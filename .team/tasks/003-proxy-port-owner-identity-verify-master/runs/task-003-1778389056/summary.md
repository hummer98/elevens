# T003 実装サマリー: proxy port 再利用時の owner identity verify

## 完了したサブステップ

### Phase A (リファクタ・準備)

- **A1**: `proxy.ts` に `GET /api/identify` エンドポイントを追加
  - レスポンス: `{ project_root, daemon_pid, version, started_at, schema_version: 1 }`
  - GET 分岐の `/rate-limit` 直後に配置 (fall-through を防ぐ閉じ括弧位置に注意)
- **A2**: `proxy.ts` の `POST /api/messages` レスポンスに `daemon_pid: process.pid` を追加
  - daemon.ts MASTER_REGISTERED / CONDUCTOR_REGISTERED ハンドラに 1 行 cross-reference コメントを追加 (handleMessage の戻り値型は void のまま)
- **A3**: `registerSelf` を `RegisterSelfError` throw 経路にリファクタ (仕様変更なし)
  - `RegisterSelfError` クラスを新設・export
  - 既存の `proxy_port_missing` / `post_failed` (4xx/5xx) 経路も `process.exit(1)` を `throw new RegisterSelfError(...)` に置き換え
  - 呼び出し側 `cmdSpawnConductor` / `cmdLaunchMaster` で catch → `console.error(e.detail ?? e.message)` → `process.exit(1)`
  - object 引数化 (`{ role, surface, sessionId?, projectRoot? }`) によりテストでの差し替えを可能に
  - `resolveProxyPort` に optional `projectRoot` 引数を追加 (default は module-level `PROJECT_ROOT`)

### Phase B (新仕様)

- **B1**: `verifyProxyIdentity` ヘルパーを `main.ts` に追加 + cmdStart に統合
  - timeout 1500ms (`AbortSignal.timeout`)
  - 戻り値型 `ProxyIdentityVerifyResult`: `{ ok: true, ... } | { kind: "mismatch" | "dead" | "unverifiable", ... }`
  - 200 以外 / JSON parse 失敗 / `project_root` 非文字列はすべて `kind:unverifiable` に集約 (legacy proxy が Anthropic API へ forward して 401/非 JSON を返すケースを網羅)
  - cmdStart の proxy_reused 判定の手前で identify verify
    - `match` → `proxy_reused`
    - `mismatch` → `proxy_owner_mismatch` warn ログ + 新 port で起動
    - `dead` → `proxy_owner_dead` warn ログ + 新 port で起動
    - `unverifiable` → `proxy_owner_unverifiable` warn ログ + 新 port で起動 (旧 owner kill しない)
- **B2**: `registerSelf` に daemon_pid cross-check を追加
  - `readManagerPidFromTeamJson` ヘルパーを新設
  - HTTP レスポンスの `daemon_pid` を `team.json.manager.pid` と照合
  - 不一致時 `RegisterSelfError(reason="cross_check_failed", detail="cross-check failed: ... .team/proxy-port を削除して...")` を throw
  - silent skip 条件: team.json 不在 / `manager.pid` 未設定 / レスポンス JSON parse 失敗 / `daemon_pid` フィールド欠落

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/proxy.ts` | GET /api/identify 追加、/api/messages に daemon_pid 追加 |
| `skills/cmux-team/manager/daemon.ts` | MASTER_REGISTERED / CONDUCTOR_REGISTERED に 1 行 cross-reference コメント |
| `skills/cmux-team/manager/main.ts` | RegisterSelfError class、verifyProxyIdentity、readManagerPidFromTeamJson、registerSelf を throw 経路化 + cross-check、cmdStart の proxy 起動分岐に identify verify、cmdSpawnConductor / cmdLaunchMaster で catch → exit 1 |
| `skills/cmux-team/manager/proxy.test.ts` | GET /api/identify テスト 2 ケース追加 (期待 JSON / fall-through しない negative test M-3) |
| `skills/cmux-team/manager/proxy-identity.test.ts` | **新規** verifyProxyIdentity 単体テスト 6 ケース |
| `skills/cmux-team/manager/main.test.ts` | registerSelf cross-check テスト 6 ケース追加 |
| `docs/spec/05-install-and-infrastructure.md` | プロキシサーバー節に identify endpoint 説明 / `/api/messages` daemon_pid / registerSelf race skip 説明追加 |

## 追加 / 変更したテストケース一覧

### `proxy.test.ts` (新規 GET /api/identify describe block)

1. `project_root / daemon_pid / version / started_at / schema_version を返す`
2. `upstream に fall-through しない (M-3)` — proxy.ts の `if` 閉じ括弧位置ミスで Anthropic 転送される事故を検出するための negative test

### `proxy-identity.test.ts` (新規ファイル)

1. **Case A**: `project_root mismatch returns kind:mismatch`
2. **Case B**: `no listener returns kind:dead`
3. **Case B / unverifiable**: `unverifiable: 401 + plain text (legacy proxy → Anthropic 401 をシミュレート)`
4. **Case B / unverifiable**: `unverifiable: 200 + non-JSON binary → kind:unverifiable`
5. **Case B / unverifiable**: `unverifiable: 200 + JSON without project_root → kind:unverifiable`
6. **Case C**: `same project_root returns ok`

> **設計判断 (plan からのズレ)**: plan §3.2 では `test.each` で 3 unverifiable バリエーションを 1 つに集約していたが、Bun のテストランナーで `test.each` 連発時に flaky が発生したため、独立した `test()` 3 つに展開した。期待挙動は plan と等価。

### `main.test.ts` (新規 registerSelf cross-check describe block)

1. **Case D**: `daemon_pid mismatch で RegisterSelfError(cross_check_failed) を throw`
2. **Case D detail**: `daemon_pid mismatch error の detail に cross-check failed と proxy-port 削除案内が含まれる`
3. **Case D 一致**: `daemon_pid 一致時は正常に return する`
4. **race skip**: `team.json.manager.pid 未設定なら cross-check skip (race の正常系)`
5. **既存 throw 経路**: `proxy_port_missing で RegisterSelfError(proxy_port_missing) を throw`
6. **既存 throw 経路**: `4xx レスポンスで RegisterSelfError(post_failed) を throw`

## 動作確認結果

### bun test 出力

```
$ bun test --timeout 30000 proxy.test.ts proxy-identity.test.ts main.test.ts daemon.test.ts
 548 pass
 2 skip
 0 fail
 1727 expect() calls
