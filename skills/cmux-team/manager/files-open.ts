/**
 * `elevens open <file>` — 追従モード（follow mode）のヘルパー。
 *
 * 指定ファイルを Web ファイルビューワー（`/files`）で表示する。新規タブを増やさず、
 * 開いている viewer タブが自分でフォーカス対象を差し替える（spec 12 §8.7）。
 *  - CLI は `.team/files-focus.json`（`{ rootKey, relPath, ts }`）を atomic に書くだけ
 *  - dashboard が `GET /files/_focus` で返し、SPA が ~1s ポーリングして該当ファイルへ移動
 *
 * 許可 root はビューワーと同じ `ROOT_DIRS`（docs / .team/artifacts / .team/output）。
 * 本モジュールは副作用の薄い純関数のみ（spawn / console / exit は main.ts 側 cmdOpen が担う）。
 */
import { existsSync, realpathSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve, relative, join, sep } from "path";
import { ROOT_DIRS, FILES_FOCUS_REL } from "./dashboard-files";

export interface FocusTarget {
  rootKey: string;
  relPath: string;
}

/**
 * `<file>`（cwd 相対 or 絶対）を rootKey + rootKey 相対 path に解決する。
 * 許可 root 外 / 不存在は `{ error }`。symlink・macOS `/var`→`/private/var` は realpath で吸収。
 */
export function resolveFocusTarget(
  projectRoot: string,
  cwd: string,
  fileArg: string,
): FocusTarget | { error: string } {
  const absFile = resolve(cwd, fileArg);
  if (!existsSync(absFile)) return { error: `file not found: ${absFile}` };
  let realFile: string;
  try {
    realFile = realpathSync(absFile);
  } catch {
    realFile = absFile;
  }
  for (const rootKey of Object.keys(ROOT_DIRS)) {
    const rootAbs = resolve(projectRoot, ROOT_DIRS[rootKey]);
    let realRoot: string;
    try {
      realRoot = realpathSync(rootAbs);
    } catch {
      realRoot = rootAbs;
    }
    if (realFile === realRoot || realFile.startsWith(realRoot + sep)) {
      const rel = relative(realRoot, realFile).split(sep).join("/");
      return { rootKey, relPath: rel };
    }
  }
  return {
    error: `not under a viewable root (docs/ / .team/artifacts/ / .team/output/): ${absFile}`,
  };
}

/** focus 状態を atomic（tmp + rename）に書く。返り値は書いた絶対 path。 */
export function writeFilesFocus(
  projectRoot: string,
  target: FocusTarget,
  ts: number,
): string {
  const dest = join(projectRoot, FILES_FOCUS_REL);
  const tmp = dest + ".tmp";
  writeFileSync(
    tmp,
    JSON.stringify({ rootKey: target.rootKey, relPath: target.relPath, ts }),
  );
  renameSync(tmp, dest);
  return dest;
}

/** `.team/team.json` から dashboard server URL を読む（未起動 / 不明なら null）。 */
export function readDashboardUrl(projectRoot: string): string | null {
  const p = join(projectRoot, ".team", "team.json");
  if (!existsSync(p)) return null;
  try {
    const tj = JSON.parse(readFileSync(p, "utf-8"));
    const url = tj?.dashboardServer?.url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/**
 * `.team/team.json` から dashboard server の LAN 公開 URL を読む。
 * `dashboard.lanAccess` 無効 or LAN IP 不明なら null（フィールド自体が無い）。
 */
export function readDashboardLanUrl(projectRoot: string): string | null {
  const p = join(projectRoot, ".team", "team.json");
  if (!existsSync(p)) return null;
  try {
    const tj = JSON.parse(readFileSync(p, "utf-8"));
    const url = tj?.dashboardServer?.lanUrl;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** dashboard URL から `/files` ビューワー URL を組む（末尾 slash を正規化）。 */
export function filesViewerUrl(dashboardUrl: string): string {
  return dashboardUrl.replace(/\/+$/, "") + "/files";
}
