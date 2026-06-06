# Inspection: Task 020 — commands/team-task.md 書き換え

**判定: GO**

Implementer の `commands/team-task.md` 修正は plan §3〜§7 / §10 DoD を実質的に満たしており、本 PR としてマージ可能。
heredoc 終端のインデント問題 1 点を Minor として後述するが、これは GO を妨げない（elevens の `commands/*.md` は Claude が解釈実行する前提であり、現状の運用に実害無し）。

---

## チェックリスト結果（plan §10 DoD ベース）

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | 変更が `commands/team-task.md` 1 ファイルに閉じている | ✓ | `git status` で `modified: commands/team-task.md` のみ。CLI 実装・他テンプレへの波及なし |
| 2 | 「操作: 新規作成」が 1 コマンド完結（ダミー → update 2 段階を誘発しない） | ✓ | L67–86 で `elevens create-task --title --priority --status draft --body "..."` の単発呼び出しに統合済み |
| 3 | 手動 ID 発番ブロック（`ls ... \| grep -oE \| sort \| tail -1`）削除 | ✓ | 旧 L52–59 のブロックが完全に消滅。L94 で「CLI が自動採番」と明示 |
| 4 | `.team/tasks/NNN-<slug>.md` への直接 Write 手順・手書き frontmatter 削除 | ✓ | 旧 L68–90 のテンプレ frontmatter (id/title/type/raised_by/created_at) が消滅。L96 / L117 で「直接 Write は hook block」「frontmatter 手書き禁止」が NG パターンとして明記 |
| 5 | create-task が受けないフィールド（`type` / `raised_by`）の記述なし | ✓ | 全文 `grep -E 'type:\|raised_by'` でヒット 0。旧 L33/L41 の「タイプ」列も L34/L41 で「優先度」に置換、`起票者` 列も「起票元 (`created_by`)」に変更 |
| 6 | 記述されている全フラグが `elevens <cmd> --help` に実在 | ✓ | `elevens create-task --help` / `update-task --help` / `close-task --help` で確認。team-task.md 内のフラグ (`--title` `--body` `--priority` `--status` `--task-id` `--deliverable-kind` `--merged-into` `--merge-sha` `--journal`) はすべて実在 |
| 7 | 「操作: 一覧表示」が `タイプ` 列削除・`created_by`(surface 形式)・ディレクトリ形式 task.md 走査に追従 | ✓ | L26「`.team/tasks/<NNN-slug>/task.md` を読む」、L34–37 / L41–43 のサンプル表で「優先度」「起票元 (`created_by`)」「surface:200」等を反映 |
| 8 | 「操作: クローズ」が `--deliverable-kind` 必須に対応 | ✓ | L138–139 で必須を明記、L142–149 で `merged` / `none` の両例。L152–153 で「ショートカット時は最低限 `--deliverable-kind none --journal "closed by user"`」を案内 |
| 9 | 「操作: 詳細表示」が `.team/tasks/<NNN-slug>/task.md` 直読みに追従 | ✓ | L174–176 で「ディレクトリ内の `task.md`」と明示、L178–182 で `DIR=$(ls ... grep) ; cat .team/tasks/$DIR/task.md ; jq` の具体例 |
| 10 | 「draft → 確認 → update-task --status ready」の標準フロー導線 | ✓ | L108–113 の「### status について」で `update-task --status ready` または `create-task --status ready` 経路を案内、sync state check の参照あり |
| 11 | plan §9 想定外スコープに手を出していない | ✓ | list-tasks/show-task CLI 新設なし、`elevens --help` トップ行 (`close-task` summary) 修正なし、sub-agent template 改変なし。`git status` でも他ファイル変更なし |

### Minor（GO を妨げない）

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| 12 | `--body` の heredoc 例の構文整合（コピペで動く形か） | △ | L74–84 の `<<'BODY' ... BODY` がリスト項目 3 (3 スペースインデント) 内のコードブロックに置かれているため、ターミネータ `BODY` も 3 スペースインデントされる。`bash` heredoc は `<<-` ではないので先頭スペースを許容しない。実機検証で `bash: 警告: ヒアドキュメントの 4 行目でファイル終了 (EOF) に達しました (\`BODY' が必要)` を再現。**ただし** elevens の `commands/*.md` は Claude が解釈実行する前提であり (`skills/cmux-team/templates/ja/master.md` 等は heredoc を使わず単純な `--body "..."` 形式)、純粋 bash コピペ用途は想定されていない。L100–102 で `<<'BODY'` の変数展開仕様に触れる注記もあるため、運用上の支障は薄い |

