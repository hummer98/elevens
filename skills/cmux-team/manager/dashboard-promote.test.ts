/**
 * T035: dashboard-promote.ts（TUI Tasks リストの draft → ready 昇格フロー）のテスト。
 *
 * decidePromote（pure 判定）と promoteTaskToReady（DI 副作用フロー）を
 * spy 化した deps fixture で検証する。末尾の統合テストのみ実 runReadySyncGuard +
 * fake git（dirty）で guard との結合を確認する。
 */
import { describe, test, expect } from "bun:test";
import type { TaskSummary } from "./daemon";
import {
  decidePromote,
  promoteTaskToReady,
  type PromoteDeps,
} from "./dashboard-promote";
import { runReadySyncGuard } from "./ready-guard";
import { withDummyProject } from "./test-project";

function makeTask(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "035",
    title: "promote test",
    status: "draft",
    createdAt: "2026-06-13T00:00:00+09:00",
    dependsOn: [],
    filePath: "/proj/.team/tasks/035-promote-test.md",
    ...over,
  };
}

interface DepsCalls {
  guard: Array<[string, unknown]>;
  apply: Array<[string, unknown]>;
  notify: Array<[string, string | undefined]>;
  toast: Array<[string, string, string | undefined]>;
  log: Array<[string, string]>;
}

function makeDeps(over: Partial<PromoteDeps> = {}): { deps: PromoteDeps; calls: DepsCalls } {
  const calls: DepsCalls = { guard: [], apply: [], notify: [], toast: [], log: [] };
  const deps: PromoteDeps = {
    projectRoot: "/proj",
    runGuard: async (root, opts) => {
      calls.guard.push([root, opts]);
      return { ok: true, notices: [] };
    },
    applyEvent: async (root, input) => {
      calls.apply.push([root, input]);
      return { committed: true } as any;
    },
    notifyTaskCreated: async (taskId, taskFile) => {
      calls.notify.push([taskId, taskFile]);
    },
    showToast: (kind, message, label) => {
      calls.toast.push([kind, message, label]);
    },
    log: (event, detail) => {
      calls.log.push([event, detail]);
    },
    ...over,
  };
  return { deps, calls };
}

describe("decidePromote (pure)", () => {
  test("undefined → no-task", () => {
    expect(decidePromote(undefined)).toEqual({ kind: "no-task" });
  });

  test("draft → promote（taskId / taskFile 引継ぎ。filePath → taskFile 写像）", () => {
    const d = decidePromote(makeTask());
    expect(d).toEqual({
      kind: "promote",
      taskId: "035",
      taskFile: "/proj/.team/tasks/035-promote-test.md",
    });
  });

  test("draft 以外の各 status → not-draft", () => {
    for (const status of ["ready", "assigned", "closed", "aborted"]) {
      const d = decidePromote(makeTask({ status }));
      expect(d).toEqual({ kind: "not-draft", taskId: "035", status });
    }
  });
});

