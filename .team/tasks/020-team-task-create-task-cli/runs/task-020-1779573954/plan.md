# Plan: commands/team-task.md を現行 `elevens create-task` CLI に合わせて書き換え

> Task 020 — `/team-task create` を「1 コマンドで draft 作成」に揃え、ダミー発行 → update-task の 2 段階を撲滅する。

---

## 0. スコープ確認

- 対象ファイル: `commands/team-task.md`（149 行）
- 触らないもの: `elevens create-task` / `update-task` / `close-task` の CLI 実装、`createTaskProgrammatic` の挙動、`.team/tasks/` のディレクトリ形式
- 触るもの: `commands/team-task.md` の「操作: 新規作成」「操作: 一覧表示」「操作: クローズ」「操作: 詳細表示」の各セクション本文と、それに付随する frontmatter サンプル・ヘッダ表
- 完了条件: 修正後の手順どおりに `/team-task create <title>` を実行すれば、対話的に集めた内容を 1 回の `elevens create-task` で draft タスクとして作り終え、`update-task` を追加で呼ばずに済むこと

---

## 1. 現状分析 — `commands/team-task.md` の齟齬リスト

| 行 | 現記述 | 現行 CLI / 実装の実態 | 判定 |
|---|---|---|---|
| L33–44（一覧表）| `タイプ` 列（`decision / blocker / finding / question`）と `起票者` 列 | `createTaskProgrammatic` が書く frontmatter に `type` フィールドは無い（似た意味の `kind` はあるが任意・空が既定）。`raised_by` も無く `created_by` (surface ID) に置き換わっている | **要修正**: 表ヘッダ・例示の列名を実フィールドに合わせる |
| L52–59 | `ls .team/tasks/ 2>/dev/null \| grep -oE '^[0-9]+' \| sort -n \| tail -1` で次番号を手動計算 | `createTaskProgrammatic` 内で `String(maxId + 1).padStart(3, "0")` 自動採番（`task.ts:916–925`） | **要修正**: ブロックごと削除 |
| L61–66 | 対話で「タイプ: decision / blocker / finding / question」を収集 | frontmatter に該当フィールドが存在しない（保存されない） | **要修正**: 削除、または「`kind` を使うなら `--kind` フラグで指定」と案内 |
| L68–93 | `.team/tasks/NNN-<slug>.md` を Write でテンプレ書き込み（id / title / type / raised_by / created_at を手書き）、status は含めないと注記 | `.team/tasks/` への直接 write は hook で block。実ファイルパスは `.team/tasks/NNN-<slug>/task.md`（ディレクトリ形式）。frontmatter は CLI が自動生成（id / title / priority / created_at + 必要に応じ base_branch / run_after_all / exclusive / depends_on / kind / created_by / epic_id） | **要修正**: ブロックごと削除 |
| L99 | 「`elevens create-task --title <title> --priority <p> --status draft` を使用」 | 唯一の正解。ただし `--body` の渡し方は書かれておらず、本文を埋める手段が示されない | **要修正**: `--body` を含む完全な実行例に差し替え |
| L112 / L134 | `ls .team/tasks/ \| grep "^$ID"` でタスクを検索 | `.team/tasks/<NNN-slug>/task.md` のディレクトリ形式に変わっているため、ディレクトリ名にヒットしても本文は中の `task.md` を読まないと表示できない | **要修正**: ディレクトリ形式に追従させる |
| L118–121 | `elevens close-task --task-id $ID --journal "closed by user"` | 現行 `close-task` は `--deliverable-kind <kind>` が必須。指定なしで呼ぶと exit 1（`elevens close-task --help` 参照） | **要修正**: 最低限の例として `--deliverable-kind none` を含む形に直す |
| L141 | 「ファイルの全内容を読み込み、`task-state.json` の状態と合わせて整形表示」 | 内容は妥当だが、ファイルパスがディレクトリ形式に変更済み | **要修正**: 読み出し対象を `task.md` に明示 |

---

## 2. 確認済み実在フラグ一覧（一次情報: `elevens <cmd> --help` + `main.ts:4342–`, `task.ts:849–`）

