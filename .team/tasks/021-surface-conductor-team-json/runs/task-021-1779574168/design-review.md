# T021 Design Review — surface 不在の残骸 Conductor を team.json から除去できる経路

> Reviewer: surface:73 (task-021-1779574168) — Planner (surface:102) とは別セッション。
> 対象: `plan.md`（同 runs/ 配下）

---

## 判定: Changes Requested

コアの設計（A 主軸 + B 回帰テスト、明示 CLI 起点での prune、observatory 制約の遵守）は妥当で、
実コードの根本症状把握（resetConductor の surface 実在ガード T251 が idle 復帰を broken に倒し戻すため
clear-conductor が詰む）も実装一致。

ただし以下の **6 件の指摘**（うち R1〜R3 が中程度、R4〜R6 が軽微）を反映してから実装に進むこと。

---

## 各レビュー観点の所見

### 1. observatory 制約の遵守 — OK（一部要追記）

| 制約 | 充足状況 |
|---|---|
| 「現役スロット broken は残す」 | OK — `getPaneForSurface(...) !== undefined` 分岐は従来 resetConductor 経路に流す |
| 「drop 対象は現スロットに属さない過去 surface の残骸に限定」 | OK — `state.conductors.get(surface)` の broken entry のみ、かつ surface 不在を二重確認 |
| 「削除時に journal/log を残す（silent state mutation 禁止）」 | OK — `conductor_pruned` を manager.log + events.jsonl + notifyStateChanged で出す |

**ただし**「現役スロットで surface が一時的に missing なだけのケースを誤って消さないか」は plan が
正面から議論していない。詳細は R1 で指摘。

### 2. 方針選定の妥当性（A vs B）— OK

実コード（`skills/cmux-team/manager/layout-restore.ts:63-142` planLayoutRestore、
`daemon.ts:1163-` applyRestorePlan、`daemon.ts:1339-1361` applyDiscardOnly）を読み込み確認：

- planLayoutRestore は `pidAlive = typeof c.pid === "number" && isAlive(c.pid)`（L83）+
  `surfaceExists = liveSurfaces.has(c.surface)`（L84）+ `runningTask = !!(taskId && resumeByTaskId.has(taskId))`（L86）で分類。
- 「broken + pid undefined + surface missing + taskId 無し」は pidAlive=false / surfaceExists=false /
  runningTask=false なので E `discard` 分類に入る（L122-123）。
- applyRestorePlan は冒頭 `state.conductors.clear()`（L1167）→ A/B のみ再登録、C/E は再登録しない。
- applyDiscardOnly は E に対して `conductor_discarded` ログのみ出して終わる（L1352-1360）。

→ plan の主張「daemon 再起動さえ走れば surface:27 は team.json から落ちる」は実コード一致。
**dedicated test（C4）が無い**点も layout-restore.test.ts L75-98 を読んで確認（M5 は pid number で
ALL_DEAD の組合せだけ。pid undefined ケースは未カバー）。C4 追加は妥当。

ただし B 経路には **副次的なリスク**が 1 つある（R2 で指摘）: planLayoutRestore は status="broken"
を直接判定しないため、「broken + surface alive + pid undefined」だと C `cleanup-stale` 経路で
**surface を closeSurface してしまう**（applyDiscardOnly L1345）。これは現行コード問題で本タスク
スコープ外だが、broken の observability 哲学とは衝突する。plan の「実装スコープ外」セクションに
言及があると親切。

### 3. 誤削除ガードの正確さ — 概ね OK（前提を 1 件補正）

- `getPaneForSurface`（`cmux.ts:298-310`）は **v0.9.0+ (T016) で tree 失敗時 throw 化**されている
  （L290 のコメント）。「surface が見つからなかった」場合のみ undefined を返す。
  plan の主張「一時的なエラーで誤 prune するリスクは低い」は実コード一致。retry の要否判断も妥当
  （resetConductor 自身も retry 無しで getPaneForSurface を呼んでいる L763）。
- **broken ⇒ taskRunId == null** の不変条件は `resetConductor` L881-882 で `conductor.taskRunId = undefined;
  conductor.taskId = undefined;` と clear されるので一致。
- **broken ⇒ pid == undefined** は plan が暗黙に仮定しているが、**厳密には正規経路（disconnected → broken）
  のみ保証**。`spawnPidWatcher`（daemon.ts:3838）が PID 死亡検出時に `conductor.pid = undefined` に
  落としてから disconnected → forceCloseDisconnectedConductor が resetConductor(broken) を呼ぶ流れ。
  surface_missing 経由の broken（resetConductor 内 L765 自動倒し）では pid が残る可能性があり、
  prune 時にプロセスが残存しているケースが理論上あり得る。実害は小さい（OS が片付ける）が、
  R3 で言及する。

