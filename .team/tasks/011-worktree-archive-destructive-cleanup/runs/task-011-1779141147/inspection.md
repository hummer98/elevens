# Inspection: T011 worktree archive 化

## 判定

**GO**

## サマリー

AC 11 件すべて実装で満たされており、関連 test の自前再実行で新規 test 49 件 (worktree-archive 23 / cli 16 / integration 10) はすべて pass、既存 test も pre-existing 1 件 (CLI rename 由来、main 側でも同症状) を除き regression なし。
新規 tsc error 0 件 (差分は main.ts の line 1038 → 1051 への shift のみ)。`cleanupMode` discriminated union (M4) / `{{ARCHIVED_WORKTREE_SECTION}}` section block (M2) / `WRITE_COMMANDS` flat sub-sub (M3) / events.jsonl `archived_at` (M1) / SESSION_CLEAR running 経路 (C1) すべて plan 通り反映。
ドキュメントは spec 5 本 (`16-worktree-archive.md` 新規 + `07` / `10` / `04` / `glossary`) + CLAUDE.md が同期済み。Minor 2 件 (`10-events-stream.md` §3.1 の event 種別カウント "17 種" 残置、spec §12 R4 の手順番号 mismatch) は仕様文書の表記揺れで実装には影響しないため後追い修正で可。

## AC チェックリスト

| AC | 判定 | 根拠 (file:line, test 名) |
|---|---|---|
| AC1: `abort-task` で archive (reason=`abort_task`) | ✅ | `daemon.ts:1865` `cleanupMode: { kind: "archive", reason: "abort_task" }` / integration test `archive-abort_task` (conductor-archive-integration.test.ts:132) pass |
| AC2: disconnect_timeout 経路で archive | ✅ | `daemon.ts:4437` archive reason=disconnect_timeout / `archive-disconnect_timeout` test (line 108) pass |
| AC3: `reset-conductor` / `clear-conductor` / 手動 `/clear` で archive | ✅ | `daemon.ts:1642` (clear_conductor) / `daemon.ts:1756` (reset_conductor) / `daemon.ts:3046` (user_clear, C1) すべて archive。`archive-reset_conductor` (line 151) / `archive-user_clear` (line 167) pass |
| AC4: `restart-task` 経路で stale worktree archive | ✅ | `main.ts:5115` `cleanupAssignedTask` → archiveWorktree reason=restart / `main.ts:5372` `restartFromAborted` → archiveWorktree reason=restart |
| AC5: 正常 CONDUCTOR_DONE では削除 | ✅ | `daemon.ts:4633` `success ? { kind:"delete", reason:"done_success" } : ...` / `regression-success-deletes` test (line 220) pass — archive ディレクトリが作られないこと assert |
| AC6: judgment_pending で in-place 温存 | ✅ | `daemon.ts:4635-4637` `unresolved ? { kind:"preserve" } : { kind:"archive", reason:"done_unresolved" }` / `regression-judgment-preserves` (line 248) pass — worktree 温存 + branch 残存 + `worktree_preserved=true` log |
| AC7: 再アサインされた Conductor の prompt に section が埋まる | ✅ | `conductor.ts:538-545` `findArchivesForTaskId` → `buildArchivedWorktreeSection` → `generateConductorTaskPrompt` 第 10 引数 / `template.ts:264,301` `{{ARCHIVED_WORKTREE_SECTION}}` 置換 / `template.test.ts` 拡張で 2 件追加 pass |
| AC8: `worktree archive list/show/remove/prune` CLI が動く | ✅ | `main.ts:6603-6800` 4 サブコマンド実装 + `main.ts:331,7027-7030` write gate (archive-remove / archive-prune) / worktree-archive-cli.test.ts 16 件 pass |
| AC9: `events.jsonl` に `worktree_archived` event | ✅ | `events-writer.ts:162-187` discriminated union variant 追加 (`archived_at` 含む) / `worktree-archive.ts:282-292` emitEvent / events-writer.test.ts 拡張 pass |
| AC10: `docs/spec/16-worktree-archive.md` 新規 + 関連 spec 更新 | ✅ | 16-worktree-archive.md 新規 (16,818 byte) / 07-state-machine.md §6.5 / 10-events-stream.md §5 / §6.18 / 04-templates.md 191 行 / glossary.md 160 行 / CLAUDE.md 303 行 すべて追記済み |
| AC11: 既存テスト pass | ✅ | conductor / daemon / main / cleanup / fsm すべて pass (詳細は下記テスト表)、pre-existing 1 件のみ |

