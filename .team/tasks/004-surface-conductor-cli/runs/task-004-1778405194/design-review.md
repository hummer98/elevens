# T004 design review — `elevens reset-conductor` CLI

## 1. Decision

**Changes Requested**

最小 1 件の **critical**（型定義違反）と 2 件の **major**（assigned 経路の watcher クリーンアップ漏れ・観察行の欠落）を解消すれば実装着手可。残りは minor / nit。

## 2. Summary

plan.md は既存コード（特に SESSION_CLEAR 経路 daemon.ts:2756–2817 と `resetConductor` conductor.ts:699–841）の挙動をよく踏まえており、データフロー・テスト計画・エッジケースの粒度はおおむね妥当。ただし `markTaskAborted` の reason 型が strict union であること、SESSION_CLEAR running 経路が claude プロセス kill の前段で `pidWatcherInterval` / `mailboxWatcherStop` を明示停止していること、abort-task が trace DB に `task_sessions(event="aborted")` 行を追加していること——の 3 点が反映されていないため、いまの擬似コードのままでは型エラー or 残留 watcher による誤検出の余地がある。

## 3. Findings

### 3.1 既存コードとの整合（観点 1）

- **[critical] `markTaskAborted` reason 引数の型違反**
  plan.md §3.4 は `markTaskAborted(state.projectRoot, conductor.taskId, "reset_conductor", journal, ...)` と書いているが、`task.ts:577–585` の `AbortReason` は閉じた union（`"user_clear" | "judgment_pending" | "assign_failed" | "disconnect_timeout" | "abort_task" | "resume_no_session_id" | "resume_no_task_run_id" | "resume_no_worktree"`）。`"reset_conductor"` はメンバーではないため TypeScript の型チェックが通らない。本実装では (a) `AbortReason` に `"reset_conductor"` を新規追加（T290 解説コメントの "6 経路" 記載も 7 経路に更新する必要あり）するか、(b) 既存 `"user_clear"` を流用するかを **plan で決定する必要がある**。`reset` の意味論としては (a) が望ましい — `journal` 上の `reason=reset_conductor;` prefix で `abort-task` / SESSION_CLEAR / reset を後追い区別できる利点が大きい。

- **[major] queue protocol 流儀の表記訂正は plan §2.2 に既に書かれているが、AC §3 の元タスクスペックは "`.team/queue/incoming/` 流儀" と書いている**
  plan §2.2 が「実装上は HTTP POST に統一」と明記している点は正しい（main.ts:2075–2088, postMessage)。タスク説明書 (.team/tasks/004-surface-conductor-cli/task.md L30) との齟齬は plan で解決済みなので OK だが、design-review 完了後の Implementer が task.md を見て混乱しないよう plan §2.2 の脚注に "task.md の queue file 表記は時代遅れの記述で、本実装は HTTP POST を採用" の一文を追記する余地はある（nit）。

### 3.2 責務分離（観点 2）

- **[ok] CLI / queue / daemon handler / conductor.ts の境界は clean**
  `cmdResetConductor` が pre-check + postMessage に専念し、daemon が abort+kill+reset を集約、`resetConductor` がそのまま流用されている。SESSION_CLEAR とほぼ対称な構造で違和感なし。

- **[minor] `cleanupAssignedTask` (main.ts:4931–4981) との重複検討は §7 step 8 にあるが優先度を明記したほうがよい**
  `cleanupAssignedTask` は CLI プロセス側で `process.kill` / git worktree remove / branch delete を **重複実装** している（resetConductor が daemon 側で同じことをやる）。plan §7 step 8 でこれと daemon 側 reset を helper 統合する余地に触れているが、**本タスクでは抽出せず** (YAGNI、§8.2 (b) と整合) で確定し、その意思決定を §3 か §8 に明記して欲しい（実装者がリファクタに引きずられないため）。

### 3.3 state machine 整合（観点 3）

- **[ok] `reserved` 復帰先の選択は spec L26 / L118 / L124 と整合**
  `docs/spec/07-state-machine.md` の `reserved` 定義（"pane だけ作成・claude 未起動"）と、`isAssignableStatus(s)` (schema.ts:455) が `idle || reserved` を返す事実を踏まえると、reset 後に `findIdleConductor` で拾える経路は確実に閉じる。

