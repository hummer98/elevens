/**
 * post-mortem-redirect.ts (T013 — parent tee)
 *
 * cmdStart 冒頭の自己再 spawn ロジック。Bun runtime panic / Rust crate panic / libc abort
 * すら file に残すために、親プロセスが child の stderr を **tee** (file + TTY 両方流出) する
 * 設計。v0.8.0 の `detached:true` + 親即 exit 方式は TTY visibility regression を起こしたため
 * (v0.8.1 hotfix で env opt-in 化)、本実装で proper fix する。
 *
 *   親プロセス (TTY あり、flag 無し)
 *      ├─ rotate stderr.log → createWriteStream(append)
 *      ├─ spawn(self, args + FLAG, { stdio: [inherit, inherit, "pipe"], detached: false })
 *      ├─ atomic bind: child.stderr.on("data") / on("end") / child.on("exit")
 *      ├─ tee: data → logStream.write + process.stderr.write
 *      │       backpressure: logStream.write false → child.stderr.pause() / drain で resume
 *      ├─ signal: SIGINT/SIGTERM no-op listener で自殺抑止 (forward は **しない**)
 *      │           kernel pgroup broadcast で child 側 fatal-handlers が 1 回だけ発火する
 *      ├─ wait: child の exit を await
 *      └─ propagate: process.exit(child.exitCode ?? 128+signo)
 *
 *   子プロセス (flag あり) → no-op return → 通常 init を続行
 *   non-TTY 親 (CI / pipe) → no-op return → inline 起動 (post-mortem evidence は呼び出し元ログ任せ)
 *
 * 設計理由 (plan §architecture):
 *   - parent は signal を forward しない: fatal-handlers.ts:84-102 が dedup を持たない
 *     (`Promise.resolve(onShutdown(signal))` fire-and-forget) ため、parent forward + kernel
 *     broadcast の二重配送で `onShutdown` が 2 回起動するのを構造的に避ける
 *   - `detached:false` + parent foreground hold: process group を共有させ kernel broadcast に乗せる
 *   - `child_process.spawn` を維持 (Bun.spawn の Web Streams ではなく EventEmitter で書きたいため)
 *   - atomic bind invariant: spawn 戻り値受取りから 3 listener bind までは同期一連で完了させる
 */
import { existsSync, renameSync, unlinkSync, createWriteStream } from "fs";
import {
  spawn as realSpawn,
  type ChildProcess,
  type StdioOptions,
} from "child_process";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import * as os from "os";

export const POST_MORTEM_REDIRECTED_FLAG = "--__post-mortem-redirected";
export const STDERR_LOG_RELATIVE = ".team/logs/manager.stderr.log";

/**
 * tee parent が listen する signal (kernel pgroup broadcast を受けるが forward はしない)。
 * SIGHUP は **bind しない** — parent は default の terminate を許容し、child は
 * kernel broadcast で同じ SIGHUP を独立に受け取って fatal-handlers が処理する。
 */
const ABSORB_SIGNALS: Array<"SIGINT" | "SIGTERM"> = ["SIGINT", "SIGTERM"];

export interface MaybeRespawnOptions {
  projectRoot: string;
  args: string[];
  // 既存 DI
  isTTYImpl?: () => boolean;
  spawnImpl?: typeof realSpawn;
  exitImpl?: (code: number) => void;
  execPath?: string;
  scriptPath?: string;
  // 新規 DI (tee 用)
  /** logStream を作る factory (default: fs.createWriteStream(path, {flags:"a"})) */
  createWriteStreamImpl?: (path: string) => NodeJS.WritableStream;
  /** TTY 側への write (default: process.stderr.write bound)。同期 block 前提 (TTY のみ) */
  processStderrWriteImpl?: (chunk: Buffer | string) => boolean;
  /**
   * note: `signalsToForward` 等の signal 関連 DI は **意図的に存在しない**。
   * parent は SIGINT/SIGTERM を absorb (自殺抑止 no-op) するのみで、child へ
   * forward しない。kernel pgroup broadcast に委ねる設計のため (plan §architecture)。
   */
}

