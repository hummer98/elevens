---
id: 009
title: await-task に Conductor ask 検知を追加（exit code 3）
priority: high
created_by: surface:739
created_at: 2026-05-16T16:20:15.090Z
---

## タスク
## 背景

現状の `cmdAwaitTask`（`skills/cmux-team/manager/main.ts:4637-4717`）は `task-state.json` のみを `fs.watch` し、対象タスクの `status` が `closed` / `aborted` になった瞬間にだけ反応する。

一方、Conductor が AskUserQuestion を発した場合、daemon は次を行うが **task-state.json は変更しない**:

- `team.json` の `conductors[].status = "asking"` / `askQuestion = "<質問文>"` を set（`daemon.ts:2836-2839`）
- `events.jsonl` に `conductor_asking` を emit
- `manager.log` に `conductor_asking` を記録

よって `await-task` で blocking している Master プロセスは、Conductor が ask で停止していてもタイムアウトまで気付けない。

設計趣旨（Conductor の ask = Master 判断点 = 自律動作 or ユーザーエスカレーション）と整合しないので、`await-task` 単独でこれを解決する。

**Manager 側は変更しない。** daemon・FSM・events.jsonl・Epic Planner template は触らない。観察軸を増やすのではなく、既存の `team.json` を `await-task` から読むだけ。

## 実装

### 1. `cmdAwaitTask` に team.json watcher を追加

`skills/cmux-team/manager/main.ts:4637-4717` の `cmdAwaitTask`:

- 既存: `.team/task-state.json` を fs.watch → closed/aborted を検知
- 追加: `.team/team.json` を fs.watch → 対象 task に紐づく conductor の `status == "asking"` を検知

対象 conductor の特定:

- `team.json` の `conductors[]` から `assignedTaskRunId` が `--task-id` で指定されたいずれかの task に対応するものを探す
- 該当 conductor の `status === "asking"` かつ `askQuestion` が非空ならば ask 検知

複数 task ID（カンマ区切り）対応: いずれか 1 つでも ask 検知 → 即 exit 3。

### 2. 新 exit code 3 の定義

既存:
- 0: 全 closed
- 1: いずれか aborted
- 2: timeout

追加:
- **3: いずれかの task で conductor が ask 中**

### 3. stdout 仕様

ask 検知時に stdout に以下を出力して exit 3:

```
Task T<NNN> paused: conductor <surface> is waiting for user input.
Question: <question 全文>
Read the surface to respond: cmux read --surface <surface>
```

複数 task の場合は ask が出た task についてのみ出力（残りはまだ進行中の可能性があるので、Master が判断）。

### 4. 既知の race condition

- 起動直後にすでに ask 中の場合: initial state load 時点で `team.json` も読み、該当 conductor が asking なら即 exit 3
- watcher 開始から initial check までの TOCTOU: 既存の `cmdAwaitAgent` と同じく watcher 先起動 + 初期 check の二段構え

### 5. テスト

`main.test.ts` または別 test file に追加:

- ask 検知 → exit 3 + stdout に question 全文が含まれる
- 起動時に既に ask 中 → 即 exit 3
- closed が先 → 既存通り exit 0
- aborted が先 → 既存通り exit 1
- 複数 task のうち 1 つが ask → exit 3、残りは継続せず即 exit

### 6. docs/spec 同期

- `docs/spec/07-state-machine.md` または該当節で `await-task` の exit code 表を更新
- exit code 3 を追加: 「いずれかの task で conductor が ask 中」

## 影響範囲

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/main.ts` | `cmdAwaitTask` 拡張 |
| `skills/cmux-team/manager/main.test.ts` または新 test file | テスト追加 |
| `skills/cmux-team/manager/i18n.ts` | `help_await_task` の exit code 表を更新（必要なら） |
| `docs/spec/07-state-machine.md` 等 | exit code 仕様の同期 |

**触らない:**
- `daemon.ts`（既に team.json に asking を書いている）
- `state-machine/`（FSM 不変）
- `events-writer.ts` / `events-cli.ts`（既存の `conductor_asking` イベントはそのまま）
- Epic Planner template（Planner は await-task を使わない / 将来使う場合も同じ exit 3 で済む）

## 完了条件

- `cmdAwaitTask` が ask 検知時に exit 3 + stdout 仕様通り出力
- 新規テスト pass
- 既存テスト pass（regression なし）
- docs/spec の exit code 表が更新済み

## 補足

設計議論の経緯:

- 当初 D 案（TaskState に pendingAsk フィールド追加）を検討したが、status FSM に直交する補助フィールドも実質状態軸を増やすため却下
- F 案（Manager が複数経路に観察を提供）も検討したが、必要なのは await-task の return value だけだったので過剰と判断
- 結論: Manager 側は無変更、await-task の read side のみ拡張