- **[minor] `error` / `starting` を「常に許可」グループに入れる根拠の補強**
  plan §5 で `status==="error"` (StopFailure 後) と `status==="starting"` を `--force` 不要グループに入れている。これは `assignTask` 直前の暫定状態であり「assigned ではない」という意味で正しいが、`starting` を reset すると進行中の cmdSpawnConductor の SESSION_STARTED が遅れて飛んでくる race がある（`SessionStartedMessage` の `source: "startup"` を受けた直後に reset 済み conductor.status=`reserved` を上書きされかねない）。挙動は壊れないが、daemon 側 `case "SESSION_STARTED"` での source=startup ハンドリングが「reset 済 reserved」を `disconnected` 検出に倒さないか、実装時に最低限ログで観測できる仕組み（`reset_during_starting` のような注記ログ）を入れることを Recommendation §4 で提案する。

### 3.4 assigned + force の経路（観点 4）

- **[major] `pidWatcherInterval` と `mailboxWatcherStop` の明示停止が plan §3.4 から欠落**
  daemon.ts:2784–2792 で SESSION_CLEAR の running 経路は `killClaudeProcess` の **前段** で `pidWatcherInterval` を `clearInterval` し、`mailboxWatcherStop()` を呼んでいる。これは「pid kill 後に watcher が pid 死亡を検知して `disconnected` に倒す」誤検出を防ぐためのセマンティクスで、`resetConductor` 内ではクリアされない（`conductor.ts:798–816` を参照、これらフィールドは触られていない）。RESET_CONDUCTOR の assigned 経路でも **同じ 2 ステップを `markTaskAborted` の後・`killClaudeProcess` の前に挿入する必要がある**。`isAssigned && conductor.taskId` ガードの内側だけでなく、`isAssigned` に該当する全ケース（assigning も含む）でクリアするのが安全。

- **[major] `task_sessions` trace DB 行の追加が漏れている**
  abort-task は `markTaskAborted` の後に `insertTaskSession(db, {role:"conductor", event:"aborted", task_run_id, session_id, surface})` を入れている（main.ts:5106–5120）。これは観察箱の retrospective 観察軸（CLAUDE.md "AI Observatory" §retrospective）で task lifecycle を再構成するための重要な signal。RESET_CONDUCTOR の force 経路でも daemon 側で同等の insertion を入れる方針が望ましい（cohort 比較で `event="aborted"` の reason を `task_sessions` ではなく `hook_signals` / `events.jsonl` 側で区別する設計でも可）。plan §3.4 と §6 のテスト計画にこれが反映されていない。

- **[minor] markTaskAborted 後の `notifyStateChanged` 明示**
  SESSION_CLEAR running 経路は `revertedChildren.length > 0` のとき `notifyStateChanged("daemon.ts:handleMessage:session-clear-cascade")` を明示的に呼ぶ（daemon.ts:2778–2779）。これは cascade で子 task が draft に巻き戻った瞬間を TUI に即時反映するため。plan §3.4 ではこれが省略されているが、`resetConductor` 内の `notifyStateChanged("conductor.ts:resetConductor:status-...")` で結果的にはカバーされる。ただし呼び出しタイミングが cascade 後 → kill+reset 後にズレるので、SESSION_CLEAR と同形にする方が予測可能（plan §3.4 に 1 行追記推奨）。

- **[minor] CLI pre-check の判定を team.json 由来 `conductor.status` で行うが、真値は task-state.json**
  plan §3.2 step 6 は `team.json.conductors[].status` を見て assigned か判定しているが、`status==="assigning"` は `task-state.json` を更新する前にセットされる場合があり、**真値は `task-state.json[taskId].status === "assigned"`**。team.json は daemon の snapshot なので 数 ms 遅れる可能性がある。daemon 側でも再判定するため race 自体は壊れないが、CLI 側で偽陰性（force 不要扱いで通って daemon で reject される）になる場合がある。pre-check は UX 向上の best-effort として現状のままで OK。Recommendation §4 でこのトレードオフを plan に明記することを提案。

### 3.5 テスト計画の妥当性（観点 5）

- **[ok] AC → テスト対応の粒度・mock 戦略は実装可能**
  daemon.test.ts:3178–3288 の CONDUCTOR_CLEAR テスト群（`paneSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1")` パターン）と main.test.ts:749–921 の `runCli` + mock HTTP server パターンがそのまま流用できる。

- **[minor] schema 追加テストの配置先**
  plan §6.2 / §7 step 1 は `queue.test.ts` に schema 検証テストを追加するとあるが、`schema.test.ts` の方が discriminated union 系テストの正規の配置場所（既存 describe ブロック L82 "QueueMessage discriminated union"、L461 "QueueMessage T379 messages are included"）。`schema.test.ts` に置くのが自然 — `queue.test.ts` は queue file の write/read 動作の統合テスト用。

