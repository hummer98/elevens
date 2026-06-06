# Summary: Task 020 — team-task コマンドの新規作成手順を現行 create-task CLI に整合

## 完了したサブタスク

- Phase 1 (Planner): 現行 CLI を一次情報（`--help` / `main.ts`）で確認し実装計画 plan.md を作成
- Phase 3 (Implementer): commands/team-task.md を現行 create-task CLI に整合させ書き換え
- Phase 3 修正: heredoc 終端 `BODY` を行頭に出し bash で正しく終端する形に修正
- Phase 4 (Inspector): GO 判定（DoD 11 項目すべて ✓、heredoc は Minor #12 として指摘 → 修正済み）

## 変更ファイル

- `commands/team-task.md`（1 ファイルのみ、+103 / -57）

## 主な変更点

- 「操作: 新規作成」: 手動 ID 発番ブロック・直接 Write テンプレ・手書き frontmatter を削除し、
  `elevens create-task --title --priority --status draft --body "$(cat <<'BODY' ... BODY)"` の
  **1 コマンド完結**手順に統合（ダミー発行 → update-task の 2 段階を撲滅）
- heredoc 終端をリスト項目インデント外（行頭）に配置し、bash でコピペ実行しても終端するよう修正
- create-task が受けないフィールド（`type` / `raised_by`）の記述を全削除
- 「操作: 一覧表示」: 表ヘッダから `タイプ` 列削除、`起票者`→`起票元 (created_by)`（surface 形式）、
  走査対象を `.team/tasks/<NNN-slug>/task.md` ディレクトリ形式に追従
- 「操作: クローズ」: `--deliverable-kind` 必須に対応（merged / none の例、ショートカット時の最小形を明記）
- 「操作: 詳細表示」: `.team/tasks/<NNN-slug>/task.md` 直読み + task-state.json 突合の具体例に修正
- NG パターン・「draft → 確認 → update-task --status ready」標準フロー導線を追加

## 検証結果

- 修正後の heredoc を抽出し `bash -n` で構文チェック → SYNTAX_OK（終端する）
- `<<'BODY'`（単一引用符）で変数 literal 保持 → 本文の注記（`<<BODY` 切替案内）と整合
- 記述フラグはすべて `elevens create-task / update-task / close-task --help` の実在フラグ
- 検証用 draft タスク（022 / 023）は `elevens delete-task` で掃除済み（task-state.json 上 deleted）
- 変更は commands/team-task.md 1 ファイルに閉じる（CLI 実装・他テンプレへの波及なし）
- ドキュメント（.md）変更のみのため tsc / bun test 対象外

## 想定外スコープ（今回は触らず）

- `elevens --help` トップレベルの close-task サマリ行が `--deliverable-kind` 必須を反映していない件 → 別タスク
- list-tasks / show-task CLI の新設 → 別タスク（現状は task.md 直読みで継続）

## 納品

- マージコミット: `8ad3031dc052522622f8ec006834b8141365686a` (main に ff-only マージ)
