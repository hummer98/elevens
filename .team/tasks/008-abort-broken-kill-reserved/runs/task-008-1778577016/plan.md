---
task: T008
title: abort 経路で broken 化させない (kill→reserved 統一)
author: surface:265 (planner)
created: 2026-05-12
---

# 実装計画書

## 1. 概要

`elevens abort-task` で停止した Conductor が、その後 5 分間放置されると `conductor_disconnect_timeout` → `conductor_broken reason=disconnect_timeout` に勝手に遷移してしまうバグを解消する。`broken` 本来の意味は **異常状態** (`disconnect_timeout` / `launch_failed` / `worktree_missing` / `unmatched` 等) であり、ユーザー主導の正常 abort で生成されるべきではない。観察箱としての metrics 解析で「abort 由来の broken」を異常源と誤検出してしまうため、構造的にも broken を生まないように倒すことが必要。

根本原因は `cmdAbortTask` (CLI 側) が Conductor の PID へ直接 SIGTERM を送り、daemon 側がその死を「予期せぬ disconnect」と見なしてしまうことにある。T004 で `RESET_CONDUCTOR` 経路に導入済みの「**watcher 停止 → markTaskAborted → kill → reserved**」シーケンス (`daemon.ts:1646-1755`) と `SESSION_CLEAR running` 経路 (`daemon.ts:2868-2929`) は既に同形のパターンで運用されており、abort-task だけが古い「外部から kill して fire-and-forget」モデルに取り残されている状態である。

修正方針はタスク本文で推奨されている **A 案**: `cmdAbortTask` から daemon に新規 `ABORT_TASK` メッセージを投げ、kill / state 更新 / trace DB 書き込み / cleanup を全て daemon 側に集約する。これにより (a) `pid_watcher` が誤発火する前に watcher を確実に停止できる、(b) `targetStatus: "reserved"` への遷移を一箇所で完結できる、(c) CLAUDE.md「決定論的なものはコードで、判断が必要なものは AI で」「silent state mutation を作っていない」「state を外部化」の原則と整合する。

## 2. 現状コード調査

### 2.1 `cmdAbortTask` の現状フロー (`main.ts:5096-5200`)

抜粋した責務 (実行順):

| # | 行 | 処理 | 備考 |
|---|---|---|---|
| 1 | 5099-5105 | `resolveCanonicalTaskId` で taskId を正規化 | T291: 不明なら exit 1 |
| 2 | 5117-5123 | `loadTaskState` で `status === "assigned"` のみ受理 | |
| 3 | 5125-5150 | `team.json` から該当 Conductor を引く | 不在なら `markTaskAborted` + `TASK_UPDATED` を投げて早期 return (no-conductor path) |
| 4 | 5153 | **`cleanupAssignedTask(conductor)` を呼ぶ** | sub-agent surface close, `process.kill(conductor.pid, "SIGTERM")`, worktree/branch 削除 (main.ts:4922-4982) |
| 5 | 5156-5161 | `abort_signal_sent` ログを **CLI プロセスから** emit | `method=sigterm pid=...` 形式 |
| 6 | 5165 | `markTaskAborted(reason="abort_task")` | journal を書き込み、cascade と events.jsonl emit (`task.ts:634-708`) |
| 7 | 5168-5182 | `insertTaskSession(event="aborted")` | trace DB に直接 INSERT (CLI が直接 DB を開いて閉じる) |
| 8 | 5184-5192 | `postMessage CONDUCTOR_DONE` (success: false) | daemon 側 handler の挙動は次節 |
| 9 | 5195-5197 | Conductor pane に `elevens spawn-conductor` 起動コマンドを直送 | session-id を CLI 側で再発行する設計 |