export interface MaybeRespawnResult {
  skipped: boolean;
  /**
   * "respawned" は廃止 (parent path は exit 前に return しない)。
   * "tee-completed" は実質呼出し元に届かない (exit 直前で resolve するだけ; test 用 hatch のみ)。
   */
  reason:
    | "already-redirected"
    | "non-tty"
    | "tee-completed"
    | "spawn-failed";
}

interface ResolvedOptions {
  isTTY: () => boolean;
  spawnImpl: typeof realSpawn;
  exitImpl: (code: number) => void;
  execPath: string;
  scriptPath: string;
  createWriteStreamImpl: (path: string) => NodeJS.WritableStream;
  processStderrWriteImpl: (chunk: Buffer | string) => boolean;
  waitForChildExit: boolean;
}

function resolveOptions(
  opts: MaybeRespawnOptions,
  internal: { waitForChildExit: boolean },
): ResolvedOptions {
  return {
    isTTY: opts.isTTYImpl ?? (() => Boolean(process.stderr.isTTY)),
    spawnImpl: opts.spawnImpl ?? realSpawn,
    exitImpl: opts.exitImpl ?? ((code: number) => process.exit(code)),
    execPath: opts.execPath ?? process.execPath,
    scriptPath: opts.scriptPath ?? process.argv[1] ?? "",
    createWriteStreamImpl:
      opts.createWriteStreamImpl ??
      ((path: string) => createWriteStream(path, { flags: "a" })),
    processStderrWriteImpl:
      opts.processStderrWriteImpl ??
      ((chunk: Buffer | string) => process.stderr.write(chunk as any)),
    waitForChildExit: internal.waitForChildExit,
  };
}

function rotateStderrLog(path: string): void {
  if (!existsSync(path)) return;
  const rotated = path + ".1";
  if (existsSync(rotated)) {
    try {
      unlinkSync(rotated);
    } catch {
      /* 上書き失敗は致命的でない */
    }
  }
  try {
    renameSync(path, rotated);
  } catch {
    /* rename 失敗時はそのまま上書き open に倒す */
  }
}

/**
 * signal 名 (string) を signal 番号に解決する。
 * `os.constants.signals` を一次ソースとし、見つからなければ POSIX 標準値で fallback。
 * (review n1 対応: process.binding internal API を回避)
 */
function signalNumber(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const fromOs = (os.constants.signals as Record<string, number | undefined>)[
    name
  ];
  if (typeof fromOs === "number") return fromOs;
  // POSIX fallback (Linux/Darwin)
  const fallback: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  return fallback[name];
}

/**
 * child の終了から親の exit code を導出する。
 *   - signal で死んだ → 128 + signo (shell 慣習)
 *   - exit code が数値 → そのまま
 *   - どちらも null → 1 (異常終了扱い)
 */
function deriveExitCode(code: number | null, signal: string | null): number {
  if (typeof code === "number") return code;
  if (signal) {
    const n = signalNumber(signal);
    if (typeof n === "number") return 128 + n;
  }
  return 1;
}

/**
 * test-only: `waitForChildExit: false` を指定すると spawn / atomic bind 直後に
 * resolve する。production code から呼ぶと parent path で exit が走らなくなるため
 * 別 export に分離 (plan §m1)。
 */
export async function __maybeRespawnWithStderrRedirectForTest(
  opts: MaybeRespawnOptions & {
    /** test 用: child 死亡を待たずに即 resolve するモード (default false = 待つ) */
    waitForChildExit?: boolean;
  },
): Promise<MaybeRespawnResult> {
  return runMaybeRespawn(opts, {
    waitForChildExit: opts.waitForChildExit ?? true,
  });
}

/**
 * 本番経路 — child 起動後は exit するまで return しない。
 */
export async function maybeRespawnWithStderrRedirect(
  opts: MaybeRespawnOptions,
): Promise<MaybeRespawnResult> {
  return runMaybeRespawn(opts, { waitForChildExit: true });
}

