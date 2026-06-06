# T021 実装計画 — surface 不在の残骸 Conductor を team.json から除去できる経路を追加

> Planner: surface:102 (task-021-1779574168)
> 対象: 存在しない surface（観測例: surface:27）を `status: "broken"` のまま `team.json` に
> 居座らせている残骸 Conductor を、ユーザー操作 / daemon restart の **両方**で安全に除去できる経路を追加する。

---

## 改訂履歴

| Rev | 反映内容 |
|---|---|
| R1 | §5 のガード条件テーブルに「tree 成功 + 特定 surface が listing から一時的に漏れる」行を追加。`skills/c11/SKILL.md` には `c11 tree` の atomicity / consistency 保証が明文化されていないため、「漏れない」と断定せず、§3.2 実装に **double-check（1 回目 undefined → 50ms 後 retry、両回 undefined のときだけ prune）** を選択肢として併記して結論先送りを避けた。脚注で「v0.9.0+ で `getPaneForSurface` は tree 失敗時 throw に変わっており（cmux.ts:298-310, L290 コメント）、undefined は『tree 成功 & surface 不在』のみ意味する」を明示。 |
| R2 | §9「実装スコープ外」に「B 経路（planLayoutRestore）C 分類 `cleanup-stale` が status を見ずに `cmux.closeSurface` する既存挙動（broken + surface alive + pid undefined で daemon restart すると pane を破壊する）は本タスク範囲外。別タスク起票もしない」を明示追加。 |
| R3 | 「broken ⇒ pid undefined」の前提を §1.2 末尾と §3.2 prune 分岐コメントに記し、方針 (a) を採用（「pid が残っていても prune する」）。§4.1 manager.log payload と §4.2 events.jsonl payload に `pid=${pid ?? "null"} alive=${pid ? cmux.isAlive(pid) : false}` 相当を追加（`conductor_broken` の aliveSuffix と整合, conductor.ts L917-920 参照）。 |
| R4 | §3.2 末尾の main.ts 出力メッセージを **採用**で確定。ack 待ちを避けつつ「prune と idle 復帰の両可能性」を文言で伝える形式に：英 `OK cleared <surface> — pruned from team.json if the surface is gone, otherwise reset to idle. See manager.log / team.json for details.` / 日 `OK cleared <surface> — surface 不在なら team.json から prune、実在なら idle 復帰。詳細は manager.log / team.json を確認してください。` |
| R5 | §3.1 に Test C5（`getPaneForSurface` throw 時に entry 維持 + broken 維持 + daemon が落ちず次メッセージを処理）を追加。C2 では `getPaneForSurface` が 2 回呼ばれる（CONDUCTOR_CLEAR ハンドラ + resetConductor 内）ことを mock に許容させる旨を明記。併せて「prune 分岐で取得した pane を resetConductor の opts として渡して二重 invocation を避ける」簡素化案を §3.2 設計判断ノートに併記し、実装者が選べるようにした。 |
| R6 | §3.2 prune 分岐コードコメントに以下 3 点を明示：(1) broken ⇒ taskRunId == null なので task-state mutation (`applyTaskEvent` / `markTaskAborted`) を呼ばない、(2) archive は broken 遷移時点で完了済みなので再 archive しない、(3) pane は元から不在なので `closeSurface` を呼ばない。 |

---

## 1. 現状分析（実コード Read 結果）

### 1.1 broken 永続化のしくみ（T250）

- `daemon.ts:1104,1113` の `restoreConductorState`：team.json から復元する際、
  `status === "broken"` をそのまま保持する。再起動でも消えない。
- `daemon.ts:2129,2682,2794,3010` の `SESSION_STARTED` / `SESSION_ACTIVE` /
  `SESSION_IDLE` / `SESSION_CLEAR` 各ハンドラ：broken は全て `logBrokenIgnore` で early
  return し、自動 idle 化しない。
- `daemon.ts:4360-4363` の `monitorConductors`：broken は disconnect-timeout 判定の
  対象外。
- 解除経路は **明示的な `clear-conductor` / `abort-task` / `restart-task`** のみ
  （`docs/spec/07-state-machine.md:36,104,131,145`）。observatory として「壊れた事実を
  人間が認識するまで消さない」設計意図（T250）。

### 1.2 clear-conductor → CONDUCTOR_CLEAR → resetConductor の経路

