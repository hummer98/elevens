# task-005 サマリー — サイドバー throttle 表示から reset 時刻を削除

## 結果

- **ステータス**: 完了（Inspector GO 判定）
- **納品方式**: ローカル ff-only マージ
- **マージ先ブランチ**: `main`
- **マージコミット SHA**: `8edf8282e5a8875c80d6badc8c13683bfd66edf1`

## 完了したサブタスク

1. Phase 3 (Implementer): `daemon.ts` のサイドバー throttle 表示を簡素化
2. Phase 4 (Inspector): GO 判定（指摘事項なし）
3. 完了処理: commit → rebase → ローカルマージ → close-task

## 変更ファイル一覧

- `skills/cmux-team/manager/daemon.ts` (+1 / -22)
- `package-lock.json` (worktree bootstrap 差分のみ)

## 主な変更点

- `computeSidebarStatus` の throttled 分岐から `formatResetRemaining(...)` 呼び出しを削除
- サイドバーの throttle 表示ラベルを `"⏸ throttled"` に固定（reset 残時間を表示しない）
- `daemon.ts` 内のローカル定義 `formatResetRemaining()` 関数本体（18 行）と直前のコメントを削除
- `rate-limit-display.ts` / `proxy.ts` の同名別実装は未変更（TUI ヘッダ / `/rate-limit` ログ用）

## テスト結果

- `bun test --timeout 30000 daemon.test.ts` → 226 pass / 2 skip / 0 fail
- `bun test --timeout 30000 pool-throttle.test.ts` → 31 pass / 0 fail
- `bunx tsc --noEmit` → daemon.ts 起因の新規エラー 0 件

## 範囲外（未変更）

- TUI ヘッダ / Web Dashboard 側の reset 表示
- `rate-limit-display.ts` / `proxy.ts` / `rate-limit-status.ts`
- `isThrottled5h` / `canSelectAnyToken` 等の throttle 判定ロジック

## 関連ファイル

- `impl-result.md` — Implementer 詳細レポート
- `inspect-result.md` — Inspector 検品レポート
