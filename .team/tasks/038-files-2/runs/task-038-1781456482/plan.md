# 実装計画書: ファイルビューワー(/files) 2 ペイン + ダークテーマ刷新 (T038)（改訂版 r2）

## 改訂履歴

Design Reviewer の `design-review.md`（Changes Requested）を反映した r2 改訂。指摘 → 反映:

- **C1 [critical]**: iframe の子文書（`/files/<path>`）が `frame-ancestors 'none'` でブラウザにブロックされ表示できない。→ §2.1 の CSP 解釈を訂正。`/files` 系 response の CSP を `frame-ancestors 'self'` 版に緩める方針へ変更し、§4.2 を「`dashboard-server.ts` は `/files` 用 CSP の 1 行差し替えのみ（routing 構造は不変）」に改訂。§3.2・§8 リスク#2 も整合。
- **M2 [major]**: `dashboard-files.test.ts` の簡易 CSP（`default-src 'self'`）では C1 を検出できない（false green）。→ §5.2 に **N12（`dashboard-server.test.ts` 統合経路で `/files` および `/files/<path>` 応答 CSP に `frame-ancestors 'self'` を含む）** を追加。
- **M3 [major]**: 右 iframe の `sandbox` 未確定。md wrapper はインライン script で marked を実行するため素の sandbox だと描画されない。→ §3.2 / §4.1 に「右 iframe には `sandbox` を付けない」を明記し、§3.2 の「サンドボックス境界が得られる」という利点記述を削除。
- **m4 [minor]**: JSON entry のフィールド名不整合。→ `mtimeLocal`（整形済み文字列）に一本化（`mtimeMs` は JSON に載せない＝表示専用）。`size` の null 表現（`-`）を client 側整形ルールとして明記。§3.1 / §4.1 / §6 の表記を統一。
- **m5 [minor]**: spec §8.5 / §8.4 の更新文言が C1 と矛盾。→ §6 を「/files 応答は `frame-ancestors 'self'`（同一オリジン埋め込み許可、他オリジン埋め込みは禁止維持）」「右ペインは同一オリジン iframe」に訂正。

---

## 1. 概要

Web ダッシュボードの `/files` ファイルビューワーを、現状の「1 ペイン・ページ遷移型」（ディレクトリ index と単一ファイル表示が別ページ）から、**左サイドバー = ファイル/ディレクトリツリー、右ペイン = 内容表示**の 2 ペイン SPA 風レイアウトに刷新する。同時に既存 SPA ダッシュボード（`dashboard-web/style.css`）と揃ったダークテーマにする。

変える点:

- `/files`（root index）が、左にツリー・右に内容を持つ単一の shell HTML を返すようにする。
- ツリーはクリックで展開/折りたたみ、ファイルクリックで右ペインに内容を表示。
- 内容表示は `iframe` で既存の `/files/<rootKey>/<relpath>` 配信経路（md wrapper / raw / html / 画像）をそのまま再利用する → セキュリティ境界・レンダリングロジックを一切重複させない。
- ツリーの子要素取得は既存 dir 解決経路に **`?format=json` を追加**して JSON で返す（lazy load）。
- 配色は `dashboard-web/style.css` の `:root` CSS 変数トーンに合わせたダークテーマを `/files` shell に inline する。
- dir index / ファイル mtime はすべて**サーバのローカルタイム**で整形する（現状の `toISOString()` = UTC Z 付きを廃止）。
- **iframe を有効化するため、`/files` 系 response の CSP を `frame-ancestors 'none'` → `frame-ancestors 'self'` に緩める**（C1 反映。他オリジン埋め込みは引き続き禁止）。`dashboard-server.ts` は CSP 1 行差し替えのみで routing 構造は不変。

**変えない点（重要）**: `resolveFilePath()` のセキュリティ境界、`contentTypeFor()`、md wrapper 生成（`renderMarkdownWrapperHtml`）、ファイル streaming 配信、`dashboard-server.ts` の `/files` 委譲構造（routing）。SPA/API 側（`/` `/api/*`）の CSP（`frame-ancestors 'none'`）は据え置き。

---

## 2. 現状アーキテクチャの理解

### 2.1 ルーティングと CSP（`dashboard-server.ts`）

