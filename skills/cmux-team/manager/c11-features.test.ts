/**
 * c11-features.ts のテスト。
 *
 * v0.9.0+ (T016): cmux backend は撤去された。「mailbox 非対応」状態を再現するには
 * `__setCapabilitiesForTest(null)` で capabilities を null 注入する（旧来の
 * `process.env.ELEVENS_BACKEND = "cmux"` 経路は廃止）。
 *
 * モック戦略:
 * - opportunistic no-op テスト: `__setCapabilitiesForTest(null)` で unsupported を強制
 * - mailbox 対応 c11 のテスト: `__setCapabilitiesForTest({methods: [...]})` で対応を強制
 * - watchMailbox: `__setFetchMailboxImpl` で fetch を直接 fake
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, chmod, mkdir } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let testDir: string;
let origPath: string | undefined;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "c11-features-test-",
    subdirs: [],
    setProjectRootEnv: false,
    createTeamDir: false,
  });
  testDir = project.root;
  const binDir = join(testDir, "bin");
  await mkdir(binDir, { recursive: true });
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  await project.dispose();
});

async function writeFakeBin(name: string, script: string): Promise<void> {
  const path = join(testDir, "bin", name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

describe("mailbox 非対応 c11 build での opportunistic no-op (T016)", () => {
  test("setMailbox / getMailbox / clearMailbox は mailbox 非対応で何もしない", async () => {
    const { setMailbox, getMailbox, clearMailbox, isMailboxSupported, __setCapabilitiesForTest, __resetCapabilitiesCache } =
      await import("./c11-features");
    __resetCapabilitiesCache();
    // capabilities=null → 「c11 binary が capabilities を返さない」状態
    __setCapabilitiesForTest(null);
    try {
      expect(await isMailboxSupported()).toBe(false);
      expect(await getMailbox({ kind: "surface", ref: "surface:1" })).toBeNull();
      await setMailbox({ kind: "surface", ref: "surface:1" }, { "mailbox.status": "running" });
      await clearMailbox({ kind: "surface", ref: "surface:1" }, "mailbox.status");
      // ↑ throw しなければ OK（no-op が成立している）
    } finally {
      __resetCapabilitiesCache();
    }
  });
});

describe("setMailbox の validate option (mailbox-schema integration)", () => {
  test("validate=strict で型違反 payload は throw する（書き込み前にガード）", async () => {
    const { setMailbox, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest(null); // unsupported (mailbox を試みない)
    try {
      await expect(
        setMailbox(
          { kind: "surface", ref: "surface:1" },
          { "mailbox.progress": 2.0 } as any,
          { validate: "strict" },
        ),
      ).rejects.toThrow(/mailbox\.progress/);
    } finally {
      __resetCapabilitiesCache();
    }
  });

  test("validate=warn (default) で型違反 payload でも no-op exit (mailbox 非対応)", async () => {
    const { setMailbox, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest(null);
    try {
      // throw しなければ OK
      await setMailbox(
        { kind: "surface", ref: "surface:1" },
        { "mailbox.status": "DONE" } as any, // canonical 集合に無い大文字
        { validate: "warn" },
      );
    } finally {
      __resetCapabilitiesCache();
    }
  });

  test("validate=off で schema 検証を完全 skip", async () => {
    const { setMailbox, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest(null);
    try {
      // strict なら throw する payload も off では throw しない
      await setMailbox(
        { kind: "surface", ref: "surface:1" },
        { "mailbox.progress": 99 } as any,
        { validate: "off" },
      );
    } finally {
      __resetCapabilitiesCache();
    }
  });
});

describe("watchMailbox の error 経路で prev を破壊しない (A031 §2 follow-up)", () => {
  test("transient error tick → prev を保持、phantom removed を emit しない、復帰後に正常 diff", async () => {
    const c11 = await import("./c11-features");
    c11.__resetCapabilitiesCache();

    const events: any[] = [];
    let phase = 0;
    // tick 1: 初期状態 mailbox.x=foo
    // tick 2: error（c11 から transient 失敗）→ prev 保持
    // tick 3: 同じ mailbox.x=foo → 余計な added/removed が出ないこと
    // tick 4: mailbox.x=bar → changed(prev=foo, value=bar) が出ること
    const fetches = [
      async () => ({ kind: "ok" as const, data: { "mailbox.x": "foo", title: "ignored" } as Record<string, any> }),
      async () => ({ kind: "error" as const, error: new Error("transient ETIMEDOUT") }),
      async () => ({ kind: "ok" as const, data: { "mailbox.x": "foo", title: "ignored" } as Record<string, any> }),
      async () => ({ kind: "ok" as const, data: { "mailbox.x": "bar", title: "ignored" } as Record<string, any> }),
    ];

    c11.__setFetchMailboxImpl(async (_target) => {
      const fn = fetches[Math.min(phase, fetches.length - 1)];
      phase++;
      return fn();
    });

    const handle = await c11.watchMailbox(
      { kind: "surface", ref: "surface:1" },
      (changes) => {
        events.push(...changes);
      },
      { intervalMs: 60 } // 内部で 250ms に clamp される
    );
    // 4 tick まで進めるのを (4 * 250) + マージン待つ
    await new Promise((r) => setTimeout(r, 1300));
    handle.stop();
    c11.__setFetchMailboxImpl(null);

    // tick 1: added mailbox.x=foo (firstTick)
    // tick 2: error → 何も emit しない、prev 保持
    // tick 3: 同じ foo → diff なし、emit なし
    // tick 4: changed mailbox.x: foo → bar
    const kinds = events.map((e) => `${e.kind}:${e.key}=${"value" in e ? e.value : "(removed)"}`);
    expect(kinds[0]).toBe("added:mailbox.x=foo");
    // **bug の挙動だと tick 2 で removed が出る**。ここでそれが無いことを assert
    expect(kinds.find((k) => k.startsWith("removed"))).toBeUndefined();
    // tick 4 の changed が確認できる
    expect(kinds).toContain("changed:mailbox.x=bar");
    // total event 数: added + changed = 2（中間の error / 同値 tick は 0）
    expect(events.length).toBe(2);
  });

  test("unsupported を返すと watcher は静かに停止する", async () => {
    const c11 = await import("./c11-features");
    c11.__resetCapabilitiesCache();

    let calls = 0;
    c11.__setFetchMailboxImpl(async () => {
      calls++;
      return { kind: "unsupported" as const };
    });

    const events: any[] = [];
    const handle = await c11.watchMailbox(
      { kind: "surface", ref: "surface:1" },
      (changes) => events.push(...changes),
      { intervalMs: 30 }
    );
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    c11.__setFetchMailboxImpl(null);

    expect(events.length).toBe(0);
    // 1 回の呼び出しで unsupported を確認したら停止しているはず
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe("isMailboxSupported は capabilities methods を見る (T016)", () => {
  test("surface.set_metadata を持つ → true", async () => {
    const { isMailboxSupported, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest({ methods: ["surface.set_metadata", "pane.get_metadata"] });
    try {
      expect(await isMailboxSupported()).toBe(true);
    } finally {
      __resetCapabilitiesCache();
    }
  });

  test("pane.set_metadata を持つ → true (どちらかが有れば良い)", async () => {
    const { isMailboxSupported, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest({ methods: ["pane.set_metadata"] });
    try {
      expect(await isMailboxSupported()).toBe(true);
    } finally {
      __resetCapabilitiesCache();
    }
  });

  test("set_metadata 系を持たない → false", async () => {
    const { isMailboxSupported, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest({ methods: ["surface.get_metadata"] });
    try {
      expect(await isMailboxSupported()).toBe(false);
    } finally {
      __resetCapabilitiesCache();
    }
  });

  test("capabilities が null → false (mailbox 非対応 c11 build)", async () => {
    const { isMailboxSupported, __setCapabilitiesForTest, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    __setCapabilitiesForTest(null);
    try {
      expect(await isMailboxSupported()).toBe(false);
    } finally {
      __resetCapabilitiesCache();
    }
  });
});
