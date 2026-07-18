import { describe, test, expect } from "bun:test";
import { buildQrMatrix } from "./dashboard-qr";

describe("buildQrMatrix", () => {
  const URL = "http://192.168.1.50:8765/files";

  test("正方行列を返し、サイズ = moduleCount + margin*2", () => {
    const margin = 2;
    const m = buildQrMatrix(URL, margin);
    expect(m.length).toBeGreaterThan(0);
    // 全行が同じ長さ（正方）
    for (const row of m) {
      expect(row.length).toBe(m.length);
    }
    // QR version 1 = 21 モジュール。URL なので version >= 2（25+）。margin 込みで十分大きい。
    expect(m.length).toBeGreaterThanOrEqual(25 + margin * 2);
  });

  test("quiet zone（margin）は全て light（false）", () => {
    const margin = 2;
    const m = buildQrMatrix(URL, margin);
    const n = m.length;
    for (let i = 0; i < margin; i++) {
      // 上下端の margin 行は全 false
      expect(m[i]!.every((v) => v === false)).toBe(true);
      expect(m[n - 1 - i]!.every((v) => v === false)).toBe(true);
      // 左右端の margin 列は全 false
      for (let r = 0; r < n; r++) {
        expect(m[r]![i]).toBe(false);
        expect(m[r]![n - 1 - i]).toBe(false);
      }
    }
  });

  test("finder pattern 由来の dark モジュールを含む（全 false ではない）", () => {
    const m = buildQrMatrix(URL);
    const anyDark = m.some((row) => row.some((v) => v === true));
    expect(anyDark).toBe(true);
  });

  test("同一入力は決定論的（version/mask 固定）", () => {
    const a = buildQrMatrix(URL);
    const b = buildQrMatrix(URL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("margin=0 ならサイズ = moduleCount（余白行が無い）", () => {
    const m0 = buildQrMatrix(URL, 0);
    const m2 = buildQrMatrix(URL, 2);
    expect(m2.length).toBe(m0.length + 4);
  });
});
