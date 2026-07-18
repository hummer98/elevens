/**
 * dashboard-qr.ts — URL を QR コードの boolean 行列に変換する純関数（T: docs WebServer QR）。
 *
 * UI レンダ（rezi-ui ノード生成）からは切り離し、行列生成だけをここに置いてテスト可能にする。
 * Settings タブが LAN URL から QR を組み立てる際に使う。
 */
import qrcode from "qrcode-generator";

/**
 * `text` を QR の boolean 行列（true = dark module）に変換する。
 *
 * - `margin`: quiet zone（読み取りに必須の余白）のモジュール数。default 2。
 *   QR 仕様上の推奨は 4 だが、ターミナル幅を節約するため 2 を既定とする（多くの
 *   スマホリーダーは 2 でも読める）。
 * - typeNumber=0（自動）/ errorCorrectionLevel="M" で生成する。URL 程度の長さなら
 *   version 2〜4（25〜37 モジュール）に収まる。
 */
export function buildQrMatrix(text: string, margin = 2): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = new Array(size);
    for (let c = 0; c < size; c++) {
      const mr = r - margin;
      const mc = c - margin;
      row[c] = mr >= 0 && mr < n && mc >= 0 && mc < n && qr.isDark(mr, mc);
    }
    rows.push(row);
  }
  return rows;
}
