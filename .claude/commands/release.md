---
allowed-tools: Bash, Read, Edit, Write
description: "elevens のリリース作業を直接実行する（npm publish + GitHub Actions OIDC + plugin marketplace 更新）"
---

# /release

elevens のリリース作業を Master 自身が直接実行する。Conductor / Manager の起動は不要。

## 引数

`$ARGUMENTS` でバージョンを指定できる:

- `/release` — コミット履歴から自動判定
- `/release 0.2.0` — 指定バージョンで固定

## フロー概要

| Phase | 内容 |
|---|---|
| A | 現在 version + commit log 取得、NEW_VERSION 判定、（任意）docs/spec の同期 |
| B | CHANGELOG / version 3 ファイル更新、1 commit、tag、push |
| C | GitHub Actions release.yml の OIDC publish 監視（並行で plugin marketplace cache 更新） |
| D | `npm install -g @hummer98/elevens` で動作確認 |

## 手順

### 0. （任意）docs/spec を background subagent で同期

直近の実装と仕様書がずれていたら `docs/spec/*.md` / `README.md` / `README.ja.md` を直しておきたい。重作業なので `Agent` ツール（`subagent_type: general-purpose`, `run_in_background: true`）に投げる。Step 1-2 と並行実行する。

> サブエージェントは `docs/` と `README*` のみ編集する。`CHANGELOG.md` / `package.json` / `.claude-plugin/*.json` には触れさせない（Step 4-5 で Master が編集するため）。

### 1. 現在のバージョンとコミット履歴を取得

```bash
cd "$PROJECT_ROOT"
CURRENT=$(node -e "console.log(require('./package.json').version)")
LAST_TAG=$(git describe --tags --abbrev=0 --match='v0.*' 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log ${LAST_TAG}..HEAD --oneline)
else
  COMMITS=$(git log --oneline -20)
fi
```

> `--match='v0.*'` で cmux-team から継承した `v4.x` 系 tag を除外する。Phase 4 で v1.x に上がったらこの match も外す。

### 2. バージョンを判定

タスク引数があれば最優先で採用。未指定ならコミット群から最大変更レベルで決定:

| キーワード | 変更レベル |
|---|---|
| `BREAKING CHANGE`, `!:` | major |
| `feat:`, `feat(` | minor |
| `fix:` / `chore:` / `docs:` のみ | patch |

### 3. doc-sync subagent の完了確認（Step 0 を起動した場合）

完了通知を待ってから Step 4 へ。`git status -s -- docs/spec/ README.md README.ja.md` で実際の編集ファイルを確認。想定外（CHANGELOG / package.json / .claude-plugin/）に触れていたら `git checkout -- <file>` で破棄。

subagent がエラー終了した場合は warning 扱いで release を続行（doc-sync で release を止めない）。

### 4. CHANGELOG.md を更新

先頭（`# Changelog` の直後）に追記:

```
## [X.Y.Z] - YYYY-MM-DD

### Added
- 新機能の説明

### Changed
- 変更の説明

### Fixed
- 修正の説明
```

**分類:** `feat:` → Added / `fix:` → Fixed / それ以外 → Changed。コミットメッセージそのままコピーせず、ユーザーが読んで意味がわかる説明に書き直す。

### 5. バージョンを 3 ファイルで更新

- `package.json` — `"version": "X.Y.Z"`
- `.claude-plugin/plugin.json` — `"version": "X.Y.Z"`
- `.claude-plugin/marketplace.json` — `plugins[0].version` を `"X.Y.Z"` に（存在しない場合スキップ）

### 6. コミット・push・タグ（doc-sync 差分も同梱）

```bash
cd "$PROJECT_ROOT"
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
# doc-sync subagent が編集したファイルがあれば同コミットに含める
git add docs/ README.md README.ja.md 2>/dev/null || true
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"
```

### 7. GitHub Actions release.yml の OIDC publish を kick + 監視（Phase C 開始）

`.github/workflows/release.yml` は `npm publish --provenance --access public` を OIDC trusted publisher 経由で実行する（`NPM_TOKEN` 不要）。

**重要 (運用ノート):** yml 上は `on: push: tags: 'v*'` も設定されているが、実運用では tag push trigger は機能しておらず、過去 6 リリース（v0.3.0〜v0.5.0）すべて `workflow_dispatch` で起動している。tag push 後に明示的に `gh workflow run` を叩いて kick する。原因調査は別タスク。

```bash
cd "$PROJECT_ROOT"
gh workflow run release.yml --ref "v${NEW_VERSION}"

# kick した run を id で特定する（list の最新が必ず該当 run とは限らないので、ref 一致で絞り込む）
sleep 3
RUN_ID=$(gh run list \
  --workflow=release.yml \
  --branch "v${NEW_VERSION}" \
  --event workflow_dispatch \
  --limit=1 \
  --json databaseId \
  --jq '.[0].databaseId')

if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "Error: workflow run for v${NEW_VERSION} not found"
  exit 1
fi
echo "RUN_ID=${RUN_ID}"
gh run watch ${RUN_ID} --exit-status > /tmp/gh-run-watch-${NEW_VERSION}.log 2>&1 &
GH_WATCH_PID=$!
```

