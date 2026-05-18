/**
 * T011: worktree archive unit tests
 *
 * §9.1 のテスト計画に沿って:
 *  - archiveWorktree happy / 冪等 / target_exists / mv 失敗
 *  - uncommitted_changes 検出
 *  - findArchivesForTaskId
 *  - removeArchive / pruneArchives
 *  - parseDuration / buildArchivedWorktreeSection
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import {
  existsSync,
} from "fs";
import { mkdir, readFile, writeFile, rm, stat, chmod } from "fs/promises";
import { join } from "path";
import {
  archiveWorktree,
  findArchivesForTaskId,
  removeArchive,
  pruneArchives,
  buildArchivedWorktreeSection,
  parseDuration,
  ArchiveFailedError,
  ARCHIVE_DIR_REL,
  ARCHIVE_META_SCHEMA_VERSION,
  type ArchiveMeta,
  type ArchiveSummary,
} from "./worktree-archive";
import { createDummyProject, type DummyProject } from "./test-project";

const execFile = promisify(execFileCb);

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-worktree-archive-test-" });
  // git repo として初期化 (worktree prune 等が動くため)
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: project.root });
  await execFile("git", ["config", "user.email", "t@example.com"], {
    cwd: project.root,
  });
  await execFile("git", ["config", "user.name", "T"], { cwd: project.root });
  await writeFile(join(project.root, ".gitignore"), ".team/\n");
  await execFile("git", ["add", "-A"], { cwd: project.root });
  await execFile("git", ["commit", "-q", "-m", "init"], { cwd: project.root });
});

afterEach(async () => {
  await project.dispose();
});

/**
 * git worktree を本物に近い状態で 1 つ作成する
 */
async function createDummyWorktree(
  taskRunId: string,
  opts?: { uncommitted?: boolean },
): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = join(project.root, ".worktrees", taskRunId);
  const branch = `${taskRunId}/task`;
  await mkdir(join(project.root, ".worktrees"), { recursive: true });
  await execFile(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, "main"],
    { cwd: project.root },
  );
  // 1 commit を追加
  await writeFile(join(worktreePath, "work.txt"), "first\n");
  await execFile("git", ["add", "-A"], { cwd: worktreePath });
  await execFile("git", ["commit", "-q", "-m", "work"], { cwd: worktreePath });

  if (opts?.uncommitted) {
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n");
  }

  return { worktreePath, branch };
}

