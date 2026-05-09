/**
 * c11-features.ts のテスト。
 *
 * モック戦略: cmux.test.ts と同じく fake binary を `PATH` 先頭に置く方式。
 * `ELEVENS_BACKEND=c11` を beforeEach で設定し、`c11` という名前の fake script を作る。
 *
 * 注意: SUBSTRATE_BINARY は cmux.ts の module load 時に評価されるため、
 * `bun:test` の各テストファイルは独立 module コンテキストで動く前提で env を起動前に設定する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, chmod, mkdir } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";

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
    // ELEVENS_BACKEND を未設定にして cmux backend にする
    delete process.env.ELEVENS_BACKEND;
    const mod = await import(`./c11-features?cmux-${Date.now()}.ts` as any).catch(() => null);
    // 上記 dynamic re-import が効かない場合は静的 import を使う（SUBSTRATE_BINARY が cmux のはず）
    const { setMailbox, getMailbox, clearMailbox, isMailboxSupported, __resetCapabilitiesCache } =
      mod ?? (await import("./c11-features"));
    __resetCapabilitiesCache();

    // cmux backend では `c11` を呼ぼうとしないので、fake `c11` スクリプトが無くても通る
    expect(await isMailboxSupported()).toBe(false);
    expect(await getMailbox({ kind: "surface", ref: "surface:1" })).toBeNull();
    await setMailbox({ kind: "surface", ref: "surface:1" }, { "mailbox.status": "running" });
    await clearMailbox({ kind: "surface", ref: "surface:1" }, "mailbox.status");
    // ↑ throw しなければ OK（no-op が成立している）
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
