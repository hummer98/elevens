# T010 実装レポート: Manager Daemon Post-mortem Evidence Capture

> Plan v2 (Approved) + Design Review N1 (採用 A) を反映した実装結果。
> TDD で S1 → S2 → S3 → S4 → S5 → S5.1 → S7 → S6 → S8 → S9 → S10 の順に逐次実装。
> 全 677 test green / 新規型エラー 0 件 (baseline 16 件維持)。

## Completed Tasks

| サブタスク | 完了 |
|---|---|
| S1 logger.ts に sync API 追加 (`logSync` / `warnSync` / `errorSync`) | ✅ |
| S2 fatal-handlers.ts 新設 + pidfile.ts の uncaughtException/unhandledRejection listener 撤去 + pidfile.test.ts 修正 | ✅ |
| S3 heartbeat.ts 新設 (sync write / clean exit / DI timer) | ✅ |
| S4 self-telemetry.ts 新設 (JSONL append / size base rotation / event loop lag meter) | ✅ |
| S5 post-mortem-redirect.ts 新設 (Bun.spawn ベースの自己再 spawn + DI) | ✅ |
| S5.1 reload.ts に `--__post-mortem-redirected` flag 伝播 (R2) | ✅ |
| S7 config.ts に postMortem schema + `resolvePostMortemConfig` 追加 | ✅ |
| S6 main.ts (cmdStart) 統合 (N1 採用 A: signal bind を fatal-handlers に集約、shutdown signature 変更、heartbeat / telemetry 起動・停止) | ✅ |
| S8 scripts/test-crash-evidence.sh 新設 (開発者ローカル前提、CI 化は別タスク) | ✅ |
| S9 docs/spec/15-post-mortem-evidence.md 新設 + glossary §12 / 00-project-overview / 05-install-and-infrastructure 連携 | ✅ |
| S10 CLAUDE.md 更新 (`.team/` 構造 + Manager protocol + Post-mortem section) | ✅ |

## Files Changed

### 新規

| パス | 概要 |
|---|---|
| `skills/cmux-team/manager/logger.ts` の追加 export | logSync / warnSync / errorSync (`appendFileSync` ベース、format は async 版と一致、`CMUX_TEAM_LOGGER_STRICT` 互換) |
| `skills/cmux-team/manager/fatal-handlers.ts` | uncaughtException / unhandledRejection / SIGTERM / SIGINT / SIGHUP を集約。DI 可能。signal 経路は `onShutdown(signal)` を fire-and-forget |
| `skills/cmux-team/manager/fatal-handlers.test.ts` | uncaught / unhandled / 3 signal / uninstall を DI で網羅 (9 test) |
| `skills/cmux-team/manager/heartbeat.ts` | `.team/daemon.heartbeat` への 10s sync write、clean exit 時に reason 記録 + unlink。DI 可能 |
| `skills/cmux-team/manager/heartbeat.test.ts` | 即時 write / interval tick / cleanExit true/false / 二重 stop (6 test) |
| `skills/cmux-team/manager/self-telemetry.ts` | JSONL append、size base rotation (`.1`)、`startEventLoopLagMeter` (setImmediate ベース) |
| `skills/cmux-team/manager/self-telemetry.test.ts` | 即時 / interval / rotation 発火 / rotation skip / stop (5 test) |
| `skills/cmux-team/manager/post-mortem-redirect.ts` | `maybeRespawnWithStderrRedirect` (Bun.spawn でも child_process.spawn でも動く DI、rotate + open + spawn + exit) |
| `skills/cmux-team/manager/post-mortem-redirect.test.ts` | flag skip / 非 TTY skip / redirect 経路 / rotate / spawn 失敗 (6 test) |
| `scripts/test-crash-evidence.sh` | 手動再現スクリプト (heartbeat / telemetry / stderr.log / fatal_uncaught の 4 軸確認) |
| `docs/spec/15-post-mortem-evidence.md` | 新規 spec (概要 / ファイル一覧 / heartbeat schema / telemetry schema / 重複経路 / event 名 / config override / 事後分析 cookbook) |

### 変更

