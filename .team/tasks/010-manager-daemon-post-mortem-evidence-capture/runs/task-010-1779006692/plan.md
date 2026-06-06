# T010 実装計画書: Manager Daemon Post-mortem Evidence Capture (改訂版 v2)

> 2026-05-17 の Brainship/prototype インシデント（Manager daemon が無言で死亡し、29 分のギャップで原因究明不能）への構造的対策。
> 次回同種クラッシュ時に **WHEN / WHAT / WHY** の 3 軸で原因究明できる evidence を残す機構を Manager daemon に組み込む。
>
> **v2 改訂要点**: Design Review (Changes Requested) の F1〜F7 を全反映。中核改訂は
> - **R1**: `installCrashHandler` の `uncaughtException` / `unhandledRejection` listener を撤去し、`'exit'` listener のみに縮退。fatal-handlers.ts に完全集約することで「最初の listener が `exit(1)` を呼んだ瞬間に後続 listener が走らない」問題を構造的に解消。
> - **R2**: reload 経路への `--__post-mortem-redirected` flag 伝播を独立サブタスク S5.1 として追加。

---

## 1. 課題分析

### 1.1 現状の問題点（observability の欠落）

| 観測軸 | 現状 | インシデント時の影響 |
|---|---|---|
| **WHEN**（死亡時刻 ±10s） | `manager.log` の最終 append のみ。append が async (`fs/promises.appendFile`) なので daemon 死亡時の最終ログ行が flush されない可能性 | 15:58:09 (最終 log) と 16:27:23 (runningboardd 検知) の 29 分ギャップ |
| **WHAT**（直前内部状態） | TUI 上にしか出ない（RSS / 稼働 Conductor 数）。永続化なし | 死亡時のメモリ・event loop 状態が再現不能 |
| **WHAT**（system context） | 取得手段なし | memory pressure event 2 (16:48-50) が原因か無関係か判断不能 |
| **WHY**（JS 例外） | `installCrashHandler` (pidfile.ts:228) が `console.error(err) + exit(1)`。**stderr が file に向いていない**ので消失 | uncaughtException / unhandledRejection が起きていても痕跡なし |
| **WHY**（Bun runtime panic / Rust backtrace） | Bun runtime の Zig レイヤ panic は JS の `process.stderr.write` を経由せず直接 stderr に書く → JS hook で捕捉不可 | c11 pane に流れた stderr は c11 freeze で回収不能 |
| **WHY**（外部 signal） | `shutdown` (daemon.ts:1199) が SIGINT / SIGTERM のみ捕捉。**SIGHUP 未捕捉**、signal 種別の log 出力なし | 外部 kill signal の有無を事後判定不能 |
| **logger sync 性** | `appendFile` (async) のみ。critical path 用 sync API 無し | 死亡直前の最終 1〜2 行が file に出る前にプロセス消滅 |

### 1.2 根本原因

1. **stderr が pane に閉じている**: `bin/elevens` が `exec bun run main.ts "$@"` で起動するため、stderr は cmux pane に流れる。Bun runtime panic / unhandled console.error は pane 上にのみ残り、pane が freeze すると回収不能。
2. **heartbeat 機構が無い**: daemon プロセスが「いつ最後に動いていたか」を外部に持続的に通知する仕組みが無い。
3. **self-telemetry が無い**: RSS / heap / event loop lag / 稼働 Conductor 数の time-series が永続化されない。
4. **handler が分散 + `process.exit` 同期 terminate の制約**: SIGINT/SIGTERM は `shutdown`、uncaughtException/unhandledRejection は `installCrashHandler`、SIGHUP は誰も捕捉しないという責務分散。さらに `process.exit()` は同期 terminate のため、複数 listener を順次走らせて全部に副作用を持たせる設計は構造的に不可能。fatal 経路で sync logging が無い。

### 1.3 影響範囲

- 本タスクスコープ: Manager daemon (`skills/cmux-team/manager/`) のクラッシュ事後再現性
- 関連影響: Manager 配下の Master / Conductor / Agent への影響は無い（Manager だけが直接的に observe する対象）
- 既存挙動への影響: stderr redirect により `start` サブコマンドの stderr 出力先が pane → file に変わる（dashboard TUI は stdout / stdin のみ使用のため互換）

---

## 2. 技術アプローチ

### 2.1 全体方針

「**daemon 内部から外部に対し、死亡前・死亡時・死亡後で読み取れる永続的痕跡を残す**」を中核に据え、4 軸の evidence を file 出力で機械可読に残す:

| evidence | 媒体 | writer | reader |
|---|---|---|---|
| stderr 全部 | `.team/logs/manager.stderr.log` (+ `.1` rotate) | OS fd 2 を file へ redirect | 人間 / `tail` / 事後 grep |
| heartbeat（死亡時刻） | `.team/daemon.heartbeat` | 10s 間隔の sync write、shutdown 時 unlink | mtime + 内容を見るだけで OK |
| self-telemetry（直前内部状態） | `.team/logs/manager.telemetry.jsonl` (+ `.1` rotate) | 30s 間隔の async append | JSONL を時系列で再生 |
| fatal trace（最終ログ行） | `.team/logs/manager.log` への **sync** append | fatal-handlers.ts に集約された uncaughtException / unhandledRejection / signal handler 内で `logSync()` | 既存の manager.log 解析と同じ |

「decision は AI、機構は決定論的コードで」原則どおり、observe する側（人間／事後 grep）は file を読むだけで状況を再構成できる。

### 2.2 既存実装との統合方針（R1 反映: 単一責務化）

