/**
 * post-mortem-redirect.ts のテスト (T013 — parent tee 仕様)
 *
 * T010 S5 の self-respawn 方式から T013 で parent tee に転換したことに伴い、
 * 全テストを書き直した。
 *   - skip 経路 (already-redirected / non-tty) — 維持
 *   - rotate (.1 退避) — 維持
 *   - spawn 失敗 fail-fast → TTY + file 両方へ stderr 書き出し (拡張)
 *   - spawn 形式 stdio:[inherit,inherit,"pipe"] / detached:false (書き換え)
 *   - tee: chunk が logStream / processStderrWrite 両方へ届く (新規)
 *   - exit code 継承 (新規)
 *   - parent は child.kill を呼ばない (no-forward 構造的 assert, 新規)
 *   - SIGHUP listener は parent が bind しない (新規)
 *   - backpressure: pause → drain → resume (新規)
 *   - atomic bind invariant: data/end/exit が同一 tick で bind される (新規)
 *   - waitForChildExit:false test hatch は __maybeRespawnWithStderrRedirectForTest 経由 (m1)
 */
import { EventEmitter } from "events";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  maybeRespawnWithStderrRedirect,
  __maybeRespawnWithStderrRedirectForTest,
  POST_MORTEM_REDIRECTED_FLAG,
} from "./post-mortem-redirect";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let projectRoot: string;
let stderrLogPath: string;

// review n2 対応: SIGHUP / SIGINT / SIGTERM の baseline listener count を beforeEach で snapshot
let sighupBaseline = 0;
let sigintBaseline = 0;
let sigtermBaseline = 0;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-pmr-test-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  projectRoot = project.root;
  stderrLogPath = join(projectRoot, ".team/logs/manager.stderr.log");
  sighupBaseline = process.listenerCount("SIGHUP");
  sigintBaseline = process.listenerCount("SIGINT");
  sigtermBaseline = process.listenerCount("SIGTERM");
});

afterEach(async () => {
  await project.dispose();
});

// =========================================================================
// child mock 構造
// =========================================================================

interface MockChildStderr extends EventEmitter {
  pauseCalls: number;
  resumeCalls: number;
  pause: () => void;
  resume: () => void;
}

interface MockChild extends EventEmitter {
  pid: number | undefined;
  stderr: MockChildStderr | null;
  killCalls: string[];
  kill: (signal?: string) => boolean;
}

function makeMockChildStderr(): MockChildStderr {
  const emitter = new EventEmitter() as MockChildStderr;
  emitter.pauseCalls = 0;
  emitter.resumeCalls = 0;
  emitter.pause = () => {
    emitter.pauseCalls++;
  };
  emitter.resume = () => {
    emitter.resumeCalls++;
  };
  return emitter;
}

function makeMockChild(pid: number | undefined): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stderr = pid === undefined ? null : makeMockChildStderr();
  child.killCalls = [];
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: any;
  child: MockChild;
  /** spawnImpl 戻り値直後に同期で listener が bind されたかを記録 */
  bindSnapshotAfterReturn?: {
    data: number;
    end: number;
    exit: number;
  };
}

const PID_UNDEFINED = Symbol("PID_UNDEFINED");

function makeSpawnMock(
  calls: SpawnCall[],
  pidFn:
    | (() => number | undefined)
    | number
    | typeof PID_UNDEFINED = 99,
): (cmd: string, args: string[], opts: any) => any {
  return (cmd: string, args: string[], opts: any) => {
    const pid =
      pidFn === PID_UNDEFINED
        ? undefined
        : typeof pidFn === "function"
          ? pidFn()
          : pidFn;
    const child = makeMockChild(pid);
    const call: SpawnCall = { cmd, args, opts, child };
    calls.push(call);
    // microtask で listener bind 数の snapshot を取る (atomic bind 検証用)
    queueMicrotask(() => {
      call.bindSnapshotAfterReturn = {
        data: child.stderr ? child.stderr.listenerCount("data") : 0,
        end: child.stderr ? child.stderr.listenerCount("end") : 0,
        exit: child.listenerCount("exit"),
      };
    });
    return child as any;
  };
}