### 8. plugin marketplace cache を更新（並行・graceful）

ローカルに plugin marketplace `hummer98-elevens` を installed してある場合は最新化する。未 install ならスキップ（初回 release では当然 skip される）。

```bash
MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/hummer98-elevens"
if [ -d "$MARKETPLACE_DIR/.git" ]; then
  (cd "$MARKETPLACE_DIR" && git pull origin main)
fi

# 旧バージョン cache 削除（最新 1 つを残す）
CACHE_BASE="${HOME}/.claude/plugins/cache/hummer98-elevens/elevens"
if [ -d "$CACHE_BASE" ]; then
  LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
  for dir in "$CACHE_BASE"/*/; do
    [ "$dir" != "$LATEST" ] && rm -rf "$dir"
  done
fi

# plugin 再インストール（marketplace 未登録ならスキップ）
if claude plugin list 2>/dev/null | grep -q "elevens@hummer98-elevens"; then
  claude plugin uninstall elevens@hummer98-elevens
  claude plugin install elevens@hummer98-elevens
fi
```

### 9. GitHub Actions の完了待ち（Phase C 同期点）

```bash
wait ${GH_WATCH_PID}
GH_EXIT=$?
if [ ${GH_EXIT} -ne 0 ]; then
  echo "GitHub Actions release workflow failed (exit ${GH_EXIT})"
  cat /tmp/gh-run-watch-${NEW_VERSION}.log
  exit ${GH_EXIT}
fi
```

### 10. npm レジストリからインストール検証 (ローカル更新)

```bash
# global install (新 version の symlink で旧 version を上書き)
npm install -g @hummer98/elevens@${NEW_VERSION}

# nodenv / nvm 系を使っている場合、新 bin の shim 生成を強制
command -v nodenv >/dev/null 2>&1 && nodenv rehash
# nvm の場合は通常 rehash 不要 (PATH 直結) だが念のため確認:
# command -v nvm >/dev/null 2>&1 && nvm reinstall-packages "$(node -v)" 2>/dev/null || true

# 動作確認 (version が NEW_VERSION と一致するか)
which elevens
INSTALLED_VERSION=$(elevens --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "?")
if [ "$INSTALLED_VERSION" = "${NEW_VERSION}" ]; then
  echo "✓ elevens ${NEW_VERSION} がローカルに反映されました"
else
  echo "⚠️  expected ${NEW_VERSION} but got ${INSTALLED_VERSION}"
  echo "    rehash 漏れの場合は 'nodenv rehash' or 'hash -r' を実行"
fi
```

**注意点 (本番運用ノート、A031 / v0.3.2 経験から)**:

- `npm install -g .` は使わない（symlink 連鎖再起動を避けるため）
- **`@hummer98/cmux-team` (legacy) と共存させる場合**: elevens は `bin: { elevens }` のみで `cmux-team` alias を提供しないため bin 衝突は起きない (v0.3.2+)。`@hummer98/cmux-team` の `cmux-team` バイナリはそのまま legacy 4.28.x が動く
- **nodenv 使用時**: `npm install -g` 後に新規 bin (例: `elevens`) は `nodenv rehash` を実行しないと shim が作られず `command not found` になる。既存 bin の symlink 上書きは shim 作り直し不要
- **v0.3.0 / v0.3.1 を `--force` で install して `cmux-team` bin が elevens に上書きされてしまった場合の復旧**: `npm install -g --force @hummer98/cmux-team@<latest>` を 1 回実行で legacy cmux-team の bin に戻る。**v0.3.2+ では発生しない**

### 11. 完了報告

```
リリース完了: v${CURRENT} → v${NEW_VERSION}
- tag: v${NEW_VERSION}
- npm: @hummer98/elevens@${NEW_VERSION}（OIDC provenance 付き）
- plugin: <更新済み or "marketplace 未登録">
- doc-sync: <更新ファイル数 or "変更なし">
- workflow run: https://github.com/hummer98/elevens/actions/runs/${RUN_ID}
```

## 前提

- `package.json.publishConfig.access` が `"public"` であること（scoped package を public publish するため）
- npmjs.com 側で `@hummer98/elevens` の Trusted Publisher として `hummer98/elevens` repo + `release.yml` workflow が登録済みであること
- GitHub Actions 側に `permissions.id-token: write` が設定済みであること（OIDC 用、`release.yml` 既設）

## 注意事項

- v0.x.x は initial development（SemVer minor が breaking 含み得る）。v1.0.0 への昇格タイミングは別途判断
- `--match='v0.*'` 制約は cmux-team 由来の `v4.x` tag をリリースノート diff から除外するためのもの。Phase 4 で elevens を v1.0 に bump したら外す
- elevens の Master / Conductor / Agent オーケストレーション機構が稼働中の repo で release を打つ場合、本コマンドは Master 直接実行で済むため `--exclusive` task gating は使わない（cmux-team 時代との挙動差）
