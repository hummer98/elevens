# 検品結果: Task 015（SUBSTRATE_BINARY default を cmux → c11 に反転）

## 1. 判定

**GO**

plan.md (rev2) / design-review.md (Approved) で要求された全項目（fallback 反転、`resolveSubstrateBinary(env)` / `isC11Backend(env)` の追加、`maybeLogDeprecationNotice` ガード + `getCapabilities` ガードの関数評価化、`IS_C11_BACKEND` 維持、docs / CHANGELOG 更新、cmux backend 想定 test への経路観測 assert 追加）が漏れなく実装されており、テスト / 型 / 衛生のいずれも基準を満たす。

---

## 2. 検証サマリ（実出力ベース）

### テスト個別実行（`bun test --timeout 30000`）

| ファイル | 結果 |
|---|---|
| `cmux.test.ts` | **30 pass / 0 fail / 49 expect()** (856ms) |
| `c11-features.test.ts` | **7 pass / 0 fail / 15 expect()** (1.55s) |
| `mailbox-cli.test.ts` | **11 pass / 0 fail / 32 expect()** (30ms) |
| `main.test.ts` | **275 pass / 0 fail / 753 expect()** (23.62s) |

全ファイル全テスト pass。

### tsc 型チェック (`bunx tsc --noEmit`)

触ったファイル絡みのエラー出力は以下 4 件:

```
c11-features.test.ts(136,14): error TS2722
c11-features.test.ts(180,20): error TS2322
c11-features.ts(248,22):       error TS2345
c11-features.ts(256,49):       error TS2322
```

stash で main 状態 (作業前) でも同じ tsc を回した結果、**同一エラーがすべて pre-existing** であることを確認:

```
(stashed)
c11-features.test.ts(129,14): error TS2722   ← test 行ずれ前 (Task 015 が 7 行追加)
c11-features.test.ts(172,20): error TS2322   ← 同上 (8 行ずれ)
c11-features.ts(246,22):       error TS2345   ← 同上 (2 行ずれ、c11-features.ts:37 import の 1 行差し替えで派生)
c11-features.ts(254,49):       error TS2322   ← 同上
```

エラー型・メッセージ完全一致、行番号差は Task 015 で追加した行数と一致。**Task 015 由来の新規 tsc エラーは 0 件**。

### 手動 smoke (Step 6 相当)

```
# unset ELEVENS_BACKEND
{ s: "c11",  c11: true,  isC11: true  }

# ELEVENS_BACKEND=cmux
{ s: "cmux", c11: false, isC11: false }
```

完了条件 §8 の上 2 項目を実機確認済み。

---

## 3. 観点別チェック結果

### 観点 1: コード正当性 — **pass**

| 確認項目 | 結果 |
|---|---|
| `cmux.ts` の `resolveSubstrateBinary(env)` が `env.ELEVENS_BACKEND?.trim() || "c11"` | ✓ (cmux.ts:15-17) |
| `cmux.ts` の `isC11Backend(env)` が basename 判定 (`resolveSubstrateBinary` 再利用) | ✓ (cmux.ts:88-92) |
| `maybeLogDeprecationNotice` のガードが `isC11Backend(process.env)` 関数評価 | ✓ (cmux.ts:122 `if (isC11Backend(process.env)) return;`) |
| `c11-features.ts:37` のガードが `isC11Backend(process.env)` 関数評価 | ✓ (`if (!isC11Backend(process.env)) return null;`) |
| `IS_C11_BACKEND` const 維持 (撤廃せず) | ✓ (cmux.ts:99) |
| `IS_C11_BACKEND` の参照箇所が `cmux.ts:247` (tree --no-layout) と `main.ts:1054` (daemon log) のみに局在 | ✓ (それ以外の参照は今回の差分で除去) |
| `detectBackendDecision` の refuse ロジックは変更なし | ✓ (差分は `cmux.ts:1-118` 周辺のみ。`detectBackendDecision` 本体 `cmux.ts:42-69` 相当には差分なし) |
| `SUBSTRATE_BINARY` 初期化が `resolveSubstrateBinary(process.env)` 経由 | ✓ (cmux.ts:31) |

### 観点 2: テスト経路観測 — **pass**

- cmux backend 想定 test で `expect(isC11Backend(process.env)).toBe(false)` の明示 assert を確認:
  - `cmux.test.ts` deprecation 通知 describe: 1 箇所 (line 311)
  - `c11-features.test.ts`: 5 箇所 (各 cmux backend 想定 test 冒頭)
  - `mailbox-cli.test.ts`: 8 箇所 (各 cmux backend 想定 test 冒頭)