// logStream の最小 mock。write/end/once("drain") をサポート。
interface MockLogStream {
  writes: Array<string | Buffer>;
  ended: boolean;
  endCallbackCalled: boolean;
  drainListeners: Array<() => void>;
  writeResults: boolean[]; // pre-set 戻り値の queue (空なら true)
  write: (chunk: any) => boolean;
  once: (ev: string, cb: () => void) => MockLogStream;
  end: (cb?: () => void) => MockLogStream;
  emitDrain: () => void;
}

function makeMockLogStream(presetWriteResults: boolean[] = []): MockLogStream {
  const stream: MockLogStream = {
    writes: [],
    ended: false,
    endCallbackCalled: false,
    drainListeners: [],
    writeResults: [...presetWriteResults],
    write(chunk: any) {
      this.writes.push(chunk);
      if (this.writeResults.length > 0) {
        return this.writeResults.shift() as boolean;
      }
      return true;
    },
    once(ev: string, cb: () => void) {
      if (ev === "drain") this.drainListeners.push(cb);
      return this;
    },
    end(cb?: () => void) {
      this.ended = true;
      if (cb) {
        this.endCallbackCalled = true;
        cb();
      }
      return this;
    },
    emitDrain() {
      const ls = this.drainListeners;
      this.drainListeners = [];
      for (const l of ls) l();
    },
  };
  return stream;
}

// =========================================================================
// skip 経路
// =========================================================================

describe("maybeRespawnWithStderrRedirect - skip 経路", () => {
  test("flag が args に含まれる場合は何もせず return", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start", POST_MORTEM_REDIRECTED_FLAG],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result).toEqual({ skipped: true, reason: "already-redirected" });
    expect(spawnCalls).toEqual([]);
    expect(exitCalls).toEqual([]);
  });

  test("isTTY=false なら何もせず return (CI / pipe 経路)", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => false,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
    });
    expect(result).toEqual({ skipped: true, reason: "non-tty" });
    expect(spawnCalls).toEqual([]);
    expect(exitCalls).toEqual([]);
  });

  test("CMUX_TEAM_POST_MORTEM_REDIRECT env が無くても TTY なら起動する (env opt-in 廃止)", async () => {
    // v0.8.1 hotfix の opt-in env は T013 で廃止。env をセットしなくても tee が走る。
    delete process.env.CMUX_TEAM_POST_MORTEM_REDIRECT;
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    const result = await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });
    expect(result).toEqual({ skipped: false, reason: "tee-completed" });
    expect(spawnCalls.length).toBe(1);
  });
});

// =========================================================================
// rotate (.1 退避)
// =========================================================================

describe("maybeRespawnWithStderrRedirect - rotate", () => {
  test("既存 stderr.log があれば .1 に rotate される", async () => {
    mkdirSync(join(projectRoot, ".team/logs"), { recursive: true });
    writeFileSync(stderrLogPath, "old content\n", "utf8");

    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });

    const rotated = stderrLogPath + ".1";
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(rotated, "utf8")).toBe("old content\n");
  });

  test("既存 stderr.log と .1 が両方ある場合、.1 を上書きする", async () => {
    mkdirSync(join(projectRoot, ".team/logs"), { recursive: true });
    writeFileSync(stderrLogPath, "current\n", "utf8");
    writeFileSync(stderrLogPath + ".1", "very-old\n", "utf8");

    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });

    expect(readFileSync(stderrLogPath + ".1", "utf8")).toBe("current\n");
  });
});

// =========================================================================
// spawn 形式 (stdio / detached / args)
// =========================================================================

describe("maybeRespawnWithStderrRedirect - spawn 形式", () => {
  test("stdio:[inherit, inherit, 'pipe'] / detached:false / args 末尾に flag", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });
    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0]!;
    expect(call.opts.stdio).toEqual(["inherit", "inherit", "pipe"]);
    expect(call.opts.detached).toBe(false);
    expect(call.args[call.args.length - 1]).toBe(POST_MORTEM_REDIRECTED_FLAG);
  });
});

