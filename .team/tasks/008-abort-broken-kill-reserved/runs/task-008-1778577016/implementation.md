---
task: T008
title: abort 経路で broken 化させない (kill→reserved 統一)
author: surface:265 (implementer)
created: 2026-05-12
---

# 実装結果サマリー

## 変更ファイル

| ファイル | 内容 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `AbortTaskMessage` 追加 + `QueueMessage` union / type alias 拡張 |
| `skills/cmux-team/manager/daemon.ts` | `case "ABORT_TASK":` handler を AGENT_TOKEN_BOUND の前に追加（R1〜R5 シーケンス） |
| `skills/cmux-team/manager/main.ts` | `cmdAbortTask` の conductor 有りパスを ABORT_TASK postMessage 1 行に集約。`cleanupAssignedTask` / 直接 trace DB / `CONDUCTOR_DONE` / `cmux.send spawn-conductor` を削除 |
| `skills/cmux-team/manager/schema.test.ts` | `ABORT_TASK` の QueueMessage parse テスト + `AbortTaskMessage` 単体 parse テストを追加 |
| `skills/cmux-team/manager/daemon.test.ts` | `describe("T008 ABORT_TASK ...")` で 6 ケース追加（reserved 遷移 / 6 分後 broken 不発 / not_found / stale_task_id / pid undefined / cascade） |
| `skills/cmux-team/manager/main.test.ts` | conductor 有りパスで ABORT_TASK が postMessage される M1 テストを追加 |

## 追加テスト

### `schema.test.ts`（5 ケース）

1. `QueueMessage` 経由で `ABORT_TASK` を parse できる（必須最小）
2. `ABORT_TASK` を `taskTitle` / `journal` 付きで parse できる
3. `ABORT_TASK`: `taskId` 欠落で reject
4. `ABORT_TASK`: `surface` 欠落で reject
5. `ABORT_TASK`: `timestamp` 欠落で reject
6. `AbortTaskMessage` 単体: 必須フィールドで parse 成功 / type 不一致で reject

### `daemon.test.ts` — `describe("T008 ABORT_TASK ...")`（6 ケース）

1. `ABORT_TASK` で running Conductor が reserved に戻り、task が aborted、trace DB に行追加（R1〜R5 全段）
2. `ABORT_TASK` 後に 6 分（disconnectedAt = 10 分前）経過しても `monitorConductors` の disconnected ガードで skip され reserved 維持（本タスクの核心）
3. 未登録 surface に来ても state 不変（`abort_task_ignored reason=not_found`）
4. `taskId` 不一致なら state 不変（`abort_task_ignored reason=stale_task_id`）
5. `conductor.pid === undefined` のとき kill は呼ばれない（旧挙動: `method=none` をログしない方針）
6. 子 task が `ready` で `depends_on: [parent]` のとき、abort で draft に巻き戻る cascade を確認

### `main.test.ts`（1 ケース追加・既存維持）

- M1: `abort-task` を conductor 有りで実行したとき、`ABORT_TASK` 1 件だけが postMessage され、`taskId` / `surface` / `journal` / `taskTitle` が乗ること。出力に `returning to reserved` を含むこと。
- M2: `abort-task: no-conductor 早期 return パスで TASK_UPDATED が送信される`（既存 912 行）は変更なしで pass 継続。

## 通したコマンドと結果

```bash
cd skills/cmux-team/manager

bun test --timeout 30000 schema.test.ts    # 116 pass, 0 fail
bun test --timeout 30000 task.test.ts      # 128 pass, 0 fail
bun test --timeout 30000 daemon.test.ts    # 232 pass, 2 skip, 0 fail
bun test --timeout 30000 main.test.ts      # 275 pass, 0 fail

bunx tsc --noEmit                          # 既存エラー数件のみ
                                           #   → touch ファイル(schema/daemon/main 系)からは
                                           #     main.ts:975 のみ。既存 (T008 着手前から存在) で
                                           #     git stash でも再現することを確認。
```

