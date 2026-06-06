# T027 実装計画書: surface 不在の残骸 Conductor を team.json から除去できる経路を追加（v0.9.0 環境向け）

## 改訂履歴

- **T027 (v0.9.0 環境向け再々起票・本 plan)**:
  - 前回 T025 plan rev2（Design Review 通過済み）の設計骨子をそのまま継承。
  - v0.9.0 (`418d4ac chore: release v0.9.0`) の現 worktree で line 番号・前提を**全件再 Read で再確認済み**。下記「v0.9.0 line 番号再検証結果」表に明記。
  - 訂正は実質 2 件のみ:
    1. `forceCloseDisconnectedConductor` の **関数開始行**を `L4518` → `L4489` に訂正（v0.8 系から関数定義位置のみシフト。watcher 2 連停止コードは依然 `L4518-4527` で同一）。
    2. `daemon.ts:CONDUCTOR_CLEAR` ハンドラ末尾位置が `L1693` → `L1694` に +1 行（軽微）。
  - 上記以外の参照 line（`restoreConductorState` / `applyRestorePlan` / `applyDiscardOnly` / `RESET_CONDUCTOR` watcher 2 連停止 / `cmdClearConductor` / `resetConductor` / `planLayoutRestore` / `conductor-fsm.ts` / `i18n.ts` / spec/07 invariants）は前回 plan rev2 と**完全一致**。
- **T025 rev2 (Design Reviewer Changes Requested 対応)**:
  - **R1**: §3.3 の CONDUCTOR_CLEAR prune 分岐に `pidWatcherInterval` / `mailboxWatcherStop` の 2 連停止を追加。
    既存 abort_task / RESET_CONDUCTOR (L1727-1736) / forceCloseDisconnectedConductor (L4518-4527) と同形。
    根拠コメントを「daemon 再起動を挟むと applyRestorePlan で再 spawn される」前提に書き換え、誤前提 2 文（broken 遷移時に clear 済み・副次的な害なし）は削除。
  - **R2**: §6.2 の新 invariant ID を `C-I4` → `C-I6` に変更（C-I4=error / C-I5=asking が既存占有のため）。
  - **R3**: §3.4 を i18n.ts 英語版（L494-509）+ 日本語版（L1579-1596）の両方に拡張する形に修正。
  - **R4**: §5.2 に「再起動経由を模した broken (pid 生存) + surface_missing + CONDUCTOR_CLEAR」ケースと「watcher tick が delete 後に走っても state 不変」ケースを追加。
  - **R5**: §1.5 の line 参照を訂正（`conductor-fsm.ts:40-42` → `42-44`、spec `L33` → `L36 / L145 (C-I3)`）。
  - **R6**: §3.6 に dashboard event tail での `conductor_pruned` 視認性確認 TODO を 1 行追加。

---

## 0. v0.9.0 line 番号再検証結果

前回 plan rev2 で参照されていた file:line を **v0.9.0 現 worktree で全件 Read** し、ズレを下記表で明示する。

