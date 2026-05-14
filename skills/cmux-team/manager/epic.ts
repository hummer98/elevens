/**
 * Epic（PoC）ファイルのパース・CRUD。
 *
 * Epic は `.team/epics/E001-<slug>.md` の単一 markdown ファイルで管理する。
 * Task / Artifact と並ぶ第三のカテゴリ。仕様は `docs/spec/14-epic.md`。
 */
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export type EpicStatus = "active" | "blocked" | "closed" | "aborted";

export const EPIC_STATUSES: readonly EpicStatus[] = [
  "active",
  "blocked",
  "closed",
  "aborted",
] as const;

export interface EpicBudget {
  token: number;
  iteration: number;
  wall_clock_hours: number;
}

export interface EpicMeta {
  id: string;             // "E001"
  title: string;
  status: EpicStatus;
  created: string;        // ISO 8601
  updated?: string;       // ISO 8601
  createdBy: string;      // surface:NNN
  budget: EpicBudget;
  filePath: string;
  fileName: string;
  body: string;
}

const EPIC_ID_RE = /^E\d{3}$/;

/**
 * YAML frontmatter から Epic メタデータを抽出。
 * budget はネストオブジェクト形式 (3 行) をパースする。
 */
export function parseEpicMeta(
  content: string,
  fileName: string,
  filePath: string,
): EpicMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length).replace(/^\n+/, "");

  const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
  const id = unquote(fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const title = unquote(fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const status = unquote(fm.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? "") as EpicStatus;
  const created = unquote(fm.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? "");
  const updatedRaw = fm.match(/^updated:\s*(.+)$/m)?.[1]?.trim();
  const updated = updatedRaw ? unquote(updatedRaw) : undefined;
  const createdBy = unquote(fm.match(/^created_by:\s*(.+)$/m)?.[1]?.trim() ?? "");

  // budget は YAML ネスト形式（2 スペースインデント）でパース
  //   budget:
  //     token: 500000
  //     iteration: 30
  //     wall_clock_hours: 24
  const token = parseInt(
    fm.match(/^\s{2}token:\s*(\d+)\s*$/m)?.[1] ?? "0",
    10,
  );
  const iteration = parseInt(
    fm.match(/^\s{2}iteration:\s*(\d+)\s*$/m)?.[1] ?? "0",
    10,
  );
  const wallClockHoursRaw = fm.match(/^\s{2}wall_clock_hours:\s*([\d.]+)\s*$/m)?.[1];
  const wall_clock_hours = wallClockHoursRaw ? parseFloat(wallClockHoursRaw) : 0;

  return {
    id,
    title,
    status,
    created,
    updated,
    createdBy,
    budget: { token, iteration, wall_clock_hours },
    filePath,
    fileName,
    body,
  };
}

/**
 * .team/epics/ 配下の Epic を全件読み込む。
 */
export async function loadEpics(projectRoot: string): Promise<EpicMeta[]> {
  const epicsDir = join(projectRoot, ".team/epics");
  if (!existsSync(epicsDir)) return [];

  const files = await readdir(epicsDir);
  const epics: EpicMeta[] = [];

  for (const f of files) {
    if (!f.startsWith("E") || !f.endsWith(".md")) continue;
    const filePath = join(epicsDir, f);
    const content = await readFile(filePath, "utf-8");
    const meta = parseEpicMeta(content, f, filePath);
    if (meta) epics.push(meta);
  }

  return epics;
}

/**
 * 単一 Epic を ID で読み込む。
 */
export async function readEpic(
  projectRoot: string,
  id: string,
): Promise<EpicMeta | null> {
  if (!EPIC_ID_RE.test(id)) return null;
  const epics = await loadEpics(projectRoot);
  return epics.find((e) => e.id === id) ?? null;
}

/**
 * 次の Epic ID を採番（E001, E002, ...）。
 */
export async function nextEpicId(projectRoot: string): Promise<string> {
  const epics = await loadEpics(projectRoot);
  if (epics.length === 0) return "E001";
  const nums = epics
    .map((e) => parseInt(e.id.replace(/^E/, ""), 10))
    .filter((n) => !isNaN(n));
  const max = Math.max(0, ...nums);
  return `E${String(max + 1).padStart(3, "0")}`;
}

/**
 * Frontmatter を YAML 形式で組み立てる。
 */
function buildFrontmatter(meta: Omit<EpicMeta, "filePath" | "fileName" | "body">): string {
  const lines = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`title: "${meta.title.replace(/"/g, '\\"')}"`);
  lines.push(`status: ${meta.status}`);
  lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push(`created_by: ${meta.createdBy}`);
  lines.push(`budget:`);
  lines.push(`  token: ${meta.budget.token}`);
  lines.push(`  iteration: ${meta.budget.iteration}`);
  lines.push(`  wall_clock_hours: ${meta.budget.wall_clock_hours}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * Frontmatter 必須フィールドの検証。
 */
export function validateEpic(meta: EpicMeta): string[] {
  const errors: string[] = [];
  if (!meta.id) errors.push("id が未設定");
  else if (!EPIC_ID_RE.test(meta.id)) errors.push(`id "${meta.id}" は不正 (E001 形式)`);
  if (!meta.title) errors.push("title が未設定");
  if (!meta.status) errors.push("status が未設定");
  else if (!EPIC_STATUSES.includes(meta.status)) {
    errors.push(`status "${meta.status}" は不正 (${EPIC_STATUSES.join(" | ")})`);
  }
  if (!meta.created) errors.push("created が未設定");
  if (!meta.createdBy) errors.push("created_by が未設定");
  if (!meta.budget.token || meta.budget.token <= 0) {
    errors.push("budget.token は正の整数が必要");
  }
  if (!meta.budget.iteration || meta.budget.iteration <= 0) {
    errors.push("budget.iteration は正の整数が必要");
  }
  if (!meta.budget.wall_clock_hours || meta.budget.wall_clock_hours <= 0) {
    errors.push("budget.wall_clock_hours は正の数値が必要");
  }
  return errors;
}

export interface CreateEpicOpts {
  projectRoot: string;
  title: string;
  body?: string;          // intent 本文（Markdown）。section 構成は呼び出し側に委ねる
  budget?: Partial<EpicBudget>;
  createdBy?: string;
}

const DEFAULT_BUDGET: EpicBudget = {
  token: 500_000,
  iteration: 30,
  wall_clock_hours: 24,
};

/**
 * Epic を新規作成する。
 *
 * - `.team/epics/E001-<slug>.md` を書き出す
 * - status は "active" 固定（PoC: blocked / closed / aborted への遷移は別 API）
 */
export async function createEpic(
  opts: CreateEpicOpts,
): Promise<{ id: string; filePath: string }> {
  const id = await nextEpicId(opts.projectRoot);
  const now = new Date().toISOString();

  let slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) slug = "epic";

  const budget: EpicBudget = {
    token: opts.budget?.token ?? DEFAULT_BUDGET.token,
    iteration: opts.budget?.iteration ?? DEFAULT_BUDGET.iteration,
    wall_clock_hours: opts.budget?.wall_clock_hours ?? DEFAULT_BUDGET.wall_clock_hours,
  };

  const meta = {
    id,
    title: opts.title,
    status: "active" as EpicStatus,
    created: now,
    createdBy: opts.createdBy ?? process.env.CMUX_SURFACE ?? "unknown",
    budget,
  };

  const frontmatter = buildFrontmatter(meta);
  const bodyContent = (opts.body ?? "").trim();

  const defaultBody = bodyContent
    ? bodyContent
    : [
        "## Intent（E2E シナリオ + 勘所）",
        "",
        "<!-- 達成したい E2E シナリオ、設計の勘所、Done 条件をここに書く。start 後は immutable。 -->",
        "",
        "## Current Plan",
        "",
        "<!-- Planner が随時更新する Task 分解。 -->",
        "",
        "## Journal",
        "",
        "<!-- Planner の意思決定ログ。append-only。 -->",
      ].join("\n");

  const output = `${frontmatter}\n\n${defaultBody}\n`;

  const epicsDir = join(opts.projectRoot, ".team/epics");
  if (!existsSync(epicsDir)) {
    await mkdir(epicsDir, { recursive: true });
  }

  const filePath = join(epicsDir, `${id}-${slug}.md`);
  await writeFile(filePath, output, "utf-8");

  return { id, filePath };
}

/**
 * Epic の status を更新（CLI resume / abort 経路用）。
 * Planner が active 中に自身で status を書き換える経路は本関数を通さず
 * epic.md を直接 Edit する（PoC: spec §4 参照）。
 *
 * 遷移ルール:
 * - blocked → active (resume)
 * - active / blocked → aborted (abort)
 * - closed → 不可（終端）
 * - aborted → 不可（終端）
 */
export async function updateEpicStatus(
  projectRoot: string,
  id: string,
  newStatus: EpicStatus,
  opts?: { budget?: Partial<EpicBudget>; journalEntry?: string },
): Promise<{ filePath: string }> {
  const epic = await readEpic(projectRoot, id);
  if (!epic) {
    throw new Error(`Epic ${id} not found`);
  }

  // 遷移チェック
  if (epic.status === "closed" || epic.status === "aborted") {
    throw new Error(
      `Epic ${id} is terminal (${epic.status}); cannot transition to ${newStatus}`,
    );
  }
  if (newStatus === "active" && epic.status !== "blocked") {
    throw new Error(
      `resume は status=blocked のみ。現在の status は "${epic.status}"`,
    );
  }
  if (newStatus !== "active" && newStatus !== "aborted") {
    throw new Error(
      `updateEpicStatus は resume / abort のみサポート（${newStatus} は不可）`,
    );
  }

  const now = new Date().toISOString();
  const newBudget: EpicBudget = {
    token: opts?.budget?.token ?? epic.budget.token,
    iteration: opts?.budget?.iteration ?? epic.budget.iteration,
    wall_clock_hours:
      opts?.budget?.wall_clock_hours ?? epic.budget.wall_clock_hours,
  };

  const newMeta = {
    id: epic.id,
    title: epic.title,
    status: newStatus,
    created: epic.created,
    updated: now,
    createdBy: epic.createdBy,
    budget: newBudget,
  };

  const frontmatter = buildFrontmatter(newMeta);
  let body = epic.body;

  if (opts?.journalEntry) {
    body = appendJournalEntry(body, now, opts.journalEntry);
  }

  const output = `${frontmatter}\n\n${body.trimEnd()}\n`;
  await writeFile(epic.filePath, output, "utf-8");

  return { filePath: epic.filePath };
}

/**
 * Journal セクションに timestamp 付きエントリを append する。
 * `## Journal` セクションが無い場合は末尾に追加する。
 */
function appendJournalEntry(body: string, timestamp: string, entry: string): string {
  const journalHeader = "## Journal";
  const stamped = `\n### ${timestamp}\n\n${entry.trim()}\n`;

  if (body.includes(journalHeader)) {
    return body.trimEnd() + stamped;
  }
  return body.trimEnd() + `\n\n${journalHeader}\n${stamped}`;
}

/**
 * .team/tasks/ 配下から epic_id が一致する Task を抽出する。
 * task.ts の loadTasks に依存せず、frontmatter を直接 grep して軽量に取得する。
 *
 * 戻り値は Task の dirName / id / title / status を含む簡易レコード。
 */
export interface EpicChildTask {
  id: string;
  title: string;
  status: string;
  dirName: string;
}

export async function listEpicTasks(
  projectRoot: string,
  epicId: string,
): Promise<EpicChildTask[]> {
  const tasksDir = join(projectRoot, ".team/tasks");
  if (!existsSync(tasksDir)) return [];

  // task-state.json から status を引くための map
  const taskStateMap: Record<string, { status?: string }> = await (async () => {
    const stateFile = join(projectRoot, ".team/task-state.json");
    if (!existsSync(stateFile)) return {};
    try {
      const raw = await readFile(stateFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

  const dirs = await readdir(tasksDir);
  const results: EpicChildTask[] = [];

  for (const d of dirs) {
    const taskFile = join(tasksDir, d, "task.md");
    if (!existsSync(taskFile)) continue;

    const content = await readFile(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch?.[1]) continue;

    const fm = fmMatch[1];
    const taskEpicId = fm.match(/^epic_id:\s*(.+)$/m)?.[1]?.trim();
    if (taskEpicId !== epicId) continue;

    const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const title = (fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "").replace(/^["']|["']$/g, "");
    const status = taskStateMap[id]?.status ?? "draft";

    results.push({ id, title, status, dirName: d });
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}
