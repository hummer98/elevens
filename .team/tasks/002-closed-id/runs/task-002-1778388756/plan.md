# Plan: T002 — 依存解決を closed のみで成立させる + 未存在 ID を入力検証

## 1. 背景・要約

surface:47 (Brainship/prototype) で発生した事象では、aborted となった親タスクが `closedIds` に含まれていたため、その親に `depends_on` する子タスクが executable と判定されてアサイン候補になり、user の意図 (「親を restart 後に流す」) に反して走り出した。根本原因は `daemon.ts:3173-3177` で `closedIds` を `isTerminalStatus` (closed/aborted/deleted) で構築している点にある。加えて未存在 ID (`--depends-on 9999`) が CLI で素通りし、永久 block する「ゾンビ ready」が作れる問題もある。

方針: 依存解決の意味論を **`closed` のみ成立** に揃える。`closedIds` 構築を `s.status === "closed"` 限定にし、CLI 側 (`create-task` / `update-task --depends-on`) で未存在 ID を即時 reject する。`isTerminalStatus` は他用途 (open task 集合、run_after_all 競合判定) のためそのまま保持し、変更は局所化する。cascade ルール (PARENT_ABORTED reducer) は既存挙動 (ready→draft 降格) を維持する。

## 2. 設計判断

### 2.1 `closedIds` 構築を `closed` 限定にする局所化方針

`closedIds` (= `closed` Set) は daemon.ts:3173-3177 の 1 か所でのみ構築され、`filterExecutableTasks` / `filterRunAfterAllTasks` の 2 関数だけが消費する (`task.ts:482, 528, 541`)。`grep -n "closedIds\|filterExecutableTasks\|filterRunAfterAllTasks"` で確認したとおり、**他参照箇所は存在しない**。

一方 `isTerminalStatus` 自体は以下の 3 箇所で利用されており、これらは「closed/aborted/deleted のいずれも『これ以上動かない』集合として扱う」セマンティクスが正しい:

- `daemon.ts:3179` openTasksList — 「open とは terminal でないもの」(aborted も open ではない)
- `main.ts:1478` boot 時 open task 数集計
- `task.ts:859` createTaskProgrammatic の run_after_all 競合チェック (terminal なら競合なし)
- `team-gc.ts:357` GC

したがって `isTerminalStatus` の semantics は変更せず、`closedIds` の構築だけを `s.status === "closed"` に絞る。これで「依存解決 = closed のみ」と「open / 競合判定 = terminal 全体」が分離され、コードの 2 つの semantics が明示的になる。

### 2.2 `validateDependsOnExist` を `task.ts` に置く理由

CLI 引数の正規化 (`normalizeTaskIdList`) は `task.ts:255` に既存。`validateDependsOnExist` は `normalizeTaskIdList` の **後段** (= 正規化済み 3 桁 zero-pad の ID 配列に対する disk 検証) として位置づける。両方とも task.ts に置くことで:

- task ID に関するルールが 1 ファイルに集約される
- `cmdCreateTask` / `cmdUpdateTask` の両所から同じ関数を呼ぶ DRY が達成される
- 将来 daemon.ts 側 (`createTaskProgrammatic`) からも検証したくなった場合に再利用可能

実装は `loadTasks(projectRoot)` (task.ts:416) を再利用する。`loadTasks` は既に全 task ファイルをスキャンするため、追加の I/O ヘルパは不要。

### 2.3 エラーメッセージ文言

タスク本文で確定済み: `Error: depends_on task <id> not found in .team/tasks/`

`<id>` は 3 桁 zero-pad 後の ID を入れる (例: `Error: depends_on task 9999 not found in .team/tasks/` ではなく `Error: depends_on task 09999 not found in .team/tasks/`、ただし `normalizeTaskId` は `padStart(3, "0")` のため最低 3 桁。4 桁以上の入力はそのまま padding なし)。

`exit 1` で CLI を抜ける。`--force` bypass は付けない (タスク本文 §非対象)。

### 2.4 複数 ID で複数未存在の場合

**最初の未存在 ID のみを error message に含める** (タスク本文と整合)。複数列挙ではなく単一 ID で fail-fast にする理由:

- `normalizeTaskIdList` が「最初の invalid を報告」する既存挙動 (task.ts:259) と揃う
- user は 1 つ修正してから再実行する flow が一貫する
- メッセージ仕様を確定値で固定でき、テストが安定する

入力順序を保ったまま順次 `existsSync` を確認し、最初に見つかった未存在 ID で throw する。