| 既存 | 統合方針 |
|---|---|
| `installCrashHandler` (pidfile.ts:228) — uncaughtException / unhandledRejection / exit を捕捉して pidfile cleanup + console.error + exit | **責務を `'exit'` listener のみに縮退**（R1 採用案 (a)）。uncaughtException / unhandledRejection の listener (`pidfile.ts:271-272` 相当) を**撤去**し、fatal trace の責務は fatal-handlers.ts に完全集約する。`'exit'` listener が `process.exit(1)` 経由で必ず発火する Node/Bun の仕様を利用し、pidfile cleanup は `'exit'` listener 内で実行する。これにより「最初の listener が exit(1) を呼んだ瞬間に後続 listener が走らない」順序問題を構造的に解消し、handler の単一責務化と test の単純化を達成する。 |
| `shutdown` (daemon.ts:1199) — SIGINT/SIGTERM → stopDaemon → pidfile release → exit(0) | **保持 + SIGHUP 追加 + signal 文字列引数化**。`shutdown` は graceful（clean exit）経路として残し、SIGHUP も同 handler に紐づける。シグネチャを `(signal?: string) => Promise<void>` に変更し、bind 側で `() => shutdown("SIGTERM")` のように呼ぶ（Node listener は signal 名を渡さないため、bind 時に明示）。signal 名を sync write で manager.log に記録してから既存処理に入る。 |
| `logger.ts` (async `appendFile`) | **保持 + sync API 追加**。`logSync()` / `warnSync()` / `errorSync()` を新規追加。format は async 版と一致させ、`appendFileSync` で出力。critical path（fatal handler / signal handler / heartbeat clean exit）からのみ呼ぶ。 |
| `installDashboardConsoleRedirect` (dashboard-console-redirect.ts) | **保持**。TUI 描画中の console.warn/error 漏出防止が本来の責務であり、stderr redirect とは目的が異なる。本タスクで `installCrashHandler` 内の `console.error(err)` 経路が撤去されるため、fatal 時の manager.log 重複は `[error]` 経由 (もし呼ばれていれば) と `fatal_uncaught` event の 2 経路に簡素化される。 |
| `cmdStart` の起動経路（自プロセスが daemon 化） | **wrapper 方式（D1 採用）で再 spawn**。詳細は §2.3。 |
| `performDaemonReload` (reload.ts) — `Bun.spawn("bun", ["run", absoluteMainTs, "start"], ...)` で reload 時に新 daemon 起動 | **`--__post-mortem-redirected` flag を常時付与**。親（旧 daemon）は既に redirect 済みなので、reload した子も「redirect 済み」として継承する。これがないと reload で `maybeRespawnWithStderrRedirect` が再度子を spawn して 2 段重ねになり、rotate も毎 reload で 1 世代消える副作用が出る。詳細は §S5.1。 |

### 2.3 stderr redirect 実装方式（D1）

**選択: (b) wrapper subcommand（cmdStart 冒頭で自己再 spawn）**

3 案を実機検証した結果:

| 案 | 検証結果 | 採否 |
|---|---|---|
| (a) 自プロセス内で `fs.openSync` + dup2-like | Bun には `process.dup2` 相当の公式 API が無い。`process.stderr` を tty.WriteStream として持っているが、内部 `_handle` を差し替えても **Bun runtime の Zig レイヤから直接 stderr に書く panic は捕捉できない**（fd 2 自体を OS レイヤで差し替える必要がある）。✗ | 不採用 |
| (b) `cmdStart` 冒頭で自己再 spawn（`Bun.spawn(self, [...args, "--__post-mortem-redirected"], { stdio: ["inherit", "inherit", fd], detached: true })`） | 実機検証で `Bun.spawn` が `stderr: fd` を受け付け、子プロセスの `throw` による Bun runtime backtrace（"Bun v1.3.13 (macOS arm64)" を含む）まで file に書かれることを確認。reload.ts と同じ pattern なので新規依存無し | **採用** |
| (c) `process.stderr.write` を hook | (a) と同じ理由で Bun runtime panic は捕捉不可。既存 `installDashboardConsoleRedirect` が console.* レベルでこれを部分的に行っており、stderr 全部の捕捉には不十分 | 不採用 |

**根拠**: Bun の stderr に書ける subject は (1) JS `console.error` / `process.stderr.write`、(2) Bun runtime の uncaught exception printer (Zig)、(3) Rust 依存 crate の panic、(4) libc abort/assert。これらすべてを残すには **OS レイヤで fd 2 を file に向ける**しかない。子 spawn 方式はこれを満たす唯一の現実解。

**実装フロー**:

```
cmdStart() {
  if (args.includes("--__post-mortem-redirected")) {
    // 子（redirect 済み）: 普通の init を続行
    proceedWithNormalInit()
    return
  }

  // 親: TTY なら子に redirect して exit、非 TTY ならそのまま inline
  if (!process.stderr.isTTY) {
    proceedWithNormalInit()  // test / pipe 経路（CI、proxy 起動など）
    return
  }

  const stderrLogPath = join(PROJECT_ROOT, ".team/logs/manager.stderr.log")
  await mkdirpSync(dirname(stderrLogPath))
  await rotateStderrLog(stderrLogPath)  // exists → .1 にリネーム
  const fd = openSync(stderrLogPath, "a")
  const child = Bun.spawn(
    [process.execPath, process.argv[1], ...args, "--__post-mortem-redirected"],
    { stdio: ["inherit", "inherit", fd], detached: true, env: process.env, cwd: process.cwd() }
  )
  child.unref()
  closeSync(fd)  // 親側 fd を閉じる（子は dup 済み）
  process.exit(0)
}
```

**注意点**:
- 親はまだ pidfile を取得していない（取得は子側で）。reload と同じ「親は spawn だけして exit」モデル。
- `process.argv[1]` は `main.ts` の絶対パス。reload.ts の resolve() パターンに合わせる。
- `stdio: ["inherit", "inherit", fd]` で stdin/stdout は親 TTY を継承（Ink TUI が動く）、stderr のみ file。
- preflight / pidfile / direnv check は子側で実行される → 失敗時の stderr 出力も stderr.log に残る（証拠として有用）。これらが exit(1) すると stdout への console.error は親 TTY からは見えないため、**preflight 失敗時のメッセージは stdout にも echo する**実装ガード（既に preflight は stdout 経路）を維持する。

### 2.4 代替案と却下理由

