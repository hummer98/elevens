/**
 * Settings タブの role 別モデル編集ロジックのテスト。
 * - cycleModelValue: model picker のサイクル純関数（unset ↔ KNOWN_MODELS の巡回）
 * - buildSettingsRows: editable な model 行の描画（← / → ヒント表示）
 */
import { describe, test, expect } from "bun:test";
import { cycleModelValue, buildSettingsRows } from "./dashboard";
import { KNOWN_MODELS } from "./config";

describe("cycleModelValue", () => {
  test("unset から +1 で先頭モデルへ", () => {
    expect(cycleModelValue(undefined, 1)).toBe(KNOWN_MODELS[0]);
  });

  test("unset から -1 で末尾モデルへ（wrap）", () => {
    expect(cycleModelValue(undefined, -1)).toBe(KNOWN_MODELS[KNOWN_MODELS.length - 1]);
  });

  test("先頭モデルから +1 で次モデルへ", () => {
    expect(cycleModelValue(KNOWN_MODELS[0], 1)).toBe(KNOWN_MODELS[1]);
  });

  test("末尾モデルから +1 で unset へ（wrap）", () => {
    expect(cycleModelValue(KNOWN_MODELS[KNOWN_MODELS.length - 1], 1)).toBeUndefined();
  });

  test("2番目モデルから -1 で先頭モデルへ", () => {
    expect(cycleModelValue(KNOWN_MODELS[1], -1)).toBe(KNOWN_MODELS[0]);
  });

  test("KNOWN_MODELS 外の legacy 値 → unset 起点に復帰（+1 で先頭）", () => {
    expect(cycleModelValue("claude-opus-4-8", 1)).toBe(KNOWN_MODELS[0]);
    expect(cycleModelValue("claude-opus-4-8", -1)).toBe(
      KNOWN_MODELS[KNOWN_MODELS.length - 1],
    );
  });

  test("往復で元に戻る（+1 → -1）", () => {
    for (const m of [undefined, ...KNOWN_MODELS]) {
      expect(cycleModelValue(cycleModelValue(m, 1), -1)).toBe(m as any);
    }
  });
});

// buildSettingsRows は settingsItems / settingsCursor / daemon.projectRoot のみ参照する。
function stateWith(item: any, cursor = 0): any {
  return {
    settingsItems: [item],
    settingsCursor: cursor,
    daemon: { projectRoot: "/tmp/proj" },
  };
}

describe("buildSettingsRows: editable model 行", () => {
  test("edit を持つ config 行は選択時に ←/→ ヒントを表示する", () => {
    const item = {
      kind: "config",
      label: "models.master",
      value: "claude-fable-5",
      edit: { target: "master", current: "claude-fable-5" },
    };
    const rows = buildSettingsRows(stateWith(item));
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain("←/→");
  });

  test("edit を持たない config 行は ←/→ ヒントを出さない", () => {
    const item = { kind: "config", label: "mainBranch", value: "main" };
    const rows = buildSettingsRows(stateWith(item));
    expect(JSON.stringify(rows)).not.toContain("←/→");
  });
});
