/**
 * files-open.ts（`elevens open` 追従モードのヘルパー）のユニットテスト。
 * rootKey 解決の許可境界 / focus atomic write / dashboard URL 読取を実 tmp dir で検証する。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveFocusTarget,
  writeFilesFocus,
  readDashboardUrl,
  readDashboardLanUrl,
  filesViewerUrl,
} from "./files-open";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cmux-team-files-open-"));
  await mkdir(join(root, "docs/sub"), { recursive: true });
  await writeFile(join(root, "docs/sub/file.md"), "# hello\n");
  await mkdir(join(root, ".team/artifacts"), { recursive: true });
  await writeFile(join(root, ".team/artifacts/A001-t.md"), "# a\n");
  await mkdir(join(root, ".team/output/task-001-100"), { recursive: true });
  await writeFile(join(root, ".team/output/task-001-100/report.html"), "<p>r</p>");
  await writeFile(join(root, "outside.md"), "# outside\n"); // root 直下（許可 root 外）
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("files-open: resolveFocusTarget", () => {
  test("docs 配下 → rootKey=docs + relPath", () => {
    const r = resolveFocusTarget(root, root, "docs/sub/file.md");
    expect(r).toEqual({ rootKey: "docs", relPath: "sub/file.md" });
  });

  test(".team/artifacts 配下 → rootKey=artifacts", () => {
    const r = resolveFocusTarget(root, root, ".team/artifacts/A001-t.md");
    expect(r).toEqual({ rootKey: "artifacts", relPath: "A001-t.md" });
  });

  test(".team/output 配下 → rootKey=output（ネスト relPath）", () => {
    const r = resolveFocusTarget(root, root, ".team/output/task-001-100/report.html");
    expect(r).toEqual({ rootKey: "output", relPath: "task-001-100/report.html" });
  });

  test("cwd 相対でも解決できる（cwd=doc/サブ）", () => {
    const r = resolveFocusTarget(root, join(root, "docs"), "sub/file.md");
    expect(r).toEqual({ rootKey: "docs", relPath: "sub/file.md" });
  });

  test("許可 root 外のファイルは error", () => {
    const r = resolveFocusTarget(root, root, "outside.md");
    expect("error" in r).toBe(true);
  });

  test("不存在ファイルは error", () => {
    const r = resolveFocusTarget(root, root, "docs/nope.md");
    expect("error" in r).toBe(true);
  });
});

describe("files-open: writeFilesFocus / readDashboardUrl / filesViewerUrl", () => {
  test("writeFilesFocus は .team/files-focus.json に {rootKey,relPath,ts} を書く", () => {
    const dest = writeFilesFocus(root, { rootKey: "docs", relPath: "sub/file.md" }, 42);
    expect(dest).toBe(join(root, ".team", "files-focus.json"));
    expect(existsSync(dest)).toBe(true);
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toEqual({
      rootKey: "docs",
      relPath: "sub/file.md",
      ts: 42,
    });
  });

  test("readDashboardUrl は team.json の dashboardServer.url を返す / 無ければ null", async () => {
    expect(readDashboardUrl(root)).toBeNull(); // team.json 未作成
    await writeFile(
      join(root, ".team/team.json"),
      JSON.stringify({ dashboardServer: { url: "http://127.0.0.1:8765", schemaVersion: 1 } }),
    );
    expect(readDashboardUrl(root)).toBe("http://127.0.0.1:8765");
  });

  test("filesViewerUrl は末尾 slash を正規化して /files を付ける", () => {
    expect(filesViewerUrl("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765/files");
    expect(filesViewerUrl("http://127.0.0.1:8765/")).toBe("http://127.0.0.1:8765/files");
  });

  test("readDashboardLanUrl は dashboardServer.lanUrl を返す / 無ければ null", async () => {
    // 直前テストで url のみの team.json が書かれている → lanUrl は無いので null
    expect(readDashboardLanUrl(root)).toBeNull();
    await writeFile(
      join(root, ".team/team.json"),
      JSON.stringify({
        dashboardServer: {
          url: "http://127.0.0.1:8765",
          lanUrl: "http://192.168.1.50:8765",
          schemaVersion: 1,
        },
      }),
    );
    expect(readDashboardLanUrl(root)).toBe("http://192.168.1.50:8765");
    // url は据え置きで読める
    expect(readDashboardUrl(root)).toBe("http://127.0.0.1:8765");
  });
});
