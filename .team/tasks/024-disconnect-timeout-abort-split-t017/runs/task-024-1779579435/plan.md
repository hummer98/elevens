# Plan: T024 — spawn-agent の silent state mutation 解消

## 1. 背景と確定 root cause

直近 2 タスク（T021, T019）が連続で `disconnect_timeout` により abort し、同時間窓で空の split ペインが量産された。T017（spawn-agent の Agent 起動先が別 pane/split になる不具合, ea6dc57 で fix・merged）の再発が疑われた事象である。

事象は 2 系統に切り分けられる:

- **事象A** — Conductor が無言で死に `disconnect_timeout` で task が abort（compact 直後から崩れる）
- **事象B** — 空の split ペインが量産され、しかも `manager.log` に一切記録されない

### 1.1 findings 独立再確認の結果

Conductor から受け取った 3 つの findings を Planner として実機で再確認した。すべて裏付けられた。

| # | finding | 再確認方法 | 結果 |
|---|---------|------------|------|
| 1 | published v0.8.2 の `getPaneForSurface` は `line.includes(surface)` の **substring match バグ** | `/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/lib/node_modules/@hummer98/elevens/skills/cmux-team/manager/cmux.ts:271-286` を Read | **裏付け確認** — L279 `if (line.includes(surface) && currentPane) return currentPane;` を確認。`surface:11` を `surface:110/113/115/116` 含む行に誤マッチする |
| 2 | HEAD（worktree）の `getPaneForSurface` は完全一致照合に修正済み（T017 fix = ea6dc57） | `skills/cmux-team/manager/cmux.ts:298-310` を Read | **裏付け確認** — L305-307 で `line.match(/surface:\d+/g)` → `surfaceMatches.includes(surface)` に変更されていることを確認。コメントにも「部分一致 (`line.includes(surface)`) は禁止 — `surface:2` が `surface:26` を含む行に誤マッチして間違った pane を返すバグ (T017) を防ぐため」と明記 |
| 3 | HEAD の `cmdSpawnAgent` が targetPane 解決 / newSurface 生成を `log()` / `events.jsonl` に記録していない | `skills/cmux-team/manager/main.ts:3565-3625` および周辺 grep | **裏付け確認** — L3575 `getPaneForSurface` 直後 / L3589 `newSurface` 直後ともに `log()` 呼び出しなし。`postMessage(AGENT_SPAWNED)` 経由で daemon 側 (`daemon.ts:2027`) は `agent_spawned` を log するが、これは spawn 後の daemon 受信ログであり、spawn-agent CLI 側で「**どの pane を解決した／どの surface を作った**」を spawn 時点で残す決定論的 log は存在しない |

### 1.2 確定 root cause（observatory 観点での解釈）

- **事象B の物理原因**: 実機 PATH 上の elevens が published `@hummer98/elevens@0.8.2` である（git log 上 v0.8.2 release = 2a08770 は ea6dc57 より前なので T017 fix を含まない）。spawn-agent が conductor surface を解決する際に substring match で誤った pane を返し、その pane に split / new-surface を生やしている。
- **観察箱として真の欠陥**: 上記の物理原因が起きていた時、`manager.log` には何の手がかりも残らなかった。CLAUDE.md の「silent state mutation を作っていないか」「observer が pull で観測できるか」原則に反する。**現象は HEAD でも substrate 側（cmux tree 出力の食い違い、c11 への移行差分、別バグ等）で同種の誤解決が再発し得る**ため、コードでの観察可能性向上は HEAD でも必要。

## 2. 実装スコープ

### 2.1 主スコープ（in-scope）

cmdSpawnAgent が pane を解決し new-surface を作る過程の **生成イベントを `manager.log` に決定論的に記録する最小改修**。

これにより、将来同種の誤解決（あるいは substrate 側の問題による pane 解決ミス）が起きても `manager.log` の grep だけで「どの conductor から呼ばれ、どの workspace を caller として、どの pane に、どの surface を作った」を再構成できるようになる。

### 2.2 副スコープ（in-scope）

`cmux.test.ts` の `getPaneForSurface` prefix collision regression test の **網羅性確認**と、今回事象に対応する具体ケース追加の検討。

