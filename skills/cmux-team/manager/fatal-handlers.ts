/**
 * fatal-handlers.ts (T010 S2)
 *
 * Manager daemon の fatal 経路を一箇所に集約する handler。
 *
 *   - uncaughtException / unhandledRejection: sync log → exit(1)
 *   - SIGTERM / SIGINT / SIGHUP: sync log → onShutdown(signal) を await
 *
 * 設計理由 (plan §2.2 / D7):
 *   - `process.exit()` は同期 terminate のため、複数 listener を順次走らせて
 *     全部に副作用を持たせる設計は構造的に不可能。
 *   - したがって fatal trace の責務は本ファイル 1 箇所に集約する。
 *   - pidfile cleanup は installCrashHandler (pidfile.ts) の 'exit' listener が
 *     `process.exit(1)` 経由で必ず発火する仕様で担保されるため、本 handler では
 *     cleanup を呼ばない（責務分離）。
 *
 * 互換性:
 *   - logSync / warnSync / errorSync は logger.ts の export を default impl とする。
 *   - DI 可能（テストで in-memory に capture するため）。
 *
 * sync ロギング (logSync) は appendFileSync ベースなので、fatal handler の
 * stack 末端で process が消えても最終行は file に flush される。
 */
import {
  logSync as realLogSync,
  errorSync as realErrorSync,
} from "./logger";

export type FatalSignal = "SIGTERM" | "SIGINT" | "SIGHUP";

export interface FatalHandlerOptions {
  /** Shutdown 経路（signal handler 経由）。signal 名を渡される。 */
  onShutdown?: (signal: FatalSignal) => Promise<void> | void;
  // DI（テスト用）
  logSyncImpl?: (event: string, detail?: string) => void;
  warnSyncImpl?: (event: string, detail?: string) => void;
  errorSyncImpl?: (event: string, detail?: string) => void;
  exitImpl?: (code: number) => void;
}

const FATAL_SIGNALS: FatalSignal[] = ["SIGTERM", "SIGINT", "SIGHUP"];

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Error";
  }
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function formatStack(err: unknown): string {
  if (err instanceof Error && err.stack) {
    // 1 行 1 イベント原則。改行はスペースに畳む。
    return err.stack.replace(/\n/g, " | ");
  }
  return formatErr(err);
}

export function installFatalHandlers(opts: FatalHandlerOptions = {}): () => void {
  const logSyncImpl = opts.logSyncImpl ?? realLogSync;
  const errorSyncImpl = opts.errorSyncImpl ?? realErrorSync;
  const exitImpl = opts.exitImpl ?? ((code: number) => process.exit(code));
  const onShutdown = opts.onShutdown;

  const onUncaught = (err: unknown): void => {
    logSyncImpl("fatal_uncaught", `err=${formatErr(err)}`);
    errorSyncImpl("fatal_stack", formatStack(err));
    exitImpl(1);
  };

  const onUnhandled = (reason: unknown): void => {
    logSyncImpl("fatal_unhandled_rejection", `reason=${formatErr(reason)}`);
    errorSyncImpl("fatal_stack", formatStack(reason));
    exitImpl(1);
  };

  const signalHandlers: Array<{ signal: FatalSignal; handler: () => void }> = [];
  for (const signal of FATAL_SIGNALS) {
    const handler = (): void => {
      logSyncImpl("signal_received", `signal=${signal}`);
      if (onShutdown) {
        // shutdown は async だが listener コンテキストで await できないので fire-and-forget。
        // shutdown 自身が graceful 終了経路（releasePidFile / process.exit(0)）を担当する。
        Promise.resolve(onShutdown(signal)).catch((e) => {
          errorSyncImpl("shutdown_failed", `signal=${signal} err=${formatErr(e)}`);
        });
      }
    };
    signalHandlers.push({ signal, handler });
  }

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  for (const { signal, handler } of signalHandlers) {
    process.on(signal, handler);
  }

  return (): void => {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler);
    }
  };
}
