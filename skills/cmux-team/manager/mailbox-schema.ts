/**
 * mailbox.* metadata の formal schema 定義（軽量手書き validator）。
 *
 * 詳細仕様は `docs/spec/13-mailbox-schema.md` を参照。
 *
 * 設計方針:
 * - canonical key は型違反を error にする（strict）
 * - 未知 `mailbox.*` key は warning（schema 進化の余地確保）
 * - 非 `mailbox.*` prefix（title / lifecycle_state 等）は passthrough（無視）
 * - normalizer は副作用なし pure function（input を mutate しない）
 * - zod は使わない（既存コードに合わせて軽量）
 *
 * 想定 lifecycle:
 * - 開始時: { mailbox.role, mailbox.status: "running", mailbox.task?, mailbox.started_at? }
 * - 進捗時: { mailbox.progress, mailbox.status: "running" }
 * - 完了時: { mailbox.status: "done", mailbox.completed_at? }
 * - エラー時: { mailbox.status: "error" | "aborted", mailbox.error: "<msg>" }
 *
 * 観測側（daemon mailbox watcher / FSM）の契約:
 * - canonical key は spec 準拠の値で読む
 * - 未知 mailbox.* key は無視 OR debug log のみ（コア挙動は変えない）
 */

// --- Canonical key 一覧 ---

/**
 * spec で型契約を持つ canonical mailbox.* key の集合。
 * 順序は docs/spec/13-mailbox-schema.md の表と揃える。
 */
export const MAILBOX_KEYS = [
  "mailbox.role",
  "mailbox.status",
  "mailbox.task",
  "mailbox.task_run_id",
  "mailbox.progress",
  "mailbox.started_at",
  "mailbox.completed_at",
  "mailbox.error",
] as const;
export type MailboxKey = (typeof MAILBOX_KEYS)[number];

// --- mailbox.role の値 ---

/**
 * mailbox.role に書き込まれる canonical 値。
 *
 * - `master` / `conductor` / `agent`: 4 層アーキテクチャの上位 3 ロール
 *   （`agent` は role 種別が判らない agent 全般、上位互換）
 * - 8 件の Agent role: `schema.ts` の `AgentRole` と一致
 *   （`researcher` / `architect` / `planner` / `design-reviewer` /
 *     `implementer` / `inspector` / `dockeeper` / `task-manager`）
 *
 * common-header.md template で `{{ROLE_ID}}` に展開される値の網羅。
 */
export const MAILBOX_ROLES = [
  "master",
  "conductor",
  "agent",
  "researcher",
  "architect",
  "planner",
  "design-reviewer",
  "implementer",
  "inspector",
  "dockeeper",
  "task-manager",
] as const;
export type MailboxRole = (typeof MAILBOX_ROLES)[number];

// --- mailbox.status の値 ---

/**
 * mailbox.status に書き込まれる canonical 値。
 *
 * - `running`: 作業中
 * - `done`: 正常完了（done marker と dual-write）
 * - `idle`: アイドル状態（Conductor の待機、claude-hook idle 経路）
 * - `error`: エラーで停止
 * - `aborted`: 外部要因で中止
 */
export const MAILBOX_STATUSES = ["running", "done", "idle", "error", "aborted"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

// --- 型定義 ---

/**
 * 型付き mailbox payload。canonical key は型契約を持ち、
 * `[key: string]` で未知 key も保持できる（warning として扱う）。
 *
 * Partial にしているのは「全 key を一度に書く」ユースケースが無いため。
 */
export type MailboxPayload = Partial<{
  "mailbox.role": MailboxRole;
  "mailbox.status": MailboxStatus;
  "mailbox.task": string;
  "mailbox.task_run_id": string;
  /** 0..1 の進捗（dashboard が進捗バーに使う想定） */
  "mailbox.progress": number;
  /** ISO 8601 timestamp */
  "mailbox.started_at": string;
  /** ISO 8601 timestamp */
  "mailbox.completed_at": string;
  /** エラーメッセージ（status=error/aborted と組み合わせる） */
  "mailbox.error": string;
}> & {
  // 未知 key 許容（warning 扱い）+ 非 mailbox.* prefix の passthrough
  [key: string]: unknown;
};

// --- 判定ヘルパー ---

const MAILBOX_KEY_SET = new Set<string>(MAILBOX_KEYS);
const MAILBOX_ROLE_SET = new Set<string>(MAILBOX_ROLES);
const MAILBOX_STATUS_SET = new Set<string>(MAILBOX_STATUSES);

/**
 * `mailbox.*` prefix を持つ key かどうかを判定。
 * canonical かどうかは問わない（拡張余地）。
 *
 * `mailbox.` 単体や空文字は false（サフィックス必須）。
 */
export function isMailboxKey(s: string): boolean {
  if (typeof s !== "string") return false;
  if (!s.startsWith("mailbox.")) return false;
  if (s.length <= "mailbox.".length) return false;
  return true;
}

/** canonical key か（型契約を持つ key か）を判定。 */
export function isCanonicalMailboxKey(s: string): s is MailboxKey {
  return MAILBOX_KEY_SET.has(s);
}

// --- ISO 8601 timestamp 判定 ---

/**
 * ISO 8601 timestamp として有効か（`Date` parse 可能 + ISO っぽいパターン）。
 *
 * ゆるめに判定する: `2026-05-09T10:00:00Z` / `2026-05-09T10:00:00.000Z` /
 * `2026-05-09T10:00:00+00:00` / `2026-05-09T10:00:00+09:00` を許す。
 * `yesterday` のような自由形式は弾く。
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
export function isIso8601(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!ISO_8601_RE.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

// --- Validator ---

export type MailboxValidationResult =
  | { ok: true; value: MailboxPayload; warnings?: string[] }
  | { ok: false; errors: string[]; warnings?: string[] };

/**
 * canonical key の型違反は error、未知 mailbox.* は warning、
 * 非 mailbox.* prefix は passthrough（warning にも error にもしない）。
 *
 * 入力が object でない場合（null / array / primitive）は ok:false で返す。
 */
export function validateMailboxPayload(obj: unknown): MailboxValidationResult {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["payload must be a non-null object"] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const value: MailboxPayload = {};

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isMailboxKey(k)) {
      // 非 mailbox.* prefix は passthrough（surface 標準 metadata）
      (value as any)[k] = v;
      continue;
    }
    if (!isCanonicalMailboxKey(k)) {
      // 未知 mailbox.* key は warning として残す（書き込みは許容）
      warnings.push(`unknown mailbox.* key: ${k} (value preserved as-is)`);
      (value as any)[k] = v;
      continue;
    }

    // canonical key の型チェック
    const err = validateCanonicalValue(k, v);
    if (err) {
      errors.push(err);
      continue; // 不正値は value に入れない
    }
    (value as any)[k] = v;
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings: warnings.length ? warnings : undefined };
  }
  return { ok: true, value, warnings: warnings.length ? warnings : undefined };
}

