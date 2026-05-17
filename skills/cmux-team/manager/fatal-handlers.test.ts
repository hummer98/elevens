/**
 * fatal-handlers.ts のテスト (T010 S2)
 *
 * uncaughtException / unhandledRejection / SIGTERM / SIGINT / SIGHUP の listener を集約管理する。
 * pidfile cleanup は installCrashHandler の 'exit' listener が担うため、本 handler は fatal trace の
 * sync ログ出力のみ責務として持つ（決定: plan §S2 / §2.2 / D7）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { installFatalHandlers } from "./fatal-handlers";

interface CapturedLog {
  level: "info" | "warn" | "error";
  event: string;
  detail: string;
}

let uninstall: (() => void) | null = null;
let logs: CapturedLog[];
let exitCalls: number[];

beforeEach(() => {
  logs = [];
  exitCalls = [];
});

afterEach(() => {
  if (uninstall) {
    uninstall();
    uninstall = null;
  }
});

function di() {
  return {
    logSyncImpl: (event: string, detail: string = "") => {
      logs.push({ level: "info", event, detail });
    },
    warnSyncImpl: (event: string, detail: string = "") => {
      logs.push({ level: "warn", event, detail });
    },
    errorSyncImpl: (event: string, detail: string = "") => {
      logs.push({ level: "error", event, detail });
    },
    exitImpl: (code: number) => {
      exitCalls.push(code);
    },
  };
}

describe("installFatalHandlers - uncaughtException", () => {
  test("fatal_uncaught + fatal_stack を sync で出してから exit(1) する", () => {
    uninstall = installFatalHandlers({ ...di() });
    const err = new Error("test-uncaught");
    process.emit("uncaughtException", err);
    const uncaught = logs.find((l) => l.event === "fatal_uncaught");
    const stack = logs.find((l) => l.event === "fatal_stack");
    expect(uncaught).toBeTruthy();
    expect(uncaught!.detail).toContain("test-uncaught");
    expect(stack).toBeTruthy();
    expect(stack!.level).toBe("error");
    expect(exitCalls).toEqual([1]);
  });
});

describe("installFatalHandlers - unhandledRejection", () => {
  test("fatal_unhandled_rejection + fatal_stack を sync で出してから exit(1) する", () => {
    uninstall = installFatalHandlers({ ...di() });
    const err = new Error("test-rejection");
    process.emit("unhandledRejection", err, Promise.resolve());
    const ev = logs.find((l) => l.event === "fatal_unhandled_rejection");
    const stack = logs.find((l) => l.event === "fatal_stack");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("test-rejection");
    expect(stack).toBeTruthy();
    expect(exitCalls).toEqual([1]);
  });

  test("非 Error の rejection 値でも throw せず exit(1) する", () => {
    uninstall = installFatalHandlers({ ...di() });
    process.emit("unhandledRejection", "string-reason" as any, Promise.resolve());
    const ev = logs.find((l) => l.event === "fatal_unhandled_rejection");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("string-reason");
    expect(exitCalls).toEqual([1]);
  });
});

describe("installFatalHandlers - signals", () => {
  test("SIGTERM 受信で signal_received signal=SIGTERM を sync 記録し onShutdown が SIGTERM で呼ばれる", async () => {
    const shutdowns: string[] = [];
    uninstall = installFatalHandlers({
      ...di(),
      onShutdown: async (signal) => {
        shutdowns.push(signal);
      },
    });
    process.emit("SIGTERM");
    // 1 tick 待つ
    await Promise.resolve();
    await Promise.resolve();
    const ev = logs.find((l) => l.event === "signal_received");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("signal=SIGTERM");
    expect(shutdowns).toEqual(["SIGTERM"]);
    // signal 経路では fatal-handlers が直接 exit を呼ばない（shutdown 側に委譲）
    expect(exitCalls).toEqual([]);
  });

  test("SIGINT 受信で signal_received signal=SIGINT を sync 記録し onShutdown が SIGINT で呼ばれる", async () => {
    const shutdowns: string[] = [];
    uninstall = installFatalHandlers({
      ...di(),
      onShutdown: async (signal) => {
        shutdowns.push(signal);
      },
    });
    process.emit("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    const ev = logs.find((l) => l.event === "signal_received");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("signal=SIGINT");
    expect(shutdowns).toEqual(["SIGINT"]);
  });

  test("SIGHUP 受信で signal_received signal=SIGHUP を sync 記録し onShutdown が SIGHUP で呼ばれる", async () => {
    const shutdowns: string[] = [];
    uninstall = installFatalHandlers({
      ...di(),
      onShutdown: async (signal) => {
        shutdowns.push(signal);
      },
    });
    process.emit("SIGHUP");
    await Promise.resolve();
    await Promise.resolve();
    const ev = logs.find((l) => l.event === "signal_received");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("signal=SIGHUP");
    expect(shutdowns).toEqual(["SIGHUP"]);
  });

  test("onShutdown が未指定でも signal_received は記録される（exit はしない）", async () => {
    uninstall = installFatalHandlers({ ...di() });
    process.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    const ev = logs.find((l) => l.event === "signal_received");
    expect(ev).toBeTruthy();
  });
});

describe("installFatalHandlers - uninstall", () => {
  test("uninstall すると後続 signal で onShutdown が呼ばれない", async () => {
    const shutdowns: string[] = [];
    uninstall = installFatalHandlers({
      ...di(),
      onShutdown: async (signal) => {
        shutdowns.push(signal);
      },
    });
    uninstall();
    uninstall = null;
    process.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdowns).toEqual([]);
  });

  test("uninstall すると後続 uncaughtException で exit が呼ばれない", () => {
    uninstall = installFatalHandlers({ ...di() });
    uninstall();
    uninstall = null;
    // uncaughtException emit は process が listener 0 件だとデフォルト動作で abort してしまうので、
    // ダミー listener を仕込んでから emit する。
    const noop = () => {};
    process.on("uncaughtException", noop);
    try {
      process.emit("uncaughtException", new Error("after-uninstall"));
    } finally {
      process.removeListener("uncaughtException", noop);
    }
    expect(exitCalls).toEqual([]);
  });
});
