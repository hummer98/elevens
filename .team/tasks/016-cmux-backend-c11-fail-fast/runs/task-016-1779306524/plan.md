# T016 実装計画書 — cmux backend を完全削除し c11 専用化（fail-fast）

- **タスク**: `.team/tasks/016-cmux-backend-c11-fail-fast/task.md`
- **worktree**: `/Users/yamamoto/git/elevens/.worktrees/task-016-1779306524`
- **ブランチ**: `task-016-1779306524/task`
- **前提**: T015 (default を c11 に反転、cmux opt-in 後方互換維持) が main にマージ済み
- **このタスクの主張**: 「elevens は c11 前提」なので cmux backend へのフォールバック・opt-in 自体を撤去する。前提が崩れたら無言でフォールバックせず exit 1 する

---

## 改訂履歴

- **rev-2 (1779307992)**: design-review.md の Changes Requested を反映
  - **M1**: §3.6 / §5-3 — `AGENT_SPAWN_FAILED` schema に `surface?: string` を追加。daemon side handler で対応する `conductor.agents` entry を findIndex + splice で掃除する記述に統一。§3.6（仮登録 race 用 slot 掃除）と §5-3（最小実装: state 変更なし）の矛盾を解消（slot 掃除を含める方針に揃える）
  - **M2**: §6 docs テーブルに `skills/c11/SKILL.md` (L9 description trigger / L17 本文) を追加。invocation trigger 部から `ELEVENS_BACKEND` keyword を撤去し c11 一本化に書き換える
  - **M3**: §3.5 を「`runCmux` 内で `opts.timeout ?? SEND_TIMEOUT_MS` の default を持つ」設計に変更。`send` / `sendKey` / `closeSurface` / `renameTab` / `renameWorkspace` / `setStatus` / `notify` / `clearStatus` に加え、`newSurface` / `newSplit` / `getCallerSurface` / `getCallerWorkspace` も自動保護。`tree` は既存の `TREE_TIMEOUT_MS(5s)` を保持（read-only query 用に短く）
  - **M4**: §4-5 の所在を `main.ts` 内 → **`daemon.ts:1411-1412 (initializeLayout 内、L1363 定義)`** に修正。リトライは `cmux.fetchLiveSurfaces(state.workspace ?? undefined)` の呼び出しを包む形で daemon.ts 内に置く
  - **m1**: §5.1 / §5.2 のテスト削除行範囲を実 grep 結果に整合（`mailbox-cli.test.ts` は 8 箇所 = L51/L62/L83/L97/L111/L139/L160/L182、`c11-features.test.ts` は L54/L72/L86/L99/L114/L166 等）。文言は「`process.env.ELEVENS_BACKEND = "cmux"` を含む全 test block を削除」に統一
  - **m2**: §3.6 末尾に「events.jsonl への出力は phase 2 で別途検討」の deferred を明示
  - **m3**: §2.1 c11-features.ts 行に「`isMailboxSupported()` の早期 return が引き続きガードするため throw 経路は実質増えない」を補記
  - **m4**: §3.2 に「`CMUX_BUNDLED_CLI_PATH` は c11.app launch 経由でのみ設定される env で、PATH lookup の `c11` が常に第 2 候補として残る」を 1 行補足

---

## 1. 概要 — 方針と全体像

### 1.1 ユーザー決定方針（不変条件）

- elevens は c11 substrate を前提に動くアプリケーション
- 「フォールバックして動かす」のではなく、**前提が崩れたら明示的にエラーで止める**
- 観察箱（observatory）原則: 失敗は **daemon に観測可能な形** で残す（manager.log / postMessage）

### 1.2 削除対象と非削除対象（誤削除防止）

| 対象 | 扱い |
|---|---|
| `SUBSTRATE_BINARY = ELEVENS_BACKEND \|\| "cmux"` フォールバック | **削除** |
| `detectBackendDecision` の `explicit` escape hatch（任意 backend 透過） | **削除** |
| `IS_C11_BACKEND` / `isC11Backend` の分岐 | **削除**（常に c11 一本化） |
| `maybeLogDeprecationNotice` / `__resetDeprecationNoticeForTest` | **削除** |
| `ELEVENS_BACKEND=cmux` で cmux を選ぶ経路 | **削除** |
| `newSurface()` 失敗 → `newSplit("right")` フォールバック | **削除** |
| `getPaneForSurface` の tree 失敗時 `undefined` 握り潰し | **修正**（substrate 不通は throw / fail-fast） |
| `layout-restore.ts` `pid_only` degrade による無条件続行 | **修正**（substrate 不通は起動中断） |
| `cmux.send` の timeout 欠如 | **修正**（timeout 付与） |
| `cmdSpawnAgent` の silent fail | **修正**（daemon に AGENT_SPAWN_FAILED 通知） |
| **`CMUX_*` env 名 / `cmux.ts` ファイル名 / `skills/cmux-team/` ディレクトリ名** | **非削除**（c11 が設定する正当な env / 内部名） |
| `CMUX_BUNDLE_ID` / `CMUX_BUNDLED_CLI_PATH` / `CMUX_SOCKET_PATH` / `CMUX_SURFACE` 等の read | **非削除**（c11 が提供する識別子） |

### 1.3 タスク全体像

A〜D を「テスト先行 → 実装 → docs」の順に進める。コミット粒度は A/B/C 各群ごと + テスト追補 + docs 更新で 5〜7 個程度。

---

## 2. 現状調査

### 2.1 対象コード（行番号付き）

#### `skills/cmux-team/manager/cmux.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L16-18 | `resolveSubstrateBinary` が `env.ELEVENS_BACKEND?.trim() \|\| "c11"` | `ELEVENS_BACKEND=cmux` をそのまま通す。さらに任意文字列を透過するため cmux への逃げ道が残る |
| L31 | `SUBSTRATE_BINARY = resolveSubstrateBinary(process.env)` | module-load 時の env のみで decide。`detectBackendDecision` の auto-detect 結果と独立 → 設計意図と実装の乖離 |
| L53-80 | `detectBackendDecision`（L54-56 の explicit 経路） | `ELEVENS_BACKEND` 明示で **任意 backend を許可**する escape hatch。これが cmux を生かす唯一の出口 |
| L87-91 | `isC11Backend(env)` | basename で c11 判定。一本化後は分岐不要 |
| L98-99 | `IS_C11_BACKEND = SUBSTRATE_BASENAME === "c11"` | 常に true 想定なので分岐不要 |
| L112-132 | `maybeLogDeprecationNotice` / `deprecationNoticeEmitted` / `__resetDeprecationNoticeForTest` | cmux 容認 warn。一本化により無意味 |
| L145 | `await execFile(SUBSTRATE_BINARY, args, opts)` | `runCmux` の実体。timeout は呼び出し側依存（send には付いていない） |
| L188-197 | `send()` が `runCmux` を **timeout なし** で呼ぶ | hang 時に固まる。tree は `TREE_TIMEOUT_MS = 5_000`（L245, L271）あり |
| L270 | `if (IS_C11_BACKEND && !opts?.json) args.push("--no-layout")` | c11 一本化後は `IS_C11_BACKEND` ガード不要 |
| L282-292 | `fetchLiveSurfaces` tree 失敗時 null 返却 + log のみ | 「surface 単に無い」と「substrate 不通」を区別していない |
| L294-309 | `getPaneForSurface` tree 失敗時 `undefined` + log のみ | 同上。caller (`cmdSpawnAgent` L3579) はこの undefined を `newSurface(targetPane)` に流し → 失敗 → `newSplit("right")` に逃げる |

#### `skills/cmux-team/manager/main.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L797-807 | `cmdStart` で `detectBackendDecision(process.env)` を呼び `refuse` で exit | OK（保つ）。ただし `explicit` 経路が cmux も通す → ここから cmux が起動できる |
| L848 | `await cmux.maybeLogDeprecationNotice()` | 削除予定 |
| L1054 | `backend: cmux.IS_C11_BACKEND ? "c11" : "cmux"` | `daemon_started` ログの分岐。一本化により `"c11"` 固定でよい（型も narrow） |
| L263 | `formatDaemonStartedDetail({ ..., backend: "cmux" \| "c11" })` | 型 narrow（`"c11"` のみへ） |
| L3578-3586 | `getCallerWorkspace` → `getPaneForSurface` → `newSurface(targetPane)` 失敗時 `newSplit("right")` フォールバック | substrate 不通 / pane 解決失敗が **無言で別 pane に逃げる**。これが KDG-lab 障害の発火点 |
| L3731-3790 | `cmux.send(surface, ...)` を直列で多数（export / cd / direnv allow / claude 起動） | 各 send が timeout なし。`cmux.send` の timeout 化で fail-fast |
| L3435- (`cmdSpawnAgent` 関数) | トップレベルで try-catch なし、cmux 操作失敗時 daemon 通知なし | stderr 止まりで `manager.log` に何も残らない → 観察不能 |