/** canonical key 1 件分の型違反チェック。OK なら null、NG なら error message。 */
function validateCanonicalValue(key: MailboxKey, v: unknown): string | null {
  switch (key) {
    case "mailbox.role":
      if (typeof v !== "string") return `mailbox.role: expected string, got ${typeOf(v)}`;
      if (!MAILBOX_ROLE_SET.has(v))
        return `mailbox.role: '${v}' is not a canonical role (allowed: ${MAILBOX_ROLES.join(", ")})`;
      return null;
    case "mailbox.status":
      if (typeof v !== "string") return `mailbox.status: expected string, got ${typeOf(v)}`;
      if (!MAILBOX_STATUS_SET.has(v))
        return `mailbox.status: '${v}' is not canonical (allowed: ${MAILBOX_STATUSES.join(", ")})`;
      return null;
    case "mailbox.task":
    case "mailbox.task_run_id":
    case "mailbox.error":
      if (typeof v !== "string") return `${key}: expected string, got ${typeOf(v)}`;
      return null;
    case "mailbox.progress":
      if (typeof v !== "number" || !Number.isFinite(v))
        return `mailbox.progress: expected finite number, got ${typeOf(v)}`;
      if (v < 0 || v > 1) return `mailbox.progress: ${v} is out of [0, 1]`;
      return null;
    case "mailbox.started_at":
    case "mailbox.completed_at":
      if (!isIso8601(v))
        return `${key}: expected ISO 8601 timestamp string, got ${JSON.stringify(v)}`;
      return null;
    default: {
      // exhaustiveness check
      const _exhaust: never = key;
      void _exhaust;
      return null;
    }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// --- Normalizers ---

/**
 * mailbox.status の case / whitespace を canonical 値に揃える。
 * 揃えられない場合は undefined。
 */
export function normalizeMailboxStatus(raw: string): MailboxStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (MAILBOX_STATUS_SET.has(lowered)) return lowered as MailboxStatus;
  return undefined;
}

/**
 * mailbox.role を canonical 値に揃える。case 不一致は弾く方針
 * （role は ID として扱うため）。
 */
export function normalizeMailboxRole(raw: string): MailboxRole | undefined {
  if (typeof raw !== "string") return undefined;
  if (MAILBOX_ROLE_SET.has(raw)) return raw as MailboxRole;
  return undefined;
}

/**
 * ISO 8601 timestamp を正規化（`+00:00` → `Z` 揃え、ms 桁を 3 桁に揃える）。
 * parse 不能な値は元のまま返す（validation で弾く責務）。
 */
export function normalizeIso8601(raw: string): string {
  if (typeof raw !== "string") return raw;
  if (!ISO_8601_RE.test(raw)) return raw;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toISOString();
}

/**
 * payload 全体を pure に正規化（input は mutate しない）。
 *
 * - mailbox.status: case-fold
 * - mailbox.started_at / mailbox.completed_at: Z 形式 + ms 3 桁
 * - 他の canonical key: そのまま
 * - 非 mailbox.* prefix: passthrough
 * - normalize 不能な値: そのまま残す（validation 側で error にする）
 */
export function normalizeMailboxPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload === null || typeof payload !== "object") return payload as any;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!isMailboxKey(k)) {
      out[k] = v;
      continue;
    }
    if (k === "mailbox.status" && typeof v === "string") {
      const n = normalizeMailboxStatus(v);
      out[k] = n ?? v;
      continue;
    }
    if ((k === "mailbox.started_at" || k === "mailbox.completed_at") && typeof v === "string") {
      out[k] = normalizeIso8601(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}
