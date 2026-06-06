## Verdict: GO

## Summary

plan v2 の全サブタスク (S1〜S10 + S5.1) が実装され、Design Review N1 採用 A (main.ts cmdStart 内の signal bind 撤去 + fatal-handlers.ts への完全集約) も構造的に反映されている。bun test 675 pass / 0 fail、tsc 16 件 = baseline 維持 (新規 0 件)。Critical 0 件 / Major 0 件で GO 判定。

## Findings

### 1. 計画充足（OK — 観点 1）

- **touched files (14 個) は plan §3.1 / §3.2 と一致**:
  - 新規: `fatal-handlers.ts` / `heartbeat.ts` / `self-telemetry.ts` / `post-mortem-redirect.ts` + 各 `.test.ts` (4 ファイル × 2) / `docs/spec/15-post-mortem-evidence.md` / `scripts/test-crash-evidence.sh`
  - 変更: `logger.ts` / `pidfile.ts` / `reload.ts` / `daemon.ts` 相当 (shutdown は main.ts 内に移動済み — main.ts に統合 — daemon.ts 自体は touched に出てこないが impl-report どおり機能が main.ts 側に集約) / `main.ts` / `config.ts` + 各 `.test.ts` / `CLAUDE.md` / `docs/spec/00-project-overview.md` / `docs/spec/05-install-and-infrastructure.md` / `docs/spec/glossary.md`
  - daemon.ts は変更対象になっていない: plan §3.2 で「`daemon.ts` の `shutdown` を `async shutdown(signal?: string)` 化」と書かれていたが、impl では `shutdown` が `main.ts` 内 (line 1267) の local closure として実装されており、daemon.ts へのこの種の手入れは不要だった (元々 shutdown は main.ts 側に存在)。**Acceptance Criteria・design intent は満たされている** ので OK
- **Acceptance Criteria 8 項目**: stderr.log / heartbeat / fatal trace / signal handler (SIGTERM/SIGHUP) / telemetry.jsonl / docs / spec / 既存 test pass のすべてが実装で達成 (それぞれ後述の観点で個別検証)
- **Design Review N1 採用 A の反映**:
  - `grep 'process\.on\("SIG(INT|TERM|HUP)"' main.ts` で 6 件ヒットしたが、**いずれも cmdEvents / cmdMetrics / runWithAbort 内の subcommand-local abort 用** (main.ts:5904-5905 / 5980-5981 / 6005-6006) であり、daemon の **cmdStart 経路には 0 件**。N1 採用 A (cmdStart 内 signal bind 撤去) は構造的に反映されている。cmdStart 内のコメント (main.ts:1260-1263) でも「fatal-handlers.ts 経由で bind 済み、main.ts 側の直接 bind は二重 listener になるため撤去」と明記
  - `grep installFatalHandlers main.ts` → main.ts:826 で `installFatalHandlers({ onShutdown: ... })` を 1 件呼んでいる (cmdStart 内、installCrashHandler 直後)

### 2. Dead/Zombie Code（OK — 観点 2）

- `grep 'uncaughtException|unhandledRejection' pidfile.ts` → 該当 listener 行は 0 件。`'exit'` listener のみ残置 (R1 反映)。残るのはコメント (pidfile.ts:206 で「旧実装にあった listener は撤去」と明記) のみで物理コードは撤去済み
- pidfile.ts の `installCrashHandler` は `exitImpl` option を legacy 互換のため残置 — これは impl-report で明記済みの保守判断であり dead code ではない (テストからの DI 入口として有効)
- main.ts の旧 signal bind は撤去済み (上記 N1 採用 A 反映の通り)

### 3. テスト（OK — 観点 3）

- `bun test --timeout 30000` 対象 10 ファイル (logger / heartbeat / self-telemetry / fatal-handlers / post-mortem-redirect / main / daemon / reload / config / pidfile):
  - **675 pass / 2 skip / 0 fail / 1901 expect() calls / 32.99s**
  - impl-report 記載の「675 pass / 2 skip / 0 fail」と完全一致 ✅
