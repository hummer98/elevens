# Design Review: T027 plan.md

## 判定

**Approved**

前回 T025 plan rev2 で Changes Requested を受けた R1〜R6 はすべて本 plan に取り込まれており、
v0.9.0 (`418d4ac chore: release v0.9.0`) 現 worktree で plan §0 の line 番号再検証表をサンプリング照合した結果、
**13 件すべて完全一致**でした。実装に進んで構いません。

ただし「巨大ファイル (daemon.ts 5053 行) は grep + 部分 Read 徹底」の運用注意は実装フェーズでも継続してください
（前回 Agent が巨大 payload で crash → 親 Conductor 道連れ死の教訓）。

---

## 1. 観点別評価

### 観点 1 — 案選択の妥当性（A+B 併用）

**評価: 妥当**

プロンプトでは「案B 優先で検討」とあるが、plan §2 は「B を主・A を副（escape hatch）」と明確に位置付け、
B 単独だと daemon 再起動を強要する UX 退行になる点と、観察箱原則の「観察できたら即介入できる経路を残す」を根拠に
A+B 併用を選んでいる。実装規模も A=handler 1 ヶ所書き換え / B=ループに 4 行挿入＋log filter 拡張で過剰ではない。

- `feedback_minimal_scope`（read side 拡張で済むなら膨らませない）との関係: 本件の要件は「team.json から entry を物理削除して再起動後も復活させない」という write side の変更が要件本体であり、
  read filter で隠す形では「再発防止」も「現に stuck している surface:27 を消す」も成立しない。read 側回避の選択肢は存在しないため最小スコープを逸脱していない。
- 「B のみ + daemon 再起動誘導」案も理屈上は escape hatch 要件を満たすが、観察箱原則（観察できたら即介入）に照らすと
  ユーザー操作（A）を残すべきという plan の判断は妥当。

### 観点 2 — observatory 両立（必須制約）

**評価: 妥当**

- **現役スロット broken の温存**:
  - A 経路（§3.3）は `pane === undefined`（c11 tree 不在）のみ delete。surface 実在なら従来通り `resetConductor` で idle 復帰。
  - B 経路（§3.1）は `c.status === "broken" && !surfaceExists` の AND 条件のみ discard。
  - 両経路で **`broken` かつ `!surfaceExists`** に限定されており、regression なし。
- **drop 対象の限定**: 上記の通り broken + surface_missing 限定。disconnected / running / idle / reserved / asking / error は touch しない。
- **silent state mutation 回避**:
  - A 経路: `conductor_pruned ... reason=user_clear_surface_missing pid=<n> alive=<bool>` で詳細を残す。
  - B 経路: `conductor_pruned ... reason=broken_surface_missing` で残す。
  - 既存の `conductor_discarded` (`reason=surface_missing_no_task`) とは event 名で分離され、retrospective grep で抽出可能。
  - silent eviction は無い。

### 観点 3 — line 番号・前提の正確性（実 Read サンプリング照合結果）

**評価: 正確（サンプリング 13 件すべて一致）**

下記の通り plan §0 の v0.9.0 再検証表は実コードと完全一致しました。

