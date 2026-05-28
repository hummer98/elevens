/**
 * T359: `cmux-team events` サブコマンド本体。
 *
 * `.team/logs/events.jsonl` (T358 writer の出力) を tail / filter / format conversion する。
 * spec: `docs/spec/10-events-stream.md` reader 実装ガイドライン (§8)。
 *
 * 設計判断:
 *  - main.ts に直書きせず module 化。`runEventsCli(opts): Promise<number>` を export し
 *    exit code を返すことで test を in-process で書ける（process.exit せず stdout / stderr を
 *    capture できる）
 *  - non-follow は readline / follow は自前 read+buffer で経路別に line buffering を分担
 *    （rotate 制御と readline の lifecycle が衝突するため共通化しない）
 *  - 警告は stderr に 1 行 (spec §8: forward-compat、abort せず continue)
 *
 * plan: .team/tasks/359-cmux-team-events-follow-types-since-format/runs/.../plan.md
 */

import { existsSync } from "node:fs";
import { open, stat } from "fs/promises";
import { join } from "path";
import { setTimeout as wait } from "node:timers/promises";
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import {
  EVENTS_SCHEMA_VERSION,
  RESERVED_EVENTS,
  emitUserSignal,
} from "./events-writer";
import { t } from "./i18n";

export interface RunEventsCliOpts {
  /** "events" 自身を除いた残りの argv（main.ts: args.slice(1)） */
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
  /** follow loop の poll 間隔。test 用に短く差し込める（default 200ms） */
  pollIntervalMs?: number;
}

interface ParsedArgs {
  follow: boolean;
  types: Set<string> | null;
  since: Date | null;
  format: "json" | "text";
  help: boolean;
}

const KNOWN_FLAGS = new Set([
  "--follow",
  "-f",
  "--types",
  "--since",
  "--format",
  "--help",
  "-h",
]);

const FLAGS_WITH_VALUE = new Set(["--types", "--since", "--format"]);

// ────────────────────────────────────────────────────────────────────────
// 引数 parser
// ────────────────────────────────────────────────────────────────────────

class ArgError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  let follow = false;
  let typesRaw: string | undefined;
  let sinceRaw: string | undefined;
  let format: "json" | "text" = "json";
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!KNOWN_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--follow" || a === "-f") {
      follow = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || KNOWN_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--types") typesRaw = v;
      else if (a === "--since") sinceRaw = v;
      else if (a === "--format") {
        if (v !== "json" && v !== "text") {
          throw new ArgError(`invalid --format value: ${v} (must be json or text)`);
        }
        format = v;
      }
    }
  }

  const types = parseTypes(typesRaw);
  const since = parseSince(sinceRaw);

  return { follow, types, since, format, help };
}

export function parseTypes(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const set = new Set(
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  if (set.size === 0) {
    throw new ArgError(`--types value cannot be empty`);
  }
  return set;
}

const DURATION_RE = /^(\d+)([mhd])$/;
const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// ISO 8601 like (date-only or full) — `5` のような bare 数字を `Date.parse` が
// 「year=5」と解釈する処理系差を避けるため、形状で先に弾く。
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}/;

export function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const m = DURATION_RE.exec(raw);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    return new Date(Date.now() - n * DURATION_MS[unit]!);
  }
  if (ISO_LIKE_RE.test(raw)) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new ArgError(`invalid --since value: ${raw} (use 5m / 1h / 2d or ISO 8601)`);
}

// ────────────────────────────────────────────────────────────────────────
// text formatter (plan §2.5.3 / §6.2)
// ────────────────────────────────────────────────────────────────────────