- `main.ts:5216-5256 cmdClearConductor`：
  1. `team.json` を読み、`status === "broken"` を pre-check
  2. `postMessage({ type: "CONDUCTOR_CLEAR", surface, reason: "user_clear" })`
- `daemon.ts:1665-1693 case "CONDUCTOR_CLEAR"`：
  1. `state.conductors.get(surface)` で entry を取得
  2. `status !== "broken"` なら ignore
  3. `resetConductor(conductor, projectRoot, workspace, { targetStatus: "idle", reason: "cleared", cleanupMode: { kind: "archive", reason: "clear_conductor" } })`
  4. `requestWakeup(state)` で次 tick を即時起動
- `conductor.ts:737- resetConductor`：
  - **L758-767 で `getPaneForSurface(conductor.surface, workspace)` を呼び、
    pane が undefined なら `effectiveTargetStatus = "broken"`**（surface 不在ガード、T251）
  - L878-908 で `conductor.status = effectiveTargetStatus` を設定して終了
  - 結果として「broken → broken」の no-op。**team.json からの除去は起こらない。**

→ surface ごと消滅した broken は CONDUCTOR_CLEAR を送っても消せない。これが本タスクの根本症状。

**broken 遷移時の pid 不変条件（R3 で明示化）**: `surface_missing` 経由の broken
（`conductor.ts:765` 周辺）では **pid が残ったままになるケースがある**（pid を unset
する責務はそこにはない）。つまり「broken ⇒ pid undefined」は成立しない。
本タスクの prune は **方針 (a)** = 「pid が残っていても prune する」を採用する（理由は §3.2 ノート）。
ただし `taskRunId` は broken 遷移時に必ずクリアされる（C-I2 と整合）ので、task-state mutation を
追加で打つ必要は無い（R6）。

### 1.3 daemon 起動時 reconcile（planLayoutRestore / applyRestorePlan）

- `layout-restore.ts:63 planLayoutRestore`：team.json の各 conductor entry を 5 ラベルに分類
  - A `keep-alive`        : surface 実在 + PID 生存
  - B `resume-existing`   : surface 実在 + PID 死亡 + running task
  - C `cleanup-stale`     : surface 実在 + PID 死亡 + idle 残骸 → pane close
  - D `resume-new-surface`: surface 消失 + running task
  - **E `discard`         : surface 消失 + idle/その他 → entry 破棄（reason="surface_missing_no_task"）**
- `daemon.ts:1163 applyRestorePlan`：
  1. `state.conductors.clear()` で一括クリア
  2. A / B のみ `state.conductors.set` で再登録
  3. C/E は `applyDiscardOnly` で副作用（close-surface + log）のみ実行、
     **state.conductors への再登録はしない**
- `daemon.ts:1339 applyDiscardOnly`：
  - C: `cmux.closeSurface(surface)` + `conductor_stale_surface_closed` log
  - E: `conductor_discarded` log（surface_missing_no_task のみ）

→ **理論上、`status="broken"` で pid=undefined・surface 消失の entry は E 経路で discard される**。
すなわち daemon 再起動さえ走れば surface:27 は team.json から落ちるはず。

> ⚠️ B 経路 C 分類が status を見ずに `cmux.closeSurface` する既存挙動は、broken + surface alive
> + pid undefined のケースで pane を破壊する副作用がある（observability 哲学と衝突する既存挙動）。
> **本タスクでは触らない**（R2 / §9 で明示）。

### 1.4 本タスク発見時点での再現確認

live `.team/team.json` (root, worktree 外) を確認したところ：

```json
{ "surface": "surface:27", "status": "broken", "pid": undefined,
  "disconnectedAt": "2026-05-22T22:41:08.786Z", "agents": [] }
```

`.team/daemon.heartbeat` → daemon `pid=24019`, `uptime_sec=95176`（約 26h 連続稼働）。
manager.log の直近 restart は `2026-05-23T04:49:08`（boot_completed）。
**surface:27 が broken になった時刻（22:41 UTC ≒ 翌 07:41 JST）は最終 restart より後**。
つまり「最後の restart 以降に broken に遷移し、それ以降 restart が無い」状態。

