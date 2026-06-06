---
task: T008
title: abort 経路で broken 化させない (kill→reserved 統一)
conductor: surface:265
created: 2026-05-12
status: completed
---

# 作業サマリー

## 完了したサブタスク

1. **Phase 1 (Planner)** — `plan.md` 作成: 現状コード調査・設計 (A 案 = `ABORT_TASK` message 集約)・TDD 実装ステップ・テスト設計・影響範囲を整理
2. **Phase 2 (Design Review)** — `design-review.md` で **Approved** 判定 (Critical 0、Recommendations 7 件)。実コードと plan の照合・FSM 不変条件・観察箱メトリクス影響を確認
3. **Phase 3 (Implementer)** — TDD で実装。`schema.ts` / `daemon.ts` / `main.ts` を編集、`schema.test.ts` / `daemon.test.ts` / `main.test.ts` にテスト追加
4. **Phase 4 (Inspector)** — `inspection.md` で **GO** 判定 (Fix Required 0、minor 3 件)。全テスト green、tsc 新規エラー 0 件

## 変更ファイル

| ファイル | 内容 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `AbortTaskMessage` 追加 + `QueueMessage` discriminated union / type alias 拡張 |
| `skills/cmux-team/manager/daemon.ts` | `case "ABORT_TASK":` handler を `RESET_CONDUCTOR` の直後に追加。R1 (watcher 停止) → R2 (markTaskAborted) → R3 (insertTaskSession) → R4 (kill + abort_signal_sent) → R5 (resetConductor reserved) のシーケンス |
| `skills/cmux-team/manager/main.ts` | `cmdAbortTask` の conductor 有りパスを `postMessage({type:"ABORT_TASK", ...})` 1 行に集約。`cleanupAssignedTask` / 直接 trace DB / `CONDUCTOR_DONE postMessage` / `cmux.send spawn-conductor` を削除。no-conductor early-return は完全維持 |
| `skills/cmux-team/manager/schema.test.ts` | `ABORT_TASK` の QueueMessage parse + `AbortTaskMessage` 単体 parse テスト 7 ケース |
| `skills/cmux-team/manager/daemon.test.ts` | `describe("T008 ABORT_TASK ...")` で 6 ケース (reserved 遷移 / 6 分後 broken 不発 / not_found / stale_task_id / pid undefined / cascade) |
| `skills/cmux-team/manager/main.test.ts` | M1: conductor 有りパスで `ABORT_TASK` が postMessage されることを検証 |
| `package-lock.json` | リリース時 (v0.5.0 → v0.6.0) の自動更新 (worktree が古い base から派生したため取り込み) |

## テスト結果

```
schema.test.ts    116 pass / 0 fail
daemon.test.ts    232 pass / 2 skip / 0 fail
main.test.ts      275 pass / 0 fail
task.test.ts      128 pass / 0 fail
```

`bunx tsc --noEmit` で touch ファイル起因の新規エラー 0 件。
既存エラー (`main.ts:975` / `c11-features.*` / `mailbox-cli.ts`) は `git stash` で再現確認、本タスク無関係。

## 期待挙動の達成

| 期待 | 実装 |
|---|---|
| ユーザーが `elevens abort-task` 実行で Conductor が即時 reserved になる | ✅ `daemon.ts` ABORT_TASK handler の R5 で `targetStatus: "reserved"` を呼ぶ |
| pid_watcher 誤発火 (`conductor_disconnected`) が出ない | ✅ R1 で watcher を kill より前に停止 |
| 5 分後の `disconnect_timeout` → broken が発生しない | ✅ `monitorConductors` の disconnected ガードで reserved は skip される (テスト #2 で実遷移検証) |
| 次の ready task で reserved → assigning → running に自然遷移 | ✅ `requestWakeup` で次 tick の `findIdleConductor` が拾う (本タスクでは状態遷移の不変条件で間接証明) |

## Design Review Recommendations 取り込み

| # | Rec | 取り込み |
|---|---|---|
| 1 | `method=kill_claude_process` 採用 | ✅ 実装 (production grep ヒット 0 件で互換性 OK) |
| 2 | `restart-task` 同型 bug の明記 | ✅ Follow-up に記載 (別タスクで起票候補) |
| 3 | `resetConductor` reason 型混同コメント | ✅ handler に 1 行 |
| 4 | `method=none` ログ抑制 | ✅ T260 旧挙動を継承 |
| 5 | `state.traceDb = initDB(testDir)` 初期化 | ✅ T008 daemon テスト 4 ケースで明示 |
| 6 | R5 後の追加ログ禁止 | ✅ Decision D12 集約を尊重 |
| 7 | メトリクス note | ✅ Follow-up に記載 (CHANGELOG / `docs/spec/11-metrics.md` 別タスク) |

## Follow-up (本タスクのスコープ外)

1. **`restart-task` 経路の同型 bug**: `cmdRestartTask` (`main.ts:5323`) も `cleanupAssignedTask` で `process.kill(pid, SIGTERM)` → `CONDUCTOR_DONE` を送るだけで、daemon に「watcher を先に止めて reserved に倒す」協調シグナルを送らない。理屈上 abort-task と同じ「kill → pid_watcher disconnected → 5 分後 broken」race を起こしうる。`RESTART_TASK` メッセージで集約する別タスクで対応する。
2. **メトリクス影響 note**: T008 で「abort 起点の broken_count」が観測上消える。`cmux-team-analyze` cohort クエリで `broken_count` が T008 マージ以降に減ったとき「構造変化」と区別できるよう、CHANGELOG または `docs/spec/11-metrics.md` に一文入れる。
3. **`abort_signal_sent method=...` ラベル変更**: 旧 `sigterm` → 新 `kill_claude_process`。production 配下 grep ヒット 0 件 (`CHANGELOG.md` / `tasks-archive` のみ) のため後方互換問題なしだが、CHANGELOG に 1 行残しておくと retrospective 解析がブレない。

## 納品

- 方式: **ローカル ff-only マージ**
- マージ先: `main`
- マージコミット SHA: `46e633145711300d45dbfbd9cdc1c501cb04f771`

## 残課題

なし (Inspector minor 指摘 3 件はいずれも GO に影響しない / Follow-up に転記済)。