| 代替案 | 却下理由 |
|---|---|
| `bin/elevens` (bash) を改修して `start` のとき `2>>file` で redirect | bash で PROJECT_ROOT 解決（cwd up-walk）を再実装する必要があり責務分散。さらに rotate を bash で書くと脆弱。npm publish タイミングのみに修正が依存し、開発時の `bun run main.ts` 直接起動経路では効かない |
| OS launchd plist で daemon 化 + stderr redirect | ユーザー体験を大幅に変更（cmux pane 上で `elevens start` する現行モデルが壊れる）。本タスク範囲外 |
| Bun の `--smol` モード / `DO_NOT_TRACK` 環境変数で crash report を bun.sh サーバーへ自動アップロード | (1) サーバーアップロードは privacy 配慮で off にすべき (2) ユーザー手元の `.team/` に残らない (3) 公式 API として local file dump 経路が無い（Context7 確認結果） |

### 2.5 構造的解決

- **state を外部化**: heartbeat / telemetry はすべて file。daemon が in-memory に持つのは「次回 polling までの timer ハンドル」のみ
- **silent state mutation を作らない**: `logSync()` 経由 / `appendFileSync` 経由のみ。fatal handler 内の直接 `writeFileSync` は logger を再利用
- **observer が pull で観測できる**: heartbeat の存在 + mtime / telemetry の最終行 / stderr.log の `.1` rotate 有無 を **外部から file アクセスのみで判定可能**
- **handler の単一責務化**: uncaughtException / unhandledRejection / signal は fatal-handlers.ts に集約、pidfile cleanup は `'exit'` listener に集約。`process.exit` の同期 terminate 制約に依存しない設計

---

## 3. 変更対象

### 3.1 新規ファイル

| パス | 用途 |
|---|---|
| `skills/cmux-team/manager/post-mortem-redirect.ts` | cmdStart 冒頭の自己再 spawn ロジック（rotate + open + Bun.spawn + exit）|
| `skills/cmux-team/manager/heartbeat.ts` | 10s 間隔の sync write、clean exit 記録、unlink |
| `skills/cmux-team/manager/self-telemetry.ts` | 30s 間隔の async append、circular rotation |
| `skills/cmux-team/manager/fatal-handlers.ts` | uncaught/unhandled/SIGTERM/SIGINT/SIGHUP の統合 handler（fatal trace の単一責務点） |
| `skills/cmux-team/manager/post-mortem-redirect.test.ts` | DI 化した spawn の単体テスト |
| `skills/cmux-team/manager/heartbeat.test.ts` | sync write / clean exit / rotate 検証 |
| `skills/cmux-team/manager/self-telemetry.test.ts` | rotation 閾値検証 |
| `skills/cmux-team/manager/fatal-handlers.test.ts` | signal 種別の sync log 出力検証 |
| `docs/spec/15-post-mortem-evidence.md` | 新規 spec（4 軸 evidence の仕様） |
| `scripts/test-crash-evidence.sh` | 手動再現スクリプト（throw / kill -TERM / kill -9 で evidence が残ることを検証） |