// =========================================================================
// tee の data ルーティング
// =========================================================================

describe("maybeRespawnWithStderrRedirect - tee data routing", () => {
  test("child の stderr chunk が logStream / processStderrWrite 両方へ届く", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    const ttyWrites: Array<string | Buffer> = [];

    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: (chunk) => {
        ttyWrites.push(chunk);
        return true;
      },
      waitForChildExit: false,
    });

    const child = spawnCalls[0]!.child;
    child.stderr!.emit("data", Buffer.from("panic!\n"));
    child.stderr!.emit("data", "trace line\n");

    expect(logStream.writes.length).toBe(2);
    expect(logStream.writes[0]!.toString()).toBe("panic!\n");
    expect(logStream.writes[1]!.toString()).toBe("trace line\n");
    expect(ttyWrites.length).toBe(2);
    expect(ttyWrites[0]!.toString()).toBe("panic!\n");
    expect(ttyWrites[1]!.toString()).toBe("trace line\n");
  });
});

// =========================================================================
// exit code 継承
// =========================================================================

describe("maybeRespawnWithStderrRedirect - exit code 継承", () => {
  test("child が exit(7) で死ぬと親は exitImpl(7) を呼ぶ", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    // 次の microtask で child.exit を emit
    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;
    child.emit("exit", 7, null);
    await p;
    expect(exitCalls).toEqual([7]);
  });

  test("child が SIGINT で死ぬと親は exitImpl(130) を呼ぶ (128+2)", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;
    child.emit("exit", null, "SIGINT");
    await p;
    expect(exitCalls).toEqual([130]);
  });

  test("child が SIGTERM で死ぬと親は exitImpl(143) を呼ぶ (128+15)", async () => {
    const exitCalls: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;
    child.emit("exit", null, "SIGTERM");
    await p;
    expect(exitCalls).toEqual([143]);
  });

  test("logStream は child exit 後に flush close される", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;
    child.stderr!.emit("end");
    child.emit("exit", 0, null);
    await p;
    expect(logStream.ended).toBe(true);
    expect(logStream.endCallbackCalled).toBe(true);
  });
});

// =========================================================================
// no-forward signal 設計の構造的 assert (C1 / C2 解決)
// =========================================================================

describe("maybeRespawnWithStderrRedirect - no-forward signal", () => {
  test("parent は SIGINT を受け取っても child.kill を呼ばない", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;

    // SIGINT を parent に届ける (kernel broadcast simulating)
    process.emit("SIGINT" as any);
    // child は kernel broadcast で独立に signal を受けて自前で死ぬ前提
    child.emit("exit", null, "SIGINT");
    await p;

    expect(child.killCalls).toEqual([]);
  });

  test("parent は SIGTERM を受け取っても child.kill を呼ばない", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    const child = spawnCalls[0]!.child;
    process.emit("SIGTERM" as any);
    child.emit("exit", null, "SIGTERM");
    await p;

    expect(child.killCalls).toEqual([]);
  });

  test("parent は SIGHUP listener を bind しない (差分が 0)", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const result = await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });
    expect(result.reason).toBe("tee-completed");
    // helper bind 前後で SIGHUP listener 数は変化しない (差分 0)
    expect(process.listenerCount("SIGHUP") - sighupBaseline).toBe(0);
  });

  test("parent は SIGINT / SIGTERM listener を一時的に bind する (差分 +1) が、exit 後に cleanup される", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    const p = maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
    });

    await new Promise((r) => setImmediate(r));
    // bind 中: SIGINT/SIGTERM 各 +1
    expect(process.listenerCount("SIGINT") - sigintBaseline).toBe(1);
    expect(process.listenerCount("SIGTERM") - sigtermBaseline).toBe(1);

    const child = spawnCalls[0]!.child;
    child.emit("exit", 0, null);
    await p;

    // exit 後: cleanup される
    expect(process.listenerCount("SIGINT") - sigintBaseline).toBe(0);
    expect(process.listenerCount("SIGTERM") - sigtermBaseline).toBe(0);
  });
});