### 2.5 検証経路

`findTaskFile` (main.ts:568) は `taskId.startsWith` 判定 + frontmatter 読みの 2 段検索で重い。task.ts では disk 走査の代わりに `loadTasks` を 1 回だけ呼んで集合を作り、O(N + M) で判定する (N=tasks, M=depends_on 数)。

## 3. 変更ファイルと差分の概略

### 3.1 `skills/cmux-team/manager/task.ts`

**追加**: `validateDependsOnExist(projectRoot: string, ids: string[]): Promise<void>`

```ts
/**
 * T002: depends_on の各 ID が .team/tasks/ に実在するか検証。
 * 未存在なら最初の未存在 ID を Error で throw する (caller が exit 1)。
 */
export async function validateDependsOnExist(
  projectRoot: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { tasks } = await loadTasks(projectRoot);
  const existingIds = new Set(tasks.map((t) => t.id));
  for (const id of ids) {
    if (!existingIds.has(id)) {
      throw new Error(`depends_on task ${id} not found in .team/tasks/`);
    }
  }
}
```

配置位置: `normalizeTaskIdList` の直下 (task.ts:262 付近) が semantically 自然。

### 3.2 `skills/cmux-team/manager/daemon.ts:3173-3177`

```ts
// before
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => isTerminalStatus(s.status))
    .map(([id]) => id)
);

// after
// T002: 依存解決は closed のみで成立。aborted / deleted 親に依存する子は block。
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed")
    .map(([id]) => id)
);
```

`openTasksList` (daemon.ts:3179) は `isTerminalStatus` のまま (aborted/deleted も open ではない)。

### 3.3 `skills/cmux-team/manager/main.ts`

import に `validateDependsOnExist` を追加 (main.ts:74)。

**`cmdCreateTask` (main.ts:3995-4001 周辺)**:

```ts
let dependsOn: string[];
try {
  dependsOn = normalizeTaskIdList(dependsOnRaw);
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
// T002: 未存在 ID を reject
try {
  await validateDependsOnExist(PROJECT_ROOT, dependsOn);
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
```

**`cmdUpdateTask` (main.ts:4099-4106 周辺)**:

```ts
if (dependsOn !== undefined) {
  let depsArray: string[];
  try {
    depsArray = normalizeTaskIdList(dependsOn);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  // T002: 未存在 ID を reject
  try {
    await validateDependsOnExist(PROJECT_ROOT, depsArray);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  // ... 既存の depends_on 行更新ロジック
}
```

### 3.4 `docs/spec/07-state-machine.md`

§2.4 cascade ルールの直後 (= §2.5 不変条件の前) に新規節 §2.5 を挿入し、不変条件は §2.6 にずらす。または既存 §2.4 末尾に追記。実装は **新規節 §2.5「依存解決の意味論」** を推奨 (cascade と依存解決は別 axis)。

追記内容:

```markdown
### 2.5 依存解決の意味論 (T002)

`depends_on` の解決は **親が `closed` のときのみ** 成立する。

| 親 status | 子 (ready, depends_on=parent) の executable 判定 |
|---|---|
| `closed` | ✅ executable |
| `aborted` / `deleted` | ❌ block (`closedIds` に含まれない) |
| 未存在 ID (CLI で reject 済) | ❌ block (永久) |
| `draft` / `ready` / `assigned` | ❌ block (まだ closed でない) |

cascade ルール (§2.4) と独立: 親が aborted/deleted に遷移したとき子は cascade で `draft` 降格するが、**user が再 ready 化しても親が closed でない限り executable にはならない**。これが本仕様の本質。

block された子の解除手段:
1. 親を `restart-task` / `close-task --force` (T001) で `closed` に持っていく
2. 子の `--depends-on` を編集して依存先を変更
3. 子を `abort-task` / `delete-task`

CLI 入力検証: `create-task --depends-on <ids>` / `update-task --depends-on <ids>` は実行前に各 ID が `.team/tasks/` に実在するか検証し、未存在なら exit 1 (`Error: depends_on task <id> not found in .team/tasks/`)。`--force` bypass は無い。
```

§2.6 不変条件にも 1 行追加:

| ID | 条件 | 監視位置 |
|----|------|---------|
| T-I3 | `closedIds = { id : status==="closed" }` (aborted/deleted は含まない) | `daemon.ts scanTasks closedIds 構築` |

## 4. テスト計画 (TDD 順)