### 2.3 スコープ外（explicit out-of-scope）

| 項目 | スコープ外の理由 |
|------|------------------|
| published v0.8.2 の `getPaneForSurface` substring match 自体の再修正 | HEAD で T017 fix 済み。実機解消は **次回 release（publish + 再 install）**で完結する。コード変更は不要 |
| `events.jsonl` への agent spawn event 追加 | CLAUDE.md「minimal scope」原則。`docs/spec/10-events-stream.md` の現行 19 event に agent lifecycle は意図的に含まれていない（Task / Conductor / Artifact / Worktree / Daemon の 5 軸）。追加すると schema 拡張 + spec 更新 + reader 影響範囲が広がる。observatory 上の必要性は `manager.log` で十分賄える（事象B の根本欠陥は「ログがゼロ」であって「外向け event がない」ではない）。将来 watch mode で agent 異常を検知したくなったら別タスクで議論 |
| 事象A（`disconnect_timeout` / compact → Conductor 死） | 切り分け系統が異なる（spawn-agent ではなく Conductor 本体 / compact 経路）。§7 で follow-up task として提案する |

## 3. 具体的な変更箇所

> コードは書かず、追加位置・event 名・detail フィールドの方針のみ示す。

### 3.1 `skills/cmux-team/manager/main.ts`

#### 変更点 A: `getPaneForSurface` 解決結果のログ追加（`main.ts:3575` 直後）

| 項目 | 方針 |
|------|------|
| 位置 | L3575 `const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);` の **直後**、L3580 の `if (!targetPane)` チェックの **前** |
| event 名 | `spawn_agent_pane_resolved` |
| detail フォーマット | `${formatSurface(conductorSurface, "C")} target_pane=${targetPane ?? "(none)"} caller_workspace=${callerWorkspace ?? "(none)"} role=${role}` |
| 形式合わせ | `formatSurface(surface, "C")` は既存の Conductor 表記。同 file L3661 の `formatSurface(surface, "A")`（Agent 表記）パターンに揃える |
| 失敗時 (`targetPane === undefined`) | 既存の `throw new Error(...)` 経路に乗ったまま、catch ブロックの `spawn_agent_failed`（L3831）で記録される。新規 log を入れる必要なし（throw 前にすでに `target_pane=(none)` を出している） |

**理由**: pane 解決時点で何を target に選んだかを残せば、再発時に「誤った pane が選ばれた」ことを `manager.log` の grep だけで確認できる。

#### 変更点 B: `newSurface` 生成結果のログ追加（`main.ts:3589` 直後）

| 項目 | 方針 |
|------|------|
| 位置 | L3589 `createdSurface = await cmux.newSurface(targetPane, { workspace: callerWorkspace });` の **直後**、L3590 `const surface = createdSurface;` の前後どちらでも可（読みやすさで L3590 の直後を推奨） |
| event 名 | `spawn_agent_surface_created` |
| detail フォーマット | `${formatSurface(createdSurface, "A")} target_pane=${targetPane} conductor=${conductorSurface} role=${role} caller_workspace=${callerWorkspace ?? "(none)"}` |
| 失敗時 (`newSurface` throw) | catch ブロックの `spawn_agent_failed`（L3831）が `surface=${createdSurface ?? "(none)"}` を含むため独立 log 不要 |

**理由**: spawn-agent CLI 側で「どの pane に新 surface を生やしたか」を spawn 直後に確定的に残す。AGENT_SPAWNED message を `postMessage`（L3601）した瞬間の daemon 側 log（`daemon.ts:2027` の `agent_spawned`）と pair で読めば、CLI 側決定 → daemon 受信 の往復が再構成できる。

### 3.2 `skills/cmux-team/manager/main.ts` 以外

- **`cmux.ts`**: 変更なし（HEAD は T017 fix 済み、再修正不要）
- **`daemon.ts`**: 変更なし（daemon 側 `agent_spawned` log は既存で十分）
- **`events-writer.ts`**: 変更なし（events.jsonl はスコープ外）
- **`logger.ts`**: 変更なし（`log()` シグネチャ `(event: string, detail: string)` をそのまま使う）

## 4. events.jsonl / spec の扱い

### 4.1 events.jsonl: **触らない**

