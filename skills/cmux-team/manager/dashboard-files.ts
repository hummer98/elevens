/**
 * T033: dashboard ファイルビューワー（`/files`）
 *
 * docs / .team/artifacts / .team/output を localhost ブラウザで閲覧するための
 * path 解決 + セキュリティ境界チェック + Content-Type マップ + index HTML 生成 +
 * md wrapper HTML 生成。dashboard-server.ts は routing のみ担い、本モジュールの
 * `handleFilesRequest(projectRoot, url, headers)` に委譲する。
 *
 * セキュリティ設計（plan §3）:
 *  - 許可 rootKey は辞書引き（prefix 文字列比較をしない）
 *  - `..` 等の dot segment は正規化で解決させずに拒否する
 *  - decode 後 segment に `/` `\` が現れる入力は malformed として 400
 *  - realpath 境界チェックで root 外へ抜ける symlink を 404 に閉じる
 *    （root 側も realpath する — macOS の /var → /private/var 対策）
 */
import { lstatSync, realpathSync, statSync, readdirSync, readFileSync } from "fs";
import { join, sep, dirname } from "path";
import { fileURLToPath } from "url";

// ────────────────────────────────────────────────────────────────────────
// resolver
// ────────────────────────────────────────────────────────────────────────

/** rootKey → projectRoot 起点の実パス（allowlist そのもの） */
const ROOT_DIRS: Record<string, string> = {
  docs: "docs",
  artifacts: join(".team", "artifacts"),
  output: join(".team", "output"),
};

export type ResolveResult =
  | { kind: "root_index" }
  | { kind: "dir"; absPath: string; rootKey: string; relPath: string }
  | { kind: "file"; absPath: string; rootKey: string; relPath: string }
  | { kind: "bad_request" } // → 400
  | { kind: "not_found" }; // → 404

/**
 * `/files/...` の pathname を resolve する。throw しない（全拒否経路が
 * bad_request / not_found の return で閉じる）。
 */
export function resolveFilePath(projectRoot: string, pathname: string): ResolveResult {
  if (pathname !== "/files" && !pathname.startsWith("/files/")) {
    return { kind: "not_found" };
  }
  let rest = pathname.slice("/files".length);
  if (rest.startsWith("/")) rest = rest.slice(1);
  // trailing slash は dir 指定として同一視（/files/docs と /files/docs/ は同じ）
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "") return { kind: "root_index" };

  // 手順 1–2: segment ごとに decode し、解決させずに拒否する
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let dec: string;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      return { kind: "bad_request" };
    }
    // NUL・改行等の制御文字 → malformed
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(dec)) return { kind: "bad_request" };
    // decode で出現した区切り文字（%2f / %5c）→ malformed。
    // これにより後続の join に区切り文字入り segment は渡らない
    if (dec.includes("/") || dec.includes("\\")) return { kind: "bad_request" };
    // dot segment / 空 segment（連続スラッシュ）は存在しないものとして扱う
    if (dec === "" || dec === "." || dec === "..") return { kind: "not_found" };
    segments.push(dec);
  }

  // 手順 3: rootKey 辞書引き
  const rootKey = segments[0]!;
  const rootRel = ROOT_DIRS[rootKey];
  if (rootRel === undefined) return { kind: "not_found" };
  const rootAbsDir = join(projectRoot, rootRel);
  const restSegments = segments.slice(1);

  // 手順 4: join + 境界チェック（多層防御の backstop。手順 2 が正しければ到達しない）
  const abs = join(rootAbsDir, ...restSegments);
  if (abs !== rootAbsDir && !abs.startsWith(rootAbsDir + sep)) {
    return { kind: "not_found" };
  }

  // 手順 5: 存在チェック（symlink 自体の存在）
  try {
    lstatSync(abs);
  } catch {
    return { kind: "not_found" };
  }

  // 手順 6: realpath 境界チェック（root 側も realpath するのが要点）
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(rootAbsDir);
    real = realpathSync(abs);
  } catch {
    // dangling symlink / rootKey 実 dir 不存在
    return { kind: "not_found" };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { kind: "not_found" };
  }

  // 手順 7: file / dir 判定（symlink 解決後）
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return { kind: "not_found" };
  }
  const relPath = restSegments.join("/");
  if (st.isDirectory()) {
    return { kind: "dir", absPath: real, rootKey, relPath };
  }
  return { kind: "file", absPath: real, rootKey, relPath };
}

// ────────────────────────────────────────────────────────────────────────
// Content-Type マップ
// ────────────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".css": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

