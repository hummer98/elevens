# 実装計画: proxy port 再利用時の owner identity verify (T003)

## 0. ゴール

`elevens start` の boot path で `.team/proxy-port` に書かれている既存 proxy が
**自プロジェクトの daemon が握っている proxy** であることを verify してから再利用する。
別プロジェクト (旧 `cmux-team` repo / 別 path の `elevens`) の孤児 daemon が
同じ port を握っていた場合、新 daemon は再利用を諦めて新 port で proxy を起動する。

防御深度として、`registerSelf` 側でも HTTP レスポンス経由で daemon pid を cross-check し、
proxy が他プロジェクトに転送している兆候があれば fail-fast する。

---

## 1. 設計判断 (上流)

### 1.1 identify エンドポイントの形

- HTTP path: `GET /api/identify`
  - `/state` `/tasks` `/conductors` `/rate-limit` と並ぶ debug endpoint 群に揃える
  - ただし `daemon` の身元を返すことを明示するため `/api/identify` という名前空間に分ける
    (`/state` 等は state debug、`/api/identify` は identity verify 用、と読み取れる)
- レスポンス JSON:
  ```json
  {
    "project_root": "/Users/.../elevens",
    "daemon_pid": 8978,
    "version": "0.4.1",
    "started_at": "2026-05-10T13:31:14+09:00",
    "schema_version": 1
  }
  ```
- `schema_version: 1` を入れて将来の互換切替に備える (現行 proxy が返さない場合 = legacy 扱い)
- `getState` が無い独立 proxy モード (現行 daemon 外起動経路) でも `project_root` だけは
  proxy 起動時に closure に握っているので返せる。`daemon_pid` は `process.pid`、
  `version` / `started_at` は `getState` がない場合 `null`

### 1.2 timeout / retry

- identify 確認の HTTP timeout: **1500ms**
  - 既存 `resolveProxyPort` の TCP connect timeout (1000ms) と同等オーダー
  - 1 度しか叩かないので retry はしない (失敗 = proxy 不健全とみなして discard する)
- 再試行を増やすと「孤児 daemon が遅延しただけで誤って捨てる」リスクが出るが、
  そもそも proxy は ephemeral port を使うので孤児が居る方が異常。再試行不要

### 1.3 後方互換 (古い proxy が `/api/identify` を返さない場合)

- レスポンス 404 / connection refused / timeout / `project_root` 欠落 の **すべてを
  「identify 不可 = 自プロジェクトと verify できない」と扱い**、proxy-port を捨てて新 port で起動する
- 安全側に倒す方針。古い proxy を強制的に殺すことはしない (相手プロセスはそのまま生きる)
- `proxy_owner_unverifiable` warn ログを出して原因を後追いできるようにする

### 1.4 registerSelf cross-check の発火条件

- HTTP レスポンスは proxy.ts の `/api/messages` ハンドラが生成する。
  proxy と daemon は同一プロセスなので `process.pid` = daemon の pid となる
- `team.json.manager.pid` がまだ書かれていない初回起動 (initInfra で `manager: {}` のみ作成、
  `updateTeamJson` で初書き込み) は **skip**。false positive を避ける
- registerSelf 自身は MASTER / CONDUCTOR 双方で呼ばれる。両者に同じ cross-check を入れる
- 不一致時は `RegisterSelfError(reason="cross_check_failed")` を throw し、呼び出し側
  `cmdSpawnMaster` / `cmdSpawnConductor` が catch して exit 1 する (詳細は §2.2.3)。
  エラーメッセージで `.team/proxy-port` 削除を案内

---

## 2. 実装ステップ (ファイル単位)

### 2.1 `skills/cmux-team/manager/proxy.ts`

#### 2.1.1 GET /api/identify エンドポイント追加

**位置**: `fetchHandlerInner` 内 GET 分岐の最後 (現行 `if (url.pathname === "/rate-limit")` 直後、
proxy.ts L600 の `}` 前)

**実装**:

```typescript
if (url.pathname === "/api/identify") {
  const state = opts?.getState?.();
  return new Response(JSON.stringify({
    project_root: projectRoot,
    daemon_pid: process.pid,
    version: state?.version ?? null,
    started_at: state?.startedAt ?? null,
    schema_version: 1,
  }), { headers: jsonHeaders });
}
```