describe("promoteTaskToReady", () => {
  test("no-task → silent no-op（toast なし、guard/apply 呼ばれない）", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await promoteTaskToReady(undefined, deps);
    expect(outcome).toBe("noop-no-task");
    expect(calls.guard.length).toBe(0);
    expect(calls.apply.length).toBe(0);
    expect(calls.toast.length).toBe(0);
  });

  test("not-draft → guard も applyEvent も呼ばれず、status 名入り error toast", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await promoteTaskToReady(makeTask({ status: "assigned" }), deps);
    expect(outcome).toBe("noop-not-draft");
    expect(calls.guard.length).toBe(0);
    expect(calls.apply.length).toBe(0);
    expect(calls.notify.length).toBe(0);
    expect(calls.toast.length).toBe(1);
    expect(calls.toast[0]![0]).toBe("error");
    expect(calls.toast[0]![1]).toContain("assigned");
    expect(calls.toast[0]![1]).toContain("035");
  });

  test("guard ok:false → applyEvent 呼ばれず、message 先頭行が error toast に渡る", async () => {
    const rejectMessage =
      "Error: uncommitted — main is checked out with a dirty working tree.\n\n  Recommended: git stash ...";
    const { deps, calls } = makeDeps({
      runGuard: async () => ({
        ok: false,
        state: "uncommitted",
        message: rejectMessage,
        notices: [],
      }),
    });
    const outcome = await promoteTaskToReady(makeTask(), deps);
    expect(outcome).toBe("rejected");
    expect(calls.apply.length).toBe(0);
    expect(calls.notify.length).toBe(0);
    expect(calls.toast.length).toBe(1);
    expect(calls.toast[0]![0]).toBe("error");
    expect(calls.toast[0]![1]).toBe(
      "Error: uncommitted — main is checked out with a dirty working tree.",
    );
    // 全文は manager.log（task_promote_rejected）に残す
    const rejectedLogs = calls.log.filter(([e]) => e === "task_promote_rejected");
    expect(rejectedLogs.length).toBe(1);
  });

  test("guard ok:false + notices（auto-pull 失敗）→ preMessage が log に流れる", async () => {
    // inspection Finding #2: 失敗経路でも preMessage（behind-ff 案内行）を観測可能にする
    const { deps, calls } = makeDeps({
      runGuard: async () => ({
        ok: false,
        state: "auto_pull_failed",
        message: "Error: auto git pull --ff-only origin main failed.\n  stderr: ...",
        notices: [
          { level: "info", message: "behind-ff — local main is behind origin/main; pulling…" },
        ],
      }),
    });
    const outcome = await promoteTaskToReady(makeTask(), deps);
    expect(outcome).toBe("rejected");
    const noticeLogs = calls.log.filter(([e]) => e === "task_promote_notice");
    expect(noticeLogs.length).toBe(1);
    expect(noticeLogs[0]![1]).toContain("level=info");
    expect(noticeLogs[0]![1]).toContain("behind-ff");
    // toast / rejected ログは従来どおり
    expect(calls.toast[0]![0]).toBe("error");
    const rejectedLogs = calls.log.filter(([e]) => e === "task_promote_rejected");
    expect(rejectedLogs.length).toBe(1);
  });

  test("guard ok → applyEvent が CLI と同一入力で呼ばれる（deep equal）", async () => {
    const { deps, calls } = makeDeps();
    await promoteTaskToReady(makeTask(), deps);
    expect(calls.apply.length).toBe(1);
    expect(calls.apply[0]![0]).toBe("/proj");
    expect(calls.apply[0]![1]).toEqual({
      taskId: "035",
      event: { type: "UPDATE_STATUS", to: "ready" },
      ctx: { hasConductor: false, parentAborted: false },
    });
    // guard も TUI 固定オプション（bypass なし）で呼ばれる
    expect(calls.guard.length).toBe(1);
    expect(calls.guard[0]![0]).toBe("/proj");
    expect(calls.guard[0]![1]).toEqual({
      status: "ready",
      forceFlag: false,
      skipFetch: false,
      noAutoPull: false,
      phase: "update",
      taskId: "035",
    });
  });

  test("成功 → notifyTaskCreated(taskId, taskFile) + success toast + promoted", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await promoteTaskToReady(makeTask(), deps);
    expect(outcome).toBe("promoted");
    expect(calls.notify).toEqual([["035", "/proj/.team/tasks/035-promote-test.md"]]);
    expect(calls.toast.length).toBe(1);
    expect(calls.toast[0]![0]).toBe("success");
    expect(calls.toast[0]![1]).toContain("035");
  });

  test("guard の warn notices は log に渡り、昇格は続行する", async () => {
    const { deps, calls } = makeDeps({
      runGuard: async () => ({
        ok: true,
        notices: [{ level: "warn", message: "warning: no-remote — origin/main missing" }],
      }),
    });
    const outcome = await promoteTaskToReady(makeTask(), deps);
    expect(outcome).toBe("promoted");
    const noticeLogs = calls.log.filter(([e]) => e === "task_promote_notice");
    expect(noticeLogs.length).toBe(1);
    expect(noticeLogs[0]![1]).toContain("no-remote");
  });

  test("applyEvent committed:false（race）→ notify 呼ばれず error toast + conflict", async () => {
    const { deps, calls } = makeDeps({
      applyEvent: async () => ({ committed: false }) as any,
    });
    const outcome = await promoteTaskToReady(makeTask(), deps);
    expect(outcome).toBe("conflict");
    expect(calls.notify.length).toBe(0);
    expect(calls.toast.length).toBe(1);
    expect(calls.toast[0]![0]).toBe("error");
    expect(calls.toast[0]![1]).toContain("035");
  });

  test("統合: 実 runReadySyncGuard + fake git（dirty）→ uncommitted 拒否が toast に出る", async () => {
    const savedSkip = process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
    delete process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
    try {
      await withDummyProject(
        async (project) => {
          // collectSyncFacts の git 列に「on-main + dirty」を応答する fake
          const dirtyGit = async (args: string[]): Promise<string> => {
            const cmd = args[0];
            if (cmd === "rev-parse" && args[1] === "--verify") return "aaa";
            if (cmd === "symbolic-ref") return "main";
            if (cmd === "status") return " M file.txt";
            if (cmd === "rev-parse") return "aaa";
            if (cmd === "merge-base") return "";
            return "";
          };
          const { deps, calls } = makeDeps({
            projectRoot: project.root,
            runGuard: (root, opts) =>
              runReadySyncGuard(root, { ...opts, skipFetch: true, git: dirtyGit }),
          });
          const outcome = await promoteTaskToReady(makeTask(), deps);
          expect(outcome).toBe("rejected");
          expect(calls.apply.length).toBe(0);
          expect(calls.toast.length).toBe(1);
          expect(calls.toast[0]![0]).toBe("error");
          expect(calls.toast[0]![1]).toContain("uncommitted");
        },
        { prefix: "promote-integ-", seedConfigJson: { mainBranch: "main" } },
      );
    } finally {
      if (savedSkip !== undefined) process.env.CMUX_TEAM_SKIP_SYNC_CHECK = savedSkip;
      else delete process.env.CMUX_TEAM_SKIP_SYNC_CHECK;
    }
  });
});
