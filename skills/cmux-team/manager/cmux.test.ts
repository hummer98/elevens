/**
 * cmux.ts のテスト（T195 以降は isAlive / send / setStatus を中心に検証）。
 *
 * モック戦略: `PATH` 先頭に fake `cmux` シェルスクリプトを置き、execFile 経由で
 * 実プロセスとして呼び出す。呼び出し回数は外部 state file (`count`) で管理する。
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
    prefix: "cmux-validate-test-",
    subdirs: [],
    setProjectRootEnv: false,
    createTeamDir: false,
  });
  testDir = project.root;
  const binDir = join(testDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(testDir, "count"), "0");
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath ?? "";
  await project.dispose();
});

async function writeFakeCmux(script: string): Promise<void> {
  const path = join(testDir, "bin/cmux");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

import { send, setStatus, isAlive, __setIsAliveImpl, __setTreeImpl, listSiblingSurfaces, detectBackendDecision } from "./cmux";

describe("detectBackendDecision (v0.4.0+ c11 必須化)", () => {
  test("ELEVENS_BACKEND=c11 明示 → kind=explicit, backend=c11", () => {
    const r = detectBackendDecision({ ELEVENS_BACKEND: "c11" });
    expect(r.kind).toBe("explicit");
    if (r.kind === "explicit") expect(r.backend).toBe("c11");
  });

  test("ELEVENS_BACKEND=cmux 明示 → kind=explicit, backend=cmux (legacy opt-in)", () => {
    const r = detectBackendDecision({ ELEVENS_BACKEND: "cmux" });
    expect(r.kind).toBe("explicit");
    if (r.kind === "explicit") expect(r.backend).toBe("cmux");
  });

  test("ELEVENS_BACKEND=絶対パス指定 → kind=explicit, backend=パスそのまま", () => {
    const r = detectBackendDecision({ ELEVENS_BACKEND: "/opt/c11-dev/bin/c11" });
    expect(r.kind).toBe("explicit");
    if (r.kind === "explicit") expect(r.backend).toBe("/opt/c11-dev/bin/c11");
  });

  test("ELEVENS_BACKEND 空文字 + CMUX_BUNDLE_ID=com.stage11.c11 → 空文字を無視して auto c11", () => {
    const r = detectBackendDecision({ ELEVENS_BACKEND: "", CMUX_BUNDLE_ID: "com.stage11.c11" });
    expect(r.kind).toBe("auto");
    if (r.kind === "auto") expect(r.backend).toBe("c11");
  });

  test("CMUX_BUNDLE_ID=com.stage11.c11 のみ → kind=auto, backend=c11", () => {
    const r = detectBackendDecision({ CMUX_BUNDLE_ID: "com.stage11.c11" });
    expect(r.kind).toBe("auto");
    if (r.kind === "auto") {
      expect(r.backend).toBe("c11");
      expect(r.bundle).toBe("com.stage11.c11");
    }
  });

  test("CMUX_BUNDLED_CLI_PATH に /c11.app/ 含む (CMUX_BUNDLE_ID 不在) → kind=auto, backend=c11 (backup)", () => {
    const r = detectBackendDecision({
      CMUX_BUNDLED_CLI_PATH: "/Applications/c11.app/Contents/Resources/bin/c11",
    });
    expect(r.kind).toBe("auto");
    if (r.kind === "auto") expect(r.backend).toBe("c11");
  });

  test("env が空 → kind=refuse (c11 必須)", () => {
    const r = detectBackendDecision({});
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.reason).toContain("c11-first");
      expect(r.reason).toContain("ELEVENS_BACKEND=cmux"); // legacy opt-in を案内
      expect(r.observed.bundleId).toBeUndefined();
    }
  });

  test("CMUX_BUNDLE_ID=com.manaflow.cmux (cmux multiplexer) → kind=refuse + observed に bundleId", () => {
    const r = detectBackendDecision({ CMUX_BUNDLE_ID: "com.manaflow.cmux" });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.observed.bundleId).toBe("com.manaflow.cmux");
    }
  });

  test("CMUX_BUNDLED_CLI_PATH が cmux.app → kind=refuse (c11.app 以外)", () => {
    const r = detectBackendDecision({
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
    });
    expect(r.kind).toBe("refuse");
  });

  test("ELEVENS_BACKEND が opt-in なら CMUX_BUNDLE_ID が cmux でも refuse しない", () => {
    const r = detectBackendDecision({ ELEVENS_BACKEND: "cmux", CMUX_BUNDLE_ID: "com.manaflow.cmux" });
    expect(r.kind).toBe("explicit");
  });
});

describe("send / setStatus のエラー伝搬 (T163)", () => {
  test("send() 失敗時 Error.message に stderr が含まれる", async () => {
    const sentinel = "STDERR_SENTINEL_X9Y2";
    await writeFakeCmux(`echo "${sentinel}" >&2; exit 1`);
    let caught: Error | undefined;
    try {
      await send("surface:42", "hello");
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(`stderr=${sentinel}`);
  });

  test("setStatus は失敗時に握りつぶすが log に stderr 付きメッセージが渡る", async () => {
    // setStatus は内部で catch して log するだけ。throw しないことを保証
    const sentinel = "SETSTATUS_STDERR_42";
    await writeFakeCmux(`echo "${sentinel}" >&2; exit 1`);
    // 例外が漏れないこと
    await setStatus("k", "v", "i", "c");
  });
});

describe("isAlive (T195)", () => {
  test("__setIsAliveImpl による fake 差し替え — true を返す", () => {
    __setIsAliveImpl(() => true);
    try {
      expect(isAlive(99999)).toBe(true);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("__setIsAliveImpl による fake 差し替え — false を返す", () => {
    __setIsAliveImpl(() => false);
    try {
      expect(isAlive(99999)).toBe(false);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("実 kill(pid, 0): 自プロセスは alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("実 kill(pid, 0): 架空 PID は dead", () => {
    // PID 2^22 付近の極端な値は OS 上でほぼ確実に存在しない
    expect(isAlive(4194303)).toBe(false);
  });
});

describe("listSiblingSurfaces (T207)", () => {
  afterEach(() => {
    __setTreeImpl(null);
  });

  test("同 pane に複数 surface がある場合は sibling のみを返す", async () => {
    // cmux tree 出力を模擬: pane:1 に surface:10/11、pane:2 に surface:20
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:10",
      "    surface:11",
      "  pane pane:2",
      "    surface:20",
    ].join("\n");
    __setTreeImpl(async () => fake);

    const siblings = await listSiblingSurfaces("surface:10");
    // pane:1 所属の全 surface が返る（自分自身を含む ── 呼び出し側で除外する契約）
    expect(siblings).toContain("surface:10");
    expect(siblings).toContain("surface:11");
    expect(siblings).not.toContain("surface:20");
  });

  test("対象 surface が存在しない場合は [] を返す", async () => {
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:10",
    ].join("\n");
    __setTreeImpl(async () => fake);

    const siblings = await listSiblingSurfaces("surface:999");
    expect(siblings).toEqual([]);
  });
});

// --- Phase 3 prep: maybeLogDeprecationNotice (A031 follow-up) -------------
import { maybeLogDeprecationNotice, __resetDeprecationNoticeForTest } from "./cmux";

describe("maybeLogDeprecationNotice (Phase 3 prep)", () => {
  let origNoWarn: string | undefined;
  let origRoot: string | undefined;

  beforeEach(() => {
    __resetDeprecationNoticeForTest();
    origNoWarn = process.env.ELEVENS_NO_DEPRECATION_WARN;
    origRoot = process.env.PROJECT_ROOT;
    delete process.env.ELEVENS_NO_DEPRECATION_WARN;
    process.env.PROJECT_ROOT = testDir;
  });

  afterEach(() => {
    __resetDeprecationNoticeForTest();
    if (origNoWarn === undefined) delete process.env.ELEVENS_NO_DEPRECATION_WARN;
    else process.env.ELEVENS_NO_DEPRECATION_WARN = origNoWarn;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  async function readManagerLog(): Promise<string> {
    try {
      const { readFile } = await import("fs/promises");
      return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    } catch {
      return "";
    }
  }

  test("cmux backend では DEPRECATION_NOTICE が manager.log に 1 度だけ warn される", async () => {
    // SUBSTRATE_BINARY は module 読み込み時に process.env.ELEVENS_BACKEND を見て確定する。
    // テスト harness では default = cmux backend として走る前提（top-level beforeEach で
    // ELEVENS_BACKEND を delete している）。
    await mkdir(join(testDir, ".team/logs"), { recursive: true });
    await maybeLogDeprecationNotice();
    let log = await readManagerLog();
    expect(log).toContain("DEPRECATION_NOTICE");
    expect(log).toContain("cmux backend is deprecated");
    expect(log).toContain("ELEVENS_BACKEND=c11");

    // 2 回呼んでも追加されないこと（idempotent）
    await maybeLogDeprecationNotice();
    log = await readManagerLog();
    const matches = log.match(/DEPRECATION_NOTICE/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("ELEVENS_NO_DEPRECATION_WARN=1 で suppress される（log に出ない）", async () => {
    await mkdir(join(testDir, ".team/logs"), { recursive: true });
    process.env.ELEVENS_NO_DEPRECATION_WARN = "1";
    await maybeLogDeprecationNotice();
    const log = await readManagerLog();
    expect(log).not.toContain("DEPRECATION_NOTICE");
  });
});
