# Plan Revisions (T003 design-review への対応ログ)

design-review.md の Verdict は **Changes Requested**。Critical 1 件 + Important 4 件 +
Minor 3 件 (任意) のうち、**全 8 項目**を反映した。以下に変更点を summary する。

## 反映した指摘

### Critical

| ID | 指摘 | 反映先 | 変更内容 |
|---|---|---|---|
| C-1 | §7.1 R5 / §2.1.1 で `state.version` 確定タイミングの記述が誤り (L1090 ローカル変数と DaemonState フィールドを混同) | §7.1 R5 / §2.1.1 cross-reference 行 | 「`state.version` / `state.startedAt` は **proxy 起動 (L1064) より前**、main.ts:945-947 で確定。L1090 のローカル変数 `version` は startDashboardServer 用の別物」と書き換え |

### Important

| ID | 指摘 | 反映先 | 変更内容 |
|---|---|---|---|
| I-1 | 古い proxy への `/api/identify` は upstream forward されるので 401 / 非 JSON / project_root 欠落の各バリエーションを `kind:unverifiable` テストでカバー | §3.2 | `test.each` で 3 ケース (401 + plain text / 200 + non-JSON binary / 200 + JSON without project_root) を 1 つに集約。実装側にも「200 以外 / JSON parse 失敗 / project_root 非文字列はすべて kind:unverifiable」コメントを残す方針を明記 |
| I-2 | initInfra → 初回 `updateTeamJson` flush 前は `manager.pid` 未設定であり、これが「正常系の skip」であることを spec に明記 | §1.4 / §2.2.3 / §6.1 | §2.2.3 のコメントに「initInfra 直後 / 初回 handleMessage 前は manager は `{}` のまま」を明記。§6.1 docs に「registerSelf cross-check の race skip」セクションを追加 (3 経路を列挙) |
| I-3 | registerSelf テスト戦略 — throw リファクタを「推奨」ではなく「必須」に格上げ | §2.2.3 / §3.4 / §5 / §4 / §8 | (1) §2.2.3 を「`RegisterSelfError` 経由 throw」に確定 (選択肢列挙を消去)、`proxy_port_missing` / `post_failed` / `cross_check_failed` の 3 reason に揃える。(2) 呼び出し側 `cmdSpawnMaster` / `cmdSpawnConductor` で catch → exit 1 する分岐を追加。(3) §3.4 のテストを `expect(...).rejects.toMatchObject(...)` 直接 assert 形式に書き換え (`__test_register_self__` / `runCli` / process.exit モック案を消去)。(4) §5 実装順序の Step 5 冒頭に throw リファクタを位置づけ、commit 分割の推奨も記載。(5) §4 後方互換テーブルに「外部挙動は同じ」を明示。(6) §8 完了条件にリファクタ項目を追加 |
| I-4 | テスト用 fake proxy のクリーンアップで `setTimeout(50ms)` 依存を排除し `await fake.stop(true)` に統一 | §3.1 / §3.2 / §3.3 / §3.4 | 全テスト 4 箇所で `fake.stop()` / `tmp.stop() + setTimeout(50)` を `await fake.stop(true)` / `await tmp.stop(true)` に置換。`try/finally` 構造はそのまま |

### Minor (任意 — 全部反映済み)

| ID | 指摘 | 反映先 | 変更内容 |
|---|---|---|---|
| M-1 | `verifyProxyIdentity` 引数型を `string` / `number` で揃えるか検討 | (未対応) | 既存 `resolveProxyPort` の string 返却契約を尊重し、引数 `port: string` のままとした (テスト中の `String(fake.port)` も維持)。型を広げる変更は別 PR で議論する余地としてここに残す |
| M-2 | `verifyProxyIdentity` 導入後は `resolveProxyPort` の TCP probe を省略可能 | §2.2.2 | 「最適化メモ」を追加: HTTP fetch が TCP connect を含むので TCP probe は省略可能 → ワーストケース 2.5s → 1.5s 短縮。本タスクでは互換重視で既存 `resolveProxyPort` に手を入れず、spec 上の TODO として残す |
| M-3 | proxy.ts の `/api/identify` 配置位置 — fall-through リスクを検出する negative test を追加 | §3.3 / §5 / §8 | proxy.test.ts に「GET /api/identify は upstream に fall-through しない」テストを追加。closure 内 `projectRoot` (= testDir) が必ず一致することを assert することで、`if` 閉じ括弧位置ミスで upstream に流す事故を検出 |

## 反映を見送った指摘

- **M-1 のみ**: 既存の `resolveProxyPort` の string 返却契約と整合させるため見送り。
  plan-revisions.md にメモを残し、将来別 PR で議論する選択肢として明示。

## 主要な変更ハイライト

1. **registerSelf を `RegisterSelfError` throw 経路に統一** — 実装容易性のためではなく、
   テスト信頼性 (CI flakiness 回避) と既存経路 (4xx / proxy_port_missing) との
   一貫性のために必須化。仕様変更なし (exit 1 で死ぬ事実は同じ)。
2. **§3.2 を unverifiable バリエーションテストで強化** — legacy proxy の forward 経路
   (Anthropic 401 / 非 JSON) に対する verify の robustness を担保。
3. **§5 実装順序を 2-phase に明示** — Phase A: throw リファクタ (仕様変更なし、別 commit)
   → Phase B: cross-check 追加 (新仕様、別 commit)。review 粒度を上げる commit 分割を推奨。
4. **§6.1 docs に race skip 説明を追加** — registerSelf cross-check が silent skip される
   3 条件 (team.json 不在 / manager.pid 未設定 / レスポンス JSON 解析失敗) を spec に
   明文化し、運用者・将来の改修者の理解を保つ。

## 次のアクション

- design review L220 の通り、Important 修正後は **再レビュー不要**。Conductor 判断で
  実装着手可。
- 実装時は §5 の 2-phase commit 分割 (リファクタ commit + cross-check commit) を
  遵守する。
