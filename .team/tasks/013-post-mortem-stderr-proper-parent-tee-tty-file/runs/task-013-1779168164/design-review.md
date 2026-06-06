# T013 Design Review (round 2)

## Verdict
**Approved**

## Summary

round 1 で指摘した critical / major 7 件と minor 5 件は、いずれも plan の §architecture / §状態モデル / §公開 API 変更 / §TDD / §リスクと対策 / §変更ファイル一覧 にわたり構造的に反映されました。とくに C1 (SIGINT 二重発火) と C2 (SIGHUP 矛盾) は「parent は signal を forward せず process group broadcast に委ねる」という設計上の選択へ転換され、`signalsToForward` DI を **廃止** することで `fatal-handlers.ts` の dedup 不在問題を構造的に閉じています。R5 / R10 / 補遺の整合、`detached: true` を捨てる根拠、Mermaid 3 図 (component / state machine / signal sequence) の書き直し、test #4 / #5 / #10 / #11 の追加、spec §5.1 新設 + §5 (a) の TTY-only 補足、`__maybeRespawnWithStderrRedirectForTest` 分離まで漏れなく入っており、P1 着手の前提は揃っています。残った懸念はすべて実装時の運用 / 計測レベル (minor) で、blocker はありません。

## Resolved (round 1 concerns)

- **[C1] parent forward と process group broadcast の二重配送** → §採用方針 (plan §architecture, line 38–87) で「parent は signal を forward しない」と明文化。`signalsToForward` DI は §公開 API 変更 (line 263, 276) で廃止確定、JSDoc に設計上の理由を残す方針も明記。state machine 図 (line 168–189) と sequence 図 (line 193–208) が「listener は no-op、kernel pgroup broadcast で child 側に 1 回だけ届く」前提で書き直されている。unit test #4 / #5 (line 319–321) で `child.kill` mock が呼ばれないことを assert する方向に転換。`fatal-handlers.ts:84–102` の dedup 不在は実装ファイルでも再確認済み (`process.on(signal, handler)` + fire-and-forget `Promise.resolve(onShutdown(signal))` の構造を確認)。**構造的に解決**。

- **[C2] SIGHUP の扱いが plan 内で矛盾** → SIGHUP は parent listener を **bind しない** 方針 (line 70, 216) で R5 (line 369) と一致。default forward list 自体が消えたので「default に SIGHUP を含むかどうか」という矛盾点が API 表面から消滅。test #5 (line 320) で `process.listenerCount("SIGHUP")` が helper bind 前後で増えないことを assert する。

- **[M1] `child_process.spawn` か `Bun.spawn` か** → §architecture §API 選択 (line 30–36) で「`import { spawn } from "child_process"` を継続使用」と明文化。理由 (Web Streams ではなく `EventEmitter` で書きたい / 既存 `post-mortem-redirect.ts:23` と `reload.ts:21` がすでに `child_process` を使っている) も併記。R6 (line 370) の表現も「`child_process.spawn` を Bun ランタイム上で動かしたときの挙動差」に直されている。

- **[M2] backpressure 制御** → §backpressure dispatcher 擬似コード (line 88–107) として `child.stderr.pause()` + `logStream.once("drain", () => child.stderr.resume())` を明示。新規 unit test #10 (line 325) で pause/resume の呼出し順序を assert する。`pipeline + Writable` で完全 stream 統合する別解は note (line 107) で見送り根拠が記され、follow-up 余地も残されている。

- **[M3] reload 経路の TUI feedback 責務** → §変更ファイル一覧 (line 227) で spec §5.1 新設方針が明記。reload 失敗時に (i) `logger.log` (info / warn / error)、(ii) `.team/daemon.heartbeat` mtime 停止、(iii) `.team/logs/events.jsonl` の `reload_failed` event の **3 経路** で Master / TUI が検知する旨が plan 内に書かれ、P4 done 定義 (line 351) でも「実装で担保」と紐付いている。Acceptance Criteria 対応表 (line 388) でも M3 反映済みと明示。

- **[M4] atomic bind invariant** → P2 done 定義 (line 349) に「(ii) atomic bind invariant が code review で確認できる構造 (spawn 戻り値受取り → 3 listener bind の間に await / 関数境界 / 別ロジックが無い)」が追加。§補遺 (line 396) でも明示的に invariant として記録。new unit test #11 (line 326) で `child.stderr.on("data")` / `on("end")` / `on("exit")` の 3 listener が同一 tick 内に bind されることを assert。

- **[m1] test-only hatch の分離** → §公開 API 変更 §m1 (line 278–280) で `__maybeRespawnWithStderrRedirectForTest` 等として **別 export に切り出す** ことを採用。production code から誤って呼ぶと type-level で検出可能。

