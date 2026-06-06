# T014 実装計画: Manager 再起動時の `asking` / `askQuestion` 喪失バグ修正

- **タスク**: 014-manager-conductor-asking-askquestion
- **taskRunId**: task-014-1779211698
- **対象ブランチ**: `task-014-1779211698/task`
- **worktree**: `/Users/yamamoto/git/elevens/.worktrees/task-014-1779211698`

---

## 1. 課題分析

### 1.1 現状の問題点

`elevens start`（Manager daemon 再起動）後、`asking` 状態の Conductor が次の通り壊れて復元される:

1. **`status` が `idle` に倒される** — `restoreConductorState`（`skills/cmux-team/manager/daemon.ts:1103-1108`）の status 分岐に `asking` ケースが無く、catch-all `: "idle"` に落ちる。
2. **`askQuestion` が永続化されない** — `updateTeamJson`（`skills/cmux-team/manager/daemon.ts:4705-4735`）の conductors map に `askQuestion` フィールドが含まれていない。Zod schema (`skills/cmux-team/manager/schema.ts:413`) には `askQuestion: z.string().optional()` が定義済みだが、書き手が出力していないので team.json には乗らない。

結果として、Conductor 本体（claude プロセス）は `AskUserQuestion` の入力待ちで blocking 中（PID 生存）なので surface / taskId / taskRunId / worktreePath は A 経路 (keep-alive) で正しく復元されるが、**ユーザー視点では「idle なのに新タスクを assign できない」** という silent fail になる（`scanTasks` は idle として拾うが、claude 側は ask を受け付け中で /clear が走らず詰まる）。

### 1.2 根本原因

Conductor FSM の 9 状態のうち、`restoreConductorState` の status switch は明示的に保持されるのが `running` / `disconnected` / `broken` / `reserved` のみ。**過渡状態 (`starting` / `assigning` / `error`)** は次の `SESSION_*` hook で正常化される前提のため idle 倒しが妥当だが、**`asking` だけは「ユーザー入力待ちで自発 hook が来ない」** という独自性質を持ち、idle 倒しすると永久に誤表示される。

これは **observatory 原則**（state を外部化し、観察者が pull で観測できる）への直接的な違反: 再起動を跨いだ瞬間に「ask 中で停止している Conductor」が観察不能になる。

### 1.3 影響範囲

| 層 | 影響 | 補足 |
|---|---|---|
| Manager daemon | restart 時に `asking` の Conductor を idle として復元 → 後段の assign 判定が誤る | `scanTasks` / `findIdleConductor` の入力 |
| Master / TUI dashboard | `asking` アイコン（⚠ + 質問本文）が消え idle 表示に倒れる | `dashboard.tsx:buildConductorRow` 経由（spec 1.5 のマッピングが効かなくなる） |
| Task FSM / task-state | **影響なし** | task の status は別ファイル (`task-state.json`) で管理 |
| events.jsonl / dashboard | read 側は team.json の status を直接見るので**修正後は自然に追従** | 専用追加実装は不要 |
| Epic Planner | task-state 経由なので**影響なし** | 同上 |

---

## 2. 技術アプローチ

### 2.1 選択したアプローチとその理由

**「team.json への永続化 + restore 時の status 分岐拡張」** という最小スコープ。

| 採用 | 不採用 | 理由 |
|---|---|---|
| `updateTeamJson` の conductors map に `askQuestion: c.askQuestion` を追加 | 別ファイル（例: `.team/ask-state.json`）に切り出し | team.json は既に Conductor の `lastHookAt` / `clearSentAt` / `tokenHandle` 等の per-conductor ランタイム属性を永続化する責務を担っており、`askQuestion` も同性質。**ファイルを増やす理由が無い**（read side 拡張で済むなら read side 拡張する原則 / `MEMORY.md` の `feedback_minimal_scope`） |
| `restoreConductorState` の status 三項演算子に `asking` ケースを 1 行追加 + `askQuestion` を返り値に追加 | FSM reducer 側に restore 専用 event を追加 | 既存の `reserved`（T421 / F3）と同じ「過渡状態として倒さず明示保持する」パターンに沿う。**reducer は無変更**（restore は reducer を経由しない A 経路） |
| `askQuestion` が空のときは防御的に `idle` に倒す | 無条件で `asking` を維持 | `status="asking"` だが `askQuestion` が空 = team.json 破損 / 古い形式。idle にフォールバックすれば「再起動でユーザーが ask に気付かず idle として新タスク assign」より「assign 後に再 ask が来る」方が回復容易 |

