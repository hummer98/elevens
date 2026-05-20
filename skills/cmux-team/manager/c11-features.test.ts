/**
 * c11-features.ts のテスト。
 *
 * モック戦略: cmux.test.ts と同じく fake binary を `PATH` 先頭に置く方式。
 *
 * 注意: T015 以降、cmux backend 想定 test は各テスト本体で `process.env.ELEVENS_BACKEND = "cmux"`
 * を明示注入する（env 未設定だと default が c11 になるため）。getCapabilities ガードが
 * `isC11Backend(process.env)` を都度評価するので、この実行時注入が有効に効く。
 * SUBSTRATE_BINARY 自体は module load 時に確定する定数なので、backend 判定は isC11Backend 経由で行う。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, chmod, mkdir } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { isC11Backend } from "./cmux";

let project: DummyProject;
let testDir: string;
let origPath: string | undefined;
let origBackend: string | undefined;

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
  origBackend = process.env.ELEVENS_BACKEND;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  if (origBackend === undefined) delete process.env.ELEVENS_BACKEND;
  else process.env.ELEVENS_BACKEND = origBackend;
  await project.dispose();
});

async function writeFakeBin(name: string, script: string): Promise<void> {
  const path = join(testDir, "bin", name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

describe("cmux backend での opportunistic no-op", () => {
  test("setMailbox / getMailbox / clearMailbox は backend が cmux のとき何もしない", async () => {
    // T015: cmux backend として動かす（env 未設定だと c11 default になるため明示注入）。
    // getCapabilities ガードが isC11Backend(process.env) を都度評価するため、この注入が実行時に効く。
    process.env.ELEVENS_BACKEND = "cmux";
    const { setMailbox, getMailbox, clearMailbox, isMailboxSupported, __resetCapabilitiesCache } =
      await import("./c11-features");
    __resetCapabilitiesCache();
    // 観察箱: cmux backend 経路（!isC11Backend で getCapabilities が早期 null 返却）を通ることを明示
    expect(isC11Backend(process.env)).toBe(false);

    // cmux backend では `c11` を呼ぼうとしないので、fake `c11` スクリプトが無くても通る
    expect(await isMailboxSupported()).toBe(false);
    expect(await getMailbox({ kind: "surface", ref: "surface:1" })).toBeNull();
    await setMailbox({ kind: "surface", ref: "surface:1" }, { "mailbox.status": "running" });
    await clearMailbox({ kind: "surface", ref: "surface:1" }, "mailbox.status");
    // ↑ throw しなければ OK（no-op が成立している）
  });
});

describe("setMailbox の validate option (mailbox-schema integration)", () => {
  test("validate=strict で型違反 payload は throw する（書き込み前にガード）", async () => {
    process.env.ELEVENS_BACKEND = "cmux";
    const { setMailbox, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    expect(isC11Backend(process.env)).toBe(false); // 観察箱: cmux backend 経路
    await expect(
      setMailbox(
        { kind: "surface", ref: "surface:1" },
        { "mailbox.progress": 2.0 } as any,
        { validate: "strict" },
      ),
    ).rejects.toThrow(/mailbox\.progress/);
  });

  test("validate=warn (default) で型違反 payload でも no-op exit（cmux backend）", async () => {
    process.env.ELEVENS_BACKEND = "cmux";
    const { setMailbox, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    expect(isC11Backend(process.env)).toBe(false); // 観察箱: cmux backend 経路
    // throw しなければ OK
    await setMailbox(
      { kind: "surface", ref: "surface:1" },
      { "mailbox.status": "DONE" } as any, // canonical 集合に無い大文字
      { validate: "warn" },
    );
  });

  test("validate=off で schema 検証を完全 skip", async () => {
    process.env.ELEVENS_BACKEND = "cmux";
    const { setMailbox, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    expect(isC11Backend(process.env)).toBe(false); // 観察箱: cmux backend 経路
    // strict なら throw する payload も off では throw しない
    await setMailbox(
      { kind: "surface", ref: "surface:1" },
      { "mailbox.progress": 99 } as any,
      { validate: "off" },
    );
  });
});

describe("watchMailbox の error 経路で prev を破壊しない (A031 §2 follow-up)", () => {
  test("transient error tick → prev を保持、phantom removed を emit しない、復帰後に正常 diff", async () => {
    process.env.ELEVENS_BACKEND = "cmux";
    const c11 = await import("./c11-features");
    c11.__resetCapabilitiesCache();
    expect(isC11Backend(process.env)).toBe(false); // 観察箱: cmux backend 経路

    type R = Awaited<ReturnType<typeof c11.getMailbox>>;
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
    process.env.ELEVENS_BACKEND = "cmux";
    const c11 = await import("./c11-features");
    c11.__resetCapabilitiesCache();
    expect(isC11Backend(process.env)).toBe(false); // 観察箱: cmux backend 経路

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

describe("c11 backend での mailbox 経路", () => {
  test("isMailboxSupported は capabilities の methods を見て判定する", async () => {
    // テスト前に再 import したいが ESM cache の都合で困難。
    // ここでは ELEVENS_BACKEND=c11 を起動 process に注入できないので smoke test のみ:
    // capabilities --json が JSON を返せば parse が通る、エラーなら null になる、
    // という最低限の動作を fake `c11` で確認する
    if (process.env.ELEVENS_BACKEND !== "c11") {
      // この test は ELEVENS_BACKEND=c11 で起動された場合のみ走る（CI default は cmux）
      return;
    }
    await writeFakeBin(
      "c11",
      `if [ "$1" = "capabilities" ]; then echo '{"ok":true,"id":1,"result":{"methods":["surface.set_metadata","pane.get_metadata"]}}'; exit 0; fi`
    );
    const { isMailboxSupported, __resetCapabilitiesCache } = await import("./c11-features");
    __resetCapabilitiesCache();
    expect(await isMailboxSupported()).toBe(true);
  });
});