async function runMaybeRespawn(
  opts: MaybeRespawnOptions,
  internal: { waitForChildExit: boolean },
): Promise<MaybeRespawnResult> {
  const r = resolveOptions(opts, internal);

  // 子 (redirect 済み): 何もしない
  if (opts.args.includes(POST_MORTEM_REDIRECTED_FLAG)) {
    return { skipped: true, reason: "already-redirected" };
  }

  // TTY でなければ inline 起動 (CI / pipe 経路、post-mortem evidence は呼び出し元ログ任せ)
  if (!r.isTTY()) {
    return { skipped: true, reason: "non-tty" };
  }

  const stderrLogPath = join(opts.projectRoot, STDERR_LOG_RELATIVE);
  mkdirSync(dirname(stderrLogPath), { recursive: true });
  rotateStderrLog(stderrLogPath);
  const logStream = r.createWriteStreamImpl(stderrLogPath);

  // spawn (stdio: [inherit, inherit, "pipe"], detached: false)
  const stdio: StdioOptions = ["inherit", "inherit", "pipe"];
  const child: ChildProcess = r.spawnImpl(
    r.execPath,
    [r.scriptPath, ...opts.args, POST_MORTEM_REDIRECTED_FLAG],
    {
      stdio,
      detached: false,
      env: process.env,
      cwd: process.cwd(),
    },
  );

  // ATOMIC BIND INVARIANT (plan §M4):
  // spawn 戻り値受取りから data/end/exit の 3 listener bind までは同期一連。
  // ここに await / 別ロジックを挟むと初回 chunk / 早期 exit を取りこぼす。
  // ---- begin atomic bind ----
  if (!child.pid) {
    // spawn 失敗 — TTY と file の **両方** にエラーメッセージを書いて exit(1) (plan R8)
    const msg = `[cmux-team] post-mortem stderr redirect spawn failed: child.pid undefined\n`;
    try {
      r.processStderrWriteImpl(msg);
    } catch {
      /* TTY 書き失敗は無視 */
    }
    try {
      logStream.write(msg);
    } catch {
      /* file 書き失敗は無視 */
    }
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
    r.exitImpl(1);
    return { skipped: false, reason: "spawn-failed" };
  }

  const childStderr = child.stderr;
  let stderrEnded = false;

  if (childStderr) {
    childStderr.on("data", (chunk: Buffer | string) => {
      // tee: file + TTY
      const okToLog = logStream.write(chunk);
      try {
        r.processStderrWriteImpl(chunk);
      } catch {
        /* TTY visibility は best-effort (plan §backpressure note: m5) */
      }
      // backpressure: logStream が一時的に詰まったら child.stderr を pause し
      // drain event で resume する (plan §M2)
      if (!okToLog) {
        try {
          childStderr.pause();
        } catch {
          /* mock 経路で pause 不在の場合は無視 */
        }
        logStream.once("drain", () => {
          try {
            childStderr.resume();
          } catch {
            /* 同上 */
          }
        });
      }
    });
    childStderr.on("end", () => {
      stderrEnded = true;
    });
  }

  // SIGINT / SIGTERM を absorb (no-op listener で default の自殺挙動を抑止)
  // SIGHUP は bind しない (plan §architecture 線 70 / R5)。
  const absorbHandlers: Array<{
    signal: "SIGINT" | "SIGTERM";
    handler: () => void;
  }> = [];
  for (const sig of ABSORB_SIGNALS) {
    const handler = (): void => {
      /* no-op: kernel broadcast で child 側 fatal-handlers が処理する */
    };
    process.on(sig, handler);
    absorbHandlers.push({ signal: sig, handler });
  }

  // child の exit を待つ Promise を atomic bind 直後に生成
  const exitPromise = new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  // ---- end atomic bind ----

  if (!r.waitForChildExit) {
    // test-only hatch: spawn 直後に return (production 経路では到達しない)
    return { skipped: false, reason: "tee-completed" };
  }

  const { code, signal } = await exitPromise;

  // 残 chunk drain & logStream flush close
  try {
    if (childStderr && !stderrEnded) {
      // best-effort: stderr stream が data を残したまま close した場合に備え少し待つ
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        childStderr.once("end", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  } catch {
    /* ignore drain failures */
  }

  await new Promise<void>((resolve) => {
    try {
      logStream.end(() => resolve());
    } catch {
      resolve();
    }
  });

  // signal listener cleanup (test 環境のグローバル listener pollution を防ぐ)
  for (const { signal: sig, handler } of absorbHandlers) {
    process.removeListener(sig, handler);
  }

  r.exitImpl(deriveExitCode(code, signal));
  return { skipped: false, reason: "tee-completed" };
}