→ **planLayoutRestore の E 経路は機能している**（M17a/b/c のテストで保証済み）が、
それが発火するのは daemon 再起動時のみ。runtime 中に broken-残骸を除去する経路が無い。
クリア手段：
- `clear-conductor`：surface 不在ガードで bounce → broken のまま
- `abort-task`：taskId が無いので Conductor を引けない（broken 遷移時に taskId クリア済）
- `restart-task`：同上、taskId 起点
- `reset-conductor`：surface 実在前提（pane が無いと kill 対象が無い）
- daemon kill + 再起動：効くが副作用が大きすぎる（他 Conductor の resume 経路を走らせるので、
  observability・観測ノイズ・タイミングリスクが大）

→ **runtime に閉じた、副作用の小さい除去経路が必要**。

---

## 2. 方針選定

| | 方針 | 役割 | 実装コスト | 誤削除リスク |
|---|------|------|-----------|--------------|
| A | `clear-conductor` の surface 不在分岐を追加し team.json から entry を削除 | runtime 中の即時 prune | 小（daemon 1 handler + main.ts 文言調整） | 低（明示 CLI 起点） |
| B | daemon 起動時 reconcile の拡張 | 復旧後の永続的整合性保証 | 既存 E 経路で大部分カバー済み（追加テストで補強） | 既存ロジックの範囲内 |

### 採用方針: **A 主軸 + B を回帰テストで補強**

理由：

1. **runtime 中の prune 経路が現状ゼロ**。A が無いと restart せずに残骸を消す手段が無い。
   reset-conductor は surface 実在前提、abort/restart-task は taskId 起点なので broken には届かない。
2. **B は planLayoutRestore E 経路で論理的にはカバー済み**（restart すれば落ちる）。
   ただし `status === "broken"` 専用の test case が daemon.test.ts に明示されていない（M17 系は
   全 entry idle/discard のシナリオ）。**ここに dedicated test を追加**して回帰防止する。
3. B を runtime tick で動かす案（例: monitorConductors 内で broken + surface_missing なら prune）も
   検討したが、observatory 制約（壊れた事実を残す）と衝突するため取らない。**人間の明示操作起点が
   観測哲学に合致**する。
4. 観察箱原則：A の prune は明示 CLI 起点 + journal/log 双方 + events.jsonl 出力で
   「いつ・なぜ消したか」を retrospective に追える状態にする（silent な state mutation を作らない）。

---

## 3. 実装ステップ（TDD）

### 3.1 まず書くテスト（赤）

`skills/cmux-team/manager/daemon.test.ts` の CONDUCTOR_CLEAR 系 describe ブロックに以下を追加：

#### Test C1: surface 不在の broken に対する CONDUCTOR_CLEAR が entry を削除する
- pre-state: `state.conductors` に `{ surface: "surface:99", status: "broken", pid: undefined }` を入れる
- mock: `cmux.getPaneForSurface("surface:99")` → undefined（surface 消失）
- act: `handleMessage(state, { type: "CONDUCTOR_CLEAR", surface: "surface:99", reason: "user_clear", timestamp })`
- assert:
  - `state.conductors.has("surface:99") === false`
  - manager.log に `conductor_pruned` が出る（reason=clear_conductor_surface_missing）
  - manager.log の payload に `pid=null alive=false` が含まれる（R3）
  - events.jsonl に `{event:"conductor_pruned", conductor_surface:"surface:99", reason:"clear_conductor_surface_missing", pid:null, pid_alive:false}` が出る
  - notifyStateChanged が呼ばれる（team.json 書き出しトリガ）

#### Test C2: surface 実在の broken に対する CONDUCTOR_CLEAR は従来通り idle 復帰
- pre-state: `state.conductors` に `{ surface: "surface:99", status: "broken", pid: 12345 }`
- mock: `cmux.getPaneForSurface("surface:99")` → `"pane:abc"`（surface 実在）
  - ⚠️ **R5: `getPaneForSurface` が 2 回呼ばれる**（CONDUCTOR_CLEAR ハンドラ内 pre-check
    + resetConductor 内 surface 実在ガード）。単発返答 mock は禁止 — `mock.fn().mockReturnValue("pane:abc")`
    のように毎回同じ値を返す形にする（単発 mock だと 2 回目で undefined を受けて broken に倒れ assertion が破壊される）
  - ※ 実装側で「prune 分岐で取得した pane を resetConductor opts として渡して二重 invocation を回避」する
    設計を採った場合は、mock は 1 回返却で十分（実装案 §3.2 ノート参照）
- act: CONDUCTOR_CLEAR
- assert:
  - `state.conductors.get("surface:99")?.status === "idle"`（resetConductor が走る）
  - **`conductor_pruned` ログは出ない**（regression 防止）
  - `conductor_reset` ログが出る

