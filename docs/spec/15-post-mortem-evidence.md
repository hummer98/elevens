# 15. Post-mortem Evidence Capture

## 1. 概要

Manager daemon が死亡した時に **WHEN / WHAT / WHY** の 3 軸で原因究明できる evidence を残す機構。
2026-05-17 の Brainship/prototype インシデント（Manager daemon が無言で死亡し、29 分のギャップで原因究明不能）への構造的対策として T010 で導入された。

「decision は AI、機構は決定論的コードで」原則どおり、observe する側（人間／事後 grep）は file を読むだけで状況を再構成できる。

| 観測軸 | 媒体 |
|---|---|
| WHEN (死亡時刻 ±10s) | `.team/daemon.heartbeat` |
| WHAT (死亡直前の内部状態) | `.team/logs/manager.telemetry.jsonl` |
| WHY (JS 例外 / Bun runtime panic / Rust backtrace / libc abort) | `.team/logs/manager.stderr.log` |
| WHY (signal 受信 / fatal 例外の sync log) | `.team/logs/manager.log` の `signal_received` / `fatal_uncaught` event |

## 2. ファイル一覧

| パス | 種別 | 書き込み方法 | rotate |
|---|---|---|---|
| `.team/daemon.heartbeat` | JSON 1 オブジェクト | 10s 間隔の sync write (truncate 上書き) | なし — clean exit 時に reason 追記 + unlink |
| `.team/logs/manager.telemetry.jsonl` | JSONL (1 行 1 sample) | 30s 間隔の sync append | size base — 既存が `telemetryMaxBytes` (default 5 MB) を超えていたら `.1` に rename |
| `.team/logs/manager.stderr.log` | raw text (OS fd 2) | `start` 時に自己再 spawn、子の fd 2 を file に redirect | start 時に既存があれば `.1` に rename (1 世代) |
| `.team/logs/manager.log` | text (既存 logger) | fatal handler 経由で sync append (`logSync` / `errorSync`) | 既存の team-gc rotation に従う |

## 3. heartbeat schema

```json
{
  "ts": "2026-05-17T15:58:09+09:00",
  "pid": 25813,
  "uptime_sec": 518400,
  "open_tasks": 3,
  "conductors": {
    "idle": 2,
    "running": 1,
    "disconnected": 0,
    "broken": 0
  },
  "rss_mb": 1240,
  "heap_mb": 380
}
```

書き込み時は **`writeFileSync` で truncate 上書き**。観察者は `stat` の mtime と JSON の `ts` の両方を死亡時刻として参照できる。

## 4. telemetry schema

```json
{"ts":"2026-05-17T15:58:30+09:00","pid":25813,"rss_mb":187,"heap_used_mb":142,"heap_total_mb":178,"external_mb":5,"event_loop_lag_ms":4,"open_tasks":3,"open_conductors":2,"open_agents":1,"uptime_sec":518400}
```

| field | 取得元 |
|---|---|
| `ts` | local TZ ISO 8601 |
| `pid` | `process.pid` |
| `rss_mb` / `heap_used_mb` / `heap_total_mb` / `external_mb` | `process.memoryUsage()` を MB に換算 |
| `event_loop_lag_ms` | `startEventLoopLagMeter` (`setImmediate` の delay 計測) |
| `open_tasks` | `state.openTasks` |
| `open_conductors` | `state.conductors.size` |
| `open_agents` | `state.conductors` の各 `agents.length` を合計 |
| `uptime_sec` | `process.uptime()` |

## 5. fatal trace の重複経路

同じ fatal err が以下の経路で複数 file に出る可能性がある。事後分析時の主参照は **(c)** とする。

| 経路 | 媒体 | 出所 | T010 改訂後の状況 |
|---|---|---|---|
| (a) | `.team/logs/manager.stderr.log` | OS fd 2 経由 (Bun runtime backtrace / `console.error` / Rust panic / libc abort) | Bun runtime panic / Rust panic / libc abort のように JS 層に来ない fatal の取得に限定して使う |
| (b) | `.team/logs/manager.log` の `[error]` 行 | `installDashboardConsoleRedirect` 経由 (TUI 描画中の `console.error`) | T010 R1 改訂で `installCrashHandler` 内の `console.error(err)` 経路は撤去されたため基本的に空 |
| (c) | `.team/logs/manager.log` の `fatal_uncaught` / `fatal_unhandled_rejection` / `fatal_stack` event | `fatal-handlers.ts` の `logSync` / `errorSync` 由来 | **primary source** |

整合性のため、同一 fatal err を **重複カウントしない**こと。

## 6. fatal event 名

`.team/logs/manager.log` に出る fatal/signal 関連 event:

| event | 出所 |
|---|---|
| `fatal_uncaught` | `process.on("uncaughtException", ...)` (fatal-handlers.ts) |
| `fatal_unhandled_rejection` | `process.on("unhandledRejection", ...)` (fatal-handlers.ts) |
| `fatal_stack` | 上記いずれかの直後に `errorSync` で出される stack trace (`\n` は ` | ` に畳む) |
| `signal_received` | SIGTERM / SIGINT / SIGHUP 受信時 (fatal-handlers.ts) + shutdown 関数冒頭 (main.ts) |
| `shutdown_failed` | `onShutdown(signal)` が reject した場合 |
| `daemon_stopped` | shutdown 完了時 (既存) |

