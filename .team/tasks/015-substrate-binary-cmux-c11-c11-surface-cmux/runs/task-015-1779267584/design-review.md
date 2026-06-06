# Design Review: plan.md (Task 015) — rev2 再レビュー

## 判定
**Approved**

## 評価サマリ
前回 Changes Requested で挙げた致命的欠陥（getCapabilities ガードの module-load-time 定数依存により cmux backend 想定 test が偽 pass / 真 fail に陥る問題）が、Recommendations 案 1（`isC11Backend(env)` pure 関数の導入 + getCapabilities ガードの関数評価化）の採用により構造的に解消された。指摘 1〜5 すべてが過不足なく plan.md (rev2) に反映されている。新たに導入した「2 箇所だけ関数評価化、2 箇所は module-load-time 定数維持」の区分にも論理破れは無く、実コード（`c11-features.ts` の cache check がガードより前に来る構造）まで正確に踏まえている。実装フェーズに進める品質と判断する。

## 前回指摘の反映状況

### 指摘 1（最重要）: getCapabilities ガードの関数評価化 — **反映済み**
- `isC11Backend(env: NodeJS.ProcessEnv = process.env): boolean` を pure 関数として §0(line 14) / Step 2(line 292-296) で追加定義。`resolveSubstrateBinary` を内部で再利用し basename 判定する実装案も明示。
- `maybeLogDeprecationNotice` (cmux.ts:100) と `getCapabilities` (c11-features.ts:37) の **両方**を関数評価化する旨を §0(line 15) / §1.2(line 70-72) / §2.2(line 105,107) / Step 3-a,3-b(line 307-317) で一貫して記述。
- `IS_C11_BACKEND` const は `cmux.ts:247`(tree --no-layout) / `main.ts:1054`(daemon log) でのみ維持と §0(line 16) / §2.2(line 106,108) / §7(line 375) で明示。
- 「触る箇所 / 触らない箇所」の区分基準を §1.2(line 75) / §5.1(line 266-270) で「test 経路観測のために env 注入を機能させる必要があるか」として論理化。
- `__resetCapabilitiesCache()` の必要性を §3.2(line 166) / Step 3-d(line 325) で明記。**実コード照合で確認**: `c11-features.ts:36` の cache check (`if (capsFetched && cachedCaps) return cachedCaps;`) がガード (line 37) より前にあるため、cache reset は env 切替を機能させる前提条件として本当に必要。plan の記述は正確。

### 指摘 2: GREEN 確認に経路観測 assert — **反映済み**
- cmux backend test が `isC11Backend(process.env) === false` で動いていることを明示 assert する方針を Step 3-c(line 321) / 3-d(line 326) / 3-e(line 330) で各 test ファイルに追加。
- Step 4(line 341-344) に「GREEN 確認の防御」節を新設し、置換漏れ（関数評価化漏れ）があれば assert で確実に検出 → 偽 pass を構造的に排除する旨を明記。§8(line 391) の完了条件にも組み込み。

### 指摘 3: docs 文言の具体 draft — **反映済み**
- §4.1（コード内コメント / メッセージ）と §4.2（docs）を「現状 → 変更後（具体 draft）」の対比表に再構成。
- SKILL.md:9 description (line 219) / SKILL.md:17 (line 220) / README.md:83-90 (line 211-213) / README.ja.md:83-90 (line 214-216) / docs/seed.md:121,143 (line 217-218) を 1 行ずつ draft 化。「予定 → 済み」の具体文言が揃った。
- version 二重管理回避の指針を §4.5 に分離し、具体バージョン番号は CHANGELOG に集約・他文書は「v0.9.0 以降」止まりにする方針を draft に具現化。

### 指摘 4: CHANGELOG entry — **反映済み**
- §4.3(line 232) に「getCapabilities ガード / deprecation 通知ガードを `isC11Backend(process.env)` 関数評価化（推奨案 1 採用、Design Review T015 で確定）」の entry を追加。なぜこの 2 箇所だけ関数評価化したかの経緯（他参照は module-load-time 定数維持）も同 entry に記録され、後続 maintainer が追跡可能。

### 指摘 5: CLAUDE.md 確認を §4 チェックリスト化 — **反映済み**
- §4.4 に grep コマンド（`ELEVENS_BACKEND` / `SUBSTRATE` / `default.*cmux` を CLAUDE.md / docs / README / SKILL.md 横断）を新設。既知の予測（CLAUDE.md 本体に default 値の明示記述は無い）と、万一残存時の対応方針も記載。Step 5(line 355) / §8(line 397) の完了条件にも組み込み。

## 残課題（あれば）
いずれも実装を妨げない nice-to-have。Approved を保留する理由にはならない。

1. **§4.1 のコメント draft 内の `\n *` リテラル**: markdown 表セル内表記のため、Implementer は実装時に実際の改行 + JSDoc 継続行へ展開する必要がある。表セルという媒体の都合であり意図は明確だが、機械的にコピペしないよう実装時に留意。
2. **version `v0.9.0` の確定タイミング**: package.json 現値 0.8.2 からの推測。plan 自身が §4.2(line 222) / §4.5(line 255) で「release 時に再 grep / 再確認」と明記済みなので運用でカバーされる。
3. **`cmux.ts:247` tree --no-layout を「触らない」根拠**: 「runtime で env 切替を想定しない」を根拠としているが、当該経路を env 注入で評価する test が無いことの裏付けも grep 網羅（§2.2）でカバーされている。一貫性に問題は無い。

## 総評
rev2 は前回指摘の核心（テスト側の env 注入が module-load-time 定数に届かない構造的欠陥）を、最小スコープを保ったまま正しく閉じた。「export const `IS_C11_BACKEND` を撤廃せず、test 経路観測が必要な 2 箇所のガードだけ `isC11Backend(env)` 関数評価に切り替える」という折衷は、波及 12+ 箇所の破壊的リファクタ（案 B）を避けつつ、観察箱原則（test が狙った経路を通っているか観測可能）を満たす設計判断として筋が通っている。区分基準・偽 pass / 真 fail の構造説明・dynamic re-import が効かない事実も実コードと整合する。docs draft・CHANGELOG・grep チェックリスト・経路観測 assert がすべて完了条件（§8）に落とし込まれており、Implementer が揺れずに実行できる状態。実装フェーズへ進めてよい。
