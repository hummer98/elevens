/**
 * T423 S1 / T013 P4: daemon reload (TUI 'r' 起動経路) を `spawn + unref + 親即時 exit` に置換する helper。
 *
 * 旧実装 (`main.ts:931-945`) は `execFileSync("bun", ...)` で子 daemon が終了
 * するまで親をブロックしていた。子 daemon でさらに 'r' が押されると親も子も
 * `execFileSync` で待機 → reload chain で `bun` ランタイム (1.2GB RSS) が累積
 * → 24h で 27GB 浪費という事故を発生させていた。
 *
 * 本 helper は:
 *   1. 親が pidfile を release し
 *   2. stderr.log を append open して fd を取得
 *   3. `spawn(... { detached: true, stdio: ["inherit", "inherit", fd] })` で子を起動
 *   4. 親側で fd を close (child 側で dup された fd は保持される)
 *   5. `child.unref()` で event loop の参照を切り
 *   6. 親自身は `process.exit(0)` で即座に解放
 * という流れで、親のリソースを保持せずに reload する。
 *
 * stderr fd 注入 (T013 P4 / R4):
 *   親 (TTY tee) が exit すると reload 子の stderr 継承先 (pipe) が壊れ SIGPIPE で
 *   死ぬため、reload では stderr.log を直接 open して child に dup させる。rotate は
 *   行わず append のみ (最初の `elevens start` で rotate された世代を再 rotate しない)。
 *
 * 失敗通知 (T013 M3, spec §5.1):
 *   reload 失敗時は (i) logger.log、(ii) heartbeat mtime 停止 (daemon が exit するため
 *   構造的に発生)、(iii) events.jsonl `reload_failed` event の 3 経路で Master / TUI が
 *   検知する。child_pid_undefined / stderr_log_open_failed / spawn_threw のいずれも emit。
 *
 * direnv 注記: `env: process.env` で親の direnv ロード済み環境変数を継承する。
 * reload 経路では direnv の再 allow check は走らないが、`cmdStart` 内の
 * `checkDirenvAllowed` は子側で再度実行されるため、direnv 制約に違反する状態で
 * reload しても子側で fail-stop する。
 */
import { spawn as realSpawn, type ChildProcess } from "child_process";
import {
  openSync as realOpenSync,
  closeSync as realCloseSync,
  mkdirSync,
} from "fs";
import { resolve, join, dirname } from "path";
import { releasePidFile as realReleasePidFile } from "./pidfile";
import { log as realLog } from "./logger";
import {
  POST_MORTEM_REDIRECTED_FLAG,
  STDERR_LOG_RELATIVE,
} from "./post-mortem-redirect";
import {
  emitEvent as realEmitEvent,
  type EventStreamRecord,
} from "./events-writer";

export interface PerformDaemonReloadOptions {
  pidFilePath: string;
  latestMainTs: string;
  /** stderr.log を解決する project root。省略時は PROJECT_ROOT env / cwd fallback */
  projectRoot?: string;
  // DI（テスト用）
  spawnImpl?: typeof realSpawn;
  releaseImpl?: (path: string) => Promise<void>;
  exitImpl?: (code: number) => void;
  logImpl?: (event: string, detail: string) => Promise<void>;
  openSyncImpl?: (path: string, flags: string) => number;
  closeSyncImpl?: (fd: number) => void;
  emitEventImpl?: (record: EventStreamRecord) => Promise<void>;
}

function resolveProjectRoot(explicit: string | undefined): string {
  return explicit ?? process.env.PROJECT_ROOT ?? process.cwd();
}