## plan.md Step 完了状況

| Step | 完了 | 備考 |
|---|---|---|
| Step 1: events-writer に worktree_archived variant | ✅ | events-writer.ts:162-187 / `ts` と `archived_at` 並列 |
| Step 2: worktree-archive.ts 新規 + test | ✅ | 597 行 / 主要 6 関数 + ArchiveFailedError export / 23 test pass |
| Step 3: template.ts に archivedWorktreeSection 拡張 + templates 改修 | ✅ | template.ts:264, 301 / ja・en 両 conductor-task.md:45 に placeholder |
| Step 4: conductor.ts resetConductor cleanupMode 3 分岐 | ✅ | conductor.ts:719-722 CleanupMode export / 811-877 archive / delete / preserve 分岐 + v2-m1 `worktree_delete_legacy_fallback` log |
| Step 5: daemon.ts 6 経路 (A/B/C/D/E/H[C1]) に cleanupMode 付与 | ✅ | daemon.ts:1642 / 1756 / 1865 / 3046 / 3716 / 4437 / 4633-4639 (F も 3 値分岐) |
| Step 6: main.ts cleanupAssignedTask archive 化 | ✅ | main.ts:5110-5165 / taskRunId/taskId 不明時の fallback も保守 |
| Step 7: main.ts restartFromAborted archive 化 + resume 経路 | ✅ | main.ts:5367-5402 / 1633-1638 resume violation 経路に archive |
| Step 8: assignTask で findArchivesForTaskId + buildArchivedWorktreeSection | ✅ | conductor.ts:536-545 / try/catch で lookup 失敗を `archive_section_lookup_failed` log として吸収 |
| Step 9: CLI dispatch + WRITE_COMMANDS 登録 + isWriteCommand アダプタ | ✅ | main.ts:331 (worktree set) / 7025-7030 (subCmd 2 階層アダプタ) / 6603-6800 (cmdWorktree + 4 サブ) |
| Step 10: ドキュメント更新 | ✅ | spec 5 本 + CLAUDE.md |
| Step 11: 全関連 test 通過 | ✅ | 後述「テスト実行結果」のとおり (pre-existing 1 件のみ) |

## Critical 経路 [C1] / Major 取り込み [M1-M4]

| 項目 | 判定 | 根拠 |
|---|---|---|
| C1 SESSION_CLEAR running の archive 化 | ✅ | daemon.ts:3046 `cleanupMode: { kind: "archive", reason: "user_clear" }` / `archive-user_clear` integration test (conductor-archive-integration.test.ts:167-188) で worktree が `.team/worktrees-archive/...` に移動し log に `reason=user_clear` が出ることを検証 |
| M1 events `archived_at` フィールド | ✅ | events-writer.ts:183 `archived_at: string` 必須 / worktree-archive.ts:241 mv 完了直後に確定した同一 ISO 文字列を meta.json (line 259) と event (line 288) で共有 |
| M2 `{{ARCHIVED_WORKTREE_SECTION}}` placeholder | ✅ | template.ts:264 引数 / template.ts:301 置換 / conductor-task.md:45 (ja/en) / archive 不在時は `""` で section 全体が消える (worktree-archive.ts:526) |
| M3 `WRITE_COMMANDS` flat sub-sub | ✅ | main.ts:331 `worktree: new Set(["archive-remove", "archive-prune"])` / 7025-7030 アダプタ / cli-project-root.test.ts:R12-R16 (5 件) で list/show=read, remove/prune=write を assert |
| M4 `CleanupMode` discriminated union | ✅ | conductor.ts:719-722 export type / 811-815 cleanupMode 未指定→legacy_fallback (delete) 合成 / TODO(T011-phase2) コメント (line 809-810) |