- `projectRoot` は `start(projectRoot, opts)` の引数で closure 内に握られている (proxy.ts L461)
- `state.version` / `state.startedAt` は DaemonState のフィールド (daemon.ts L111 / L157)。
  cmdStart の boot 順で **proxy 起動 (main.ts L1064) より前の main.ts:945-947 で確定する**
  ため、request 時の `getState()` 呼び出しでは常に値が返る (詳細は §7.1 R5)
- 独立 proxy モード (`getState` 未指定) でも `project_root` と `daemon_pid` は返せる

#### 2.1.2 /api/messages レスポンスに daemon_pid を含める

**位置**: proxy.ts L720-732 の `/api/messages` POST ハンドラ

**変更内容**: success レスポンスに `daemon_pid: process.pid` を追加 (全 message 種別で常に載せる)

```typescript
if (req.method === "POST" && url.pathname === "/api/messages") {
  if (!opts?.onMessage) {
    return new Response(JSON.stringify({ error: "no handler" }), { status: 503, ... });
  }
  try {
    const body = await req.json();
    const msg = QueueMessage.parse(body);
    await opts.onMessage(msg);
    return new Response(
      JSON.stringify({ ok: true, daemon_pid: process.pid }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch {
    return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, ... });
  }
}
```

- 全 message type で常に `daemon_pid` を含める方針 (型分岐を増やさない)
- 古い CLI 側は `daemon_pid` を無視するだけなので後方互換は保たれる

> **Note**: daemon.ts の `handleMessage` は void のまま。レスポンス整形は proxy.ts 側に
> 集約する設計を維持する (handleMessage の戻り値型を変えると影響範囲が広い)。
> spec の「daemon.ts のハンドラのレスポンスに daemon pid を載せる」は実装上は
> proxy.ts の `/api/messages` 分岐を指す解釈とする (実装メモを daemon.ts のハンドラ箇所に
> 1 行コメントで残し、cross-reference を確保する)。

### 2.2 `skills/cmux-team/manager/main.ts`

#### 2.2.1 verifyProxyIdentity ヘルパー関数の新設

**位置**: `resolveProxyPort` (main.ts L1948) の直後に新関数を追加

**実装方針**:

```typescript
type ProxyIdentityVerifyResult =
  | { ok: true; projectRoot: string; daemonPid: number; version: string | null }
  | { kind: "dead" }                                      // TCP/HTTP 接続不能
  | { kind: "unverifiable"; reason: string }              // 接続できたが identify レス不正/欠落
  | { kind: "mismatch"; otherProjectRoot: string; otherDaemonPid: number };

async function verifyProxyIdentity(
  port: string,
  expectedProjectRoot: string,
): Promise<ProxyIdentityVerifyResult>;
```

- `fetch("http://127.0.0.1:" + port + "/api/identify", { signal: AbortSignal.timeout(1500) })`
- レスポンス 200 + JSON parse 成功 + `project_root` フィールド存在を要求
- `project_root === expectedProjectRoot` (絶対パス完全一致) なら `{ ok: true, ... }`
- それ以外は分類して返す (deadliteral には dead / unverifiable / mismatch を区別)
- node の `realpath` 等は使わず文字列一致で良い (両側とも `process.cwd()` ベースの絶対 path)

#### 2.2.2 cmdStart boot path 内での integration

**位置**: main.ts L1042-1081 (proxy 起動分岐)

**変更フロー**:

```typescript
// 前回ポートを読む (既存)
let previousProxyPort: string | undefined;
try { previousProxyPort = (await readFile(...)).trim(); } catch {}

// proxy 起動分岐
let proxyHandle: { port: number; stop: () => void } | null = null;
const existingProxyPort = await resolveProxyPort();

let reuseExisting = false;
if (existingProxyPort) {
  const verify = await verifyProxyIdentity(existingProxyPort, PROJECT_ROOT);
  if (verify.ok) {
    reuseExisting = true;
  } else if (verify.kind === "mismatch") {
    await log(
      "proxy_owner_mismatch",
      `port=${existingProxyPort} my=${PROJECT_ROOT} other=${verify.otherProjectRoot} other_pid=${verify.otherDaemonPid}`,
    );
    // 旧 proxy-port ファイルは startProxy 後の writeFile で上書きされるので削除不要
  } else if (verify.kind === "dead") {
    await log("proxy_owner_dead", `port=${existingProxyPort}`);
  } else {
    await log("proxy_owner_unverifiable", `port=${existingProxyPort} reason=${verify.reason}`);
  }
}

if (reuseExisting) {
  state.proxyPort = parseInt(existingProxyPort!, 10);
  await log("proxy_reused", `port=${existingProxyPort}`);
} else {
  // 既存 startProxy 起動コード (L1057-1080) をそのまま使う
  try {
    const traceDb = initDB(PROJECT_ROOT);
    proxyHandle = await startProxy(PROJECT_ROOT, { ... });
    await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
    state.proxyPort = proxyHandle.port;
    await log("proxy_started", `port=${proxyHandle.port}`);
  } catch (e: any) {
    await log("proxy_start_failed", e.message);
  }
}
```

