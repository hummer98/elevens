/**
 * self-telemetry.ts のテスト (T010 S4)
 *
 * 30s 間隔で `.team/logs/manager.telemetry.jsonl` に append、size base で .1 へ rotate。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import {
  startSelfTelemetry,
  stopSelfTelemetry,
  type TelemetrySample,
} from "./self-telemetry";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let telemetryPath: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-telemetry-test-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  telemetryPath = join(project.root, ".team/logs/manager.telemetry.jsonl");
});

afterEach(async () => {
  await project.dispose();
});

function makeSample(over: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    pid: 12345,
    rss_mb: 100,
    heap_used_mb: 50,
    heap_total_mb: 80,
    external_mb: 2,
    event_loop_lag_ms: 1,
    open_tasks: 0,
    open_conductors: 0,
    open_agents: 0,
    uptime_sec: 100,
    ...over,
  };
}

describe("startSelfTelemetry", () => {
  test("即時 1 回 append される", () => {
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const handle = startSelfTelemetry({
      path: telemetryPath,
      intervalMs: 30_000,
      maxBytes: 5_242_880,
      getSample: () => makeSample(),
      setIntervalImpl: ((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return 1 as any;
      }) as any,
      clearIntervalImpl: () => {},
    });
    expect(existsSync(telemetryPath)).toBe(true);
    const content = readFileSync(telemetryPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.pid).toBe(12345);
    expect(parsed.rss_mb).toBe(100);
    expect(typeof parsed.ts).toBe("string");
    expect(intervals[0]!.ms).toBe(30_000);
    stopSelfTelemetry(handle);
  });

  test("interval tick で 行が追加される (JSONL)", () => {
    let counter = 0;
    const handle = startSelfTelemetry({
      path: telemetryPath,
      intervalMs: 30_000,
      maxBytes: 5_242_880,
      getSample: () => makeSample({ uptime_sec: ++counter * 10 }),
      setIntervalImpl: ((fn: any) => {
        fn();
        fn();
        return 1 as any;
      }) as any,
      clearIntervalImpl: () => {},
    });
    const content = readFileSync(telemetryPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3); // immediate + 2 tick
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    stopSelfTelemetry(handle);
  });
});

describe("self-telemetry rotation", () => {
  test("既存 file size > maxBytes なら .1 に rename され新 file に append される", () => {
    // 既存 file を maxBytes 超過に膨らませる
    mkdirSync(dirname(telemetryPath), { recursive: true });
    const bigPayload = "x".repeat(200);
    writeFileSync(telemetryPath, bigPayload, "utf8");

    const handle = startSelfTelemetry({
      path: telemetryPath,
      intervalMs: 30_000,
      maxBytes: 100, // 既存 200 > 100 → rotate 発火
      getSample: () => makeSample(),
      setIntervalImpl: (() => 1 as any) as any,
      clearIntervalImpl: () => {},
    });

    // .1 が生成され、元 path には新 1 行
    expect(existsSync(telemetryPath + ".1")).toBe(true);
    const rotated = readFileSync(telemetryPath + ".1", "utf-8");
    expect(rotated).toContain(bigPayload);

    const current = readFileSync(telemetryPath, "utf-8");
    const lines = current.trim().split("\n");
    expect(lines.length).toBe(1);
    JSON.parse(lines[0]!);
    stopSelfTelemetry(handle);
  });

  test("既存 file size <= maxBytes なら rotate しない", () => {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    writeFileSync(telemetryPath, "small\n", "utf8");

    const handle = startSelfTelemetry({
      path: telemetryPath,
      intervalMs: 30_000,
      maxBytes: 1_000_000,
      getSample: () => makeSample(),
      setIntervalImpl: (() => 1 as any) as any,
      clearIntervalImpl: () => {},
    });

    expect(existsSync(telemetryPath + ".1")).toBe(false);
    const content = readFileSync(telemetryPath, "utf-8");
    expect(content).toContain("small\n");
    // 即時 1 行 append されている
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    stopSelfTelemetry(handle);
  });
});

describe("stopSelfTelemetry", () => {
  test("clearInterval が呼ばれ stopped フラグが立つ", () => {
    const cleared: any[] = [];
    const handle = startSelfTelemetry({
      path: telemetryPath,
      intervalMs: 30_000,
      maxBytes: 5_242_880,
      getSample: () => makeSample(),
      setIntervalImpl: (() => 99 as any) as any,
      clearIntervalImpl: ((id: any) => cleared.push(id)) as any,
    });
    stopSelfTelemetry(handle);
    expect(cleared).toEqual([99]);
    // 二重 stop は no-op
    expect(() => stopSelfTelemetry(handle)).not.toThrow();
  });
});
