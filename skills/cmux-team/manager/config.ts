/**
 * `.team/config.json` の読み込みと派生値解決（T247 で main.ts から抽出）。
 *
 * main.ts / dashboard.tsx の両方から参照する必要があるため、module として独立させる。
 * `TeamConfig` / `loadConfig` / `resolveLayout` / `resolveAutoUpdateMode` を提供する。
 * `normalizeAutoUpdate` は schema.ts にある（config 生値の正規化は schema 側の責務）。
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { homedir } from "os";
import type { LayoutMode, AutoUpdateMode, SleepPreventionMode } from "./schema";
import { normalizeAutoUpdate, normalizeSleepPrevention } from "./schema";

/**
 * config.models で role 別指定が無いときに全 spawn ロールへ適用する既定モデル。
 * 解決順: CLI --model > config.models[role] > DEFAULT_MODEL。
 * main.ts（getModelForRole）と dashboard.tsx（Settings タブ表示）の両方が参照するため、
 * literal の drift を避けて config モジュールに集約する。
 */
export const DEFAULT_MODEL = "claude-fable-5";

export interface TeamConfig {
  models?: {
    master?: string;
    conductor?: string;
    agent?: string;
  };
  envrcHookPromptSkipped?: boolean;
  layout?: LayoutMode;
  /**
   * 使用する AI runtime backend（デフォルト: "claude-code"）。Issue #30 M5
   * - "claude-code": Claude Code CLI + cmux（既存動作）
   * - "opencode": opencode REST API / SSE
   */
  runtime?: "claude-code" | "opencode";
  /** opencode backend の設定。Issue #30 M5 / #37 */
  opencode?: {
    /** opencode server の URL（デフォルト: "http://localhost:54321"） */
    serverUrl?: string;
    /**
     * Agent ロールに opencode を使うかどうか（デフォルト: false）。Issue #37
     * true のとき spawn-agent / await-agent / kill-agent が opencode 経路を使う。
     * Conductor は常に Claude Code のまま。
     */
    agentEnabled?: boolean;
    /**
     * opencode Agent で使うモデル名（デフォルト: "anthropic/claude-fable-5"）。Issue #37
     * "providerID/modelID" 形式（スラッシュ必須）で opencode provider layer に渡す。
     * スラッシュが無い値は model 指定として渡らず opencode 側デフォルトにフォールバックする。
     * 例: "anthropic/claude-fable-5", "openrouter/anthropic/claude-haiku-4.5"
     */
    agentModel?: string;
  };
  /**
   * caffeinate によるスリープ抑止モード（デフォルト: "aggressive"）。T419 で mode 化。
   *
   * - `"off"`        : caffeinate を起動しない（旧 sleepPrevention=false 相当）
   * - `"idle"`       : `caffeinate -i` のみ起動（user idle 抑止、display sleep は許可）
   * - `"aggressive"` : `caffeinate -dis`（display + idle + system sleep を全抑止、T256 以降のデフォルト）
   *
   * 後方互換: boolean は受理する（true → "aggressive"、false → "off"）。詳細は
   * `normalizeSleepPrevention` / `resolveSleepPrevention` を参照。
   */
  sleepPrevention?: SleepPreventionMode | boolean;
  /**
   * auto-update のモード（デフォルト: "off"）。env CMUX_TEAM_AUTO_UPDATE が優先。
   * - "off": 更新チェックしない
   * - "notify": 更新を検出して TUI バナーに表示（install は行わない）
   *
   * T294 (v4.5.0): `"task"` モードと boolean 後方互換（true/false）は削除された。
   * 旧値が残っている場合は resolveAutoUpdateMode が throw する（exit 1）。
   */
  autoUpdate?: AutoUpdateMode;
  /**
   * プロジェクトの主開発ブランチ。未設定時は cmux-team start 起動時に
   * `git symbolic-ref refs/remotes/origin/HEAD` で自動検出して書き込まれる。T213 で追加。
   */
  mainBranch?: string;
  /**
   * Metrics タブの再描画間隔（ms）。T354 で追加。
   * - default: 10_000（10s）
   * - clamp: [1_000, 600_000]（1s 〜 10min）
   * - 不正値（型違反 / 範囲外）は default に倒す（fail-fast せず warn のみ）
   *
   * 1s 未満は CPU 浪費、10min 超は実質手動 reload と変わらないためレンジを切る。
   */
  metricsRefreshIntervalMs?: number;
  /**
   * token pool の有効/無効と policy。T322 で `enabled` のみ追加、T335 で
   * `default` / `include` / `exclude` を拡張。
   *
   * - `enabled`: 未指定時は global config / default(false) にフォールバック。
   *   env CMUX_TEAM_TOKEN_POOL が最優先。詳細は resolveTokenPoolEnabled を参照。
   * - `default`: spawn-agent 時に最優先で候補化される handle（runtime 昇格・DB 不変）
   * - `include`: tags 不一致でも候補化を強制する handle 配列
   * - `exclude`: 最優先で候補から除外する handle 配列
   *
   * policy 整形は resolveProjectTokenPool を参照。
   */
  tokenPool?: {
    enabled?: boolean;
    default?: string;
    include?: string[];
    exclude?: string[];
  };
  /**
   * `.team/` 自動 GC の保持ポリシー（T416）。
   * 全フィールド optional — 未指定値は team-gc.ts の DEFAULTS で埋める。
   */
  gc?: GcConfig;
  /**
   * Post-mortem evidence capture の override（T010）。
   * 全フィールド optional — 未指定値は resolvePostMortemConfig の DEFAULTS で埋める。
   *
   * - `heartbeatIntervalMs`: heartbeat 書き込み間隔（ms）。default 10_000、clamp [1_000, 600_000]
   * - `telemetryIntervalMs`: telemetry jsonl append 間隔（ms）。default 30_000、clamp [5_000, 3_600_000]
   * - `telemetryMaxBytes`: telemetry jsonl の rotation 閾値（bytes）。default 5_242_880、clamp [262_144, 268_435_456]
   * - `stderrRotateGenerations`: stderr.log の rotate 世代数。default 1、clamp [1, 5]
   */
  postMortem?: PostMortemConfig;
  /**
   * cmux / c11 backend 周りの調整 override（T026）。全フィールド optional。
   *
   * - `reservedRenameDelayMs`: reserved Conductor pane の delay re-rename 遅延（ms）。
   *   c11 default title setter (W-A) が surface 作成 +~570ms で `[N] Claude Code` を
   *   書き戻す問題を、後着で `[N] Conductor` に上書きするための待ち時間。
   *   default 800ms (570ms + マージン 230ms)。clamp [0, 60_000]。
   *   実機の W-A timing が将来 c11 update で変わったとき、再ビルド無しに延長可能にする。
   */
  cmux?: CmuxConfig;
  /**
   * dashboard server の設定（T034）。全フィールド optional。
   *
   * - `port`: 固定 listen port。未指定 / `0` = ephemeral（従来どおり）。
   *   整数 [1, 65535] のみ受理。不正値は default（ephemeral）に倒し、呼び出し側が warn log を出す。
   *   詳細は resolveDashboardPort / docs/spec/12-web-dashboard.md を参照。
   */
  dashboard?: DashboardConfig;
}

