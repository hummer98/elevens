# Task 001: `close-task --force` で aborted → closed を許可

## 概要

`elevens close-task --force` に **aborted → closed** 経路を追加する。現状 reducer (`task-fsm.ts:102` の `// closed / aborted からは no-op` 分岐) は aborted を弾いており、CLI 側 (`main.ts:4324-4331`) も assigned ガードしか持たない。これを **DELETE reducer の `--force` パターン** (`task-fsm.ts:119-135`) と同じ構造で拡張し、

1. `events.ts` の `CLOSE` event に `force?: boolean` を追加
2. `task-fsm.ts` の `CLOSE` reducer に `aborted + force=true → closed` 分岐を追加（log event = `task_closed_from_aborted`、detail に直前 `abortedAt` を `prev_aborted_at=...` で記録）
3. `main.ts cmdCloseTask` に「`aborted` で `--force` 無し → exit 1」ガードを追加し、`aborted` 経路では `applyTaskEvent` に `event.force=true` と `event.prevAbortedAt` を渡す
4. `docs/spec/07-state-machine.md` の遷移表 / Mermaid / footnote を更新

cascade なし、`closed → closed` の上書きは引き続き noop、`abortedAt` は残置（trace 可能性確保）。`task_closed_from_aborted` は `apply-task-actions.ts:67-69` の events.jsonl allowlist 対象外なので manager.log のみに残る。

## 変更ファイル一覧

| ファイル | 変更内容 | 行数見積 |
|---|---|---|
| `skills/cmux-team/manager/state-machine/events.ts` | `CLOSE` event 型に `force?: boolean` と `prevAbortedAt?: string` を追加 | +4 行 |
| `skills/cmux-team/manager/state-machine/task-fsm.ts` | `CLOSE` reducer に `aborted + force=true → closed` 分岐を追加 | +12 行 |
| `skills/cmux-team/manager/main.ts` | `cmdCloseTask` に aborted ガード追加 + applyTaskEvent への force/prevAbortedAt 受け渡し | +10 行 |
| `skills/cmux-team/manager/state-machine/fsm.test.ts` | CLOSE force=true (aborted→closed) / force=false (aborted noop は既存) / detail prev_aborted_at テスト追加 | +60 行 |
| `skills/cmux-team/manager/state-machine/task-state-store.test.ts` | applyTaskEvent CLOSE force=true の log event 名検証 + abortedAt 残置検証を追加 | +50 行 |
| `skills/cmux-team/manager/main.test.ts` | CLI 統合: `aborted + --force` で closed に遷移、`aborted + force 無し` で exit 1 | +60 行 |
| `docs/spec/07-state-machine.md` | 2.2 遷移表に `CLOSE(force=true)` 行追加、2.3 Mermaid に `aborted --> closed` 追加、footnote 追記 | +6 行 |

合計 **コード ~26 行 + テスト ~170 行 + spec ~6 行**。

## 詳細実装手順

### 1. `events.ts`: CLOSE 型に `force` / `prevAbortedAt` 追加

**現状** (`events.ts:106`):
```ts
| { type: "CLOSE"; autoClosed?: boolean }
```

**比較対象 — DELETE のパターン** (`events.ts:108`):
```ts
| { type: "DELETE"; force?: boolean }
```

**変更後** (`events.ts:106` を以下に置換):
```ts
| {
    type: "CLOSE";
    autoClosed?: boolean;
    /** T??? : aborted → closed の上書きを許可するフラグ。aborted 以外の state では無視される。 */
    force?: boolean;
    /**
     * T??? : reducer の log detail に出す直前 abortedAt（ISO 8601）。
     * main.ts cmdCloseTask が taskState[taskId]?.abortedAt を読んで populate する。
     */
    prevAbortedAt?: string;
  }
```

`autoClosed=true` と `force=true` は経路として排他（auto-close は assigned 起点、force は aborted 起点）。同時指定はあり得ないため interface 上の制約は付けない（DELETE が同様）。

### 2. `task-fsm.ts`: CLOSE reducer に aborted+force 分岐を追加

**現状** (`task-fsm.ts:95-104`):
```ts
case "CLOSE": {
  // close-task CLI。assigned → closed が主経路。ready / draft からも可 (手動 close)。
  // T303: autoClosed=true (T274 auto-close) では区別可能な log event を emit する。
  if (state === "assigned" || state === "ready" || state === "draft") {
    const logEvent = event.autoClosed ? "task_completed_state_mismatch" : "task_closed";
    return withActions("closed", [{ type: "log", event: logEvent }]);
  }
  // closed / aborted からは no-op。
  return noop(state);
}
```