### 2.1 `elevens create-task`

| フラグ | 値域 | 既定 | 備考 |
|---|---|---|---|
| `--title <title>` | 任意文字列 | — | **必須** |
| `--body <text>` | 任意文字列（複数行可）| `""` | frontmatter の後に `## タスク内容\n<body>\n` として埋め込まれる（i18n header は `t("task_section_header")`） |
| `--priority <p>` | `high` / `medium` / `low` | `medium` | |
| `--status <s>` | `draft` / `ready` | `draft` | `ready` で起票すると即 `TASK_CREATED` 送信 + sync state check 走行 |
| `--depends-on <ids>` | カンマ区切り ID（例 `"081,082"`）| `[]` | 未存在 ID は即 reject |
| `--base-branch <branch>` | branch 名 | 未指定 = main | |
| `--run-after-all` | flag | off | 1 件のみ存在可（既存 run_after_all 未クローズだと `RUN_AFTER_ALL_CONFLICT`） |
| `--exclusive` | flag | off | `--run-after-all` を暗黙に含む。`--exclusive` 同士は ID 順に順次排他実行 |
| `--force` | flag | off | ready 昇格時 sync state check を bypass |
| `--skip-fetch` | flag | off | sync check 前の `git fetch` を省略 |
| `--no-auto-pull` | flag | off | behind-ff + mainBranch checkout 時の自動 `git pull --ff-only` を抑止 |
| 共通: `--project-root <path>` / `--project-root-confirm` | — | — | cross-project write gate |

**自動生成される frontmatter**（手書き不要・むしろ書いてはいけない）:
`id` / `title` / `priority` / `created_at` + 必要に応じて `base_branch` / `run_after_all` / `exclusive` / `depends_on` / `kind` / `created_by`（`CMUX_SURFACE` 環境変数から自動取得）/ `epic_id`。

**現行 frontmatter に存在しないフィールド**（=`team-task.md` から記述を落とすべき）:
`type`（decision / blocker / finding / question）, `raised_by`。

**実ファイルパス**: `.team/tasks/<NNN-slug>/task.md`（ディレクトリ形式）。`stdout` に `TASK_ID=NNN FILE=.team/tasks/<NNN-slug>/task.md` を返す（パース可能）。

> 注: `--kind <kind>` フラグは `create-task` 実装内で受け付けるが（`main.ts:4355`）、`--help` には未掲載で UI 上は隠し相当。今回の team-task.md 修正では基本的に触れず、必要なら「内部用」と一行注記する程度に留める。

### 2.2 `elevens update-task`

| フラグ | 必須 | 備考 |
|---|---|---|
| `--task-id <id>` | ✓ | slug / ディレクトリ名でも canonical id に解決される |
| `--status <s>` | △ | `ready` 遷移時に sync state check |
| `--title <title>` | △ | frontmatter の `title:` を置換 |
| `--body <text>` | △ | frontmatter 以降の本文をまるごと差し替え |
| `--depends-on <ids>` | △ | |
| `--no-exclusive` | △ | `exclusive: true` / `run_after_all: true` 行を除去 |
| `--force` / `--skip-fetch` / `--no-auto-pull` | — | create-task と同様 |

少なくとも 1 つの更新フラグが必須。`assigned` / `closed` のタスクは update 不可（assigned は abort-task → 新規作成、closed は新規作成）。

### 2.3 `elevens close-task`

| フラグ | 必須 | 備考 |
|---|---|---|
| `--task-id <id>` | ✓ | |
| `--deliverable-kind <kind>` | ✓ | `files` / `merged` / `pr` / `none` のいずれか。**未指定は exit 1** |
| `--deliverable <path>` | kind=files で必須（複数指定可） | |
| `--merged-into <branch>` / `--merge-sha <sha>` | kind=merged で両方必須 | |
| `--pr-url <url>` | kind=pr で必須 | |
| `--journal <text>` | △ | |
| `--force` | △ | `assigned` 実行中タスクの強制クローズ |

> `commands/team-task.md` 内の close 例は最低限 `--deliverable-kind none` を含めないと動かない。