- 既存の proxy_reused / proxy_started ログは残す。新規ログを追加する形
- `proxy_port_changed` 検出 (L1084) はそのまま動く (新 port が取得できるため)

> **最適化メモ (M-2 / 別 PR で良い)**: `verifyProxyIdentity` 導入後は HTTP fetch
> 自体が TCP connect を含むため、`resolveProxyPort` の TCP probe (1000ms) と合わせると
> ワーストケースで 2.5s の boot 遅延が発生する。`verifyProxyIdentity` で
> dead 判定が `kind:dead` として得られるので、`resolveProxyPort` の TCP probe を
> 省略して `.team/proxy-port` の port 文字列を直接 `verifyProxyIdentity` に渡す
> 経路にまとめれば 1.5s に短縮可能。本タスクのスコープでは既存の `resolveProxyPort`
> に手を入れずに `verifyProxyIdentity` を後段に追加する (互換重視)。
> 最適化は spec 上の TODO として残す。

#### 2.2.3 registerSelf cross-check 追加 + throw リファクタ (確定)

**位置**: main.ts L2017-2044 (`registerSelf` 関数本体) + 呼び出し側 (`cmdSpawnMaster` /
`cmdSpawnConductor`)

**リファクタ方針 (確定 / I-3)**:

`registerSelf` 内では `process.exit(1)` を **直接呼ばず** `throw new RegisterSelfError(reason)`
に統一する。呼び出し側 (cmdSpawnMaster / cmdSpawnConductor) で catch して exit 1 する分岐を
追加する。**仕様は変えない** (exit 1 で死ぬ事実は同じ)。

理由 (design review I-3):
1. 子プロセス経由 (`runCli`) はプロセス起動コストが高く CI で flaky になりやすい
2. `process.exit` モックは Bun の test runner で副作用が他テストに漏れる
3. 既存の MASTER_REGISTERED 4xx / proxy-port 不在経路も同じ throw に揃えれば一貫した
   テスト容易な設計になる

**RegisterSelfError 型 (新規)**:

```typescript
export class RegisterSelfError extends Error {
  constructor(public reason: string, public detail?: string) {
    super(reason);
    this.name = "RegisterSelfError";
  }
}
```

**registerSelf 本体の変更 (確定)**:

```typescript
// 既存: proxy-port 不在
if (!port) {
  throw new RegisterSelfError(
    "proxy_port_missing",
    `${messageType} cannot be sent: .team/proxy-port not found`,
  );
}

const res = await fetch(`http://127.0.0.1:${port}/api/messages`, { ... });

// 既存: 4xx / 5xx
if (!res.ok) {
  throw new RegisterSelfError(
    "post_failed",
    `${messageType} POST failed: status=${res.status} surface=${surface}`,
  );
}

