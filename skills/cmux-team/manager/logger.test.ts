import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { readFile, readFile as readFileAsync } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { log, warn, error, logSync, warnSync, errorSync, formatSurface, formatPair } from "./logger";
import { createDummyProject, type DummyProject } from "./test-project";

const SENTINEL = `regression_sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const cwdLogFile = join(process.cwd(), ".team/logs/manager.log");

async function countSentinelInCwdLog(): Promise<number> {
  try {
    const content = await readFile(cwdLogFile, "utf-8");
    const matches = content.match(new RegExp(SENTINEL, "g"));
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

let baselineSentinelCount = 0;

beforeAll(async () => {
  baselineSentinelCount = await countSentinelInCwdLog();
});

afterAll(async () => {
  const after = await countSentinelInCwdLog();
  expect(after).toBe(baselineSentinelCount);
});

// 遅延評価テストは test 本体で process.env.PROJECT_ROOT を都度切り替える必要があるため、
// helper には setProjectRootEnv: false を指定し env mutation を委譲しない。
// 代わりに savedProjectRoot を手動で save/restore する（テスト本体の挙動は従来通り）。
let projectA: DummyProject;
let projectB: DummyProject;
let tmpdirA: string;
let tmpdirB: string;
let savedProjectRoot: string | undefined;

beforeEach(async () => {
  savedProjectRoot = process.env.PROJECT_ROOT;
  projectA = await createDummyProject({
    prefix: "cmux-logger-test-a-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  projectB = await createDummyProject({
    prefix: "cmux-logger-test-b-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  tmpdirA = projectA.root;
  tmpdirB = projectB.root;
});

afterEach(async () => {
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
  await projectA.dispose();
  await projectB.dispose();
});

describe("formatSurface", () => {
  test('"surface:665" と role "C" → "C[665]"', () => {
    expect(formatSurface("surface:665", "C")).toBe("C[665]");
  });
  test('"665" と role "A" → "A[665]"', () => {
    expect(formatSurface("665", "A")).toBe("A[665]");
  });
  test('空文字 → ""', () => {
    expect(formatSurface("", "C")).toBe("");
  });
  test('undefined → ""', () => {
    expect(formatSurface(undefined, "C")).toBe("");
  });
  test('"surface:999" と role "S" → "S[999]"', () => {
    expect(formatSurface("surface:999", "S")).toBe("S[999]");
  });
  test('role "M" / "U" も使える', () => {
    expect(formatSurface("surface:10", "M")).toBe("M[10]");
    expect(formatSurface("surface:20", "U")).toBe("U[20]");
  });
  test("冪等性: すでに C[665] 形式のものはそのまま扱えること", () => {
    // 念のため surface:C[665] のような異常入力では prefix を除いた数値部分のみ抽出
    // 設計上の主要経路は生 ID を渡すので厳密なガードは不要だが、挙動を固定
    expect(formatSurface("C[665]", "C")).toBe("C[665]");
  });

  // T266: optional uuid 引数で末尾 6 文字・大文字化を末尾に付与する
  test("uuid 未指定なら従来通り", () => {
    expect(formatSurface("surface:192", "C", undefined)).toBe("C[192]");
  });
  test("uuid を渡すと末尾 6 文字を大文字で付与", () => {
    expect(formatSurface("surface:192", "C", "abcdef12-3456-7890-abcd-ef0122d8f9")).toBe("C[192/22D8F9]");
  });
  test("uuid 短い場合（6文字未満）は全体を大文字で付与", () => {
    expect(formatSurface("surface:10", "A", "a1b2c")).toBe("A[10/A1B2C]");
  });
  test("uuid 空文字は付与しない", () => {
    expect(formatSurface("surface:10", "A", "")).toBe("A[10]");
  });
});

describe("formatPair", () => {
  test('両方ある → "C[665]>A[719]"', () => {
    expect(formatPair("surface:665", "surface:719", "C", "A")).toBe("C[665]>A[719]");
  });
  test('parent 空 → child 側のみ', () => {
    expect(formatPair("", "surface:719", "C", "A")).toBe("A[719]");
  });
  test('child 空 → parent 側のみ', () => {
    expect(formatPair("surface:665", "", "C", "A")).toBe("C[665]");
  });
  test('両方空 → ""', () => {
    expect(formatPair("", "", "C", "A")).toBe("");
  });
  test("undefined 混在", () => {
    expect(formatPair(undefined, "surface:719", "C", "A")).toBe("A[719]");
    expect(formatPair("surface:665", undefined, "C", "A")).toBe("C[665]");
    expect(formatPair(undefined, undefined, "C", "A")).toBe("");
  });
});

describe("logger - PROJECT_ROOT 遅延評価", () => {
  test("log() 呼び出し時に PROJECT_ROOT を都度評価する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_case1`;
    await log(event, "detail=1");

    const logPath = join(tmpdirA, ".team/logs/manager.log");
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain(event);
    expect(content).toContain("detail=1");
  });

  test("同一プロセス内で PROJECT_ROOT を切り替えると書き込み先も切り替わる", async () => {
    const eventA = `${SENTINEL}_event_A`;
    const eventB = `${SENTINEL}_event_B`;

    process.env.PROJECT_ROOT = tmpdirA;
    await log(eventA, "from=A");

    process.env.PROJECT_ROOT = tmpdirB;
    await log(eventB, "from=B");

    const logA = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    const logB = await readFile(join(tmpdirB, ".team/logs/manager.log"), "utf-8");

    expect(logA).toContain(eventA);
    expect(logA).not.toContain(eventB);
    expect(logB).toContain(eventB);
    expect(logB).not.toContain(eventA);
  });

  test("PROJECT_ROOT を tmpdir に向けた log() 呼び出しが cwd の manager.log を汚染しない", async () => {
    const before = await countSentinelInCwdLog();

    process.env.PROJECT_ROOT = tmpdirA;
    await log(`${SENTINEL}_case3`, "detail=3");

    const after = await countSentinelInCwdLog();
    expect(after).toBe(before);
  });
});

