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
 * @param daemonSurface      daemon 自身が動作している surface。C (cleanup-stale) の close 対象から
 *                           除外する self-close guard に使う（未指定なら guard 無効）
 */
export function planLayoutRestore(
  conductorsFromJson: any[],
  liveSurfaces: Set<string>,
  isAlive: (pid: number) => boolean,
  resumePlan: ResumePlanItem[],
  daemonSurface?: string | null,
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

    // T027: broken は surface 実在を pidAlive より優先で判定する。
    //   broken Conductor は resetConductor が pid をクリアしない
    //   (conductor.ts:918-921 reserved 経路限定) ため、team.json に live 値が
    //   残り続け、PID が他プロセスに recycle されると pidAlive で誤って A に
    //   流入する。surface が tree に無い broken エントリは「現スロットに
    //   属さない過去 surface の残骸」確定なので E (discard) に倒す。
    //   surface が tree にあれば従来通り pidAlive 判定に進む（現役 broken
    //   スロット温存）。E のログは applyDiscardOnly 側で reason に応じて
    //   conductor_pruned / conductor_discarded を出し分ける。
    if (c.status === "broken" && !surfaceExists) {
      discarded.push({ surface: c.surface, reason: "broken_surface_missing" });
      continue;
    }

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
      //   self-close guard: daemon 自身が動作している surface は絶対に close しない。
      //   過去に Conductor だった surface で `elevens start` すると、その entry が
      //   team.json に pid_dead のまま残っているため C に分類され、daemon が起動直後に
      //   自分の足元の pane を閉じて SIGTERM で自滅する事故があった
      //   （Brainship 2026-07-18 23:59: daemon_surface M[165] の 1 秒後に
      //     surface_closed surface:165 reason=conductor_stale_pid_dead_idle → uptime 5s）。
      //   entry は stale なので pool からは外すが、surface には触れず discard に倒す。
      if (daemonSurface && c.surface === daemonSurface) {
        discarded.push({ surface: c.surface, reason: "daemon_surface_self_close_guard" });
        continue;
      }
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
