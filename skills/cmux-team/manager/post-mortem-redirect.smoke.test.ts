/**
 * post-mortem-redirect.ts (T013) — integration smoke test
 *
 * 実 spawn で child を起動し、parent tee が:
 *   - child の stderr を file (manager.stderr.log) と TTY (processStderrWriteImpl) の
 *     両方に届けること
 *   - child の exit code を親 exit に伝播させること
 * を E2E に検証する。
 *
 * 実プロセス起動を伴うため flakiness 余地あり。CI で一時的に skip したい場合は
 * `CMUX_TEAM_SKIP_INTEGRATION=1` を設定する (本テストファイル全体が skip される)。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __maybeRespawnWithStderrRedirectForTest,
  STDERR_LOG_RELATIVE,
} from "./post-mortem-redirect";

const skipIntegration = process.env.CMUX_TEAM_SKIP_INTEGRATION === "1";
const d = skipIntegration ? describe.skip : describe;

d("post-mortem-redirect — integration smoke (real spawn)", () => {
  test("child の stderr が tee 経由で file と TTY mock の両方に届き exit code が伝播する", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "post-mortem-smoke-"));
    const childScript = join(tmpRoot, "child.js");
    writeFileSync(
      childScript,
      `process.stderr.write("hello-from-child-stderr\\n");\n` +
        `process.stderr.write("second-line\\n");\n` +
        `process.exit(42);\n`,
    );

    const ttyChunks: string[] = [];
    let exitCode: number | null = null;

    const result = await __maybeRespawnWithStderrRedirectForTest({
      projectRoot: tmpRoot,
      args: ["arg-from-test"],
      isTTYImpl: () => true,
      execPath: process.execPath,
      scriptPath: childScript,
      processStderrWriteImpl: (chunk) => {
        ttyChunks.push(chunk.toString());
        return true;
      },
      exitImpl: (code) => {
        exitCode = code;
      },
      waitForChildExit: true,
    });

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("tee-completed");

    // 親 exit code = child の exit code (42)
    expect(exitCode!).toBe(42);

    // TTY mock に届いている
    const ttyAll = ttyChunks.join("");
    expect(ttyAll).toContain("hello-from-child-stderr");
    expect(ttyAll).toContain("second-line");

    // file にも届いている
    const logPath = join(tmpRoot, STDERR_LOG_RELATIVE);
    const logContent = readFileSync(logPath, "utf8");
    expect(logContent).toContain("hello-from-child-stderr");
    expect(logContent).toContain("second-line");
  }, 15000);

  test("正常終了 (exit 0) も親 exit code に伝わる", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "post-mortem-smoke-"));
    const childScript = join(tmpRoot, "child.js");
    writeFileSync(
      childScript,
      `process.stderr.write("normal-exit\\n");\nprocess.exit(0);\n`,
    );

    let exitCode: number | null = null;

    await __maybeRespawnWithStderrRedirectForTest({
      projectRoot: tmpRoot,
      args: [],
      isTTYImpl: () => true,
      execPath: process.execPath,
      scriptPath: childScript,
      processStderrWriteImpl: () => true,
      exitImpl: (code) => {
        exitCode = code;
      },
      waitForChildExit: true,
    });

    expect(exitCode!).toBe(0);
  }, 15000);
});
