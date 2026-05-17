/**
 * post-mortem-redirect.ts のテスト (T010 S5)
 *
 * cmdStart 冒頭の自己再 spawn ロジック (rotate + open + spawn + exit) を DI で検証。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  maybeRespawnWithStderrRedirect,
  POST_MORTEM_REDIRECTED_FLAG,
} from "./post-mortem-redirect";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let projectRoot: string;
let stderrLogPath: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-pmr-test-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  projectRoot = project.root;
  stderrLogPath = join(projectRoot, ".team/logs/manager.stderr.log");
});

afterEach(async () => {
  await project.dispose();
});

// spawn の signature: (command, args?, options?) — test 用 helper でキャプチャ
function makeSpawnMock(calls: Array<{ cmd: string; args: string[]; opts: any }>, pid?: number) {
  return ((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    return { pid: pid ?? 99, unref: () => {} } as any;
  }) as any;
}

describe("maybeRespawnWithStderrRedirect - skip 経路", () => {
  test("flag が args に含まれる場合は何もせず return", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start", POST_MORTEM_REDIRECTED_FLAG],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls),
      openSyncImpl: () => 5,
      closeSyncImpl: () => {},
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result).toEqual({ skipped: true, reason: "already-redirected" });
    expect(spawnCalls).toEqual([]);
    expect(exitCalls).toEqual([]);
  });

  test("isTTY=false なら何もせず return (test / pipe 経路)", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => false,
      spawnImpl: makeSpawnMock(spawnCalls),
      openSyncImpl: () => 5,
      closeSyncImpl: () => {},
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result).toEqual({ skipped: true, reason: "non-tty" });
    expect(spawnCalls).toEqual([]);
    expect(exitCalls).toEqual([]);
  });
});

describe("maybeRespawnWithStderrRedirect - redirect 経路", () => {
  test("TTY + flag 無し → spawn + exit(0) し stderr.log を作成する", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const opens: Array<{ path: string; flag: string }> = [];
    const closes: number[] = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls, 99),
      openSyncImpl: (path: string, flag: string) => {
        opens.push({ path, flag });
        return 7;
      },
      closeSyncImpl: (fd: number) => {
        closes.push(fd);
      },
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result).toEqual({ skipped: false, reason: "respawned" });
    expect(spawnCalls.length).toBe(1);
    const lastArg = spawnCalls[0]!.args[spawnCalls[0]!.args.length - 1];
    expect(lastArg).toBe(POST_MORTEM_REDIRECTED_FLAG);
    // stdio: [inherit, inherit, fd]
    expect(spawnCalls[0]!.opts.stdio[2]).toBe(7);
    expect(spawnCalls[0]!.opts.detached).toBe(true);
    expect(opens.length).toBe(1);
    expect(opens[0]!.path).toBe(stderrLogPath);
    expect(opens[0]!.flag).toBe("a");
    expect(closes).toEqual([7]);
    expect(exitCalls).toEqual([0]);
  });

  test("既存 stderr.log があれば .1 に rotate される", async () => {
    mkdirSync(join(projectRoot, ".team/logs"), { recursive: true });
    writeFileSync(stderrLogPath, "old content\n", "utf8");

    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls, 99),
      openSyncImpl: () => 7,
      closeSyncImpl: () => {},
      exitImpl: () => {},
    });

    const rotated = stderrLogPath + ".1";
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(rotated, "utf8")).toBe("old content\n");
  });

  test("既存 stderr.log と .1 が両方ある場合、.1 を上書きする", async () => {
    mkdirSync(join(projectRoot, ".team/logs"), { recursive: true });
    writeFileSync(stderrLogPath, "current\n", "utf8");
    writeFileSync(stderrLogPath + ".1", "very-old\n", "utf8");

    const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls, 99),
      openSyncImpl: () => 7,
      closeSyncImpl: () => {},
      exitImpl: () => {},
    });

    expect(readFileSync(stderrLogPath + ".1", "utf8")).toBe("current\n");
  });

  test("spawn 失敗 (pid undefined) は fail-fast で exit(1)", async () => {
    const exitCalls: number[] = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: ((_cmd: string, _args: string[], _opts: any) =>
        ({ pid: undefined, unref: () => {} }) as any) as any,
      openSyncImpl: () => 7,
      closeSyncImpl: () => {},
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result.skipped).toBe(false);
    expect(exitCalls).toEqual([1]);
  });
});
