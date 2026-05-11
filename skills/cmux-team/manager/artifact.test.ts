/**
 * T006 Phase 1: addArtifact が events.jsonl に artifact_added を emit することの検証。
 *
 * `parseArtifactMeta` / `validateArtifact` / `nextArtifactId` の sanity test も
 * 新規ファイル作成のついでに最小限同居させる（将来 regression に強くするため）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  addArtifact,
  parseArtifactMeta,
  validateArtifact,
  nextArtifactId,
} from "./artifact";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-artifact-test-",
    subdirs: ["logs", "artifacts"],
  });
});

afterEach(async () => {
  await project.dispose();
});

async function readEventsJsonl(): Promise<Record<string, unknown>[]> {
  const filePath = join(project.root, ".team/logs/events.jsonl");
  const content = await readFile(filePath, "utf-8").catch(() => "");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("addArtifact: events 連携", () => {
  test("T3: 成功すると events.jsonl に artifact_added が 1 行 append される", async () => {
    const srcPath = join(project.root, "memo.md");
    await writeFile(srcPath, "# memo body\n", "utf-8");

    const result = await addArtifact({
      projectRoot: project.root,
      srcPath,
      type: "research",
      title: "テスト",
    });

    expect(result.id).toBe("A001");

    const events = await readEventsJsonl();
    const artifactEvents = events.filter((e) => e.event === "artifact_added");
    expect(artifactEvents).toHaveLength(1);

    const rec = artifactEvents[0]!;
    expect(rec.artifact_id).toBe("A001");
    expect(typeof rec.artifact_path).toBe("string");
    expect(rec.artifact_path as string).toMatch(/^\.team\/artifacts\/A001-.*\.md$/);
    expect(rec.artifact_type).toBe("research");
    expect(rec.title).toBe("テスト");
  });

  test("T4: frontmatter に task が含まれていれば task_id が emit される", async () => {
    const srcPath = join(project.root, "input.md");
    const content = `---
id: ""
type: research
title: "task 紐付け"
created: 2026-05-12T00:00:00.000Z
author: surface:100
task: T038
---

本文
`;
    await writeFile(srcPath, content, "utf-8");

    await addArtifact({ projectRoot: project.root, srcPath });

    const events = await readEventsJsonl();
    const rec = events.find((e) => e.event === "artifact_added");
    expect(rec).toBeDefined();
    expect(rec!.task_id).toBe("T038");
  });

  test("T5: frontmatter に task が無ければ task_id は record から omit される", async () => {
    const srcPath = join(project.root, "no-task.md");
    await writeFile(srcPath, "# 本文だけ\n", "utf-8");

    await addArtifact({
      projectRoot: project.root,
      srcPath,
      type: "research",
      title: "task 無し",
    });

    const events = await readEventsJsonl();
    const rec = events.find((e) => e.event === "artifact_added");
    expect(rec).toBeDefined();
    expect("task_id" in rec!).toBe(false);
  });
});

describe("artifact pure helpers (sanity)", () => {
  test("parseArtifactMeta: 最小 frontmatter から id/type/title/created/author を抽出", () => {
    const content = `---
id: A001
type: research
title: "サンプル"
created: 2026-05-12T00:00:00.000Z
author: surface:100
---

本文
`;
    const meta = parseArtifactMeta(content, "A001-sample.md", "/tmp/A001-sample.md");
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("A001");
    expect(meta!.type).toBe("research");
    expect(meta!.title).toBe("サンプル");
    expect(meta!.author).toBe("surface:100");
    expect(meta!.task).toBeUndefined();
  });

  test("validateArtifact: 必須 field 欠損を検出", () => {
    const errors = validateArtifact({
      id: "",
      type: "",
      title: "",
      created: "",
      author: "",
      filePath: "",
      fileName: "",
      body: "",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test("nextArtifactId: 空ディレクトリでは A001 を返す", async () => {
    const id = await nextArtifactId(project.root);
    expect(id).toBe("A001");
  });
});