- 既存 test (daemon.test.ts / main.test.ts / reload.test.ts / pidfile.test.ts) も green
- 新規 test (fatal-handlers / heartbeat / self-telemetry / post-mortem-redirect の各 .test.ts) も pass
- 出力中の `[cmux-team] post-mortem stderr redirect spawn failed: child.pid undefined` は post-mortem-redirect.test.ts が spawn 失敗 case を意図的に検証している stderr (test 内 mock 経路) であり assertion 上は正常な発火 (pass に含まれる)

### 4. 設計原則（OK — 観点 4）

- **fatal-handlers.ts は sync I/O のみ**: `grep 'await|appendFile\('` で 2 件ヒットしたが、**いずれもコメント** (`fatal-handlers.ts:7` の signal 経路説明、`fatal-handlers.ts:88` の fire-and-forget 設計理由) であり、**実コード上は await 0 件 / appendFile (async) 0 件**。signal handler 内では `Promise.resolve(onShutdown(signal)).catch(...)` で fire-and-forget しており、handler が同期的に return する設計が守られている (fatal-handlers.ts:90-92)
- 責務分担:
  - heartbeat = `.team/daemon.heartbeat` への 10s sync write + clean exit unlink
  - telemetry = `.team/logs/manager.telemetry.jsonl` への 30s async append + size base rotation
  - stderr.log = OS fd 2 redirect (Bun runtime panic も拾える)
  - fatal trace = `logSync` 経由で manager.log に sync 書き込み
  - 4 軸が file 別 / writer 別 / interval 別 に分離されていて明確 (`docs/spec/15-post-mortem-evidence.md` §2 とも整合)
- SSOT: signal bind は fatal-handlers.ts 1 箇所に集約 (N1 採用 A)。pidfile cleanup は pidfile.ts の `'exit'` listener 1 箇所に集約

### 5. 統合（OK — 観点 5）

cmdStart 内の install 順序 (main.ts):

| 位置 | 行 | 内容 |
|---|---|---|
| 冒頭・副作用前 | 775 | `await maybeRespawnWithStderrRedirect({ projectRoot: PROJECT_ROOT, args })` ✅ |
| pidfile 取得直後 | 820 | `installCrashHandler(pidFilePath)` ✅ |
| その直後 | 826 | `installFatalHandlers({ onShutdown: closure })` ✅ |
| state.startedAt 設定後 | 1004 | `startHeartbeat({ path: ..., intervalMs: postMortemConfig.heartbeatIntervalMs, getState })` ✅ |
| startDashboard 後 | 1415 | `startSelfTelemetry({ path: ..., intervalMs: ..., maxBytes: ..., getState })` ✅ |
| shutdown 内 | 1296 / 1303 | `stopSelfTelemetry(...)` / `stopHeartbeat(..., { cleanExit: true, reason: signal ?? "shutdown" })` ✅ |
| onFullQuit 内 | 1392 / 1398 | shutdown を通らない経路でも heartbeat/telemetry を清掃 ✅ |
| shutdown signature | 1267 | `const shutdown = async (signal?: string): Promise<void> => { ... }` ✅ |
| signal_received sync log | 1270 | shutdown 冒頭で `logSync("signal_received", \`signal=${signal ?? "none"}\`)` ✅ |
| onQuit reason 渡し | 1348 | `onQuit: () => { shutdown("dashboard_quit"); }` ✅ |

reload 経路:
- reload.ts:25 で `POST_MORTEM_REDIRECTED_FLAG` を import、reload.ts:62 で spawn args (`["run", absoluteMainTs, "start", POST_MORTEM_REDIRECTED_FLAG]`) に常時付与 → 2 段重ね防止 (S5.1 / R2 反映) ✅

config 経路:
- config.ts:104-111 で `postMortem` 型を schema に追加 (全フィールド optional)、575-594 で `resolvePostMortemConfig` を export ✅
- main.ts:91 で `resolvePostMortemConfig` を import、main.ts:1001 で `postMortemConfig = resolvePostMortemConfig(startConfig)` を解決、heartbeat / telemetry の interval / maxBytes に流し込み (main.ts:1006 / 1417 / 1418) ✅

