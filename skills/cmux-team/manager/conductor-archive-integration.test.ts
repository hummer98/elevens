/**
 * T011: resetConductor cleanupMode 経路の integration test (§9.4)
 *
 * 各 archive reason ごとに「実 git repo + worktree → resetConductor → archive 化」を観測する。
 * conductor.test.ts:T263 (preserveWorktree) のパターンを踏襲し、fs 上の副作用と
 * `.archive-meta.json` の中身、manager.log の `worktree_archived` 行で検証する。
 *
 * test 番号体系は plan §9.4 のとおり `archive-<reason>` で統一 [m4]。
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { resetConductor } from "./conductor";
import type { ConductorState } from "./schema";
import * as cmux from "./cmux";
import { ARCHIVE_DIR_REL, type ArchiveMeta } from "./worktree-archive";
import { createDummyProject, type DummyProject } from "./test-project";

const execFile = promisify(execFileCb);

let project: DummyProject;
let testDir: string;

let listSiblingsSpy: ReturnType<typeof spyOn>;
let closeSurfaceSpy: ReturnType<typeof spyOn>;
let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-conductor-archive-int-test-",
    subdirs: ["logs", "tasks"],
  });
  testDir = project.root;
  listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
  closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
  getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");

  // git init + initial commit
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
  await execFile("git", ["config", "user.email", "t@example.com"], { cwd: testDir });
  await execFile("git", ["config", "user.name", "T"], { cwd: testDir });
  await writeFile(join(testDir, "README.md"), "init\n");
  await execFile("git", ["add", "-A"], { cwd: testDir });
  await execFile("git", ["commit", "-q", "-m", "init"], { cwd: testDir });
});

afterEach(async () => {
  listSiblingsSpy.mockRestore();
  closeSurfaceSpy.mockRestore();
  getPaneForSurfaceSpy.mockRestore();
  await project.dispose();
});

async function setupWorktree(
  taskRunId: string,
): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = join(testDir, ".worktrees", taskRunId);
  const branch = `${taskRunId}/task`;
  await mkdir(join(testDir, ".worktrees"), { recursive: true });
  await execFile("git", ["worktree", "add", "-b", branch, worktreePath, "main"], {
    cwd: testDir,
  });
  // 1 commit を追加
  await writeFile(join(worktreePath, "work.txt"), "hello\n");
  await execFile("git", ["add", "-A"], { cwd: worktreePath });
  await execFile("git", ["commit", "-q", "-m", "work"], { cwd: worktreePath });
  return { worktreePath, branch };
}

function makeConductor(
  taskRunId: string,
  taskId: string,
  worktreePath: string,
): ConductorState {
  return {
    surface: `surface:archive-int-${taskId}`,
    startedAt: new Date().toISOString(),
    taskRunId,
    taskId,
    taskTitle: `archive-int ${taskId}`,
    worktreePath,
    agents: [],
    status: "running",
  };
}

async function readMeta(taskRunId: string): Promise<ArchiveMeta> {
  const path = join(testDir, ARCHIVE_DIR_REL, taskRunId, ".archive-meta.json");
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as ArchiveMeta;
}

async function readManagerLog(): Promise<string> {
  return readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
}

describe("T011: resetConductor cleanupMode archive 経路 (§9.4)", () => {
  test("archive-disconnect_timeout: archive 存在 / meta.reason / worktreePath が `.team/worktrees-archive/...` に移動", async () => {
    const taskRunId = "task-901-1700000901";
    const { worktreePath, branch } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "901", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
      cleanupMode: { kind: "archive", reason: "disconnect_timeout" },
    });

    // 元 worktree 消滅
    expect(existsSync(worktreePath)).toBe(false);
    // archive 存在
    const archiveAbs = join(testDir, ARCHIVE_DIR_REL, taskRunId);
    expect(existsSync(archiveAbs)).toBe(true);
    // meta
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("disconnect_timeout");
    expect(meta.branch).toBe(branch);
    // ConductorState は broken へ
    expect(conductor.status).toBe("broken");
  });

  test("archive-abort_task: meta.reason=abort_task / worktree archive に移動", async () => {
    const taskRunId = "task-902-1700000902";
    const { worktreePath, branch } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "902", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "reserved",
      reason: "abort_task",
      cleanupMode: { kind: "archive", reason: "abort_task" },
    });

    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(testDir, ARCHIVE_DIR_REL, taskRunId))).toBe(true);
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("abort_task");
    expect(meta.branch).toBe(branch);
    expect(conductor.status).toBe("reserved");
  });

  test("archive-reset_conductor: meta.reason=reset_conductor", async () => {
    const taskRunId = "task-903-1700000903";
    const { worktreePath } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "903", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "reserved",
      reason: "user_reset",
      cleanupMode: { kind: "archive", reason: "reset_conductor" },
    });

    expect(existsSync(worktreePath)).toBe(false);
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("reset_conductor");
  });

  test("archive-user_clear [C1]: 手動 /clear 経路で archive 化 / 進行中 worktree が消えないこと", async () => {
    const taskRunId = "task-904-1700000904";
    const { worktreePath } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "904", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "reserved",
      reason: "user_clear",
      cleanupMode: { kind: "archive", reason: "user_clear" },
    });

    // 進行中 worktree は archive に「保全」されている (= 無言で消えていない)
    expect(existsSync(worktreePath)).toBe(false);
    const archiveAbs = join(testDir, ARCHIVE_DIR_REL, taskRunId);
    expect(existsSync(archiveAbs)).toBe(true);
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("user_clear");
    // events.jsonl / manager.log にも user_clear が記録されている
    const logContent = await readManagerLog();
    expect(logContent).toContain("worktree_archived");
    expect(logContent).toContain("reason=user_clear");
  });

  test("archive-assign_terminal_race: meta.reason=assign_terminal_race", async () => {
    const taskRunId = "task-905-1700000905";
    const { worktreePath } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "905", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      cleanupMode: { kind: "archive", reason: "assign_terminal_race" },
    });

    expect(existsSync(worktreePath)).toBe(false);
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("assign_terminal_race");
  });

  test("archive-resume: broken 状態の conductor を resume → meta.reason=resume", async () => {
    const taskRunId = "task-906-1700000906";
    const { worktreePath } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "906", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "resume",
      cleanupMode: { kind: "archive", reason: "resume" },
    });

    expect(existsSync(worktreePath)).toBe(false);
    const meta = await readMeta(taskRunId);
    expect(meta.reason).toBe("resume");
  });

  test("regression-success-deletes: cleanupMode delete → archive されず worktree 削除", async () => {
    const taskRunId = "task-907-1700000907";
    // 既存 T263 と同じく commit を入れない (branch が main と同点で `-d` が通る)
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    const branch = `${taskRunId}/task`;
    await mkdir(join(testDir, ".worktrees"), { recursive: true });
    await execFile(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, "main"],
      { cwd: testDir },
    );

    const conductor = makeConductor(taskRunId, "907", worktreePath);
    await resetConductor(conductor, testDir, undefined, {
      cleanupMode: { kind: "delete", reason: "done_success" },
    });

    // worktree 削除されている
    expect(existsSync(worktreePath)).toBe(false);
    // archive は作られていない
    expect(existsSync(join(testDir, ARCHIVE_DIR_REL, taskRunId))).toBe(false);
    // branch も削除されている (delete 経路は branch -d も走る)
    const { stdout } = await execFile("git", ["branch", "--list", branch], {
      cwd: testDir,
    });
    expect(stdout.trim()).toBe("");
  });

  test("regression-judgment-preserves: cleanupMode preserve → worktree 温存 / archive なし", async () => {
    const taskRunId = "task-908-1700000908";
    const { worktreePath, branch } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "908", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      cleanupMode: { kind: "preserve" },
    });

    // worktree 温存
    expect(existsSync(worktreePath)).toBe(true);
    // archive 不在
    expect(existsSync(join(testDir, ARCHIVE_DIR_REL, taskRunId))).toBe(false);
    // branch 残存
    const { stdout } = await execFile("git", ["branch", "--list", branch], {
      cwd: testDir,
    });
    expect(stdout.trim()).toContain(branch);
    // log に worktree_preserved=true
    const logContent = await readManagerLog();
    expect(logContent).toContain("worktree_preserved=true");
  });

  test("legacy_fallback: cleanupMode 未指定で worktree が削除される (後方互換)", async () => {
    const taskRunId = "task-909-1700000909";
    const { worktreePath, branch } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "909", worktreePath);

    // cleanupMode 未指定 (旧呼び出し)
    await resetConductor(conductor, testDir, undefined, {});

    // worktree 削除
    expect(existsSync(worktreePath)).toBe(false);
    // archive は作られていない
    expect(existsSync(join(testDir, ARCHIVE_DIR_REL, taskRunId))).toBe(false);
    // [v2-m1] legacy_fallback log
    const logContent = await readManagerLog();
    expect(logContent).toContain("worktree_delete_legacy_fallback");
  });

  test("preserveWorktree=true (DEPRECATED) → kind=preserve と等価扱い", async () => {
    const taskRunId = "task-910-1700000910";
    const { worktreePath } = await setupWorktree(taskRunId);
    const conductor = makeConductor(taskRunId, "910", worktreePath);

    await resetConductor(conductor, testDir, undefined, {
      preserveWorktree: true,
    });

    // worktree 温存
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(testDir, ARCHIVE_DIR_REL, taskRunId))).toBe(false);
  });
});