**比較対象 — DELETE reducer の force 分岐** (`task-fsm.ts:129-133`):
```ts
if (event.force && (state === "closed" || state === "aborted")) {
  return withActions("deleted", [
    { type: "log", event: "task_deleted", detail: `force=true prev=${state}` },
  ]);
}
```

**変更後** (上記 CLOSE case を以下に置換):
```ts
case "CLOSE": {
  // close-task CLI。assigned → closed が主経路。ready / draft からも可 (手動 close)。
  // T303: autoClosed=true (T274 auto-close) では区別可能な log event を emit する。
  if (state === "assigned" || state === "ready" || state === "draft") {
    const logEvent = event.autoClosed ? "task_completed_state_mismatch" : "task_closed";
    return withActions("closed", [{ type: "log", event: logEvent }]);
  }
  // T??? : aborted → closed は --force 指定時のみ。closedAt 上書きは CLI 側の patch で行い、
  //        abortedAt は残置（trace 可能性のため）。cascade なし。
  if (state === "aborted" && event.force === true) {
    const detail = event.prevAbortedAt
      ? `prev_aborted_at=${event.prevAbortedAt}`
      : undefined;
    return withActions("closed", [
      { type: "log", event: "task_closed_from_aborted", ...(detail ? { detail } : {}) },
    ]);
  }
  // closed / aborted (force 無し) からは no-op。
  return noop(state);
}
```

cascade はなし（`task_closed_from_aborted` は終端遷移であり、子タスクは aborted 時点で既に cascade 処理済み）。

### 3. `main.ts`: cmdCloseTask に aborted ガード + force 渡し

**現状** (`main.ts:4324-4353` 抜粋):
```ts
// assigned ガード: --force で明示許可（T295 F1: kind が valid に解決されていれば
// それが意図の表明なので、journal の有無ではなく --force を唯一の escape にする）
const taskState = await loadTaskState(PROJECT_ROOT);
const currentStatus = taskState[taskId]?.status;
if (currentStatus === "assigned" && !force) {
  console.error(`Error: task ${taskId} is assigned (running). Use --force to close a running task.`);
  process.exit(1);
}

// task-state.json で closed + closedAt + journal + deliverable を設定（ファイルは移動しない）
// T303: applyTaskEvent(CLOSE) 経由。reducer は assigned / ready / draft → closed に遷移。
//       それ以外 (aborted) は noop で弾かれるが CLI 入口で既に reject していない旧経路は
//       reducer で拾う (冪等)。
await applyTaskEvent(PROJECT_ROOT, {
  taskId,
  event: { type: "CLOSE" },
  ctx: { hasConductor: currentStatus === "assigned", parentAborted: false },
  patch: (_p, next) =>
    next === "closed"
      ? {
          merge: {
            closedAt: new Date().toISOString(),
            ...(journal ? { journal } : {}),
            deliverable,
          },
          // close 時は assigned 時の resume metadata をクリア (冪等)
          remove: [],
        }
      : {},
});
```

**変更後** (assigned ガード直後に aborted ガードを追加、applyTaskEvent 呼び出しの event 構築を分岐):
```ts
const taskState = await loadTaskState(PROJECT_ROOT);
const currentStatus = taskState[taskId]?.status;
if (currentStatus === "assigned" && !force) {
  console.error(`Error: task ${taskId} is assigned (running). Use --force to close a running task.`);
  process.exit(1);
}
// T??? : aborted は --force でのみ closed に上書き可。journal は推奨だが必須化はしない。
if (currentStatus === "aborted" && !force) {
  console.error(
    `Error: task ${taskId} is already aborted. Use --force to close an aborted task (journal recommended).`,
  );
  process.exit(1);
}

// T??? : aborted 経路では event.force と event.prevAbortedAt を渡す。
//        reducer は aborted+force のとき log event = task_closed_from_aborted を emit する。
const prevAbortedAt = taskState[taskId]?.abortedAt;
const closeEvent =
  currentStatus === "aborted"
    ? ({ type: "CLOSE", force: true, ...(prevAbortedAt ? { prevAbortedAt } : {}) } as const)
    : ({ type: "CLOSE" } as const);

await applyTaskEvent(PROJECT_ROOT, {
  taskId,
  event: closeEvent,
  ctx: { hasConductor: currentStatus === "assigned", parentAborted: false },
  patch: (_p, next) =>
    next === "closed"
      ? {
          merge: {
            closedAt: new Date().toISOString(),
            ...(journal ? { journal } : {}),
            deliverable,
          },
          // close 時は assigned 時の resume metadata をクリア (冪等)
          // abortedAt は merge していないので aborted→closed でも残置される
          remove: [],
        }
      : {},
});
```

