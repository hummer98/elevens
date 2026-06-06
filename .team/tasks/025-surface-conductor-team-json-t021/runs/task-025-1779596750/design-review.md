# Design Review: T025 plan.md

## 判定

**Changes Requested**

Critical 1 件（pid watcher リーク前提誤り）と Major 2 件（mailbox watcher 未言及、invariant ID 衝突）を確認しました。
方針 A+B 併用の戦略・matrix 拡張位置・観察可能性担保 (`conductor_pruned` log)・テスト構造は健全で、
下記の修正を入れれば実装に進めます。

---

## 検証した前提（コード Read 結果）

| plan §  | 主張 | 検証結果 |
|---|---|---|
| §1.1 | `daemon.ts:1069-1118` `restoreConductorState()` の status switch (L1110-1117) で `broken` を保持、L1104 にコメント `// T250: broken は再起動後も保持する` | **正** `daemon.ts:1110-1117` switch・L1104 コメント完全一致 |
| §1.2 | `layout-restore.ts` `planLayoutRestore` L88-105 で `pidAlive` 短絡（surface 不確認） | **正** L88-93 で `if (pidAlive) { alive.push(...); continue; }`、surface は見ない |
| §1.2 末尾 | `resetConductor` (conductor.ts:893-921) は `reserved` 経路でのみ pid を undefined にする（L917-921） | **正** L917-921 `if (targetStatus === "reserved") { conductor.pid = undefined; }`。broken 経路では pid 保持 |
| §1.3 | `resetConductor` L773-787 で surface 不在時に `effectiveTargetStatus="broken"` に倒し戻し、L894-895 で `conductor.status = targetStatus` に反映 | **正** conductor.ts:778-787, 893-895 一致 |
| §1.3 | `CONDUCTOR_CLEAR` ハンドラ `daemon.ts:1665-1693` | **正** L1665-1694（plan の末尾 1 行ずれは許容範囲）。`{ targetStatus: "idle", reason, cleanupMode: archive }` の呼び出し形 OK |
| §1.4 | `main.ts:5241-5281` `cmdClearConductor()` の `status !== "broken"` ガード | **正** L5265-5271 exit 1。surface 実在は CLI で確認しない |
| §1.5 | `state-machine/conductor-fsm.ts:40-42` で broken 全 event no-op | **正** L42-44（plan の L40-42 は 2 行ずれ — 軽微） |
| §3.1 / §3.2 | `applyDiscardOnly` E ループ (`daemon.ts:1352-1360`) で `surface_missing_no_task` のみ log 出力 | **正** L1352-1360 一致。関数名は `applyDiscardOnly`（L1339）で plan と一致 |
| §3.3 設計判断 | 「pid watcher の停止は broken 遷移時に既に実施済み (**resetConductor 内で interval clear**)」 | **誤** — `conductor.ts` 内に `pidWatcher` / `clearInterval` の出現ゼロ（grep 確認）。実際は `forceCloseDisconnectedConductor` (daemon.ts:4518-4522) が `resetConductor` を呼ぶ**前**に clearInterval している。さらに**daemon 再起動を経た broken は L1192-1195 `spawnPidWatcher` で再 spawn される**（後述 Critical #1） |
| §3.3 設計判断 | 「万一残っていても削除後の `state.conductors.get(surface)` が undefined になるため副次的に害は出ない」 | **誤** — tick 関数 `__testSpawnPidWatcherTick` (daemon.ts:3835-3878) は `state.conductors.get` を呼ばず、`conductor` 引数を直接 mutate する設計。`state.conductors.delete` 後も interval は走り続ける（後述 Critical #1） |
| §6.2 spec invariant 追加 ID = `C-I4` | spec/07 L144-147 に C-I1〜C-I5 が既存。**C-I4 は `status=error ⇒ lastApiError != null` で T392 が占有済み** | **誤** — `C-I6` に振り直す必要あり |

---

## 指摘事項

### Critical（必須修正）

#### C1. CONDUCTOR_CLEAR の prune 分岐で pid watcher を明示停止する必要がある

plan §3.3 は「pid watcher は broken 遷移時に clear 済みなので delete だけで足りる」と前提を置いているが、**daemon 再起動を挟むと前提が崩れる**。

実コードの確認結果:

1. `conductor.ts` の `resetConductor` 内に pidWatcher の停止コードは存在しない（grep 結果空）。
2. broken 遷移時の停止は唯一 `daemon.ts:4518-4522` の `forceCloseDisconnectedConductor` 内、`resetConductor(targetStatus: "broken")` を呼ぶ**前**で行われる。
3. その後 daemon が再起動すると `applyRestorePlan` (`daemon.ts:1192-1195`) で:
   ```ts
   state.conductors.set(c.surface, c);
   if (typeof c.pid === "number") {
     spawnPidWatcher(state, c, c.pid);
   }
   ```
   が走り、**broken でも pid 値が残っていれば pidWatcher が再 spawn される**。
4. tick 関数 `__testSpawnPidWatcherTick` (`daemon.ts:3835-3878`) は `state.conductors.get(surface)` を確認せず、引数で受け取った `conductor` オブジェクトを直接 mutate する設計:
   ```ts
   if (cmux.isAlive(pid)) return "alive";   // ← alive の間は永久に走る
   conductor.status = "disconnected";        // delete 後は state に反映されない
   conductor.pid = undefined;
   ```
   → `state.conductors.delete` 後も `setInterval` は alive な間ずっと走り続け、**dangling timer リーク**。
   さらに pid が死亡検出された瞬間に削除済みオブジェクトを mutate し、`session_ended` / `conductor_disconnected` ログ・`events.jsonl` emit・shadow observe まで走る（observability 上のノイズ）。

**修正案**: CONDUCTOR_CLEAR ハンドラの prune 分岐（plan §3.3 のコードブロック）で `state.conductors.delete` の**前**に明示 teardown を入れる:

```ts
if (pane === undefined) {
  // pid watcher / mailbox watcher を明示停止（再起動経由で再 spawn されているケースの確実な teardown）
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }
  if (conductor.mailboxWatcherStop) {
    try { conductor.mailboxWatcherStop(); } catch { /* best-effort */ }
    conductor.mailboxWatcherStop = undefined;
  }
  state.conductors.delete(conductor.surface);
  await log("conductor_pruned", ...);
  notifyStateChanged("daemon.ts:CONDUCTOR_CLEAR:pruned");
  requestWakeup(state);
  break;
}
```

これは abort_task (L1834-1842) / RESET_CONDUCTOR (L1727-1736) / forceCloseDisconnectedConductor (L4518-4527) の既存 teardown シーケンスと同形で、規約として確立している（**該当箇所すべてが pid watcher → mailbox watcher の 2 連停止を必ず行う**）。CONDUCTOR_CLEAR の prune 分岐だけ抜けると invariant がほつれる。

---

### Major（修正推奨）

#### M1. mailbox watcher の teardown 漏れ（C1 と同根）

`applyRestorePlan` L1197 `void spawnConductorMailboxWatcher(state, c)` は **status 不問で**全 alive entry に対し起動される。broken Conductor も restore されれば mailbox watcher が走る。
plan §3.3 は pid watcher のみ言及し mailbox watcher について沈黙しているため、teardown 漏れになる。

→ C1 の修正案に含めて同時に対応する（上記コード参照）。
追加テスト (M3 参照) でも mailbox watcher の停止を assert する。

#### M2. spec §1.4 invariants に追加する ID が衝突している

plan §6.2 は新 invariant を `C-I4` として追加するが、`docs/spec/07-state-machine.md:146` で**既に C-I4 = `status=error ⇒ lastApiError != null` (T392 由来)** が定義済み。L147 で C-I5 (asking) まで埋まっている。

→ 新 invariant の ID を **C-I6** に変更する。テキスト本文（plan §6.2 の表内 conditional）はそのまま流用可。

```diff
- | C-I4 | status=broken && surface ∉ c11 tree ⇒ next CONDUCTOR_CLEAR / boot restore で entry 削除 | planLayoutRestore / CONDUCTOR_CLEAR handler |
+ | C-I6 | status=broken && surface ∉ c11 tree ⇒ next CONDUCTOR_CLEAR / boot restore で entry 削除 | planLayoutRestore / CONDUCTOR_CLEAR handler |
```

#### M3. テスト計画に watcher teardown の assert が無い

5.2 の「broken + getPaneForSurface undefined」ケースは `state.conductors.has(surface) === false` までしか assert していない。
C1/M1 の teardown が抜けても test pass してしまうため、次の assert を追加する必要がある:

| 追加ケース | assert |
|---|---|
| 再起動経由を模した broken (pid 生存) + surface_missing + CONDUCTOR_CLEAR | (a) `conductor.pidWatcherInterval === undefined` (b) `conductor.mailboxWatcherStop === undefined` (c) test 終了時に Bun の active timer count が pre-CLEAR と等しい（リーク無し） |
| 同上 + 数 tick 後 | tick 関数が dangling 参照経由で `conductor.status = "disconnected"` を書きに来ても、`state.conductors.has(surface) === false` のまま（state mutation が起きない） |

