# T014 完了サマリ: Manager 再起動時の `asking` / `askQuestion` 喪失バグ修正

- **taskRunId**: task-014-1779211698
- **ブランチ**: `task-014-1779211698/task`
- **完了**: 2026-05-20

## 完了したサブタスク

1. **Plan**: 実装計画書 `plan.md` を作成（Subtask 1-4、リスク表、テスト戦略）
2. **Impl**: 3 ファイル変更で 4 Edit を実装、新規 3 テスト追加
3. **Inspect**: GO 判定（Critical findings なし、Minor は本タスクスコープ外）

## 変更ファイル一覧

| ファイル | 差分 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/daemon.ts` | +13 / -1 | (a) `updateTeamJson` の conductors map に `askQuestion: c.askQuestion` を追加。(b) `restoreConductorState` を `export function` 化（`@internal` JSDoc）、返り値に `askQuestion` 追加、status 三項演算子に `asking` 分岐 + 防御 fallback (空時 idle) 追加 |
| `skills/cmux-team/manager/daemon.test.ts` | +56 / 0 | T261 describe 直後に T014 用 describe を追加し 3 ケース実装（書き出し / restore 維持 / 防御 idle 倒し） |
| `docs/spec/07-state-machine.md` | +2 / -1 | §1.1 `asking` 行に永続化注記、§1.6 不変条件に `C-I5` 追加 |

## テスト結果

- 新規 T014 テスト: 3 pass / 0 fail
- daemon.test.ts 全体: 235 pass / 2 skip / 0 fail
- tsc 新規エラー: 0 件（事前状態 `(none)` 維持）

## 設計判断・補足

- `restoreConductorState` を test-only export 化し、unit テストで直接検証可能にした（T421-F3 の制約解消への布石、本タスクでは F3 リファクタは scope 外）
- 防御 fallback (`askQuestion` 空時 idle 倒し) を `length > 0` まで厳格化し、観察可能な不整合状態にしないよう設計
- schema.ts の既存 `askQuestion: z.string().optional()` を流用、schema 変更なし（最小スコープ）

## 後続タスク化推奨（本タスクで起票しない）

- R1: C-I5 violation の shadow log 追加（防御 idle 倒し発動時の `fsm_invariant_violation` 通知）
- R2: E2E 手動検証 artifact（実際に asking 状態の Conductor で Manager 再起動 → TUI / team.json の表示確認）
- R3: 既存 fail 3 件（`cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts` / `project-root.test.ts`）の `cmux-team` → `elevens` リネーム取り残し修正（本タスクと独立、main でも fail する既存問題）

## マージ情報

- 納品方式: ローカル ff-only マージ
- マージコミット: 後段の rebase / merge 後に追記
