---
id: 014
title: Manager 再起動時に Conductor の asking 状態と askQuestion を喪失するバグを修正
priority: high
created_by: surface:739
created_at: 2026-05-19T17:28:18.007Z
---

## タスク
## 背景

Manager が再起動（`elevens start`）すると、`asking` 状態の Conductor は `idle` として復元され、`askQuestion` も失われる。Conductor 本体 (claude プロセス) は ask 入力待ちで blocking 中なので PID は生存しており、A 経路 (keep-alive) で surface・taskId・taskRunId・worktreePath は正しく復元されるが、status のみ落ちる。

これは observatory 原則（state を外部化し、観察者が pull で観測できる）に反するバグ。再起動を跨ぐと「ask 中で停止している Conductor」が見えなくなり、Master が「idle なのに新タスクを assign できない（実は ask 中）」という silent fail を引き起こす。

## 該当箇所と現状

### 1. `updateTeamJson` (`skills/cmux-team/manager/daemon.ts:4705-4735`)

team.json に conductors を書き出すマップに **`askQuestion` フィールドが含まれていない**。Zod schema (`skills/cmux-team/manager/schema.ts:413`) には定義済みだが、書き手が出力していないので team.json には永続化されない。

### 2. `restoreConductorState` (`skills/cmux-team/manager/daemon.ts:1067-1110`)

status の復元分岐:

```ts
status:
  c.status === "running"      ? "running"
  : c.status === "disconnected" ? "disconnected"
  : c.status === "broken"     ? "broken"
  : c.status === "reserved"   ? "reserved"
  : "idle",
```

`asking` が明示分岐に無いため `idle` に倒される。また `askQuestion` も復元されない (返り値に含まれない)。

ConductorStatus 9 値のうち `starting` / `assigning` / `error` も idle に倒れるが、これらは過渡状態であり次の SESSION_* hook で正常化される（T392 仕様通り）ので実害は限定的。`asking` だけは「ユーザー入力待ち」で自発 hook が来ないため idle に固定されてしまう。

## 修正内容

### Edit 1: `updateTeamJson` の conductors map に `askQuestion` を追加

`skills/cmux-team/manager/daemon.ts:4705-4735` 付近、conductors のオブジェクトリテラルに以下を追記:

```ts
// T181: AskUserQuestion 検出時の質問本文。Manager 再起動後も asking 状態を
//       復元できるよう永続化する。SESSION_STARTED/IDLE 経路で undefined に戻る。
askQuestion: c.askQuestion,
```

### Edit 2: `restoreConductorState` で `asking` を分岐に追加 + `askQuestion` を復元

`skills/cmux-team/manager/daemon.ts:1067-1110`:

- 戻り値のオブジェクトリテラルに `askQuestion: c.askQuestion` を追加
- status 分岐に `c.status === "asking"` を追加（ただし `c.askQuestion` が非空のときのみ。空の場合は idle に倒す＝防御的）

```ts
status:
  c.status === "running"      ? "running"
  : c.status === "disconnected" ? "disconnected"
  : c.status === "broken"     ? "broken"
  : c.status === "reserved"   ? "reserved"
  : c.status === "asking" && typeof c.askQuestion === "string" && c.askQuestion.length > 0 ? "asking"
  : "idle",
```

コメントで「asking を含む理由」を 1 行記述（observatory 原則: 再起動後も ask 中の Conductor を観測可能にする）。

### Edit 3: テスト追加

`skills/cmux-team/manager/daemon.test.ts` または新 test file:

- updateTeamJson で `c.status = "asking" / askQuestion = "Q1"` を持つ Conductor を書き出すと、JSON に `askQuestion` フィールドが含まれる
- restoreConductorState で `{ status: "asking", askQuestion: "Q1" }` を入力すると `{ status: "asking", askQuestion: "Q1" }` が返る
- restoreConductorState で `{ status: "asking", askQuestion: undefined }` を入力すると `status: "idle"` に倒される（防御）

### Edit 4: docs/spec 更新

該当節（`docs/spec/07-state-machine.md` などの Conductor FSM 永続化セクション）に「`asking` も再起動後に保持される / `askQuestion` も永続化される」と追記。

## 触らない

- `applyResumeTransitions` / `layout-restore.ts` の分類ロジック（A〜E 経路は無変更）
- daemon の SESSION_ASK ハンドリング（既存通り）
- task-state.json schema（task の status は影響なし）
- Task FSM（無変更）
- events.jsonl / dashboard / Epic Planner（read 側は team.json の status を見れば自然に追従する）

## 完了条件

- 上記 4 ファイルの編集が完了
- 新規テスト pass
- 既存テスト pass（regression なし）

## 補足: 関連する design 議論

過去の議論で「await-task に Conductor ask 検知を追加（exit code 3）」(deleted T009) を検討した際、team.json の `conductor.status === "asking"` を watch する設計だった。本タスクが先に入れば、await-task 側を再検討するときも team.json の asking が再起動を跨いで生き残るので、ask 監視機構の信頼性が上がる。