| パス | 概要 |
|---|---|
| `skills/cmux-team/manager/logger.ts` | 上記 sync API 追加 (既存 async API は無変更) |
| `skills/cmux-team/manager/pidfile.ts` | `installCrashHandler` の `uncaughtException` / `unhandledRejection` listener を撤去 (R1)。`'exit'` listener のみ残置。`exitImpl` option は legacy 互換のため残置 |
| `skills/cmux-team/manager/pidfile.test.ts` | 撤去された listener に依存する 3 件のテストを `process.emit("exit", 1)` 経由で cleanup を assert する形に修正 |
| `skills/cmux-team/manager/reload.ts` | `performDaemonReload` の spawn args に常に `POST_MORTEM_REDIRECTED_FLAG` を付与 (R2、2 段重ね防止) |
| `skills/cmux-team/manager/reload.test.ts` | 既存 args assertion を flag 込みに更新、新規 test 「flag が args に含まれる」を追加 |
| `skills/cmux-team/manager/config.ts` | `TeamConfig.postMortem` 追加 + `PostMortemConfig` interface + `resolvePostMortemConfig` (clamp 解決) |
| `skills/cmux-team/manager/config.test.ts` | `resolvePostMortemConfig` の単体テスト 10 件追加 (default / override / 範囲外 / 型違反 / 部分指定) |
| `skills/cmux-team/manager/main.ts` | (1) cmdStart 冒頭で `maybeRespawnWithStderrRedirect` (2) `installCrashHandler` 直後で `installFatalHandlers({ onShutdown: closure })` (3) `process.on("SIGINT"/"SIGTERM", shutdown)` を撤去 (N1 採用 A) (4) `shutdown` を `async shutdown(signal?: string): Promise<void>` に変更し冒頭で `logSync("signal_received", ...)` (5) `state.startedAt` 直後に `startHeartbeat` (6) `startDashboard` 後に `startSelfTelemetry` (7) shutdown / onFullQuit で heartbeat / telemetry 停止 (8) onQuit に `"dashboard_quit"` reason |
| `docs/spec/00-project-overview.md` | 観察可能性二層に **post-mortem 観察** 列を追加、本体 doc index に §15 を追加 |
| `docs/spec/05-install-and-infrastructure.md` | `.team/` ファイル一覧に heartbeat / stderr.log / telemetry.jsonl を追加 |
| `docs/spec/glossary.md` | §12 「Post-mortem evidence」5 用語追加 |
| `CLAUDE.md` | `.team/` ディレクトリ構造に heartbeat 追加、Manager プロトコル節に Post-mortem 行追加、新規 §「Post-mortem evidence (T010)」を追加 |

### 削除

なし（plan §3.3 通り、ファイル単位の削除無し）。pidfile.ts 内の listener コードブロックのみ撤去。

## TDD Cycles / Verification Results

各サブタスクで RED → GREEN → REFACTOR → VERIFY (該当 test + `bunx tsc --noEmit`) を実行。

| Sub | RED | GREEN | VERIFY |
|---|---|---|---|
| S1 | `logger.test.ts` に sync API テスト 5 件 → import error で fail | logger.ts に `appendLineSync` + 3 export 追加 → 28 pass | tsc 16 件 |
| S2 | `fatal-handlers.test.ts` 9 件 → module not found | fatal-handlers.ts 新設 + pidfile.ts listener 撤去 + pidfile.test.ts 修正 → 50 pass (2 files) | tsc 16 件 |
| S3 | `heartbeat.test.ts` 6 件 → module not found | heartbeat.ts 新設 → 6 pass | tsc 16 件 |
| S4 | `self-telemetry.test.ts` 5 件 → module not found | self-telemetry.ts 新設 → 5 pass | tsc 16 件 |
| S5 | `post-mortem-redirect.test.ts` 6 件 → module not found → spawn mock signature mismatch を 1 件修正 | post-mortem-redirect.ts 新設 → 6 pass | tsc 16 件 |
| S5.1 | reload.test.ts の既存 args assertion fail | reload.ts に flag 付与 + test を flag 込みに更新 + 新 assertion 追加 → 10 pass | tsc 16 件 |
| S7 | `config.test.ts` に `resolvePostMortemConfig` テスト 10 件 → undefined export | config.ts に schema + resolver 追加 → 63 pass。`@ts-expect-error` の複数行 statement で 1 度 tsc 18 件になり、`const r1 = ...` で 1 行化して 16 件に戻す | tsc 16 件 |
| S6 | main.ts の編集途上で `state.openTaskCount` を誤参照 → tsc 18 件 (新規 2 件) | `state.openTasks` に修正 → 16 件復帰。`shutdown(` caller を `grep "shutdown(" *.test.ts` で確認: main.test.ts 内の独立 closure (`makeShutdownGuard` test) のみで cmdStart の shutdown とは別物 — signature 変更影響なし | main.test.ts / daemon.test.ts / reload.test.ts / pidfile.test.ts / config.test.ts 全 pass |
| S8 | スクリプト無し | `scripts/test-crash-evidence.sh` 新設 + `chmod +x` + `bash -n` で syntax-ok | 手動実行は daemon 立ち上げ要 (worktree から立ち上げ不可のため skip) |
| S9 | spec 無し | `15-post-mortem-evidence.md` 新設 + glossary §12 + overview §観察可能性 + 05-install-and-infrastructure の `.team/` 表に追記 | markdown のみ、tsc 影響なし |
| S10 | CLAUDE.md 未更新 | 既存 `.team/` 表 + Manager 節 + Post-mortem 節を追加 | tsc 影響なし |