**問題点**:
- **(4) で外部から SIGTERM を送るが daemon は知らない**。pid_watcher (`daemon.ts:spawnPidWatcher` 系) が独立に `pid_dead` を検出して `conductor_disconnected` を発行 (`daemon.ts:2333-2454` 周辺の SESSION_ENDED + pid_watcher 経路)。
- **(8) の CONDUCTOR_DONE は no_task ガード or 既に disconnected に倒れた conductor 相手では effective に処理されない**。実観測 (タスク本文の再現ログ) でも `conductor_disconnected → 5 分後 disconnect_timeout → broken` と進む。
- **(9) の手動 re-spawn は不要になる**: A 案では daemon が `reserved` に倒すので、`findIdleConductor` (`daemon.ts:3420`) が次 tick で reserved を拾って通常の `spawn-conductor-cli` 経路で session を立ち上げる (`daemon.ts:1941-1967` の reserved → idle 遷移 + `requestWakeup`)。
- **(7) で CLI が trace DB を直接開いている**: T004 では daemon 側で `state.traceDb` を使って書く (`daemon.ts:1713-1727`)。abort-task もこちら側に揃えると DB 接続管理が一元化する。

### 2.2 `RESET_CONDUCTOR` handler — 正解シーケンス (`daemon.ts:1646-1755`)

T004 で導入された「kill するなら reserved に倒し、watcher を先に止めて誤検出を防ぐ」社内 paradigm の現行実装:

```text
1. state.conductors.get(message.surface) で対象を取得（不在は ignored）
2. isAssigned 判定 (assigning|running|asking) + force=false なら ignored
3. R1: isAssigned のときに pidWatcherInterval / mailboxWatcherStop を停止 ★ kill より前
4. R2/R3: isAssigned + taskId 有りなら
       markTaskAborted(projectRoot, taskId, "reset_conductor", detail, { taskTitle })
       revertedChildren 有りなら notifyStateChanged(...)
       state.traceDb に insertTaskSession(event="aborted", role="conductor", ...)
5. pid 退避 (conductor.pid = undefined) → backend.killClaudeProcess(pid)
6. resetConductor(conductor, projectRoot, workspace, {
       targetStatus: "reserved",
       reason: message.reason ?? "user_reset",
   }, ccBackend(state.backend))
7. requestWakeup(state) で次 tick を即時起動 → findIdleConductor が reserved を拾う
```

abort-task はこのシーケンスを `reason="abort_task"` で再利用すれば「broken に倒さない」要件を構造的に満たす。

### 2.3 `SESSION_CLEAR running` 経路との共通点 (`daemon.ts:2868-2929`)

両者は以下の点で同形である:

| 順 | RESET_CONDUCTOR | SESSION_CLEAR running |
|---|---|---|
| watcher 停止 | 1675-1686 | 2896-2905 |
| markTaskAborted | 1692-1709 (reason=`reset_conductor`) | 2879-2895 (reason=`user_clear`) |
| trace DB session 追加 | 1713-1727 | (なし — SESSION_CLEAR 経路は task_sessions 不要) |
| pid 退避 → killClaudeProcess | 1730-1748 | 2914-2925 |
| resetConductor(targetStatus=reserved) | 1749-1752 | 2926-2929 |
| requestWakeup | 1754 | (SESSION_CLEAR は外側で notifyStateChanged 経由) |

→ abort-task は `RESET_CONDUCTOR` と最も近い (task_sessions 追加が必要なため)。

### 2.4 `forceCloseDisconnectedConductor` (`daemon.ts:4265-4311`) — 本タスクでは触らない

`disconnect_timeout` 発火時に呼ばれ、`resetConductor(targetStatus: "broken", reason: "disconnect_timeout")` を呼んで Conductor を `broken` で確定させる経路。本タスクは **入口側 (abort)** を直す方向なので、この出口は変更しない。**ただし変更後は abort 経由でここに到達するケースが消える**ことを副次的に確認する。

> 注: `disconnect_timeout` 自体を broken 以外のステータスに分離する案は範囲外 (§7)。

### 2.5 daemon message dispatcher の位置 (`daemon.ts:1517-` の `handleMessage`)

現状の `case "..."` 一覧 (1540-3085 までの登場順):

```
TASK_CREATED / TASK_UPDATED / CONDUCTOR_DONE / CONDUCTOR_CLEAR / RESET_CONDUCTOR /
AGENT_TOKEN_BOUND / AGENT_SPAWNED / SESSION_STARTED / CONDUCTOR_REGISTERED /
MASTER_REGISTERED / SESSION_ENDED / SESSION_ACTIVE / SESSION_STOP / SESSION_IDLE /
SESSION_ASK / SESSION_CLEAR / NOTIFICATION / STOP_FAILURE / SHUTDOWN
```

