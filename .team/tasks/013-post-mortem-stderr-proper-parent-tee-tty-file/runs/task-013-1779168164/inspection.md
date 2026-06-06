# T013 Inspection

## Verdict
**GO**

## Summary

T013「post-mortem stderr proper 実装 (parent tee で TTY 表示 + file 両立)」の実装を独立第三者視点で検品。Acceptance Criteria 9 項目はいずれもコード・テスト・spec で根拠を確認できる。plan.md (rev2) と design-review.md round 2 の Approved 内容 (C1/C2/M1〜M4/m1/m2/m3/m5) は構造的に実装へ反映されており、parent は signal を forward しない設計 (`signalsToForward` DI 不在 + `ABSORB_SIGNALS = ["SIGINT","SIGTERM"]` の no-op listener) / atomic bind invariant / pause+drain+resume backpressure / `__maybeRespawnWithStderrRedirectForTest` の test-only 別 export 化 / reload の `[inherit, inherit, fd]` への切替 + 3 経路 (logger.log / heartbeat / events.jsonl `reload_failed`) failure 通知が揃っている。テストは T013 で touch した 3 ファイル (`post-mortem-redirect.test.ts` 19 / `post-mortem-redirect.smoke.test.ts` 2 / `reload.test.ts` 17) すべて green。pre-existing failure (`project-root.test.ts` / `cli-project-root.test.ts` / `cwd-mismatch.integration.test.ts`) は main との diff 0 行で T013 起因ではないことを確認。design-review n1/n2 は実装で対応済み、n3 は impl-notes.md に意図的 follow-up として記録 (許容範囲)。

懸念は 1 件のみ: `post-mortem-redirect.smoke.test.ts` で `expect(exitCode).toBe(42)` / `toBe(0)` が bun:test の `toBe` overload に対し TS2769 を起こす (`let exitCode: number | null = null` の TS narrowing で `null` overload にマッチする問題)。テスト実行は pass するため機能影響は無いが、`bunx tsc --noEmit` で 2 件の新規エラーが出る。「touch ファイルの新規エラーは先送り禁止」のスコープ内なので Major として記録するが、test の意図に対して構造的・機能的瑕疵は無く GO を妨げる level ではない。修正は `exitCode!` non-null assertion / 型 narrowing の解消 / `toBe<number>(42)` の generic 指定など 1 行で済む軽微なもの。

## Acceptance Criteria 検証

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `CMUX_TEAM_POST_MORTEM_REDIRECT` env なしで default tee が走る | OK | `post-mortem-redirect.ts` から env 参照は完全削除 (production code に grep ヒット 0)。`post-mortem-redirect.test.ts:229` で `delete process.env.CMUX_TEAM_POST_MORTEM_REDIRECT` 状態で spawn が走ることを assert |
| 2 | `elevens start` のエラーが TTY に出る (例: `daemon already running`) | OK | `post-mortem-redirect.ts:227-247` の `if (!child.pid)` で `processStderrWriteImpl(msg)` と `logStream.write(msg)` の **両方** に書いてから `exit(1)`。`post-mortem-redirect.test.ts:572-602` でも両者 assert |
| 3 | child の Bun runtime panic / `process.exit(1)` が file に残る | OK | `post-mortem-redirect.ts:253-277` で `childStderr.on("data")` が pipe 経由の全 chunk を `logStream.write` に流す。`post-mortem-redirect.smoke.test.ts:26-71` で実 spawn child の stderr が file に届くことを確認 (exit 42 の panic 相当も同様) |
| 4 | Ctrl+C で daemon が正常 shutdown する (かつ 1 回しか走らない) | OK | parent は `process.on("SIGINT", () => {})` / `("SIGTERM", () => {})` で **no-op listener のみ** bind。`child.kill` を呼ばない構造 (`post-mortem-redirect.ts:283-295` + `ABSORB_SIGNALS = ["SIGINT","SIGTERM"]`)。`post-mortem-redirect.test.ts:470-518` で `child.killCalls` が空であることを assert。SIGHUP は bind しない仕様で同テスト L520-537 で `listenerCount("SIGHUP") - sighupBaseline === 0` を assert |
| 5 | 親プロセスは child の exit code を継承する | OK | `deriveExitCode(code, signal)` (`post-mortem-redirect.ts:155-162`): `typeof code === "number"` → そのまま / signal → `128 + signalNumber(signal)` / どちらも null → 1。`post-mortem-redirect.test.ts:368-441` で exit 7 / SIGINT→130 / SIGTERM→143 を assert。smoke test でも 42 / 0 を実 spawn で確認 |
| 6 | `CMUX_TEAM_POST_MORTEM_REDIRECT` 廃止 or backward-compat | OK | 完全廃止 (back-compat 残さず)。`CHANGELOG.md:14` に「v0.8.1 の env opt-in は本実装で不要化し、再 default 有効化」と明記。production code に grep 0 件、test code は廃止確認用途のみ |
| 7 | 既存 test を tee 経路に書き直し + cases 拡張 | OK | `post-mortem-redirect.test.ts` を 642 行追加で全面書き換え (19 test、8 describe ブロック)。新規: tee data routing / exit code 継承 (3 case) / no-forward signal (4 case) / spawn 失敗 / backpressure / atomic bind / test hatch |
| 8 | CHANGELOG に「v0.8.1 hotfix の proper fix」として記録 | OK | `CHANGELOG.md:3-16` の `[Unreleased]` セクションに T013 entry。設計要点 (no-forward / atomic bind / backpressure / spawn 失敗 / reload fd 注入 / 3 経路通知 / env 廃止 / spec 更新箇所) を網羅 |
| 9 | spec を tee 設計に更新 | OK | `docs/spec/15-post-mortem-evidence.md` §2 table (L23) は「parent tee + reload は fd 注入」と書き換え / §5 (a) (L70) に「TTY 親プロセス起動時のみ」明記 / §5.1 (L76-88) 新設で reload 3 経路通知責務 / §9 D1 (L188) は parent tee 方式に改訂 |

