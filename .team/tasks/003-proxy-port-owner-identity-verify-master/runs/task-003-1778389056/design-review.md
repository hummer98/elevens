# Design Review

## Verdict
**Changes Requested**

承認に近いが、実装着手前に修正すべき正確性の問題と、テスト戦略上の補強が必要。
Critical 1 件 (リファクタ前提の整合)、Important 4 件、Minor 3 件。

---

## Strengths

- **後方互換戦略が安全側**: 古い proxy (identify 未実装) を `kind:unverifiable` 扱いにして
  「自分の新 port で起動するだけで相手は kill しない」方針は、cmux-team v0.3.x 系との
  共存を壊さず、孤児 daemon の握る port も奪い返さない。観察箱原則 (state を内部に隠さない)
  とも整合する。
- **timeout / retry の判断根拠が明示**: `1500ms` を `resolveProxyPort` の TCP probe
  (1000ms) と同等オーダーに揃え、retry なしを「孤児 daemon 検出の早さ」を理由に選ぶ
  設計判断が文書化されている。後で運用者がパラメータ変更を判断する材料になる。
- **false positive 回避の skip 条件が網羅的**: registerSelf cross-check で
  「team.json 不在 / `manager.pid` 未設定 / レスポンス JSON parse 失敗」の 3 経路を
  全て skip にしている。初回起動の race と前方互換 (古い proxy) を一気に救う。
- **新ログ ID が分割されている**: `proxy_owner_mismatch` / `proxy_owner_dead` /
  `proxy_owner_unverifiable` / cross-check 失敗で別 ID。retrospective 観察 (`cmux-team metrics`)
  で原因別に集計可能。CLAUDE.md の AI Observatory 原則と整合。
- **schema_version: 1 の予約**: 将来 identify レスポンスを拡張する際に互換切替の余地を残す
  設計。proxy.ts と main.ts の両方が増えるシナリオを意識している。
- **fail-soft / fail-fast の使い分け**: boot 側 (`cmdStart`) は安全側に倒して新 port、
  registerSelf 側は fail-fast で exit 1 と、影響範囲に応じた戦略を分けている。

---

## Findings

### Critical (必ず修正)

#### C-1. プラン §1.4 / §2.2.3 / §3.4 / §7.1 R5 の前提認識を修正

プランは複数箇所で `state.version` の確定タイミングを誤っている。

- §7.1 R5: 「proxy.ts L478 時点で state.version は呼び出し側 main.ts L1090 で
  後設定される」と記述。
- 実コード:
  - `state.version = await loadVersion()` は **main.ts:945**
    (proxy 起動 L1064 より **前**)
  - L1090 のローカル変数 `version` は `startDashboardServer` 用に別途読み込む
    別物 (DaemonState のフィールドではない)

結論として「`getState()` は request 受信時に呼ばれるので OK」というプランの結論は
**正しい**が、根拠がズレている。実装側で proxy.ts の `/api/identify` が
`opts.getState().version` を読むだけで `state.version` は既に確定済みになるため、
plan の R5 を「state.version / state.startedAt は cmdStart の boot 順で proxy 起動 (L1064)
より前 (L945-L947) に確定するため、`getState()` を request 時に呼べば常に値が返る」
に書き換えること。

**修正案**: §7.1 R5 と §2.1.1 の cross-reference 行を「state.version は
main.ts:945 で proxy 起動より前に確定する。proxy 内 closure 経由で参照しても
`undefined` にならない」と訂正する。

---

### Important (修正推奨)

#### I-1. 古い proxy への `/api/identify` リクエストは upstream にフォワードされる

現行 proxy.ts は L734 以降で「GET 分岐に hit しなかったリクエストを Anthropic API に
フォワード」する。古い (T003 未適用) proxy が握る port に新 daemon の
`verifyProxyIdentity` が GET `/api/identify` を投げると、相手 proxy は
**`https://api.anthropic.com/api/identify` にフォワードしてしまう**。

挙動:
- Anthropic 側が 401 (auth missing) / 404 を返す確率が高い
- レスポンスボディに `project_root` フィールドが無い → `kind:unverifiable` 判定で
  期待通り新 port 起動になる

