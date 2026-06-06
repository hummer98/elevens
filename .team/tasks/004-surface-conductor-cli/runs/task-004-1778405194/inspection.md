# T004 Inspection — `elevens reset-conductor` CLI

## Decision

**GO**

## Summary

設計（plan.md / design-review-rev2.md）通りの実装で、SESSION_CLEAR running 経路と完全対称な watcher 停止 / `markTaskAborted("reset_conductor")` / `task_sessions` 行追加 / `notifyStateChanged` cascade / `killClaudeProcess` / `resetConductor(reserved)` シーケンスが daemon に入っている。AC 6 件は全てテストで cover され、回帰テスト・型検査ともに本タスク由来のエラーは 0 件。critical / major 無し、minor / nit のみ。

## AC ごとのチェック結果

| AC | 内容 | 対応テスト | カバー範囲 |
|---|---|---|---|
| **AC1** | `elevens reset-conductor` CLI が main.ts に追加され help にも記載 | `main.test.ts` ▸ `reset-conductor: --surface 指定で RESET_CONDUCTOR が POST される (AC1/AC3)` / `reset-conductor: 出力文言が "OK reset <surface> (<oldStatus> → reserved)" 形式 (R8)` | コマンド存在 + dispatch + 出力文言 ✅。help テキスト本体（`help_reset_conductor` 追加・`help_main` usage 1 行追加）の自動テストは無く手動確認に委ねている（既存 `clear-conductor` 等と同等扱い）。WRITE_COMMANDS にも登録済み (main.ts:301)。 |
| **AC2** | `--surface` 省略時に `CMUX_SURFACE` から自動解決 | `main.test.ts` ▸ `reset-conductor: CMUX_SURFACE env で auto-resolve できる (AC2)` | env 注入版 `runCliEnv` で `CMUX_SURFACE=surface:201` を渡し `receivedMessages[0].surface` を assert ✅ |
| **AC3** | Manager 側で `RESET_CONDUCTOR` を処理 | `schema.test.ts` 3 ケース + `daemon.test.ts` `T004 RESET_CONDUCTOR (reset-conductor CLI)` describe 全 9 ケース | `QueueMessage` discriminatedUnion 互換 + handleMessage の各分岐 ✅ |
| **AC4** | broken / disconnected からの復旧で次の task assign が成功 | `daemon.test.ts` ▸ `RESET_CONDUCTOR で broken Conductor が reserved に戻る (AC4)` / `RESET_CONDUCTOR で disconnected Conductor が reserved に戻る (AC4)` | conductor.status==="reserved" / taskId/taskRunId/pid undefined / `isAssignableStatus(reserved)===true` を assert（assign 経路全体の e2e ではないが「次 tick で findIdleConductor が拾う前提条件」は確認できている）✅ |
| **AC5** | assigned 中の `--force` なしで reject | `daemon.test.ts` ▸ `running force=false で無視される (force_required, AC5)` / `assigning force=false で無視される` + `main.test.ts` ▸ assigned + --force なしで CLI exit 1 / assigning / asking 各 reject | CLI pre-check + daemon 側の二重防御を両方 cover ✅ |
| **AC6** | assigned + `--force` ありで task abort + reserved | `daemon.test.ts` ▸ `running force=true で task が aborted になり surface が reserved に戻る (AC6)` + `main.test.ts` ▸ `--force で message.force=true が乗る` | task-state.json ▸ taskId.status==="aborted" / journal が `reason=reset_conductor;` で始まる (R2) / pidWatcherInterval undefined + mailboxWatcherStop spy 呼出 (R1) / trace DB の `task_sessions` に event="aborted" AND role="conductor" 行 (R3) / conductor.status==="reserved" + taskId/taskRunId/pid undefined をすべて assert ✅ |

## テスト実走結果

`cd skills/cmux-team/manager && bun test --timeout 30000 <file>` で個別実行。

| ファイル | pass | skip | fail | expect calls |
|---|---:|---:|---:|---:|
| `schema.test.ts` (+ schema-task-state.test.ts) | 109 | 0 | 0 | 199 |
| `daemon.test.ts` | 226 | 2 | 0 | 791 |
| `main.test.ts` | 274 | 0 | 0 | 746 |
| `events-writer.test.ts` | 20 | 0 | 0 | 154 |
| `task.test.ts` + `conductor.test.ts` (regression) | 181 | 3 | 0 | 418 |

合計：810 pass / 5 skip / **0 fail**。skip は本タスク由来ではない既存 skip。

## 型検査結果

`bunx tsc --noEmit` 出力：**16 行**。

| 由来 | 行数 | 内訳 |
|---|---:|---|
| 本タスク由来 | **0** | 新規追加した `task.ts` / `schema.ts` / `daemon.ts` / `main.ts (cmdResetConductor 周辺)` / `i18n.ts` / `events-writer.ts` のいずれにもエラーなし |
| 既存（本タスク前から） | 16 | `c11-features.{ts,test.ts}` (4 行) / `mailbox-cli.ts` (3 行) / `main.ts:975:7 sleepPrevention` (1 行) ほか。impl-summary §「型検査結果」で git stash 検証済みと明記 |