新 `ABORT_TASK` は **`RESET_CONDUCTOR` の直後** (1758 行の AGENT_TOKEN_BOUND の前) に置き、共通 paradigm として並べる。

### 2.6 関連 helper の signature

- `markTaskAborted(projectRoot, taskId, reason, detail, opts?)` (`task.ts:634-708`)
  - `reason: AbortReason` — `task.ts` 内で型定義済。**新規に `"abort_task"` を追加する必要は無し** (既に列挙済み: `events-writer.ts:181` で `case "abort_task"` を見ると `"other"` にマップされる)。
  - 戻り値: `{ revertedChildren, journal, idempotentSkip?, existingStatus? }`
  - 内部で `applyTaskEvent({type:"ABORT"})` → reducer による cascade + `task_aborted` ログ + `events.jsonl emit` を全部やる。
  - **既存の `cmdAbortTask` で渡している `{ taskTitle: title }` も維持** (extra log field 用)。
- `insertTaskSession(db, row)` (`trace-store.ts`)
  - `event: "aborted"` 行を追加 (`daemon.ts:1713-1727` と同形で OK)。
- `resetConductor(conductor, projectRoot, workspace?, opts?, backend?)` (`conductor.ts:699`)
  - `opts.targetStatus: "idle" | "broken" | "reserved"`
  - **`reserved` 指定時の挙動**: surface 実在性チェック → siblings close → worktree 削除 (preserveWorktree=false なら) → branch 削除 → `conductor.status = "reserved"` ＋ `taskId/taskRunId/sessionId/agents` クリア (詳細は conductor.ts 700 以降)。
  - ログは内部で `conductor_reset` を発行 (Decision D12 集約)。

## 3. 設計

### 3.1 新メッセージ `ABORT_TASK` のスキーマ (`schema.ts`)

```ts
// T008: `elevens abort-task` から daemon に送るメッセージ。
// daemon 側で T004 RESET_CONDUCTOR と同形のシーケンス
//   (watcher 停止 → markTaskAborted → insertTaskSession → kill → reserved) を実行する。
// 旧来の「CLI が直接 process.kill して CONDUCTOR_DONE を後追いする」モデルは廃止。
// reason は journal/events で `abort_task` 固定なので任意フィールドにせず固定運用。
export const AbortTaskMessage = z.object({
  type: z.literal("ABORT_TASK"),
  taskId: z.string(),
  surface: z.string(),            // 対象 Conductor surface（CLI 側で team.json から解決）
  taskTitle: z.string().optional(),
  journal: z.string().optional(), // markTaskAborted の detail に流す自由テキスト
  timestamp: z.string().datetime(),
});
```

`QueueMessage` discriminated union に `AbortTaskMessage` を追加 (`schema.ts:251-274` の末尾近く)。`AbortTaskMessage` 型を export する (251-294 周辺の type alias 列に追加)。

### 3.2 daemon 側 handler (擬似コード)

`daemon.ts:1758` の AGENT_TOKEN_BOUND の前に配置:

```ts
case "ABORT_TASK": {
  // T008: `elevens abort-task` から届く。watcher 停止 → markTaskAborted →
  //       trace DB → kill → resetConductor(reserved) のシーケンスを daemon 側で実行する。
  //       旧モデル（CLI が SIGTERM → daemon が事後に disconnect_timeout → broken）を構造的に廃止する。
  const conductor = state.conductors.get(message.surface);
  if (!conductor) {
    await log(
      "abort_task_ignored",
      `surface=${message.surface} task_id=${message.taskId} reason=not_found`
    );
    break;
  }

  // task-state の状態は CLI 側で既に検証済みだが、race 防止のため
  // taskId が conductor の現在値と一致するかだけは見る（mismatch なら ignored）。
  if (conductor.taskId !== message.taskId) {
    await log(
      "abort_task_ignored",
      `${formatSurface(conductor.surface, "C")} message_task_id=${message.taskId} current_task_id=${conductor.taskId ?? "-"} reason=stale_task_id`
    );
    break;
  }

  // R1: watcher を先に止める（pid_watcher 誤発火 disconnected を防ぐ）
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }
  if (conductor.mailboxWatcherStop) {
    try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }
    conductor.mailboxWatcherStop = undefined;
  }

  // R2: markTaskAborted（cascade + task_aborted + events.jsonl emit を含む）
  const abortedTaskId = conductor.taskId;
  const abortedTaskRunId = conductor.taskRunId;
  const abortedSessionId = conductor.sessionId;
  const detail = message.journal ?? `${formatSurface(conductor.surface, "C")} taskRunId=${abortedTaskRunId ?? "-"}`;
  try {
    const { revertedChildren } = await markTaskAborted(
      state.projectRoot,
      abortedTaskId,
      "abort_task",
      detail,
      { taskTitle: message.taskTitle ?? conductor.taskTitle ?? "" },
    );
    if (revertedChildren.length > 0) {
      notifyStateChanged("daemon.ts:handleMessage:abort-task-cascade");
    }
  } catch (e: any) {
    await log("error", `ABORT_TASK markTaskAborted failed: task_id=${abortedTaskId} ${e?.message ?? e}`);
  }

  // R3: trace DB に task_sessions(event="aborted") を追加（RESET_CONDUCTOR と対称）
  if (state.traceDb) {
    try {
      insertTaskSession(state.traceDb, {
        timestamp: new Date().toISOString(),
        task_id: abortedTaskId,
        task_run_id: abortedTaskRunId,
        session_id: abortedSessionId ?? "",
        role: "conductor",
        surface: conductor.surface,
        event: "aborted",
      });
    } catch (e: any) {
      await log("error", `ABORT_TASK insertTaskSession failed: task_id=${abortedTaskId} ${e?.message ?? e}`);
    }
  }

  // R4: abort_signal_sent を daemon 側で emit（CLI 側からは外す）
  const killTarget = conductor.pid;
  conductor.pid = undefined;
  if (killTarget !== undefined) {
    await log(
      "abort_signal_sent",
      `task_id=${abortedTaskId} surface=${formatSurface(conductor.surface, "C")} reason=abort_task method=kill_claude_process pid=${killTarget}`
    );
    const backend = ccBackend(state.backend);
    if (backend) {
      try {
        await backend.killClaudeProcess(backend.surfaceToRef(conductor.surface), killTarget);
      } catch (e: any) {
        await log(
          "error",
          `ABORT_TASK killClaudeProcess failed: ${formatSurface(conductor.surface, "C")} pid=${killTarget} ${e?.message ?? e}`
        );
      }
    }
  } else {
    await log(
      "abort_signal_sent",
      `task_id=${abortedTaskId} surface=${formatSurface(conductor.surface, "C")} reason=abort_task method=none`
    );
  }

  // R5: resetConductor(reserved) — RESET_CONDUCTOR と同形
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    targetStatus: "reserved",
    reason: "abort_task",
  }, ccBackend(state.backend));

  // 次 tick で reserved → assign 経路（findIdleConductor）を起動
  requestWakeup(state);
  break;
}
```

> 注 1: `method=` の値は現状 `sigterm` / `surface_close` / `none` の 3 値。`backend.killClaudeProcess` 経由になると semantic が変わるため `method=kill_claude_process` を新設するか、既存 `sigterm` を維持するかは実装ステップ (b) で決める (telemetry 互換性のチェック — `cmux-team-analyze` の cohort クエリで `method` を grep していないか確認)。デフォルトは新設だが、grep ヒット 0 なら `sigterm` 互換ラベルで残す案も検討する。
>
> 注 2: cleanup の **worktree 削除** は `resetConductor` 内 (`conductor.ts:767-` 周辺) で必ず行われるため、`cleanupAssignedTask` の役割はそちらに完全に吸収される。

### 3.3 CLI 側 `cmdAbortTask` の書き換え方針 (`main.ts:5096-5200`)

責務を「**入口バリデーション + 1 メッセージ送信**」に薄くする:

```text
1. resolveCanonicalTaskId（既存）
2. journal デフォルト生成（既存: i18n の abort_journal_default）
3. loadTaskState で status=="assigned" のみ受理（既存）
4. team.json から conductor を引く
   - 不在: markTaskAborted("abort_task") + TASK_UPDATED postMessage（既存の no-conductor path をそのまま残す）
   - 存在: postMessage({ type: "ABORT_TASK", taskId, surface, taskTitle: title, journal, timestamp })
5. console.log("OK aborted ${taskId} (conductor ${surface} returning to reserved)")
```

**削除する処理**:
- `cleanupAssignedTask(conductor)` 呼び出し → 廃止（worktree 削除 / kill / sub-agent close は全て daemon 側で `resetConductor` を通じて発生）。
- 呼び出し元が他に無いか念のため確認 (`restart-task` 経路 `main.ts:5356` で同 helper を使っている)。restart-task 側は今回触らないので `cleanupAssignedTask` 自体は **残す** (restart-task のみが呼び出し元になる)。
- CLI からの直接 trace DB insert (5168-5182) → 廃止。
- 5184-5192 の `CONDUCTOR_DONE postMessage` → 廃止。**`ABORT_TASK` がその役割を吸収する**。
- 5195-5197 の `cmux.send + spawn-conductor` の手動再起動 → 廃止。daemon が `reserved` に倒したあと `findIdleConductor` (`daemon.ts:3420`) が新 ready task と組み合わせて自然に再 spawn する。

**残す処理**:
- no-conductor 早期 return 経路 (5135-5150) は完全に維持 (`markTaskAborted` + `TASK_UPDATED`)。**ここは daemon を介さない**ため A 案の対象外。
- canonical id 解決 / journal 既定値 / pre-check (5099-5123)。

### 3.4 共通化検討（必須ではない）

`RESET_CONDUCTOR` と `ABORT_TASK` のシーケンスは R1〜R5 まで構造的にほぼ同じ。**今回は extract しない**方針を推奨:

- 違いは (a) reason の固定値 (`abort_task` vs `reset_conductor`)、(b) assigned 系チェックの要否、(c) detail メッセージ生成の細部、で、ヘルパー化すると分岐パラメータが増えて読解負荷が増す。
- `SESSION_CLEAR running` 経路を含めると 3 経路だが、SESSION_CLEAR は task_sessions 追加なし・shadow observer 連携あり・task_run_id 一致ガードあり等で差異が多い。
- 構造的にバグを絶ちたい場合は、**3 経路を同じテストフィクスチャで FSM テスト**するほうが effective (実装重複より状態遷移の不変条件を検査する方針)。

→ T008 では「共通化はしないが 3 経路の不変条件を `daemon.test.ts` で対称的にテストする」方針で着地。

## 4. 実装ステップ（TDD）

各ステップで「失敗するテスト → 実装 → 通過」のサイクルを 1 巡。

### ステップ A: `AbortTaskMessage` schema を追加

- (a.1) `schema.ts` に `AbortTaskMessage` を z.object として追加し、`QueueMessage` union と type alias に組み込む。
- (a.2) `schema.test.ts` (存在しなければ inline で `QueueMessage.parse` を呼ぶテストを `daemon.test.ts` に置く) で `ABORT_TASK` を含む JSON が parse 成功し、必須フィールド欠落で fail することを確認。
- 通過条件: `bun test --timeout 30000 schema*.test.ts`（または該当 test）が green。

### ステップ B: daemon ハンドラを実装し、reserved 遷移をテスト

- (b.1) `daemon.test.ts` に新 `describe("T008 ABORT_TASK", ...)` ブロックを追加。最初のテストは `RESET_CONDUCTOR force=true` のテスト (`daemon.test.ts:3529-3610`) を模倣:
  - `running` Conductor + `task-state.json` に `status=assigned` + `pidWatcherInterval` + `mailboxWatcherStop` を仕込む。
  - `handleMessage(state, { type:"ABORT_TASK", taskId, surface, ... })`
  - 期待:
    - `conductor.pidWatcherInterval === undefined` ★
    - `mailboxWatcherStop` の mock が呼ばれた ★
    - `taskState[taskId].status === "aborted"` かつ `journal` が `^reason=abort_task;` で始まる
    - `conductor.status === "reserved"` ★ (broken ではない)
    - `conductor.pid === undefined`、`taskId/taskRunId === undefined`
    - `backend.killClaudeProcess` mock が呼ばれた
    - trace DB `task_sessions` に `event="aborted" role="conductor"` 行
