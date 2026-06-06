# Design Review: T024 — spawn-agent の silent state mutation 解消

## 総合判定: **Approved**

minimal scope の判断は CLAUDE.md「機能追加で Manager / FSM / dashboard 横断の機構化を膨らませず、read side 拡張で済むならそれを採る」「silent state mutation を作らない / observer が pull で観測できる」原則と整合する。`file:line` の指定は HEAD（worktree）の実機実装と一致し、提案 event 名 / detail フォーマットは既存 `spawn_agent_*` log 群と命名・主語整形（`formatSurface(_, "C"|"A")`）の規約に揃っている。事象A は follow-up 事前起票せず close journal にメモを残す方針も memory `feedback_task_cleanup_over_draft_hoarding` と整合する。

下記の任意指摘（nice-to-have）を実装時の判断材料として残すが、Approved の前提を覆すものではない。

## 観点別評価

### 1. スコープの妥当性 ✅

- **minimal scope 判断**: published v0.8.2 への再修正なし / events.jsonl 拡張なし / spec 更新なし / 新規 unit test なし — すべて CLAUDE.md「read side 拡張で済むならそれを採る」原則に整合。observatory ギャップを埋める primary source は `manager.log`（grep 可能・retrospective 観察の一次媒体）であり、`docs/spec/10-events-stream.md` §5 が意図的に Agent lifecycle を含まない現状を尊重しつつ、watch mode 用の event 拡張は将来別タスクに分離するという判断は妥当。
- **観察可能性ギャップを `manager.log` だけで埋め切れるか**: 事象B の根本欠陥は「pane 解決・surface 生成のタイミングで決定論的 log がゼロ」であり、これは log() 追加 2 件で完全に埋まる。`daemon.ts:2027` 側 `agent_spawned` log と pair で読めば「CLI 側決定 → daemon 受信」の往復が再構成可能、という plan §3.1 変更点 B の説明は実機経路と一致している（main.ts L3601 `postMessage({type:"AGENT_SPAWNED", ...})` の直前に新規 log が並ぶ）。
- **副次的にも妥当**: 「published v0.8.2 の substring match は HEAD で T017 fix 済み (ea6dc57)。実機解消は次回 release で完結」というスコープ切り分けは git log・cmux.ts 実機差分（L298-310 完全一致照合 / L271-286 substring match）と一致。

### 2. 変更箇所の正確性 ✅

worktree 実機 `skills/cmux-team/manager/main.ts` を Read して file:line を検証した:

| plan 記述 | 実機 | 結果 |
|-----------|------|------|
| L3575 `const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);` | L3575 同一行 | ✅ 完全一致 |
| L3580 `if (!targetPane)` チェック | L3580-3585 throw 経路 | ✅ 一致（変更点 A の挿入位置 L3575 直後・L3580 の前と整合） |
| L3589 `createdSurface = await cmux.newSurface(targetPane, { workspace: callerWorkspace });` | L3589 同一行 | ✅ 完全一致 |
| L3590 `const surface = createdSurface;` | L3590 同一行 | ✅ 完全一致（変更点 B の挿入位置として妥当） |
| L3831 catch `spawn_agent_failed` log | L3831-3834 (`event="spawn_agent_failed"`, detail に `surface=${createdSurface ?? "(none)"}` 含む) | ✅ 完全一致 |

引数名（`conductorSurface` / `callerWorkspace` / `targetPane` / `createdSurface` / `role`）も実機関数シグネチャと plan 記述で同名。formatSurface の使い分け（Conductor=`"C"` / Agent=`"A"` / Master=`"M"|"U"`）も `logger.ts:38` および main.ts 内既存呼び出し 13 箇所と整合。

### 3. ログ設計の整合 ✅

- **event 名**: 既存 `spawn_agent_throttled` / `spawn_agent_ratelimit_warn` / `spawn_agent_expand` / `spawn_agent_expand_failed` / `spawn_agent_failed` と同じ `spawn_agent_<verb>` 命名規則に従う。`spawn_agent_pane_resolved` / `spawn_agent_surface_created` は state transition の動詞表現として一貫している。
- **主語整形**: `formatSurface(conductorSurface, "C")`（変更点 A）/ `formatSurface(createdSurface, "A")`（変更点 B）は L3661 `formatSurface(surface, "A")`（token pool 文脈で agent surface を主語に置く既存パターン）、および L1641 `${formatSurface(r.surface, "C")} task_id=${r.taskId}`（主語のみ formatSurface、参照は plain string）と整合。
- **失敗時の二重記録 / 漏れ**:
  - `targetPane === undefined`: 変更点 A の log は L3580 の `if (!targetPane) throw` よりも前に位置するため `target_pane=(none)` を含む `spawn_agent_pane_resolved` が必ず出る → throw → catch の `spawn_agent_failed` が続く。**2 行ペアで読める設計**で記録漏れ・冗長重複なし。
  - `newSurface` throw: 変更点 B は newSurface 成功代入直後に置かれるため throw 時は新規 log は出ず、catch の `spawn_agent_failed` が `surface=(none)` 付きで記録する。これも plan §3.1 変更点 B の「失敗時 catch 側で記録、独立 log 不要」と整合。