### 2.4 一覧 / 詳細用 CLI の有無

`elevens list-tasks` / `elevens show-task` / `elevens tasks` はいずれも未実装（`elevens --help` 出力 / `main.ts` grep で確認）。
従って `/team-task` の「一覧」「詳細」は引き続き `.team/tasks/<NNN-slug>/task.md` の直接読み + `.team/task-state.json` 突合で実装する以外にない。これは現状維持（=今回の修正で list/show 用の新 CLI を要求しない）。

### 2.5 関連: `elevens delete-task`

検証で作った draft の掃除に使う。`draft` / `ready` は `--force` 無しで delete 可（`closed` / `aborted` は `--force` 必要、`assigned` は不可）。
書式: `elevens delete-task --task-id <id> [--journal <text>]`。

---

## 3. 「操作: 新規作成」セクション 書き換え案（L50–104 を以下で置換）

> 設計指針: ID 発番・frontmatter 生成・ファイル配置は CLI に完全委譲し、`/team-task` がやることは **(a) 引数から title を取る、(b) 対話で本文用テキストを集める、(c) 1 回の `elevens create-task --body` で投げる、(d) 結果を表示する** に絞る。

### 3.1 置換後の本文（案）

```markdown
## 操作: 新規作成

### 手順

1. **タイトルの確定**

   `$ARGUMENTS` の "create " 以降、またはショートハンド時は `$ARGUMENTS` 全体をタイトルとして使う。

2. **本文の収集（対話）**

   以下を順に聞き取り、Context / Options / Recommendation を組み立てる。
   いずれも空欄可。空欄ならそのセクションを省略する。

   - **コンテキスト**: 背景（1–2 文）
   - **選択肢**: 検討中のオプション（複数あればリスト）
   - **推奨案**: あれば

3. **タスク作成（1 コマンド）**

   ```bash
   elevens create-task \
     --title "$TITLE" \
     --priority "$PRIORITY" \
     --status draft \
     --body "$(cat <<'BODY'
   ## Context
   $CONTEXT

   ## Options
   1. $OPTION_A
   2. $OPTION_B

   ## Recommendation
   $RECOMMENDATION
   BODY
   )"
   ```

   出力例:

   ```
   TASK_ID=042 FILE=.team/tasks/042-<slug>/task.md
   ```

   - ID は CLI が自動採番する（`.team/tasks/` 直下を走査し最大 ID + 1）。
   - frontmatter（`id` / `title` / `priority` / `created_at` / `created_by`）は CLI が自動生成する。
     **手書きで `.team/tasks/` にファイルを書いてはいけない**（hook で block される）。
   - `--priority` 既定は `medium`。`high` / `low` を選びたければ対話で確認。
   - `$ARGUMENTS` から本文を直接渡したい・対話を省きたい場合は `--body` を空にしてよい
     （あとから `elevens update-task --task-id NNN --body "..."` で埋める）。

4. **作成確認**

   `cat .team/tasks/<NNN-slug>/task.md` で内容を表示。

### status について

- `draft` — 既定。Manager は無視する（ユーザー確認待ち）。
- `ready` — 着手 OK。`update-task --status ready` または `create-task --status ready` で遷移。
  `ready` 遷移時は local と `origin/<mainBranch>` の sync state check が走る
  （diverged / uncommitted / detached は reject。詳細は CLAUDE.md「Ready 昇格時の sync state ガード」）。

### NG パターン

- ❌ `.team/tasks/NNN-<slug>.md` を Write で直接作る → hook block で失敗
- ❌ 自前で ID を採番する → 自動採番と競合し得る
- ❌ frontmatter を手書きする → `created_at` / `created_by` などの自動生成と二重になる
- ❌ `--body` 抜きで create-task → 枠だけのタスクができ、後で update-task が必要（=ダミー発行 2 段階）
```

### 3.2 ヒアドキュメントが nested で正しく閉じる検証ポイント

