/**
 * Conductor の初期化・タスク割り当て・監視・結果回収・リセット
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, mkdir, readdir, rm, stat, copyFile } from "fs/promises";
import { join, relative, dirname } from "path";
import { loadTaskState, findAssignmentConflict } from "./task";
import * as cmux from "./cmux";
import { generateConductorTaskPrompt } from "./template";
import { log, formatSurface } from "./logger";
import { notifyStateChanged } from "./eventBus";
import { formatExecError } from "./exec-error";
import { initDB, insertTaskSession } from "./trace-store";
import { resolveWorktreeBase } from "./worktree-base";
import { resolveFetchBeforeWorktree, loadConfig, resolveReservedRenameDelayMs } from "./config";
import type { ConductorState, LayoutMode } from "./schema";
import { ClaudeCodeBackend } from "./claude-code-backend";
import { shellQuote, buildLaunchCommand } from "./util";
import {
  archiveWorktree,
  buildArchivedWorktreeSection,
  findArchivesForTaskId,
  type ArchiveReason,
} from "./worktree-archive";

const execFile = promisify(execFileCb);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- AssignTaskError ---

/**
 * assignTask 失敗時の分類
 * - "task": タスク固有の問題（worktree 作成失敗、タスクファイル不備など）
 *   → 該当タスクを abort、Conductor は idle のまま
 * - "conductor": Conductor 側の問題（cmux send 失敗、surface 不在など）
 *   → Conductor を disconnected にする
 */
export type AssignFailureKind = "task" | "conductor";

