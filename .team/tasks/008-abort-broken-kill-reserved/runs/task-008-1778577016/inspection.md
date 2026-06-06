---
task: T008
title: abort 経路で broken 化させない (kill→reserved 統一)
inspector: surface:265 (inspector)
created: 2026-05-12
verdict: GO
---

# Inspection

## 判定
GO

## サマリ

A 案 (`ABORT_TASK` メッセージを daemon 側で集約処理) が plan / design-review 通りに実装されており、本タスクの構造的肝である **R1 (watcher 停止) を R4 (kill) より前に置く順序** が `daemon.ts:1782-1789` → `1832-1852` で確実に確保されている。テストは plan §5 の 7 ケースのうち #3 (findIdleConductor 経由の再 assign 統合) を除く 6 ケースが実装され、特に **ステップ C「6 分時計を進めても broken に倒れない」テスト** は `disconnectedAt = 10 分前` を強制設定したうえで `monitorConductors` を実呼び出しし、`status === "reserved"` を assert しているため silent green ではない。

CLI 側 `cmdAbortTask` の集約も plan §3.3 通りで、`cleanupAssignedTask` / 直接 trace DB / `CONDUCTOR_DONE postMessage` / `cmux.send spawn-conductor` を全て削除して `postMessage({ type: "ABORT_TASK", ... })` の 1 行に絞られている。no-conductor path も完全に維持。Design Review Recommendations 1〜6 は全て実装側で取り込み済 (method ラベル = `kill_claude_process` / pid undefined 抑制 / reason 型混同コメント / D12 集約ログ尊重 / trace DB init / R5 後ログ無し)。Rec 2 / 7 は Follow-up としてスコープ外明記。

`bun test` の 4 ファイル個別実行は全て green、`bunx tsc --noEmit` で touch ファイル起因の新規エラーは 0 件 (既存の `main.ts:975` は git stash で再現確認、T008 着手前から存在)。構造的バグ・race 不備・観察箱原則違反は検出されず、GO 判定とした。

## 確認したこと

### 1. plan / review 通りの実装

- `schema.ts:55-69` に `AbortTaskMessage` 追加。`QueueMessage` discriminated union (`schema.ts:271`) と type alias (`schema.ts:297`) に組み込み済。
- `daemon.ts:1758-1864` の `case "ABORT_TASK":` が plan §3.2 の順序通り:
  1. surface lookup → `abort_task_ignored reason=not_found` 早期 return (1762-1769)
  2. `conductor.taskId !== message.taskId` mismatch → `abort_task_ignored reason=stale_task_id` 早期 return (1773-1779)
  3. **R1: watcher 停止 (pidWatcherInterval / mailboxWatcherStop)** (1782-1789) ← kill より前 ★
  4. R2: `markTaskAborted("abort_task", ...)` + `revertedChildren.length > 0` のときのみ `notifyStateChanged("daemon.ts:handleMessage:abort-task-cascade")` (1791-1813)
  5. R3: `state.traceDb` 経由 `insertTaskSession(event="aborted", role="conductor")` (1815-1829)
  6. R4: `conductor.pid = undefined` 退避 → `backend.killClaudeProcess` + `abort_signal_sent ... method=kill_claude_process pid=${killTarget}` (1832-1852)
  7. R5: `resetConductor(conductor, ..., { targetStatus: "reserved", reason: "abort_task" }, ccBackend(state.backend))` (1854-1859)
  8. `requestWakeup(state)` (1862)
- `main.ts:cmdAbortTask` は `postMessage({ type: "ABORT_TASK", taskId, surface, taskTitle: title, journal, timestamp })` 1 行 (`main.ts:5157-5164`) に集約。`cleanupAssignedTask` / 直接 trace DB / `CONDUCTOR_DONE` / `cmux.send spawn-conductor` を削除。
- no-conductor early-return は CLI 側で完全維持 (markTaskAborted + TASK_UPDATED の経路は変更なし)。
- Design Review Recommendations 1〜6 が全て反映 (implementation.md 取り込み表を実コードで全件突合・一致を確認)。

### 2. テストの妥当性

- `schema.test.ts:138-211` で `QueueMessage` 経由 + `AbortTaskMessage` 単体の parse テスト計 7 ケース (正常系 + 必須欠落 reject + type mismatch reject)。
- `daemon.test.ts:3662-3960` に `describe("T008 ABORT_TASK ...")` 6 ケース:
  1. reserved 遷移 + R1〜R5 全段検証 (watcher 停止 / aborted journal / trace DB row / killClaudeProcess 呼び出し / status=reserved / pid undefined)
  2. **6 分後 broken 不発** (`conductor.disconnectedAt = new Date(Date.now() - 10 * 60 * 1000)` を強制設定 → `monitorConductors(state)` を実呼び出し → `expect(conductor.status).toBe("reserved")`)。`monitorConductors` 内 `daemon.ts:4330` の `if (conductor.status === "disconnected")` ガードで reserved な conductor が skip されることを **実遷移ベース** で検証 (silent green ではない)。
  3. not_found 早期 return
  4. stale_task_id 早期 return (watcher も止まらない / pid 不変)
  5. pid undefined のとき killClaudeProcess 未呼び出し
  6. revertedChildren cascade (子 task: ready → draft 巻き戻り)