- `dashboard-server.ts:807` で `pathname === "/files" || pathname.startsWith("/files/")` を判定し、`handleFilesRequest(projectRoot, url, baseHeaders)` に委譲（`dashboard-server.ts:44` import）。
- 現状の baseHeaders は `{ "Cache-Control": "no-store", "Content-Security-Policy": CSP_HEADER }`（`dashboard-server.ts:808-811`）。`handleFilesRequest` は **全 response に `...baseHeaders` を spread** する → shell も、iframe に読み込む `/files/<path>` 子文書も同じ CSP を背負う。
- `CSP_HEADER`（`dashboard-server.ts:111-118`）= `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`。
  - **inline `<script>` / `<style>` は許可済み**（既存 md wrapper / SPA がこれに依存）。
  - **`connect-src 'self'` で同一オリジンへの `fetch()` が許可済み** → ツリー lazy load の JSON fetch は CSP 上問題なし。
  - **`frame-ancestors 'none'` の正しい解釈（C1 で訂正）**: `frame-ancestors` は「**その文書自身が frame されてよいか**」を**frame される側（子文書）**に効かせるディレクティブ。`'none'` は**同一オリジンを含む一切の ancestor からの埋め込みを禁止**する（`'self'` のような同一オリジン例外なし）。
    - shell（`/files`）が `<iframe src="/files/docs/foo.md">` を持つと、**子文書 `/files/docs/foo.md` 自身の `frame-ancestors 'none'`** によりブラウザが `Refused to display … in a frame because an ancestor violates … frame-ancestors 'none'` で描画を拒否する。
    - `frame-src` が `default-src 'self'` にフォールバックして「**親**が同一オリジンを load してよい」のは事実だが、それは親側の許可であり、**子側の `frame-ancestors 'none'` 拒否が別レイヤで優先して効く**。`frame-src 'self'` を追加しても無効。
  - **→ 対応（C1）**: `/files` 系 response の CSP を `frame-ancestors 'self'`（同一オリジン埋め込みのみ許可）に緩める。他オリジン埋め込みは引き続き禁止 = セキュリティ後退は最小。詳細は §4.2。

### 2.2 `dashboard-files.ts` の関数構成と責務

| 関数 | 責務 |
|---|---|
| `ROOT_DIRS`（定数, L25） | rootKey allowlist（`docs` / `artifacts` / `output`）→ projectRoot 相対パス |
| `resolveFilePath(projectRoot, pathname)`（L42） | `/files/...` の path 解決。decode→制御文字/区切り拒否→dot segment 拒否→rootKey 辞書引き→join backstop→lstat→realpath 境界（root 側も realpath）→stat で file/dir 判定。**throw しない**。返り値 `root_index` / `dir` / `file` / `bad_request` / `not_found` |
| `contentTypeFor(filename)`（L148） | 拡張子→Content-Type。未知は `application/octet-stream` |
| `escapeHtml` / `hrefFor` / `breadcrumbHtml`（L159–189） | HTML 生成ヘルパ |
| `renderRootIndexHtml()`（L207） | root index ページ（3 rootKey リンク） |
| `listDirEntries(absDir, prefix)`（L221） | dir エントリ列挙（`DirEntryRow{ name, isDir, size, mtimeIso }`、dir 優先 + name 昇順 sort、prefix 前方一致 filter）。**現状 `mtimeIso = st.mtime.toISOString()`（UTC）** |
| `renderDirIndexHtml(...)`（L244） | dir index ページ（breadcrumb + table） |
| `getMarkedJs()`（L272） | `dashboard-web/vendor/marked.min.js` を readFileSync + module cache |
| `renderMarkdownWrapperHtml(...)`（L296） | md wrapper HTML（marked inline、md 本文を `<script type="application/json">` に `JSON.stringify` + `<`→`<` で埋め込み、`?raw=1` リンク + breadcrumb） |
| `handleFilesRequest(projectRoot, url, baseHeaders)`（L346） | entry point。`resolveFilePath` の結果で分岐: bad_request→400 / not_found→404 / root_index→`renderRootIndexHtml` / dir→`renderDirIndexHtml`（`?prefix=`）/ file→md は wrapper（`?raw=1` で生）、それ以外は `Bun.file` streaming |

### 2.3 セキュリティ境界（絶対不可侵）

`resolveFilePath` の 7 段（spec 12 §8.4）:

