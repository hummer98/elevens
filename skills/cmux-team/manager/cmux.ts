/**
 * c11 コマンドラッパー — シェルスクリプト不要でペイン操作
 *
 * v0.9.0+: cmux backend を完全撤去し c11 のみをサポート。
 * 但しファイル名 `cmux.ts` / シンボル `SUBSTRATE_BINARY` / env `CMUX_*` は
 * 互換のため温存している（c11 が cmux 系列の wire format を引き継ぐため）。
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log, formatSurface } from "./logger";
import { formatExecError } from "./exec-error";

const execFile = promisify(execFileCb);

/**
 * Substrate binary（c11）を env から解決する pure 関数。
 *
 * - `CMUX_BUNDLED_CLI_PATH` が `/c11.app/` を含む（c11.app launch 経由）→ そのフルパス
 * - それ以外 → `"c11"`（PATH 上で解決）
 *
 * `ELEVENS_BACKEND` env は v0.9.0 で参照されない（cmux backend を撤去したため）。
 */
export function resolveC11Binary(env: NodeJS.ProcessEnv): string {
  const cliPath = env.CMUX_BUNDLED_CLI_PATH;
  if (cliPath && /\/c11\.app\//.test(cliPath)) return cliPath;
  return "c11";
}

/**
 * Substrate binary（c11）。
 *
 * v0.9.0+: c11 のみをサポート。`SUBSTRATE_BINARY` というシンボル名は
 * caller 側の import を壊さないために温存する（実体は c11 binary を指す）。
 *
 * module load 時に 1 回 env を読んで確定する。runtime での切替は不要
 * （c11 のみのため）。テストで env 注入したい場合は `resolveC11Binary(env)` を直接呼ぶ。
 */
export const SUBSTRATE_BINARY: string = resolveC11Binary(process.env);

/**
 * elevens start の起動可否判定 (v0.4.0+ 導入、v0.9.0 で 2-value 化)。
 *
 * **方針**: c11-first。auto-detect で c11 multiplexer 上にいないと判断したら refuse。
 *
 * 優先順位:
 *   1. `CMUX_BUNDLE_ID === "com.stage11.c11"` → `{ kind: "c11" }`
 *   2. `CMUX_BUNDLED_CLI_PATH` が `/c11.app/` を含む → `{ kind: "c11" }`
 *   3. それ以外 → `{ kind: "refuse" }` を返し、cmdStart で exit 1
 *
 * v0.9.0+: `ELEVENS_BACKEND` env は読まない（cmux backend を撤去）。
 * c11 以外の bundle を見たら refuse する（`CMUX_BUNDLE_ID=com.manaflow.cmux` は明示的に refuse）。
 *
 * 補足 (m4): c11.app launch 経由のみ `CMUX_BUNDLED_CLI_PATH` が設定される。
 * `resolveC11Binary` と同じ `/c11\.app/` regex に依存することで、binary 解決と判定が一致する。
 */
export type BackendDecision =
  | { kind: "c11"; bundle: string; binary: string }
  | { kind: "refuse"; reason: string; observed: { bundleId?: string; cliPath?: string } };

export function detectBackendDecision(env: NodeJS.ProcessEnv = process.env): BackendDecision {
  const bundleId = env.CMUX_BUNDLE_ID;
  const cliPath = env.CMUX_BUNDLED_CLI_PATH;
  if (bundleId === "com.stage11.c11") {
    return { kind: "c11", bundle: bundleId, binary: resolveC11Binary(env) };
  }
  if (cliPath && /\/c11\.app\//.test(cliPath)) {
    return {
      kind: "c11",
      bundle: bundleId ?? "(unknown via CLI path)",
      binary: resolveC11Binary(env),
    };
  }
  // refuse path: c11 surface 起動のみを案内する。
  return {
    kind: "refuse",
    reason: [
      "elevens は c11 multiplexer 上での起動を必要とします。",
      "Stage 11 Agentics の c11 (https://github.com/Stage-11-Agentics/c11) をインストールして、",
      "c11 surface 内で `elevens start` を実行してください。",
    ].join("\n"),
    observed: {
      bundleId,
      cliPath,
    },
  };
}

/** send / new-surface 等の substrate 操作の default timeout (ms) */
export const SEND_TIMEOUT_MS = 30_000;

/** tree 呼び出し専用のタイムアウト (ms) */
export const TREE_TIMEOUT_MS = 5_000;

type RunCmuxOpts = { timeout?: number };

/**
 * テスト用: 実際に execFile に渡す binary を上書きする。`null` で元に戻す。
 * c11.app launch 経由で起動された test runner では SUBSTRATE_BINARY が
 * `/Applications/c11.app/.../c11` の絶対パスに解決され、PATH 上の fake binary が
 * 効かなくなるため、fake 経路を必要とするテストはこの hook で binary を差し替える。
 */
let substrateBinaryOverride: string | null = null;
export function __setSubstrateBinaryForTest(binary: string | null): void {
  substrateBinaryOverride = binary;
}

/**
 * c11 コマンドの execFile ラッパー。失敗時に stderr/stdout を含む新しい Error を throw する。
 *
 * - **default timeout** `SEND_TIMEOUT_MS` (30s) を `opts.timeout` 未指定時に適用する (T016)。
 *   `tree` は `TREE_TIMEOUT_MS` (5s) を明示渡しするため上書きされない。
 * - 二重ラップ防止: 既に runCmux で wrap 済みの Error はそのまま再 throw する
 * - 元の Error は `cause` および `__cmuxWrapped` チェーンで追跡可能
 * - 元 Error の `stderr` / `stdout` プロパティも wrap 後の Error に転写する（呼び出し元が必要なら参照可能）
 */
async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  // spread を先に置き timeout を後に置くことで、`opts.timeout` が未指定なら
  // default を、明示指定があればその値を使う（tree の 5s が上書きされないよう注意）。
  const mergedOpts: RunCmuxOpts = { ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS };
  const binary = substrateBinaryOverride ?? SUBSTRATE_BINARY;
  try {
    const { stdout, stderr } = await execFile(binary, args, mergedOpts);
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: any) {
    if (e?.__cmuxWrapped) throw e;
    const detail = formatExecError(e);
    const wrapped: any = new Error(detail);
    wrapped.cause = e;
    wrapped.stderr = e?.stderr;
    wrapped.stdout = e?.stdout;
    // T180: 上位で isExecTimeout() が wrapped にも反応できるよう転写する
    wrapped.killed = e?.killed;
    wrapped.signal = e?.signal;
    wrapped.code = e?.code;
    wrapped.__cmuxWrapped = true;
    throw wrapped;
  }
}

