/**
 * T255: initializeLayout 用の復帰アルゴリズム（pure function）
 *
 * team.json の conductors 配列を A〜E のマトリクスで分類する:
 *   A keep-alive          : surface 実在 + PID 生存
 *   B resume-existing     : surface 実在 + PID 死亡 + running task → 既存 pane に session-id resume
 *   C cleanup-stale       : surface 実在 + PID 死亡 + idle → 残骸 pane を close
 *   D resume-new-surface  : surface 消失 + running task → 新 pane + session-id resume
 *   E discard             : surface 消失 + idle → entry 破棄
 *
 * v0.9.0+ (T016): tree 失敗時の pid_only degrade を撤去。tree が取れないなら
 * daemon 起動を継続する判断を planLayoutRestore に委ねず、呼び出し元 (daemon.ts)
 * の retry → exit 1 経路に責任を持たせる。`liveSurfaces` は `Set<string>` 必須。
 *
 * 副作用なし（state mutation・I/O・ロギングは applyRestorePlan 側で担当）。
 */

import type { ResumePlanItem } from "./conductor";

export type RestoreDecision =
  | "keep-alive"
  | "resume-existing"
  | "cleanup-stale"
  | "resume-new-surface"
  | "discard";

export interface RestoreEntry {
  /** team.json から読み込んだ conductor の生データ（型は呼び出し側で詰め直す前提で any） */
  raw: any;
  decision: RestoreDecision;
  /** B / D の場合のみセット */
  resume?: ResumePlanItem;
}

export interface DiscardedEntry {
  surface: string;
  reason: string;
}

export interface LayoutRestorePlan {
  /** A: そのまま登録 */
  alive: RestoreEntry[];
  /** B: 既存 pane に対して session-id resume を送る */
  resumeExisting: RestoreEntry[];
  /** C: pid dead + idle の残骸 pane を close する surface 一覧 */
  cleanup: string[];
  /** D: 新 pane を作って session-id resume を送る */
  resumeNewSurface: RestoreEntry[];
  /** C / E の破棄理由ログ用 */
  discarded: DiscardedEntry[];
  /** team.json に未反映の assigned タスク（resumePlan にあるが conductors に紐付けが無い） */
  unmatchedResumes: ResumePlanItem[];
}

/**
 * team.json の conductors と resumePlan から復帰計画を組み立てる pure function。
 *
 * @param conductorsFromJson team.json.conductors 配列（要素は surface フィールドが無ければ無視）
 * @param liveSurfaces       c11 tree から取得した実在 surface の集合（必須。tree 失敗時は呼び出し元が exit 1 する）
 * @param isAlive            PID 生存判定（テスト時は mock で差し替える）
 * @param resumePlan         main.ts 側で worktree 実在 + sessionId 有を保証済みの resume 計画
 */
export function planLayoutRestore(
  conductorsFromJson: any[],
  liveSurfaces: Set<string>,
  isAlive: (pid: number) => boolean,
  resumePlan: ResumePlanItem[],
): LayoutRestorePlan {
  const alive: RestoreEntry[] = [];
  const resumeExisting: RestoreEntry[] = [];
  const cleanup: string[] = [];
  const resumeNewSurface: RestoreEntry[] = [];
  const discarded: DiscardedEntry[] = [];

  const resumeByTaskId = new Map<string, ResumePlanItem>();
  for (const r of resumePlan ?? []) {
    resumeByTaskId.set(r.taskId, r);
  }
  const matchedTaskIds = new Set<string>();

  for (const c of conductorsFromJson ?? []) {
    if (!c?.surface || typeof c.surface !== "string") continue;
    const pidAlive = typeof c.pid === "number" && isAlive(c.pid);
    const surfaceExists = liveSurfaces.has(c.surface);
    const taskId = typeof c.taskId === "string" ? c.taskId : undefined;
    const runningTask = !!(taskId && resumeByTaskId.has(taskId));

    // PID 生存 → A
    if (pidAlive) {
      alive.push({ raw: c, decision: "keep-alive" });
      if (runningTask) matchedTaskIds.add(taskId!);
      continue;
    }

    // ここから !pidAlive
    if (surfaceExists && runningTask) {
      // B: 既存 pane に対して session-id resume
      resumeExisting.push({
        raw: c,
        decision: "resume-existing",
        resume: resumeByTaskId.get(taskId!),
      });
      matchedTaskIds.add(taskId!);
      continue;
    }
    if (surfaceExists && !runningTask) {
      // C: pid 死亡 + idle の残骸 pane → close
      cleanup.push(c.surface);
      discarded.push({ surface: c.surface, reason: "pid_dead_idle_cleanup" });
      continue;
    }
    if (!surfaceExists && runningTask) {
      // D: surface 消失 + running task
      resumeNewSurface.push({
        raw: c,
        decision: "resume-new-surface",
        resume: resumeByTaskId.get(taskId!),
      });
      matchedTaskIds.add(taskId!);
      continue;
    }
    // E: surface 消失 + idle
    discarded.push({ surface: c.surface, reason: "surface_missing_no_task" });
  }

  // 未マッチ resume の集約 — team.json 未反映の assigned タスクを救う
  const unmatchedResumes: ResumePlanItem[] = [];
  for (const [tid, item] of resumeByTaskId) {
    if (!matchedTaskIds.has(tid)) {
      unmatchedResumes.push(item);
    }
  }

  return {
    alive,
    resumeExisting,
    cleanup,
    resumeNewSurface,
    discarded,
    unmatchedResumes,
  };
}