1. segment 単位 `decodeURIComponent`（失敗 → 400 `bad_request`）
2. 制御文字 `[ -]` / decode 後の `/` `\` を含む segment → 400
3. `..` / `.` / 空 segment → 404
4. rootKey 辞書引き（allowlist 外 → 404）
5. `join` 後の `startsWith(rootAbsDir + sep)` backstop → 範囲外 404
6. `lstatSync` → `realpathSync`（**root 側も realpath**、macOS `/var`→`/private/var` 対策）で境界外 symlink → 404
7. `statSync` で file / dir 判定

エラー設計: **malformed のみ 400、それ以外の拒否は一律 404**（存在有無を漏らさない）。

### 2.4 既存 SPA との関係

- 既存 SPA（Overview 等 5 ページ）は `dashboard-web/index.html` + `app.js` + `style.css` + vendor で、サーバ起動時に bundle される別経路。
- `/files` はこの SPA とは**完全に別経路**で `dashboard-files.ts` が単一 HTML を都度生成する。
- → 本タスクは `dashboard-files.ts` 内で完結させる（routing 不変）。`dashboard-server.ts` への変更は **§4.2 の CSP 1 行差し替えのみ**。`dashboard-web/app.js` / `index.html` には手を入れない（`style.css` は配色値の**参照元**としてのみ使い、編集はしない）。

### 2.5 ダークテーマ配色（`dashboard-web/style.css` `:root` から抽出）

| 変数 | 値 | 用途 |
|---|---|---|
| `--bg` | `#0e1116` | 全体背景 |
| `--panel` | `#161b22` | サイドバー/カード背景 |
| `--panel2` | `#1c232c` | hover / 強調背景 |
| `--border` | `#2a313c` | 境界線 |
| `--fg` | `#d4d8df` | 本文 |
| `--fg-dim` | `#8a93a0` | 補助テキスト（見出し・mtime 等） |
| `--accent` | `#58a6ff` | リンク・選択中 |
| `--green` | `#30c850` / `--yellow` `#d6a626` / `--red` `#e0524d` | （必要時のみ） |
| フォント | `13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` | 全体 |
| code/pre 背景 | （現行 light の `#f6f8fa` を**ダーク化**: `var(--panel2)` 相当に置換） | md wrapper |

サイドバー幅は SPA の `#sidebar { width: 200px }` を踏襲しつつ、ツリーは可変なので `240–280px` 程度 + リサイズ不要（最小スコープ）。

---

## 3. 設計判断

### 3.1 ツリー取得方式 A/B 比較

**前提**: SSE / WebSocket / polling は使わない（タスク指示）。`.team/output/` は taskRun 単位で多数のサブディレクトリ・ファイルを持ちうる（数百〜）。

| | A: 軽量 JSON endpoint（lazy load） | B: 初期 HTML に全ツリー埋め込み |
|---|---|---|
| 仕組み | dir 解決経路に `?format=json` を追加し、`{ entries: [{name,isDir,size,mtimeLocal}] }` を返す。ツリーはクリック展開時に該当 dir を 1 階層 fetch | shell HTML 生成時に 3 rootKey を再帰 walk し、全ノードを JSON / DOM として埋め込む |
| 初期負荷 | 小（root の 3 rootKey + 第 1 階層のみ）。`.team/output` が巨大でも初期は軽い | 大（`.team/output` 全 walk。ファイル数に比例して HTML 肥大・生成時間増） |
| セキュリティ | 既存 `resolveFilePath`（kind=dir）を**再利用**。新たな walk ロジックを書かない → 境界が増えない | rootKey ごとの再帰 walk を**新規実装**する必要があり、symlink/境界チェックを再発明するリスク（境界の二重管理 = sign of trouble） |
| 観察可能性 | dir 単位の素直な read。trace も既存経路に乗る | 一括 walk は挙動が見えにくい |
| 実装量 | `handleFilesRequest` の dir 分岐に format 判定を足すだけ（+ client 側 fetch） | walk + シリアライズ + 巨大 DOM 構築 |
| 弱点 | クリックごとに fetch が走る（ただし `connect-src 'self'` で許可済み、no-store でも軽量 JSON なら問題なし） | 大規模 output で破綻。再帰境界の自前実装が危険 |

**結論: A 案（軽量 JSON endpoint + lazy load）を採る。**

理由:
1. **セキュリティ境界を一切増やさない** — 既存 `resolveFilePath`（kind=dir）+ `listDirEntries` をそのまま使い、`?format=json` でシリアライズ先だけ変える。再帰 walk を新規実装しないため「境界の二重管理」を避けられる（CLAUDE.md「構造的正しさ」「state を外部化」）。
2. **最小スコープ** — read side（既存 dir 解決）の拡張だけで済む（memory: minimal scope / read side 拡張優先）。
3. `.team/output` の規模に対してスケールする（初期は浅く、必要な枝だけ展開）。
4. CSP 適合（`connect-src 'self'`）。

具体 API（**JSON entry は `mtimeLocal`（整形済み文字列）を正とし、`mtimeMs` は JSON に載せない** — m4 反映）:
- `GET /files/<rootKey>/<relpath>?format=json` → kind=dir のときのみ JSON `{ rootKey, relPath, entries: [{ name, isDir, size, mtimeLocal }] }` を返す。kind=file / not_found / bad_request は従来どおり（JSON error or 配信）。
  - `size`: dir entry や stat 失敗時は `null`。client は `null` を `-` と表示する（client 側整形ルール）。
  - `mtimeLocal`: サーバローカルタイム `YYYY-MM-DD HH:mm` 文字列。stat 失敗時は `null` → client は `-` 表示。