// T003 (新規): cross-check daemon pid
try {
  const respBody = await res.clone().json() as { ok?: boolean; daemon_pid?: number };
  const responseDaemonPid = typeof respBody?.daemon_pid === "number"
    ? respBody.daemon_pid
    : null;
  if (responseDaemonPid !== null) {
    // initInfra 直後 / 初回 handleMessage 前は team.json.manager は `{}` のまま
    // (manager.pid 未設定)。`readManagerPidFromTeamJson` が null を返して skip するので
    // 正常系の race である (cross-check は best-effort、false positive を避けるため)
    const expectedPid = await readManagerPidFromTeamJson(PROJECT_ROOT);
    if (expectedPid != null && expectedPid !== responseDaemonPid) {
      throw new RegisterSelfError(
        "cross_check_failed",
        `${messageType} cross-check failed: response.daemon_pid=${responseDaemonPid} ` +
        `team.json manager.pid=${expectedPid}\n` +
        "proxy が他プロジェクトの daemon に転送している可能性があります。\n" +
        ".team/proxy-port を削除して elevens start をやり直してください。",
      );
    }
  }
} catch (e) {
  if (e instanceof RegisterSelfError) throw e;
  // レスポンス JSON 解析失敗 / team.json 読めない → cross-check skip (前方互換)
}
```

**呼び出し側 (cmdSpawnMaster / cmdSpawnConductor) の変更 (確定)**:

```typescript
try {
  await registerSelf({ ... });
} catch (e: any) {
  if (e instanceof RegisterSelfError) {
    console.error(e.detail ?? e.message);
    process.exit(1);
  }
  throw e;
}
```

`readManagerPidFromTeamJson` ヘルパー (新規):

```typescript
async function readManagerPidFromTeamJson(root: string): Promise<number | null> {
  try {
    const raw = await readFile(join(root, ".team/team.json"), "utf-8");
    const tj = JSON.parse(raw);
    const p = tj?.manager?.pid;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}
```

- team.json 不在 / `manager.pid` 未設定 (初回起動順序で daemon 起動直後 registerSelf が
  team.json 初期書き込み前に到達するケース) は `null` を返して **skip** (silent skip)
- daemon.ts:829 の initInfra で `manager: {}` を seed → updateTeamJson が初回 flush
  されるまでは `manager.pid` 未設定のまま。これは仕様通りの挙動なので docs にも明記する
  (§6.1)
- `daemon_pid` が無い古い proxy 経路も skip (前方互換)

---

## 3. テスト戦略

ファイル: `skills/cmux-team/manager/proxy-identity.test.ts` (新規)

各ケースとも `Bun.serve` で偽 proxy を立てる pattern を使う。
既存 `main.test.ts` の `port` 利用パターン (L929-) を参考にする。

### 3.1 ケース A: 別 project_root → proxy_owner_mismatch + 新 port で proxy_started

**戦略**: `verifyProxyIdentity` 単体ユニットテスト

```typescript
test("verifyProxyIdentity: project_root mismatch returns kind:mismatch", async () => {
  // 別 project_root を返す偽 proxy を Bun.serve で立てる
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({
      project_root: "/Users/.../old-cmux-team",
      daemon_pid: 39221,
      version: "0.3.2",
      schema_version: 1,
    }), { headers: { "Content-Type": "application/json" } }),
  });
  try {
    const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
    expect(result).toMatchObject({
      kind: "mismatch",
      otherProjectRoot: "/Users/.../old-cmux-team",
      otherDaemonPid: 39221,
    });
  } finally {
    await fake.stop(true);
  }
});
```

加えて、cmdStart boot path レベルの integration テストとして
**マイクロ統合テスト**を `daemon.test.ts` 形式で書く:

- `createDaemon` で state を作成 → `.team/proxy-port` に偽 proxy port を書く →
  proxy 起動分岐を切り出した helper (例: `decideProxyReuse(state, projectRoot)`) を呼んで
  返り値が `"start_new"` であることを期待する
- これは cmdStart 全体を実行せず、proxy 起動判定ロジックだけを切り出した unit test

→ そのため main.ts に `decideProxyReuse` を export しておく (verifyProxyIdentity 呼び出しを内包)

### 3.2 ケース B: 誰も listen していない port → kind:dead + unverifiable バリエーション

**戦略**: ユニットテスト。`tmp.stop(true)` を `await` して setTimeout(50ms) 依存を排除する
(I-4 対応)。

```typescript
test("verifyProxyIdentity: no listener returns kind:dead", async () => {
  const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = tmp.port;
  await tmp.stop(true); // close active connections too — TCP 解放を確実にする
  const result = await verifyProxyIdentity(String(port), "/dummy");
  expect(result).toMatchObject({ kind: "dead" });
});
```

- 既存 `resolveProxyPort` も `alive` を見ているので boot path として
  proxy-port ファイル自体を無視する経路と整合

加えて **unverifiable バリエーションテストを 1 ケース集約で追加 (I-1 対応)**。
古い (T003 未適用) proxy が握る port に新 daemon が `GET /api/identify` を投げると、
proxy は `https://api.anthropic.com/api/identify` に **fall-through forward** してしまう
(proxy.ts L734 以降の forward 経路)。Anthropic 側は 401 / 非 JSON を返すことが多い。
偽 proxy 側ではこれら 3 パターン (401 / 非 JSON / `project_root` フィールド欠落 JSON)
を共通テーブルでまとめて assert する:

