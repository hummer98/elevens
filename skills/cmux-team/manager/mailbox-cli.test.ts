/**
 * mailbox-cli.ts の最小単位テスト。
 * 実 c11 daemon に対する書き込みは c11-features.test.ts と smoke test 側でカバー。
 *
 * v0.9.0+ (T016): cmux backend が撤去されたため、「mailbox 非対応」状態は
 * `__setCapabilitiesForTest(null)` で再現する（旧来の ELEVENS_BACKEND=cmux 経路は廃止）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runMailboxCli } from "./mailbox-cli";
import { __resetCapabilitiesCache, __setCapabilitiesForTest } from "./c11-features";

class StringSink {
  data = "";
  write(chunk: any): boolean {
    this.data += String(chunk);
    return true;
  }
}

beforeEach(() => {
  __resetCapabilitiesCache();
});

afterEach(() => {
  __resetCapabilitiesCache();
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

describe("supported (mailbox 非対応 c11 → 1, 対応 c11 は smoke test 側)", () => {
  test("mailbox 非対応 c11 build では supported=no、exit 1", async () => {
    __setCapabilitiesForTest(null);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({ args: ["supported"], stdout: stdout as any, stderr: stderr as any });
    expect(code).toBe(1);
    expect(stdout.data.trim()).toBe("no");
  });

  test("--json flag で JSON 出力 + exit code 据え置き (非対応 → false / exit 1)", async () => {
    __setCapabilitiesForTest(null);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: ["supported", "--json"],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(1);
    // 厳密に 1 行 JSON
    const parsed = JSON.parse(stdout.data.trim());
    expect(parsed).toEqual({ supported: false });
    // text "no" は出さない
    expect(stdout.data).not.toContain("no\n");
  });
});

describe("引数バリデーション", () => {
  test("set --key 単独 (--value 欠落) で exit 2", async () => {
    __setCapabilitiesForTest(null);
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
    __setCapabilitiesForTest(null);
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
    __setCapabilitiesForTest(null);
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

describe("validate 経路 smoke (mailbox-schema integration)", () => {
  test("canonical key で型違反値があっても warn mode (default) で exit 0（書き込み続行）", async () => {
    __setCapabilitiesForTest(null);
    const stdout = new StringSink();
    const stderr = new StringSink();
    // mailbox.progress に 2.0（範囲外）を渡しても CLI は exit 0 で抜ける（warn のみ）
    const code = await runMailboxCli({
      args: [
        "set",
        "--surface",
        "surface:1",
        "--json",
        '{"mailbox.progress":2.0}',
      ],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(0);
  });

  test("未知 mailbox.* key も warn mode で exit 0（書き込み続行）", async () => {
    __setCapabilitiesForTest(null);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await runMailboxCli({
      args: [
        "set",
        "--surface",
        "surface:1",
        "--json",
        '{"mailbox.unknown_field":"hello"}',
      ],
      stdout: stdout as any,
      stderr: stderr as any,
    });
    expect(code).toBe(0);
  });
});

describe("mailbox 非対応 c11 build での no-op set/get/clear", () => {
  test("set/get/clear が exit 0、副作用なし", async () => {
    __setCapabilitiesForTest(null);
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
