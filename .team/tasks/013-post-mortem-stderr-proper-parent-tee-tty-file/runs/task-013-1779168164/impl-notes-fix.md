# impl-notes-fix (round 2: Inspector Major 指摘の修正)

## 修正内容

`post-mortem-redirect.smoke.test.ts` L59 / L96 の `expect(exitCode).toBe(42|0)` を non-null assertion (`expect(exitCode!).toBe(...)`) に変更。Inspector の修正案 (1) を採用。

理由: `child.on("exit", ...)` 完了後の assertion で `exitCode` は確定済みなので test の意図を最も素直に表現でき、副作用が最小（型宣言の変更や generic 指定が不要）。

## 検証

- `bunx tsc --noEmit` で smoke.test.ts の TS2769: 0 件
- `bun test post-mortem-redirect.smoke.test.ts`: 2 pass / 0 fail
- regression check (`post-mortem-redirect.test.ts` + `reload.test.ts` 合算): 38 pass / 0 fail
