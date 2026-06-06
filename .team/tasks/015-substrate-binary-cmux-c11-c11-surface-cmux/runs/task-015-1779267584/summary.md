# Task 015 結果サマリー

## タスク
`SUBSTRATE_BINARY` のデフォルトを `cmux` → `c11` に反転。c11 surface 上で cmux バイナリを叩く実機障害（Agent spawn の無言失敗）を解消し、c11-first 方針（v0.4.0+）と整合させる。

## 採用方針
**案 A'**（plan rev2 / design-review Approved）:
- fallback 文字列を `"cmux"` → `"c11"` に反転
- pure 関数 `resolveSubstrateBinary(env)` / `isC11Backend(env)` を追加（test 可能化）
- `maybeLogDeprecationNotice` ガード（cmux.ts）と `getCapabilities` ガード（c11-features.ts）を `isC11Backend(process.env)` の**関数評価**に切替（module-load-time 定数だと test の env 注入が効かない構造的欠陥を回避。design-review rev1 の最重要指摘）
- `IS_C11_BACKEND` const は撤廃せず、runtime 不変の参照箇所（`tree --no-layout` / `daemon_started` log）のためにのみ維持
- `detectBackendDecision` の refuse ロジックは不変（タスク制約）

## 完了したサブタスク
- Phase 1 Plan（plan.md rev2、2 往復で Approved）
- Phase 2 Design Review（Approved）
- Phase 3 Implementation（TDD: RED → GREEN、コア 5 ファイル + docs 5 ファイル）
- Phase 4 Inspection（**GO**、独立検証で全テスト pass / tsc 新規エラー 0 / docs 整合）

## 変更ファイル（10 件）
| ファイル | 内容 |
|---|---|
| `skills/cmux-team/manager/cmux.ts` | `resolveSubstrateBinary` / `isC11Backend` 追加、fallback 反転、deprecation 通知ガード関数評価化、DEPRECATION_NOTICE 文言更新、JSDoc コメント更新 |
| `skills/cmux-team/manager/c11-features.ts` | `getCapabilities` ガードを `isC11Backend(process.env)` に |
| `skills/cmux-team/manager/cmux.test.ts` | `resolveSubstrateBinary`/`isC11Backend` 新規テスト、deprecation harness の env 注入 + 経路観測 assert、`writeFakeCmux` の basename 動的化 |
| `skills/cmux-team/manager/c11-features.test.ts` | env 注入（`delete` → `= "cmux"` 6 箇所）+ `__resetCapabilitiesCache()` + 経路観測 assert 5 箇所 |
| `skills/cmux-team/manager/mailbox-cli.test.ts` | env 注入 8 箇所 + 経路観測 assert |
| `README.md` / `README.ja.md` | backend 表（c11/cmux 行）+ migration 案内を「v0.9.0 以降 default は c11」に |
| `docs/seed.md` | Phase 1 / Phase 3 記述を完了マーク化 |
| `skills/c11/SKILL.md` | default 言及更新 |
| `CHANGELOG.md` | `[Unreleased]` に Changed / Compatibility entry 追加 |

## テスト結果（Inspector 独立実行）
| ファイル | 結果 |
|---|---|
| `cmux.test.ts` | 30 pass / 0 fail |
| `c11-features.test.ts` | 7 pass / 0 fail |
| `mailbox-cli.test.ts` | 11 pass / 0 fail |
| `main.test.ts` | 275 pass / 0 fail |

tsc: 触ったファイル起因の新規エラー 0 件（既存 4 件は stash 比較で pre-existing 確認）。
手動 smoke: unset → c11 / `=cmux` → cmux を実機確認。

## 完了条件の充足
- [x] `ELEVENS_BACKEND` 未設定時に c11 が選択される
- [x] `ELEVENS_BACKEND=cmux` で cmux に opt-in（後方互換）
- [x] 既存テスト pass（cmux 前提テストは backend 明示注入に修正）
- [x] docs / コメントの「未設定で cmux」記述を更新

## 補足（plan 外の必須補助修正）
- `cmux.test.ts` の `writeFakeCmux` を default 反転に合わせて `bin/cmux` → `bin/<SUBSTRATE_BASENAME>` に動的化。`runCmux` が `execFile(SUBSTRATE_BINARY, ...)` で呼ぶため env 未設定（default c11）の harness では必須。plan 未記載だが Inspector が妥当性を確認済み。

## 残課題（GO を妨げない）
- CHANGELOG の `[Unreleased]` → `v0.9.0` 昇格は release 時作業（本タスク外）。

## 納品
ローカル ff-only マージ（main）。マージコミット SHA は close-task で記録。