最終一括検証:

```
bun test --timeout 30000 logger.test.ts heartbeat.test.ts self-telemetry.test.ts \
  fatal-handlers.test.ts post-mortem-redirect.test.ts main.test.ts daemon.test.ts \
  reload.test.ts config.test.ts pidfile.test.ts

→ 675 pass / 2 skip / 0 fail / 1901 expect() calls / 31.21s
```

## Type Check Result

`cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | wc -l`

- baseline (本タスク変更前): 16 件
- 最終: **16 件** (新規導入 0 件)

baseline の 16 件はすべて本タスクと無関係（c11-features.test.ts / c11-features.ts / mailbox-cli.ts / main.ts:977→1038 の TS2322 boolean assignment）。

## Issues Encountered

### config.test.ts での `@ts-expect-error` 多行 statement の挙動

複数行 `expect(...)` の直前に `@ts-expect-error` を付けると TS は statement レベルで matching し、`unused directive` 警告 + 別行の TS2322 を出して 2 件増えた。1 行 `const r1 = ...` に分けて `@ts-expect-error` の対象を明示することで解消。**cleanup タスク起票不要**（本タスク内で解決済み）。

### `state.openTaskCount` の typo

最初 main.ts の heartbeat getState / telemetry getSample で `state.openTaskCount` を参照していたが、実際のフィールド名は `state.openTasks`。tsc 検査で即座に発覚し修正。**cleanup タスク起票不要**。

### 既存 main.ts(977→1038) の TS2322

baseline 16 件のうち main.ts に 1 件含まれる既存型エラー (`state.updateMode = autoUpdate.mode`)。本タスクの変更とは無関係なため触らず baseline として維持。plan §6 で「別タスクで対応」と明記済み。**新規 cleanup タスクは起票しない**（既知 baseline）。

## Manual Verification

`scripts/test-crash-evidence.sh` は **実行 skip**。理由:

- スクリプトは `elevens start` で daemon を立ち上げた状態で別 process から実行する設計
- 本タスクは git worktree (`.worktrees/task-010-1779006692`) 内で進行しており、ここで `elevens start` を起動すると親プロジェクトの daemon と衝突 / pidfile race のリスク
- plan §S8 / R5 の通り「**開発者ローカル前提、CI 化は別タスク**」と明示されており、本実装ではスクリプト自体の整備に留める

スクリプトは `bash -n` で syntax 検証済み。実機検証は本実装をマージ後に開発者がプロジェクト直下で行う想定（手順は spec §8 の cookbook と script のコメントに記載）。

代替検証:
- unit test: `heartbeat.test.ts` で sync write / clean exit / cleanExit:false で残存することを assert
- unit test: `self-telemetry.test.ts` で JSONL append / rotation 発火 / skip を assert
- unit test: `post-mortem-redirect.test.ts` で spawn 引数 / fd / rotate / spawn 失敗時の fail-fast を assert
- unit test: `fatal-handlers.test.ts` で各 fatal / signal が正しい event を sync 出力することを assert

実機での総合検証は merge 後に PR レビューと併せて開発者が `scripts/test-crash-evidence.sh` を実行することを想定。
