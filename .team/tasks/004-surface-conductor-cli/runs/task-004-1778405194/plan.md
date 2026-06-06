# T004 実装計画 — `elevens reset-conductor` CLI

## 1. 背景・ゴール

Conductor が `broken` / `disconnected` に倒れたあと、現状はユーザーに「daemon 全体の再起動」または「`team.json` 直接編集（規約違反）」しか選択肢がない。`daemon.ts` のコメントに `broken_requires_manual_clear` とあるが pane 単位の局所復旧手段は未整備で、`elevens clear-conductor` は `broken → idle` 限定で `disconnected` / `reserved` / `assigned` をカバーしていない。観察箱原則（real-time 観察 → 介入のサイクル）を閉じるため、ユーザーが pane で「壊れている」と気づいた瞬間に同じ pane から自身をリセットできる CLI を提供する。

ゴール: 任意の状態の Conductor surface を `reserved` 状態（pane だけ生存・claude プロセス未起動）に戻し、次の `findIdleConductor` で再利用可能にする。`assigning` / `running` / `asking`（assigned 系）は `--force` 必須として暴発を防ぐ。

## 2. 既存コードの調査結果

### 2.1 関連ファイルとシンボル

| ファイル | 行 | シンボル / 役割 |
|---|---|---|
| `skills/cmux-team/manager/schema.ts` | 5–235, 237–259 | `QueueMessage` discriminatedUnion（21 種）。`ConductorClearMessage` (L34) が新メッセージ追加の最近事例 |
| `skills/cmux-team/manager/schema.ts` | 369–448 | `ConductorState` 型と `status` enum (`reserved` / `starting` / `assigning` / `idle` / `running` / `asking` / `disconnected` / `broken` / `error`) |
| `skills/cmux-team/manager/schema.ts` | 455–457 | `isAssignableStatus(s)` — `idle` または `reserved` を「割当対象」として返す |
| `skills/cmux-team/manager/conductor.ts` | 699–841 | `resetConductor(conductor, projectRoot, workspace?, opts?, backend?)`。`opts.targetStatus` は `"idle" \| "broken" \| "reserved"`、`opts.killClaudeProcess` で claude プロセス kill 可能。冪等で sibling surface close / worktree remove / branch delete を実施 |
| `skills/cmux-team/manager/task.ts` | 577–585 | `AbortReason` union（現行 7 メンバー: `"user_clear" \| "judgment_pending" \| "assign_failed" \| "disconnect_timeout" \| "abort_task" \| "resume_no_session_id" \| "resume_no_task_run_id" \| "resume_no_worktree"`）。本タスクで `"reset_conductor"` を追加し T290 コメント "6 経路" を "7 経路" に更新する |
| `skills/cmux-team/manager/main.ts` | 3003–3016 | `resolveCallerSurfaceOrExit()` — `CMUX_SURFACE` env → `cmux.getCallerSurface()` の順に解決し、失敗時 `process.exit(1)` |
| `skills/cmux-team/manager/main.ts` | 285–305 | `WRITE_COMMANDS` に新コマンドを登録する必要がある（cross-project write gate） |
| `skills/cmux-team/manager/main.ts` | 2075–2088 | `postMessage(msg)` — `.team/proxy-port` を読んで `http://localhost:<port>/api/messages` に POST。daemon 不在時は silent skip |
| `skills/cmux-team/manager/main.ts` | 4992–5032 | `cmdClearConductor()` — surface 起点 CLI の最近事例。`team.json` 読込 → status check → `postMessage({type:"CONDUCTOR_CLEAR", surface, reason, timestamp})` |
| `skills/cmux-team/manager/main.ts` | 4931–4981 | `cleanupAssignedTask(conductor)` — sub-agent close + Conductor PID kill (SIGTERM) + worktree/branch 削除。`abort-task` で利用 |
| `skills/cmux-team/manager/main.ts` | 5034–5138 | `cmdAbortTask()` — assigned 中タスクの停止経路。`markTaskAborted` 呼び出し → `CONDUCTOR_DONE` 送信 → Conductor 再起動。trace DB に `insertTaskSession({event:"aborted", role:"conductor", ...})` を入れる |
| `skills/cmux-team/manager/main.ts` | 6435–6443 | コマンドディスパッチ switch（新 case 追加点） |
| `skills/cmux-team/manager/i18n.ts` | 494–511, 1552– | `help_clear_conductor`（en/ja 双方）。新 help テキストはここに追加 |
| `skills/cmux-team/manager/i18n.ts` | 913–959, 1971– | `help_main`（en/ja 双方）— 新コマンドの 1 行 usage を追加 |
| `skills/cmux-team/manager/daemon.ts` | 1517–1644 | `handleMessage()` switch。`CONDUCTOR_CLEAR` case (L1617–1644) が「surface 起点 reset 系」の最近事例 |
| `skills/cmux-team/manager/daemon.ts` | 2756–2817 | `SESSION_CLEAR` running 経路 — `pidWatcherInterval` / `mailboxWatcherStop` 停止 → `pid` 退避 → `backend.killClaudeProcess()` → `markTaskAborted` → `notifyStateChanged("daemon.ts:handleMessage:session-clear-cascade")` → `resetConductor(targetStatus:"reserved", reason:"user_clear", killClaudeProcess:true)`。**RESET_CONDUCTOR 実装の手本** |
| `skills/cmux-team/manager/daemon.ts` | 22, 2768–2774 | `markTaskAborted(root, taskId, reason, journal, {taskTitle})` を `./task` から import。task-state 書換 / cascade / `task_aborted` log を集約 |
| `skills/cmux-team/manager/daemon.ts` | 1524–1530 | `hook_signals` pipeline — daemon 側で受け付けた message は自動で trace DB に書かれる。`RESET_CONDUCTOR` も追加実装なしで `hook_signals` 行が残る |
| `skills/cmux-team/manager/daemon.ts` | 1552 | `requestWakeup(state)` — handler 末尾で呼ぶと次 tick が即時発火し、`scanTasks` が reserved を拾って kill+spawn する |
| `skills/cmux-team/manager/trace-db.ts` | (`insertTaskSession`) | `task_sessions` テーブルへの行追加。`event: "aborted"` でレコード化することで cohort 比較・retrospective 観察が可能になる |
| `skills/cmux-team/manager/daemon.test.ts` | 3178–3288 | `CONDUCTOR_CLEAR` のテストパターン（broken→idle 正常、idle/running/disconnected で ignored、未登録 surface で not_found）— RESET_CONDUCTOR テストの雛形 |
| `skills/cmux-team/manager/conductor.test.ts` | 507–612 | `resetConductor` の `targetStatus` 別テスト群（既存）。`reserved` 経路は SESSION_CLEAR テスト経由で間接カバー済み |
| `skills/cmux-team/manager/main.test.ts` | 749–921 | `runCli([...args])` ヘルパー + mock HTTP server で `postMessage` を捕捉する pattern。`receivedMessages` 配列を assert する。`setupTeamDir` で `task.md` 本体 + `task-state.json` を共に書き出す fixture (L759–772) |
| `skills/cmux-team/manager/schema.test.ts` | 82–, 461– | `QueueMessage discriminated union` describe ブロック群。新メッセージ型の schema テストの正規配置場所 |