/** 拡張子（lowercase 比較）から配信 Content-Type を引く。未知は octet-stream */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// ────────────────────────────────────────────────────────────────────────
// HTML 生成（index / md wrapper）
// ────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * mtime（epoch ms）をサーバのローカルタイムで `YYYY-MM-DD HH:mm` に整形する。
 * `toISOString()`（UTC / Z 付き）を使わず、ローカルタイムの各成分をゼロ埋め連結する。
 * `ms == null`（stat 失敗等）は `-` を返す。
 */
export function formatLocalMtime(ms: number | null): string {
  if (ms === null) return "-";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}`
  );
}

/** path segments を segment 単位で encodeURIComponent して href を組み立てる */
function hrefFor(segments: string[], trailingSlash: boolean): string {
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `/files/${encoded}${trailingSlash && encoded !== "" ? "/" : ""}`;
}

/**
 * breadcrumb HTML。`/files/` から各階層へのリンクを生成し、最終 segment は
 * lastIsLink=false のときリンクなしテキストで表示する。
 */
function breadcrumbHtml(segments: string[], lastIsLink: boolean): string {
  const parts: string[] = [`<a href="/files/">files</a>`];
  for (let i = 0; i < segments.length; i++) {
    const label = escapeHtml(segments[i]!);
    const isLast = i === segments.length - 1;
    if (isLast && !lastIsLink) {
      parts.push(label);
    } else {
      parts.push(`<a href="${hrefFor(segments.slice(0, i + 1), true)}">${label}</a>`);
    }
  }
  return parts.join(" / ");
}

const INDEX_STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:24px;color:#d4d8df;background:#0e1116}
nav{margin-bottom:16px;font-size:14px}
table{border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:4px 16px 4px 0}
th{border-bottom:1px solid #2a313c;color:#8a93a0}
td.num{text-align:right}
a{text-decoration:none;color:#58a6ff}
a:hover{text-decoration:underline}
.empty{color:#8a93a0;font-style:italic}
`.trim();