---

## 既知の前提（NOGO 理由から除外）

- 検証用 draft タスク `022-verify-team-task-rewrite` の物理ディレクトリ残存は delete-task の標準挙動でありスコープ外。確認不要。

---

## Minor Improvement Suggestions（次回イテレーションの改善候補）

GO を妨げないが、次回触る機会があれば検討する余地のある点:

### M1. heredoc 終端のインデント問題（前述 #12）

**現状**: L74–84 の `<<'BODY' ... BODY` がリスト項目内コードブロックで 3 スペースインデントされており、純粋 bash コピペでは終端しない。

**選択肢**（軽い順）:

1. **そのまま据え置き + 注記**: 現行の L100–102 注記の末尾に「終端 `BODY` は行頭に来る必要があるため、Claude が解釈・実行する想定。bash で直接実行する場合は事前にインデントを除去すること」と 1 行追記。最小変更。
2. **master.md 等のスタイルに合わせ heredoc を使わない**: `elevens create-task --title "$TITLE" --priority "$PRIORITY" --status draft --body "<本文を組み立てて渡す>"` のように heredoc を撤去し、本文構築は Claude の裁量に任せる。`skills/cmux-team/templates/ja/master.md` の `elevens create-task --title "タスク名" --priority high --body "タスクの詳細"` と完全に揃う。
3. **リスト項目から外して左寄せの独立コードブロックに移す**: L67 の「3. **タスク作成（1 コマンド）**」直後で改行 → コードブロックをトップレベルに置く。markdown ソース上のインデントが 0 になるためコピペで動く。ただし「ステップ 3 の説明」と「コードブロック」が視覚的に離れる。

**推奨**: 案 2（master.md スタイル統一）。`commands/*.md` 群の記法を 1 つに揃えると、利用者・LLM 双方の解釈ブレが減る。

### M2. L100–102 の `<<BODY` 切替指示は若干冗長

「`<<'BODY'` （単一引用符付き）」と「`<<BODY` （引用符無し）」の切替について 3 行を割いている。M1 案 2 を採れば本ブロックごと撤去可能。Minor。

### M3. L186–190 の「前提チェック」セクションは古い形のまま残存（スコープ外）

「.team/tasks/ ディレクトリが存在すること（なければ作成）」とあるが、現行は `elevens create-task` がディレクトリ作成も内包する。今回 scope 外として手をつけていないのは正解。次回 cleanup の機会に併せて検討すれば足りる。

---

## 検証ログ

```
$ git status -s
 M commands/team-task.md

$ elevens create-task --help | grep -E -- '^  --'
  --title <title>         タスクタイトル（必須）
  --body <text>           タスク本文（任意）
  --priority <priority>   優先度: high / medium / low（任意、デフォルト medium）
  --status <status>       初期ステータス: draft / ready（任意、デフォルト draft）
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
  --base-branch <branch>  マージ先ブランチ（任意、デフォルト: 指定なし → main にマージ）
  --run-after-all         全通常タスク完了後に実行（任意）
  --exclusive             排他実行: ...
  --force                 ready 昇格時の sync state チェックをバイパス（注意して使用）
  --skip-fetch            sync state チェック前の 'git fetch' を省略
  --no-auto-pull          behind-ff + <mainBranch> checkout 時の自動 'git pull --ff-only' を抑止

$ elevens close-task --help | grep -E -- '^  --'
  --task-id <id>                  タスク ID（必須）
  --deliverable-kind <kind>       納品方式（必須。files / merged / pr / none のいずれか）
  --deliverable <path>            ファイルパス（kind=files のとき 1 件以上必須。複数指定可）
  --merged-into <branch>          マージ先ブランチ名（kind=merged で必須）
  --merge-sha <sha>               マージコミット SHA（kind=merged で必須）
  --pr-url <url>                  Pull Request URL（kind=pr で必須）
  --journal <text>                完了ジャーナル（任意）
  --force                         assigned（実行中）タスクを強制クローズ

$ bash -c '
> echo "$(cat <<'\''BODY'\''
>    ## Context
>    $CONTEXT
>    BODY
>    )"
> '
bash: 行 8: 警告: ヒアドキュメントの 4 行目でファイル終了 (EOF) に達しました (`BODY' が必要)
bash: -c: 行 9: 対応する `)' を探索中に予期せずファイルが終了しました (EOF)
rc=2
```

heredoc コピペ問題は実機で再現確認したが、運用は LLM 経由のため GO を妨げない。

---

**最終判定: GO**