**重要ポイント**:
- `assigned` ガードと `aborted` ガードは並列に置く（assigned が先で OK）
- `aborted` 経路でも `parseCloseTaskArgs` が回る（`--deliverable-kind` 必須は変わらない）。
- `patch.merge` は `closedAt` / `journal` / `deliverable` のみで `abortedAt` を触らないため、`baseEntry = { ...cur }` (`task-state-store.ts:230`) に乗っていた `abortedAt` がそのまま残る ＝ 仕様通り。
- `force` 変数 (`main.ts:4316` で parse 結果から取得) はそのまま CLI fallback 判定に使うのみで、reducer に渡す `event.force` は `currentStatus === "aborted"` でのみ true にする（assigned ガード経路は既存通り `event.force` 不要 / reducer は assigned で force を読まない）。

### 4. `docs/spec/07-state-machine.md`: 遷移表 / Mermaid / footnote

**4.1 2.2 遷移表** (`07-state-machine.md:209-210`):

現状:
```
| `CLOSE` | `closed` | `closed` | `closed` | — | — | — |
| `CLOSE(autoClosed=true)` [^t3] | `closed` | `closed` | `closed` | — | — | — |
```

直下に追加:
```
| `CLOSE(force=true)` [^t6] | `closed` | `closed` | `closed` | — | `closed` | — |
```

**4.2 2.3 Mermaid** (`07-state-machine.md:240` 直前 `aborted --> ready : RESTART` の前):

現状:
```mermaid
    aborted --> ready : RESTART
```

直前に追加:
```mermaid
    aborted --> closed : CLOSE(force=true)
```

**4.3 footnote** (`07-state-machine.md:221` の `[^t5]` の後ろ):
```
[^t6]: T??? : `--force` 指定時のみ aborted → closed を許可する救済経路。reducer の log event は `task_closed_from_aborted`、detail は `prev_aborted_at=<ISO8601>` (元の abortedAt が存在する場合)。`abortedAt` は merge せず残置し、`closedAt` を新規付与することで二重タイムスタンプによる trace 可能性を維持する。cascade なし。
```

cascade ルール (2.4) には触れない（aborted→closed は cascade 不要 — 子タスクは aborted 時点で既に cascade 処理済み）。

## テスト計画 (TDD)

### A. `state-machine/fsm.test.ts` — reducer 単体

`describe("Task FSM — CLOSE (A017 §2.2)", ...)` (line 667-688) の末尾に以下を追加:

```ts
// T??? : --force による aborted → closed 遷移
test("aborted + CLOSE (force=true) → closed + log(task_closed_from_aborted)", () => {
  const { next, actions } = taskReduce(
    "aborted",
    { type: "CLOSE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("closed");
  const log = actions.find((a) => a.type === "log");
  expect(log).toBeDefined();
  if (log && log.type === "log") {
    expect(log.event).toBe("task_closed_from_aborted");
    expect(log.detail).toBeUndefined();  // prevAbortedAt 未指定 → detail なし
  }
  expect(actions.find((a) => a.type === "cascade_children")).toBeUndefined();
});

test("aborted + CLOSE (force=true, prevAbortedAt) → detail に prev_aborted_at が入る", () => {
  const { actions } = taskReduce(
    "aborted",
    { type: "CLOSE", force: true, prevAbortedAt: "2026-04-23T11:00:00Z" },
    tctx({ hasConductor: false }),
  );
  const log = actions.find((a) => a.type === "log");
  if (log && log.type === "log") {
    expect(log.detail).toBe("prev_aborted_at=2026-04-23T11:00:00Z");
  }
});

test("aborted + CLOSE (force=false) → aborted (noop, 既存挙動)", () => {
  // 既存 line 684-687 と同等。force 引数を明示するパスを別 test として残す。
  const { next, actions } = taskReduce(
    "aborted",
    { type: "CLOSE", force: false },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("aborted");
  expect(actions).toEqual([]);
});

test("closed + CLOSE (force=true) → closed (誤操作防止 noop)", () => {
  const { next, actions } = taskReduce(
    "closed",
    { type: "CLOSE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("closed");
  expect(actions).toEqual([]);
});

test("deleted + CLOSE (force=true) → deleted (terminal state guard)", () => {
  const { next, actions } = taskReduce(
    "deleted",
    { type: "CLOSE", force: true },
    tctx({ hasConductor: false }),
  );
  expect(next).toBe("deleted");
  expect(actions).toEqual([]);
});

// R: assigned / ready / draft + force=true は通常経路（既存 task_closed log）
test("assigned + CLOSE (force=true) → closed + task_closed (force は通常経路に影響しない)", () => {
  const { next, actions } = taskReduce(
    "assigned",
    { type: "CLOSE", force: true },
    tctx({ hasConductor: true }),
  );
  expect(next).toBe("closed");
  const log = actions.find((a) => a.type === "log");
  expect(log && log.type === "log" ? log.event : undefined).toBe("task_closed");
});
```