`conductor` への直接参照を握って tick を回す手法は既存 `__testSpawnPidWatcherTick` テストパターンに合わせる。

---

### Minor（任意）

#### m1. i18n.ts 日本語版の更新漏れ

plan §3.4 は英語版 `help_clear_conductor` (`i18n.ts:494-509`) のみ言及。日本語版 (`i18n.ts:1579-1596`) にも対応する 1 行追加が必要:

```diff
  Notes:
    - broken 状態の Conductor のみクリアできます
    - 他の状態は abort-task / restart-task を使ってください
    - worktree / branch 残骸は broken 遷移時点で既に掃除済みのため、ここでは行いません
+   - surface が c11 tree から消えている場合、idle 復帰ではなく team.json から entry 削除されます（conductor_pruned で記録）
```

#### m2. spec §1.5 の参照 line が「定義行」と「invariant 行」を混同している

plan §1.5 で「`docs/spec/07-state-machine.md:33`: `broken` の解除手段は `clear-conductor` / `reset-conductor` のみと明記」と書いているが、L33 は broken の **状態定義行**。解除手段の明記は L36（散文）と L145（C-I3）。読者の混乱回避のため `L36 / L145 (C-I3)` と訂正したほうが正確（実害は無い）。

#### m3. plan §1.5 で参照される `conductor-fsm.ts:40-42` は実際には L42-44

差し障りの無い 2 行ずれだが、レビュアー追跡時の摩擦を減らすため修正推奨。

#### m4. dashboard の event tail への影響確認

plan §3.6 で「dashboard.tsx: 削除されれば自然に表示から消える（差分なし）」と書いているが、`conductor_pruned` は新規 event 名のため dashboard の event filter / styling 側で取り扱いが無い場合、ログとして無色表示される可能性がある（既存 `conductor_discarded` と同階層と plan は宣言しているが実装確認は無し）。
real-time 観察軸（観察箱原則）に照らすと、Critical/Major には届かないが、`conductor_broken` と並ぶ「conductor が消えた」イベントは UI で見える方が観察しやすい。実装時に dashboard の既存 RED 表示色を `conductor_pruned` にも継承させる check を 5 分で済むため添える価値あり。

---

## Recommendations（Changes Requested 対応の具体的修正指示）

plan を以下のとおり改訂してください:

### R1. plan §3.3 のコードブロックを差し替え

`if (pane === undefined) { ... }` ブロックを上記 C1 の修正案で置き換える。
コメント部に「再起動経由で spawnPidWatcher / spawnConductorMailboxWatcher が再 spawn されている可能性があるため、delete 前に明示 teardown する」と根拠を残す。
「pid watcher の停止は broken 遷移時に既に実施済み」「副次的に害は出ない」の 2 文は削除して上記コメントに置き換える。

### R2. plan §6.2 で追加する invariant ID を `C-I4` → `C-I6` に変更

本文ロジックはそのまま。表セル ID のみ更新。

### R3. plan §3.4 を i18n.ts 英語版 + 日本語版の両方に拡張

`help_clear_conductor`（L494-509 / L1579-1596 の双方）に Notes 1 行を追加する旨明記。

### R4. plan §5.2 のテストケースを M3 の項目で拡張

「再起動経由を模した broken + pid 生存 + surface_missing + CONDUCTOR_CLEAR」ケースを追加し、`pidWatcherInterval === undefined` / `mailboxWatcherStop === undefined` を assert。
さらに「watcher tick が delete 後に走っても state.conductors に影響しない」ケースを追加。

### R5. plan §1.5 / §1.3 の line 参照を実コードに合わせて訂正（軽微）

- §1.5 `conductor-fsm.ts:40-42` → `42-44`
- §1.5 spec 参照 `L33` → `L36 / L145 (C-I3)`

### R6.（任意）plan §3.6 に dashboard event filter 確認の TODO を 1 行追加

「`conductor_pruned` log が dashboard event tail で `conductor_broken` と同程度に視認できるか実装時に確認、必要なら styling 1 行追加」と記す。実装の追加コストは低い。

---

## 判定（再掲）

**Changes Requested**

Critical C1（pid watcher リーク）は実害（メモリリーク + 削除済み Conductor への mutation による observability ノイズ）を伴うため必須修正。
Major M1/M2/M3 を併せて plan 改訂したのち再レビュー不要で実装に進んで可（修正範囲が明確かつ既存パターンに合致しているため）。

**Changes Requested**
