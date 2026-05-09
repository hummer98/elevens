/**
 * mailbox-cli.ts の最小単位テスト。
 * 実 c11 daemon に対する書き込みは c11-features.test.ts と smoke test 側でカバー。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runMailboxCli } from "./mailbox-cli";
import { __resetCapabilitiesCache } from "./c11-features";

class StringSink {
  data = "";
  write(chunk: any): boolean {
    this.data += String(chunk);
    return true;
  }
}

let origBackend: string | undefined;

beforeEach(() => {
  origBackend = process.env.ELEVENS_BACKEND;
  __resetCapabilitiesCache();
});

afterEach(() => {
  if (origBackend === undefined) delete process.env.ELEVENS_BACKEND;
  else process.env.ELEVENS_BACKEND = origBackend;
});

describe("help / 引数なし", () => {
  test("引数なしで help を出して 0 を返す", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({ args: [], stdout: stdout as any, stderr: stderr as any });
    expect(code).toBe(0);
    expect(stdout.data).toContain("elevens mailbox");
    expect(stderr.data).toBe("");
  });

  test("--help でも 0", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({ args: ["--help"], stdout: stdout as any, stderr: stderr as any });
    expect(code).toBe(0);
    expect(stdout.data).toContain("Usage:");
  });
});

describe("supported (cmux backend → 1, c11 backend は smoke test 側)", () => {
  test("cmux backend では supported=no、exit 1", async () => {
    delete process.env.ELEVENS_BACKEND;
    __resetCapabilitiesCache();
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({ args: ["supported"], stdout: stdout as any, stderr: stderr as any });
    expect(code).toBe(1);
    expect(stdout.data.trim()).toBe("no");
  });
});

describe("引数バリデーション", () => {
  test("set --key 単独 (--value 欠落) で exit 2", async () => {
    delete process.env.ELEVENS_BACKEND;
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: ["set", "--surface", "surface:1", "--key", "x"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(2);
    expect(stderr.data).toContain("--value");
  });

  test("set --json で不正 JSON は exit 2", async () => {
    delete process.env.ELEVENS_BACKEND;
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: ["set", "--surface", "surface:1", "--json", "not-json"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(2);
    expect(stderr.data).toContain("payload parse error");
  });

  test("clear で --key 欠落は exit 2", async () => {
    delete process.env.ELEVENS_BACKEND;
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: ["clear", "--surface", "surface:1"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(2);
    expect(stderr.data).toContain("--key");
  });

  test("unknown subcommand は exit 2", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: ["doesnotexist"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(2);
    expect(stderr.data).toContain("unknown");
  });
});

describe("cmux backend での no-op set/get/clear", () => {
  test("set/get/clear が exit 0、副作用なし", async () => {
    delete process.env.ELEVENS_BACKEND;
    __resetCapabilitiesCache();
    const stdout = new StringSink();
    const stderr = new StringSink();
    let code = await runMailboxCli({
      args: ["set", "--surface", "surface:1", "--key", "mailbox.x", "--value", "v"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(0);
    code = await runMailboxCli({
      args: ["get", "--surface", "surface:1", "--json"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(0);
    expect(stdout.data).toContain("{}"); // null → "{}" が JSON モードで出る
    code = await runMailboxCli({
      args: ["clear", "--surface", "surface:1", "--key", "mailbox.x"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(0);
  });
});