/**
 * cmux / c11 backend 周りの設定（T026）。詳細は docs/spec 該当箇所（未作成）または
 * conductor.ts の reserved 分岐コメントを参照。
 */
export interface CmuxConfig {
  reservedRenameDelayMs?: number;
}

/**
 * `cmux.reservedRenameDelayMs` を解決する（T026）。
 *
 * - 数値以外 / 非有限 → default(800)
 * - 範囲外（< 0 / > 60_000）→ default(800)
 * - 範囲内 → そのまま返す
 *
 * 範囲は「0 = delay 無し（テスト時短縮用）」から「60s（reserved init を 1 分以上待たせる
 * 設定は明らかに事故）」まで。実機既定 800ms はマージン込み（findings 実測 570ms +230ms）。
 */
export function resolveReservedRenameDelayMs(config: Pick<TeamConfig, "cmux">): number {
  const DEFAULT_MS = 800;
  const MIN_MS = 0;
  const MAX_MS = 60_000;
  const raw = config.cmux?.reservedRenameDelayMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MS;
  if (raw < MIN_MS || raw > MAX_MS) return DEFAULT_MS;
  return raw;
}

/**
 * dashboard server の設定（T034）。詳細は docs/spec/12-web-dashboard.md §2.3 / §10.3。
 */
export interface DashboardConfig {
  /** 固定 listen port。未指定 / 0 = ephemeral（従来どおり）。整数 [1, 65535] のみ受理 */
  port?: number;
}

/**
 * `resolveDashboardPort` の解決結果（T034）。
 *
 * invalid を silent にしないため、reject 理由を `invalidReason` で返す。
 * resolve 関数自体は log しない（呼び出し側 main.ts が warn log を出す既存流儀）。
 */
export interface DashboardPortResolution {
  /** 解決された listen port。0 = ephemeral */
  port: number;
  /** 値の出所。config に有効値があれば "config"、未指定・不正値なら "default" */
  source: "config" | "default";
  /** 値はあったが reject した場合のみセット（呼び出し側の warn log 用） */
  invalidReason?: string;
}