| 対象 | 前回 rev2 | v0.9.0 実測 | 状態 |
|---|---|---|---|
| `daemon.ts` 全体行数 | (推定 4400+) | **5053** | 増加。grep / 部分 Read 徹底（A021 教訓） |
| `daemon.ts:restoreConductorState()` 開始 | L1069 | **L1069** | 完全一致 |
| `daemon.ts:restoreConductorState()` broken switch | L1110-1117 | **L1110-1117** | 完全一致 |
| `daemon.ts:restoreConductorState()` T250 comment | L1104 | **L1104** | 完全一致 |
| `daemon.ts:applyRestorePlan()` 開始 | L1163 | **L1163** | 完全一致 |
| `daemon.ts:applyRestorePlan()` set + watcher spawn | L1192-1197 | **L1192-1197** | 完全一致（`state.conductors.set` L1192、`spawnPidWatcher` L1193-1195、`spawnConductorMailboxWatcher` L1197） |
| `daemon.ts:applyDiscardOnly()` 開始 | L1339 | **L1339** | 完全一致 |
| `daemon.ts:applyDiscardOnly()` E ループ | L1352-1360 | **L1352-1360** | 完全一致 |
| `daemon.ts:CONDUCTOR_CLEAR` ハンドラ | L1665-1693 | **L1665-1694** | ＋1 行（軽微） |
| `daemon.ts:RESET_CONDUCTOR` watcher 2 連停止 | L1727-1736 | **L1727-1736** | 完全一致 |
| `daemon.ts:__testSpawnPidWatcherTick` 開始 | L3835 | **L3835** | 完全一致 |
| `daemon.ts:forceCloseDisconnectedConductor()` **開始** | (前回参照値 ≒ L4513-4518 範囲) | **L4489** | **訂正** — 関数定義位置が v0.8 系から ‑29 行シフト |
| `daemon.ts:forceCloseDisconnectedConductor()` watcher 2 連停止 | L4518-4527 | **L4518-4527** | 完全一致（関数内 offset は不変） |
| `conductor.ts:resetConductor()` 開始 | L752 | **L752** | 完全一致 |
| `conductor.ts:resetConductor()` surface 実在確認 | L773-787 | **L773-787** | 完全一致 |
| `conductor.ts:resetConductor()` `conductor.status = targetStatus` | L894-895 | **L894-895** | 完全一致 |
| `conductor.ts:resetConductor()` reserved 経路 pid クリア | L917-921 | **L917-921**（L918-921 が `targetStatus === "reserved"` ブロック本体） | 完全一致 |
| `main.ts:cmdClearConductor()` | L5241-5281 | **L5241-5281** | 完全一致 |
| `layout-restore.ts` ファイル全体 | (recent) | **142 行** | 縮小済 — `planLayoutRestore` ループは **L81-124** |
| `layout-restore.ts:planLayoutRestore()` loop 内分類分岐 | L88-105（PID 短絡 ＋ B/C/D/E 分岐） | **L88-124**（L88-93 が pidAlive 短絡 A、L96-104 B、L106-110 C、L112-120 D、L122-123 E） | 完全一致 |
| `schema.ts:isAssignableStatus()` | L503 | **L503**（`idle` または `reserved` のみ true） | 完全一致 |
| `state-machine/conductor-fsm.ts:broken` no-op | L42-44 | **L42-44** | 完全一致 |
| `i18n.ts:help_clear_conductor` (英) | L494-509 | **L494-510**（v0.9.0 で worktree 注記 1 行追加済み — Notes は L507-510） | 1 行追加済み（Notes 末尾に既に "Worktree / branch residue ..." の 1 行が入っている） |
| `i18n.ts:help_clear_conductor` (日) | L1579-1596 | **L1579-1596** | 完全一致 |
| `docs/spec/07-state-machine.md` broken 状態定義 | L33 | **L33** | 完全一致 |
| `docs/spec/07-state-machine.md` broken 解除手段 散文 | L36 | **L36** | 完全一致 |
| `docs/spec/07-state-machine.md` Invariants (C-I1〜C-I5) | L143-147 | **L143-147**（C-I4=error / C-I5=asking 占有確認済み） | 完全一致 — **新 invariant は C-I6** |
| `daemon.test.ts:CONDUCTOR_CLEAR` 既存 5 ケース | L3428-3538 | **L3428-3540**（直後 L3540 から ST-14 round-trip） | 完全一致 |
| `daemon.test.ts:ST-14 broken round-trip` | L3540 | **L3540** | 完全一致 |
| `layout-restore.test.ts` describe ブロック | (matrix M1〜M5/M12/M6) | **L27-** に describe + 既存 9 test | 一致。新 describe ブロックを後置追加可能 |

**結論**: 前回 T025 plan rev2 の設計と参照 line は v0.9.0 でほぼそのまま使える。`forceCloseDisconnectedConductor` の関数開始行を **L4489** に書き換える以外、本文の変更は不要。

---

## 1. 現状分析（v0.9.0 現 worktree の実 Read 結果）

### 1.1 broken Conductor の永続化経路

`skills/cmux-team/manager/daemon.ts:1069-1118` `restoreConductorState()` は team.json の生データから `ConductorState` を再構築する関数。L1110-1117 の status 復元 switch:

```ts
status:
  c.status === "running" ? "running"
  : c.status === "disconnected" ? "disconnected"
  : c.status === "broken" ? "broken"          // ← L1113
  : c.status === "reserved" ? "reserved"
  : ... : "idle",
```

直前 L1104 のコメント:

> `// T250: broken は再起動後も保持する（明示 clear まで idle に戻さない）`

この関数は `applyRestorePlan()`（`daemon.ts:1163-`）の A 経路（keep-alive）でのみ呼ばれる。

### 1.2 「surface 不在 + PID 生存」が A に流れる構造的問題

`skills/cmux-team/manager/layout-restore.ts:81-124` `planLayoutRestore()` のループ:

```ts
for (const c of conductorsFromJson ?? []) {
  if (!c?.surface || typeof c.surface !== "string") continue;        // L82
  const pidAlive = typeof c.pid === "number" && isAlive(c.pid);      // L83
  const surfaceExists = liveSurfaces.has(c.surface);                 // L84
  const taskId = typeof c.taskId === "string" ? c.taskId : undefined;// L85
  const runningTask = !!(taskId && resumeByTaskId.has(taskId));      // L86

  // PID 生存 → A
  if (pidAlive) {                                                    // L89
    alive.push({ raw: c, decision: "keep-alive" });
    if (runningTask) matchedTaskIds.add(taskId!);
    continue;                                                        // L92 — surfaceExists を見ない
  }
  // ここから !pidAlive
  if (surfaceExists && runningTask)  { /* B */ }                     // L96
  if (surfaceExists && !runningTask) { /* C */ }                     // L106
  if (!surfaceExists && runningTask) { /* D */ }                     // L112
  // E: surface 消失 + idle
  discarded.push({ surface: c.surface, reason: "surface_missing_no_task" }); // L123
}
```

`pidAlive` が真ならば `surfaceExists` を一切確認せず A に倒す。
`broken` Conductor は `resetConductor`（`conductor.ts:752-`、L918-921）で **`pid` をクリアしない**（`reserved` 経路でのみ undefined にする）。
→ broken 遷移時に live だった pid 値が team.json に残り続け、再起動時にたまたまそのプロセスが生きていれば `pidAlive=true` で A に分類される。

PID が他プロセスに recycle されても `cmux.isAlive(pid)` は true を返すため、現実には surface:27 のような「surface はとうに消えたが pid が偶然生きている」残骸が `keep-alive` 扱いで永続復元される。

### 1.3 clear-conductor が `broken → idle` に戻せない構造的問題

`skills/cmux-team/manager/conductor.ts:752-` `resetConductor()` の L773-787:

```ts
// 0. surface 実在確認（T251: 幽霊 Conductor 防止）
const pane = await cmux.getPaneForSurface(conductor.surface, workspace);
const surfaceMissing = pane === undefined;
const effectiveTargetStatus: "idle" | "broken" | "reserved" = surfaceMissing
  ? "broken"
  : (opts?.targetStatus ?? "idle");
```

`CONDUCTOR_CLEAR` ハンドラ（`daemon.ts:1665-1694`）は L1686-1690 で `resetConductor(..., { targetStatus: "idle", reason: message.reason ?? "cleared", cleanupMode: { kind: "archive", reason: "clear_conductor" } }, ...)` を呼ぶが、surface が tree に無いと L780-782 で `effectiveTargetStatus="broken"` に倒し戻され、L894-895 の `conductor.status = targetStatus` で **broken のまま居座る**。

### 1.4 CLI 入口側のガード

`skills/cmux-team/manager/main.ts:5241-5281` `cmdClearConductor()` は `team.json` を直読みして:
- `conductor.status !== "broken"` ならば `exit 1`（L5265-5271）
- `CONDUCTOR_CLEAR` メッセージを投函するだけ（daemon 側で処理 — L5274-5279）

surface 実在は事前確認していない（daemon 側に判定を委ねている）。

### 1.5 FSM reducer と spec

- `skills/cmux-team/manager/state-machine/conductor-fsm.ts:42-44`: `broken` は全 event で no-op を返す終端状態
- `docs/spec/07-state-machine.md:L36` 散文 / `L145 (C-I3)`: `broken` の解除手段は `clear-conductor` / `reset-conductor` のみと明記
- `docs/spec/07-state-machine.md:L144` C-I2 invariant: `status=broken ⇒ taskRunId == null`

### 1.6 評価サマリ

「surface 消失 + status=broken」のエントリは:
- **boot 経路**: `planLayoutRestore` の pidAlive 短絡で A keep-alive へ → `restoreConductorState` が broken を保持 → 復元される
- **steady state**: `CONDUCTOR_CLEAR` → `resetConductor` の surface_missing ガードで broken に倒し戻される → 解除不能
- **dashboard / snapshot / count**: 常時 RED 表示され `Conductors N broken` カウントを圧迫する
- **割り当て影響**: `schema.ts:503` `isAssignableStatus` は `idle|reserved` のみ true → 機能的実害はほぼ無い（task 割り当ては現役 idle/reserved で回る）

---

## 2. 方針比較と選定