```typescript
test.each([
  {
    name: "401 + plain text (legacy proxy → Anthropic 401 をシミュレート)",
    response: () => new Response("Authentication required", {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    }),
  },
  {
    name: "200 + non-JSON binary",
    response: () => new Response(new Uint8Array([0xff, 0x00, 0xab]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }),
  },
  {
    name: "200 + JSON without project_root",
    response: () => new Response(JSON.stringify({ daemon_pid: 99, version: "0.1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
])("verifyProxyIdentity: $name → kind:unverifiable", async ({ response }) => {
  const fake = Bun.serve({ port: 0, fetch: response });
  try {
    const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
    expect(result.kind).toBe("unverifiable");
  } finally {
    await fake.stop(true);
  }
});
```

`verifyProxyIdentity` の実装側コメントとして
「200 以外 / JSON parse 失敗 / `project_root` 非文字列はすべて `kind:unverifiable`
に集約する (legacy proxy が Anthropic に forward して 401/非 JSON を返すケースを
網羅するため)」を 1 行残しておく。

### 3.3 ケース C: 同一 project_root → kind:ok / proxy_reused

**戦略**: ユニットテスト

```typescript
test("verifyProxyIdentity: same project_root returns ok", async () => {
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({
      project_root: "/Users/.../elevens",
      daemon_pid: process.pid,
      version: "0.4.1",
      schema_version: 1,
    }), { headers: { "Content-Type": "application/json" } }),
  });
  try {
    const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
    expect(result).toMatchObject({
      ok: true,
      projectRoot: "/Users/.../elevens",
      daemonPid: process.pid,
    });
  } finally {
    await fake.stop(true);
  }
});
```

加えて、proxy.ts 側で実際に GET /api/identify が期待 JSON を返すかの
`proxy.test.ts` 追加テスト (1):

```typescript
test("GET /api/identify が project_root / daemon_pid / version を返す", async () => {
  const handle = await start(testDir, {
    getState: () => ({ version: "0.4.1", startedAt: "2026-05-10T..." }),
  });
  try {
    const res = await fetch(`http://localhost:${handle.port}/api/identify`);
    const body = await res.json();
    expect(body).toMatchObject({
      project_root: testDir,
      daemon_pid: process.pid,
      version: "0.4.1",
      schema_version: 1,
    });
  } finally {
    handle.stop();
  }
});
```

さらに **negative test (M-3)** として「`/api/identify` が upstream API.anthropic.com に
fall-through していない」ことを確認:

```typescript
test("GET /api/identify は upstream に fall-through しない (M-3)", async () => {
  // upstream を mock せずに proxy を起動。fall-through すれば
  // Anthropic API への接続でレスポンスが 401 / 5xx / 接続失敗になるはず。
  // 自前 endpoint なら closure 内の testDir をそのまま返すので 200 + project_root が必ず一致する
  const handle = await start(testDir, {});
  try {
    const res = await fetch(`http://localhost:${handle.port}/api/identify`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // proxy 内 closure の projectRoot が返る = forward されていない
    expect(body.project_root).toBe(testDir);
    expect(body.schema_version).toBe(1);
  } finally {
    handle.stop();
  }
});
```

これにより proxy.ts 実装で `if (url.pathname === "/api/identify") { ... }` の
**閉じ括弧位置を間違えて upstream forward 経路に流す事故**を test で検出可能になる。

### 3.4 ケース D: registerSelf cross-check (daemon_pid mismatch)

**戦略**: §2.2.3 の throw リファクタを前提に、`registerSelf` を `export` してユニットテスト。
子プロセス経由 (`runCli`) や `process.exit` モックは使わない (I-3 確定方針)。

```typescript
import { registerSelf, RegisterSelfError } from "./main";

test("registerSelf: daemon_pid mismatch で RegisterSelfError(cross_check_failed) を throw", async () => {
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ manager: { pid: 99999 } }),
  );
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response(
      JSON.stringify({ ok: true, daemon_pid: 11111 }),
      { headers: { "Content-Type": "application/json" } },
    ),
  });
  await writeFile(join(testDir, ".team/proxy-port"), String(fake.port));

  try {
    await expect(
      registerSelf({
        role: "master",
        surface: "U[1]",
        projectRoot: testDir,
      }),
    ).rejects.toMatchObject({
      name: "RegisterSelfError",
      reason: "cross_check_failed",
    });
    // detail には cross-check failed 文と .team/proxy-port 案内が含まれる
    await expect(registerSelf({ ... })).rejects.toMatchObject({
      detail: expect.stringContaining("cross-check failed"),
    });
  } finally {
    await fake.stop(true);
  }
});