/**
 * `dashboard.port` を解決する（T034）。
 *
 * - 未指定 → `{ port: 0, source: "default" }`（ephemeral、従来どおり）
 * - `0` → `{ port: 0, source: "config" }`（明示 ephemeral として有効値扱い）
 * - 整数 [1, 65535] → そのまま受理
 * - 非 number / 非有限 / 非整数 / 範囲外 → default + invalidReason
 *
 * privileged port（1〜1023）は reject しない。bind 時に EACCES で fail し、
 * bind 失敗経路（`dashboard_server_start_failed`）で明示ログが出るため、二重検証を持たない。
 */
export function resolveDashboardPort(
  config: Pick<TeamConfig, "dashboard">,
): DashboardPortResolution {
  const raw = config.dashboard?.port;
  if (raw === undefined) return { port: 0, source: "default" };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      port: 0,
      source: "default",
      invalidReason: `dashboard.port must be an integer in [0, 65535], got ${JSON.stringify(raw)}`,
    };
  }
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535) {
    return {
      port: 0,
      source: "default",
      invalidReason: `dashboard.port must be an integer in [0, 65535], got ${raw}`,
    };
  }
  return { port: raw, source: "config" };
}

/**
 * Post-mortem evidence capture の設定（T010）。詳細は docs/spec/15-post-mortem-evidence.md。
 */
export interface PostMortemConfig {
  heartbeatIntervalMs?: number;
  telemetryIntervalMs?: number;
  telemetryMaxBytes?: number;
  stderrRotateGenerations?: number;
}

/**
 * `.team/` 自動 GC の保持ポリシー（T416）。詳細は docs/spec/05-install-and-infrastructure.md。
 */
export interface GcConfig {
  /** 起動時 GC を実行するか。default: true */
  runOnStart?: boolean;
  /** periodic GC を実行するか。default: true */
  periodic?: boolean;
  /** periodic GC の周期（ms）。default: 86_400_000 = 24h。clamp: [3_600_000, 604_800_000] */
  intervalMs?: number;
  /** 削除を行わず log のみ出すか。default: false */
  dryRun?: boolean;
  retention?: {
    /** .team/logs/traces/bodies/<file> の保持日数。default: 14 */
    bodiesDays?: number;
    /** .team/prompts/<file> の保持日数。default: 14 */
    promptsDays?: number;
    /** .team/queue/processed/<file> の保持日数。default: 7 */
    queueProcessedDays?: number;
    /** .team/output/<taskRunId>/ の保持日数。default: 14 */
    outputDays?: number;
    /** .team/conductors/<surface>/ の保持日数。default: 14 */
    conductorsDays?: number;
    /** .team/e2e-results/<run-id>/ の保持日数。default: 7 */
    e2eResultsDays?: number;
    /** hook_signals / api_usage の保持日数。default: 30 */
    dbDays?: number;
  };
  rotation?: {
    /** ローテート発火サイズ（bytes）。default: 10_485_760 (10MB) */
    sizeBytes?: number;
    /** 保持世代数。default: 5（.1 〜 .5） */
    keep?: number;
  };
}

/**
 * resolveGcConfig: GcConfig の不正値を default に倒した完全形を返す（T416）。
 *
 * - 各 boolean / number は型違反で default に倒す（resolveMetricsRefreshIntervalMs と同流儀）
 * - intervalMs は [1h, 168h] に clamp
 * - retention.*Days は >= 0 のみ受理（0 は active 保護 race 警告用に運用）
 * - rotation.sizeBytes は >= 1MB のみ受理、rotation.keep は [1, 50]
 *
 * 不正値はすべて default に倒すだけで throw しない（fail-fast せず log は呼び出し側）。
 */
