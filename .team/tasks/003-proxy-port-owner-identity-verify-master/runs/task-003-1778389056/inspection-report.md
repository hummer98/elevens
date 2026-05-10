# Inspection Report

## Verdict
**GO**

plan.md の §1〜§8 の完了条件と design-review.md の Critical / Important 修正、Minor 反映 (M-1 を除く) はすべて実装に取り込まれている。テスト 548 pass / 0 fail、tsc 新規エラー 0 (既存の `sleepPrevention` 1 件のみで、本タスク変更による位置シフト)。納品可。

---

## 要件カバレッジ

### plan §1 設計判断 (上流)

| 項目 | 場所 | 結果 |
|---|---|---|
| §1.1 GET /api/identify エンドポイント (5 フィールド + schema_version:1) | `proxy.ts:606-615` | ✅ project_root / daemon_pid / version / started_at / schema_version すべて返却 |
| §1.1 独立 proxy モード (`getState` 未指定) でも project_root を返せる | `proxy.ts:607` `state = opts?.getState?.()` | ✅ オプショナル参照で fallback |
| §1.2 HTTP timeout 1500ms / no retry | `main.ts:2028` `AbortSignal.timeout(1500)` | ✅ |
| §1.3 後方互換: 404 / refused / timeout / 欠落を unverifiable に集約 | `main.ts:2030-2049` | ✅ 4 経路すべて kind:unverifiable に倒す |
| §1.4 cross-check 発火条件 (manager.pid 未設定は skip) | `main.ts:readManagerPidFromTeamJson` | ✅ `null` 返却で skip |

### plan §2 実装ステップ

| 項目 | 場所 | 結果 |
|---|---|---|
| §2.1.1 GET /api/identify を `/rate-limit` 直後に追加 | `proxy.ts:606-615` (`/rate-limit` ハンドラの直後、GET 分岐内) | ✅ 配置・閉じ括弧位置正しい |
| §2.1.2 /api/messages レスポンスに `daemon_pid: process.pid` | `proxy.ts:748-751` | ✅ 全 message type で常に付与 |
| §2.1.2 daemon.ts の MASTER/CONDUCTOR_REGISTERED に cross-reference コメント | `daemon.ts:2047-2049` / `daemon.ts:2129-2131` | ✅ 1 行コメント追加 |
| §2.2.1 verifyProxyIdentity ヘルパー追加 + 4 戻り値型 | `main.ts:2008-2052` (`ProxyIdentityVerifyResult`) | ✅ ok / mismatch / dead / unverifiable の 4 種類を網羅 |
| §2.2.2 cmdStart の proxy 起動分岐に identify verify 統合 | `main.ts:1077-1102` | ✅ proxy_owner_mismatch / dead / unverifiable の warn ログ + reuseExisting フラグで分岐 |
| §2.2.3 registerSelf を RegisterSelfError throw 経路にリファクタ | `main.ts:RegisterSelfError class (179-184)` + `registerSelf (2126-2222)` | ✅ proxy_port_missing / post_failed / cross_check_failed の 3 reason |
| §2.2.3 cmdSpawnConductor / cmdLaunchMaster で catch → exit 1 | `main.ts:3122-3131` (Conductor) / `main.ts:3226-3235` (Master) | ✅ `console.error(e.detail ?? e.message)` + `process.exit(1)` |
| §2.2.3 readManagerPidFromTeamJson 新設 (silent skip 条件 4 つ) | `main.ts:2104-2113` | ✅ 不在 / parse 失敗 / 未設定 / number でない を全て null 化 |

### plan §3 テスト

