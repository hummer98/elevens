/**
 * Integration Queue（spec 17）の FSM / CRUD / 検証ユニットテスト。
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  integReduce,
  parseIntegItem,
  serializeIntegItem,
  validateIntegItem,
  loadIntegItems,
  readIntegItem,
  nextIntegId,
  enqueueIntegItem,
  updateIntegItem,
  isIntegTerminal,
  INTEG_STATES,
  type IntegItem,
  type IntegItemState,
} from "./integration-queue";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "integq-"));
  await mkdir(join(root, ".team"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTaskState(map: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, ".team/task-state.json"), JSON.stringify(map), "utf-8");
}

// --- FSM reducer ---

test("integReduce: 正常な full path queued→integrating→verifying→done", () => {
  let s: IntegItemState = "queued";
  let r = integReduce(s, { type: "CLAIM", batchId: "B001" });
  expect(r).toEqual({ ok: true, next: "integrating" });
  s = "integrating";
  r = integReduce(s, { type: "DEPLOYED" });
  expect(r).toEqual({ ok: true, next: "verifying" });
  s = "verifying";
  r = integReduce(s, { type: "VERIFY_PASS", resultArtifact: "A045" });
  expect(r).toEqual({ ok: true, next: "done" });
});

test("integReduce: verifying→failed", () => {
  expect(
    integReduce("verifying", { type: "VERIFY_FAIL", resultArtifact: "A045", followupTaskId: "150" }),
  ).toEqual({ ok: true, next: "failed" });
});

test("integReduce: REQUEUE は integrating / verifying からのみ", () => {
  expect(integReduce("integrating", { type: "REQUEUE" })).toEqual({ ok: true, next: "queued" });
  expect(integReduce("verifying", { type: "REQUEUE" })).toEqual({ ok: true, next: "queued" });
  expect(integReduce("queued", { type: "REQUEUE" }).ok).toBe(false);
});

test("integReduce: 不正遷移は ok=false", () => {
  expect(integReduce("queued", { type: "DEPLOYED" }).ok).toBe(false);
  expect(integReduce("done", { type: "CLAIM", batchId: "B1" }).ok).toBe(false);
  expect(integReduce("failed", { type: "DEPLOYED" }).ok).toBe(false);
  expect(integReduce("integrating", { type: "VERIFY_PASS", resultArtifact: "A1" }).ok).toBe(false);
});

test("isIntegTerminal", () => {
  expect(isIntegTerminal("done")).toBe(true);
  expect(isIntegTerminal("failed")).toBe(true);
  expect(isIntegTerminal("queued")).toBe(false);
  expect(INTEG_STATES.length).toBe(5);
});

// --- シリアライズ round-trip ---

test("serialize/parse round-trip（snake_case on-disk）", () => {
  const item: IntegItem = {
    id: "Q001",
    taskId: "142",
    branch: "task-142-foo",
    pr: "17",
    state: "queued",
    batchId: null,
    retry: 0,
    enqueuedAt: "2026-06-07T09:00:00.000Z",
    updatedAt: "2026-06-07T09:00:00.000Z",
    resultArtifact: null,
    followupTaskId: null,
    journal: null,
    filePath: "/x/Q001.json",
    fileName: "Q001.json",
  };
  const json = serializeIntegItem(item);
  // on-disk は snake_case
  expect(json).toContain('"task_id": "142"');
  expect(json).toContain('"batch_id": null');
  expect(json).toContain('"enqueued_at"');
  const parsed = parseIntegItem(json, "Q001.json", "/x/Q001.json");
  expect(parsed?.taskId).toBe("142");
  expect(parsed?.branch).toBe("task-142-foo");
  expect(parsed?.state).toBe("queued");
});

test("parseIntegItem: 壊れた JSON / 必須欠落は null", () => {
  expect(parseIntegItem("{not json", "Q001.json", "/x")).toBeNull();
  expect(parseIntegItem(JSON.stringify({ id: "Q001" }), "Q001.json", "/x")).toBeNull();
});

test("parseIntegItem: pr が number でも string 化", () => {
  const raw = JSON.stringify({
    id: "Q001", task_id: "1", branch: "b", state: "queued",
    enqueued_at: "t", updated_at: "t", pr: 17,
  });
  expect(parseIntegItem(raw, "Q001.json", "/x")?.pr).toBe("17");
});

// --- validation ---

test("validateIntegItem", () => {
  const base: IntegItem = {
    id: "Q001", taskId: "142", branch: "b", pr: null, state: "queued",
    batchId: null, retry: 0, enqueuedAt: "t", updatedAt: "t",
    resultArtifact: null, followupTaskId: null, journal: null,
    filePath: "", fileName: "",
  };
  expect(validateIntegItem(base)).toEqual([]);
  expect(validateIntegItem({ ...base, id: "X1" }).length).toBeGreaterThan(0);
  expect(validateIntegItem({ ...base, taskId: "12345" }).length).toBeGreaterThan(0);
  expect(validateIntegItem({ ...base, state: "bogus" as IntegItemState }).length).toBeGreaterThan(0);
  expect(validateIntegItem({ ...base, retry: -1 }).length).toBeGreaterThan(0);
});

// --- enqueue ---

test("enqueue: closed && deliverable=pr を要求", async () => {
  await writeTaskState({
    "142": { status: "closed", deliverable: { kind: "pr", prUrl: "https://x/pr/17" }, taskRunId: "task-142-abc" },
  });
  const { id } = await enqueueIntegItem({ projectRoot: root, taskId: "142" });
  expect(id).toBe("Q001");
  const item = await readIntegItem(root, "Q001");
  expect(item?.state).toBe("queued");
  expect(item?.branch).toBe("task-142-abc");
  expect(item?.pr).toBe("https://x/pr/17");
});

test("enqueue: closed でない Task は reject", async () => {
  await writeTaskState({ "142": { status: "assigned" } });
  await expect(enqueueIntegItem({ projectRoot: root, taskId: "142" })).rejects.toThrow(/closed/);
});

test("enqueue: deliverable!=pr は reject", async () => {
  await writeTaskState({ "142": { status: "closed", deliverable: { kind: "merged", branch: "b", sha: "x" } } });
  await expect(enqueueIntegItem({ projectRoot: root, taskId: "142" })).rejects.toThrow(/deliverable/);
});

test("enqueue: 不正 taskId は reject", async () => {
  await expect(enqueueIntegItem({ projectRoot: root, taskId: "abc" })).rejects.toThrow(/task_id/);
});

test("enqueue: --force で検証 skip（branch 明示）", async () => {
  const { id } = await enqueueIntegItem({ projectRoot: root, taskId: "9", branch: "wip", force: true });
  expect(id).toBe("Q001");
  expect((await readIntegItem(root, "Q001"))?.branch).toBe("wip");
});

test("nextIntegId: 連番採番", async () => {
  expect(await nextIntegId(root)).toBe("Q001");
  await enqueueIntegItem({ projectRoot: root, taskId: "1", branch: "a", force: true });
  expect(await nextIntegId(root)).toBe("Q002");
  await enqueueIntegItem({ projectRoot: root, taskId: "2", branch: "b", force: true });
  expect(await nextIntegId(root)).toBe("Q003");
});

// --- update (CLI 起点遷移) ---

async function seedQueued(taskId = "1", branch = "b"): Promise<string> {
  const { id } = await enqueueIntegItem({ projectRoot: root, taskId, branch, force: true });
  return id;
}

test("update: full happy path で done まで", async () => {
  const id = await seedQueued();
  expect((await updateIntegItem(root, id, "integrating", { batchId: "B001" })).next).toBe("integrating");
  expect((await readIntegItem(root, id))?.batchId).toBe("B001");
  expect((await updateIntegItem(root, id, "verifying")).next).toBe("verifying");
  expect((await updateIntegItem(root, id, "done", { resultArtifact: "A045" })).next).toBe("done");
  const item = await readIntegItem(root, id);
  expect(item?.resultArtifact).toBe("A045");
});

test("update: failed は artifact + followup 必須", async () => {
  const id = await seedQueued();
  await updateIntegItem(root, id, "integrating", { batchId: "B1" });
  await updateIntegItem(root, id, "verifying");
  await expect(updateIntegItem(root, id, "failed", { resultArtifact: "A1" })).rejects.toThrow(/followup/);
  const r = await updateIntegItem(root, id, "failed", { resultArtifact: "A1", followupTaskId: "150" });
  expect(r.next).toBe("failed");
  expect((await readIntegItem(root, id))?.followupTaskId).toBe("150");
});

test("update: integrating は --batch 必須", async () => {
  const id = await seedQueued();
  await expect(updateIntegItem(root, id, "integrating")).rejects.toThrow(/batch/);
});

test("update: 不正遷移は throw（queued から verifying）", async () => {
  const id = await seedQueued();
  await expect(updateIntegItem(root, id, "verifying")).rejects.toThrow(/illegal transition/);
});

test("update: requeue で retry+1 / batch クリア", async () => {
  const id = await seedQueued();
  await updateIntegItem(root, id, "integrating", { batchId: "B1" });
  await updateIntegItem(root, id, "queued", { retryInc: true, reason: "bisect 無実" });
  const item = await readIntegItem(root, id);
  expect(item?.state).toBe("queued");
  expect(item?.retry).toBe(1);
  expect(item?.batchId).toBeNull();
  expect(item?.journal).toContain("bisect 無実");
});

test("loadIntegItems: Qnnn.json 以外は無視", async () => {
  await mkdir(join(root, ".team/integration-queue"), { recursive: true });
  await writeFile(join(root, ".team/integration-queue/README.md"), "noise", "utf-8");
  await seedQueued("1", "a");
  const items = await loadIntegItems(root);
  expect(items.length).toBe(1);
  expect(items[0]?.id).toBe("Q001");
});