**問題**: テストで偽 proxy を立てる時はこの挙動を再現できないため、§3.2 の
`kind:unverifiable` テストでは「proxy が 401 を返すケース」「proxy が想定外の
JSON を返すケース」「proxy が JSON ですらないバイナリを返すケース」を最低 1 つ
カバーすべき。

**修正案**: §3.2 の追加テストとして以下を入れる:
```typescript
test("verifyProxyIdentity: legacy proxy forwards to Anthropic (401 + non-JSON) → kind:unverifiable", async () => {
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response("Authentication required", {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    }),
  });
  // ...
  expect(result.kind).toBe("unverifiable");
});
```
合わせて `verifyProxyIdentity` の実装で「200 以外 / JSON parse 失敗 / `project_root`
非文字列」を全部 `kind:unverifiable` に集約していることを明示するコメントを残す。

#### I-2. registerSelf の race 条件 — initInfra 直後の team.json 状態を spec に明記

プラン §1.4 は「team.json.manager.pid 未設定の初回起動は skip」としているが、
実コードの初期化順序が plan に書かれていない:

- daemon.ts:829 の initInfra で `manager: {}` (空オブジェクト) で seed
- main.ts の cmdStart は `state.running = true` を立てた後に loop に入る
- updateTeamJson (manager.pid 書き込み) は **handleMessage 後** または定期 flush
  経由で呼ばれる (daemon.ts:4434)

つまり「daemon が proxy 起動 → state.running=true → 最初の handleMessage 呼ばれるまで」
の窓で Master spawn が走ると、`team.json.manager` は `{}` のまま。プランの
`readManagerPidFromTeamJson` は `tj?.manager?.pid` を見て `null` 返却し skip するので
バグにはならないが、これが「正常系の skip」であることを CLAUDE.md / spec で明示する
必要がある。逆にこの窓を狭めるため cmdStart の boot 完了直前に
`updateTeamJson(state)` を 1 度同期 flush する選択肢も検討余地がある。

**修正案**:
- §2.2.3 のコメントに「initInfra 直後 / 初回 handleMessage 前は manager.pid 未設定」
  であることを明記
- §6.1 docs 更新で「registerSelf cross-check は team.json.manager.pid が
  存在する時のみ発火する。初回 race 中は silent skip」を追記
- (任意) cmdStart の proxy 起動直後に `await updateTeamJson(state)` を 1 度呼んで
  `manager.pid` を即座に書き込めば cross-check の発火確率が上がる。これは別タスク
  でも良い

#### I-3. registerSelf テスト戦略 — 「throw → exit 1 リファクタ」を必須に格上げ

プラン §3.4 は `__test_register_self__` 専用 entry / `process.exit` モック /
throw リファクタの 3 案を併記し、最後を「推奨」にしている。実装容易性とテスト
信頼性を考えると、**throw リファクタは推奨ではなく必須**にすべき。

理由:
1. 子プロセス経由 (`runCli`) はプロセス起動コストが高く、CI で flaky になりやすい
2. `process.exit` モックは Bun の test runner で副作用が他テストに漏れる
3. 既存の MASTER_REGISTERED 4xx / proxy-port 不在経路も同じリファクタで
   一貫した throw → catch → exit 1 にできる (仕様変更なし)

**修正案**: §3.4 の選択肢列挙を消し、§2.2.3 のリファクタを以下に確定:
```typescript
// registerSelf 内では throw new RegisterSelfError(reason) のみ
// 呼び出し側 (cmdSpawnMaster / cmdSpawnConductor) で
// try { await registerSelf(...) } catch (e: any) {
//   console.error(e.message); process.exit(1);
// }
```
プラン §5 実装順序の Step 5 にこのリファクタを「最初に行う」こととして組み込む。

#### I-4. テスト用 fake proxy の port 衝突回避とクリーンアップ

§3 の各テストは `Bun.serve({ port: 0 })` で ephemeral port を取るので衝突は起きないが、
`tmp.stop()` 後の TCP 解放を `setTimeout(50ms)` で待つ §3.2 の方法は flaky になりうる。
Bun の `serve.stop()` は `await` 可能なので明示的に `await tmp.stop()` するか、
`net.connect` で再試行ロジックを書くべき。