- 外側の bash コードブロックは ```` ```bash ... ``` ```` で囲む。内側のヒアドキュメント終端 `BODY` は行頭・前後空白なしで配置する。
- 引用符付き delimiter (`<<'BODY'`) を使い、`$VARIABLE` を展開するか否かをスキル側で決められるようにする
  （今回の例は呼び出し前に `$TITLE` / `$CONTEXT` 等が既に展開されている前提のためダブルクォート外、シェル変数を入れたまま渡すなら `<<'BODY'` のシングルクォート版に変える）。
- 実装上は `/team-task` 内の bash で `printf` / 一時ファイル経由でも等価。要点は **「`create-task` を 1 回しか呼ばないこと」**。

---

## 4. 「操作: 一覧表示」セクション 修正案（L22–46）

- 表ヘッダから `タイプ` 列を削除（frontmatter に該当フィールドが無い）。
- `起票者` 列の例示値を `architect` / `implementer-1` のような role 文字列ではなく `surface:NNN` 形式（実 `created_by` の値）に差し替える。
  必要なら列名も「起票元 (`created_by`)」に明示。
- 例示の `ID` カラム値は現行と同じ 3 桁 0 詰めでよい。
- 「タスクが 0 件の場合: 『オープンタスクはありません』」はそのまま。

修正後の例（イメージ）:

```
## オープンタスク (N件)

| ID  | タイトル                  | 優先度 | ステータス | 起票元       | 作成日     |
|-----|--------------------------|--------|-----------|--------------|-----------|
| 001 | 認証トークンの有効期限設計 | medium | ready     | surface:200  | 2026-03-19 |
| 002 | DB接続のタイムアウト      | high   | draft     | surface:201  | 2026-03-19 |
```

手順 1 は「`.team/tasks/<NNN-slug>/task.md` を走査する」に明示（ディレクトリ形式に追従）。

---

## 5. 「操作: クローズ」セクション 修正案（L106–124）

- 手順 1 の検索: `ls .team/tasks/ | grep "^$ID"` でディレクトリ名を取得（変更なし、ディレクトリ形式でもヒットする）。
- 手順 3 の CLI 呼び出しを `--deliverable-kind` 必須に対応:

```bash
# ローカル ff-only マージで完了したケース
elevens close-task --task-id $ID --deliverable-kind merged \
  --merged-into <branch> --merge-sha <sha> \
  --journal "<完了理由>"

# 納品物なしで閉じるケース（例: 既に他タスクで充足、調査のみで成果物なし）
elevens close-task --task-id $ID --deliverable-kind none \
  --journal "<完了理由>"
```

- 「`/team-task close <id>` のショートカットで投げるなら、最低限 `--deliverable-kind none --journal "closed by user"` を補う」と注記する。
- 詳細フラグの組み合わせは `elevens close-task --help` を参照、と一行案内。

---

## 6. 「操作: 詳細表示」セクション 修正案（L128–141）

- 手順 1: `ls .team/tasks/ | grep "^$ID"` でディレクトリ名（例 `020-team-task-create-task-cli`）を取得。
- 手順 3: 「ディレクトリ内の `task.md` を読む」と明示:

```bash
DIR=$(ls .team/tasks/ | grep "^$ID")
cat ".team/tasks/$DIR/task.md"
```

- `task-state.json` の `status` / `assigned_to` 等と組み合わせて整形表示する点は現行どおり。

---

## 7. 削除対象の特定（修正コミットで落とす行範囲）

| 行範囲 | 内容 | 削除理由 |
|---|---|---|
| L54–59 | 「次のタスク番号を決定」`ls ... | tail -1` ブロック | 自動採番に委ねる |
| L61–66 のうち「タイプ」項 | 対話で type を聞き出す指示 | frontmatter に該当フィールドが無い |
| L68–90 | `.team/tasks/NNN-<slug>.md` を Write する手順とテンプレ frontmatter（id/title/type/raised_by/created_at の手書き例）| 直接 write は hook block、frontmatter は CLI 自動生成 |
| L92–93 | 「タスクファイルには status を含めない（…）。status は `task-state.json` で管理する」 | CLI 経由なら自明、誤読を招く表現 |
| L99 | 「新規作成時は `elevens create-task --title <title> --priority <p> --status draft` を使用」（単独行）| §3.1 の完全な手順に統合 |
| L33 / L41 の `タイプ` 列 | 一覧表ヘッダの「タイプ」 | frontmatter に該当フィールドが無い |