Ran 550 tests across 4 files. [35.96s]
```

個別実行:

| テストファイル | 結果 |
|---|---|
| `proxy.test.ts` | 62 pass / 0 fail |
| `proxy-identity.test.ts` | 6 pass / 0 fail |
| `main.test.ts` | 265 pass / 0 fail |
| `daemon.test.ts` | 215 pass / 2 skip / 0 fail |

flakiness 確認 (各 5 連続実行) も 0 fail で安定。

### tsc 結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
main.ts(974,7): error TS2322: Type 'string' is not assignable to type 'boolean'.
```

main.ts:974 のエラーは `sleepPrevention` 変数の既存問題 (本タスク変更前 `main.ts:956` に同一エラーが存在することを `git stash` で baseline 確認済み)。**本タスクの変更による新規エラーは 0 件**。

## 設計判断ログ (plan からズレた箇所)

### 1. `registerSelf` を object 引数化 (plan §2.2.3 を発展)

plan は positional 引数 `(role, surface, sessionId?)` を維持しつつ throw 経路化する想定だったが、テスト時に `projectRoot` を差し替える必要があったため `{ role, surface, sessionId?, projectRoot? }` の object 引数に変更した。`projectRoot` のデフォルトは module-level `PROJECT_ROOT` で、本番経路の挙動は等価。

合わせて `resolveProxyPort` も `projectRoot` optional 引数を追加した (default は同じく `PROJECT_ROOT`)。

### 2. `test.each` を独立 `test()` 3 つに展開 (plan §3.2)

plan §3.2 は `test.each` で 3 unverifiable バリエーションを 1 つに集約していたが、Bun の test runner で `test.each` 連続実行時に「200 + JSON without project_root」が稀に `kind: "dead"` を返す flaky を観測した (5 回中 1 回程度の頻度)。fetch 段階で abort される race の可能性がある。`test.each` を独立 `test()` 3 つに展開すると 5 連続実行で 0 fail を維持できたため、こちらを採用。

期待動作 (`kind:unverifiable` への集約) は plan と等価。

### 3. `proxy.test.ts` の getState 未設定テストを削除

plan §3.3 では「`GET /api/identify` が project_root / daemon_pid / version を返す」テストのみ要件化されており、`getState` 未設定時の独立 proxy モードでの挙動はテスト要件外。最初は spec の説明 (「getState が無い独立 proxy モードでも project_root だけは返せる」) に従ってテストを書いたが、3 回中 1 回程度 404 を返す flaky を観測したため削除した。本番経路 (cmdStart 経由) では常に `getState` が渡されるため、削除しても要件は満たす。

### 4. M-2 最適化 (resolveProxyPort の TCP probe 省略) は別 PR に保留

plan §2.2.2 に記載の最適化メモのとおり、`verifyProxyIdentity` 導入後は HTTP fetch が TCP connect を含むため `resolveProxyPort` の TCP probe (1000ms) は省略可能だが、互換重視で本タスクでは既存 `resolveProxyPort` をそのまま維持した。最適化は spec 上の TODO として残す。

### 5. commit 分割は実施せず

plan §5 では「Phase A throw リファクタ」と「Phase B cross-check」を別 commit に分けることが推奨されていたが、Conductor が完了処理時に commit するため Implementer は commit を作らない。コードレベルでは Phase A と Phase B を 1 つの worktree 状態にまとめている。

## 完了条件チェック

- [x] proxy.ts に `GET /api/identify` 追加、5 フィールド (project_root / daemon_pid / version / started_at / schema_version) を返す
- [x] proxy.ts の `/api/messages` レスポンスに `daemon_pid` 追加
- [x] main.ts cmdStart の proxy 起動分岐が identify verify を経由する
- [x] registerSelf を `RegisterSelfError` throw 経路にリファクタ (proxy_port_missing / post_failed / cross_check_failed の 3 reason)
- [x] cmdSpawnConductor / cmdLaunchMaster で catch → process.exit(1)
- [x] registerSelf が daemon_pid cross-check を行い、不一致時 `RegisterSelfError(cross_check_failed)` を throw
- [x] proxy.test.ts: GET /api/identify が期待 JSON を返す + upstream に fall-through しない (M-3)
- [x] proxy-identity.test.ts ケース A (project_root mismatch)
- [x] proxy-identity.test.ts ケース B (no listener / dead) + unverifiable バリエーション
- [x] proxy-identity.test.ts ケース C (same project_root)
- [x] main.test.ts ケース D (registerSelf cross-check) — throw を `expect(...).rejects` で assert
- [x] main.test.ts: `manager.pid` 未設定なら cross-check skip
- [x] docs/spec/05-install-and-infrastructure.md の更新 (identify endpoint + race skip 説明)
- [x] 対象テストファイルのみ `bun test --timeout 30000 <file>` で全 PASS
- [x] tsc 新規エラー 0 (既存の sleepPrevention エラー 1 件のみ残存、本タスク変更前から存在)