- plan §5 #3 (findIdleConductor 経由の再 assign 統合テスト) は省略されているが、これは plan 自身が「再 assign は除外 OK」と明示しており、状態遷移レベルでは #2 の reserved 維持で本タスク要件を満たすため許容。
- `main.test.ts:923-955` の M1 で `runCli(["abort-task", ...])` 後 `receivedMessages.map(m => m.type) === ["ABORT_TASK"]` を assert、`taskId` / `surface` / `journal` / `taskTitle` が乗ること + `stdout` に `"returning to reserved"` が含まれることを検証。M2 (912 行の no-conductor early-return) は変更なしで継続 pass。
- `grep "broken.*abort\|abort.*broken" *.test.ts` ヒット 0 件 → 既存 broken 期待テストの assertion 更新不要 (design-review §検証ログと一致)。

### 3. テスト実行結果

```bash
$ cd /Users/yamamoto/git/elevens/.worktrees/task-008-1778577016/skills/cmux-team/manager

$ bun test --timeout 30000 schema.test.ts
 116 pass / 0 fail / 208 expect() calls

$ bun test --timeout 30000 daemon.test.ts
 232 pass / 2 skip / 0 fail / 816 expect() calls

$ bun test --timeout 30000 main.test.ts
 275 pass / 0 fail / 753 expect() calls

$ bun test --timeout 30000 task.test.ts
 128 pass / 0 fail / 236 expect() calls

$ bunx tsc --noEmit  (touch ファイル起因の新規エラー 0 件)
 c11-features.test.ts(129,14)  ← 既存 (T008 無関係)
 c11-features.ts(246,22)        ← 既存
 mailbox-cli.ts(29,9)           ← 既存
 main.ts(975,7)                 ← 既存 (git stash で再現確認: stash 後も同じエラーが残存)
```

`bun test` 全体実行は CLAUDE.md §既知の注意点に従い未実行。

### 4. 構造的バグの有無

- **watcher 停止が kill より前**: `daemon.ts:1782-1789` (R1) → `1832-1852` (R4) の順で実装。順序逆転なし。
- **重複 ABORT_TASK race**: watcher 停止は `undefined` チェック付きで idempotent。`markTaskAborted` も `task.ts:661` で `idempotentSkip` を返すため二重発火しても state 不変。
- **ABORT_TASK + SESSION_CLEAR 同時着火**: `conductor.taskId !== message.taskId` の stale_task_id ガードで防御。pid は `R4` 直前で `undefined` に退避するため二重 kill は backend 側で `killTarget !== undefined` のチェックを通過しない。
- **`cleanupAssignedTask` 呼び出し元**: `grep cleanupAssignedTask skills/cmux-team/manager/main.ts` → 定義 (4932) と `cmdRestartTask` (5323) の 2 箇所のみ。abort-task 経路 (旧 5153) からは削除済。
- **未使用 import**: `initDB` / `insertTaskSession` は `main.ts` で他経路 (spawn-conductor / report 等) でも使用継続のため import 削除不要。dead code 残存なし。

### 5. CLAUDE.md / 観察箱原則

- `abort_signal_sent` ログを grep するコード: production 配下 0 件 (CHANGELOG.md:784 のリリースノートのみ)。`method=sigterm` 互換性も問題なし。
- 新 ログ `abort_signal_sent ... reason=abort_task method=kill_claude_process pid=...` は semantic に忠実 (旧 `method=sigterm` から `kill_claude_process` への semantic 強化)。
- R5 後の追加ログ無し → Decision D12 (resetConductor 内 `conductor_reset` 集約発行を尊重) 遵守。
- trace DB 経路は `state.traceDb` 経由に集約され、CLI 側 `initDB` / `db.close()` の重複が abort-task 経路から消えた → 観察箱の DB 接続管理が一元化。
- silent state mutation なし: `markTaskAborted` 経由で journal / cascade / events.jsonl emit が全て一箇所で発生。

## 良い点

