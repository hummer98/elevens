---
id: 007
title: artifact 一覧のデフォルト並び順を最新を上に
priority: low
created_by: surface:267
created_at: 2026-05-12T06:00:06.574Z
---

## タスク
## 背景

`elevens artifacts` CLI および TUI dashboard の artifacts タブで、artifact のデフォルト並び順が「古いものが上」になっている。アーティファクトは新しいものを参照する頻度が圧倒的に高いので、デフォルトを反転して「最新を上に」したい。

## 変更内容

### 1. CLI: `elevens artifacts` のデフォルトを降順に

`skills/cmux-team/manager/main.ts:6413-6419` の sort 部分:

```ts
// 現状
const sortBy = getArg("sort") || "created";
filtered.sort((a, b) => {
  const aVal = sortBy === "updated" ? (a.updated || a.created) : a.created;
  const bVal = sortBy === "updated" ? (b.updated || b.created) : b.created;
  return aVal.localeCompare(bVal);   // ← 昇順
});
```

`return bVal.localeCompare(aVal);` に変える（降順 = 最新が上）。

`--sort created` / `--sort updated` どちらも降順になる。これは元から両方とも同じ向きだったので一貫性を崩さない。

### 2. TUI dashboard: artifacts タブのデフォルト (`id` 順) を降順に

`skills/cmux-team/manager/dashboard.tsx:1180-1183`:

```ts
} else {
  // id 順（デフォルト）
  list.sort((a, b) => a.id.localeCompare(b.id));   // ← 昇順 (A001→A045)
}
```

`b.id.localeCompare(a.id)` に変える。artifact 番号は採番順に増えるので、id 降順 ＝ 最新採番分が上。

`created` / `updated` 軸は既に降順（`b.created.localeCompare(a.created)`）なので touch 不要。

### 3. テスト

- `main.ts` 側: 既存テストで artifact list の順序を assert しているものがあれば更新（無ければ追加）
- `dashboard.tsx` 側: dashboard-chord / keymap 系テストの fixture (`artifactSort: "id"`) は変えないが、`getFilteredArtifacts` の id 順 assert を変えるテストがあれば降順に更新

## 確認手順

1. `cd skills/cmux-team/manager && bun test --timeout 30000 artifact.test.ts main-artifacts.test.ts dashboard-chord.test.ts dashboard-keymap.test.ts` (該当 test ファイルだけ。`bun test` 全体実行は禁止 — CLAUDE.md 参照)
2. 実機: `elevens artifacts` で A045 が一番上、A001 が一番下になることを確認
3. 実機: TUI dashboard の artifacts タブで最新採番が一番上に来ることを確認

## 範囲外

- sort モードの追加（asc/desc トグル）は今回は入れない
- Web Dashboard 側に同様の表示があればついでに揃える程度（cycle-sort UI には触らない）

## 補足

最新を見るのが圧倒的多数というユーザーフィードバックに基づく。降順を逆にしたい advanced ユースケースが出てきたら、`--sort created:asc` のようなオプション拡張を別タスクで検討する。