### 3.2 変更ファイル（R2 反映: reload.ts を追加）

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/logger.ts` | `logSync()` / `warnSync()` / `errorSync()` を追加（既存 `log()` 等はそのまま）。`appendFileSync` ベース、format は async 版と一致 |
| `skills/cmux-team/manager/pidfile.ts` | **R1 採用**: `installCrashHandler` 内の `uncaughtException` / `unhandledRejection` listener を**撤去**し、`'exit'` listener のみ残置（pidfile cleanup のみが本来の責務）。fatal trace の出力は fatal-handlers.ts に移譲。既存 `pidfile.test.ts` の crash handler テストも撤去された listener に関する部分を修正 |
| `skills/cmux-team/manager/reload.ts` | **R2 反映**: `performDaemonReload` の `Bun.spawn` 引数 (`["run", absoluteMainTs, "start"]`) に **常に `--__post-mortem-redirected` を付与**する。親が既に redirect 済みなので reload した子も継承する設計理由をコメントで明示。`reload.test.ts` に「flag が args に含まれる」assertion を追加 |
| `skills/cmux-team/manager/daemon.ts` | 既存 `shutdown` を `async shutdown(signal?: string): Promise<void>` 化。冒頭で `logSync("signal_received", "signal=" + (signal ?? "none"))` を sync write してから既存処理に入る。SIGHUP listener を追加（shutdown と同じ handler を bind） |
| `skills/cmux-team/manager/main.ts` | (1) cmdStart 冒頭に `maybeRespawnWithStderrRedirect()` を追加。(2) pidfile 取得直後に `installCrashHandler(pidFilePath)` (これは `'exit'` listener のみ) と `installFatalHandlers({ onShutdown: (sig) => shutdown(sig) })` を呼ぶ。(3) `startHeartbeat(state)` を呼ぶ。(4) TUI 起動成功後に `startSelfTelemetry(state)` を呼ぶ。(5) `process.on("SIGINT", () => shutdown("SIGINT"))` / `process.on("SIGTERM", () => shutdown("SIGTERM"))` / `process.on("SIGHUP", () => shutdown("SIGHUP"))` の bind を明示化。(6) `onQuit: () => shutdown("dashboard_quit")` / `onFullQuit` 内 shutdown 呼びにも reason 文字列を渡す。(7) `shutdown` の終端で `stopHeartbeat({ cleanExit: true, reason: "shutdown" })` / `stopSelfTelemetry()` を呼ぶ |
| `skills/cmux-team/manager/config.ts` | `heartbeatIntervalMs` (default 10_000) / `telemetryIntervalMs` (default 30_000) / `telemetryMaxBytes` (default 5_242_880) / `stderrRotateGenerations` (default 1) の config schema 追加 |
| `CLAUDE.md` | 「Post-mortem Evidence Capture」セクション追加（heartbeat / telemetry / stderr.log の場所と読み方）|
| `docs/spec/00-project-overview.md` | 観察可能性章に post-mortem evidence へのリンクを追記 |
| `docs/spec/05-install-and-infrastructure.md` | `.team/logs/` / `.team/daemon.heartbeat` のファイル説明を追加 |

### 3.3 削除ファイル

なし。ただし pidfile.ts 内の `uncaughtException` / `unhandledRejection` listener コード**ブロック**は削除する（ファイル自体は残る。`'exit'` listener と PID-aware cleanup ヘルパは保持）。

---

## 4. サブタスク分割

> 並列実装禁止。下記の順番で 1 サブタスクずつ完了 → コミット → 次へ。
> 各サブタスクで `cd skills/cmux-team/manager && bunx tsc --noEmit` を通す（既存 16 件以上に増やさない）。
>
> **R2 反映**: S5 と S6 の間に **S5.1 (reload.ts への flag 伝播)** を追加。

### S1: `logger.ts` に sync API を追加

- 対象: `skills/cmux-team/manager/logger.ts`
- 完了条件:
  - `logSync(event, detail)` / `warnSync` / `errorSync` を export
  - 既存 `appendLine` と同じ format（タイムスタンプ・level prefix）
  - `appendFileSync` / `mkdirSync` で同期書き込み（recursive: true）
  - `CMUX_TEAM_LOGGER_STRICT` の挙動も async 版と一致
- 検証: 新規 `logger.test.ts` に `logSync()` の単体テスト追加 → `bun test logger.test.ts` pass

### S2: `fatal-handlers.ts` を新設（uncaught / unhandled / signal の完全集約） — R1 反映

- 対象: `skills/cmux-team/manager/fatal-handlers.ts` (新規) + `skills/cmux-team/manager/pidfile.ts` (listener 撤去) + `skills/cmux-team/manager/pidfile.test.ts` (テスト修正)
- 完了条件:
  - **fatal-handlers.ts**:
    - `installFatalHandlers(opts)` を export。opts には `onShutdown?: (signal: string) => Promise<void>` を受ける
    - 内部で `process.on("uncaughtException", ...)` / `process.on("unhandledRejection", ...)` / `process.on("SIGTERM" | "SIGINT" | "SIGHUP", ...)` を install
    - uncaught / unhandled handler 内: `logSync("fatal_uncaught", "err=" + format(err))` → `errorSync("fatal_stack", err.stack)` → `exit(1)`。**cleanup は不要 — `installCrashHandler` の `'exit'` listener が `process.exit(1)` 経由で必ず走るため pidfile cleanup は保証される**
    - signal handler 内: `logSync("signal_received", "signal=" + name)` → `onShutdown?.(name)` を await（無ければ no-op）→ shutdown が return すれば自然終了、return しなければ最終的に SIGTERM 等で死ぬ
    - 返り値で uninstall function（`process.removeListener`）
  - **pidfile.ts**:
    - `installCrashHandler` から `uncaughtException` / `unhandledRejection` listener を**撤去**
    - `'exit'` listener のみ残置（pidfile cleanup の単一責務化）
    - 関数名・export は維持し、コメントで「fatal trace の責務は fatal-handlers.ts に移譲、本関数は pidfile cleanup のみ」を明記
  - **pidfile.test.ts**:
    - 撤去された listener に依存する既存テスト（`uncaughtException` 経由で cleanup が走ることを assert していたもの）を修正。具体的には `process.emit("exit", 1)` 経由で cleanup が走ることを assert する形に書き換える
- 検証:
  - `fatal-handlers.test.ts` で DI 化した logSync / exitImpl を mock し、各 signal / uncaught / unhandledRejection に対して正しい event が記録されることを assert
  - `bun test pidfile.test.ts` が修正後も green

### S3: `heartbeat.ts` を新設

- 対象: `skills/cmux-team/manager/heartbeat.ts` (新規)
- 完了条件:
  - `startHeartbeat({ path, intervalMs, getState })` で setInterval 開始、即時 1 回 write
  - `stopHeartbeat({ cleanExit, reason })` で clearInterval → cleanExit:true ならファイル内に `clean exit: reason=<reason>` を **sync write** してから unlink
  - 書き込み内容（JSON 1 行 + 改行）:
    ```json
    {"ts": "2026-05-17T15:58:09+09:00", "pid": 25813, "uptime_sec": 518400, "open_tasks": 3, "conductors": {"idle": 2, "running": 1, "disconnected": 0, "broken": 0}, "rss_mb": 1240, "heap_mb": 380}
    ```
  - 内部は `writeFileSync(path, content, "utf8")`（truncate して上書き）
  - getState は state からの snapshot 取得関数（DI）
- 検証: `heartbeat.test.ts`
  - setInterval を DI 可能にし、`startHeartbeat` 後にファイルが存在 + JSON parse 成功
  - `stopHeartbeat({ cleanExit: false })` でファイル残存
  - `stopHeartbeat({ cleanExit: true, reason: "shutdown" })` でファイル消滅前に `clean exit: reason=shutdown` が記録される
- 手動: `kill -9 <pid>` 後にファイル残存 + mtime が ±10s で死亡時刻を示すことを scripts/test-crash-evidence.sh で確認

### S4: `self-telemetry.ts` を新設

- 対象: `skills/cmux-team/manager/self-telemetry.ts` (新規)
- 完了条件:
  - `startSelfTelemetry({ path, intervalMs, maxBytes, getState })` で setInterval 開始
  - append 内容（JSONL 1 行）:
    ```json
    {"ts": "...", "pid": ..., "rss_mb": ..., "heap_used_mb": ..., "heap_total_mb": ..., "event_loop_lag_ms": ..., "open_tasks": ..., "conductor_count": {"idle":...,"running":...}}
    ```
  - event loop lag は `setImmediate` の delay 測定（初回 0、以降は前回 timer からの差分 - intervalMs）
  - rotation: append 前に `statSync(path).size > maxBytes` なら `rename(path, path + ".1")`
  - `stopSelfTelemetry()` で clearInterval
- 検証: `self-telemetry.test.ts`
  - maxBytes=100 などで強制 rotation → `.1` が生成され元 file が新規 append 可能
  - JSONL の各行が parse 可能

### S5: `post-mortem-redirect.ts` を新設

- 対象: `skills/cmux-team/manager/post-mortem-redirect.ts` (新規)
- 完了条件:
  - `maybeRespawnWithStderrRedirect(opts)` を export。opts: `{ projectRoot, args, isTTYImpl?, spawnImpl?, openSyncImpl?, exitImpl? }`
  - flag `--__post-mortem-redirected` を args に含むなら何もせず return（子）
  - flag 無し かつ `process.stderr.isTTY` でないなら何もせず return（test / pipe 経路）
  - それ以外: `.team/logs/manager.stderr.log` を rotate（存在すれば `.1` に rename、`.1` も存在すれば overwrite）→ `openSync(..., "a")` → `Bun.spawn([execPath, argv1, ...args, "--__post-mortem-redirected"], { stdio: ["inherit", "inherit", fd], detached: true, env, cwd })` → `child.unref()` → `closeSync(fd)` → `exit(0)`
  - エッジケース: spawn 失敗（`child.pid` undefined）→ stderr へ error 出力 → exit(1)（redirect 無しの直接実行に fallback すべきか議論。**fallback しない**: silent failure を避けるため fail-fast）
- 検証: `post-mortem-redirect.test.ts`
  - spawnImpl を mock し、`stdio[2]` に渡される fd が `manager.stderr.log` を開いた fd であること
  - 既存 file がある場合は `.1` への rename が走ること
  - flag 付き呼び出しでは何もせず return

### S5.1: `reload.ts` への `--__post-mortem-redirected` flag 伝播 — R2 反映（新設）

- 対象: `skills/cmux-team/manager/reload.ts` + `skills/cmux-team/manager/reload.test.ts`
- 完了条件:
  - `performDaemonReload` の args 構築 (`["run", absoluteMainTs, "start"]`) を `["run", absoluteMainTs, "start", "--__post-mortem-redirected"]` に変更
  - 親（旧 daemon）は既に redirect 済みなので、reload した子も「redirect 済み」として継承する設計理由をコメントで明示:
    ```ts
    // reload した子も親の stderr fd (manager.stderr.log) を継承するため、
    // redirect 済み扱いとして起動する。flag を付けないと子の cmdStart で
    // maybeRespawnWithStderrRedirect が再度子を spawn してしまい 2 段重ねになる。
    ```
  - `reload.test.ts` に新規 assertion を追加: spawnImpl の mock 呼び出し引数に `"--__post-mortem-redirected"` が含まれることを assert
- 検証:
  - `cd skills/cmux-team/manager && bun test --timeout 30000 reload.test.ts` が green
  - 既存 reload integration test が壊れていないこと

### S6: cmdStart に統合 — R3 / R4 反映で完了条件を具体化

- 対象: `skills/cmux-team/manager/main.ts` + `skills/cmux-team/manager/daemon.ts`
- 完了条件:
  - **redirect**: cmdStart の冒頭（CMUX_SOCKET_PATH チェックの**前**、つまり一切の副作用前）に `await maybeRespawnWithStderrRedirect({ projectRoot: PROJECT_ROOT, args })` を追加
  - **handler install 順序（R1 反映）**: pidfile 取得直後に
    1. `installCrashHandler(pidFilePath)` (`'exit'` listener のみ — pidfile cleanup を担保)
    2. `installFatalHandlers({ onShutdown: (signal) => shutdown(signal) })` (uncaught / unhandled / signal)
    を**この順**で呼ぶ。順序は重要ではないが、コメントで両者の責務分離（cleanup vs. fatal log）を明記
  - **signal bind を明示化（R3 反映）**:
    - `process.on("SIGINT", () => shutdown("SIGINT"))`
    - `process.on("SIGTERM", () => shutdown("SIGTERM"))`
    - `process.on("SIGHUP", () => shutdown("SIGHUP"))`
    - (これらは fatal-handlers.ts の signal listener と同じ pattern。fatal-handlers 側で install するなら main.ts 側は重複を避けるため install しない — どちらか一方に集約する。**採用**: fatal-handlers.ts に集約し、main.ts 側の `process.on("SIGINT", shutdown)` 等は撤去)
  - **dashboard コールバック（R3 反映）**:
    - `onQuit: () => shutdown("dashboard_quit")`
    - `onFullQuit` 終端の `shutdown` 呼びがあれば `shutdown("dashboard_full_quit")` のように reason 文字列を渡す
  - **shutdown signature（R3 反映）**:
    - `shutdown` を `async shutdown(signal?: string): Promise<void>` に変更
    - 冒頭で `logSync("signal_received", "signal=" + (signal ?? "none"))` を sync write
    - 終端（`releasePidFile` 直前）で `stopHeartbeat({ cleanExit: true, reason: signal ?? "shutdown" })` / `stopSelfTelemetry()` を呼ぶ
  - **heartbeat / telemetry 起動**:
    - `state.startedAt` 設定の直後に `startHeartbeat({ path: join(PROJECT_ROOT, ".team/daemon.heartbeat"), intervalMs, getState: () => state })`
    - `startDashboard(...)` 成功後（onReload / onQuit / onFullQuit を仕掛けた後）に `startSelfTelemetry({ path: join(PROJECT_ROOT, ".team/logs/manager.telemetry.jsonl"), intervalMs, maxBytes, getState: () => state })`
- 検証（R4 反映 — 既存テストへの影響評価を追加）:
  - `cd skills/cmux-team/manager && bun test --timeout 30000 main.test.ts` が green
  - `cd skills/cmux-team/manager && bun test --timeout 30000 daemon.test.ts` が green
  - shutdown を直接 call している既存 test を `grep "shutdown(" *.test.ts` で抽出し、signature 変更（optional 引数追加）が既存 caller を壊さないことを確認。grep 結果と pass 状況を sub-task ログに残す
  - `main.test.ts` 内で cmdStart を呼ぶ test は `isTTYImpl=false` 注入 or 非 TTY 環境で動かす wire-up を維持（spawn 経路に入らないことを保証）
  - 手動: `elevens start` → 別 terminal で `kill -TERM <pid>` → manager.log に `signal_received signal=SIGTERM` が記録され、graceful exit
  - 手動: `elevens start` → 別 terminal で `kill -HUP <pid>` → 同様に `signal_received signal=SIGHUP` が記録される

### S7: `config.ts` への interval override schema 追加

- 対象: `skills/cmux-team/manager/config.ts`
- 完了条件:
  - schema に `postMortem?: { heartbeatIntervalMs?, telemetryIntervalMs?, telemetryMaxBytes?, stderrRotateGenerations? }` を追加
  - default 値解決関数 `resolvePostMortemConfig(config)` を export
  - 既存 config の zod schema を壊さない（optional のみ追加）
- 検証: `config.test.ts` に override 解決の単体テスト追加

### S8: 手動再現スクリプト — R5 反映（CI 統合可否を明示）

- 対象: `scripts/test-crash-evidence.sh` (新規)
- 完了条件: 以下シナリオで evidence が残ることを bash で自動確認
  1. `elevens start` を別 process で起動 → 5s 待機
  2. heartbeat ファイル存在確認 / JSON parse OK / mtime が直近 ±15s
  3. telemetry jsonl 存在確認 / 行数 >= 1
  4. shell に `kill -SIGUSR2 <pid>` → main.ts に test hook を仕込み `throw new Error("synthetic")` を発火
  5. manager.stderr.log に "synthetic" を含むことを grep 確認
  6. manager.log に `fatal_uncaught` event を含むことを grep 確認
  7. heartbeat ファイルが残存していて mtime が死亡時刻 ±10s であることを確認
- 注: SIGUSR2 hook は dev only（`process.env.CMUX_TEAM_DEV === "1"` ガード）
- **CI 統合方針（R5 採用）**: **本スクリプトは開発者ローカル前提（要 TTY、要 dev hook、要 ephemeral PID race の手動検証）。CI 化は別タスクで検討する**。理由:
  - TTY 前提のため `.github/workflows/test.yml` の非対話実行環境ではそのまま回せない
  - SIGUSR2 dev hook は `CMUX_TEAM_DEV=1` ガード下で `throw` を発火させる仕掛けで、CI で誤発火するリスクを避けたい
  - ephemeral port / PID race の CI 安定性は別途設計が必要
  - 本 plan のスコープは「evidence 機構の実装」であり、CI 化は副次目標として後続タスクで起票推奨

### S9: docs/spec/15-post-mortem-evidence.md を新設 — R6 反映（重複経路の節を追加）

- 対象: `docs/spec/15-post-mortem-evidence.md`
- 完了条件: 以下節を含む
  - **1. 概要**（4 軸 evidence の目的、インシデント T010 を参照）
  - **2. ファイル一覧**（.stderr.log / .heartbeat / .telemetry.jsonl の path / format / rotate ルール）
  - **3. heartbeat schema**（JSON 1 オブジェクト）
  - **4. telemetry schema**（JSONL、各 field）
  - **5. fatal trace の重複経路（R6 反映）**: 同じ fatal err が以下の経路で複数 file に出る可能性があることを明記:
    - **(a) `.team/logs/manager.stderr.log`** — Bun runtime backtrace + `console.error` 由来（OS fd 2 経由）
    - **(b) `.team/logs/manager.log` の `[error]` 行** — `installDashboardConsoleRedirect` 経由（TUI 描画中に `console.error` が呼ばれた場合に限る。本タスクの R1 改訂で `installCrashHandler` 内の `console.error(err)` 経路は撤去されたため、fatal handler から直接 `console.error` を呼ぶ経路は基本的に発生しない）
    - **(c) `.team/logs/manager.log` の `fatal_uncaught` / `fatal_stack` event** — fatal-handlers.ts の `logSync` 由来
    - **事後分析時の primary source は (c) `fatal_uncaught` event**。(a) は Bun runtime panic / Rust panic / libc abort のような JS 層に来ない fatal の取得のみに使う。(b) は基本的に空のはず（R1 改訂後）。整合性のため重複カウントを避ける旨を読み手向けに明記
  - **6. fatal event 名**（`fatal_uncaught` / `fatal_unhandled_rejection` / `signal_received`）
  - **7. config override**（`.team/config.json` の `postMortem.*`）
  - **8. 事後分析 cookbook**（heartbeat の mtime → 死亡時刻、telemetry の最後 N 行 → 直前 RSS / event loop、stderr.log → JS exception or Bun panic か）
- glossary.md / 00-project-overview.md からのリンクも忘れず追加

### S10: CLAUDE.md 更新

- 対象: `CLAUDE.md`
- 完了条件:
  - 「Manager プロトコル（概要）」セクションに `manager.stderr.log` / `daemon.heartbeat` / `manager.telemetry.jsonl` の存在を追記
  - 新規セクション「Post-mortem evidence」を追加し、`docs/spec/15-post-mortem-evidence.md` へリンク

### 制約事項の遵守確認

- **並列実装禁止**: S1〜S10（S5.1 含む）は逐次
- **削除タスク必須**: 本タスクの責務縮退で `installCrashHandler` 内の `uncaughtException` / `unhandledRejection` listener コードブロックを撤去するが、ファイル単位の削除は無い（`'exit'` listener と pidfile cleanup ヘルパは保持）。S2 内で listener 撤去 + テスト修正をセットで実施

---

## 5. リスク

### 5.1 既存機能への影響 — R1 反映で順序問題を解消

| リスク | 対策 |
|---|---|
| **handler 順序の保証問題**（旧案では `process.exit(1)` 同期 terminate により後続 listener が走らない） | **R1 採用案 (a) で構造的に解消**: `installCrashHandler` の `uncaughtException` / `unhandledRejection` listener を撤去し、fatal-handlers.ts に完全集約することで「handler が複数登録されている」状況自体を排除。pidfile cleanup は `'exit'` listener が `process.exit(1)` 経由で必ず発火する仕様を利用 |
| 子 spawn 方式で **init order** が変わる（preflight が子で走る）→ 親プロセスでの環境変数や TTY 設定が伝播するか | `env: process.env` で継承、`stdio: ["inherit", "inherit", fd]` で TTY ハンドルを継承。reload.ts と同形なので動作実績あり |
| `shutdown` 関数の signature 変更（`signal?: string` 追加）で既存 caller (`onQuit: () => { shutdown(); }`) が壊れる | optional 引数なので既存呼び出しは互換。S6 検証ステップで `grep "shutdown(" *.test.ts` 結果を確認し、signature 変更影響を明示的に検証 |
| heartbeat の sync write が daemon main loop を毎 10s 数 ms ブロック | RSS / heap のみ取得（sync 操作のみ）、file write も 1KB 未満。10s 周期で <5ms 想定。問題なし |
| stderr.log の rotate が race condition で .1 を上書き | `start` 時のみ rotate するため race は無い（pidfile で多重起動防止済み） |
| **reload 経路で stderr redirect が 2 段重ね**（旧案では `performDaemonReload` の args に flag が無く、reload した子が再度 `maybeRespawnWithStderrRedirect` で子を spawn してしまう） | **R2 採用で S5.1 として独立サブタスク化**: reload.ts で常に `--__post-mortem-redirected` を args に付与することで、reload した子は「redirect 済み扱い」として通常 init を続行 |
| pidfile.ts の listener 撤去で既存 pidfile.test.ts が壊れる | S2 完了条件に「pidfile.test.ts の修正」を明示。`process.emit("exit", ...)` 経由で cleanup を assert する形に書き換え |

### 5.2 エッジケース

| ケース | 挙動 |
|---|---|
| reload 中（親が exit → 子が起動）| **R2 反映**: `performDaemonReload` が `--__post-mortem-redirected` を常に args に付与するため、reload した子は `maybeRespawnWithStderrRedirect` で「flag あり → no-op return」して通常 init を続行。stderr fd は親から継承される |
| test 環境 (`bun test`) | `process.stderr.isTTY === false` で redirect skip → inline 実行。既存テスト互換 |
| `initInfra` 失敗 | preflight 段階での失敗は redirect 後の子で起こり、stderr.log + manager.log に痕跡。pidfile はまだ取得していないので cleanup 不要 |
| `Bun.spawn` 失敗（bun ENOENT 等）| `child.pid` undefined → process.stderr.write でエラー + exit(1)。preflight で bun 存在は確認済みなので通常起きない |
| heartbeat file が外部から削除された | 次の interval で再作成される。clean exit 検知のみ false negative になる（許容） |
| uncaughtException 発生時 | fatal-handlers.ts の listener が `logSync("fatal_uncaught", ...)` → `errorSync("fatal_stack", ...)` → `exit(1)`。`'exit'` listener (pidfile.ts) が pidfile cleanup を実行（順序保証は `process.exit` の仕様で担保） |

### 5.3 テスト戦略

| 種別 | 範囲 |
|---|---|
| Unit | logger.ts (logSync), heartbeat.ts (sync write / clean exit / DI timer), self-telemetry.ts (rotation 閾値), post-mortem-redirect.ts (DI spawn / rotate logic), fatal-handlers.ts (signal 種別 / uncaught / unhandled の event 出力), reload.ts (flag 伝播 assertion) |
| Integration（既存に追加） | daemon.test.ts に「shutdown が `signal_received` を logSync で出すこと」のテスト 1 件追加。main.test.ts への影響評価（`isTTYImpl=false` 注入の wire-up）。`bunx tsc --noEmit` の新規エラー 0 件 |
| Manual | scripts/test-crash-evidence.sh で 4 軸 evidence を自動検証（**開発者ローカル前提、CI 化は別タスク** — R5 反映） |
| **禁忌**: `bun test` を repo root から実行しないこと（CLAUDE.md の既知の注意点）。`cd skills/cmux-team/manager && bun test --timeout 30000 <file>` で個別実行 |

---

## 6. 既存型エラーの先読み

`cd skills/cmux-team/manager && bunx tsc --noEmit` 実行結果（本タスク変更前）:

| ファイル | エラー | 本タスクで触る? | 扱い |
|---|---|---|---|
| c11-features.test.ts | 2 件 (TS2722, TS2322) | × | 別タスクで対応 |
| c11-features.ts | 2 件 (TS2345, TS2322 — MailboxChange discriminated union) | × | 別タスクで対応 |
| mailbox-cli.ts | 3 件 (TS18048, TS2345 — undefined narrowing) | × | 別タスクで対応 |
| main.ts:977 | 1 件 (TS2322: state.updateMode = autoUpdate.mode) | △ (main.ts は触るが 977 行は触らない) | 別タスクで対応 |

**本タスクで解消する型エラー: 0 件**（既存 16 件は本タスクと無関係なので別タスクに分離）。
**本タスクで新規導入してはいけない型エラー: 0 件**（新規 module は strict mode を遵守）。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | stderr redirect の実装方式（a/b/c） | **(b) cmdStart 冒頭で自己再 spawn**（`Bun.spawn(stdio:["inherit","inherit",fd], detached:true)`）| (a) は Bun の `process.dup2` 相当 API が無く Bun runtime panic も捕捉不可。(c) は console hook が Bun Zig レイヤの直接 stderr 書き込みを捕捉できない。(b) は OS fd レイヤで redirect するため JS exception / Bun runtime panic / Rust crate panic / libc abort すべてを file に残せる。実機検証で `throw` 時に "Bun v1.3.13 (macOS arm64)" を含む backtrace 全文が file に残ることを確認 |
| D2 | heartbeat / telemetry interval の override 許可有無 | **許可する**。`.team/config.json` の `postMortem.{heartbeatIntervalMs, telemetryIntervalMs}` で override 可、default は 10s / 30s | 重い process 環境（多 Conductor + slow disk）で 10s interval が main loop ノイズになる場合に緩める判断ができる。spec で default を強く推奨し、env 経由（`CMUX_TEAM_HEARTBEAT_INTERVAL_MS` 等）は導入しない（config.json の方が永続的・観察可能） |
| D3 | stderr rotate の世代数 | **1 世代（`.1` のみ）**。`.team/logs/manager.stderr.log` + `.team/logs/manager.stderr.log.1` | crash 後の debug workflow では「死亡時の stderr」と「その 1 つ前の起動時の stderr」があれば十分。多世代は disk 占有とコード複雑性を増やす。必要なら config で `stderrRotateGenerations` を増やせる設計だけ残す（PoC では 1 固定） |
| D4 | telemetry circular rotation 閾値 | **5 MB（file size base）**。`telemetryMaxBytes = 5_242_880` | 30s 間隔 × 1 record 約 200 bytes = 1 day 約 0.6 MB。5 MB なら約 8 day 保持。daemon 平均稼働 6 日（インシデント時の値）に余裕。size base にした理由: 件数 base だと 1 record サイズが変わると保持期間がブレる |
| D5 | 外部 sampler (#6 launchd plist) を本タスクに含めるか | **別タスクに切る**。本タスクスコープから除外し、後続タスクとして create-task 推奨 | launchd plist 配布は plugin user 体験への影響大（権限要求、uninstall 経路、cross-platform 非対応）。design 議論を本タスクに含めると scope creep する。本タスクの 4 軸 evidence (stderr / heartbeat / telemetry / fatal trace) で **WHEN/WHAT/WHY のうち system context 以外は十全に取れる**。残った system context（vm_stat / swap / 他 bun process）は launchd plist で別途 sample する方が責務分離も明確 |
| D6 | bun crash report 設定 (#7) の出力先 | **artifact (research) として記録**。本 plan には組み込まない。**本 plan 採択後、別タスクとして `cmux-team create-task --status draft --title "T0xx: bun crash report 調査 artifact 作成"` で起票し、Axxx-bun-crash-report.md research artifact を `/elevens:artifact research bun-crash-report` で作成する（R7 反映）**。本タスクの S 系（S1〜S10）には含めない | Context7 経由で Bun の env var を調査した結果、(1) `DO_NOT_TRACK=1` で自動アップロード無効化が可能、(2) **local file dump を強制する公式 env は無い**、(3) 不安定版 (`BUN_JSC_dumpSimulatedThrows`) は debug build 専用。プロダクション運用では (b) 子 spawn 方式での stderr redirect が唯一の現実解。今回の調査結果は別タスク経由で artifact 化し、本 plan の決定根拠を落穂拾い経路に残す |
| D7 (新規, R1 反映) | uncaught/unhandled handler の集約先 | **fatal-handlers.ts に完全集約**（採用案 (a)）。`installCrashHandler` の `uncaughtException` / `unhandledRejection` listener は撤去 | `process.exit()` の同期 terminate 仕様により、複数 listener を順次走らせて全部に副作用を持たせる設計は構造的に不可能。「最初の listener が exit を呼んだ瞬間に後続 listener は走らない」問題を構造で排除するには、handler を 1 箇所に集約するしかない。pidfile cleanup は `'exit'` listener が `process.exit(1)` 経由で必ず発火する仕様で担保されるため、cleanup の責務を `'exit'` listener に分離することで両立 |

---

## 8. 完了条件チェックリスト（タスク本文 Acceptance Criteria に対応）

- [ ] `.team/logs/manager.stderr.log` が daemon spawn 時に作られ、bun の stderr 全部がそこに行く
  → S5 / S6 の手動検証で確認（daemon 内で `throw new Error(...)` → stderr.log に stack trace + Bun runtime backtrace が残る）
- [ ] reload した子も 2 段重ね無しで動く（stderr fd は親から継承）
  → S5.1 (R2 反映) の unit test + 手動検証で確認
- [ ] `.team/daemon.heartbeat` が 10s 毎に更新される。daemon kill -9 後に file が残存し mtime が死亡時刻 (±10s) を示す
  → S3 / scripts/test-crash-evidence.sh で確認
- [ ] daemon 内で `throw` した時、manager.log に fatal trace が sync で書かれ、process が exit する
  → S2 (R1 反映: fatal-handlers.ts に集約) / S1 (logSync) で実装、scripts/test-crash-evidence.sh で確認
- [ ] daemon に `kill -TERM` / `kill -HUP` を送ると、manager.log に「signal received: SIGTERM」「signal received: SIGHUP」が記録されてから exit
  → S2 / S6 (R3 反映: 各 signal bind を明示) で実装、scripts/test-crash-evidence.sh で確認
- [ ] `.team/logs/manager.telemetry.jsonl` に 30s 毎にメトリクスが append される
  → S4 / S6 で実装、scripts/test-crash-evidence.sh で確認
- [ ] (6 を本タスクに含めるなら) `elevens install-watchdog` で launchd plist が install され〜 → **D5 により本タスク対象外**（別タスク推奨）
- [ ] `docs/spec/` に新規 spec を追加、`CLAUDE.md` にも該当 section を追加
  → S9 (R6 反映: §5 fatal trace の重複経路を追加) / S10
- [ ] 既存 test (manager 配下) が pass — main.test.ts / daemon.test.ts / pidfile.test.ts / reload.test.ts 含む
  → S6 の検証ステップ（R4 反映）、`cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done`

---

## 9. 実装順序（推奨） — S5.1 追加で更新

1. **S1** logger sync API（他全てが依存）
2. **S2** fatal-handlers + pidfile.ts listener 撤去 + pidfile.test.ts 修正（S1 に依存、R1 反映）
3. **S3** heartbeat（S1 に依存）
4. **S4** self-telemetry（独立、S1 をオプションで使用）
5. **S5** post-mortem-redirect（独立）
6. **S5.1** reload.ts への flag 伝播（S5 に依存、R2 反映 — 新設）
7. **S7** config schema 追加（S3 / S4 / S5 の interval / threshold を解決）
8. **S6** cmdStart に統合（S1〜S5.1, S7 すべて完了後、R3 / R4 反映で完了条件具体化）
9. **S8** 手動再現スクリプト（S6 完了後の整合検証、R5 反映で CI 化は別タスク明示）
10. **S9** spec ドキュメント（実装確定後の規範化、R6 反映で §5 重複経路追加）
11. **S10** CLAUDE.md 更新（spec 完成後にリンク）

各サブタスク完了時に `bunx tsc --noEmit` と該当 `bun test <file>.test.ts` を走らせ、エラーが既存 16 件を超えていないことを確認する。