| 観点 | A: clear-conductor 分岐 | B: boot reconcile | A+B 併用 |
|---|---|---|---|
| 既存 stuck entry の即時除去 | ✅ ユーザー操作で即時 | ⚠ daemon 再起動が必要 | ✅ |
| 再発防止（再起動越し） | ⚠ 同じ状態に陥れば再度手動 clear が必要 | ✅ 構造的に防止 | ✅ |
| observatory: silent state mutation 回避 | ✅ ユーザー操作起点で log・notify | ⚠ 起動時に自動 drop（log で吸収） | ✅ |
| 現役スロット broken の温存 | ✅ surface 実在チェックでガード | ✅ surface 実在チェックでガード | ✅ |
| 実装コスト | 小（handler 1 箇所） | 小（pure function 1 行追加 + テスト） | 中 |
| 回帰リスク | 低（clear-conductor は broken 専用） | 中（planLayoutRestore は復元の中核） | 中 |
| 実害評価との整合 | 「ユーザーが見つけた時だけ消せる」で十分 | ユーザー無操作で自動清掃 | 両方 |

### 採用方針: **A + B 併用**

理由:
1. **A は「現に stuck している surface:27 を今すぐ消す」escape hatch** として必須。CLI 介入起点で観察可能性を保つ（既存 `clear-conductor` の延長で UX 一貫）。
2. **B は構造的根治** として併設。`planLayoutRestore` は pidAlive を絶対正としており、surface 消失を見落とす設計欠陥そのものを直す。再発防止と「ユーザーが気付かなくても自然消滅する」性質を獲得する。
3. observatory 制約は両方とも `conductor_pruned` 系イベントの journal で担保。silent な state mutation にはしない。
4. 単独採用だと:
   - A のみ → 同じ罠を踏むたびに手動操作。BG で発生したら気付かないまま蓄積する。
   - B のみ → daemon 再起動するまで stuck。ユーザーが「今すぐ消したい」ニーズに応えられない（surface:27 の現状そのもの）。

> プロンプトでは「**案B 優先で検討**」と指示されているが、これは「B を中心に据えよ」の趣旨と解釈する。
> A 単独 / B 単独の trade-off（特に「現に stuck している surface:27 を今すぐ消す」要件）を直視すると **A+B 併用が必要**である。B のみだと再起動を強要するため UX 退行であり、観察箱原則の「観察できたら即介入できる」サイクルを閉じない。逆に A+B 併用は B を主、A を副（escape hatch）として位置付け、両者が `conductor_pruned` 系イベントで観察可能性を担保するため、プロンプトの「B 優先で検討」要件と整合する。

---

## 3. 変更対象ファイルと変更内容

### 3.1 `skills/cmux-team/manager/layout-restore.ts` — 方針 B 本体

`planLayoutRestore()` 関数ループ先頭（**L86 直後・L88 コメントの手前**）に以下を挿入:

```ts
for (const c of conductorsFromJson ?? []) {
  if (!c?.surface || typeof c.surface !== "string") continue;
  const pidAlive = typeof c.pid === "number" && isAlive(c.pid);
  const surfaceExists = liveSurfaces.has(c.surface);
  const taskId = typeof c.taskId === "string" ? c.taskId : undefined;
  const runningTask = !!(taskId && resumeByTaskId.has(taskId));

  // ★ T027 新規 (B 経路): broken は surface 実在を pidAlive より優先で判定する。
  //   broken Conductor は resetConductor が pid をクリアしない (conductor.ts:918-921 reserved 経路限定) ため、
  //   team.json に live 値が残り続け、PID が他プロセスに recycle されると pidAlive で誤って A に流入する。
  //   surface が tree に無い broken エントリは「現スロットに属さない過去 surface の残骸」確定なので
  //   E (discard) に倒す。surface が tree にあれば従来通り pidAlive 判定に進む（現役 broken スロット温存）。
  if (c.status === "broken" && !surfaceExists) {
    discarded.push({ surface: c.surface, reason: "broken_surface_missing" });
    continue;
  }

  // PID 生存 → A  (既存 L88-93)
  if (pidAlive) { ... }
  ...
}
```

**重要な制約**:
- `c.status === "broken"` 限定。他状態（`disconnected`, `running` 等）は既存挙動を維持（resume 経路の妥当性に依存するため触らない）。
- `!surfaceExists` 必須。surface が tree にあれば「現役スロットの broken」として保持し、`restoreConductorState` 経由で復元される（C-I2 invariant 不変）。