- **[minor] markTaskAborted を実際に動かすテストの fixture 整備**
  plan §6.3 が `task-state.json` に `taskId.status="assigned"` を事前書きしておく必要があると正しく指摘している。さらに `markTaskAborted` は task.md frontmatter から status / journal を読むので **task.md ファイル本体も併設する必要がある**（main.test.ts:759–772 の `setupTeamDir` と同等）。これを §6.3 mock セクションに明記すること。

- **[major] `pidWatcherInterval` / `mailboxWatcherStop` のテストカバレッジが計画にない**
  上記 §3.4 の major と対応。force=true 経路で watcher が確実に停止することを assertion する test（spawnPidWatcher / spawnConductorMailboxWatcher を spy / mock して呼び出し回数を検証、もしくは `conductor.pidWatcherInterval === undefined` を確認）が必要。AC §6 の中の "force=true で task が aborted になり surface が reserved に戻る" テストで併せて検証可能。

- **[minor] CLI side pre-check の reject 経路 (assigned + 非 force) が exit 1 することを確認するテストは plan §6.2 にあるが、daemon 側でも同じ reject ログが出ることを確認するテスト**
  二重防御の整合性が取れているかを担保するため。`grep "reason=force_required" .team/logs/manager.log` 相当の assertion を daemon.test.ts に入れる。

### 3.6 エッジケース漏れ（観点 6）

- **[ok] plan §5 の表は包括的**
  claude pid 既死亡 / surface 不在 / queue 競合 / 連続 RESET_CONDUCTOR / `taskId === undefined` race 等を網羅。

- **[minor] `RESET_CONDUCTOR` と並行する `TASK_CREATED` の race**
  reset 中に新タスクが ready になり scanTasks が走った場合、reset 完了前の Conductor (status=running, force=true 経路) が `findIdleConductor` で対象外なので race にはならない。reset 完了 → status=reserved → 次 tick で scanTasks が拾う、という確定的順序になる（HTTP message が逐次処理される前提）。これを plan §5 の表に 1 行追記すると安心。

- **[minor] `--force` で reset した直後の旧 SESSION_ENDED / NOTIFICATION の遅延着信**
  `killClaudeProcess` 後に旧 claude プロセスが SESSION_ENDED を送ってから死ぬ場合、reset 済み reserved Conductor に対して SESSION_ENDED が来る。`killInProgressUntil` が `resetConductor` で `undefined` にされる（conductor.ts:805）ので suppression window がないと `disconnected` 倒れの可能性。SESSION_CLEAR running 経路はどうしているか実機 e2e で確認することを §7 step 10 に追加してほしい。

- **[minor] `assigning` 中 force の prompt 配信ログ残留**
  plan §8.1 で言及されているが、テスト計画に「`assigning` 状態で force=true を撃った場合に `promptSentAt` / `promptBytes` が `resetConductor` でクリアされていることを assertion する」テストが無い。conductor.ts:800–801 で実際にクリアされるので、その動作を 1 ケースに足すと state 整合の保証が増える。

### 3.7 プロンプト編集ルール（観点 7）

- **[ok] テンプレート変更は不要**
  本タスクは CLI / daemon / schema / i18n / test の追加であり、`skills/cmux-team/templates/*.md` への変更は無い。plan も何も触れていない（正しい）。CLAUDE.md の "プロンプト編集ルール" 違反は無い。

### 3.8 観察箱原則との整合（観点 8）

- **[major] 観察箱原則と関連: `task_sessions` 追加（§3.4 major と重複） + `events.jsonl` 新 event 検討**
  本タスクは "real-time 観察 → 介入 のサイクルを閉じる" のがゴール（task.md L65–67）なので、介入したこと自体が retrospective 観察可能になっていることが望ましい。具体的には:
  - `task_sessions` 行（前述、observability 重要）
  - `events.jsonl` への `conductor_reset` event の追加検討。現行 16 event には reset がなく、§3 spec 改訂で event #17 として追加する余地あり。本タスクスコープに含めるか、別タスクで議論するかを plan §8.2 に追記してほしい。`hook_signals` テーブルに `RESET_CONDUCTOR` 行は自動で入る（daemon.ts:1524–1530 の hook_signal pipeline）ので最低限の trace は確保される — events.jsonl まで必要かはトレードオフ。

- **[ok] journal entry の prefix `[reset-conductor] reset by user: surface=...`**
  `markTaskAborted` の `reason=reset_conductor; [reset-conductor] reset by user: surface=...` 形式（前述 critical 修正後）は task-state.json の journal で明示的に区別可能になり後追い grep に資する。

## 4. Recommendations

plan.md に以下の差し替え/追記を提案する。

