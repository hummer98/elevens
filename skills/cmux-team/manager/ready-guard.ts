/**
 * T035: ready 昇格 sync guard 共有モジュール。
 *
 * 旧 `main.ts:runSyncCheckOrExit`（T283/T339/T358）の本体ロジックを抽出し、
 * CLI（create-task / update-task --status ready）と TUI（Tasks リストの r キー昇格）の
 * 両方から同一経路で呼べるようにした。verdict 分岐 / auto-pull 実行 / manager.log /
 * events.jsonl emit はすべて本モジュール内に残すため、CLI / TUI で観測可能性が
 * 完全に一致する（同一セマンティクスの構造的保証）。
 *
 * 副作用の写像は呼び出し側の責務:
 * - CLI: notices → console.warn / console.log、ok:false → console.error + exit 1
 * - TUI: notices → manager.log、ok:false → error toast
 *
 * 注意（design-review R1）: `log` / `emitEvent` の出力先は
 * `process.env.PROJECT_ROOT || process.cwd()` で解決される（既存グローバル挙動を維持）。
 * `projectRoot` 引数が適用されるのは `loadConfig` / `checkSyncState` / `runAutoPull`
 * のみであり、ログ・イベントの出力先を切り替えるものではない。
 */
import { loadConfig } from "./config";
import { checkSyncState, runAutoPull, type SyncState } from "./git-sync";
import { log } from "./logger";
import { emitEvent } from "./events-writer";

/**
 * T339: auto-pull verdict を受けたときの「副作用なしの決定」を返す pure 関数。
 * `runSyncCheckOrExit` から切り出して unit-testable にする（design-review M2）。
 * T035 で main.ts から本モジュールへ移設（main.ts は re-export で互換維持）。
 */
export type AutoPullDecision =
  | { kind: "skip-warn"; warnMessages: string[] }
  | { kind: "perform"; mainBranch: string; preMessage: string };

export function decideAutoPullAction(
  verdict: { kind: "auto-pull"; mainBranch: string; message: string },
  opts: { noAutoPull: boolean },
): AutoPullDecision {
  if (opts.noAutoPull) {
    return {
      kind: "skip-warn",
      warnMessages: [verdict.message, `warning: --no-auto-pull set; auto-pull skipped.`],
    };
  }
  return {
    kind: "perform",
    mainBranch: verdict.mainBranch,
    preMessage: verdict.message,
  };
}

/**
 * T339: `runAutoPull` の結果から表示すべき log / error メッセージを組み立てる pure 関数。
 * 失敗時のメッセージには `Bypass:` ヒントと `diverged 可能性` ヒント（design-review m3）を含む。
 */
export type AutoPullOutcomeFormatted =
  | { kind: "ok"; summary: string; logMessage: string }
  | { kind: "fail"; stderrSummary: string; errorMessage: string };

export function formatAutoPullOutcome(
  pull: { ok: boolean; stdout: string; stderr: string; summary: string },
  mainBranch: string,
): AutoPullOutcomeFormatted {
  if (pull.ok) {
    return {
      kind: "ok",
      summary: pull.summary,
      logMessage: `[sync-check] auto-pulled origin/${mainBranch} (${pull.summary})`,
    };
  }
  return {
    kind: "fail",
    stderrSummary: pull.stderr.trim().replace(/\s+/g, " "),
    errorMessage:
      `Error: auto git pull --ff-only origin ${mainBranch} failed.\n` +
      `  stdout: ${pull.stdout.trim()}\n` +
      `  stderr: ${pull.stderr.trim()}\n\n` +
      `  Hint: local ${mainBranch} may have diverged since fetch; ` +
      `try \`git pull --rebase origin ${mainBranch}\` manually.\n` +
      `  Bypass: add --no-auto-pull (warn-only) or --force (skip sync check entirely)`,
  };
}

/** 呼び出し側が console.warn / console.log（または log）へ写像する通知 */
export type ReadyGuardNotice = { level: "info" | "warn"; message: string };

export type ReadyGuardResult =
  | { ok: true; notices: ReadyGuardNotice[] }
  // ok:false 側も notices を持つ（T035 inspection Finding #2）:
  // auto-pull 失敗時に preMessage（"behind-ff … pulling…" の案内行）を
  // エラーより先に表示する旧 CLI 挙動を保つため。reject 経路では空配列
  | {
      ok: false;
      state: SyncState | "auto_pull_failed";
      message: string;
      notices: ReadyGuardNotice[];
    };