### 3.2 `skills/cmux-team/manager/daemon.ts:1339-1360` — 方針 B の log 出力拡張

`applyDiscardOnly()` の E ループ（L1352-1360）の filter を拡張:

```ts
// E: discarded — log のみ
for (const d of plan.discarded) {
  if (d.reason === "surface_missing_no_task" || d.reason === "broken_surface_missing") {
    await log(
      d.reason === "broken_surface_missing" ? "conductor_pruned" : "conductor_discarded",
      `${formatSurface(d.surface, "C")} reason=${d.reason}`,
    );
  }
}
```

- 既存の `pid_dead_idle_cleanup` (C 経路) は重複防止のため引き続き除外（C 経路は `closeSurface` の log で別途記録される）。
- 新 reason `broken_surface_missing` は **`conductor_pruned` という別 event 名で記録**し `conductor_discarded` (idle 残骸) と区別する。retrospective 観察（trace DB grep）で「broken からの除去」だけを抽出できるようにする。

### 3.3 `skills/cmux-team/manager/daemon.ts:1665-1694` — 方針 A 本体（CONDUCTOR_CLEAR 分岐）

L1665-1694 `case "CONDUCTOR_CLEAR":` ブロックを以下に書き換える:

```ts
case "CONDUCTOR_CLEAR": {
  const conductor = state.conductors.get(message.surface);
  if (!conductor) {
    await log("conductor_clear_ignored", `surface=${message.surface} reason=not_found`);
    break;
  }
  if (conductor.status !== "broken") {
    await log(
      "conductor_clear_ignored",
      `${formatSurface(conductor.surface, "C")} status=${conductor.status} reason=not_broken`,
    );
    break;
  }
  // ★ T027 新規 (A 経路): surface が tree に存在しないなら idle 復帰でなく entry 削除する。
  //   resetConductor は surface_missing 時に effectiveTargetStatus="broken" へ倒し戻すため (conductor.ts:780-782)、
  //   idle 復帰の経路では「surface 不在の broken」を絶対に解除できない。
  //   観察制約: 現役スロットの broken（surface 実在）は drop 対象外。
  const pane = await cmux.getPaneForSurface(conductor.surface, state.workspace ?? undefined);
  if (pane === undefined) {
    // ★ R1 (rev2): pid watcher / mailbox watcher を delete の前に明示停止する。
    //   理由: daemon 再起動を挟むと applyRestorePlan (daemon.ts:1192-1197) で broken でも
    //   `pid` 値が残っていれば spawnPidWatcher / spawnConductorMailboxWatcher が再 spawn される。
    //   delete 後も interval が走り続け、dangling timer リーク + 削除済みオブジェクトへの
    //   mutation（observability ノイズ — session_ended / conductor_disconnected 誤発火）を起こす。
    //   abort_task / RESET_CONDUCTOR (L1727-1736) / forceCloseDisconnectedConductor (L4518-4527) と
    //   同形の「pid watcher → mailbox watcher の 2 連停止」を必ず行う規約に合わせる。
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
    if (conductor.mailboxWatcherStop) {
      try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }
      conductor.mailboxWatcherStop = undefined;
    }
    // C-I2 invariant: status=broken ⇒ taskRunId == null は維持されている前提。
    // worktree archive も broken 遷移時に実施済み (CONDUCTOR_DISCONNECT_TIMEOUT 経路の cleanupMode: archive)。
    state.conductors.delete(conductor.surface);
    await log(
      "conductor_pruned",
      `${formatSurface(conductor.surface, "C")} reason=user_clear_surface_missing` +
        ` pid=${conductor.pid ?? "null"} alive=${conductor.pid !== undefined ? String(cmux.isAlive(conductor.pid)) : "unknown"}`,
    );
    notifyStateChanged("daemon.ts:CONDUCTOR_CLEAR:pruned");
    requestWakeup(state);
    break;
  }

  // 既存経路: surface 実在 → idle 復帰
  await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
    targetStatus: "idle",
    reason: message.reason ?? "cleared",
    cleanupMode: { kind: "archive", reason: "clear_conductor" },
  }, ccBackend(state.backend));
  requestWakeup(state);
  break;
}
```