## CLAUDE.md ガードレール遵守

| 項目 | 判定 | 備考 |
|---|---|---|
| `cmux tree` workspace 省略がないか | ✅ | worktree-archive.ts は cmux.tree を使わない (git CLI 直叩き) / conductor.ts:790 `listSiblingSurfaces(surface, workspace)` は既存 (本 task で追加なし) |
| 空の `catch {}` がないか | △ Minor | worktree-archive.ts:186 / 336 / 425 / 463 / 476 / 491 は「skip して次のエントリ」「meta 不在で default 値」など意図が明示されており、内部にコメントあり。main.ts:428 (`catch {}`) は本 task で増えた箇所ではない (既存 code) |
| `bus.emit` / `bus.on` 直接呼び出しがないか | ✅ | grep でヒットなし。`notifyStateChanged` のみ使用 |
| `task-state` を `taskState[...] =` で直接書いていないか | ✅ | すべて read (`taskState[x]?.field`)、write は applyTaskEvent / updateTaskSessionId 経由 |
| hook shell に分岐ロジックがないか | ✅ | 本 task で hook shell の変更なし |
| `bun test` 全体実行を避けて個別 file で test しているか | ✅ | impl-notes.md の検証コマンドが for ループで個別実行。Inspector 側でも個別実行 |

## テスト実行結果 (Inspector 自身が実行)

| ファイル | 結果 | tests pass/fail |
|---|---|---|
| worktree-archive.test.ts (新規) | ✅ | 23 / 0 (86 expect) |
| worktree-archive-cli.test.ts (新規) | ✅ | 16 / 0 (46 expect) |
| conductor-archive-integration.test.ts (新規) | ✅ | 10 / 0 (33 expect) |
| events-writer.test.ts (拡張) | ✅ | 24 / 0 (178 expect) |
| template.test.ts (拡張) | ✅ | 19 / 0 (65 expect) |
| cli-project-root.test.ts (拡張) | △ | 20 / 1 (R4 のみ失敗、pre-existing) |
| conductor.test.ts (既存) | ✅ | 53 / 0 + 3 skip (182 expect) |
| daemon.test.ts (既存) | ✅ | 232 / 0 + 2 skip (816 expect) |
| cleanup.test.ts (既存) | ✅ | 4 / 0 (11 expect) |
| state-machine/fsm.test.ts (既存) | ✅ | 191 / 0 (360 expect) |
| main.test.ts (既存) | ✅ | 275 / 0 (753 expect) |

**pre-existing 1 件の検証**: `cli-project-root.test.ts` R4 (line 381) は `"not a cmux-team project"` を期待しているが、`main.ts:208` (main branch・本 worktree とも) は既に `"not an elevens project"` を返す。main worktree (commit 9666f35) で `git checkout main -- skills/cmux-team/manager/` した後 `bunx tsc --noEmit` を実行しても同じ「CLI rename 由来の test 遅延」が確認できる。本タスクの変更とは無関係。

## tsc 結果

**新規 error: 0 件**

`bunx tsc --noEmit` (cd skills/cmux-team/manager) で残る errors はすべて pre-existing:

- `c11-features.test.ts:129,172` (TS2722 / TS2322)
- `c11-features.ts:246,254` (MailboxChange 型)
- `mailbox-cli.ts:29,30,44` (TS18048 / TS2345)
- `main.ts:1051` (sleepPrevention 型 — main branch では line 1038 で同症状)

main branch から `git checkout` した状態で比較しても **error 種類・件数は同一**。本タスクで増えた error は 0。

## Findings

### Critical (NOGO の根拠)

なし。

### Major (推奨修正、GO 可)

なし。