### 2.2 既存メッセージ流儀（重要事実）

タスク説明書（`.team/tasks/004-surface-conductor-cli/task.md` L30）には「`.team/queue/incoming/` 流儀」とあるが、実装上は **HTTP POST** に統一されている（`postMessage()` が `http://localhost:<port>/api/messages` に投げる）。`.team/queue/` には `processed/` のみ作られ、現行の write 経路は HTTP のみ。queue file 直接書き込みのテストフィクスチャ (`queue.test.ts`) は queue file の write/read 統合テスト用で、production 経路には使われていない。本実装も `postMessage` を踏襲する。

> **注**: task.md の queue file 表記は時代遅れの記述で、本実装は HTTP POST を採用する（design-review 観点 1 / Recommendation 関連）。

### 2.3 reserved 復帰の前例（SESSION_CLEAR）

`daemon.ts:2756–2817` が「watcher 停止 → `pid` 退避 → `killClaudeProcess` → `markTaskAborted` → `notifyStateChanged` → `resetConductor(reserved, killClaudeProcess:true)`」のシーケンスを既に確立している。コメント T421/D5: 「ユーザー手動 /clear → claude を kill して reserved に戻す」。これと完全に同じシーケンスを RESET_CONDUCTOR でも採用する（R1 / R4 反映）。

### 2.4 `assigning` / `running` / `asking` の意味

- `assigning`: assignTask で `status="assigning"` をセットした直後、SESSION_STARTED(source=clear) で running に遷移する直前
- `running`: claude が動作中で taskRunId / taskId 紐付き済み
- `asking`: AskUserQuestion 検出中（task は assigned のまま）
- これら 3 状態を本実装では **「assigned 系」** とまとめて扱う。`task-state.json` 上の `status==="assigned"` と一対一対応する（asking 中も taskState は assigned）。

## 3. 実装方針

### 3.1 `skills/cmux-team/manager/schema.ts`

新メッセージ型 `ResetConductorMessage` を追加し `QueueMessage` discriminatedUnion に組み込む。

```ts
// 新規追加 (CONDUCTOR_CLEAR の直後 / L40 付近)
export const ResetConductorMessage = z.object({
  type: z.literal("RESET_CONDUCTOR"),
  surface: z.string(),
  force: z.boolean().optional(), // assigned 中に true なら abort 経由で reserved 復帰
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});
```

`QueueMessage` discriminatedUnion (L237) と末尾の `export type` 群 (L264 以降) にも追加。

### 3.2 `skills/cmux-team/manager/main.ts` — CLI 追加

新関数 `cmdResetConductor()` を `cmdClearConductor` の直後（L5033 付近）に配置:

1. `hasHelpFlag()` → `showHelp(t("help_reset_conductor"))`
2. `--surface <s>` 引数を `getArg("surface")` で取得（不在時 `resolveCallerSurfaceOrExit()` で auto-resolve）
3. `surface` を `surface:` プレフィクス正規化（`cmdClearConductor` と同じ）。以下この値を `normalizedSurface` と呼ぶ
4. `--force` フラグを `hasFlag("force")` で判定
5. `team.json` を読み conductor entry を取得（不在で error exit）。`oldStatus = entry.status`
6. status check（**注意: pre-check は best-effort UX。真の判定は daemon 側で再実行する**。`team.json` は daemon の snapshot で 数 ms 遅れる可能性があり、`task-state.json[taskId].status === "assigned"` が真値）:
   - `assigning` / `running` / `asking` で `--force` なし → `console.error` + `process.exit(1)`（メッセージ「Use --force to reset an assigned conductor」）
   - 上記以外（`broken` / `disconnected` / `reserved` / `idle` / `error` / `starting`）→ そのまま続行
