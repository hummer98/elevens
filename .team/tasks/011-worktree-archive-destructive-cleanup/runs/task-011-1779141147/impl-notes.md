# T011 Implementation Notes

## 変更ファイル一覧

### 新規

- `skills/cmux-team/manager/worktree-archive.ts` — `archiveWorktree` / `findArchivesForTaskId` / `removeArchive` / `pruneArchives` / `buildArchivedWorktreeSection` / `parseDuration` / `ArchiveFailedError`
- `skills/cmux-team/manager/worktree-archive.test.ts` — unit tests (23 件)
- `skills/cmux-team/manager/worktree-archive-cli.test.ts` — CLI subprocess test (16 件)
- `skills/cmux-team/manager/conductor-archive-integration.test.ts` — resetConductor cleanupMode 経路 integration test (10 件、§9.4 構成)
- `docs/spec/16-worktree-archive.md` — 仕様書本体

### 更新 (Source)

- `skills/cmux-team/manager/events-writer.ts` — `EventStreamRecord` に `worktree_archived` variant 追加 (add-only)
- `skills/cmux-team/manager/template.ts` — `generateConductorTaskPrompt` の signature に `archivedWorktreeSection: string = ""` を追加、`{{ARCHIVED_WORKTREE_SECTION}}` 置換
- `skills/cmux-team/manager/conductor.ts` —
  - `CleanupMode` discriminated union 型を export ([M4])
  - `resetConductor` に `cleanupMode?: CleanupMode` opts 追加 + 3 分岐 (preserve / archive / delete) 実装
  - `legacy_fallback` 削除経路に `worktree_delete_legacy_fallback` log 追加 ([v2-m1])
  - `assignTask` 内で `findArchivesForTaskId` + `buildArchivedWorktreeSection` を呼んで `generateConductorTaskPrompt` に渡す
- `skills/cmux-team/manager/daemon.ts` — 7 経路 (A〜E + F + H) の `resetConductor` 呼び出しに `cleanupMode` 付与
  - A: CONDUCTOR_CLEAR → archive: clear_conductor
  - B: RESET_CONDUCTOR → archive: reset_conductor
  - C: ABORT_TASK → archive: abort_task
  - D: applyAssignCommit terminal race → archive: assign_terminal_race
  - E: forceCloseDisconnectedConductor → archive: disconnect_timeout
  - F: handleConductorDone → success/unresolved で delete/preserve/archive: done_unresolved 分岐
  - H [C1]: SESSION_CLEAR running → archive: user_clear (★新規 archive 化経路)
- `skills/cmux-team/manager/main.ts` —
  - `cleanupAssignedTask` を `archiveWorktree` に置き換え (reason: restart) + taskRunId/taskId 不明時の fallback
  - `restartFromAborted` を `archiveWorktree` に置き換え (reason: restart) + taskRunId 不明時の fallback
  - resume 起動時 violation 経路 (G) に `cleanupMode: { kind: "archive", reason: "resume" }` 付与
  - `WRITE_COMMANDS` に `worktree: new Set(["archive-remove", "archive-prune"])` を登録 ([M3])
  - `isWriteCommand` を export (test 用) + 2 階層 (`worktree archive {sub}`) 用アダプタを dispatcher に追加
  - `cmdWorktree` / `cmdWorktreeArchiveList` / `cmdWorktreeArchiveShow` / `cmdWorktreeArchiveRemove` / `cmdWorktreeArchivePrune` + `showWorktreeUsage` 追加
  - `case "worktree"` を main switch に登録
- `skills/cmux-team/templates/ja/conductor-task.md` — 末尾に `{{ARCHIVED_WORKTREE_SECTION}}` 追加
- `skills/cmux-team/templates/en/conductor-task.md` — 同上

### 更新 (Test)

- `skills/cmux-team/manager/events-writer.test.ts` — `worktree_archived` round-trip test 2 件追加
- `skills/cmux-team/manager/template.test.ts` — `generateConductorTaskPrompt` の archivedWorktreeSection test 2 件追加
- `skills/cmux-team/manager/cli-project-root.test.ts` — `isWriteCommand worktree archive` アダプタ test 5 件追加

### 更新 (Docs)

- `docs/spec/07-state-machine.md` — §6.5 cleanup 経路の archive 化 を追記
- `docs/spec/10-events-stream.md` — 17 → 18 event、§5.4 Worktree lifecycle 追加、§6.18 worktree_archived schema 追加
- `docs/spec/04-templates.md` — `{{ARCHIVED_WORKTREE_SECTION}}` placeholder を conductor-task.md の変数一覧に追加
- `docs/spec/glossary.md` — §9 に worktree archive 用語、events stream の event 種数を 18 に更新
- `CLAUDE.md` — git worktree 節に archive 化 1 行追記

## テスト結果

