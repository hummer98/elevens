# Design Review: タブタイトル `[N] Claude Code` 上書き fix 計画

実施: 2026-05-24 / Reviewer: surface:28 (Conductor 28 / Design Reviewer)
worktree: `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000`
対象: [`./plan.md`](./plan.md) / 根拠調査: [`./findings.md`](./findings.md)

---

## 判定: **Approved**（条件付き — Recommendations §4 を実装に反映すること）

理由（先出し）:

- 計画の中核機構（SESSION_STARTED hook 駆動の counter-rename を Conductor/Agent/restart に横展開）は **既存 Master 経路（daemon.ts:2111-2121）の素直な拡張** であり、決定論的イベントに乗る点で CLAUDE.md 原則と整合する。
- レビュー観点 6 で最重要視された **「Agent が SESSION_STARTED を daemon に POST するか」** を実コード（`main.ts:2932` `generateAgentSettings` の SessionStart hook）で確認した結果、**確かに POST する**（後述 §2-C）。plan §2.2 の Agent 行（「△」）の前提は成立しており、本機構が Agent 経路にも適用可能。
- recap を本タスクの確実な scope から外す判断（plan §6.1）は findings §3 Q3 / §4 末尾の「再現できず writer 未特定」と整合し honest。observatory 原則に乗る follow-up 動線も示されている。
- 主な timing 依存（reserved 800ms delay）は **単発・限定スコープ** に閉じており、回避策（config 化／パラレル化）も R6/R1 で言及済。

ただし以下 4 点は実装着手前に plan/コードへ落とし込むこと（§4 Recommendations 詳述）:

1. Agent SESSION_STARTED hook の実在を plan §2.2 / §2.3 に明示引用
2. reserved 800ms delay の **並列化を §3 に明文化**（serial では N\*800ms 遅延）
3. Conductor 分岐への挿入行を一意に固定（"L2197 付近" を具体行で）
4. `assertTabTitle` を成功時にも 1 行 log（observatory 原則）

---

## 1. レビューで実際に読んだ実コード（plan 主張との照合）

| plan の主張 | 検証ファイル:行 | 照合結果 |
|---|---|---|
| Master 既存 counter-rename: `daemon.ts:2111-2122` | `skills/cmux-team/manager/daemon.ts:2111-2122` | ✓ 実在。`message.surface.replace("surface:", "")` → `cmux.renameTab(surface, "[N] Master")` + try/catch + error log の構造、plan 引用通り |
| Conductor SESSION_STARTED 分岐は counter-rename を持たない | `daemon.ts:2125-2284` | ✓ 該当ブロック全文を確認、`cmux.renameTab` の呼び出しは存在しない。`notifyStateChanged` (L2221) → `spawnPidWatcher` (L2222) → `spawnConductorMailboxWatcher` (L2226) → sessionId/task_session 更新 → log → shadow observe → break の順 |
| Agent SESSION_STARTED 分岐も counter-rename を持たない | `daemon.ts:2286-2321`（`agentMatched` ループ内） | ✓ `agent.pid = message.pid` / `agent.status = "running"` / `spawnAgentPidWatcher` / `notifyStateChanged` / log の流れのみ。renameTab 呼び出し無し |
| Conductor reserved の初回 rename: `conductor.ts:332` | `conductor.ts:320-339` | ✓ 実在。`newSplit` 直後に `conductors.set(...)` → `renameTab(surface, "[N] Conductor")` を同期で呼んでいる。delay 無し |
| restart 経路で `CMUX_NO_RENAME_TAB=1` 欠落: `main.ts:5610` | `main.ts:5610` | ✓ 欠落確認。`export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1\n` のみで `CMUX_NO_RENAME_TAB` 無し |
| `CMUX_NO_RENAME_TAB=1` 既存 export: `main.ts:3300 / 3388 / 3654` | `main.ts:3300` (cmdSpawnConductor) / `3388` (cmdLaunchMaster) / `3654` (cmdSpawnAgent exportVars) | ✓ いずれも実在 |
| Agent spawn 末尾の `renameTab`: `main.ts:3815` | `main.ts:3815` | ✓ 実在。`cmux.send(surface, claudeCmd + "\n")` (L3811) の **後** に `await cmux.renameTab(surface, "[N] Agent")` を呼ぶ |
| **観点 6: Agent の SessionStart hook が daemon に SESSION_STARTED を POST するか** | `main.ts:2932` (`generateAgentSettings` 内 `SessionStart` hook) | ✓ **POST する**。`bash -c 'INPUT="$(cat)"; printf %s "$INPUT" \| elevens send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID" 2>/dev/null \|\| true; ...'`（Master `main.ts:2796` / Conductor `main.ts:3068` と同一 pattern）。plan §2.2 の Agent 行（hook 駆動の再 assert「無し」）が指すのは「daemon 側の counter-rename ハンドラ不在」であり、hook 自体は存在する。本機構を入れれば確実に発火する |
| daemon Master 用テストパターン (`daemon.test.ts` 4369 付近 `renameTabSpy`) | `daemon.test.ts:4369` ほか | ✓ `spyOn(cmux, "renameTab").mockImplementation(...)` の pattern が複数箇所で確立（L4116, L4369, etc.）。同型で Conductor/Agent 用テストが書ける |
| Master spawn 時の初回 renameTab: `master.ts:124` | `master.ts:113-127` | ✓ 実在。`cmux.newSplit` (L113) → `cmux.send(buildLaunchCommand("elevens spawn-master"))` (L120) → `cmux.renameTab(surface, "[N] Master")` (L124)。surface 作成直後・claude 実 exec より前に rename を呼ぶため W-A (~570ms) に負ける可能性は plan §2.1 指摘通り |