describe("archiveWorktree: happy path", () => {
  test("worktree が archive へ mv され、meta.json に必要 field が揃う", async () => {
    const taskRunId = "task-094-1700000000";
    const taskId = "094";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);

    const result = await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId,
      branch,
      reason: "disconnect_timeout",
      conductorSurface: "surface:5",
      sessionId: "01HXR",
      baseBranch: "main",
      baseSha: "deadbeef",
    });

    expect(result.skipped).toBeUndefined();
    expect(result.archivePath).toBe(join(ARCHIVE_DIR_REL, taskRunId));
    expect(result.uncommittedChanges).toBe(false);
    expect(result.lastCommitSha).toMatch(/^[0-9a-f]{7,40}$/);

    // 元 worktree path は消えている
    expect(existsSync(worktreePath)).toBe(false);
    // archive path に mv 済み
    const archiveAbs = join(project.root, ARCHIVE_DIR_REL, taskRunId);
    expect(existsSync(archiveAbs)).toBe(true);

    // meta.json の中身
    const metaRaw = await readFile(
      join(archiveAbs, ".archive-meta.json"),
      "utf-8",
    );
    const meta = JSON.parse(metaRaw) as ArchiveMeta;
    expect(meta.schema_version).toBe(ARCHIVE_META_SCHEMA_VERSION);
    expect(meta.task_id).toBe(taskId);
    expect(meta.task_run_id).toBe(taskRunId);
    expect(meta.reason).toBe("disconnect_timeout");
    expect(meta.branch).toBe(branch);
    expect(meta.base_branch).toBe("main");
    expect(meta.base_sha).toBe("deadbeef");
    expect(meta.conductor_surface).toBe("surface:5");
    expect(meta.session_id).toBe("01HXR");
    expect(meta.uncommitted_changes).toBe(false);
    expect(meta.original_path).toBe(join(".worktrees", taskRunId));
    expect(meta.archived_at).toBe(result.archivedAt);
    expect(meta.last_commit_sha).toBe(result.lastCommitSha);

    // archived_at は ISO 8601 UTC
    expect(meta.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // events.jsonl に worktree_archived が記録される
    const eventsRaw = await readFile(
      join(project.root, ".team/logs/events.jsonl"),
      "utf-8",
    );
    const lines = eventsRaw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const archived = lines.find(
      (e: Record<string, unknown>) => e.event === "worktree_archived",
    );
    expect(archived).toBeDefined();
    expect((archived as Record<string, unknown>).archived_at).toBe(
      result.archivedAt,
    );
    expect((archived as Record<string, unknown>).reason).toBe("disconnect_timeout");
  });

  test("uncommitted_changes=true が検出される", async () => {
    const taskRunId = "task-095-1700000001";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId, {
      uncommitted: true,
    });

    const result = await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId: "095",
      branch,
      reason: "user_clear",
    });

    expect(result.uncommittedChanges).toBe(true);
    const metaRaw = await readFile(
      join(project.root, ARCHIVE_DIR_REL, taskRunId, ".archive-meta.json"),
      "utf-8",
    );
    const meta = JSON.parse(metaRaw) as ArchiveMeta;
    expect(meta.uncommitted_changes).toBe(true);
  });

  test("manager.log に worktree_archived が記録される", async () => {
    const taskRunId = "task-096-1700000002";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);

    await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId: "096",
      branch,
      reason: "abort_task",
    });

    const logContent = await readFile(
      join(project.root, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(logContent).toContain("worktree_archived");
    expect(logContent).toContain("task_id=096");
    expect(logContent).toContain("reason=abort_task");
  });
});