#### Test C3: surface 不在でも `status !== "broken"` なら prune しない（既存 not_broken ガード維持）
- pre-state: `status: "running"`、surface 消失
- act: CONDUCTOR_CLEAR
- assert: `conductor_clear_ignored reason=not_broken` が出る、entry は維持される

#### Test C4 (B 回帰): daemon restart で broken + surface 消失 + pid undefined の entry が discard される
- 既存 M17a パターンを派生：team.json に `{surface:52, status:"broken", pid:undefined, disconnectedAt:..., agents:[]}` を 1 件、他 2 件は alive。
- `__setTreeImpl` で surface:52 を含まない tree を返す
- act: `initializeLayout(state)`
- assert:
  - `state.conductors.has("surface:52") === false`
  - manager.log に `conductor_discarded ... reason=surface_missing_no_task` が出る
  - team.json には surface:52 が含まれない
  - 他 2 件（alive）は state に残る

#### Test C5 (R5 追加): `getPaneForSurface` が throw した場合は entry を維持し daemon が継続する
- pre-state: `state.conductors` に `{ surface: "surface:99", status: "broken", pid: undefined }`
- mock: `cmux.getPaneForSurface("surface:99")` → throw `new Error("tree failed")`
- act: CONDUCTOR_CLEAR を投げ、続けて次の無害なメッセージ（例 `SESSION_IDLE` for 別 surface）を投げる
- assert:
  - `state.conductors.get("surface:99")?.status === "broken"`（prune も idle 復帰も起きない）
  - `state.conductors.has("surface:99") === true`（entry 維持）
  - manager.log に `conductor_clear_failed` か相当のエラーログが残る
  - 2 件目のメッセージが正常に処理されること（daemon が落ちていない・例外で handleMessage が破壊されていない）

### 3.2 実装（緑）

**ファイル: `skills/cmux-team/manager/daemon.ts`**

CONDUCTOR_CLEAR ハンドラ（L1665-1693）に surface 実在 pre-check を追加：

```ts
case "CONDUCTOR_CLEAR": {
  const conductor = state.conductors.get(message.surface);
  if (!conductor) {
    await log("conductor_clear_ignored",
      `surface=${message.surface} reason=not_found`);
    break;
  }
  if (conductor.status !== "broken") {
    await log("conductor_clear_ignored",
      `${formatSurface(conductor.surface, "C")} status=${conductor.status} reason=not_broken`);
    break;
  }
  // T021 NEW: surface 不在の broken 残骸は entry を prune する（runtime 中の clear 経路）
  //          resetConductor の surface 実在ガード（T251）は idle 復帰を broken に倒し戻すため、
  //          そこに到達する前に「pane が無い = 観測すべき pane も無い」を確定させて drop する。
  //
  //          drop 対象は state.conductors の broken entry に限定。R6 で確認した不変条件：
  //            (1) broken ⇒ taskRunId == null（broken 遷移時に必ずクリア済み, C-I2）。
  //                よって task-state mutation (applyTaskEvent / markTaskAborted) は呼ばない。
  //            (2) archive は broken 遷移時点で完了済み（i18n.ts:510,1595 の注釈）。
  //                よって再 archive (archiveWorktree) は呼ばない。
  //            (3) pane は元から不在（pre-check で undefined 確定）。
  //                よって closeSurface も呼ばない（呼んでも no-op だが意図を明示）。
  //
  //          pid 状態（R3 方針 (a)）:
  //            surface_missing 経由の broken では pid が残る場合がある。pid が残っていても prune する。
  //            ただし「いつ消したか」「prune 時に pid が生きていたか」を retrospective に追えるよう
  //            ログに pid / pid_alive を含める（conductor_broken の aliveSuffix と整合, conductor.ts L917-920）。
  const pane = await cmux.getPaneForSurface(conductor.surface, state.workspace ?? undefined);
  if (pane === undefined) {
    const prunedPid = conductor.pid;
    const prunedPidAlive = prunedPid !== undefined ? cmux.isAlive(prunedPid) : false;
    state.conductors.delete(message.surface);
    notifyStateChanged("daemon.ts:CONDUCTOR_CLEAR:surface-missing-prune");
    await log(
      "conductor_pruned",
      `${formatSurface(conductor.surface, "C")} reason=clear_conductor_surface_missing ` +
      `pid=${prunedPid ?? "null"} alive=${prunedPidAlive} ` +
      `started_at=${conductor.startedAt ?? "-"} disconnected_at=${conductor.disconnectedAt ?? "-"}`,
    );
    await emitEvent({
      event: "conductor_pruned",
      conductor_surface: conductor.surface,
      reason: "clear_conductor_surface_missing",
      pid: prunedPid ?? null,
      pid_alive: prunedPidAlive,
    });
    requestWakeup(state);
    break;
  }
  // 既存経路: surface 実在 broken → idle 復帰
  // (R5 二重 invocation 回避の簡素化案を採るなら、ここで pane を渡す API 拡張を入れる)
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    targetStatus: "idle",
    reason: message.reason ?? "cleared",
    cleanupMode: { kind: "archive", reason: "clear_conductor" },
  }, ccBackend(state.backend));
  requestWakeup(state);
  break;
}
```

