/**
 * reload.ts (T423 S1 / T013 P4) — daemon reload helper のテスト
 *
 * 全 DI で外部副作用を捕えてシーケンスと spawn options を検証する。
 * T013 P4 で追加された stderr fd 注入 / reload_failed event 通知も網羅。
 */
import { describe, test, expect } from "bun:test";
import type { ChildProcess } from "child_process";
import { join } from "path";
import { performDaemonReload } from "./reload";
import {
  POST_MORTEM_REDIRECTED_FLAG,
  STDERR_LOG_RELATIVE,
} from "./post-mortem-redirect";
import type { EventStreamRecord } from "./events-writer";

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

interface ReloadHarness {
  pidFilePath: string;
  latestMainTs: string;
  projectRoot: string;
  events: string[];
  spawnCalls: SpawnCall[];
  releaseCalls: string[];
  exitCalls: number[];
  logs: Array<{ event: string; detail: string }>;
  emittedEvents: EventStreamRecord[];
  openSyncCalls: Array<{ path: string; flags: string }>;
  closeSyncCalls: number[];
  unrefCount: number;
}

type HarnessOverrides = {
  spawnPidUndefined?: boolean;
  releaseImpl?: (path: string) => Promise<void>;
  openSyncThrows?: NodeJS.ErrnoException;
  spawnThrows?: NodeJS.ErrnoException;
  fakeFd?: number;
};

const FAKE_FD_DEFAULT = 7;

const makeHarness = (
  overrides: HarnessOverrides = {},
): ReloadHarness & { run: () => Promise<void> } => {
  const harness: ReloadHarness & { run: () => Promise<void> } = {
    pidFilePath: "/tmp/test/.team/daemon.pid",
    latestMainTs: "/tmp/test/skills/cmux-team/manager/main.ts",
    projectRoot: "/tmp/test",
    events: [],
    spawnCalls: [],
    releaseCalls: [],
    exitCalls: [],
    logs: [],
    emittedEvents: [],
    openSyncCalls: [],
    closeSyncCalls: [],
    unrefCount: 0,
    run: async () => {},
  };

  const fakeFd = overrides.fakeFd ?? FAKE_FD_DEFAULT;

  harness.run = (): Promise<void> =>
    performDaemonReload({
      pidFilePath: harness.pidFilePath,
      latestMainTs: harness.latestMainTs,
      projectRoot: harness.projectRoot,
      releaseImpl:
        overrides.releaseImpl ??
        (async (path) => {
          harness.releaseCalls.push(path);
          harness.events.push("release");
        }),
      openSyncImpl: (path: string, flags: string) => {
        harness.openSyncCalls.push({ path, flags });
        harness.events.push("open");
        if (overrides.openSyncThrows) throw overrides.openSyncThrows;
        return fakeFd;
      },
      closeSyncImpl: (fd: number) => {
        harness.closeSyncCalls.push(fd);
        harness.events.push(`close:${fd}`);
      },
      spawnImpl: ((cmd: string, args: readonly string[], options: any) => {
        harness.spawnCalls.push({ cmd, args, options });
        harness.events.push("spawn");
        if (overrides.spawnThrows) throw overrides.spawnThrows;
        return {
          pid: overrides.spawnPidUndefined ? undefined : 99999,
          unref: () => {
            harness.unrefCount++;
            harness.events.push("unref");
          },
        } as unknown as ChildProcess;
      }) as any,
      exitImpl: (code) => {
        harness.exitCalls.push(code);
        harness.events.push(`exit:${code}`);
      },
      logImpl: async (event, detail) => {
        harness.logs.push({ event, detail });
        harness.events.push(`log:${event}`);
      },
      emitEventImpl: async (record) => {
        harness.emittedEvents.push(record);
        harness.events.push(`emit:${record.event}`);
      },
    });

  return harness;
};