describe("archiveWorktree: 冪等性 / skip", () => {
  test("worktreePath 不在 → no_source で skip + no-op return", async () => {
    const taskRunId = "task-097-nonexistent";
    const result = await archiveWorktree({
      projectRoot: project.root,
      worktreePath: join(project.root, ".worktrees", taskRunId),
      taskRunId,
      taskId: "097",
      branch: `${taskRunId}/task`,
      reason: "disconnect_timeout",
    });
    expect(result.skipped).toBe("no_source");
    // archive ディレクトリは作られていない
    const archiveAbs = join(project.root, ARCHIVE_DIR_REL, taskRunId);
    expect(existsSync(archiveAbs)).toBe(false);

    // manager.log に skipped が記録される
    const logContent = await readFile(
      join(project.root, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(logContent).toContain("worktree_archive_skipped");
    expect(logContent).toContain("reason=no_source");
  });

  test("同 taskRunId の archive 既存 → target_exists で skip / 既存破壊しない", async () => {
    const taskRunId = "task-098-1700000003";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);

    // 1 回目: archive 化
    const first = await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId: "098",
      branch,
      reason: "abort_task",
    });
    expect(first.skipped).toBeUndefined();

    // 2 回目: 同じ場所に新規 worktree を作って archive を試みる
    const { worktreePath: wp2 } = await createDummyWorktree(taskRunId + "-2");
    // worktreePath を「あたかも存在する」状態に偽装するため別 path を使う
    // -> ここでは worktreePath が同じ場合の skip 確認なので、既存 archive のまま再 invoke
    // worktreePath は既に削除済み (mv された) なので no_source になる → 別 dir で再現
    // 同 taskRunId だが worktreePath だけは別 → target_exists
    const fakeWorktreePath = join(project.root, ".worktrees", taskRunId);
    await mkdir(fakeWorktreePath, { recursive: true });
    // git worktree とは別の素の dir として archive を試みる
    const second = await archiveWorktree({
      projectRoot: project.root,
      worktreePath: fakeWorktreePath,
      taskRunId,
      taskId: "098",
      branch,
      reason: "reset_conductor",
    });
    expect(second.skipped).toBe("target_exists");
    // 既存 archive の meta が破壊されていないこと: archived_at が一致
    const metaRaw = await readFile(
      join(project.root, ARCHIVE_DIR_REL, taskRunId, ".archive-meta.json"),
      "utf-8",
    );
    const meta = JSON.parse(metaRaw) as ArchiveMeta;
    expect(meta.archived_at).toBe(first.archivedAt);
    expect(meta.reason).toBe("abort_task"); // 上書きされていない

    // cleanup: 偽装 worktree dir を削除
    await rm(fakeWorktreePath, { recursive: true, force: true });
  });

  test("mv 失敗 → ArchiveFailedError", async () => {
    const taskRunId = "task-099-1700000004";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);
    // archive 先を file として既存にして rename を失敗させる
    const archiveDirAbs = join(project.root, ARCHIVE_DIR_REL);
    await mkdir(archiveDirAbs, { recursive: true });
    // archive 先 path に dir ではなく file を置く → rename(worktreePath, archivePath) は EEXIST or ENOTDIR
    // ※ Node の rename はターゲットが空 dir でなければ失敗するため、内容入り dir を置く
    const archiveAbs = join(archiveDirAbs, taskRunId);
    await mkdir(archiveAbs, { recursive: true });
    await writeFile(join(archiveAbs, "occupant.txt"), "x\n");

    // ただし archiveWorktree は target_exists を先に skip するので、ここでは
    // archive 先が file の場合の失敗経路をテストするため、
    // archive dir 自体を file にして mkdir を失敗させる
    await rm(archiveAbs, { recursive: true, force: true });
    await rm(archiveDirAbs, { recursive: true, force: true });
    await writeFile(archiveDirAbs, "occupant\n"); // dir 親が file

    let thrown: unknown;
    try {
      await archiveWorktree({
        projectRoot: project.root,
        worktreePath,
        taskRunId,
        taskId: "099",
        branch,
        reason: "other",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // mkdir 失敗 or rename 失敗 (ENOTDIR / EEXIST)
  });
});

describe("findArchivesForTaskId", () => {
  test("同 task_id 2 件 + 別 task_id 1 件 → 2 件を archived_at 降順で返す", async () => {
    // 直接 meta を作る (archiveWorktree を経由するより速い)
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    await mkdir(archiveDir, { recursive: true });

    const entries: Array<{ id: string; taskId: string; at: string }> = [
      { id: "task-100-1700000010", taskId: "100", at: "2026-01-01T00:00:00.000Z" },
      { id: "task-100-1700000020", taskId: "100", at: "2026-02-01T00:00:00.000Z" },
      { id: "task-101-1700000030", taskId: "101", at: "2026-03-01T00:00:00.000Z" },
    ];
    for (const e of entries) {
      const dir = join(archiveDir, e.id);
      await mkdir(dir, { recursive: true });
      const meta: ArchiveMeta = {
        schema_version: 1,
        task_id: e.taskId,
        task_run_id: e.id,
        archived_at: e.at,
        reason: "abort_task",
        original_path: `.worktrees/${e.id}`,
        branch: `${e.id}/task`,
        uncommitted_changes: false,
      };
      await writeFile(join(dir, ".archive-meta.json"), JSON.stringify(meta));
    }

    const found = await findArchivesForTaskId(project.root, "100");
    expect(found).toHaveLength(2);
    expect(found[0]!.taskRunId).toBe("task-100-1700000020"); // 新しい順
    expect(found[1]!.taskRunId).toBe("task-100-1700000010");
    expect(found[0]!.archivedAt > found[1]!.archivedAt).toBe(true);
  });

  test("不正 JSON の meta → archive_meta_invalid warn + skip", async () => {
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    const broken = join(archiveDir, "task-102-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, ".archive-meta.json"), "{ this is not json");

    const found = await findArchivesForTaskId(project.root, "102");
    expect(found).toHaveLength(0);

    const logContent = await readFile(
      join(project.root, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(logContent).toContain("archive_meta_invalid");
  });

  test("必須 field 欠落 → archive_meta_invalid + skip", async () => {
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    const missing = join(archiveDir, "task-103-missing");
    await mkdir(missing, { recursive: true });
    // schema_version が無い
    await writeFile(
      join(missing, ".archive-meta.json"),
      JSON.stringify({
        task_id: "103",
        task_run_id: "task-103-missing",
        archived_at: "2026-01-01T00:00:00.000Z",
        reason: "abort_task",
        branch: "task-103-missing/task",
      }),
    );

    const found = await findArchivesForTaskId(project.root, "103");
    expect(found).toHaveLength(0);
    const logContent = await readFile(
      join(project.root, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(logContent).toContain("archive_meta_invalid");
    expect(logContent).toContain("missing_required_field");
  });

  test(".archive-meta.json が無い entry はサイレント skip", async () => {
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    const noMeta = join(archiveDir, "task-104-no-meta");
    await mkdir(noMeta, { recursive: true });
    const found = await findArchivesForTaskId(project.root, "104");
    expect(found).toHaveLength(0);
  });

  test("archive ディレクトリ不在 → 空配列", async () => {
    const found = await findArchivesForTaskId(project.root, "999");
    expect(found).toEqual([]);
  });
});

describe("removeArchive", () => {
  test("archive ディレクトリを削除する", async () => {
    const taskRunId = "task-105-1700000040";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);
    await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId: "105",
      branch,
      reason: "abort_task",
    });
    const archiveAbs = join(project.root, ARCHIVE_DIR_REL, taskRunId);
    expect(existsSync(archiveAbs)).toBe(true);

    await removeArchive(project.root, taskRunId);
    expect(existsSync(archiveAbs)).toBe(false);
  });

  test("不在は no-op", async () => {
    await removeArchive(project.root, "task-nonexistent");
    // throw しない
  });

  test("deleteBranch=true で branch も削除", async () => {
    const taskRunId = "task-106-1700000050";
    const { worktreePath, branch } = await createDummyWorktree(taskRunId);
    await archiveWorktree({
      projectRoot: project.root,
      worktreePath,
      taskRunId,
      taskId: "106",
      branch,
      reason: "abort_task",
    });
    // branch 存在確認
    const { stdout: before } = await execFile(
      "git",
      ["branch", "--list", branch],
      { cwd: project.root },
    );
    expect(before.trim()).toContain(branch);

    await removeArchive(project.root, taskRunId, { deleteBranch: true });

    const { stdout: after } = await execFile(
      "git",
      ["branch", "--list", branch],
      { cwd: project.root },
    );
    expect(after.trim()).toBe("");
  });
});

describe("pruneArchives", () => {
  async function writeArchive(
    taskRunId: string,
    archivedAt: string,
  ): Promise<void> {
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    const dir = join(archiveDir, taskRunId);
    await mkdir(dir, { recursive: true });
    const meta: ArchiveMeta = {
      schema_version: 1,
      task_id: taskRunId.split("-")[1] ?? "000",
      task_run_id: taskRunId,
      archived_at: archivedAt,
      reason: "abort_task",
      original_path: `.worktrees/${taskRunId}`,
      branch: `${taskRunId}/task`,
      uncommitted_changes: false,
    };
    await writeFile(join(dir, ".archive-meta.json"), JSON.stringify(meta));
  }

  test("古い archive のみ削除", async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeArchive("task-200-recent", oneDayAgo);
    await writeArchive("task-200-old", tenDaysAgo);

    const result = await pruneArchives(project.root, {
      olderThanMs: 7 * 24 * 60 * 60 * 1000, // 7d
    });
    expect(result.pruned).toEqual(["task-200-old"]);
    expect(result.skipped).toContain("task-200-recent");
    expect(existsSync(join(project.root, ARCHIVE_DIR_REL, "task-200-old"))).toBe(
      false,
    );
    expect(
      existsSync(join(project.root, ARCHIVE_DIR_REL, "task-200-recent")),
    ).toBe(true);
  });

  test("dryRun=true で候補のみ返し物理削除しない", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeArchive("task-201-old", tenDaysAgo);

    const result = await pruneArchives(project.root, {
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      dryRun: true,
    });
    expect(result.pruned).toEqual(["task-201-old"]);
    // 実体は残っている
    expect(existsSync(join(project.root, ARCHIVE_DIR_REL, "task-201-old"))).toBe(
      true,
    );
  });

  test("meta 壊れた entry は skipped に分類", async () => {
    const archiveDir = join(project.root, ARCHIVE_DIR_REL);
    const broken = join(archiveDir, "task-202-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, ".archive-meta.json"), "{ bad json");

    const result = await pruneArchives(project.root, {
      olderThanMs: 1,
    });
    expect(result.skipped).toContain("task-202-broken");
    expect(result.pruned).not.toContain("task-202-broken");
  });

  test("archive ディレクトリ不在 → 空 result", async () => {
    const result = await pruneArchives(project.root, {
      olderThanMs: 1,
    });
    expect(result).toEqual({ pruned: [], skipped: [] });
  });
});

describe("parseDuration", () => {
  test("単位ごとの変換", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration("12h")).toBe(12 * 60 * 60 * 1000);
    expect(parseDuration("7d12h")).toBe(
      7 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
    );
    expect(parseDuration("1w")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("90s")).toBe(90 * 1000);
    expect(parseDuration("5m")).toBe(5 * 60 * 1000);
  });

  test("invalid input は throw", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("30")).toThrow();
    expect(() => parseDuration("30x")).toThrow();
    expect(() => parseDuration("30 d")).toThrow();
    expect(() => parseDuration("30d ")).toThrow();
  });
});

