# Task 017 minor 対応 impl notes

検品 (GO) で出た minor 指摘 2 件 (M1 / M2) への対応記録。production code (cmux.ts / main.ts / i18n.ts) は無変更。

## 変更内容

### M2: `cmux.test.ts` の prefix collision テスト差別化力強化（commit 対象）

`skills/cmux-team/manager/cmux.test.ts` の「1 行に複数 surface が同居していても完全一致のみ拾う」テストを書き換え。

**旧（差別化力なし）**: pane:5 1 つに `surface:26 surface:2` を同居させる配置 — `line.includes("surface:2")` でも `surfaceMatches.includes("surface:2")` でも同じ pane:5 を返すため、pre-fix / post-fix で結果が変わらず TDD 整合性証明にならない。

**新（pre-fix 赤・post-fix 緑）**: 先行 pane:5 に collision 源 `surface:26 surface:99`、後続 pane:6 に target `surface:2 surface:31` を置く配置。

- pre-fix (`line.includes`): pane:5 行の `"...surface:26 surface:99"` に `"surface:2"` が部分一致 → 誤 pane:5 を返す → 赤
- post-fix (完全一致): pane:5 行は `surface:26 / surface:99` のみ抽出 → continue、pane:6 行で `surface:2` 完全一致 → pane:6 → 緑

同時に「同居行の positive 検証」も保つため、`getPaneForSurface("surface:31", "workspace:1")` → `pane:6` を併せて assert（pane:6 の同居行から完全一致で `surface:31` を拾えること）。これで「同行同居でも完全一致のみ」というテストの本来の意図はそのまま、prefix collision 検出力だけ追加された。

### M1: `impl-notes.md` の tsc baseline 記述補正（commit 対象外）

`impl-notes.md` 検証節 L87 を補正。

**旧**: 「baseline で既に存在する `main.ts:1043 sleepPrevention` の 1 件のみ」
**新**: 「baseline に既存エラー 8 件あり: `c11-features.test.ts` ×2 / `c11-features.ts` ×2 / `mailbox-cli.ts` ×3 / `main.ts:1043 sleepPrevention` ×1。いずれも T017 変更箇所 (`cmux.ts` / `cmux.test.ts` / `main.ts:3577` 付近 / `i18n.ts`) とは無関係。T017 による新規エラーは 0」

実機の `bunx tsc --noEmit` 出力で 8 件すべて確認済み。

## 検証結果

### M2: stash 赤化テスト（最重要）

production code 3 ファイル (`cmux.ts` / `main.ts` / `i18n.ts`) を `git stash` で退避して `cmux.test.ts` を実行 → **7 fail**（うち書き換えた M2 テストは「Expected `pane:6` / Received `pane:5`」で赤化）。他 6 件 (test1 / test2 / newSurface 系 4 件) は inspection.md 時点と同様の赤化を踏襲。

```
(fail) ... > 1 行に複数 surface が同居していても完全一致のみ拾う (prefix collision は別 pane の同居行) [0.99ms]
expect(received).toBe(expected)
Expected: "pane:6"
Received: "pane:5"
```

`git stash pop` で本体修正を完全復元 (`Dropped refs/stash@{0}`)、復元後の `git diff --stat` で 3 ファイルが元の数値 (`cmux.ts +36 / i18n.ts ±4 / main.ts +14`) と一致することを確認。

### 全体テスト pass

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
 38 pass
 0 fail
 63 expect() calls
Ran 38 tests across 1 file. [5.92s]
```

検品時の 38 pass / 62 expect() から **expect() を 1 件 (+1) 追加** （surface:31 → pane:6 の同居行 positive 検証）。

### tsc 新規エラー 0

```
$ bunx tsc --noEmit
c11-features.test.ts(138,14) / (180,20)
c11-features.ts(268,22) / (276,49)
mailbox-cli.ts(29,9) / (30,20) / (44,23)
main.ts(1043,7)
```

baseline 8 件と完全一致、新規エラー 0。M1 補正後の記述の通り。

### production code 無変更

```
skills/cmux-team/manager/cmux.ts | 36 ++++++++++++++++++++++++++++-----
skills/cmux-team/manager/i18n.ts |  4 ++--
skills/cmux-team/manager/main.ts | 14 +++++++++++++-
```

inspection.md L101 / impl-notes.md L99 の数値と完全一致。本 minor 対応で production code には一切触れていない。

## 完了条件チェック

| # | 条件 | 結果 |
|---|---|---|
| 1 | M2 テストが pre-fix 赤・post-fix 緑になる配置に書き換わっている (stash 検証で実証) | ✅ stash 退避時に「Expected pane:6 / Received pane:5」で赤化を実機確認 |
| 2 | cmux.test.ts 全 pass | ✅ 38 pass / 0 fail |
| 3 | production code (cmux.ts / main.ts / i18n.ts) は無変更 | ✅ git diff --stat の数値が元と一致 |
| 4 | impl-notes.md の tsc 記述が正確に補正されている | ✅ baseline 8 件の内訳を明記 |

## 作業境界遵守

- production code (cmux.ts / main.ts / i18n.ts) — 触らず
- plan.md スコープ外 — 触らず
- commit — 実施せず（Conductor が行う）