export class AssignTaskError extends Error {
  public readonly kind: AssignFailureKind;
  public readonly reason: string;
  constructor(kind: AssignFailureKind, reason: string, cause?: unknown) {
    super(reason);
    this.name = "AssignTaskError";
    this.kind = kind;
    this.reason = reason;
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}

// --- launchConductor ---

/** resume 復元の 1 件分 */
export interface ResumePlanItem {
  taskId: string;
  taskRunId: string;
  worktreePath: string;
  sessionId: string;
  taskTitle?: string;
}

/** resume 割当結果（surface と task の紐付け） */
export interface ResumeAssignment {
  surface: string;
  taskId: string;
  taskRunId: string;
  worktreePath: string;
  sessionId: string;
  taskTitle?: string;
}

/**
 * 指定 surface 上で Conductor Claude セッションを起動する（resume 経路のみ）。
 *
 * T421: 新方式では「pane 作成時に claude を起動しない」ため、本関数は **resume 経路専用**
 * になった。通常起動は `initializeConductorSlots` が `state.conductors` に reserved entry を
 * pre-set するだけで claude は spawn せず、初回タスク assign 時の `assignTask` 内で kill+spawn
 * 経路（`backend.reset()`）を経由して spawn-conductor が呼ばれる。
 *
 * resume 経路:
 *   - 環境変数をシェルに焼き付け
 *   - `cmux-team spawn-conductor --resume <session-id>` を起動（既存 session を復元）
 *   - タブ名を `[N] Conductor` に設定
 *
 * F8: `taskState` を引数で受け取り、二重 load を回避（純粋関数化）。
 *
 * T228: 登録は `cmdSpawnConductor` の self-register に委譲。
 * T207: pane キャッシュ引数は廃止。pane 解決は呼び出し時には不要で、後段の
 * spawn-agent / resetConductor が `cmux.getPaneForSurface` /
 * `cmux.listSiblingSurfaces` を on-demand で呼ぶ。
 */
export async function launchConductor(
  projectRoot: string,
  surface: string,
  opts: {
    resumeTaskId?: string;
    /** T421: resume 時に session-id を直接受け取る経路（呼び出し元が resumePlan
     *  から既に取得している場合に使う）。省略時は taskState から引く。 */
    resumeSessionId?: string;
    mainBranch: string;
    taskState?: import("./task").TaskStateMap;
  },
  backend?: ClaudeCodeBackend,
): Promise<import("./runtime-backend").SessionRef | undefined> {
  // 1. 環境変数をシェルに焼き付け
  //    CMUX_SURFACE: cmdSpawnConductor が読み取る（必須）。hook も参照する
  //    CMUX_CLAUDE_HOOKS_DISABLED: 統一（旧 spawnSingleConductor のみ欠落していた）
  //    CMUX_TEAM_MAIN_BRANCH: T213 で追加。cmdSpawnConductor が env → config の順で
  //       解決するための一次ソース（race の構造的排除）。T253 で暗黙 "main"
  //       フォールバックを削除。空文字なら fail-stop（silent failure 防止）。
  if (!opts.mainBranch.trim()) {
    throw new Error(
      "launchConductor: opts.mainBranch must be a non-empty string " +
        "(T253: fail-stop when mainBranch is unresolved)",
    );
  }
  const mainBranchEnv = opts.mainBranch.trim();
  // T283: Conductor 自身が直接 shell で `cmux-team create-task --status ready`
  // を叩く経路で、worktree 配下の HEAD 状態に起因する false reject を防ぐために
  // `CMUX_TEAM_SKIP_SYNC_CHECK=1` を明示的に焼き付ける（Master shell には注入しない）。
  const env: Record<string, string> = {
    CMUX_SURFACE: surface,
    CMUX_CLAUDE_HOOKS_DISABLED: "1",
    CMUX_TEAM_MAIN_BRANCH: mainBranchEnv,
    CMUX_TEAM_SKIP_SYNC_CHECK: "1",
    CMUX_NO_RENAME_TAB: "1",
  };

  // 2. Claude 起動コマンド組み立て
  //    T421: resume 経路は session-id を直接受け取る新仕様。
  //          task-state.json から sessionId を引いて `--resume <session-id>` 形式に変換する。
  //    F8: taskState を引数で受け取って二重 load を避ける（呼び出し元が 1 回 load）。
  let launchCmd: string;
  if (opts.resumeTaskId) {
    // 優先順: opts.resumeSessionId > opts.taskState > loadTaskState(projectRoot)
    let sessionId: string | undefined = opts.resumeSessionId;
    if (!sessionId) {
      const taskState = opts.taskState ?? await loadTaskState(projectRoot);
      sessionId = taskState[opts.resumeTaskId]?.sessionId;
    }
    if (!sessionId) {
      throw new Error(
        `launchConductor: no sessionId for task ${opts.resumeTaskId} (opts.resumeSessionId / taskState lookup both empty)`,
      );
    }
    launchCmd = buildLaunchCommand(projectRoot, `elevens spawn-conductor --resume ${sessionId}`);
  } else {
    launchCmd = buildLaunchCommand(projectRoot, "elevens spawn-conductor");
  }

  // backend が渡されない場合はデフォルトの ClaudeCodeBackend を使う（後方互換）。
  // ClaudeCodeBackend.spawn() は cmux.send を呼び出すため、
  // テストの cmux.send spy は backend 経由でも引き続き有効。
  const _backend = backend ?? new ClaudeCodeBackend();
  const sessionRef = await _backend.spawn({ role: "conductor", prompt: "", workdir: surface, surface, launchCmd, env });

  // 3. タブ名設定
  //    resume / 新規問わず `[N] Conductor` を設定する。
  //    T193 でタブ名はロール固定表記にしたため、後続で assign/reset 時に
  //    rename する必要はなく、ここで一度だけ設定すれば十分。
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] Conductor`);
  // Issue #30 M3-b: spawn から得た SessionRef を呼び出し元に返す。
  // daemon.ts が conductor.runtimeSessionRef に保存して handleRuntimeEvent のルックアップに使う。
  return sessionRef;
}

// --- createConductorPanes ---

/**
 * Conductor 用の pane を分割作成する（Claude は起動しない）
 *
 * layout:
 *   - "16x9" (default): 上段フル幅 daemon+Master、下段を 2 分割して C1（左）/ C2（右）（最大 2）
 *   - "wide": 2x2 — 左上 daemon+Master、右上 C1、左下 C2、右下 C3（最大 3）
 */
export async function createConductorPanes(
  count: number,
  daemonSurface?: string,
  layout: LayoutMode = "16x9",
): Promise<string[]> {
  const panes: string[] = [];

  if (layout === "16x9") {
    if (count > 2) {
      // env CMUX_TEAM_MAX_CONDUCTORS で 3 以上を要求されても 16x9 は 2 pane しか作らない。
      // 呼び出し元（daemon.ts）でも警告ログを出すが、ここでは clamp して続行する。
      await log(
        "layout_16x9_clamp",
        `requested=${count} clamped=2 — 16x9 layout supports max 2 conductors`,
      );
      count = 2;
    }
    // 1. daemon を下に split → Conductor-1 pane（下段の基底）
    const s1 = await cmux.newSplit(
      "down",
      daemonSurface ? { surface: daemonSurface } : undefined,
    );
    panes.push(s1);

    if (count >= 2) {
      // 2. Conductor-1 pane を右に split → Conductor-2 pane（下段を等幅 2 分割）
      const s2 = await cmux.newSplit("right", { surface: s1 });
      panes.push(s2);
    }

    return panes;
  }

  // --- layout === "wide"（既存ロジック） ---
  // 1. daemon を右に split → Conductor-1 pane
  const s1 = await cmux.newSplit("right", daemonSurface ? { surface: daemonSurface } : undefined);
  panes.push(s1);

  if (count >= 2) {
    // 2. daemon を下に split → Conductor-2 pane
    const s2 = await cmux.newSplit("down", daemonSurface ? { surface: daemonSurface } : undefined);
    panes.push(s2);
  }

  if (count >= 3) {
    // 3. Conductor-1 を下に split → Conductor-3 pane
    const s3 = await cmux.newSplit("down", { surface: s1 });
    panes.push(s3);
  }

  return panes;
}

// --- initializeConductorSlots ---

export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number = 3,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
  layout: LayoutMode = "16x9",
  mainBranch: string = "",
  backend?: ClaudeCodeBackend,
): Promise<ResumeAssignment[]> {
  // T253: mainBranch は required。空文字なら fail-stop（silent failure 防止）
  if (!mainBranch.trim()) {
    throw new Error(
      "initializeConductorSlots: mainBranch must be a non-empty string " +
        "(T253: fail-stop when mainBranch is unresolved)",
    );
  }
  const assignments: ResumeAssignment[] = [];
  try {
    await log("conductor_slots_creating", `count=${count} layout=${layout}`);

    // Phase 1: pane 分割（Claude は起動しない）
    await log("conductor_panes_creating", "");
    const panes = await createConductorPanes(count, daemonSurface, layout);
    await log("conductor_panes_created", `count=${panes.length}`);

    // Phase 2: Claude 起動 / 予約 entry 作成
    //   T421: 新方式では非 resume 経路は claude を spawn せず、Manager 内部で
    //         `state.conductors` に reserved entry を pre-set するだけ。
    //         初回 assignTask が kill+spawn 経路で spawn-conductor を起動する。
    //   resume 経路は従来通り launchConductor で `cmux-team spawn-conductor --resume <session-id>` を起動。
    //         resumePlan 自体に sessionId を含むため task-state.json lookup は不要。
    await log("conductor_claude_launching", "");
    for (const [i, surface] of panes.entries()) {
      const resumeItem = resumePlan?.[i];
      if (resumeItem) {
        await launchConductor(projectRoot, surface, {
          resumeTaskId: resumeItem.taskId,
          resumeSessionId: resumeItem.sessionId,  // F8: resumePlan の sessionId を直接渡す
          mainBranch,
        }, backend);
        assignments.push({
          surface,
          taskId: resumeItem.taskId,
          taskRunId: resumeItem.taskRunId,
          worktreePath: resumeItem.worktreePath,
          sessionId: resumeItem.sessionId,
          taskTitle: resumeItem.taskTitle,
        });
      }
      // T421: 非 resume 経路は launchConductor を呼ばない。下の reserved pre-set ループで
      //       state.conductors に reserved entry を作るだけ。タブ名設定は initial spawn 時に
      //       `cmdSpawnConductor` 経由で `[N] Conductor` に rename される。
    }

    // resume 時の state pre-population: main.ts:699-718 の resume 割当反映ループが
    // state.conductors.get(r.surface) で既存エントリを mutate するため、
    // initializeLayout 完了時点で state.conductors に resume 対象 surface が
    // 同期的に存在する必要がある。
    // T421: 非 resume 経路は reserved entry を pre-set する（claude 未起動を表現）。
    //       初回 assignTask の kill+spawn で spawn-conductor が起動 →
    //       CONDUCTOR_REGISTERED で sessionId merge → SESSION_STARTED で running 遷移する。
    // T026 (Rec #2/#8): reserved 分岐の delay re-rename を Promise.all で並列化する。
    //   serial に sleep を入れると N*delayMs 遅延になるため、各 pane の delay は独立に走らせ
    //   ループ後の Promise.all で一括 await する。pane 数によらず合計遅延は delayMs 1 回分に収束。
    const reservedDelayMs = resolveReservedRenameDelayMs(await loadConfig(projectRoot));
    const reservedDelayedRenames: Promise<void>[] = [];
    for (const [i, surface] of panes.entries()) {
      const resumeItem = resumePlan?.[i];
      if (resumeItem && !conductors.has(surface)) {
        await log("conductor_resume_prepopulated", formatSurface(surface, "C"));
        conductors.set(surface, {
          surface,
          status: "running",
          startedAt: new Date().toISOString(),
          agents: [],
          taskId: resumeItem.taskId,
          taskRunId: resumeItem.taskRunId,
          worktreePath: resumeItem.worktreePath,
          taskTitle: resumeItem.taskTitle,
          // sessionId なし — SessionStart hook で後から設定される
        });
      } else if (!resumeItem && !conductors.has(surface)) {
        // T421: pane だけ作って claude 未起動の "reserved" 状態。
        //       findIdleConductor が isAssignableStatus 経由で拾う対象。
        await log("conductor_reserved", formatSurface(surface, "C"));
        conductors.set(surface, {
          surface,
          status: "reserved",
          startedAt: new Date().toISOString(),
          agents: [],
        });
        // タブ名を `[N] Conductor` に設定（claude 未起動でも UI 上は Conductor として見せる）。
        // 初回 assign 時に kill+spawn → cmdSpawnConductor が `CMUX_NO_RENAME_TAB=1` を立てるので
        // ここで設定したタブ名は維持される。
        // T026: 即時 rename は W-A (c11 default title setter ~570ms 後) に上書きされる可能性が
        //       高いため、`reservedDelayMs` 後に再度 assert する遅延 re-rename を予約する。
        //       初回 rename / 遅延 re-rename とも assertTabTitle 経由で title_reassert ログを残す。
        const num = surface.replace("surface:", "");
        await cmux.assertTabTitle(surface, `[${num}] Conductor`, "conductor reserved");
        reservedDelayedRenames.push(
          (async () => {
            await sleep(reservedDelayMs);
            await cmux.assertTabTitle(
              surface,
              `[${num}] Conductor`,
              "conductor reserved delayed",
            );
          })(),
        );
      }
    }
    // T026: 並列化した delay re-rename をまとめて await（Rec #2）。pane 数 N に対し合計 delayMs 1 回分。
    if (reservedDelayedRenames.length > 0) {
      await Promise.all(reservedDelayedRenames);
    }

    await log("conductor_slots_initialized", `count=${panes.length}`);
  } catch (e: any) {
    await log("error", `initializeConductorSlots failed: ${e.message}`);
  }
  return assignments;
}

// --- assignTask ---

export async function assignTask(
  conductor: ConductorState,
  taskId: string,
  projectRoot: string,
  mainBranch: string,
  backend?: ClaudeCodeBackend,
): Promise<ConductorState> {
  // T253: mainBranch は required。空文字なら fail-stop（silent failure 防止）
  if (!mainBranch.trim()) {
    throw new Error(
      "assignTask: mainBranch must be a non-empty string " +
        "(T253: fail-stop when mainBranch is unresolved)",
    );
  }
  const taskRunId = `task-${taskId.padStart(3, '0')}-${Math.floor(Date.now() / 1000)}`;
  const worktreePath = join(projectRoot, ".worktrees", taskRunId);
  const branch = `${taskRunId}/task`;
  let worktreeCreated = false;

  try {
    // --- 0. Unique 検査（T254: 同一 taskId の二重 assign 防止） ---
    //   worktree 作成より前に検査することで違反時の cleanup コストを回避する。
    //   違反検出時は AssignTaskError("task", ...) を throw し、scanTasks の既存
    //   エラーハンドラで task abort + Conductor idle 維持の経路に乗せる
    //   （kind=conductor にしない。Conductor 自体は壊れていない）。
    const currentTaskState = await loadTaskState(projectRoot);
    const conflict = findAssignmentConflict(currentTaskState, taskId, conductor.surface);
    if (conflict.conflict) {
      await log(
        "task_unique_violation_runtime",
        `task_id=${taskId} existing_surface=${conflict.existingSurface} conflict_surface=${conductor.surface}`,
      );
      throw new AssignTaskError(
        "task",
        `task_already_assigned_to=${conflict.existingSurface}`,
      );
    }

    // --- 1. タスクファイル検索（ハイブリッド対応） ---
    const tasksDir = join(projectRoot, ".team/tasks");
    let entries: string[];
    try {
      entries = await readdir(tasksDir);
    } catch (e: any) {
      throw new AssignTaskError("task", `tasks dir not readable: ${e.message}`, e);
    }
    let taskContent: string | null = null;
    let taskDir: string | undefined;

    for (const entry of entries) {
      const id = entry.match(/^0*(\d+)/)?.[1];
      if (id !== taskId && id !== taskId.replace(/^0+/, "")) continue;

      const fullPath = join(tasksDir, entry);
      const s = await stat(fullPath);

      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          taskContent = await readFile(taskMdPath, "utf-8");
          taskDir = fullPath;
        }
      } else if (entry.endsWith(".md")) {
        taskContent = await readFile(fullPath, "utf-8");
      }
      break;
    }

    if (!taskContent) {
      throw new AssignTaskError("task", `task file not found: id=${taskId}`);
    }

    const taskTitle = taskContent.match(/^title:\s*(.+)/m)?.[1]?.trim() || "unknown";
    const baseBranch = taskContent.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim();

    // --- 2. git worktree 作成 ---
    const baseResolution = await resolveWorktreeBase(projectRoot, {
      baseBranch,
      mainBranch,
      doFetch: resolveFetchBeforeWorktree().enabled,
    });
    try {
      const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
      if (baseResolution.startPoint) {
        worktreeArgs.push(baseResolution.startPoint);  // start-point を指定
      }
      await execFile("git", worktreeArgs, {
        cwd: projectRoot,
      });
      worktreeCreated = true;
    } catch (e: any) {
      throw new AssignTaskError("task", `git worktree add failed: ${formatExecError(e)}`, e);
    }

    // T284: rerere (reuse recorded resolution) を worktree scope で有効化
    //   Step 8 semantic resolution で同一 conflict が再出現した際の時短用。
    //   第1試行: --worktree（extensions.worktreeConfig=true 必要）
    //   第2試行: --local（main repo の .git/config に書く。worktree 群で共有）
    //   いずれも best-effort。失敗しても worktree 作成自体は成功扱い。
    {
      let rerereScope: "worktree" | "local" | null = null;
      try {
        await execFile("git", ["config", "--worktree", "rerere.enabled", "true"], {
          cwd: worktreePath,
          timeout: 10000,
        });
        rerereScope = "worktree";
      } catch {
        try {
          await execFile("git", ["config", "--local", "rerere.enabled", "true"], {
            cwd: worktreePath,
            timeout: 10000,
          });
          rerereScope = "local";
        } catch (e: any) {
          await log(
            "rerere_enable_failed",
            `worktree=${worktreePath} ${formatExecError(e)}`,
          );
        }
      }
      if (rerereScope) {
        await log("rerere_enabled", `worktree=${worktreePath} scope=${rerereScope}`);
      }
    }

    // T243: worktree 作成直後に rev-parse HEAD で base SHA を取得する
    //   `git worktree add -b <new> <start-point>` は HEAD を start-point に揃えるので
    //   worktree の cwd で rev-parse HEAD を打てば「実際に出発した commit」が手に入る。
    //   失敗時は null + error ログで継続し、DB insert はそのまま続行する。
    let baseSha: string | null = null;
    try {
      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        timeout: 30000,
      });
      const sha = stdout.trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        baseSha = sha;
      } else {
        await log("error", `rev-parse HEAD returned unexpected value in worktree: path=${worktreePath} value=${sha.slice(0, 64)}`);
      }
    } catch (e: any) {
      await log("error", `rev-parse HEAD failed in worktree: path=${worktreePath} ${formatExecError(e)}`);
    }

    const shortSha = baseSha ? baseSha.slice(0, 7) : "-";
    await log(
      "worktree_created",
      `branch=${branch} base=${baseResolution.baseLabel} source=${baseResolution.source} sha=${shortSha} path=${worktreePath}`,
    );

    // .claude/settings.local.json を worktree にコピー
    // （untracked なので worktree に含まれないが、Agent 起動時に必要）
    const settingsSrc = join(projectRoot, ".claude/settings.local.json");
    if (existsSync(settingsSrc)) {
      const settingsDst = join(worktreePath, ".claude/settings.local.json");
      await mkdir(dirname(settingsDst), { recursive: true })
        .then(() => copyFile(settingsSrc, settingsDst))
        .then(() => log("settings_copied_to_worktree", `worktree=${worktreePath}`))
        .catch(async (e: any) => {
          await log("error", `settings copy failed: worktree=${worktreePath} ${e.message}`);
        });
    }

    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
        await log("error", `npm install failed in worktree: path=${worktreePath} ${formatExecError(e)}`);
      });
    }

    // --- 3. Conductor プロンプト生成 ---
    let outputDir: string;
    if (taskDir) {
      // 新形式: タスクフォルダ内
      outputDir = relative(projectRoot, join(taskDir, "runs", taskRunId));
    } else {
      // 旧形式: .team/output/
      outputDir = `.team/output/${taskRunId}`;
    }
    await mkdir(join(projectRoot, outputDir), { recursive: true });

    // T011: 同 taskId の最新 archive 情報を prompt に section として埋め込む。
    //   archive 不在時 buildArchivedWorktreeSection は空文字を返し、template から section 全体が消える。
    let archivedSection = "";
    try {
      const archives = await findArchivesForTaskId(projectRoot, taskId);
      archivedSection = buildArchivedWorktreeSection(archives[0]);
    } catch (e: any) {
      await log(
        "archive_section_lookup_failed",
        `task_id=${taskId} ${formatExecError(e)}`,
      );
    }

    let promptFile: string;
    try {
      promptFile = await generateConductorTaskPrompt(
        projectRoot,
        taskRunId,
        taskId,
        taskContent,
        worktreePath,
        outputDir,
        baseBranch,
        taskDir,
        mainBranch,
        archivedSection,
      );
    } catch (e: any) {
      throw new AssignTaskError("task", `prompt generation failed: ${e.message}`, e);
    }

    // --- 4. 既存 claude を kill+spawn して新セッションを起動（T421） ---
    // T232: assigning を立てる。daemon 経路の SESSION_ENDED が kill 中に届いても
    //       killInProgressUntil で disconnected 遷移を抑止する（F6）。
    // T265: assigning にセットした正確な時刻を記録する（formatUserClearDecision
    //       の assigning_set_at が参照する）。conductor.status と同じトランザクションで set。
    // T421/F6: kill 中の SESSION_ENDED を suppress するための window（5s）。
    //       SESSION_STARTED で assigning → running 遷移時にクリアされる。
    conductor.status = "assigning";
    conductor.assigningSetAt = new Date().toISOString();
    conductor.killInProgressUntil = Date.now() + 5000;
    notifyStateChanged("conductor.ts:assignTask:assigning-set");

    // T421/D7: promptFile のサニタイズ
    //   `cmux send` で shell に投入されるため、空白・改行・shell metacharacter が
    //   混入すると command injection になる。Manager 制御下のパスだが防御的に reject。
    if (!promptFile.startsWith("/")) {
      throw new AssignTaskError(
        "task",
        `promptFile must be absolute path: ${promptFile}`
      );
    }
    if (/[\s\n]/.test(promptFile)) {
      throw new AssignTaskError(
        "task",
        `promptFile must not contain whitespace/newline: ${promptFile}`
      );
    }
    if (/[;|&$`()<>'"]/.test(promptFile)) {
      throw new AssignTaskError(
        "task",
        `promptFile must not contain shell metacharacters: ${promptFile}`
      );
    }
    const quotedPath = shellQuote(promptFile);
    const launchCmd = buildLaunchCommand(projectRoot, `elevens spawn-conductor --task-prompt ${quotedPath}`);

    const env: Record<string, string> = {
      CMUX_SURFACE: conductor.surface,
      CMUX_CLAUDE_HOOKS_DISABLED: "1",
      CMUX_TEAM_MAIN_BRANCH: mainBranch,
      CMUX_TEAM_SKIP_SYNC_CHECK: "1",
    };

    // T421/F5/R2: kill 前に sessionId / pid を明示クリアする。
    //   これがないと CONDUCTOR_REGISTERED の sessionId mismatch warn が毎回出る。
    //   pid は backend.reset の `pid` 引数に焼き付けてから undefined にする。
    const oldPid = conductor.pid;
    conductor.sessionId = undefined;
    conductor.pid = undefined;

    const _backend = backend ?? new ClaudeCodeBackend();
    const sessionRef = _backend.surfaceToRef(conductor.surface);
    try {
      await _backend.reset(sessionRef, {
        launchCmd,
        env,
        pid: oldPid, // reserved 状態 (oldPid===undefined) のときは内部で kill skip
      });
      // T261: 送信したプロンプトの byte 長を記録
      //       byte 長は UTF-8 換算（D9: API レート制限の byte 感覚と揃える）。
      //       D7 採用後は CLI 引数経由なので「TUI に send したか」は問わないが、観測ログ用に
      //       promptSentAt / promptBytes は埋める（spec/11-metrics.md の `assign_prompt_sent` 互換）。
      conductor.promptSentAt = new Date().toISOString();
      conductor.promptBytes = Buffer.byteLength(
        `${promptFile} を読んで指示に従って作業してください。`,
        "utf8"
      );
      await log(
        "assign_prompt_sent",
        `${formatSurface(conductor.surface, "C")} task_id=${taskId} bytes=${conductor.promptBytes} prompt_file=${promptFile} via=spawn-conductor-cli`
      );
    } catch (e: any) {
      throw new AssignTaskError("conductor", `kill+spawn failed: ${e.message}`, e);
    }

    // タスク-セッション索引に記録
    try {
      const db = initDB(projectRoot);
      insertTaskSession(db, {
        timestamp: new Date().toISOString(),
        task_id: taskId,
        task_run_id: taskRunId,
        session_id: conductor.sessionId ?? "",
        role: "conductor",
        surface: conductor.surface,
        worktree_path: worktreePath,
        event: "assigned",
        base_branch: baseResolution.baseLabel,
        base_sha: baseSha,
        base_source: baseResolution.source,
      });
      db.close();
    } catch (e: any) {
      log("error", `trace DB assigned insert failed: ${e?.message ?? e}`).catch(() => {});
    }

    // --- 6. ConductorState 更新 ---
    // T232: status は "assigning" のまま維持する（/clear 送信直前にセット済み）。
    //       running への遷移は SESSION_STARTED(source=clear) hook 到達時に行う。
    //       保険経路として SESSION_ACTIVE でも assigning→running へ遷移させる（daemon.ts 側、
    //       現行 hook では発火せず CLI 経由のみ）。60 秒経過で disconnected に倒す timeout もある。
    //       （T277: SESSION_IDLE R1 は撤去済み）
    conductor.taskRunId = taskRunId;
    conductor.taskId = taskId;
    conductor.taskTitle = taskTitle;
    conductor.worktreePath = worktreePath;
    conductor.outputDir = outputDir;
    conductor.startedAt = new Date().toISOString();
    conductor.agents = [];
    // sessionId は SessionStart hook で最新値に追従する
    notifyStateChanged("conductor.ts:assignTask:task-info-updated");

    await log(
      "conductor_started",
      `task_id=${taskId} task_run_id=${taskRunId} ${formatSurface(conductor.surface, "C")} title=${taskTitle}`
    );

    return conductor;
  } catch (e: any) {
    // worktree 作成後に失敗した場合は cleanup する（残骸がブランチ名衝突を引き起こすのを防ぐ）
    if (worktreeCreated) {
      try {
        await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot });
      } catch (ce: any) {
        await log("error", `assignTask cleanup worktree remove failed: path=${worktreePath} ${formatExecError(ce)}`);
      }
      try {
        await execFile("git", ["branch", "-D", branch], { cwd: projectRoot });
      } catch (ce: any) {
        await log("error", `assignTask cleanup branch delete failed: branch=${branch} ${formatExecError(ce)}`);
      }
    }

    if (e instanceof AssignTaskError) throw e;
    // 想定外エラーはタスク側に寄せる（Conductor を守る保守的挙動）
    throw new AssignTaskError("task", `assignTask unexpected error: ${e.message}`, e);
  }
}

