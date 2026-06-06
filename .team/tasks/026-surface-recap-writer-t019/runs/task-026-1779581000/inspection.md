# Inspection: タブタイトル `[N] Claude Code` 上書き fix の検品（T026）

## 総合判定: **GO**

実施: 2026-05-24 / Inspector: surface:28 (Conductor 28 / Inspector Agent)
worktree: `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000`
対象: plan.md / design-review.md / findings.md の Recommendations #1-#9 + 実装タスク 1-8

理由（先出し）:

- design-review Recommendations **#1-#8 すべて反映**を git diff / Read で確認（#9 は Conductor 担当の commit 分割項目で本検品の対象外）。
- 実装タスク **1-8 すべて反映**を確認。挿入位置・並列化・config 化・コメントすべて plan 通り。
- per-file テスト 6 本すべて **0 fail**（cmux / conductor / daemon / main / master / config）。新規 T1/T2/T3/T4/T5 が assertion を持つ実テスト（空振り無し）。
- tsc 新規エラー **0 件**。既存 8 件はすべて untouched ファイル（c11-features / mailbox-cli / main.ts:1043）で、本 PR の touched 変更行（main.ts:3300/3389/3656/3817/3823/5618-5625 など）と無関係を確認。
- 構造的妥当性: 空 catch なし / logger→eventBus import なし / assertTabTitle 失敗が main 制御を止めない設計。observatory ログ (`title_reassert` / `title_reassert_failed`) を成功・失敗両方で残す。
- 実 spawn 検証（F）は安全性制約により省略（後述）。判定根拠は A-E の静的 + unit test 検証で十分。

---

## A. design-review Recommendations #1-#9 反映チェック

| Rec | 内容 | 反映 | 根拠 (file:line) |
|---|---|---|---|
| **#1** | Agent SessionStart hook (main.ts:2932 `generateAgentSettings`) の引用を plan / 実装コメントに明示 | ✓ | `skills/cmux-team/manager/daemon.ts:2319-2321` Agent 分岐コメントに「`generateAgentSettings` の SessionStart hook 経由で daemon に SESSION_STARTED を POST する（main.ts:2932 付近、Master/Conductor と同 pattern）」と明示引用 |
| **#2** | reserved 800ms delay の **Promise.all 並列化** | ✓ | `conductor.ts:303-304, 332-345, 354-356` で `reservedDelayedRenames: Promise<void>[]` を作成し各 pane の delay を独立 IIFE で push、ループ後 `Promise.all` で一括 await。N pane でも合計遅延は delayMs 1 回分に収束 |
| **#3** | Conductor は `spawnConductorMailboxWatcher` 直後 / Agent は `notifyStateChanged(session-started-agent)` 直後に挿入 | ✓ | `daemon.ts:2223` (mailboxWatcher 起動) → `daemon.ts:2225-2231` (counter-rename) → `daemon.ts:2233-` (task_session update)。Agent も `daemon.ts:2318` (notifyStateChanged) → `daemon.ts:2319-2325` (counter-rename) → `daemon.ts:2326-` (log)。指示位置と一致 |
| **#4** | `assertTabTitle` を **成功時にも** `title_reassert` log | ✓ | `cmux.ts:251-254` で `try` 内で `log("title_reassert", ...)` を成功時に出力。失敗時は `cmux.ts:256-259` で `title_reassert_failed` を error log として残す。`cmux.test.ts:476-487, 491-503` で success/failure 両方を assert |
| **#5** | W-A / W-B の区別をコメントに反映 | ✓ | `cmux.ts:235-237` で「W-A (c11 default title setter) や W-B (using-cmux SessionStart hook)」を区別記載、`daemon.ts:2225-2227` でも「W-A, ~570ms 後 / W-B」両方を明示 |
| **#6** | recap 抑止を実装に勝手に入れていないか | ✓ | git diff 全体に recap 関連の変更なし。scope が W-A `[N] Claude Code` 上書き阻止に限定されている（commit/PR 説明は Conductor 担当のため判定対象外） |
| **#7** | T4 が fake timer 不使用で実時刻依存テストか | ✓ | `conductor.test.ts:529-585` で `Date.now()` ベースの実時刻測定（`start = Date.now()` / `Date.now() - start`）。fake timer は使われていない。テスト config で delayMs=200ms に短縮して 6.57s で完了 |
| **#8** | `reservedRenameDelayMs` の config 化（config.ts、default 800ms） | ✓ | `config.ts:121-130` `CmuxConfig` interface + `config.ts:140-149` `resolveReservedRenameDelayMs` を実装。default 800、clamp [0, 60_000]、非数値 / 範囲外は default に fallback。`conductor.ts:17, 303` で実呼び出し |
| **#9** | commit 分割（Conductor 担当） | 対象外 | Inspector の判定範囲外。実装の品質には影響なし |