// T409: log / warn / error の level prefix と既存互換の検証
describe("logger - warn / error level", () => {
  test("warn() は [warn] prefix 付きで manager.log に append する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_warn1`;
    await warn(event, "from=warn-test");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[warn] ${event}`);
    expect(content).toContain("from=warn-test");
  });

  test("error() は [error] prefix 付きで manager.log に append する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_error1`;
    await error(event, "from=error-test");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[error] ${event}`);
    expect(content).toContain("from=error-test");
  });

  test("log() は従来通り prefix なしで append する（互換）", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_info_compat`;
    await log(event, "from=info-compat");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    // prefix なし行であること（[warn] / [error] が event と timestamp の間に居ない）
    expect(content).toMatch(new RegExp(`\\] ${event} from=info-compat`));
    expect(content).not.toMatch(new RegExp(`\\] \\[warn\\] ${event}`));
    expect(content).not.toMatch(new RegExp(`\\] \\[error\\] ${event}`));
  });
});

// T010 S1: sync API (critical path 用)
describe("logger - sync API (logSync / warnSync / errorSync)", () => {
  test("logSync() は appendFileSync ベースで PROJECT_ROOT 配下の manager.log に append する", () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_logsync_1`;
    logSync(event, "from=logsync-test");

    const content = readFileSync(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(event);
    expect(content).toContain("from=logsync-test");
    // info は prefix 無しの async 版と完全一致 format
    expect(content).toMatch(new RegExp(`\\] ${event} from=logsync-test`));
  });

  test("warnSync() は [warn] prefix で sync append する", () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_warnsync_1`;
    warnSync(event, "from=warnsync-test");

    const content = readFileSync(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[warn] ${event}`);
    expect(content).toContain("from=warnsync-test");
  });

  test("errorSync() は [error] prefix で sync append する", () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_errorsync_1`;
    errorSync(event, "from=errorsync-test");

    const content = readFileSync(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[error] ${event}`);
    expect(content).toContain("from=errorsync-test");
  });

  test("logSync() は ログディレクトリ未作成でも recursive: true で作って append する", () => {
    process.env.PROJECT_ROOT = tmpdirB; // 別ディレクトリ、未だ書いていない
    const event = `${SENTINEL}_logsync_mkdirp`;
    logSync(event);

    const content = readFileSync(join(tmpdirB, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(event);
  });

  test("CMUX_TEAM_LOGGER_STRICT=1 で PROJECT_ROOT 未設定なら logSync() は throw する", () => {
    delete process.env.PROJECT_ROOT;
    const prev = process.env.CMUX_TEAM_LOGGER_STRICT;
    process.env.CMUX_TEAM_LOGGER_STRICT = "1";
    try {
      expect(() => logSync(`${SENTINEL}_strict`)).toThrow(
        /PROJECT_ROOT is not set/,
      );
    } finally {
      if (prev !== undefined) {
        process.env.CMUX_TEAM_LOGGER_STRICT = prev;
      } else {
        delete process.env.CMUX_TEAM_LOGGER_STRICT;
      }
    }
  });

  test("logSync() / log() の出力 format が一致する (timestamp prefix 形式)", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_format_parity`;
    logSync(event, "k=v");
    await log(event + "_async", "k=v");

    const content = readFileSync(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    // 両方 同じ format: `[<ts>] <event> <detail>\n`
    const syncRe = new RegExp(`\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\] ${event} k=v\\n`);
    const asyncRe = new RegExp(`\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\] ${event}_async k=v\\n`);
    expect(content).toMatch(syncRe);
    expect(content).toMatch(asyncRe);
  });
});
