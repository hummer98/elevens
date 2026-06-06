---
id: 011
title: worktree archive 化（destructive cleanup の置き換え）
priority: medium
created_at: 2026-05-18T21:52:27.615Z
---

## タスク
## 背景

現状、worktree は **タスクの終わり方に関係なく多くの経路で `git worktree remove --force` で物理削除される**。これにより:

- daemon クラッシュ → restart 時に `resume_no_session_id` → restart-task → 前回 worktree 削除で **作業内容が失われる** (2026-05-17 Brainship/prototype の実害)
- `abort-task` 後に「中身を見てから決めたい」が叶わない
- `reset-conductor` / `clear-conductor` (recovery 系) でも問答無用に消える

これを **「正常完了したときだけ消す。それ以外は退避 (archive) する」** に変える。退避は `.team/worktrees-archive/<taskRunId>/` に dir + branch をセットで保存し、後から `cd` / `git log` で参照できるようにする。

## ゴール

1. 正常完了以外の worktree 削除を **全て archive 化** に置き換える
2. archived worktree が存在する task が **再アサインされたとき、Conductor が prompt で archive の存在を知らされ、自律的に引き継ぎ判断ができる**
3. archive 一覧・参照・削除のための CLI を提供 (`elevens worktree archive list / show / remove`)

## 仕様

### 1. ディレクトリレイアウト

```
.worktrees/<taskRunId>/                    # active (今と同じ)
.team/worktrees-archive/<taskRunId>/       # 退避先（新規）
    ├── (元 worktree の全 file)
    └── .archive-meta.json
```

### 2. archiveWorktree() ヘルパー

新規 `skills/cmux-team/manager/worktree-archive.ts` に集約:

```typescript
async function archiveWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
  taskRunId: string;
  taskId: string;
  branch: string;            // 例: "task-094-1778998001/task"
  reason: string;             // "disconnect_timeout" / "abort_task" / "restart" / "reset_conductor" / ...
}): Promise<{ archivePath: string }>
```

実装手順:

1. `.team/worktrees-archive/` を mkdir -p
2. `mv <worktreePath> .team/worktrees-archive/<taskRunId>/` (rename)
3. `git worktree prune` で git の broken registration を掃除
4. **branch は残す** (`<taskRunId>/task` のまま、gc から守るため明示的に削除しない)
5. `.team/worktrees-archive/<taskRunId>/.archive-meta.json` を書く:
   ```json
   {
     "task_id": "094",
     "task_run_id": "task-094-1778998001",
     "archived_at": "2026-05-17T17:02:36.000Z",
     "reason": "resume_no_session_id",
     "original_path": ".worktrees/task-094-1778998001",
     "branch": "task-094-1778998001/task",
     "last_commit_sha": "abc1234",
     "uncommitted_changes": true
   }
   ```
   - `last_commit_sha` は `git rev-parse <branch>` で取得
   - `uncommitted_changes` は archive 前に `git status --porcelain` で判定
6. `manager.log` に `worktree_archived task_run_id=... reason=... path=...` を emit
7. `events.jsonl` に `worktree_archived` event を emit (新 schema、`docs/spec/10-events-stream.md` に追加)

### 3. 削除→archive 置き換え対象 (4 経路)

以下の `git worktree remove --force` 呼び出しを `archiveWorktree()` に差し替える:

| 経路 | 現在の場所 | reason |
|---|---|---|
| disconnect_timeout 経由 broken | `forceCloseDisconnectedConductor` → `resetConductor` (daemon.ts:4415) | `"disconnect_timeout"` |
| `abort-task` CLI | `cmdAbortTask` (main.ts:4970) | `"abort_task"` |
| `restart-task` の stale worktree | `cmdRestartTask` (main.ts:5200) | `"restart"` |
| `reset-conductor` / `clear-conductor` | `resetConductor` 内 (conductor.ts:770) — ただし preserveWorktree=false かつ targetStatus∈{idle,broken,reserved} のとき | `"reset_conductor"` / `"clear_conductor"` |

**variable な reason** を `resetConductor` の opts に追加し (`archiveReason?: string`)、呼び出し側で渡す。

### 4. 維持する経路

| 経路 | 挙動 | 理由 |
|---|---|---|
| 正常 CONDUCTOR_DONE (success=true) | **削除のまま** (変更なし) | 正常完了の worktree は保存価値なし。ユーザー明確要望 |
| judgment_pending (success=false かつ task open) | **in-place 温存のまま** (T263 維持) | Conductor がまだ生きてて手動 rebase 等で `cd` する必要あり |
| assignTask 失敗ロールバック (conductor.ts:667) | **削除のまま** | 直前に作成された空 worktree、保存価値なし |

### 5. Conductor prompt への archive 通知

