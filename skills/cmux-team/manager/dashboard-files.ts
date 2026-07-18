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
import {
  lstatSync,
  realpathSync,
  statSync,
  readdirSync,
  readFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join, sep, dirname } from "path";
import { fileURLToPath } from "url";

// ────────────────────────────────────────────────────────────────────────
// resolver
// ────────────────────────────────────────────────────────────────────────

/**
 * rootKey → projectRoot 起点の実パス（allowlist そのもの）。
 * `elevens open` の focus 解決（files-open.ts）も同じ map を参照し、ビューワーと
 * CLI で許可 root を一元化する。
 */
export const ROOT_DIRS: Record<string, string> = {
  docs: "docs",
  artifacts: join(".team", "artifacts"),
  output: join(".team", "output"),
};

/** 追従モード（`elevens open`）の focus 状態ファイル（projectRoot 起点） */
export const FILES_FOCUS_REL = join(".team", "files-focus.json");

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
html{background:#0e1116}
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
#tree{width:280px;min-width:160px;max-width:70vw;flex:none;display:flex;flex-direction:column;background:var(--panel)}
#treehdr{flex:none;position:sticky;top:0;z-index:1;background:var(--panel);border-bottom:1px solid var(--border);padding:6px 8px;display:flex;flex-direction:column;gap:6px}
#treebody,#flatbody{flex:1;overflow:auto;padding:8px 0}
/* 表示モード: mode-time で tree を隠し flat list を出す。sort は tree 専用（時系列固定） */
#flatbody{display:none}
#tree.mode-time #treebody{display:none}
#tree.mode-time #flatbody{display:block}
#tree.mode-time #sortgrp{display:none}
/* スプリッター: ドラッグで左ペイン幅を変更 */
#splitter{flex:none;width:5px;cursor:col-resize;background:var(--border)}
#splitter:hover,#splitter.drag{background:var(--accent)}
.hgroup{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.hlabel{color:var(--fg-dim);font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-right:2px;flex:none}
.btn{cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--fg-dim);border-radius:4px;padding:2px 7px;font-size:11px;line-height:1.4;user-select:none}
.btn:hover{border-color:var(--accent)}
.btn.on{background:var(--panel2);color:var(--accent);border-color:var(--accent)}
.btn .arw{font-size:9px}
/* タイプフィルター: チップ OFF で該当タイプの file ノードを隠す（dir は常に表示） */
#tree.hide-md .node[data-type="md"]{display:none}
#tree.hide-html .node[data-type="html"]{display:none}
#tree.hide-image .node[data-type="image"]{display:none}
#viewpane{flex:1;min-width:0}
/* iframe 要素はブラウザ既定どおり白地（任意 raw HTML を「白い紙」の上に忠実表示）。
   ビューワー生成ページ（md wrapper / dir index）は自前で html ごとダークを塗るため影響なし。 */
#view{width:100%;height:100%;border:0;background:#fff}
.node{font-size:13px}
.children{margin-left:14px;border-left:1px solid var(--border)}
.row{display:flex;align-items:center;gap:8px;padding:3px 10px;cursor:pointer;white-space:nowrap;color:var(--fg)}
.row:hover{background:var(--panel2)}
.row.selected{background:var(--panel2);color:var(--accent)}
.row.dir>.label{color:var(--fg)}
.row.dir.open>.label::before{content:"\\25be ";color:var(--fg-dim)}
.row.dir>.label::before{content:"\\25b8 ";color:var(--fg-dim)}
.row .meta{margin-left:auto;color:var(--fg-dim);font-size:11px;flex:none}
/* flat 行: タイトルは ellipsis で切る（時系列モードはタイトルが主役） */
.row.flat>.label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.trunc{color:var(--fg-dim);font-style:italic;padding:6px 10px;font-size:11px}
.ns{padding:24px}
.ns a{color:var(--accent)}
`.trim();

// ツリー lazy load のクライアント JS。外部 src を持たず inline で完結する。
// XSS 回避: ノードラベルは textContent 代入、href/fetch path は encodeURIComponent。
const SHELL_SCRIPT = `
(function(){
  var tree=document.getElementById("tree");
  var treebody=document.getElementById("treebody");
  var flatbody=document.getElementById("flatbody");
  var view=document.getElementById("view");
  var selected=null;
  var IMG=["png","jpg","jpeg","gif","svg","webp","bmp","ico","avif"];
  var sortKey="mtime",sortDir="desc";       // 既定: 更新日降順
  var mode="tree";                            // 表示モード: tree | time
  var containers=[];                          // 既ロード children コンテナ（sort 再適用用）
  try{var p=JSON.parse(localStorage.getItem("filesSort")||"{}");if(p.key)sortKey=p.key;if(p.dir)sortDir=p.dir;}catch(e){}
  try{if(localStorage.getItem("filesMode")==="time")mode="time";}catch(e){}
  function enc(segs){return segs.map(encodeURIComponent).join("/");}
  function dash(v){return (v===null||v===undefined||v==="")?"-":String(v);}
  function typeOf(name){
    var dot=name.lastIndexOf("."),ext=dot<0?"":name.slice(dot+1).toLowerCase();
    if(ext==="md")return "md";
    if(ext==="html"||ext==="htm")return "html";
    if(IMG.indexOf(ext)>=0)return "image";
    return "other";
  }
  function nameCmp(a,b){return a.dataset.name<b.dataset.name?-1:(a.dataset.name>b.dataset.name?1:0);}
  function cmp(a,b){
    var ad=a.dataset.isdir==="1",bd=b.dataset.isdir==="1";
    if(ad!==bd)return ad?-1:1;              // dir を常に先頭
    if(ad)return nameCmp(a,b);              // dir 同士は名前昇順固定
    var r;
    if(sortKey==="size")r=(+a.dataset.size)-(+b.dataset.size);
    else if(sortKey==="mtime")r=a.dataset.mtime<b.dataset.mtime?-1:(a.dataset.mtime>b.dataset.mtime?1:0);
    else r=nameCmp(a,b);
    if(r===0)r=nameCmp(a,b);                // tiebreak は名前
    return sortDir==="desc"?-r:r;
  }
  function sortContainer(c){
    var n=[],i;for(i=0;i<c.children.length;i++)n.push(c.children[i]);
    n.sort(cmp);for(i=0;i<n.length;i++)c.appendChild(n[i]); // appendChild は既存ノードを移動（subtree/展開状態を保持）
  }
  function resortAll(){for(var i=0;i<containers.length;i++)sortContainer(containers[i]);}
  function makeNode(entry,parentSegs){
    var segs=parentSegs.concat([entry.name]);
    var node=document.createElement("div");
    node.className="node";
    node.dataset.isdir=entry.isDir?"1":"0";
    node.dataset.name=String(entry.name).toLowerCase();
    if(!entry.isDir){
      node.dataset.type=typeOf(entry.name);
      node.dataset.size=(entry.size==null?-1:entry.size);
      node.dataset.mtime=entry.mtimeLocal||"";
    }
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
    node._name=entry.name;                  // 追従モードの programmatic 展開用（exact name 一致）
    if(entry.isDir){
      var box=null,loadP=null;
      node._open=function(){                // 展開（必要なら lazy load）。children コンテナの Promise を返す
        if(!box){box=document.createElement("div");box.className="children";node.appendChild(box);}
        if(!loadP)loadP=loadDir(box,segs);
        box.style.display="";row.classList.add("open");
        return loadP.then(function(){return box;});
      };
      row.addEventListener("click",function(){
        if(box&&loadP){var hidden=box.style.display==="none";box.style.display=hidden?"":"none";row.classList.toggle("open",hidden);}
        else node._open();
      });
    }else{
      node._select=function(){
        if(selected)selected.classList.remove("selected");
        row.classList.add("selected");selected=row;
        view.src="/files/"+enc(segs);
        node.scrollIntoView({block:"nearest"});
      };
      row.addEventListener("click",node._select);
    }
    return node;
  }
  function loadInto(container,segs,url){
    if(containers.indexOf(container)<0)containers.push(container);
    return fetch(url).then(function(r){return r.json();}).then(function(data){
      container.textContent="";
      var entries=(data&&data.entries)||[];
      for(var i=0;i<entries.length;i++)container.appendChild(makeNode(entries[i],segs));
      sortContainer(container);
    }).catch(function(){container.textContent="(error)";});
  }
  function loadDir(container,segs){return loadInto(container,segs,"/files/"+enc(segs)+"/?format=json");}
  // ---- 時系列モード（flat list）: /files/_flat を表示。順序はサーバー確定（mtime 降順）----
  function makeFlatNode(e){
    var node=document.createElement("div");
    node.className="node";
    node.dataset.type=typeOf(e.name);
    node._rootKey=e.rootKey;node._relPath=e.relPath;
    var row=document.createElement("div");
    row.className="row file flat";
    row.title=e.rootKey+"/"+e.relPath;         // フルパスは tooltip で補完
    var label=document.createElement("span");
    label.className="label";
    label.textContent=e.title||e.name;
    var meta=document.createElement("span");
    meta.className="meta";
    meta.textContent=dash(e.mtimeLocal);
    row.appendChild(label);row.appendChild(meta);
    node.appendChild(row);
    node._select=function(){
      if(selected)selected.classList.remove("selected");
      row.classList.add("selected");selected=row;
      var segs=[e.rootKey],rest=String(e.relPath||"").split("/");
      for(var i=0;i<rest.length;i++){if(rest[i])segs.push(rest[i]);}
      view.src="/files/"+enc(segs);
      node.scrollIntoView({block:"nearest"});
    };
    row.addEventListener("click",node._select);
    return node;
  }
  function loadFlat(){
    return fetch("/files/_flat").then(function(r){return r.json();}).then(function(data){
      flatbody.textContent="";
      var entries=(data&&data.entries)||[];
      for(var i=0;i<entries.length;i++)flatbody.appendChild(makeFlatNode(entries[i]));
      if(data&&data.truncated){var t=document.createElement("div");t.className="trunc";t.textContent="(truncated)";flatbody.appendChild(t);}
    }).catch(function(){flatbody.textContent="(error)";});
  }
  function selectFlat(rootKey,relPath){
    for(var i=0;i<flatbody.children.length;i++){
      var n=flatbody.children[i];
      if(n._rootKey===rootKey&&n._relPath===relPath){if(n._select)n._select();return true;}
    }
    return false;
  }
  // ---- mode header ----
  var modeBtns=document.querySelectorAll("#modegrp .btn");
  function applyMode(){
    tree.classList.toggle("mode-time",mode==="time");
    for(var i=0;i<modeBtns.length;i++)modeBtns[i].classList.toggle("on",modeBtns[i].dataset.mode===mode);
    if(mode==="time")loadFlat();               // 切替のたびに再取得（新規ファイルを反映）
  }
  for(var mi=0;mi<modeBtns.length;mi++){(function(b){
    b.addEventListener("click",function(){
      if(mode===b.dataset.mode)return;
      mode=b.dataset.mode;
      try{localStorage.setItem("filesMode",mode);}catch(e){}
      applyMode();
    });
  })(modeBtns[mi]);}
  // ---- sort header ----
  var sortBtns=document.querySelectorAll("#sortgrp .btn");
  function paintSort(){
    for(var i=0;i<sortBtns.length;i++){
      var b=sortBtns[i],on=b.dataset.key===sortKey,old=b.querySelector(".arw");
      if(old)b.removeChild(old);
      b.classList.toggle("on",on);
      if(on){var s=document.createElement("span");s.className="arw";s.textContent=sortDir==="desc"?" \\u25be":" \\u25b4";b.appendChild(s);}
    }
  }
  for(var si=0;si<sortBtns.length;si++){(function(b){
    b.addEventListener("click",function(){
      if(sortKey===b.dataset.key)sortDir=sortDir==="desc"?"asc":"desc";
      else{sortKey=b.dataset.key;sortDir=(b.dataset.key==="name"?"asc":"desc");}
      try{localStorage.setItem("filesSort",JSON.stringify({key:sortKey,dir:sortDir}));}catch(e){}
      paintSort();resortAll();
    });
  })(sortBtns[si]);}
  // ---- type filter ----
  var filtBtns=document.querySelectorAll("#filtergrp .btn");
  for(var fi=0;fi<filtBtns.length;fi++){(function(b){
    var t=b.dataset.type,on=true;
    try{var fp=JSON.parse(localStorage.getItem("filesFilter")||"{}");if(t in fp)on=!!fp[t];}catch(e){}
    b.classList.toggle("on",on);tree.classList.toggle("hide-"+t,!on);
    b.addEventListener("click",function(){
      on=!on;b.classList.toggle("on",on);tree.classList.toggle("hide-"+t,!on);
      try{var f=JSON.parse(localStorage.getItem("filesFilter")||"{}");f[t]=on;localStorage.setItem("filesFilter",JSON.stringify(f));}catch(e){}
    });
  })(filtBtns[fi]);}
  paintSort();
  // ---- 追従モード（elevens open）: /files/_focus を ~1s ポーリングし該当ファイルへ自動移動 ----
  var focusTs=0;
  function findChild(c,name){for(var i=0;i<c.children.length;i++){if(c.children[i]._name===name)return c.children[i];}return null;}
  function expandTo(rootKey,relPath){
    var parts=[rootKey],rest=(relPath||"").split("/");
    for(var i=0;i<rest.length;i++){if(rest[i])parts.push(rest[i]);}
    var container=treebody,idx=0;
    (function step(){
      if(idx>=parts.length)return;
      var node=findChild(container,parts[idx]);
      if(!node)return;                      // 未ロード / 不一致なら打ち切り（次 poll で再試行されうる）
      if(idx===parts.length-1){if(node._select)node._select();else if(node._open)node._open();return;}
      if(node._open)node._open().then(function(box){container=box;idx++;step();});
    })();
  }
  function pollFocus(){
    fetch("/files/_focus").then(function(r){return r.json();}).then(function(f){
      if(f&&f.ts&&f.ts!==focusTs){
        focusTs=f.ts;
        if(mode==="time"){
          // flat list に無い（新規作成直後の）ファイルは再取得してから選択
          if(!selectFlat(f.rootKey,f.relPath))loadFlat().then(function(){selectFlat(f.rootKey,f.relPath);});
        }else expandTo(f.rootKey,f.relPath);
      }
    }).catch(function(){});
  }
  // ---- スプリッター: pointer drag で左ペイン幅を変更（localStorage 永続化）----
  var splitter=document.getElementById("splitter");
  try{var w0=parseInt(localStorage.getItem("filesPaneW")||"",10);if(w0>=160)tree.style.width=w0+"px";}catch(e){}
  splitter.addEventListener("pointerdown",function(ev){
    ev.preventDefault();
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add("drag");
    view.style.pointerEvents="none";           // ドラッグ中に iframe が pointer を食わないように
    function move(e2){
      var maxW=Math.floor(window.innerWidth*0.7);
      if(!(maxW>160))maxW=160;               // innerWidth が取れない / 極小時も下限 160 を保証
      var w=Math.max(160,Math.min(e2.clientX,maxW));
      tree.style.width=w+"px";
    }
    function up(){
      splitter.removeEventListener("pointermove",move);
      splitter.removeEventListener("pointerup",up);
      splitter.classList.remove("drag");
      view.style.pointerEvents="";
      try{localStorage.setItem("filesPaneW",String(parseInt(tree.style.width,10)||280));}catch(e){}
    }
    splitter.addEventListener("pointermove",move);
    splitter.addEventListener("pointerup",up);
  });
  applyMode();
  loadInto(treebody,[],"/files/?format=json").then(function(){pollFocus();}); // root ノード生成後に初回 poll
  setInterval(pollFocus,1000);
})();
`.trim();

/**
 * 2 ペイン shell HTML（root index の差し替え）。
 *  - 左 `#tree`: rootKey / dir をクリックで lazy 展開（`?format=json`）するツリー、
 *    または時系列 flat list（`/files/_flat`、view チップで切替・localStorage 永続化）
 *  - `#splitter`: pointer drag で左ペイン幅を変更（localStorage 永続化）
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
    `<aside id="tree" aria-label="file tree">` +
    `<div id="treehdr">` +
    `<div class="hgroup" id="modegrp"><span class="hlabel">view</span>` +
    `<span class="btn" data-mode="tree" title="ツリー表示">tree</span>` +
    `<span class="btn" data-mode="time" title="時系列表示（タイトル・更新日降順）">time</span></div>` +
    `<div class="hgroup" id="sortgrp"><span class="hlabel">sort</span>` +
    `<span class="btn" data-key="name" title="名前順">name</span>` +
    `<span class="btn" data-key="mtime" title="更新日時順">mtime</span>` +
    `<span class="btn" data-key="size" title="サイズ順">size</span></div>` +
    `<div class="hgroup" id="filtergrp"><span class="hlabel">show</span>` +
    `<span class="btn" data-type="md" title="Markdown の表示切替">md</span>` +
    `<span class="btn" data-type="html" title="HTML の表示切替">html</span>` +
    `<span class="btn" data-type="image" title="画像の表示切替">img</span></div>` +
    `</div>` +
    `<div id="treebody"></div>` +
    `<div id="flatbody"></div>` +
    `</aside>` +
    `<div id="splitter" title="ドラッグで幅変更"></div>` +
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

// ────────────────────────────────────────────────────────────────────────
// flat listing（時系列モード）
// ────────────────────────────────────────────────────────────────────────

/** flat list の返却上限。mtime 降順で新しい側から切る */
const FLAT_MAX_ENTRIES = 500;
/** flat walk の走査 file 数上限（巨大 output dir の暴走 backstop） */
const FLAT_MAX_SCAN = 20000;
/** md タイトル抽出で読む先頭バイト数 */
const TITLE_HEAD_BYTES = 4096;

/**
 * md ファイルからタイトルを抽出する。優先順位:
 *  1. frontmatter の `title:`（引用符は剥がす）
 *  2. 最初の ATX 見出し（`# ...`）
 *  3. どちらも無ければ null（呼び出し側がファイル名に fallback）
 * 先頭 4KB しか読まない（タイトルは先頭にある前提。巨大ファイルを読み切らない）。
 */
export function extractMdTitle(absPath: string): string | null {
  let head: string;
  try {
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(TITLE_HEAD_BYTES);
      const n = readSync(fd, buf, 0, TITLE_HEAD_BYTES, 0);
      head = buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = head.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "---") break;
      const m = line.match(/^title:\s*(.+?)\s*$/);
      if (m) {
        const title = m[1]!.replace(/^(["'])(.*)\1$/, "$2").trim();
        if (title !== "") return title;
      }
    }
  }
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

interface FlatEntryRow {
  rootKey: string;
  relPath: string;
  name: string;
  size: number | null;
  mtimeMs: number;
}

/**
 * 全 rootKey を再帰走査して file を集める。symlink は file / dir とも辿らない
 * （root 外への escape とループを walk 段階で断つ。tree 表示は従来どおり
 * resolveFilePath の realpath 境界で個別に守られる）。
 */
function walkFlatEntries(projectRoot: string): { rows: FlatEntryRow[]; truncated: boolean } {
  const rows: FlatEntryRow[] = [];
  let truncated = false;
  for (const [rootKey, rootRel] of Object.entries(ROOT_DIRS)) {
    const rootAbs = join(projectRoot, rootRel);
    const stack: string[] = [""];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      const absDir = rel === "" ? rootAbs : join(rootAbs, rel);
      let names: string[];
      try {
        names = readdirSync(absDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (rows.length >= FLAT_MAX_SCAN) {
          truncated = true;
          return { rows, truncated };
        }
        const relPath = rel === "" ? name : `${rel}/${name}`;
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(join(absDir, name));
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push(relPath);
        } else if (st.isFile()) {
          rows.push({ rootKey, relPath, name, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  return { rows, truncated };
}

/**
 * 時系列モードの JSON payload。mtime 降順で上限 FLAT_MAX_ENTRIES 件。
 * タイトル抽出は返却対象（上位 N 件）に絞ってから行う。
 */
export function listFlatEntries(projectRoot: string): {
  entries: Array<{
    rootKey: string;
    relPath: string;
    name: string;
    title: string;
    size: number | null;
    mtimeLocal: string;
  }>;
  truncated: boolean;
} {
  const { rows, truncated } = walkFlatEntries(projectRoot);
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const top = rows.slice(0, FLAT_MAX_ENTRIES);
  const entries = top.map((r) => {
    const abs = join(projectRoot, ROOT_DIRS[r.rootKey]!, r.relPath);
    const title = r.name.toLowerCase().endsWith(".md") ? extractMdTitle(abs) : null;
    return {
      rootKey: r.rootKey,
      relPath: r.relPath,
      name: r.name,
      title: title ?? r.name,
      size: r.size,
      // 表示専用のローカルタイム文字列のみ載せる（mtimeMs は JSON に出さない / m4）
      mtimeLocal: formatLocalMtime(r.mtimeMs),
    };
  });
  return { entries, truncated: truncated || rows.length > FLAT_MAX_ENTRIES };
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
html{background:#0e1116}
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
 * 追従モードの focus 状態を読む。壊れた / 無い場合は `{}` を返す（SPA は ts 差分でのみ反応）。
 * 返す形は `{ rootKey, relPath, ts }`（`files-open.ts` が書く形）。
 */
function readFilesFocus(projectRoot: string): unknown {
  const p = join(projectRoot, FILES_FOCUS_REL);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
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
  // 追従モード（`elevens open`）: SPA が ~1s ポーリングする focus 状態。
  // `.team/files-focus.json` を素通しで返す（無ければ空オブジェクト）。実 path 解決の前に分岐する。
  if (url.pathname === "/files/_focus") {
    return fileJsonResponse(readFilesFocus(projectRoot), baseHeaders);
  }
  // 時系列モード: 全 rootKey 横断の flat list（mtime 降順・タイトル付き）
  if (url.pathname === "/files/_flat") {
    return fileJsonResponse(listFlatEntries(projectRoot), baseHeaders);
  }
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
