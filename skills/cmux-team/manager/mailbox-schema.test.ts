/**
 * mailbox-schema.ts のテスト（TDD）。
 *
 * docs/spec/13-mailbox-schema.md に書かれた formal schema を実装と一致させる。
 * 設計判断:
 *   - canonical key は型違反を error にする（strict）
 *   - 未知 mailbox.* key は warning（schema 進化の余地確保）
 *   - 非 mailbox.* prefix は無視（passthrough）
 *   - normalizer は副作用なし pure function
 */
import { describe, test, expect } from "bun:test";
import {
  isMailboxKey,
  validateMailboxPayload,
  normalizeMailboxStatus,
  normalizeMailboxPayload,
  MAILBOX_KEYS,
  MAILBOX_ROLES,
  MAILBOX_STATUSES,
  type MailboxPayload,
  type MailboxRole,
  type MailboxStatus,
} from "./mailbox-schema";

describe("MAILBOX_KEYS / MAILBOX_ROLES / MAILBOX_STATUSES の網羅性", () => {
  test("canonical key には最低限の8つが含まれる", () => {
    const expected = [
      "mailbox.role",
      "mailbox.status",
      "mailbox.task",
      "mailbox.task_run_id",
      "mailbox.progress",
      "mailbox.started_at",
      "mailbox.completed_at",
      "mailbox.error",
    ];
    for (const k of expected) {
      expect(MAILBOX_KEYS).toContain(k as any);
    }
  });

  test("MAILBOX_ROLES に master / conductor / agent と 8 agent role が含まれる", () => {
    // common-header.md 経由で書き込まれる role の実値網羅
    const expected: MailboxRole[] = [
      "master",
      "conductor",
      "agent",
      "researcher",
      "architect",
      "planner",
      "design-reviewer",
      "implementer",
      "inspector",
      "dockeeper",
      "task-manager",
    ];
    for (const r of expected) {
      expect(MAILBOX_ROLES).toContain(r);
    }
  });

  test("MAILBOX_STATUSES は running / done / idle / error / aborted の 5 値", () => {
    const expected: MailboxStatus[] = ["running", "done", "idle", "error", "aborted"];
    for (const s of expected) {
      expect(MAILBOX_STATUSES).toContain(s);
    }
    expect(MAILBOX_STATUSES.length).toBe(5);
  });
});

describe("isMailboxKey", () => {
  test("canonical key は true", () => {
    expect(isMailboxKey("mailbox.role")).toBe(true);
    expect(isMailboxKey("mailbox.status")).toBe(true);
    expect(isMailboxKey("mailbox.progress")).toBe(true);
  });

  test("mailbox.* prefix の未知 key も true（拡張余地）", () => {
    expect(isMailboxKey("mailbox.custom_field")).toBe(true);
  });

  test("非 mailbox.* prefix は false", () => {
    expect(isMailboxKey("title")).toBe(false);
    expect(isMailboxKey("lifecycle_state")).toBe(false);
    expect(isMailboxKey("mailbox")).toBe(false);
    expect(isMailboxKey("mailbox.")).toBe(false); // 空サフィックス
    expect(isMailboxKey("")).toBe(false);
  });
});

describe("validateMailboxPayload — canonical key の正常系", () => {
  test("全 canonical key の valid 値で {ok:true}", () => {
    const payload = {
      "mailbox.role": "implementer",
      "mailbox.status": "running",
      "mailbox.task": "T123",
      "mailbox.task_run_id": "task-123-1234567890",
      "mailbox.progress": 0.5,
      "mailbox.started_at": "2026-05-09T10:00:00.000Z",
      "mailbox.completed_at": "2026-05-09T11:00:00.000Z",
      "mailbox.error": "",
    };
    const r = validateMailboxPayload(payload);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value["mailbox.role"]).toBe("implementer");
      expect(r.value["mailbox.progress"]).toBe(0.5);
      expect(r.warnings ?? []).toEqual([]);
    }
  });

  test("progress 0 と 1 の境界値は OK", () => {
    expect(validateMailboxPayload({ "mailbox.progress": 0 }).ok).toBe(true);
    expect(validateMailboxPayload({ "mailbox.progress": 1 }).ok).toBe(true);
  });

  test("空 object は OK（warnings 無し）", () => {
    const r = validateMailboxPayload({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings ?? []).toEqual([]);
  });
});

