/**
 * T011: worktree archive — destructive cleanup の置き換え
 *
 * 正常完了 (`CONDUCTOR_DONE success=true` / `close-task`) 以外の cleanup 経路で
 * `git worktree remove --force` していた worktree を物理削除せず、
 * `.team/worktrees-archive/<taskRunId>/` に `mv` で退避し branch を残す。
 *
 * 設計の上位指針 (CLAUDE.md):
 *  - 観察箱原則: archive は retrospective 観察用の証拠保全。
 *    `.archive-meta.json` / `events.jsonl` / `manager.log` の三層で WHEN / WHY を再構成
 *  - silent state mutation を作らない: `worktree_archived` log + event でフォーマット可能な痕跡
 *  - 構造的正しさ: cleanup 判断を `cleanupMode` discriminated union (conductor.ts) で型強制
 *
 * spec: docs/spec/16-worktree-archive.md
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { isAbsolute, join, relative } from "path";
import { log, warn } from "./logger";
import { emitEvent } from "./events-writer";
import { formatExecError } from "./exec-error";

const execFile = promisify(execFileCb);

export const ARCHIVE_META_SCHEMA_VERSION = 1;

/** `.team/worktrees-archive/` 配下 directory 名 */
export const ARCHIVE_DIR_REL = ".team/worktrees-archive";

export type ArchiveReason =
  | "disconnect_timeout"
  | "abort_task"
  | "reset_conductor"
  | "clear_conductor"
  | "user_clear"
  | "restart"
  | "assign_terminal_race"
  | "resume"
  | "done_unresolved"
  | "other";

export interface ArchiveWorktreeOpts {
  projectRoot: string;
  /** 絶対 or projectRoot 相対のどちらでも受ける */
  worktreePath: string;
  taskRunId: string;
  /** canonical task id (数字のみ) */
  taskId: string;
  /** 例: "task-094-1778998001/task" */
  branch: string;
  reason: ArchiveReason;
  conductorSurface?: string;
  sessionId?: string;
  baseBranch?: string;
  baseSha?: string;
}

export interface ArchiveWorktreeResult {
  /** projectRoot 相対 */
  archivePath: string;
  /** ISO 8601 UTC (meta.json と event の archived_at と一致) */
  archivedAt: string;
  uncommittedChanges: boolean;
  lastCommitSha?: string;
  /** 既存 archive をスキップした (target_exists) か no-op (no_source) の場合 true */
  skipped?: "no_source" | "target_exists";
}

export interface ArchiveMeta {
  schema_version: number;
  task_id: string;
  task_run_id: string;
  archived_at: string;
  reason: ArchiveReason;
  /** projectRoot 相対 */
  original_path: string;
  branch: string;
  base_branch?: string;
  base_sha?: string;
  last_commit_sha?: string;
  uncommitted_changes: boolean;
  conductor_surface?: string;
  session_id?: string;
  notes?: string;
}

export interface ArchiveSummary {
  archivePath: string;
  taskRunId: string;
  taskId: string;
  archivedAt: string;
  reason: ArchiveReason;
  branch: string;
  uncommittedChanges: boolean;
  lastCommitSha?: string;
}

export class ArchiveFailedError extends Error {
  public readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ArchiveFailedError";
    this.code = code;
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}

function toAbsolute(projectRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(projectRoot, p);
}

function toProjectRelative(projectRoot: string, p: string): string {
  if (!isAbsolute(p)) return p;
  return relative(projectRoot, p) || p;
}

/**
 * `archiveWorktree(opts)` — §5.1 contract
 *
 * 1. worktreePath 不在 / archive 先既存 → skip ログ + 早期 return (throw しない)
 * 2. mv 前に `last_commit_sha` / `uncommitted_changes` を採取
 * 3. `mkdir -p .team/worktrees-archive/`
 * 4. `mv <worktreePath> <archivePath>` (fs.rename, 同一 fs で atomic)
 * 5. `git worktree prune` (broken registration 掃除)
 * 6. `.archive-meta.json` を atomic write
 * 7. `log("worktree_archived", ...)` を manager.log
 * 8. `emitEvent({ event: "worktree_archived", archived_at, ... })`
 *
 * meta.json と event の `archived_at` は必ず同値 ([M1])
 */
