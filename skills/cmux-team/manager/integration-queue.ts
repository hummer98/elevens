/**
 * Integration Queue（後工程・統合レーン）の Item パース・FSM・CRUD。
 *
 * closed かつ `deliverable.kind=pr` の Task を参照する「統合待ち item」を
 * `.team/integration-queue/Qnnn.json` の単一 JSON ファイルで管理する。
 * Task / Artifact / Epic と並ぶカテゴリで、Integrator（`/loop`）が pull して
 * merge → deploy → 実機 E2E を直列に遂行する。仕様は `docs/spec/17-integration-queue.md`。
 *
 * 設計原則（CLAUDE.md）:
 * - state を外部化: 統合の in-flight 状態（batch 所属 / retry / 進捗）を本 file に持つ。
 *   Integrator は cold start で毎回 read し、自分の記憶に state を持たない。
 * - 決定論はコード: enqueue / claim / 遷移 / ordering は本モジュール（純粋 FSM + file）。
 *   merge / deploy / E2E 解釈 / bisect は Integrator（判断）。
 */
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import type { TaskStateMap } from "./task";

// --- 状態 (5 値) ---

export type IntegItemState =
  | "queued"
  | "integrating"
  | "verifying"
  | "done"
  | "failed";

export const INTEG_STATES: readonly IntegItemState[] = [
  "queued",
  "integrating",
  "verifying",
  "done",
  "failed",
] as const;

/** done / failed は終端。 */
export function isIntegTerminal(state: IntegItemState): boolean {
  return state === "done" || state === "failed";
}

// --- Item ---

export interface IntegItem {
  id: string;                       // "Q001"
  taskId: string;                   // 参照先 Task ID ("142")
  branch: string;                   // 統合対象 branch
  pr: string | null;                // PR URL or 番号（deliverable=pr 由来）
  state: IntegItemState;
  batchId: string | null;           // claim 時に Integrator が付与（"B001" 等）
  retry: number;                    // requeue 回数
  enqueuedAt: string;               // ISO 8601
  updatedAt: string;                // ISO 8601
  resultArtifact: string | null;    // verifying→done/failed 時の artifact ID
  followupTaskId: string | null;    // failed 時に起票した follow-up Task ID
  journal: string | null;           // optional prose
  filePath: string;                 // 実ファイルパス（非永続。load 時に補完）
  fileName: string;
}

const INTEG_ID_RE = /^Q\d{3}$/;
const TASK_ID_RE = /^\d{1,4}$/;

// --- FSM reducer（純関数） ---

export type IntegEvent =
  | { type: "CLAIM"; batchId: string }
  | { type: "DEPLOYED" }
  | { type: "VERIFY_PASS"; resultArtifact: string }
  | { type: "VERIFY_FAIL"; resultArtifact: string; followupTaskId: string }
  | { type: "REQUEUE"; reason?: string };

export type IntegReduceResult =
  | { ok: true; next: IntegItemState }
  | { ok: false; error: string };

/**
 * spec §4.1 の遷移表に対応する純粋 reducer。
 * 不正遷移は `{ ok: false }` を返す（throw しない）。副作用なし。
 */
export function integReduce(
  state: IntegItemState,
  event: IntegEvent,
): IntegReduceResult {
  switch (event.type) {
    case "CLAIM":
      if (state === "queued") return { ok: true, next: "integrating" };
      break;
    case "DEPLOYED":
      if (state === "integrating") return { ok: true, next: "verifying" };
      break;
    case "VERIFY_PASS":
      if (state === "verifying") return { ok: true, next: "done" };
      break;
    case "VERIFY_FAIL":
      if (state === "verifying") return { ok: true, next: "failed" };
      break;
    case "REQUEUE":
      if (state === "integrating" || state === "verifying") {
        return { ok: true, next: "queued" };
      }
      break;
  }
  return {
    ok: false,
    error: `illegal transition: ${state} --${event.type}-->`,
  };
}

// --- シリアライズ（on-disk snake_case ⇄ TS camelCase） ---

/**
 * on-disk JSON（spec §3.2 の snake_case）を IntegItem に変換。
 * 壊れた JSON / 必須欠落は null を返す。
 */
export function parseIntegItem(
  raw: string,
  fileName: string,
  filePath: string,
): IntegItem | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;

  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const id = str(j.id);
  const taskId = str(j.task_id);
  const branch = str(j.branch);
  const state = str(j.state) as IntegItemState | undefined;
  const enqueuedAt = str(j.enqueued_at);
  const updatedAt = str(j.updated_at);

  if (!id || !taskId || !branch || !state || !enqueuedAt || !updatedAt) {
    return null;
  }

  const prRaw = j.pr;
  const pr =
    prRaw === undefined || prRaw === null
      ? null
      : typeof prRaw === "number"
        ? String(prRaw)
        : str(prRaw) ?? null;

  return {
    id,
    taskId,
    branch,
    pr,
    state,
    batchId: str(j.batch_id) ?? null,
    retry: typeof j.retry === "number" ? j.retry : 0,
    enqueuedAt,
    updatedAt,
    resultArtifact: str(j.result_artifact) ?? null,
    followupTaskId: str(j.followup_task_id) ?? null,
    journal: str(j.journal) ?? null,
    filePath,
    fileName,
  };
}

