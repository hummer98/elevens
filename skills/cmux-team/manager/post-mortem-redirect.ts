/**
 * post-mortem-redirect.ts (T010 S5)
 *
 * cmdStart 冒頭の自己再 spawn ロジック。Bun runtime panic / Rust crate panic / libc abort
 * すら file に残すために OS fd 2 を `.team/logs/manager.stderr.log` に redirect する。
 *
 * D1: 採用 (b) wrapper subcommand 方式
 *
 *   親プロセス (TTY あり) ─┐
 *                          ├─ rotate stderr.log → openSync(..., "a") → spawn(self, args + flag,
 *                          │   { stdio: ["inherit", "inherit", fd], detached: true })
 *                          └─ child.unref() → closeSync(parent fd) → exit(0)
 *
 *   子プロセス (flag あり / TTY 無し) → no-op return → 通常 init を続行
 *
 * 設計理由 (plan §2.3):
 *   - Bun の `process.dup2` 相当 API が無いため自プロセス内では OS fd 差替不可
 *   - `process.stderr.write` hook は Zig 層の panic を捕捉不可
 *   - reload 経路では `--__post-mortem-redirected` を args に常に付与する (S5.1)
 */
import { existsSync, renameSync, unlinkSync } from "fs";
import { openSync as realOpenSync, closeSync as realCloseSync } from "fs";
import { spawn as realSpawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

export const POST_MORTEM_REDIRECTED_FLAG = "--__post-mortem-redirected";
export const STDERR_LOG_RELATIVE = ".team/logs/manager.stderr.log";

export interface MaybeRespawnOptions {
  projectRoot: string;
  args: string[];
  // DI
  isTTYImpl?: () => boolean;
  spawnImpl?: typeof realSpawn;
  openSyncImpl?: (path: string, flag: string) => number;
  closeSyncImpl?: (fd: number) => void;
  exitImpl?: (code: number) => void;
  /** 子起動用 executable (default: process.execPath = bun) */
  execPath?: string;
  /** 子起動用 script (default: process.argv[1]) */
  scriptPath?: string;
}

export interface MaybeRespawnResult {
  skipped: boolean;
  reason: "already-redirected" | "non-tty" | "respawned" | "spawn-failed";
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

export async function maybeRespawnWithStderrRedirect(
  opts: MaybeRespawnOptions,
): Promise<MaybeRespawnResult> {
  const isTTY = opts.isTTYImpl ?? (() => Boolean(process.stderr.isTTY));
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const openSyncImpl = opts.openSyncImpl ?? realOpenSync;
  const closeSyncImpl = opts.closeSyncImpl ?? realCloseSync;
  const exitImpl = opts.exitImpl ?? ((code: number) => process.exit(code));
  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1] ?? "";

  // 子（redirect 済み）: 何もしない
  if (opts.args.includes(POST_MORTEM_REDIRECTED_FLAG)) {
    return { skipped: true, reason: "already-redirected" };
  }

  // TTY でないなら redirect skip (test / pipe 経路)
  if (!isTTY()) {
    return { skipped: true, reason: "non-tty" };
  }

  const stderrLogPath = join(opts.projectRoot, STDERR_LOG_RELATIVE);
  mkdirSync(dirname(stderrLogPath), { recursive: true });
  rotateStderrLog(stderrLogPath);
  const fd = openSyncImpl(stderrLogPath, "a");

  const child: ChildProcess = spawnImpl(
    execPath,
    [scriptPath, ...opts.args, POST_MORTEM_REDIRECTED_FLAG],
    {
      stdio: ["inherit", "inherit", fd] as any,
      detached: true,
      env: process.env,
      cwd: process.cwd(),
    },
  );

  if (!child.pid) {
    // spawn 失敗 — silent failure を避けるため fail-fast
    try {
      closeSyncImpl(fd);
    } catch {
      /* fd 閉じ失敗は無視 */
    }
    process.stderr.write(
      `[cmux-team] post-mortem stderr redirect spawn failed: child.pid undefined\n`,
    );
    exitImpl(1);
    return { skipped: false, reason: "spawn-failed" };
  }

  child.unref();
  try {
    closeSyncImpl(fd);
  } catch {
    /* 親側 fd 閉じ失敗は無視 */
  }
  exitImpl(0);
  return { skipped: false, reason: "respawned" };
}