| ファイル | pass / fail | tests |
|---|---|---|
| `worktree-archive.test.ts` (新規) | 23 / 0 | 86 expect |
| `worktree-archive-cli.test.ts` (新規) | 16 / 0 | 46 expect |
| `conductor-archive-integration.test.ts` (新規) | 10 / 0 | 33 expect |
| `events-writer.test.ts` (更新) | 24 / 0 | 178 expect |
| `template.test.ts` (更新) | 19 / 0 | 65 expect |
| `cli-project-root.test.ts` (更新) | 20 / 1 | 33 expect (1 失敗は pre-existing、後述) |
| `conductor.test.ts` (既存) | 53 / 0 + 3 skip | 182 expect |
| `daemon.test.ts` (既存) | 232 / 0 + 2 skip | 816 expect |
| `cleanup.test.ts` (既存) | 4 / 0 | 11 expect |
| `state-machine/fsm.test.ts` | 191 / 0 | 360 expect |
| `state-machine/apply-task-actions.test.ts` | 15 / 0 | 48 expect |
| `state-machine/task-state-store.test.ts` | 44 / 0 | 120 expect |
| `main.test.ts` | 275 / 0 | 753 expect |

### 既存 1 件失敗 (pre-existing)

`cli-project-root.test.ts` R4: `expect(r.stderr).toContain("not a cmux-team project")` — 現行実装は `"not an elevens project"` メッセージを返す。main worktree でも同じ失敗が確認されており、本タスクの変更とは無関係 (CLI 名 rebrand に伴う test の遅延)。

## tsc 結果

新規エラー: **0 件**

`bunx tsc --noEmit` で残る error はすべて pre-existing (`c11-features.ts` / `mailbox-cli.ts` / `main.ts:1051`)。main worktree でも同じ errors を確認済み。

## 設計判断ログ

### 1. legacy_fallback の事故性緩和

cleanupMode 未指定時の後方互換のため `{ kind: "delete", reason: "legacy_fallback" }` を合成する。`worktree_delete_legacy_fallback` log を出力するようにしたので、`grep worktree_delete_legacy_fallback .team/logs/manager.log` で「型で守れていない呼び出し経路」を grep で列挙可能 ([v2-m1])。

### 2. preserveWorktree=true は cleanupMode 上書き優先順位

`cleanupMode` が指定されていれば `cleanupMode` を採用、未指定 + `preserveWorktree=true` で `{ kind: "preserve" }` 合成。`preserveWorktree=false` を明示するケースは `{ kind: "delete", reason: "legacy_fallback" }` と等価。

### 3. preservedSuffix log は cleanupMode.kind === "preserve" を基準に

`preserveWorktree=true` 経由でも `cleanupMode: { kind: "preserve" }` 経由でも、log に `worktree_preserved=true` suffix が付くよう、合成後の `cleanupMode.kind` をベースに判定する形に変更。

### 4. handleConductorDone の F 経路は 3 値分岐

- `success=true` → `{ kind: "delete", reason: "done_success" }`
- `success=false && unresolved=true` → `{ kind: "preserve" }` (judgment_pending 維持)
- `success=false && unresolved=false` → `{ kind: "archive", reason: "done_unresolved" }`

`preserveWorktree: unresolved` 1 行で表現していた既存ロジックを「3 状態 = 3 動作」に展開した形。

### 5. restartFromAborted の branch 削除は撤廃

archive 経路では branch を残す方針なので、既存の `git branch -D <branch>` を撤廃した。taskRunId 不明な edge case の fallback でも archive 化を選んでいないため branch は触らない (削除は worktree remove のみ)。

### 6. CLI `prune` の安全装置

`--dry-run` / `--yes` のどちらも指定されないと exit 1。`--dry-run --yes` 同時は `--dry-run` 優先 (保守側設計 [m9])。

### 7. worktree dispatcher の 2 階層対応 ([M3])

`WRITE_COMMANDS` は `Record<string, true | Set<string>>` の 2 階層構造。`worktree archive remove` 等の 3 階層 subcommand には `args[1] + "-" + args[2]` で flat に展開して登録 (`archive-remove` / `archive-prune`)。`isWriteCommand` 呼び出し側 (dispatcher の write gate 起動部) でも同じ組み立てを行うアダプタを 1 行追加。

### 8. 既存 fixture pattern (T263) との互換性

`conductor.test.ts:T263 preserveWorktree` の既存テストは引き続き pass (`preserveWorktree=true` / `false` 明示 / 未指定 のすべて)。fixture が worktree dir に commit を入れない構造 (branch が main と同点) なので legacy `branch -d` が成功する条件は維持されている。

## 残課題

- **Phase 2 への移行 TODO**: `conductor.ts:resetConductor` に `TODO(T011-phase2): cleanupMode を required に昇格させ、preserveWorktree opt と legacy_fallback path を削除する。` を明記済み。Phase 2 着手時に required 昇格と `preserveWorktree` 削除を行う
- **dashboard widget**: plan §v2-m2 のとおり Phase 2 で別タスク
- **archive retention 自動化**: `pruneArchives` 自動実行は本タスク範囲外。Phase 2 で daemon の `gc` 設定と統合検討
- **branch 削除戦略**: Phase 1 では `--delete-branches` default = false。Phase 2 で `cherry-pick` ユースケースとのトレードオフを再評価

## 検証コマンド

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-011-1779141147

# tsc (新規 error 0 件 を確認)
bunx tsc --noEmit 2>&1 | tail -20

# 個別テスト
cd skills/cmux-team/manager
for f in worktree-archive.test.ts worktree-archive-cli.test.ts conductor-archive-integration.test.ts events-writer.test.ts conductor.test.ts daemon.test.ts cli-project-root.test.ts template.test.ts cleanup.test.ts state-machine/fsm.test.ts main.test.ts; do
  echo "=== $f ==="
  bun test --timeout 60000 "$f" 2>&1 | tail -5
done
```