describe("performDaemonReload — happy path", () => {
  test("release → open → spawn → close → log → unref → exit(0) の順で実行される", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.events).toEqual([
      "release",
      "open",
      "spawn",
      `close:${FAKE_FD_DEFAULT}`,
      "log:daemon_reload_spawned",
      "unref",
      `exit:0`,
    ]);
  });

  test("release は pidFilePath で 1 回だけ呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.releaseCalls).toEqual([h.pidFilePath]);
  });

  test("openSync は stderr.log を append mode で 1 回だけ open する", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.openSyncCalls.length).toBe(1);
    expect(h.openSyncCalls[0]!.path).toBe(
      join(h.projectRoot, STDERR_LOG_RELATIVE),
    );
    expect(h.openSyncCalls[0]!.flags).toBe("a");
  });

  test("closeSync は spawn 後・unref 前に fd を close する (fd leak 防止)", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.closeSyncCalls).toEqual([FAKE_FD_DEFAULT]);
    const closeIdx = h.events.indexOf(`close:${FAKE_FD_DEFAULT}`);
    const spawnIdx = h.events.indexOf("spawn");
    const unrefIdx = h.events.indexOf("unref");
    expect(spawnIdx).toBeLessThan(closeIdx);
    expect(closeIdx).toBeLessThan(unrefIdx);
  });

  test("spawn の stdio は [inherit, inherit, fd] になっている (T013 P4)", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.spawnCalls.length).toBe(1);
    const call = h.spawnCalls[0]!;
    expect(call.options.stdio).toEqual(["inherit", "inherit", FAKE_FD_DEFAULT]);
  });

  test("spawn の options が正しい (cmd / args / env / cwd / detached)", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.spawnCalls.length).toBe(1);
    const call = h.spawnCalls[0]!;
    expect(call.cmd).toBe("bun");
    // T010 S5.1: reload した子は redirect 済み扱いで起動する (2 段重ね防止)
    expect(call.args).toEqual([
      "run",
      h.latestMainTs,
      "start",
      POST_MORTEM_REDIRECTED_FLAG,
    ]);
    expect(call.options).toEqual({
      stdio: ["inherit", "inherit", FAKE_FD_DEFAULT],
      env: process.env,
      cwd: process.cwd(),
      detached: true,
    });
  });

  // T010 S5.1: reload した子に必ず POST_MORTEM_REDIRECTED_FLAG が伝播する
  test("spawn args の末尾に --__post-mortem-redirected が含まれる (S5.1)", async () => {
    const h = makeHarness();
    await h.run();
    const call = h.spawnCalls[0]!;
    expect(call.args).toContain(POST_MORTEM_REDIRECTED_FLAG);
    expect(call.args[call.args.length - 1]).toBe(POST_MORTEM_REDIRECTED_FLAG);
  });

  test("exit は code=0 で 1 回だけ呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.exitCalls).toEqual([0]);
  });

  test("log には child_pid と latestMainTs が含まれる", async () => {
    const h = makeHarness();
    await h.run();
    const reloadLog = h.logs.find((l) => l.event === "daemon_reload_spawned");
    expect(reloadLog).toBeDefined();
    expect(reloadLog!.detail).toContain("child_pid=99999");
    expect(reloadLog!.detail).toContain(`latestMainTs=${h.latestMainTs}`);
  });

  test("unref は close 後・exit 前にちょうど 1 回呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.unrefCount).toBe(1);
    const unrefIdx = h.events.indexOf("unref");
    const closeIdx = h.events.indexOf(`close:${FAKE_FD_DEFAULT}`);
    const exitIdx = h.events.indexOf("exit:0");
    expect(closeIdx).toBeLessThan(unrefIdx);
    expect(unrefIdx).toBeLessThan(exitIdx);
  });

  test("happy path では reload_failed event は emit されない", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.emittedEvents).toEqual([]);
  });
});