### 2.2 既存パターンとの整合性

- **T250 (`broken` 永続化)** / **T421-F3 (`reserved` 永続化)** が確立した「**過渡状態として倒さず明示保持する**」分岐に asking を 1 行追加するだけの拡張。
- 永続化フィールド追加は **T260 (`lastHookAt`)** / **T261 (`clearSentAt`)** / **T323 (`tokenHandle`)** と同じ「`updateTeamJson` の map に 1 行追加 + ConductorState schema は既存定義流用」パターン。schema 変更は不要（既に `askQuestion: z.string().optional()` 定義済み）。
- spec の永続化セクション（`docs/spec/07-state-machine.md` §1.1 状態一覧の脚注 / §1.6 不変条件）にも対応箇所が既にあり、最小追記で済む。

---

## 3. 変更対象

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | (a) `updateTeamJson` の conductors map に `askQuestion: c.askQuestion` を追加。(b) `restoreConductorState` の status 三項演算子に `asking` 分岐を追加 + 返り値に `askQuestion` を追加。(c) `restoreConductorState` をテスト用に export（最小範囲、test-only export パターン） |
| `skills/cmux-team/manager/daemon.test.ts` | テスト 3 ケース追加（書き出し時に askQuestion 含む / restore 時 asking 維持 / 防御的 idle 倒し） |
| `docs/spec/07-state-machine.md` | §1.1 / §1.6 に「`asking` と `askQuestion` は team.json に永続化され、restart 後も保持される」と追記。`askQuestion` 空時の防御 idle fallback も明記 |

> **scope 外（触らない）**: `applyResumeTransitions` / `layout-restore.ts` の A〜E 分類ロジック、`handleMessage` の SESSION_ASK 経路、`task-state.json` schema、Task FSM reducer、events.jsonl / dashboard / Epic Planner（read 側は team.json の status を見れば自然に追従）。

---

## 4. サブタスク分割

### Subtask 1: `updateTeamJson` の conductors map に `askQuestion` を追加

**対象**: `skills/cmux-team/manager/daemon.ts:4705-4735`

**Before**:
```ts
teamJson.conductors = [...state.conductors.values()].map((c) => ({
  surface: c.surface,
  taskRunId: c.taskRunId,
  taskId: c.taskId,
  taskTitle: c.taskTitle,
  status: c.status,
  worktreePath: c.worktreePath,
  outputDir: c.outputDir,
  startedAt: c.startedAt,
  // T250: broken Conductor が再起動後も経過時間を表示できるよう disconnectedAt を永続化する。
  disconnectedAt: c.disconnectedAt,
  // T260: ...
  lastHookAt: c.lastHookAt,
  // T261: ...
  clearSentAt: c.clearSentAt,
  sessionId: c.sessionId,
  pid: c.pid,
  // T323: token pool 用 handle（proxy が auth_hash 解決時に書き戻す）
  tokenHandle: c.tokenHandle,
  agents: c.agents.map((a) => ({ ... })),
}));
```

**After**: `tokenHandle: c.tokenHandle,` の直後（agents の手前）に以下を 1 ブロック追加:

```ts
  // T014: Manager 再起動後も asking 状態を復元できるよう askQuestion を永続化する。
  //       SESSION_STARTED/IDLE 経路で undefined に戻る（既存挙動を維持）。
  askQuestion: c.askQuestion,
```

**完了条件**:
- `grep -n "askQuestion: c.askQuestion" skills/cmux-team/manager/daemon.ts` が `updateTeamJson` 内 (4700-4740 行台) で 1 ヒットすること
- `bunx tsc --noEmit` が daemon.ts に対し新規エラーを出さないこと

---

### Subtask 2: `restoreConductorState` の status 分岐に `asking` を追加 + `askQuestion` 復元

**対象**: `skills/cmux-team/manager/daemon.ts:1067-1110`

