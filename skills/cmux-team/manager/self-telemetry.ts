/**
 * self-telemetry.ts (T010 S4)
 *
 * 30s 間隔で daemon の内部状態を JSONL append し、死亡直前の trajectory を残す。
 *
 *   - `.team/logs/manager.telemetry.jsonl` に 1 行 = 1 sample
 *   - size base rotation: 既存 file が maxBytes を超えていたら append 前に `.1` へ rename
 *     （`.1` がすでに存在すれば上書き = 1 世代保持）
 *
 * 観察箱の retrospective signal: heap が単調増 → leak、burst → 別系統。
 */
import {
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";

export interface TelemetrySample {
  pid: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  event_loop_lag_ms: number;
  open_tasks: number;
  open_conductors: number;
  open_agents: number;
  uptime_sec: number;
}

export interface StartSelfTelemetryOptions {
  path: string;
  intervalMs: number;
  maxBytes: number;
  getSample: () => TelemetrySample;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface SelfTelemetryHandle {
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

function rotateIfNeeded(path: string, maxBytes: number): void {
  try {
    const st = statSync(path);
    if (st.size <= maxBytes) return;
  } catch {
    return; // file 無ければ rotate 不要
  }
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
    /* rename 失敗時は append に倒す */
  }
}

function appendOne(
  path: string,
  maxBytes: number,
  getSample: () => TelemetrySample,
): void {
  mkdirSync(dirname(path), { recursive: true });
  rotateIfNeeded(path, maxBytes);
  const sample = getSample();
  const payload = {
    ts: localISOString(),
    ...sample,
  };
  appendFileSync(path, JSON.stringify(payload) + "\n");
}

export function startSelfTelemetry(
  opts: StartSelfTelemetryOptions,
): SelfTelemetryHandle {
  const setIntv = opts.setIntervalImpl ?? setInterval;
  const clearIntv = opts.clearIntervalImpl ?? clearInterval;

  appendOne(opts.path, opts.maxBytes, opts.getSample);

  const tick = (): void => {
    appendOne(opts.path, opts.maxBytes, opts.getSample);
  };
  const timer = setIntv(tick, opts.intervalMs);

  return {
    timer,
    clear: clearIntv,
    stopped: false,
  };
}

export function stopSelfTelemetry(handle: SelfTelemetryHandle): void {
  if (handle.stopped) return;
  handle.stopped = true;
  if (handle.timer !== null) {
    handle.clear(handle.timer);
    handle.timer = null;
  }
}

/**
 * 標準 sampler: process.memoryUsage / uptime を読んでサンプル化。
 * event loop lag は呼び出し側で計測した値を受け取る（持続的な setImmediate 測定が必要）。
 */
export function measureBasicSample(args: {
  open_tasks: number;
  open_conductors: number;
  open_agents: number;
  event_loop_lag_ms: number;
}): TelemetrySample {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    external_mb: Math.round(mem.external / 1024 / 1024),
    event_loop_lag_ms: args.event_loop_lag_ms,
    open_tasks: args.open_tasks,
    open_conductors: args.open_conductors,
    open_agents: args.open_agents,
    uptime_sec: Math.round(process.uptime()),
  };
}

/**
 * Event loop lag を持続測定する helper。
 * setImmediate で 1 tick 計測 → 期待 0ms との差分を保持。
 *
 * @returns { read, stop } — `read()` で最新の lag を ms 単位で取得、`stop()` で測定停止
 */
export function startEventLoopLagMeter(): {
  read: () => number;
  stop: () => void;
} {
  let lastLagMs = 0;
  let stopped = false;
  const measure = (): void => {
    if (stopped) return;
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      lastLagMs = elapsedNs / 1_000_000;
      measure();
    });
  };
  measure();
  return {
    read: () => Math.round(lastLagMs * 100) / 100,
    stop: () => {
      stopped = true;
    },
  };
}
