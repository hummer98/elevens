# 結果サマリー: ファイルビューワー(/files) 2 ペイン + ダークテーマ刷新 (T038)

## 完了したサブタスク

- Phase 1 (Plan): `plan.md`(r2) — A案 lazy JSON endpoint(`?format=json`) + 既存 `resolveFilePath(kind=dir)`/`listDirEntries` 再利用、右ペイン iframe で既存 `/files/<rootKey>/<relpath>` 配信を再利用、mtime ローカルタイム化、`/files` 専用 CSP 緩和
- Phase 2 (Design Review): r1 Changes Requested(C1 critical 他) → r2 **Approved**（`design-review.md`）
- Phase 3 (TDD Implementation): plan r2 に沿って実装（`inspection.md` 条件1〜8 ✓）
- Phase 4 (Inspection): **GO**（`inspection.md`、軽微提案のみ非ブロッキング）

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/dashboard-files.ts` | +188/-39 — `renderFilesShellHtml()`(2ペイン shell)、`?format=json` 分岐、`formatLocalMtime()`、`DirEntryRow.mtimeIso`→`mtimeMs`、`WRAPPER_STYLE`/`INDEX_STYLE` ダーク化 |
| `skills/cmux-team/manager/dashboard-server.ts` | +12 — `FILES_CSP_HEADER`(frame-ancestors 'self') 新設、`/files` 委譲の baseHeaders 差し替え（SPA/API は 'none' 据え置き） |
| `skills/cmux-team/manager/dashboard-files.test.ts` | +103 — N1〜N11 |
| `skills/cmux-team/manager/dashboard-server.test.ts` | +17 — N12（実 CSP 経路で frame-ancestors 'self' を assert） |
| `docs/spec/12-web-dashboard.md` | +48 — §4/§8.1〜8.5 を 2ペイン・ダークテーマ・format=json・FILES_CSP_HEADER に追従更新 |

> `package-lock.json` の差分(0.13.0→0.14.1)は worktree base が古いことによる lockfile churn であり本タスクと無関係のため `git checkout` で除外した。

## 完了条件の検証証明（Conductor が commit 前に実行）

| 完了条件 | 検証方法 | 結果 |
|---|---|---|
| 1. ツリーから docs/artifacts/output を開き右ペイン表示 | N1(rootKey JSON)/N2(dir entries JSON)/N6(shell に `id="tree"`+`<iframe id="view"`) | pass |
| 2. ダークテーマ表示 | N11(shell/wrapper に `#0e1116`、light 色 `#24292f` 無し) | pass |
| 3. mtime ローカルタイム表示 | N5(`/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/`、Z/T 無し、null→`-`)/N4(JSON mtimeLocal が非 ISO) | pass |
| 4. 既存セキュリティ境界を壊さない | Inspector が diff の全 hunk が L164 以降に限られ `resolveFilePath`(L42)/`contentTypeFor`(L148) 無変更を確認。dir JSON 化も既存 resolve 結果+`listDirEntries` 再利用で新 walk 無し | 不変 |
| 5. 既存(U1〜U12)+新(N1〜N12)テストが通る | `bun test dashboard-files.test.ts` → **39 pass / 0 fail**、`bun test dashboard-server.test.ts` → **41 pass / 0 fail**（Conductor 再実行） | pass |
| 6. spec 12 を実態に追従更新 | Inspector が §4/§8.1〜8.5 の更新を確認 | 更新済 |
| 7. read-only 維持 / 認証なし・127.0.0.1 限定 | Inspector が POST/PUT/DELETE/writeFile 皆無、新 route 無し、bind/認証変更無しを確認。「POST /files → 404」テスト継続 pass | 不変 |
| 8. C1 反映(/files CSP=frame-ancestors 'self'、SPA/API 'none' 据え置き、iframe に sandbox 無し) | N12(shell・子文書とも 'self'、`/api/health` は 'none') pass、iframe sandbox 属性無し | pass |
| (補) touch ファイルの tsc | `bunx tsc --noEmit \| grep dashboard` → エラー無し（Conductor 再実行） | clean |

不変制約（やってはいけないこと）の違反なし: セキュリティ境界・read-only・認証なし/127.0.0.1 限定 すべて維持を確認済み。

## 軽微残課題（Inspector §4、非ブロッキング・スコープ外）

- iframe 初期表示は `src` 未設定（`about:blank`）。ツリー初期描画はあるため UX 上の致命性なし。
- `FILES_CSP_HEADER` の `.replace` は `CSP_HEADER` 末尾が `frame-ancestors 'none'` であることに依存するが、N12 が回帰で守る。

## 納品

- 納品方式: ローカル ff-only マージ（conductor overlay に Integrator 運用の記載なし）
- マージコミット: （後段で記録）