#### `skills/cmux-team/manager/c11-features.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L12 | `import { SUBSTRATE_BINARY, isC11Backend } from "./cmux"` | `isC11Backend` 削除に伴い import 修正 |
| L39 | `if (!isC11Backend(process.env)) return null` | 一本化後は ガード不要（常に c11）。**注: `getCapabilities` は try/catch で null fallback、`setMailbox` / `clearMailbox` 等は `isMailboxSupported()` ガード経由なので `capabilities` 不取得時は no-op となり、`isC11Backend` 早期 return を消しても throw 経路は実質増えない**（c11 不通でも daemon 内 callsite は safe）|
| L42, L121, L149, L199 | `execFile(SUBSTRATE_BINARY, args, ...)` | OK（保つ）|

#### `skills/cmux-team/manager/e2e.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L32 | `import { SUBSTRATE_BINARY } from "./cmux"` | OK（保つ）|
| L65, L71, L77, L83 | `execFile(SUBSTRATE_BINARY, [...])` | OK（保つ）|

#### `skills/cmux-team/manager/layout-restore.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L74 | `const treeDegraded = liveSurfaces === null` | tree 失敗を degrade として扱う |
| L96-101 | `if (treeDegraded) { alive.push(...); continue; }` | tree 失敗時 pid_only で **全 conductor を keep-alive 扱い**。substrate 恒常不通でも起動が継続してしまう |
| L65 | `liveSurfaces: Set<string> \| null` | API contract |

呼び出し側: `skills/cmux-team/manager/conductor.ts` 等（要 grep で確認、initializeLayout 経路）

#### `skills/cmux-team/manager/daemon.ts`

| 行 | コード | 問題点 |
|---|---|---|
| L1549 message switch | `AGENT_SPAWN_FAILED` の case が **無い** | 通知先となる handler を追加する必要あり |
| L1915-1992 | `AGENT_SPAWNED` handler | 既存 handler 構造のリファレンスとして使う |

### 2.2 grep で洗い出した全参照箇所

実装時は以下を `cd skills/cmux-team/manager && grep -n ...` で再洗い出し、漏れなく扱う:

```bash
# 削除対象シンボル
grep -rn "SUBSTRATE_BINARY\|ELEVENS_BACKEND\|IS_C11_BACKEND\|isC11Backend\|resolveSubstrateBinary\|detectBackendDecision\|maybeLogDeprecationNotice\|__resetDeprecationNoticeForTest" --include="*.ts" --include="*.md"

# cmux リテラル実行（"cmux" 文字列での実行経路）
grep -rn '"cmux"' --include="*.ts" skills/cmux-team/manager/

# cmux backend の docs / コメント記述
grep -rn "cmux backend\|legacy cmux\|opt-in.*cmux\|ELEVENS_BACKEND" --include="*.md"

# DEPRECATION_NOTICE / ELEVENS_NO_DEPRECATION_WARN
grep -rn "DEPRECATION_NOTICE\|ELEVENS_NO_DEPRECATION_WARN" --include="*.ts" --include="*.md"
```

**現時点で確認済みのファイル**:

- src (TS): `cmux.ts` / `main.ts` / `c11-features.ts` / `e2e.ts` / `layout-restore.ts` / `daemon.ts`
- test: `cmux.test.ts` / `c11-features.test.ts` / `mailbox-cli.test.ts` / `main.test.ts`
- docs: `docs/spec/05-install-and-infrastructure.md` / `docs/spec/13-mailbox-schema.md` / `docs/seed.md` / `CLAUDE.md` / `README.md` / `README.ja.md` / `CHANGELOG.md`
- artifacts: `.team/artifacts/A028-*.md` / `A029-*.md` / `A030-*.md`（歴史的記録、本文は触らない）

`main.ts` の `"cmux"` リテラルは L263 と L1054 のみ（grep 結果）。これらは `daemon_started` ログの型シグネチャ（`backend: "cmux" | "c11"`）なので、型を narrow して `backend: "c11"` 固定にする。

---

## 3. 設計判断（残す論点と推奨案）

### 3.1 `ELEVENS_BACKEND` env の扱い — **「廃止 = 認識しない」を推奨**

| 案 | 内容 | 評価 |
|---|---|---|
| **(A) 完全廃止** | `ELEVENS_BACKEND` を一切読まない。値が何であっても無視 | ✅ **推奨**。「c11 一本化」の意図と一致。env が残っても無害（コードが読まない） |
| (B) c11 パス差し替え専用に再定義 | `ELEVENS_BACKEND=/opt/c11-dev/bin/c11` のように c11 互換 binary の絶対パスのみ許可 | カスタムビルド差し替え需要を残せるが、basename チェックが必要で再び条件分岐が増える |
| (C) c11 binary 差し替えは別 env で | `ELEVENS_C11_BINARY` のような新 env を導入 | 命名統一は良いが今回スコープを広げる |

**推奨: (A)**。理由:

1. T016 の目的は「cmux への逃げ道を塞ぐ」。env 自体を読まなければ最も単純で誤動作余地ゼロ
2. c11 binary パスは下記 3.2 の解決順序で十分カバーできる（`CMUX_BUNDLED_CLI_PATH` が一次ソース）
3. 既存ユーザーが `ELEVENS_BACKEND=cmux` を pin していても、何も起こらず c11 解決に進む（読まれないだけ）。**「migration して」と言うのではなく構造的に無効化**する
4. 将来 c11 binary 差し替えが必要になれば別 env (`ELEVENS_C11_BINARY` 等) を新設する（YAGNI 適用）

なお `ELEVENS_NO_DEPRECATION_WARN` も同時に廃止（deprecation 通知自体を消すため）。

### 3.2 c11 binary の解決順序 — **`CMUX_BUNDLED_CLI_PATH` 一次 / PATH 上の `c11` フォールバック**

```
1. process.env.CMUX_BUNDLED_CLI_PATH があり、かつ /c11.app/ を含む    → そのパス
2. PATH 上の "c11"（execFile が PATH lookup する default）         → "c11"
3. それ以外                                                          → cmdStart で exit 1
```

`detectBackendDecision` (3.3) が auto-detect 段階で c11 を確定できなければ `refuse` を返すので、cmdStart は exit 1。auto 確定後の `SUBSTRATE_BINARY` 解決で `CMUX_BUNDLED_CLI_PATH` を優先するのは「実機 c11 が PATH 上 `c11` と一致するとは限らない」（c11.app/Resources/bin/c11 等の埋め込みケース）への対応。

> **補足 (m4)**: `CMUX_BUNDLED_CLI_PATH` は c11.app launch 経由でのみ設定される env（c11 自身が子プロセスに渡す）であり、設定されていないターミナル（PATH 上の `c11` を直接呼んだ場合や、c11 外で `elevens start` を叩いた場合）では常に PATH lookup の `"c11"` が第 2 候補として残る。`detectBackendDecision` の成功条件と `resolveC11Binary` の解決条件で **同じ env (`CMUX_BUNDLED_CLI_PATH`) と同じ `/\/c11\.app\//` regex に依存** することで、両者の判定が破綻なく一致する。

**推奨実装**: `SUBSTRATE_BINARY` を `let` ではなく `function resolveC11Binary(env): string` として遅延解決し、`cmdStart` で `detectBackendDecision` 成功後に値を確定する。ただし既存コードの依存（`runCmux` / `c11-features.ts` / `e2e.ts` が module-load-time 定数を import）を考えると、**module-load 時に `resolveC11Binary(process.env)` を 1 回評価する pure 関数化**で十分（auto-detect は cmdStart 側で行うので、env から `CMUX_BUNDLED_CLI_PATH` を見るだけならテストも安定）。

### 3.3 `detectBackendDecision` 単純化 — **2 値判定（c11 確定 / refuse）**