function indexPageHtml(title: string, breadcrumb: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${INDEX_STYLE}</style></head><body><nav>${breadcrumb}</nav>${bodyHtml}</body></html>`;
}

// 2 ペイン shell のダークテーマ CSS（SPA dashboard-web/style.css の :root トーンに合わせる）
const SHELL_STYLE = `
:root{--bg:#0e1116;--panel:#161b22;--panel2:#1c232c;--border:#2a313c;--fg:#d4d8df;--fg-dim:#8a93a0;--accent:#58a6ff}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
#app{display:flex;height:100vh}
#tree{width:280px;min-width:280px;overflow:auto;background:var(--panel);border-right:1px solid var(--border);padding:8px 0}
#viewpane{flex:1;min-width:0}
#view{width:100%;height:100%;border:0;background:var(--bg)}
.node{font-size:13px}
.children{margin-left:14px;border-left:1px solid var(--border)}
.row{display:flex;align-items:center;gap:8px;padding:3px 10px;cursor:pointer;white-space:nowrap;color:var(--fg)}
.row:hover{background:var(--panel2)}
.row.selected{background:var(--panel2);color:var(--accent)}
.row.dir>.label{color:var(--fg)}
.row.dir.open>.label::before{content:"\\25be ";color:var(--fg-dim)}
.row.dir>.label::before{content:"\\25b8 ";color:var(--fg-dim)}
.row .meta{margin-left:auto;color:var(--fg-dim);font-size:11px;flex:none}
.ns{padding:24px}
.ns a{color:var(--accent)}
`.trim();

// ツリー lazy load のクライアント JS。外部 src を持たず inline で完結する。
// XSS 回避: ノードラベルは textContent 代入、href/fetch path は encodeURIComponent。
const SHELL_SCRIPT = `
(function(){
  var tree=document.getElementById("tree");
  var view=document.getElementById("view");
  var selected=null;
  function enc(segs){return segs.map(encodeURIComponent).join("/");}
  function dash(v){return (v===null||v===undefined||v==="")?"-":String(v);}
  function makeNode(entry,parentSegs){
    var segs=parentSegs.concat([entry.name]);
    var node=document.createElement("div");
    node.className="node";
    var row=document.createElement("div");
    row.className="row "+(entry.isDir?"dir":"file");
    var label=document.createElement("span");
    label.className="label";
    label.textContent=entry.isDir?entry.name+"/":entry.name;
    row.appendChild(label);
    if(!entry.isDir){
      var meta=document.createElement("span");
      meta.className="meta";
      meta.textContent=dash(entry.size)+"  "+dash(entry.mtimeLocal);
      row.appendChild(meta);
    }
    node.appendChild(row);
    var box=null,loaded=false;
    row.addEventListener("click",function(){
      if(entry.isDir){
        if(!box){box=document.createElement("div");box.className="children";node.appendChild(box);}
        if(!loaded){loaded=true;loadDir(box,segs);box.style.display="";row.classList.add("open");}
        else{var hidden=box.style.display==="none";box.style.display=hidden?"":"none";row.classList.toggle("open",hidden);}
      }else{
        if(selected)selected.classList.remove("selected");
        row.classList.add("selected");selected=row;
        view.src="/files/"+enc(segs);
      }
    });
    return node;
  }
  function loadInto(container,segs,url){
    fetch(url).then(function(r){return r.json();}).then(function(data){
      container.textContent="";
      var entries=(data&&data.entries)||[];
      for(var i=0;i<entries.length;i++)container.appendChild(makeNode(entries[i],segs));
    }).catch(function(){container.textContent="(error)";});
  }
  function loadDir(container,segs){loadInto(container,segs,"/files/"+enc(segs)+"/?format=json");}
  loadInto(tree,[],"/files/?format=json");
})();
`.trim();

/**
 * 2 ペイン shell HTML（root index の差し替え）。
 *  - 左 `#tree`: rootKey / dir をクリックで lazy 展開（`?format=json`）するツリー
 *  - 右 `#view`: 既存 `/files/<path>` 配信経路を再利用する iframe（sandbox なし）
 *  - inline ダークテーマ CSS（SPA `style.css` と同配色トーン）
 *  - `<noscript>`: JS 無効時の 3 rootKey 直リンク（既存 root index assert の後継）
 *
 * iframe に `sandbox` を付けない（plan M3）: md wrapper はインライン script で marked を
 * 実行するため。隔離は CSP（同一オリジン）+ resolveFilePath のパス境界に委ねる。
 */
function renderFilesShellHtml(): string {
  const noscriptLinks = Object.keys(ROOT_DIRS)
    .map((key) => `<li><a href="${hrefFor([key], true)}">${escapeHtml(key)}/</a></li>`)
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>files</title>` +
    `<style>${SHELL_STYLE}</style></head><body>` +
    `<div id="app">` +
    `<aside id="tree" aria-label="file tree"></aside>` +
    `<main id="viewpane"><iframe id="view" title="file view"></iframe></main>` +
    `</div>` +
    `<noscript><div class="ns"><p>JavaScript を有効にするとツリー表示が使えます。</p>` +
    `<ul>${noscriptLinks}</ul></div></noscript>` +
    `<script>${SHELL_SCRIPT}</script>` +
    `</body></html>`
  );
}

interface DirEntryRow {
  name: string;
  isDir: boolean;
  size: number | null;
  mtimeMs: number | null;
}

function listDirEntries(absDir: string, prefix: string | null): DirEntryRow[] {
  const rows: DirEntryRow[] = [];
  for (const name of readdirSync(absDir)) {
    if (prefix !== null && !name.startsWith(prefix)) continue;
    let isDir = false;
    let size: number | null = null;
    let mtimeMs: number | null = null;
    try {
      const st = statSync(join(absDir, name));
      isDir = st.isDirectory();
      size = isDir ? null : st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // dangling symlink 等。エントリ自体は表示する（リンク先は 404 になる）
    }
    rows.push({ name, isDir, size, mtimeMs });
  }
  rows.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return rows;
}

function renderDirIndexHtml(
  absDir: string,
  rootKey: string,
  relPath: string,
  prefix: string | null,
): string {
  const segments = [rootKey, ...relPath.split("/").filter((s) => s !== "")];
  const entries = listDirEntries(absDir, prefix);
  let body: string;
  if (entries.length === 0) {
    body = `<div class="empty">empty</div>`;
  } else {
    const rows = entries
      .map((e) => {
        const href = hrefFor([...segments, e.name], e.isDir);
        const label = escapeHtml(e.name) + (e.isDir ? "/" : "");
        const size = e.size === null ? "-" : String(e.size);
        return `<tr><td><a href="${href}">${label}</a></td><td class="num">${size}</td><td>${escapeHtml(formatLocalMtime(e.mtimeMs))}</td></tr>`;
      })
      .join("");
    body = `<table><thead><tr><th>name</th><th>size</th><th>mtime</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return indexPageHtml(segments.join("/"), breadcrumbHtml(segments, true), body);
}

// md wrapper: marked.min.js は初回 readFileSync → module-level cache
let cachedMarkedJs: string | null = null;

function getMarkedJs(): string {
  if (cachedMarkedJs !== null) return cachedMarkedJs;
  const here = dirname(fileURLToPath(import.meta.url));
  cachedMarkedJs = readFileSync(
    join(here, "dashboard-web", "vendor", "marked.min.js"),
    "utf-8",
  );
  return cachedMarkedJs;
}

const WRAPPER_STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0 auto;max-width:860px;padding:24px;color:#d4d8df;background:#0e1116;line-height:1.6}
nav{margin-bottom:16px;font-size:14px;border-bottom:1px solid #2a313c;padding-bottom:8px}
a{text-decoration:none;color:#58a6ff}
a:hover{text-decoration:underline}
pre{background:#1c232c;padding:12px;border-radius:6px;overflow-x:auto}
code{background:#1c232c;padding:1px 4px;border-radius:4px;font-size:90%}
pre code{background:none;padding:0}
table{border-collapse:collapse}
th,td{border:1px solid #2a313c;padding:4px 10px}
blockquote{border-left:4px solid #2a313c;margin-left:0;padding-left:12px;color:#8a93a0}
img{max-width:100%}
`.trim();

function renderMarkdownWrapperHtml(
  mdText: string,
  rootKey: string,
  relPath: string,
): string {
  const segments = [rootKey, ...relPath.split("/").filter((s) => s !== "")];
  const filename = segments[segments.length - 1] ?? rootKey;
  // </script> による script コンテキスト脱出を防ぐため < を \\u003c に置換する
  const mdJson = JSON.stringify(mdText).replace(/</g, "\\u003c");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(filename)}</title>` +
    `<style>${WRAPPER_STYLE}</style></head><body>` +
    `<nav>${breadcrumbHtml(segments, false)} | <a href="?raw=1">raw</a></nav>` +
    `<article id="content"></article>` +
    `<script>${getMarkedJs()}</script>` +
    `<script type="application/json" id="md-src">${mdJson}</script>` +
    `<script>` +
    `const src = JSON.parse(document.getElementById("md-src").textContent);` +
    `document.getElementById("content").innerHTML = marked.parse(src);` +
    `</script></body></html>`
  );
}

// ────────────────────────────────────────────────────────────────────────
// handleFilesRequest
// ────────────────────────────────────────────────────────────────────────

function fileHtmlResponse(body: string, baseHeaders: Record<string, string>): Response {
  return new Response(body, {
    headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function fileJsonResponse(
  data: unknown,
  baseHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    headers: { ...baseHeaders, "Content-Type": "application/json" },
  });
}

function fileErrorResponse(
  status: number,
  error: string,
  endpoint: string,
  baseHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error, endpoint }), {
    status,
    headers: { ...baseHeaders, "Content-Type": "application/json" },
  });
}

/**
 * `/files` 系 request の entry point。dashboard-server.ts の fetchHandler から
 * 委譲される。baseHeaders には CSP / Cache-Control を渡す（全 response に付与）。
 */
export function handleFilesRequest(
  projectRoot: string,
  url: URL,
  baseHeaders: Record<string, string>,
): Response {
  const r = resolveFilePath(projectRoot, url.pathname);
  // dir / root_index は ?format=json で JSON serialize（ツリー lazy load 用）。
  // file は format を無視して従来配信する。
  const wantJson = url.searchParams.get("format") === "json";
  switch (r.kind) {
    case "bad_request":
      return fileErrorResponse(400, "bad_request", url.pathname, baseHeaders);
    case "not_found":
      return fileErrorResponse(404, "not_found", url.pathname, baseHeaders);
    case "root_index":
      if (wantJson) {
        return fileJsonResponse(
          { entries: Object.keys(ROOT_DIRS).map((name) => ({ name, isDir: true })) },
          baseHeaders,
        );
      }
      return fileHtmlResponse(renderFilesShellHtml(), baseHeaders);
    case "dir": {
      const prefix = url.searchParams.get("prefix");
      if (wantJson) {
        const entries = listDirEntries(r.absPath, prefix).map((e) => ({
          name: e.name,
          isDir: e.isDir,
          size: e.size,
          // 表示専用のローカルタイム文字列のみ載せる（mtimeMs は JSON に出さない / m4）
          mtimeLocal: e.mtimeMs === null ? null : formatLocalMtime(e.mtimeMs),
        }));
        return fileJsonResponse(
          { rootKey: r.rootKey, relPath: r.relPath, entries },
          baseHeaders,
        );
      }
      return fileHtmlResponse(
        renderDirIndexHtml(r.absPath, r.rootKey, r.relPath, prefix),
        baseHeaders,
      );
    }
    case "file": {
      const isMd = r.absPath.toLowerCase().endsWith(".md");
      if (isMd && url.searchParams.get("raw") !== "1") {
        const mdText = readFileSync(r.absPath, "utf-8");
        return fileHtmlResponse(
          renderMarkdownWrapperHtml(mdText, r.rootKey, r.relPath),
          baseHeaders,
        );
      }
      // 画像・大きい HTML report をメモリに読み切らないよう streaming 配信
      return new Response(Bun.file(r.absPath), {
        headers: {
          ...baseHeaders,
          "Content-Type": contentTypeFor(r.absPath),
        },
      });
    }
  }
}