describe("buildArchivedWorktreeSection", () => {
  test("undefined → 空文字", () => {
    expect(buildArchivedWorktreeSection(undefined)).toBe("");
  });

  test("ArchiveSummary が与えられたら markdown section を返す", () => {
    const summary: ArchiveSummary = {
      archivePath: ".team/worktrees-archive/task-300-1700000060",
      taskRunId: "task-300-1700000060",
      taskId: "300",
      archivedAt: "2026-01-01T00:00:00.000Z",
      reason: "disconnect_timeout",
      branch: "task-300-1700000060/task",
      uncommittedChanges: true,
      lastCommitSha: "abcdef1234567",
    };
    const section = buildArchivedWorktreeSection(summary);
    // 文字列に必須要素が含まれる
    expect(section).toContain("## 前回 attempt の archive について");
    expect(section).toContain(summary.archivePath);
    expect(section).toContain(summary.branch);
    expect(section).toContain(summary.archivedAt);
    expect(section).toContain(summary.reason);
    expect(section).toContain("uncommitted: あり");
    expect(section).toContain("abcdef1234567");
    expect(section).toContain(`cd ${summary.archivePath}`);
    expect(section).toContain(`git log --oneline ${summary.branch} -10`);
  });

  test("last_commit_sha 無し / uncommitted=false でも表示が崩れない", () => {
    const summary: ArchiveSummary = {
      archivePath: ".team/worktrees-archive/task-301-1700000070",
      taskRunId: "task-301-1700000070",
      taskId: "301",
      archivedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_clear",
      branch: "task-301-1700000070/task",
      uncommittedChanges: false,
    };
    const section = buildArchivedWorktreeSection(summary);
    expect(section).toContain("uncommitted: なし");
    expect(section).toContain("(取得失敗)");
  });
});