export function resolveGcConfig(
  config: Pick<TeamConfig, "gc">,
): Required<GcConfig> & {
  retention: Required<NonNullable<GcConfig["retention"]>>;
  rotation: Required<NonNullable<GcConfig["rotation"]>>;
} {
  const DEFAULTS = {
    runOnStart: true,
    periodic: true,
    intervalMs: 86_400_000,
    dryRun: false,
    retention: {
      bodiesDays: 14,
      promptsDays: 14,
      queueProcessedDays: 7,
      outputDays: 14,
      conductorsDays: 14,
      e2eResultsDays: 7,
      dbDays: 30,
    },
    rotation: {
      sizeBytes: 10_485_760,
      keep: 5,
    },
  } as const;

  const INTERVAL_MIN = 3_600_000; // 1h
  const INTERVAL_MAX = 604_800_000; // 7day
  const ROTATION_SIZE_MIN = 1_048_576; // 1MB
  const ROTATION_KEEP_MIN = 1;
  const ROTATION_KEEP_MAX = 50;

  const gc = config.gc ?? {};

  const pickBool = (raw: unknown, def: boolean): boolean =>
    typeof raw === "boolean" ? raw : def;

  const pickInterval = (raw: unknown): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULTS.intervalMs;
    if (raw < INTERVAL_MIN || raw > INTERVAL_MAX) return DEFAULTS.intervalMs;
    return raw;
  };

  const pickDays = (raw: unknown, def: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
    if (raw < 0) return def;
    return raw;
  };

  const pickSize = (raw: unknown): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULTS.rotation.sizeBytes;
    if (raw < ROTATION_SIZE_MIN) return DEFAULTS.rotation.sizeBytes;
    return raw;
  };

  const pickKeep = (raw: unknown): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULTS.rotation.keep;
    if (raw < ROTATION_KEEP_MIN || raw > ROTATION_KEEP_MAX) return DEFAULTS.rotation.keep;
    return Math.floor(raw);
  };

  const retention = gc.retention ?? {};
  const rotation = gc.rotation ?? {};

  return {
    runOnStart: pickBool(gc.runOnStart, DEFAULTS.runOnStart),
    periodic: pickBool(gc.periodic, DEFAULTS.periodic),
    intervalMs: pickInterval(gc.intervalMs),
    dryRun: pickBool(gc.dryRun, DEFAULTS.dryRun),
    retention: {
      bodiesDays: pickDays(retention.bodiesDays, DEFAULTS.retention.bodiesDays),
      promptsDays: pickDays(retention.promptsDays, DEFAULTS.retention.promptsDays),
      queueProcessedDays: pickDays(
        retention.queueProcessedDays,
        DEFAULTS.retention.queueProcessedDays,
      ),
      outputDays: pickDays(retention.outputDays, DEFAULTS.retention.outputDays),
      conductorsDays: pickDays(retention.conductorsDays, DEFAULTS.retention.conductorsDays),
      e2eResultsDays: pickDays(retention.e2eResultsDays, DEFAULTS.retention.e2eResultsDays),
      dbDays: pickDays(retention.dbDays, DEFAULTS.retention.dbDays),
    },
    rotation: {
      sizeBytes: pickSize(rotation.sizeBytes),
      keep: pickKeep(rotation.keep),
    },
  };
}

/**
 * `~/.cmux-team/config.yaml` のスキーマ。T322 で追加、T335 で拡張。
 * yaml 慣習に従い snake_case (`token_pool`) で受け、内部表現は camelCase (`tokenPool`) に正規化する。
 *
 * - `enabled`: T322 既存（pool 全体の有効/無効）
 * - `ossDefault`: T335。OSS project の default fallback handle（yaml: `oss_default`）
 * - `primaryOrgs`: T335。自社 org 名配列。OSS 判定に使う（yaml: `primary_orgs`）
 *
 * **廃止**: `oss_pool_tags`（旧 A019 案）は T335 で廃止。OSS project では
 * `selectable=1` の全 token を候補化するシンプルなルールに置き換えた。
 */
export interface GlobalConfig {
  tokenPool?: {
    enabled?: boolean;
    ossDefault?: string;
    primaryOrgs?: string[];
  };
}

/**
 * Project tokenPool の整形済み policy。T335 で追加。
 *
 * - `default`: project 設定の `tokenPool.default`。null=未指定
 * - `include`: 重複 / 型違反を除いた string 配列
 * - `exclude`: default と重複する handle を除いた string 配列
 *
 * **enabled は含めない**: 別経路の `resolveTokenPoolEnabled` が 3 階層で解決する。
 */
export interface ProjectTokenPoolPolicy {
  default: string | null;
  include: string[];
  exclude: string[];
}

/**
 * Global tokenPool の整形済み policy。T335 で追加。
 *
 * - `ossDefault`: OSS project の default fallback handle。null=未指定
 * - `primaryOrgs`: 自社 org 名配列（小文字英数推奨）
 *
 * **enabled は含めない**: 別経路の `resolveTokenPoolEnabled` が解決する。
 */
export interface GlobalTokenPoolPolicy {
  ossDefault: string | null;
  primaryOrgs: string[];
}

/**
 * 大文字を含む handle に対して 1 回だけ warn する純粋ヘルパ（副作用は console.warn のみ）。
 *
 * tokens.db 上の handle は CLI 経由で小文字英数のみが許容されるため、config に
 * 大文字混じり handle を書くと結果として「マッチしない」状態になる。利用者が
 * 気付けるよう警告するが、自動 lowercase 化や reject はしない（plan §4 決定方針）。
 */
function warnIfUppercaseHandle(handle: string, field: string): void {
  if (/[A-Z]/.test(handle)) {
    console.warn(
      `[token-pool] config_warning: handle '${handle}' (${field}) contains uppercase letters; ` +
        `tokens are matched as-is and likely won't match (handles are lowercase by convention)`,
    );
  }
}