### 4. CLI 経路の正しさ — OK

- `main.ts:5216-5256 cmdClearConductor`：L5240-5246 で `status !== "broken"` を pre-check 拒否、
  plan の認識と一致。
- daemon.ts CONDUCTOR_CLEAR ハンドラの位置（L1665-1693）も実コード一致。
- ただし、`broken → idle` を出力していたメッセージ（L5255）が「broken → 削除（surface 不在時）」
  にもなるため、ユーザーに見える挙動が分岐する。詳細は R4 で指摘。

### 5. 実害評価とスコープ — 概ね OK

- runtime tick 自動 prune を採用しない判断 → observatory 制約と整合、妥当。
- `--all-broken` フラグ不採用 → スコープとして妥当。
- TUI 変更不要 → entry 消えれば自動で消える、妥当。
- **不足**: 「broken + surface alive + pid undefined」が C 経路で closeSurface される副次効果
  （上述）への言及が無い。本タスクの範疇外と明示するか、別 issue を立てる方針かを書いておくこと。

### 6. テスト網羅性 — 一部不足（要追加）

C1〜C4 は要件をほぼ網羅。ただし以下が漏れている（R5 で指摘）：

- **C5（追加推奨）**: `getPaneForSurface` が throw する場合（tree 失敗）の挙動 —
  prune も idle 復帰も起こらず、handleMessage の外側でハンドリングされること（または
  daemon が落ちずに次メッセージを処理し続けること）の保証。
- **C2 補強**: C2 では `getPaneForSurface` の mock が "pane:abc" を返すと resetConductor 内でも
  もう一度呼ばれる（L763 で再 invocation）。テストが「同じ surface に対し 2 回呼ばれる」を
  assert または許容することを明示しないと flaky 化する。あるいは prune 経路で取った pane 値を
  resetConductor の opts として渡す設計に変えるとシンプル化する。

### 7. ガードレール遵守 — OK（1 件補強推奨）

- `notifyStateChanged` のみ使用 → plan のコード OK。
- `applyTaskEvent` 経由 → broken には taskId が無いので task-state は触らない。**plan に
  明示コメントを足すこと**（R6）。「broken ⇒ taskRunId == null なので task-state mutation は不要」と
  CONDUCTOR_CLEAR ハンドラの prune 分岐コメントで明示しないと、後続改修者が「ここでも markTaskAborted
  を呼ぶべきか」を再判断するコストが発生する。
- `cmux tree` workspace 必須 → plan は `state.workspace ?? undefined` を渡している。
  `getPaneForSurface` 自体は workspace optional 受け（L298）なので throw はしないが、
  fetchLiveSurfaces 系（必須 throw）との非対称が分かりにくい。コードはそのまま OK。
- 空 catch 禁止 → plan の new code に空 catch 無し、OK。
- ログに stderr 含む → 該当箇所無し（外部コマンド直接呼ばないため）、OK。
- `bus.emit` / `bus.on` 直接使用禁止 → plan の new code は `notifyStateChanged` 経由のみ、OK。

### 8. docs/spec 更新 — OK

- 07-state-machine.md §1.1 / §1.2 footnote / §1.4 mermaid / §1.6 不変条件 C-I6 追加 → 妥当な範囲。
- 10-events-stream.md の `conductor_pruned` schema 追記、`schema_version` 据え置き → 妥当
  （他の add-only event と同じ運用）。
- reader 互換（T359/T360）について plan は触れていないが、`schema_version` 据え置きならば既存 reader
  は新 event を unknown としてスキップする想定。spec §6.x の forward-compat 規約を確認のうえ問題無ければ
  そのまま、要更新ならば該当 § に追記すること。

---

## Recommendations

Planner は plan.md を以下のように修正してから実装に進むこと。

### R1（重要）: 誤削除リスクの議論を §5 に補強する

§5「誤削除防止のガード条件」テーブルに **「tree が成功するが特定 surface が一時的に listing から
漏れるケース」** を明示的に評価する 1 行を追加すること。c11 substrate がこのケースをどこまで除外
保証しているか（surface lifecycle の一貫性）を skills/c11/SKILL.md か c11 spec で確認し、
- 「listing 漏れは substrate レベルで起きない」と確認できれば → その根拠を脚注で書く
- 確認できなければ → retry / confirm prompt（"Are you sure to prune?"）を任意で入れる検討を残す

(現状の plan は v0.9.0+ retry を「検討する」とだけ書いて結論を先送りしているが、観察箱原則「壊れた
事実を残す」を優先するなら、誤 prune は idle 誤復帰より重い結果。明示的判断が要る。)

