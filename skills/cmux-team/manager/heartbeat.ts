/**
 * heartbeat.ts (T010 S3)
 *
 * Manager daemon が「いつ最後に動いていたか」を外部 file で永続的に通知する。
 *
 *   - 10s 間隔で `.team/daemon.heartbeat` に **sync write** (`writeFileSync` で truncate 上書き)
 *   - clean exit (`stopHeartbeat({ cleanExit: true, reason })`) では reason を sync 記録 → unlink
 *   - 異常終了 (kill -9 / panic) では file 残存 → mtime が死亡時刻 ±10s を示す
 *
 * 観察箱の primary signal: file の存在 + mtime で daemon 死亡の WHEN を再構成できる
 * （観察者は file を読むだけで判定可能）。
 */
import { writeFileSync, unlinkSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";

export interface ConductorCounts {
  idle: number;
  running: number;
  disconnected: number;
  broken: number;
}

export interface HeartbeatState {
  pid: number;
  uptime_sec: number;
  open_tasks: number;
  conductors: ConductorCounts;
  rss_mb: number;
  heap_mb: number;
}

export interface StartHeartbeatOptions {
  path: string;
  intervalMs: number;
  getState: () => HeartbeatState;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface HeartbeatHandle {
  path: string;
  timer: ReturnType<typeof setInterval> | null;
  clear: typeof clearInterval;
  stopped: boolean;
}

function localISOString(): string {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}:${mm}`;
}

function writeOnce(path: string, getState: () => HeartbeatState): void {
  const state = getState();
  const payload = {
    ts: localISOString(),
    pid: state.pid,
    uptime_sec: state.uptime_sec,
    open_tasks: state.open_tasks,
    conductors: state.conductors,
    rss_mb: state.rss_mb,
    heap_mb: state.heap_mb,
  };
  mkdirSync(dirname(path), { recursive: true });
  // truncate 上書き (1 record しか保持しない; observer は mtime + content を見る)
  writeFileSync(path, JSON.stringify(payload) + "\n", "utf8");
}

export function startHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle & {
  uninstall: () => void;
} {
  const setIntv = opts.setIntervalImpl ?? setInterval;
  const clearIntv = opts.clearIntervalImpl ?? clearInterval;

  // 即時 1 回 write (daemon 起動の証拠を最速で残す)
  writeOnce(opts.path, opts.getState);

  const tick = (): void => {
    writeOnce(opts.path, opts.getState);
  };
  const timer = setIntv(tick, opts.intervalMs);

  const handle: HeartbeatHandle = {
    path: opts.path,
    timer,
    clear: clearIntv,
    stopped: false,
  };

  return {
    ...handle,
    uninstall: () => {
      if (handle.stopped) return;
      handle.stopped = true;
      if (handle.timer !== null) {
        clearIntv(handle.timer);
        handle.timer = null;
      }
    },
  };
}

export interface StopHeartbeatOptions {
  cleanExit: boolean;
  reason: string;
}

export function stopHeartbeat(
  handle: HeartbeatHandle,
  opts: StopHeartbeatOptions,
): void {
  if (handle.stopped) return;
  handle.stopped = true;
  if (handle.timer !== null) {
    handle.clear(handle.timer);
    handle.timer = null;
  }
  if (opts.cleanExit) {
    // 「clean exit: reason=<reason>」を sync 追記 → unlink
    try {
      appendFileSync(handle.path, `clean exit: reason=${opts.reason}\n`);
    } catch {
      // 既に消えていても問題なし
    }
    try {
      unlinkSync(handle.path);
    } catch {
      // ENOENT 等は無視 (file が既に削除されている)
    }
  }
  // cleanExit:false は異常終了の証拠として残す
}