### 4. テスト方針 ✅

- **prefix collision 既存テスト**: `cmux.test.ts:347-394` を Read。3 ケースで surface:2 vs surface:26/27、同居行 surface:99/31 の完全一致照合をカバーしており、実機事象（surface:11 vs surface:110/113/115/116）は論理的に同クラス。「新規追加は不要、追加する場合は test 名に `T024 regression` を含める」という判断は CLAUDE.md「既存の動作を壊さない」「最適化は優先度低」と整合。
- **新規 log の unit test 見送り**: `cmdSpawnAgent` を unit test しようとすると cmux substrate / postMessage / token pool / trace DB の多重モックが必要で、テスト負債が大きい一方で副作用 log の機能的価値は実機 grep で十分検証可能。判断は妥当。
- **受け入れ条件 §6.1-2 で `bun test --timeout 30000 cmux.test.ts main.test.ts state-machine/*.test.ts` を個別 file 指定で回す方針**: CLAUDE.md「`bun test` 全体実行は禁忌（O(N²) 級劣化）」と整合。

### 5. 事象A の扱い ✅

- **事前起票せず close journal にメモを残す判断**: memory `feedback_task_cleanup_over_draft_hoarding`（「リスク小と評価された follow-up は draft 保留せず delete、必要なら 1 分で再起票」）と整合。
- **H4（T024 spillover）仮説**: 事象A・B が同一系統の二次症状であり T024 fix で消える可能性を最初に検証順序に置いているのは効率的。fix 後に再現しなければ draft 起票自体が不要になる。
- **再発時の起票路**: 「再発時は本 plan.md §7.1 を参照して新規 task を 1 分で起こす」「`/elevens:artifact session` で本セッションの調査経緯を残し follow-up task の body から参照する」という追跡経路が plan に明記されており、情報のサルベージ性は保たれる。

## 任意指摘（nice-to-have、Approved を覆さない）

implementer 判断で取捨選択してよい:

1. **変更点 B の `conductor=` 表記の一貫性**: plan §3.1 変更点 B では `conductor=${conductorSurface}`（plain string）を提案している。同じ surface を主語化する場合は formatSurface を通すが、参照位置では plain string で書く既存パターン（L1641 等）と整合するため**現案のままで一貫している**。ただし detail を grep でスキャンするとき視覚的に C/A が混在する文字列を作ると読みやすくなる余地はある。`conductor=${formatSurface(conductorSurface, "C")}` に揃えるかは可読性志向の好みで判断してよい（既存統一性を崩すまでではない）。

2. **変更点 A で `target_pane=(none)` が `spawn_agent_failed` と 2 行並ぶ点**: 意図設計（plan §3.1 変更点 A 「失敗時 (targetPane === undefined)」で明記済み）だが、コード側コメントでも「pane lookup 失敗時は本 log → throw → catch の `spawn_agent_failed` の 2 行ペアになる」を 1 行コメントで残しておくと、後続改修で本 log を `if (!targetPane)` の後ろに動かしてしまう regression を防げる（コードの自己説明性）。

3. **`spawn_agent_pane_resolved` の `role=${role}` 重複**: 変更点 A・B 双方の detail に `role` が入る。spawn 1 回に対し 2 行に同 role が並ぶ冗長性はあるが、各行が単独で grep されたとき context が立つ利点の方が大きいため**現案維持で問題ない**（任意指摘の中でも優先度低）。

4. **`/elevens:artifact session` の参照タイミング**: plan §7.2 末尾で「T024 完了時に `/elevens:artifact session` で本セッションの調査経緯を残す」とあるが、これは Conductor / Master の close 経路に依存する。Conductor 側 close journal にも「artifact 化済み / 未済」を 1 行残すと、follow-up 再起票時の trace 経路が短くなる（implementer 主導の作業ではないので任意）。
