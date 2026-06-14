# Design Review (r2): ファイルビューワー(/files) 2 ペイン + ダークテーマ刷新 (T038)

レビュアー: Design Reviewer Agent（Planner とは独立セッション）
対象 plan: `.team/tasks/038-files-2/runs/task-038-1781456482/plan.md`（改訂版 r2）
裏取りした実コード: `dashboard-server.ts` / `dashboard-files.ts` / `dashboard-files.test.ts` / `dashboard-server.test.ts`

---

## 1. 判定

**Approved**（実装着手可）

前回 Changes Requested で挙げた C1 / M2 / M3 / m4 / m5 はすべて plan r2 で正しく解消されている。各修正は実コードの構造と整合することを再確認した。設計の骨子（A 案 lazy JSON + 既存 `resolveFilePath(kind=dir)` 再利用、iframe で既存配信を再利用、mtime ローカルタイム化）は前回時点で妥当と評価済みで、ブロッカーだった iframe 表示問題が CSP 緩和で正面から解消されたため承認する。残る軽微な提案は §3 に記載（いずれも非ブロッキング）。

---

## 2. 前回指摘の解消確認（実コード照合つき）

### C1 [critical] iframe ブロック → **解消**

- plan r2 §2.1（L42-45）が CSP 解釈を訂正。「子文書 `/files/<path>` 自身の `frame-ancestors 'none'` が同一オリジンを含む全埋め込みを拒否する」「`frame-src 'self'` 追加は無効」を正しく記述。
- §4.2（L189-213）が対応を確定: `/files` 専用 `FILES_CSP_HEADER` を `CSP_HEADER.replace("frame-ancestors 'none'", "frame-ancestors 'self'")` で新設し、`/files` 委譲の baseHeaders を差し替える。
- **実コード照合**:
  - `CSP_HEADER`（`dashboard-server.ts:113-118`）は末尾が `frame-ancestors 'none'`（セミコロンなし・文字列内に 1 回だけ出現）。`.replace(...)` は確実に 1 箇所だけ書き換わる → 方針成立。
  - `/files` 委譲は `dashboard-server.ts:807-810` で `CSP_HEADER` を渡している。`handleFilesRequest` が全 response に baseHeaders を spread する構造なので、ここを `FILES_CSP_HEADER` に差し替えれば shell（親）も `/files/<path>`（iframe 子文書）も `frame-ancestors 'self'` を背負う → iframe 表示可。
  - SPA/API 用に `CSP_HEADER` を渡す他 2 箇所（`dashboard-server.ts:131` / `:140`）は据え置きで `frame-ancestors 'none'` のまま = plan の「SPA/API は 'none' 据え置き」と整合。`CSP_HEADER` 本体も不変（L223）。
- → routing 構造・委譲構造は不変、変更は CSP 1 行差し替えのみ。「dashboard-server.ts 変更なし」前提の崩れも §1 概要・§4.2・§4.4・受け入れ基準に正しく反映済み。

### M2 [major] 単体テストが C1 を検出できない（false green）→ **解消**

- N12（L252）を追加し、**`dashboard-server.test.ts`**（実 CSP を通る統合経路）に配置。`/files`（shell）と `/files/<path>`（iframe 子文書相当）の応答 CSP に `frame-ancestors 'self'` が含まれ `'none'` を含まないこと、かつ `/`・`/api/*` は `'none'` 据え置きを assert する内容。L254 の注記で files.test.ts の簡易 CSP では検出不能な理由も明記。
- **実コード照合**:
  - `dashboard-files.test.ts` の `BASE_HEADERS`（L19-22）は `Content-Security-Policy: "default-src 'self'"` で本物の `frame-ancestors 'none'` を通さない → false green の指摘は正確。
  - `dashboard-server.test.ts` は実サーバを `fetch(${handle.url}/...)` で叩く形式（L38 等）で、既に CSP header を `res.headers.get("Content-Security-Policy")` で assert する前例がある（L52-54）。`/files` 専用 describe block も存在（L439）。→ N12 をここに置けば実 `CSP_HEADER` / `FILES_CSP_HEADER` を確実に通す。配置は妥当。

