# 検品結果: ファイルビューワー(/files) 2 ペイン + ダークテーマ刷新 (T038)

検品者: Inspector Agent（Implementer とは独立セッション）
対象 diff（main 比）: `dashboard-files.ts` / `dashboard-server.ts` / `dashboard-files.test.ts` / `dashboard-server.test.ts` / `docs/spec/12-web-dashboard.md`
承認済み計画: `plan.md`（r2） / レビュー: `design-review.md`（Approved）

---

## 1. 判定

**GO** — 全完了条件（1〜8）を満たす。軽微提案のみ §4 に記載（いずれも非ブロッキング）。

---

## 2. 完了条件ごとの検証結果

### 条件1: 2 ペイン構成（#tree + iframe#view、format=json ツリー、iframe src = /files/<path>） — ✓

- `renderFilesShellHtml()` が `<aside id="tree">` + `<main id="viewpane"><iframe id="view" title="file view">` を返す（`dashboard-files.ts` shell）。
- `handleFilesRequest` の `root_index`/`dir` 分岐に `wantJson = url.searchParams.get("format") === "json"` を追加。root_index→rootKey JSON、dir→`{ rootKey, relPath, entries }` JSON。
- SHELL_SCRIPT が起動時 `/files/?format=json` を fetch、dir クリックで `/files/<segs>/?format=json` を lazy fetch、file クリックで `view.src = "/files/" + enc(segs)` を設定。
- 根拠テスト: N1（rootKey JSON）✓ / N2（dir entries JSON）✓ / N6（shell に `id="tree"` と `<iframe id="view"`）✓ — いずれも pass。

### 条件2: ダークテーマ（shell / WRAPPER_STYLE / INDEX_STYLE） — ✓

- `SHELL_STYLE`: `:root` に `--bg:#0e1116` 等を定義しダーク配色。
- `WRAPPER_STYLE`: body `color:#d4d8df;background:#0e1116`、pre/code `#1c232c`、border `#2a313c`、link `#58a6ff` にダーク化。
- `INDEX_STYLE`: body `color:#d4d8df;background:#0e1116`、border `#2a313c`、link `#58a6ff` にダーク化。
- light 本文色 `#24292f` / `#f6f8fa` / `#0969da` / `#d0d7de` / `#57606a` は `dashboard-files.ts` から完全に除去（grep で NONE 確認）。
- 根拠テスト: N11（shell / wrapper に `#0e1116` を含み `#24292f` を含まない）✓ pass。

### 条件3: mtime はサーバローカルタイム（UTC/Z 付き ISO を出さない） — ✓

- `formatLocalMtime(ms)` 新設: `getFullYear/getMonth/getDate/getHours/getMinutes`（ローカルタイム）をゼロ埋め連結し `YYYY-MM-DD HH:mm` を生成。`toISOString()` は不使用。`ms === null` → `-`。
- `DirEntryRow.mtimeIso: string` → `mtimeMs: number | null`（`st.mtimeMs`）に変更。JSON へは `mtimeLocal`（整形済み文字列）のみ載せ `mtimeMs` は出さない。`renderDirIndexHtml` も `formatLocalMtime(e.mtimeMs)` 経由。
- 根拠テスト: N5（`/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/`、Z/T を含まない、null→`-`）✓ / N4（JSON entry の mtimeLocal が非 ISO）✓ pass。

### 条件4: 既存セキュリティ境界を壊していない（resolveFilePath 本体不変） — ✓

- diff の全 hunk は L164（escapeHtml）以降に限られる（`@@ -164,...` 〜 `@@ -349,...`）。`resolveFilePath`（L42）・`contentTypeFor`（L148）はどの hunk にも含まれず**無変更**。
- 7 段境界（decodeURIComponent / 制御文字・区切り拒否 / dot segment 拒否 / rootKey 辞書引き / join backstop / lstat→realpath / stat）に差分なし。
- dir JSON 化も `r.absPath`（resolveFilePath の結果）+ 既存 `listDirEntries` を再利用し、新 walk を実装していない（境界を増やさない）。

### 条件5: 既存テスト（U1〜U12）+ 新テスト（N1〜N12）が通る — ✓

- `bun test dashboard-files.test.ts` → **39 pass / 0 fail**（U1–U12 + 既存 handleFilesRequest 群 + N1–N11）。
- `bun test dashboard-server.test.ts` → **41 pass / 0 fail**（/files 統合 I 系 + N12）。
- N12 は実 `CSP_HEADER` / `FILES_CSP_HEADER` を通す `dashboard-server.test.ts` に配置（M2 false green 回避）。

### 条件6: spec 12 が実態に追従更新 — ✓

- §4 endpoint 表に `?format=json` 追記。§8.1 に 2 ペイン/ダークテーマ追記。§8.2 URL 表に shell / rootKey JSON / dir JSON / フォールバック index を追加。§8.3 にレンダリング詳細（mtimeLocal フィールド・mtimeMs 非掲載・ローカルタイム）追記。§8.4 に lazy load の境界再利用 + iframe sandbox なし方針。§8.5 を `FILES_CSP_HEADER`（frame-ancestors 'self'）/ SPA・API 据え置きに訂正。責務表・実装/テスト参照も T038 反映。

### 条件7: read-only 維持 / 認証なし・127.0.0.1 限定の前提不変 — ✓

- `dashboard-files.ts` に POST/PUT/DELETE/writeFile/unlink/method 判定は皆無（grep で NONE）。追加 API は `fileJsonResponse`（GET の serialize 先のみ）。
- `dashboard-server.ts` の変更は CSP 定数追加 + 委譲 1 行差し替えのみで routing 不変。新 route なし。bind アドレス/認証に関する変更なし。
- 既存テスト「POST /files → 404」も pass 継続。

### 条件8: C1 反映（/files CSP = frame-ancestors 'self'、SPA/API 'none' 据え置き、iframe に sandbox なし） — ✓

- `FILES_CSP_HEADER = CSP_HEADER.replace("frame-ancestors 'none'", "frame-ancestors 'self'")` を新設。`/files` 委譲の baseHeaders を `FILES_CSP_HEADER` に差し替え。`CSP_HEADER` 本体不変、SPA(`/`)/API(`/api/*`) は 'none' のまま。
- iframe は `<iframe id="view" title="file view">` で **sandbox 属性なし**（M3）。
- tsc: `bunx tsc --noEmit` で dashboard-files / dashboard-server に型エラーなし。
- 根拠テスト: N12（shell・/files/<path> 子文書ともに `frame-ancestors 'self'` を含み `'none'` を含まない、`/api/health` は `'none'` 据え置き）✓ pass。

---

## 3. テスト出力の要点

```
dashboard-files.test.ts:  39 pass / 0 fail / 121 expect()   [28ms]
dashboard-server.test.ts: 41 pass / 0 fail / 138 expect()   [424ms]
bunx tsc --noEmit (dashboard-files|dashboard-server): エラーなし
```

---

## 4. 補足（軽微提案・非ブロッキング）

1. **iframe 初期表示**: design-review §3-3 で言及された「初期 iframe の placeholder」は未対応で `src` 未設定（`about:blank`）。スコープ外で問題なし。ツリー初期描画はあるため UX 上の致命性はない。
2. **`FILES_CSP_HEADER` の `.replace` 依存**: `CSP_HEADER` 末尾が `frame-ancestors 'none'` であることに依存。将来 directive 順変更時に silent fail の可能性があるが、N12 が回帰で守るため現状問題なし（design-review §3-2 と同旨）。
3. N12 が `/api/*` 側の `'none'` 据え置きまで 1 ケースで確認しており、C1 の回帰防御として十分。
