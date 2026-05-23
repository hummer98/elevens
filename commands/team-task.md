---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "タスクの作成・一覧・クローズ・表示を管理する"
---

# /team-task

`.team/tasks/` のタスクを管理してください。

## サブコマンド判定

`$ARGUMENTS` を解析し、以下のいずれかの操作を実行する:

- `$ARGUMENTS` = "" または未指定 → **一覧表示**
- `$ARGUMENTS` が "create " で始まる → **新規作成**（"create " 以降がタイトル）
- `$ARGUMENTS` が "close " で始まる → **クローズ**（"close " 以降が ID）
- `$ARGUMENTS` が "show " で始まる → **詳細表示**（"show " 以降が ID）
- `$ARGUMENTS` がその他の文字列 → **新規作成のショートハンド**（文字列全体がタイトル）

---

## 操作: 一覧表示

### 手順

1. `.team/tasks/` 直下の `<NNN-slug>/` ディレクトリを走査し、各 `.team/tasks/<NNN-slug>/task.md` を読む
2. `cat .team/task-state.json` でタスク状態を取得
3. 各タスクの YAML フロントマター（`id` / `title` / `priority` / `created_at` / `created_by` 等）と状態を組み合わせて解析
4. 一覧を表形式で表示:

```
## オープンタスク (N件)

| ID  | タイトル                    | 優先度 | ステータス | 起票元 (`created_by`) | 作成日     |
|-----|---------------------------|--------|-----------|----------------------|-----------|
| 001 | 認証トークンの有効期限設計   | medium | ready     | surface:200          | 2026-03-19 |
| 002 | DB接続のタイムアウト        | high   | draft     | surface:201          | 2026-03-19 |

## クローズ済み (M件)

| ID  | タイトル                    | 優先度 | 起票元 (`created_by`) | 作成日     |
|-----|---------------------------|--------|----------------------|-----------|
| 000 | 初期設計の方針決定          | medium | surface:200          | 2026-03-18 |
```

タスクが 0 件の場合: 「オープンタスクはありません」

---

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

   以下のコマンドを実行する。heredoc 終端 `BODY` を行頭に置く必要があるため、コードブロックは
   リスト項目のインデント外（左寄せ）に配置している。コピペでそのまま `bash` に流せる:

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

補足:

- ID は CLI が自動採番する（`.team/tasks/` 直下を走査し最大 ID + 1）。
- frontmatter（`id` / `title` / `priority` / `created_at` / `created_by`）は CLI が自動生成する。
  **手書きで `.team/tasks/` にファイルを書いてはいけない**（hook で block される）。
- `--priority` 既定は `medium`。`high` / `low` を選びたければ対話で確認。
- `$ARGUMENTS` から本文を直接渡したい・対話を省きたい場合は `--body` を空にしてよい
  （あとから `elevens update-task --task-id NNN --body "..."` で埋める）。
- 上記ヒアドキュメントは `<<'BODY'` （単一引用符付き）で書いているため、`$CONTEXT` 等の
  bash 変数を実展開させたい場合はスキル側で事前に展開した文字列を流し込むか、
  `<<BODY` （引用符無し）に切り替えること。

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

---

## 操作: クローズ

### 手順

1. **タスクディレクトリを検索**:
   ```bash
   ls .team/tasks/ | grep "^$ID"
   # → 例: 035-fix-login-bug
   ```

2. **タスクが見つからない場合**:
   「ID: $ID のオープンタスクが見つかりません」と表示

3. **CLI でタスクをクローズ**:
   `elevens close-task` は `--deliverable-kind <kind>` が必須（`files` / `merged` / `pr` / `none`）。
   未指定で呼ぶと `exit 1` になるので、最低限 `--deliverable-kind none` を補う。

   ```bash
   # ローカル ff-only マージで完了したケース
   elevens close-task --task-id $ID --deliverable-kind merged \
     --merged-into <branch> --merge-sha <sha> \
     --journal "<完了理由>"

   # 納品物なしで閉じるケース（例: 既に他タスクで充足、調査のみで成果物なし）
   elevens close-task --task-id $ID --deliverable-kind none \
     --journal "<完了理由>"
   ```

   `/team-task close <id>` のショートカットで投げる場合は、最低限
   `--deliverable-kind none --journal "closed by user"` を補ってよい。
   詳細なフラグの組み合わせは `elevens close-task --help` を参照。

4. **確認表示**:
   「タスク #NNN をクローズしました: <タイトル>」

---

## 操作: 詳細表示

### 手順

1. **タスクディレクトリを検索**:
   ```bash
   ls .team/tasks/ 2>/dev/null | grep "^$ID"
   # → 例: 020-team-task-create-task-cli
   ```

2. **タスクが見つからない場合**:
   「ID: $ID のタスクが見つかりません」と表示

3. **タスクの全内容を表示**:
   ディレクトリ内の `task.md` を読み込み、`task-state.json` の状態（`status` / `assigned_to` 等）と
   組み合わせて整形表示する。

   ```bash
   DIR=$(ls .team/tasks/ | grep "^$ID")
   cat ".team/tasks/$DIR/task.md"
   jq ".[\"$ID\"]" .team/task-state.json
   ```

---

## 前提チェック

すべての操作の前に:
- `.team/team.json` が存在すること
- `.team/tasks/` ディレクトリが存在すること（なければ作成）

## 引数

`$ARGUMENTS` = サブコマンドと引数:
- "" → 一覧表示
- "create <title>" → 新規作成
- "close <id>" → クローズ
- "show <id>" → 詳細表示
- "<title>" → 新規作成のショートハンド