**修正案**: §3.2 のテストを以下に変更:
```typescript
const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
const port = tmp.port;
await tmp.stop(true); // close active connections too
const result = await verifyProxyIdentity(String(port), "/dummy");
expect(result).toMatchObject({ kind: "dead" });
```

加えて全テストで `try/finally` の `fake.stop()` を `await fake.stop(true)` に統一し、
テスト間で port が leak しないようにする。

---

### Minor (任意)

#### M-1. `verifyProxyIdentity` の引数型を `number` に揃える

プランは引数を `port: string` にしているが、内部で `parseInt(existingProxyPort, 10)` し
直したり、Bun.serve の `tmp.port` (number) を `String()` で変換したりしている。
`resolveProxyPort` が string を返す既存契約に合わせるなら `string` のままで構わないが、
`fetch` URL を組む時は `${port}` で number でも動く。引数を `string | number` に
広げるか、`number` 一本にして呼び出し側で parse させる方が型としてきれい。

#### M-2. `previousProxyPort` と `existingProxyPort` の重複読み

main.ts:1043-1050 で `.team/proxy-port` を 2 回読んでいる (一度 `previousProxyPort` のため、
一度 `resolveProxyPort` 経由で alive チェック)。プラン §2.2.2 はこの重複に触れていない。
`verifyProxyIdentity` 導入後は `resolveProxyPort` の TCP probe (1000ms) + identify HTTP
(1500ms) で計 2.5s の boot 遅延がワーストケース。`verifyProxyIdentity` 内で TCP probe
+ HTTP identify を 1 度の HTTP fetch にまとめれば 1.5s に短縮できる (HTTP fetch 自体が
TCP connect を含むので、TCP probe をスキップしても dead 判定は kind:dead で得られる)。
別 PR でも良いので spec の最適化候補としてメモを残すこと。

#### M-3. proxy.ts の `/api/identify` 配置位置 — fall-through リスク

§2.1.1 は GET 分岐の最後 (`/rate-limit` 直後) に置く方針だが、proxy.ts の現行実装は
GET 分岐内の if 連鎖で「該当しなければ fall-through で upstream へ転送」する構造
(proxy.ts:600 の `}` 後)。new endpoint を追加する際は `if (url.pathname === "/api/identify")`
の閉じ括弧位置を間違えると Anthropic API に転送される事故が起きる。
実装時に `proxy.test.ts` で「GET /api/identify が upstream に転送されない」テスト
(upstream を mock せずに 200 が返ることを assert) を確実に入れる。

---

## Recommendations

Planner が次に修正すべき点:

1. **§7.1 R5 の事実誤認を修正**: state.version / state.startedAt は main.ts:945-947
   (proxy 起動より前) で確定する旨に書き換える (Critical C-1)。
2. **§3.2 unverifiable テストを追加**: 401 / 非 JSON / project_root 欠落の 3 ケース
   を 1 つに集約したテストを最低 1 ケース追加 (Important I-1)。
3. **§2.2.3 を throw リファクタ確定に修正**: 選択肢列挙を消し、registerSelf を
   `throw RegisterSelfError` に統一。呼び出し側 (cmdSpawnMaster /
   cmdSpawnConductor) で catch → exit 1 する分岐を追加 (Important I-3)。
4. **§5 実装順序を更新**: throw リファクタを Step 5 の **冒頭** に位置づけ、
   既存 4xx / proxy-port 不在経路も同じ throw 経路に揃えること (Important I-3)。
5. **§3 全テストで `await fake.stop(true)` に統一**: port leak と setTimeout(50ms)
   依存を排除 (Important I-4)。
6. **§6.1 docs 更新に race skip の説明を追加**: 初回起動 race で cross-check が
   silent skip されることを明示 (Important I-2)。
7. (任意) §2.2.2 で `verifyProxyIdentity` 導入後は `resolveProxyPort` の TCP probe を
   省略可能であることをメモとして残す (Minor M-2)。
8. (任意) proxy.test.ts に「GET /api/identify が upstream に fall-through しない」
   negative test を追加 (Minor M-3)。

これらを反映した plan で再レビュー不要 (Important 修正後は Conductor 判断で実装着手可)。
ただし I-3 のリファクタは仕様変更ではないが影響範囲が広いので、commit を分けて
レビュー粒度を上げることを推奨する。
