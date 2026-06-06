# task-005 サイドバー throttle 表示の簡素化 — 実装結果

## 概要

`daemon.ts` のサイドバー throttle 表示から reset 残時間表記を取り除き、ラベルを常に
`"⏸ throttled"` に固定。あわせて、それ専用にローカル定義されていた
`formatResetRemaining()` を `daemon.ts` から削除した。

## 変更ファイル一覧

- `skills/cmux-team/manager/daemon.ts` (+1 / -22)

## 削除した関数と削除した行数

| 対象 | 行数（変更前） | 説明 |
|---|---|---|
| `formatResetRemaining()`（daemon.ts ローカル定義） | `daemon.ts:4632-4649`（関数本体 18 行）+ `4631`（コメント 1 行）+ 末尾空行 1 行 = **20 行削除** | dashboard.tsx からのコピーで、`daemon.ts` 内では `computeSidebarStatus` の throttled 分岐からのみ呼ばれていた |
| throttled 分岐内の `const remaining = formatResetRemaining(...)` | `daemon.ts:4696` の **1 行削除** | reset 残時間の動的算出を廃止 |
| throttled 分岐の `label` 三項演算子 | `remaining ? \`⏸ reset ${remaining}\` : "⏸ throttled"` を `"⏸ throttled"` に置換（1 行差替え） | 表記を固定化 |

差分は `git diff --stat`:

```
 skills/cmux-team/manager/daemon.ts | 23 +----------------------
 1 file changed, 1 insertion(+), 22 deletions(-)
```

## 確認したコマンドと結果

### 1. 単体テスト

```
cd skills/cmux-team/manager
bun test --timeout 30000 daemon.test.ts        → 226 pass / 2 skip / 0 fail (791 expect)
bun test --timeout 30000 pool-throttle.test.ts → 31 pass / 0 fail (41 expect)
```

両テスト pass。throttled 分岐を直接検証するテストも regression なし。

### 2. 型チェック (daemon.ts 起因のエラーが増えていないこと)

```
cd skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E '^daemon\.ts'
```

→ 出力なし（**daemon.ts 起因の tsc エラーは 0 件のまま**）。

他ファイル（`c11-features.ts` / `mailbox-cli.ts` / `main.ts` 等）に既存の tsc 警告は
あるが、本タスクの編集範囲外であり、本変更で新規に増えたものではない。

## 範囲外への影響がないことの確認

### `formatResetRemaining` の他の定義はそのまま残っている

`rg -n "formatResetRemaining" --type ts` の結果（編集前）:

```
skills/cmux-team/manager/rate-limit-status.ts:84:  ... コメント中で参照
skills/cmux-team/manager/rate-limit-display.ts:112: const remaining = formatResetRemaining(resetIso, now);
skills/cmux-team/manager/rate-limit-display.ts:120: function formatResetRemaining(resetIso, now): string { ... }
skills/cmux-team/manager/trace-store.ts:734:      ... コメント中で参照
skills/cmux-team/manager/proxy.ts:298:            function formatResetRemaining(resetIso): string { ... }
skills/cmux-team/manager/proxy.ts:586:            const remaining = formatResetRemaining(rawReset5h);
skills/cmux-team/manager/daemon.ts:4632:          function formatResetRemaining(resetIso): string { ... }  ← 今回削除
skills/cmux-team/manager/daemon.ts:4696:          const remaining = formatResetRemaining(...)             ← 今回削除
```

→ `rate-limit-display.ts`（TUI ヘッダ用）と `proxy.ts`（`/rate-limit` ログ用）の
   ローカル定義はそのまま残存。指示書通り。

### export / 外部 import がないことの確認

```
rg -n "export.*formatResetRemaining|import.*formatResetRemaining" --type ts
```

→ 0 件。すべて各ファイル内のローカル定義であり、daemon.ts の削除は他ファイルの
   挙動に一切影響しない（breaking change なし）。

### daemon.ts 内に他の呼び出し箇所がないことの確認

編集後:

```
rg -n "formatResetRemaining" skills/cmux-team/manager/daemon.ts
```

→ 0 件。`computeSidebarStatus` の throttled 分岐以外に daemon.ts 内利用なし
   だったため、削除によるダングリング参照は発生していない。

### 範囲外（指示書の「触らない」セクション）

以下は意図的に未編集:

- `rate-limit-display.ts::formatResetRemaining`（TUI ヘッダ用）
- `proxy.ts::formatResetRemaining`（`/rate-limit` ログ用）
- `rate-limit-status.ts` の reset 情報出力
- Web Dashboard 側の reset 表示
- `isThrottled5h` / `canSelectAnyToken` 等の throttle 判定ロジック
- daemon.ts のその他のリファクタリング

## まとめ

- 変更: `daemon.ts` 1 ファイルのみ、`+1 / -22` 行
- テスト: `daemon.test.ts` / `pool-throttle.test.ts` ともに pass
- 型: daemon.ts 起因の新規 tsc エラー 0 件
- 影響範囲: サイドバー表示のラベルのみ。TUI ヘッダ / `/rate-limit` ログ / Web
  Dashboard / throttle 判定ロジックは未変更。breaking change なし。