export async function newSplit(
  direction: "left" | "right" | "up" | "down",
  opts?: { surface?: string }
): Promise<string> {
  const args = ["new-split", direction];
  if (opts?.surface) args.push("--surface", opts.surface);
  const { stdout } = await runCmux(args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create split: ${stdout}`);
  }
  return surface;
}

/**
 * 指定 pane 上に新しい surface（タブ）を作成する。
 *
 * T017: pane は必須化された (`!pane.startsWith("pane:")` で throw)。
 * かつて `pane?` optional だったが、undefined を渡すと c11 が focused pane /
 * focused workspace に surface を作って別ペインに Agent が飛ぶ事故が発生したため
 * fail-fast に切り替えた。caller 側で `getPaneForSurface` が undefined を返した場合は
 * caller 自身が throw して意味付きの reason を残すこと。
 *
 * 二重防御: `opts.workspace` が指定されれば `--workspace <ws>` を c11 argv に追加する。
 * c11 が `--pane` だけで意図 workspace を解決できなかった将来変更や、別 workspace の
 * pane を誤って指定された場合の暗黙フォールバックを物理的に塞ぐ。
 */
export async function newSurface(
  pane: string,
  opts?: { workspace?: string },
): Promise<string> {
  if (!pane || !pane.startsWith("pane:")) {
    throw new Error(`newSurface: pane is required (got ${JSON.stringify(pane)})`);
  }
  const args = ["new-surface", "--pane", pane];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  const { stdout } = await runCmux(args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create surface: ${stdout}`);
  }
  return surface;
}

export async function send(
  surface: string,
  text: string,
  opts?: { workspace?: string }
): Promise<void> {
  const args = ["send"];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  args.push("--surface", surface, text);
  await runCmux(args);
}

export async function sendKey(
  surface: string,
  key: string,
  opts?: { workspace?: string }
): Promise<void> {
  const args = ["send-key"];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  args.push("--surface", surface, key);
  await runCmux(args);
}