test("registerSelf: daemon_pid が一致すれば成功", async () => {
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ manager: { pid: 11111 } }),
  );
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response(
      JSON.stringify({ ok: true, daemon_pid: 11111 }),
      { headers: { "Content-Type": "application/json" } },
    ),
  });
  await writeFile(join(testDir, ".team/proxy-port"), String(fake.port));

  try {
    await expect(registerSelf({ ... })).resolves.toBeUndefined();
  } finally {
    await fake.stop(true);
  }
});

test("registerSelf: team.json.manager.pid 未設定なら cross-check skip", async () => {
  // initInfra 直後 / 初回 handleMessage 前は manager: {} のまま
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ manager: {} }),
  );
  const fake = Bun.serve({
    port: 0,
    fetch: () => new Response(
      JSON.stringify({ ok: true, daemon_pid: 11111 }),
      { headers: { "Content-Type": "application/json" } },
    ),
  });
  await writeFile(join(testDir, ".team/proxy-port"), String(fake.port));

  try {
    // skip なので daemon_pid 不一致でも成功する (false positive 回避)
    await expect(registerSelf({ ... })).resolves.toBeUndefined();
  } finally {
    await fake.stop(true);
  }
});
```

- `RegisterSelfError` を `throw` する形に統一したことで、`process.exit` や子プロセス起動を
  使わずに同期的に assertion 可能になる (CI flakiness 回避)
- 既存の MASTER_REGISTERED 4xx / proxy-port 不在経路も同じ `RegisterSelfError` で投げる
  ように揃えるので、それぞれのケースに対するテストも同じ pattern で追加する
  (reason: `post_failed` / `proxy_port_missing`)

---

## 4. 後方互換 / 既存挙動への影響

| 観点 | 現行 | 本変更後 |
|---|---|---|
| 自プロジェクトの proxy が生きている (正常 reuse) | `proxy_reused` | identify verify → ok → `proxy_reused` (同じ) |
| 旧 cmux-team 系 proxy が同 port を握っている | (バグ) silent に他 daemon に POST | identify verify → mismatch → 新 port で起動 + warn ログ |
| 古い proxy (identify 未実装) が握っている | reuse | unverifiable → 新 port で起動 + warn ログ (安全側) |
| `.team/proxy-port` の port が dead | resolveProxyPort で alive=false → 新 port で起動 | 同左 (TCP probe は維持) |
| registerSelf POST 200 だが daemon が他プロジェクト | (バグ) silent 成功 | レスポンスの daemon_pid 不一致 → exit 1 |
| team.json 未生成 (初回起動 race) | - | cross-check skip (false positive 回避) |

- CLI フラグ追加なし
- `.team/proxy-port` のフォーマット変更なし
- API endpoint 追加 (`GET /api/identify`)。古いクライアントは利用しないので影響なし
- `/api/messages` レスポンスに `daemon_pid` 追加。古いクライアントは無視する
- **registerSelf 内部リファクタ (throw)**: `process.exit(1)` を `throw RegisterSelfError`
  + 呼び出し側 catch → exit 1 に置き換える。**外部から見た挙動 (exit code / stderr 内容)
  は同じ**。proxy_port_missing / post_failed (4xx / 5xx) 経路も同じ throw 経路に揃える。

---

## 5. 実装順序

1. `proxy.ts` に `GET /api/identify` 追加 + ユニットテスト
   (proxy.test.ts に「期待 JSON を返す」「upstream に fall-through しない (M-3)」の 2 ケース)
2. `proxy.ts` の `/api/messages` レスポンスに `daemon_pid` 追加
3. `main.ts` に `verifyProxyIdentity` ヘルパーを追加 + 単体テスト
   (proxy-identity.test.ts: ケース A/B/C/unverifiable バリエーション)
4. `main.ts` の cmdStart boot path に integration → proxy_owner_mismatch ログ確認
5. **registerSelf を throw リファクタ (確定 / I-3)** — Step 5 の冒頭で実施:
   1. `RegisterSelfError` クラスを export
   2. **既存** の `proxy_port_missing` / `post_failed` (4xx / 5xx) 経路も
      `process.exit(1)` を `throw new RegisterSelfError(...)` に置き換える (仕様変更なし)
   3. 呼び出し側 `cmdSpawnMaster` / `cmdSpawnConductor` に
      `try { ... } catch (e) { if (e instanceof RegisterSelfError) { console.error(e.detail ?? e.message); process.exit(1); } throw e; }` を追加
   4. リファクタが既存テストを壊していないことを `bun test --timeout 30000 main.test.ts` で確認
   5. その上で **新規** cross-check + `readManagerPidFromTeamJson` を追加し、
      `cross_check_failed` reason を持つ `RegisterSelfError` を throw する経路を実装
6. registerSelf cross-check テスト (ケース D) — throw を直接 `expect(...).rejects.toMatchObject(...)` で assert
7. 全体回帰: 既存 `proxy.test.ts` `main.test.ts` `daemon.test.ts` を再実行

> **commit 分割の推奨 (design review より)**: Step 5 の **(1)〜(4) のリファクタ** と
> **(5) cross-check 追加**を別 commit に分けることで review 粒度を上げる。
> リファクタ commit は仕様変更なし (既存テストグリーン)、cross-check commit のみ
> 新仕様。

各ステップ後に対象ファイルだけ `bun test --timeout 30000 <file>` で回す
(CLAUDE.md の bun test 全体実行禁忌に従う)。

---

## 6. ドキュメント更新

### 6.1 `docs/spec/05-install-and-infrastructure.md`

- 「プロキシサーバー」節 (L248-) のデバッグエンドポイント一覧に `GET /api/identify` を追加
  ```
  デバッグエンドポイント: ..., GET /api/identify (proxy 識別: project_root, daemon_pid,
  version, started_at を返す。daemon boot 時の port 再利用で別プロジェクトの孤児
  daemon を排除するために使う)
  ```
- 「daemon 起動時に proxy を再利用」節 (L255) を改訂:
  ```
  - daemon 起動時に proxy を再利用する。再利用の前に GET /api/identify で
    project_root を verify し、不一致なら新 port で proxy を立て直す
    (proxy_owner_mismatch を warn ログ)
  ```
- **registerSelf cross-check の race skip を明記 (I-2 対応)**:
  ```
  ### registerSelf の daemon_pid cross-check と初回起動 race

  Master / Conductor sub-agent は registerSelf で `/api/messages` POST 後、
  レスポンスの `daemon_pid` と `.team/team.json` の `manager.pid` を突き合わせて
  proxy 経由で他プロジェクトの daemon に転送されていないか verify する。

  **ただし以下のケースでは silent skip となる (false positive 回避)**:

  - `.team/team.json` 不在 (initInfra 完了前)
  - `team.json.manager.pid` 未設定 (initInfra で `manager: {}` を seed した直後、
    daemon の最初の `updateTeamJson` flush が走る前。これは正常系の初回起動 race)
  - レスポンス JSON parse 失敗 / `daemon_pid` フィールド欠落 (古い proxy 経路、前方互換)

  cross-check が走らない window を狭めたい場合は、cmdStart の proxy 起動直後に
  `await updateTeamJson(state)` を 1 度同期 flush する案がある (本タスクのスコープ外)。
  ```

### 6.2 (任意) `CLAUDE.md` 既知の注意点に 1 行

- 「`.team/proxy-port` に書かれた port が他プロジェクトの daemon に握られている場合は
  `proxy_owner_mismatch` ログが出て新 port が割り当てられる」旨

### 6.3 docs/spec/00-project-overview.md / 07-state-machine.md

- 影響なし (state machine には触らない)

---

## 7. リスクと検証手順

### 7.1 リスク

| # | リスク | 緩和策 |
|---|---|---|
| R1 | identify HTTP の 1500ms timeout 中に boot 全体が遅延する | `verifyProxyIdentity` は 1 度だけ呼ぶ。dead パスでも 1.5s 増。許容 |
| R2 | 古い proxy (identify 未実装) も `unverifiable` で殺してしまうので、cmux-team v0.3.x → v0.4.x の同居は不可 | `proxy_owner_unverifiable` ログ + 新 port で起動するだけで、相手 proxy は kill しない。共存可能 |
| R3 | `registerSelf` の cross-check で team.json read 中に他プロセスが書き換える race | 失敗時 `null` 返却 → cross-check skip。fail-safe |
| R4 | `process.exit` を直接呼んでいるためテストしにくい | 実装で throw → 呼び出し側で exit 1 にリファクタ (推奨) |
| R5 | `version` を proxy 起動時 (state.version 確定前) に取得しても空文字 | `state.version` / `state.startedAt` は **cmdStart の boot 順で proxy 起動 (main.ts L1064) より前**、main.ts:945-947 の `state.version = await loadVersion()` / `state.startedAt = ...` で確定済み。proxy.ts の `/api/identify` が `opts.getState().version` を読む時点では既に値があるので `undefined` にならない。L1090 のローカル変数 `version` は `startDashboardServer` 用に別途読み込む別物 (DaemonState のフィールドではない) |

### 7.2 検証手順 (手動)

1. **正常 reuse**: `elevens start` → 一度 stop → 再 `elevens start`
   ログに `proxy_reused port=NNNN` が出ること
2. **mismatch シナリオ再現**:
   - 別ディレクトリで `elevens start` (proxy port 60372 を握る)
   - 自ディレクトリの `.team/proxy-port` に手動で `60372` を書き込む
   - `elevens start` を実行
   - `manager.log` に `proxy_owner_mismatch` + `proxy_started port=NNNN` (60372 ≠ NNNN) が出ること
   - team.json の `masters` 配列に新 Master が登録されていること
3. **dead port シナリオ**: `.team/proxy-port` に空き port を書く → `proxy_started` が出る
4. **registerSelf cross-check**:
   - 偽 daemon を立て、team.json.manager.pid を別 PID で書く
   - `elevens spawn-master` (内部で registerSelf) → exit 1 + stderr に `cross-check failed`

### 7.3 自動テスト

- `bun test --timeout 30000 skills/cmux-team/manager/proxy-identity.test.ts`
- `bun test --timeout 30000 skills/cmux-team/manager/proxy.test.ts`
- `bun test --timeout 30000 skills/cmux-team/manager/main.test.ts` (registerSelf 周辺の追加テスト)

### 7.4 観察箱原則 (CLAUDE.md)

- 新ログ: `proxy_owner_mismatch` / `proxy_owner_dead` / `proxy_owner_unverifiable` / `register_self_cross_check_failed`
  → manager.log に残る → trace DB の `hook_signals` ではなく log 経由。retrospective 観察に資する
- 状態を内部に隠さない設計を維持: 全判定は manager.log と team.json から後追い可能

---

## 8. 完了条件 (Definition of Done)

- [ ] proxy.ts に `GET /api/identify` が追加され、project_root / daemon_pid / version / started_at /
      schema_version を返す
- [ ] proxy.ts の `/api/messages` レスポンスに `daemon_pid` が含まれる
- [ ] main.ts cmdStart の proxy 起動分岐が identify verify を経由する
- [ ] **registerSelf を `RegisterSelfError` throw 経路にリファクタ** (proxy_port_missing /
      post_failed / cross_check_failed の 3 reason)。呼び出し側 `cmdSpawnMaster` /
      `cmdSpawnConductor` で catch → `process.exit(1)`
- [ ] main.ts registerSelf が daemon_pid cross-check を行い、不一致時
      `RegisterSelfError(cross_check_failed)` を throw
- [ ] 以下のテストがそれぞれユニットテストとしてパスする:
  - [ ] proxy.test.ts: `GET /api/identify` が期待 JSON を返す + upstream に fall-through しない (M-3)
  - [ ] proxy-identity.test.ts ケース A (project_root mismatch)
  - [ ] proxy-identity.test.ts ケース B (no listener / dead) +
        unverifiable バリエーション (401 / 非 JSON / project_root 欠落)
  - [ ] proxy-identity.test.ts ケース C (same project_root)
  - [ ] main.test.ts ケース D (registerSelf cross-check) — throw を `expect(...).rejects`
        で assert
  - [ ] main.test.ts: `manager.pid` 未設定なら cross-check skip (race の正常系)
- [ ] docs/spec/05-install-and-infrastructure.md の更新 (identify endpoint + race skip 説明)
- [ ] 対象テストファイルのみ `bun test --timeout 30000 <file>` で全 PASS
- [ ] manager.log の手動再現で proxy_owner_mismatch シナリオが期待通りログされる
