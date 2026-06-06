---
id: 012
title: T011 follow-up: restart 経路 integration test 追加
priority: medium
created_by: surface:737
created_at: 2026-05-18T23:24:11.868Z
---

## タスク
## 背景

T011 worktree archive 化の Inspector 検品 (`inspection.md` minor 3) で指摘された follow-up タスク。

T011 の `conductor-archive-integration.test.ts` (10 ケース) では plan §9.4 が指定した 10 ケースのうち、restart 経由 2 ケース (archive-restart-assigned / archive-restart-aborted) が含まれず、代わりに `legacy_fallback` と `preserveWorktree=true` DEPRECATED 互換の 2 ケースが入っている。

restart 経路は `archiveWorktree()` を直接呼ぶため worktree-archive.test.ts の unit と main.ts の dispatch wiring の 2 軸で**間接検証されており、E2E 観点での欠落リスクは小**。ただし plan §9.4 と完全一致させるなら追加が望ましい。

## やること

`conductor-archive-integration.test.ts` に 2 ケース追加:

1. `archive-restart-assigned`: `cleanupAssignedTask` を fixture で叩いて archive 化されることを検証 (reason=restart)
2. `archive-restart-aborted`: `restartFromAborted` を fixture で叩いて archive 化されることを検証 (reason=restart)

## 関連

- T011 (closed)
- T011 plan §9.4 の 10 ケース仕様
- `skills/cmux-team/manager/conductor-archive-integration.test.ts`