| ケース | 場所 | 結果 |
|---|---|---|
| §3.1 A: project_root mismatch → kind:mismatch | `proxy-identity.test.ts:21-48` | ✅ otherProjectRoot / otherDaemonPid を assert |
| §3.2 B: no listener → kind:dead | `proxy-identity.test.ts:51-57` (`await tmp.stop(true)`) | ✅ setTimeout 依存排除 (I-4 対応) |
| §3.2 unverifiable バリエーション 3 種 (I-1) | `proxy-identity.test.ts:64-113` | ✅ 401 plain text / 200 non-JSON binary / 200 JSON without project_root を 3 独立 test として実装 |
| §3.3 C: same project_root → ok | `proxy-identity.test.ts:116-144` | ✅ projectRoot / daemonPid / version も assert |
| §3.3 proxy.test.ts GET /api/identify 期待 JSON | `proxy.test.ts:241-261` | ✅ 5 フィールド完全一致 + content-type も assert |
| §3.3 (M-3) proxy.test.ts upstream に fall-through しない | `proxy.test.ts:268-281` | ✅ 自前 endpoint で終端していることを negative test で確認 |
| §3.4 D: registerSelf cross-check (mismatch → throw) | `main.test.ts:1997-2028` | ✅ `RegisterSelfError(cross_check_failed)` を rejects assertion |
| §3.4 cross-check error の detail 内容 | `main.test.ts:2030-2062` | ✅ "cross-check failed" / ".team/proxy-port" を含むことを assert |
| §3.4 一致 → 正常 return | `main.test.ts:2064-2090` | ✅ resolves.toBeUndefined |
| §3.4 manager.pid 未設定 → skip (race 正常系) | `main.test.ts:2092-2120` | ✅ 不一致でも skip で成功する false-positive 回避を test |
| §3.4 既存 proxy_port_missing throw 経路 | `main.test.ts:2122-2135` | ✅ throw リファクタ後の挙動を locked-in |
| §3.4 既存 4xx post_failed throw 経路 | `main.test.ts:2137-2161` | ✅ 同上 |

### plan §4 後方互換 / §5 docs

| 項目 | 場所 | 結果 |
|---|---|---|
| 旧 daemon (identify 未実装) と通信 → kind:unverifiable で fail-soft | `main.ts:verifyProxyIdentity` の 200 以外 / parse 失敗 / project_root 欠落集約 + 単体テスト 3 種 | ✅ 旧 owner kill しない方針も `cmdStart` で守られている |
| `/api/messages` レスポンスに daemon_pid 追加 (前方互換) | `proxy.ts:748-751` (古いクライアントは無視するだけ) | ✅ |
| docs/spec/05-install-and-infrastructure.md (identify endpoint / proxy_owner_mismatch / race skip) | `05-install-and-infrastructure.md:255 / 257-258 / 293-308` | ✅ プロキシサーバー節更新 + registerSelf cross-check + 初回起動 race の独立節追加 |

### plan §6 構造的正しさ

| 項目 | 結果 |
|---|---|
| throw リファクタが既存 4xx / proxy_port_missing 経路にも適用 | ✅ `main.ts:2138-2150` (proxy_port_missing) / `main.ts:2168-2186` (post_failed) で `RegisterSelfError` throw に統一 |
| 仕様変更なし (exit 1 で死ぬ事実は同じ) | ✅ 呼び出し側 (`cmdSpawnConductor` / `cmdLaunchMaster`) で catch → `console.error` → `process.exit(1)`。stderr 出力も従来通り |

### plan §7 ズレの妥当性

| ズレ | 妥当性 | 根拠 |
|---|---|---|
| 関数引数 object 化 (`{ role, surface, sessionId?, projectRoot? }`) | ✅ 妥当 | テストで `projectRoot` 差し替え必要。本番経路は default の `PROJECT_ROOT` で挙動同一 |
| test.each → 独立 test 3 つ展開 | ✅ 妥当 | summary に「Bun の test.each で 5 回中 1 回 flaky」と根拠記載。期待挙動 (kind:unverifiable 集約) は plan と等価 |
| getState 未設定テスト削除 | ✅ 妥当 | plan §3.3 要件は「getState あり」のみ。本番経路 (cmdStart) では常に getState を渡すため要件未充足にはならない |
| M-2 最適化 (resolveProxyPort TCP probe 省略) 見送り | ✅ 妥当 | plan §2.2.2 の「最適化メモ」自体に互換重視で別 PR と明記 |
| commit 分割見送り | ✅ 妥当 | Conductor が完了処理時に commit する設計上、Implementer 側で commit を作らない。コードレベルの状態としては Phase A/B が 1 つの worktree に同居 |

---

## Findings

### Critical / Fix Required
なし。

### Important
なし。

### Minor / Notes

