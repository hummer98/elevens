# Inspection: Task 001 — `close-task --force` aborted → closed

## 1. 判定

**GO**

plan.md と実装の乖離は最小（変数名・コメント表現のみ、機能差分なし）。テスト 4 ファイルすべて pass。新規 TSC エラー 0。観察可能性・既存挙動保護・仕様逸脱の各項目で問題なし。

## 2. テスト結果

| ファイル | 結果 | tests / expects |
|---|---|---|
| `state-machine/fsm.test.ts` | **pass** | 191 pass / 0 fail / 360 expect |
| `state-machine/task-state-store.test.ts` | **pass** | 44 pass / 0 fail / 120 expect |
| `state-machine/apply-task-actions.test.ts` | **pass** | 15 pass / 0 fail / 48 expect |
| `main.test.ts` | **pass** | 259 pass / 0 fail / 715 expect |

新規テストは plan.md のテスト計画通り全件追加されており、内訳は:

- fsm.test.ts: aborted+force=true (log/detail/no cascade)、aborted+force=false noop、closed+force=true noop、deleted+force=true noop、assigned+force=true (通常 task_closed) の 6 ケース + deleted 終端 events 配列に `{ type: "CLOSE", force: true }` 追加
- task-state-store.test.ts: aborted+force=true で abortedAt 残置 + closedAt 付与 + task_closed_from_aborted log + prev_aborted_at detail / aborted+force=false noop の 2 ケース
- apply-task-actions.test.ts: T358 allowlist 外確認に `task_closed_from_aborted` 行を追加（events.jsonl に流れない・manager.log には残る、両方 assert）
- main.test.ts: CLI 統合 3 ケース（`--force` なし reject / aborted+`--force` で closed 遷移 + abortedAt 残置 + manager.log に task_closed_from_aborted / journal 省略許容）

## 3. TSC 結果

**pass（新規エラー 0）**

`bunx tsc --noEmit`（manager 配下）の総エラー数は変更前 8 件 / 変更後 8 件で同数。

差分内訳（既存エラーで本タスク touch ファイル外）:
- `c11-features.test.ts:129,172`、`c11-features.ts:246,254`
- `mailbox-cli.ts:29,30,44`
- `main.ts:956`（行番号は `cmdCloseTask`(4324〜) と離れた既存箇所）

今回 touch した `events.ts` / `task-fsm.ts` / `main.ts:4329-4366` / 各 test に紐づく新規エラーは 0。

## 4. plan.md との乖離

**重大な乖離なし**。検出した軽微な差分のみ列挙:

1. **events.ts のコメント**: plan.md は `T??? :` プレフィックスを案として記載していたが、実装ではプレフィックスなしの説明文に統一。コメントが識別子なしでも機能が自明なので妥当（plan.md 自身が `T???` をプレースホルダ扱いしている）。
2. **task-fsm.ts コメント**: `Why:` 形式の 2 行コメントが追加され、cascade なしの根拠が一行で読めるようになっている。plan.md からのプラス改善で問題なし。
3. **main.ts コメント**: CLI flag `--force` と `event.force` の意味の独立性を明示するコメントが追加され、混同防止の plan.md 「リスク・注意点」§ "event.force と parseCloseTaskArgs の force の使い分け" を実装側で補強。
4. **main.test.ts のテスト名**: plan.md は `test("close-task (T???): ...")` 形式だったが、実装は `test("close-task: ...")` で `T???` プレースホルダを除去。可読性 +、機能差なし。

## 5. 観察可能性

**OK**

- `apply-task-actions.ts:155-164` で `action.type === "log"` のとき `log(action.event, action.detail)` を呼び manager.log に書き込んだ後、`dispatchEventStreamLog` を呼ぶ二段構成。
- `dispatchEventStreamLog`（`apply-task-actions.ts:74-147`）の `switch` 5 case (`task_created` / `task_ready` / `task_assigned` / `task_completed_state_mismatch` / `task_reverted_to_ready`) に `task_closed_from_aborted` は含まれず、default で return。
- 結果: `task_closed_from_aborted` は **manager.log のみ**に残り、events.jsonl には流れない（plan.md §「log event 名衝突」と一致、apply-task-actions.test.ts で locked-in 済み）。
- main.test.ts のテスト 581 で実際に `.team/logs/manager.log` を読んで `task_closed_from_aborted` と `prev_aborted_at=2026-04-23T11:00:00Z` が含まれることを assert（end-to-end で経路確認済み）。

## 6. 既存挙動の保護

**regression なし**

- `closed + CLOSE (force=true)` → noop: fsm.test.ts 新規テストで確認 / 既存 closed+CLOSE noop テストも pass
- `aborted + CLOSE (force 無し)` → noop: fsm.test.ts 既存 + 新規テストで確認 / task-state-store.test.ts 新規テストで committed=false まで確認
- `assigned + CLOSE` 通常経路: fsm.test.ts で `assigned + CLOSE (force=true)` でも `task_closed` が emit されることを確認（reducer は assigned で event.force を読まない）
- T295 既存テスト (`assigned + --force` 必須): main.test.ts で 1227 行までの既存テストはそのまま pass（259 件総 pass）
- T291 slug 経路 / autoClosed=true: 該当テストすべて pass

## 7. Critical findings

なし。

## 8. Minor findings

GO 判定だが今後改善検討してよい点:

- **footnote 番号**: `[^t6]` は spec ファイル全体で重複していないが、新規 footnote の番号採番は将来 conflict のリスクがある。次回追加時は `grep -n "^\[\^t" docs/spec/07-state-machine.md` で番号衝突確認するルーチン化が望ましい（本タスクでは衝突なしを確認済み）。
- **main.test.ts 内のヘルパ**: 3 つの新規テストで `import("fs/promises").writeFile` を毎回 dynamic import しているが、ファイル冒頭の static import に揃えても良い（既存テスト 1227 行付近でも同じパターンなので踏襲は妥当、blocking ではない）。
- **prev_aborted_at detail format**: `prev_aborted_at=<ISO>` は単純な key=value だが、将来 detail に複数 key を載せる際の delimiter 決定がまだない。今回 1 key のみなので問題なし。

## 9. Fix Required

なし（GO）。

---

**検品実施**: surface126 inspector / 2026-05-10