export async function readScreen(
  surface: string,
  lines: number = 10,
  opts?: { workspace?: string }
): Promise<string> {
  const args = ["read-screen", "--surface", surface, "--lines", String(lines)];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  const { stdout } = await runCmux(args, { timeout: 10_000 });
  return stdout;
}

/** surface を閉じる。SESSION_ENDED は送信しないため、呼び出し元が必要に応じて明示的に送信すること */
export async function closeSurface(surface: string): Promise<void> {
  await runCmux(["close-surface", "--surface", surface]).catch(
    () => {}
  );
}

export async function renameTab(
  surface: string,
  title: string
): Promise<void> {
  await runCmux(["rename-tab", "--surface", surface, title]).catch(
    () => {}
  );
}

export async function renameWorkspace(title: string, workspace?: string): Promise<void> {
  const args = ["rename-workspace"];
  if (workspace) args.push("--workspace", workspace);
  args.push(title);
  await runCmux(args).catch(() => {});
}

export type TreeOpts = { json?: boolean; idFormat?: "refs" | "uuids" | "both" };

/**
 * テストから tree の実体を差し替えるためのフック（R4）。
 * 未設定時は実 c11 コマンドを呼ぶ。テスト時は `__setTreeImpl()` で差し替える。
 */
let treeImpl: ((workspace?: string, opts?: TreeOpts) => Promise<string>) | null = null;

/** テスト用: tree の実装を差し替える。`null` で元に戻す。 */
export function __setTreeImpl(
  impl: ((workspace?: string, opts?: TreeOpts) => Promise<string>) | null
): void {
  treeImpl = impl;
}

export async function tree(workspace?: string, opts?: TreeOpts): Promise<string> {
  if (treeImpl) return treeImpl(workspace, opts);
  const args: string[] = [];
  if (opts?.idFormat) args.push("--id-format", opts.idFormat);
  if (opts?.json) args.push("--json");
  args.push("tree");
  if (workspace) args.push("--workspace", workspace);
  // c11: text 出力時に floor plan ASCII art の前置を抑制（output 肥大化を回避）
  if (!opts?.json) args.push("--no-layout");
  const { stdout } = await runCmux(args, { timeout: TREE_TIMEOUT_MS });
  return stdout;
}

/**
 * 指定 workspace の生存 surface 集合を返す (T255、T016 で fail-fast 化)。
 *
 * - workspace 未指定 → throw（initializeLayout の retry/exit 経路に乗せる）
 * - tree 失敗 → throw（呼び出し元 daemon が retry → exit 1 に責任を持つ）
 * - 成功 → tree 出力から `surface:N` を集合化して返す
 *
 * v0.9.0 以前は `null` を返して pid_only モードへ degrade していたが、
 * c11 substrate が応答していないのに動き続ける方が観察箱原則上有害と判断し fail-fast 化した。
 */
export async function fetchLiveSurfaces(workspace?: string): Promise<Set<string>> {
  if (!workspace) {
    throw new Error("fetchLiveSurfaces: workspace is required (c11 substrate fail-fast)");
  }
  const output = await tree(workspace);
  const matches = output.match(/surface:\d+/g) ?? [];
  return new Set(matches);
}

/**
 * surface が属する pane を返す (T016 で fail-fast 化、T017 で完全一致照合化)。
 *
 * tree が失敗した場合は throw する（v0.9.0 以前は undefined を返して swallow していた）。
 * 「surface が見つからなかった」場合は引き続き undefined を返す（正常範囲の missing）。
 *
 * **照合方式**: 各行から `surface:\d+` を全抽出し、引数 `surface` と `===` で完全一致するものを探す。
 * 部分一致 (`line.includes(surface)`) は禁止 — `surface:2` が `surface:26` を含む行に誤マッチして
 * 間違った pane を返すバグ (T017) を防ぐため。`listSiblingSurfaces` と同じ照合パターンに揃え、
 * 両者の判定結果が常に同期するようにしている。
 */
export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  const output = await tree(workspace);
  const lines = output.split("\n");
  let currentPane: string | undefined;
  for (const line of lines) {
    const paneMatch = line.match(/pane (pane:\d+)/);
    if (paneMatch) currentPane = paneMatch[1];
    const surfaceMatches = line.match(/surface:\d+/g);
    if (!surfaceMatches || !currentPane) continue;
    if (surfaceMatches.includes(surface)) return currentPane;
  }
  return undefined;
}

