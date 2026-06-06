# T014 実装レポート: Manager 再起動時の `asking` / `askQuestion` 喪失バグ修正

- **taskRunId**: task-014-1779211698
- **ブランチ**: `task-014-1779211698/task`
- **worktree**: `/Users/yamamoto/git/elevens/.worktrees/task-014-1779211698`
- **plan.md**: `/Users/yamamoto/git/elevens/.team/tasks/014-manager-conductor-asking-askquestion/runs/task-014-1779211698/plan.md`

---

## 1. 変更ファイル一覧

| ファイル | 種別 | 行数差分 | 概要 |
|---|---|---|---|
| `skills/cmux-team/manager/daemon.ts` | 変更 | +12 / -2 | (a) `updateTeamJson` の conductors map に `askQuestion: c.askQuestion` を追加 (b) `restoreConductorState` を `export function` に変更 + JSDoc `@internal` 付与 (c) 返り値に `askQuestion: typeof c.askQuestion === "string" ? c.askQuestion : undefined` 追加 (d) status 三項演算子に `asking` 分岐（`askQuestion` 非空のときのみ）追加 |
| `skills/cmux-team/manager/daemon.test.ts` | 変更 | +59 / 0 | 新規 describe `updateTeamJson / restoreConductorState: askQuestion 永続化 (T014)` を T261 describe 直後に追加し 3 ケース実装 |
| `docs/spec/07-state-machine.md` | 変更 | +2 / -1 | §1.1 `asking` 行に永続化注記 + §1.6 不変条件に `C-I5` 追加 |

## 2. 実装サマリ

### Subtask 1: `updateTeamJson` の conductors map に `askQuestion` を追加

- `daemon.ts:4737` に `askQuestion: c.askQuestion` を挿入。
- 既存の T260/T261/T323 と同じ「`updateTeamJson` の map に 1 行追加 + ConductorState schema は既存定義流用」パターン。
- schema.ts には既に `askQuestion: z.string().optional()` (`schema.ts:413`) が存在するため、schema 変更は不要。

### Subtask 2: `restoreConductorState` の status 分岐に `asking` + `askQuestion` 復元

- `daemon.ts:1069` で `restoreConductorState` を `export function` に変更（test-only export、`@internal` JSDoc 付与）。
- `daemon.ts:1103` に `askQuestion: typeof c.askQuestion === "string" ? c.askQuestion : undefined` を追加。
- `daemon.ts:1115` で status 三項演算子に `c.status === "asking" && typeof c.askQuestion === "string" && c.askQuestion.length > 0 ? "asking"` 分岐を追加（防御 fallback: `askQuestion` 空時は `idle` に倒す）。

### Subtask 3: テスト 3 ケース追加

`daemon.test.ts:5470-5527` に `describe("updateTeamJson / restoreConductorState: askQuestion 永続化 (T014)", ...)` を追加。3 ケースとも PASS。

- 3-a: `updateTeamJson` で `status='asking' + askQuestion='どちらにしますか?'` の Conductor を書き出すと JSON に含まれる
- 3-b: `restoreConductorState({ status: 'asking', askQuestion: 'Q1' })` が同値を返す
- 3-c: `restoreConductorState({ status: 'asking', askQuestion: undefined })` で `status='idle'` に倒される（防御 fallback）

### Subtask 4: docs/spec 更新

- §1.1 `asking` 行に「team.json に `askQuestion` と共に永続化され、Manager 再起動後も保持される (T014)」「`askQuestion` 空時は防御的に `idle` に倒す」を追記。
- §1.6 不変条件テーブルに `C-I5 | status=asking ⇒ askQuestion != null (T014) | restoreConductorState 防御 fallback` 行を追加。

## 3. テスト結果

### 3.1 新規 T014 テスト

```
$ bun test --timeout 30000 daemon.test.ts -t "T014"
3 pass / 0 fail / 7 expect() calls
```

### 3.2 daemon.test.ts 全体（regression 確認）

```
$ bun test --timeout 30000 daemon.test.ts
235 pass / 2 skip / 0 fail / 823 expect() calls
```

T261 / T326 / T421-F3 など `askQuestion` / `asking` を扱う既存テスト全 PASS、regression 無し。

### 3.3 全 test ファイル個別実行

CLAUDE.md ルール「`bun test` 全体実行は禁忌」に従い、ファイル単体実行を for ループで実行。

| 状態 | ファイル数 | 内訳 |
|---|---|---|
| PASS | 92 | 全 daemon / dashboard / metrics / state-machine / token / proxy / pool / worktree / mailbox 系 |
| FAIL（既存・本タスク無関係） | 3 | `cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts` / `project-root.test.ts` |

