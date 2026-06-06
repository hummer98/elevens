# T014 検品レポート

- **taskRunId**: task-014-1779211698
- **inspector**: surface (inspector role)
- **対象ブランチ**: `task-014-1779211698/task`
- **inspect 実施日時**: 2026-05-20
- **対象差分**: `docs/spec/07-state-machine.md` (+2/-1) / `skills/cmux-team/manager/daemon.test.ts` (+56) / `skills/cmux-team/manager/daemon.ts` (+13/-1)

## 判定: GO

## 検品結果サマリ

- **A. 仕様適合性**: ○ — plan.md / conductor-prompt.md の全 Edit が漏れなく実装されている
- **B. テスト品質**: ○ — 3 ケースとも意味のあるアサーションで fake green なし
- **C. ガードレール**: ○ — 全 invariant 維持
- **D. scope 逸脱**: ○ — plan.md「触らない」リストの遵守を git diff で確認
- **E. 型検査**: ○ — `bunx tsc --noEmit | grep daemon` の出力なし（既存 0 件維持）
- **F. テスト実行**: ○ — `daemon.test.ts` 235 pass / 2 skip / 0 fail（T014 3 ケース PASS 含む）
- **G. 観察可能性**: ○ — observatory 原則（state を team.json に外部化、observer が pull で観測可）に厳密に従う

## 詳細検査

### A. 仕様適合性

| 観点 | 結果 | 証拠 |
|---|---|---|
| A-1 `updateTeamJson` の conductors map に `askQuestion: c.askQuestion` 追加 | ✓ | `daemon.ts:4737`、T014 コメント付き |
| A-2-a `restoreConductorState` 返り値に `askQuestion` 追加 | ✓ | `daemon.ts:1103`、`typeof c.askQuestion === "string" ? c.askQuestion : undefined` で型 narrowing 付き |
| A-2-b status 三項演算子に `asking` 分岐追加 + 防御 fallback | ✓ | `daemon.ts:1115` で `c.status === "asking" && typeof c.askQuestion === "string" && c.askQuestion.length > 0 ? "asking"` と `length > 0` まで含む厳格防御 |
| A-2-c `restoreConductorState` の export | ✓ | `daemon.ts:1069` で `export function`、JSDoc `@internal` 付き（test-only export 明示） |
| A-3 docs/spec/07-state-machine.md §1.1 / §1.6 T014 注記 | ✓ | §1.1 `asking` 行 (line 31)、§1.6 `C-I5` 追加 (line 147)、`grep -c T014` で 2 ヒット |
| A-4 `schema.ts` の `askQuestion: z.string().optional()` 健在 | ✓ | `schema.ts:413` — 本タスクで未変更、parse 経路で blocking なし |

### B. テスト品質

新規 describe `updateTeamJson / restoreConductorState: askQuestion 永続化 (T014)` を T261 永続化 describe (line 5420) の直後 (line 5470-5527) に配置。3 ケースの意味的検証:

| ケース | アサーション | 評価 |
|---|---|---|
| 3-a 書き出し | `serialized.status === "asking"` AND `serialized.askQuestion === "どちらにしますか?"` の 2 段検証 | ○ — status/askQuestion の両方を JSON から読み出して検証、構造的に意味あり |
| 3-b restore 維持 | `restored.status === "asking"` AND `restored.askQuestion === "Q1"` | ○ — input/output の同値性を直接確認、副作用検証 |
| 3-c 防御 idle 倒し | `restored.status === "idle"` AND `restored.askQuestion === undefined` | ○ — 防御 fallback が両 field に効くことを明示確認 |

3 ケースとも actual に対する具体的な値検証であり、`.toBeDefined()` 等のゆるい trivial アサーションのみで終わっていない（fake green でない）。

regression 確認:
- daemon.test.ts 全 235 pass / 2 skip / 0 fail （T261 / T326 / T421-F3 系 askQuestion / asking 既存テスト全 PASS）
- impl-report.md §3.2 と一致

### C. ガードレール

| 観点 | 結果 | 証拠 |
|---|---|---|
| C-1 `task-state` 直接書き込みなし | ✓ | `grep -nE 'taskState\[.*\]\s*='` および `(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*='` で 0 ヒット |
| C-2 `bus.emit / bus.on` 直接呼び出しなし | ✓ | `rg "bus\.(emit\|on)\b"` で 0 ヒット（eventBus.ts 除く） |
| C-3 空の `catch {}` 新規追加なし | ✓ | git diff 上に `catch` の追加が存在しない |
| C-4 `cmux tree` API workspace 省略なし | ✓ | 本タスクで tree() / validateSurface() 呼び出し変更なし |
| C-5 `bun test` 全体実行に依存しない | ✓ | impl-report に `daemon.test.ts` 単体実行のみ記録、`for f in *.test.ts` パターン併用 |
| C-6 `saveTaskState(` 直接呼び出しなし | ✓ | grep 0 ヒット |

### D. scope 逸脱