**Before** (1079-1109 行):
```ts
return {
  surface: c.surface,
  taskRunId: c.taskRunId,
  taskId: c.taskId,
  taskTitle: c.taskTitle,
  worktreePath: c.worktreePath,
  outputDir: c.outputDir,
  startedAt: c.startedAt ?? new Date().toISOString(),
  disconnectedAt: c.disconnectedAt,
  sessionId: c.sessionId,
  pid: c.pid,
  agents: restoredAgents,
  lastHookAt: c.lastHookAt,
  clearSentAt: c.clearSentAt,
  tokenHandle: typeof c.tokenHandle === "string" ? c.tokenHandle : undefined,
  // T250: broken は再起動後も保持する（明示 clear まで idle に戻さない）
  // T421/F3: reserved も再起動後に保持する。silent に idle へ coerce すると ...
  status:
    c.status === "running" ? "running"
    : c.status === "disconnected" ? "disconnected"
    : c.status === "broken" ? "broken"
    : c.status === "reserved" ? "reserved"
    : "idle",
};
```

**After**:

1. `tokenHandle: ...` 行の直後に `askQuestion` を追加:
   ```ts
   // T014: asking 状態は SESSION_ASK で得た質問本文をユーザーに表示する必要があるため、
   //       restart 後も askQuestion を保持する（status="asking" の前提）。
   askQuestion: typeof c.askQuestion === "string" ? c.askQuestion : undefined,
   ```
2. status 三項演算子に `asking` を `reserved` の次（`: "idle"` の直前）に追加。**「`askQuestion` が非空のときのみ asking を維持」** の防御を含める:
   ```ts
   // T014: asking も明示保持。ただし askQuestion が空ならデータ破損疑いで idle に倒す
   //       (observatory: 再起動後も ask 中の Conductor を観測可能にする)
   : c.status === "asking" && typeof c.askQuestion === "string" && c.askQuestion.length > 0
     ? "asking"
   : "idle",
   ```

3. 関数 `restoreConductorState` を **`export function`** に変更（test-only export）。既存の `__setIsAliveImpl` 等の test-only export パターンに合わせ、JSDoc に `@internal` を付与する:
   ```ts
   /**
    * team.json の conductor 生データから ConductorState を構築する（A 経路の復元用）。
    * agents の PID alive 判定もここで行う。
    *
    * @internal export はテスト用。プロダクションコードから直接呼ばないこと。
    */
   export function restoreConductorState(c: any): ConductorState {
   ```

**完了条件**:
- `grep -n "c.status === \"asking\"" skills/cmux-team/manager/daemon.ts` が `restoreConductorState` 内で 1 ヒット
- `grep -n "askQuestion: typeof c.askQuestion" skills/cmux-team/manager/daemon.ts` が `restoreConductorState` 内で 1 ヒット
- `grep -n "^export function restoreConductorState" skills/cmux-team/manager/daemon.ts` が 1 ヒット
- `bunx tsc --noEmit` 新規エラー無し

---

### Subtask 3: テスト 3 ケース追加

**対象**: `skills/cmux-team/manager/daemon.test.ts`

挿入位置: 既存の **T261 永続化 describe（`updateTeamJson / restoreConductors: T261 フィールド永続化`、5420 行付近）の直後** に新規 describe ブロック `updateTeamJson / restoreConductorState: askQuestion 永続化 (T014)` を追加する。理由:
- T261 と並列の「フィールド永続化テスト」群で、構造的に同質。
- T261 は `restoreConductorState` が非公開のため Zod schema parse roundtrip で代替していたが、本タスクで restoreConductorState を export するので **直接 unit テスト可能**。同所に置けば「T014 で export 化された」の文脈が読み手に伝わる。

#### Test 3-a: 書き出し時に `askQuestion` が team.json に含まれる

```ts
test("updateTeamJson: status='asking' + askQuestion='Q1' の Conductor を書き出すと JSON に askQuestion が含まれる (T014)", async () => {
  const { updateTeamJson, createDaemon } = await import("./daemon");
  const state = await createDaemon(testDir);
  const conductor: ConductorState = {
    surface: "surface:014a",
    startedAt: new Date().toISOString(),
    agents: [],
    status: "asking",
    askQuestion: "どちらにしますか?",
    pid: 12345,
    taskRunId: "task-014-a",
    taskId: "14a",
  };
  state.conductors.set(conductor.surface, conductor);

  await updateTeamJson(state);

  const teamJson = JSON.parse(
    await readFile(join(testDir, ".team/team.json"), "utf-8"),
  );
  const serialized = teamJson.conductors.find((c: any) => c.surface === "surface:014a");
  expect(serialized).toBeDefined();
  expect(serialized.status).toBe("asking");
  expect(serialized.askQuestion).toBe("どちらにしますか?");
});
```

