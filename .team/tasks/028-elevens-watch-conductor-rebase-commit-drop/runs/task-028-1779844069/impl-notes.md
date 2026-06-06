# T028 Impl Notes

## 編集したファイル一覧

1. `commands/watch.md`
   - 設計方針節（L13）: 「PR merge（squash + delete-branch）/ conflict resolve」を「PR merge（squash、branch は残す）」「conflict が出た PR の自動 resolve は行わない」に書き換え
   - Step 2: `gh pr merge --squash --delete-branch "$PR_URL"` → `gh pr merge --squash "$PR_URL"`（`--delete-branch` 除去）。「conflict 系は必ず Step 3 へ」「自動の衝突解消は行わない」を明示
   - Step 3: 旧 `git merge origin/main` + Edit による自動解消経路を削除。代わりに `git merge --abort` / `git rebase --abort` で merge / rebase 状態を中断し、`[escalation] task_completed (PR conflict — manual resolve required)` フォーマットで user に判断委任する経路へ変更
   - ファイル末尾に「Branch cleanup 方針メモ」節を追加（累積 branch の cleanup は別タスク運用、`docs/spec/16-worktree-archive.md` の `--delete-branch` は別系統であることを明記）

2. `skills/cmux-team/templates/ja/conductor-role.md` Step 8
   - 見出し: `### Step 8: {{MAIN_BRANCH}} に rebase する（conflict は semantic に自解決する）` → `### Step 8: {{MAIN_BRANCH}} に rebase する（conflict 時は判断必要レポートで停止する）`
   - 冒頭の「Conductor 原則との関係（例外扱い）」ブロックを「Conductor 原則の徹底」に書き換え（conflict marker 出ても Edit / Write しない、T028 で semantic resolution 経路は廃止）
   - rebase コードブロックから `ALL_CONFLICT_FILES=""` 初期化を削除、`PRE_REBASE` のコメントを 8-2 rollback 用に変更
   - 「rebase が conflict で失敗した場合」分岐文を「8-1（情報収集）→ 8-2（rollback）→ 8-3（escalation）の最小フロー」に書き換え
   - 旧 8-1 / 8-2 / 8-3（semantic resolution）/ 8-4（検証）/ 8-5（conflict-resolution.md）/ 8-6（escalation）を全廃
   - 新 8-1（conflict 情報収集、Edit 禁止の最小限）/ 8-2（rollback）/ 8-3（[判断必要] レポート、`failure_mode=rebase_conflict`）に再構成

3. `skills/cmux-team/templates/en/conductor-role.md` Step 8
   - ja と 1:1 で同期。同じ構造（旧 8-1〜8-6 全廃 → 新 8-1 / 8-2 / 8-3）。「Conductor principle (strict)」ブロックを設置
   - 見出し: `Step 8: Rebase onto {{MAIN_BRANCH}} (resolve conflicts semantically)` → `Step 8: Rebase onto {{MAIN_BRANCH}} (stop on conflict with a [Judgment Required] report)`

4. `docs/spec/04-templates.md`
   - L211 段落 `**Step 8 semantic resolution（T284）:**` を `**Step 8 conflict handling（T028 で semantic resolution は廃止）:**` に書き換え。新仕様（最小情報収集 + rollback + `failure_mode=rebase_conflict` の判断必要レポート）を記載し、旧 T284 path（8-1 ALL_CONFLICT_FILES / 8-3 Edit / 8-4 scope_violation・test・tsc / 8-5 / 旧 failure_mode 区分）が T028 で削除されたことを明記。経緯参照として A034 を pin
   - `### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）` 節タイトルを `### conflict-resolution.md フォーマット（廃止: T028）` に変更し、冒頭に「廃止 (T028)」注記の blockquote を追加（フォーマット本体は歴史保存）

## 作成した artifact

- パス: `.team/artifacts/A034-watch-commit-drop-postmortem.md`
- ID: A034
- type: research
- title: "watch / Conductor 自動 rebase commit drop の post-mortem (T028 構造変更)"
- 章立て: 背景 / 調査結果（経路 A・B・C / Manager log 対応 / 99e23a6e 残存確認）/ 比較・分析（自動解消を残す案 vs 廃止する案 / 04-templates.md を touch した理由）/ 結論（本タスクで適用した構造変更 4 項目 / 残課題）

## §4.3 grep の最終結果（残骸 0 の確認）

実行コマンド:
```bash
grep -rn "Edit ツールで衝突マーカー\|自動.*衝突解消\|semantic resolution\|conflict-resolution.md\|--delete-branch\|ITERATION_LIMIT\|ALL_CONFLICT_FILES" \
  commands/ skills/cmux-team/templates/ docs/spec/
```

ヒット一覧と分類:

