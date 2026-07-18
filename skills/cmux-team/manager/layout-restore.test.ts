/**
 * planLayoutRestore (T255) — pure function 単体テスト。
 *
 * マトリクス分類 (A〜E) と tree degrade、unmatched resume の集約を検証する。
 * 副作用検証 (cleanup / resume 起動 / state mutation) は daemon.test.ts 側の
 * initializeLayout 統合テスト (M6〜M16) でカバーする。
 */
import { describe, test, expect } from "bun:test";
import { planLayoutRestore } from "./layout-restore";
import type { ResumePlanItem } from "./conductor";

const ALL_ALIVE = (_pid: number) => true;
const ALL_DEAD = (_pid: number) => false;
const aliveOf = (...alivePids: number[]) => {
  const set = new Set(alivePids);
  return (pid: number) => set.has(pid);
};

const resume = (taskId: string, surfaceHint = ""): ResumePlanItem => ({
  taskId,
  taskRunId: `task-${taskId}-1700000000`,
  worktreePath: `/tmp/wt/${taskId}${surfaceHint}`,
  sessionId: `sess-${taskId}`,
  taskTitle: `t-${taskId}`,
});

describe("planLayoutRestore: マトリクス分類 (T255 §3.1)", () => {
  test("M1: A のみ — surface 実在 + pid alive 2 件", () => {
    const conductors = [
      { surface: "surface:100", pid: 1001 },
      { surface: "surface:101", pid: 1002 },
    ];
    const live = new Set(["surface:100", "surface:101"]);
    const plan = planLayoutRestore(conductors, live, aliveOf(1001, 1002), []);
    expect(plan.alive).toHaveLength(2);
    expect(plan.alive.every(e => e.decision === "keep-alive")).toBe(true);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M2: A 1件 + C 1件 — alive 1 + pid_dead surface 残骸 + task なし", () => {
    const conductors = [
      { surface: "surface:100", pid: 1001 },
      { surface: "surface:101", pid: 1002 },
    ];
    const live = new Set(["surface:100", "surface:101"]);
    // surface:100 alive、surface:101 pid 死亡
    const plan = planLayoutRestore(conductors, live, aliveOf(1001), []);
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.raw.surface).toBe("surface:100");
    expect(plan.cleanup).toEqual(["surface:101"]);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
  });

  test("M3: B 1件 — surface 実在 + pid_dead + running task", () => {
    const conductors = [
      { surface: "surface:200", pid: 2001, taskId: "042" },
    ];
    const live = new Set(["surface:200"]);
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, [resume("042")]);
    expect(plan.resumeExisting).toHaveLength(1);
    expect(plan.resumeExisting[0]!.decision).toBe("resume-existing");
    expect(plan.resumeExisting[0]!.resume?.taskId).toBe("042");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M4: D 1件 — surface 消失 + running task", () => {
    const conductors = [
      { surface: "surface:300", pid: 3001, taskId: "077" },
    ];
    const live = new Set<string>(); // surface 消失
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, [resume("077")]);
    expect(plan.resumeNewSurface).toHaveLength(1);
    expect(plan.resumeNewSurface[0]!.decision).toBe("resume-new-surface");
    expect(plan.resumeNewSurface[0]!.resume?.taskId).toBe("077");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M5: E 1件 — surface 消失 + task なし", () => {
    const conductors = [{ surface: "surface:400", pid: 4001 }];
    const live = new Set<string>();
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, []);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.surface).toBe("surface:400");
    expect(plan.discarded[0]!.reason).toBe("surface_missing_no_task");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
  });

  // T016: tree 失敗時の pid_only degrade は撤去 (v0.9.0+)。
  // 呼び出し元 (daemon.ts fetchLiveSurfacesWithRetry) が retry → exit 1 を担う。
  // planLayoutRestore は常に Set<string> を受け取る前提に変わったので、
  // 旧 "null degrade" テストは削除した。

  test("M12: team.json 空 + resumePlan 非空 → 全て unmatched", () => {
    const plan = planLayoutRestore(
      [],
      new Set<string>(),
      ALL_ALIVE,
      [resume("042"), resume("077")],
    );
    expect(plan.alive).toHaveLength(0);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(2);
    expect(plan.unmatchedResumes.map(r => r.taskId).sort()).toEqual(["042", "077"]);
  });

  test("再現バグ M6 のコア分類: pid_dead 2 件 + pid alive 1 件 + running task 1 件", () => {
    // 部分復元バグ — 旧コードは alive 1 件で early return してしまった。
    // pure 関数レベルでは「分類が正しく行われる」ことだけ確認し、
    // pane 補充の有無は initializeLayout 統合テストで検証する。
    const conductors = [
      { surface: "surface:600", pid: 6001 }, // alive
      { surface: "surface:601", pid: 6002, taskId: "111" }, // pid dead + running task → B
      { surface: "surface:602", pid: 6003 }, // pid dead + idle → C
    ];
    const live = new Set(["surface:600", "surface:601", "surface:602"]);
    const plan = planLayoutRestore(
      conductors,
      live,
      aliveOf(6001),
      [resume("111")],
    );
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.raw.surface).toBe("surface:600");
    expect(plan.resumeExisting).toHaveLength(1);
    expect(plan.resumeExisting[0]!.raw.surface).toBe("surface:601");
    expect(plan.cleanup).toEqual(["surface:602"]);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
  });

  test("surface 無しの entry はスキップ", () => {
    const plan = planLayoutRestore(
      [{ pid: 1 } as any, null, undefined, { surface: "" }] as any[],
      new Set<string>(),
      ALL_DEAD,
      [],
    );
    expect(plan.alive).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
  });

  test("pid フィールドが number でないなら pid dead 扱い", () => {
    const conductors = [{ surface: "surface:700", pid: null as any }];
    const live = new Set(["surface:700"]);
    const plan = planLayoutRestore(conductors, live, ALL_ALIVE, []);
    // pid null → pid dead → surface 実在 + idle → cleanup
    expect(plan.cleanup).toEqual(["surface:700"]);
  });
});