```typescript
export type BackendDecision =
  | { kind: "c11"; bundle: string; binary: string }
  | { kind: "refuse"; reason: string; observed: { bundleId?: string; cliPath?: string } };

export function detectBackendDecision(env: NodeJS.ProcessEnv = process.env): BackendDecision {
  if (env.CMUX_BUNDLE_ID === "com.stage11.c11") {
    return { kind: "c11", bundle: env.CMUX_BUNDLE_ID, binary: resolveC11Binary(env) };
  }
  const cliPath = env.CMUX_BUNDLED_CLI_PATH;
  if (cliPath && /\/c11\.app\//.test(cliPath)) {
    return { kind: "c11", bundle: env.CMUX_BUNDLE_ID ?? "(unknown via CLI path)", binary: cliPath };
  }
  return {
    kind: "refuse",
    reason: [
      "elevens は c11 multiplexer 上での起動を必要とします。",
      "Stage 11 Agentics の c11 (https://github.com/Stage-11-Agentics/c11) をインストールして、",
      "c11 surface 内で `elevens start` を実行してください。",
    ].join("\n"),
    observed: { bundleId: env.CMUX_BUNDLE_ID, cliPath: env.CMUX_BUNDLED_CLI_PATH },
  };
}
```

- 旧 `explicit` / `auto` を `c11` 一つに統合
- `binary` field を追加し、`cmdStart` が ここで決まった binary パスを `runCmux` 経路に反映できる

### 3.4 `layout-restore.ts` の degrade 戦略 — **短時間リトライ + 恒常不通で fail-fast**

| 案 | 内容 | 評価 |
|---|---|---|
| (A) 即 fail | tree 失敗即 exit 1 | ❌ 起動直後の一時的不通（c11 daemon ウォームアップ）で過度に脆い |
| **(B) 3 回リトライ（指数バックオフ 200ms / 600ms / 1500ms）後 fail** | 累計 ~2.3 秒。安定運用で見たことのない遅延ではない | ✅ **推奨** |
| (C) 旧 pid_only degrade 維持 | 現状維持 | ❌ T016 の意図と矛盾 |

**推奨: (B)**。`cmux.fetchLiveSurfaces` または `cmux.tree` 呼び出し側（initializeLayout 経路）で 3 回までリトライし、それでも失敗したら **`liveSurfaces === null` を返さず throw** する。`planLayoutRestore` の degrade 分岐（L96-101）は削除し、`liveSurfaces` 型を `Set<string>` non-null に narrow する。

実装の局所性: 既存 `planLayoutRestore` は pure 関数なのでシグネチャを `liveSurfaces: Set<string>` に narrow して degrade 分岐を消す。リトライは caller（`main.ts` の initializeLayout 経路）に置く。

### 3.5 substrate 操作 timeout — **`runCmux` 内に default 30s を持たせる**

| 候補 | 評価 |
|---|---|
| 5s（tree と同じ） | send は claude 起動コマンド等で長文を送るので短すぎる |
| **30s** | claude 起動文字列の入力が PTY echo を待つ最悪ケースでも余裕 |
| 60s | hang を fail-fast にする意義が薄れる |

**推奨: 30s + `runCmux` 内 default 化**。

#### 設計判断: 個別関数ごと vs `runCmux` default

| 案 | 内容 | 評価 |
|---|---|---|
| (a) 個別関数ごとに opts.timeout を付与 | `send / sendKey / closeSurface / renameTab / renameWorkspace / setStatus / notify / clearStatus` の各関数を改修 | 列挙漏れに弱い。`newSurface` / `newSplit` / `getCallerSurface` / `getCallerWorkspace` は timeout なしで残り、cmdSpawnAgent の起点 `newSurface(targetPane)` (L3583) が hang した場合に fail-fast にならない |
| **(b) `runCmux` 内で `opts.timeout ?? SEND_TIMEOUT_MS` の default** | `runCmux` を呼ぶ全関数が自動的に保護される。`tree` のような短 timeout が必要な関数は明示的に `{ timeout: TREE_TIMEOUT_MS }` を渡す | ✅ **推奨**。将来追加される runCmux 経由関数も自動保護（YAGNI 違反ではない、保護を取り損なう方が事故になる） |

**推奨実装** (`cmux.ts`):

```typescript
const SEND_TIMEOUT_MS = 30_000;   // substrate 操作の default timeout
const TREE_TIMEOUT_MS = 5_000;    // 既存維持（read-only query）

async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  const mergedOpts: RunCmuxOpts = { ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS };
  try {
    const { stdout, stderr } = await execFile(SUBSTRATE_BINARY, args, mergedOpts);
    // ...既存処理
  }
}
```

これにより以下が **自動で 30s timeout 保護される**:

- `send` (L188-197) / `sendKey` (L199-208) / `closeSurface` (L221-226) / `renameTab` (L228-235) / `renameWorkspace` (L237-242)
- `setStatus` / `clearStatus` / `notify` (best-effort 系。catch 済みだが hang は防ぐ)
- **`newSplit` (L163-175) / `newSurface` (L177-186)** — `cmdSpawnAgent` の起点 `newSurface(targetPane)` (`main.ts` L3583) が c11 不通で hang した場合に fail-fast 化
- **`getCallerSurface` (L378-386) / `getCallerWorkspace` (L438-446)** — identify hang による daemon 起動ブロックを防ぐ

`tree` (L262-273) は **既存の `{ timeout: TREE_TIMEOUT_MS }` を保持**（既に明示渡し済み、default より短い 5s）。`readScreen` も既存の `{ timeout: 10_000 }` を保持。

#### tree (5s) と send (30s) を区別する理由

tree は read-only で daemon に軽い query（応答時間 < 100ms 想定）。一方 send は PTY echo を待つので claude 起動コマンド等で時間がかかる可能性がある（最悪 ~10s）。区別することで「substrate が live だが応答が遅い」状態の検出粒度を上げる。

### 3.6 AGENT_SPAWN_FAILED の通知方式 — **`postMessage` + `manager.log` 二重 + daemon slot 掃除**

| 案 | 評価 |
|---|---|
| (A) `manager.log` のみ | 観察可能だが daemon の state 更新（agent registry 等）には反映されない |
| (B) `postMessage` のみ | daemon に届くが、daemon プロセス未起動だと silent skip。spawn-agent の前段で daemon は live のはずなので通常は OK |
| **(C) 両方** | log と state の両方に残せる。observability 最大 | ✅ **推奨** |

**推奨: (C)**。`cmdSpawnAgent` トップレベルで try-catch し、失敗時:

1. `postMessage({ type: "AGENT_SPAWN_FAILED", conductorSurface, surface?, role, reason, error, timestamp, callerPid })` を送信
2. `await log("spawn_agent_failed", ...)` で `manager.log` にも書き込む
3. `console.error(...)` で CLI stderr にも出す（Conductor が読む）
4. `process.exit(1)`

#### スキーマ（**修正: `surface?: string` を追加**）

```typescript
type AgentSpawnFailedMessage = {
  type: "AGENT_SPAWN_FAILED";
  conductorSurface: string;            // 親 Conductor の surface（必須）
  surface?: string;                    // 失敗 agent 自身の surface（newSurface 成功後に失敗した場合のみセット。newSurface 自体が失敗なら undefined）
  role?: string;                       // agent role
  reason: string;                      // 失敗理由（error.message 等）
  error?: string;                      // 元 error の追加情報
  timestamp: string;                   // ISO8601
  callerPid: number;                   // spawn-agent CLI 自身の PID
  callerSurface?: string;              // process.env.CMUX_SURFACE
};
```

**なぜ `surface?` が必要か**: `cmdSpawnAgent` の実コード順は **(a) `newSurface` (L3583) → (b) AGENT_SPAWNED post (L3597) → (c) `cmux.send` 群 (L3731-3790)** であり、`AGENT_SPAWNED` は send 失敗より **前** に既に送信されている。daemon は AGENT_SPAWNED 受信時点で `conductor.agents.push({ surface, role, ... })` (`daemon.ts:1968-1978`) し、agent slot を確保している。

ここで send 群が失敗すると、`AGENT_SPAWN_FAILED` に **失敗 agent の surface** を載せないと daemon 側で対応する `conductor.agents` エントリを特定できず、phantom slot として永続残留する（SESSION_STARTED 経路の自己回復に頼ると tick 待ちで観察箱原則からも望ましくない）。