- **[m2] non-TTY (systemd / nohup) の post-mortem evidence** → §非ゴール (line 22) と §変更ファイル一覧 (line 227) で spec §5 (a) に「`elevens start` を TTY 親プロセスから起動した場合のみ」と明記する方針が確定。R10 (line 374) で新規リスクとして可視化、spec §9 D5 (launchd plist 別タスク) と整合。

- **[m3] backpressure unit test の追加** → 新規 unit test #10 (line 325) として追加済み。

- **[m4] P2 の done 定義は TDD 順序として弱い** → plan (line 359) で「現状維持」と明示的判断を記録、reviewer の blocker 扱いではない旨も併記。`1 commit 1 phase` 原則との trade-off が言語化された。

- **[m5] `processStderrWriteImpl` の戻り値処理** → §backpressure dispatcher 擬似コード (line 92–97) で「`process.stderr` は TTY 前提のため同期書き込み。pipe 経路は non-TTY inline path で弾かれているのでこの分岐に来ない」と明示。万一 false が返っても fail-fast せず drop する方針 (`void okToTty`) も明記。

- **Acceptance Criterion 4 評価「不十分」** → C1 / C2 解決により対応表 (line 383) で「OK (C1 / C2 解決済み)」に格上げ。ゴール文 (line 13) にも「**かつ shutdown は 1 回しか走らない**」が追記され、評価軸がコードに反映される設計に。

## Outstanding Concerns

### Critical
None

### Major
None

### Minor

- **n1 (新規, plan の精緻化)**: signal 由来 exit code の lookup table が plan 内に table 化されていない。`signal ? 128 + signalNo : 1` の signalNo について SIGINT=2 / SIGTERM=15 / SIGHUP=1 の mapping は test #3 (line 318) で「130」と書かれているのみ。実装時に Node の `os.constants.signals` を引くか、自前の小さな record で持つかは P2 の判断範囲。blocker ではない。

- **n2 (新規, test の堅牢性)**: test #5 (line 320) で `process.listenerCount("SIGHUP")` の **差分** ではなく絶対値を見ると、test runner / `installFatalHandlers` 経路が SIGHUP listener を bind しているケースで誤判定する可能性。実装時に「helper bind 前の count を beforeEach で snapshot し、bind 後との差分が 0 であること」を assert する微修正で安全に書ける。

- **n3 (新規, TTY 切断時の edge)**: parent が SIGHUP の default action (terminate) を許容する設計 (line 216) の場合、TTY 切断時に親が一足先に exit すると Acceptance Criterion 5「親プロセスは child の exit code を継承する」が成立しなくなる edge case が残る。これは shell prompt が既に消えた後のシナリオで user は exit code を観測しないため、plan は許容範囲としている (R5)。リリース後に該当 incident が観測されたら follow-up で SIGHUP も「自殺抑止 + 親も待機」に倒す余地あり。

## New Concerns (round 2 で新たに発見)

- 上記 n1 / n2 / n3 のみ、いずれも Minor。

## Recommendations

Approved につき、P1 → P8 に進んで問題なし。実装時の **軽い注意点** を 3 点だけ記しておきます。

1. **n1 の signal 番号 mapping**: P3 で test #3 (line 318) を実装するときに、`exitImpl` が `128 + signo` を計算する箇所で signal 名→番号の lookup を helper 内に置く。`process.binding("constants").os.signals` は internal API なので避け、`os.constants.signals.SIGINT` 等を使う。SIGINT=2 / SIGTERM=15 / SIGHUP=1 (Linux/Darwin) を直書きでも実害は無い (POSIX 標準)。
2. **n2 の SIGHUP listener カウント assert**: test #5 を書くときに「`process.removeAllListeners('SIGHUP')` で beforeEach に baseline を作る」「helper 内で `signal-listener-handle` を返して afterEach で removeListener する」のいずれかで listener pollution を防ぐ。plan §test の落とし穴 (line 339–340) で SIGINT 側は対応済みだが、SIGHUP も同じ扱いに揃えるとよい。
3. **P4 reload の `[inherit, inherit, fd]` 切替**: reload child の stderr.log open 経路 (P4) でも、最初の `elevens start` で rotate された世代を **再 rotate しない** (R4 line 368)。reload 経路の helper では append のみで、世代退避は親 tee path に閉じる。これは R4 で書かれているが、実装時に「reload helper は rotate を呼ばない」ことを assertion で明示すると future regression を防げる。

C1 / C2 / M1 / M2 / M3 / M4 / m1 / m2 / m3 / m5 が plan 全層 (architecture / state model / API / TDD / risks / spec sync) に整合的に展開されており、再 review 時に確認した範囲では新たな構造的瑕疵は見当たりません。
