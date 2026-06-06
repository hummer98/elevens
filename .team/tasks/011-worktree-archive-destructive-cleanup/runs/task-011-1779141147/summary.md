# T011 Summary — worktree archive 化（destructive cleanup の置き換え）

## 完了状態

- フェーズ: Plan → Design Review (1 往復差し戻し → Approved) → Implementation (TDD) → Inspection (GO) → Minor 修正 → 完了処理
- 判定: **GO** （Inspector minor 5 件のうち 3 件は本タスク内で修正、1 件は意図通り、1 件は T012 にフォローアップ起票）

## 達成した AC（task.md §Acceptance Criteria 全 11 件）

1. ✅ `elevens abort-task` 後、`.team/worktrees-archive/<taskRunId>/` に移動、reason=`abort_task`
2. ✅ disconnect_timeout 経路で archive
3. ✅ `reset-conductor` / `clear-conductor` / 手動 `/clear` (SESSION_CLEAR running) で archive
4. ✅ `restart-task` 経路で stale worktree archive
5. ✅ 正常 CONDUCTOR_DONE (success=true) では従来通り削除（archive されない）
6. ✅ judgment_pending では in-place 温存（archive されない）
7. ✅ 再アサインされた Conductor の prompt に `{{ARCHIVED_WORKTREE_SECTION}}` セクションが埋まる
8. ✅ `elevens worktree archive {list,show,remove,prune}` CLI が動く
9. ✅ `events.jsonl` に `worktree_archived` event（`archived_at` 含む）
10. ✅ `docs/spec/16-worktree-archive.md` 新規 + 関連 spec 更新
11. ✅ 既存 cleanup / abort-task / restart-task / reset-conductor 周りの test pass（pre-existing 1 件除く）

## 変更ファイル一覧

### 新規（5 ファイル）

- `skills/cmux-team/manager/worktree-archive.ts` — archiveWorktree / findArchivesForTaskId / removeArchive / pruneArchives / buildArchivedWorktreeSection / parseDuration / ArchiveFailedError
- `skills/cmux-team/manager/worktree-archive.test.ts` — unit tests 23 件 / 86 expect
- `skills/cmux-team/manager/worktree-archive-cli.test.ts` — CLI subprocess test 16 件 / 46 expect
- `skills/cmux-team/manager/conductor-archive-integration.test.ts` — 10 ケース integration test / 33 expect
- `docs/spec/16-worktree-archive.md` — 仕様書本体

### 更新（Source、9 ファイル）

- `skills/cmux-team/manager/events-writer.ts` — `worktree_archived` discriminated union variant 追加（`archived_at` 含む）
- `skills/cmux-team/manager/template.ts` — `generateConductorTaskPrompt` に `archivedWorktreeSection` 引数追加、`{{ARCHIVED_WORKTREE_SECTION}}` 置換
- `skills/cmux-team/manager/conductor.ts` — `CleanupMode` discriminated union export / `resetConductor` の 3 分岐 (preserve/archive/delete) / `legacy_fallback` log / `assignTask` で archive section 組み立て
- `skills/cmux-team/manager/daemon.ts` — 7 経路 (A-F + H[C1]) の resetConductor 呼び出しに cleanupMode 付与
- `skills/cmux-team/manager/main.ts` — cleanupAssignedTask / restartFromAborted の archive 化 / resume 経路に archive / WRITE_COMMANDS flat sub-sub / 4 CLI コマンド
- `skills/cmux-team/templates/ja/conductor-task.md` / `skills/cmux-team/templates/en/conductor-task.md` — `{{ARCHIVED_WORKTREE_SECTION}}` placeholder 追加
- `package-lock.json` — version 0.6.0 → 0.8.0 同期（bootstrap 副作用）

### 更新（Test、3 ファイル）

- `skills/cmux-team/manager/events-writer.test.ts` — `worktree_archived` round-trip test 2 件追加
- `skills/cmux-team/manager/template.test.ts` — `archivedWorktreeSection` test 2 件追加
- `skills/cmux-team/manager/cli-project-root.test.ts` — `isWriteCommand worktree archive` adapter test 5 件追加