7. `postMessage({type:"RESET_CONDUCTOR", surface: normalizedSurface, force, reason:"user_reset", timestamp})`
8. `console.log` の出力文言は `cmdClearConductor` の `OK cleared ...` パターンに統一して以下の形式（R8）:
   ```
   OK reset ${normalizedSurface} (${oldStatus} → reserved)
   ```

WRITE_COMMANDS (L300 付近) に `"reset-conductor": true,` を追加。

ディスパッチ switch (L6441 付近) に `case "reset-conductor": await cmdResetConductor(); break;` を追加。

`hasFlag()` ヘルパーが既に存在するか調査必要（簡易には `process.argv.includes("--force")` で代替可、ただし既存パターンを踏襲する）。

### 3.3 `skills/cmux-team/manager/i18n.ts` — help テキスト

`help_reset_conductor` を en/ja の両 dictionary に追加（L494 / L1552 付近、`help_clear_conductor` の直後）。`help_main` (L913 / L1971) の usage 一覧にも 1 行追加:

```
elevens reset-conductor [--surface <id>] [--force]   reset a conductor surface to reserved
```

### 3.4 `skills/cmux-team/manager/daemon.ts` — handleMessage 拡張

`switch (message.type)` に `case "RESET_CONDUCTOR"` を追加（CONDUCTOR_CLEAR の直後 L1644 付近）。SESSION_CLEAR running 経路（daemon.ts:2756–2817）と完全対称な構造にする:

```ts
case "RESET_CONDUCTOR": {
  const conductor = state.conductors.get(message.surface);
  if (!conductor) {
    await log("conductor_reset_ignored",
      `surface=${message.surface} reason=not_found`);
    break;
  }
  const isAssigned = conductor.status === "assigning"
    || conductor.status === "running"
    || conductor.status === "asking";
  if (isAssigned && !message.force) {
    await log("conductor_reset_ignored",
      `${formatSurface(conductor.surface, "C")} status=${conductor.status} reason=force_required`);
    break;
  }

  // [R1] watcher を先に止める — pid kill 後の watcher 誤検出 (disconnected 倒れ) を防ぐ。
  // SESSION_CLEAR running 経路 (daemon.ts:2784–2792) と同形。
  // isAssigned 全ケース（assigning も含む）でクリアする。
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

  // [R2/R3] assigned + force: 紐付く task を abort 状態へ + trace DB に task_sessions 行追加
  let abortedTaskRunId: string | undefined;
  let abortedSessionId: string | undefined;
  let revertedChildren: string[] = [];
  if (isAssigned && conductor.taskId) {
    abortedTaskRunId = conductor.taskRunId;
    abortedSessionId = conductor.sessionId;
    const journal = `[reset-conductor] reset by user: surface=${conductor.surface}`;
    try {
      const result = await markTaskAborted(state.projectRoot, conductor.taskId,
        "reset_conductor", journal, { taskTitle: conductor.taskTitle ?? "" });
      // markTaskAborted の戻り値で revertedChildren を受け取れる場合は保持
      revertedChildren = result?.revertedChildren ?? [];
    } catch (e: any) {
      await log("error", `RESET_CONDUCTOR markTaskAborted failed: ${e?.message ?? e}`);
    }

    // [R3] task_sessions(event="aborted") を追加 — abort-task との対称性を保つ。
    // retrospective 観察軸（CodeDNA 評価・cohort 比較）で task lifecycle 再構成に必要。
    try {
      if (state.traceDb && abortedTaskRunId) {
        insertTaskSession(state.traceDb, {
          role: "conductor",
          event: "aborted",
          surface: conductor.surface,
          task_run_id: abortedTaskRunId,
          session_id: abortedSessionId ?? null,
        });
      }
    } catch (e: any) {
      await log("error", `RESET_CONDUCTOR insertTaskSession failed: ${e?.message ?? e}`);
    }

    // [R4] cascade で子 task が draft に巻き戻った場合は TUI に即時反映。
    // SESSION_CLEAR running 経路 (daemon.ts:2778–2779) と同形。
    if (revertedChildren.length > 0) {
      notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade");
    }
  }

  // SESSION_CLEAR と同じシーケンスで reserved 復帰
  const killTarget = conductor.pid;
  conductor.pid = undefined;
  if (killTarget !== undefined) {
    const backend = ccBackend(state.backend);
    if (backend) {
      try {
        await backend.killClaudeProcess(backend.surfaceToRef(conductor.surface), killTarget);
      } catch (e: any) {
        await log("error",
          `RESET_CONDUCTOR killClaudeProcess failed: ${formatSurface(conductor.surface, "C")} pid=${killTarget} ${e?.message ?? e}`);
      }
    }
  }
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    targetStatus: "reserved",
    reason: message.reason ?? "user_reset",
  }, ccBackend(state.backend));
  requestWakeup(state);
  break;
}
```

`markTaskAborted` は L22 で既に import 済み。`ccBackend` / `formatSurface` / `notifyStateChanged` も同ファイル内で利用可能。`insertTaskSession` は `./trace-db` から追加 import が必要（既に他箇所で使用されているはず）。