「deleted は終端 state」ブロック (`fsm.test.ts:604-624`) の `events` 配列にも `{ type: "CLOSE", force: true }` を追加して、deleted+force でも noop が保証されることを確認すること（現行 `{ type: "CLOSE" }` のみ）。

### B. `state-machine/task-state-store.test.ts` — applyTaskEvent 経由

`describe("task-state-store — applyTaskEvent (T303)", ...)` の `// ---- CLOSE autoClosed ------------------------------------------` (line 448) ブロック直後に追加:

```ts
// ---- T??? : CLOSE force (aborted → closed) ---------------------------
test("CLOSE force=true on aborted → closed + task_closed_from_aborted log + abortedAt 残置", async () => {
  await writeState(project.root, {
    "070": {
      status: "aborted",
      abortedAt: "2026-04-23T11:00:00Z",
      journal: "Task 070 aborted [user_clear]",
    },
  });
  const result = await applyTaskEvent(project.root, {
    taskId: "070",
    event: {
      type: "CLOSE",
      force: true,
      prevAbortedAt: "2026-04-23T11:00:00Z",
    },
    patch: (_prev, next) =>
      next === "closed"
        ? {
            merge: {
              closedAt: "2026-04-23T12:00:00Z",
              journal: "force-closed by user",
              deliverable: { kind: "none" },
            },
          }
        : {},
  });
  expect(result.committed).toBe(true);
  expect(result.prev).toBe("aborted");
  expect(result.next).toBe("closed");

  const after = await readState(project.root);
  expect(after["070"]?.status).toBe("closed");
  expect(after["070"]?.closedAt).toBe("2026-04-23T12:00:00Z");
  // abortedAt は残置（trace 可能性）
  expect(after["070"]?.abortedAt).toBe("2026-04-23T11:00:00Z");
  expect(after["070"]?.deliverable?.kind).toBe("none");

  const logContent = await readLog(project.root);
  expect(logContent).toMatch(/task_closed_from_aborted/);
  expect(logContent).toMatch(/prev_aborted_at=2026-04-23T11:00:00Z/);
});

test("CLOSE force=false on aborted → noop（committed=false、abortedAt そのまま）", async () => {
  await writeState(project.root, {
    "071": { status: "aborted", abortedAt: "2026-04-23T11:00:00Z" },
  });
  const result = await applyTaskEvent(project.root, {
    taskId: "071",
    event: { type: "CLOSE" },
  });
  expect(result.committed).toBe(false);
  expect(result.prev).toBe("aborted");
  expect(result.next).toBe("aborted");

  const after = await readState(project.root);
  expect(after["071"]?.status).toBe("aborted");
  expect(after["071"]?.abortedAt).toBe("2026-04-23T11:00:00Z");
});
```

### C. `apply-task-actions.test.ts` — events.jsonl allowlist 検証

`describe("applyTaskActions — T303", ...)` の `T358: allowlist 外の log action は events.jsonl に流れない` テスト (line 337-358) の events 配列に `task_closed_from_aborted` を追加:

```ts
test("T358: allowlist 外の log action は events.jsonl に流れない", async () => {
  await applyTaskActions(
    [
      { type: "log", event: "task_aborted_core", detail: "reason=user_clear" },
      { type: "log", event: "task_closed" },
      { type: "log", event: "task_closed_from_aborted", detail: "prev_aborted_at=2026-04-23T11:00:00Z" },  // 追加
      { type: "log", event: "task_deleted" },
      ...
```

これにより `task_closed_from_aborted` も `dispatchEventStreamLog` の default 分岐に落ちる（events.jsonl に流れない）ことが locked-in される。

