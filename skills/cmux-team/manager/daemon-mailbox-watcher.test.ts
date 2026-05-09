/**
 * Phase 2 観測パイプラインの単体テスト。
 *
 * Conductor lifecycle で `watchMailbox` が起動・停止し、change 検出時に
 * trace DB の `hook_signals` に `source='metadata'` で記録されることを確認する。
 *
 * 設計: daemon と c11-features の結合点だけを verify する。watchMailbox 自体は
 * c11-features.test.ts で smoke test 済み。本テストでは `__setMailboxWatcherImpl`
 * test seam で fake watcher を注入し、daemon の wiring が正しいことだけ確認する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDB, getHookSignals } from "./trace-store";
import { createDummyProject, type DummyProject } from "./test-project";
import {
  __setMailboxWatcherImpl,
  spawnConductorMailboxWatcher,
  type MailboxWatcherFactory,
} from "./daemon";
import type { DaemonState } from "./daemon";
import type { ConductorState } from "./schema";
import type { MailboxChange } from "./c11-features";

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-daemon-mailbox-watcher-test-",
    subdirs: ["logs", "traces"],
  });
  testDir = project.root;
  // events.jsonl の出力先解決（events-writer は PROJECT_ROOT を参照）
  process.env.PROJECT_ROOT = testDir;
});

afterEach(async () => {
  __setMailboxWatcherImpl(null);
  await project.dispose();
});

function buildConductor(surface: string, opts: Partial<ConductorState> = {}): ConductorState {
  return {
    surface,
    startedAt: new Date().toISOString(),
    agents: [],
    status: "running",
    ...opts,
  } as ConductorState;
}

function buildMockDaemonState(db: Database): DaemonState {
  // 必要最小限の DaemonState shape。本テストは watcher の wiring のみを検証する。
  return {
    running: true,
    conductors: new Map<string, ConductorState>(),
    projectRoot: testDir,
    workspace: null,
    traceDb: db,
  } as unknown as DaemonState;
}

describe("spawnConductorMailboxWatcher (Phase 2 観測パイプライン)", () => {
  test("Conductor register 時に watchMailbox factory が呼ばれ、stop が conductor に保存される", async () => {
    const db = initDB(testDir);
    try {
      const calls: Array<{ surface: string }> = [];
      const stopFn = () => {};
      const fakeFactory: MailboxWatcherFactory = async (target, _onChange) => {
        if (target.kind === "surface") calls.push({ surface: target.ref });
        return { stop: stopFn };
      };
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:71");
      state.conductors.set(conductor.surface, conductor);

      await spawnConductorMailboxWatcher(state, conductor);

      expect(calls.length).toBe(1);
      expect(calls[0]!.surface).toBe("surface:71");
      expect(typeof conductor.mailboxWatcherStop).toBe("function");
    } finally {
      db.close();
    }
  });

  test("change 検出時に hook_signals に source='metadata' / type='MAILBOX_CHANGED' で書き込まれる", async () => {
    const db = initDB(testDir);
    try {
      let captured: ((c: MailboxChange[]) => void | Promise<void>) | undefined;
      const fakeFactory: MailboxWatcherFactory = async (_target, onChange) => {
        captured = onChange;
        return { stop: () => {} };
      };
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:81", { taskId: "42", taskRunId: "task-42-x" });
      state.conductors.set(conductor.surface, conductor);

      await spawnConductorMailboxWatcher(state, conductor);
      if (!captured) throw new Error("onChange handler was not captured");

      // change を発火
      await captured([
        { kind: "added", key: "mailbox.status", value: "running" },
        { kind: "changed", key: "mailbox.status", value: "done", previous: "running" },
      ]);

      const rows = getHookSignals(db, { type: "MAILBOX_CHANGED" });
      expect(rows.length).toBe(2);
      // 最新が先頭（id DESC）
      const first = rows[0]!;
      const second = rows[1]!;
      expect(first.source).toBe("metadata");
      expect(first.surface).toBe("surface:81");
      expect(first.task_id).toBe("42");
      expect(first.task_run_id).toBe("task-42-x");
      const payload0 = JSON.parse(first.payload_json);
      expect(payload0.kind).toBe("changed");
      expect(payload0.key).toBe("mailbox.status");
      expect(payload0.value).toBe("done");
      expect(payload0.previous).toBe("running");

      expect(second.source).toBe("metadata");
      const payload1 = JSON.parse(second.payload_json);
      expect(payload1.kind).toBe("added");
      expect(payload1.key).toBe("mailbox.status");
      expect(payload1.value).toBe("running");
    } finally {
      db.close();
    }
  });

  test("change 検出時に events.jsonl に mailbox_changed が emit される", async () => {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const db = initDB(testDir);
    try {
      let captured: ((c: MailboxChange[]) => void | Promise<void>) | undefined;
      const fakeFactory: MailboxWatcherFactory = async (_target, onChange) => {
        captured = onChange;
        return { stop: () => {} };
      };
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:91", { taskId: "55" });
      state.conductors.set(conductor.surface, conductor);

      await spawnConductorMailboxWatcher(state, conductor);
      if (!captured) throw new Error("onChange handler was not captured");
      await captured([{ kind: "added", key: "mailbox.role", value: "conductor" }]);

      const eventsPath = join(testDir, ".team/logs/events.jsonl");
      const content = await readFile(eventsPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
      const ev = JSON.parse(lines[0]!);
      expect(ev.event).toBe("mailbox_changed");
      expect(ev.conductor_surface).toBe("surface:91");
      expect(ev.changes).toBeDefined();
      expect(ev.changes.length).toBe(1);
      expect(ev.changes[0].kind).toBe("added");
      expect(ev.changes[0].key).toBe("mailbox.role");
    } finally {
      db.close();
    }
  });

  test("conductor.mailboxWatcherStop() を呼ぶと stop が起動される", async () => {
    const db = initDB(testDir);
    try {
      let stopped = false;
      const fakeFactory: MailboxWatcherFactory = async (_target, _onChange) => ({
        stop: () => {
          stopped = true;
        },
      });
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:101");
      state.conductors.set(conductor.surface, conductor);

      await spawnConductorMailboxWatcher(state, conductor);
      expect(typeof conductor.mailboxWatcherStop).toBe("function");

      conductor.mailboxWatcherStop!();
      expect(stopped).toBe(true);
    } finally {
      db.close();
    }
  });

  test("既に watcher が起動していると、再呼び出しは旧 watcher を stop してから新規起動する", async () => {
    const db = initDB(testDir);
    try {
      const stops: number[] = [];
      let counter = 0;
      const fakeFactory: MailboxWatcherFactory = async (_target, _onChange) => {
        const id = ++counter;
        return {
          stop: () => {
            stops.push(id);
          },
        };
      };
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:111");
      state.conductors.set(conductor.surface, conductor);

      await spawnConductorMailboxWatcher(state, conductor);
      await spawnConductorMailboxWatcher(state, conductor);

      // 旧 (1) が stop されている
      expect(stops).toContain(1);
    } finally {
      db.close();
    }
  });

  test("watcher factory が throw しても daemon は落ちない（best-effort 観測）", async () => {
    const db = initDB(testDir);
    try {
      const fakeFactory: MailboxWatcherFactory = async () => {
        throw new Error("simulated factory failure");
      };
      __setMailboxWatcherImpl(fakeFactory);

      const state = buildMockDaemonState(db);
      const conductor = buildConductor("surface:121");
      state.conductors.set(conductor.surface, conductor);

      // throw されないことを確認
      await spawnConductorMailboxWatcher(state, conductor);
      expect(conductor.mailboxWatcherStop).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("traceDb=null でも fail-soft（events.jsonl だけ走る）", async () => {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    let captured: ((c: MailboxChange[]) => void | Promise<void>) | undefined;
    const fakeFactory: MailboxWatcherFactory = async (_target, onChange) => {
      captured = onChange;
      return { stop: () => {} };
    };
    __setMailboxWatcherImpl(fakeFactory);

    const state = {
      running: true,
      conductors: new Map<string, ConductorState>(),
      projectRoot: testDir,
      workspace: null,
      traceDb: null,
    } as unknown as DaemonState;
    const conductor = buildConductor("surface:131");
    state.conductors.set(conductor.surface, conductor);

    await spawnConductorMailboxWatcher(state, conductor);
    if (!captured) throw new Error("onChange handler was not captured");
    // throw されないこと
    await captured([{ kind: "added", key: "mailbox.status", value: "running" }]);

    const eventsPath = join(testDir, ".team/logs/events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    expect(content.includes("mailbox_changed")).toBe(true);
  });
});
