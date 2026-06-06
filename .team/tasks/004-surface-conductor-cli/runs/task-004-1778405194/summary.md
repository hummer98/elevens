# T004 サマリー — `elevens reset-conductor` CLI

## 概要

Conductor surface を任意の状態（broken / disconnected / reserved / idle / running / assigning 等）から `reserved` に戻す pane 単位の局所復旧 CLI を追加。observation box 原則（real-time 観察 → 介入）のサイクルを閉じる。

## 完了したサブタスク

| Phase | 内容 | 結果 |
|---|---|---|
| Phase 1 | Planner Agent で plan.md 作成 | 277 行、AC マッピング・データフロー・テスト計画含む |
| Phase 2 (rev1) | Design Reviewer | Changes Requested（critical 1 / major 2 / minor 多数） |
| Phase 1 (rev2) | Planner で R1〜R9 反映 | 378 行に拡張、Revision History 付き |
| Phase 2 (rev2) | Design Reviewer 再査読 | **Approved**（minor 3 件は実装中に補正推奨） |
| Phase 3 | Implementer で TDD 実装 | 8 実装ファイル + 4 テストファイル更新、新規 22 テスト全 pass |
| Phase 4 | Inspector | **GO**（critical 0 / major 0 / minor 2 / nit 2、blocker なし） |

## 変更ファイル一覧（10 ファイル / +733/-4 行）

### 実装ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `AbortReason` union に `"reset_conductor"` 追加（"6 経路 → 7 経路" コメント更新） |
| `skills/cmux-team/manager/schema.ts` | `ResetConductorMessage` schema + `QueueMessage` discriminatedUnion 追加 + 型 export |
| `skills/cmux-team/manager/daemon.ts` | `handleMessage` switch に `RESET_CONDUCTOR` case 追加。watcher 停止 → markTaskAborted → insertTaskSession → notifyStateChanged cascade → killClaudeProcess → resetConductor(reserved) → requestWakeup の全シーケンス |
| `skills/cmux-team/manager/main.ts` | `cmdResetConductor()` 追加、`WRITE_COMMANDS` 登録、dispatch switch 追加。出力文言 `OK reset <surface> (<oldStatus> → reserved)` |
| `skills/cmux-team/manager/i18n.ts` | `help_reset_conductor` (en/ja) + `help_main` の usage 一覧に追加 |
| `skills/cmux-team/manager/events-writer.ts` | `mapAbortReason` の switch に `"reset_conductor": → "other"` を追加 |

### テストファイル

| ファイル | 追加 |
|---|---:|
| `schema.test.ts` | 3 ケース |
| `daemon.test.ts` | 9 ケース |
| `main.test.ts` | 9 ケース |
| `events-writer.test.ts` | 1 ケース |
| 合計 | **22 ケース** |

## テスト結果

`bun test --timeout 30000 <file>` 個別実行：**810 pass / 5 skip / 0 fail**（skip は本タスク由来でない既存 skip）

## 受け入れ条件チェックリスト

| AC | 内容 | 対応テスト | 結果 |
|---|---|---|---|
| AC1 | `elevens reset-conductor` CLI が main.ts に追加され help にも記載 | `main.test.ts` 各種 + i18n.ts | ✅ |
| AC2 | `--surface` 省略時 `CMUX_SURFACE` から自動解決 | `main.test.ts` ▸ CMUX_SURFACE auto-resolve | ✅ |
| AC3 | Manager 側で `RESET_CONDUCTOR` を処理 | `schema.test.ts` 3 + `daemon.test.ts` 9 | ✅ |
| AC4 | broken / disconnected からの復旧で次の task assign が成功 | `daemon.test.ts` ▸ broken/disconnected → reserved + `isAssignableStatus` 確認 | ✅ |
| AC5 | assigned 中の `--force` なしで reject | `daemon.test.ts` + `main.test.ts`（CLI 側 + daemon 側の二重防御） | ✅ |
| AC6 | assigned + `--force` ありで task abort + reserved | `daemon.test.ts` + `main.test.ts`（journal `reason=reset_conductor;` / pidWatcher 停止 / task_sessions 行 / status=reserved） | ✅ |

## 型検査

`bunx tsc --noEmit`: **本タスク由来エラー 0 件**。残 16 行は既存（`c11-features.{ts,test.ts}` / `mailbox-cli.ts` / `main.ts:975:7`）で本タスク前と同数。

## design-review Recommendations の反映

| Rec | 内容 | 反映 |
|---|---|---|
| R1 | pidWatcherInterval / mailboxWatcherStop の明示停止 | ✅ daemon.ts isAssigned 分岐 + assertion |
| R2 | `AbortReason` に `"reset_conductor"` 追加 | ✅ task.ts + journal prefix |
| R3 | `task_sessions` event="aborted" 行追加 | ✅ daemon.ts + assertion |
| R4 | `notifyStateChanged` 明示 | ✅ revertedChildren > 0 で cascade reason 明示 |
| R5 | fixture 補強（task.md 本体 + task-state.json） | ✅ |
| R6 | schema テスト配置先を schema.test.ts に | ✅ |
| R7 | events.jsonl `conductor_reset` event 判断 | 本タスクスコープ外（hook_signals + mapAbortReason で trace 確保） |
| R8 | CLI 出力文言統一 | ✅ |
| R9 | エッジケース表 2 行追加 | ✅ |

## マージコミット / PR URL

- マージ方式: ローカル ff-only merge into `main`
- マージコミット: `d567f2ab5b79eb82489db497404a81513d648361`
- ブランチ: `task-004-1778405194/task`

## 既知の問題・残課題

1. **pane タブ名のリセット**: 既存 `resetConductor` は cmux 側 pane title を直接書き換えていない。実機でタブ名残留を確認したら別タスク化
2. **events.jsonl への `conductor_reset` event 追加 (R7)**: 本タスクでは見送り。`hook_signals` + `task_sessions` で retrospective 観察を確保
3. **`assigning` + force で旧 SESSION_ENDED 遅延着信時の race (R9-2)**: SESSION_CLEAR running 経路と同問題。実機 e2e で要観察
4. **`starting` 中 reset の race**: source=startup の SESSION_STARTED 後着が `reserved` を上書きする可能性。観察用注記ログ `reset_during_starting` 追加余地
5. **`cleanupAssignedTask` 抽出**: SESSION_CLEAR / RESET_CONDUCTOR の重複は YAGNI 判断で見送り

## Inspector findings（追加修正なし）

- minor 1: CLI 内の `team.json` parse error 詳細握りつぶし（既存 `cmdClearConductor` と同パターン、blocker でない）
- minor 2: help テキスト自動テストなし（既存 `help_clear_conductor` 同等扱い、AC1 で明文化されていない）
- nit 1: daemon.test.ts AC6 で trace DB 後付け代入（テストヘルパー都合）
- nit 2: `assigned` 系判定の 2 箇所重複（二重防御で意図的、YAGNI と整合）