**A 判定: 全 Rec 反映済（#9 は Conductor 担当のため対象外）**

---

## B. 実装タスク 1-8 網羅性

| # | タスク | 反映 | 根拠 |
|---|---|---|---|
| **1** | cmux.ts `assertTabTitle`（成功 log + 失敗時 error log で例外抑止 + contextForLog） | ✓ | `cmux.ts:245-261` 実装。`title_reassert` (success) / `title_reassert_failed` (failure) を `contextForLog` 付きで出力 |
| **2** | daemon.ts Master を `assertTabTitle` 化（等価変更） | ✓ | `daemon.ts:2111-2117` で旧 try/catch + renameTab → `assertTabTitle(message.surface, "[N] Master", "master session_started")` に置換。既存 spy テスト (master 用) は内部で `renameTab` を経由するため通過 |
| **3** | daemon.ts Conductor counter-rename、`broken` 早期 break で呼ばれない | ✓ | `daemon.ts:2225-2231` で counter-rename 追加。`daemon.ts:2128-2131` の `if (conductor.status === "broken") { ... break; }` により broken 経路では到達しない。`daemon.test.ts:1118-1188` の T2 が `reserved/disconnected/assigning/broken` 4 状態すべてを検証 |
| **4** | daemon.ts Agent counter-rename | ✓ | `daemon.ts:2319-2325` で counter-rename 追加。`daemon.test.ts:1067-1110` の T3 が `assertTabTitle` の `(surface, "[N] Agent", "agent session_started")` 引数 + 1 回呼び出しを assert |
| **5** | conductor.ts reserved 遅延 re-rename + 並列 + config | ✓ | `conductor.ts:299-356` 実装。`resolveReservedRenameDelayMs(await loadConfig(projectRoot))` で config 読み込み、各 pane の delay 付き re-rename を IIFE で `reservedDelayedRenames` に push、ループ後 `Promise.all` で一括 await。`conductor.test.ts:514-585` (T4) + `conductor.test.ts:587-622` (Rec #2 並列化検証) の 2 テストが時間特性を assert |
| **6** | main.ts:5618 付近 restart に `CMUX_NO_RENAME_TAB=1` 追加（token 区切り破壊なし） | ✓ | `main.ts:5618-5625` で旧 `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1` → `... CMUX_NO_RENAME_TAB=1` 追加。空白 1 個区切りで token 破壊なし。`main.test.ts:3824-3852` の T5 が ソース上の env 並びを正規表現 + section grep で regression 検出 |
| **7** | main.ts の `CMUX_NO_RENAME_TAB=1` export 箇所にコメント | ✓ | `main.ts:3300, 3389, 3656` の 3 箇所すべてに `// T026: using-cmux plugin v1.8.0+ の SessionStart hook（plugin.json 内で参照）を抑止する env gate。dead flag ではない、削除不可。` のコメント追加 |
| **8** | main.ts Agent spawn 末尾 renameTab を assertTabTitle 化（DRY） | ✓ | `main.ts:3823` で `cmux.renameTab(surface, ...)` → `cmux.assertTabTitle(surface, "[N] Agent", "agent spawn")` に置換。`main.ts:3817-3821` で「本質的な W-A 防御は daemon.ts の Agent SESSION_STARTED 分岐の counter-rename が担う」旨のコメント追加 |

**B 判定: 全タスク網羅**

---

## C. テスト独立再実行（per-file）

worktree: `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000/skills/cmux-team/manager`

```text
$ bun test --timeout 30000 cmux.test.ts
 40 pass / 0 fail / 77 expect() / 6.92s

$ bun test --timeout 30000 conductor.test.ts
 55 pass / 3 skip / 0 fail / 197 expect() / 6.57s

$ bun test --timeout 30000 daemon.test.ts
 242 pass / 2 skip / 0 fail / 839 expect() / 41.55s

$ bun test --timeout 30000 main.test.ts
 274 pass / 0 fail / 754 expect() / 22.19s

$ bun test --timeout 30000 master.test.ts
 22 pass / 0 fail / 46 expect() / 108ms

$ bun test --timeout 30000 config.test.ts
 63 pass / 0 fail / 121 expect() / 75ms
```

**全 6 ファイル 0 fail**。Conductor 側報告の per-file 結果と完全一致。

### 新規テストの実 assertion 確認（空振り防止）

| Test | 検証内容 | assertion の中身 |
|---|---|---|
| T1: `cmux.test.ts:449-503` `assertTabTitle` | 成功時 / 失敗時の log 経路 | `argv` に `rename-tab --surface surface:42 [42] Conductor` が 1 回、manager.log に `title_reassert` 成功 / `title_reassert_failed` 失敗、各 context 文字列を含むこと |
| T2: `daemon.test.ts:1118-1188` Conductor SESSION_STARTED counter-rename | 4 状態（reserved / disconnected / assigning / broken）の発火可否 | `assertTabTitle` mock spy の `calls[0]` で surface/title/context を逐次 assert、broken は 0 回 |
| T3: `daemon.test.ts:1067-1110` Agent SESSION_STARTED counter-rename | 1 回呼び出し + 引数検証 | `expect(assertSpy).toHaveBeenCalledTimes(1)` + `call[0]/[1]/[2]` でそれぞれ surface / `[719] Agent` / `agent session_started` を assert |
| T4: `conductor.test.ts:514-585` reserved 遅延 re-rename | 即時 + 遅延の 2 回呼び出し、遅延が delayMs 以降 | `immediate.length === 2 && delayed.length === 2`、即時 < 150ms、遅延 >= 200ms。実時刻測定（fake timer 不使用） |
| T4 (Rec #2): `conductor.test.ts:587-622` 並列化検証 | pane 数 N で合計遅延が delayMs に収束 | `elapsed < 700ms && elapsed >= 200ms`（pane=2 で 200ms config）。serial だと 400ms 以上になるので並列化を真に検証 |
| T5: `main.test.ts:3824-3852` restart 経路 env | restart section に env 全部入りを static assert | section に `cmux.send(` / `export CMUX_SURFACE=` / `CMUX_CLAUDE_HOOKS_DISABLED=1` / `CMUX_NO_RENAME_TAB=1` / `spawn-conductor` の全部を `expect(section).toContain(...)` |

すべて意味のある assertion を持ち、空振りテストではない。

**C 判定: 全テスト pass、新規テストは実 assertion 構成**

---

## D. tsc 新規エラー 0 確認

```text
$ bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | sort
c11-features.test.ts(138,14): error TS2722: Cannot invoke an object which is possibly 'undefined'.
c11-features.test.ts(180,20): error TS2322: Type 'number' is not assignable to type 'void | Promise<void>'.
c11-features.ts(268,22): error TS2345: Argument of type '{ kind: "added" | "changed"; key: string; value: MailboxValue; previous: MailboxValue | undefined; }' is not assignable to parameter of type 'MailboxChange'.
c11-features.ts(276,49): error TS2322: Type 'MailboxValue | undefined' is not assignable to type 'MailboxValue'.
mailbox-cli.ts(29,9): error TS18048: 'a' is possibly 'undefined'.
mailbox-cli.ts(30,20): error TS18048: 'a' is possibly 'undefined'.
mailbox-cli.ts(44,23): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
main.ts(1043,7): error TS2322: Type 'string' is not assignable to type 'boolean'.
```

既存 8 件のみ。本 PR の touched ファイル/行と突き合わせ:

- **c11-features.ts / c11-features.test.ts**: 本 PR で diff 無し（変更ファイル一覧に含まれない）
- **mailbox-cli.ts**: 本 PR で diff 無し
- **main.ts:1043**: 本 PR の main.ts 変更ハンクは `3300 / 3389 / 3656 / 3817 / 3823 / 5618-5625` のみ（`git diff -U0` で確認済）。1043 は範囲外

**touched 行起因の新規エラー 0**。Conductor 側報告と完全一致。

**D 判定: 新規エラー 0 件**

---

## E. 構造的妥当性（CLAUDE.md 原則）

| 項目 | 評価 | 根拠 |
|---|---|---|
| **last-write-wins の競争に持ち込んでいないか** | ✓ | SESSION_STARTED hook という決定論的イベントに乗って後着で counter-rename する設計（W-A は surface 経過時間ベースで因果保証、W-B は env gate で抑止 + 二重防衛）。reserved 分岐の 800ms delay は唯一の timing 依存だが、(a) 範囲限定、(b) config で延長可、(c) Promise.all 並列化で N pane でも合計遅延一定。design-review §2-C の analysis と整合 |
| **空 catch 禁止** | ✓ | `cmux.ts:255-260` の catch は `logError("title_reassert_failed", ...)` で stderr/stdout を含む詳細を残す。`formatExecError(e)` 経由で exec エラーの内訳まで保持。空 catch なし |
| **logger → eventBus 循環 import 禁止** | ✓ | `cmux.ts:10` import は `./logger` のみ、`./eventBus` なし。`conductor.ts:13` の `notifyStateChanged from "./eventBus"` は既存で本 PR 改変なし |
| **EventBus 直接呼び出し禁止 (`bus.emit/on`)** | ✓ | 本 PR の追加コードに `bus.emit` / `bus.on` の直接呼び出しなし。`notifyStateChanged` 経由のみ |
| **assertTabTitle 失敗が main 制御を止めない** | ✓ | `cmux.ts:249-260` の try/catch で例外を握りつぶし error log を残す設計。daemon.ts / conductor.ts / main.ts の呼び出し側で `await` のみ、例外 propagation なし |
| **observatory 強化** | ✓ | `title_reassert` event を成功時にも出すことで「W-A / W-B 上書きが何回起きて何回戻したか」を `grep title_reassert .team/logs/manager.log` で pull 観測可能。recap follow-up の monitoring 動線（plan §6.1）が成立する前提が実装に落ちている |
| **state 外部化 / silent mutation 無し** | ✓ | counter-rename は state を持たない単発関数。daemon の `conductor.lastHookAt` 等の state 更新は既存経路を再利用、本 PR 追加の silent mutation なし |

**E 判定: 違反なし、observatory 原則をむしろ強化**

---

## F. 実 spawn 検証の実施 / 省略理由

**実施せず、unit test + 静的検証で代替**。理由（タスク本文 F 項に従う）:

- `elevens start` / `elevens create-task --status ready` は live daemon と競合し実 surface を spawn してしまうため Inspector 環境では実行禁止
- `c11` CLI 経由の手動 surface 1 個での `get-metadata --sources` 観測も検討したが、現 production daemon を破壊するリスクを優先回避（前任実装 Agent が 2 回 pid_watcher crash しており、本検品では負荷を避けたい）
- **A の静的検証 (Recs 全反映) + B (実装網羅) + C (新規テスト 5 本が時間特性・引数・log 経路を実 assertion で検証) + D (tsc 新規エラー 0) + E (構造原則) で GO 根拠は十分**。タスク本文も「これでも GO 可。判定は A-E の静的+test 検証を主とする」と明記
- 実 spawn での目視確認は **後続 production rollout 時** に observatory（`grep title_reassert .team/logs/manager.log`）と `c11 get-metadata` で継続観察する（recap follow-up の monitor 動線と兼用可能）

**F 判定: 省略（タスク本文許容範囲内）**

---

## 総合判定: **GO**

本 PR は plan / design-review の Rec #1-#9 (#9 除く) を全反映し、実装タスク 1-8 を網羅、per-file テスト 6 ファイル 0 fail、tsc 新規エラー 0、CLAUDE.md 構造原則違反なし。Conductor 28 が次のステップ（commit 分割 / PR 作成）に進んで問題なし。

### 補足: Conductor / 後任が留意すべき点（Fix Required ではない）

- **commit 分割 (Rec #9)**: design-review §4.2 Rec #9 で示された 6 commit 分割（`cmux.assertTabTitle 追加+T1 → Master 置換 → Conductor counter-rename+T2 → Agent counter-rename+T3 → reserved 並列化+config+T4 → restart env+T5+コメント`）に従うことを推奨。本検品では 1 つの diff として GO 判定済だが、bisect 可能性と review の見通しのため commit 分割は価値が高い
- **scope 縮約の commit/PR 明記 (Rec #6)**: タスクタイトル「surface-recap-writer-t019」と「recap writer は本フェーズ再現不可、scope は W-A `[N] Claude Code` 上書き阻止」のギャップを commit message / PR description に明示（design-review §4.1 Rec #6 文面参照）
- **recap follow-up タスク**: plan §6.1 で別タスク化が提案されている。本 PR closing artifact (A027 想定) または別 issue で起票するかは Conductor 判断
- **`reservedRenameDelayMs` config の docs**: `config.ts:121-130` で interface は document 済だが、`docs/spec/05-install-and-infrastructure.md` または同 config セクションへの追記は別 follow-up（minimal scope 原則: 本 PR には含めない）