| 対象 | plan §0 主張 | 実 Read 結果 | 状態 |
|---|---|---|---|
| `layout-restore.ts:81-124` planLayoutRestore ループ全体 | L81 ループ開始 / L88-93 pidAlive 短絡 / L96-105 B / L106-110 C / L112-120 D / L122-123 E | 完全一致（ループ全体 L81-124） | ✅ |
| `conductor.ts:752` resetConductor 関数開始 | L752 | L752 完全一致 | ✅ |
| `conductor.ts:773-787` surface 実在確認 (T251 ガード) | L773-787 | L773-787 完全一致 | ✅ |
| `conductor.ts:894-895` `conductor.status = targetStatus` | L894-895 | L894 `const targetStatus = effectiveTargetStatus` / L895 `conductor.status = targetStatus` 完全一致 | ✅ |
| `conductor.ts:917-921` reserved 経路 pid クリア | L917-921 | L918-921 が `if (targetStatus === "reserved") { ... pid = undefined }` 本体、broken/idle 経路では pid 保持 — 完全一致 | ✅ |
| `daemon.ts:1104` T250 コメント | L1104 | `// T250: broken は再起動後も保持する（明示 clear まで idle に戻さない）` 完全一致 | ✅ |
| `daemon.ts:1110-1117` broken 復元 switch | L1110-1117 | L1113 で `c.status === "broken" ? "broken"` 完全一致 | ✅ |
| `daemon.ts:1192-1197` applyRestorePlan の set + watcher spawn | L1192-1197 | L1192 `state.conductors.set` / L1193-1195 `spawnPidWatcher` / L1197 `spawnConductorMailboxWatcher` 完全一致 | ✅ |
| `daemon.ts:1339-1361` applyDiscardOnly | L1339-1360 | L1339 関数開始 / L1352-1360 E ループ完全一致 | ✅ |
| `daemon.ts:1665-1694` CONDUCTOR_CLEAR ハンドラ | L1665-1694 | L1665 `case "CONDUCTOR_CLEAR":` / L1686-1690 `resetConductor(...)` 呼び出し / L1694 `}` 完全一致 | ✅ |
| `daemon.ts:1727-1736` RESET_CONDUCTOR watcher 2 連停止 | L1727-1736 | L1728-1730 `pidWatcherInterval` / L1732-1735 `mailboxWatcherStop` 完全一致 | ✅ |
| `daemon.ts:4489` forceCloseDisconnectedConductor 関数開始 (T027 訂正値) | L4489 | L4489 `async function forceCloseDisconnectedConductor` 完全一致（plan の T025 → T027 訂正反映済み） | ✅ |
| `daemon.ts:4518-4527` forceClose の watcher 2 連停止 | L4518-4527 | L4519-4522 `pidWatcherInterval` / L4524-4527 `mailboxWatcherStop` 完全一致 | ✅ |
| `docs/spec/07-state-machine.md:33,36` broken 状態定義・解除手段散文 | L33 / L36 | L33 状態定義行 / L36 「`broken` は終端状態。`cmux-team clear-conductor` または `cmux-team reset-conductor`（T004…）でのみ解除」完全一致 | ✅ |
| `docs/spec/07-state-machine.md:143-147` Invariants C-I1〜C-I5 | C-I4=error / C-I5=asking 占有確認 | L146 C-I4=`status=error ⇒ lastApiError != null (T392)` / L147 C-I5=`status=asking ⇒ askQuestion != null (T014)` 完全一致 — **新 invariant 採番が C-I6 で正しい** | ✅ |

特筆事項:
- plan §0 が訂正項目として明示する 2 件 — (a) `forceCloseDisconnectedConductor` の関数開始行 `L4513-4518 範囲 → L4489` (b) `CONDUCTOR_CLEAR` 末尾 `L1693 → L1694` — はいずれも実 Read で確定。
- それ以外の参照 line（restoreConductorState / applyRestorePlan / applyDiscardOnly / RESET_CONDUCTOR / cmdClearConductor / resetConductor / planLayoutRestore / conductor-fsm.ts / i18n.ts / spec/07 invariants）も plan の主張通り完全一致。

### 観点 4 — 回帰リスク

**評価: 妥当**

`planLayoutRestore` の挿入位置（**L86 直後・L88 pidAlive 短絡コメントの手前**）は安全:

- 既存 A 経路（pidAlive 短絡）を **下流** に置くため、`broken + surface_exists + pidAlive` は従来通り A keep-alive に流れる。**現役 broken スロット温存 OK**。
- `broken + surface_missing` だけが新規 discard 経路に分岐。pid 生死を見ない（plan の「pid recycle で `pidAlive=true` 誤判定」根拠と整合）。
- 他状態 (`disconnected` / `running` / `reserved` / `idle` / `asking` / `error`) は `c.status === "broken"` ガードで素通り。既存挙動 100% 維持。

pid recycle ケースの扱い:
- 現状は broken Conductor の pid が他プロセスに recycle されても `cmux.isAlive(pid)` で `true` になり、A keep-alive で永続化される。本変更で surface_missing なら必ず discard されるため、recycle の影響を根絶。**正しい**。