/** IntegItem を on-disk JSON 文字列（snake_case, 末尾改行付き）に変換。 */
export function serializeIntegItem(item: IntegItem): string {
  const obj = {
    id: item.id,
    task_id: item.taskId,
    branch: item.branch,
    pr: item.pr,
    state: item.state,
    batch_id: item.batchId,
    retry: item.retry,
    enqueued_at: item.enqueuedAt,
    updated_at: item.updatedAt,
    result_artifact: item.resultArtifact,
    followup_task_id: item.followupTaskId,
    journal: item.journal,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

// --- Validation ---

/** 必須フィールド + ID 形状の検証。エラーメッセージ配列を返す（空なら valid）。 */
export function validateIntegItem(item: IntegItem): string[] {
  const errors: string[] = [];
  if (!item.id) errors.push("id が未設定");
  else if (!INTEG_ID_RE.test(item.id)) errors.push(`id "${item.id}" は不正 (Q001 形式)`);
  if (!item.taskId) errors.push("task_id が未設定");
  else if (!TASK_ID_RE.test(item.taskId)) errors.push(`task_id "${item.taskId}" は不正 (1〜4 桁)`);
  if (!item.branch) errors.push("branch が未設定");
  if (!item.state) errors.push("state が未設定");
  else if (!INTEG_STATES.includes(item.state)) {
    errors.push(`state "${item.state}" は不正 (${INTEG_STATES.join(" | ")})`);
  }
  if (item.retry < 0 || !Number.isInteger(item.retry)) {
    errors.push("retry は 0 以上の整数が必要");
  }
  return errors;
}

// --- CRUD ---

function integDir(projectRoot: string): string {
  return join(projectRoot, ".team/integration-queue");
}

/** .team/integration-queue/ 配下の item を全件読み込む。 */
export async function loadIntegItems(projectRoot: string): Promise<IntegItem[]> {
  const dir = integDir(projectRoot);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const items: IntegItem[] = [];
  for (const f of files) {
    if (!INTEG_ID_RE.test(f.replace(/\.json$/, "")) || !f.endsWith(".json")) continue;
    const filePath = join(dir, f);
    const content = await readFile(filePath, "utf-8");
    const item = parseIntegItem(content, f, filePath);
    if (item) items.push(item);
  }
  return items;
}

/** 単一 item を ID で読み込む。 */
export async function readIntegItem(
  projectRoot: string,
  id: string,
): Promise<IntegItem | null> {
  if (!INTEG_ID_RE.test(id)) return null;
  const items = await loadIntegItems(projectRoot);
  return items.find((i) => i.id === id) ?? null;
}

/** 次の Item ID を採番（Q001, Q002, ...）。 */
export async function nextIntegId(projectRoot: string): Promise<string> {
  const items = await loadIntegItems(projectRoot);
  if (items.length === 0) return "Q001";
  const nums = items
    .map((i) => parseInt(i.id.replace(/^Q/, ""), 10))
    .filter((n) => !isNaN(n));
  const max = Math.max(0, ...nums);
  return `Q${String(max + 1).padStart(3, "0")}`;
}

export interface EnqueueOpts {
  projectRoot: string;
  taskId: string;
  branch?: string;        // 省略時は task-state の taskRunId から derive
  pr?: string;            // 省略時は deliverable=pr の prUrl から derive
  /** spec §3.3 の closed && deliverable=pr 検証を skip（PoC / テスト用） */
  force?: boolean;
}

/**
 * Task を Integration Queue に enqueue する。
 *
 * spec §3.3 の検証:
 * - task_id は 1〜4 桁の数字
 * - task-state.json に実在し status=closed
 * - deliverable.kind === "pr"
 * いずれか不一致は Error throw（--force で bypass）。
 */
export async function enqueueIntegItem(
  opts: EnqueueOpts,
): Promise<{ id: string; filePath: string }> {
  const { projectRoot, taskId } = opts;

  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`task_id "${taskId}" は不正（1〜4 桁の数字が必要）`);
  }

  // task-state を読む
  const stateFile = join(projectRoot, ".team/task-state.json");
  let taskState: TaskStateMap = {};
  if (existsSync(stateFile)) {
    try {
      taskState = JSON.parse(await readFile(stateFile, "utf-8"));
    } catch {
      taskState = {};
    }
  }
  const entry = taskState[taskId];

  let branch = opts.branch;
  let pr = opts.pr ?? null;

  if (!opts.force) {
    if (!entry) {
      throw new Error(`Task ${taskId} が task-state.json に存在しません`);
    }
    if (entry.status !== "closed") {
      throw new Error(
        `Task ${taskId} は closed ではありません (status=${entry.status})。enqueue 対象は closed のみ`,
      );
    }
    const kind = entry.deliverable?.kind;
    if (kind !== "pr") {
      throw new Error(
        `Task ${taskId} の deliverable.kind は "${kind ?? "(none)"}" です。enqueue 対象は deliverable=pr のみ（Conductor が PR を成果物として close した Task）`,
      );
    }
    // deliverable=pr は { kind:"pr", prUrl }
    if (!pr && entry.deliverable && "prUrl" in entry.deliverable) {
      pr = entry.deliverable.prUrl;
    }
  }

  // branch 解決: 明示 > task-state.taskRunId
  if (!branch) {
    branch = entry?.taskRunId;
  }
  if (!branch) {
    throw new Error(
      `branch を解決できません。--branch を明示するか、task-state に taskRunId が必要`,
    );
  }

  const id = await nextIntegId(projectRoot);
  const now = new Date().toISOString();

  const item: IntegItem = {
    id,
    taskId,
    branch,
    pr,
    state: "queued",
    batchId: null,
    retry: 0,
    enqueuedAt: now,
    updatedAt: now,
    resultArtifact: null,
    followupTaskId: null,
    journal: null,
    filePath: "",
    fileName: `${id}.json`,
  };

  const errors = validateIntegItem(item);
  if (errors.length > 0) {
    throw new Error(`Integration item validation failed: ${errors.join("; ")}`);
  }

  const dir = integDir(projectRoot);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${id}.json`);
  await writeFile(filePath, serializeIntegItem({ ...item, filePath }), "utf-8");

  return { id, filePath };
}

export interface UpdateIntegOpts {
  batchId?: string;
  resultArtifact?: string;
  followupTaskId?: string;
  retryInc?: boolean;
  reason?: string;
}

/**
 * target state への遷移を CLI 起点で適用する（`elevens integ update`）。
 * (現 state, target state, opts) から FSM event を導出し、reducer で合法性を検証。
 *
 * - target=integrating: CLAIM（--batch 必須）
 * - target=verifying:   DEPLOYED
 * - target=done:        VERIFY_PASS（--artifact 必須）
 * - target=failed:      VERIFY_FAIL（--artifact + --followup 必須）
 * - target=queued:      REQUEUE（--retry-inc で retry+1）
 */
export async function updateIntegItem(
  projectRoot: string,
  id: string,
  target: IntegItemState,
  opts: UpdateIntegOpts = {},
): Promise<{ filePath: string; next: IntegItemState }> {
  const item = await readIntegItem(projectRoot, id);
  if (!item) throw new Error(`Integration item ${id} が見つかりません`);

  // target state → event 導出 + 必須フラグ検証
  let event: IntegEvent;
  switch (target) {
    case "integrating":
      if (!opts.batchId) throw new Error("--state integrating は --batch が必須");
      event = { type: "CLAIM", batchId: opts.batchId };
      break;
    case "verifying":
      event = { type: "DEPLOYED" };
      break;
    case "done":
      if (!opts.resultArtifact) throw new Error("--state done は --artifact が必須（evidence 必須）");
      event = { type: "VERIFY_PASS", resultArtifact: opts.resultArtifact };
      break;
    case "failed":
      if (!opts.resultArtifact) throw new Error("--state failed は --artifact が必須（evidence 必須）");
      if (!opts.followupTaskId) throw new Error("--state failed は --followup が必須（follow-up Task）");
      event = {
        type: "VERIFY_FAIL",
        resultArtifact: opts.resultArtifact,
        followupTaskId: opts.followupTaskId,
      };
      break;
    case "queued":
      event = { type: "REQUEUE", reason: opts.reason };
      break;
    default:
      throw new Error(`未知の target state: ${target}`);
  }

  const result = integReduce(item.state, event);
  if (!result.ok) {
    throw new Error(result.error);
  }

  // フィールド適用
  const now = new Date().toISOString();
  const next: IntegItem = { ...item, state: result.next, updatedAt: now };
  switch (event.type) {
    case "CLAIM":
      next.batchId = event.batchId;
      break;
    case "VERIFY_PASS":
      next.resultArtifact = event.resultArtifact;
      break;
    case "VERIFY_FAIL":
      next.resultArtifact = event.resultArtifact;
      next.followupTaskId = event.followupTaskId;
      break;
    case "REQUEUE":
      if (opts.retryInc) next.retry = item.retry + 1;
      next.batchId = null;
      if (event.reason) {
        next.journal = (item.journal ? item.journal + "\n" : "") + `[${now}] requeue: ${event.reason}`;
      }
      break;
  }

  await writeFile(next.filePath, serializeIntegItem(next), "utf-8");
  return { filePath: next.filePath, next: next.state };
}
