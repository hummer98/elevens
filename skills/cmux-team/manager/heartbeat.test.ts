/**
 * heartbeat.ts のテスト (T010 S3)
 *
 * - `.team/daemon.heartbeat` に 10s 間隔で sync write
 * - clean exit 時には reason を記録してから unlink
 * - kill -9 等の異常終了では file 残存（mtime が死亡時刻 ±10s を示す）
 *
 * Bun の fake timer は不安定なので setIntervalImpl / clearIntervalImpl を DI する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  startHeartbeat,
  stopHeartbeat,
  type HeartbeatState,
} from "./heartbeat";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let heartbeatPath: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-heartbeat-test-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  heartbeatPath = join(project.root, ".team/daemon.heartbeat");
});

afterEach(async () => {
  await project.dispose();
});

function makeState(): HeartbeatState {
  return {
    pid: 12345,
    uptime_sec: 100,
    open_tasks: 3,
    conductors: { idle: 2, running: 1, disconnected: 0, broken: 0 },
    rss_mb: 120,
    heap_mb: 64,
  };
}

describe("startHeartbeat", () => {
  test("即時 1 回 sync write される (interval 待たない)", () => {
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: makeState,
      setIntervalImpl: ((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return 42 as any;
      }) as any,
      clearIntervalImpl: () => {},
    });
    expect(existsSync(heartbeatPath)).toBe(true);
    const content = readFileSync(heartbeatPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(12345);
    expect(parsed.open_tasks).toBe(3);
    expect(parsed.conductors.idle).toBe(2);
    expect(typeof parsed.ts).toBe("string");
    expect(intervals.length).toBe(1);
    expect(intervals[0]!.ms).toBe(10_000);
    handle.uninstall();
  });

  test("interval で次回 tick が走り file が更新される", () => {
    let stateUptime = 100;
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: () => ({
        pid: 12345,
        uptime_sec: stateUptime,
        open_tasks: 0,
        conductors: { idle: 0, running: 0, disconnected: 0, broken: 0 },
        rss_mb: 1,
        heap_mb: 1,
      }),
      setIntervalImpl: ((fn: any, _ms: number) => {
        // 直後に手動で 1 回呼んで「次回 tick」をシミュレート
        stateUptime = 200;
        fn();
        return 0 as any;
      }) as any,
      clearIntervalImpl: () => {},
    });
    const content = readFileSync(heartbeatPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.uptime_sec).toBe(200);
    handle.uninstall();
  });
});

describe("stopHeartbeat", () => {
  test("cleanExit:false なら file 残存（異常終了の証拠扱い）", () => {
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: makeState,
      setIntervalImpl: (() => 0 as any) as any,
      clearIntervalImpl: () => {},
    });
    stopHeartbeat(handle, { cleanExit: false, reason: "kill-9" });
    expect(existsSync(heartbeatPath)).toBe(true);
  });

  test("cleanExit:true なら reason を sync 記録してから unlink される", () => {
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: makeState,
      setIntervalImpl: (() => 0 as any) as any,
      clearIntervalImpl: () => {},
    });
    expect(existsSync(heartbeatPath)).toBe(true);
    stopHeartbeat(handle, { cleanExit: true, reason: "SIGTERM" });
    // unlink 後なので不在
    expect(existsSync(heartbeatPath)).toBe(false);
  });

  test("clearInterval が呼ばれる", () => {
    const cleared: any[] = [];
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: makeState,
      setIntervalImpl: (() => 777 as any) as any,
      clearIntervalImpl: ((id: any) => cleared.push(id)) as any,
    });
    stopHeartbeat(handle, { cleanExit: true, reason: "stop" });
    expect(cleared).toEqual([777]);
  });

  test("stop 後の二重 stop は no-op (例外を投げない)", () => {
    const handle = startHeartbeat({
      path: heartbeatPath,
      intervalMs: 10_000,
      getState: makeState,
      setIntervalImpl: (() => 0 as any) as any,
      clearIntervalImpl: () => {},
    });
    stopHeartbeat(handle, { cleanExit: true, reason: "first" });
    expect(() =>
      stopHeartbeat(handle, { cleanExit: true, reason: "second" }),
    ).not.toThrow();
  });
});