#### Test 3-b: `restoreConductorState` で `asking` + `askQuestion` を保持

```ts
test("restoreConductorState: { status: 'asking', askQuestion: 'Q1' } 入力で同値が返る (T014)", async () => {
  const { restoreConductorState } = await import("./daemon");
  const restored = restoreConductorState({
    surface: "surface:014b",
    startedAt: "2026-05-20T00:00:00.000Z",
    agents: [],
    status: "asking",
    askQuestion: "Q1",
    pid: 99999,
  });
  expect(restored.status).toBe("asking");
  expect(restored.askQuestion).toBe("Q1");
});
```

#### Test 3-c: 防御 — `askQuestion` 欠落時は `idle` に倒す

```ts
test("restoreConductorState: status='asking' でも askQuestion 空なら idle に倒される (T014 防御)", async () => {
  const { restoreConductorState } = await import("./daemon");
  const restored = restoreConductorState({
    surface: "surface:014c",
    startedAt: "2026-05-20T00:00:00.000Z",
    agents: [],
    status: "asking",
    askQuestion: undefined,
    pid: 99999,
  });
  expect(restored.status).toBe("idle");
  expect(restored.askQuestion).toBeUndefined();
});
```

**完了条件**:
- `cd skills/cmux-team/manager && bun test --timeout 30000 daemon.test.ts` で 3 ケース全 PASS、既存テストの regression 無し（T261 / T326 / T421-F3 の既存 askQuestion / asking 系も継続 PASS）
- `grep -n "T014" skills/cmux-team/manager/daemon.test.ts` が 3 ヒット以上

> **既存 helper / fixture の再利用**: testDir, `createDaemon`, `readFile`, `join` は既に T261 describe 内で import 済み。新規 import 不要。`ConductorState` 型も既に import 済み (1278 行付近の import 文を再利用)。

---

### Subtask 4: docs/spec 更新

**対象**: `docs/spec/07-state-machine.md`

#### 4-a: §1.1 状態一覧 (line 31) の `asking` 行に永続化注記を追加

**Before**:
```
| `asking` | `AskUserQuestion` 受信 (Notification hook) | `SESSION_ASK` |
```

**After**:
```
| `asking` | `AskUserQuestion` 受信 (Notification hook)。**team.json に `askQuestion` と共に永続化され、Manager 再起動後も保持される (T014)**。`askQuestion` 空時は防御的に `idle` に倒す | `SESSION_ASK` |
```

#### 4-b: §1.6 不変条件テーブル (line 141-146) に `asking` 関連を 1 行追加

`C-I4` の次に追加:

```
| C-I5 | `status=asking` ⇒ `askQuestion != null` (T014) | `restoreConductorState` 防御 fallback（違反検出時は idle に倒す）+ shadow log は将来追加 |
```

#### 4-c: §1.4 Mermaid 図 / §1.2 遷移表は変更不要

reducer 経路の遷移は SESSION_ASK / SESSION_IDLE の 1.2 表で既に網羅されており、本タスクは A 経路（restore）の挙動のみ扱う。Mermaid stateDiagram も restore 経路は表現対象外。

**完了条件**:
- `grep -n "T014" docs/spec/07-state-machine.md` が 2 ヒット以上（§1.1 と §1.6）
- markdown lint（プロジェクトに有れば）合格

---

## 5. リスク

| ID | リスク | 影響 | 緩和 |
|---|---|---|---|
| R1 | 既存 `restoreConductorState` を呼ぶ唯一の経路 (`applyRestorePlan` の 1165 行) が新シグネチャと整合しない可能性 | restart 経路全断 | 関数シグネチャは変更しない（追加フィールドのみ）。呼び出し側無変更を `grep -n "restoreConductorState(" skills/cmux-team/manager/daemon.ts` で確認 |
| R2 | Zod `ConductorState.parse` で `askQuestion` が `optional` でないと restore 経路で reject される | restart 時 panic | `schema.ts:413` で既に `z.string().optional()` 済み — Subtask 1/2 共に schema 変更不要。Subtask 0 として `grep -n "askQuestion" skills/cmux-team/manager/schema.ts` で existing optional を再確認 |
| R3 | `restoreConductorState` の export 化により内部実装が外部 API として固定される | 将来のリファクタ阻害 | `@internal` JSDoc + test-only export コメントを付け、production import を grep でガード可能にする。コード規模も小（数十行）で抑えられる |
| R4 | 既存 T326 テスト（`conductor.askQuestion` を check）が壊れる | 副作用検出失敗 | 本タスクは hook 側の挙動を変えない（updateTeamJson と restore のみ）。T326 系 (1572 行付近) は in-memory state を見ているので影響なし。テスト実行で確認 |
| R5 | dashboard / events.jsonl で `asking` 復元後の表示崩れ | UX 退行 | dashboard.tsx:buildConductorRow は既に status="asking" を扱っており（spec §1.5）、`askQuestion` 表示も既存実装あり。**現状の復元バグで「実際の asking 状態が永遠に消える」のが直る**ので退行ではなく回復方向 |
| R6 | `askQuestion` がユーザー機微情報を含み team.json に永続化される | 漏洩懸念 | team.json は既に taskTitle / sessionId 等のセンシティブ情報を含んでおり、permission boundary は同一。新規漏洩面は無し |