### 4.1 追加テストファイル

既存 `skills/cmux-team/manager/task.test.ts` に追記する (新規ファイルは作らない)。理由:

- `filterExecutableTasks` / `filterRunAfterAllTasks` のテストブロックが既に存在 (line 271 〜)
- `normalizeTaskIdList` のテストブロックも存在 (line 250 付近)
- `validateDependsOnExist` は task.ts の関数なので task.test.ts に配置

### 4.2 追加するテスト一覧

#### A. `filterExecutableTasks` (task.test.ts §"filterExecutableTasks" 内)

```ts
test("T002: aborted 親に依存する ready 子は executable から外れる", () => {
  const child = makeMeta("003", "ready", ["001"]);
  const closed = new Set<string>();  // 001 は aborted で closed には含まれない
  const result = filterExecutableTasks([child], closed, new Set());
  expect(result).toHaveLength(0);
});

test("T002: deleted 親に依存する ready 子は executable から外れる", () => {
  const child = makeMeta("003", "ready", ["001"]);
  const closed = new Set<string>();  // 001 は deleted で closed には含まれない
  const result = filterExecutableTasks([child], closed, new Set());
  expect(result).toHaveLength(0);
});

test("T002: 未存在 ID に依存する ready 子は executable から外れる", () => {
  const child = makeMeta("003", "ready", ["999"]);
  const result = filterExecutableTasks([child], new Set(), new Set());
  expect(result).toHaveLength(0);
});

test("T002: closed 親に依存する ready 子は executable (既存挙動の retain 確認)", () => {
  const child = makeMeta("003", "ready", ["001"]);
  const closed = new Set(["001"]);
  const result = filterExecutableTasks([child], closed, new Set());
  expect(result).toHaveLength(1);
});
```

#### B. `filterRunAfterAllTasks` (task.test.ts §"filterRunAfterAllTasks" 内)

```ts
test("T002: run_after_all タスクが aborted 親に依存していたら block される", () => {
  const aborted = makeMeta("001", "ready"); // open list には居ない想定 (caller でフィルタ済)
  const raa = { ...makeMeta("002", "ready", ["001"]), runAfterAll: true };
  // closedIds = closed のみ (aborted の 001 は含まれない)
  const result = filterRunAfterAllTasks([raa], new Set(), new Set());
  expect(result).toHaveLength(0);
});
```

#### C. `daemon.ts scanTasks` の closedIds 構築 (daemon.test.ts、必要なら)

`scanTasks` の closedIds 構築は内部 const なので直接アサート困難。代わりに **task-state を仕込んで scanTasks 後に `state.pendingTasks` がゼロになる** ことを検証する end-to-end 風テストを daemon.test.ts に追加する。既存 daemon.test.ts に類似パターンがあれば踏襲する (なければ scanTasks 単体を呼ぶテスト)。

```ts
test("T002: aborted 親に depends_on する ready 子は scanTasks で pending にカウントされない", async () => {
  // .team/tasks/001-*, 002-* を仕込む
  // task-state.json: 001=aborted, 002=ready (depends_on: [001])
  // scanTasks(state) 実行
  // expect(state.pendingTasks).toBe(0);
});
```

優先度: A/B が必須、C は時間あれば。最小スコープでは A/B のみで仕様カバー可能 (`closedIds` 構築修正は `scanTasks` 唯一 1 行のため、構築値が変われば下流関数の挙動は A/B の test で担保される)。

#### D. `validateDependsOnExist` 単体テスト (task.test.ts に新規 describe)

```ts
describe("validateDependsOnExist", () => {
  // tmpdir に .team/tasks/001-*/task.md を仕込む helper を用意

  test("ids 空配列なら throw しない", async () => {
    await validateDependsOnExist(tmp, []);
  });

  test("全 ID が実在すれば throw しない", async () => {
    // 001-foo, 002-bar を仕込む
    await validateDependsOnExist(tmp, ["001", "002"]);
  });

  test("未存在 ID があれば throw する", async () => {
    await expect(validateDependsOnExist(tmp, ["9999"])).rejects.toThrow(
      "depends_on task 9999 not found in .team/tasks/"
    );
  });

  test("複数未存在の場合は最初の ID を含む", async () => {
    // 001 のみ仕込む
    await expect(validateDependsOnExist(tmp, ["001", "888", "999"])).rejects.toThrow(
      "depends_on task 888 not found in .team/tasks/"
    );
  });
});
```