## Findings

### Critical（GO 不可、必ず修正）
None

### Major（GO だが修正推奨）

- **`post-mortem-redirect.smoke.test.ts` の TS2769 (toBe overload mismatch)**:
  - `bunx tsc --noEmit` (実行: `cd skills/cmux-team/manager && bunx tsc --noEmit`) で以下 2 件の新規エラー:
    - `post-mortem-redirect.smoke.test.ts(59,27): error TS2769: No overload matches this call. Argument of type '42' is not assignable to parameter of type 'null'.`
    - `post-mortem-redirect.smoke.test.ts(96,27): error TS2769: ... Argument of type '0' is not assignable to parameter of type 'null'.`
  - 原因: `let exitCode: number | null = null;` (L37, L81) の control flow analysis で TS が `exitCode` の型を `null` に narrow し、bun:test の `toBe(expected: null)` overload に固定マッチしてしまう。実行時には pass する (smoke.test 2 pass / 0 fail) ため機能影響は無い
  - main 比較: stash した main 状態の tsc 出力にこの 2 行は出ない (smoke.test.ts 自体が main には無い)。`main.ts(1051,7)` / `c11-features.{ts,test.ts}` / `mailbox-cli.ts` の TS エラーは pre-existing で T013 起因ではない (main の状態でも同じ箇所が出る)
  - 修正案 (どれか 1 つ): `expect(exitCode!).toBe(42)` で non-null assertion / `let exitCode: number | undefined` で `null` を消す / `expect<number | null>(exitCode).toBe(42)` の generic 指定 / 中間変数で型を絞る
  - 影響範囲: tsc を pre-commit / CI gate に組み込んでいる運用では blocker。テスト pass のみで CI を切っているなら影響ゼロ
  - T013 のスコープ内 (新規追加ファイルの touch) のため「pre-existing として先送り」できない

### Minor（補足、必須ではない）

- **design-review n1 (signal 番号 mapping)**: 実装で対応済み。`post-mortem-redirect.ts:138-147` の `signalNumber()` が `os.constants.signals` を一次ソース、POSIX fallback (SIGINT=2 / SIGTERM=15 / SIGHUP=1) を二次ソースとして引いている。`process.binding("constants")` internal API は使用していない。テスト #3 / 追加 case (`exitCode 130 / 143`) で結果値も確認済み
- **design-review n2 (SIGHUP listener カウント差分 assert)**: 実装で対応済み。`post-mortem-redirect.test.ts:33-49` の `beforeEach` で `sighupBaseline` / `sigintBaseline` / `sigtermBaseline` を snapshot し、test L536 / L555-564 で差分 (`listenerCount - baseline`) を assert。listener pollution を防いでいる
- **design-review n3 (TTY 切断時 SIGHUP edge)**: 意図的 follow-up として `impl-notes.md` line 60 に記載。design-review 自身が「shell prompt が既に消えた後のシナリオで user は exit code を観測しないため許容」と書いており、実装側でも明示的に踏襲。`R5` リスクとしても plan.md / spec §5 (a) に書かれている
- `main.ts(1051,7)` の TS エラーは pre-existing (main の stash 状態でも同じ箇所で出ている)。T013 と無関係 (T013 の main.ts 変更は L1359-1363 の `projectRoot` 引数追加のみ)

