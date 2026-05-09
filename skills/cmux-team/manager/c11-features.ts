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
import { SUBSTRATE_BINARY, IS_C11_BACKEND } from "./cmux";

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
  if (!IS_C11_BACKEND) return null;
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
 */
export async function setMailbox(
  target: MailboxTarget,
  payload: Record<string, MailboxValue>,
  opts?: { source?: "explicit" | "declare" | "osc" | "heuristic" }
): Promise<void> {
  if (!(await isMailboxSupported())) return;
  const args: string[] = ["set-metadata"];
  args.push(`--${target.kind}`, target.ref);
  args.push("--json", JSON.stringify(payload));
  args.push("--mode", "merge");
  if (opts?.source) args.push("--source", opts.source);
  await execFile(SUBSTRATE_BINARY, args, { timeout: META_TIMEOUT_MS });
}

/**
 * surface または pane の metadata を取得。
 * cmux backend では null。c11 では `{key: value, ...}` を返す（取得失敗時も null）。
 *
 * @param opts.withSources true なら sidecar `metadata_sources` も同梱した raw response を返す
 */
export async function getMailbox(
  target: MailboxTarget,
  opts?: { withSources?: boolean }
): Promise<Record<string, MailboxValue> | null> {
  if (!(await isMailboxSupported())) return null;
  // c11 では --json は global flag。subcommand より前に置く必要がある（subcommand の後に置くと text 出力になる）
  const args: string[] = ["--json", "get-metadata"];
  args.push(`--${target.kind}`, target.ref);
  if (opts?.withSources) args.push("--sources");
  try {
    const { stdout } = await execFile(SUBSTRATE_BINARY, args, { timeout: META_TIMEOUT_MS });
    const parsed = JSON.parse(stdout.toString());
    const result = parsed?.result ?? parsed;
    if (opts?.withSources) return result as Record<string, MailboxValue>;
    return (result?.metadata ?? null) as Record<string, MailboxValue> | null;
  } catch {
    return null;
  }
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
  if (!(await isMailboxSupported())) {
    return { stop: () => {} };
  }
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
    const data = (await getMailbox(target)) ?? {};
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