### 更新（Docs、5 ファイル）

- `docs/spec/07-state-machine.md` — §6.5 cleanup 経路の archive 化 を追記
- `docs/spec/10-events-stream.md` — 17 → 18 event、§5.4 Worktree lifecycle 追加、§6.18 worktree_archived schema 追加（17 種 → 18 種 残置の minor 修正含む）
- `docs/spec/04-templates.md` — `{{ARCHIVED_WORKTREE_SECTION}}` placeholder を conductor-task.md 変数一覧に追加
- `docs/spec/glossary.md` — §9 に worktree archive 用語、events stream 18 event に更新
- `CLAUDE.md` — git worktree 節に archive 化 1 行追記

## テスト結果

| ファイル | 結果 | tests |
|---|---|---|
| worktree-archive.test.ts (新規) | ✅ | 23 / 0 (86 expect) |
| worktree-archive-cli.test.ts (新規) | ✅ | 16 / 0 (46 expect) |
| conductor-archive-integration.test.ts (新規) | ✅ | 10 / 0 (33 expect) |
| events-writer.test.ts (拡張) | ✅ | 24 / 0 (178 expect) |
| template.test.ts (拡張) | ✅ | 19 / 0 (65 expect) |
| cli-project-root.test.ts (拡張) | △ | 20 / 1 (R4 のみ失敗、pre-existing CLI rename 由来) |
| conductor.test.ts (既存) | ✅ | 53 / 0 + 3 skip (182 expect) |
| daemon.test.ts (既存) | ✅ | 232 / 0 + 2 skip (816 expect) |
| cleanup.test.ts (既存) | ✅ | 4 / 0 (11 expect) |
| state-machine/fsm.test.ts (既存) | ✅ | 191 / 0 (360 expect) |
| main.test.ts (既存) | ✅ | 275 / 0 (753 expect) |

新規・拡張 test 合計: 49 件追加 (worktree-archive 23 / cli 16 / integration 10)

## tsc 結果

- 新規 error: **0 件**
- pre-existing error（c11-features / mailbox-cli / main.ts:1051）は本タスク無関係（main branch でも同症状）

## 主要な設計判断

1. **`CleanupMode` discriminated union 化（M4）** — `cleanupMode?: { kind: "delete" | "archive" | "preserve" } & ...` で型レベルで「archive / 削除 / 温存」のいずれかを明示させる構造。`cleanupMode` 未指定時のみ `{ kind: "delete", reason: "legacy_fallback" }` でフォールバック（Phase 2 で required 昇格 TODO 記載済み）
2. **`{{ARCHIVED_WORKTREE_SECTION}}` section block placeholder（M2）** — `cd ` 不完全コマンドリスクを構造的に排除。archive 不在時は section 全体が prompt から消える
3. **`WRITE_COMMANDS` flat sub-sub 形式（M3）** — `worktree: new Set(["archive-remove", "archive-prune"])` で list/show は write 対象外、UX 維持
4. **SESSION_CLEAR running 経路 [C1] の archive 化** — 手動 `/clear` で進行中 worktree が消える既知バグを解消（reason=`user_clear`）
5. **`handleConductorDone` F 経路の 3 値分岐** — success → delete / unresolved → preserve / それ以外 → archive (`done_unresolved`)
6. **observatory 三層保全** — `.archive-meta.json` + `manager.log` (`worktree_archived` / `worktree_delete_legacy_fallback`) + `events.jsonl` (`worktree_archived`) で WHEN/WHY 再構成可能

## フォローアップ

- **T012**: T011 plan §9.4 の restart 経路 2 ケースの integration test 追加（Inspector minor 3、リスク小・unit + main wiring で間接検証済み）
- **Phase 2 検討**: `cleanupMode` required 昇格 + `preserveWorktree` opt 撤廃、archive retention 自動化、dashboard widget での archive 可視化

## マージ・納品

- ローカル ff-only マージで `main` に取り込む（小さな新規機能、観察箱方針に沿った変更、共有リポジトリではないため PR は不要）