| 触らない対象 | 確認 |
|---|---|
| `applyResumeTransitions` | git diff に該当関数の変更なし |
| `layout-restore.ts` | `git diff main --stat` に含まれず（変更ファイル 3 件: daemon.ts / daemon.test.ts / 07-state-machine.md のみ） |
| daemon の SESSION_ASK ハンドリング | `daemon.ts:2848` の `conductor.askQuestion = message.question;` は既存ライン、本タスクで未変更 |
| `task-state.json` schema | 同上、変更ファイルに schema.ts 含まれず（既存 `schema.ts:413` の `askQuestion: z.string().optional()` も無変更） |
| Task FSM reducer | `apply-task-actions.ts` / `state-machine/` 一切無変更 |
| events.jsonl / dashboard / Epic Planner | 変更なし。impl-report §5.4 で「read 側は team.json の status を見れば自然に追従」と整合 |

既存 fail 3 件（`cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts` / `project-root.test.ts`）について `git diff main --stat` で本 worktree の変更対象に含まれないことを確認。これら 3 件は `cmux-team` → `elevens` リネームの取り残しに起因する main ブランチでも fail する既存問題で、本タスクの regression ではない。

### E. 型検査

```
$ bunx tsc --noEmit 2>&1 | grep -E "(daemon\.ts|daemon\.test\.ts)"
(none)
```

事前状態 `(none)` を維持。`restoreConductorState` の export 化により外部 import 可能になったが新規エラー無し（既存唯一の呼び出し元 `applyRestorePlan` の `daemon.ts:1170` はシグネチャ変更なしで影響なし）。

### F. テスト実行

```
$ bun test --timeout 60000 daemon.test.ts
 235 pass
 2 skip
 0 fail
 823 expect() calls
Ran 237 tests across 1 file. [100.23s]

$ bun test --timeout 30000 daemon.test.ts -t "T014"
 3 pass
 1 skip
 0 fail
 7 expect() calls
Ran 4 tests across 1 file. [214.00ms]
```

T014 系 3 ケース PASS、全体 regression なし。1 skip は別系統の既存 skip テスト（filter 内）。

### G. 観察可能性 / observatory 原則

| 観点 | 評価 |
|---|---|
| 再起動を跨いだ asking 状態が観察可能になったか | ○ — team.json に `status="asking"` と `askQuestion` の両方が永続化され、外部 observer（Master / dashboard / cmux-team status）は pull で正しく取得可能になった |
| state を外部化する設計に合致 | ○ — 「state を外部化し、observer が pull で観測できる」原則に従う。新ファイル追加せず既存 team.json への 1 フィールド追加で済む最小変更（MEMORY.md `feedback_minimal_scope` に合致） |
| silent state mutation を作っていないか | ○ — restore 経路は `restoreConductorState` の純粋関数化（テスト可能）+ 防御 fallback で「`status=asking` だが `askQuestion=undefined`」という不整合を観察可能に変換（C-I5 不変条件として明文化） |
| pane / observability 阻害なし | ○ — read 側（dashboard.tsx:buildConductorRow）は既存実装が `asking` を扱っており、修正後は再起動を跨いでも `⚠ + 質問本文` の TUI 表示が消えない（退行ではなく回復方向） |

## Critical findings（NOGO 必要レベル）

なし。

## Minor findings（改善推奨、GO でも記載）

- M1. `C-I5` の violation 検出 shadow log は本タスクスコープ外として「将来追加」と明記されているが、現状 violation が起きた事実が log に残らない。実害は限定的（防御 fallback で idle に倒した結果 ask 中の Conductor が見えなくなる程度）だが、後続タスクで `fsm_invariant_violation` への C-I5 通知を追加する余地あり。
- M2. `restoreConductorState` の export を test-only と明示する手段は `@internal` JSDoc のみ。プロダクション import を grep で機械的に防ぐ仕組み（`eslint-plugin-no-internal-modules` 等）は未導入。現状の規模（呼び出し元 1 箇所、責務単一）では十分許容範囲。

## Fix Required（NOGO の場合のみ）

なし（GO 判定）。

## 推奨事項

- R1. **C-I5 violation の shadow log 追加**: `restoreConductorState` で防御 idle 倒しが発動したケース（`c.status === "asking"` だが `askQuestion` 空）を `fsm_invariant_violation` などにログ出力すると、team.json 破損や hook 経路バグの早期検出が可能。後続タスクで対応推奨。
- R2. **E2E 検証 artifact**: plan.md §7.5 で記載された手動 E2E（実際に asking 状態の Conductor を作って Manager を再起動 → TUI / team.json の表示確認）はスコープ外として未実施。リリース前に手動検証を行うか、cmux-team-lab で再現スクリプトを artifact 化することを推奨。
- R3. **既存 fail 3 件の修正タスク化**: `cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts` / `project-root.test.ts` の `cmux-team` → `elevens` リネーム取り残しは、本タスクと独立した新タスクとして起票することを推奨。
