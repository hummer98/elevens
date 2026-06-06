# T004 実装サマリー — `elevens reset-conductor` CLI

## 概要

Conductor surface を任意の状態から `reserved` に戻す pane 単位の局所復旧 CLI を追加。観察箱原則（real-time 観察 → 介入）のサイクルを閉じる。SESSION_CLEAR running 経路と同形のシーケンスを daemon 側 `RESET_CONDUCTOR` ハンドラで実装。

## 変更ファイル一覧

### 実装ファイル (8)

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `AbortReason` union に `"reset_conductor"` を追加（"6 経路" → "7 経路" コメント更新） |
| `skills/cmux-team/manager/schema.ts` | `ResetConductorMessage` 定義 + `QueueMessage` discriminatedUnion 追加 + 型 export |
| `skills/cmux-team/manager/daemon.ts` | `handleMessage` switch に `RESET_CONDUCTOR` case 追加（CONDUCTOR_CLEAR の直後）。watcher 停止 / markTaskAborted / insertTaskSession / notifyStateChanged cascade / killClaudeProcess / resetConductor(reserved) / requestWakeup の全シーケンス |
| `skills/cmux-team/manager/main.ts` | `cmdResetConductor()` 関数追加 + `WRITE_COMMANDS` に `"reset-conductor": true` 登録 + dispatch switch 追加。出力文言は `OK reset <surface> (<oldStatus> → reserved)` |
| `skills/cmux-team/manager/i18n.ts` | `help_reset_conductor` (en/ja) + `help_main` の usage 一覧に 1 行追加（en/ja 両方） |
| `skills/cmux-team/manager/events-writer.ts` | `mapAbortReason` の switch に `"reset_conductor": → "other"` を追加（spec § 6.6 の 6 値マップ。abort_task と同じ user 主導 abort として "other" にマッピング。区別は journal の `reason=reset_conductor;` prefix で行う） |

### テストファイル (4)

| ファイル | 追加テスト |
|---|---|
| `skills/cmux-team/manager/schema.test.ts` | `QueueMessage discriminated union` describe に 3 ケース追加（RESET_CONDUCTOR が含まれる / force・reason 付きパース / surface 欠落 reject） |
| `skills/cmux-team/manager/daemon.test.ts` | 新 describe `T004 RESET_CONDUCTOR (reset-conductor CLI)` を `T250 broken status` describe の直後に追加。9 ケース（broken/disconnected/idle/reserved への reset / not_found / running・assigning に force=false で ignored / force=true で task aborted + reserved + watcher 停止 + task_sessions 行追加 / assigning + force で promptSentAt/promptBytes クリア） |
| `skills/cmux-team/manager/main.test.ts` | `TASK_UPDATED postMessage (T183)` describe の末尾に 9 ケース追加（--surface 指定 / 数字のみ受容 / CMUX_SURFACE auto-resolve / assigned + --force なしで exit 1 / --force で force=true 伝搬 / 出力文言 / surface not found / assigning・asking で reject） |
| `skills/cmux-team/manager/events-writer.test.ts` | `mapAbortReason: 8 値 → 6 値マップ全網羅` を 9 値に拡張し `["reset_conductor", "other"]` 行追加 |

## 追加・更新したテスト一覧と pass 状況

すべて pass。`bun test --timeout 30000 <file>` ループで個別実行。

| ファイル | 新規追加 | 既存 (pass) | 失敗 | スキップ |
|---|---:|---:|---:|---:|
| `schema.test.ts` (+ schema-task-state.test.ts 同一スイート) | 3 | 106 | 0 | 0 |
| `daemon.test.ts` | 9 | 217 | 0 | 2 |
| `main.test.ts` | 9 | 265 | 0 | 0 |
| `events-writer.test.ts` (task.test.ts / conductor.test.ts と同一スイート) | 1 | 200 | 0 | 3 |
| `state-machine/*.test.ts` | 0 | 250 | 0 | 0 |
| `agent-instructions / agent-strategy / events-cli / i18n / logger / queue / trace-store` (regression 確認) | 0 | 152 | 0 | 0 |

合計：新規追加 22 ケース、既存 1190 ケース全 pass。

## 受け入れ条件 6 件のチェックリスト

すべて 1 つ以上のテストが対応（design-review-rev2 Rec1 cross-check）。