### Minor (参考、修正は別タスクで可)

1. **`docs/spec/10-events-stream.md:63` の "17 種" 残置**: line 92 では「合計 **18 event 種**」と更新されているが、§3.1 line 63 の `event` フィールド説明 "§5 の **17 種** のいずれか" が古い表記のまま。glossary.md line 162 は 18 に更新済み。修正は 1 文字差し替えのみ。
2. **spec §12 R4 の手順番号 mismatch**: `docs/spec/16-worktree-archive.md:308` 「`archiveWorktree()` 手順 6 で必ず呼ぶ」とあるが、同 spec §2 architecture (line 41-44) の番号付けでは git worktree prune は **step 3**、実装 (worktree-archive.ts:243) でも **step 5** のコメント。番号体系が混在しているのでどれかに揃えるのが望ましい (R4 文字を「mv 直後に呼ぶ」に書き換えればナンバリング非依存)。
3. **integration test §9.4-5/6 (archive-restart-assigned / archive-restart-aborted) のカバレッジ**: plan §9.4 が指定した 10 ケースのうち、restart 経由 2 ケースは conductor-archive-integration.test.ts には含まれず、代わりに `legacy_fallback` (R9 covering) と `preserveWorktree=true` DEPRECATED 互換の 2 ケースが入っている。restart 経路は `archiveWorktree()` を直接呼ぶため worktree-archive.test.ts の unit と main.ts の dispatch wiring の 2 軸で間接検証されており、E2E 観点での欠落リスクは小。気になる場合は `cleanupAssignedTask` / `restartFromAborted` を fixture で叩く integration test を追加すると plan §9.4 と完全一致できる。
4. **conductor.ts:870 `worktree_delete_legacy_fallback` の発火条件**: `cleanupMode.reason === "legacy_fallback"` のみ log を吐く設計。明示的に `{ kind: "delete", reason: "done_success" }` を渡したときは log が出ないので、observatory で「型で守れていない呼び出し経路を grep で列挙」というv2-m1の意図は満たされている (legacy_fallback 経由だけ拾える)。意図通り。
5. **conductor.ts:540 `archive_section_lookup_failed` の event name**: events-writer の discriminated union には含まれない「log only」の event 名。`worktree-archive.md` の log event 一覧 (5.2 / Minor 6 [m6]) には `archive_meta_unreadable` / `archive_meta_invalid` のみ言及があり、`archive_section_lookup_failed` の説明が抜けている (本 worktree のドキュメントの完全性のみの観点)。

## Fix Required

なし (GO 判定)。

## 参考: Inspector 検証手順

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-011-1779141147/skills/cmux-team/manager

# 新規 + 拡張 test の自前再実行 (impl-notes の自己申告検証)
for f in worktree-archive.test.ts worktree-archive-cli.test.ts conductor-archive-integration.test.ts \
         events-writer.test.ts template.test.ts cli-project-root.test.ts \
         conductor.test.ts daemon.test.ts cleanup.test.ts main.test.ts state-machine/fsm.test.ts; do
  bun test --timeout 60000 "$f" 2>&1 | tail -5
done

# tsc 比較 (本 worktree vs main)
bunx tsc --noEmit 2>&1 | tail -30

# 残存 worktree remove 呼び出しの確認 (3 経路に絞れていること)
grep -rn "worktree.*remove" skills/cmux-team/manager/*.ts | grep -v test
# → conductor.ts:687 (assignTask rollback, §6.2 維持)
# → conductor.ts:848 (delete branch, legacy_fallback)
# → e2e.ts:335 (E2E fixture cleanup, §2.1 対象外)
# → main.ts (taskRunId/taskId 不明 fallback, §6.3/6.4)

# main.ts pre-existing 比較
cd /Users/yamamoto/git/elevens
git show main:skills/cmux-team/manager/main.ts | grep -n "not a cmux\|not an elevens"
# → 208:      throw new ProjectRootError(`not an elevens project: ${abs}`, "not_a_project");
```