// --- resetConductor ---

/**
 * T011 [M4]: cleanupMode discriminated union — 呼び出し側に「archive / delete / preserve」を
 * 必ず選ばせる構造で、社会的契約 (`preserveWorktree?` flag) ではなく型レベルで選択を強制する。
 *
 *  - `{ kind: "archive", reason: ArchiveReason }` — `.team/worktrees-archive/<taskRunId>/` に
 *    mv で退避し branch を保持。observatory への証拠保全。
 *  - `{ kind: "delete", reason: string }` — 旧来の `git worktree remove --force` + branch -d 経路。
 *    `reason="legacy_fallback"` は cleanupMode 未指定時の後方互換 fallback。
 *  - `{ kind: "preserve" }` — worktree / branch を何も触らない (judgment_pending 等)。
 *
 * Phase 2 で `cleanupMode` を required に昇格させ、`preserveWorktree` opt と
 * legacy_fallback path を削除する予定。新規呼び出しでは `cleanupMode` を必ず明示する。
 */
export type CleanupMode =
  | { kind: "delete"; reason: string }
  | { kind: "archive"; reason: ArchiveReason }
  | { kind: "preserve" };

/**
 * Conductor の cleanup を行い、指定された status に遷移させる。
 *
 * T250: `opts.targetStatus` で遷移先を制御する。
 *   - 省略 or "idle": 完全リセット（既存挙動）。disconnectedAt もクリア
 *   - "broken": disconnect timeout 経由で「確定的に壊れた」と記録する経路。
 *     cleanup（siblings close / worktree / branch 削除）は実行するが、
 *     UI 上で「いつ壊れたか」を表示するため `disconnectedAt` は保持する。
 *     次の割当対象から自動除外され、`cmux-team clear-conductor` で idle に戻せる。
 *
 * ログは本関数内で status に応じて `conductor_broken` / `conductor_reset` を発行する。
 * 呼び出し側で個別にログを出してはならない（集約ポリシー — Decision D12）。
 */