**plan 引用にコードの嘘・行ズレ・追加位置の誤指定なし。**

---

## 2. 観点ごとの所見

### 2-A. 前提の正しさ（観点 1）

`findings.md` の 4 結論（W-A は c11 default ~570ms / source=explicit、W-B は using-cmux hook で elevens worktree では plugin disabled、CMUX_NO_RENAME_TAB は dead flag ではない、recap は再現できず）を plan §1 / §2.2 / §6 が正しく踏襲。CLAUDE_CODE_DISABLE_TERMINAL_TITLE を入れない理由（§6.3）も findings §3 Q5 と整合。**矛盾なし。**

### 2-B. 採用機構の妥当性（観点 2）

「Master が既にやっている `SESSION_STARTED` hook 受信時の counter-rename を、Conductor/Agent/restart に横展開する」は既存パターンの素直な拡張。daemon.ts:2111-2121 の構造（surface_num 抽出 → `renameTab` → try/catch → error log）をそのまま 3 経路に複製するだけで意味論が揃う。**追加位置が実コード上に確実に存在する**ことは §1 の表で確認済。

追加位置の細部については §4 Recommendations #3 で具体化を求める。

### 2-C. CLAUDE.md 原則との整合の批判的検証（観点 3）

#### last-write-wins の競争に該当しないという主張

plan §2.3 「W-A / W-B より因果的に後着する」の核心:

- **W-A (c11 default setter, surface 作成 +570ms)**: surface は claude 起動より **必ず先に** 存在する。kill+spawn / restart 経路では surface 再利用なので W-A は遠い過去に発火済。new spawn (cmdSpawnConductor / cmdSpawnAgent) でも、`exportVars` → `cd worktree` → `direnv allow` の合間に複数の `await sleep(500)` が挟まる（main.ts:3752-3760）ため、claude 起動時点で surface 経過時間は **数秒以上** で W-A は完了している。**この timing 因果は実コードから読み取れる**（claude 起動が surface 作成 < 570ms 以内に来る経路は normal 系統では存在しない）。
- **W-B (using-cmux SessionStart hook, claude 起動 +1s 程度)**: SessionStart hook は claude が起動して初めて発火する。elevens daemon の SESSION_STARTED ハンドラも同じ SessionStart hook を発火元とするので、W-B と daemon ハンドラは **同じ hook イベント** に乗る兄弟。並走するが、両者の to-the-wire 順序は OS スケジューラ次第で保証はない。ただし elevens 配下では W-B が project settings で disabled、Conductor/Agent では `CMUX_NO_RENAME_TAB=1` env で gated されるため **W-B は事実上発火しない**（findings §4・§6 / `main.ts:3654`）。

