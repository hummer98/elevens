# タスク割り当て

## タスク内容

---
id: 020
title: team-task コマンドの新規作成手順を現行 create-task CLI に整合させる
priority: high
created_by: surface:29
created_at: 2026-05-23T22:05:54.630Z
---

## タスク
## 背景・症状

cross-project の surface（観測例: surface:99）で `/team-task` の新規作成を実行すると、
**ダミーのタスクを発行してから `update-task` で本文を埋める2段階**になっている。
原因は `commands/team-task.md` の「操作: 新規作成」手順が古く、現行の
`elevens create-task`（ID 自動採番・ファイル自動生成・frontmatter 自動生成・`.team/tasks/` 直接書き込みは hook block）
と矛盾しているため。ID 発番に関する誤解を誘発している。

## 矛盾点（commands/team-task.md「操作: 新規作成」）

| 行 | 指示内容 | 現行 CLI の実態 | 問題 |
|---|---|---|---|
| L54-59 | `ls .team/tasks/ \| grep -oE '^[0-9]+' \| sort -n \| tail -1` で**最大 ID を手動計算して +1** | `elevens create-task` が **ID を自動採番** | 手動発番は不要。「自分で決めた NNN」と実採番のズレを生み、ID 確定のために一度作る動機になる |
| L68-90 | `.team/tasks/NNN-<slug>.md` に **frontmatter テンプレを直接 Write** | `.team/tasks/` 直接書き込みは **hook でブロック**、かつ create-task がファイル自動生成 | 直接 Write は失敗 or 二重生成 |
| L77 | `raised_by: conductor` 等を手書き | frontmatter は create-task が生成 | 手書き前提が残存 |
| L92-93 | 「status を含めない」「task-state.json で管理」 | create-task / update-task が管理 | CLI ベースと未整合 |
| L99 | 最後にようやく「`elevens create-task --title <title> --priority <p> --status draft` を使用」 | これが唯一の正解 | `--body` の渡し方が手順に書かれていない |

## なぜ「ダミー発行 → update」になるか（因果）

1. L54-59 で「自分で ID を決めたい」が create-task は別 ID を振り得る
2. L68-90 の Context/Options/Recommendation 構造の本文を作りたいが、`--body` での渡し方が手順にない（L92-93 は frontmatter 手書き前提）

→ 結果、`create-task --title`（or ダミー body）でまず枠を作って実 ID を確定 →
`update-task --task-id NNN --body "..."` で本文を埋める2段階に陥る。観測挙動と一致。

## 修正内容

`commands/team-task.md` の「操作: 新規作成」を現行 CLI に合わせて書き換える:

- **L54-59 の手動 ID 発番を削除**（自動採番に委ねる旨に置換）
- **L68-93 の直接 Write テンプレ／frontmatter 手書き記述を削除**し、`elevens create-task` 1コマンドで本文構造を `--body` で渡す例に置換。例:
  ```bash
  elevens create-task --title "<title>" --priority <p> --status draft --body "$(cat <<'INNER'
  ## Context
  ...
  ## Options
  ...
  ## Recommendation
  ...
  INNER
  )"
  ```
  （※ヒアドキュメントのネスト表記はテンプレ内で実際に動く形に調整すること）
- **type / raised_by 等の扱いを現行 create-task のフラグ・自動生成に合わせて整理**（create-task が受けないフィールドは記述から落とす。create-task の --help を確認して実在フラグのみ案内）
- **list（L22-46）/ close（L106-124, 既に CLI）/ show（L128-141）も現行仕様と齟齬がないか点検**し、ズレていれば合わせる
- 「draft で作成 → 確認 → update-task --status ready」の標準フローへの導線を明示

## 検証

- 修正後の team-task.md の手順どおりに**実際に1コマンドで** draft タスクが作れること（ダミー→update の2段階が発生しないこと）を確認
- `elevens create-task --help` の実在フラグと手順内の記述が一致していること
- list / close / show の各手順が現行 CLI / 出力と整合していること

## 参考 file:line

- `commands/team-task.md`（新規作成 L50-104 が主対象、list L22-46 / close L106-124 / show L128-141）
- `CLAUDE.md`「タスクの作成・更新は CLI 経由（直接ファイル操作禁止）」節（`.team/tasks/` 直接 Write は hook block の根拠）
- `skills/cmux-team/manager/main.ts` `cmdCreateTask`（L4342〜）/ `cmdUpdateTask`（L4433〜）— 実在フラグの確認元


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-020-1779573954` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-020-1779573954
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-020-1779573954/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/020-team-task-create-task-cli/runs/task-020-1779573954
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/020-team-task-create-task-cli/runs/task-020-1779573954/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


