/**
 * T035: ready-guard.ts（ready 昇格 sync guard 共有モジュール）のテスト。
 *
 * 旧 `main.ts:runSyncCheckOrExit` から抽出した `runReadySyncGuard` が
 * 同一セマンティクス（verdict 分岐 / log / events.jsonl emit / bypass）を
 * 保持していることを git 注入 + temp project で検証する。
 *
 * 注意（design-review R1）: `log` / `emitEvent` の出力先は
 * `process.env.PROJECT_ROOT || process.cwd()` で解決される。
 * createDummyProject は default で PROJECT_ROOT を temp root に set/restore する
 * （setProjectRootEnv: true）ため、manager.log / events.jsonl の検証は
 * temp root 配下のファイルを読む。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { runReadySyncGuard } from "./ready-guard";
import { createDummyProject, type DummyProject } from "./test-project";

/** collectSyncFacts の git コマンド列に応答する fake git */
interface FakeGitOpts {
  /** symbolic-ref の結果。null で throw（= detached） */
  branch?: string | null;
  /** status --porcelain が dirty 出力を返すか */
  dirty?: boolean;
  /** null で rev-parse --verify refs/remotes/origin/<main> が throw（= origin に無い） */
  originSha?: string | null;
  /** null で rev-parse --verify refs/heads/<main> が throw（= local に無い） */
  localSha?: string | null;
  /** merge-base --is-ancestor origin/<main> <main> が成功するか */
  originAncestorOfLocal?: boolean;
  /** merge-base --is-ancestor <main> origin/<main> が成功するか */
  localAncestorOfOrigin?: boolean;
}

function makeFakeGit(opts: FakeGitOpts) {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === "fetch") return "";
    if (cmd === "rev-parse" && args[1] === "--verify") {
      const ref = args[3] ?? "";
      if (ref.startsWith("refs/remotes/origin/")) {
        if (opts.originSha == null) throw new Error("no origin ref");
        return opts.originSha;
      }
      if (opts.localSha == null) throw new Error("no local ref");
      return opts.localSha;
    }
    if (cmd === "symbolic-ref") {
      if (opts.branch == null) throw new Error("detached");
      return opts.branch;
    }
    if (cmd === "status") return opts.dirty ? " M file.txt" : "";
    if (cmd === "rev-parse") {
      const ref = args[1] ?? "";
      if (ref.startsWith("origin/")) {
        if (opts.originSha == null) throw new Error("no origin");
        return opts.originSha;
      }
      if (opts.localSha == null) throw new Error("no local");
      return opts.localSha;
    }
    if (cmd === "merge-base") {
      // args: ["merge-base", "--is-ancestor", A, B]
      const a = args[2] ?? "";
      if (a.startsWith("origin/")) {
        if (opts.originAncestorOfLocal) return "";
        throw new Error("not ancestor");
      }
      if (opts.localAncestorOfOrigin) return "";
      throw new Error("not ancestor");
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { git, calls };
}

/** よく使う sync 状態の fake git プリセット */
const PRESET = {
  clean: { branch: "main", dirty: false, originSha: "aaa", localSha: "aaa" },
  ahead: {
    branch: "main",
    dirty: false,
    originSha: "aaa",
    localSha: "bbb",
    originAncestorOfLocal: true,
    localAncestorOfOrigin: false,
  },
  uncommitted: { branch: "main", dirty: true, originSha: "aaa", localSha: "aaa" },
  diverged: {
    branch: "main",
    dirty: false,
    originSha: "aaa",
    localSha: "bbb",
    originAncestorOfLocal: false,
    localAncestorOfOrigin: false,
  },
  detached: { branch: null, originSha: "aaa", localSha: "aaa" },
  behindFf: {
    branch: "main",
    dirty: false,
    originSha: "bbb",
    localSha: "aaa",
    originAncestorOfLocal: false,
    localAncestorOfOrigin: true,
  },
  behindFfOtherBranch: {
    branch: "feature/x",
    originSha: "bbb",
    localSha: "aaa",
    originAncestorOfLocal: false,
    localAncestorOfOrigin: true,
  },
  noRemote: { branch: "main", dirty: false, originSha: null, localSha: "aaa" },
} satisfies Record<string, FakeGitOpts>;

let project: DummyProject;
// Conductor/Agent 実行環境には CMUX_TEAM_SKIP_SYNC_CHECK=1 が自動注入されるため
// （CLAUDE.md §Ready 昇格時の sync state ガード）、guard 本体の分岐を検証する
// テストでは明示的に unset し、afterEach で復元する。
let savedSkipEnv: string | undefined;