**結論**: 「因果的に後着」が成立するのは W-A について（surface 経過時間ベースで保証）。W-B については「並走 vs gate されて発火しない」の二重防衛で実用上問題ない。plan §2.3 のニュアンスはおおむね正しいが、`W-A と W-B で因果保証の根拠が異なる` ことは plan 上には明記されていない（暗黙）。**重大な穴ではない**が、後任が「W-B との順序も因果保証されている」と誤読しないよう、§4 Recommendations #5 で文言追加を提案する。

#### reserved Conductor の 800ms delay

唯一の「surface 経過 < 570ms で renameTab を呼ぶ」経路。findings §2.1 実測 570ms にマージン 230ms を載せた 800ms は妥当範囲。**より決定論的な代替は実在しない**（reserved は claude 未起動 → SESSION_STARTED は来ない、Phase 1 で再確認済）。

ただし R6（serial loop で N\*800ms 遅延）は plan §3 の実装定義には落ちておらず Risk 欄にしか書かれていない。conductor.ts:302 の for ループは `await` を持つ serial 経路なので、`sleep(800)` を素朴に入れると N=5 で 4s 遅延する。**§4 Recommendations #2 で plan §3 に並列化方針を書き込むよう求める**。

### 2-D. スコープの妥当性（観点 4）

タスクタイトルは「recap で上書きされる問題」だが、Phase 1 findings で recap writer は再現できず未特定。plan §6.1 はこの不一致を honest に切り分け、

1. 本 fix は W-A `[N] Claude Code` 上書きの確実な阻止に限定
2. recap が SessionStart 経路で来るタイプならば副次的にカバー
3. recap 再現は別 follow-up（observability で `title_reassert` 出現頻度を monitor）

としている。**observatory 原則に沿った筋道**で、unverified を verified として扱わない姿勢は適切。

ただし「W-A 上書き阻止 だけで本タスクを closed にしてよいか」の問いには、plan は「scope を切り直したので closed 可」と暗黙に答えているのみで明示的な合意点が無い。**§4 Recommendations #6 で commit/PR description に明示するよう求める**（recap は別 follow-up、本タスクは W-A scope に縮約と宣言）。これは hard block ではないがユーザー視点との乖離を防ぐ。

### 2-E. テスト計画の実効性（観点 5）

- **T1 (cmux.assertTabTitle)**: 単純な wrapper の unit test。実装可能。
- **T2 (Conductor SESSION_STARTED counter-rename)**: `daemon.test.ts:4369` の `renameTabSpy = spyOn(cmux, "renameTab").mockImplementation(...)` パターンを流用可能。conductor state を pre-populate して `handleMessage({type:"SESSION_STARTED",...})` を呼ぶ pattern は既存 T203/T407 テスト群 (`daemon.test.ts:1067-1270`) で実証済。`broken` 状態で呼ばれないことの検証は L2131-2134 の早期 break をテストすれば良い。**実装可能。**
- **T3 (Agent SESSION_STARTED counter-rename)**: T2 と同形で Agent 用。`daemon.test.ts:1030-1064` に既存 "Agent SESSION_STARTED (T195)" describe ブロックがあるので追加箇所が明確。**実装可能。**
- **T4 (conductor.ts reserved delay)**: 現状 `conductor.test.ts` は renameTab spy を持たない（grep 0 件）。新規 describe ブロックを起こす必要がある。bun:test は fake timers (Jest 互換) を持たないため **実時刻で測る** ことになり、テスト 1 本あたり ~1s かかる。**実装可能だが速度コスト** あり。`Date.now()` ベースの始点記録 → end - start >= 800 を assert する形なら安定する。
- **T5 (restart 経路 env)**: 既存 restart テストパターンが daemon.test.ts に複数あるので `send` spy で `CMUX_NO_RENAME_TAB=1` 包含を assert。**実装可能。**

**4.3 既存テスト非破壊** の主張も妥当: `assertTabTitle` は内部で `renameTab` を呼ぶラッパなので既存 spy (`stubs.renameTab` / `renameTabSpy`) はそのまま動く。等価性は保たれる。