### D. `main.test.ts` — CLI 統合

`describe("TASK_UPDATED postMessage (T183)", ...)` 内、`close-task (T295): assigned + kind 指定のみ ... --force が必要` テスト (line 1204) の直後に以下を追加:

```ts
// T??? : aborted → closed (--force による上書き)
test("close-task (T???): aborted タスクは --force なしで reject される", async () => {
  await setupTeamDir("580", "t-aborted", "aborted");
  // abortedAt を task-state.json に追加
  const { writeFile: wf } = await import("fs/promises");
  const stateFile = join(testDir, ".team/task-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf-8"));
  state["580"] = {
    status: "aborted",
    abortedAt: "2026-04-23T11:00:00Z",
    journal: "Task 580 aborted [user_clear]",
  };
  await wf(stateFile, JSON.stringify(state, null, 2));

  const r = await runCli([
    "close-task", "--task-id", "580",
    "--deliverable-kind", "none",
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("aborted");
  expect(r.stderr).toContain("--force");

  const after = JSON.parse(await readFile(stateFile, "utf-8"));
  expect(after["580"].status).toBe("aborted");
});

test("close-task (T???): aborted + --force で closed に遷移し、abortedAt が残置される", async () => {
  await setupTeamDir("581", "t-aborted-force", "aborted");
  const { writeFile: wf } = await import("fs/promises");
  const stateFile = join(testDir, ".team/task-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf-8"));
  state["581"] = {
    status: "aborted",
    abortedAt: "2026-04-23T11:00:00Z",
    journal: "Task 581 aborted [user_clear]",
  };
  await wf(stateFile, JSON.stringify(state, null, 2));

  const r = await runCli([
    "close-task", "--task-id", "581",
    "--deliverable-kind", "none", "--force",
    "--journal", "force-closed by user",
  ]);
  expect(r.code).toBe(0);

  const after = JSON.parse(await readFile(stateFile, "utf-8"));
  expect(after["581"].status).toBe("closed");
  expect(after["581"].closedAt).toBeDefined();
  expect(after["581"].abortedAt).toBe("2026-04-23T11:00:00Z");  // 残置
  expect(after["581"].journal).toBe("force-closed by user");
  expect(after["581"].deliverable).toEqual({ kind: "none" });

  // manager.log に task_closed_from_aborted が出ること
  const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
  expect(log).toContain("task_closed_from_aborted");
  expect(log).toContain("prev_aborted_at=2026-04-23T11:00:00Z");
});

test("close-task (T???): aborted + --force で journal 省略しても closed に遷移する（推奨だが必須ではない）", async () => {
  await setupTeamDir("582", "t-aborted-no-journal", "aborted");
  const { writeFile: wf } = await import("fs/promises");
  const stateFile = join(testDir, ".team/task-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf-8"));
  state["582"] = { status: "aborted", abortedAt: "2026-04-23T11:00:00Z" };
  await wf(stateFile, JSON.stringify(state, null, 2));

  const r = await runCli([
    "close-task", "--task-id", "582",
    "--deliverable-kind", "none", "--force",
  ]);
  expect(r.code).toBe(0);
  const after = JSON.parse(await readFile(stateFile, "utf-8"));
  expect(after["582"].status).toBe("closed");
});
```

### E. 既存テスト regression 確認

以下の既存テストが影響を受けない（pass し続ける）ことを確認:

| テスト | 期待 |
|---|---|
| `fsm.test.ts:684-687` `aborted + CLOSE → aborted (no-op)` | force 無しなので noop（変わらず） |
| `fsm.test.ts:680-683` `closed + CLOSE → closed (no-op)` | 変わらず |
| `fsm.test.ts:668-679` assigned/ready/draft + CLOSE → closed | force 無し経路は変わらず |
| `task-state-store.test.ts:449-471` CLOSE autoClosed=true | autoClosed と force は独立、変わらず |
| `main.test.ts:1204` close-task (T295): assigned + --force 必須 | assigned ガードは触らない、変わらず |
| `main.test.ts:1014-1097` close-task (T291) slug 経路 | 変わらず |

`bun test --timeout 30000` をファイル単位で回す（`bun test` 全体は CLAUDE.md「`bun test` 全体実行は禁忌」のため避ける）:

```bash
cd skills/cmux-team/manager && \
  for f in state-machine/fsm.test.ts state-machine/task-state-store.test.ts \
           state-machine/apply-task-actions.test.ts main.test.ts; do
    bun test --timeout 30000 "$f"
  done
```

