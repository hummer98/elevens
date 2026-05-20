/**
 * c11 backend 専用機能（capability 検出 + mailbox.* metadata helpers）。
 *
 * cmux backend では全ての書き込み系 API は **opportunistic no-op**、
 * 読み取り系 API は null を返す。これにより呼び出し元は backend を意識せず
 * 「書けたら書く / 読めたら使う」スタイルで利用できる（Phase 2 の dual-write 戦略）。
 *
 * 詳細は .team/artifacts/A029-c11-parity-and-phase2-prep.md 参照。
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { SUBSTRATE_BINARY, isC11Backend } from "./cmux";
import { validateMailboxPayload } from "./mailbox-schema";
import { warn as logWarn } from "./logger";

const execFile = promisify(execFileCb);

const CAPS_TIMEOUT_MS = 3_000;
const META_TIMEOUT_MS = 3_000;

type CapabilitiesResult = {
  protocol?: string;
  version?: number;
  methods?: string[];
  brand?: { bundle?: { identifier?: string } };
};

let cachedCaps: CapabilitiesResult | null = null;
let capsFetched = false;

/**
 * c11 daemon の capability を取得（成功 1 回のみキャッシュ、失敗は都度再試行）。
 * cmux backend では常に null を返す。
 */
export async function getCapabilities(): Promise<CapabilitiesResult | null> {
  if (capsFetched && cachedCaps) return cachedCaps;
  // module-load-time 定数ではなく都度評価（test 時の env 注入を効かせ、cmux backend test が
  // 狙った「!isC11Backend で早期 return」経路を通ることを観察可能にするため）。
  if (!isC11Backend(process.env)) return null;
  try {
    // c11 capabilities は default で JSON 出力（--json flag 不要）
    const { stdout } = await execFile(SUBSTRATE_BINARY, ["capabilities"], {
      timeout: CAPS_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout.toString());
    // c11 0.46.0 は `{ok:true, id, result: {...}}` の wrapper を返す
    cachedCaps = (parsed?.result ?? parsed) as CapabilitiesResult;
    capsFetched = true;
    return cachedCaps;
  } catch {
    return null;
  }
}

/** テスト用: cache を強制リセット。 */
export function __resetCapabilitiesCache(): void {
  cachedCaps = null;
  capsFetched = false;
}

/**
 * mailbox.* metadata 書き込みが可能かどうか（surface または pane どちらかの set_metadata method があれば true）。
 */
export async function isMailboxSupported(): Promise<boolean> {
  const caps = await getCapabilities();
  if (!caps) return false;
  const methods = caps.methods ?? [];
  return methods.includes("surface.set_metadata") || methods.includes("pane.set_metadata");
}

export type MailboxTarget =
  | { kind: "surface"; ref: string }
  | { kind: "pane"; ref: string };

export type MailboxValue = string | number | boolean | object;

/**
 * surface または pane に metadata を書き込む。
 * cmux backend（または mailbox 非対応の c11 build）では no-op。
 *
 * @param target 書き込み先 surface / pane の ref
 * @param payload mailbox.* キーを含む JSON object（merge mode で書き込まれる）
 * @param opts.source precedence layer（default: declare、agent 自書き用）
 * @param opts.validate mailbox-schema による validation 動作:
 *   - `"strict"`: error 発生時に throw（書き込みしない）
 *   - `"warn"` (default): error / warning を log に流して書き込みは続行
 *   - `"off"`: 検証しない（既存呼び出し元の opportunistic 動作と完全一致）
 *   詳細仕様は `docs/spec/13-mailbox-schema.md` を参照。
 */
export async function setMailbox(
  target: MailboxTarget,
  payload: Record<string, MailboxValue>,
  opts?: {
    source?: "explicit" | "declare" | "osc" | "heuristic";
    validate?: "strict" | "warn" | "off";
  }
): Promise<void> {
  const mode = opts?.validate ?? "warn";
  if (mode !== "off") {
    const result = validateMailboxPayload(payload);
    if (mode === "strict") {
      if (!result.ok) {
        throw new Error(`setMailbox: schema validation failed: ${result.errors.join("; ")}`);
      }
    } else {
      // warn mode: error も warning も log に流す（書き込みは続行）
      if (!result.ok) {
        await logWarn("MAILBOX_SCHEMA_ERROR", result.errors.join("; ")).catch(() => {});
      }
      if (result.warnings && result.warnings.length > 0) {
        await logWarn("MAILBOX_SCHEMA_WARN", result.warnings.join("; ")).catch(() => {});
      }
    }
  }
  if (!(await isMailboxSupported())) return;
  const args: string[] = ["set-metadata"];
  args.push(`--${target.kind}`, target.ref);
  args.push("--json", JSON.stringify(payload));
  args.push("--mode", "merge");
  if (opts?.source) args.push("--source", opts.source);
  await execFile(SUBSTRATE_BINARY, args, { timeout: META_TIMEOUT_MS });
}

/**
 * watchMailbox 内部用の discriminated 取得結果。
 * - `ok`: c11 から正常に取得できた（metadata は空 dict もあり得る）
 * - `unsupported`: cmux backend / capability 不足で取得できない（永続的）
 * - `error`: c11 invocation / parse の transient 失敗。**prev は触らずに次 tick へ**
 *
 * Phase 2 e2e smoke (A031 §2 follow-up) で発覚: 旧実装は error を `null` に
 * 折り畳んで `data = {}` と同視し、prev を空に上書きしていた → 一度の transient
 * 失敗で watcher が永続 desync する bug があった。本 union で error を分離する。
 */
type FetchMailboxResult =
  | { kind: "ok"; data: Record<string, MailboxValue>; raw?: Record<string, MailboxValue> }
  | { kind: "unsupported" }
  | { kind: "error"; error: Error };

async function fetchMailboxData(
  target: MailboxTarget,
  opts?: { withSources?: boolean }
): Promise<FetchMailboxResult> {
  if (!(await isMailboxSupported())) return { kind: "unsupported" };
  // c11 では --json は global flag。subcommand より前に置く必要がある（subcommand の後に置くと text 出力になる）
  const args: string[] = ["--json", "get-metadata"];
  args.push(`--${target.kind}`, target.ref);
  if (opts?.withSources) args.push("--sources");
  try {
    const { stdout } = await execFile(SUBSTRATE_BINARY, args, { timeout: META_TIMEOUT_MS });
    const parsed = JSON.parse(stdout.toString());
    const result = parsed?.result ?? parsed;
    const raw = result as Record<string, MailboxValue>;
    const data = (result?.metadata ?? {}) as Record<string, MailboxValue>;
    return { kind: "ok", data, raw };
  } catch (e: any) {
    return { kind: "error", error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** テスト seam: watchMailbox / getMailbox が使う取得関数を差し替える。null で reset。 */
type FetchMailboxImpl = (
  target: MailboxTarget,
  opts?: { withSources?: boolean }
) => Promise<FetchMailboxResult>;
let fetchImpl: FetchMailboxImpl | null = null;
export function __setFetchMailboxImpl(impl: FetchMailboxImpl | null): void {
  fetchImpl = impl;
}
async function callFetch(
  target: MailboxTarget,
  opts?: { withSources?: boolean }
): Promise<FetchMailboxResult> {
  return fetchImpl ? fetchImpl(target, opts) : fetchMailboxData(target, opts);
}

/**
 * surface または pane の metadata を取得。
 * cmux backend / 取得失敗ともに null（既存契約。詳細な失敗種別が必要なときは
 * watchMailbox 内部の `callFetch` 経路を直接使う）。
 *
 * @param opts.withSources true なら sidecar `metadata_sources` も同梱した raw response を返す
 */
export async function getMailbox(
  target: MailboxTarget,
  opts?: { withSources?: boolean }
): Promise<Record<string, MailboxValue> | null> {
  const r = await callFetch(target, opts);
  if (r.kind !== "ok") return null;
  if (opts?.withSources) return r.raw ?? null;
  return r.data;
}

/**
 * 指定 key を削除（cmux backend / 未対応 c11 では no-op）。
 */
export async function clearMailbox(target: MailboxTarget, key: string): Promise<void> {
  if (!(await isMailboxSupported())) return;
  const args: string[] = ["clear-metadata", `--${target.kind}`, target.ref, "--key", key];
  await execFile(SUBSTRATE_BINARY, args, { timeout: META_TIMEOUT_MS });
}

/**
 * `mailbox.*` キーが追加・変更・削除されたら onChange を呼び出す poll loop。
 *
 * - cmux backend / 未対応 c11 では即 resolve（poll loop は走らない）
 * - 戻り値の `stop()` で停止
 * - 同じキー・同じ値の連続検出は通知しない（差分のみ）
 * - `intervalMs` の default は 1500ms。あまり短くすると CLI spawn コストが嵩むので 1〜2 秒推奨
 */
export async function watchMailbox(
  target: MailboxTarget,
  onChange: (changes: MailboxChange[]) => void | Promise<void>,
  opts?: { intervalMs?: number; signal?: AbortSignal }
): Promise<{ stop: () => void }> {
  // unsupported は最初の tick の `callFetch` 結果で検出して自然停止する
  // （早期 exit を入れると test seam 経路が通らないため）
  const interval = Math.max(250, opts?.intervalMs ?? 1500);
  let stopped = false;
  let prev: Record<string, MailboxValue> = {};
  let firstTick = true;
  const stop = (): void => {
    stopped = true;
  };
  opts?.signal?.addEventListener("abort", stop);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const r = await callFetch(target);
    if (r.kind === "error") {
      // A031 §2 e2e smoke で発覚した永続 desync を回避: error 時は prev を触らず
      // diff 計算もスキップ。次 tick で正常取得できれば自然に diff が再開する。
      await logWarn("MAILBOX_FETCH_ERROR", `target=${target.kind}:${target.ref} ${r.error.message}`).catch(() => {});
      if (!stopped) setTimeout(() => void tick(), interval);
      return;
    }
    if (r.kind === "unsupported") {
      // 起動時には support されていたが途中で capability が消えるケースは想定外。
      // 安全側に倒して watcher を停止する。
      stopped = true;
      return;
    }
    const data = r.data;
    const changes: MailboxChange[] = [];
    // mailbox.* prefix のみ対象（surface 標準 metadata である title/lifecycle_state を除外）
    for (const [k, v] of Object.entries(data)) {
      if (!k.startsWith("mailbox.")) continue;
      if (!firstTick && JSON.stringify(prev[k]) !== JSON.stringify(v)) {
        changes.push({ kind: prev[k] === undefined ? "added" : "changed", key: k, value: v, previous: prev[k] });
      } else if (firstTick) {
        changes.push({ kind: "added", key: k, value: v });
      }
    }
    for (const k of Object.keys(prev)) {
      if (!k.startsWith("mailbox.")) continue;
      if (!(k in data)) {
        changes.push({ kind: "removed", key: k, previous: prev[k] });
      }
    }
    if (changes.length > 0) await onChange(changes);
    prev = data;
    firstTick = false;
    if (!stopped) setTimeout(() => void tick(), interval);
  };
  void tick();
  return { stop };
}

export type MailboxChange =
  | { kind: "added"; key: string; value: MailboxValue }
  | { kind: "changed"; key: string; value: MailboxValue; previous: MailboxValue }
  | { kind: "removed"; key: string; previous: MailboxValue };
