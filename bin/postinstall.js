#!/usr/bin/env node

// elevens postinstall スクリプト
//
// 責務: manager/ の bun 依存を解決するだけ。
//
// 設計判断 (A031-fresh-install での発覚から修正):
//   - **他パッケージ (`hummer98/cmux-team`) plugin の auto-add は廃止** — 元実装は
//     elevens を install しただけで cmux-team plugin が登録される cross-package
//     副作用があり、user 認知外の状態変化を起こしていた。plugin install は
//     README で `claude plugin marketplace add hummer98/elevens` →
//     `claude plugin install elevens@hummer98-elevens` を案内する形に
//   - **`~/.claude/statusline.sh` の上書きは廃止** — global file を毎回上書きする
//     cross-package pollution を避ける。statusline 利用は別途 opt-in に分離
//   - **bun が無くても fail しない** — warn 出力のみで postinstall は exit 0

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const managerDir = join(__dirname, "..", "skills", "cmux-team", "manager");

try {
  execFileSync("which", ["bun"], { stdio: "ignore" });
  console.log("elevens: bun install を実行中 (manager/ 依存解決)...");
  execFileSync("bun", ["install"], { cwd: managerDir, stdio: "inherit" });
} catch {
  console.warn("elevens: bun が見つかりません。manager 依存を手動で解決してください:");
  console.warn(`  cd ${managerDir} && bun install`);
  console.warn("  bun のインストール: https://bun.sh/docs/installation");
}

console.log("elevens: postinstall 完了");
console.log("elevens: plugin として使う場合は以下を実行してください:");
console.log("  claude plugin marketplace add hummer98/elevens");
console.log("  claude plugin install elevens@hummer98-elevens");
