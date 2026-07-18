/**
 * Settings タブの docs WebServer QR 描画（buildSettingsRows の qr kind 分岐）のテスト。
 * lanAccess 無効 → ヒント / URL 未取得 → ヒント / 揃っていれば QR 行を描く、の 3 分岐を
 * rezi ノードを JSON 直列化して文字列検証する。
 */
import { describe, test, expect } from "bun:test";
import { buildSettingsRows } from "./dashboard";
import { buildQrMatrix } from "./dashboard-qr";

// buildSettingsRows は settingsItems / settingsCursor / daemon.projectRoot のみ参照する。
function stateWith(item: any, cursor = 0): any {
  return {
    settingsItems: [item],
    settingsCursor: cursor,
    daemon: { projectRoot: "/tmp/proj" },
  };
}

function serialize(rows: any[]): string {
  return JSON.stringify(rows);
}

describe("buildSettingsRows: docs WebServer QR", () => {
  test("lanAccess=false → 有効化ヒントを表示（QR 無し）", () => {
    const rows = buildSettingsRows(
      stateWith({ kind: "qr", lanAccess: false, url: null, matrix: null }),
    );
    const s = serialize(rows);
    expect(s).toContain("lanAccess");
    expect(s).toContain("LAN 公開は無効");
  });

  test("lanAccess=true だが url/matrix 無し → URL 未取得ヒント", () => {
    const rows = buildSettingsRows(
      stateWith({ kind: "qr", lanAccess: true, url: null, matrix: null }),
    );
    const s = serialize(rows);
    expect(s).toContain("URL を取得できません");
  });

  test("url + matrix が揃う → URL 文字列と QR 行（複数行）を描く", () => {
    const url = "http://192.168.1.50:8765/files";
    const matrix = buildQrMatrix(url);
    const rows = buildSettingsRows(
      stateWith({ kind: "qr", lanAccess: true, url, matrix }),
    );
    const s = serialize(rows);
    // URL がそのまま表示される
    expect(s).toContain(url);
    // QR は行数が多い（matrix の行数 + ヘッダ等）。最低でも matrix.length 行は増える。
    expect(rows.length).toBeGreaterThan(matrix.length);
  });

  test("qr item 選択中でもクラッシュしない（preview セクション）", () => {
    const url = "http://10.0.0.2:8765/files";
    const matrix = buildQrMatrix(url);
    expect(() =>
      buildSettingsRows(stateWith({ kind: "qr", lanAccess: true, url, matrix }, 0)),
    ).not.toThrow();
  });
});