- **R1 順序の明示性**: handler コメント (`daemon.ts:1762-1764`) で「R1〜R5 paradigm」「watcher 停止 → kill 前」を明文化。RESET_CONDUCTOR / SESSION_CLEAR running と完全に同形になり、CLAUDE.md「構造的正しさを優先」原則に沿う。
- **核心テスト #2 (6 分後 broken 不発) の証明戦略**: `disconnectedAt` を 10 分前に強制設定 + `monitorConductors` 実呼び出しで「reserved が timeout 判定で skip される」状態遷移を直接検証。Design Review §良い点と完全一致。
- **stale_task_id ガード**: SESSION_CLEAR の `taskRunId` ガード (`daemon.ts:2860`) と発想が揃った race 防御を導入。テスト #4 で「watcher も止まらない / pid 不変」まで assert している。
- **`reason` 型混同への 1 行コメント** (`daemon.ts:1854-1855`): Design Review Rec 3 を実装側で明示的に取り込み、後段読者の事故を予防。
- **`method=none` 抑制方針** (Rec 4): T260 旧挙動を継承し、handler 内 `else` 分岐を丸ごと省略 (`daemon.ts:1832-1852`)。log 互換性が崩れない。
- **trace DB init の明示** (Rec 5): T008 daemon テスト 4 ケースで `state.traceDb = initDB(testDir)` を明示初期化し、silent green を構造的に排除。
- **Follow-up の明記** (implementation.md §Follow-up): restart-task 同型 bug / metrics note / CHANGELOG 更新の 3 件を次タスク候補として残し、本タスクのスコープ境界が明確。

## Fix Required (NOGO の根拠)

なし。

## minor 指摘 (GO だが改善余地)

- **テスト #3 (findIdleConductor 経由の再 assign 統合テスト) の省略理由を implementation.md に 1 行明記したい**。plan §5 では「再 assign は除外 OK」と書かれているが、reader が implementation.md を独立に読んだとき plan §5 の 7 ケース vs 実装の 6 ケースの差分理由を辿れない。本タスクの核心は #2 で押さえられているため GO に影響しないが、Follow-up コメントで足すと親切。
- **`AbortTaskMessage` の type alias 重複名衝突** (`schema.ts:297`): `export type AbortTaskMessage = z.infer<typeof AbortTaskMessage>` は zod object と同名 type を上書きする TypeScript の慣例 (既存 `ResetConductorMessage` 等と同形) で動作に問題ないが、構造的には declaration merging のため新 reader がやや混乱しやすい。既存 paradigm に合わせているので互換性最優先で OK。
- **`abort_signal_sent` ログの新 `method=kill_claude_process` ラベル**: production 配下 grep ヒット 0 件で後方互換 OK だが、`cmux-team-analyze` 等の cohort クエリで `method` を後から filter する場合に「T008 マージ前後で別ラベル」になる点を CHANGELOG に 1 行残すと retrospective 解析がブレない (implementation.md の Follow-up #3 で既に next-task 化済み)。

## テスト実行結果

```bash
$ cd /Users/yamamoto/git/elevens/.worktrees/task-008-1778577016/skills/cmux-team/manager

$ bun test --timeout 30000 schema.test.ts
bun test v1.3.13 (bf2e2cec)
 116 pass
 0 fail
 208 expect() calls
Ran 116 tests across 2 files. [49.00ms]

$ bun test --timeout 30000 daemon.test.ts
bun test v1.3.13 (bf2e2cec)
 232 pass
 2 skip
 0 fail
 816 expect() calls
Ran 234 tests across 1 file. [8.80s]

$ bun test --timeout 30000 main.test.ts
bun test v1.3.13 (bf2e2cec)
 275 pass
 0 fail
 753 expect() calls
Ran 275 tests across 1 file. [23.08s]

$ bun test --timeout 30000 task.test.ts
bun test v1.3.13 (bf2e2cec)
 128 pass
 0 fail
 236 expect() calls
Ran 128 tests across 1 file. [190.00ms]

$ bunx tsc --noEmit  # touch ファイル起因の新規エラー 0 件
 c11-features.test.ts(129,14): error TS2722  ← 既存 (T008 touch 外)
 c11-features.ts(246,22): error TS2345        ← 既存 (T008 touch 外)
 mailbox-cli.ts(29,9): error TS18048           ← 既存 (T008 touch 外)
 main.ts(975,7): error TS2322                  ← 既存 (git stash 後も再現を確認)
```

**触ったファイル (schema.ts / daemon.ts / main.ts / schema.test.ts / daemon.test.ts / main.test.ts) 由来の新規 tsc エラー: 0 件。**

`main.ts:975` のエラーは `git stash` 後にも同一行で再現することを確認 (Implementer 主張通り、T008 着手前から存在)。`c11-features.ts` / `c11-features.test.ts` / `mailbox-cli.ts` の既存エラーは本タスク touch ファイル外。
