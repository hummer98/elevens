# T013 Summary

## タスク
post-mortem stderr の proper 実装: parent tee で TTY 表示 + file 両立

## 達成したこと
- v0.8.1 hotfix で disable していた post-mortem stderr redirect を **parent tee** アーキテクチャで proper に再実装
- bun runtime panic / Rust crate panic / libc abort を `manager.stderr.log` に capture（v0.8.0 同等の post-mortem evidence）
- 同時に TTY に正常 stdout/stderr が見える（v0.8.1 hotfix 同等の UX）
- 子プロセスの spawn 失敗（`daemon already running` 等）を TTY と file の両方に表示
- Ctrl+C で正常 shutdown（fatal-handlers dedup を必要としない構造）
- 親プロセスは child の exit code を継承

## 設計要点（plan.md / design-review.md round 2 Approved）
- parent は SIGINT/SIGTERM を child に forward しない（no-op listener で「親自殺の抑止」のみ）
- kernel の process group broadcast に shutdown 配送を委ねる → fatal-handlers dedup 不在問題が構造的に解決
- spawn 直後の atomic bind invariant（data/end/exit を同期 block 内で 3 listener bind）
- backpressure: `child.stderr.pause()` + `logStream.once("drain", () => resume())`
- test-only hatch を `__maybeRespawnWithStderrRedirectForTest` に別 export
- reload 経路は `[inherit, inherit, fd]` の fd 注入 + 3 経路通知（logger.log / heartbeat / events.jsonl `reload_failed`）
- `CMUX_TEAM_POST_MORTEM_REDIRECT` env opt-in を廃止（default 有効化）

## 変更ファイル（9 files, +1210/-174）
- `skills/cmux-team/manager/post-mortem-redirect.ts` — parent tee 全面書き換え
- `skills/cmux-team/manager/post-mortem-redirect.test.ts` — 19 tests に拡張
- `skills/cmux-team/manager/post-mortem-redirect.smoke.test.ts` — NEW（実 spawn 2 tests）
- `skills/cmux-team/manager/reload.ts` — fd 注入 + 3 経路 failure 通知
- `skills/cmux-team/manager/reload.test.ts` — 17 tests に拡張
- `skills/cmux-team/manager/events-writer.ts` — `reload_failed` event 追加
- `skills/cmux-team/manager/main.ts` — `projectRoot` 引数追加
- `docs/spec/15-post-mortem-evidence.md` — §2 table / §5(a) TTY-only / §5.1 新設 / §9 D1 改訂
- `CHANGELOG.md` — [Unreleased] T013 entry

## テスト結果
- `post-mortem-redirect.test.ts`: 19 pass / 0 fail
- `post-mortem-redirect.smoke.test.ts`: 2 pass / 0 fail
- `reload.test.ts`: 17 pass / 0 fail
- 合計 38 test / 113 expect 全 pass
- `bunx tsc --noEmit`: T013 touch ファイルに新規エラー無し（pre-existing の main.ts/c11-features 系は無関係）

## Inspector Verdict
**GO** (Critical 0 / Major 1 → round 2 で修正済み / Minor は意図的 follow-up)

## ラウンド構成
- Plan: round 1 (Changes Requested) → round 2 (Approved)
- Implementation: round 1 (実装完了) → round 2 (smoke.test.ts TS2769 修正のみ)
- Inspection: 1 round
