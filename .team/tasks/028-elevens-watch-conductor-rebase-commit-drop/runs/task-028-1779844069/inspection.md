# Inspection: T028

## 判定: GO

## 検品結果（観点 A〜E ごと）

### A. 完了条件
**充足**。3 ファイルの修正・新フローへの差し替えがすべて確認できた。

- `commands/watch.md` Step 2（L116）: `gh pr merge --squash "$PR_URL"` に変更され `--delete-branch` 除去済。L115 のコメントで「branch は残す（drop 追跡可能性のため）」と理由も明記。
- `commands/watch.md` Step 2 分岐（L121-123）: `MERGE_EXIT != 0` で conflict 系は **Step 3 への escalation 経路** に統一。「**自動の衝突解消は行わない**（drop リスク回避のため）」を明示行で追加。
- `commands/watch.md` Step 3（L125-157）: 見出しが「Conflict 検出時の escalation（自動 resolve は行わない）」に変更。`git merge --abort` / `git rebase --abort` の中断処理を `MERGE_HEAD` / `rebase-merge` / `rebase-apply` の有無で分岐させて明示。`Edit ツールで衝突マーカー解消` 経路は完全削除。escalation フォーマットも Step 2 の他 escalation と同フォーマット（`[escalation] task_completed (PR conflict — manual resolve required)` 形式）。
- `commands/watch.md` 設計方針節（L13）: 「PR merge（squash、branch は残す）」「**conflict が出た PR の自動 resolve は行わない（drop リスクを避けるため escalate に倒す）**」に書き換え済み。
- `commands/watch.md` 末尾（L330-343）: 「Branch cleanup 方針メモ」節を追加し、`docs/spec/16-worktree-archive.md` の `--delete-branch` が別系統であることも明記して読者の混乱を防止。
- `skills/cmux-team/templates/ja/conductor-role.md` Step 8（L477-557）: 旧 8-3（semantic resolution）/ 8-4（検証）/ 8-5（conflict-resolution.md 書き出し）/ 8-6（escalation）が**完全廃止**され、新フロー 8-1（情報収集、Edit 禁止）→ 8-2（rollback、`PRE_REBASE` を引き続き使用）→ 8-3（`failure_mode=rebase_conflict` の判断必要レポート）の 3 ステップに圧縮。
- ja L486 の例外注記: 「Conductor 原則の例外扱い（8-3 が唯一の例外）」→ 「**Conductor 原則の徹底**: conflict marker が出たファイルを含め、いかなる場合も Edit / Write しない」に書き換え済。
- ja L504 周辺: `ALL_CONFLICT_FILES=""` の初期化が削除済。`PRE_REBASE` は新 8-2 rollback 用として残置（コメントも更新）。
- `.team/artifacts/A034-watch-commit-drop-postmortem.md` 存在確認済（後述）。

### B. en / ja 同期
**充足**。`skills/cmux-team/templates/en/conductor-role.md` Step 8（L431-510）を実際に Read で突き合わせ、ja Step 8 と 1:1 対応していることを確認。

- 見出し: en L431 `Step 8: Rebase onto {{MAIN_BRANCH}} (stop on conflict with a [Judgment Required] report)` ↔ ja L477 同義。
- 原則注記: en L440 `Conductor principle (strict)` ↔ ja L486 「Conductor 原則の徹底」、いずれも「conflict でも Edit / Write しない / `semantic resolution` was removed in T028」に統一。
- 分岐文: en L463 ↔ ja L509、いずれも 8-1 → 8-2 → 8-3 の 3 ステップ minimal flow。
- 新 8-1 / 8-2 / 8-3: en L465-510 ↔ ja L511-556、コード/フィールド名（`CONFLICT_FILES` / `PRE_REBASE` / `CONFLICT_TASK_ID` / `failure_mode=rebase_conflict`）まで完全一致。
- 旧 8-3 / 8-4 / 8-5 / 8-6（semantic resolution / 検証 / conflict-resolution.md / 旧 escalation）は en 側でも全削除。片方だけ古い記述が残っている箇所は見つからなかった。

### C. dangling 参照 / 整合性
**充足**。