`skills/cmux-team/templates/ja/conductor-task.md` に `{{ARCHIVED_WORKTREE_PATH}}` placeholder セクションを追加。daemon は assignTask 時に **同 task ID の archive を最新順で 1 件選んで** path を埋める (なければ空文字)。空でなければ Conductor は以下を行う:

```markdown
## 前回 attempt の archive について

{{ARCHIVED_WORKTREE_PATH}} が空でなければ、このタスクは前回 daemon クラッシュ / abort / reset などで中断され、再アサインされたものです。

1. `cd {{ARCHIVED_WORKTREE_PATH}}` で前回作業を確認
   - `cat .archive-meta.json` で archive 理由・最終 commit・uncommitted の有無
   - `git log --oneline` で前回どこまで commit されたか
   - `git status` で uncommitted な作業がないか
2. 引き継ぎ判断:
   - 続行できそう → `git cherry-pick` / patch 適用で新 worktree に取り込む
   - 別アプローチが必要 → archive は無視して fresh start、判断理由を journal に残す
3. 判断結果を journal に明記してから本作業に入る
```

daemon 側に `findArchivesForTaskId(projectRoot, taskId)` を実装し、`.team/worktrees-archive/*/. archive-meta.json` を grep して `task_id` 一致するものを `archived_at` 降順で返す。

### 6. CLI

`elevens worktree archive` サブコマンド (新規):

| サブ | 説明 |
|---|---|
| `list [--task-id N]` | archive 一覧 (taskRunId / archived_at / reason / branch を表) |
| `show <taskRunId>` | meta.json + `git log --oneline <branch>` -10 + worktree path |
| `remove <taskRunId>` | archive 物理削除 (`rm -rf` + 関連 branch 削除任意) |
| `prune --older-than 30d` | 30 日以上前の archive を一括削除 (確認 prompt あり) |

`WRITE_COMMANDS` に `worktree: new Set(["archive"])` 系の登録、archive サブの remove / prune は write 扱い。

### 7. 仕様書 / glossary 更新

- 新規 `docs/spec/16-worktree-archive.md` を起こす — レイアウト / archiveWorktree contract / meta.json schema / Conductor prompt 連携 / CLI
- `docs/spec/07-state-machine.md` に「cleanup 経路の archive 化」節を追記
- `docs/spec/glossary.md` に worktree archive 用語追加
- CLAUDE.md の「git worktree（概要）」節に archive 説明を追記

### 8. event schema (events.jsonl)

`docs/spec/10-events-stream.md` に `worktree_archived` event を追加:

```json
{
  "event": "worktree_archived",
  "task_id": "094",
  "task_run_id": "task-094-1778998001",
  "archived_at": "...",
  "reason": "disconnect_timeout",
  "archive_path": ".team/worktrees-archive/task-094-1778998001",
  "branch": "task-094-1778998001/task"
}
```

## Acceptance Criteria

- [ ] `elevens abort-task` 実行後、worktree が `.team/worktrees-archive/<taskRunId>/` に移動しており、`.archive-meta.json` に reason=`abort_task` が記録される
- [ ] `disconnect_timeout` → broken 経路でも同様に archive される
- [ ] `elevens reset-conductor` / `clear-conductor` でも archive される
- [ ] `elevens restart-task` 経路で stale worktree が archive されたうえで新 worktree が作成される
- [ ] 正常 CONDUCTOR_DONE (success=true) では従来通り削除されることを確認 (archive されない)
- [ ] judgment_pending 経路では in-place 温存されることを確認 (archive されない)
- [ ] archive を含む task が再アサインされたとき、Conductor の prompt に `{{ARCHIVED_WORKTREE_PATH}}` が埋まり、テンプレ追加分セクションが展開される
- [ ] `elevens worktree archive list` / `show <id>` / `remove <id>` / `prune --older-than 30d` が動く
- [ ] `events.jsonl` に `worktree_archived` event が出ている
- [ ] `docs/spec/16-worktree-archive.md` 新規 + 関連 spec 更新
- [ ] 既存の cleanup / abort-task / restart-task / reset-conductor 周りの test が pass

## Non-goals (Phase 2 で検討)

- archive の **自動 retention** (cron で 30 日経ったものを自動削除) — まずは手動 prune CLI のみ
- archive 内容を **dashboard で可視化** — Web UI 対応は別タスク
- **複数 archive の自動 merge / rebase 統合** — Conductor の自律判断に委ねる

## 関連

- task #010 (post-mortem evidence capture) — 同インシデント由来。WHEN/WHAT/WHY 把握と worktree 保全はワンセット
- spec: `docs/spec/05-install-and-infrastructure.md` (worktree-base / start-point 解決) は変更不要