// T027: 「broken + surface 消失」は pidAlive 短絡より前に E (discard) に倒す。
// broken Conductor の pid は resetConductor が reserved 経路でのみクリアするため
// (conductor.ts:918-921)、team.json に live 値が残り続け、PID が他プロセスに
// recycle されると pidAlive=true で誤って A keep-alive に流入する。surface が
// tree に無ければ「過去 surface の残骸」確定なので早期 discard し、現役スロット
// (surface 実在) は従来通り pidAlive 判定に進める。
describe("planLayoutRestore: T027 broken+surface_missing 早期 discard", () => {
  test("status=broken + pidAlive=true + surface_missing → broken_surface_missing で discard", () => {
    const conductors = [
      { surface: "surface:27", pid: 27001, status: "broken" },
    ];
    const live = new Set<string>(); // surface 消失
    // pidAlive=true でも broken + surface_missing なら discard に倒す
    const plan = planLayoutRestore(conductors, live, aliveOf(27001), []);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.surface).toBe("surface:27");
    expect(plan.discarded[0]!.reason).toBe("broken_surface_missing");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
  });

  test("status=broken + pidAlive=false + surface_missing → broken_surface_missing で discard", () => {
    const conductors = [
      { surface: "surface:28", pid: 28001, status: "broken" },
    ];
    const live = new Set<string>();
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, []);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.surface).toBe("surface:28");
    expect(plan.discarded[0]!.reason).toBe("broken_surface_missing");
    expect(plan.alive).toHaveLength(0);
  });

  test("status=broken + surface_exists + pidAlive=true → 従来通り A keep-alive (現役 broken スロット温存)", () => {
    const conductors = [
      { surface: "surface:29", pid: 29001, status: "broken" },
    ];
    const live = new Set(["surface:29"]); // surface 実在
    const plan = planLayoutRestore(conductors, live, aliveOf(29001), []);
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.decision).toBe("keep-alive");
    expect(plan.alive[0]!.raw.surface).toBe("surface:29");
    expect(plan.discarded).toHaveLength(0);
  });

  test("status=broken + surface_exists + pidAlive=false → 従来通り C (pid_dead_idle_cleanup)", () => {
    const conductors = [
      { surface: "surface:30", pid: 30001, status: "broken" },
    ];
    const live = new Set(["surface:30"]);
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, []);
    // surface 実在 + pid 死亡 + task なし → C
    expect(plan.cleanup).toEqual(["surface:30"]);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
    expect(plan.alive).toHaveLength(0);
  });

  test("status=disconnected + pidAlive=true + surface_missing → 従来通り A (broken 以外は触らない)", () => {
    const conductors = [
      { surface: "surface:31", pid: 31001, status: "disconnected" },
    ];
    const live = new Set<string>();
    const plan = planLayoutRestore(conductors, live, aliveOf(31001), []);
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.decision).toBe("keep-alive");
    expect(plan.discarded).toHaveLength(0);
  });

  test("status=idle + pidAlive=true + surface_missing → 従来通り A (broken 以外は触らない)", () => {
    const conductors = [
      { surface: "surface:32", pid: 32001, status: "idle" },
    ];
    const live = new Set<string>();
    const plan = planLayoutRestore(conductors, live, aliveOf(32001), []);
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.decision).toBe("keep-alive");
    expect(plan.discarded).toHaveLength(0);
  });
});