/**
 * `tokenPool` の string[] フィールドを安全に正規化する。
 *
 * - 配列でない → 空配列を返す（呼び出し側で feature 自体を無効化）
 * - string でない要素 → console.warn で報告して捨てる
 * - 重複は維持（dedup は default との関係で個別に行う）
 */
function normalizeStringList(
  raw: unknown,
  field: string,
): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string") {
      out.push(v);
    } else {
      console.warn(
        `[token-pool] config_warning: ${field} contains non-string entry ${JSON.stringify(v)}; ignoring`,
      );
    }
  }
  return out;
}

/**
 * Project の tokenPool 設定を整形済み policy に変換する（T335）。
 *
 * 仕様:
 * - `default` が string でない → null
 * - `default` ∈ `include` → include 側を黙って dedup（default 優先）
 * - `default` ∈ `exclude` → console.warn + exclude 側から default を除外（default 候補化を維持）
 * - `include` / `exclude` の文字列以外要素は warn して捨てる
 * - 大文字を含む handle は warn のみ（reject も lowercase 化もしない）
 */
export function resolveProjectTokenPool(
  projectConfig: Pick<TeamConfig, "tokenPool">,
): ProjectTokenPoolPolicy {
  const tp = projectConfig.tokenPool;
  if (!tp) {
    return { default: null, include: [], exclude: [] };
  }

  const defaultHandle: string | null =
    typeof tp.default === "string" ? tp.default : null;
  if (defaultHandle !== null) warnIfUppercaseHandle(defaultHandle, "default");

  const include = normalizeStringList(tp.include, "tokenPool.include");
  const exclude = normalizeStringList(tp.exclude, "tokenPool.exclude");

  // include / exclude の各 handle に対しても uppercase warn
  for (const h of include) warnIfUppercaseHandle(h, "include");
  for (const h of exclude) warnIfUppercaseHandle(h, "exclude");

  // default ∩ include → include 側を dedup（静かに）
  const dedupedInclude =
    defaultHandle === null ? include : include.filter((h) => h !== defaultHandle);

  // default ∩ exclude → warn + exclude 側から除外（default 候補化を維持）
  let dedupedExclude = exclude;
  if (defaultHandle !== null && exclude.includes(defaultHandle)) {
    console.warn(
      `[token-pool] config_warning: default '${defaultHandle}' is also in exclude — ignoring exclude entry`,
    );
    dedupedExclude = exclude.filter((h) => h !== defaultHandle);
  }

  return { default: defaultHandle, include: dedupedInclude, exclude: dedupedExclude };
}

/**
 * Global の tokenPool 設定を整形済み policy に変換する（T335）。
 *
 * - null → 空 policy
 * - `ossDefault` が string でない → null
 * - `primaryOrgs` の文字列以外要素は normalizeStringList が warn して捨てる
 */
export function resolveGlobalTokenPool(
  globalConfig: GlobalConfig | null,
): GlobalTokenPoolPolicy {
  if (!globalConfig || !globalConfig.tokenPool) {
    return { ossDefault: null, primaryOrgs: [] };
  }
  const tp = globalConfig.tokenPool;
  const ossDefault: string | null =
    typeof tp.ossDefault === "string" ? tp.ossDefault : null;
  if (ossDefault !== null) warnIfUppercaseHandle(ossDefault, "ossDefault");

  const primaryOrgs = normalizeStringList(tp.primaryOrgs, "tokenPool.primary_orgs");

  return { ossDefault, primaryOrgs };
}

/**
 * `.team/config.json` + global config + project context (git remote / OSS 判定) を合成して
 * `SelectTokenPolicy` を構築する（T367）。
 *
 * `selectToken` / `canSelectAnyToken` の policy 引数として直接渡せる形で返す。
 * spawn-agent と daemon (pool-throttle) の両方が同じ関数を呼ぶことで、
 * admit 判定の構造的整合性を保証する（design-review-r2 Major #N1 対応）。
 *
 * - 失敗時は `["any"]` / `isOss=false` の安全 fallback（resolveProjectContext と同方針）
 * - resolveProjectContext は git/network を参照するため、daemon 起動時の cache では
 *   network 復旧に追従しない（plan §0.1 確定: 起動時 1 回固定 + diagnostic ログ）
 *
 * @returns daemon 起動時 / spawn-agent ごとに同じシグネチャで取得可能な policy。失敗しても throw しない。
 */