### 観点 5 — watcher リーク対応（前回 T025 design-review R1 の反映）

**評価: 妥当（前回指摘を完全に反映済み）**

前回 T025 design-review の Critical C1（pid watcher リーク）/ Major M1（mailbox watcher 未言及）を plan §3.3 が完全に取り込んでいる:

- delete の **前**に `pidWatcherInterval` clearInterval + `mailboxWatcherStop` 呼び出しの 2 連停止。
- 同形パターンの既存 3 箇所をすべて実コードで confirm:
  - `daemon.ts:1727-1736` RESET_CONDUCTOR watcher 2 連停止（**実 Read 一致**）
  - `daemon.ts:4518-4527` forceCloseDisconnectedConductor watcher 2 連停止（**実 Read 一致**）
  - plan §3.3 コメントの abort_task 参照も実コード経路で確認可（teardown 規約として確立）
- コメント内で「daemon 再起動を挟むと `applyRestorePlan` (`daemon.ts:1192-1197`) が `spawnPidWatcher` / `spawnConductorMailboxWatcher` を再 spawn する」と前回 R1 根拠も正確に反映。
- 「broken 遷移時に clear 済み」「副次的に害なし」の誤前提 2 文は削除されている。

### 観点 6 — テスト計画の十分性

**評価: 十分**

5.1 layout-restore.test.ts に 5 ケース、5.2 daemon.test.ts CONDUCTOR_CLEAR に 4 ケース + R4 由来 2 ケース（watcher teardown assert + delete 後 tick の state 不変 assert）、5.3 boot integration に 3 ケース、5.4 既存テスト regression check の列挙、5.5 で per-file 実行コマンド（A021 / bun test 全体禁忌の遵守）まで網羅。検証条件（残骸除去・再起動後復活しない・現役 broken 残る・割り当て無影響）は以下の通り対応:

| 検証条件 | 対応テスト |
|---|---|
| 残骸除去（A 経路） | 5.2 「broken + getPaneForSurface undefined」 |
| 残骸除去（B 経路） | 5.1 「broken + pidAlive + surface_missing」 / 5.3 「boot で broken+surface_missing を 1 件含む状態」 |
| 再起動後復活しない | 5.3 「team.json round-trip: pruned 後の next save で disk から該当 entry が消える」 |
| 現役 broken 残る（A） | 5.2 「broken + getPaneForSurface 実在」(既存 ST-1 維持) |
| 現役 broken 残る（B） | 5.1 「status=broken + surface_exists」 |
| 割り当て無影響 | 5.4 で `schema.ts:503` `isAssignableStatus` 触らないため `state-machine/fsm.test.ts` regression check で担保 |
| watcher リーク無し | 5.2 R4 追加 (`pidWatcherInterval === undefined` / `mailboxWatcherStop === undefined` / active timer count pre/post 比較) |
| delete 後 tick の state mutation 無し | 5.2 R4 追加 「`__testSpawnPidWatcherTick` を delete 後に呼んでも `state.conductors.has(surface) === false` のまま」 |

小さな観点として、`cmdClearConductor` CLI 入口側のテストは plan に列挙されていないが、§3.5 で「CLI 側は変更しない」と明示しており既存ガードのみ維持 — 追加テスト不要は妥当。
dashboard event tail での `conductor_pruned` 視認性は §3.6 TODO（実装時 5 分タスク）で担保しており、自動 assert は不要というスコープ判断も合理的。

### 観点 7 — spec 更新

**評価: 妥当**

- §6.1: `docs/spec/07-state-machine.md:36` 直後に broken の「surface 不在時は CLI / boot reconcile で entry 削除（`conductor_pruned`）」を追記する案。L36 が散文セクションなので追記位置として自然。
- §6.2: 新 invariant `C-I6` 採番。前回 R2 指摘（C-I4 = error / C-I5 = asking が既占有）を反映済み。**実 Read で L146 C-I4 / L147 C-I5 占有を最終確認した**ため C-I6 採番で正しい。
- §6.3: reducer は no-op のまま、entry eviction は state machine 外の操作（machine 外 evict）と注記する案。FSM の整合性を壊さず、観察箱で「broken は終端だが evict され得る」を読者に伝えられる。
- 他 spec（05 / 10）更新不要の判断も合理的。`events.jsonl` への `conductor_pruned` 公開は §7.2 で別 issue として明示的に切り出されている。