> 行番号は現リポジトリ HEAD 時点（`commands/team-task.md` 149 行版）。実装時は再 grep で固定する。

---

## 8. 検証手順（修正コミット前に必ず実行）

### 8.1 修正手順どおりに 1 コマンドで draft が作れること

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-020-1779573954

# 検証用 draft 作成（1 コマンド完結を確認）
elevens create-task \
  --title "verify team-task rewrite" \
  --priority medium \
  --status draft \
  --body "$(cat <<'BODY'
## Context
team-task.md 修正の検証 draft。

## Options
1. このまま削除
2. 内容を残して update

## Recommendation
削除
BODY
)"
# → 期待: stdout に "TASK_ID=NNN FILE=.team/tasks/NNN-verify-team-task-rewrite/task.md"
```

### 8.2 frontmatter と本文が想定どおり生成されていること

```bash
NNN=<上で得た ID>
cat ".team/tasks/$NNN-verify-team-task-rewrite/task.md"
```

期待出力（要点）:

- `id: $NNN` / `title: verify team-task rewrite` / `priority: medium` / `created_at:` がある
- `created_by: surface:...` がある（呼び出し元 surface に応じて）
- `type:` / `raised_by:` は **無い**
- 本文に `## タスク内容` ヘッダ → `## Context` / `## Options` / `## Recommendation` の順で含まれている

### 8.3 `--help` 出力と team-task.md の記述が一致していること

```bash
elevens create-task --help | grep -E -- "^  --"
elevens update-task --help | grep -E -- "^  --"
elevens close-task  --help | grep -E -- "^  --"
elevens delete-task --help | grep -E -- "^  --"
```

→ team-task.md に書いたフラグが全て `--help` 出力に存在することを目視確認。

### 8.4 一覧 / 詳細手順の整合

```bash
# 一覧（直接 ls + task-state.json 突合）
ls .team/tasks/ | sort
cat .team/task-state.json | jq ".[\"$NNN\"]"

# 詳細表示
DIR=$(ls .team/tasks/ | grep "^$NNN")
cat ".team/tasks/$DIR/task.md"
```

→ 修正案 §4 / §6 のサンプル出力構造と矛盾しないこと。

### 8.5 検証で作った draft の掃除

```bash
elevens delete-task --task-id $NNN \
  --journal "team-task.md 修正検証用 draft の掃除"
# → task-state.json の status が deleted、Journal に行が残る
```

> `draft` 状態なので `--force` は不要。**plan に従って必ず掃除する**（draft の溜め込み禁止 / `[[feedback_task_cleanup_over_draft_hoarding]]` 方針）。

### 8.6 修正本体のコミット前チェック

```bash
git diff commands/team-task.md | head -200
# → 削除行が §7 のとおりであること、追加行が §3 / §4 / §5 / §6 の案と一致すること
```

---

## 9. 想定外スコープ（今回は触らない）

- `elevens --help` トップレベルの `close-task` 1 行サマリ（`elevens close-task --task-id <id> [--journal <text>]`）が `--deliverable-kind` 必須を反映していない件は **別タスク**。今回は team-task.md のみ修正。
- `list-tasks` / `show-task` CLI の新設も今回スコープ外（必要なら別 Axxx で議論）。
- Conductor 等の sub-agent template (`skills/cmux-team/templates/*.md`) に「team-task の新フロー」を周知する文言を入れるかは別 issue。

---

## 10. 完了の定義（DoD）

1. `commands/team-task.md` が §3 / §4 / §5 / §6 / §7 のとおり書き換わっている
2. §8.1 の 1 コマンド実行で draft タスクが作成でき、§8.2 のとおり frontmatter + 本文が生成される
3. §8.3 で `--help` と team-task.md の記述に齟齬がない
4. §8.5 で検証用 draft が `deleted` になり後始末済み
5. 変更が `commands/team-task.md` 1 ファイルに閉じる（CLI 実装や他テンプレへの波及無し）

以上。