| AC | 内容 | 対応テスト |
|---|---|---|
| **AC1** | `elevens reset-conductor` CLI が main.ts に追加され、help にも記載 | `main.test.ts` ▸ `reset-conductor: --surface 指定で RESET_CONDUCTOR が POST される (AC1/AC3)` / `reset-conductor: 出力文言が "OK reset <surface> (<oldStatus> → reserved)" 形式 (R8)`<br>+ `i18n.ts` `help_reset_conductor` (en/ja) と `help_main` 1 行追加（手動確認: `bun run main.ts reset-conductor --help` および `bun run main.ts --help` で正しく表示） |
| **AC2** | `--surface` 省略時に `CMUX_SURFACE` から自動解決 | `main.test.ts` ▸ `reset-conductor: CMUX_SURFACE env で auto-resolve できる (AC2)` |
| **AC3** | Manager 側で `RESET_CONDUCTOR` メッセージを処理 | `schema.test.ts` ▸ `RESET_CONDUCTOR は QueueMessage にも含まれる` 等 3 ケース<br>+ `daemon.test.ts` ▸ `T004 RESET_CONDUCTOR (reset-conductor CLI)` describe 全 9 ケース |
| **AC4** | broken / disconnected からの復旧で次の task assign が成功 | `daemon.test.ts` ▸ `RESET_CONDUCTOR で broken Conductor が reserved に戻る (AC4)` / `RESET_CONDUCTOR で disconnected Conductor が reserved に戻る (AC4)` — 後者で `isAssignableStatus(reserved) === true` を assertion し findIdleConductor で拾える状態を確認 |
| **AC5** | assigned 中の `--force` なしで reject | `daemon.test.ts` ▸ `RESET_CONDUCTOR が running Conductor に force=false で来ても無視される (force_required, AC5)` / `RESET_CONDUCTOR が assigning Conductor に force=false で来ても無視される`<br>+ `main.test.ts` ▸ `reset-conductor: assigned + --force なしで CLI が exit 1 する (AC5 CLI 側)` / `assigning Conductor も --force なしで reject` / `asking Conductor も --force なしで reject`（CLI pre-check + daemon 側の二重防御） |
| **AC6** | assigned 中の `--force` ありで task が abort され surface が reserved に戻る | `daemon.test.ts` ▸ `RESET_CONDUCTOR が running Conductor に force=true で来ると task が aborted になり surface が reserved に戻る (AC6)` — task-state.json で `taskId.status === "aborted"` / `journal が reason=reset_conductor; で始まる` (R2) / `pidWatcherInterval === undefined` + `mailboxWatcherStop` mock 呼び出し (R1) / trace DB の `task_sessions` に `event="aborted" AND role="conductor"` 行 (R3) / `conductor.status === "reserved"` を all assert<br>+ `main.test.ts` ▸ `reset-conductor: --force で message.force=true が乗る (AC6 CLI 側)` |

## 型検査結果

- `bunx tsc --noEmit` エラー数：本タスクで導入したエラーは **0 件**。
- 残った 16 行のエラーは `c11-features.{ts,test.ts}` / `mailbox-cli.ts` / `main.ts:975:7 (sleepPrevention)` の事前から存在する既知エラー。`git stash` 検証で本タスク変更前と同数（16 行）であることを確認済み。

## design-review-rev2 Recommendations の反映状況

| Rec | 反映 | 反映先 |
|---|---|---|
| Rec1: §6.1 AC マッピング表を 6 件すべて拡張 | ✅ | 本サマリーの「受け入れ条件 6 件のチェックリスト」で全 AC をマップ |
| Rec2: `markTaskAborted` 戻り値型確認 | ✅ | `task.ts:597–606` の `MarkTaskAbortedResult` に `revertedChildren: string[]` フィールドが存在することを確認。SESSION_CLEAR running 経路と同じ `const { revertedChildren } = await markTaskAborted(...)` 形で取得 |
| Rec3: `AbortReason` 型変更を RED テスト前に先行実施 | ✅ | TDD 進行で「型追加 → RED → GREEN → REFACTOR」の順を採用（Task #1 で task.ts 編集後に Task #2〜#4 で RED テスト追加） |

## design-review (rev1) Recommendations の反映状況