describe("performDaemonReload — failure paths", () => {
  test("spawn が pid=undefined を返したら reload_failed (child_pid_undefined) を emit + log + exit(1)", async () => {
    const h = makeHarness({ spawnPidUndefined: true });
    await h.run();
    // 新挙動: release → open → spawn → close → log:spawn_failed → emit → exit:1
    expect(h.events).toEqual([
      "release",
      "open",
      "spawn",
      `close:${FAKE_FD_DEFAULT}`,
      "log:daemon_reload_spawn_failed",
      "emit:reload_failed",
      "exit:1",
    ]);
    const failedLog = h.logs.find((l) => l.event === "daemon_reload_spawn_failed");
    expect(failedLog).toBeDefined();
    expect(failedLog!.detail).toContain("child_pid_undefined");
    expect(h.emittedEvents.length).toBe(1);
    expect(h.emittedEvents[0]).toMatchObject({
      event: "reload_failed",
      reason: "child_pid_undefined",
    });
    // spawned ログは出ない
    expect(h.logs.find((l) => l.event === "daemon_reload_spawned")).toBeUndefined();
    // unref は呼ばれない
    expect(h.unrefCount).toBe(0);
    // exit code は 1
    expect(h.exitCalls).toEqual([1]);
  });

  test("pid=undefined でも fd は close される (leak 防止)", async () => {
    const h = makeHarness({ spawnPidUndefined: true });
    await h.run();
    expect(h.closeSyncCalls).toEqual([FAKE_FD_DEFAULT]);
  });

  test("openSync 失敗時は reload_failed (stderr_log_open_failed) を emit + log + exit(1)", async () => {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error("EACCES: permission denied"),
      { code: "EACCES" },
    );
    const h = makeHarness({ openSyncThrows: err });
    await h.run();
    // 新挙動: release → open(throws) → log → emit → exit:1 (spawn は呼ばれない)
    expect(h.events).toEqual([
      "release",
      "open",
      "log:daemon_reload_stderr_log_open_failed",
      "emit:reload_failed",
      "exit:1",
    ]);
    expect(h.spawnCalls).toEqual([]);
    expect(h.closeSyncCalls).toEqual([]);
    const failedLog = h.logs.find(
      (l) => l.event === "daemon_reload_stderr_log_open_failed",
    );
    expect(failedLog).toBeDefined();
    expect(failedLog!.detail).toContain("code=EACCES");
    expect(h.emittedEvents.length).toBe(1);
    expect(h.emittedEvents[0]).toMatchObject({
      event: "reload_failed",
      reason: "stderr_log_open_failed",
    });
    expect(h.exitCalls).toEqual([1]);
  });

  test("spawn が throw した場合は fd を close してから reload_failed (spawn_threw) を emit + log + exit(1)", async () => {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error("ENOENT: bun not found"),
      { code: "ENOENT" },
    );
    const h = makeHarness({ spawnThrows: err });
    await h.run();
    expect(h.events).toEqual([
      "release",
      "open",
      "spawn",
      `close:${FAKE_FD_DEFAULT}`,
      "log:daemon_reload_spawn_threw",
      "emit:reload_failed",
      "exit:1",
    ]);
    expect(h.closeSyncCalls).toEqual([FAKE_FD_DEFAULT]);
    const failedLog = h.logs.find((l) => l.event === "daemon_reload_spawn_threw");
    expect(failedLog).toBeDefined();
    expect(failedLog!.detail).toContain("code=ENOENT");
    expect(h.emittedEvents.length).toBe(1);
    expect(h.emittedEvents[0]).toMatchObject({
      event: "reload_failed",
      reason: "spawn_threw",
    });
    expect(h.exitCalls).toEqual([1]);
    expect(h.unrefCount).toBe(0);
  });
});

describe("performDaemonReload — invariants", () => {
  test("release が internal log を出すが throw しない契約に依存する (releasePidFile contract)", async () => {
    // releasePidFile は ENOENT を握り潰し、それ以外も await log(...) で吸収して return する設計のため
    // throw しない契約（pidfile.ts:141-148）。reload helper はこの invariant に依存しているので、
    // 「release が throw しても spawn と exit は呼ばれる」test は意図的に置いていない。
    // 代わりに、release が解決すれば spawn と exit が呼ばれることを assert する。
    const h = makeHarness({
      releaseImpl: async (path) => {
        // simulate releasePidFile with internal log but no throw
        h.releaseCalls.push(path);
        h.events.push("release");
      },
    });
    await h.run();
    expect(h.releaseCalls.length).toBe(1);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.exitCalls).toEqual([0]);
  });

  test("latestMainTs が相対パスでも spawn には絶対パスを渡す (cwd 依存除去)", async () => {
    const h = makeHarness();
    await performDaemonReload({
      pidFilePath: h.pidFilePath,
      latestMainTs: "skills/cmux-team/manager/main.ts",
      projectRoot: h.projectRoot,
      releaseImpl: async (path) => {
        h.releaseCalls.push(path);
        h.events.push("release");
      },
      openSyncImpl: (path: string, flags: string) => {
        h.openSyncCalls.push({ path, flags });
        h.events.push("open");
        return FAKE_FD_DEFAULT;
      },
      closeSyncImpl: (fd: number) => {
        h.closeSyncCalls.push(fd);
        h.events.push(`close:${fd}`);
      },
      spawnImpl: ((cmd: string, args: readonly string[], options: any) => {
        h.spawnCalls.push({ cmd, args, options });
        h.events.push("spawn");
        return {
          pid: 1,
          unref: () => {
            h.unrefCount++;
            h.events.push("unref");
          },
        } as unknown as ChildProcess;
      }) as any,
      exitImpl: (code) => {
        h.exitCalls.push(code);
        h.events.push(`exit:${code}`);
      },
      logImpl: async (event, detail) => {
        h.logs.push({ event, detail });
        h.events.push(`log:${event}`);
      },
      emitEventImpl: async (record) => {
        h.emittedEvents.push(record);
        h.events.push(`emit:${record.event}`);
      },
    });
    expect(h.spawnCalls.length).toBe(1);
    const passedPath = h.spawnCalls[0]!.args[1]!;
    // 絶対パス ("/" 始まり on POSIX) になっていること
    expect(passedPath.startsWith("/")).toBe(true);
  });
});
