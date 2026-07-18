/**
 * T033: dashboard-files.ts のユニットテスト。
 *
 * resolver（resolveFilePath）の path traversal / symlink 境界と、
 * index HTML / md wrapper 生成のエスケープを検証する。
 * fs 依存は実 tmp dir で検証する（plan §8 / §9-2）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink, utimes } from "fs/promises";
import { realpathSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveFilePath,
  contentTypeFor,
  handleFilesRequest,
  formatLocalMtime,
  extractMdTitle,
} from "./dashboard-files";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'",
} as const;

function filesRequest(pathAndQuery: string): Response {
  return handleFilesRequest(root, new URL(`http://127.0.0.1${pathAndQuery}`), {
    ...BASE_HEADERS,
  });
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cmux-team-dashboard-files-"));
  // rootKey 3 種 + traversal 標的の seed
  await mkdir(join(root, "docs/sub"), { recursive: true });
  await writeFile(join(root, "docs/sub/file.md"), "# hello\n");
  await mkdir(join(root, "docs/b"), { recursive: true });
  await writeFile(join(root, "docs/b/real.md"), "# real\n");
  await mkdir(join(root, ".team/artifacts"), { recursive: true });
  await writeFile(join(root, ".team/artifacts/A001-t.md"), "# artifact\n");
  await mkdir(join(root, ".team/output/task-001-100"), { recursive: true });
  await writeFile(join(root, ".team/output/task-001-100/report.html"), "<p>r</p>");
  await mkdir(join(root, ".team/traces"), { recursive: true });
  await writeFile(join(root, ".team/traces/secret.txt"), "TOP_SECRET");
  await writeFile(join(root, "secret"), "ROOT_SECRET");
  // U10: root 内 symlink（docs/a → docs/b/real.md）
  await symlink(join(root, "docs/b/real.md"), join(root, "docs/a"));
  // U9: root 外への symlink
  await symlink("/etc/hosts", join(root, "docs/escape-link"));
  // U9b: dangling symlink
  await symlink(join(root, "docs/nonexistent"), join(root, "docs/dangling-link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dashboard-files: resolveFilePath", () => {
  test("U1: /files/ は root_index（trailing slash 有無両方）", () => {
    expect(resolveFilePath(root, "/files/").kind).toBe("root_index");
    expect(resolveFilePath(root, "/files").kind).toBe("root_index");
  });

  test("U2: 実在ファイルは file + 正しい absPath", () => {
    const r = resolveFilePath(root, "/files/docs/sub/file.md");
    expect(r.kind).toBe("file");
    if (r.kind !== "file") return;
    expect(r.absPath).toBe(realpathSync(join(root, "docs/sub/file.md")));
    expect(r.rootKey).toBe("docs");
    expect(r.relPath).toBe("sub/file.md");
  });

  test("U3: 実在 dir は trailing slash 有無どちらも dir", () => {
    const withSlash = resolveFilePath(root, "/files/docs/sub/");
    const noSlash = resolveFilePath(root, "/files/docs/sub");
    expect(withSlash.kind).toBe("dir");
    expect(noSlash.kind).toBe("dir");
    if (withSlash.kind !== "dir") return;
    expect(withSlash.absPath).toBe(realpathSync(join(root, "docs/sub")));
    expect(withSlash.relPath).toBe("sub");
  });

  test("U3b: rootKey 自体（/files/docs/）は dir + relPath 空", () => {
    const r = resolveFilePath(root, "/files/docs/");
    expect(r.kind).toBe("dir");
    if (r.kind !== "dir") return;
    expect(r.relPath).toBe("");
  });

  test("U4: allowlist 外 rootKey は not_found", () => {
    expect(resolveFilePath(root, "/files/traces/secret.txt").kind).toBe("not_found");
    expect(resolveFilePath(root, "/files/.team/artifacts/A001-t.md").kind).toBe(
      "not_found",
    );
  });

  test("U5: raw `..` segment は not_found", () => {
    expect(resolveFilePath(root, "/files/docs/../secret").kind).toBe("not_found");
    expect(resolveFilePath(root, "/files/docs/../.team/traces/secret.txt").kind).toBe(
      "not_found",
    );
  });

  test("U6: encoded dot segment（%2e%2e）は not_found", () => {
    expect(resolveFilePath(root, "/files/docs/%2e%2e/secret").kind).toBe("not_found");
  });

  test("U6b: decode 後 segment に `/` `\\` を含むものは bad_request", () => {
    expect(resolveFilePath(root, "/files/docs/%2e%2e%2fsecret").kind).toBe("bad_request");
    expect(resolveFilePath(root, "/files/docs/a%2f..%2fb").kind).toBe("bad_request");
    expect(resolveFilePath(root, "/files/docs/%2e%2e%5csecret").kind).toBe("bad_request");
  });

  test("U7: decode 失敗（%zz）は bad_request", () => {
    expect(resolveFilePath(root, "/files/docs/%zz").kind).toBe("bad_request");
  });

  test("U8: NUL byte（%00）は bad_request", () => {
    expect(resolveFilePath(root, "/files/docs/a%00b").kind).toBe("bad_request");
  });

  test("U9: root 外への symlink は not_found", () => {
    expect(resolveFilePath(root, "/files/docs/escape-link").kind).toBe("not_found");
  });

  test("U9b: dangling symlink は not_found", () => {
    expect(resolveFilePath(root, "/files/docs/dangling-link").kind).toBe("not_found");
  });

  test("U10: root 内 symlink は file（許可）", () => {
    const r = resolveFilePath(root, "/files/docs/a");
    expect(r.kind).toBe("file");
    if (r.kind !== "file") return;
    expect(r.absPath).toBe(realpathSync(join(root, "docs/b/real.md")));
  });

  test("U11: macOS tmpdir（root 自体が symlink 配下）でも正当ファイルは file", () => {
    // mkdtemp(tmpdir()) は macOS で /var → /private/var の symlink 配下になる。
    // root 側も realpath して比較していないとここで not_found になる。
    const r = resolveFilePath(root, "/files/artifacts/A001-t.md");
    expect(r.kind).toBe("file");
  });

  test("U12: 不存在パスは not_found", () => {
    expect(resolveFilePath(root, "/files/docs/nope.md").kind).toBe("not_found");
    expect(resolveFilePath(root, "/files/docs/sub/nope/deep.md").kind).toBe("not_found");
  });

  test("rootKey の実 dir が存在しない project では not_found", () => {
    // realpathSync(rootAbsDir) の throw を catch で not_found に閉じる経路
    expect(resolveFilePath(join(root, "no-such-project"), "/files/docs/x.md").kind).toBe(
      "not_found",
    );
  });
});

describe("dashboard-files: contentTypeFor", () => {
  test("拡張子マップどおりの Content-Type を返す（lowercase 比較）", () => {
    expect(contentTypeFor("report.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("report.HTM")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("img.png")).toBe("image/png");
    expect(contentTypeFor("img.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("chart.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("data.json")).toBe("application/json");
    expect(contentTypeFor("data.csv")).toBe("text/csv; charset=utf-8");
    expect(contentTypeFor("events.jsonl")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("main.ts")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("notes.md")).toBe("text/plain; charset=utf-8");
  });

  test("未知の拡張子・拡張子なしは application/octet-stream", () => {
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("Makefile")).toBe("application/octet-stream");
  });
});

describe("dashboard-files: handleFilesRequest（index / wrapper 生成）", () => {
  beforeAll(async () => {
    // index escape 検証用の細工ファイル名 + 空 dir + prefix filter 用エントリ
    await mkdir(join(root, "docs/weird"), { recursive: true });
    await writeFile(join(root, "docs/weird/a&<b> #1.md"), "# weird\n");
    await mkdir(join(root, "docs/emptydir"), { recursive: true });
    await mkdir(join(root, ".team/output/task-002-200"), { recursive: true });
    await writeFile(
      join(root, "docs/sub/script.md"),
      "before\n</script><script>alert(1)</script>\nafter\n",
    );
  });

  test("root index は 3 rootKey へのリンクを含む", async () => {
    const res = filesRequest("/files/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain('href="/files/docs/"');
    expect(body).toContain('href="/files/artifacts/"');
    expect(body).toContain('href="/files/output/"');
  });

  test("dir index はエントリ名を HTML escape し href は segment 単位で encode する", async () => {
    const res = filesRequest("/files/docs/weird/");
    expect(res.status).toBe(200);
    const body = await res.text();
    // 表示テキストは escape される
    expect(body).toContain("a&amp;&lt;b&gt; #1.md");
    expect(body).not.toContain("<b> #1.md");
    // href は encodeURIComponent（# が fragment 化しない）
    expect(body).toContain(`href="/files/docs/weird/${encodeURIComponent("a&<b> #1.md")}"`);
  });

  test("dir index は subdir に trailing slash 付きリンク + breadcrumb を持つ", async () => {
    const res = filesRequest("/files/docs/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/files/docs/sub/"');
    // breadcrumb: 上位階層へのリンク
    expect(body).toContain('href="/files/"');
  });

  test("空 dir は 200 + empty 表示", async () => {
    const res = filesRequest("/files/docs/emptydir/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("empty");
  });

  test("?prefix= は前方一致 filter", async () => {
    const res = filesRequest("/files/output/?prefix=task-001-");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("task-001-100");
    expect(body).not.toContain("task-002-200");
  });

  test("md wrapper は marked inline + JSON 埋め込み + raw リンク + breadcrumb を含む", async () => {
    const res = filesRequest("/files/docs/sub/file.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("marked.parse");
    expect(body).toContain('<script type="application/json" id="md-src">');
    expect(body).toContain(JSON.stringify("# hello\n"));
    expect(body).toContain('href="?raw=1"');
    expect(body).toContain('href="/files/docs/sub/"');
  });

  test("md wrapper は JSON 埋め込みの < を \\u003c に置換する（</script> 脱出防止）", async () => {
    const res = filesRequest("/files/docs/sub/script.md");
    expect(res.status).toBe(200);
    const body = await res.text();
    // 埋め込み JSON 内に生の </script> が現れない
    expect(body).toContain("\\u003c/script>");
    const jsonPart = body.slice(body.indexOf('id="md-src">'));
    expect(jsonPart.slice(0, jsonPart.indexOf("</script>"))).not.toContain("<script>");
  });

  test("?raw=1 は生 Markdown を text/plain で返す", async () => {
    const res = filesRequest("/files/docs/sub/file.md?raw=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/plain");
    expect(await res.text()).toBe("# hello\n");
  });

  test("html は無加工で text/html serve", async () => {
    const res = filesRequest("/files/output/task-001-100/report.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(await res.text()).toBe("<p>r</p>");
  });

  test("bad_request は 400 / not_found は 404 の JSON error", async () => {
    const bad = filesRequest("/files/docs/%zz");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("bad_request");
    const nf = filesRequest("/files/docs/nope.md");
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).error).toBe("not_found");
  });
});

describe("dashboard-files: 2 ペイン shell + JSON / ローカルタイム (T038)", () => {
  test("N5: formatLocalMtime は YYYY-MM-DD HH:mm（Z 無し）、null は -", () => {
    // 固定 ms（絶対値は TZ 依存なのでパターンと非 ISO のみ検証）
    const s = formatLocalMtime(Date.parse("2026-06-15T03:04:05.000Z"));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(s).not.toContain("Z");
    expect(s).not.toContain("T");
    expect(formatLocalMtime(null)).toBe("-");
  });

  test("N1: /files/?format=json は 3 rootKey の JSON entries を返す", async () => {
    const res = filesRequest("/files/?format=json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("application/json");
    const data = (await res.json()) as any;
    const names = data.entries.map((e: any) => e.name).sort();
    expect(names).toEqual(["artifacts", "docs", "output"]);
    expect(data.entries.every((e: any) => e.isDir === true)).toBe(true);
  });

  test("N2: dir ?format=json は entries に name/isDir/size/mtimeLocal（mtimeMs 無し）", async () => {
    const res = filesRequest("/files/docs/?format=json");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const sub = data.entries.find((e: any) => e.name === "sub");
    expect(sub).toBeDefined();
    expect(sub.isDir).toBe(true);
    expect("size" in sub).toBe(true);
    expect("mtimeLocal" in sub).toBe(true);
    expect("mtimeMs" in sub).toBe(false);
    expect(data.rootKey).toBe("docs");
  });

  test("N3: dir ?format=json + ?prefix= で前方一致 filter", async () => {
    const res = filesRequest("/files/output/?format=json&prefix=task-001-");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const names = data.entries.map((e: any) => e.name);
    expect(names).toContain("task-001-100");
    expect(names).not.toContain("task-002-200");
  });

  test("N4: JSON entries の mtimeLocal は ISO/Z でなくローカルタイム形式", async () => {
    // mtime を持つファイルエントリで検証
    const res = filesRequest("/files/docs/sub/?format=json");
    const data = (await res.json()) as any;
    const file = data.entries.find((e: any) => e.name === "file.md");
    expect(file).toBeDefined();
    expect(file.mtimeLocal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(file.mtimeLocal).not.toMatch(/Z$/);
    expect(file.mtimeLocal).not.toMatch(/T\d/);
  });

  test("N6: GET /files（format 無し）は 2 ペイン shell（#tree + iframe#view）", async () => {
    const res = filesRequest("/files/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain('id="tree"');
    expect(body).toContain('<iframe id="view"');
  });

  test("N7: shell は外部 src を参照しない（inline のみ）", async () => {
    const body = await filesRequest("/files/").text();
    expect(body).not.toContain("http://");
    expect(body).not.toContain("https://");
  });

  test("N8: shell の noscript に 3 rootKey 直リンクが含まれる", async () => {
    const body = await filesRequest("/files/").text();
    expect(body).toContain("<noscript>");
    expect(body).toContain('href="/files/docs/"');
    expect(body).toContain('href="/files/artifacts/"');
    expect(body).toContain('href="/files/output/"');
  });

  test("N9: format=json でも baseHeaders（no-store / CSP）が付与される", async () => {
    const res = filesRequest("/files/docs/?format=json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy") ?? "").toContain(
      "default-src 'self'",
    );
  });

  test("N10: file に ?format=json を付けても従来配信（md wrapper）", async () => {
    const res = filesRequest("/files/docs/sub/file.md?format=json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("marked.parse");
  });

  test("N11: shell / wrapper の inline style はダーク背景でライト本文色を含まない", async () => {
    const shell = await filesRequest("/files/").text();
    expect(shell).toContain("#0e1116");
    expect(shell).not.toContain("#24292f");
    const wrapper = await filesRequest("/files/docs/sub/file.md").text();
    expect(wrapper).toContain("#0e1116");
    expect(wrapper).not.toContain("#24292f");
  });

  test("N12: コンテンツ iframe(#view) はブラウザ既定の白地（白前提 raw HTML の判読性確保）", async () => {
    const shell = await filesRequest("/files/").text();
    // #view 要素にダーク var(--bg) を塗らない。任意 raw HTML を白い紙の上に映す
    expect(shell).toMatch(/#view\{[^}]*background:#fff/);
    expect(shell).not.toMatch(/#view\{[^}]*background:var\(--bg\)/);
    // ビューワー生成ページ（dir index / md wrapper）は html ごとダークを塗り、白縁を出さない
    const dirIndex = await filesRequest("/files/docs/").text();
    expect(dirIndex).toContain("html{background:#0e1116}");
    const wrapper = await filesRequest("/files/docs/sub/file.md").text();
    expect(wrapper).toContain("html{background:#0e1116}");
  });

  test("N13: 左ペインヘッダに sort アイコン + type フィルターチップを持つ", async () => {
    const shell = await filesRequest("/files/").text();
    expect(shell).toContain('id="treehdr"');
    expect(shell).toContain('id="treebody"'); // ツリー本体は分離したスクロール領域
    // sort: name / mtime / size
    expect(shell).toContain('data-key="name"');
    expect(shell).toContain('data-key="mtime"');
    expect(shell).toContain('data-key="size"');
    // filter: md / html / image
    expect(shell).toContain('data-type="md"');
    expect(shell).toContain('data-type="html"');
    expect(shell).toContain('data-type="image"');
    // フィルター CSS（OFF 時に該当 file ノードを隠す）
    expect(shell).toContain('#tree.hide-md .node[data-type="md"]');
  });

  test("N14: shell の inline JS は構文的に妥当 + 既定ソートは mtime 降順", async () => {
    const shell = await filesRequest("/files/").text();
    // 既定ソートキー / 方向
    expect(shell).toContain('sortKey="mtime",sortDir="desc"');
    // <script>…</script> を取り出して構文チェック（document 等は実行しないので未定義でも可）
    const m = shell.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    // new Function は本体を実行せず構文だけ検証する（throw すれば SyntaxError）
    expect(() => new Function(m![1])).not.toThrow();
  });

  test("N15: /files/_focus は files-focus.json を返す（無ければ {}）", async () => {
    const res0 = filesRequest("/files/_focus");
    expect(res0.status).toBe(200);
    expect(await res0.json()).toEqual({}); // 未作成時
    const fp = join(root, ".team/files-focus.json");
    writeFileSync(
      fp,
      JSON.stringify({ rootKey: "docs", relPath: "sub/file.md", ts: 123 }),
    );
    try {
      const res = filesRequest("/files/_focus");
      expect(res.headers.get("Content-Type") ?? "").toContain("application/json");
      expect(await res.json()).toEqual({
        rootKey: "docs",
        relPath: "sub/file.md",
        ts: 123,
      });
    } finally {
      rmSync(fp);
    }
  });

  test("N16: shell に追従モードのポーリング（/files/_focus）と expandTo がある", async () => {
    const shell = await filesRequest("/files/").text();
    expect(shell).toContain('fetch("/files/_focus")');
    expect(shell).toContain("setInterval(pollFocus,1000)");
    expect(shell).toContain("function expandTo(");
  });
});

describe("dashboard-files: 時系列モード + スプリッター (flat list)", () => {
  let flatRoot: string;

  beforeAll(async () => {
    flatRoot = await mkdtemp(join(tmpdir(), "cmux-team-dashboard-flat-"));
    await mkdir(join(flatRoot, "docs/sub"), { recursive: true });
    await mkdir(join(flatRoot, ".team/artifacts"), { recursive: true });
    await mkdir(join(flatRoot, ".team/output"), { recursive: true });
    // frontmatter title 持ち（引用符付き）
    await writeFile(
      join(flatRoot, ".team/artifacts/A001-research.md"),
      `---\nid: A001\ntitle: "調査: flat list の設計"\n---\n\n# 別見出し\n`,
    );
    // 見出しのみ
    await writeFile(join(flatRoot, "docs/sub/guide.md"), "# ガイド見出し\n\n本文\n");
    // タイトルなし md
    await writeFile(join(flatRoot, "docs/plain.md"), "本文のみ\n");
    // md 以外
    await writeFile(join(flatRoot, ".team/output/report.html"), "<p>r</p>");
    // root 外 symlink（flat walk は file / dir とも辿らない）
    await writeFile(join(flatRoot, "outside.md"), "# outside\n");
    await mkdir(join(flatRoot, "outside-dir"), { recursive: true });
    await writeFile(join(flatRoot, "outside-dir/in.md"), "# in\n");
    await symlink(join(flatRoot, "outside.md"), join(flatRoot, "docs/escape.md"));
    await symlink(join(flatRoot, "outside-dir"), join(flatRoot, "docs/escape-dir"));
    // mtime を固定して順序を決定論化（新しい順: A001 → guide → plain → report）
    await utimes(join(flatRoot, ".team/artifacts/A001-research.md"), new Date(4000000), new Date(4000000));
    await utimes(join(flatRoot, "docs/sub/guide.md"), new Date(3000000), new Date(3000000));
    await utimes(join(flatRoot, "docs/plain.md"), new Date(2000000), new Date(2000000));
    await utimes(join(flatRoot, ".team/output/report.html"), new Date(1000000), new Date(1000000));
  });

  afterAll(async () => {
    await rm(flatRoot, { recursive: true, force: true });
  });

  function flatRequest(pathAndQuery: string): Response {
    return handleFilesRequest(flatRoot, new URL(`http://127.0.0.1${pathAndQuery}`), {
      ...BASE_HEADERS,
    });
  }

  test("F1: extractMdTitle は frontmatter title > 先頭見出し > null の優先順位", () => {
    expect(extractMdTitle(join(flatRoot, ".team/artifacts/A001-research.md"))).toBe(
      "調査: flat list の設計",
    );
    expect(extractMdTitle(join(flatRoot, "docs/sub/guide.md"))).toBe("ガイド見出し");
    expect(extractMdTitle(join(flatRoot, "docs/plain.md"))).toBeNull();
    expect(extractMdTitle(join(flatRoot, "no-such.md"))).toBeNull();
  });

  test("F2: /files/_flat は mtime 降順 + title（fallback はファイル名）", async () => {
    const res = flatRequest("/files/_flat");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    const names = data.entries.map((e) => e.name);
    expect(names).toEqual(["A001-research.md", "guide.md", "plain.md", "report.html"]);
    const titles = data.entries.map((e) => e.title);
    expect(titles).toEqual([
      "調査: flat list の設計",
      "ガイド見出し",
      "plain.md", // タイトルなし md はファイル名
      "report.html", // md 以外はファイル名
    ]);
    expect(data.truncated).toBe(false);
  });

  test("F3: /files/_flat の entries は rootKey/relPath を持ち mtimeMs を出さない", async () => {
    const data = (await flatRequest("/files/_flat").json()) as {
      entries: Array<Record<string, unknown>>;
    };
    const top = data.entries[0]!;
    expect(top.rootKey).toBe("artifacts");
    expect(top.relPath).toBe("A001-research.md");
    expect(top).not.toHaveProperty("mtimeMs");
    expect(String(top.mtimeLocal)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const guide = data.entries.find((e) => e.name === "guide.md")!;
    expect(guide.rootKey).toBe("docs");
    expect(guide.relPath).toBe("sub/guide.md");
  });

  test("F4: flat walk は symlink を辿らない（escape.md が現れない）", async () => {
    const data = (await flatRequest("/files/_flat").json()) as {
      entries: Array<{ name: string }>;
    };
    expect(data.entries.map((e) => e.name)).not.toContain("escape.md");
    expect(data.entries.map((e) => e.name)).not.toContain("outside.md");
    expect(data.entries.map((e) => e.name)).not.toContain("in.md"); // symlink dir 配下
  });

  test("F5: /files/_flat にも baseHeaders（no-store / CSP）が付与される", async () => {
    const res = flatRequest("/files/_flat");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  test("F6: shell に view モードチップ + #flatbody + mode-time CSS がある", async () => {
    const shell = await flatRequest("/files/").text();
    expect(shell).toContain('id="modegrp"');
    expect(shell).toContain('data-mode="tree"');
    expect(shell).toContain('data-mode="time"');
    expect(shell).toContain('<div id="flatbody">');
    expect(shell).toContain("#tree.mode-time #treebody{display:none}");
    expect(shell).toContain("#tree.mode-time #sortgrp{display:none}");
    expect(shell).toContain('fetch("/files/_flat")');
    expect(shell).toContain('localStorage.setItem("filesMode"');
  });

  test("F7: shell にスプリッター（#splitter + pointer drag + 幅永続化）がある", async () => {
    const shell = await flatRequest("/files/").text();
    expect(shell).toContain('<div id="splitter"');
    expect(shell).toContain('addEventListener("pointerdown"');
    expect(shell).toContain('localStorage.setItem("filesPaneW"');
    expect(shell).toContain("cursor:col-resize");
  });

  test("F8: 追従モードは time モードで selectFlat 経由（無ければ再取得）", async () => {
    const shell = await flatRequest("/files/").text();
    expect(shell).toContain("function selectFlat(");
    expect(shell).toContain('if(mode==="time")');
  });
});