**設計判断**:
- `cmux.getPaneForSurface` をハンドラ側で 1 回呼ぶ。`resetConductor` も内部で呼ぶが二重コストは無視できる（rare path）。
- `state.conductors.delete` の後 `notifyStateChanged` を発火 → main.ts の handleMessage flush ループが team.json を rewrite し、消えたことが永続化される。
- **watcher teardown は CONDUCTOR_CLEAR prune 分岐の責任**として明示的に置く（rev2 R1）。
  これは abort_task / RESET_CONDUCTOR (`daemon.ts:1727-1736`) / forceCloseDisconnectedConductor (`daemon.ts:4518-4527`) の既存 teardown シーケンスと
  同形（pid watcher → mailbox watcher の 2 連停止）。CONDUCTOR_CLEAR の prune 分岐だけ抜けると invariant がほつれる。

### 3.4 `skills/cmux-team/manager/i18n.ts` — help 文言追記

**英語版** L494-510 `help_clear_conductor` の `Notes:` セクションに以下 1 行追加（既存 "Worktree / branch residue ..." 行の直後 = L510 末尾）:

```
  - If the surface is missing from the c11 tree, the conductor entry is pruned
    from team.json instead of being reset (logged as conductor_pruned)
```

**日本語版** L1579-1596 `help_clear_conductor` の `Notes:` セクションにも対応する 1 行追加（既存 "worktree / branch 残骸..." 行の直後 = L1595 末尾）:

```
  - surface が c11 tree から消えている場合、idle 復帰ではなく team.json から
    entry 削除されます（conductor_pruned で記録）
```

両方を同じ PR で更新（言語差分が出ないように同時 commit）。

### 3.5 `skills/cmux-team/manager/main.ts:5241-5281` — CLI 側ガードは変更しない

`cmdClearConductor()`（L5241-5281）は status==="broken" のみ受け付ける既存ガードを維持。surface 実在は CLI 側で見ない（team.json の stale 表示と c11 tree の真値がズレるレースを避け、daemon 側で一意に判定する — `cmdResetConductor` と同じ方針）。

### 3.6 触らないファイル

- `schema.ts:503` `isAssignableStatus`: 変更不要（broken 自体の意味は不変）
- `conductor.ts:752-` `resetConductor`: 既存挙動維持。surface_missing → broken 倒し込みは T251 の幽霊 Conductor 防止として残す（A 経路が hit する前提）
- `state-machine/conductor-fsm.ts`: 削除は遷移ではなく **entry エビクション**。FSM の状態遷移表に新値を追加する必要なし
- `dashboard.tsx`: 削除されれば自然に表示から消える（差分なし）
- **TODO (rev2 R6)**: 実装時、`conductor_pruned` log が dashboard event tail で `conductor_broken` / `conductor_discarded` と
  同程度に視認できるか確認する。既存 RED 系の filter / styling から漏れていれば 1 行追加（`conductor_pruned` を「conductor が消えた」系イベント色に揃える）。real-time 観察軸（観察箱原則）に資する。実装コスト 5 分程度。

---

## 4. 新イベント/ログ

### 4.1 `conductor_pruned`

| 項目 | 値 |
|---|---|
| event name | `conductor_pruned` |
| 発火箇所 | (a) `daemon.ts:1665-1694` CONDUCTOR_CLEAR 分岐（user_clear 起点）<br>(b) `daemon.ts:1352-1360` `applyDiscardOnly` の E ループ（boot reconcile 起点） |
| payload (a) | `C[<surface>] reason=user_clear_surface_missing pid=<n>\|null alive=<true\|false\|unknown>` |
| payload (b) | `C[<surface>] reason=broken_surface_missing` |
| ログレベル | info（既存 `conductor_discarded` と同階層） |

retrospective grep:
- `grep 'conductor_pruned' .team/logs/manager.log` で「いつ何の残骸を消したか」を一覧化
- trace DB の `hook_signals` テーブルにも自動収集される（既存ロジック）

### 4.2 既存イベントの分岐拡張

- `conductor_discarded`: `reason=surface_missing_no_task` のみ（idle 残骸） — 不変
- `conductor_stale_surface_closed`: C 経路（pid_dead_idle 残骸 pane の close） — 不変
- `conductor_broken`: broken 遷移時 — 不変

`conductor_pruned` は新規。dashboard / metrics / trace 側の集計は既存の log line 走査経路に乗るため追加実装不要（ただし dashboard 視認性は §3.6 TODO で確認）。

---

## 5. テスト計画

### 5.1 追加テスト — `skills/cmux-team/manager/layout-restore.test.ts`

`describe("planLayoutRestore: T027 broken+surface_missing 早期 discard", ...)` を **既存 L27 ブロックの後**に追加:

| ケース | 期待 |
|---|---|
| `status="broken" + pidAlive=true + surface_missing` | `discarded[0].reason === "broken_surface_missing"`、`alive.length === 0` |
| `status="broken" + pidAlive=false + surface_missing` | 同上（pidAlive を見ない） |
| `status="broken" + surface_exists` (pid 生死問わず) | 従来通り A keep-alive に流れる（現役スロット温存） |
| `status="disconnected" + pidAlive=true + surface_missing` | 従来通り A（broken 以外は触らない） |
| `status="idle" + pidAlive=true + surface_missing` | 従来通り A（broken 以外は触らない） |

### 5.2 追加テスト — `skills/cmux-team/manager/daemon.test.ts`

`describe("CONDUCTOR_CLEAR (T027 surface_missing pruning)", ...)`:

| ケース | 期待 |
|---|---|
| broken + `getPaneForSurface` undefined を返す | `state.conductors.has(surface)===false`、log に `conductor_pruned ... reason=user_clear_surface_missing` |
| broken + `getPaneForSurface` 実在を返す | 既存通り `status==="idle"`、`state.conductors.has(surface)===true`（既存 ST-1 テスト L3428-3458 維持） |
| running + surface_missing | 既存通り `conductor_clear_ignored reason=not_broken`、state 維持（regression: 削除されない） |
| disconnected + surface_missing | 同上 |

**rev2 R4 追加ケース（watcher teardown assert）**:

| ケース | 期待 |
|---|---|
| 再起動経由を模した broken (pid 生存) + surface_missing + CONDUCTOR_CLEAR | (a) handler 実行直後に `conductor.pidWatcherInterval === undefined` (b) `conductor.mailboxWatcherStop === undefined` (c) test 終了時に Bun 内 active timer 数が pre-CLEAR と等しい（リーク無し） |
| 同上 + watcher tick を delete 後に手動駆動 | `__testSpawnPidWatcherTick(state, conductor, pid)` を delete 後に呼んでも `state.conductors.has(surface) === false` のまま（state mutation が起きない）。`conductor` への直接参照を握って tick を回す手法は既存 `__testSpawnPidWatcherTick` テストパターン (`daemon.ts:3835-`) に合わせる |

実装メモ:
- pre-arrange: state にダミー interval を `pidWatcherInterval` に、ダミー stop fn を `mailboxWatcherStop` にセットしておき、handler が両方とも `undefined` に倒すことを確認する。
- timer リーク assertion は `process._getActiveHandles?.()` か Bun 内 active interval count を pre/post で比較する（既存テストヘルパに準じる）。

### 5.3 boot 経路 integration テスト — `daemon.test.ts` の applyRestorePlan / initializeLayout 周辺

`describe("initializeLayout (T027 broken pruning at boot)", ...)`:

| ケース | 期待 |
|---|---|
| team.json に broken (surface 不在, pid 生存) を 1 件含む状態で initializeLayout 実行 | 復元後の `state.conductors.has` は false、log に `conductor_pruned ... reason=broken_surface_missing` |
| team.json に broken (surface 実在) を含む状態 | 復元後も状態保持（regression: 既存 ST-14 round-trip テスト L3540 維持） |
| team.json round-trip: pruned 後の next save で disk から該当 entry が消える | `JSON.parse(readFile(team.json)).conductors.find(...)` が undefined |

### 5.4 既存テストの回帰チェック（差分の見落とし防止）

- `daemon.test.ts:3428-3540` CONDUCTOR_CLEAR テスト群（5 ケース）が全 pass する
- `daemon.test.ts:3540-` ST-14 broken round-trip テストが pass する
- `layout-restore.test.ts` 既存マトリクス分類テスト全部 (L27-) pass する
- `state-machine/fsm.test.ts` reducer テスト pass（reducer は触らないので影響なし想定）

### 5.5 実行コマンド