- **N-1**: `verifyProxyIdentity` の catch は `unused variable e` を 2 箇所 (kind:dead / json_parse_failed) で受けているが、戻り値の `reason` フィールドに `e?.message` を含めていない。dead は接続失敗、parse 失敗は body 不正と用途は明確なので debugging には支障ないが、network glitch 詳細を後追いしたい場合に raw error message を保持していると便利 (将来余裕があれば `reason: \`fetch_failed:${e.message}\`` 等に拡張する余地)。本タスクのスコープ外で対応見送りで OK。
- **N-2**: `proxy.ts:606-615` の `/api/identify` ハンドラは `state?.version ?? null` で fallback しているが、独立 proxy モード (`getState` 未指定) のケースは proxy.test.ts では cover されていない (Implementer が summary に「getState 未設定テストは flaky で削除」と記載済)。本番経路では常に getState が渡されるため要件未充足ではないが、独立 proxy モード自体の使用想定があるならば後続タスクで integration test を入れたい。
- **N-3**: cmdStart の proxy 起動直後に `await updateTeamJson(state)` を 1 度同期 flush すれば cross-check race window を狭められる旨は docs/spec/05 / main.ts の readManagerPidFromTeamJson docstring の双方に「本タスクのスコープ外」として明記されており、TODO として漏れなく残っている。
- **N-4**: M-2 (resolveProxyPort TCP probe 省略 → 1.5s 短縮) は main.ts の cmdStart コメントに「最適化メモ」として明記されている。別タスク化推奨。
- **N-5**: plan §3.4 では cross_check_failed assert と detail 検証を 1 テストに統合する想定だったが、実装では別 test に分かれている。粒度が細かくなっただけで要件は満たす (むしろテスト failure の原因が判別しやすい)。

---

## Verification

### bun test 結果

```
$ bun test --timeout 30000 proxy-identity.test.ts
 6 pass / 0 fail / 6 expect() calls / Ran 6 tests across 1 file. [213ms]

$ bun test --timeout 30000 proxy.test.ts
 62 pass / 0 fail / 246 expect() calls / Ran 62 tests across 1 file. [4.13s]

$ bun test --timeout 30000 main.test.ts
 265 pass / 0 fail / 724 expect() calls / Ran 265 tests across 1 file. [31.99s]

$ bun test --timeout 30000 daemon.test.ts
 215 pass / 2 skip / 0 fail / 751 expect() calls / Ran 217 tests across 1 file. [9.00s]
```

合計 548 pass / 2 skip / 0 fail。

### tsc 結果

```
$ bunx tsc --noEmit
... (c11-features.test.ts / c11-features.ts / mailbox-cli.ts: 既存エラー)
main.ts(974,7): error TS2322: Type 'string' is not assignable to type 'boolean'.
```

baseline 検証: `git stash` 後 `bunx tsc --noEmit` で `main.ts(956,7)` に同一型エラーを確認。本タスクで追加された RegisterSelfError class / verifyProxyIdentity / readManagerPidFromTeamJson の 18 行で位置がシフトしただけで、**新規エラー 0 件**。c11-features / mailbox-cli のエラーも本タスクと無関係 (Implementer の主張と一致)。

### コード品質チェック

- 空 catch: なし。`verifyProxyIdentity` の catch は適切に typed result を返却。`readManagerPidFromTeamJson` は意図的に null fallback (silent skip 仕様) でコメントあり。`registerSelf` の `res.clone().json()` catch も silent skip 仕様。
- 外部コマンド失敗時の detail: `RegisterSelfError` の detail に messageType / status / surface / fetch error message を含む。
- ガードレール: `bus.emit` / `eventBus` 直接呼び出しなし、`saveTaskState` / `taskState[...]=` 直書きなし。proxy.ts は `notifyStateChanged` を使用 (既存方針継続)。

---

## Recommendation

**GO で commit / 納品可。** 以下を留意点として残す:

1. **commit 分割の推奨** — plan §5 に従い「Phase A (RegisterSelfError throw リファクタ + 4xx/proxy_port_missing 経路の throw 化)」と「Phase B (verifyProxyIdentity + cross-check 追加)」を別 commit に分けると review 粒度が上がる。本タスクでは Conductor が完了処理時に commit するため、Implementer 側での分割は見送られている (妥当)。Conductor 側で git diff を確認して可能であれば 2 commit に分割するのが理想だが、必須ではない。
2. **既存 sleepPrevention 型エラー** (main.ts:974) は本タスク変更前から存在 (位置シフトしただけ)。別タスクで修正対象。
3. **M-2 最適化** (resolveProxyPort TCP probe 省略 → boot 1s 短縮) は spec / コードコメントに TODO として残されている。別 PR で対応推奨。
4. **race window 縮小案** (cmdStart の proxy 起動直後に `updateTeamJson` 同期 flush) も docs/spec/05 に「T003 のスコープ外」として記録済。実運用で `manager.pid` 未設定の cross-check skip 頻度を観測したくなったら別タスクで対応。
5. **整合性**: `manager.log` の新ログ ID 4 種 (`proxy_owner_mismatch` / `proxy_owner_dead` / `proxy_owner_unverifiable` / cross-check 由来 `RegisterSelfError`) は CLAUDE.md の AI Observatory 原則に整合。retrospective 観察 (`cmux-team metrics`) で原因別集計が可能。