- `GET /files/?format=json` → root の 3 rootKey 一覧 JSON `{ entries: [{ name: "docs", isDir: true }, ...] }`。
- shell HTML（`GET /files` / `GET /files/`、`format` query なし）→ 2 ペイン shell を返す。初期表示で root の 3 rootKey を fetch して左に描画。

### 3.2 右ペインの内容表示方式

**iframe で既存配信経路を再利用する。**

- 右ペインは `<iframe>`。ファイルクリックで `iframe.src = "/files/<rootKey>/<relpath>"`（md は wrapper、画像/html/raw もそのまま）に設定。
- **iframe には `sandbox` 属性を付けない（M3 反映）。** 理由: md wrapper は `marked` をインライン `<script>` で実行して本文を描画する（`renderMarkdownWrapperHtml`）。素の `sandbox`（=全制限）を付けると `allow-scripts` が無く marked が動かず md が空白になる。`sandbox="allow-scripts allow-same-origin"` を付けても実質サンドボックス無効と等価で「境界が得られる」とは言えない。よって sandbox は付けず、隔離は **CSP（同一オリジン制約）+ 既存 `resolveFilePath` のパス境界**に委ねる。
- 表示可否は **CSP `frame-ancestors`** が支配する。現状 `'none'` は子文書の埋め込みを全面禁止するため iframe が表示されない（C1）→ §4.2 で `/files` 系 CSP を `frame-ancestors 'self'` に緩めて同一オリジン埋め込みを許可する。
- 利点: md レンダリング（marked）・画像・html・raw すべて既存の `handleFilesRequest` file 分岐をそのまま使え、**レンダリングロジックを二重実装しない**。
- md wrapper をダークテーマにすると iframe 内も自動でダークになる（§4 で wrapper style をダーク化）。
- 代替（fetch して innerHTML 注入）は却下: md の marked 実行・script 埋め込み・画像 streaming を client 側で再現する必要があり複雑、かつ XSS 面が増える。iframe + CSP `frame-ancestors 'self'` 緩和が最小コスト。

### 3.3 ローカルタイム整形

- `listDirEntries` の `mtimeIso: string`（`st.mtime.toISOString()`）を廃止し、**内部では `mtimeMs: number | null`（`st.mtimeMs`）を保持**するが、**JSON / HTML へは `formatLocalMtime` を通した `mtimeLocal` 文字列のみ載せる**（m4: JSON に `mtimeMs` を出さない）。
- 整形は**サーバ側**で行う（JSON にもローカルタイム文字列を載せる。client の TZ に依存させない = タスク指示「サーバのローカルタイムゾーン」）。
- フォーマッタ `formatLocalMtime(ms: number | null): string` を新設。`new Date(ms)` の `getFullYear/getMonth/getDate/getHours/getMinutes`（いずれもローカルタイム）をゼロ埋めで連結し `YYYY-MM-DD HH:mm` を生成（Z や ISO を出さない）。`ms == null` のときは `-` を返す。
  - 決定論的でテストしやすく、TZ 依存も「サーバのローカル」で一貫。
- JSON entries・dir index HTML（後方互換で残す場合）・将来表示箇所すべてでこの formatter を使う。

> 注: `dashboard-files.test.ts` 既存テストは mtime 文字列を assert していない（`listDirEntries` を直接呼ぶテストは無し、HTML 内 mtime 値も検査していない）。よって UTC→ローカル変更で既存テストは壊れない。

### 3.4 tree walk のセキュリティ

A 案では**専用 walk を新規実装しない**。ツリーの各展開は `GET /files/<dir>?format=json` = 既存 `resolveFilePath`（kind=dir）→ `listDirEntries`（既存 `readdirSync` + `statSync`、symlink は entry 表示のみでリンク先は開いた時に再度 `resolveFilePath` が 404 で閉じる）に乗る。

- root index の rootKey 列挙は `Object.keys(ROOT_DIRS)`（allowlist そのもの）。
- 各 entry の href / fetch path は client 側で `encodeURIComponent`（segment 単位）して組み立て、サーバ側は従来どおり decode→検証。
- → 新たな境界を作らないため、既存セキュリティテスト（U1–U12）がそのままカバーする。

---

## 4. 変更対象ファイルと変更内容

### 4.1 `skills/cmux-team/manager/dashboard-files.ts`（主変更）

