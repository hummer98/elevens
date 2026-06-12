# タスク割り当て

## タスク内容

{{TASK_CONTENT}}

## 完了条件の扱い

タスク内容に「完了条件」セクションがある場合、以下を守ること:

- close-task（conductor-role.md Step 11）の**前に**、完了条件の各項目を実際に検証する
  （テストの実行、成果物パスの存在確認等。「やったはず」で済ませない）
- 検証の証明（実行したコマンドと結果の要点）を `{{OUTPUT_DIR}}/summary.md` に記録する
  （conductor-role.md Step 3 のサマリー書き出しに含める）
- 完了条件に不変制約（やってはいけないこと）が含まれる場合、違反していないことも確認する
- 条件を満たせない場合は、満たせない理由を summary.md に明記し、
  conductor-role.md の判断必要レポート経路（`--success false`）を検討する

タスク内容に完了条件セクションが無い場合、この節は無視してよい（従来どおりの完了処理を行う）。

## 作業ディレクトリ

すべての作業は git worktree `{{WORKTREE_PATH}}` 内で行う。
```bash
cd {{WORKTREE_PATH}}
```
{{MAIN_BRANCH}} ブランチに直接変更を加えてはならない。

ブランチ名: `{{CONDUCTOR_ID}}/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
{{OUTPUT_DIR}}
```

結果サマリーは `{{OUTPUT_DIR}}/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `{{BASE_BRANCH}}` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。

{{ARCHIVED_WORKTREE_SECTION}}
