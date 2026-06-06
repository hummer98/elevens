# Inspection: T024 — spawn-agent の silent state mutation 解消

## 総合判定: **GO**

plan.md §3.1 / design-review.md の指針に完全に整合した最小改修。`git diff` で main.ts 1 ファイル・17 行追加のみ。追加 log 2 件は位置・detail フォーマット・引数名・formatSurface role 文字・`log()` 呼び出しパターン（既存 `spawn_agent_failed` 等と揃った `await log("name", "detail")`）すべて plan / 実コードと一致。失敗経路は throw 前後の 2 行ペア設計 (`spawn_agent_pane_resolved target_pane=(none)` → catch の `spawn_agent_failed`) になっており、`newSurface` throw 時に `spawn_agent_surface_created` が誤って出ないことも構造的に保証されている。テスト 561 件全 pass・tsc 新規エラー 0 件・root cause 結論（published v0.8.2 の substring match バグ / HEAD は ea6dc57 で fix 済み / 実機解消は次回 release）も実コード差分（v0.8.2 L279 vs HEAD L298-310）と照合済みで論理的に妥当。

実装は merge 可。release で実機解消する従属タスクは plan §6.2 / impl-summary §未消化のとおり別タスクで処理。

## チェックリスト

### 1. 実装の正確性 ✅

`git diff skills/cmux-team/manager/main.ts` および worktree 実コード (`main.ts:3565-3610`) を Read して以下を確認:

| 項目 | plan / 既存規約 | 実装 | 結果 |
|---|---|---|---|
| `spawn_agent_pane_resolved` 位置 | `getPaneForSurface` 直後・`if (!targetPane)` の前 | L3577-3584（L3575 `const targetPane = ...` の直後、L3589 `if (!targetPane)` の前） | ✅ 完全一致 |
| `spawn_agent_surface_created` 位置 | `createdSurface = await cmux.newSurface(...)` 成功代入の後 | L3601-3607（L3598 `createdSurface = await cmux.newSurface(...)`、L3599 `const surface = createdSurface;` の直後） | ✅ 完全一致 |
| pane_resolved detail | `${formatSurface(conductorSurface, "C")} target_pane=${targetPane ?? "(none)"} caller_workspace=${callerWorkspace ?? "(none)"} role=${role}` | 同上、改行・順序まで完全一致 (L3583) | ✅ |
| surface_created detail | `${formatSurface(createdSurface, "A")} target_pane=${targetPane} conductor=${conductorSurface} role=${role} caller_workspace=${callerWorkspace ?? "(none)"}` | 同上、完全一致 (L3606) | ✅ |
| 引数名 | `conductorSurface` / `callerWorkspace` / `targetPane` / `createdSurface` / `role` | 全て実コードと同名 | ✅ |
| formatSurface role 文字 | Conductor=`"C"` / Agent=`"A"` | pane_resolved=`"C"` / surface_created=`"A"` | ✅ |
| `log()` 呼び出しパターン | 既存 `spawn_agent_failed` (L3848-3851) と同じ `await log("event", "detail")` | 両 log とも同形（multi-line も同じ書式） | ✅ |
| `formatSurface` import | `logger.ts:38` でエクスポート済み、main.ts L36 で import 済み | 既に呼び出し実績多数（L1641 / L3661 など） | ✅ |

### 2. 失敗経路の健全性 ✅

- **targetPane undefined のケース**: 変更点 A の log は L3589 `if (!targetPane) throw` よりも**前**に位置するため、`target_pane=(none)` を含む `spawn_agent_pane_resolved` が必ず先に出てから throw する → catch (L3848) の `spawn_agent_failed` (`surface=(none)` を含む) と並ぶ **2 行ペア設計**。pane 解決時点で「何を target に試みたか」が必ず残るため後続診断が可能。
- **newSurface throw のケース**: 変更点 B (L3601-3607) は L3598 `createdSurface = await cmux.newSurface(...)` の**成功代入後**に配置されているため、`newSurface` が throw した瞬間に制御が catch に飛び、`spawn_agent_surface_created` は出ない。代わりに catch の `spawn_agent_failed` が `surface=(none)` 付きで記録される。**誤って成功扱いの log が出る経路は存在しない**。
- **regression guard コメント**: L3577-3580 に「本 log を `if (!targetPane)` の後ろに動かすと target_pane=(none) のケースを残せなくなる」の 4 行コメントが入っており、design-review §「任意指摘 #2」採用済み。後続改修時の事故防止に効く。

### 3. スコープ遵守 ✅

`git diff --stat`:

```
 skills/cmux-team/manager/main.ts | 17 +++++++++++++++++
 1 file changed, 17 insertions(+)
```