/**
 * 指定 surface が属する pane 内の全 surface を返す（自分自身を含む）。
 *
 * `c11 tree` を 1 回だけ呼び、(1) 対象 surface の所属 pane を特定し
 * (2) 同 pane に属する全 surface を集める。`getPaneForSurface` と同じ
 * line-by-line スキャン方式を採用し、tree 出力 1 回で両情報を引き出す。
 *
 * 失敗時 / 対象 surface が見つからない時は `[]` を返す。
 */
export async function listSiblingSurfaces(surface: string, workspace?: string): Promise<string[]> {
  try {
    const output = await tree(workspace);
    const lines = output.split("\n");

    // pass 1: 各 surface がどの pane に属するかを記録しつつ、対象 surface の pane を特定
    const surfacesByPane = new Map<string, string[]>();
    let currentPane: string | undefined;
    let targetPane: string | undefined;
    for (const line of lines) {
      const paneMatch = line.match(/pane (pane:\d+)/);
      if (paneMatch) currentPane = paneMatch[1];
      const surfaceMatches = line.match(/surface:\d+/g);
      if (surfaceMatches && currentPane) {
        const list = surfacesByPane.get(currentPane) ?? [];
        for (const s of surfaceMatches) {
          if (!list.includes(s)) list.push(s);
          if (s === surface) targetPane = currentPane;
        }
        surfacesByPane.set(currentPane, list);
      }
    }

    if (!targetPane) return [];
    return surfacesByPane.get(targetPane) ?? [];
  } catch (e: any) {
    await log("error", `listSiblingSurfaces failed: ${formatSurface(surface, "S")} ${formatExecError(e)}`);
    return [];
  }
}

/**
 * PID 生存確認（T195）。
 *
 * `process.kill(pid, 0)` で signal 0 を送信し、プロセス存在を確認する。
 * tree / list-status を使わないため c11 daemon の deadlock 影響を受けない。
 *
 * 注意: PID は OS で再利用されるため、kill(pid, 0) が true を返しても
 * それが元のプロセスとは限らない。Manager 再起動直後は team.json 永続化の
 * pid が別プロセスと衝突する可能性があるが、発生確率は低いため割り切る。
 */
let isAliveImpl: ((pid: number) => boolean) | null = null;

/** テスト用: `isAlive` の実装を差し替える。`null` で元に戻す。 */
export function __setIsAliveImpl(impl: ((pid: number) => boolean) | null): void {
  isAliveImpl = impl;
}

export function isAlive(pid: number): boolean {
  if (isAliveImpl) return isAliveImpl(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getCallerSurface(): Promise<string> {
  const { stdout } = await runCmux(["identify"]);
  const data = JSON.parse(stdout);
  const surface = data?.caller?.surface_ref;
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to get caller surface: ${stdout}`);
  }
  return surface;
}

export async function setStatus(
  key: string,
  value: string,
  icon: string,
  color: string,
  workspace?: string,
): Promise<void> {
  const args = ["set-status", key, value, "--icon", icon, "--color", color];
  if (workspace) args.push("--workspace", workspace);
  try {
    await runCmux(args);
  } catch (e: any) {
    await log("error", `setStatus failed: key=${key} value=${value} ${formatExecError(e)}`);
  }
}

export async function clearStatus(
  key: string,
  workspace?: string,
): Promise<void> {
  const args = ["clear-status", key];
  if (workspace) args.push("--workspace", workspace);
  try {
    await runCmux(args);
  } catch {
    // 冪等な後処理のため、失敗は握りつぶす
  }
}

/**
 * c11 notify を実行して OS 通知を送る (T238)。
 * best-effort: 失敗時は log するのみで throw しない。
 */
export async function notify(
  surface: string,
  title: string,
  body?: string,
  opts?: { subtitle?: string; workspace?: string },
): Promise<void> {
  const args = ["notify", "--surface", surface, "--title", title];
  if (opts?.subtitle) args.push("--subtitle", opts.subtitle);
  if (body) args.push("--body", body);
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  try {
    await runCmux(args);
  } catch (e: any) {
    await log("error", `notify failed: ${formatSurface(surface, "S")} ${formatExecError(e)}`);
  }
}

export async function getCallerWorkspace(): Promise<string | undefined> {
  try {
    const { stdout } = await runCmux(["identify"]);
    const data = JSON.parse(stdout);
    return data?.caller?.workspace_ref;
  } catch {
    return undefined;
  }
}