## Test Results

```
post-mortem-redirect.test.ts        19 pass | 0 fail | 51 expect | 353ms
post-mortem-redirect.smoke.test.ts   2 pass | 0 fail |  8 expect |  85ms
reload.test.ts                       17 pass | 0 fail | 54 expect |  24ms
```

総計 38 test / 113 expect すべて pass。impl-notes.md 記載の数値と一致。

## TypeScript check

`bunx tsc --noEmit` (skills/cmux-team/manager 配下、tsconfig.json は同 dir のもの) を main / T013 working tree それぞれで実行し diff を取った:

| エラー | main | T013 working tree | 判定 |
|---|---|---|---|
| `c11-features.test.ts` / `c11-features.ts` / `mailbox-cli.ts` | あり | あり | pre-existing |
| `main.ts(1051,7): TS2322` | あり | あり | pre-existing (T013 で touch していない箇所、main.ts の T013 変更は L1359-1363 の `projectRoot` 引数追加のみ) |
| `post-mortem-redirect.smoke.test.ts(59,27) / (96,27): TS2769` | なし (ファイル不在) | あり | **T013 起因の新規エラー** (Major 参照) |
| `post-mortem-redirect.ts` / `post-mortem-redirect.test.ts` / `reload.ts` / `reload.test.ts` / `events-writer.ts` | (該当 ts エラー無し) | (該当 ts エラー無し) | OK |

新規エラーは smoke.test.ts の 2 件のみ。

## Pre-existing failure の確認

implementer が「pre-existing で T013 起因ではない」と主張している 3 ファイルについて main からの diff を取得:

```
$ git diff main -- skills/cmux-team/manager/project-root.test.ts \
                   skills/cmux-team/manager/cli-project-root.test.ts \
                   skills/cmux-team/manager/cwd-mismatch.integration.test.ts | wc -l
0
```

差分ゼロを確認。これら 3 ファイルの失敗は T013 では touch されておらず、`cmux-team` → `elevens` rename 残課題 (impl-notes.md 記載) として別タスクで一括修正される対象。

## 補足: plan 整合性 (sanity check)

- parent は signal を forward しない (`signalsToForward` DI を持たない): ✅ `MaybeRespawnOptions` に該当フィールド無し、JSDoc L65-69 に意図的不在の理由を明記
- atomic bind invariant: ✅ `post-mortem-redirect.ts:223-306` で `// ---- begin atomic bind ----` / `// ---- end atomic bind ----` の同期 block 内で `data` / `end` / `exit` を連続 bind。途中の唯一の `await` は不在 (test #11 が microtask snapshot で構造的に保証)
- backpressure: ✅ `post-mortem-redirect.ts:263-275` で `child.stderr.pause()` + `logStream.once("drain", () => childStderr.resume())`
- test-only hatch の別 export: ✅ `__maybeRespawnWithStderrRedirectForTest` (L169) と `maybeRespawnWithStderrRedirect` (L183) を分離。前者だけが `waitForChildExit?: boolean` を受け取る
- reload 経路の 3-channel 失敗通知: ✅ `reload.ts` の 3 failure path (`stderr_log_open_failed` / `spawn_threw` / `child_pid_undefined`) すべてで `logImpl` + `emitEventImpl({event:"reload_failed", ...})` を emit。heartbeat 停止は daemon exit で構造的に発生
- spec §5.1 新設 + §5 (a) TTY-only 補足: ✅ `docs/spec/15-post-mortem-evidence.md:70` (L70) と L76-88 (§5.1) を確認

## CLAUDE.md ガードレール sanity check

- `bus.emit` / `bus.on` 直接呼び出し: 該当ファイルに grep ヒット無し
- `taskState[...] =` 直書き: 該当ファイルに grep ヒット無し
- 空の `catch {}`: `post-mortem-redirect.ts` 内に複数あるが、いずれもコメントで意図 (TTY/file 書き失敗を意図的に無視、test mock 経路で pause/resume 不在の場合の no-op など) が明示されている。CLAUDE.md の「外部コマンド失敗時の detail 必須」は spawn の stderr/stdout 経路の話で、本 helper は stream 経由の TTY/file 書き込みなので適用外
- dead code / debug log / `console.log` / TODO / FIXME: T013 で touch した 5 ファイルに grep ヒット無し
- セキュリティ問題 (command injection / path traversal): `spawn(r.execPath, [r.scriptPath, ...opts.args, FLAG], ...)` の args は呼び出し元 (`cmdStart`) で構築された静的なもの。`projectRoot` は `cmdStart` 内の `PROJECT_ROOT` (resolved absolute) を流すだけ。injection 経路無し