### 2-F. 見落とし（観点 6）

#### Agent の SESSION_STARTED hook の実在

**実コードで確認: 存在する**（`main.ts:2932` generateAgentSettings の SessionStart hook が `elevens send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID"` を POST）。plan §2.2 表の Agent 行「無し (hook 駆動再 assert)」は **daemon 側のハンドラが counter-rename を持たない** という意味で、hook 自体は実在。**重大な見落としではない。**

ただし plan §2.2 の表現が `△ (claude 起動 send より後なので W-A はもう発火済の可能性が高いが順序依存)` と書かれており、これは Agent 経路の `main.ts:3815` の直接 renameTab について W-A 防御を論じたもの。本機構（SESSION_STARTED 駆動 counter-rename）が入れば、W-A 防御の主軸が SESSION_STARTED ハンドラに移り、Agent の直接 renameTab (L3815) は冗長な初回 assert になる（plan §3 で `assertTabTitle` 置換すると明示）。**設計の整合性は保たれている。**

#### restart 経路の修正が他の export と整合するか

L5610 で `CMUX_CLAUDE_HOOKS_DISABLED=1` のみ → `CMUX_NO_RENAME_TAB=1` も追加。これは L3300 (cmdSpawnConductor) / L3388 (cmdLaunchMaster) / L3654 (cmdSpawnAgent) の確立 pattern と一致するため整合。**問題なし。**

#### 確認できなかった事項（リスク残）

- W-B が plugin disabled 環境で確実に発火しないことは findings §4 で確認済だが、**plugin 設定がうっかり enable に戻った場合** の脆弱性は plan が二重防衛（hook 駆動 counter-rename も走る）で吸収するとしている。これは合理。
- `assertTabTitle` を呼ぶ位置を Master 既存 L2113-2121 と同型にする際、Master では `persistMasterFile` の **後** に renameTab を呼ぶが、Conductor では `task_session update` (L2228-2261) との位置関係を決める必要がある。**§4 Recommendations #3 で具体化**。

---

## 3. CLAUDE.md state-tracking 原則チェック

plan が観察箱原則を阻害していないか確認:

| 確認項目 | 評価 |
|---|---|
| **state を外部化しているか** | ✓ counter-rename は state を持たない（一回呼んで終わる関数）。daemon が message を受けてから rename するので状態は daemon の conductor map に集約 |
| **silent state mutation を作っていないか** | ✓ rename ログは `title_reassert` で残す（plan §2.3 / §3）。observatory で観測可能 |
| **observer が pull で観測できるか** | ✓ trace DB の log 行を集計すれば「上書きが起きた / 戻した」の頻度が pull で取れる |
| **statefulness を排除できないか** | ✓ reserved 800ms delay は単発の `await sleep`、retry loop や watcher を持たない |
| **observatory を阻害しないか（CLAUDE.md §観察箱）** | ✓ むしろ `title_reassert` ログを増やすことで observation が深まる |

**問題なし。** むしろ Recommendation #4（成功時にも log）で observatory を強化する余地がある。

---

## 4. Recommendations（Planner / Implementer への申し送り）

### 4.1 Plan 文面の補強（着手前）

#### Rec #1（必須・observation 6 関連）: Agent の SessionStart hook の実在を plan に明示引用

plan §2.2 表の Agent 行 / §2.3 / §3 のいずれかで、`main.ts:2932`（`generateAgentSettings` の SessionStart hook が `elevens send SESSION_STARTED` を POST）を **コード引用 1 行** で明示する。後任 Reviewer / 将来の改修者が「Agent も hook で来るのか？」を再調査せずに済む。

#### Rec #2（必須・R6 関連）: reserved 800ms delay の並列化を §3 に明文化

現状 plan §3 の `conductor.ts:L320-339` 行は「delay を入れる」だけで serial/parallel を指定していない。conductor.ts:302 は `for (const [i, surface] of panes.entries())` の serial loop で、内部に `await` を含むため、素朴に `await sleep(800)` を入れると N=5 で 4s 遅延する。

§3 を以下のように改める:

> reserved 分岐の delay は **panes を Promise.all で並列処理** し、各 pane の delay を独立に走らせる。具体的には reserved の `renameTab` を `(async () => { await sleep(reservedRenameDelayMs); await assertTabTitle(surface, ..., "conductor reserved"); })()` で wrap し、loop 全体は collected promises を `await Promise.all(...)` で待つ。pane 数によらず合計遅延は 800ms に収束する。

合わせて R6 を「対策済」マークし、Risk から「実装で並列化したため遅延は 800ms 一定」に縮約する。

#### Rec #3（必須）: Conductor 分岐の挿入行を一意に固定

plan §3 「L2197 付近 (Conductor `SESSION_STARTED` 分岐, `notifyStateChanged` 直後 or `spawnPidWatcher` 直後)」は曖昧。Master 既存 (L2111-2121) は `notifyStateChanged` → `spawnMasterPidWatcher` → `persistMasterFile` の **後** に renameTab を呼ぶので、Conductor でも対称に **L2226 `spawnConductorMailboxWatcher` の直後（task_session 更新ブロックの前）** に挿入することを推奨。理由:

- Master 既存パターンとの構造的対称性（state 更新と PID watcher 起動が終わってから rename）
- task_session update (L2228-2261) は別責務（trace 用）なので rename と前後しても意味論は変わらないが、rename を先に置く方が「UI 反映 → 内部 indexing」の自然な順序

Agent 分岐については L2313 `notifyStateChanged("daemon.ts:handleMessage:session-started-agent")` の **直後** に挿入し、L2314 の log の前に持ってくる。

#### Rec #4（強く推奨・observatory 関連）: `assertTabTitle` を成功時にも 1 行 log

plan §3 では `assertTabTitle` の log を **失敗時のみ**（catch 内）に限定している。observatory 原則上、「counter-rename が走った頻度」を pull 観測したいので、成功時にも 1 行:

```ts
await log("title_reassert", `surface=${surface} title="${title}" context=${contextForLog}`);
```

を出すよう変更する。これにより `.team/logs/manager.log` を `grep title_reassert` するだけで「W-A / W-B 上書きが何回起きて何回戻したか」が見える。recap follow-up（plan §6.1）の monitoring 動線そのもの。

**注**: ログ量増は 1 spawn あたり 1-3 行（Master/Conductor/Agent それぞれ 1 回）程度で trace DB を圧迫しない。

#### Rec #5（推奨）: §2.3 の「因果保証」記述を W-A / W-B で別建てに

現状の §2.3 「W-A / W-B の発火順序に対し因果関係を持って後着する」は両者を一括りに語っているが、実際は:

- **W-A**: surface 経過時間ベースで因果保証（claude 起動時に W-A はほぼ完了）
- **W-B**: SessionStart hook イベント共有（並走 + 二重防衛）

の二段建て。plan §2.3 を 2 文に分けて書き直すと、後任の誤読を防げる。

#### Rec #6（推奨）: scope 縮約を commit / PR description に明示

タスクタイトル「surface-recap-writer-t019」「recap で上書きされる問題」とのギャップを、commit message および PR description で:

> findings §3 Q3 / §4 末尾で recap writer は本フェーズ再現不可と判明したため、本 PR は W-A による `[N] Claude Code` 上書き阻止に scope を限定する。recap は別 follow-up タスクで再現実験 → writer 特定 → 必要に応じ本機構の拡張を行う（observatory `title_reassert` ログで再発監視）。

の旨を明記する。task closing artifact (A027) にも同じ宣言を残す。

### 4.2 実装中に注意すべき点

#### Rec #7: T4 テストの実時刻依存を許容

bun:test は Jest 互換の fake timers を持たないため、T4 (reserved delay 検証) は実時刻 800ms 待ちが入る。`bun test --timeout 30000 conductor.test.ts` の全体時間は 1-2s 増加する想定。CLAUDE.md「`bun test` 全体実行は禁忌」は依然守られる（per-file ループは影響を受けない）。

#### Rec #8: `reservedRenameDelayMs` の config 化（R1 対策）

R1 で言及されている `config.json.cmux.reservedRenameDelayMs` での override 化は **本 PR で同時に入れる** ことを推奨。理由:

- 後から足すと「default 800 で困っているのか / config 化していないせいで困っているのか」の切り分けに調査工数がかかる
- 追加コストは数行（`loadConfig` から読み出すだけ、未設定なら default 800）

#### Rec #9: `assertTabTitle` の Master 既存箇所置換は **同一 PR で別 commit に分割**

plan §4.2 の実装順序 2 (Master 既存 → assertTabTitle 置換) は equivalence 変更（無機能）。Conductor/Agent 新規追加の commit (3,4) とは趣旨が異なるので、commit を分けて bisect 可能性を保つ:

- commit 1: `cmux.assertTabTitle` 追加 + T1 テスト
- commit 2: Master 既存箇所を `assertTabTitle` に置換（リファクタ・既存テスト緑のまま）
- commit 3: Conductor SESSION_STARTED 分岐に counter-rename 追加 + T2 テスト
- commit 4: Agent SESSION_STARTED 分岐に counter-rename 追加 + T3 テスト
- commit 5: conductor.ts reserved 分岐に並列化 delay 追加 + `reservedRenameDelayMs` config + T4 テスト
- commit 6: main.ts restart 経路 `CMUX_NO_RENAME_TAB=1` 追加 + T5 テスト + 各所 export 部にコメント

---

## 5. Implementer が必ず確認すべき注意点

1. **plan §3 の行番号は確認時点（2026-05-24）のもの**。実装着手時に他 PR が merge されて行ズレしている可能性があるため、各 commit 着手前に該当箇所を必ず再確認（特に daemon.ts は他タスクでの編集頻度が高い）。
2. **conductor.ts reserved 分岐の delay 並列化** は Recommendation #2 の通り Promise.all で全 pane 同時開始。serial で 1 つずつ delay する実装にしないこと（N\*800ms 遅延になる）。
3. **`assertTabTitle` の成功時 log** (Rec #4) は必須。trace DB / `grep title_reassert .team/logs/manager.log` で recap follow-up の monitoring が成立する前提。
4. **daemon.ts への挿入位置** (Rec #3) は Master 既存 L2111-2121 と対称的に。renameTab の前後で他の state mutation を挟まない（race を入れない）。
5. **restart 経路の `CMUX_NO_RENAME_TAB=1` 追加** は env 文字列に単純に追記するだけだが、`export A=1 B=2 C=3\n` の token 区切りを破壊しないこと（typo `CMUX_NO_RENAME_TAB =1` でも shell は通すが意味が変わる）。
6. **5. 実 spawn 検証手順** は実装後に Inspector が必ず実行（plan §5 のスクリプトをそのまま使える）。結果は A027 artifact に保存し、本タスク close 時に参照。
7. **既存 plugin 設定の確認**: `/Users/yamamoto/git/elevens/.claude/settings.json` の `enabledPlugins."using-cmux@hummer98-using-cmux"` が `false` のままであることを実装後にも再確認（誰かが true に戻すと W-B が再活性化するが、本機構の二重防衛で吸収される想定 — ただし `title_reassert` ログが増えるので observatory で検知可能）。

---

## 6. まとめ

| 項目 | 評価 |
|---|---|
| 前提（findings との整合） | ✓ |
| 機構の妥当性（既存 Master パターン拡張） | ✓ |
| CLAUDE.md 原則整合（決定論 / 責務分離 / 安全構造 / observatory） | ✓（W-A 因果保証は強、W-B 順序保証は二重防衛で吸収） |
| timing 依存スコープ | ✓（reserved 800ms のみ、R6 対策あり） |
| scope 切り（recap follow-up） | ✓（honest、observatory 動線あり） |
| テスト計画実効性 | ✓（既存 spy パターン流用可、T4 のみ実時刻コスト） |
| 観点 6（Agent SESSION_STARTED 経路） | ✓ 実コードで確認済（`main.ts:2932`） |

**判定再掲: Approved。** Recommendations #1-#9 を plan / 実装に反映してから着手すること。Recommendations #1-#3 は plan 文面の補強として **着手前に plan.md を更新**、#4-#9 は実装中に作り込む。