- main.ts 1 ファイルのみ、純増 17 行（log 2 件 + コメント 7 行）。
- plan §2.3 / §3.2 / §4 のスコープ外項目（cmux.ts / daemon.ts / events-writer.ts / logger.ts / events.jsonl / `docs/spec/10-events-stream.md` / 新規テストファイル）への変更は一切なし。

### 4. テスト再実行 ✅

CLAUDE.md「`bun test` 全体実行は禁忌」に従い per-file で worktree 配下で再実行:

| テスト | 結果 |
|---|---|
| `cmux.test.ts` | **38 pass / 0 fail**（63 expect、6.03s） |
| `main.test.ts` | **273 pass / 0 fail**（748 expect、22.42s） |
| `state-machine/apply-task-actions.test.ts` | **15 pass / 0 fail**（48 expect） |
| `state-machine/fsm.test.ts` | **191 pass / 0 fail**（360 expect） |
| `state-machine/task-state-store.test.ts` | **44 pass / 0 fail**（120 expect） |
| **合計** | **561 pass / 0 fail / 1339 expect** |

impl-summary §テスト結果と完全一致。新規 unit test 追加が見送られた点も plan §5.2 判断（テスト負債 > 検知価値）と整合。

### 5. tsc 健全性 ✅

```
$ bunx tsc --noEmit -p skills/cmux-team/manager 2>&1 | grep main.ts
skills/cmux-team/manager/main.ts(1043,7): error TS2322: Type 'string' is not assignable to type 'boolean'.
```

- `main.ts(1043,7) TS2322` 1 件のみ。impl-summary §tsc が baseline (main repo) と比較済みで同じ既存エラー。
- 自分の変更（L3577-3584 / L3601-3607）に起因する新規エラーは 0 件。`log()` / `formatSurface` の戻り型と detail 文字列は型整合済み。

### 6. root cause 結論の妥当性 ✅

両 cmux.ts を Read して裏取り:

- **published v0.8.2** (`/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/lib/node_modules/@hummer98/elevens/skills/cmux-team/manager/cmux.ts:271-286`):
  - L279: `if (line.includes(surface) && currentPane) return currentPane;` ← **substring match 確認**。`surface:11` が `surface:110` / `surface:113` 等を含む行に誤マッチする物理経路あり。
- **HEAD (worktree)** (`skills/cmux-team/manager/cmux.ts:298-310`):
  - L305-307: `const surfaceMatches = line.match(/surface:\d+/g); ... if (surfaceMatches.includes(surface)) return currentPane;` ← **完全一致照合に修正済み**を確認。
  - L294 コメントに「部分一致 (`line.includes(surface)`) は禁止 — `surface:2` が `surface:26` を含む行に誤マッチして間違った pane を返すバグ (T017) を防ぐため」と明記。
- git log 上 `2a08770 chore: release v0.8.2` は `ea6dc57 fix(spawn-agent): pane lookup を完全一致化し undefined pane を fail-fast (T017)` より**前**のコミットなので、v0.8.2 tarball には T017 fix が**含まれていない**ことが構造的に保証される。

→ plan の結論「実機 v0.8.2 が substring バグ / HEAD は fix 済み / コード再修正不要・release で実機解消」は完全に妥当。本タスクで cmux.ts に手を入れる必要はない。

## minor 指摘（GO を覆さない任意改善）

implementer / Conductor / Master 判断で取捨選択可。いずれも本 PR 内で対応する必要なし。

1. **`spawn_agent_pane_resolved` 単独実機検証の従属タスク化**: impl-summary §「未消化」で実機 daemon 再起動が必要なため見送られた `manager.log` への新 log 2 行の grep 検証 (plan §6.1-1) は、次回 spawn-agent が自然に発生したタイミングで `grep -E "spawn_agent_pane_resolved|spawn_agent_surface_created" .team/logs/manager.log` を 1 回流すだけで足る。release 後の実機確認手順に組み込めば十分。

2. **release 起票路**: plan §6.2 の patch release（実機 elevens を v0.8.2 から最新化して事象B を実機から消す）は本タスクのスコープ外だが、close journal にメモを残すと事象A follow-up （H4 spillover 仮説の検証）と合わせて再現観察の出発点が一本化される。

3. **`role=${role}` 重複**: design-review §「任意指摘 #3」のとおり pane_resolved / surface_created の detail に同じ `role` が並ぶが、grep 時の context 確保のため**現案維持で問題ない**。後続で log 量が問題になったら surface_created 側を落とす余地があるが、現時点では優先度低。

4. **`conductor=${conductorSurface}` の表記**: surface_created の detail で `formatSurface(_, "C")` を通さず plain string `surface:NNN` を使っている（design-review §「任意指摘 #1」と整合、L1641 等の既存パターンと一致）。grep の視認性を上げたければ将来 `formatSurface` 経由に揃える余地はあるが、本 PR では既存統一性を優先しているため現案で適切。