export async function resetConductor(
  conductor: ConductorState,
  projectRoot: string,
  workspace?: string,
  opts?: {
    targetStatus?: "idle" | "broken" | "reserved";
    reason?: string;
    // T263: success=false && task-state=assigned 経路で worktree/branch を温存する。
    //       in-memory の ConductorState (taskRunId 等) は preserveWorktree と
    //       無関係に必ずリセットされる（Decision D7）— さもないと次タスク割当が破綻する。
    // DEPRECATED (T011): `cleanupMode: { kind: "preserve" }` と等価。Phase 2 で削除。
    preserveWorktree?: boolean;
    // T011 [M4]: cleanup の挙動を明示的に選ばせる。未指定時は legacy_fallback (delete) 相当。
    cleanupMode?: CleanupMode;
    // T421/D5: true なら conductor.pid に対して claude プロセスを kill する
    //          （pane は保持）。reserved 復帰経路 (user_clear) で使う。
    killClaudeProcess?: boolean;
  },
  backend?: ClaudeCodeBackend,
): Promise<void> {
  try {
    // 0. surface 実在確認（T251: 幽霊 Conductor 防止）
    //    surface が tree に存在しない場合は idle 要求であっても broken に倒す。
    //    v0.9.0+ (T016): tree 失敗時は throw されるが、外側 try で catch するので
    //    本関数の冪等な後処理 (sibling close / worktree remove / branch delete) は
    //    呼び出し元の cleanup ルーチンに委ねる。
    const pane = await cmux.getPaneForSurface(conductor.surface, workspace);
    const surfaceMissing = pane === undefined;
    const effectiveTargetStatus: "idle" | "broken" | "reserved" = surfaceMissing
      ? "broken"
      : (opts?.targetStatus ?? "idle");
    // idle→broken 昇格時のみ surface_missing を使用する。
    // broken を明示した呼び出しは opts.reason をそのまま使う（呼び出し側が原因を把握済みのため）。
    const effectiveReason = (surfaceMissing && opts?.targetStatus !== "broken")
      ? "surface_missing"
      : opts?.reason;

    // backend が渡されない場合はデフォルトの ClaudeCodeBackend を使う（後方互換）。
    // ClaudeCodeBackend.kill() は cmux.closeSurface を呼び出す。
    const _backend = backend ?? new ClaudeCodeBackend();

    // T421/D5: killClaudeProcess=true && conductor.pid 有り の場合は claude プロセスのみ kill。
    //          surface (pane) は保持する（reserved 復帰のための前提）。
    if (opts?.killClaudeProcess && conductor.pid !== undefined) {
      await _backend.killClaudeProcess(_backend.surfaceToRef(conductor.surface), conductor.pid);
    }

    // 1. この Conductor が spawn した Agent surface のみを閉じる。
    //    旧実装は `cmux.listSiblingSurfaces`（= Conductor と同 pane の全 surface）を
    //    「自分の Agent 群」とみなして閉じていたが、listSiblingSurfaces は pane の
    //    同居判定しかできず所有を保証しない。pane に同居する無関係 surface（ユーザーが
    //    手動で積んだ surface 等）まで巻き添えで閉じる事故があったため、所有判定を
    //    daemon が把握している `conductor.agents` に限定する。
    //    トレードオフ: agents リストが不完全な場合（daemon 再起動直後など）は孤児 Agent
    //    surface が閉じ残りうるが、「未知 surface を巻き込む」害より明確に小さいので許容する。
    for (const agent of conductor.agents) {
      if (agent.surface !== conductor.surface) {
        await _backend.kill(
          _backend.surfaceToRef(agent.surface),
          `reset_conductor_agent:${effectiveReason ?? "unknown"}`,
        );
      }
    }

    // 2. worktree cleanup — T011 [M4] cleanupMode で「archive / delete / preserve」を必ず選ばせる
    //    - preserve: 何もしない (judgment_pending 等)
    //    - archive: `.team/worktrees-archive/<taskRunId>/` に mv (証拠保全)
    //    - delete: `git worktree remove --force` + branch -d (旧来挙動 / legacy_fallback)
    //    cleanupMode 未指定時は preserveWorktree フラグから合成する後方互換 fallback。
    // TODO(T011-phase2): cleanupMode を required に昇格させ、preserveWorktree opt と
    //                    legacy_fallback path を削除する。
    const cleanupMode: CleanupMode =
      opts?.cleanupMode
      ?? (opts?.preserveWorktree
        ? { kind: "preserve" }
        : { kind: "delete", reason: "legacy_fallback" });

    if (cleanupMode.kind === "preserve") {
      // 温存: 何もしない
    } else if (
      cleanupMode.kind === "archive"
      && conductor.worktreePath
      && existsSync(conductor.worktreePath)
      && conductor.taskRunId
      && conductor.taskId
    ) {
      try {
        await archiveWorktree({
          projectRoot,
          worktreePath: conductor.worktreePath,
          taskRunId: conductor.taskRunId,
          taskId: conductor.taskId,
          branch: `${conductor.taskRunId}/task`,
          reason: cleanupMode.reason,
          conductorSurface: conductor.surface,
          sessionId: conductor.sessionId,
        });
      } catch (e: any) {
        // archive 失敗時は削除にフォールバックせず、worktree は元場所に残す
        // (user に判断委ねる方針 — R2)
        await log(
          "cleanup_failed",
          `resetConductor archive failed: ${formatExecError(e)}`,
        );
      }
    } else if (cleanupMode.kind === "delete") {
      if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
        try {
          await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
            cwd: projectRoot,
          });
        } catch (e: any) {
          await log(
            "cleanup_failed",
            `resetConductor worktree remove (cleanup_reason=${cleanupMode.reason}): path=${conductor.worktreePath} ${formatExecError(e)}`,
          );
        }
        // ブランチ削除（冪等: 既に削除済みでもエラーにしない）
        if (conductor.taskRunId) {
          const branch = `${conductor.taskRunId}/task`;
          try {
            await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
          } catch (e: any) {
            await log(
              "cleanup_failed",
              `resetConductor branch delete (cleanup_reason=${cleanupMode.reason}): branch=${branch} ${formatExecError(e)}`,
            );
          }
        }
        // T011 [v2-m1]: legacy_fallback を log で identify 可能にする (observatory)
        if (cleanupMode.reason === "legacy_fallback") {
          await log(
            "worktree_delete_legacy_fallback",
            `surface=${conductor.surface} task_run_id=${conductor.taskRunId ?? ""}`,
          );
        }
      }
    }

    // 4. ConductorState リセット
    const targetStatus = effectiveTargetStatus;
    conductor.status = targetStatus;
    conductor.taskRunId = undefined;
    conductor.taskId = undefined;
    conductor.taskTitle = undefined;
    conductor.worktreePath = undefined;
    conductor.outputDir = undefined;
    conductor.agents = [];
    // T261/T265: user_clear 判定用の snapshot フィールドも必ずクリアする。
    //       stale 値で次の割当サイクルの判定を汚染しないため（Decision 記載の安全策）。
    conductor.clearSentAt = undefined;
    conductor.promptSentAt = undefined;
    conductor.promptBytes = undefined;
    conductor.sessionStartedClearAt = undefined;
    conductor.assigningSetAt = undefined;
    // T421/F6: kill+spawn 中の SESSION_ENDED suppression window もクリア
    conductor.killInProgressUntil = undefined;
    // idle / reserved に戻す経路では古い disconnectedAt をクリアする (Minor 3 + T421)。
    // broken 経路では UI の「経過時間」表示のため保持する（将来 clear-conductor で
    // idle に戻す際は、上の条件に従って undefined に落ちる）。
    if (targetStatus === "idle" || targetStatus === "reserved") {
      conductor.disconnectedAt = undefined;
    }
    // T421/D5: reserved 復帰時は sessionId / pid もクリアする（kill 後の真実）。
    if (targetStatus === "reserved") {
      conductor.sessionId = undefined;
      conductor.pid = undefined;
    }
    // sessionId は SessionStart hook で最新値に追従するため reset では触らない（idle/broken 経路）。
    notifyStateChanged(`conductor.ts:resetConductor:status-${targetStatus}`);

    const reasonSuffix = effectiveReason ? ` reason=${effectiveReason}` : "";
    // T263: preserveWorktree=true の場合は grep 可能な suffix を付与し、
    //       `grep 'worktree_preserved=true' manager.log` で温存された worktree を列挙可能にする。
    // T011: cleanupMode.kind="preserve" 経由も同じ suffix で識別可能にする。
    const preservedSuffix = cleanupMode.kind === "preserve" ? ` worktree_preserved=true` : "";
    // broken 時は「本当に死んでいるか」を snapshot 側と対称に示す（pid/alive を明示）。
    // idle 経路では pane 生存確認済みで自明なので出さない。
    const aliveSuffix =
      targetStatus === "broken"
        ? ` pid=${conductor.pid ?? "null"} alive=${conductor.pid !== undefined ? String(cmux.isAlive(conductor.pid)) : "unknown"}`
        : "";
    const event =
      targetStatus === "broken" ? "conductor_broken"
        : targetStatus === "reserved" ? "conductor_reset_reserved"
        : "conductor_reset";
    await log(
      event,
      `${formatSurface(conductor.surface, "C")}${reasonSuffix}${preservedSuffix}${aliveSuffix}`,
    );
  } catch (e: any) {
    await log("error", `resetConductor failed: ${e.message}`);
  }
}

// --- collectResults ---

export async function collectResults(
  conductor: ConductorState,
  projectRoot: string
): Promise<{ journalSummary?: string }> {
  const result: { journalSummary?: string } = {};

  // Journal サマリーを task-state.json から読み取る
  try {
    if (conductor.taskId) {
      const taskState = await loadTaskState(projectRoot);
      const state = taskState[conductor.taskId];
      if (state?.journal) {
        result.journalSummary = state.journal;
      }
    }
  } catch (e: any) {
    await log("error", `collectResults journal read failed: taskId=${conductor.taskId} ${e.message}`);
  }

  return result;
}