1. **`DirEntryRow` を変更**: `mtimeIso: string` → `mtimeMs: number | null`（取得失敗時 null、内部保持用）。
2. **`formatLocalMtime(ms: number | null): string` を新設**: ローカルタイム `YYYY-MM-DD HH:mm`、null は `-`（§3.3）。
3. **`listDirEntries`**: `mtimeIso = st.mtime.toISOString()` → `mtimeMs = st.mtimeMs`（stat 失敗時 null）。
4. **`renderDirIndexHtml`（後方互換）**: mtime セルを `escapeHtml(formatLocalMtime(e.mtimeMs))` に。dir index 自体は JSON 化後も `?format` 無しアクセスのフォールバックとして残す（直リンク・既存テストの互換）。配色をダークテーマ化（`INDEX_STYLE` を CSS 変数ベースに差し替え）。
5. **`renderRootIndexHtml` を 2 ペイン shell に差し替え**（`renderFilesShellHtml()` 新設）:
   - 左 `<aside id="tree">`（ツリーコンテナ）+ 右 `<iframe id="view">`。**`iframe` に `sandbox` 属性を付けない**（M3）。
   - inline `<style>`: ダークテーマ（§2.5 の配色を直値で埋め込む。`/files` は SPA の外部 CSS を読まない別経路なので変数定義も shell 内に inline）。
   - inline `<script>`:
     - 起動時 `fetch("/files/?format=json")` で rootKey 描画。
     - ノードクリック: dir なら `fetch("/files/<path>/?format=json")` で子を lazy 展開（取得済みはトグルのみ）、file なら `view.src` を設定 + 選択中ハイライト。
     - `encodeURIComponent` を segment 単位で適用。エスケープは `textContent` 代入で行い innerHTML 文字列連結を避ける（XSS 安全）。
     - `size === null` / `mtimeLocal === null` は `-` 表示（client 側整形ルール、m4）。
   - `<noscript>` フォールバック: 3 rootKey 直リンク（`href="/files/docs/"` 等）を残す（既存 root index assert 維持 + JS 無効ナビ）。
   - 初期 iframe は空 or 案内文。
6. **`handleFilesRequest` を拡張**:
   - 先頭で `const wantJson = url.searchParams.get("format") === "json";`
   - `root_index`: `wantJson` → `{ entries: [{name,isDir:true} for rootKey] }` JSON、else → `renderFilesShellHtml()`。
   - `dir`: `wantJson` → `listDirEntries` を `{ rootKey, relPath, entries:[{name,isDir,size,mtimeLocal}] }` JSON（`?prefix=` も適用。`mtimeLocal = formatLocalMtime(row.mtimeMs)`、`mtimeMs` は JSON に出さない）、else → 従来 `renderDirIndexHtml`。
   - `file` / `bad_request` / `not_found`: 従来どおり（file は wrapper / streaming、`format=json` は無視 = file には JSON モード無し）。
   - JSON response は `baseHeaders + Content-Type: application/json` で返す（新ヘルパ `fileJsonResponse`）。baseHeaders は `dashboard-server.ts` から渡る `/files` 専用 CSP（`frame-ancestors 'self'`）を含む。
7. **`WRAPPER_STYLE` をダークテーマ化**（md wrapper も iframe 内でダークに）: `color:#24292f`→`var(--fg)`相当の直値、`pre/code` 背景 `#f6f8fa`→ダーク（`#1c232c`）、border `#d0d7de`→`#2a313c`、リンク `#0969da`→`#58a6ff`、body 背景もダーク（`#0e1116`）。
8. **`INDEX_STYLE` をダークテーマ化**（後方互換 dir index 用）。

### 4.2 `skills/cmux-team/manager/dashboard-server.ts`（CSP 1 行差し替えのみ。routing 不変）

C1 反映により「変更なし」前提は崩れ、**`/files` 専用 CSP の差し替えのみ**を行う（routing 構造・委譲構造は不変）。

- **`/files` 専用 CSP 定数を追加**する。既存 `CSP_HEADER`（`dashboard-server.ts:111-118`）はそのまま（SPA/API 用 = `frame-ancestors 'none'` 据え置き）。`frame-ancestors` 以外のディレクティブは共通なので、**末尾の `frame-ancestors` だけ差し替えた定数を新設**する:
  ```ts
  // /files 系専用 CSP。右ペイン iframe（同一オリジン /files/<path>）を表示するため
  // frame-ancestors を 'self' に緩める（他オリジンからの埋め込みは引き続き禁止）。
  const FILES_CSP_HEADER = CSP_HEADER.replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
  );
  ```
  （`CSP_HEADER` 末尾が `frame-ancestors 'none'` であることに依存。可読性のため文字列 `replace` で 1 箇所だけ差し替える。`CSP_HEADER` を分割して組み立て直す書き方でも可。実装者は既存定数の構造に合わせる。）