- 新 8-1 / 8-2 / 8-3 内に廃止済の `ALL_CONFLICT_FILES` / `ITERATION_LIMIT` / `scope_violation` / `8-4` / `8-5` / `8-6` への dangling 参照は **無し**（grep で 0 ヒット、§D 参照）。
- `PRE_REBASE` は Step 8 冒頭で保存（ja L502 / en L456）され、新 8-2 rollback（ja L533 / en L487）で正しく使われ続けている。rollback が壊れていないことを確認。
- 旧 `ALL_CONFLICT_FILES=""` 初期化は ja / en ともに削除済。新フローでは `git diff --name-only --diff-filter=U` で都度算出（iteration ループが無いため積み上げ不要）。
- Step 9（ff-only merge）/ Step 10（worktree 削除）/ Step 11（close-task）への参照は新フローと矛盾しない。Step 9 失敗時の judgment-pending escalation 経路は維持されており、新 Step 8 の escalation 経路と同フォーマット。
- `docs/spec/04-templates.md` L211 で旧 Step 8 semantic resolution 段落が「Step 8 conflict handling（T028 で semantic resolution は廃止）」に書き換わり、旧 T284 path（8-1〜8-5 / 旧 failure_mode 区分）が削除済と明記。A034 への参照も入り、dead spec が放置されていない。
- `docs/spec/04-templates.md` L215 で `conflict-resolution.md フォーマット` 節タイトルが「廃止: T028」に変更され、L217-220 の blockquote で「現在 Conductor によって書き出されない、新規実装は本節を参照しない」と明記。フォーマット本体は歴史保存。
- L258-259 の「`Verification` 節は 8-4 の test / tsc 結果を 1 行ずつ」「`Iterations` 節は 8-3 の `git rebase --continue` ループ回数」は廃止注記節（L215-）の **内部** の歴史記述で、冒頭の「廃止 (T028)」blockquote でカバーされているため dangling とは判定しない。

### D. 残骸 grep
**残骸 0**。タスク本文指定の grep を実行した結果は以下のとおり。

```bash
grep -rn "Edit ツールで衝突マーカー\|semantic resolution\|conflict-resolution.md\|--delete-branch\|ITERATION_LIMIT\|ALL_CONFLICT_FILES\|8-5\|8-6" commands/ skills/cmux-team/templates/ docs/spec/
```

ヒットを分類（タスク本文指定の (a) / (b) 基準）:

| ファイル:行 | 内容 | 分類 |
|---|---|---|
| `commands/watch.md:332` | `gh pr merge` で `--delete-branch` を付けない（cleanup 方針メモ） | (a) 新仕様の明示 |
| `commands/watch.md:342` | `--delete-branch` フラグは worktree archive 専用の別系統 | (a) 別機能との区別説明 |
| `skills/cmux-team/templates/ja/conductor-role.md:486` | 「semantic resolution 経路は廃止」（Conductor 原則の徹底注記） | (a) 新仕様の明示 |
| `skills/cmux-team/templates/en/conductor-role.md:440` | 同上の英訳 | (a) 同上 |
| `skills/cmux-team/templates/en/conductor-role.md:463` | "The Conductor must not attempt semantic resolution" | (a) 同上 |
| `docs/spec/04-templates.md:211` | Step 8 conflict handling 段落（「T028 で semantic resolution は廃止」） | (a) 廃止 (T028) 注記 |
| `docs/spec/04-templates.md:215` | `conflict-resolution.md フォーマット（廃止: T028）` 節タイトル | (a) 廃止 (T028) 注記 |
| `docs/spec/04-templates.md:217` | `> 廃止 (T028): Step 8-5 ... 廃止されたため ...` blockquote | (a) 廃止 (T028) 注記 |
| `docs/spec/16-worktree-archive.md:241` | `remove <taskRunId> [--delete-branch]`（worktree archive 機能） | (b) 別機能 — 触らない |
| `docs/spec/16-worktree-archive.md:290` | `elevens worktree archive prune --delete-branches` | (b) 別機能 — 触らない |

追加で「自動衝突解消」「8-3 / 8-4」「scope_violation / iteration_limit / spec_divergence」も grep した（出力は省略）。すべて (a) 新仕様か (b) 廃止注記内の歴史記述に該当し、Edit / 自動 rebase 続行を促す残骸はゼロ。

### E. artifact 品質
**充足**。`.team/artifacts/A034-watch-commit-drop-postmortem.md` を確認。

- frontmatter: `id: A034` / `type: research` / `title: "watch / Conductor 自動 rebase commit drop の post-mortem (T028 構造変更)"` / `created: 2026-05-27` / `author: surface:8` / `task: T028` / `tags: [...]` がすべて揃っている。
- 本文章立て: 「背景」/「調査結果」（経路 A semantic resolution / 経路 B `--delete-branch` / 経路 C 自動 Edit / Manager log 対応 / 99e23a6e 残存確認）/「比較・分析」（残す案 vs 廃止する案 / docs/spec/04-templates.md を touch した理由）/「結論」（本タスクで適用した構造変更 4 項目 / 残課題）/「関連ファイル」と、タスク本文「背景 / 経路推定 A・B・C / Manager log 対応 / 99e23a6e 残存確認 / 本タスクで適用した構造変更 / 残課題」を完全網羅。
- **04-templates.md を touch した理由**: 「比較・分析」§「docs/spec/04-templates.md を touch した理由」（L96-110）で、タスク本文の `commands/` と `skills/cmux-team/templates/` のみで完結する想定と完了条件「衝突解消経路に『自動 Edit』『自動 rebase 続行』が残っていない」の葛藤に対し、dangling spec を絶つために「廃止 (T028)」注記を加える判断を明記（フル削除はしない）。タスク本文の「もし必要だと判断したら理由を artifact に残してから着手」要件を満たす。
- 経路 A の root cause（scope_violation / `bun test` / `bunx tsc --noEmit` が片側 drop を検知できない理由）まで踏み込んで分析されている。

## Fix Required
（GO のため無し）