#### E. CLI 統合テスト (main.test.ts または create-task / update-task の既存 test file)

CLI レベルの exit code 検証は test 環境では困難 (process.exit が直接呼ばれる)。**単体テスト D で十分カバー**。CLI 経路は手動 smoke で確認する:

```bash
cmux-team create-task --title "test" --depends-on 9999
# expect: Error: depends_on task 9999 not found in .team/tasks/
# expect: exit 1
```

### 4.3 red → green の順序

1. **Step A (red)** — `filterExecutableTasks` テスト 4 本を task.test.ts に追加。`closedIds` 構築は未修正のため、aborted/deleted 親のテストは現状 **pass してしまう** (closed Set に aborted も入ってきていたら 0 になっていない)。**注意**: A の 4 本は実は `filterExecutableTasks` 自体の挙動は変わらず、`closedIds` Set の内容を変えるだけで achievable。テスト側で「`closed` に aborted が入っていない Set」を渡せば既存実装でもテストが通る。これは `closedIds` 構築側の変更が daemon.ts:3173-3177 の問題であり、`filterExecutableTasks` 単体は依存先 ID が Set に含まれるかだけ判定する。
   - したがって red の本体は **C (scanTasks 統合) または D (validateDependsOnExist)** に置く必要がある。A/B は仕様の retain 確認 (regression guard) として価値がある (closed のみセマンティクスを契約として固定)。
2. **Step C (red)** — daemon.test.ts に「aborted 親 + ready 子 → pendingTasks=0」を追加。現状実装 (isTerminalStatus 包含) では aborted も closedIds に入って executable と判定される → fail。
3. **Step C green** — daemon.ts:3173-3177 を `s.status === "closed"` に修正 → pass。
4. **Step D (red)** — `validateDependsOnExist` のテストを追加 (関数未実装) → import 失敗または未定義で fail。
5. **Step D green** — task.ts に `validateDependsOnExist` を追加 → pass。
6. **Step E** — CLI から呼び出す統合 (`cmdCreateTask` / `cmdUpdateTask`) → 手動 smoke。

### 4.4 既存テストへの影響確認

実行コマンド (CLAUDE.md「`bun test` 全体実行禁忌」を厳守):

```bash
cd skills/cmux-team/manager
for f in task.test.ts daemon.test.ts state-machine/*.test.ts; do
  bun test --timeout 30000 "$f"
done
```

特に確認すべき既存テスト:
- `task.test.ts §"filterExecutableTasks"` (line 271-) — 既存テストが `closed` Set に `aborted` ID を渡すパターンを使っていないか確認 (使っていれば調整が必要)。
- `daemon.test.ts` の `scanTasks` 関連テスト — `taskState` で aborted ID を含めて pending 期待値を立てている test があれば調整。
- `state-machine/task-fsm.test.ts` の cascade (PARENT_ABORTED) テスト — 影響なし (cascade ルールは変更しないため)。

## 5. TDD 実装手順 (Implementer 向け)

### Step 1: 既存テストの現状確認

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-002-1778388756/skills/cmux-team/manager
bun test --timeout 30000 task.test.ts
bun test --timeout 30000 daemon.test.ts
```

両方 baseline pass を確認。

### Step 2: scanTasks 統合テストを追加 (red)

`daemon.test.ts` に「aborted 親 + ready 子 (depends_on=parent) → state.pendingTasks=0」を 1 本追加。既存の scanTasks テストパターンを踏襲し tmp project root で task-state を仕込む。

実行:
```bash
bun test --timeout 30000 daemon.test.ts
```

新規テストが fail することを確認 (期待: pendingTasks=0、実際: 1)。

### Step 3: `closedIds` 構築修正 → green

`skills/cmux-team/manager/daemon.ts:3173-3177` を編集:

```ts
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed")
    .map(([id]) => id)
);
```

実行:
```bash
bun test --timeout 30000 daemon.test.ts
```

新規テスト含む全 pass を確認。

### Step 4: `filterExecutableTasks` / `filterRunAfterAllTasks` の retain テスト追加 (green-only regression guard)

§4.2 A/B のテストを task.test.ts に追記。既存実装で pass する (closedIds 構築側がもう closed のみになっているため)。これらは仕様契約を将来にわたって固定するための regression guard。

実行:
```bash
bun test --timeout 30000 task.test.ts
```

全 pass を確認。

### Step 5: `validateDependsOnExist` 単体テスト追加 (red)

§4.2 D のテストを task.test.ts に追記。tmpdir helper (既存テストにあるか確認、なければ `mkdtemp` で書く) を使う。

実行:
```bash
bun test --timeout 30000 task.test.ts
```

`validateDependsOnExist` import 失敗で fail。

### Step 6: `validateDependsOnExist` 実装 → green

`skills/cmux-team/manager/task.ts` の `normalizeTaskIdList` 直下 (line 263 付近) に追加 (§3.1 参照)。

実行:
```bash
bun test --timeout 30000 task.test.ts
```

全 pass を確認。

### Step 7: CLI 統合 (`cmdCreateTask` / `cmdUpdateTask`)

`skills/cmux-team/manager/main.ts`:
- import 行 (line 74) に `validateDependsOnExist` を追加
- `cmdCreateTask` (line 3995 付近) と `cmdUpdateTask` (line 4099 付近) に検証呼び出しを差し込む (§3.3 参照)

手動 smoke:
```bash
# 既存 fixtures や手元 .team/tasks 配下で動作確認
bun run skills/cmux-team/manager/main.ts create-task --title "test" --depends-on 9999
# expect: Error: depends_on task 9999 not found in .team/tasks/
# expect: $? == 1
```

### Step 8: spec 更新

`docs/spec/07-state-machine.md` に §2.5「依存解決の意味論」を新規挿入し、§2.5 不変条件を §2.6 にずらす (§3.4 参照)。

### Step 9: 関連テスト全実行で regression 無確認

```bash
cd skills/cmux-team/manager
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