- これらの assert が pass しているため、関数評価化漏れ・env 注入失敗による「偽 pass (ENOENT catch 経由)」を構造的に排除できている (plan §6 Step 4 の防御が機能)。
- `delete process.env.ELEVENS_BACKEND` → `process.env.ELEVENS_BACKEND = "cmux"` への置換: `c11-features.test.ts` 6 箇所 / `mailbox-cli.test.ts` 8 箇所すべて確認。
- `__resetCapabilitiesCache()` の各 cmux backend test での呼び出しも確認 (`c11-features.ts:36` の cache check がガードより前にあるため必須)。

### 観点 3: tsc 型チェック — **pass**

触ったファイル起因の新規 tsc エラー 0 件 (上記検証サマリ参照)。pre-existing エラー 8 件は無関係。

### 観点 4: docs 整合 — **pass**

| ファイル | plan §4.2 draft 通り更新されているか |
|---|---|
| `README.md:83-84,86` Substrate backend 表 + migration | ✓ (`default since v0.9.0` / `unset ELEVENS_BACKEND`) |
| `README.ja.md:83-84,86` 同上 | ✓ (`v0.9.0 以降デフォルト` / `unset ELEVENS_BACKEND`) |
| `docs/seed.md:121` Phase 1 | ✓ (`✅ ... Phase 1 時点では default cmux`) |
| `docs/seed.md:143` Phase 3 | ✓ (`✅ ... default を c11 に切替（v0.9.0、T015）`) |
| `skills/c11/SKILL.md:9` description | ✓ (`(default since v0.9.0)`) |
| `skills/c11/SKILL.md:17` 本文 | ✓ (`v0.9.0 以降は env 未設定でも c11 が default`) |
| `CHANGELOG.md` §4.3 の entry (Changed / Compatibility) | ✓ ([Unreleased] セクションに Substrate backend default reversed entry + 関数評価化の経緯 + compatibility note の 3 部追加) |
| コード内コメント (`cmux.ts:11-25,107,114-118`) | ✓ (§4.1 draft 通り、JSDoc 化済) |
| `DEPRECATION_NOTICE` メッセージ更新 | ✓ (`no longer the default (v0.9.0+)`) |

横断 grep (`grep -rn "未設定.*cmux\|default.*cmux\|cmux.*default\|v0.3.0"` / 日本語版 `デフォルト.*cmux` も並走) でヒットした項目はすべて (a) 既に更新済みの新文言、(b) 歴史的記述として残すべき箇所 (Phase 1 説明)、(c) 別文脈の `default` (watch / layout / token_pool / fetch / hooks / CMUX_SOCKET_PATH 等) で、**取りこぼしなし**。

### 観点 5: 衛生 — **pass**

- `git status` に意図しないファイル (`package-lock.json` 等) の混入なし。差分は 10 ファイル (plan の予想範囲 + CHANGELOG)。
- `git log` 先頭は `2a08770 chore: release v0.8.2` のまま → **Implementer は未 commit**（Conductor の責務範囲のため正しい）。

---

## 4. Fix Required

なし (GO 判定)。

---

## 5. 残課題・nice-to-have（GO を妨げない範囲）

1. **`cmux.test.ts` の `writeFakeCmux` 修正**: default 反転に伴って `bin/cmux` → `bin/<SUBSTRATE_BASENAME>` に基底名を動的化している (cmux.test.ts:36-44)。plan には未記載の補助修正だが、`runCmux` が `execFile(SUBSTRATE_BINARY, ...)` で呼ぶ以上、env 未設定 (default c11) のテスト harness では必須の対応であり、テスト全 30 件 pass の事実から動作も妥当。Conductor へ "plan 外の補助修正だが必須" として共有のみで OK。
2. **CHANGELOG の `[Unreleased]` セクション**: plan §4.5 で示した「version 二重管理回避」方針通り `[Unreleased]` 配置になっている。release 時に `v0.9.0` へ昇格させる作業は本タスク外。
3. **`c11-features.ts:37` の関数評価化に伴う性能オーバヘッド**: 各呼び出しで env 読み + basename split が走る。`getCapabilities` は cache hit する経路 (line 36) が事前にあるため実害なし。観察箱としての test 経路観測価値とのトレードオフで妥当 (design-review §2 で承認済み)。

以上、Task 015 の実装は GO 判定で Conductor に commit を促せる状態にある。