### R1. §3.4 daemon ハンドラ擬似コードに pid watcher / mailbox watcher 停止を追加

`isAssigned` 分岐（`markTaskAborted` 呼び出し直後・`killClaudeProcess` の直前）に SESSION_CLEAR 同形のクリーンアップを挿入:

```ts
if (isAssigned) {
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }
  if (conductor.mailboxWatcherStop) {
    try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }
    conductor.mailboxWatcherStop = undefined;
  }
}
```

### R2. §3.4 と §6 で `markTaskAborted` reason 型の方針を明記

`AbortReason` union に `"reset_conductor"` を追加（`task.ts:577–585`）。T290 コメント "6 経路" を "7 経路" に更新。テスト assertion で journal が `reason=reset_conductor;` で始まることを確認。

代替: `"user_clear"` を流用（実装は楽だが SESSION_CLEAR と grep で区別できなくなる — 観察箱原則上は前者推奨）。

### R3. §3.4 と §6 で task_sessions 行追加

daemon 側で force 経路成功時に `insertTaskSession({event:"aborted", role:"conductor", surface, task_run_id, session_id})` を入れる。abort-task との対称性を保つ。テストは `daemon.test.ts` で trace DB を読み戻して 1 行 assertion で十分。

### R4. §3.4 で `notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade")` を `markTaskAborted` 後に明示

revertedChildren > 0 のとき、SESSION_CLEAR と同パターンで明示呼び出し。

### R5. §6.3 で fixture 仕様を補強

`task.md` 本体（frontmatter）と `task-state.json` の両方を test setup で書き出すこと（既存 main.test.ts:759–772 `setupTeamDir` 風）を明記。

### R6. §7 step 1 のテストファイルを `schema.test.ts` に変更

`schema.test.ts` の "QueueMessage discriminated union" describe 群に追記する。

### R7. §8.2 (e) を新設: events.jsonl への `conductor_reset` event 追加判断

本タスクで追加するか別タスクで議論するかを user に確認する未解決事項として明記。判断は `hook_signals` テーブルの自動取込みで足りるかどうかで決める。

### R8. §3.2 step 8 の CLI 出力文言を `cmdClearConductor` 流に統一

`OK reset ${normalizedSurface} (${oldStatus} → reserved)` に変更（`oldStatus` は team.json から読み込んだ pre-check 時点の値）。

### R9. §5 のエッジケース表に 2 行追加

| `RESET_CONDUCTOR` と並行 `TASK_CREATED` | reset 完了 → reserved → 次 tick で scanTasks が拾う（race 無し） |
| `assigning` + force で旧 SESSION_ENDED 遅延着信 | `disconnected` に倒れる可能性。実機 e2e 確認項目に追加 |

## 5. Approved as-is items

以下は plan 通りで OK。実装者は迷わず進めて良い。

- **§2.1 / §2.2 / §2.3** 既存コードのシンボル一覧・HTTP POST 統一の指摘・SESSION_CLEAR 前例の踏襲方針はすべて正確
- **§3.1** `ResetConductorMessage` を `ConductorClearMessage` の直後に置き `QueueMessage` discriminatedUnion + `export type` 群に追加する配置設計
- **§3.2** WRITE_COMMANDS 登録 / dispatch switch / `surface:` プレフィクス正規化 / `requireArg` `getArg` `hasFlag` ヘルパー流用方針
- **§3.3** i18n.ts への `help_reset_conductor` (en/ja) + `help_main` 1 行追加
- **§3.4** daemon ハンドラの全体構造（R1〜R4 を反映後）— `state.conductors.get(message.surface)` → not_found 早期 break → assigned 判定 → markTaskAborted → kill+reset → requestWakeup の流れ
- **§3.5** pane タブ名は本タスクスコープ外で実機確認後に別タスク化する判断
- **§4** データフロー図は正確（kill+spawn 経路へつながる遷移を明示している）
- **§5** エッジケース表は包括的（force race / pid undefined / 連続発行 / 冪等性の議論を含む）。R9 の 2 行追加で完成
- **§7** TDD 順序（RED → GREEN → REFACTOR）と全体 `bun test` 禁忌の遵守
- **§8.1** リスク列挙（pane タブ名・asking 中 force の context 破棄・assigning race・partial recovery）
- **§8.2 (a) (b) (c) (d)** 未解決事項の列挙と防御方針（特に Master surface 誤指定の弾き方は `team.json.conductors[]` フィルタで自然に対応できる正しい設計）

---

レビュー終了。R1〜R9 を plan.md に反映後、Implementer に渡せる状態になる。
