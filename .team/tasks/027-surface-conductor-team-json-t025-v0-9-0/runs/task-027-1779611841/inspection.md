# Inspection: T027 surface 不在の残骸 Conductor を team.json から除去できる経路を追加

## 判定: **GO**

実装は plan rev2 の設計と完全に整合しており、案 A + 案 B 併用がそれぞれ意図通りに実装されている。
watcher teardown 規約・observatory ログ・現役 broken スロットの温存・spec invariant 追加・i18n 両言語追記が全て満たされている。
回帰観点でも、broken 以外の status / surface 実在ケースは既存挙動を維持する分岐になっている。
Conductor 報告（layout-restore.test.ts 15 pass / daemon.test.ts 251 pass+2 skip / tsc 0 err）を正本として採用する。

---

## 検証項目（10 項目）

### 1. 案A: CONDUCTOR_CLEAR ハンドラの surface_missing 分岐 — **PASS**

`daemon.ts:1693-1736` を確認。
- L1686-1691 で `status !== "broken"` を弾く既存ガードの後、L1698-1701 で `getPaneForSurface(conductor.surface, state.workspace ?? undefined)` を呼ぶ。
- L1702 で `clearPane === undefined` のとき delete 分岐 (L1723 で `state.conductors.delete`)、`conductor_pruned` を `reason=user_clear_surface_missing` で log (L1727-1731)。
- L1733 で `notifyStateChanged("daemon.ts:CONDUCTOR_CLEAR:pruned")` を発火。team.json 永続化は既存 debounce 経路に乗る。
- 実在時 (`clearPane !== undefined`) は L1740-1744 の従来 `resetConductor(..., targetStatus:"idle", cleanupMode:{kind:"archive"})` 経路に進み、idle 復帰の挙動が保たれる。

### 2. 案B: planLayoutRestore の pidAlive 短絡前 discard — **PASS**

`layout-restore.ts:88-100` を確認。
- L83 で `pidAlive` を計算しているが、L97 の `if (c.status === "broken" && !surfaceExists)` は L103 の `if (pidAlive)` 短絡分岐より**手前**に配置されている。
- `discarded.push({ surface, reason: "broken_surface_missing" })` → `continue` で E 経路に倒す。
- broken 以外 / surface 実在のいずれかなら従来のロジック（A 〜 E）に進む。

### 3. 再起動後復活しない（boot discard + テスト） — **PASS**

`layout-restore.test.ts:166-246` に T027 専用 describe ブロックが追加されている。
- `status=broken + pidAlive=true + surface_missing` → `broken_surface_missing` で discard
- `status=broken + pidAlive=false + surface_missing` → 同上
- `status=broken + surface_exists + pidAlive=true` → 従来通り A keep-alive
- `status=disconnected / idle + surface_missing` → 従来通り A
の 6 ケース。

`daemon.test.ts` 側にも `initializeLayout` 経由の broken+surface_missing prune を verify する case が追加されており（grep で `T027 boot: team.json に broken...` を確認）、`conductor_pruned ... reason=broken_surface_missing` の log assertion を含む。実行は Conductor 報告で 251 pass を正本採用。

### 4. 現役 broken 温存（regression なし） — **PASS**

- `layout-restore.ts:97` の条件は `!surfaceExists` 必須。surface 実在の broken はそのまま pidAlive 判定 → A keep-alive に流れ、`restoreConductorState` 経由で broken のまま保持される。
- `daemon.ts:1702` の CONDUCTOR_CLEAR 分岐も `clearPane === undefined` のみで delete。実在時は既存 `resetConductor` 経路。
- テストでも `surface_exists + status=broken` のケース (layout-restore.test.ts L203-213) が `alive.length===1 / decision==="keep-alive" / discarded.length===0` を assert。

### 5. 割り当てロジック無影響 — **PASS**

`git diff` で `findIdleConductor` / `isAssignableStatus` 周辺に変更なし。
`schema.ts:isAssignableStatus` は変更なし（broken は依然 false）。
daemon.ts:3691 の `findIdleConductor` 相当行も触れられていない（diff 80 行は §1349-§1370 と §1693-§1736 の 2 箇所のみ）。

### 6. observatory 両立（log の reason 区別） — **PASS**

