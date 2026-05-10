/**
 * T003: verifyProxyIdentity の単体テスト。
 *
 * cmdStart の boot path で `.team/proxy-port` に書かれている既存 proxy が
 * 自プロジェクトの daemon が握っている proxy か verify するヘルパー。
 *
 * Test cases (plan §3.1〜§3.3):
 *  - A: 別 project_root を返す → kind:mismatch
 *  - B: 誰も listen していない port → kind:dead
 *      + unverifiable バリエーション 3 種 (legacy proxy が Anthropic API へ
 *        forward するケース: 401 plain text / 200 non-JSON binary /
 *        200 JSON without project_root)
 *  - C: 同一 project_root を返す → ok
 */

import { describe, test, expect } from "bun:test";
import { verifyProxyIdentity } from "./main";

describe("verifyProxyIdentity (T003)", () => {
  // Case A: project_root mismatch
  test("project_root mismatch returns kind:mismatch", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            project_root: "/Users/.../old-cmux-team",
            daemon_pid: 39221,
            version: "0.3.2",
            schema_version: 1,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      const result = await verifyProxyIdentity(
        String(fake.port),
        "/Users/.../elevens",
      );
      expect(result).toMatchObject({
        kind: "mismatch",
        otherProjectRoot: "/Users/.../old-cmux-team",
        otherDaemonPid: 39221,
      });
    } finally {
      await fake.stop(true);
    }
  });

  // Case B: no listener → dead
  test("no listener returns kind:dead", async () => {
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = tmp.port;
    await tmp.stop(true); // close active connections too — TCP 解放を確実にする
    const result = await verifyProxyIdentity(String(port), "/dummy");
    expect(result).toMatchObject({ kind: "dead" });
  });

  // Case B (I-1): unverifiable バリエーション
  // legacy proxy (T003 未適用) が握る port に新 daemon が GET /api/identify を投げると、
  // proxy は https://api.anthropic.com/api/identify に fall-through forward してしまう。
  // Anthropic 側は 401 / 非 JSON を返すことが多い。実装側で「200 以外 / JSON parse 失敗
  // / project_root 非文字列」を全部 kind:unverifiable に集約していることを確認する。
  test("unverifiable: 401 + plain text (legacy proxy → Anthropic 401 をシミュレート)", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("Authentication required", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
    });
    try {
      const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
      expect("kind" in result && result.kind).toBe("unverifiable");
    } finally {
      await fake.stop(true);
    }
  });

  test("unverifiable: 200 + non-JSON binary → kind:unverifiable", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(new Uint8Array([0xff, 0x00, 0xab]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    });
    try {
      const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
      expect("kind" in result && result.kind).toBe("unverifiable");
    } finally {
      await fake.stop(true);
    }
  });

  test("unverifiable: 200 + JSON without project_root → kind:unverifiable", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ daemon_pid: 99, version: "0.1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      const result = await verifyProxyIdentity(String(fake.port), "/Users/.../elevens");
      expect("kind" in result && result.kind).toBe("unverifiable");
    } finally {
      await fake.stop(true);
    }
  });

  // Case C: same project_root → ok
  test("same project_root returns ok", async () => {
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            project_root: "/Users/.../elevens",
            daemon_pid: process.pid,
            version: "0.4.1",
            schema_version: 1,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      const result = await verifyProxyIdentity(
        String(fake.port),
        "/Users/.../elevens",
      );
      expect(result).toMatchObject({
        ok: true,
        projectRoot: "/Users/.../elevens",
        daemonPid: process.pid,
        version: "0.4.1",
      });
    } finally {
      await fake.stop(true);
    }
  });
});