// =========================================================================
// spawn 失敗 (TTY + file 両方表示)
// =========================================================================

describe("maybeRespawnWithStderrRedirect - spawn 失敗", () => {
  test("spawn 失敗 (pid undefined) は TTY と file の両方に message を書いて exit(1)", async () => {
    const exitCalls: number[] = [];
    const ttyWrites: Array<string | Buffer> = [];
    const logStream = makeMockLogStream();
    const spawnCalls: SpawnCall[] = [];

    const result = await maybeRespawnWithStderrRedirect({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls, PID_UNDEFINED) as any,
      exitImpl: (c: number) => {
        exitCalls.push(c);
      },
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: (chunk) => {
        ttyWrites.push(chunk);
        return true;
      },
    });

    expect(result).toEqual({ skipped: false, reason: "spawn-failed" });
    expect(exitCalls).toEqual([1]);
    expect(ttyWrites.length).toBeGreaterThan(0);
    expect(ttyWrites[0]!.toString()).toContain("post-mortem stderr redirect spawn failed");
    expect(logStream.writes.length).toBeGreaterThan(0);
    expect(logStream.writes[0]!.toString()).toContain("post-mortem stderr redirect spawn failed");
    expect(logStream.ended).toBe(true);
  });
});

// =========================================================================
// backpressure
// =========================================================================

describe("maybeRespawnWithStderrRedirect - backpressure", () => {
  test("logStream.write false → child.stderr.pause()、drain → resume()", async () => {
    const spawnCalls: SpawnCall[] = [];
    // 最初の write を false (詰まり) にする
    const logStream = makeMockLogStream([false]);

    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });

    const child = spawnCalls[0]!.child;
    child.stderr!.emit("data", Buffer.from("burst\n"));

    expect(child.stderr!.pauseCalls).toBe(1);
    expect(child.stderr!.resumeCalls).toBe(0);

    // drain event が発火すると resume
    logStream.emitDrain();
    expect(child.stderr!.resumeCalls).toBe(1);

    // 続く write が true なら pause は増えない
    child.stderr!.emit("data", Buffer.from("ok\n"));
    expect(child.stderr!.pauseCalls).toBe(1);
  });
});

// =========================================================================
// atomic bind invariant
// =========================================================================

describe("maybeRespawnWithStderrRedirect - atomic bind invariant", () => {
  test("spawn 戻り値直後 (queueMicrotask 内) で data/end/exit listener が全て bind 済み", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();

    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });

    const snap = spawnCalls[0]!.bindSnapshotAfterReturn;
    expect(snap).toBeDefined();
    expect(snap!.data).toBe(1);
    expect(snap!.end).toBe(1);
    expect(snap!.exit).toBe(1);
  });
});

// =========================================================================
// test-only hatch (__maybeRespawnWithStderrRedirectForTest)
// =========================================================================

describe("__maybeRespawnWithStderrRedirectForTest - test hatch", () => {
  test("waitForChildExit:false を渡せば spawn 直後に tee-completed で resolve する", async () => {
    const spawnCalls: SpawnCall[] = [];
    const logStream = makeMockLogStream();
    const result = await __maybeRespawnWithStderrRedirectForTest({
      projectRoot,
      args: ["start"],
      isTTYImpl: () => true,
      spawnImpl: makeSpawnMock(spawnCalls) as any,
      exitImpl: () => {},
      createWriteStreamImpl: () => logStream as any,
      processStderrWriteImpl: () => true,
      waitForChildExit: false,
    });
    expect(result).toEqual({ skipped: false, reason: "tee-completed" });
    // exit / end は child.exit を emit していないので走らない
    expect(logStream.ended).toBe(false);
  });
});