#### daemon side handler（**仮登録 race の slot 掃除を含める**）

`daemon.ts` の `handleMessage` switch に新設:

```typescript
case "AGENT_SPAWN_FAILED": {
  await log(
    "agent_spawn_failed",
    `${formatSurface(message.conductorSurface, "C")}` +
      (message.surface ? ` agent=${formatSurface(message.surface, "S")}` : "") +
      ` role=${message.role ?? "?"} reason=${message.reason ?? ""}`,
  );
  // 仮登録 race を片付ける: AGENT_SPAWNED 後に send 失敗したケースで phantom slot を除去
  if (message.surface) {
    const conductor = state.conductors.find(c => c.surface === message.conductorSurface);
    if (conductor) {
      const idx = conductor.agents.findIndex(a => a.surface === message.surface);
      if (idx >= 0) {
        conductor.agents.splice(idx, 1);
        await log(
          "agent_spawn_failed_slot_cleaned",
          `${formatSurface(message.conductorSurface, "C")} removed=${formatSurface(message.surface, "S")}`,
        );
      }
    }
  }
  notifyStateChanged("daemon.ts:handleMessage:agent_spawn_failed");
  break;
}
```

> **m2 (deferred)**: `events.jsonl` への AGENT_SPAWN_FAILED 出力は phase 2 で別途検討する。`docs/spec/10-events-stream.md` で `reload_failed` 等が 3 経路通知（manager.log / daemon.heartbeat / events.jsonl）になっている例があるので、observatory 原則的には流すべきだが、本 task のスコープでは manager.log + state 掃除に留め、events.jsonl 連携は別 issue 化。

---

## 4. 実装ステップ（TDD 順）

T016 はテスト先行で進める。各ステップで「テストを書き失敗を確認 → 実装で pass → 個別テスト実行」のサイクル。`bun test` 全体実行は禁忌（CLAUDE.md）。

> 個別テストの実行方法:
> ```bash
> cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
> ```

### Step 0: 準備

1. `cd /Users/yamamoto/git/elevens/.worktrees/task-016-1779306524`
2. `cd skills/cmux-team/manager && bun install`（package.json があれば）
3. `git status` で worktree がクリーンであることを確認

### Step 1 (A: backend レベル) — `cmux.ts` を c11 専用化

**テスト先行** (`cmux.test.ts` を改修):

1. 既存の `resolveSubstrateBinary` / `isC11Backend` テスト群（L60-104）を **削除**。代わりに `resolveC11Binary` を新規テスト:
   - `resolveC11Binary({})` → `"c11"` (PATH fallback)
   - `resolveC11Binary({ CMUX_BUNDLED_CLI_PATH: "/Applications/c11.app/Contents/Resources/bin/c11" })` → そのパス
   - `resolveC11Binary({ CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux" })` → `"c11"` (cmux.app パスは無視)
   - `resolveC11Binary({ ELEVENS_BACKEND: "cmux" })` → `"c11"` (env を読まないことを assert)
2. `detectBackendDecision` テスト (L106-180) を 2 値判定に再構成:
   - `CMUX_BUNDLE_ID=com.stage11.c11` → `{ kind: "c11", ... }`
   - `CMUX_BUNDLED_CLI_PATH` が `/c11.app/` 含む → `{ kind: "c11", ... }`
   - env が空 → `{ kind: "refuse", ... }`
   - `ELEVENS_BACKEND=cmux` 単独 → `{ kind: "refuse", ... }` (escape hatch 消滅を確認)
   - `CMUX_BUNDLE_ID=com.manaflow.cmux` → `{ kind: "refuse", observed.bundleId: "com.manaflow.cmux" }`
3. `maybeLogDeprecationNotice` describe (L271-336) を **削除**
4. **`process.env.ELEVENS_BACKEND = "cmux"` を含む全 test block を削除**（一本化により「!c11」経路が存在しないため）:
   - `c11-features.test.ts`: L54 / L72 / L86 / L99 / L114 / L166 の各テスト本体（および setup 行）。`!isC11Backend` 経路を踏むテストは `isMailboxSupported() === false` を fake する形に書き換え（c11 build に mailbox サポートが無いケースの観察箱として残す）
   - `mailbox-cli.test.ts`: L51 / L62 / L83 / L97 / L111 / L139 / L160 / L182 の各テスト本体（**8 箇所**）
5. テストを失敗させる: `bun test --timeout 30000 cmux.test.ts` で削除した import などにより failing になることを確認

**実装** (`cmux.ts`):

1. `resolveSubstrateBinary` (L16-18) → `resolveC11Binary(env)` にリネーム。実装:
   ```typescript
   export function resolveC11Binary(env: NodeJS.ProcessEnv): string {
     const cliPath = env.CMUX_BUNDLED_CLI_PATH;
     if (cliPath && /\/c11\.app\//.test(cliPath)) return cliPath;
     return "c11";
   }
   ```
2. `SUBSTRATE_BINARY` (L31) → `export const SUBSTRATE_BINARY: string = resolveC11Binary(process.env)`（名前は維持: 他ファイル多数 import）
3. `BackendDecision` 型 (L48-51) と `detectBackendDecision` (L53-80) を 3.3 の 2 値判定に置き換え
4. `isC11Backend` (L87-91) を **削除**
5. `IS_C11_BACKEND` (L98-99) と `SUBSTRATE_BASENAME` を **削除**
6. `maybeLogDeprecationNotice` / `__resetDeprecationNoticeForTest` / `deprecationNoticeEmitted` (L112-132) を **削除**
7. `tree` (L270): `if (IS_C11_BACKEND && !opts?.json)` → `if (!opts?.json)`（常に c11 なのでガード不要）
8. テストを pass させる: `bun test --timeout 30000 cmux.test.ts`

### Step 2 (A4: caller 側の `IS_C11_BACKEND` / `isC11Backend` 参照を一掃)

**テスト先行**:

- `main.test.ts` の `formatDaemonStartedDetail` テスト（`backend` field を期待するもの）を `backend: "c11"` 固定に書き換える

**実装**:

1. `main.ts` L1054: `backend: cmux.IS_C11_BACKEND ? "c11" : "cmux"` → `backend: "c11"`
2. `main.ts` L263 `formatDaemonStartedDetail` のシグネチャ: `backend: "cmux" | "c11"` → `backend: "c11"`
3. `main.ts` L848 `await cmux.maybeLogDeprecationNotice()` を **削除**（L845-848 のコメントブロックも）
4. `main.ts` L797-807 `cmdStart` の backendDecision 処理: 新シグネチャ (`{ kind: "c11" | "refuse" }`) に合わせる
5. `c11-features.ts` L12 `import { SUBSTRATE_BINARY, isC11Backend } from "./cmux"` → `import { SUBSTRATE_BINARY } from "./cmux"`
6. `c11-features.ts` L39 `if (!isC11Backend(process.env)) return null` を **削除**（常に c11）
7. 関連コメント (`cmux backend では...` 等) を `c11 専用` に書き換え
8. `bun test --timeout 30000 main.test.ts` / `c11-features.test.ts` 個別実行で pass を確認

### Step 3 (A6: `ELEVENS_BACKEND` env を一切読まない)

**テスト先行**:

- `cmux.test.ts` に regression テスト: `resolveC11Binary({ ELEVENS_BACKEND: "cmux" })` → `"c11"`（既に Step 1 で追加）
- `detectBackendDecision({ ELEVENS_BACKEND: "cmux" })` → `{ kind: "refuse" }`（既に Step 1 で追加）

**実装**: Step 1 で完了済み（`env.ELEVENS_BACKEND` への参照を全削除）。

ただし grep で残存確認:

```bash
grep -rn "ELEVENS_BACKEND\|ELEVENS_NO_DEPRECATION_WARN" --include="*.ts" skills/cmux-team/manager/
```

ヒットゼロを確認。テストファイル内のコメント / `process.env.ELEVENS_BACKEND = "cmux"` の setup 経路も削除（Step 1 で削除済みのはず）。

### Step 4 (B7-9: 操作レベルの fail-fast 化)

**テスト先行**:

新規テスト `cmux.test.ts` に追加 / または `main.test.ts` に追加:

1. `getPaneForSurface` が tree 失敗 → throw する（fake cmux で `exit 1`）。「surface が見つからない」（tree 成功だが該当 surface なし）は引き続き `undefined` を返す
2. `fetchLiveSurfaces` が tree 失敗 → throw する（旧: null + log）
3. `layout-restore.test.ts`（新規 or 既存があれば追加）: `planLayoutRestore` の `liveSurfaces` 型 narrow 後、`liveSurfaces` は非 null 前提でテスト
4. `cmdSpawnAgent` の `newSurface` 失敗時 `newSplit` フォールバックが **発火しない** (failing test) — 失敗が呼び出し元に伝播することを確認

**実装**:

#### 4-1: `cmux.ts` `getPaneForSurface` (L294-309) を修正

```typescript
export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  // tree 失敗（substrate 不通）は throw。caller でハンドリング
  const output = await tree(workspace);  // 既存の catch を削除し try/catch を撤去
  const lines = output.split("\n");
  let currentPane: string | undefined;
  for (const line of lines) {
    const paneMatch = line.match(/pane (pane:\d+)/);
    if (paneMatch) currentPane = paneMatch[1];
    if (line.includes(surface) && currentPane) return currentPane;
  }
  return undefined;  // surface が tree 出力に無い場合（substrate は live）
}
```

#### 4-2: `cmux.ts` `fetchLiveSurfaces` (L282-292) を修正

```typescript
export async function fetchLiveSurfaces(workspace?: string): Promise<Set<string>> {
  if (!workspace) {
    throw new Error("fetchLiveSurfaces: workspace is required");
  }
  // tree 失敗時は throw — caller のリトライポリシーに委ねる
  const output = await tree(workspace);
  const matches = output.match(/surface:\d+/g) ?? [];
  return new Set(matches);
}
```

戻り型 `Set<string> | null` → `Set<string>` に narrow。

#### 4-3: `main.ts` `cmdSpawnAgent` L3578-3586 のフォールバック撤去

```typescript
const callerWorkspace = await cmux.getCallerWorkspace();
const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);
// pane 解決失敗（undefined）でも newSurface() に渡す。失敗したら throw して上位 try/catch でハンドリング
const surface = await cmux.newSurface(targetPane);
// ↑ 旧: try { await newSurface(targetPane) } catch { await newSplit("right") } を撤去
```

ただし `cmdSpawnAgent` 全体を Step 5 (C) で try/catch でラップするので、ここでは生 throw でよい。

#### 4-4: `layout-restore.ts` `planLayoutRestore` を修正

- シグネチャ: `liveSurfaces: Set<string> | null` → `liveSurfaces: Set<string>`
- L74 `const treeDegraded = liveSurfaces === null` を削除
- L96-101 の `if (treeDegraded)` 分岐を削除
- L85 `liveSurfaces ? liveSurfaces.has(c.surface) : true` → `liveSurfaces.has(c.surface)`

#### 4-5: `daemon.ts:1411-1412` (initializeLayout 内、L1363 定義) に短時間リトライを実装

**所在の正確化**: `initializeLayout` は `daemon.ts:1363` で定義され、`state.workspace` を参照しながら `cmux.fetchLiveSurfaces(state.workspace ?? undefined)` を `daemon.ts:1412` で呼んでいる。`main.ts:1623` は `initializeLayout(state, daemonSurface, rawResumePlan)` を呼ぶだけのため、**リトライ実装の置き場は daemon.ts 内が正しい**。

`daemon.ts:1412` の `cmux.fetchLiveSurfaces(...)` 呼び出しをラップする形で以下を実装:

```typescript
// daemon.ts 内ヘルパー (initializeLayout 関数直前または同ファイル先頭付近)
async function fetchLiveSurfacesWithRetry(workspace: string | undefined): Promise<Set<string>> {
  const delays = [200, 600, 1500];
  let lastError: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await cmux.fetchLiveSurfaces(workspace);
    } catch (e) {
      lastError = e;
      if (i < delays.length) {
        await log("tree_fetch_retry", `attempt=${i + 1} workspace=${workspace ?? "(none)"} delay_ms=${delays[i]}`);
        await sleep(delays[i]);
      }
    }
  }
  throw lastError;
}
```

`daemon.ts:1412` の差し替え:

```typescript
// 既存 conductor あり → planLayoutRestore でマトリクス分類 → applyRestorePlan で副作用適用
let liveSurfaces: Set<string>;
try {
  liveSurfaces = await fetchLiveSurfacesWithRetry(state.workspace ?? undefined);
} catch (e: any) {
  console.error(
    `[elevens] c11 substrate not responding to 'tree' after 3 retries — refusing to start: ${e?.message ?? e}`,
  );
  await log("tree_fetch_failed_terminal", `workspace=${state.workspace ?? "(none)"} ${e?.message ?? e}`);
  process.exit(1);
}
const plan = planLayoutRestore(
  conductorsFromJson,
  liveSurfaces,
  cmux.isAlive,
  resumePlan ?? [],
);
```

`fetchLiveSurfaces` の戻り値型は §4-2 で `Set<string>` に narrow 済み。`planLayoutRestore` のシグネチャも §4-4 で `liveSurfaces: Set<string>` に narrow されているので、この経路は型整合する。

#### 4-6: 個別テスト実行

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
cd skills/cmux-team/manager && bun test --timeout 30000 layout-restore.test.ts   # 存在すれば
cd skills/cmux-team/manager && bun test --timeout 30000 main.test.ts
```

### Step 5 (C10-11: spawn-agent silent fail 解消 + send timeout)

**テスト先行**:

1. `cmux.test.ts` に `send` の timeout テスト追加: fake cmux が 60s sleep する script で `send(...)` を呼び、30s 程度で reject されることを確認（hang 検出）
2. `main.test.ts` に `cmdSpawnAgent` 失敗時の通知テスト追加: `cmux.send` が throw した場合に
   - `postMessage` が `type: "AGENT_SPAWN_FAILED"` で呼ばれている
   - `manager.log` に `spawn_agent_failed` が含まれる
   - exit code が 1
3. `daemon.test.ts` に `AGENT_SPAWN_FAILED` handler のスモークテスト追加（最小実装の挙動を確認）

**実装**:

#### 5-1: `cmux.ts` `runCmux` に default timeout 30s を持たせる（M3 反映）

§3.5 の設計に従い、**個別関数ごとではなく `runCmux` 内で default 化**する:

```typescript
const SEND_TIMEOUT_MS = 30_000;

async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  const mergedOpts: RunCmuxOpts = { ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS };
  try {
    const { stdout, stderr } = await execFile(SUBSTRATE_BINARY, args, mergedOpts);
    // ...既存処理（formatExecError による wrap など）はそのまま
  }
}
```

これにより `send` / `sendKey` / `closeSurface` / `renameTab` / `renameWorkspace` / `setStatus` / `notify` / `clearStatus` / **`newSplit` / `newSurface` / `getCallerSurface` / `getCallerWorkspace`** が一斉に 30s timeout 保護される。個別関数の signature 変更は不要。

`tree` (`TREE_TIMEOUT_MS = 5_000`) と `readScreen` (`{ timeout: 10_000 }`) は既に明示渡しなので default より短い値が維持される。

#### 5-2: `cmdSpawnAgent` (`main.ts` L3435-3822) をトップレベルで try/catch する

関数本体を:

```typescript
async function cmdSpawnAgent(): Promise<void> {
  // ... 既存処理 ...
  try {
    // ↓ 既存処理を try でラップ
    if (hasHelpFlag()) showHelp(...);
    // ... 全 spawn 経路 ...
    console.log(`SURFACE=${surface}`);
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    try {
      await postMessage({
        type: "AGENT_SPAWN_FAILED",
        conductorSurface,    // 引数解決後の値
        role,                // 引数解決後の値
        reason,
        timestamp: new Date().toISOString(),
        callerPid: process.pid,
        callerSurface: process.env.CMUX_SURFACE,
      });
    } catch {}  // post 失敗は log に止める
    await log("spawn_agent_failed", `conductor=${conductorSurface ?? "?"} role=${role ?? "?"} reason=${reason}`).catch(() => {});
    console.error(`[elevens] spawn-agent failed: ${reason}`);
    process.exit(1);
  }
}
```

`conductorSurface` / `role` は引数 parse 失敗の段階では未定義なので、try の冒頭で let で宣言 → parse 後に代入する。または引数 parse 部分を try の外に置いて、`cmux.send` 等の **実 substrate 操作** だけを try でラップする方針も可（後者の方が「token throttle 等の既存 exit 経路を壊さない」ので推奨）。

**推奨**: 引数 parse・throttle ガード等の既存 exit 経路はそのまま保持し、`// --- 3. タブ作成` (L3574) 以降の substrate 操作部分のみ try でラップする。これで「token throttle exit 75」「direnv exit 1」等の既存挙動は保たれ、cmux 操作失敗だけが新 handler に乗る。