- (b.2) `daemon.ts` に case を追加して green に。
- (b.3) 追加テスト:
  - **未登録 surface 時**は `abort_task_ignored reason=not_found` ログのみで state 不変。
  - **taskId mismatch** (`conductor.taskId !== message.taskId`) は `reason=stale_task_id` ログのみで state 不変。
  - **pid === undefined** のとき `abort_signal_sent ... method=none` ログを出すが kill は呼ばない。

### ステップ C: 時計を進めても broken に倒れないことを確認 (★核心テスト)

- (c.1) ステップ B の最終状態 (`conductor.status === "reserved"`) で `monitorConductors(state)` を呼ぶ。
- (c.2) 期待: `monitorConductors` は `disconnected` ステータスのみを timeout 判定の対象にする (`daemon.ts:4222`) ため、reserved Conductor は無視され、`status === "reserved"` のまま。
- (c.3) さらに `conductor.disconnectedAt = new Date(Date.now() - 10 * 60 * 1000)` をわざと書き込んでも、`status` が `disconnected` でない限り 4222 行の条件で skip される → still reserved。
- (c.4) これで「abort → 5 分後 broken」が構造的に発生しないことを **状態遷移レベル**で証明する。

### ステップ D: `cmdAbortTask` を `ABORT_TASK` 送信に書き換える

- (d.1) `main.test.ts:912` の既存テスト「abort-task: no-conductor 早期 return パスで TASK_UPDATED が送信される」は維持されることを確認 (no-conductor path は変更しないため変わらず通る)。
- (d.2) 新規テスト: `abort-task` を **conductor 有り** で実行したとき、`postMessage` で `{type:"ABORT_TASK", taskId, surface, ...}` が送信されることを確認 (postMessage を spy する既存パターン or queue ファイルを直接読む)。
- (d.3) `main.ts:cmdAbortTask` を §3.3 に従って書き換え。`cleanupAssignedTask` / 直接 trace DB / `CONDUCTOR_DONE` / `cmux.send spawn-conductor` を削除し、`postMessage({ type: "ABORT_TASK", ... })` に集約。
- (d.4) `OK` 出力メッセージは「`OK aborted ${taskId} (conductor ${surface} returning to reserved)`」に変更。

### ステップ E: 既存テストの assertion 更新

- (e.1) `main.test.ts:912` (`abort-task: no-conductor 早期 return パスで TASK_UPDATED が送信される`) → そのまま通るはず。変更不要。
- (e.2) `main.test.ts:1064` (slug 渡し no-conductor) → 同上、変更不要。
- (e.3) `task.test.ts:799-984` の `markTaskAborted("abort_task", ...)` 系 → reducer は無変更なので不変。
- (e.4) **新規 daemon テスト**側で `reserved` を assert (ステップ B/C で網羅)。
- (e.5) 既存で broken を期待しているテストがあれば探索 (`grep "broken.*abort\|abort.*broken" skills/cmux-team/manager/*.test.ts` → 0 件であることを確認。あれば assertion を `reserved` に更新)。

### ステップ F: 副次 cleanup

- (f.1) `cleanupAssignedTask` の **呼び出し元が `cmdRestartTask` のみ** になっていることを `grep cleanupAssignedTask skills/cmux-team/manager/main.ts` で確認 (restart-task: 5356, abort-task: 5153 → 削除)。
- (f.2) `events-writer.ts:181` の `case "abort_task":` で `"other"` にマップされる挙動は維持 (events.jsonl の reason 互換性)。
- (f.3) 直接 trace DB を開いている import (`initDB` / `insertTaskSession`) が `cmdAbortTask` から除去できるか確認。restart-task でも使っているなら残す。

### ステップ G: 手動 E2E（要 main 動作）