**設計判断のポイント:**

- `state.conductors.delete` を入れることで、次回 `notifyStateChanged` 経由の team.json
  シリアライズ時に entry が落ちる（team.json は `state.conductors.values()` から派生する）。
- `archiveWorktree` 系の cleanup は呼ばない：broken 遷移時に既に archive 済み（spec §1.1 注釈
  「worktree / branch 残骸は broken 遷移時点で既に掃除済み」、`i18n.ts:510,1595`）。
  もう一度 archive すると同 reason で空 mv が走るのは無駄。
- `cmux.getPaneForSurface` は internal で `cmux tree` を叩く。`tree` が失敗した場合は throw
  される（cmux.ts:298-310, L290 コメント）。throw 時は handleMessage の既存 catch にフォールバック
  し entry は維持される（Test C5 で保証）。
- **R1 オプション（double-check）**: `c11 tree` の listing atomicity は本家 spec に
  明文化されていない。万が一「tree 成功・特定 surface が一時的に listing から漏れる」ケースが
  実機で観測されたら、prune 分岐を以下のように double-check 化することで誤削除リスクを潰せる：
  ```ts
  let pane = await cmux.getPaneForSurface(conductor.surface, state.workspace ?? undefined);
  if (pane === undefined) {
    await delay(50);
    pane = await cmux.getPaneForSurface(conductor.surface, state.workspace ?? undefined);
  }
  if (pane === undefined) { /* prune */ }
  ```
  初版は素直に 1 回呼びで実装し、観測時に追加検討する（YAGNI）。実装者が必要と判断すれば
  最初から double-check を入れて良い。
- **R5 二重 invocation 回避の簡素化案（選択肢）**: prune 分岐で取得した `pane` を
  `resetConductor` の opts として渡し、resetConductor 内の `getPaneForSurface` 再呼出しを
  skip できる API 拡張（例: `opts.knownPane?: string`）を入れる。これにより c11 tree の
  呼出し回数が 2 → 1 に減り、`getPaneForSurface` の状態揺らぎを受けるウィンドウも縮む。
  実装者の裁量で選択可。

**ファイル: `skills/cmux-team/manager/main.ts`**

`cmdClearConductor`（L5216-5256）の pre-check（L5240 status !== "broken" 拒否）はそのまま維持。
**R4 採用**: 末尾出力メッセージを prune / idle 復帰の両可能性を伝える文言に差し替える
（ack 待ちは入れない — ack 待ちはコスト過大、log で十分追える）：

```ts
// en
console.log(
  `OK cleared ${normalizedSurface} — pruned from team.json if the surface is gone, ` +
  `otherwise reset to idle. See manager.log / team.json for details.`
);
// ja
console.log(
  `OK cleared ${normalizedSurface} — surface 不在なら team.json から prune、実在なら idle 復帰。` +
  `詳細は manager.log / team.json を確認してください。`
);
```

i18n catalog を経由する（既存 clear-conductor 出力と同様）。

**ファイル: `skills/cmux-team/manager/events-writer.ts`**

`EventStreamRecord` union に `conductor_pruned` を追加（schema_version は bump しない、add-only）：

```ts
  | {
      // T021: surface 不在の broken 残骸を CONDUCTOR_CLEAR で除去したときの event。
      // observatory: 「いつ・なぜ消したか」を retrospective に追える。
      // 現状の reason は 1 値だが将来 (例: startup_reconcile_prune) 拡張余地を残す。
      // R3: prune 時の pid 状態を併記（surface_missing 経由 broken は pid が残ることがある）
      event: "conductor_pruned";
      conductor_surface: string;
      reason: "clear_conductor_surface_missing";
      pid: number | null;
      pid_alive: boolean;
    }
```