- **`/files` 委譲（`dashboard-server.ts:808-811`）の baseHeaders を差し替える**:
  ```ts
  if (pathname === "/files" || pathname.startsWith("/files/")) {
    return handleFilesRequest(projectRoot, url, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": FILES_CSP_HEADER, // ← CSP_HEADER から差し替え
    });
  }
  ```
- これにより shell（親）も `/files/<path>`（iframe 子文書）も `frame-ancestors 'self'` を背負い、同一オリジン埋め込みが許可される。SPA（`/`）・API（`/api/*`）の response は `CSP_HEADER`（`frame-ancestors 'none'`）のまま。
- routing（`pathname === "/files" || startsWith("/files/")` の分岐）は不変。新 route 登録は不要（`?format=json` は同じ entry point 内で処理）。

### 4.3 `docs/spec/12-web-dashboard.md`

§6 を参照（spec 更新内容）。

### 4.4 変更しないファイル

- `dashboard-web/style.css` / `index.html` / `app.js`（配色の参照のみ。SPA は無関係）。
- `resolveFilePath` 本体（境界ロジック）。
- `CSP_HEADER` 定数自体（SPA/API 用は据え置き。新設するのは `FILES_CSP_HEADER`）。

---

## 5. テスト方針（`dashboard-files.test.ts` + `dashboard-server.test.ts`）

### 5.1 既存テスト維持（壊さない）

- resolver U1–U12 + contentTypeFor: **無変更で通す**（`resolveFilePath` を触らないため）。
- handleFilesRequest 既存（root index リンク / dir escape / breadcrumb / 空 dir / prefix / md wrapper / raw / html serve / 400・404）:
  - **root index テスト（"root index は 3 rootKey へのリンクを含む"）は要調整**。shell HTML 化で `href="/files/docs/"` 直リンクが消える可能性 → shell の `<noscript>` に 3 rootKey 直リンクを残すことで既存 assert を維持しつつ JS 無効でも最低限辿れるようにする（推奨）。
  - dir index 系テストは `?format` 無しアクセス（後方互換 HTML）を検証し続けるため維持。
  - mtime を直接 assert するテストは無いため UTC→ローカル変更で破綻しない。

### 5.2 追加テストケース

| ID | 検証内容 | 場所 |
|---|---|---|
| N1 | `GET /files/?format=json` が 3 rootKey の JSON entries を返す（`docs`/`artifacts`/`output`、isDir:true） | dashboard-files.test.ts |
| N2 | `GET /files/docs/?format=json` が dir entries JSON（sub/ 等）を返す。各 entry に `name`/`isDir`/`size`/`mtimeLocal`（`mtimeMs` は**含まない**） | dashboard-files.test.ts |
| N3 | `?format=json` + `?prefix=task-001-` で前方一致 filter が効く（既存 prefix ロジック流用の回帰） | dashboard-files.test.ts |
| N4 | JSON entries の `mtimeLocal` が **ISO/Z 形式でない**（`/Z$/`・`/T\d/` を含まない、`YYYY-MM-DD HH:mm` パターンに合致）= ローカルタイム検証 | dashboard-files.test.ts |
| N5 | `formatLocalMtime(ms)` 単体: 既知 ms（固定値）→ ローカルタイム整形文字列。Z を含まない。`null` → `-` | dashboard-files.test.ts |
| N6 | `GET /files`（format 無し）が 2 ペイン shell を返す（`id="tree"` と `id="view"`(iframe) を含む、Content-Type text/html） | dashboard-files.test.ts |
| N7 | shell が外部 src を参照しない（inline script/style のみ、body に `http://`/`https://` の外部 src が無い簡易 assert） | dashboard-files.test.ts |
| N8 | shell に `<noscript>` フォールバックの 3 rootKey 直リンクが含まれる（既存 root index assert の後継） | dashboard-files.test.ts |
| N9 | `format=json` でも baseHeaders（`Cache-Control: no-store` / CSP）が付与される | dashboard-files.test.ts |
| N10 | file に `?format=json` を付けても JSON 化せず従来配信（md wrapper / streaming）= file 分岐が format を無視する回帰 | dashboard-files.test.ts |
| N11 | ダークテーマ回帰（軽め）: shell / wrapper の inline style にダーク背景色（`#0e1116` か CSS 変数）を含み、light の `#24292f` 本文色を含まない | dashboard-files.test.ts |
| **N12** | **（M2 反映 / C1 回帰）実 CSP を通る統合経路で `/files`（shell）および `/files/<path>`（iframe 子文書相当、例: 既存 md ファイル）の response の `Content-Security-Policy` に `frame-ancestors 'self'` が含まれ、`frame-ancestors 'none'` を含まないことを assert。あわせて `/`（SPA）/ `/api/*` の response は `frame-ancestors 'none'` のまま据え置きであることも 1 ケースで確認** | **dashboard-server.test.ts** |

