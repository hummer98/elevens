# T010 タスクサマリー

## タスク概要

**Manager daemon post-mortem evidence capture 強化** — 2026-05-17 Brainship/prototype での「無言死」インシデント (manager.log 最終行から検知まで 29 分のギャップ、死因不明) への構造的対策。次回同種クラッシュ時に WHEN / WHAT / WHY の 3 軸で原因究明できる evidence を残す機構を Manager daemon に組み込んだ。

## 完了したサブタスク（11 件）

| サブタスク | 状態 |
|---|---|
| S1: `logger.ts` に `logSync` / `warnSync` / `errorSync` sync API 追加 | ✅ |
| S2: `fatal-handlers.ts` 新設 (uncaught/unhandled/SIGTERM/SIGINT/SIGHUP 集約) + `pidfile.ts` の uncaughtException/unhandledRejection listener 撤去 | ✅ |
| S3: `heartbeat.ts` 新設 (10s sync write + clean exit 記録 + unlink) | ✅ |
| S4: `self-telemetry.ts` 新設 (30s JSONL append + size base rotation + event loop lag meter) | ✅ |
| S5: `post-mortem-redirect.ts` 新設 (Bun.spawn 自己再 spawn で OS fd 2 を file へ redirect) | ✅ |
| S5.1: `reload.ts` に `--__post-mortem-redirected` flag 伝播 (2 段重ね防止) | ✅ |
| S7: `config.ts` に `postMortem.*` schema + `resolvePostMortemConfig` 追加 | ✅ |
| S6: `main.ts` (cmdStart) に統合 (N1 採用 A: signal bind を fatal-handlers に完全集約) | ✅ |
| S8: `scripts/test-crash-evidence.sh` 新設 (開発者ローカル前提) | ✅ |
| S9: `docs/spec/15-post-mortem-evidence.md` 新設 + glossary §12 / overview / 05-install 連携 | ✅ |
| S10: `CLAUDE.md` 更新 (`.team/` 構造 / Manager protocol / Post-mortem section) | ✅ |

## 変更ファイル一覧

### 新規 (11 ファイル)
- `skills/cmux-team/manager/fatal-handlers.ts` + `fatal-handlers.test.ts`
- `skills/cmux-team/manager/heartbeat.ts` + `heartbeat.test.ts`
- `skills/cmux-team/manager/self-telemetry.ts` + `self-telemetry.test.ts`
- `skills/cmux-team/manager/post-mortem-redirect.ts` + `post-mortem-redirect.test.ts`
- `docs/spec/15-post-mortem-evidence.md`
- `scripts/test-crash-evidence.sh`

### 変更 (13 ファイル)
- `skills/cmux-team/manager/logger.ts` + `logger.test.ts` — sync API 追加
- `skills/cmux-team/manager/pidfile.ts` + `pidfile.test.ts` — uncaughtException/unhandledRejection listener 撤去 ('exit' listener のみ残置)
- `skills/cmux-team/manager/reload.ts` + `reload.test.ts` — flag 常時付与
- `skills/cmux-team/manager/config.ts` + `config.test.ts` — postMortem schema
- `skills/cmux-team/manager/main.ts` — cmdStart 統合 (8 箇所、N1 採用 A)
- `CLAUDE.md` — `.team/` 構造 + Manager 節 + Post-mortem section
- `docs/spec/00-project-overview.md` — 観察可能性に post-mortem 列追加
- `docs/spec/05-install-and-infrastructure.md` — `.team/` ファイル一覧追加
- `docs/spec/glossary.md` — §12 post-mortem evidence 5 用語

## テスト結果

```
cd skills/cmux-team/manager && bun test --timeout 30000 \
  logger.test.ts heartbeat.test.ts self-telemetry.test.ts \
  fatal-handlers.test.ts post-mortem-redirect.test.ts \
  main.test.ts daemon.test.ts reload.test.ts config.test.ts pidfile.test.ts

→ 675 pass / 2 skip / 0 fail / 1901 expect() calls / 32.99s
```

型エラー (`bunx tsc --noEmit`): baseline 16 件維持、新規 0 件追加。

## フロー記録

- **Phase 1 (Planner)**: surface:818 → plan.md (396 行)
- **Phase 2 (Design Review)**: surface:821 → Changes Requested (Critical 2: F1 handler 順序の前提誤り / F2 reload.ts 修正漏れ)
- **Phase 2 (Planner v2)**: surface:822 → plan.md 改訂 (465 行、R1〜R7 反映、S5.1 追加)
- **Phase 2 (Design Review v2)**: surface:823 → **Approved** (N1 minor: §3.2 と §S6 の signal bind 記述衝突)
- **Phase 3 (Implementer)**: surface:824 → 11 サブタスク TDD 実装、N1 採用 A で実装
- **Phase 4 (Inspector)**: surface:826 → **GO** (Critical 0 / Major 0)

## マージコミット

(commit 後に追記)

## 観察可能性への寄与

CLAUDE.md「観察箱 (AI Observatory)」原則に基づき、Manager daemon の **retrospective 観察層**を 4 軸 evidence file (heartbeat / telemetry / stderr.log / fatal trace) で大幅強化。daemon 死亡時の事後再現性が「pane を斜め読み」だけだった現状から、決定論的に file から再構成できる構造に変わった。