**ファイル: `skills/cmux-team/manager/i18n.ts`**

clear-conductor の help 文言（L494-511 / L1579-1596）を補足：

```
Notes:
  - Only Conductors currently in broken state can be cleared
  - For other states, use abort-task / restart-task
  - Worktree / branch residue is already cleaned up at the broken transition; this CLI only resets the status
  - If the underlying surface no longer exists (e.g. pane was killed), the entry is pruned from team.json instead of being reset to idle
```

日本語版にも同等の追記。R4 で確定した出力文言も同 catalog に追加する。

### 3.3 docs/spec/07-state-machine.md の更新

§1.1 broken 説明と §1.2 transitions に **prune ケース**を明示：

- L36 に追記：「surface 不在の broken は `cmux-team clear-conductor` で entry ごと
  prune される（idle に戻らず削除）」
- L65 `CLEAR_MANUAL` 行の備考に prune ケースの注釈を追加
- L104 mermaid の `broken --> [*]` ラインに「prune (surface missing)」を併記
- §1.6 不変条件に C-I6 を追加検討：
  「C-I6: surface 不在の broken は CONDUCTOR_CLEAR で `state.conductors` から削除される
  （reducer 副作用なし、daemon ハンドラ直のみ）」

`docs/spec/10-events-stream.md` にも `conductor_pruned` event の schema 追記（pid / pid_alive 含む）。

---

## 4. 新規イベント / ログの payload 定義

### 4.1 manager.log

```
conductor_pruned C[27] reason=clear_conductor_surface_missing pid=null alive=false started_at=2026-05-22T22:03:07.926Z disconnected_at=2026-05-22T22:41:08.786Z
```

- prefix: `formatSurface(conductor.surface, "C")` で他の conductor_* 系と整合
- reason: `clear_conductor_surface_missing`（将来拡張余地として enum 化）
- **R3 追加フィールド**: `pid=${pid ?? "null"} alive=${alive}` — broken 時に pid が残る
  ケース（surface_missing 経由）でも prune するため、prune 時点の pid 状態を後から追えるようにする。
  `conductor_broken` のログ aliveSuffix（conductor.ts L917-920）と書式を揃える。
- 補足フィールド: `started_at` / `disconnected_at` を出すことで「いつ作られ・いつ壊れ・いつ消したか」を 1 行で追える

### 4.2 events.jsonl

```json
{"schema_version":2,"ts":"2026-05-24T...","event":"conductor_pruned","conductor_surface":"surface:27","reason":"clear_conductor_surface_missing","pid":null,"pid_alive":false}
```

- writer 自動付与: `schema_version`, `ts`
- payload: `conductor_surface` (必須), `reason` (enum literal), `pid` (number | null, R3), `pid_alive` (boolean, R3)

---

## 5. 誤削除防止のガード条件（observatory 制約の維持）

| 条件 | 実装上の表現 | 備考 |
|---|---|---|
| state に登録された entry のみ対象 | `state.conductors.get(surface)` が undefined なら早期 break | — |
| status === "broken" 以外は触らない | 既存 `if (status !== "broken") ignore` を維持 | — |
| surface が tree に **本当に** 無いことを確認 | `await cmux.getPaneForSurface(surface, state.workspace)` が undefined のときのみ prune | †1 |
| **tree 成功 + 特定 surface が listing から一時的に漏れる**（R1） | 初版は 1 回呼びで判定。`c11 tree` の atomicity は本家 spec に明文化なし。実機で誤削除が観測されたら double-check（50ms 後 retry）を §3.2 ノートの実装案に切替 | †2 |
| 現役スロット broken（surface alive）は idle 復帰させる | pane が undefined でない分岐は resetConductor をそのまま呼ぶ（既存挙動） | — |
| daemon 起動時 reconcile で誤って alive 系を落とさない | planLayoutRestore は (surfaceExists, pidAlive, runningTask) 3 軸で判定済み（A/B 経路を変更しない） | — |
| `getPaneForSurface` が throw した場合は何もしない | 既存 handleMessage catch にフォールバック、entry は維持（Test C5） | †3 |