`bun test` 全体実行は禁忌（CLAUDE.md / A021）。per-file 実行:

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 layout-restore.test.ts
bun test --timeout 30000 daemon.test.ts
bun test --timeout 30000 conductor.test.ts
bun test --timeout 30000 state-machine/fsm.test.ts
```

CI と同じ per-file ループで:

```bash
cd skills/cmux-team/manager
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f" || echo "FAIL: $f"
done
```

---

## 6. spec 更新要否

### `docs/spec/07-state-machine.md` — **更新する**

#### 6.1 §1.1 状態一覧 — `broken` 行への補足

L36 直後に追記:

```
追加: `broken` Conductor の surface が c11 tree から消えた場合（外部 close / cmux session 全終了等）、
`clear-conductor` は idle 復帰ではなく **team.json からの entry 削除**を行う（T027）。
daemon 起動時の planLayoutRestore も同条件で entry を discard する。
削除イベントは `conductor_pruned` として journal に記録される。
```

#### 6.2 §1.4 Invariants — 新 invariant 追加

L143-147 表に追加（既存 C-I4=error, C-I5=asking との衝突回避のため **C-I6** を採番 — rev2 R2）:

| ID | 不変条件 | 検証箇所 |
|---|---|---|
| C-I6 | `status=broken && surface ∉ c11 tree` ⇒ next CONDUCTOR_CLEAR / boot restore で entry 削除 | `planLayoutRestore` / `CONDUCTOR_CLEAR` handler |

#### 6.3 §1.x（reducer の no-op 例外注記が必要なら追加）

reducer の `broken → no-op` は変更しない（state machine 上は変化しない、entry 自体の削除はマシン外の操作）。spec 本文で「broken は終端状態だが、surface 消失時は machine 外で entry が evict される」と注記する。

### 他の spec — 更新不要

- `docs/spec/05-install-and-infrastructure.md`: surface 解決は変更なし
- `docs/spec/10-events-stream.md`: events.jsonl に出る event ではない（manager.log のみ） — 更新不要。将来 events stream に乗せたい場合は別 issue で議論

---

## 7. リスク・残課題

### 7.1 リスク

| リスク | 評価 | 緩和 |
|---|---|---|
| **現役 broken slot を誤って drop** | 中 | `!surfaceExists` ガードと CONDUCTOR_CLEAR の `getPaneForSurface === undefined` チェックで二重に防御。テスト 5.1, 5.2 で regression 検証 |
| **`liveSurfaces` 取得失敗時の誤判定** | 低 | 既に `fetchLiveSurfacesWithRetry` (daemon.ts:1372) で 3 retry → fatal exit に集約済み。tree が取れない状態では daemon 自体起動しないため `liveSurfaces` が嘘になることはない |
| **pid watcher / mailbox watcher が delete 後に conductor を mutate** | 低 | CONDUCTOR_CLEAR prune 分岐で明示 teardown 済み（rev2 R1）。abort_task / RESET_CONDUCTOR (L1727-1736) / forceCloseDisconnectedConductor (L4518-4527) と同形の 2 連停止。テスト 5.2 で teardown 後の tick が state mutation を起こさないことを assert |
| **worktree / branch リソースの取り残し** | 低 | broken 遷移時に `cleanupMode: archive` で `.team/worktrees-archive/` に退避済み。本変更で worktree 操作を追加しない（archive 済みものへの no-op で十分） |
| **observatory に出力する `conductor_pruned` ログの後方互換** | 低 | 新 event name。既存 grep / dashboard には影響なし（dashboard 視認性は §3.6 TODO で確認） |

### 7.2 残課題（本タスクスコープ外）

1. **`resetConductor` で `pid` を broken 経路でもクリアすべきか**
   - 現状 reserved 経路のみクリア（L918-921）。broken でもクリアすれば「pid recycle による pidAlive=true 誤判定」の根本原因が消える
   - ただし observatory 上「壊れたときの最後の pid」を残したい意図があるかもしれない（disconnectedAt と同様の trace 値）
   - 別 issue で議論。本 plan ではこの設計を維持しつつ planLayoutRestore 側で surface 判定を入れる方が侵襲が少ない
2. **events.jsonl への `conductor_pruned` 公開**
   - watch mode / 外部 subscriber へ流したい場合は `docs/spec/10-events-stream.md` の schema 追加が必要
   - 本タスクでは manager.log + trace DB grep で観察可能性を担保し、外部公開は別 issue とする
3. **`surface_missing` broken の自動定期 reconcile**
   - boot reconcile (B) + ユーザー操作 (A) があれば充分だが、長時間 daemon が走り続けるケースに備えて `monitorConductors` で steady-state チェックを足すかは将来検討
   - 現状は実害評価「機能影響ほぼ無し」を踏まえ shipping 不要と判断
4. **dashboard 側に「broken (surface missing)」の視覚区別を追加するか**
   - 現状の RED `broken <elapsed>` で十分（むしろ stuck であることが目立つ）。pruned 後は自然消滅するので恒常表示の必要は無い
   - rev2 R6 で event tail の `conductor_pruned` 視認性のみは確認する（実装時 5 分タスク）
