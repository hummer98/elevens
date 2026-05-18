/**
 * T011: worktree archive CLI のテスト (§9.6)
 *
 * subprocess で main.ts を起動し、cli の出力 / exit code を検証する。
 * cli-project-root.test.ts と同じ subprocess パターン。
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFile = promisify(execFileCb);
const MAIN_TS = join(import.meta.dir, "main.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function setupProject(prefix = "cmux-archive-cli-"): Promise<{
  root: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".team/logs"), { recursive: true });
  await mkdir(join(root, ".team/tasks"), { recursive: true });
  await mkdir(join(root, ".team/queue"), { recursive: true });
  await mkdir(join(root, ".team/worktrees-archive"), { recursive: true });
  // git init
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "T"], { cwd: root });
  await writeFile(join(root, "README.md"), "init\n");
  await execFile("git", ["add", "-A"], { cwd: root });
  await execFile("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return {
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runCli(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const baseEnv = { ...process.env };
    delete baseEnv.PROJECT_ROOT;
    const proc = spawn("bun", ["run", MAIN_TS, ...args], {
      cwd,
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    proc.stdin.end();
  });
}

async function writeArchive(
  root: string,
  taskRunId: string,
  taskId: string,
  archivedAt: string,
  reason = "abort_task",
): Promise<void> {
  const dir = join(root, ".team/worktrees-archive", taskRunId);
  await mkdir(dir, { recursive: true });
  const branch = `${taskRunId}/task`;
  // git worktree add 経由で branch も実際に作っておく (show / remove --delete-branch 用)
  // archive 化を後追いで再現するために worktree を作って commit 入れて mv
  const tmpWorktree = join(root, ".worktrees", taskRunId);
  await mkdir(join(root, ".worktrees"), { recursive: true });
  try {
    await execFile("git", ["worktree", "add", "-b", branch, tmpWorktree, "main"], {
      cwd: root,
    });
  } catch {
    // 既存 branch 等で失敗したら無視 (test 内 race を想定しない)
  }
  // archive 用に dir を上書き作成
  const meta = {
    schema_version: 1,
    task_id: taskId,
    task_run_id: taskRunId,
    archived_at: archivedAt,
    reason,
    original_path: `.worktrees/${taskRunId}`,
    branch,
    uncommitted_changes: false,
  };
  await writeFile(
    join(dir, ".archive-meta.json"),
    JSON.stringify(meta, null, 2),
  );
  // tmpWorktree を消すと git worktree が dangling になる; prune
  try {
    await rm(tmpWorktree, { recursive: true, force: true });
    await execFile("git", ["worktree", "prune"], { cwd: root });
  } catch {
    // ignore
  }
}

describe("worktree archive CLI: list", () => {
  test("空 archive ディレクトリ → '(no archives)'", async () => {
    const proj = await setupProject("cmux-archive-cli-list-empty-");
    try {
      const r = await runCli(["worktree", "archive", "list"], proj.root);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("(no archives)");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("N 件の archive をテーブルで表示", async () => {
    const proj = await setupProject("cmux-archive-cli-list-n-");
    try {
      await writeArchive(
        proj.root,
        "task-300-1700000300",
        "300",
        "2026-01-01T00:00:00.000Z",
      );
      await writeArchive(
        proj.root,
        "task-301-1700000301",
        "301",
        "2026-01-02T00:00:00.000Z",
        "user_clear",
      );
      const r = await runCli(["worktree", "archive", "list"], proj.root);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("task-300-1700000300");
      expect(r.stdout).toContain("task-301-1700000301");
      expect(r.stdout).toContain("user_clear");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--task-id N で filter", async () => {
    const proj = await setupProject("cmux-archive-cli-list-filter-");
    try {
      await writeArchive(
        proj.root,
        "task-310-1700000310",
        "310",
        "2026-01-01T00:00:00.000Z",
      );
      await writeArchive(
        proj.root,
        "task-311-1700000311",
        "311",
        "2026-01-02T00:00:00.000Z",
      );
      const r = await runCli(
        ["worktree", "archive", "list", "--task-id", "310"],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("task-310-1700000310");
      expect(r.stdout).not.toContain("task-311-1700000311");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--format json で JSON 配列出力", async () => {
    const proj = await setupProject("cmux-archive-cli-list-json-");
    try {
      await writeArchive(
        proj.root,
        "task-320-1700000320",
        "320",
        "2026-01-01T00:00:00.000Z",
      );
      const r = await runCli(
        ["worktree", "archive", "list", "--format", "json"],
        proj.root,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].taskRunId).toBe("task-320-1700000320");
    } finally {
      await proj.dispose();
    }
  }, 30000);
});

describe("worktree archive CLI: show", () => {
  test("meta + git log を出力", async () => {
    const proj = await setupProject("cmux-archive-cli-show-");
    try {
      await writeArchive(
        proj.root,
        "task-330-1700000330",
        "330",
        "2026-01-01T00:00:00.000Z",
      );
      const r = await runCli(
        ["worktree", "archive", "show", "task-330-1700000330"],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("task-330-1700000330");
      expect(r.stdout).toContain("schema_version");
      // git log section も含まれる
      expect(r.stdout).toContain("git log");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("引数なし → exit 1", async () => {
    const proj = await setupProject("cmux-archive-cli-show-noarg-");
    try {
      const r = await runCli(["worktree", "archive", "show"], proj.root);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("taskRunId required");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("不在 → exit 1", async () => {
    const proj = await setupProject("cmux-archive-cli-show-missing-");
    try {
      const r = await runCli(
        ["worktree", "archive", "show", "task-999-missing"],
        proj.root,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("archive not found");
    } finally {
      await proj.dispose();
    }
  }, 30000);
});

describe("worktree archive CLI: remove", () => {
  test("archive を削除する", async () => {
    const proj = await setupProject("cmux-archive-cli-remove-");
    try {
      await writeArchive(
        proj.root,
        "task-340-1700000340",
        "340",
        "2026-01-01T00:00:00.000Z",
      );
      const archiveAbs = join(
        proj.root,
        ".team/worktrees-archive/task-340-1700000340",
      );
      expect(existsSync(archiveAbs)).toBe(true);
      const r = await runCli(
        ["worktree", "archive", "remove", "task-340-1700000340"],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("OK removed task-340-1700000340");
      expect(existsSync(archiveAbs)).toBe(false);
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--delete-branch で branch も削除", async () => {
    const proj = await setupProject("cmux-archive-cli-remove-branch-");
    try {
      await writeArchive(
        proj.root,
        "task-341-1700000341",
        "341",
        "2026-01-01T00:00:00.000Z",
      );
      // 事前 assert: branch 存在
      const { stdout: before } = await execFile(
        "git",
        ["branch", "--list", "task-341-1700000341/task"],
        { cwd: proj.root },
      );
      expect(before.trim()).toContain("task-341-1700000341/task");

      const r = await runCli(
        [
          "worktree",
          "archive",
          "remove",
          "task-341-1700000341",
          "--delete-branch",
        ],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("(with branch)");

      const { stdout: after } = await execFile(
        "git",
        ["branch", "--list", "task-341-1700000341/task"],
        { cwd: proj.root },
      );
      expect(after.trim()).toBe("");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("不在 → OK noop", async () => {
    const proj = await setupProject("cmux-archive-cli-remove-noop-");
    try {
      const r = await runCli(
        ["worktree", "archive", "remove", "task-999-nonexistent"],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("OK noop");
    } finally {
      await proj.dispose();
    }
  }, 30000);
});

describe("worktree archive CLI: prune", () => {
  test("--dry-run → 候補のみ表示 / 物理削除しない", async () => {
    const proj = await setupProject("cmux-archive-cli-prune-dry-");
    try {
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await writeArchive(proj.root, "task-350-old", "350", tenDaysAgo);
      const r = await runCli(
        [
          "worktree",
          "archive",
          "prune",
          "--older-than",
          "7d",
          "--dry-run",
        ],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("dry-run");
      expect(r.stdout).toContain("task-350-old");
      expect(
        existsSync(join(proj.root, ".team/worktrees-archive/task-350-old")),
      ).toBe(true);
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--yes で実削除", async () => {
    const proj = await setupProject("cmux-archive-cli-prune-yes-");
    try {
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await writeArchive(proj.root, "task-351-old", "351", tenDaysAgo);
      const r = await runCli(
        ["worktree", "archive", "prune", "--older-than", "7d", "--yes"],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("OK pruned 1 archive(s)");
      expect(
        existsSync(join(proj.root, ".team/worktrees-archive/task-351-old")),
      ).toBe(false);
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--dry-run + --yes 併用は --dry-run を優先 [m9]", async () => {
    const proj = await setupProject("cmux-archive-cli-prune-dry-yes-");
    try {
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await writeArchive(proj.root, "task-352-old", "352", tenDaysAgo);
      const r = await runCli(
        [
          "worktree",
          "archive",
          "prune",
          "--older-than",
          "7d",
          "--dry-run",
          "--yes",
        ],
        proj.root,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("dry-run");
      // 物理削除されていない
      expect(
        existsSync(join(proj.root, ".team/worktrees-archive/task-352-old")),
      ).toBe(true);
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--older-than なし → exit 1", async () => {
    const proj = await setupProject("cmux-archive-cli-prune-noarg-");
    try {
      const r = await runCli(["worktree", "archive", "prune"], proj.root);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--older-than required");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("--yes / --dry-run なし → exit 1 (confirm 要求)", async () => {
    const proj = await setupProject("cmux-archive-cli-prune-confirm-");
    try {
      const r = await runCli(
        ["worktree", "archive", "prune", "--older-than", "7d"],
        proj.root,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("confirm with --yes");
    } finally {
      await proj.dispose();
    }
  }, 30000);
});

describe("worktree archive CLI: usage", () => {
  test("subcommand なし → usage 表示", async () => {
    const proj = await setupProject("cmux-archive-cli-usage-");
    try {
      const r = await runCli(["worktree"], proj.root);
      expect(r.stdout).toContain("Usage: elevens worktree archive");
    } finally {
      await proj.dispose();
    }
  }, 30000);
});