| Rec | 反映 |
|---|---|
| R1: pidWatcherInterval / mailboxWatcherStop の明示停止 | ✅ daemon.ts RESET_CONDUCTOR ハンドラの isAssigned 分岐冒頭で 2 ステップ実行 + daemon.test.ts assertion |
| R2: `AbortReason` に `"reset_conductor"` 追加 | ✅ task.ts + journal `reason=reset_conductor;` で識別可能 |
| R3: `task_sessions` 行追加 | ✅ daemon.ts の markTaskAborted 直後に `insertTaskSession({event:"aborted", role:"conductor", ...})` + daemon.test.ts assertion |
| R4: notifyStateChanged 明示 | ✅ `revertedChildren.length > 0` で `notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade")` |
| R5: §6.3 fixture 補強 | ✅ daemon.test.ts AC6/promptSentAt テストで task.md 本体（frontmatter 込み）+ task-state.json の両方を書き出し |
| R6: §7 step 1 のテストファイル変更 | ✅ schema.test.ts に追加（queue.test.ts ではなく） |
| R7: §8.2 (e) events.jsonl `conductor_reset` event 追加判断 | ✅ 本タスクスコープでは追加せず `hook_signals` テーブル + `mapAbortReason` で retrospective 観察を確保（events-writer.ts コメントに方針を明記） |
| R8: CLI 出力文言 | ✅ `OK reset <surface> (<oldStatus> → reserved)` 統一 + main.test.ts assertion |
| R9: §5 エッジケース表 | ✅ 仕様確定済み（R9-2 の旧 SESSION_ENDED 遅延着信は §既知の問題で言及） |

## 既知の問題・残課題

### スコープ外 / 別タスク化候補

1. **pane タブ名のリセット (task.md 仕様案 step 2c)**：既存 `resetConductor` は cmux 側 pane title を直接書き換えていない。本実装でも追加処理は入れず、`team.json` の status 変更経由で TUI 表示が更新される設計に依存。実機で「タブ名が古いまま残る」事象を確認したら別タスクで対処。
2. **events.jsonl への `conductor_reset` event 追加 (R7)**：本タスクでは見送り。`hook_signals` テーブルへの自動取込み（`RESET_CONDUCTOR` 行）と `task_sessions` の `event="aborted"` 行で retrospective 観察を確保。spec §3 改訂で event #17 として追加検討する場合は別タスク化。
3. **`assigning` + force で旧 SESSION_ENDED 遅延着信時の race (R9-2)**：`killClaudeProcess` 後に旧 claude プロセスが SESSION_ENDED を送ってから死ぬ場合、reset 済み reserved Conductor に対して SESSION_ENDED が来る。`killInProgressUntil` が `resetConductor` で `undefined` にされるため suppression window が無く、`disconnected` に倒れる可能性。実機 e2e で要観察。SESSION_CLEAR running 経路と同じ問題で、対処が必要なら両経路同時に修正。
4. **`starting` 中 reset の race**：source=startup の SESSION_STARTED が reset 完了後に到着し `reserved` を上書きする可能性。実害は小さい想定だが、観察可能性のための注記ログ `reset_during_starting` を将来追加する余地あり。
5. **`cleanupAssignedTask` 抽出 (§3.6 YAGNI 確定)**：SESSION_CLEAR / RESET_CONDUCTOR の重複（pid 退避 → killClaudeProcess → resetConductor reserved）の helper 抽出は本タスクでは見送り。差分 5 行 × 2 箇所では YAGNI（design-review §3.6 で確定）。

### 実機 e2e 確認

実機検証は本タスクの自動テスト範囲外。worktree 内で daemon を起動して以下をマニュアル確認することを推奨（plan §7 step 11）：

- broken Conductor 復旧を 1 回（`elevens reset-conductor --surface <broken_surface>` → `team.json.conductors[].status === "reserved"`）
- assigning + force での SESSION_ENDED 遅延着信時の振る舞い（R9-2）
- `starting` 中 reset で source=startup の SESSION_STARTED 後着が `reserved` を上書きしないか

### 既存型エラー (本タスク範囲外)

`c11-features.{ts,test.ts}` / `mailbox-cli.ts` / `main.ts:975:7` に事前から型エラー 16 行が残るが、いずれも本タスクとは独立した既存問題。