### M3 [major] iframe sandbox 未確定 → **解消**

- §3.2（L136）に「iframe には `sandbox` を付けない」を明記。理由（md wrapper のインライン script で marked を実行するため素の sandbox では空白化、`allow-scripts allow-same-origin` は実質サンドボックス無効）も正確。前回問題視した「サンドボックス境界が得られる」という誤った利点記述は削除済み（§3.2 末尾は「iframe + CSP 緩和が最小コスト」に置換）。§4.1-5（L171）・受け入れ基準（L289）・リスク#6（L309）にも反映。

### m4 [minor] JSON フィールド不整合 → **解消**

- JSON entry を `mtimeLocal`（整形済み文字列）に一本化、`mtimeMs` は JSON に載せない（内部保持のみ）と統一（L124, L144, L166, L183, L242）。`size` / `mtimeLocal` の null → `-` を client 側整形ルールとして明記（L126-127, L177）。§3.1 / §4.1 / §6 の表記が揃った。

### m5 [minor] spec 文言が C1 と矛盾 → **解消**

- §6 の §8.5 更新案（L275）を「`/files` 系は `FILES_CSP_HEADER` で `frame-ancestors 'self'`（同一オリジン埋め込み許可、他オリジン埋め込みは禁止維持）、SPA/API は 'none' 据え置き」に訂正。誤った `frame-src` 説明の削除も明記。§8.4 更新案（L274）に M3 の sandbox 方針も追記済み。

---

## 3. 残る軽微提案（非ブロッキング・実装時の参考）

1. **N12 実装時の `/api` CSP 既存テストとの整合**: `dashboard-server.test.ts:52` の既存「CSP 4 directive を含む」テストは `/api/health`（= `CSP_HEADER`）を対象としており、`frame-ancestors 'none'` 据え置きで影響なし。N12 で `/api/*` 側を `'none'` と確認するケースを足すなら、この既存テストと重複しない粒度（`/files` 緩和との対比 1 ケース）で十分。
2. **`FILES_CSP_HEADER` の堅牢性メモ（任意）**: `.replace` は `CSP_HEADER` 末尾が `frame-ancestors 'none'` であることに依存する。将来 `CSP_HEADER` の directive 順を変える改修が入った場合に silent に効かなくなる可能性があるため、実装者は plan §4.2 の代替案（分割して組み立て直す）でも可。N12 が回帰で守るので現状の `.replace` で問題はない（必須ではない）。
3. **iframe 初期表示**: plan は「初期 iframe は空 or 案内文」（L179）。空 `src` のままだと一部ブラウザで `about:blank` 由来の見え方になるため、案内文（同一オリジンの軽量 placeholder か `srcdoc` ではなくツリー側のメッセージ表示）で済ませると CSP 追加考慮が不要。スコープ外でよいが実装時に一言判断を。

---

## 4. 承認後の留意（前回 §5 から維持・再確認済み）

- root_index / dir の `wantJson` 分岐は `handleFilesRequest` の resolve 後 switch に足すだけ。`resolveFilePath` 本体・U1–U12 は無変更で通る（境界不変）。
- `/files/?format=json` は query が pathname に含まれず resolver は `root_index` を返す（plan 想定どおり）。
- file への `?format=json` は無視（N10）。md/画像の JSON 化は不要かつ複雑化を招くため正しい。
- ダークテーマ化（`WRAPPER_STYLE` / `INDEX_STYLE` の色値置換）は副作用が閉じており低リスク。直リンクで md を開いてもダークになる点は plan が許容と整理済み。
- テストは `cd skills/cmux-team/manager && bun test --timeout 30000 dashboard-files.test.ts` と `... dashboard-server.test.ts` を個別実行（`bun test` 全体実行は禁忌 — CLAUDE.md / A021）。

以上、実装着手を承認する。
