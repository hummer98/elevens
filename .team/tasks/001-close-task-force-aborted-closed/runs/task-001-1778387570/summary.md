# Task 001: `close-task --force` で aborted → closed への上書きを許可

## 完了状態

- **Inspection**: GO（Critical/Fix Required なし、Minor は blocking でない）
- **テスト**: 4 ファイル全 pass（fsm 191 / task-state-store 44 / apply-task-actions 15 / main 259）
- **TSC**: 新規エラー 0（既存 8 件は本タスク touch ファイル外）

## 変更ファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/state-machine/events.ts` | CLOSE event に `force?: boolean` / `prevAbortedAt?: string` を追加 |
| `skills/cmux-team/manager/state-machine/task-fsm.ts` | CLOSE reducer に `aborted+force=true → closed` 分岐追加（log event = `task_closed_from_aborted`、detail に `prev_aborted_at=<ISO>`） |
| `skills/cmux-team/manager/main.ts` | `cmdCloseTask` に aborted ガード追加（`--force` なしで exit 1）+ applyTaskEvent への force/prevAbortedAt 渡し |
| `docs/spec/07-state-machine.md` | 2.2 遷移表に `CLOSE(force=true)` 行追加、2.3 Mermaid に `aborted --> closed` 追加、footnote `[^t6]` 追記 |
| `skills/cmux-team/manager/state-machine/fsm.test.ts` | reducer 単体テスト 6 ケース追加（aborted+force=true / =false / closed+force=true / deleted+force=true / assigned+force=true / deleted 終端 events 配列拡張） |
| `skills/cmux-team/manager/state-machine/task-state-store.test.ts` | applyTaskEvent 経由テスト 2 ケース追加（force=true で abortedAt 残置 + log event / force=false で committed=false） |
| `skills/cmux-team/manager/state-machine/apply-task-actions.test.ts` | T358 events.jsonl allowlist 確認に `task_closed_from_aborted` 追加 |
| `skills/cmux-team/manager/main.test.ts` | CLI 統合テスト 3 ケース追加（reject / closed 遷移 + abortedAt 残置 / journal 省略許容） |

## 仕様適合

- `--force` 必須: `--force` なしで aborted タスクを close すると exit 1（CLI ガード）
- FSM: aborted+force=true → closed、`closed → closed` は引き続き noop（誤操作防止）
- log event: `task_closed_from_aborted`（events.jsonl allowlist 外、manager.log のみ）
- abortedAt 残置 + closedAt 新規付与（trace 可能性確保）
- cascade なし（aborted 時点で子は既に降格済み）

## 観察可能性

events.jsonl に `task_aborted_core` → `task_closed_from_aborted` の順で残るのは false（後者は events.jsonl に流れない）。manager.log で `task_closed_from_aborted` を grep することで「aborted_then_closed」中間遷移を別カウント可能。タスク本文の「観察可能性への配慮」§ にあった「events.jsonl に残る」表現は厳密には manager.log に残るが、metrics 集計で区別可能という意図は満たしている。

## 非対象（仕様通りスコープ外）

- `closed → closed` の上書き（noop のまま）
- `--force` を journal 必須化（journal 省略許容）
- restart-task の挙動変更
- TUI / dashboard の表示変更

## 注記（タスクスコープ外）

worktree bootstrap 時の `npm install` で package-lock.json の name/version が `@hummer98/cmux-team@4.28.1` → `@hummer98/elevens@0.4.1` に更新されたが、これは本タスクの作業とは無関係なので commit から除外する。