### 3.5 タスク説明 step 2 の「pane のタブ名を `[N] Conductor` に戻す」

`resetConductor` 内および pane 表示の更新は cmux 側 metadata（surface 名）に依存する。現行 `resetConductor` は pane タブ名を直接更新しないが、`team.json` 上の status 変更で TUI 側が表示を更新する流れになっている（dashboard 経由）。本実装スコープでは追加処理を入れず、既存の `resetConductor` の挙動に依存する（実装後に実機確認、必要なら別タスク化）。

### 3.6 `cleanupAssignedTask` との重複の扱い（YAGNI 確定）

`cleanupAssignedTask` (main.ts:4931–4981) は `abort-task` CLI プロセス側で `process.kill` / git worktree remove / branch delete を **重複実装** している（resetConductor が daemon 側で同じことをやる）。SESSION_CLEAR / RESET_CONDUCTOR は daemon 側で完結するため `cleanupAssignedTask` を呼ばず、resetConductor に集約する。helper 抽出の余地はあるが、文脈差（ログ文言・reason 値）と LOC（差分が 5 行 × 2 箇所程度）を踏まえ **本タスクでは抽出しない**（YAGNI、§8.2 (b) と整合）。実装者はリファクタに引きずられず、SESSION_CLEAR と同形のインライン実装で進めること。

## 4. データフロー

```
[pane shell] $ elevens reset-conductor [--force]
       │
       ▼
main.ts: cmdResetConductor()
  ├─ resolveCallerSurfaceOrExit()  ← CMUX_SURFACE or cmux identify
  ├─ team.json 読込 → status pre-check (best-effort UX, 真値は daemon 側)
  │     └─ assigned 系 + !force ⇒ exit 1
  └─ postMessage({type:"RESET_CONDUCTOR", surface, force, reason, ts})
       │  HTTP POST → http://localhost:<proxy-port>/api/messages
       ▼
daemon.ts: handleMessage(state, msg)
  case "RESET_CONDUCTOR":
    ├─ state.conductors.get(surface)            (not_found → ignore)
    ├─ status==assigned & !force → ignore (force_required ログ)
    ├─ [R1] isAssigned → pidWatcherInterval / mailboxWatcherStop 停止
    ├─ status==assigned & force →
    │     ├─ markTaskAborted(taskId, "reset_conductor", journal)
    │     ├─ [R3] insertTaskSession({event:"aborted", role:"conductor", surface, task_run_id, session_id})
    │     └─ [R4] revertedChildren > 0 → notifyStateChanged("...:reset-conductor-cascade")
    ├─ pid 退避 → backend.killClaudeProcess()
    ├─ resetConductor(targetStatus:"reserved", reason:"user_reset")
    │     ├─ sibling surface close (agent 含む)
    │     ├─ worktree remove + branch delete
    │     ├─ ConductorState フィールドクリア（promptSentAt / promptBytes / killInProgressUntil 等）
    │     ├─ status="reserved", pid=undefined, sessionId=undefined
    │     └─ notifyStateChanged + log("conductor_reset_reserved")
    └─ requestWakeup(state)
       │
       ▼
次 tick: scanTasks → findIdleConductor (isAssignableStatus)
  └─ reserved を拾う → kill+spawn 経路で claude 再起動 → SESSION_STARTED → running
```

## 5. エッジケース

| ケース | 期待動作 |
|---|---|
| `--surface` 不在 + `CMUX_SURFACE` 未設定 + cmux pane 外 | `resolveCallerSurfaceOrExit` が `process.exit(1)` |
| `team.json` 不在 | CLI 側で `console.error` → exit 1 |
| 指定 surface が `team.json.conductors` に無い | CLI 側で「conductor not found」exit 1（pre-check）。daemon 側にも到達した場合は `not_found` ログのみ |
| `daemon` 未起動 | `postMessage` が silent skip → CLI は OK 表示するが何も起きない（既存 `cmdClearConductor` と同じ挙動） |
| `status==="reserved"` で実行 | reset → 既に reserved だが冪等。`resetConductor` 内の sibling close / worktree remove は idempotent（worktree 不在で no-op） |
| `status==="idle"` で実行 | claude は走っているが reserved に戻す。`killClaudeProcess` で SIGTERM。次 assign で kill+spawn 経路（`assignTask` の D5）が走るので問題なし |
| `status==="broken"` / `"disconnected"` | taskRunId / taskId は既にクリアされている可能性が高いので abort 経路をスキップ。`pid` も基本 undefined で `killClaudeProcess` no-op |
| `status==="error"` (StopFailure 後) | `--force` 不要。`killClaudeProcess` + reset reserved |
| `status==="starting"` | `--force` 不要。SESSION_STARTED 待ちの最中だが reset で reserved へ。実害は小さい（次 assign で kill+spawn）。**観察可能性のための注記ログ追加候補**: `reset_during_starting` を 1 行残し、source=startup の SESSION_STARTED が後着して `reserved` を `disconnected` に倒さないか観測 |
| `status==="assigning"` / `"running"` / `"asking"` + `--force` なし | reject。CLI 側で「Use --force ...」、daemon 側でも `force_required` ログ |
| `status==="running"` + `--force` あり | `markTaskAborted(taskId, "reset_conductor")` → task は aborted（cascade あれば children も revert）→ task_sessions 追記 → notifyStateChanged → killClaudeProcess → reset reserved |
| assigned + force だが `taskId === undefined` (race) | `markTaskAborted` / `insertTaskSession` 呼び出しを skip し reset のみ実行 |
| `conductor.pid === undefined` (既に死亡) | `killClaudeProcess` 呼び出しを skip し reset のみ実行 |
| `markTaskAborted` 失敗（task ファイル / state 破損） | エラーログを残し reset 処理は続行（partial recovery 優先） |
| `worktree remove` 失敗 (ディスク占有等) | 既存 `resetConductor` が `cleanup_failed` ログを出して続行 |
| 同一 surface への RESET_CONDUCTOR が連続到着 | 2 回目は `resetConductor` が冪等に no-op（reserved 状態）。問題なし |
| **[R9-1] `RESET_CONDUCTOR` と並行 `TASK_CREATED`** | reset 完了 → reserved → 次 tick で scanTasks が拾う（race 無し）。reset 中の Conductor (status=running, force=true 経路) は `findIdleConductor` で対象外。HTTP message が逐次処理される前提で確定的順序 |
| **[R9-2] `assigning` + force で旧 SESSION_ENDED 遅延着信** | `killClaudeProcess` 後に旧 claude プロセスが SESSION_ENDED を送ってから死ぬ場合、reset 済み reserved Conductor に対して SESSION_ENDED が来る。`killInProgressUntil` が `resetConductor` で `undefined` にされる (conductor.ts:805) ため、suppression window がないと `disconnected` に倒れる可能性。**実機 e2e 確認項目に追加**（§7 step 10） |