| ファイル:行 | 内容 | 分類 |
|---|---|---|
| `commands/watch.md:123` | `**自動の衝突解消は行わない**（drop リスク回避のため、conflict 系は必ず Step 3 へ）` | (a) 新仕様の明示記述 |
| `commands/watch.md:332` | `gh pr merge` で `--delete-branch` を付けないため remote/local の feature branch が残る | (a) 新仕様の cleanup 方針メモ |
| `commands/watch.md:342` | `--delete-branch` フラグは別系統（worktree archive 専用）であり本件と無関係 | (a) 区別の説明 |
| `skills/cmux-team/templates/ja/conductor-role.md:486` | 「semantic resolution 経路は廃止」 | (a) 新仕様の明示記述 |
| `skills/cmux-team/templates/en/conductor-role.md:440` | 同上の英訳 | (a) 同上 |
| `skills/cmux-team/templates/en/conductor-role.md:463` | "The Conductor must not attempt semantic resolution" | (a) 同上 |
| `docs/spec/04-templates.md:211` | `Step 8 conflict handling（T028 で semantic resolution は廃止）` 段落 | (a) 「廃止 (T028)」注記 |
| `docs/spec/04-templates.md:215` | `### conflict-resolution.md フォーマット（廃止: T028）` 節タイトル | (a) 「廃止 (T028)」注記 |
| `docs/spec/04-templates.md:217` | `**廃止 (T028):** Step 8-5（…）が廃止された…` 本文 | (a) 「廃止 (T028)」注記 |
| `docs/spec/16-worktree-archive.md:241` | `remove <taskRunId> [--delete-branch]` | (b) 別機能（worktree archive）— **触らない** |
| `docs/spec/16-worktree-archive.md:290` | `elevens worktree archive prune --older-than 30d --yes --delete-branches` | (b) 別機能（worktree archive）— **触らない** |

すべて (a) 「廃止 (T028)」注記または新仕様の明示記述、または (b) `docs/spec/16-worktree-archive.md` の worktree archive 機能（plan.md §4.4 リスク表で明示的に除外）に該当。**残骸 0** を確認。

追加で `8-3` / `8-4` / `8-5` / `8-6` の grep も実施し、すべて「廃止 (T028)」注記（`docs/spec/04-templates.md` L211 / L217）内の言及であることを確認した。

## 判断した点・懸念

### 判断したこと

1. **`docs/spec/04-templates.md` を touch した**: タスク本文「修正は `commands/` と `skills/cmux-team/templates/` のみで完結する想定」に対する例外として、完了条件「衝突解消経路に『自動 Edit』『自動 rebase 続行』が残っていない」を厳守するため、spec の dangling 記述を「廃止 (T028)」注記で塞いだ。フル削除はせず歴史保存。理由は A034 §「比較・分析 → docs/spec/04-templates.md を touch した理由」に記録
2. **conflict-resolution.md フォーマット節は本文を残した**: 節タイトルと冒頭注記で「廃止 (T028)」を明示し、本文（旧 T284 当時のフォーマット）は歴史資料として残置。完全削除するかは将来別タスクで判断
3. **`docs/spec/16-worktree-archive.md` は触らない**: plan.md §4.4 リスク表に従い、worktree archive 機能の `--delete-branch` / `--delete-branches` フラグは独立した別系統として残す。`commands/watch.md` 末尾の cleanup 方針メモにこの区別を明記して読者の混乱を防止
4. **新 8-3 の `failure_mode`**: 旧 6 値（`spec_divergence` / `test_failed` / `tsc_failed` / `missing_context` / `scope_violation` / `iteration_limit`）を `rebase_conflict` の単一値に集約。判断必要レポートに添える情報は最小限（衝突ファイル一覧 + ORIG_HEAD..HEAD commit list + 衝突元 task ID）に絞り、ファイルごとの diff dump は report 添付しない（worktree に残るため `git diff` で人間が見れば足りる）

### 懸念

1. **branch 累積**: `--delete-branch` を外したぶん、merge 後の feature branch が remote / local に累積する。短期的には個別に `git push origin --delete <branch>` で掃除する想定。中長期的には `cmux-team archive prune` 系の整備が別タスクとして必要（A034 §残課題に記載）
2. **compass-wind 99e23a6e の復旧**: 本リポジトリ管轄外。別 prototype repo で `git log --all --format=%H | grep -i 99e23a6e` 等の確認手順は A034 に記載したが、実際の復旧作業は本タスクの scope 外
3. **TypeScript daemon コード変更なし**: `task_completed_state_mismatch` / `conductor_done_unresolved` / `judgment_pending` 等の event は既存実装で発火するため新規 TS コード変更は不要だが、新 `failure_mode=rebase_conflict` の値が daemon 側で特別扱いを受けないこと（plain text reason として manager.log に出るだけ）の確認は実機 smoke で別途行う必要あり
4. **bun test 全体実行は行っていない**: 本タスクは template / commands / docs / artifact のみの修正で TS code を一切触っていないため、CLAUDE.md「`bun test` 全体実行禁忌」「tsc 不要」の制約に従い test は実行していない。Inspector フェーズで grep ベースの structural check に倒すべき