export async function archiveWorktree(
  opts: ArchiveWorktreeOpts,
): Promise<ArchiveWorktreeResult> {
  const {
    projectRoot,
    worktreePath: rawWorktreePath,
    taskRunId,
    taskId,
    branch,
    reason,
    conductorSurface,
    sessionId,
    baseBranch,
    baseSha,
  } = opts;

  const worktreeAbs = toAbsolute(projectRoot, rawWorktreePath);
  const archiveDirAbs = join(projectRoot, ARCHIVE_DIR_REL);
  const archiveAbs = join(archiveDirAbs, taskRunId);
  const archiveRel = join(ARCHIVE_DIR_REL, taskRunId);

  // 1a. worktreePath 不在 → no-op
  if (!existsSync(worktreeAbs)) {
    await log(
      "worktree_archive_skipped",
      `reason=no_source task_id=${taskId} task_run_id=${taskRunId} path=${toProjectRelative(projectRoot, worktreeAbs)}`,
    );
    return {
      archivePath: archiveRel,
      archivedAt: new Date().toISOString(),
      uncommittedChanges: false,
      skipped: "no_source",
    };
  }

  // 1b. archive 先既存 → skip ログ + 既存 path return (冪等性 [R1] / [R9])
  if (existsSync(archiveAbs)) {
    await log(
      "worktree_archive_skipped",
      `reason=target_exists task_id=${taskId} task_run_id=${taskRunId} path=${archiveRel}`,
    );
    // 既存 meta を読んで return 値を整合させる (best-effort)
    let archivedAt = new Date().toISOString();
    let uncommitted = false;
    let lastSha: string | undefined;
    try {
      const metaRaw = await readFile(join(archiveAbs, ".archive-meta.json"), "utf-8");
      const meta = JSON.parse(metaRaw) as ArchiveMeta;
      archivedAt = meta.archived_at;
      uncommitted = !!meta.uncommitted_changes;
      lastSha = meta.last_commit_sha;
    } catch {
      // meta 不在 / 壊れている場合は default を使う (skip 自体は成立している)
    }
    return {
      archivePath: archiveRel,
      archivedAt,
      uncommittedChanges: uncommitted,
      lastCommitSha: lastSha,
      skipped: "target_exists",
    };
  }

  // 2. mv 前に worktree の状態を採取
  let lastCommitSha: string | undefined;
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: worktreeAbs,
    });
    lastCommitSha = stdout.trim() || undefined;
  } catch (e) {
    await log(
      "worktree_archive_rev_parse_failed",
      `task_id=${taskId} task_run_id=${taskRunId} ${formatExecError(e)}`,
    );
  }

  let uncommittedChanges = false;
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], {
      cwd: worktreeAbs,
    });
    uncommittedChanges = stdout.trim().length > 0;
  } catch (e) {
    await log(
      "worktree_archive_status_failed",
      `task_id=${taskId} task_run_id=${taskRunId} ${formatExecError(e)}`,
    );
  }

  // 3. mkdir -p .team/worktrees-archive/
  await mkdir(archiveDirAbs, { recursive: true });

  // 4. mv (fs.rename, atomic on same fs)
  try {
    await rename(worktreeAbs, archiveAbs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new ArchiveFailedError(
      err?.code ?? "rename_failed",
      `mv ${worktreeAbs} → ${archiveAbs} failed: ${err?.message ?? String(e)}`,
      e,
    );
  }

  // archived_at は手順 4 完了直後に確定させ、meta.json と event で同値にする ([M1])
  const archivedAt = new Date().toISOString();

  // 5. git worktree prune (broken registration 掃除)
  try {
    await execFile("git", ["worktree", "prune"], { cwd: projectRoot });
  } catch (e) {
    // 致命ではない (warn)
    await warn(
      "worktree_archive_prune_failed",
      `task_id=${taskId} task_run_id=${taskRunId} ${formatExecError(e)}`,
    );
  }

  // 6. .archive-meta.json を atomic write
  const meta: ArchiveMeta = {
    schema_version: ARCHIVE_META_SCHEMA_VERSION,
    task_id: taskId,
    task_run_id: taskRunId,
    archived_at: archivedAt,
    reason,
    original_path: toProjectRelative(projectRoot, worktreeAbs),
    branch,
    base_branch: baseBranch,
    base_sha: baseSha,
    last_commit_sha: lastCommitSha,
    uncommitted_changes: uncommittedChanges,
    conductor_surface: conductorSurface,
    session_id: sessionId,
  };
  const metaPath = join(archiveAbs, ".archive-meta.json");
  const tmpPath = `${metaPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(meta, null, 2) + "\n");
  await rename(tmpPath, metaPath);

  // 7. log
  await log(
    "worktree_archived",
    `task_id=${taskId} task_run_id=${taskRunId} reason=${reason} path=${archiveRel} uncommitted=${uncommittedChanges}`,
  );

  // 8. emitEvent
  await emitEvent({
    event: "worktree_archived",
    task_id: taskId,
    task_run_id: taskRunId,
    reason,
    archive_path: archiveRel,
    archived_at: archivedAt,
    branch,
    uncommitted_changes: uncommittedChanges,
    last_commit_sha: lastCommitSha,
  });

  return {
    archivePath: archiveRel,
    archivedAt,
    uncommittedChanges,
    lastCommitSha,
  };
}

/**
 * `findArchivesForTaskId(projectRoot, taskId)` — §5.2
 *
 * `.team/worktrees-archive/` 直下の各 directory の `.archive-meta.json` を読み、
 * `task_id` 一致のものを `archived_at` 降順で return。
 *
 * - meta 読込失敗: `archive_meta_unreadable` warn ログ + skip
 * - JSON parse / 必須フィールド欠落: `archive_meta_invalid` warn ログ + skip
 * - ディレクトリ不在: 空配列
 */
export async function findArchivesForTaskId(
  projectRoot: string,
  taskId: string,
): Promise<ArchiveSummary[]> {
  const archiveDirAbs = join(projectRoot, ARCHIVE_DIR_REL);
  if (!existsSync(archiveDirAbs)) return [];

  let entries: string[];
  try {
    entries = await readdir(archiveDirAbs);
  } catch (e) {
    await warn(
      "archive_meta_unreadable",
      `path=${ARCHIVE_DIR_REL} ${formatExecError(e)}`,
    );
    return [];
  }

  const results: ArchiveSummary[] = [];
  for (const entry of entries) {
    const archiveAbs = join(archiveDirAbs, entry);
    let st: import("fs").Stats;
    try {
      st = await stat(archiveAbs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const metaPath = join(archiveAbs, ".archive-meta.json");
    let raw: string;
    try {
      raw = await readFile(metaPath, "utf-8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        // .archive-meta.json 自体無い entry はサイレント skip
        continue;
      }
      await warn(
        "archive_meta_unreadable",
        `path=${join(ARCHIVE_DIR_REL, entry)} ${formatExecError(e)}`,
      );
      continue;
    }

    let meta: ArchiveMeta;
    try {
      meta = JSON.parse(raw) as ArchiveMeta;
    } catch (e) {
      await warn(
        "archive_meta_invalid",
        `path=${join(ARCHIVE_DIR_REL, entry)} reason=parse_error message=${(e as Error)?.message ?? String(e)}`,
      );
      continue;
    }

    // 必須フィールド検証
    if (
      typeof meta.schema_version !== "number" ||
      typeof meta.task_id !== "string" ||
      typeof meta.task_run_id !== "string" ||
      typeof meta.archived_at !== "string" ||
      typeof meta.reason !== "string" ||
      typeof meta.branch !== "string"
    ) {
      await warn(
        "archive_meta_invalid",
        `path=${join(ARCHIVE_DIR_REL, entry)} reason=missing_required_field`,
      );
      continue;
    }

    if (meta.task_id !== taskId) continue;

    results.push({
      archivePath: join(ARCHIVE_DIR_REL, entry),
      taskRunId: meta.task_run_id,
      taskId: meta.task_id,
      archivedAt: meta.archived_at,
      reason: meta.reason,
      branch: meta.branch,
      uncommittedChanges: !!meta.uncommitted_changes,
      lastCommitSha: meta.last_commit_sha,
    });
  }

  // archived_at 降順
  results.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return results;
}

/**
 * `removeArchive(projectRoot, taskRunId, opts?)` — §5.3
 *
 * - `rm -rf <archivePath>`
 * - `opts.deleteBranch === true` で `git branch -D <branch>` (meta 読み込み → branch 削除 → rm)
 * - 不在は no-op
 */
export async function removeArchive(
  projectRoot: string,
  taskRunId: string,
  opts?: { deleteBranch?: boolean },
): Promise<void> {
  const archiveAbs = join(projectRoot, ARCHIVE_DIR_REL, taskRunId);
  if (!existsSync(archiveAbs)) return;

  let branch: string | undefined;
  if (opts?.deleteBranch) {
    try {
      const raw = await readFile(join(archiveAbs, ".archive-meta.json"), "utf-8");
      const meta = JSON.parse(raw) as ArchiveMeta;
      branch = meta.branch;
    } catch {
      // meta 不在 / 壊れている → branch 削除は skip
    }
    if (branch) {
      try {
        await execFile("git", ["branch", "-D", branch], { cwd: projectRoot });
      } catch (e) {
        await warn(
          "archive_branch_delete_failed",
          `branch=${branch} ${formatExecError(e)}`,
        );
      }
    }
  }

  await rm(archiveAbs, { recursive: true, force: true });
  await log(
    "archive_removed",
    `task_run_id=${taskRunId} delete_branch=${!!opts?.deleteBranch}`,
  );
}

/**
 * `pruneArchives(projectRoot, opts)` — §5.4
 *
 * 現在時刻 - archived_at > olderThanMs のものを removeArchive 経由で削除。
 * dryRun=true のとき削除はせず候補のみ返す。
 */
export async function pruneArchives(
  projectRoot: string,
  opts: { olderThanMs: number; deleteBranches?: boolean; dryRun?: boolean },
): Promise<{ pruned: string[]; skipped: string[] }> {
  const archiveDirAbs = join(projectRoot, ARCHIVE_DIR_REL);
  if (!existsSync(archiveDirAbs)) return { pruned: [], skipped: [] };

  let entries: string[];
  try {
    entries = await readdir(archiveDirAbs);
  } catch {
    return { pruned: [], skipped: [] };
  }

  const now = Date.now();
  const pruned: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const archiveAbs = join(archiveDirAbs, entry);
    let st: import("fs").Stats;
    try {
      st = await stat(archiveAbs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const metaPath = join(archiveAbs, ".archive-meta.json");
    let archivedAt: string;
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as ArchiveMeta;
      archivedAt = meta.archived_at;
      if (typeof archivedAt !== "string") {
        skipped.push(entry);
        continue;
      }
    } catch {
      skipped.push(entry);
      continue;
    }

    const archivedMs = Date.parse(archivedAt);
    if (Number.isNaN(archivedMs)) {
      skipped.push(entry);
      continue;
    }

    if (now - archivedMs > opts.olderThanMs) {
      if (!opts.dryRun) {
        await removeArchive(projectRoot, entry, {
          deleteBranch: !!opts.deleteBranches,
        });
      }
      pruned.push(entry);
    } else {
      skipped.push(entry);
    }
  }

  return { pruned, skipped };
}

/**
 * `buildArchivedWorktreeSection(archive?)` — §5.5 / [M2]
 *
 * - archive 未指定 → 空文字 (template から section 全体が消える)
 * - archive 指定 → markdown section を path / branch / archived_at 込みで返す
 */
export function buildArchivedWorktreeSection(
  archive: ArchiveSummary | undefined,
): string {
  if (!archive) return "";
  const uncommitted = archive.uncommittedChanges ? "あり" : "なし";
  const lastSha = archive.lastCommitSha ?? "(取得失敗)";
  return [
    "## 前回 attempt の archive について",
    "",
    "このタスクは前回 daemon クラッシュ / abort / reset などで中断され、再アサインされたものです。",
    "",
    `- archive path: \`${archive.archivePath}\``,
    `- archive branch: \`${archive.branch}\``,
    `- archived_at: ${archive.archivedAt}`,
    `- archive reason: ${archive.reason}`,
    `- uncommitted: ${uncommitted}`,
    `- last commit: \`${lastSha}\``,
    "",
    `1. \`cd ${archive.archivePath}\` で前回作業を確認`,
    "   - `cat .archive-meta.json` で archive 理由・最終 commit・uncommitted の有無",
    `   - \`git log --oneline ${archive.branch} -10\` で前回どこまで commit されたか`,
    "   - `git status` で uncommitted な作業がないか",
    "2. 引き継ぎ判断:",
    "   - 続行できそう → `git cherry-pick` / patch 適用で新 worktree に取り込む",
    "   - 別アプローチが必要 → archive は無視して fresh start、判断理由を journal に残す",
    "3. 判断結果を journal に明記してから本作業に入る",
    "",
    "> 旧 archive を一覧で見たい場合は `elevens worktree archive list --task-id <id>` で確認できる。",
    "",
  ].join("\n");
}

/**
 * `parseDuration(s)` — humanized duration string ("30d", "12h", "7d12h" 等) を ms へ変換。
 *
 * 受け付ける単位: w (week), d (day), h (hour), m (minute), s (second), ms.
 * 空白なし、複数単位連結可、整数のみ (小数禁止)。invalid な入力は throw。
 */
export function parseDuration(s: string): number {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error(`parseDuration: empty input`);
  }
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  // 例: "7d12h30m" / "500ms"
  const re = /(\d+)(ms|w|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const whole = match[0];
    const num = match[1];
    const unit = match[2];
    if (!unit || !num) {
      throw new Error(`parseDuration: invalid input "${s}"`);
    }
    const mult = units[unit];
    if (mult === undefined) {
      throw new Error(`parseDuration: unknown unit "${unit}" in "${s}"`);
    }
    total += Number(num) * mult;
    consumed += whole.length;
  }
  if (consumed !== s.length || total === 0) {
    throw new Error(`parseDuration: invalid input "${s}"`);
  }
  return total;
}