## Findings

### [minor] CLI 内の team.json parse error 詳細を握りつぶしている

**箇所**: `main.ts:cmdResetConductor` 内の
```ts
try { teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8")); }
catch { console.error("Error: team.json unreadable"); process.exit(1); }
```

`e?.message` を含めずに「unreadable」とだけ出している。CLAUDE.md 実装ルール「外部コマンド失敗時は stderr/stdout を必ず detail に含める」は外部コマンド向けで、JSON.parse 失敗は厳密には対象外だが、observability の観点では parse error 内容を残せると trouble-shoot しやすい。`cmdClearConductor` も同様のフォールバックパターンなので本タスクの blocker ではない。

### [minor] AC1 の help テキスト本体（`help_reset_conductor` / `help_main` 追加分）に自動テストが無い

i18n.ts への追加は impl-summary §「受け入れ条件 6 件のチェックリスト」で手動確認に委ねられている。`help_clear_conductor` 等の前例も同等扱いだが、`expect(t("help_reset_conductor")).toContain("reset-conductor")` 程度の最小 i18n 完備テストは i18n.test.ts 又は main.test.ts に追加できる余地がある。本タスクの受け入れ条件 AC1 は「help にも記載される」までで、自動 assertion は明文化されていないので reject 理由には当たらない。

### [nit] daemon.test.ts AC6 テストでの trace DB 後付け代入

```ts
state.traceDb = initDB(testDir);
```

`createDaemon(testDir)` 戻り値の `state.traceDb` を後から再代入している。テスト fixture として動作しており全 assertion pass しているが、本来 daemon の初期化経路で trace DB が生成される設計と差分がある（テストヘルパー側の都合）。実装そのものへの影響は無い。

### [nit] `assigned` 系の判定列挙が 2 箇所に独立して書かれている

- `main.ts:cmdResetConductor` (`oldStatus === "assigning" || oldStatus === "running" || oldStatus === "asking"`)
- `daemon.ts:case "RESET_CONDUCTOR"` 内の `isAssigned` 同形定義

二重防御で意図的に独立した判定にしているが、`isAssignedStatus(s: ConductorStatus)` のような predicate を `schema.ts` に置くと新状態が増えたときの保守性が向上する。本タスクスコープでは plan §3.6 の YAGNI 判断と整合し refactor 見送りで OK。

### [ok] ガードレール違反なし

- 空 catch は `try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }` のみで、SESSION_CLEAR 既存パターンと同一形式（`/* best-effort */` コメント付き）。他の catch は `await log("error", ...)` でエラー詳細を残している。
- `bus.emit` / `bus.on` 直接呼び出し無し、`notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade")` 経由のみ ✅
- `taskState[..] =` / `saveTaskState(` の直接書き込みは daemon.ts / main.ts のいずれにも無し。`markTaskAborted` 経由のみで task-state を更新 ✅
- `cmux tree(workspace)` / `validateSurface` の workspace 省略は本実装スコープ外（reset-conductor は cmux tree を直接呼ばない）

### [ok] 観察箱原則と整合

- `hook_signals` には `RESET_CONDUCTOR` 行が daemon.ts:1524–1530 の signal pipeline で自動取込み（追加実装不要）
- `task_sessions` に `insertTaskSession({event:"aborted", role:"conductor", surface, task_run_id, session_id})` を `markTaskAborted` 直後に追加。retrospective 観察軸（cohort 比較・task lifecycle 再構成）に資する ✅
- journal の `reason=reset_conductor;` prefix で `abort_task` / SESSION_CLEAR / reset を grep 区別可能（R2 採用済み）✅
- `events.jsonl` の `conductor_reset` event 追加は §8.2 (e) / R7 で本タスクスコープ外と判断済み（`hook_signals` + `mapAbortReason → "other"` で最低限 trace 可能）

### [ok] CLI の動作

`main.test.ts` の追加 9 ケースで以下を網羅：
- `--surface` フラグ伝搬（`200` / `surface:200` 双方の正規化）
- `CMUX_SURFACE` env 自動解決
- `--force` フラグ伝搬（POST body の `force: true`）
- exit 1 経路（assigned + 非 force）×3（running / assigning / asking）
- 出力文言（`OK reset surface:204 (broken → reserved)`）
- 異常系（surface が team.json に不在）

CLI 引数 / env / 出力文言 / exit code すべてを試している ✅

## 判定根拠

- critical: **0 件**
- major: **0 件**
- minor: 2 件（CLI parse error 詳細欠落 / help 自動テストなし）
- nit: 2 件（trace DB 後付け代入 / 列挙の重複）

判定基準「critical 1 件 or major 2 件以上 → NOGO」に該当せず、minor / nit のみのため **GO**。findings は Conductor 判断に委ねる。
