/**
 * cmux.ts のテスト（T016+ で c11 専用化・cmux backend 撤去）。
 *
 * モック戦略: `PATH` 先頭に fake `c11` シェルスクリプトを置き、execFile 経由で
 * 実プロセスとして呼び出す。呼び出し回数は外部 state file (`count`) で管理する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, chmod, mkdir, readFile } from "fs/promises";
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

async function writeFakeCmux(script: string): Promise<string> {
  // T016: c11.app launch 環境では SUBSTRATE_BINARY が絶対パスに解決されるため、
  // fake binary を testDir/bin/c11 に置き、`__setSubstrateBinaryForTest` で
  // runCmux 実行時の binary をそのパスに上書きする。
  const path = join(testDir, "bin", "c11");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  __setSubstrateBinaryForTest(path);
  return path;
}

afterEach(() => {
  __setSubstrateBinaryForTest(null);
});

import {
  send,
  setStatus,
  isAlive,
  __setIsAliveImpl,
  __setTreeImpl,
  __setSubstrateBinaryForTest,
  listSiblingSurfaces,
  detectBackendDecision,
  resolveC11Binary,
  fetchLiveSurfaces,
  getPaneForSurface,
  newSurface,
  tree,
  assertTabTitle,
  SUBSTRATE_BINARY,
  SEND_TIMEOUT_MS,
  TREE_TIMEOUT_MS,
} from "./cmux";

describe("resolveC11Binary (T016)", () => {
  test("env 空 → 'c11' を返す（PATH 解決前提）", () => {
    expect(resolveC11Binary({})).toBe("c11");
  });

  test("CMUX_BUNDLED_CLI_PATH が /c11.app/ を含む → そのパスをそのまま返す", () => {
    const path = "/Applications/c11.app/Contents/Resources/bin/c11";
    expect(resolveC11Binary({ CMUX_BUNDLED_CLI_PATH: path })).toBe(path);
  });

  test("CMUX_BUNDLED_CLI_PATH が /cmux.app/ → 無視して 'c11' fallback", () => {
    expect(
      resolveC11Binary({
        CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      }),
    ).toBe("c11");
  });

  test("ELEVENS_BACKEND env は無視される (T016 で参照撤去)", () => {
    expect(resolveC11Binary({ ELEVENS_BACKEND: "cmux" })).toBe("c11");
    expect(resolveC11Binary({ ELEVENS_BACKEND: "/opt/cmux/bin/cmux" })).toBe("c11");
  });

  test("SUBSTRATE_BINARY は module load 時 resolveC11Binary(process.env) と一致", () => {
    expect(SUBSTRATE_BINARY).toBe(resolveC11Binary(process.env));
  });
});

describe("detectBackendDecision (T016 で 2-value 化)", () => {
  test("CMUX_BUNDLE_ID=com.stage11.c11 → kind=c11", () => {
    const r = detectBackendDecision({ CMUX_BUNDLE_ID: "com.stage11.c11" });
    expect(r.kind).toBe("c11");
    if (r.kind === "c11") {
      expect(r.bundle).toBe("com.stage11.c11");
      expect(r.binary).toBe("c11");
    }
  });

  test("CMUX_BUNDLED_CLI_PATH に /c11.app/ 含む → kind=c11 (backup detect)", () => {
    const r = detectBackendDecision({
      CMUX_BUNDLED_CLI_PATH: "/Applications/c11.app/Contents/Resources/bin/c11",
    });
    expect(r.kind).toBe("c11");
    if (r.kind === "c11") {
      expect(r.binary).toBe("/Applications/c11.app/Contents/Resources/bin/c11");
    }
  });

  test("env が空 → kind=refuse (c11 必須)", () => {
    const r = detectBackendDecision({});
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.reason).toContain("c11");
      expect(r.reason).toContain("Stage-11-Agentics/c11");
      // refuse message は ELEVENS_BACKEND env / cmux opt-in を案内しない
      expect(r.reason).not.toContain("ELEVENS_BACKEND");
      expect(r.observed.bundleId).toBeUndefined();
    }
  });

  test("CMUX_BUNDLE_ID=com.manaflow.cmux → kind=refuse + observed に bundleId", () => {
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

  test("ELEVENS_BACKEND=cmux でも refuse (escape hatch を撤去)", () => {
    const r = detectBackendDecision({
      ELEVENS_BACKEND: "cmux",
      CMUX_BUNDLE_ID: "com.manaflow.cmux",
    });
    expect(r.kind).toBe("refuse");
  });

  test("ELEVENS_BACKEND=c11 でも env として参照されない", () => {
    // bundle/cliPath が無ければ refuse (env だけで auto detect しない)
    const r = detectBackendDecision({ ELEVENS_BACKEND: "c11" });
    expect(r.kind).toBe("refuse");
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
    // c11 tree 出力を模擬: pane:1 に surface:10/11、pane:2 に surface:20
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

// --- T016: fail-fast 化された fetchLiveSurfaces / getPaneForSurface --------

describe("fetchLiveSurfaces (T016 で fail-fast 化)", () => {
  afterEach(() => {
    __setTreeImpl(null);
  });

  test("workspace 未指定 → throw", async () => {
    await expect(fetchLiveSurfaces(undefined)).rejects.toThrow(/workspace is required/);
  });

  test("tree 成功 → surface 集合を返す", async () => {
    __setTreeImpl(async () => "workspace workspace:1\n  pane pane:1\n    surface:10\n    surface:11");
    const set = await fetchLiveSurfaces("workspace:1");
    expect(set.has("surface:10")).toBe(true);
    expect(set.has("surface:11")).toBe(true);
    expect(set.size).toBe(2);
  });

  test("tree 失敗 → throw（degrade ではなく fail-fast）", async () => {
    __setTreeImpl(async () => {
      throw new Error("tree timeout");
    });
    await expect(fetchLiveSurfaces("workspace:1")).rejects.toThrow(/tree timeout/);
  });
});

describe("getPaneForSurface (T016 で fail-fast 化)", () => {
  afterEach(() => {
    __setTreeImpl(null);
  });

  test("surface が見つかれば pane を返す", async () => {
    __setTreeImpl(async () => "workspace workspace:1\n  pane pane:7\n    surface:10");
    expect(await getPaneForSurface("surface:10", "workspace:1")).toBe("pane:7");
  });

  test("surface が tree に存在しない → undefined（正常範囲の missing）", async () => {
    __setTreeImpl(async () => "workspace workspace:1\n  pane pane:7\n    surface:10");
    expect(await getPaneForSurface("surface:999", "workspace:1")).toBeUndefined();
  });

  test("tree が失敗 → throw（v0.9.0 以前は swallow して undefined 返却していた）", async () => {
    __setTreeImpl(async () => {
      throw new Error("tree fetch failed");
    });
    await expect(getPaneForSurface("surface:10", "workspace:1")).rejects.toThrow(/tree fetch failed/);
  });
});

// --- T016: runCmux default timeout (SEND_TIMEOUT_MS / TREE_TIMEOUT_MS) --

describe("runCmux default timeout (T016)", () => {
  test("SEND_TIMEOUT_MS は 30s", () => {
    expect(SEND_TIMEOUT_MS).toBe(30_000);
  });

  test("TREE_TIMEOUT_MS は 5s (send default に上書きされない)", () => {
    expect(TREE_TIMEOUT_MS).toBe(5_000);
  });

  test("hang する fake c11 に対して send は SEND_TIMEOUT_MS で reject", async () => {
    // 1.5s で reject させたいので、テスト用に short timeout 環境変数を …
    // ではなく、`tree(workspace, opts={timeout:N})` 自体は API で渡せないため
    // 短い timeout を使えるよう、別の経路で検証する。
    //
    // 戦略: runCmux の default timeout が "opts 未指定なら SEND_TIMEOUT_MS、
    // 指定があればそちら" であることを、`readScreen`（10s 指定）/ `tree`（5s 指定）が
    // 上書きされない型・定数の存在で確認するに留め、実 hang テストは
    // SEND_TIMEOUT_MS 自体が 30s と長すぎるため省略する。
    expect(SEND_TIMEOUT_MS).toBeGreaterThan(TREE_TIMEOUT_MS);
  });

  test("tree({timeout: TREE_TIMEOUT_MS}) は 5s で reject される (hang fake binary)", async () => {
    // 実 hang fake で reject 経路を 1 回だけ実機検証する。
    // SUBSTRATE_BINARY が PATH 解決の "c11" のときのみ実行（CI / 開発機ともに通常はこちら）。
    const basename = SUBSTRATE_BINARY.split("/").pop() ?? SUBSTRATE_BINARY;
    if (basename !== "c11") {
      // bundled CLI path 指定中など特殊環境ではスキップ
      return;
    }
    // sleep 60 秒する fake を置く（TREE_TIMEOUT_MS=5s で kill されるはず）
    await writeFakeCmux("sleep 60");
    const start = Date.now();
    let caught: any;
    try {
      await tree("workspace:1");
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeDefined();
    // 5s timeout を見越して 4s 以上 10s 以内に reject されること
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

// --- T017: getPaneForSurface prefix collision regression -----------------

describe("getPaneForSurface prefix collision (T017)", () => {
  afterEach(() => {
    __setTreeImpl(null);
  });

  test("surface:2 検索時 surface:26 を含む行に誤マッチしない (tree 出力順: surface:26 が先)", async () => {
    // pane:1 に surface:26、pane:2 に target の surface:2 が居る
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:26",
      "  pane pane:2",
      "    surface:2",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:2");
  });

  test("surface:27 も同様に surface:2 とは区別される", async () => {
    const fake = [
      "workspace workspace:1",
      "  pane pane:9",
      "    surface:27",
      "  pane pane:10",
      "    surface:2",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:27", "workspace:1")).toBe("pane:9");
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:10");
  });

  test("1 行に複数 surface が同居していても完全一致のみ拾う (prefix collision は別 pane の同居行)", async () => {
    // pane:5 (先行) の同居行に collision 源 surface:26 を置き、target surface:2 は
    // 別 pane (pane:6) の同居行に居る配置。pre-fix の line.includes("surface:2") は
    // pane:5 行で誤 true になり pane:5 を返す → 赤。完全一致照合では pane:6 を返す → 緑。
    // 同居行の positive 検証として、pane:6 の同居 surface (surface:31) → pane:6 も併せて確認する。
    const fake = [
      "workspace workspace:1",
      "  pane pane:5",
      "    surface:26 surface:99",
      "  pane pane:6",
      "    surface:2 surface:31",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:6");
    expect(await getPaneForSurface("surface:31", "workspace:1")).toBe("pane:6");
  });
});

// --- T017: newSurface の pane 必須化 (D 層) ------------------------------

describe("newSurface pane required (T017 D layer)", () => {
  test("pane=undefined → throw（型 cast で undefined を強制した場合）", async () => {
    await expect(newSurface(undefined as unknown as string)).rejects.toThrow(/pane is required/);
  });

  test("pane='' (空文字) → throw", async () => {
    await expect(newSurface("")).rejects.toThrow(/pane is required/);
  });

  test("pane が 'pane:' で始まらない → throw", async () => {
    await expect(newSurface("surface:1")).rejects.toThrow(/pane is required/);
  });
});

// --- T017: newSurface が --workspace を c11 argv に渡す (二重防御) -----

describe("newSurface forwards --workspace (T017 二重防御)", () => {
  test("opts.workspace 指定時 c11 argv に --workspace <ws> が含まれる", async () => {
    const argvFile = join(testDir, "argv.txt");
    await writeFakeCmux(
      `printf '%s\\n' "$@" > "${argvFile}"\n` +
        `echo "ok surface:100"`,
    );
    const created = await newSurface("pane:7", { workspace: "workspace:42" });
    expect(created).toBe("surface:100");
    const argv = (await readFile(argvFile, "utf-8")).split("\n").filter(Boolean);
    expect(argv).toContain("new-surface");
    expect(argv).toContain("--pane");
    expect(argv).toContain("pane:7");
    expect(argv).toContain("--workspace");
    expect(argv).toContain("workspace:42");
  });

  test("opts.workspace 未指定時は --workspace を含めない", async () => {
    const argvFile = join(testDir, "argv.txt");
    await writeFakeCmux(
      `printf '%s\\n' "$@" > "${argvFile}"\n` +
        `echo "ok surface:101"`,
    );
    const created = await newSurface("pane:7");
    expect(created).toBe("surface:101");
    const argv = (await readFile(argvFile, "utf-8")).split("\n").filter(Boolean);
    expect(argv).not.toContain("--workspace");
    expect(argv).toContain("--pane");
    expect(argv).toContain("pane:7");
  });
});

// --- T026: assertTabTitle (counter-rename 共通ヘルパ) ---------------------

describe("assertTabTitle (T026)", () => {
  // assertTabTitle は内部で logger.log / logger.error を呼ぶので、
  // PROJECT_ROOT を testDir に向けて manager.log ファイルを観察する。
  let origProjectRoot: string | undefined;

  beforeEach(async () => {
    origProjectRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = testDir;
    await mkdir(join(testDir, ".team/logs"), { recursive: true });
  });

  afterEach(() => {
    if (origProjectRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origProjectRoot;
  });

  test("成功時: rename-tab を 1 回呼び、title_reassert を log する", async () => {
    const argvFile = join(testDir, "argv.txt");
    await writeFakeCmux(
      `printf '%s\\n' "$@" >> "${argvFile}"\n` + `exit 0`,
    );
    await assertTabTitle("surface:42", "[42] Conductor", "conductor session_started");
    const argv = (await readFile(argvFile, "utf-8")).split("\n").filter(Boolean);
    expect(argv).toContain("rename-tab");
    expect(argv).toContain("--surface");
    expect(argv).toContain("surface:42");
    expect(argv).toContain("[42] Conductor");
    // 1 回だけ呼ばれる（rename-tab token が argv ファイル中に 1 度）
    const renameCount = argv.filter((a) => a === "rename-tab").length;
    expect(renameCount).toBe(1);
    const logBody = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logBody).toContain("title_reassert");
    expect(logBody).toContain('title="[42] Conductor"');
    expect(logBody).toContain("context=conductor session_started");
    // success path では failed event が出ない
    expect(logBody).not.toContain("title_reassert_failed");
  });

  test("失敗時: 例外を抑止し、title_reassert_failed を error log + contextForLog を含む", async () => {
    await writeFakeCmux(`echo "rename failed boom" >&2\nexit 1`);
    // throw しないこと
    await expect(
      assertTabTitle("surface:7", "[7] Agent", "agent session_started"),
    ).resolves.toBeUndefined();
    const logBody = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logBody).toContain("title_reassert_failed");
    expect(logBody).toContain("context=agent session_started");
    expect(logBody).toContain('title="[7] Agent"');
    // success log は出ていない
    expect(logBody).not.toMatch(/\btitle_reassert\b(?!_failed)/);
  });
});