`bun test` 全体実行は CLAUDE.md §既知の注意点に従い禁忌のため、関連個別ファイルでのみ実行。

## Design Review Recommendations 取り込み状況

| # | Rec | 取り込み内容 |
|---|---|---|
| 1 | `method=` ラベル新設 | `method=kill_claude_process` を採用（plan §3.2 注 1）。production の `method=sigterm` grep ヒット 0 件確認済み。後方互換問題なし |
| 2 | `restart-task` 同型 bug を明記 | 本 implementation.md の Follow-up に記載（plan 末尾への追記は plan 確定後のため）|
| 3 | `resetConductor` の reason 引数の型混同回避 | handler 直前に「`reason` は ConductorState 用のフリーテキスト（AbortReason 型ではない）」コメント 1 行を追加 |
| 4 | `method=none` ログを出さない方針に統一 | R4 の else 分岐は丸ごと省略。pid undefined のとき `abort_signal_sent` を一切出さない（旧 T260 挙動を継承） |
| 5 | `state.traceDb = initDB(testDir)` 初期化 | T008 daemon テスト 4 ケース（trace DB を assert / 経由するケース）で全て明示初期化 |
| 6 | R5 後の追加ログ禁止 | handler 末尾は `requestWakeup(state); break;` のみ。Decision D12 集約（`resetConductor` 内の `conductor_reset` ログ）を尊重 |
| 7 | メトリクス影響 note | スコープ外。本 implementation.md の Follow-up に記載 |

## Follow-up

実装スコープ外。次タスクで対応する候補：

1. **`restart-task` 経路の同型 bug**: `cmdRestartTask` (`main.ts:5320` 付近) も `cleanupAssignedTask` で `process.kill(pid, SIGTERM)` した直後に `CONDUCTOR_DONE success=false reason=restarted` を送るだけで、daemon に「watcher を先に止めて reserved に倒す」協調シグナルを送らない。理屈上 abort-task と同じ「kill → pid_watcher が disconnected → 5 分後 broken」race を起こしうる。同様に `RESTART_TASK` メッセージで集約する別タスクとして起票する。

2. **メトリクス note**: 本変更で「abort 起点の broken_count」が観測上消える。`cmux-team-analyze` の cohort クエリで `broken_count` が T008 マージ以降に減ったとき「構造変化」と区別できるよう、CHANGELOG または `docs/spec/11-metrics.md` に一文入れる別タスクを起票する。

3. **`abort_signal_sent method=sigterm` → `method=kill_claude_process` ラベル変更の周知**: production 配下 grep ヒット 0 件のため後方互換影響はないが、CHANGELOG に一行残す（リリース時の別作業）。

## 検証境界

- worktree 内のコードのみ編集（`/Users/yamamoto/git/elevens/.worktrees/task-008-1778577016/`）
- `.team/artifacts/` には書いていない（Conductor 完了処理で扱う）
- `git add` / `git commit` していない
- 実 CLI (`elevens abort-task` / `elevens reset-conductor`) を実プロセスでは叩いていない（test 内の mock のみ）

## 実装サマリ（短く）

旧経路: CLI が `cleanupAssignedTask` で `process.kill(pid, SIGTERM)` → daemon の `pid_watcher` が独立に `pid_dead` を検出 → `conductor_disconnected` → 5 分後 `disconnect_timeout` → `forceCloseDisconnectedConductor` で `broken` 確定。

新経路: CLI は `ABORT_TASK` postMessage 1 行だけ。daemon が R1 (watcher 停止) → R2 (markTaskAborted) → R3 (trace DB) → R4 (kill) → R5 (resetConductor reserved) を集約実行。`pid_watcher` が誤発火する前に確実に停止するため `disconnected` 経路に流れない → 構造的に `broken` に倒れない。