export async function buildSelectTokenPolicy(
  projectRoot: string,
): Promise<import("./token-store").SelectTokenPolicy> {
  // 動的 import で循環依存を避ける（config.ts → token-store.ts は許容、逆は禁止）
  const { resolveProjectContext } = await import("./project-tags");

  const [projectConfig, globalConfig] = await Promise.all([
    loadConfig(projectRoot),
    loadGlobalConfig(),
  ]);
  const projectPolicy = resolveProjectTokenPool(projectConfig);
  const globalPolicy = resolveGlobalTokenPool(globalConfig);

  let projectTags: string[];
  let isOss: boolean;
  try {
    const ctx = await resolveProjectContext(projectRoot, globalPolicy.primaryOrgs);
    projectTags = ctx.projectTags;
    isOss = ctx.isOss;
  } catch {
    projectTags = ["any"];
    isOss = false;
  }

  return {
    projectTags,
    projectDefault: projectPolicy.default,
    include: projectPolicy.include,
    exclude: projectPolicy.exclude,
    isOss,
    ossDefault: globalPolicy.ossDefault,
  };
}

/**
 * `.team/config.json` を読み込む。存在しない / 壊れている時は空オブジェクトを返す。
 */
export async function loadConfig(projectRoot: string): Promise<TeamConfig> {
  const configPath = join(projectRoot, ".team/config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * レイアウトモードを解決する。
 * 優先順位: CLI フラグ (--layout) > config.json の layout > "16x9"
 * 不正値は Error を throw する（呼び出し元で process.exit する想定）。
 */
export function resolveLayout(
  config: Pick<TeamConfig, "layout">,
  cliLayout: string | undefined,
): LayoutMode {
  const raw = cliLayout ?? config.layout ?? "16x9";
  if (raw !== "wide" && raw !== "16x9") {
    throw new Error(`Unknown layout: ${raw} (expected "wide" or "16x9")`);
  }
  return raw;
}

/**
 * caffeinate sleep prevention モードを解決する（T419）。
 *
 * 優先順位: CLI `--no-sleep-prevention` > CLI `--sleep-prevention <mode>` > config.json > "aggressive"
 *
 * - `--no-sleep-prevention` は最優先で `"off"` に倒す（旧フラグの「絶対 disable」セマンティクスを維持）
 * - `--sleep-prevention <mode>` は config を上書きする（mode は normalizeSleepPrevention で正規化）
 * - 不正値は normalizeSleepPrevention が throw する。呼出し側で process.exit(1) する想定
 */
export function resolveSleepPrevention(
  config: Pick<TeamConfig, "sleepPrevention">,
  cli: { noSleepPrevention: boolean; sleepPrevention?: string },
): SleepPreventionMode {
  if (cli.noSleepPrevention) return "off";
  if (cli.sleepPrevention !== undefined) {
    return normalizeSleepPrevention(cli.sleepPrevention);
  }
  return normalizeSleepPrevention(config.sleepPrevention);
}

/**
 * auto-update のモードを解決する。
 * 優先順位: env CMUX_TEAM_AUTO_UPDATE > config.autoUpdate > "off"
 *
 * env 値の解釈（T294 v4.5.0 で縮約）:
 * - 未定義 / 空文字 → config にフォールバック
 * - "0" / "false" / "off" → off (source=env)
 * - "notify" → notify (source=env)
 * - それ以外（"1"/"true"/"task" を含む）→ throw
 *
 * T294: `"task"` モード（自動 update タスク起票）と boolean 後方互換を削除した。
 * 旧値（`task` / `1` / `true` / `true|false` config）は起動時に reject し、
 * cmdStart の try/catch が process.exit(1) + 移行メッセージを表示する。
 *
 * config 値の解釈: normalizeAutoUpdate に委譲（"off" / "notify" のみ受理）
 */
export function resolveAutoUpdateMode(
  config: Pick<TeamConfig, "autoUpdate">,
  env: NodeJS.ProcessEnv = process.env,
): { mode: AutoUpdateMode; source: "env" | "config" | "default" } {
  const raw = env.CMUX_TEAM_AUTO_UPDATE;
  if (raw !== undefined && raw !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return { mode: "off", source: "env" };
    if (v === "notify") return { mode: "notify", source: "env" };
    throw new Error(
      `unknown CMUX_TEAM_AUTO_UPDATE=${JSON.stringify(raw)} (expected 0|false|off|notify; ` +
        `"1" / "true" / "task" were removed in v4.5.0 — use "notify" or unset to migrate)`,
    );
  }
  if (config.autoUpdate !== undefined) {
    return { mode: normalizeAutoUpdate(config.autoUpdate), source: "config" };
  }
  return { mode: "off", source: "default" };
}

/**
 * Metrics タブの再描画間隔（ms）を解決する（T354）。
 *
 * 優先順位: config.metricsRefreshIntervalMs > default(10_000)
 *
 * - 数値以外 / 非有限 / 範囲外（< 1_000 / > 600_000）→ default に倒す
 * - 範囲内の数値 → そのまま返す
 *
 * default を下回る値（極端に短い間隔）は CPU 浪費の温床になるため reject。
 * default を上回る値（10min 超）は手動 reload と変わらないため reject。
 */
export function resolveMetricsRefreshIntervalMs(
  config: Pick<TeamConfig, "metricsRefreshIntervalMs">,
): number {
  const DEFAULT_MS = 10_000;
  const MIN_MS = 1_000;
  const MAX_MS = 600_000;
  const raw = config.metricsRefreshIntervalMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MS;
  if (raw < MIN_MS || raw > MAX_MS) return DEFAULT_MS;
  return raw;
}

/**
 * post-mortem evidence capture の設定値を default 込みで解決する（T010 S7）。
 *
 * 各フィールドは型違反 / 範囲外なら default に倒す（fail-fast せず silent fallback）。
 * clamp ルールは plan §3.2 / D2 / D3 / D4 を参照。
 */
export function resolvePostMortemConfig(
  config: Pick<TeamConfig, "postMortem">,
): Required<PostMortemConfig> {
  const DEFAULTS = {
    heartbeatIntervalMs: 10_000,
    telemetryIntervalMs: 30_000,
    telemetryMaxBytes: 5_242_880, // 5 MB
    stderrRotateGenerations: 1,
  } as const;

  const HEARTBEAT_MIN = 1_000;
  const HEARTBEAT_MAX = 600_000;
  const TELEMETRY_INTERVAL_MIN = 5_000;
  const TELEMETRY_INTERVAL_MAX = 3_600_000;
  const TELEMETRY_BYTES_MIN = 262_144; // 256 KB
  const TELEMETRY_BYTES_MAX = 268_435_456; // 256 MB
  const ROTATE_MIN = 1;
  const ROTATE_MAX = 5;

  const pm = config.postMortem ?? {};

  const pickClampedInt = (
    raw: unknown,
    min: number,
    max: number,
    def: number,
  ): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
    if (raw < min || raw > max) return def;
    return Math.floor(raw);
  };

  return {
    heartbeatIntervalMs: pickClampedInt(
      pm.heartbeatIntervalMs,
      HEARTBEAT_MIN,
      HEARTBEAT_MAX,
      DEFAULTS.heartbeatIntervalMs,
    ),
    telemetryIntervalMs: pickClampedInt(
      pm.telemetryIntervalMs,
      TELEMETRY_INTERVAL_MIN,
      TELEMETRY_INTERVAL_MAX,
      DEFAULTS.telemetryIntervalMs,
    ),
    telemetryMaxBytes: pickClampedInt(
      pm.telemetryMaxBytes,
      TELEMETRY_BYTES_MIN,
      TELEMETRY_BYTES_MAX,
      DEFAULTS.telemetryMaxBytes,
    ),
    stderrRotateGenerations: pickClampedInt(
      pm.stderrRotateGenerations,
      ROTATE_MIN,
      ROTATE_MAX,
      DEFAULTS.stderrRotateGenerations,
    ),
  };
}

/**
 * worktree 作成前の `git fetch` を行うかどうかを解決する（T283）。
 *
 * 優先順位: env CMUX_TEAM_FETCH_BEFORE_WORKTREE > default (true)
 *
 * env 値の解釈:
 * - 未定義 / 空文字 → { enabled: true, source: "default" }
 * - "1" / "true" / "on" → { enabled: true, source: "env" }
 * - "0" / "false" / "off" → { enabled: false, source: "env" }
 * - それ以外 → throw
 *
 * T283 で従来の「デフォルト OFF」を「デフォルト ON」に反転した。offline 環境・
 * rate limit 対策で OFF にしたい場合は `CMUX_TEAM_FETCH_BEFORE_WORKTREE=0` を
 * 設定する。起動ログに `fetch_before_worktree enabled=<on|off> source=<env|default>`
 * を 1 回 emit する（cmdStart）。
 */
export function resolveFetchBeforeWorktree(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "default" } {
  const raw = env.CMUX_TEAM_FETCH_BEFORE_WORKTREE;
  if (raw === undefined || raw === "") {
    return { enabled: true, source: "default" };
  }
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return { enabled: true, source: "env" };
  if (v === "0" || v === "false" || v === "off") return { enabled: false, source: "env" };
  throw new Error(
    `unknown CMUX_TEAM_FETCH_BEFORE_WORKTREE=${JSON.stringify(raw)} (expected 0|1|true|false|on|off)`,
  );
}

/**
 * token pool の有効/無効を 3 階層で解決する純粋関数。T322 で追加。
 *
 * 優先順位: env > project > global > default(false / opt-in)
 *
 * env `CMUX_TEAM_TOKEN_POOL` の解釈:
 * - "0" / "false" / "off" → false (source=env)
 * - "1" / "true" / "on"   → true  (source=env)
 * - 未定義 / 空文字       → 次の層にフォールバック
 * - それ以外              → throw（既存 resolveAutoUpdateMode 等と同じ fail-fast 流儀）
 *
 * project / global の解釈:
 * - フィールド未指定 / undefined / null → 次の層にフォールバック
 * - boolean 以外（string / number 等）  → 型違反として未指定扱い（zod 未導入なので runtime check は最小限）
 */
export function resolveTokenPoolEnabled(
  projectConfig: Pick<TeamConfig, "tokenPool">,
  globalConfig: Pick<GlobalConfig, "tokenPool"> | null,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "project" | "global" | "default" } {
  const raw = env.CMUX_TEAM_TOKEN_POOL;
  if (raw !== undefined && raw !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off") return { enabled: false, source: "env" };
    if (v === "1" || v === "true" || v === "on") return { enabled: true, source: "env" };
    throw new Error(
      `unknown CMUX_TEAM_TOKEN_POOL=${JSON.stringify(raw)} (expected 0|1|true|false|on|off)`,
    );
  }
  const projectVal = projectConfig.tokenPool?.enabled;
  if (typeof projectVal === "boolean") {
    return { enabled: projectVal, source: "project" };
  }
  const globalVal = globalConfig?.tokenPool?.enabled;
  if (typeof globalVal === "boolean") {
    return { enabled: globalVal, source: "global" };
  }
  return { enabled: false, source: "default" };
}

/**
 * `~/.cmux-team/config.yaml` を読み込んで GlobalConfig に正規化する。T322 で追加。
 *
 * - ファイル不在 → null（next-layer フォールバック扱い）
 * - parse 失敗 → console.warn のみ出して null を返す（best-effort、daemon は停止しない）
 * - yaml 慣習の `token_pool.enabled` を camelCase の `tokenPool.enabled` に詰め替える
 *
 * yaml ライブラリは `yaml` (eemeli/yaml)。bun runtime で動作確認済み。
 */
export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  // Bun の os.homedir() は HOME 環境変数を尊重しない実装のため、env を優先する。
  // env 未設定時のみ homedir() に fallback する（token-store と同じ流儀）。
  const home = process.env.HOME ?? homedir();
  const path = join(home, ".cmux-team/config.yaml");
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const yaml = await import("yaml");
    const parsed = yaml.parse(text);
    if (parsed === null || typeof parsed !== "object") return {};
    const tp = (parsed as Record<string, unknown>).token_pool;
    if (tp && typeof tp === "object") {
      const tpObj = tp as Record<string, unknown>;
      const tokenPool: GlobalConfig["tokenPool"] = {};
      const enabled = tpObj.enabled;
      if (typeof enabled === "boolean") {
        tokenPool.enabled = enabled;
      }
      // T335: oss_default → ossDefault に詰め替え
      const ossDefault = tpObj.oss_default;
      if (typeof ossDefault === "string") {
        tokenPool.ossDefault = ossDefault;
      }
      // T335: primary_orgs → primaryOrgs に詰め替え（型違反は warn + 捨てる）
      const primaryOrgs = tpObj.primary_orgs;
      if (Array.isArray(primaryOrgs)) {
        const normalized: string[] = [];
        for (const v of primaryOrgs) {
          if (typeof v === "string") {
            normalized.push(v);
          } else {
            console.warn(
              `[token-pool] config_warning: token_pool.primary_orgs contains non-string entry ${JSON.stringify(v)}; ignoring`,
            );
          }
        }
        tokenPool.primaryOrgs = normalized;
      }
      // T335: oss_pool_tags は廃止 — 残っていたら一度だけ warn
      if (tpObj.oss_pool_tags !== undefined) {
        console.warn(
          `[token-pool] config_warning: 'oss_pool_tags' is deprecated and ignored (T335); ` +
            `OSS projects now admit all selectable=1 tokens (exclude only). Remove this key from ~/.cmux-team/config.yaml`,
        );
      }
      return { tokenPool };
    }
    return {};
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`cmux-team: failed to parse ~/.cmux-team/config.yaml: ${msg}`);
    return null;
  }
}

/**
 * project / global / env の 3 階層を読み込んで boolean に解決する高レベル wrapper。T322 で追加。
 * cmdSpawnAgent / cmdStart はこれを呼ぶだけで運用ログ用の source も取れる。
 */
export async function isTokenPoolEnabled(
  projectRoot: string,
): Promise<{ enabled: boolean; source: "env" | "project" | "global" | "default" }> {
  const [projectConfig, globalConfig] = await Promise.all([
    loadConfig(projectRoot),
    loadGlobalConfig(),
  ]);
  return resolveTokenPoolEnabled(projectConfig, globalConfig);
}