#### 5-3: daemon に `AGENT_SPAWN_FAILED` handler を追加 (`daemon.ts` L1549 switch、M1 反映 — 仮登録 race 用 slot 掃除込み)

§3.6 の設計に合わせ、`message.surface` があれば対応する `conductor.agents` entry を `findIndex` + `splice` で掃除する:

```typescript
case "AGENT_SPAWN_FAILED": {
  await log(
    "agent_spawn_failed",
    `${formatSurface(message.conductorSurface, "C")}` +
      (message.surface ? ` agent=${formatSurface(message.surface, "S")}` : "") +
      ` role=${message.role ?? "?"} reason=${message.reason ?? ""}`,
  );

  // 仮登録 race の slot 掃除: AGENT_SPAWNED 後に send 失敗したケースで phantom slot を除去
  if (message.surface) {
    const conductor = state.conductors.find(c => c.surface === message.conductorSurface);
    if (conductor) {
      const idx = conductor.agents.findIndex(a => a.surface === message.surface);
      if (idx >= 0) {
        conductor.agents.splice(idx, 1);
        await log(
          "agent_spawn_failed_slot_cleaned",
          `${formatSurface(message.conductorSurface, "C")} removed=${formatSurface(message.surface, "S")}`,
        );
      }
    }
  }
  notifyStateChanged("daemon.ts:handleMessage:agent_spawn_failed");
  break;
}
```

**dashboard / UI 反映 (将来 issue)**: 上記の slot 掃除は agent registry の整合性を即時に保つための最小実装。dashboard 側で「spawn 失敗イベントを可視化する」UI（赤バッジ・通知行 etc.）は別 issue で扱う。events.jsonl 連携 (m2 で deferred とした件) も同じく phase 2。

#### 5-2 における `surface` の引き回し

`main.ts` の `cmdSpawnAgent` 内で `newSurface(targetPane)` の戻り値（成功時の surface）を try ブロックの上位スコープに保持し、catch 節で `postMessage(...)` に `surface: createdSurface` として渡す:

```typescript
let createdSurface: string | undefined;  // try の外で宣言
try {
  // ... 引数 parse 後 ...
  createdSurface = await cmux.newSurface(targetPane);
  await postMessage({ type: "AGENT_SPAWNED", surface: createdSurface, ... });
  // ... cmux.send 群 ...
} catch (e: any) {
  await postMessage({
    type: "AGENT_SPAWN_FAILED",
    conductorSurface,
    surface: createdSurface,    // newSurface 成功後の失敗ならセット、newSurface 自体失敗なら undefined
    role,
    reason: e?.message ?? String(e),
    error: String(e),
    timestamp: new Date().toISOString(),
    callerPid: process.pid,
    callerSurface: process.env.CMUX_SURFACE,
  }).catch(() => {});
  // ... log / console.error / exit(1)
}
```

#### 5-4: main.ts CLI の `send` (L1858 switch) に `AGENT_SPAWN_FAILED` case を追加

`SURFACE_REQUIRED_TYPES` には含めない（spawn 失敗時に surface が無いケースもあるため）。`conductor-surface` は必須にする。

#### 5-5: 個別テスト実行

```bash
cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
cd skills/cmux-team/manager && bun test --timeout 30000 main.test.ts
cd skills/cmux-team/manager && bun test --timeout 30000 daemon.test.ts  # 存在すれば
```

### Step 6: 全 manager テスト個別実行で regression なしを確認

CLAUDE.md の禁忌に従い、`bun test` 全体実行はせず、個別ファイルを直列で回す:

```bash
cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  echo "=== $f ==="
  bun test --timeout 30000 "$f" || echo "FAILED: $f"
done
```

すべて pass することを確認。失敗があればこの計画書を更新してから直す（plan→test→fix サイクル）。

### Step 7: docs 更新

#### 7-1: `docs/spec/05-install-and-infrastructure.md`

- backend 記述（あれば）を c11 専用に書き換え
- `ELEVENS_BACKEND` への言及を全削除

#### 7-2: `docs/seed.md`

- L141-148 Phase 3 を「✅ 完了」に書き換え
  - `ELEVENS_BACKEND` の default 反転（v0.9.0）→ 維持
  - cmux backend deprecated → 「cmux backend 完全削除（vX.Y.Z）」に書き換え
  - cmux 固有 paths 削除 → 完了
- L119-128 Phase 1 の `ELEVENS_BACKEND=c11|cmux` 記述は歴史的経緯としてそのまま残し、上に「**現在: c11 専用 (T016)**」の注記を追加

#### 7-3: `docs/spec/13-mailbox-schema.md` L27

- `c11 backend が無い環境（cmux backend 等）では setMailbox は opportunistic no-op` → 削除（または「mailbox 非対応の c11 build では no-op」に書き換え）

#### 7-4: `CLAUDE.md`

- backend に関する記述があれば確認・更新（grep）
- 現状: `CLAUDE.md` 内に `ELEVENS_BACKEND` への直接言及は無い（grep 結果）。確認のみ

#### 7-4b: `skills/c11/SKILL.md`（**M2 で追加**）

- **L9** YAML frontmatter `description:` から `ELEVENS_BACKEND=c11 (default since v0.9.0)` の文言を削除。description は invocation trigger になるため keyword を残すと誤誘導:

  ```yaml
  # 旧
  `ELEVENS_BACKEND=c11` (default since v0.9.0) / cmux との差分。
  # 新（例）
  `CMUX_BUNDLE_ID` (c11 detection) / cmux との差分（歴史的比較）。
  ```

- **L17** 本文冒頭の opt-in 記述を削除:

  ```markdown
  # 旧
  elevens は **c11 (Stage-11-Agentics/c11) を substrate として動く**。v0.9.0 以降は env 未設定でも
  c11 が default。`ELEVENS_BACKEND=cmux` で legacy cmux に opt-in 可能（deprecated）。

  # 新
  elevens は **c11 (Stage-11-Agentics/c11) を substrate として動く**。T016 (vX.Y.Z) 以降は
  c11 専用で、cmux backend サポートは撤去された。c11 が検出できなければ `elevens start` は
  exit 1 する。
  ```

- 同ファイル内の他箇所に `ELEVENS_BACKEND` が残っていないか `grep -n "ELEVENS_BACKEND" skills/c11/SKILL.md` で確認

#### 7-5: `README.md` L77-98 `### Substrate backend (ELEVENS_BACKEND)`

```markdown
### Substrate

elevens runs on top of [c11](https://github.com/Stage-11-Agentics/c11), Stage 11 Agentics'
macOS-native terminal multiplexer. Install c11 and launch `elevens start` from inside a c11 surface.

`ELEVENS_BACKEND` is no longer read (removed in vX.Y.Z, T016). If c11 cannot be detected,
`elevens start` exits with a clear error. Legacy `cmux` is no longer supported.
```

`Custom builds and absolute paths...` の行は削除（または `CMUX_BUNDLED_CLI_PATH` が c11 自身によって設定される事実だけ残す）。

#### 7-6: `README.ja.md` L77-98

README.md と同じ内容を日本語で:

```markdown
### Substrate

elevens は [c11](https://github.com/Stage-11-Agentics/c11)（Stage 11 Agentics の
macOS ネイティブ terminal multiplexer）の上で動きます。c11 をインストールし、c11 surface 内で
`elevens start` を実行してください。

`ELEVENS_BACKEND` は vX.Y.Z (T016) 以降参照されません。c11 が検出できなければ `elevens start` は
明示エラーで exit します。legacy `cmux` は非サポートです。
```

#### 7-7: `CHANGELOG.md`

未リリース節（または新規節）に追加:

```markdown
## [Unreleased]

### Removed (BREAKING)

- **cmux backend サポートを完全削除（T016）**。`ELEVENS_BACKEND` env は参照されなくなり、
  c11 multiplexer が検出できなければ `elevens start` は exit 1 する。
  - `ELEVENS_BACKEND=cmux` で cmux に opt-in する経路を削除
  - `IS_C11_BACKEND` / `isC11Backend` / `maybeLogDeprecationNotice` を削除
  - `newSurface()` 失敗時の `newSplit("right")` フォールバックを削除
  - `getPaneForSurface` / `fetchLiveSurfaces` の tree 失敗握り潰しを廃止し throw に変更
  - `layout-restore.ts` の `pid_only` degrade（substrate 不通でも起動継続）を削除

### Added

- `cmux.send` / `sendKey` / その他 substrate 操作に 30s timeout を付与（hang 検出）
- `AGENT_SPAWN_FAILED` メッセージタイプを daemon に追加し、`cmdSpawnAgent` の cmux 操作失敗を観測可能化
- `initializeLayout` の tree 取得に 3 回リトライ（200ms / 600ms / 1500ms）を実装。最終失敗は exit 1
```

### Step 8: 完了検証（手動）

実機で `c11` 未起動環境にて以下を確認:

```bash
cd <test-project> && unset CMUX_BUNDLE_ID CMUX_BUNDLED_CLI_PATH && bun run skills/cmux-team/manager/main.ts start
# → exit 1 with "elevens は c11 multiplexer 上での起動を必要とします" メッセージ
```

`ELEVENS_BACKEND=cmux` 環境変数を設定しても挙動が変わらない（=以前のように cmux に逃げない）ことを確認:

```bash
ELEVENS_BACKEND=cmux bun run skills/cmux-team/manager/main.ts start
# → ELEVENS_BACKEND は読まれないので上と同じく exit 1
```

`grep -n '"cmux"' skills/cmux-team/manager/*.ts | grep -v "test\|.cmux backend (legacy)" | grep -v "manaflow.cmux"` でリテラル `"cmux"` 実行経路がゼロであることを確認（残るのは `CMUX_BUNDLE_ID=com.manaflow.cmux` 検出のような refuse 経路のみ）。

### Step 9: コミット & 統合

コミット粒度（推奨）:

1. `test(backend): cmux backend 削除のための failing tests を追加 (T016)`
2. `feat(backend)!: cmux backend を撤廃し c11 専用化 (T016 / A)`
3. `feat(backend): newSurface / tree 失敗時に fail-fast (T016 / B)`
4. `feat(spawn-agent): AGENT_SPAWN_FAILED を daemon に通知 + cmux.send timeout (T016 / C)`
5. `docs: cmux backend 撤廃を反映 (T016)`
6. `chore: CHANGELOG に T016 BREAKING を追加`

各コミット末尾に `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` を付ける。

### Step 10: 完了報告

`conductor-role.md` の Step 1〜12 に従い `elevens close-task --task-id 016 --deliverable-kind merged --journal "..."` で close。本タスクは BREAKING change なので journal に「`ELEVENS_BACKEND` を unset / `c11` 以外で pin している運用者は migration が必要」を明示する。

---

## 5. テスト計画

### 5.1 追加・修正するテストファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/cmux.test.ts` | `resolveSubstrateBinary` テスト群削除 → `resolveC11Binary` テスト追加 / `isC11Backend` テスト群削除 / `detectBackendDecision` を 2 値判定に書き換え / `maybeLogDeprecationNotice` describe 削除 / **`runCmux` default timeout のテスト追加**（fake binary が 60s sleep → 30s 程度で reject されることを確認）/ `getPaneForSurface` の throw テスト追加 / `fetchLiveSurfaces` の throw テスト追加 |
| `skills/cmux-team/manager/c11-features.test.ts` | **`process.env.ELEVENS_BACKEND = "cmux"` を含む全 test block を削除**（実 grep 結果: **L54 / L72 / L86 / L99 / L114 / L166**。「!isC11Backend」経路が消えるため `isMailboxSupported() === false` 経路の代替検証に書き換える） |
| `skills/cmux-team/manager/mailbox-cli.test.ts` | **`process.env.ELEVENS_BACKEND = "cmux"` を含む全 test block を削除**（実 grep 結果: **8 箇所** = L51 / L62 / L83 / L97 / L111 / L139 / L160 / L182） |
| `skills/cmux-team/manager/main.test.ts` | `formatDaemonStartedDetail` テストの backend field を `"c11"` 固定に / `cmdSpawnAgent` 失敗時 `AGENT_SPAWN_FAILED` post + log のテスト追加（**`surface?: string` を含めて assert**：newSurface 成功後の send 失敗時に surface がセットされること、newSurface 自体失敗時は undefined であること）/ `newSurface` 失敗時に fallback しないテスト追加 |
| `skills/cmux-team/manager/layout-restore.test.ts`（存在すれば） | `liveSurfaces: Set<string>` への型 narrow に追従。`null` ケースを削除 |
| `skills/cmux-team/manager/daemon.test.ts`（存在すれば） | `AGENT_SPAWN_FAILED` handler のスモークテスト追加（**`message.surface` あり → `conductor.agents` から該当 entry が splice されることを assert**、`message.surface` なし → state 変更なし） |

### 5.2 cmux 前提テストの扱い

T015 で `ELEVENS_BACKEND=cmux` を test 本体で注入していた経路（`c11-features.test.ts` / `mailbox-cli.test.ts` の各 test 内 `process.env.ELEVENS_BACKEND = "cmux"`）は、**「!isC11Backend 経路の観察箱」としての価値を失う**（経路自体が消えるため）。

**実 grep 結果**（実装時の照合用）:

- `mailbox-cli.test.ts`: **8 箇所** — L51, L62, L83, L97, L111, L139, L160, L182
- `c11-features.test.ts`: L54, L72, L86, L99, L114, L166

**方針**: `process.env.ELEVENS_BACKEND = "cmux"` を含む test block をまとめて削除（行範囲を個別指定するのではなく、grep 結果を一網打尽にする）。`isC11Backend` import が消えるので setup の戻し (`process.env.ELEVENS_BACKEND = original`) も同時撤去。`mailbox-cli.test.ts` 全体で `setMailbox` / `clearMailbox` の no-op 経路は `isMailboxSupported() === false` を fake する形に書き換える（c11 build に mailbox サポートが無い実機ケースを引き続き検証できる）。

### 5.3 個別実行コマンド一覧

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 cmux.test.ts
bun test --timeout 30000 c11-features.test.ts
bun test --timeout 30000 mailbox-cli.test.ts
bun test --timeout 30000 main.test.ts
bun test --timeout 30000 layout-restore.test.ts        # 存在すれば
bun test --timeout 30000 daemon.test.ts                # 存在すれば

# 全体は禁忌だが、念のため個別ファイルを順次回す:
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f" || echo "FAILED: $f"
done
```

---

## 6. docs 更新（章 4 / Step 7 の再掲・チェックリスト形式）

| ファイル | 章節 | 更新方針 |
|---|---|---|
| `docs/spec/05-install-and-infrastructure.md` | backend / substrate 言及（grep で確認） | c11 専用に統一。`ELEVENS_BACKEND` への言及削除 |
| `docs/spec/13-mailbox-schema.md` L27 | `cmux backend 等では opportunistic no-op` | 「mailbox 非対応の c11 build では no-op」に書き換え |
| `docs/seed.md` L141-148 | Phase 3 cmux サポート段階削除 | 完了として書き換え。`cmux backend を deprecated 表示` → `cmux backend 完全削除 (T016)` |
| `docs/seed.md` L121 | Phase 1 substrate adapter PoC | 歴史的記録としてそのまま。上部に「現在: c11 専用 (T016)」の注記追加 |
| `CLAUDE.md` | (grep で言及確認 — 現状 `ELEVENS_BACKEND` の直接言及無し) | 確認のみ |
| **`skills/c11/SKILL.md` L9** | YAML frontmatter `description:` の **invocation trigger 部** | **`ELEVENS_BACKEND=c11 (default since v0.9.0)` の文言を削除し、`elevens は c11 専用 (T016 以降)` 相当に書き換え**。description は skill 発動の trigger keyword になるため `ELEVENS_BACKEND` を残すと誤誘導を生む |
| **`skills/c11/SKILL.md` L17** | 本文冒頭 | **`v0.9.0 以降は env 未設定でも c11 が default。ELEVENS_BACKEND=cmux で legacy cmux に opt-in 可能（deprecated）` の一文を削除**。「elevens は c11 substrate を前提に動く（T016 以降、cmux backend サポート無し）」に置換 |
| `README.md` L77-98 `### Substrate backend (ELEVENS_BACKEND)` | c11 専用に書き換え（§3.7-5 の文面参照） | |
| `README.ja.md` L77-98 同節 | 日本語版書き換え（§3.7-6） | |
| `CHANGELOG.md` `[Unreleased]` | BREAKING change 節を追加（§3.7-7） | |
| `.team/artifacts/A028-A031` | 歴史的記録 | **触らない** |

