# T007: artifact 一覧のデフォルト並び順を最新を上に

## 完了したサブタスク

- CLI `elevens artifacts` のデフォルト sort を降順に変更（main.ts:6418）
- TUI dashboard artifacts タブの id 順デフォルトを降順に変更（dashboard.tsx:1182）

## 変更ファイル

- `skills/cmux-team/manager/main.ts` (+1/-1): `aVal.localeCompare(bVal)` → `bVal.localeCompare(aVal)`
- `skills/cmux-team/manager/dashboard.tsx` (+1/-1): `a.id.localeCompare(b.id)` → `b.id.localeCompare(a.id)`

`created` / `updated` 軸の dashboard sort は既に降順だったので touch していない。

## テスト・検証結果

- `bun test --timeout 30000 artifact.test.ts dashboard-chord.test.ts dashboard-keymap.test.ts` → **36 pass / 0 fail**
  - `main-artifacts.test.ts` はリポジトリに存在せず（タスク本文に列挙されていたが想定外）
  - 既存テストで `getFilteredArtifacts` の id 順 sort 結果を assert しているものは無く、テスト側の更新は不要だった
- `bunx tsc --noEmit`（manager ディレクトリ）→ 既存エラー 8 件（main.ts:975, c11-features.ts/test.ts, mailbox-cli.ts）。**今回 touch した行（6418, 1182）に関連する新規エラーは 0 件**

## 範囲外として残した変更

- worktree の `package-lock.json` が分岐時点で 0.5.0 のままで、Agent が `npm install` を実行した結果 0.6.0 に更新されていたが、本タスクの artifact 順序変更とは無関係なため revert した。lock の v0.5.0/v0.6.0 不整合は main 側にも存在しており別タスクで扱うべき

## マージコミット

- branch `task-007-1778565612/task` を `main` に fast-forward merge
- merge SHA: `532cd49`
- merged into: `main`
