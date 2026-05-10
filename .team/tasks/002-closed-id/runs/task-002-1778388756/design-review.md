# Design Review: T002 Plan

## 判定

**Approved**

依存解決を `closed` のみで成立させる方針、`isTerminalStatus` の semantics を保ったまま `closedIds` 構築だけを局所変更するスコープ、CLI 入力検証 (`validateDependsOnExist`) を `task.ts` に新設する配置、TDD 順序の組み立て、いずれも妥当。改善余地は Medium / Low 数件のみで、ブロッキングなし。

## Strengths（良い点）

- **責務分離の説明が明確**: `closedIds` は「依存解決」用、`isTerminalStatus` は「open 集合 / run_after_all 競合 / GC」用、と semantics を 2 軸に分けた上で `isTerminalStatus` は据え置きと明示している (plan §2.1)。
- **`closedIds` 利用箇所を grep で確定済**: `daemon.ts:3173-3177` 構築 / `task.ts:482, 528, 541` 消費の 3 箇所のみで他参照なし、を裏取りしている (plan §2.1)。実コードと一致 (本レビューでも `grep -n "closedIds"` で同結果を確認)。
- **`isTerminalStatus` 利用箇所を全列挙**: `daemon.ts:3179`, `main.ts:1478`, `task.ts:859`, `team-gc.ts:357` を網羅し、各々が「terminal 全体で正しい」根拠を 1 行で説明している (plan §2.1)。
- **`validateDependsOnExist` の配置選定**: `normalizeTaskIdList` の後段（同 `task.ts`）に置くことで「task ID 関連ルールの集約」「DRY」「将来 daemon 側からも再利用」の 3 観点でメリットを示している (plan §2.2)。`loadTasks` 再利用で I/O ヘルパ追加なし、O(N+M) で `findTaskFile` の重い経路を避ける判断も妥当 (plan §2.5)。
- **TDD の自己診断が誠実**: A/B (filterExecutableTasks/filterRunAfterAllTasks の単体) は `closedIds` Set の中身をテスト側で直接コントロールできるため**現状実装でも pass してしまう**ことを plan §4.3 で正直に認め、red の本体を C (scanTasks 統合) と D (validateDependsOnExist) に置く設計にしている。Step 4 を「green-only regression guard」として位置づける整理もブレなし。
- **エラーメッセージ・複数 ID 仕様の確定**: 文言 `Error: depends_on task <id> not found in .team/tasks/`、複数未存在は最初の 1 件、`--force` bypass なし、を plan §2.3 / §2.4 で明示。`normalizeTaskIdList` の「最初の invalid を報告」既存挙動 (`task.ts:259`) と揃えた整合性も確認。
- **spec 配置の決め打ち**: §2.4 cascade ルール直後に §2.5「依存解決の意味論」を新規挿入し、不変条件は §2.6 にずらす方針 (plan §3.4)。本レビューでも `docs/spec/07-state-machine.md:245-267` を Read し、現状の §2.4 / §2.5 構造を確認。「cascade と依存解決は別 axis」「user が再 ready 化しても親が closed でない限り executable にならない」と独立性を明示している点が良い。
- **CLAUDE.md ガードレール遵守**: `bun test` 全体実行禁忌、tmpdir fixture、`.team/tasks/` 直接書き込み禁止 (テストは tmp project) を plan §4.4 / §6.4 / §6.5 / Step 9 で繰り返し言及している。

## Recommendations（要修正・改善点）

### High

- なし (Approved)

### Medium

- **タスク本文 §テスト 5「親が closed → aborted 遷移で子が executable から外れる」のカバレッジを明示すること**
  - タスク本文 (`conductor-prompt.md` line 90-91) は「親が closed → aborted（close-task → abort-task の異常系想定）に遷移した瞬間、子が executable から外れること」を要求している。plan のテスト一覧 (A/B/C/D) には対応するケースが**明示的に列挙されていない**。
  - 実装上は plan §4.2 C「aborted 親 + ready 子 → pendingTasks=0」で実質カバーされる（taskState を `aborted` で仕込む = 「closed 後に aborted に遷移した結果状態」を再現できる）。
  - 推奨: §4.2 C のテストコメントに「= 親が closed → aborted へ異常遷移した直後の scanTasks 結果を検証する」と一文追記し、§テスト 5 の要件を明示的に紐付ける。新規テスト追加は不要。

- **既存 `daemon.test.ts:2912-2926`「ケース6（回帰）」が既に新方針コードで書かれている事実への言及が望ましい**
  - 当該テストは既に
    ```ts
    const closed = new Set(
      Object.entries(taskState)
        .filter(([_, s]) => s.status === "closed")  // ← 既に "closed" のみ
        .map(([id]) => id)
    );
    ```
    で書かれており、daemon.ts:3173-3177 の実装 (`isTerminalStatus`) と乖離している。
  - 推奨: plan §4.4「既存テストへの影響確認」に「daemon.test.ts:2912-2926 は既に `s.status === "closed"` 構築で書かれており、本変更で実装と整合する（テストコード変更不要）」と 1 行追加。これは方針の正当性の裏付け（テスト書き手の意図と本変更が同じ）にもなり、Step 2 の scanTasks 統合テストの実装雛形としても引用しやすい。

### Low

- **scanTasks 統合テスト (Step 2) の task-state 仕込み手順を具体化**
  - 既存 `daemon.test.ts:2818-2956` の `depends_on cascade on parent abort/delete (T241)` describe ブロックが、`createTask` ヘルパ + `loadTaskState` → 手動 mutate → `saveTaskState(testDir, ts)` のパターンで書かれている。Step 2 の新規テストはこのパターンを踏襲できる。
  - 推奨: Step 2 に「既存 `T241` describe (line 2817-2957) の helper / pattern を流用する」と 1 行追記する。実装者の迷いを減らす。
  - なお `saveTaskState` 直接呼び出しは tmp project 内なので CLAUDE.md「daemon.ts / main.ts で `saveTaskState(` を直接書いてはいけない」制約 (テスト/プロダクトコード対象外) には抵触しない。

