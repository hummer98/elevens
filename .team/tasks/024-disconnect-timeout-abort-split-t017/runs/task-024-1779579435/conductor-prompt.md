# タスク割り当て

## タスク内容

---
id: 024
title: 連続 disconnect_timeout abort + 空 split ペイン量産の調査・修正（T017 再発疑い）
priority: high
created_by: surface:29
created_at: 2026-05-23T23:37:15.641Z
---

## タスク
## 背景・症状（Master が事前に切り分けた）

直近 2 タスク（T021, T019）が連続で **disconnect_timeout** により abort した。さらに同じ時間窓で「空の split ペイン」が量産されている。両者は同一窓で起きており、根が繋がっている疑いが濃い。

### 事象A: Conductor が無言で死に disconnect_timeout で task が abort

T021 のタイムライン（JST, `.team/logs/manager.log`）:
- 07:09:33 C[73] に T021 assign
- 〜07:37 A[102]planner / A[105]design-reviewer / A[107]planner が completed（順調）
- 07:38:31 **C[73] が compact で session 再起動**（pid=7256, source=compact）
- 07:38:42 A[108]implementer spawn（pid=25414）→ 07:44:07 **crashed**（pid_watcher）
- 07:45:34 A[112]implementer 再spawn（pid=57247）← 再spawn 自体は成功
- 07:46:55 **C[73] 本体が死亡**（pid_watcher pid_dead, pid=7256, last_hook から 505s 沈黙）
- 07:52:00 305s 復帰せず disconnect_timeout → **task_aborted 021**（worktree archive, uncommitted=true）

T019 も同様に C[27] が disconnect_timeout で abort（task-state: abortedAt 2026-05-22T22:46, journal reason=disconnect_timeout）。

→ 「Conductor / Agent の起動失敗」ではなく **Conductor の claude プロセスが応答停止して死ぬ**のが abort トリガー。**compact 直後**から崩れている点に注目（pid=7256 は 07:38 compact 由来）。

### 事象B: 空の split ペインが量産され、しかもログに残らない

現在の `c11 tree` 下段に progressive split の残骸:
```
surface:28(50%) -> 110(25%) -> 113(13%) -> 115(6%) -> 116(6%)   # 計4分割
```
- すべて中身のない `[N] Claude Code`（role 不明）
- **manager.log に 110/113/115/116 / split / new-split の記録が一切ない**
- 作成時刻は事象A の窓（07:44-07:46）に集中
- agent_spawned ログは A[102,105,107,108,112] のみ。これら split surface は **どの agent_spawned にも対応しない**

→ spawn-agent（または別経路）が「正しいペインへのタブ追加」ではなく **split で空ペインを作って放置**している。これは **T017（"spawn-agent の Agent 起動先が別ペイン/split になる不具合", closed・ea6dc57 マージ済み）と同じ不具合クラスの再発**を強く示唆。

## 調査の論点（切り分け優先。env を実測してから根本原因を断定すること）

1. **T017 修正が実機で効いているか**: 動作中の Manager daemon と Conductor が使う `elevens` CLI が ea6dc57（T017 fix: getPaneForSurface 完全一致 + targetPane undefined の fail-fast）を実際に含むバージョンか。daemon が古いコードのまま再起動されていない / PATH 上の elevens が別実体、等の env 起因を最初に潰す。
2. **split の writer 特定**: 110/113/115/116 を作ったのは spawn-agent か、spawn-conductor 系か、Manager の pane 再生成か。`c11 get-metadata` の provenance / 作成時刻、対応する CLI 呼び出しの有無で切り分ける。これら split surface が C[28]（idle conductor の現役 pane）の兄弟として並ぶ点（C[73] の surface は既に消滅）も手掛かり。
3. **split 操作がログに残らない観察盲点**: pane split / new-surface の生成が manager.log に出ていない。observatory 原則（silent state mutation を作らない）に反する。生成イベントを必ずログ（+ events.jsonl）に出すよう改修。
4. **compact 後の Conductor 不安定化**: 07:38 compact -> A crash -> C 死亡 の連鎖が compact 起因か。compact が Conductor の claude を不安定化させる / pid 追跡がズレる等の可能性を切り分ける。根本原因が重い場合は **別タスクに切り出す**（本タスクは事象B=split の修正を主とし、事象A は切り分け結果を artifact に記録 + follow-up task 提案でよい）。

## やること

- Phase 1: 上記論点を `.team/logs/manager.log` / `c11 tree` / `get-metadata` / 実機 env で切り分け、artifact（`/elevens:artifact research ...`）に記録。
- Phase 2: **明確に修正可能なもの（最有力: spawn-agent の split 再発 + split のログ記録）を最小修正**。T017 の修正方針（getPaneForSurface 完全一致 / targetPane undefined の fail-fast）が破れている箇所を特定して塞ぐ。
- 事象A（compact 後 Conductor 死 / disconnect_timeout）は、本タスクで根治できなければ findings を artifact に残し follow-up task を提案。

## 検証

- 修正後、Conductor が agent を spawn しても **split ではなくタブ追加**になり、空ペイン残骸が出ないこと（`c11 tree`）。
- split / new-surface 生成が manager.log に必ず記録されること。
- 関連テスト（cmux.test.ts / main.test.ts の spawn-agent / getPaneForSurface 系）pass。`bun test` 全体は禁忌、per-file ループで。

## 参考 file:line

- `skills/cmux-team/manager/cmux.ts` getPaneForSurface（L281 付近, T017 で完全一致化）/ newSurface（L154-156）/ listSiblingSurfaces（L312）
- `skills/cmux-team/manager/main.ts` cmdSpawnAgent（L3574-3577 付近の targetPane / newSurface）
- T017 の調査記録: `.team/tasks/017-spawn-agent-agent-split/task.md`
- 過去ログ痕跡: `.team/logs/manager.log`（07:38-07:52 の T021 窓 / getPaneForSurface failed 例）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-024-1779579435` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-024-1779579435
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-024-1779579435/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/024-disconnect-timeout-abort-split-t017/runs/task-024-1779579435
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/024-disconnect-timeout-abort-split-t017/runs/task-024-1779579435/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