describe("validateMailboxPayload — 型違反は error", () => {
  test("mailbox.progress = 2.0 (out of [0,1]) で {ok:false}", () => {
    const r = validateMailboxPayload({ "mailbox.progress": 2.0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join("\n")).toContain("mailbox.progress");
    }
  });

  test("mailbox.progress = -0.1 で error", () => {
    const r = validateMailboxPayload({ "mailbox.progress": -0.1 });
    expect(r.ok).toBe(false);
  });

  test("mailbox.progress = 'half' (string) は error", () => {
    const r = validateMailboxPayload({ "mailbox.progress": "half" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/mailbox\.progress/);
  });

  test("mailbox.role = 'unknown_role' は error", () => {
    const r = validateMailboxPayload({ "mailbox.role": "unknown_role" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/mailbox\.role/);
  });

  test("mailbox.status = 'finished' は error（canonical 値ではない）", () => {
    const r = validateMailboxPayload({ "mailbox.status": "finished" });
    expect(r.ok).toBe(false);
  });

  test("mailbox.status = 'DONE' (大文字) は error（normalize 前なので strict）", () => {
    const r = validateMailboxPayload({ "mailbox.status": "DONE" });
    expect(r.ok).toBe(false);
  });

  test("mailbox.task = 123 (number) は error（string 必須）", () => {
    const r = validateMailboxPayload({ "mailbox.task": 123 });
    expect(r.ok).toBe(false);
  });

  test("mailbox.started_at = 'yesterday' (非 ISO) は error", () => {
    const r = validateMailboxPayload({ "mailbox.started_at": "yesterday" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/mailbox\.started_at/);
  });

  test("mailbox.error = true (bool) は error", () => {
    const r = validateMailboxPayload({ "mailbox.error": true });
    expect(r.ok).toBe(false);
  });
});

describe("validateMailboxPayload — 未知 mailbox.* key は warning", () => {
  test("未知 mailbox.* key は {ok:true, warnings:[...]}", () => {
    const r = validateMailboxPayload({
      "mailbox.role": "agent",
      "mailbox.custom_field": "anything",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining("mailbox.custom_field")])
      );
      // value にも残る
      expect((r.value as any)["mailbox.custom_field"]).toBe("anything");
    }
  });

  test("未知 mailbox.* key の値は型問わず warning（書き込みは許容）", () => {
    const r = validateMailboxPayload({ "mailbox.foo": { nested: 42 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.warnings ?? []).length).toBeGreaterThan(0);
  });
});

describe("validateMailboxPayload — 非 mailbox.* prefix は passthrough", () => {
  test("title / lifecycle_state など surface 標準 metadata は無視", () => {
    const r = validateMailboxPayload({
      title: "My Surface",
      lifecycle_state: "running",
      "mailbox.status": "running",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 値はそのまま含まれる
      expect((r.value as any).title).toBe("My Surface");
      expect((r.value as any).lifecycle_state).toBe("running");
      expect(r.warnings ?? []).toEqual([]); // 非 mailbox.* は warning にもしない
    }
  });
});

describe("validateMailboxPayload — 入力 shape の防御", () => {
  test("null 入力で {ok:false}", () => {
    const r = validateMailboxPayload(null);
    expect(r.ok).toBe(false);
  });

  test("array 入力で {ok:false}", () => {
    const r = validateMailboxPayload(["x"]);
    expect(r.ok).toBe(false);
  });

  test("string 入力で {ok:false}", () => {
    const r = validateMailboxPayload("hello");
    expect(r.ok).toBe(false);
  });
});

describe("normalizeMailboxStatus", () => {
  test("大文字小文字のゆらぎを canonical 値に揃える", () => {
    expect(normalizeMailboxStatus("DONE")).toBe("done");
    expect(normalizeMailboxStatus("Done")).toBe("done");
    expect(normalizeMailboxStatus("done")).toBe("done");
    expect(normalizeMailboxStatus("Running")).toBe("running");
    expect(normalizeMailboxStatus("ABORTED")).toBe("aborted");
  });

  test("trim も行う", () => {
    expect(normalizeMailboxStatus("  done  ")).toBe("done");
  });

  test("canonical 集合に無い値は undefined", () => {
    expect(normalizeMailboxStatus("finished")).toBeUndefined();
    expect(normalizeMailboxStatus("")).toBeUndefined();
  });

  test("純粋関数（同じ入力で常に同じ出力）", () => {
    expect(normalizeMailboxStatus("DONE")).toBe(normalizeMailboxStatus("DONE"));
  });
});

describe("normalizeMailboxPayload", () => {
  test("mailbox.status を case-fold する", () => {
    const r = normalizeMailboxPayload({ "mailbox.status": "DONE" });
    expect((r as any)["mailbox.status"]).toBe("done");
  });

  test("ISO timestamp を正規化（Z 形式に揃える）", () => {
    // +00:00 → Z 揃え
    const r = normalizeMailboxPayload({ "mailbox.started_at": "2026-05-09T10:00:00+00:00" });
    expect((r as any)["mailbox.started_at"]).toBe("2026-05-09T10:00:00.000Z");
  });

  test("既に canonical な値は変更しない", () => {
    const input: MailboxPayload = {
      "mailbox.status": "running",
      "mailbox.role": "agent",
    };
    const r = normalizeMailboxPayload(input);
    expect((r as any)["mailbox.status"]).toBe("running");
    expect((r as any)["mailbox.role"]).toBe("agent");
  });

  test("normalize 不能な値はそのまま残す（validation で error にする責務）", () => {
    const r = normalizeMailboxPayload({ "mailbox.status": "finished" });
    expect((r as any)["mailbox.status"]).toBe("finished");
  });

  test("非 mailbox.* key には触らない（passthrough）", () => {
    const r = normalizeMailboxPayload({ title: "X", "mailbox.status": "DONE" });
    expect((r as any).title).toBe("X");
    expect((r as any)["mailbox.status"]).toBe("done");
  });

  test("input を mutate しない（pure）", () => {
    const input = { "mailbox.status": "DONE" };
    normalizeMailboxPayload(input);
    expect(input["mailbox.status"]).toBe("DONE");
  });
});