- **`validateDependsOnExist` テストの fixture helper**
  - plan §4.2 D は「tmpdir helper (既存テストにあるか確認、なければ `mkdtemp` で書く)」と書いているが、確認すると `task.test.ts` 自体には現時点で `mkdtemp` ベースの fixture helper がない (現行テストは pure function のみ)。`daemon.test.ts:97-` の `タスク依存解決（ファイルシステム統合）` describe が `createTask` helper を持っており、これを参考に `task.test.ts` 用の最小 fixture を新設するのが現実的。
  - 推奨: Step 5 に「`mkdtempSync` + `mkdirSync` + `writeFileSync` で `.team/tasks/<NNN>-foo/task.md` を 1 ファイル仕込むだけの最小 fixture を describe-local に書く（共有 helper 化は不要）」と明記する。

- **手動 smoke (Step 7) の前提**
  - `validateDependsOnExist` は disk 直読みなので daemon 起動不要だが、smoke 実行時に worktree 内 `.team/tasks/` の状態に依存する。plan §6.5 と整合させ「smoke は worktree 内で実行するが `--depends-on 9999` は実在しないため副作用なし。worktree の `.team/tasks/` を汚さないこと」を 1 行明記すると安全。

- **`filterRunAfterAllTasks` の B テスト 1 本だけで run_after_all 経路が網羅できているか**
  - plan §4.2 B は 1 本のみ (aborted 親 + run_after_all 子 → block)。タスク本文「run_after_all タスクの依存判定 (`filterRunAfterAllTasks`) も同じルールが適用されていること」の最小要件は満たすが、`filterRunAfterAllTasks` は内部で `closedIds` を 2 箇所 (`task.ts:528` と `541`) で参照する。1 本でも当該 closed 判定は通るが、`normalActive` 計算側 (line 528) と「最終 ready 判定」側 (line 541) のどちらが効いているかが判別しにくい。
  - 推奨 (任意): 「closed 親 + run_after_all 子 → executable」の対称テストを 1 本足すと挙動が pin できる。最小スコープではなくてもよい。

## 検証結果（実コード/既存テストとの整合）

レビュー実施時に Read / grep で確認した実コードの状態:

- `skills/cmux-team/manager/daemon.ts:3173-3177` — 現状 `isTerminalStatus(s.status)` で `closed` Set を構築。plan の修正対象 ✓
- `skills/cmux-team/manager/daemon.ts:3179` — `openTasksList = tasks.filter(t => !isTerminalStatus(t.status))`。plan の据え置き対象 ✓
- `skills/cmux-team/manager/task.ts:465-487` — `filterExecutableTasks`、`closedIds.has(dep)` を line 482 で消費 ✓
- `skills/cmux-team/manager/task.ts:503-545` — `filterRunAfterAllTasks`、`closedIds.has(d)` を line 528, 541 で消費 ✓
- `skills/cmux-team/manager/task.ts:255-262` — `normalizeTaskIdList`、新関数の配置位置 ✓
- `skills/cmux-team/manager/task.ts:797-806` — `isTerminalStatus`、未変更で良い ✓
- `skills/cmux-team/manager/task.ts:851-870` — `createTaskProgrammatic` の run_after_all 競合チェック (line 859) で `isTerminalStatus` を使用、未変更で良い ✓
- `skills/cmux-team/manager/main.ts:74` — `isTerminalStatus` import あり、`validateDependsOnExist` 追加先 ✓
- `skills/cmux-team/manager/main.ts:1478` — `openTasksCount` 集計で `isTerminalStatus` 使用、未変更で良い ✓
- `skills/cmux-team/manager/main.ts:3995-4001` — `cmdCreateTask` の `normalizeTaskIdList` try/catch、直後に検証呼び出しを差し込む位置 ✓
- `skills/cmux-team/manager/main.ts:4099-4106` — `cmdUpdateTask` の `normalizeTaskIdList` try/catch、同上 ✓
- `skills/cmux-team/manager/team-gc.ts:357` — `isTerminalStatus(entry.status)` 使用、未変更で良い ✓
- `docs/spec/07-state-machine.md:245-267` — §2.4 cascade ルール / §2.5 不変条件、新規節 §2.5 挿入位置と §2.6 への shift が成立 ✓

既存テストの整合確認:

- `skills/cmux-team/manager/task.test.ts:271-389` — `filterExecutableTasks` describe。`new Set(["1"])` 等 closed-only パターンで書かれており、aborted ID を closed Set に渡す既存テストはなし。本変更で regression なし ✓
- `skills/cmux-team/manager/task.test.ts:391-465` — `filterRunAfterAllTasks` describe。同上 ✓
- `skills/cmux-team/manager/daemon.test.ts:2912-2926` — `T241 ケース6（回帰）`。**既に `s.status === "closed"` で closed Set を構築するパターン**で書かれており、本変更で daemon.ts 実装と完全整合する (Medium 推奨参照)。
- `skills/cmux-team/manager/daemon.test.ts:2817-2956` — `T241` cascade describe 全体は cascade ルール (PARENT_ABORTED → ready→draft 降格) を確認するもので、本変更の影響なし ✓
- `skills/cmux-team/manager/daemon.test.ts:97-` — `タスク依存解決（ファイルシステム統合）` describe、tmp project の `createTask` helper パターンが Step 2 の参考になる。

DoD (plan §7) は妥当。Medium 推奨を取り込んだ上で実装に進んで問題なし。