## 7. config override

`.team/config.json` の `postMortem` フィールドで各 interval / threshold を上書きできる:

```json
{
  "postMortem": {
    "heartbeatIntervalMs": 30000,
    "telemetryIntervalMs": 60000,
    "telemetryMaxBytes": 10485760,
    "stderrRotateGenerations": 1
  }
}
```

| field | default | clamp range | 用途 |
|---|---|---|---|
| `heartbeatIntervalMs` | 10_000 | [1_000, 600_000] | heartbeat 書き込み間隔 |
| `telemetryIntervalMs` | 30_000 | [5_000, 3_600_000] | telemetry append 間隔 |
| `telemetryMaxBytes` | 5_242_880 (5 MB) | [262_144, 268_435_456] | telemetry rotation 閾値 |
| `stderrRotateGenerations` | 1 | [1, 5] | stderr.log の世代数 (PoC では 1 固定だが将来拡張用) |

範囲外 / 型違反は silent fallback で default に倒す（fail-fast せず）。

env override (`CMUX_TEAM_HEARTBEAT_INTERVAL_MS` 等) は導入しない — config.json の方が永続的で観察可能。

## 8. 事後分析 cookbook

### Q1: daemon はいつ死亡したか？

```bash
# heartbeat の mtime と内容を見る
stat .team/daemon.heartbeat
cat .team/daemon.heartbeat | jq .ts
```

mtime が daemon の最終 alive 時刻 (±10s)。heartbeat 内 `ts` も同じ。clean exit ならファイルは存在しないため、**存在 + mtime 直近** が異常終了の証拠。

### Q2: 死亡直前の RSS / heap / event loop は？

```bash
# 末尾 20 行を見る
tail -20 .team/logs/manager.telemetry.jsonl | jq -c '{ts,rss_mb,heap_used_mb,event_loop_lag_ms,open_tasks}'
```

- `rss_mb` が単調増 → leak 型 OOM の疑い
- `rss_mb` が burst → 別系統 (突発的ワークロード)
- `event_loop_lag_ms` が増 → blocking I/O / CPU 飽和

### Q3: JS 例外 / Bun runtime panic はあったか？

```bash
# まずは primary source (c)
grep -E "fatal_uncaught|fatal_unhandled_rejection|fatal_stack" .team/logs/manager.log

# 上記が空なら Bun runtime panic / Rust panic を疑う
tail -50 .team/logs/manager.stderr.log
```

`fatal_stack` event は 1 行に畳まれているので、` | ` を `\n` に戻すと読みやすい:

```bash
grep fatal_stack .team/logs/manager.log | sed 's/ | /\n/g'
```

### Q4: 外部 signal で死んだか？

```bash
grep signal_received .team/logs/manager.log
```

`signal=SIGTERM` / `SIGINT` / `SIGHUP` のどれを受けたか分かる。
**SIGKILL / SIGSEGV / OOM-kill は捕えられない**仕様で割り切り — それらは `manager.stderr.log` の不在 + `heartbeat` 残存 で間接的に推測する。

### Q5: 前回起動の stderr を見たい

```bash
# rotate 後の前世代
tail -50 .team/logs/manager.stderr.log.1
```

`start` 時に必ず `.1` に rotate されるため、1 つ前の daemon 起動分まで保持される。

## 9. 設計判断 (関連)

- **stderr redirect は wrapper subcommand 方式 (D1 = (b))**: `Bun.spawn(stdio:["inherit","inherit",fd], detached:true)` で子プロセスの OS fd 2 を file に向ける。Bun の `process.dup2` 相当 API が無く、`process.stderr.write` hook も Zig 層の panic を捕捉できないため、これが唯一の現実解。
- **handler の単一責務化 (D7)**: uncaughtException / unhandledRejection / signal は `fatal-handlers.ts` に集約、pidfile cleanup は `pidfile.ts` の `'exit'` listener に集約。`process.exit()` の同期 terminate 仕様により、複数 listener を順次走らせて全部に副作用を持たせる設計は構造的に不可能なため、責務を分離する。
- **stderr rotate は 1 世代 (D3)**: crash 後の debug workflow では「死亡時の stderr」と「その 1 つ前」があれば十分。多世代は disk 占有とコード複雑性を増やす。
- **telemetry rotation は size base 5 MB (D4)**: 30s 間隔 × 1 record 約 200 bytes = 1 day 約 0.6 MB。5 MB なら約 8 day 保持。
- **外部 sampler (vm_stat / 他 bun process) は別タスクに切る (D5)**: launchd plist 配布は plugin user 体験への影響大。本タスクの 4 軸 evidence で WHEN/WHAT/WHY のうち system context 以外は十全に取れる。残った system context は launchd plist で別途 sample する方が責務分離も明確。

## 10. 関連

- 実装: `skills/cmux-team/manager/{heartbeat,self-telemetry,fatal-handlers,post-mortem-redirect,logger}.ts`
- 手動再現: `scripts/test-crash-evidence.sh` (開発者ローカル前提、CI 化は別タスク)
- 参照: `docs/spec/00-project-overview.md` (観察可能性章) / `docs/spec/05-install-and-infrastructure.md` (`.team/` ファイル一覧)