beforeEach(async () => {
  savedSkipEnv = process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
  delete process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
  project = await createDummyProject({
    prefix: "ready-guard-test-",
    seedConfigJson: { mainBranch: "main" },
  });
});

afterEach(async () => {
  await project.dispose();
  if (savedSkipEnv !== undefined) process.env.CMUX_TEAM_SKIP_SYNC_CHECK = savedSkipEnv;
  else delete process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
});

function baseOpts(over: Partial<Parameters<typeof runReadySyncGuard>[1]> = {}) {
  return {
    status: "ready" as string | undefined,
    forceFlag: false,
    skipFetch: true,
    noAutoPull: false,
    phase: "update" as const,
    taskId: "035",
    ...over,
  };
}

async function readManagerLog(): Promise<string> {
  const p = join(project.teamDir, "logs", "manager.log");
  if (!existsSync(p)) return "";
  return readFile(p, "utf-8");
}

describe("runReadySyncGuard: skip 経路", () => {
  test("status !== ready → 即 ok、git は呼ばれない", async () => {
    const { git, calls } = makeFakeGit(PRESET.clean);
    const r = await runReadySyncGuard(project.root, baseOpts({ status: "draft", git }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notices).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("forceFlag → ok + ready_force_bypass ログ", async () => {
    const { git, calls } = makeFakeGit(PRESET.uncommitted);
    const r = await runReadySyncGuard(project.root, baseOpts({ forceFlag: true, git }));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(0);
    const logText = await readManagerLog();
    expect(logText).toContain("ready_force_bypass");
    expect(logText).toContain("task_id=035");
  });

  test("CMUX_TEAM_SKIP_SYNC_CHECK=1 → ok + ready_sync_skipped ログ", async () => {
    const saved = process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
    process.env.CMUX_TEAM_SKIP_SYNC_CHECK = "1";
    try {
      const { git, calls } = makeFakeGit(PRESET.uncommitted);
      const r = await runReadySyncGuard(project.root, baseOpts({ git }));
      expect(r.ok).toBe(true);
      expect(calls.length).toBe(0);
      const logText = await readManagerLog();
      expect(logText).toContain("ready_sync_skipped");
      expect(logText).toContain("reason=env");
    } finally {
      if (saved !== undefined) process.env.CMUX_TEAM_SKIP_SYNC_CHECK = saved;
      else delete process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
    }
  });

  test("mainBranch 未設定 config → ok + ready_sync_skipped reason=no_main_branch", async () => {
    const bare = await createDummyProject({
      prefix: "ready-guard-nomain-",
      // config.json なし → loadConfig は {} を返す
    });
    try {
      const { git, calls } = makeFakeGit(PRESET.uncommitted);
      const r = await runReadySyncGuard(bare.root, baseOpts({ git }));
      expect(r.ok).toBe(true);
      expect(calls.length).toBe(0);
      const logText = await readFile(
        join(bare.teamDir, "logs", "manager.log"),
        "utf-8",
      );
      expect(logText).toContain("ready_sync_skipped");
      expect(logText).toContain("reason=no_main_branch");
    } finally {
      await bare.dispose();
    }
  });
});

describe("runReadySyncGuard: verdict 分岐", () => {
  test("clean → ok、notices 空", async () => {
    const { git } = makeFakeGit(PRESET.clean);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notices).toEqual([]);
  });

  test("ahead → ok、notices 空", async () => {
    const { git } = makeFakeGit(PRESET.ahead);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notices).toEqual([]);
  });

  test("uncommitted → ok:false、state=uncommitted、message に理由と Bypass ヒント", async () => {
    const { git } = makeFakeGit(PRESET.uncommitted);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.state).toBe("uncommitted");
      expect(r.message).toContain("uncommitted");
      expect(r.message).toContain("Bypass:");
    }
    const logText = await readManagerLog();
    expect(logText).toContain("ready_rejected");
    expect(logText).toContain("state=uncommitted");
  });

  test("diverged → ok:false", async () => {
    const { git } = makeFakeGit(PRESET.diverged);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.state).toBe("diverged");
  });

  test("detached → ok:false", async () => {
    const { git } = makeFakeGit(PRESET.detached);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.state).toBe("detached");
  });

  test("behind-ff + on-main + pull 成功 → ok、info notices（pre + 結果）", async () => {
    const { git } = makeFakeGit(PRESET.behindFf);
    const pullCalls: string[][] = [];
    const pullGit = async (args: string[]) => {
      pullCalls.push(args);
      return { stdout: "Fast-forward\n", stderr: "" };
    };
    const r = await runReadySyncGuard(project.root, baseOpts({ git, pullGit }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.notices.length).toBe(2);
      expect(r.notices[0]!.level).toBe("info");
      expect(r.notices[0]!.message).toContain("behind-ff");
      expect(r.notices[1]!.level).toBe("info");
      expect(r.notices[1]!.message).toContain("auto-pulled origin/main (fast-forward)");
    }
    expect(pullCalls.length).toBe(1);
    expect(pullCalls[0]).toEqual(["pull", "--ff-only", "origin", "main"]);
    const logText = await readManagerLog();
    expect(logText).toContain("ready_auto_pull_succeeded");
  });

  test("behind-ff + on-main + pull 失敗 → ok:false、state=auto_pull_failed、message に stderr", async () => {
    const { git } = makeFakeGit(PRESET.behindFf);
    const pullGit = async (_args: string[]) => {
      const e: any = new Error("pull failed");
      e.stdout = "";
      e.stderr = "fatal: Not possible to fast-forward, aborting.";
      throw e;
    };
    const r = await runReadySyncGuard(project.root, baseOpts({ git, pullGit }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.state).toBe("auto_pull_failed");
      expect(r.message).toContain("fatal: Not possible to fast-forward");
      expect(r.message).toContain("Bypass:");
      // inspection Finding #2: 失敗時も preMessage（behind-ff の案内行）が
      // notices に積まれ、呼び出し側がエラーより先に表示できる
      expect(r.notices.length).toBe(1);
      expect(r.notices[0]!.level).toBe("info");
      expect(r.notices[0]!.message).toContain("behind-ff");
    }
    const logText = await readManagerLog();
    expect(logText).toContain("ready_auto_pull_failed");
  });

  test("behind-ff + 他ブランチ checkout 中 → ok + warn notice", async () => {
    const { git } = makeFakeGit(PRESET.behindFfOtherBranch);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.notices.length).toBe(1);
      expect(r.notices[0]!.level).toBe("warn");
      expect(r.notices[0]!.message).toContain("behind-ff");
    }
    const logText = await readManagerLog();
    expect(logText).toContain("ready_warning");
  });

  test("no-remote → ok + warn notice", async () => {
    const { git } = makeFakeGit(PRESET.noRemote);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.notices.length).toBe(1);
      expect(r.notices[0]!.level).toBe("warn");
      expect(r.notices[0]!.message).toContain("no-remote");
    }
  });

  test("noAutoPull + behind-ff → ok + warn 2 件、pull は実行されない", async () => {
    const { git } = makeFakeGit(PRESET.behindFf);
    const pullCalls: string[][] = [];
    const pullGit = async (args: string[]) => {
      pullCalls.push(args);
      return { stdout: "", stderr: "" };
    };
    const r = await runReadySyncGuard(
      project.root,
      baseOpts({ git, pullGit, noAutoPull: true }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.notices.length).toBe(2);
      expect(r.notices.every((n) => n.level === "warn")).toBe(true);
      expect(r.notices[1]!.message).toContain("--no-auto-pull");
    }
    expect(pullCalls.length).toBe(0);
    const logText = await readManagerLog();
    expect(logText).toContain("reason=auto_pull_disabled");
  });
});