---

## 2. 前回 T025 design-review R1〜R6 の反映確認

| 指摘 | 内容 | 本 plan での対応 | 状態 |
|---|---|---|---|
| R1 (Critical) | CONDUCTOR_CLEAR prune 分岐に pidWatcher + mailboxWatcher 2 連停止を追加。「broken 遷移時に clear 済み」前提誤りの 2 文削除 | §3.3 で teardown 追加・既存パターン参照（L1727-1736 / L4518-4527）を明示・誤前提文削除済み | ✅ 完全反映 |
| R2 (Major) | 新 invariant ID `C-I4` → `C-I6`（C-I4 / C-I5 既占有） | §6.2 で `C-I6` に変更済み。改訂履歴にも明記 | ✅ 完全反映 |
| R3 (Major) | i18n.ts 英語版 (L494-509) + 日本語版 (L1579-1596) 両方に help_clear_conductor の Notes 1 行追加 | §3.4 で両言語に対応行を追加。同 PR で同時 commit 指示も明記 | ✅ 完全反映 |
| R4 (Major) | テスト計画に「再起動経由を模した broken (pid 生存) + surface_missing + CONDUCTOR_CLEAR」「watcher tick が delete 後に走っても state 不変」追加 | §5.2 に R4 追加ケース 2 件として明記。`__testSpawnPidWatcherTick` パターンに合わせる手法も記載 | ✅ 完全反映 |
| R5 (Minor) | line 参照訂正 (`conductor-fsm.ts:40-42` → `42-44`、spec `L33` → `L36 / L145 (C-I3)`) | §1.5 で訂正済み | ✅ 完全反映 |
| R6 (Minor / 任意) | dashboard event tail の `conductor_pruned` 視認性 TODO | §3.6 末尾に TODO 1 行追加済み（実装コスト 5 分） | ✅ 完全反映 |

---

## 3. 追記コメント（実装時の留意点 — 必須ではない）

これらは **Approved 判定を覆さない補足**で、実装時の参考までに記す。

1. **§3.3 の `notifyStateChanged` 後の team.json 永続化経路**: plan は「main.ts の handleMessage flush ループが team.json を rewrite」と述べているが、実コード上の経路は `notifyStateChanged` → debounce → `writeTeamJson` の daemon 内部経路。誤った起点ではないが、実装コメントを書くなら「team.json 永続化は `notifyStateChanged` を起点に既存 debounce 経路で行われる」程度の文言にすると誤解が無い。
2. **§3.6 dashboard 視認性 TODO**: dashboard 側で `conductor_broken` / `conductor_discarded` の色付け / フィルタリングがされている場合、`conductor_pruned` も同等扱いに揃える 1 行追加が必要。実装時の grep で `conductor_discarded` の dashboard 側 reference を一発確認可。
3. **巨大ファイル取り扱い**: `daemon.ts` は v0.9.0 で 5053 行。実装フェーズでも grep / 部分 Read（offset/limit、1 回 150 行以内）に徹すること。`bun test` 全体実行も禁忌 — per-file 実行ループ（plan §5.5）を守る。
4. **§7.2 残課題**: `resetConductor` で broken 経路でも pid をクリアすべきか / events.jsonl への `conductor_pruned` 公開 / steady-state での自動 reconcile / dashboard 視覚区別、いずれも別 issue として spec から見える形で切り出されており、本タスクスコープの hygiene は良好。

---

## 4. 判定（再掲）

**Approved**

前回 T025 design-review の R1〜R6 が完全に反映されており、v0.9.0 worktree での line 番号も
サンプリング 13 件すべて一致しました。実装に進んで構いません。