---

## 6. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-014-1779211698
bunx tsc --noEmit 2>&1 | grep -E "(daemon\.ts|daemon\.test\.ts)"
```

**実行結果（事前）**: `(none)` — 該当 2 ファイルに既存 tsc エラー無し。

### 6.1 既存エラー (本タスクで触らない)
- なし

### 6.2 本タスク導入で発生し得る新規エラー (要対応)
- `restoreConductorState` を export 化 → 既存 import からの参照無し（`grep -rn "restoreConductorState" skills/cmux-team/manager/ --include='*.ts'` で daemon.ts 内 2 箇所のみ）。新規エラー発生想定は無し
- daemon.test.ts: `restoreConductorState` の `await import("./daemon")` は既に同所で `updateTeamJson` 等を import している実績あり。新規 import 起点 OK

---

## 7. テスト戦略

### 7.1 既存テストファイル構造

`skills/cmux-team/manager/daemon.test.ts` は約 8000 行の単一ファイル。既存の関連 describe:

| 行 | describe | 関連性 |
|---|---|---|
| ~1400 (Case C IDLE / 1572 T326) | SESSION_STOP / SESSION_ASK 経路で `asking`/`askQuestion` の in-memory 遷移 | hook 経由の write 側（本タスクは触らない） |
| ~5420 (T261 フィールド永続化) | `updateTeamJson` 直接呼び出し + schema parse roundtrip | **本タスクのテンプレ** — 同 describe 直後に T014 describe を追加 |
| ~7801 (T421 予約 surface) | `restoreConductorState` の reserved 保持を統合経路で確認（`raw shape を渡せる経路は現状無い` とコメントあり） | 本タスクで restoreConductorState を export することで、F3 の制約も将来解消可能（**本タスクでは F3 リファクタは scope 外**） |

### 7.2 新規テストの追加位置

T261 describe (`updateTeamJson / restoreConductors: T261 フィールド永続化`、line ~5420) の **直後** に新 describe を追加:

```ts
describe("updateTeamJson / restoreConductorState: askQuestion 永続化 (T014)", () => {
  // Test 3-a
  // Test 3-b
  // Test 3-c
});
```

### 7.3 helper / fixture の再利用

- `testDir`: ファイル先頭の `beforeEach` で初期化済み (T261 と同じスコープを利用)
- `createDaemon`, `updateTeamJson`: `await import("./daemon")` で都度 import（既存パターン）
- `readFile`, `join`: ファイル先頭で import 済み
- `ConductorState` 型: 1278 行付近で既に import 済み

### 7.4 実行コマンド

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-014-1779211698/skills/cmux-team/manager
bun test --timeout 30000 daemon.test.ts
```

> CLAUDE.md の「`bun test` 全体実行は禁忌」ルールに従い、ファイル単体で実行する。

#### 期待結果
- 新規 3 ケース PASS
- 既存テスト（特に T326 / Case C / T261 / T421-F3）regression 無し
- `(none)` の事前 tsc 状態を維持（subtask 完了後に再度 `bunx tsc --noEmit 2>&1 | grep -E "(daemon\.ts|daemon\.test\.ts)"`）

### 7.5 手動検証（任意、scope 外だが推奨）

worktree 内で:
```bash
# Conductor を asking 状態にしてから Manager を再起動し team.json と TUI を確認する手動シナリオ
# （本タスクの自動テストでは reproduction まで担保するが、E2E 検証は別 artifact 化）
```

E2E 検証は今回の scope に含めない（unit テストで十分カバー）。