describe("runReadySyncGuard: events.jsonl emit", () => {
  test("reject 時に task_sync_guard_rejected が events.jsonl に append される", async () => {
    const { git } = makeFakeGit(PRESET.uncommitted);
    const r = await runReadySyncGuard(project.root, baseOpts({ git }));
    expect(r.ok).toBe(false);
    const eventsPath = join(project.teamDir, "logs", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const rejected = lines.filter((e) => e.event === "task_sync_guard_rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0].task_id).toBe("035");
    expect(rejected[0].kind).toBe("uncommitted");
    expect(rejected[0].main_branch).toBe("main");
    expect(rejected[0].detail).toContain("uncommitted");
  });

  test("auto-pull 失敗時に kind=auto_pull_failed の event が emit される", async () => {
    const { git } = makeFakeGit(PRESET.behindFf);
    const pullGit = async (_args: string[]) => {
      const e: any = new Error("pull failed");
      e.stdout = "";
      e.stderr = "fatal: refusing to merge";
      throw e;
    };
    const r = await runReadySyncGuard(project.root, baseOpts({ git, pullGit }));
    expect(r.ok).toBe(false);
    const eventsPath = join(project.teamDir, "logs", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const rejected = lines.filter((e) => e.event === "task_sync_guard_rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0].kind).toBe("auto_pull_failed");
    expect(rejected[0].detail).toContain("refusing to merge");
  });
});