> †1 v0.9.0+ (T016) で `getPaneForSurface` は **tree 失敗時に throw** に変わっており
> （`cmux.ts:298-310`, L290 コメント）、undefined を返すのは「tree 成功 & surface が listing に
> 含まれない」場合のみ。よって undefined = `c11 tree` snapshot 上の確定情報。
>
> †2 R1: c11 SKILL.md (`skills/c11/SKILL.md`) を確認したところ、`c11 tree` の出力 atomicity /
> consistency 保証についての明文化は無い（§5 cheat-sheet に `c11 tree` の存在のみ言及）。
> 本家 spec / 実装を追えば確証は得られるかもしれないが、本タスクでは「実機で誤削除が観測されたら
> 50ms double-check に切替」という具体的 fallback を §3.2 設計判断に残すことで結論を先送りせず判断する。
> 初版が 1 回呼びで動く根拠：(a) clear-conductor は明示 CLI 起点で頻度低、(b) 万一誤 prune しても
> 次回 spawn で新規 surface として再作成されるだけで unrecoverable な被害は無い、(c) `team.json` の
> backup は `.team/team.json.bak` 系には存在しないが events.jsonl の `conductor_pruned` で
> 「何を消したか」は完全に追える（observatory）。
>
> †3 `tree` が transient 失敗（例: c11 daemon 再起動中）した場合は throw されるが、broken entry は
> そのまま維持されるので、ユーザーが再度 `clear-conductor` を打てばリトライできる。

**「現スロット集合に属する surface か」という追加判定は不要**：state.conductors にあって status=broken
+ surface が tree に無い時点で、それは **過去スロットの残骸**である。
現役スロット broken（pane 存在）の場合は pane が undefined ではないので prune 分岐に入らない。

---

## 6. 検証手順

### 6.1 ユニットテスト（per-file 実行、`bun test` 全体は禁忌）

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 daemon.test.ts
bun test --timeout 30000 layout-restore.test.ts   # B 経路の回帰確認
bun test --timeout 30000 events-writer.test.ts    # event schema 追加の整合性
```

### 6.2 統合検証（実マシン、手動）

前提: live `.team/team.json` に surface:27 broken 残骸が現存している状態を再現
（または daemon 起動済みで手動 broken 遷移を再現したテスト worktree を用意）。

```bash
# 1. 現状確認
cat .team/team.json | jq '.conductors[] | select(.status=="broken") | {surface, status, pid, agents}'

# 2. clear-conductor で prune
elevens clear-conductor --surface 27

# 3. team.json から落ちたことを確認（数秒待ってから）
sleep 2
cat .team/team.json | jq '.conductors[] | select(.surface=="surface:27")'   # → null / 空

# 4. manager.log に prune ログが残っていることを確認（pid/alive payload も検査）
tail -50 .team/logs/manager.log | grep conductor_pruned
# → "conductor_pruned C[27] reason=clear_conductor_surface_missing pid=... alive=..."

# 5. events.jsonl に conductor_pruned が出ていることを確認
tail -50 .team/logs/events.jsonl | grep conductor_pruned

# 6. 現役スロット broken への regression テスト（pane alive な broken を別途用意）
#    → clear-conductor で idle に戻り conductor_reset が出ること、conductor_pruned は出ないこと
elevens clear-conductor --surface <alive-broken-surface>
grep conductor_reset .team/logs/manager.log | tail -5
grep conductor_pruned .team/logs/manager.log | tail -5   # → 該当 surface 行が出ていない

# 7. 割り当てロジックへの影響なし確認
elevens create-task --title "regress check" --status ready --body "noop"
# Manager surface でタスクが idle Conductor に割当てされ running に遷移すること