> N12 は `dashboard-files.test.ts` の簡易 `BASE_HEADERS`（CSP=`default-src 'self'`）では検出できない（false green）ため、**実 `CSP_HEADER` / `FILES_CSP_HEADER` を通す `dashboard-server.test.ts` 側に置く**こと（M2）。ブラウザ描画自体は headless render が無いため header レベルの回帰で守る。

### 5.3 実行コマンド

```
cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-files.test.ts
cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-server.test.ts   # /files 統合（I 系）+ N12 CSP 回帰
```

（`bun test` 全体実行は禁忌 — CLAUDE.md / A021 参照）

---

## 6. spec 12 (`docs/spec/12-web-dashboard.md`) の更新内容

| 節 | 現状 | 更新内容 |
|---|---|---|
| §8.1 目的 | 1 ペイン read-only ビューワー | 「左ツリー + 右ペイン（iframe）の 2 ペイン構成」「ダークテーマ（SPA と同配色）」を追記 |
| §8.2 URL 規則 | `GET /files/` = root index | `GET /files`(format 無し) = 2 ペイン shell HTML、`GET /files/?format=json` = rootKey 一覧 JSON、`GET /files/<dir>?format=json` = dir entries JSON（lazy load 用）を表に追加。query 節に `?format=json`（dir/root のみ。file は無視）を追記 |
| §8.3 レンダリング | dir = index HTML | 「shell が左ツリー描画、右 iframe が既存 `/files/<path>` 配信を再利用」「dir の `?format=json` は entries JSON（フィールド: `name`/`isDir`/`size`/`mtimeLocal`。mtime はサーバローカルタイム文字列、`mtimeMs` は載せない）」「dir index HTML は `?format` 無し時のフォールバックとして残る」を追記。mtime 表示が**ローカルタイム**である旨を明記 |
| §8.4 セキュリティ | 7 段判定 | 「ツリー lazy load は新 walk を持たず既存 `resolveFilePath`(kind=dir) を再利用、境界を増やさない」を 1 文追記。**「右ペイン iframe は `sandbox` を付けず、隔離は CSP（同一オリジン）+ `resolveFilePath` のパス境界に委ねる」**を追記（M3） |
| §8.5 CSP | self 制約・`frame-ancestors 'none'` | **「`/files` 系 response は専用 CSP（`FILES_CSP_HEADER`）で `frame-ancestors 'self'`（同一オリジン埋め込み許可、他オリジンからの埋め込みは依然禁止）。右ペインは同一オリジン `iframe`。SPA(`/`)/API(`/api/*`) は `frame-ancestors 'none'` 据え置き」**に訂正（C1/m5）。「ツリー JSON は `connect-src 'self'` の `fetch`」も追記。誤った `frame-src` 説明は削除 |
| §表（L235 / L439） | dashboard-files.ts の責務 | 「2 ペイン shell 生成 + dir JSON serialize + ローカルタイム mtime」を責務に追記 |
| 受け入れチェック（L294–295） | sidebar Files リンク | 必要なら「ツリーから任意ファイルを右ペインで開ける」「ダークテーマ」「/files 応答 CSP が `frame-ancestors 'self'`」を追記 |

---

## 7. 受け入れ基準（チェックリスト）

- [ ] `/files` で左ツリーから docs / artifacts / output の任意ファイルを開け、右ペイン（iframe）に内容が表示される
- [ ] ツリーは dir をクリックで展開/折りたたみでき、子は lazy load（`?format=json`）される
- [ ] md は右ペインで従来どおりレンダリング、その他テキスト/画像/html もそのまま表示される
- [ ] 全体がダークテーマで表示される（SPA `style.css` と同配色トーン）。md wrapper（iframe 内）もダーク
- [ ] mtime 表示はすべてサーバのローカルタイム（ISO/Z を出さない）。JSON は `mtimeLocal` のみ（`mtimeMs` を載せない）
- [ ] **`/files` および `/files/<path>` 応答の CSP が `frame-ancestors 'self'`（`'none'` でない）。SPA/API 応答は `frame-ancestors 'none'` 据え置き**（C1/M2）
- [ ] **右 iframe に `sandbox` を付けていない**（md インライン script が動く）（M3）
- [ ] 既存セキュリティテスト（U1–U12）+ contentTypeFor が無変更で通る
- [ ] 新レイアウト/JSON/ローカルタイムの追加テスト（N1–N11）が通る
- [ ] **`dashboard-server.test.ts` の N12（実 CSP 回帰）が通る**
- [ ] `dashboard-server.test.ts` の `/files` 統合テストが通る
- [ ] `resolveFilePath` の境界ロジックに変更を加えていない
- [ ] `dashboard-server.ts` の変更は `/files` 用 CSP の差し替えのみ（routing 構造不変、`CSP_HEADER` 本体不変）
- [ ] ファイル編集/アップロード API を追加していない（read-only 維持）
- [ ] 認証なし・127.0.0.1 限定の前提を変えていない
- [ ] spec 12 §8 を新レイアウト実態に追従更新（CSP 文言含む）