## 6. テスト計画

### 6.1 受け入れ条件 → テスト対応

| AC | テストファイル | テスト名 | 主な assertion |
|---|---|---|---|
| AC4: broken / disconnected からの復旧で次 task assign が成功 | `daemon.test.ts` | `RESET_CONDUCTOR で broken Conductor が reserved に戻る` / `RESET_CONDUCTOR で disconnected Conductor が reserved に戻る` | conductor.status === "reserved", taskRunId/taskId/pid undefined, isAssignableStatus(status) === true |
| AC5: assigned 中の `--force` なしで reject | `daemon.test.ts` | `RESET_CONDUCTOR が assigned/running Conductor に force=false で来ても無視される` | conductor.status === "running" のまま, taskId 保持, log に `reason=force_required`。**併せて CLI 側 (main.test.ts) で exit 1 する pre-check テストも置き、二重防御の整合性を担保** |
| AC6: assigned + `--force` で task abort + reserved 復帰 | `daemon.test.ts` | `RESET_CONDUCTOR が running Conductor に force=true で来ると task が aborted になり surface が reserved に戻る` | task-state.json で taskId.status === "aborted", journal が **`reason=reset_conductor;`** で始まる (R2), conductor.status === "reserved", **`pidWatcherInterval === undefined` / `mailboxWatcherStop === undefined`** (R1), **trace DB の `task_sessions` に `event="aborted", role="conductor"` 行が 1 つ存在する** (R3) |

### 6.2 追加カバレッジ（受け入れ条件に明記されていないが必要）

| テストファイル | テスト名 | 目的 |
|---|---|---|
| `daemon.test.ts` | `RESET_CONDUCTOR が未登録 surface に来ても無視される` | not_found 経路 |
| `daemon.test.ts` | `RESET_CONDUCTOR が reserved Conductor に来ても冪等に成功する` | idempotency |
| `daemon.test.ts` | `RESET_CONDUCTOR が idle Conductor に来ると reserved に戻る` | idle → reserved 経路 |
| `daemon.test.ts` | `RESET_CONDUCTOR force=true で running から reserved に戻ると pidWatcherInterval / mailboxWatcherStop が停止される` (R1) | watcher 停止 assertion。spy で呼び出し回数を検証、または `conductor.pidWatcherInterval === undefined` を確認 |
| `daemon.test.ts` | `RESET_CONDUCTOR force=true で task_sessions に aborted 行が追加される` (R3) | trace DB を読み戻して `event="aborted" AND role="conductor" AND task_run_id=...` 行が存在することを assertion |
| `daemon.test.ts` | `RESET_CONDUCTOR が assigning Conductor に force=true で来ると promptSentAt / promptBytes がクリアされる` | conductor.ts:800–801 で resetConductor が両フィールドをクリアすることを 1 ケースで確認（state 整合の保証） |
| `main.test.ts` | `reset-conductor: --surface 指定で RESET_CONDUCTOR が POST される` | CLI → postMessage 経路（`receivedMessages[0].type === "RESET_CONDUCTOR"`, `.surface` / `.force` 検証） |
| `main.test.ts` | `reset-conductor: CMUX_SURFACE env で auto-resolve できる` | env → surface 解決経路 |
| `main.test.ts` | `reset-conductor: assigned + --force なしで CLI が exit 1 する` | CLI 側 pre-check |
| `main.test.ts` | `reset-conductor: --force で message.force=true が乗る` | flag 伝搬 |
| `main.test.ts` | `reset-conductor: 出力文言が "OK reset <surface> (<oldStatus> → reserved)" 形式である` (R8) | 出力統一の確認 |
| `schema.test.ts` (R6) | `RESET_CONDUCTOR メッセージが QueueMessage discriminated union にパースされる` | schema 互換性。既存 "QueueMessage discriminated union" describe ブロック (L82, L461) に追記 |