docs:
- CLAUDE.md:164 で `.team/` 構造に heartbeat 行追加、CLAUDE.md:316 に新規 `## Post-mortem evidence (T010)` 節 + `docs/spec/15-post-mortem-evidence.md` リンク ✅
- glossary.md:22 / 201-207 で §12「Post-mortem evidence」5 用語追加 + 関連 spec リンク ✅
- 00-project-overview.md:70 で観察可能性二層に「post-mortem 観察」列追加、161 で doc index §15 追加 ✅
- 05-install-and-infrastructure.md:461-467 で `.team/` ファイル一覧に heartbeat / stderr.log / telemetry.jsonl + rotation policy 追加 ✅

### 6. 型エラーゼロ化 — touched files（OK — 観点 6）

worktree 側 tsc 結果 (16 件、`bunx tsc --noEmit`):

| ファイル | 件数 | touched か | 扱い |
|---|---|---|---|
| c11-features.test.ts | 2 (TS2722, TS2322) | × | baseline |
| c11-features.ts | 2 (TS2345, TS2322) | × | baseline |
| mailbox-cli.ts | 3 (TS18048×2, TS2345) | × | baseline |
| main.ts:1038 | 1 (TS2322: string→boolean) | ○ (touched) | **baseline 確認済み** |

main.ts:1038 が touched files に該当するが、main ブランチでも tsc を実行した結果、`main.ts:977 TS2322: Type 'string' is not assignable to type 'boolean'` と完全一致のエラーが報告されており、**本タスクで追加した行による型エラーではなく、本タスクの diff による行 shift (977 → 1038) で報告位置が動いただけの baseline**。1038 行は `sleepPrevention,` (object literal property shorthand) で、`git diff main -- main.ts | grep sleepPrevention` でも変更なし。

impl-report の「baseline 16 件は本タスク変更前から存在し、本タスクで増加させていない (新規 0)」は事実確認済み。**新規 cleanup タスク起票は不要** (plan §6 でも「別タスクで対応」と明記され、本タスクの責務外)。

## 検査実行ログ

### bun test 最終行

```
675 pass
2 skip
0 fail
1901 expect() calls
Ran 677 tests across 10 files. [32.99s]
```

### tsc 件数比較

| 場所 | 件数 | 該当 main.ts エラー位置 |
|---|---|---|
| main branch (`/Users/yamamoto/git/elevens`) | 16 | main.ts:977 TS2322 |
| worktree (`.worktrees/task-010-1779006692`) | 16 | main.ts:1038 TS2322 |

→ 完全一致 (行 shift のみ)。新規型エラー 0 件。

### grep 結果サマリ

| 検査 | 結果 | 判定 |
|---|---|---|
| `process\.on\("SIG(INT\|TERM\|HUP)"` in main.ts | 6 件 (cmdEvents / cmdMetrics / runWithAbort、いずれも cmdStart 外) | cmdStart 内 0 件 → N1 採用 A 反映 ✅ |
| `installFatalHandlers` in main.ts | 1 件 (cmdStart 内 installCrashHandler 直後) | ✅ |
| `uncaughtException\|unhandledRejection` in pidfile.ts | 0 件 (コメント 1 件のみ) | listener 物理撤去 ✅ |
| `await\|appendFile\(` in fatal-handlers.ts | 2 件 (両方コメント) | 実コード sync only ✅ |
| `maybeRespawnWithStderrRedirect` in main.ts | 1 件 (line 775、cmdStart 冒頭) | ✅ |
| `startHeartbeat` / `startSelfTelemetry` in main.ts | 1 件 / 1 件 | ✅ |
| `stopHeartbeat` / `stopSelfTelemetry` in main.ts | 2 件 / 2 件 (shutdown + onFullQuit) | ✅ |
| `POST_MORTEM_REDIRECTED_FLAG` in reload.ts | 2 件 (import + spawn args) | ✅ |
| `resolvePostMortemConfig` in config.ts / main.ts | 1 / 1 (定義 + 参照) | ✅ |
| `Post-mortem` in CLAUDE.md | 2 件 (`.team/` 表行 + 専用 section) | ✅ |
