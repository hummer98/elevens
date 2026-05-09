---
allowed-tools: Bash, Read, Glob, Grep
description: "elevens プラグインの全コマンド・スキル一覧と起動条件を表示"
---

# /elevens:help

elevens Claude Code プラグインの全スラッシュコマンドとスキルの概要・起動条件を一覧表示する。

## 手順

### 1. プラグインのルートディレクトリを特定

以下の優先順位でチェックする:

```bash
PLUGIN_DIR=""

# 1. elevens バイナリの実体パスから逆算（後方互換のため cmux-team alias も試す）
CMUX_BIN=$(which elevens 2>/dev/null || which cmux-team 2>/dev/null)
if [ -n "$CMUX_BIN" ]; then
  REAL_BIN=$(realpath "$CMUX_BIN" 2>/dev/null || readlink -f "$CMUX_BIN" 2>/dev/null || echo "$CMUX_BIN")
  CANDIDATE=$(dirname "$(dirname "$REAL_BIN")")
  [ -d "$CANDIDATE/commands" ] && PLUGIN_DIR="$CANDIDATE"
fi

# 2. npm グローバル root
if [ -z "$PLUGIN_DIR" ]; then
  NPM_ROOT=$(npm root -g 2>/dev/null)
  CANDIDATE="$NPM_ROOT/@hummer98/elevens"
  [ -d "$CANDIDATE/commands" ] && PLUGIN_DIR="$CANDIDATE"
fi

# 3. ~/.claude/plugins
if [ -z "$PLUGIN_DIR" ]; then
  CANDIDATE="$HOME/.claude/plugins/elevens"
  [ -d "$CANDIDATE/commands" ] && PLUGIN_DIR="$CANDIDATE"
fi

echo "${PLUGIN_DIR:-NOT_FOUND}"
```

`NOT_FOUND` の場合: 「プラグインが見つかりません。`npm install -g @hummer98/elevens` を確認してください」と表示して終了。

### 2. スラッシュコマンドを収集

```bash
ls "$PLUGIN_DIR/commands/"
```

各 `.md` ファイルを `Read` で開き、frontmatter の `description` とファイル名（拡張子除く）を取得する。
コマンド名は `/elevens:<ファイル名>` 形式になる。

### 3. スキルを収集

```bash
find "$PLUGIN_DIR/skills" -name "SKILL.md" | sort
```

各 `SKILL.md` を `Read` で開き、frontmatter の `name` と `description` を取得する。

### 4. 表示フォーマット

以下の形式で出力する:

---

## スラッシュコマンド

ユーザーが明示的に `/elevens:<name>` と入力して呼び出す。

| コマンド | 説明 |
|---------|------|
| `/elevens:<name1>` | description |
| ...                  | ...         |

---

## スキル（自動トリガー）

スキルはユーザーの発言内容を見て Claude が自動的にロードする。
「起動条件」は frontmatter の `description` フィールドをそのまま表示する。

### `<name1>`

> <description フィールドの内容を改行・インデントを保持してそのまま表示>

---

### `<name2>`

...

---