### 6.3 mock の扱いと fixture 仕様

- **`daemon.test.ts`**: 既存 `CONDUCTOR_CLEAR` テスト群と同じ `createDaemon(testDir)` ヘルパーを使う。`cmux.getPaneForSurface` / `cmux.listSiblingSurfaces` / `cmux.closeSurface` は `spyOn` でモック（`getPaneForSurface` は `"pane:1"` を返して surface 実在を装う）。`backend.killClaudeProcess` は `ccBackend(state.backend)` 経由で取れるので spyOn でモック可能（`ClaudeCodeBackend.prototype.killClaudeProcess` を mockResolvedValue(undefined)）。
  - **`markTaskAborted` を呼ぶケースの fixture (R5)**: `markTaskAborted` は task.md frontmatter から status / journal を読むため、テスト setup で **`task.md` 本体（frontmatter 込み）と `task-state.json` の両方を書き出す**必要がある（main.test.ts:759–772 の `setupTeamDir` と同等）。具体的には:
    - `.team/tasks/<id>-<slug>/task.md` を frontmatter 付きで作成（`status: assigned`, `taskRunId: ...` 等）
    - `.team/tasks/<id>-<slug>/runs/<taskRunId>/` ディレクトリを作成
    - `.team/task-state.json` に `{[taskId]: {status: "assigned", taskRunId, ...}}` を書き出す
    - テスト後に `loadTaskState` で「aborted」に変わったことを確認し、`task.md` frontmatter が更新されていることも assertion
  - **trace DB assertion (R3)**: `state.traceDb` を経由して `SELECT * FROM task_sessions WHERE event='aborted' AND role='conductor' AND task_run_id=?` を実行し 1 行存在することを確認
  - **watcher 停止 assertion (R1)**: 事前に `conductor.pidWatcherInterval = setInterval(()=>{}, 999999)` および `conductor.mailboxWatcherStop = mockFn` を仕込み、reset 後に `pidWatcherInterval === undefined` および `mockFn` が呼ばれたことを assertion
- **`main.test.ts`**: 既存の `runCli` + mock HTTP server (`createServer`) で `postMessage` を捕捉。`team.json` を `setupTeamDir` 系で書き分ける（broken / running / 不在）。env による auto-resolve は `runCli` の env オプションに `CMUX_SURFACE` を渡す。`cmux.getCallerSurface` への fallback は env が優先なのでテスト不要。
- **`schema.test.ts` (R6)**: 既存 "QueueMessage discriminated union" describe ブロック (L82, L461) に `RESET_CONDUCTOR` パースケースを追加。`queue.test.ts` ではない（queue.test.ts は queue file 統合テスト用）。

## 7. 作業手順（TDD 順序）

### RED フェーズ

1. **`schema.test.ts`** (R6) の "QueueMessage discriminated union" describe ブロックに「`RESET_CONDUCTOR` メッセージが QueueMessage discriminated union にパースされる」テストを追加 → **fail**（schema 未追加で discriminatedUnion パース失敗）
2. `daemon.test.ts` に「broken → reserved」「未登録 → not_found」「force=false で running → ignored」「force=true で running → reserved + aborted + task_sessions 行 + watcher 停止」テストを追加 → **fail**（handleMessage の case 不在で `state.conductors` が変化せず assertion 失敗、または schema パース失敗）
3. `main.test.ts` に「`--surface` 指定で POST 検証」「assigned + --force なしで exit 1」「出力文言 (R8)」テストを追加 → **fail**（コマンド未登録で「Unknown command」エラー）

### GREEN フェーズ

4. `task.ts:577–585` の `AbortReason` union に `"reset_conductor"` を追加し、T290 解説コメントの "6 経路" を **"7 経路"** に更新（R2）
5. `schema.ts` に `ResetConductorMessage` 定義 + `QueueMessage` union 追加 + 型 export → schema.test.ts pass
6. `daemon.ts` の `handleMessage` switch に `RESET_CONDUCTOR` case を実装（§3.4 のスケルトンそのまま、R1 watcher 停止 / R3 task_sessions / R4 notifyStateChanged を含む）→ daemon.test.ts pass
7. `main.ts` に `cmdResetConductor` 実装 + WRITE_COMMANDS 登録 + dispatch case 追加 + 出力文言 (R8) → main.test.ts pass
8. `i18n.ts` に `help_reset_conductor` (en/ja) + `help_main` 1 行追加 → `bun run main.ts reset-conductor --help` で表示確認

### REFACTOR フェーズ

9. SESSION_CLEAR / RESET_CONDUCTOR の重複（pid 退避 → killClaudeProcess → resetConductor reserved）の helper 抽出は **本タスクでは見送り** (§3.6 / §8.2 (b))。差分 5 行 × 2 箇所では YAGNI。
10. `bun test --timeout 30000 daemon.test.ts conductor.test.ts main.test.ts schema.test.ts` を回し緑確認（**全体 `bun test` 実行は禁忌** — CLAUDE.md 既知の注意点）。
11. `bun run main.ts reset-conductor --help` / 実機 e2e で以下を確認:
    - broken Conductor 復旧を 1 回
    - **assigning + force で旧 SESSION_ENDED 遅延着信時に `disconnected` に倒れないか**（R9-2 / §5 の表）
    - **`starting` 中 reset → source=startup の SESSION_STARTED 後着が `reserved` を上書きしないか**（観察可能性のための注記ログ `reset_during_starting` を確認）