**FAIL 3 件は本タスク導入の regression ではない**: 失敗理由はいずれも「`cmux-team` → `elevens` リネームに伴うテスト期待文字列の更新漏れ」。

- `cli-project-root.test.ts:381`: `expected stderr to contain "not a cmux-team project", received "not an elevens project: ..."`
- `project-root.test.ts:93`: 同上（`ProjectRootError.message`）
- `cwd-mismatch.integration.test.ts:53/68/85`: `expected /^cd '[^']+' && cmux-team spawn-master\n$/`, received `cd '...' && elevens spawn-master\n`（CLI 名 `cmux-team` → `elevens` リネームの取り残し）

これらは `git diff main -- <files>` で本 worktree に変更が無いことを確認済み。`main` ブランチでも同じ状態で失敗する既存問題で、本タスクのスコープ外。

### 3.4 tsc 型検査

```
$ bunx tsc --noEmit 2>&1 | grep -E "(daemon\.ts|daemon\.test\.ts)"
（出力なし）
```

`daemon.ts` / `daemon.test.ts` 共に新規エラー無し。事前状態 `(none)` を維持。

### 3.5 invariant grep（実装ルール）

```
$ grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/{daemon,main}.ts        # 0 hit
$ grep -nE 'ts\[[^\]]+\]\s*='     skills/cmux-team/manager/{daemon,main}.ts        # 0 hit
$ grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/{daemon,main}.ts  # 0 hit
$ grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/{daemon,main}.ts  # 0 hit
$ grep -n  'saveTaskState('       skills/cmux-team/manager/{daemon,main}.ts        # 0 hit
$ rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts               # 0 hit
```

全 invariant を維持。

## 4. 完了条件チェック

| 完了条件 | 結果 |
|---|---|
| Subtask 1: `grep -n "askQuestion: c.askQuestion" daemon.ts` が `updateTeamJson` 内で 1 ヒット | ✓ (`daemon.ts:4737`) |
| Subtask 2: `grep -n "c.status === \"asking\"" daemon.ts` が `restoreConductorState` 内で 1 ヒット | ✓ (`daemon.ts:1115`) |
| Subtask 2: `grep -n "askQuestion: typeof c.askQuestion" daemon.ts` が `restoreConductorState` 内で 1 ヒット | ✓ (`daemon.ts:1103`) |
| Subtask 2: `grep -n "^export function restoreConductorState" daemon.ts` が 1 ヒット | ✓ (`daemon.ts:1069`) |
| Subtask 3: 新規 3 ケース全 PASS | ✓ |
| Subtask 3: `grep -n "T014" daemon.test.ts` が 3 ヒット以上 | ✓ (4 ヒット) |
| Subtask 4: `grep -n "T014" docs/spec/07-state-machine.md` が 2 ヒット以上 | ✓ (2 ヒット、§1.1 と §1.6) |
| 既存テスト regression 無し | ✓ (3 件の既存 fail は本タスク外) |
| `bunx tsc --noEmit` 新規エラー無し | ✓ |

## 5. 補足事項

### 5.1 既存テスト fail 3 件の取り扱い

`cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts` / `project-root.test.ts` は `cmux-team` → `elevens` リネームの取り残しで `main` ブランチでも fail する既存問題。

- T014 plan.md §6 の事前 `bunx tsc --noEmit` チェックでは「該当 2 ファイル(`daemon.ts` / `daemon.test.ts`)に既存エラー無し」と記載されており、テスト fail は別経路の既存問題。
- 修正は別タスクで行うべき（本タスクの scope は asking/askQuestion 永続化に限定、CLAUDE.md「scope を絞る」原則）。

### 5.2 export 化に伴う影響範囲

`restoreConductorState` の export 化は test-only。`@internal` JSDoc と T014 マーカーで「プロダクションコードから直接呼ばないこと」を明示。production 経路の唯一の呼び出しは `applyRestorePlan` の `daemon.ts:1170` のみで、シグネチャは不変のため呼び出し側修正不要。

### 5.3 reducer 経路への影響

本タスクは A 経路 (restore) のみの修正で、`apply-task-actions.ts` / `state-machine/` の reducer は無変更。よって遷移表（§1.2）の意味論には変更が無く、Mermaid 図（§1.4）も更新不要。

### 5.4 dashboard / events.jsonl への自然な追従

dashboard の `buildConductorRow` は既に `asking` + `askQuestion` 表示を実装済み（§1.5 マッピング、`asking | ⚠ | [NNN] T123 asking <elapsed> + ? <質問本文> | YELLOW`）。本タスクの修正により、Manager 再起動後も `asking` 状態が消えず、ユーザーが質問に気付ける状態が回復する（退行ではなく回復方向、plan.md §5 R5 の通り）。