export interface ReadyGuardOptions {
  /** "ready" 以外は即 ok（チェック対象外） */
  status: string | undefined;
  forceFlag: boolean;
  skipFetch: boolean;
  /** T339: true で auto-pull を抑止し warn 扱いにする */
  noAutoPull: boolean;
  phase: "create" | "update";
  taskId?: string;
  /** テスト用 git 注入。checkSyncState にそのまま passthrough */
  git?: (args: string[]) => Promise<string>;
  /** テスト用 git 注入。runAutoPull にそのまま passthrough（戻り値型が git と異なる点に注意） */
  pullGit?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * T283: ready 昇格時に local `<mainBranch>` と `origin/<mainBranch>` の整合性を
 * 検証する共有ガード。
 *
 * - status が "ready" でない / forceFlag / `CMUX_TEAM_SKIP_SYNC_CHECK=1` の
 *   いずれかで skip する
 * - loadConfig().mainBranch が未設定ならログのみ出して skip（cmdStart 前に
 *   タスクを切る UX を殺さないため。Decision Log D11）
 * - reject / auto-pull 失敗 → `{ ok: false, state, message, notices }`
 *   （auto-pull 失敗時は notices に preMessage を含む。エラーより先に写像すること）
 * - warn / auto-pull 成功 → `{ ok: true, notices }`（notices は表示順を保持）
 */
export async function runReadySyncGuard(
  projectRoot: string,
  opts: ReadyGuardOptions,
): Promise<ReadyGuardResult> {
  if (opts.status !== "ready") return { ok: true, notices: [] };
  if (opts.forceFlag) {
    await log(
      "ready_force_bypass",
      `phase=${opts.phase}${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return { ok: true, notices: [] };
  }
  if (process.env.CMUX_TEAM_SKIP_SYNC_CHECK === "1") {
    await log(
      "ready_sync_skipped",
      `phase=${opts.phase} reason=env${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return { ok: true, notices: [] };
  }

  const config = await loadConfig(projectRoot);
  const mainBranch = config.mainBranch?.trim();
  if (!mainBranch) {
    await log(
      "ready_sync_skipped",
      `phase=${opts.phase} reason=no_main_branch${opts.taskId ? ` task_id=${opts.taskId}` : ""}`,
    );
    return { ok: true, notices: [] };
  }

  const result = await checkSyncState(projectRoot, {
    mainBranch,
    doFetch: !opts.skipFetch,
    git: opts.git,
  });
  const taskIdField = opts.taskId ? ` task_id=${opts.taskId}` : "";
  switch (result.verdict.kind) {
    case "allow":
      return { ok: true, notices: [] };
    case "reject":
      await log(
        "ready_rejected",
        `phase=${opts.phase} state=${result.state}${taskIdField}`,
      );
      // T358 §6.7: events.jsonl にも sync guard reject を流す。
      // reject に到達する SyncState は diverged / uncommitted / detached のみ。
      await emitEvent({
        event: "task_sync_guard_rejected",
        task_id: opts.taskId ?? "",
        kind: result.state as "diverged" | "uncommitted" | "detached",
        detail: result.verdict.message,
        main_branch: mainBranch,
      });
      return {
        ok: false,
        state: result.state,
        message: result.verdict.message,
        notices: [],
      };
    case "warn":
      await log(
        "ready_warning",
        `phase=${opts.phase} state=${result.state}${taskIdField}`,
      );
      return {
        ok: true,
        notices: [{ level: "warn", message: result.verdict.message }],
      };
    case "auto-pull": {
      // T339: behind-ff + on-main は自動 pull で解消を試みる。
      // 決定ロジックは pure な decideAutoPullAction / formatAutoPullOutcome に分離。
      const decision = decideAutoPullAction(result.verdict, {
        noAutoPull: opts.noAutoPull,
      });
      if (decision.kind === "skip-warn") {
        await log(
          "ready_warning",
          `phase=${opts.phase} state=${result.state}${taskIdField} reason=auto_pull_disabled`,
        );
        return {
          ok: true,
          notices: decision.warnMessages.map((m) => ({
            level: "warn" as const,
            message: m,
          })),
        };
      }
      const pull = await runAutoPull(projectRoot, {
        mainBranch: decision.mainBranch,
        git: opts.pullGit,
      });
      const outcome = formatAutoPullOutcome(pull, decision.mainBranch);
      if (outcome.kind === "ok") {
        await log(
          "ready_auto_pull_succeeded",
          `phase=${opts.phase} state=${result.state}${taskIdField} summary=${outcome.summary}`,
        );
        return {
          ok: true,
          notices: [
            { level: "info", message: decision.preMessage },
            { level: "info", message: outcome.logMessage },
          ],
        };
      }
      await log(
        "ready_auto_pull_failed",
        `phase=${opts.phase} state=${result.state}${taskIdField} stderr=${outcome.stderrSummary}`,
      );
      // T358 §6.7: auto-pull failed は kind 固定値で events.jsonl に流す。
      await emitEvent({
        event: "task_sync_guard_rejected",
        task_id: opts.taskId ?? "",
        kind: "auto_pull_failed",
        detail: outcome.stderrSummary,
        main_branch: mainBranch,
      });
      // 旧 CLI は preMessage を pull 実行前に出力していたため失敗時も表示されていた。
      // notices に積んで呼び出し側がエラーより先に写像する（出力順: preMessage → エラー）
      return {
        ok: false,
        state: "auto_pull_failed",
        message: outcome.errorMessage,
        notices: [{ level: "info", message: decision.preMessage }],
      };
    }
    default: {
      const _exhaustive: never = result.verdict;
      void _exhaustive;
      return { ok: true, notices: [] };
    }
  }
}