## 8. 想定リスク・未解決事項

### 8.1 リスク

- **`pane のタブ名リセット`（task.md step 2c）の扱い**: 既存 `resetConductor` は cmux 側のタブ名（pane title）を直接書き換えていない。`team.json` 上の status 変更で TUI 表示が間接更新される設計に依存しているため、本実装でも追加処理は入れない。実機で「タブ名が古いまま残る」事象を確認したら別タスクで対処。
- **`asking` 状態の force**: AskUserQuestion 中の Conductor を強制リセットすると、ユーザー入力待ちのコンテキストが破棄される。journal に明示記録すれば許容できる（spec 上は assigned 系として扱う）。
- **`assigning` 中 race**: SESSION_STARTED(source=clear) を待っている最中に reset すると、prompt 送信直後で claude が無反応になる窓がある。`killClaudeProcess` で kill すれば収束するが、prompt 配信ログだけが残る可能性。`promptSentAt` / `promptBytes` クリアは `resetConductor` で既に行うため state 整合性は保たれる（§6.2 で 1 ケース assertion 追加）。
- **`markTaskAborted` 失敗時の partial recovery**: task-state 書換に失敗しても reset 処理は続行する設計（observability 優先）。手動で task-state を直す必要が出る可能性があるが、`error` ログで検知可能。
- **`starting` 中 reset の race（観察可能性のための注記ログ追加候補）**: source=startup の SESSION_STARTED が reset 完了後に到着し `reserved` を上書きする可能性。実害は小さい想定だが、`reset_during_starting` 注記ログを daemon 側に追加することで観測可能性を高めることを検討（§5 / §7 step 11）。

### 8.2 未解決事項（実装前にユーザー確認したい）

- (a) **CLI のメッセージ仕様**: R8 で `OK reset ${normalizedSurface} (${oldStatus} → reserved)` に統一。`cmdClearConductor` の `OK cleared ...` パターンに合わせる。
- (b) **`killAndResetToReserved` helper 抽出の是非**（REFACTOR step 9）: SESSION_CLEAR 経路との重複を helper にまとめるべきか、文脈差（ログ文言・reason 値）を残してインラインで持つか。**初版はインラインで確定**（YAGNI、§3.6 と整合）。
- (c) **Master surface への適用**: タスク説明書の Out of scope に「Master surface 用の reset コマンド（必要なら別タスク）」とあるため、`reset-conductor` が誤って Master surface を指された場合は CLI 側で「conductor not found in team.json」exit 1 で弾く（`team.json.conductors[]` に Master は載らない）。
- (d) **`broken` で `taskId` が稀に残るケース**: `markTaskAborted` 呼び出し条件は `isAssigned && conductor.taskId` にしているため、broken でも taskId が残っていれば abort 処理が走らない（broken は `isAssigned = false`）。これが想定通りか（broken 時の taskId は既にクリア済みのはずだが、edge case で残ることがある場合の挙動）。本実装では「broken は abort 経路に入らず reset のみ実行」の防御的扱い。
- (e) **events.jsonl への `conductor_reset` event 追加判断 (R7)**: 現行 16 event には reset がなく、§3 spec 改訂で event #17 として追加する余地がある。`hook_signals` テーブルには `RESET_CONDUCTOR` 行が自動で入る（daemon.ts:1524–1530 の hook_signal pipeline）ので最低限の trace は確保される。**判断軸**: `hook_signals` の自動取込みで retrospective 観察が足りるなら本タスクスコープ外で別タスク化、足りないなら本タスクで events.jsonl への append を追加。**ユーザー判断を仰ぐ**。

## Revision History