describe("planLayoutRestore: daemon 自 surface の self-close guard", () => {
  // 回帰: 過去に Conductor だった surface で `elevens start` すると、pid_dead のまま
  //   残った entry が C (cleanup-stale) に分類され、daemon が起動直後に自分の pane を
  //   閉じて SIGTERM で自滅していた（Brainship 2026-07-18 23:59 / uptime 5s）。
  test("daemonSurface が C 分類に該当しても cleanup されず discard に倒れる", () => {
    const conductors = [{ surface: "surface:165", pid: 9001 }];
    const live = new Set(["surface:165"]);
    const plan = planLayoutRestore(
      conductors,
      live,
      ALL_DEAD,
      [],
      "surface:165",
    );
    // 自分の surface は絶対に閉じない
    expect(plan.cleanup).toHaveLength(0);
    // entry 自体は stale なので pool からは外す
    expect(plan.alive).toHaveLength(0);
    expect(plan.discarded).toEqual([
      { surface: "surface:165", reason: "daemon_surface_self_close_guard" },
    ]);
  });

  test("daemonSurface 以外の C 該当 surface は従来通り cleanup される", () => {
    const conductors = [
      { surface: "surface:165", pid: 9001 },
      { surface: "surface:166", pid: 9002 },
    ];
    const live = new Set(["surface:165", "surface:166"]);
    const plan = planLayoutRestore(
      conductors,
      live,
      ALL_DEAD,
      [],
      "surface:165",
    );
    expect(plan.cleanup).toEqual(["surface:166"]);
    expect(plan.discarded).toEqual([
      { surface: "surface:165", reason: "daemon_surface_self_close_guard" },
      { surface: "surface:166", reason: "pid_dead_idle_cleanup" },
    ]);
  });

  test("daemonSurface 未指定なら guard は無効（既存挙動を維持）", () => {
    const conductors = [{ surface: "surface:165", pid: 9001 }];
    const live = new Set(["surface:165"]);
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, []);
    expect(plan.cleanup).toEqual(["surface:165"]);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
  });

  test("daemonSurface が pid 生存なら A (keep-alive) のままで guard は介入しない", () => {
    const conductors = [{ surface: "surface:165", pid: 9001 }];
    const live = new Set(["surface:165"]);
    const plan = planLayoutRestore(
      conductors,
      live,
      aliveOf(9001),
      [],
      "surface:165",
    );
    expect(plan.alive).toHaveLength(1);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
  });
});