`bun test` 全体実行は禁止 (CLAUDE.md §既知の注意点)。**個別ファイル単位**で:

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 schema.test.ts
bun test --timeout 30000 daemon.test.ts
bun test --timeout 30000 main.test.ts
bun test --timeout 30000 task.test.ts
```

手動 reproduction (オプション):
1. ローカル elevens 環境で適当な ready task を作って `elevens spawn-conductor` で running に。
2. `elevens abort-task --task-id <id>` を実行。
3. `tail -f .team/logs/manager.log` で `abort_signal_sent ... method=kill_claude_process` ＋ `conductor_reset target=reserved reason=abort_task` の順に出ることを確認。
4. 6 分待っても `conductor_disconnect_timeout` / `conductor_broken` が出ないことを確認。
5. その後 ready task を投入し、reserved Conductor が `findIdleConductor` で拾われて assigning → running に遷移することを確認。

## 5. テスト設計

`skills/cmux-team/manager/daemon.test.ts` に追加する `describe("T008 ABORT_TASK", ...)` ブロックの新規ケース:

| # | テスト名 | 検証ポイント | 既存類似 |
|---|---|---|---|
| 1 | `ABORT_TASK で running Conductor が reserved に戻り、task が aborted になる` | watcher 停止 + markTaskAborted + insertTaskSession + killClaudeProcess + status=reserved + journal=`^reason=abort_task;` | T004 `RESET_CONDUCTOR force=true` (3529-3610) |
| 2 | `ABORT_TASK 後に clock を 6 分進めても disconnect_timeout / broken に遷移しない` | reserved な Conductor に `monitorConductors` を 6 分後 (disconnectedAt = 6 分前) でかけても status=reserved 維持 | 新規 (本タスク核心) |
| 3 | `ABORT_TASK 後に新規 ready task を投入すると reserved → assigning → running に遷移する` | findIdleConductor + spawn-conductor 経路を呼ぶ統合テスト (`createTask`+`scanTasks`) | T421/F3/F4 系 |
| 4 | `ABORT_TASK が未登録 surface に来ても abort_task_ignored ログのみで state 不変` | not_found 早期 return | RESET_CONDUCTOR 3468-3478 と対称 |
| 5 | `ABORT_TASK で conductor.taskId と message.taskId が不一致なら ignored` | stale_task_id 早期 return (race 防御) | 新規 |
| 6 | `ABORT_TASK で conductor.pid === undefined のとき kill は呼ばれず method=none ログのみ` | abort_signal_sent ログだけ出る | 新規 |
| 7 | `ABORT_TASK で子 task が draft に巻き戻ると notifyStateChanged が発火する` | revertedChildren cascade 経路 | RESET_CONDUCTOR の cascade 検証と対称 |

`main.test.ts` の追加 / 更新:

| # | テスト名 | 検証ポイント |
|---|---|---|
| M1 | `abort-task: conductor 有りパスで ABORT_TASK が postMessage される` | queue ファイル or postMessage spy で `{type:"ABORT_TASK", taskId, surface, taskTitle, journal}` を確認 |
| M2 | `abort-task: no-conductor パスは従来通り markTaskAborted + TASK_UPDATED のまま` | 既存 912 行のテストが green を維持 |

`task.test.ts` は変更不要 (markTaskAborted の reason=`abort_task` 系既存テストはそのまま通る)。

## 6. 影響範囲・リスク

| 観点 | 評価 |
|---|---|
| **CLI コマンド互換性** | `elevens abort-task --task-id <id>` の入力 IF は不変。出力メッセージは 1 行変わるが contract-level の互換性は維持 (機械可読ではない)。 |
| **CONDUCTOR_DONE 廃止の影響** | 旧経路で `CONDUCTOR_DONE success=false reason=aborted` を送っていた相手側挙動。`daemon.ts:1564-1614` の handler は `handleConductorDone` を経由するが、abort-task では既に `markTaskAborted` 済みで `current task-state === aborted` なので `unresolved=false`、worktree も `preserveWorktree=false` の通常リセットで終わっていた → **挙動は同等**。CONDUCTOR_DONE を消しても markTaskAborted + resetConductor(reserved) で同じ結末に着地する。 |
| **手動 re-spawn (cmux.send spawn-conductor) 廃止** | 旧経路では abort 直後に conductor pane で claude を再起動していたが、新経路では「reserved 状態 + 次 ready task が来たら自動で spawn される」モデル。**ready task が無いと session 不在のまま reserved**。これは reserved の semantic と一致しており UX 上問題なし (idle と reserved は両方とも「待機」)。Master 側からは見え方が変わるかもしれないので TUI / dashboard 表示で確認する。 |
| **trace DB 接続** | CLI 側で `initDB` を呼び出していたが、daemon 側に集約。abort-task の trace 行は `state.traceDb` 経由になる。**daemon 起動前に abort-task が呼ばれるケースは現状不在** (assigned task は daemon 起動下でのみ存在しうる) なので問題なし。 |
| **events.jsonl** | `mapAbortReason("abort_task") === "other"` の挙動は不変 (`events-writer.ts:181`)。daemon 側 markTaskAborted 経由でも同じ map が通る。schema_version bump 不要。 |
| **broken 判定の入口は他にも残る** | `forceCloseDisconnectedConductor` (`daemon.ts:4265`)、`resetConductor` の surface_missing → broken (`conductor.ts:725`)、`launch_failed` 等の入口は維持。**「abort 経由で broken に倒れる」だけが消える**。`/metrics` cohort で `broken_count` 自体は依然として観察可能。 |
| **既存の `abort_signal_sent method=sigterm` ログを grep している場所がないか** | `cmux-team-analyze` skill の SQL や dashboard / metrics 集計、`docs/spec/` を grep で確認。ヒットしたら `method=kill_claude_process` への migration コメントを add (もしくはラベルを `sigterm` 互換のまま維持)。**最終判断は実装中の grep 結果で確定する**。 |
| **後方互換 (旧 daemon + 新 CLI 組合せ)** | 旧 daemon は `ABORT_TASK` を `QueueMessage.parse` で reject する (discriminated union 外) → 422/parse error。CLI は npm release で daemon と一緒に出るため通常は問題なし。ロールバック手順は通常の npm version 戻しで成立。 |
| **race: ABORT_TASK と SESSION_CLEAR の同時着火** | abort-task 実行中にユーザーが /clear すると watcher 停止が二重発火するが、`undefined` チェック付きなので idempotent。markTaskAborted も冪等 skip (`task.ts:661`)。問題なし。 |

## 7. 範囲外 (本タスクではやらない)

- **`disconnect_timeout` を broken と別ステータスに分離する案**: 観察軸の改善案として独立タスク化する候補だが、今回は abort 側を直すだけで観測される broken 異常源を消せるため不要。
- **abort 時に claude session を kill しない運用 (session reuse)**: 別軸。reserved 復帰 + 再 spawn の方が現状の 4 層アーキテクチャと整合する。
- **`forceCloseDisconnectedConductor` 自体の挙動変更**: 「人間判断待ち」のため broken に倒すという CLAUDE.md 原則 (Decision D11 系) を守るので維持。
- **`RESET_CONDUCTOR` / `SESSION_CLEAR running` / `ABORT_TASK` の helper 共通化**: §3.4 で議論したとおり今回は見送り (3 経路を FSM-style テストで対称化することが今回の主目的)。
- **`bun test` 全体ハング問題 (`A021-research.md`)**: 別軸の既知 issue。本タスクのテストは個別ファイル単位で実行する。

## 8. 補足: 参考資料の対応マップ

| 参考 | 本 plan 内対応セクション |
|---|---|
| `main.ts:5096-5200` cmdAbortTask | §2.1, §3.3, §4(d) |
| `daemon.ts:1646-1758` RESET_CONDUCTOR | §2.2, §3.2 |
| `daemon.ts:2868-2929` SESSION_CLEAR running | §2.3 |
| `daemon.ts:4265-4311` forceCloseDisconnectedConductor | §2.4, §6, §7 |
| `task.ts:634-708` markTaskAborted | §2.6, §3.2 R2 |
| `conductor.ts:699-` resetConductor | §2.6, §3.2 R5 |
| `schema.ts:25-274` QueueMessage union | §3.1, §4(a) |
| `events-writer.ts:171-193` mapAbortReason | §6 (互換性) |
| `docs/spec/07-state-machine.md` Conductor FSM | §6 (broken の意味) |
| CLAUDE.md 設計原則 / 観察箱 | §1, §3.4 (FSM テスト) |

---

実装計画書 終了。
