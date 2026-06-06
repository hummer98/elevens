# Summary: T028 — /elevens:watch + Conductor 自動 rebase の commit drop 対策

## 完了したサブタスク

1. **`commands/watch.md` Step 2 から `--delete-branch` を除去** — `gh pr merge --squash "$PR_URL"` に変更。feature branch を残すことで squash 後も `git log --all` / `git branch -a` から元 commit を追える状態にした。理由を行内注記、cleanup 方針メモを本文末（Branch cleanup 方針メモ節）に追加
2. **`commands/watch.md` Step 3 を escalate に格上げ** — Edit による自動衝突解消を全廃。conflict 検出時点で `git merge --abort` / `git rebase --abort` で中断し `[escalation]` を user に出して停止する経路に統一
3. **`skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8 の自動衝突解消を escalate に倒す** — 旧 8-3（semantic resolution）/ 8-4（検証）/ 8-5（conflict-resolution.md 書き出し）/ 8-6（escalation）を全廃し、新 8-1（情報収集・Edit 禁止）→ 8-2（rollback）→ 8-3（`failure_mode=rebase_conflict` の判断必要レポート）の 3 ステップに圧縮。en/ja を 1:1 同期
4. **post-mortem artifact 作成** — `.team/artifacts/A034-watch-commit-drop-postmortem.md`（type: research）。T181 compass-wind 99e23a6e drop の経路推定（A/B/C）、Manager log 対応、構造変更、残課題を記録
5. **`docs/spec/04-templates.md` の dangling spec 始末** — 旧 Step 8 semantic resolution 段落と conflict-resolution.md フォーマット節に「廃止 (T028)」注記を追加（本文は歴史保存）。touch した理由は A034 に記載

## 変更ファイル一覧

- `commands/watch.md`（Step 2/3 + 設計方針節 + cleanup メモ）
- `skills/cmux-team/templates/ja/conductor-role.md`（Step 8 統合）
- `skills/cmux-team/templates/en/conductor-role.md`（Step 8 統合、ja と同期）
- `docs/spec/04-templates.md`（廃止注記）
- `.team/artifacts/A034-watch-commit-drop-postmortem.md`（新規 artifact）

※ package-lock.json はバージョン bump（0.8.2→0.10.0）のみで本タスクと無関係のため commit から除外

## 検品結果

Inspector 判定: **GO**（観点 A〜E すべて充足、Fix Required なし）

- A. 完了条件: 充足（3 ファイル修正 + 新フロー差し替え確認）
- B. en/ja 同期: 充足（Step 8 が 1:1 対応）
- C. dangling 参照 / 整合性: 充足（廃止済シンボルへの dangling 0）
- D. 残骸 grep: 残骸 0（ヒットはすべて新仕様明示 or 廃止注記内の歴史記述）
- E. artifact 品質: 充足（frontmatter / 章立て完備）

## 納品

ローカル ff-only merge で main に取り込み（後段で merge SHA を記録）