理由は §2.3 のとおり。`docs/spec/10-events-stream.md` §5 の event 軸は意図的に Task / Conductor / Artifact / Worktree / Daemon の lifecycle に絞られており、Agent lifecycle event を新設すると以下の影響が出る:

- spec §5.1〜5.5 への 5.6 章追加
- §6.20 以降の payload schema 定義
- `events-writer.ts` の writer 追加
- reader（CLI / Master watch mode）の影響範囲確認
- `schema_version` は additive なので bump 不要だが、合計 19 → 20 event は spec 改訂を伴う

CLAUDE.md「機能追加で Manager / FSM / dashboard 横断の機構化を膨らませず、read side 拡張で済むならそれを採る」に照らし、本タスクは `manager.log` 拡張のみで事象B の観察可能性ギャップを埋め切れるため、events.jsonl 拡張は意図的に見送る。

### 4.2 spec 更新: **不要**

`manager.log` の event 名・フォーマットは spec 化されていない自由フィールド（既存の `spawn_agent_throttled` / `spawn_agent_ratelimit_warn` / `spawn_agent_expand` / `spawn_agent_failed` も spec 文書化されていない）。本タスクで追加する `spawn_agent_pane_resolved` / `spawn_agent_surface_created` も同様に spec 不要。

## 5. テスト方針

### 5.1 `cmux.test.ts` — 現状確認の結果

| 既存テスト | 内容 | 評価 |
|------------|------|------|
| `cmux.test.ts:347-394` 「getPaneForSurface prefix collision (T017)」 | `surface:2` vs `surface:27` で完全一致のみ拾うことを 2 ケースで検証。L380 ケースは「1 行に複数 surface が同居」状況での完全一致確認 | **十分** — prefix collision のクラス問題はカバーされている |

実機事象（`surface:11` が `surface:110/113/115/116` を含む行に誤マッチ）は `surface:2` vs `surface:27` と論理的に等価な ケースなので **既存テストで十分カバーされている**。新規追加は不要。

ただし、回帰を追跡しやすくする目的で `surface:11` vs `surface:110` のケース（事象B を直接想起させる名前）を 1 件追加するのは妥当な余地。implementer 判断とする（**default はテスト追加なし**、追加するなら test 名に `T024 regression` を含める）。

### 5.2 `main.test.ts` — 新規 log のテスト

`cmdSpawnAgent` の新規 log 2 件をテストすると、cmux substrate のモック構造（`__setTreeImpl` 等）と `cmux.newSurface` のモック・`postMessage` のモックを多重に組む必要があり、テスト負債が大きい。

| 案 | 判断 |
|----|------|
| 新規 log を unit test で assert | **見送り** — `manager.log` 出力は副作用ログであり、機能テストの対象としての価値が薄い。テスト負債 > 検知価値 |
| log フォーマット文字列の sanity check（formatSurface 経由かどうか等） | 不要（既存パターンの踏襲のみ） |

→ **新規テスト追加なし**。observatory 強化目的の log は実機運用で観測される（次回 spawn-agent 時に `manager.log` を grep して確認）。

## 6. 検証方法（受け入れ条件）

### 6.1 必須

1. **HEAD で `cmux-team spawn-agent` を 1 回成功させ、`.team/logs/manager.log` に以下 2 行が並ぶこと**
    - `spawn_agent_pane_resolved` を含む行（target_pane / caller_workspace / role が detail に出ている）
    - `spawn_agent_surface_created` を含む行（新 surface ID / target_pane / conductor / role が detail に出ている）
2. **既存 test が壊れていないこと** — `bun test --timeout 30000 cmux.test.ts main.test.ts state-machine/*.test.ts` がグリーン（CLAUDE.md「`bun test` 全体実行は禁忌」に従い個別 file 指定）
3. **`spawn_agent_failed` 経路が壊れていないこと** — `targetPane === undefined` で意図的に throw させた時、catch の `spawn_agent_failed` log がこれまで通り出ること（新 log 2 件は throw 前 / throw に巻き込まれる位置にあるため、追加で `spawn_agent_pane_resolved target_pane=(none)` が出てから throw が走るのが期待動作）

### 6.2 任意（強化）