CLAUDE.md「`bun test` 全体実行禁忌」を厳守。dashboard-*.test.tsx は影響なし想定だが既知の劣化を避けるため個別実行する。

### Step 10: 型チェック

```bash
bunx tsc --noEmit
```

新規エラーゼロを確認。

## 6. リスクと検証項目

### 6.1 既存 cascade (PARENT_ABORTED) テストへの影響

cascade ルールは変更しない。`state-machine/task-fsm.test.ts` の PARENT_ABORTED → ready→draft 降格テストはそのまま pass する想定。Step 9 で `state-machine/*.test.ts` を実行して確認。

### 6.2 `task-state.json` 上の aborted/deleted 子への影響

子 (cascade で draft 降格済) のステータスは変わらない。本変更は **親** が closed/aborted のいずれかである場合の executable 判定のみに影響する。子の status frontmatter / task-state.json レコード自体は本変更対象外。

### 6.3 既存 fixtures での aborted 親持ち子の挙動変化

既存 `.team/tasks/` で aborted 親 (例: 過去の T012 のような状況) と ready 子 が残っているプロジェクトでは、本変更後子は永続的に non-executable になる。これは **意図した動作** (タスク本文 §背景の T013 = 動かしたくないユースケース)。user が解除する手段はタスク本文の 3 経路 (parent restart / depends_on 編集 / child abort) で提供されている。

### 6.4 `bun test` 全体実行禁忌

CLAUDE.md および `.team/artifacts/A021-research.md` に従い、`bun test` (引数なし) は実行しない。Step 9 の for loop で個別ファイルを順に実行する。

### 6.5 hook によるタスクファイル直接書き込み禁止

テスト用 fixture を作る際は `.team/tasks/` 配下を CLI 経由で作成 — ではなく、**tmpdir に独立したプロジェクト構造を作る** (既存 task.test.ts / daemon.test.ts のパターンを踏襲)。本リポジトリの `.team/` には触らない。

## 7. 完了条件 (DoD)

- [ ] `cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` で全 pass
- [ ] `bunx tsc --noEmit` で新規エラーゼロ
- [ ] 新規テスト 6+ 本 (filterExecutableTasks 4 本, filterRunAfterAllTasks 1 本, validateDependsOnExist 4 本, scanTasks 統合 1 本) が green
- [ ] `docs/spec/07-state-machine.md` に §2.5「依存解決の意味論」が追加されている
- [ ] 手動 smoke: `create-task --depends-on 9999` と `update-task --depends-on 9999` がそれぞれ exit 1 + 期待 error message を出力する
- [ ] cascade (PARENT_ABORTED) ルールは変更されていないことを `git diff` で確認
- [ ] `closedIds` 構築修正は `daemon.ts:3173-3177` の 1 か所のみ。`isTerminalStatus` 定義 (`task.ts:804`) と他参照箇所 (daemon.ts:3179, main.ts:1478, task.ts:859, team-gc.ts:357) は未変更