### R2（重要）: 「broken + surface alive + pid undefined」の副作用に言及

planLayoutRestore L106-110 の C `cleanup-stale` 経路は status を見ずに pidAlive + surfaceExists +
!runningTask で判定するため、status="broken" の Conductor が surface alive の状態で daemon
restart した場合、**applyDiscardOnly が `cmux.closeSurface(conductor.surface)` を呼んで pane を
破壊する**（daemon.ts L1345）。

これは observability 哲学（broken は人間が認識するまで残す）と衝突する既存挙動だが、本タスクで
触れないなら §9「実装スコープ外」に **「B 経路 C 分類の status 非考慮は本タスク範囲外、別 issue 化」**
と明示すること。Plan の主張「B 経路は既存でカバー済み」だけだと、C 経路の暴発を後続レビューで
見落とすリスクが残る。

### R3（中程度）: broken ⇒ pid undefined の前提を明示し、prune 時の pid 状態を確認する

plan §5 のガード条件は暗黙に「broken ⇒ pid undefined」を仮定しているが、surface_missing 経由の
broken（`conductor.ts:765`）では pid が残るケースがある。prune ロジックで以下のいずれかの方針を
明示すること：
- (a) 「pid が残っていても prune する」と明記し、観測ログ（`conductor_pruned`）に `pid=${pid ?? "null"}
  alive=${cmux.isAlive(pid)}` を含めて retrospective に追えるようにする（`conductor_broken` の
  aliveSuffix と整合、conductor.ts L917-920 参照）
- (b) 「pid が残っていれば prune を抑止する」と明記し、ガード条件に追加（こちらは過剰防衛）

実害は小さいが、明示しないと「pid leak している = prune してはいけない」と後続改修者が誤読する
余地が残る。

### R4（中程度）: CLI 出力メッセージで prune と idle 復帰を区別する

§3.2 末尾の main.ts コメント部分：

```ts
console.log(`OK cleared ${normalizedSurface} (broken → idle or pruned if surface missing)`);
```

を「採用」または「不採用＋理由」のどちらか明示にして plan に確定すること。現状は提案だけして
あいまいに留まっている。

推奨は **採用**（ユーザーが state mutation 結果を CLI 出力だけで把握できる ＝ observatory 強化）。
ack を待つ実装が重いなら、せめてメッセージを「broken → cleared (check team.json / manager.log
for prune vs idle)」に変えて誤解を防ぐ。

### R5（軽微）: テスト C5（tree 失敗時の挙動）と C2 の double-call 配慮を追加

§3.1 に以下を追加：

```
#### Test C5: getPaneForSurface が throw した場合
- pre-state: 同 C1
- mock: `cmux.getPaneForSurface` → throws new Error("tree failed")
- act: CONDUCTOR_CLEAR
- assert:
  - state.conductors.has("surface:99") === true（entry 維持、prune しない）
  - conductor.status === "broken"（idle 復帰もしない）
  - daemon が落ちない（次の handleMessage 呼び出しが正常に走る）
```

また C2 では `getPaneForSurface` mock が **2 回呼ばれる**（CONDUCTOR_CLEAR ハンドラ内 + resetConductor 内）
ことを assert または計数で許容するよう明記すること（mock が単発返答だと resetConductor 内が
undefined を受け取り broken に倒し戻して assertion が壊れる）。

### R6（軽微）: CONDUCTOR_CLEAR prune 分岐のコメントで「task-state 不要」を明示

§3.2 のコードコメントを以下に拡充：

```ts
// T021 NEW: surface 不在の broken 残骸は entry を prune する。
//   ガードレール: broken ⇒ taskRunId == null （resetConductor で clear 済み）なので
//     task-state mutation (applyTaskEvent / markTaskAborted) は呼ばない。
//   ガードレール: archive は broken 遷移時点で完了済みなので再 archive しない。
//   ガードレール: pane は元から不在（getPaneForSurface === undefined）なので closeSurface しない。
const pane = await cmux.getPaneForSurface(...);
```

後続改修者が「ここで markTaskAborted / cleanup を呼ぶべきか」を再判断するコストを下げる。

---

## 補足: 実装に進む前に追加で確認すべきこと

- R1 の c11 substrate 保証は確認次第、plan §5 に脚注として残すこと。
- R2 の別 issue 化判断は Master / ユーザーに 1 行確認（draft task 1 件起票で OK）。
- R5 の C5 test は実装と同じ PR で追加する想定（テスト無しの動作補強だけだと regression 検出不可）。

以上を反映後に再レビュー不要 — Recommendations の機械的反映で実装着手可能。
