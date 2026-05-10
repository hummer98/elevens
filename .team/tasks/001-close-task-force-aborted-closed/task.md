---
id: 001
title: close-task: --force で aborted → closed への上書きを許可
priority: medium
created_by: surface:119
created_at: 2026-05-10T04:32:50.144Z
---

## タスク
## 背景・動機

AI（Conductor / Agent）が `success=false` を返してタスクが `aborted` になっても、Master/ユーザーが成果物を確認した結果「実質的には成功」と判断するケースがある。現状はこの上書きができず、`restart-task → close-task` の 2 段階で迂回するか、aborted のまま放置するしかない。

`close-task --force` で `aborted → closed` への上書きを許可する。AI の自動判定の誤りを人間が修正できる経路を作る。

## 仕様

### CLI

- `elevens close-task --task-id <id> --deliverable-kind <kind> --force [--journal <text>]`
- `--force` 必須。`--force` なしで aborted タスクを close しようとした場合は exit 1
- `--journal` は推奨（必須化はしない。運用で「なぜ後から closed 扱いにするか」を残させる）
- deliverable は通常通り必須（`--deliverable-kind <files|merged|pr|none>` + kind 別フラグ）

### FSM

`skills/cmux-team/manager/state-machine/task-fsm.ts` の `CLOSE` reducer:

- 既存: `assigned` / `ready` / `draft` → `closed`
- 追加: `state === "aborted"` かつ `event.force === true` → `closed`（log event = `task_closed_from_aborted`、detail に直前の `abortedAt` があれば `prev_aborted_at=...` を含めて trace 可能にする）
- `closed` への上書きは引き続き noop（誤操作防止）
- cascade なし（abort 時に子は既に降格済み）

### events.ts

`CLOSE` event に `force?: boolean` を追加（既存の `DELETE` と同パターン）。

### main.ts (cmdCloseTask)

- 既存の assigned ガード（`main.ts:4328` 付近）と並列に `aborted` ガードを追加: `--force` なしで aborted の場合は exit 1（エラーメッセージで `--force` 必須を案内）
- `applyTaskEvent` 呼び出し時に `event: { type: "CLOSE", force: true }` を渡す（aborted 経路）。assigned/ready/draft 経路は force 無しで OK
- closedAt は新規付与、abortedAt は残置（履歴として task-state.json に両方保持）

### spec 更新

`docs/spec/07-state-machine.md`:
- 2.2 遷移表: `CLOSE(force=true)` 行を追加し `aborted → closed` を記載
- 2.3 Mermaid 図に `aborted --> closed : CLOSE(force=true)` を追加
- 2.4 cascade ルールには触れず（cascade 不要）
- footnote で `task_closed_from_aborted` log event の存在を明記

### テスト

- `state-machine/fsm.test.ts`: `CLOSE force=true` で aborted → closed、`force=false` で aborted noop を確認
- `state-machine/apply-task-actions.test.ts` または既存の close-task 経由テスト: log event が `task_closed_from_aborted` で emit されることを確認
- 既存の close-task テスト（assigned --force / ready / draft）に regression がないこと

## 観察可能性への配慮

- events.jsonl に `task_aborted_core` → `task_closed_from_aborted` の順で残るため、metrics 集計時に「最終状態が closed なら成功扱い」「aborted_then_closed のような中間遷移を別カウント」など分析できる粒度を保つ
- `task_closed_from_aborted` は新 event 名にすることで、通常の close (`task_closed`) と区別可能にする

## 非対象

- `closed → closed` の上書き（noop のまま）
- `--force` を journal 必須化
- restart-task の挙動変更
- TUI / dashboard の表示変更（必要なら別タスクで）
