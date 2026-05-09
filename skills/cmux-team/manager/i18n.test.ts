/**
 * i18n.ts brand naming smoke test
 *
 * elevens への naming 移行（Phase 3 派生作業）に伴う UX 等価性チェック。
 * help text / error message / hint message が brand 統一できていることを確認する。
 *
 * - 後方互換のため `cmux-team` alias は package.json bin に残してあるが、
 *   ユーザー可視文字列は `elevens` に揃える
 * - `@hummer98/elevens` package 名 / `cmux-team-analyze` skill 直下のディレクトリ参照は維持
 */

import { describe, expect, test } from "bun:test";
import { t } from "./i18n";

describe("i18n brand naming (elevens)", () => {
  test("help_main は elevens を使う（cmux-team は含まれない）", () => {
    const help = t("help_main");
    expect(help).toContain("elevens");
    // help body の例コマンドや usage 行に cmux-team は出てこないこと
    expect(help).not.toContain("cmux-team start");
    expect(help).not.toContain("cmux-team status");
  });

  test("help_start は elevens を使う", () => {
    const help = t("help_start");
    expect(help).toContain("elevens start");
    expect(help).not.toContain("cmux-team start");
  });

  test("dashboard_startup_hint は elevens start を案内する", () => {
    const hint = t("dashboard_startup_hint");
    expect(hint).toContain("elevens start");
    expect(hint).not.toContain("cmux-team start");
  });

  test("artifact_id_required は elevens artifacts を案内する", () => {
    const msg = t("artifact_id_required");
    expect(msg).toContain("elevens artifacts");
    expect(msg).not.toContain("cmux-team artifacts");
  });

  test("template_dir_not_found は @hummer98/elevens を案内する", () => {
    const msg = t("template_dir_not_found");
    expect(msg).toContain("@hummer98/elevens");
    expect(msg).not.toContain("@hummer98/cmux-team");
  });

  test("help_main は @hummer98/cmux-team を含まない（package rename 反映）", () => {
    const help = t("help_main");
    expect(help).not.toContain("@hummer98/cmux-team");
  });

  test("gh_help は elevens gh を案内する", () => {
    const help = t("gh_help");
    expect(help).toContain("elevens gh");
    expect(help).not.toContain("cmux-team gh");
  });
});
