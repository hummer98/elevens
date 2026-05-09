/**
 * `elevens mailbox` CLI — c11 surface metadata (mailbox.*) の薄いラッパー。
 *
 * cmux backend では opportunistic no-op（c11-features.ts に委譲）。
 * agent prompt から `elevens mailbox set --key mailbox.status --value running` のように
 * backend を意識せず呼び出せるよう、target 未指定なら $CMUX_SURFACE_ID / $CMUX_SURFACE を fallback にする。
 *
 * Phase 2 の dual-write 戦略に従い、cmux backend では失敗ではなく成功 (exit 0) で no-op にする
 * （prompt 側で常に呼んでも問題が起きない）。
 */
import {
  setMailbox,
  getMailbox,
  clearMailbox,
  isMailboxSupported,
  type MailboxTarget,
  type MailboxValue,
} from "./c11-features";

type Argv = string[];

function parseArgs(argv: Argv): { flags: Map<string, string>; multi: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      const isBoolFlag = next === undefined || next.startsWith("--");
      if (isBoolFlag) {
        flags.set(name, "true");
      } else {
        flags.set(name, next);
        // multi-value (--key を複数回指定可)
        const arr = multi.get(name) ?? [];
        arr.push(next);
        multi.set(name, arr);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, multi, positional };
}

function resolveTarget(flags: Map<string, string>): MailboxTarget {
  const surface = flags.get("surface") ?? process.env.CMUX_SURFACE_ID ?? process.env.CMUX_SURFACE;
  const pane = flags.get("pane");
  if (pane) return { kind: "pane", ref: pane };
  if (!surface) {
    throw new Error("--surface or --pane required (or set CMUX_SURFACE_ID env)");
  }
  return { kind: "surface", ref: surface };
}

function coerceValue(raw: string, type: string | undefined): MailboxValue {
  switch (type) {
    case undefined:
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--type=number だが値が数値ではない: ${raw}`);
      return n;
    }
    case "bool":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`--type=bool だが値が true/false ではない: ${raw}`);
    case "json":
      try {
        return JSON.parse(raw);
      } catch (e: any) {
        throw new Error(`--type=json だが JSON パース失敗: ${e.message}`);
      }
    default:
      throw new Error(`unknown --type: ${type}`);
  }
}

function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write(`elevens mailbox — c11 surface metadata helpers (cmux backend では no-op)

Usage:
  elevens mailbox set [--surface S | --pane P] (--key K --value V [--type T] | --json '{...}') [--source SRC]
  elevens mailbox get [--surface S | --pane P] [--key K]... [--sources] [--json]
  elevens mailbox clear [--surface S | --pane P] --key K
  elevens mailbox supported

Flags:
  --surface <ref>   surface ref (default: $CMUX_SURFACE_ID, $CMUX_SURFACE)
  --pane <ref>      pane ref (排他: --surface と同時指定不可)
  --key <K>         キー名（mailbox.* 推奨。get では --key 複数指定で filter）
  --value <V>       値
  --type <T>        値の型: string|number|bool|json (default: string)
  --json <payload>  set のとき payload (object) を一括書き込み
  --source <SRC>    set の precedence: explicit|declare|osc|heuristic (default: declare)
  --sources         get で metadata_sources sidecar を同梱
  --json            get で raw JSON を出力（default は plain text）

例:
  elevens mailbox set --key mailbox.status --value running
  elevens mailbox set --json '{"mailbox.role":"agent","mailbox.task":"123"}'
  elevens mailbox get --json
  elevens mailbox clear --key mailbox.status
`);
}

export type RunMailboxCliInput = {
  args: Argv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export async function runMailboxCli(input: RunMailboxCliInput): Promise<number> {
  const { args, stdout, stderr } = input;
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    showHelp(stdout);
    return 0;
  }

  const { flags, multi } = parseArgs(args.slice(1));

  try {
    switch (sub) {
      case "supported": {
        const ok = await isMailboxSupported();
        stdout.write(ok ? "yes\n" : "no\n");
        return ok ? 0 : 1;
      }

      case "set": {
        const target = resolveTarget(flags);
        const source = (flags.get("source") as any) ?? "declare";
        let payload: Record<string, MailboxValue>;
        if (flags.has("json")) {
          const raw = flags.get("json")!;
          try {
            const obj = JSON.parse(raw);
            if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
              throw new Error("payload must be a JSON object");
            }
            payload = obj;
          } catch (e: any) {
            stderr.write(`set --json payload parse error: ${e.message}\n`);
            return 2;
          }
        } else {
          const key = flags.get("key");
          const value = flags.get("value");
          if (!key || value === undefined) {
            stderr.write("set: --key と --value（または --json）が必要\n");
            return 2;
          }
          payload = { [key]: coerceValue(value, flags.get("type")) };
        }
        await setMailbox(target, payload, { source });
        return 0;
      }

      case "get": {
        const target = resolveTarget(flags);
        const withSources = flags.has("sources");
        const data = await getMailbox(target, { withSources });
        const wantJson = flags.has("json");
        if (data === null) {
          if (wantJson) stdout.write("{}\n");
          return 0;
        }
        const keys = multi.get("key") ?? [];
        const filtered: Record<string, any> = keys.length
          ? Object.fromEntries(Object.entries(data).filter(([k]) => keys.includes(k)))
          : (data as Record<string, any>);
        if (wantJson) {
          stdout.write(JSON.stringify(filtered, null, 2) + "\n");
        } else {
          for (const [k, v] of Object.entries(filtered)) {
            stdout.write(`${k} = ${typeof v === "string" ? v : JSON.stringify(v)}\n`);
          }
        }
        return 0;
      }

      case "clear": {
        const target = resolveTarget(flags);
        const key = flags.get("key");
        if (!key) {
          stderr.write("clear: --key が必要\n");
          return 2;
        }
        await clearMailbox(target, key);
        return 0;
      }

      default:
        stderr.write(`unknown mailbox subcommand: ${sub}\n`);
        showHelp(stderr);
        return 2;
    }
  } catch (e: any) {
    stderr.write(`mailbox ${sub} failed: ${e?.message ?? e}\n`);
    return 1;
  }
}