## 実装順序（TDD）

1. **テスト先行 (red)**:
   - `fsm.test.ts` に新 5 テスト追加 → reducer 未対応なので fail
   - `task-state-store.test.ts` に CLOSE force=true テスト追加 → fail
   - `main.test.ts` に CLI 統合 3 テスト追加 → fail
2. **`events.ts`**: `CLOSE` 型に `force?` / `prevAbortedAt?` 追加 → 型 OK だが reducer はまだ未対応
3. **`task-fsm.ts`**: CLOSE reducer に aborted+force 分岐追加 → fsm.test.ts green
4. **`apply-task-actions.test.ts`**: allowlist 外テストに `task_closed_from_aborted` 追加 → 既存 default 分岐で pass
5. **`main.ts cmdCloseTask`**: aborted ガード + applyTaskEvent への force/prevAbortedAt 渡し → main.test.ts / task-state-store.test.ts green
6. **`docs/spec/07-state-machine.md`**: 遷移表 + Mermaid + footnote 更新
7. **regression 確認**: `bun test` をファイル単位で 4 ファイル走らせて全 pass を確認

## リスク・注意点

### cascade 不要の根拠
- aborted 遷移時点で reducer は既に `cascade_children` action を emit 済み (`task-fsm.ts:86-88` ASSIGN_FAIL / `task-fsm.ts:113-114` ABORT)。aborted 子タスクは時点で `parent_aborted` 経由で draft に戻されている。
- `aborted → closed` は親の状態が semantically tighter になるだけで、子に新たな影響を与えない。spec 2.4 の cascade ルール (`07-state-machine.md:245-250`) はこのケースを含まない。

### `closedAt` + `abortedAt` 両保持の根拠
- `abortedAt` を残すことで「誰が・いつ aborted にして、その後いつ force closed にしたか」を trace DB / events.jsonl の組み合わせで再構成可能。
- `task-state-store.ts:230` の `baseEntry = { ...cur }` により既存 field は保持される。`patch.merge` には `abortedAt` を含めないので意図せず上書きされることもない。
- `patch.remove` は空配列のままで OK（assigned 由来の resume metadata は aborted 遷移時点で既に削除済み — `markTaskAborted` 経路）。

### 既存 noop 挙動を壊さないこと
- `closed + CLOSE` は引き続き noop（誤操作防止）— reducer 末尾の `return noop(state)` で拾う。テスト D で確認。
- `aborted + CLOSE (force 無し)` も引き続き noop — 既存 `fsm.test.ts:684-687` で保証され続ける。
- `deleted` は `task-fsm.ts:38-40` の早期 return ですべての event が noop。テスト D で `force=true` でも noop を確認。

### log event 名衝突
- `task_closed_from_aborted` は新規イベント名。grep で衝突確認:
  ```bash
  grep -rn "task_closed_from_aborted" skills/ docs/
  ```
  既存 hit が無いことを実装前に確認する。
- `apply-task-actions.ts:74-146` の events.jsonl allowlist には含めない（manager.log のみに残す）。default 分岐で吸収される。

### CLI message のニュアンス
- aborted ガードのエラーメッセージは「journal 推奨だが必須化はしない」をユーザーに伝える表現にする。assigned ガード (`Use --force to close a running task.`) と並列に書ける形で:
  ```
  Error: task ${taskId} is already aborted. Use --force to close an aborted task (journal recommended).
  ```

### `event.force` と `parseCloseTaskArgs` の force の使い分け
- CLI flag の `--force` (`main.ts:4221` で parse される `force` 変数) は **CLI ガードの bypass フラグ**として既存の assigned ガードと新規 aborted ガードの両方で使う。
- reducer 内部の `event.force` は **aborted → closed 遷移を許可するフラグ**として、aborted 経路でのみ true に設定する（assigned 経路は既存通り `event.force` 不要）。
- 二者は名前が同じだが意味は独立。混同しないよう main.ts のコメントで明示する。

### `--force` の意味の一貫性
- 既存 `delete-task --force`: `closed/aborted` (terminal) を `deleted` に上書き
- 既存 `close-task --force` (T295): `assigned` (running) を `closed` に強制移行
- 新規 `close-task --force` (本タスク): `aborted` (terminal) を `closed` に上書き

3 ケースとも「通常は禁止される遷移を強制実行する escape hatch」として一貫している。journal は推奨だが必須化はしない（既存 `delete-task --force` も journal 必須化はしていない）。