---

## 8. リスク・注意点

1. **既存 root index テストの破壊**: shell 化で `href="/files/docs/"` 直リンクが消えると "3 rootKey へのリンクを含む" テストが失敗する。→ `<noscript>` フォールバック（3 rootKey 直リンク）を shell に必ず含め、assert を維持する。
2. **（C1 解消済み）CSP `frame-ancestors` による iframe ブロック**: 旧 plan は「`frame-ancestors 'none'` は同一オリジン iframe を妨げない」と誤解していた。実際は**子文書（`/files/<path>`）自身の `frame-ancestors 'none'` が同一オリジンを含む全埋め込みを拒否**するため iframe が表示されない。→ §4.2 で `/files` 系 response の CSP を `frame-ancestors 'self'` に緩めて解消（他オリジン埋め込みは引き続き禁止）。検出は N12（実 CSP 統合テスト）で回帰。`frame-src 'self'` 追加は無効なので採らない。
3. **ローカルタイムの決定論性**: `formatLocalMtime` はサーバ TZ 依存。テストは固定 ms + 「Z を含まない / パターン一致」で検証し、絶対値（TZ 依存の時刻）を assert しない（CI TZ 差で flaky 化を避ける）。
4. **lazy fetch の no-store**: 各展開で JSON を都度取得（cache 無効）。軽量 JSON なので問題ないが、巨大 dir（数千 entry）では 1 回の取得が重い → 必要なら `?prefix=` や将来 pagination を検討（本タスクでは out of scope、巨大 dir はそのまま列挙）。
5. **md wrapper のダーク化が iframe 外の直リンクにも影響**: `/files/<x>.md` を直接タブで開いた場合もダークになる（一貫性として許容、むしろ望ましい）。
6. **iframe に sandbox を付けない判断のセキュリティ**: md wrapper のインライン script 実行を妨げないため `sandbox` は付けない（M3）。配信元は `resolveFilePath` のパス境界 + allowlist 内ファイルに限定され、CSP は同一オリジンに閉じる（`default-src 'self'` / 他オリジン埋め込み禁止維持）。read-only・127.0.0.1 限定の前提とあわせ、追加の attack surface は最小。
7. **XSS**: ツリーは client 側で `textContent` 代入 + `encodeURIComponent` href 組み立て（innerHTML 文字列連結を避ける）。JSON entries はサーバが name をそのまま載せるが、client が textContent で受けるため安全。サーバ側 dir index HTML は既存どおり `escapeHtml`。
8. **vendor 依存追加なし**: ツリー UI は素の DOM API で実装（フレームワーク/新 vendor 追加禁止 — spec §9 方針維持）。
9. **iframe と breadcrumb の二重ナビ**: 右 iframe 内にも既存 breadcrumb が出る。shell の左ツリーと併存するが機能重複は許容（混乱を避けるなら iframe 内 breadcrumb を将来削るが、本タスクでは既存 wrapper 構造を保ち scope を絞る）。

---

## 9. 実装着手順（参考）

1. `formatLocalMtime` + `DirEntryRow.mtimeMs` 化 + `listDirEntries` 修正（+ N5 テスト）
2. `handleFilesRequest` に `format=json` 分岐 + `fileJsonResponse`（JSON は `mtimeLocal` のみ）（+ N1–N4, N9, N10 テスト）
3. `dashboard-server.ts` に `FILES_CSP_HEADER` 追加 + `/files` 委譲の CSP 差し替え（+ N12 を dashboard-server.test.ts に追加）
4. `renderFilesShellHtml`（2 ペイン + inline ダーク CSS + ツリー JS + noscript + sandbox なし iframe）で `root_index` を差し替え（+ N6–N8, N11 テスト）
5. `WRAPPER_STYLE` / `INDEX_STYLE` ダークテーマ化
6. `dashboard-files.test.ts` 既存 root index テスト調整、全テスト green 確認
7. spec 12 §8 更新（CSP 文言含む）