2 経路でそれぞれ別 reason で `conductor_pruned` を出している:
- CLI 起点 (`daemon.ts:1727-1731`): `reason=user_clear_surface_missing` + `pid=<n>|null alive=<true|false|unknown>`
- boot 起点 (`daemon.ts:1364-1368`, `applyDiscardOnly` 経由): `reason=broken_surface_missing`

silent state mutation はない（delete 直前に必ず log）。
既存 `conductor_discarded` (surface_missing_no_task) / `conductor_stale_surface_closed` (pid_dead_idle) との混在を避けるため `conductor_pruned` という新 event 名で分離されており、retrospective grep で「broken からの除去」だけを抽出できる。

### 7. watcher リークなし（R1 論点） — **PASS**

`daemon.ts:1712-1719` を確認。`state.conductors.delete(conductor.surface)` (L1723) の前に:
- L1712-1715: `pidWatcherInterval` を `clearInterval` → `undefined`
- L1716-1719: `mailboxWatcherStop()` を呼出 → `undefined`

この 2 連停止は既存の abort_task (L1787-1789) / RESET_CONDUCTOR (L1894-1896) / forceCloseDisconnectedConductor (L4579-4581) と同形（grep で 7 箇所同パターン確認済）。
`mailboxWatcherStop()` の `try { ... } catch { /* best-effort */ }` は既存全 7 箇所と同じ慣習であり、daemon.ts:499 / 1268 / 1787 / 1894 / 3170 / 4579 と完全に揃っている。

### 8. CLAUDE.md ガードレール — **PASS**

- **EventBus**: `notifyStateChanged("daemon.ts:CONDUCTOR_CLEAR:pruned")` (L1733) のみ使用。`bus.emit` / `bus.on` 直書きなし。
- **getPaneForSurface に workspace**: L1698-1701 で `state.workspace ?? undefined` を渡している。
- **空 catch**: `try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }` (L1717) は既存全 7 箇所と同形の意図明示コメント付きで、新規 grey area の導入ではない。
- **task-state 直接 mutation なし**: 本変更は conductor map の delete のみ、`taskState[...]` 代入 / `saveTaskState(` 直接呼び出しなし。

### 9. spec 整合 (07-state-machine.md C-I6 / T027 段落) — **PASS**

`docs/spec/07-state-machine.md` diff:
- L36 以降に T027 段落追加：「`clear-conductor` は idle 復帰でなく team.json からの entry 削除」「`planLayoutRestore` も同条件 (`status=broken && !surfaceExists`) で entry を discard」「state machine の遷移ではなく **machine 外の entry エビクション**」「reducer は引き続き broken で全 event no-op」「CLI 起点 `user_clear_surface_missing` / boot 起点 `broken_surface_missing`」が明記されている。
- L156 (Invariants 表) に `C-I6 | status=broken && surface ∉ c11 tree ⇒ next CONDUCTOR_CLEAR / boot restore で entry 削除 (T027) | planLayoutRestore / CONDUCTOR_CLEAR handler` が追加されている。
- 既存 C-I4=error / C-I5=asking と衝突せず、採番は plan rev2 R2 と一致。

### 10. テスト（Conductor 報告を正本採用） — **PASS**

Conductor 既独立実行 (本 prompt 冒頭の OOM 回避条件で agent 実行は禁止):
- `layout-restore.test.ts`: **15 pass / 0 fail**
- `daemon.test.ts`: **251 pass / 2 skip / 0 fail**
- `bunx tsc --noEmit` (worktree root): **0 errors**

diff の grep でも T027 関連の追加 describe / test が想定通り入っていることを確認 (layout-restore に 6 ケース、daemon.test.ts に CONDUCTOR_CLEAR (T027 surface_missing pruning) + R4 watcher teardown + initializeLayout boot prune)。

---

## 補足観察（軽微・GO 判定を妨げない）

- i18n.ts 英語版 L508 後 / 日本語版 L1595 後にそれぞれ 1 行 Notes 追記。両言語同時更新で言語差分なし。完全に plan §3.4 通り。
- `applyDiscardOnly` 内コメント (daemon.ts:1352-1357) で 3 つの reason の出し分け根拠（`broken_surface_missing` → `conductor_pruned`、`surface_missing_no_task` → `conductor_discarded`、`pid_dead_idle_cleanup` は C 経路で記録済みのため重複防止で除外）が明示されており、後続レビュアに対する documentation も健全。
- package-lock.json は plan 指示通り検品対象外（Conductor が revert 予定）。
