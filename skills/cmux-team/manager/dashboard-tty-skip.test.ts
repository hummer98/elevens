/**
 * A031 follow-up: rezi/tui dashboard を non-TTY 環境で起動したとき fail-soft に skip する挙動の回帰テスト。
 *
 * 背景:
 *   - daemon を nohup / subagent / CI 経由で起動すると stdout/stdin/stderr が pipe になり、
 *     rezi の `app.start()` が `engine_create failed: code=-6` で失敗する。
 *   - 失敗そのものは fail-soft で daemon 全体は継続するが、
 *     `installDashboardConsoleRedirect()` 後の `console.error` 経路が
 *     `[error] console_error ❌ ダッシュボード起動失敗: ...` を manager.log に流し、
 *     UX 上 daemon が壊れたかのように見えてしまう。
 *
 * 期待動作:
 *   - process.stdout.isTTY が false の場合、rezi/tui の app.start() は呼ばない。
 *   - 代わりに `dashboard_tui_skipped` を info レベルで manager.log に append する。
 *   - HTTP dashboard server (start-line で別途起動) は影響を受けない (本テストは startDashboard 単体検証)。
 *   - TTY の場合は console-redirect を install して従来どおり TUI 起動を試みる。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { startDashboard, unmountDashboard } from "./dashboard";
import type { DaemonState } from "./daemon";

let project: DummyProject;
let origWarn: typeof console.warn;
let origError: typeof console.error;

async function flushAsyncLog(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function makeState(projectRoot: string): DaemonState {
  return {
    running: true,
    bootPhase: "ready",
    masters: new Map(),
    conductors: new Map(),
    projectRoot,
    pollInterval: 10_000,
    maxConductors: 2,
    layout: "16x9",
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
    lastUpdateCheckAt: 0,
    updateAvailable: null,
    updateMode: "off",
    rateLimit: null,
    proxyPort: null,
    wakeup: null,
    wakeupPending: false,
    fileWatcherAbort: null,
    proxyPortChanged: false,
    workspace: null,
    lastSidebarStatus: null,
    lastSidebarCategory: null,
    version: "v0.0.0-test",
    mainBranch: "",
    traceDb: null,
    backend: { kind: "claude-code" } as any,
    openCodeServerProcess: null,
    tokenDb: null,
    pool: null,
    poolPolicy: null,
    tokenDbInitFailed: false,
    startedAt: new Date().toISOString(),
    dashboardServerUrl: null,
    gcInterval: undefined,
    gcInFlight: false,
  } as DaemonState;
}

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-team-tty-skip-" });
  origWarn = console.warn;
  origError = console.error;
});

afterEach(async () => {
  // dashboard が install した console redirect を確実に解除
  console.warn = origWarn;
  console.error = origError;
  try { unmountDashboard(); } catch {}
  await project.dispose();
});

async function readManagerLog(): Promise<string> {
  try {
    return await readFile(join(project.root, ".team/logs/manager.log"), "utf-8");
  } catch {
    return "";
  }
}

describe("startDashboard: non-TTY fail-soft", () => {
  test("isTty=false で rezi/tui の起動を skip し info ログを残す", async () => {
    const state = makeState(project.root);
    let consoleErrorCount = 0;
    // installDashboardConsoleRedirect が呼ばれたら console.error はすり替わるが、
    // skip 経路では install 自体を呼ばない前提。素の stub で監視する。
    console.error = () => { consoleErrorCount++; };

    const handle = await startDashboard(() => state, {
      version: "test",
      isTty: false,
    });

    // skip 経路は scheduleRefresh を返すが no-op で OK
    expect(typeof handle.scheduleRefresh).toBe("function");
    handle.scheduleRefresh(); // 例外を出さないこと

    await flushAsyncLog();
    const content = await readManagerLog();

    // info レベル (prefix なし) で skip event を残す
    expect(content).toMatch(/dashboard_tui_skipped/);
    // [error] / [warn] は出さない
    expect(content).not.toMatch(/\[error\] .*dashboard/);
    expect(content).not.toMatch(/console_error/);
    // console.error も呼ばれない
    expect(consoleErrorCount).toBe(0);
  });

  test("isTty=false 経路では console.warn / error が console-redirect 経由で書き換えられない", async () => {
    const state = makeState(project.root);

    await startDashboard(() => state, { isTty: false });

    // skip 経路後、console.warn / error は依然として元の関数 (我々が beforeEach で記録したもの)
    expect(console.warn).toBe(origWarn);
    expect(console.error).toBe(origError);
  });

  test("isTty=true 指定なら従来どおり TUI 起動を試み、console-redirect が install される", async () => {
    // 注: テスト環境では実際の TTY 配線が無いため app.start() は失敗するが、
    // その失敗は fail-soft (warn 降格) で扱われ、console-redirect は既に install
    // 済みなので console.warn / error は logger 経路に振り替わる。skip 経路と
    // の差を検証するのが本テストの目的。
    const state = makeState(project.root);

    await startDashboard(() => state, { isTty: true });

    // install 後 console.warn / error は元と異なる関数になっている
    expect(console.warn).not.toBe(origWarn);
    expect(console.error).not.toBe(origError);

    await flushAsyncLog();
    const content = await readManagerLog();
    // 起動失敗は warn 降格 (skip 経路の info とは別 event)
    expect(content).toMatch(/dashboard_tui_start_failed|dashboard_tui_skipped/);
    // 旧経路の console.error → [error] console_error 経路は使われない
    expect(content).not.toMatch(/\[error\] console_error .*ダッシュボード起動失敗/);
  });
});