export async function performDaemonReload(
  opts: PerformDaemonReloadOptions,
): Promise<void> {
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const releaseImpl = opts.releaseImpl ?? realReleasePidFile;
  const exitImpl = opts.exitImpl ?? ((code: number) => process.exit(code));
  const logImpl = opts.logImpl ?? realLog;
  const openSyncImpl = opts.openSyncImpl ?? realOpenSync;
  const closeSyncImpl = opts.closeSyncImpl ?? realCloseSync;
  const emitEventImpl = opts.emitEventImpl ?? realEmitEvent;

  // 子 daemon が acquire できるよう親は spawn より前に pidfile を release する。
  // releasePidFile は ENOENT を握り潰し、それ以外も `await log(...)` で吸収して return する
  // 設計のため throw しない契約（pidfile.ts:141-148）。本 helper はこの invariant に依存。
  await releaseImpl(opts.pidFilePath);

  // findLatestMainTs は通常絶対パスを返す（npm prefix / process.cwd() / argv[1]）が、
  // spawn が cwd 依存になるのを防ぐため念のため resolve() で正規化する。
  const absoluteMainTs = resolve(opts.latestMainTs);

  // stderr fd 注入 (R4): rotate は行わず append のみ。最初の `elevens start` で rotate
  // 済みの世代は再 rotate しない (`post-mortem-redirect.ts:rotateStderrLog` 経路に閉じる)。
  const projectRoot = resolveProjectRoot(opts.projectRoot);
  const stderrLogPath = join(projectRoot, STDERR_LOG_RELATIVE);
  let stderrFd: number;
  try {
    mkdirSync(dirname(stderrLogPath), { recursive: true });
    stderrFd = openSyncImpl(stderrLogPath, "a");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const reason = err?.code ? `code=${err.code}` : `message=${err?.message ?? String(e)}`;
    const detail = `path=${stderrLogPath} ${reason}`;
    await logImpl("daemon_reload_stderr_log_open_failed", detail);
    try {
      await emitEventImpl({
        event: "reload_failed",
        reason: "stderr_log_open_failed",
        detail,
      });
    } catch {
      /* events.jsonl 失敗は best-effort */
    }
    exitImpl(1);
    return;
  }

  // detached: true で別プロセスグループにする。stdio[2]=fd で stderr を file に dup。
  // stdio[0]/[1]=inherit で stdin/stdout は親 (= TTY tee parent) から継承するが、tee parent
  // 自身は reload 後に exit するため、子は実質 stdout のみ TTY と接続される (R10)。
  // IPC channel は無いので disconnect() は no-op になる → 呼ばない。
  //
  // T010 S5.1: reload した子も親と同じ stderr.log を共有するため、redirect 済み扱いとして
  // 起動する。flag を付けないと子の cmdStart で maybeRespawnWithStderrRedirect が再度
  // 子を spawn してしまい 2 段重ねになる。
  let child: ChildProcess;
  try {
    child = spawnImpl(
      "bun",
      ["run", absoluteMainTs, "start", POST_MORTEM_REDIRECTED_FLAG],
      {
        stdio: ["inherit", "inherit", stderrFd],
        env: process.env,
        cwd: process.cwd(),
        detached: true,
      },
    );
  } catch (e) {
    // spawn 自体が throw する (例: SDK バグ / リソース不足) ケース。
    // 親側 fd は close してから fail 通知して exit する。
    try {
      closeSyncImpl(stderrFd);
    } catch {
      /* fd close 失敗は無視 */
    }
    const err = e as NodeJS.ErrnoException;
    const reason = err?.code ? `code=${err.code}` : `message=${err?.message ?? String(e)}`;
    const detail = `cmd=bun args=${absoluteMainTs} ${reason}`;
    await logImpl("daemon_reload_spawn_threw", detail);
    try {
      await emitEventImpl({
        event: "reload_failed",
        reason: "spawn_threw",
        detail,
      });
    } catch {
      /* events.jsonl 失敗は best-effort */
    }
    exitImpl(1);
    return;
  }

  // 親側で fd を close する (child 側は dup 済みで保持されている)。
  // 早期 close により fd leak / GC 依存を避ける。
  try {
    closeSyncImpl(stderrFd);
  } catch {
    /* fd close 失敗は無視 (leak しても daemon は exit 直前なので影響なし) */
  }

  // T425 minor #2: spawn 直後 sync で child.pid が undefined の場合は spawn 失敗
  // （bun 不在 ENOENT 等）。silent failure を回避するため exit(1) で early return する。
  // child.on("error") + setImmediate で errno を取る案は親即時 exit の不変条件
  // (T423 S1 reload chain 防止) を弱めるため採用しない（plan.md §2.3 参照）。
  if (!child.pid) {
    const detail = `cmd=bun args=${absoluteMainTs} reason=child_pid_undefined`;
    await logImpl("daemon_reload_spawn_failed", detail);
    try {
      await emitEventImpl({
        event: "reload_failed",
        reason: "child_pid_undefined",
        detail,
      });
    } catch {
      /* events.jsonl 失敗は best-effort */
    }
    exitImpl(1);
    return;
  }

  // spawn 直後・親 exit 前にログを flush して TTY ハンドオーバー前にログを残す。
  await logImpl(
    "daemon_reload_spawned",
    `child_pid=${child.pid} latestMainTs=${absoluteMainTs}`,
  );

  // 親の event loop 参照を切る → 子が detached で生き続けても親はすぐ exit できる。
  child.unref();

  exitImpl(0);
}
