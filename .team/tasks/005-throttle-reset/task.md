---
id: 005
title: サイドバー throttle 表示から reset 時刻を削除
priority: medium
created_by: surface:267
created_at: 2026-05-11T07:55:41.901Z
---

## タスク
## 背景

c11 サイドバーに `⏸ reset 2h22m` のような throttle 表示が出る。これは Manager daemon の `updateSidebarStatus()` → `cmux.setStatus(SIDEBAR_STATUS_KEY=...)` が送信している。

ユーザーからの指摘: **reset 時刻はサイドバーに表示する意味がない**。同じ情報は Web Dashboard の Metrics ページや TUI ヘッダ (`rate-limit-display.ts`) で確認できる。さらにサイドバーで表示している `remaining` の値は `state.rateLimit?.unified5hReset`（最後に inference を返した単一アカウントの reset header）由来なので、pool モードでは "pool 全体の next-available reset" を反映しない誤情報になりがち。

## 変更内容

`skills/cmux-team/manager/daemon.ts` でサイドバー throttle 表示を簡素化する。

### 削除する/変更する箇所

1. **`computeSidebarStatus` の throttled 分岐**（`daemon.ts:4695-4703` 付近）
   - `const remaining = formatResetRemaining(...)` の呼び出しを削除
   - `label` を **常に `"⏸ throttled"`** に固定（三項演算子を除去）

2. **`formatResetRemaining()` 関数本体**（`daemon.ts:4632-4649`）
   - daemon.ts 内ローカル定義なので削除可能
   - 同名関数は `rate-limit-display.ts` / `proxy.ts` にも別実装で存在するが、それらは TUI ヘッダ / `/rate-limit` ログ用なので**残す**（影響範囲を取り違えないこと）

3. **コメント整理**
   - `daemon.ts:4631` の "dashboard.tsx からコピー — daemon.ts が React/Ink モジュールに依存しないようにする" コメントも合わせて削除

### 残すもの（明示的に変更しない）

- `rate-limit-display.ts::formatResetRemaining`（TUI ヘッダ用）
- `proxy.ts::formatResetRemaining`（`/rate-limit` ログ用）
- `rate-limit-status.ts` の reset 情報出力
- Web Dashboard の reset 表示
- `formatResetRemaining` 自体の export や他箇所利用は無いので breaking change にはならないことを確認

## 確認手順

1. `cd skills/cmux-team/manager && bun test --timeout 30000 daemon.test.ts`（throttle 関連テストが通ること）
2. `cd skills/cmux-team/manager && bun test --timeout 30000 pool-throttle.test.ts`
3. 実際に throttle 状態を再現して c11 サイドバーが `⏸ throttled` のみになることを目視確認（任意）
4. TUI ヘッダ / Web Dashboard 側で reset 時刻が引き続き表示されることを目視確認

## 範囲外

- TUI ヘッダや Web Dashboard 側の reset 表示は今回触らない
- throttle 判定ロジック（`isThrottled5h` / `canSelectAnyToken`）は変更しない — あくまでサイドバーラベルの表現だけを変える

## 参考

- Master ↔ ユーザー会話で「reset 時刻はサイドバー表示には不要、Metrics ページか TUI ヘッダで見れば良い」と合意済み