| Recommendation | 反映内容 |
|---|---|
| **R1**: pidWatcherInterval / mailboxWatcherStop の明示停止 | §3.4 擬似コードに `isAssigned` 分岐の冒頭で `pidWatcherInterval` を `clearInterval` し `mailboxWatcherStop()` を呼ぶ 2 ステップを追加（`markTaskAborted` の前・`killClaudeProcess` の前）。§4 データフローに「[R1] isAssigned → pidWatcherInterval / mailboxWatcherStop 停止」行を追加。§6.1 AC6 の主な assertion に `pidWatcherInterval === undefined` / `mailboxWatcherStop === undefined` を追加。§6.2 に専用テスト「force=true で running から reserved に戻ると pidWatcherInterval / mailboxWatcherStop が停止される」を追加。§6.3 mock セクションに watcher 停止 assertion の手順を明記。 |
| **R2**: markTaskAborted の reason 型違反 | §2.1 `task.ts:577–585` 行を新設し `AbortReason` の現行 7 メンバーと「`"reset_conductor"` を追加し T290 コメント "6 経路" を "7 経路" に更新する」方針を明記。§7 GREEN step 4 で「task.ts AbortReason に `"reset_conductor"` を追加し T290 コメントを更新」を最初に行う手順を追加。§6.1 AC6 の主な assertion に「journal が `reason=reset_conductor;` で始まる」を明記。§3.4 擬似コードの `markTaskAborted` 第 3 引数を `"reset_conductor"` に確定（コメント `[R2]` 付き）。 |
| **R3**: task_sessions 行追加 | §3.4 擬似コードに `insertTaskSession({event:"aborted", role:"conductor", surface, task_run_id, session_id})` を `markTaskAborted` 直後に追加（コメント `[R3]` 付き、try/catch でエラーログ）。§2.1 に `trace-db.ts` の `insertTaskSession` 行を追加。§4 データフローに「[R3] insertTaskSession({event:\"aborted\", ...})」行を追加。§6.1 AC6 の主な assertion に「trace DB の `task_sessions` に `event=\"aborted\", role=\"conductor\"` 行が 1 つ存在する」を追加。§6.2 に専用テスト「force=true で task_sessions に aborted 行が追加される」を追加。§6.3 mock セクションに `state.traceDb` 経由の SELECT assertion 手順を追加。 |
| **R4**: notifyStateChanged 明示 | §3.4 擬似コードに `revertedChildren.length > 0` で `notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade")` を `markTaskAborted` 後に明示呼び出しするブロックを追加（コメント `[R4]` 付き、SESSION_CLEAR running 経路 daemon.ts:2778–2779 と同形）。§4 データフローに「[R4] revertedChildren > 0 → notifyStateChanged」行を追加。 |
| **R5**: §6.3 fixture 補強 | §6.3 の `daemon.test.ts` mock セクションを書き換え、`task.md` 本体（frontmatter 込み: `status: assigned`, `taskRunId`）と `task-state.json` の両方を書き出す手順を箇条書きで明記（main.test.ts:759–772 の `setupTeamDir` 同等）。§2.1 に `main.test.ts` の `setupTeamDir` 行を追加し参照可能にした。 |
| **R6**: §7 step 1 のテストファイル変更 | §7 RED step 1 のテスト追加先を `queue.test.ts` から **`schema.test.ts`** に変更し「"QueueMessage discriminated union" describe ブロック (L82, L461) に追加」と注記。§6.2 のスキーマテスト行も `schema.test.ts` (R6) に変更。§2.1 に `schema.test.ts` の行を追加。§2.2 で `queue.test.ts` を「queue file の write/read 統合テスト用」と明記し混同を防止。 |
| **R7**: §8.2 (e) 新設 | §8.2 (e) を新設: 「events.jsonl への `conductor_reset` event 追加判断」。判断軸として「`hook_signals` テーブルの自動取込みで retrospective 観察が足りるかどうか」を明記し、足りるなら本タスク外で別タスク化、足りないなら本タスクで append を追加することを user 判断事項として記載。§2.1 に `daemon.ts:1524–1530` の `hook_signals` pipeline 行を追加。 |
| **R8**: CLI 出力文言の統一 | §3.2 step 8 の CLI 出力文言を `OK reset ${normalizedSurface} (${oldStatus} → reserved)` に統一（`oldStatus` は team.json から読み込んだ pre-check 時点の値）。§3.2 step 5 で `oldStatus = entry.status` を保持する旨を追加。§6.2 main.test.ts に「出力文言が "OK reset <surface> (<oldStatus> → reserved)" 形式である」テストを追加。 |
| **R9**: §5 エッジケース表に 2 行追加 | §5 末尾に 2 行追加: (R9-1)「`RESET_CONDUCTOR` と並行 `TASK_CREATED` → reset 完了 → reserved → 次 tick で scanTasks が拾う（race 無し）」、(R9-2)「`assigning` + force で旧 SESSION_ENDED 遅延着信 → `disconnected` に倒れる可能性。実機 e2e 確認項目に追加」。§7 REFACTOR step 11 の実機 e2e 確認項目に R9-2 を明示的に追加。 |

### 補助的修正（design-review §3 minor / observation log）

- **§5.2 (3.2 minor) `starting` 中 reset の race 注記ログ案**: §5 リスク表の `status==="starting"` 行に「観察可能性のための注記ログ追加候補: `reset_during_starting`」を追記。§7 step 11 の実機 e2e 確認項目に「`starting` 中 reset → source=startup の SESSION_STARTED 後着が `reserved` を上書きしないか」を追加。§8.1 リスクにも 1 行追記。
- **§3.4 minor (CLI pre-check と真値の race)**: §3.2 step 6 の冒頭に「pre-check は best-effort UX、真の判定は daemon 側で再実行する。`team.json` は daemon の snapshot で 数 ms 遅れる可能性があり、`task-state.json[taskId].status === "assigned"` が真値」と明記。§4 データフローにも「best-effort UX, 真値は daemon 側」を補足。
- **§6.3 minor (`assigning` + force での promptSentAt / promptBytes クリア)**: §6.2 に専用テスト「`RESET_CONDUCTOR` が assigning Conductor に force=true で来ると promptSentAt / promptBytes がクリアされる」を 1 ケース追加し、conductor.ts:800–801 の挙動を assertion する旨を明記。§8.1 の `assigning` 中 race 行の末尾に「§6.2 で 1 ケース assertion 追加」と注記。
- **§3.6 (cleanupAssignedTask 重複の確定)**: design-review §3.2 minor に応じて新節 §3.6 を新設し「本タスクでは抽出しない (YAGNI)」を明示。§7 REFACTOR step 9 にも同旨を明記し、実装者がリファクタに引きずられないようガード。
- **§2.2 (task.md 表記乖離の脚注)**: design-review §3.1 nit に応じて「task.md の queue file 表記は時代遅れ、本実装は HTTP POST を採用」の脚注を追加。