4. 実機解消のため、本 fix を含む patch release を行い（CLAUDE.md / リリーススキル参照）、ユーザー環境を再 install して `@hummer98/elevens` を新版に揃える。これは本タスクの直接的成果物ではないが、事象B を実機から消すには必要。

### 6.3 受け入れ条件まとめ

- [ ] §6.1-1: 新 log 2 件が想定フォーマットで `manager.log` に出る
- [ ] §6.1-2: 既存 test green
- [ ] §6.1-3: `spawn_agent_failed` 経路で挙動が後退していない

## 7. 事象A follow-up task 提案

### 7.1 事象A の切り分け仮説

事象A（`disconnect_timeout` abort）は spawn-agent split 問題とは別系統。観測されたパターンは以下:

1. Conductor が compact を起動
2. compact 中 / 直後に Conductor のセッションが無言で死ぬ（cmux pane は残っているが Claude プロセスが死んでいる、または PID 自体が死亡）
3. daemon の PID watcher / `SESSION_ENDED` で `disconnected` 状態に入る
4. `DISCONNECT_TIMEOUT_SEC`（300s）超過 → forced close → `task_aborted reason=disconnect_timeout`

仮説候補:

| # | 仮説 | 検証の取っかかり |
|---|------|------------------|
| H1 | compact が token pool / proxy 経由で何らかの 401 / rate limit を引き、Claude Code が落ちる | `manager.log` の `token_pool_*` event 周辺、`proxy.ts` の 4xx ログ、compact 直前後の `api_usage` 行 |
| H2 | compact が大量の context 圧縮を試みて Claude Code 内部で OOM / crash | Conductor pane の最終出力（Console / Crash 表示）、`.team/output/conductor-N/` の末尾、macOS 側 crash log (`~/Library/Logs/DiagnosticReports/`) |
| H3 | compact 中に Conductor が `notifyStateChanged` 経由で何らかの state mutation を起こし、daemon 側 handler 経路で session を意図せず disconnected 判定 | `manager.log` の `SESSION_ENDED` reason、`task-state.json` の journal、`hook_signals` の SessionEnd 行 |
| H4 | compact 経路が直前の T024 split バグの巻き添えで「実は別 pane に作られた Agent」が死亡し、その失敗イベントが Conductor の死亡として観測された（事象A・B が同一系統の二次症状） | T024 fix 後の再現性を確認。fix 後に消えれば H4、残れば H1〜H3 を順に検証 |

### 7.2 follow-up task 提案

| 項目 | 案 |
|------|-----|
| タイトル | `disconnect_timeout の compact 由来切り分け（事象A、T024 spillover）` |
| status | `draft`（T024 fix 後の実機観察で再発有無を見てから ready に上げる、CLAUDE.md「risk 小なら draft 保留せず delete、必要なら再起票」に従い再発しなければ delete も可） |
| body 必須項目 | (i) §7.1 仮説 H1〜H4 を載せる、(ii) 検証順序として「まず T024 fix を含む版で再現待ち（H4 検証）→ 出れば H1〜H3 を順に切り分け」を明記、(iii) trace DB の `api_usage` / `hook_signals` / `task_sessions` を起点にする調査路を示す |
| 関連 artifact | T024 完了時に `/elevens:artifact session` で本セッションの調査経緯を残し、follow-up task の body から参照する |
| risk | 小（観察強化中心、コード変更は H1〜H3 のいずれが当たるかで判断） |

### 7.3 本タスクで follow-up task を **作るかどうか**

CLAUDE.md「リスク小と評価された follow-up は draft 保留せず delete、必要なら 1 分で再起票」原則に照らすと、§7.2 の task は **「T024 fix 後に再現観察 → 出れば起票」とする方が望ましい**。理由:

- H4（T024 spillover 仮説）が当たれば fix だけで事象A も消える可能性がある
- 消えない場合のみ follow-up task を起票すれば足る
- 先行起票しても着手は再発観察待ちになり draft 滞留する

→ **implementer / Conductor は本タスクの完了処理時に「再現観察待ち」のメモを T024 close journal に残し、follow-up task の事前起票は行わない**。再発時は本 plan.md §7.1 を参照して新規 task を 1 分で起こす。