---

## 7. リスク・注意点

### 7.1 誤削除リスク

- ❌ **やってはいけない**: `CMUX_*` env 名 (`CMUX_BUNDLE_ID` / `CMUX_BUNDLED_CLI_PATH` / `CMUX_SOCKET_PATH` / `CMUX_SURFACE` / `CMUX_NO_RENAME_TAB` / `CMUX_CLAUDE_HOOKS_DISABLED` 等) の削除・リネーム
- ❌ **やってはいけない**: `cmux.ts` ファイル名のリネーム / `skills/cmux-team/` ディレクトリ名の変更
- ❌ **やってはいけない**: `CMUX_BUNDLE_ID=com.manaflow.cmux` を観測する経路（refuse の reason に observed として含める）。これは「cmux substrate で起動された誤検出ケース」を診断するために必要

### 7.2 後方互換

- T016 は **BREAKING**。`ELEVENS_BACKEND=cmux` で運用していたユーザーは migration 必須
- 既存挙動: env が無効化されるだけなので、`unset ELEVENS_BACKEND` 相当の状態になる。c11 上で動かしていれば違いに気付かない可能性が高い（auto-detect が拾うため）
- README / CHANGELOG / journal に明示

### 7.3 検証手順

| 検証項目 | 確認方法 |
|---|---|
| c11 解決不能で exit 1 | 章 4 Step 8 の手動テスト |
| cmux リテラル実行ゼロ | `grep -n '"cmux"' skills/cmux-team/manager/*.ts \| grep -v "test\|com.manaflow.cmux"` がゼロ件 |
| `ELEVENS_BACKEND=cmux` で逃げられない | 章 4 Step 8 後半 |
| substrate 不通時 fail-fast | layout-restore のリトライ 3 回後 exit 1 を unit test で確認 |
| spawn-agent 失敗が daemon に観測される | `main.test.ts` の AGENT_SPAWN_FAILED テスト |
| `cmux.send` timeout | `cmux.test.ts` の send timeout テスト（fake cmux で sleep 60s） |
| 既存テスト pass | 章 5.3 の個別実行を順次回す |
| docs / コメント一掃 | `grep -rn "ELEVENS_BACKEND\|legacy cmux\|cmux backend\|DEPRECATION_NOTICE" --include="*.ts" --include="*.md"` を実行し残存ゼロ（A028-A031 等の歴史的 artifacts は除外） |
| `skills/c11/SKILL.md` の trigger / 本文に ELEVENS_BACKEND 残存ゼロ | 付録 A の grep 4b |

### 7.4 既知の落とし穴

- `cmdStart` で `detectBackendDecision` の戻り値処理を新シグネチャに合わせる際、`backendDecision.kind === "explicit"` を参照している箇所が他に無いか grep で確認（現時点では `main.ts` L801 のみ）
- `layout-restore.ts` の `liveSurfaces: Set<string> | null` 型 narrow に伴い、`planLayoutRestore` の caller (initializeLayout) もシグネチャ変更に追従する必要がある
- `runCmux` の opts に timeout が常に渡されるようになると、既存の no-timeout 前提（5s 以上かかる send を投げていた）箇所が無いか確認。実機の claude 起動コマンドは 30s 以内に PTY echo を返すので問題なし
- T015 のコミット (`15dcfc0 fix(backend): default SUBSTRATE_BINARY to c11 instead of cmux`) が main にマージ済みであることを確認 → `git log --oneline origin/main | grep T015` で確認

---

## 8. 完了条件（task.md 章「完了条件」と対応）

| 完了条件 | 対応 step / 検証 |
|---|---|
| c11 解決不能環境で `elevens start` が明示エラーで exit | Step 1, 4 / 章 7.3 検証 |
| cmux バイナリ実行経路が存在しない | Step 1 / `grep '"cmux"' ...` |
| `ELEVENS_BACKEND=cmux` で cmux に逃げられない | Step 1, 3 / 章 7.3 検証 |
| 操作レベル（B7-9）が substrate 不通時に握り潰さずエラー化 | Step 4 / `cmux.test.ts` 追加テスト |
| spawn-agent 失敗が daemon に観測される | Step 5 / `main.test.ts` 追加テスト |
| `cmux.send` に timeout | Step 5 / `cmux.test.ts` 追加テスト |
| 既存テスト pass（cmux 前提 test は c11 前提に修正） | Step 6 / 章 5.3 個別実行 |
| docs / コメントの cmux backend 記述を一掃 | Step 7 / 章 7.3 grep 検証 |

---

## 付録 A: 影響範囲一覧（最終確認用 grep スクリプト）

実装完了時に以下を実行し、想定外の残存がないことを確認:

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-016-1779306524

# 1. 削除対象シンボルがコードから完全に消えていること
grep -rn "IS_C11_BACKEND\|isC11Backend\|maybeLogDeprecationNotice\|__resetDeprecationNoticeForTest\|resolveSubstrateBinary\|ELEVENS_NO_DEPRECATION_WARN" --include="*.ts" skills/

# 2. ELEVENS_BACKEND がコード本体から消えていること (歴史的 docs の言及は許容)
grep -rn "ELEVENS_BACKEND" --include="*.ts" skills/

# 3. cmux リテラル実行経路がゼロ
grep -rn '"cmux"' --include="*.ts" skills/cmux-team/manager/ | grep -v test | grep -v "com.manaflow.cmux"

# 4. docs 残存記述
grep -rn "cmux backend\|legacy cmux\|DEPRECATION_NOTICE" docs/ README.md README.ja.md CLAUDE.md CHANGELOG.md 2>/dev/null

# 4b. skills/c11/SKILL.md に ELEVENS_BACKEND keyword が残っていないこと（M2）
grep -n "ELEVENS_BACKEND" skills/c11/SKILL.md

# 5. テスト構造の確認
grep -rn 'process.env.ELEVENS_BACKEND = "cmux"' --include="*.test.ts" skills/
```

ヒットが期待されるのは:

- (1) `SUBSTRATE_BINARY` のみ（残す）
- (2) 歴史的 docs (`docs/seed.md` の Phase 1 段落) と CHANGELOG の旧版記述のみ
- (3) ゼロ
- (4) 歴史的 changelog 行のみ
- (5) ゼロ

---

## 付録 B: コミットメッセージ叩き台

```
feat(backend)!: cmux backend を撤廃し c11 専用化 (T016)

elevens は c11 substrate を前提に動く。cmux backend へのフォールバックが
存在すること自体が誤り（実機障害 KDG-lab の根本原因）。前提が崩れたら
明示的にエラーで止める fail-fast 構造に切り替える。

BREAKING:
- ELEVENS_BACKEND env は読まれなくなった。c11 multiplexer 未検出なら
  elevens start は exit 1
- IS_C11_BACKEND / isC11Backend / maybeLogDeprecationNotice を削除
- newSurface() 失敗時の newSplit("right") フォールバックを撤去
- cmux.fetchLiveSurfaces / getPaneForSurface の tree 失敗握り潰しを廃止し
  caller に throw 伝播

実装:
- detectBackendDecision を { kind: "c11" | "refuse" } の 2 値判定に
- SUBSTRATE_BINARY は CMUX_BUNDLED_CLI_PATH 一次 / PATH 上 "c11"
  フォールバックで解決
- layout-restore の pid_only degrade を撤去（initializeLayout は 3 回リトライ
  後 exit 1）
- cmux.send / sendKey 系に 30s timeout を付与
- cmdSpawnAgent トップレベルで cmux 操作失敗を捕捉し AGENT_SPAWN_FAILED を
  daemon に通知 + manager.log に明示エラー記録 + exit 1

docs:
- README.md / README.ja.md の substrate backend 節を c11 専用に書き換え
- docs/seed.md Phase 3 を完了として記述
- CHANGELOG.md [Unreleased] に BREAKING を追加

Refs: T016
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

以上、T016 の plan.md。