const ESCAPE_RE = /[\s="\\]/;

function fmtValue(v: unknown): string {
  const s = String(v);
  return ESCAPE_RE.test(s) ? JSON.stringify(s) : s;
}

function fmtFields(pairs: Array<[string, unknown]>): string {
  const parts: string[] = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${fmtValue(v)}`);
  }
  return parts.join(" ");
}

type FieldExtractor = (r: Record<string, unknown>) => Array<[string, unknown]>;

const TEXT_FIELDS: Record<string, FieldExtractor> = {
  task_created: (r) => [["task_id", r.task_id], ["title", r.title]],
  task_ready: (r) => [["task_id", r.task_id]],
  task_assigned: (r) => [
    ["task_id", r.task_id],
    ["conductor_surface", r.conductor_surface],
    ["task_run_id", r.task_run_id],
  ],
  task_completed: (r) => [
    ["task_id", r.task_id],
    ["conductor_surface", r.conductor_surface],
    ["worktree_path", r.worktree_path],
  ],
  task_completed_state_mismatch: (r) => [
    ["task_id", r.task_id],
    ["conductor_surface", r.conductor_surface],
    ["reason", r.reason],
    ["worktree_path", r.worktree_path],
  ],
  task_aborted: (r) => [
    ["task_id", r.task_id],
    ["reason", r.reason],
  ],
  task_sync_guard_rejected: (r) => [
    ["task_id", r.task_id],
    ["kind", r.kind],
    ["main_branch", r.main_branch],
    ["detail", r.detail],
  ],
  task_reverted_to_ready: (r) => [
    ["task_id", r.task_id],
    ["reason", r.reason],
  ],
  conductor_running: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["task_id", r.task_id],
  ],
  conductor_recovered: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["new_status", r.new_status],
  ],
  conductor_disconnected: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["reason", r.reason],
    ["task_id", r.task_id],
  ],
  conductor_asking: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["question", r.question],
  ],
  conductor_done_unresolved: (r) => [
    ["task_id", r.task_id],
    ["conductor_surface", r.conductor_surface],
    ["worktree_path", r.worktree_path],
  ],
  conductor_start_timeout: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["elapsed_ms", r.elapsed_ms],
  ],
  conductor_assign_timeout: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["task_run_id", r.task_run_id],
    ["elapsed_ms", r.elapsed_ms],
  ],
  conductor_disconnect_timeout: (r) => [
    ["conductor_surface", r.conductor_surface],
    ["elapsed_ms", r.elapsed_ms],
    ["task_id", r.task_id],
  ],
  api_error_received: (r) => [
    ["surface", r.surface],
    ["role", r.role],
    ["kind", r.kind],
    ["message", r.message],
  ],
};

const KNOWN_EVENTS = new Set(Object.keys(TEXT_FIELDS));

export function formatText(record: Record<string, unknown>): string {
  const ts = String(record.ts ?? "");
  const event = String(record.event ?? "");
  const extract = TEXT_FIELDS[event];
  const fields = extract ? extract(record) : [];
  const body = fmtFields(fields);
  return body ? `${ts} ${event} ${body}` : `${ts} ${event}`;
}

// ────────────────────────────────────────────────────────────────────────
// 1 行を処理（filter → emit / warn）
// ────────────────────────────────────────────────────────────────────────

interface LineCtx {
  parsed: ParsedArgs;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  lineNumber: { value: number };
}

function processLine(rawLine: string, ctx: LineCtx): void {
  ctx.lineNumber.value += 1;
  const line = rawLine.replace(/\r$/, "");
  if (line.trim() === "") return;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.stderr.write(
      `warn: invalid JSON at events.jsonl line ${ctx.lineNumber.value}: ${msg}\n`,
    );
    return;
  }

  if (typeof record !== "object" || record === null) {
    ctx.stderr.write(
      `warn: skipping non-object record at line ${ctx.lineNumber.value}\n`,
    );
    return;
  }

  const sv = record.schema_version;
  if (sv !== EVENTS_SCHEMA_VERSION) {
    ctx.stderr.write(
      `warn: skipping record with schema_version=${sv} at line ${ctx.lineNumber.value} (current=${EVENTS_SCHEMA_VERSION})\n`,
    );
    return;
  }

  const event = record.event;
  if (typeof event !== "string") {
    ctx.stderr.write(
      `warn: skipping record with missing event field at line ${ctx.lineNumber.value}\n`,
    );
    return;
  }
  if (!KNOWN_EVENTS.has(event)) {
    // T029 / spec §8.1: --types で明示購読された event 名は通す（free-form
    // user-signal の Done 条件「--types signal:x で別セッションが拾える」を満たすため）。
    // --types 無指定時は従来どおり skip + warn（regression なし）。
    if (!(ctx.parsed.types && ctx.parsed.types.has(event))) {
      ctx.stderr.write(
        `warn: skipping record with unknown event=${event} at line ${ctx.lineNumber.value}\n`,
      );
      return;
    }
  }

  // --types filter
  if (ctx.parsed.types && !ctx.parsed.types.has(event)) return;

  // --since filter
  if (ctx.parsed.since) {
    const tsRaw = record.ts;
    if (typeof tsRaw !== "string") {
      ctx.stderr.write(
        `warn: skipping record with non-string ts at line ${ctx.lineNumber.value}\n`,
      );
      return;
    }
    const ts = Date.parse(tsRaw);
    if (Number.isNaN(ts)) {
      ctx.stderr.write(
        `warn: skipping record with unparseable ts=${tsRaw} at line ${ctx.lineNumber.value}\n`,
      );
      return;
    }
    if (ts < ctx.parsed.since.getTime()) return;
  }

  if (ctx.parsed.format === "json") {
    ctx.stdout.write(line + "\n");
  } else {
    ctx.stdout.write(formatText(record) + "\n");
  }
}

// ────────────────────────────────────────────────────────────────────────
// non-follow: createReadStream + readline
// ────────────────────────────────────────────────────────────────────────

async function runOnce(
  filePath: string,
  ctx: LineCtx,
): Promise<void> {
  const fh = await open(filePath, "r");
  try {
    const stream = fh.createReadStream();
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      processLine(line, ctx);
    }
  } finally {
    try {
      await fh.close();
    } catch {
      // 二重 close 等は無視（stream 経由で先に閉じられている可能性）
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// follow: 自前 read + line buffer + poll、rotate 検知
// ────────────────────────────────────────────────────────────────────────

interface FollowState {
  fh: Awaited<ReturnType<typeof open>>;
  position: number;
  lineBuf: string;
  lastInode: number | bigint;
  lastSize: number;
}

async function readIncrement(state: FollowState, ctx: LineCtx): Promise<void> {
  const st = await state.fh.stat();
  if (st.size <= state.position) return;
  const need = st.size - state.position;
  const buf = Buffer.alloc(need);
  const { bytesRead } = await state.fh.read(buf, 0, need, state.position);
  if (bytesRead === 0) return;
  state.position += bytesRead;
  state.lineBuf += buf.subarray(0, bytesRead).toString("utf-8");
  flushBufferedLines(state, ctx);
}

function flushBufferedLines(state: FollowState, ctx: LineCtx): void {
  let nl = state.lineBuf.indexOf("\n");
  while (nl >= 0) {
    const line = state.lineBuf.slice(0, nl);
    state.lineBuf = state.lineBuf.slice(nl + 1);
    processLine(line, ctx);
    nl = state.lineBuf.indexOf("\n");
  }
}

async function runFollowLoop(
  filePath: string,
  ctx: LineCtx,
  pollIntervalMs: number,
  abortSignal: AbortSignal,
): Promise<void> {
  let fh = await open(filePath, "r");
  let state: FollowState = {
    fh,
    position: 0,
    lineBuf: "",
    lastInode: 0,
    lastSize: 0,
  };
  try {
    const initStat = await fh.stat();
    state.lastInode = initStat.ino;
    // 初期 contents を全件読み出す
    await readIncrement(state, ctx);
    state.lastSize = initStat.size;

    while (!abortSignal.aborted) {
      try {
        await wait(pollIntervalMs, undefined, { signal: abortSignal });
      } catch {
        // AbortError → ループ脱出
        break;
      }

      let st;
      try {
        st = await stat(filePath);
      } catch {
        // 一時的に消えた → 待つ
        continue;
      }

      const rotated =
        st.ino !== state.lastInode || st.size < state.lastSize;
      if (rotated) {
        try {
          await state.fh.close();
        } catch {
          // ignore
        }
        fh = await open(filePath, "r");
        state = {
          fh,
          position: 0,
          lineBuf: "",
          lastInode: st.ino,
          lastSize: 0,
        };
        // 新ファイル先頭から読む（重複出力許容: §2.6.2）
        await readIncrement(state, ctx);
        state.lastSize = st.size;
        continue;
      }

      if (st.size > state.lastSize) {
        await readIncrement(state, ctx);
        state.lastSize = st.size;
      }
    }
  } finally {
    try {
      await state.fh.close();
    } catch {
      // ignore
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// entry point
// ────────────────────────────────────────────────────────────────────────

export async function runEventsCli(opts: RunEventsCliOpts): Promise<number> {
  // T029: `emit` サブコマンドへの routing。既存 parser とは引数集合が完全に
  // 別なので、入口 1 行で振り分けて parser を二系統に分ける。
  if (opts.args[0] === "emit") {
    return runEmitSubcommand({ ...opts, args: opts.args.slice(1) });
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(opts.args);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team events --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_events"));
    opts.stdout.write("\n");
    return 0;
  }

  const filePath = join(opts.projectRoot, ".team/logs/events.jsonl");
  if (!existsSync(filePath)) {
    opts.stderr.write(`Error: events.jsonl not found at ${filePath}\n`);
    return 1;
  }

  const ctx: LineCtx = {
    parsed,
    stdout: opts.stdout,
    stderr: opts.stderr,
    lineNumber: { value: 0 },
  };

  if (parsed.follow) {
    const pollMs = opts.pollIntervalMs ?? 200;
    await runFollowLoop(filePath, ctx, pollMs, opts.abortSignal);
    return 0;
  }

  await runOnce(filePath, ctx);
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────
// T029: `events emit` サブコマンド
// ──────────────────────────────────────────────────────────────────────────

interface ParsedEmitArgs {
  type: string;
  message?: string;
  actor?: string;
  data: Record<string, string>;
  help: boolean;
}

const EMIT_KNOWN_FLAGS = new Set([
  "--type",
  "--message",
  "--actor",
  "--data",
  "--help",
  "-h",
]);

const EMIT_FLAGS_WITH_VALUE = new Set([
  "--type",
  "--message",
  "--actor",
  "--data",
]);

/**
 * T029: emit サブコマンド専用の引数 parser。
 *
 * 既存 `parseArgs`（reader 側 --follow/--types/--since/--format）とは
 * 引数集合が完全に交わらないので別関数で持つ（相互排他チェックの爆発を避ける）。
 *
 * - `--type` は必須・空文字不可
 * - `--data k=v` は repeatable、最初の `=` で split、値は string 固定
 * - 値に `=` が無い (`--data foo`) や空キー (`--data =v`) は ArgError
 */
function parseEmitArgs(argv: string[]): ParsedEmitArgs {
  let type: string | undefined;
  let message: string | undefined;
  let actor: string | undefined;
  let help = false;
  const data: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (!EMIT_KNOWN_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (!EMIT_FLAGS_WITH_VALUE.has(a)) continue;

    const v = argv[i + 1];
    if (v === undefined || EMIT_KNOWN_FLAGS.has(v)) {
      throw new ArgError(`${a} requires a value`);
    }
    i++;

    if (a === "--type") type = v;
    else if (a === "--message") message = v;
    else if (a === "--actor") actor = v;
    else if (a === "--data") {
      const eq = v.indexOf("=");
      if (eq < 0) {
        throw new ArgError(`--data requires k=v format (got: ${v})`);
      }
      const k = v.slice(0, eq);
      if (k.length === 0) {
        throw new ArgError(`--data key cannot be empty (got: ${v})`);
      }
      const dv = v.slice(eq + 1);
      data[k] = dv;
    }
  }

  if (!help) {
    if (type === undefined || type.length === 0) {
      throw new ArgError(`--type <name> is required`);
    }
  }

  return {
    type: type ?? "",
    message,
    actor,
    data,
    help,
  };
}

/**
 * T029: `--actor` 明示 > `CMUX_SURFACE` env > 省略。
 * `CMUX_ROLE` 等の追加 env は本プロジェクトには存在しない（main.test.ts:2740 regression 確認済み）。
 */
function resolveActor(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env.CMUX_SURFACE;
  return env !== undefined && env.length > 0 ? env : undefined;
}

/**
 * T029: `elevens events emit ...` の本体。
 *
 * - parser → 予約名衝突 warn → actor 解決 → `emitUserSignal` を 1 回呼ぶ
 * - daemon 停止中でも動く（writer が `mkdir → appendFile` で初回ファイル生成）
 * - `--follow` 等の loop は持たない（同期的に 1 record 投稿のみ）
 */
async function runEmitSubcommand(opts: RunEventsCliOpts): Promise<number> {
  let parsed: ParsedEmitArgs;
  try {
    parsed = parseEmitArgs(opts.args);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'elevens events emit --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_events_emit"));
    opts.stdout.write("\n");
    return 0;
  }

  // 予約名衝突 warn（hard block しない）
  if (RESERVED_EVENTS.has(parsed.type as never)) {
    opts.stderr.write(
      `warn: --type ${parsed.type} は typed daemon event 名と衝突します（投稿は通します）。\n` +
        `      \`signal:\` prefix の使用を推奨します。例: --type signal:${parsed.type}\n`,
    );
  }

  const actor = resolveActor(parsed.actor);

  await emitUserSignal({
    event: parsed.type,
    message: parsed.message,
    actor,
    data: parsed.data,
  });

  return 0;
}
