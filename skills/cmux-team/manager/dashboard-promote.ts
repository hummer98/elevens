/**
 * T035: TUI Tasks リストの draft → ready 昇格フロー。
 *
 * dashboard.tsx の closure から切り出して DI で testable にした
 * （既存の dashboard-keymap.ts / pool-summary.ts と同じ「pure 判定 + DI 副作用」スタイル）。
 *
 * フロー（CLI `update-task --status ready` と同一経路・同一セマンティクス）:
 * 1. decidePromote（pure）— 選択タスクからアクションを決定
 * 2. runReadySyncGuard — sync guard（ログ / events.jsonl emit は guard 内部で CLI と共通）
 * 3. applyTaskEvent(UPDATE_STATUS to=ready) — task-state mutation の唯一の入口
 * 4. notifyTaskCreated — proxy POST /api/messages（daemon 起床、CLI postMessage と同一経路）
 * 5. toast / manager.log
 *
 * TUI からは `--force` / `--no-auto-pull` 相当の bypass を提供しない
 * （forceFlag:false / noAutoPull:false 固定。bypass が必要なケースは CLI に誘導）。
 */
import type { TaskSummary } from "./daemon";
import type { ReadyGuardResult, ReadyGuardOptions } from "./ready-guard";
import type {
  ApplyTaskEventInput,
  ApplyTaskEventResult,
} from "./state-machine/task-state-store";
import { t } from "./i18n";

/** pure: 選択タスクから実行すべきアクションを決定 */
export type PromoteDecision =
  | { kind: "no-task" }
  | { kind: "not-draft"; taskId: string; status: string }
  | { kind: "promote"; taskId: string; taskFile?: string };

/**
 * design-review R3: TaskSummary のタスクファイルパスは `filePath`（daemon.ts）。
 * TASK_CREATED payload のキー名は CLI（postMessage）と揃えて `taskFile` に写像する。
 */
export function decidePromote(task: TaskSummary | undefined): PromoteDecision {
  if (!task) return { kind: "no-task" };
  if (task.status !== "draft") {
    return { kind: "not-draft", taskId: task.id, status: task.status };
  }
  return { kind: "promote", taskId: task.id, taskFile: task.filePath };
}

export interface PromoteDeps {
  projectRoot: string;
  runGuard: (
    projectRoot: string,
    opts: ReadyGuardOptions,
  ) => Promise<ReadyGuardResult>;
  applyEvent: (
    projectRoot: string,
    input: ApplyTaskEventInput,
  ) => Promise<ApplyTaskEventResult>;
  /** CLI postMessage と同 payload を proxy /api/messages に POST する。throw しない実装にすること */
  notifyTaskCreated: (taskId: string, taskFile: string | undefined) => Promise<void>;
  showToast: (kind: "success" | "error", message: string, label?: string) => void;
  log: (event: string, detail: string) => void;
}

export type PromoteOutcome =
  | "noop-no-task"
  | "noop-not-draft"
  | "rejected"
  | "conflict"
  | "promoted";

/** reject message は複数行（推奨コマンド・Bypass ヒント付き）だが toast は 1 行のため先頭行のみ */
function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

export async function promoteTaskToReady(
  task: TaskSummary | undefined,
  deps: PromoteDeps,
): Promise<PromoteOutcome> {
  const decision = decidePromote(task);
  if (decision.kind === "no-task") {
    // リスト空 / cursor 範囲外は silent no-op（artifacts copy の空リスト規約に合わせる）
    return "noop-no-task";
  }
  if (decision.kind === "not-draft") {
    deps.showToast(
      "error",
      t("toast_promote_not_draft", { id: decision.taskId, status: decision.status }),
      t("toast_promote_label_failed"),
    );
    deps.log(
      "task_promote_noop",
      `task_id=${decision.taskId} status=${decision.status}`,
    );
    return "noop-not-draft";
  }

  const { taskId, taskFile } = decision;
  const guard = await deps.runGuard(deps.projectRoot, {
    status: "ready",
    forceFlag: false,
    skipFetch: false,
    noAutoPull: false,
    phase: "update",
    taskId,
  });
  // notices は ok/reject 共通で manager.log へ（TUI には console がないため）。
  // reject 時は auto-pull 失敗の preMessage が含まれる（CLI は console に先出力する行）
  for (const n of guard.notices) {
    deps.log("task_promote_notice", `task_id=${taskId} level=${n.level} ${n.message}`);
  }
  if (!guard.ok) {
    // ready_rejected ログと task_sync_guard_rejected event は guard 内部で emit 済み。
    // toast は 1 行 truncate されるため先頭行のみ。全文は manager.log に残す。
    deps.showToast("error", firstLine(guard.message), t("toast_promote_label_failed"));
    deps.log(
      "task_promote_rejected",
      `task_id=${taskId} state=${guard.state} message=${guard.message.replace(/\s+/g, " ")}`,
    );
    return "rejected";
  }

  const result = await deps.applyEvent(deps.projectRoot, {
    taskId,
    event: { type: "UPDATE_STATUS", to: "ready" },
    ctx: { hasConductor: false, parentAborted: false },
  });
  if (!result.committed) {
    // guard 実行中（git fetch 数秒）に Manager が状態を変えた race。
    // FSM reducer（draft→ready 以外 noop）が最終防衛で、silent fail にせず可視化する。
    deps.showToast(
      "error",
      t("toast_promote_conflict", { id: taskId }),
      t("toast_promote_label_failed"),
    );
    deps.log("task_promote_conflict", `task_id=${taskId}`);
    return "conflict";
  }

  await deps.notifyTaskCreated(taskId, taskFile);
  deps.showToast("success", `T${taskId}`, t("toast_promote_label_success"));
  deps.log("task_promote_succeeded", `task_id=${taskId}`);
  return "promoted";
}