# 8. (R4 確認) clear-conductor 出力文言が prune / idle 復帰の両可能性を伝えていること
elevens clear-conductor --surface 27 2>&1 | head -3
# → "OK cleared surface:27 — pruned from team.json if the surface is gone, otherwise reset to idle."
```

### 6.3 daemon restart の回帰確認

```bash
# B 経路: broken + surface 消失 entry が手動 restart で discard されること
# (テスト C4 で自動化済み、手動では daemon kill → 再起動で確認可能)
cat .team/team.json | jq '.conductors | length'           # before
kill -TERM $(cat .team/daemon.pid)
sleep 3
elevens start                                              # 再起動
sleep 5
cat .team/team.json | jq '.conductors | length'           # after — surface 不在の broken が落ちていること
grep "conductor_discarded.*surface_missing_no_task" .team/logs/manager.log | tail -5
```

---

## 7. docs/spec/07-state-machine.md 更新要否

**要更新**。修正範囲：

- §1.1 broken 説明（L33）に「surface 不在時は clear-conductor で entry 自体が prune される」と追記
- §1.2 遷移表 `CLEAR_MANUAL` 行 footnote に prune ケースを追加（または別 event `PRUNE_MANUAL` を追加して reducer 上は no-op として扱う検討）
  → 本タスクでは reducer は変更しない（daemon ハンドラ直の副作用のみ）。footnote 追記のみで OK。
- §1.4 mermaid `broken --> [*]` ラインに `prune (surface missing)` を併記
- §1.6 不変条件に C-I6（surface 不在 broken は CONDUCTOR_CLEAR で削除）を追加（observability 用、shadow 監視は将来）

合わせて：

- `docs/spec/10-events-stream.md` に `conductor_pruned` event の schema 追記（schema_version は据え置き、add-only、pid / pid_alive フィールド含む）
- `docs/spec/00-project-overview.md` / `docs/spec/01-skill-cmux-team.md` の修正は不要
  （Conductor FSM の補足説明のみで spec 全体構造には影響しない）

---

## 8. リリースノート想定

```
- fix(manager): surface 不在の broken Conductor を `clear-conductor` で team.json から
  除去できるようにした (T021)。従来は idle 復帰が surface 実在ガードで bounce して
  消せなかった残骸を、明示 CLI で prune 可能になった。
  - 新ログ: `conductor_pruned`（manager.log + events.jsonl、pid / pid_alive 含む）
  - `clear-conductor` 出力文言を「prune または idle 復帰のどちらかになる」旨に変更
  - 現役スロットの broken は従来通り idle 復帰する（regression なし）
```

---

## 9. 実装スコープ外（明示）

- runtime tick での自動 prune（monitorConductors 内）→ observatory 制約と衝突するため不採用
- broken 以外の status からの prune 経路 → 既存 abort-task / restart-task / reset-conductor で十分カバー
- `--all-broken` フラグでまとめて prune → 本タスクのスコープ外（必要なら別タスク）
- TUI（dashboard.tsx）の broken 表示変更 → prune 後は entry 自体が消えるので display 側は無変更で整合
- **R2: B 経路（planLayoutRestore）C 分類 `cleanup-stale` の status 非考慮挙動**
  - 現状 `layout-restore.ts` / `daemon.ts:applyDiscardOnly` (L1345) の `cmux.closeSurface` は
    entry の `status` を見ずに判定するため、`status="broken"` + surface alive + pid undefined の
    Conductor が存在する状態で daemon restart すると **生きている pane を破壊する**副作用がある。
  - これは observability 哲学（壊れた事実を残す）と衝突する既存挙動だが、**本タスクでは触らない**。
  - **別タスク起票もしない**（既存挙動・実害小 — surface_missing 経由 broken は通常 pid も死亡しており
    純粋な "broken + surface alive" の組合せは稀）。必要になれば後で個別起票する。
- **c11 tree atomicity の double-check（R1）**
  - 初版は素直な 1 回呼びで実装。実機で誤 prune が観測されたら §3.2 設計判断ノートに記した
    50ms double-check 案に切替（実装者裁量で初版から入れることも可）。

---

## 10. ファイル変更まとめ

| ファイル | 変更内容 | LoC 目安 |
|---|---|---|
| `skills/cmux-team/manager/daemon.ts` | CONDUCTOR_CLEAR ハンドラに surface 不在分岐追加（pid/alive ログ含む） | +25 |
| `skills/cmux-team/manager/events-writer.ts` | `conductor_pruned` event 追加（pid / pid_alive フィールド含む） | +11 |
| `skills/cmux-team/manager/i18n.ts` | clear-conductor help 補足 + R4 出力文言 (jp/en) | +10 |
| `skills/cmux-team/manager/main.ts` | clear-conductor 出力メッセージを i18n key 経由で差替 | +2 |
| `skills/cmux-team/manager/daemon.test.ts` | テスト C1〜C5 追加 | +180 |
| `docs/spec/07-state-machine.md` | broken § と mermaid と不変条件の追記 | +10 |
| `docs/spec/10-events-stream.md` | `conductor_pruned` schema 追記（pid / pid_alive 含む） | +14 |

**合計**: 約 +252 行（テスト 180 含む）、構造変更なし、新規ファイルなし。
