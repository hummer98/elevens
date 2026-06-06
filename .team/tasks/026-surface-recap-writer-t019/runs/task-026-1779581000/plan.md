# Plan: タブタイトル `[N] Claude Code` 上書き fix の実装計画

実施: 2026-05-24 / Planner: surface:28 (Conductor 28)
worktree: `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000`
findings: [`./findings.md`](./findings.md)

---

## 1. 背景

Phase 1 調査（findings.md）で、surface タブタイトルを `[N] Claude Code` に上書きする writer は 2 系統に同定された:

- **W-A**: c11 binary 内部の default title setter。新規 terminal surface 作成から **約 570 ms 後** に `[N] Claude Code` を `source=explicit` で書く。env で disable する手段は無く、すべての fresh surface で発火する。
- **W-B**: using-cmux plugin v1.8.0 の SessionStart hook。`CMUX_NO_RENAME_TAB` 空 かつ plugin enabled cwd で発火するが、**elevens 配下では project `.claude/settings.json` で plugin disabled** なので発火しない。Conductor/Agent では env `CMUX_NO_RENAME_TAB=1` で二重防衛。

いずれも `source=explicit` のため、`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`（OSC 抑止）は効かない。fix は「explicit 上書きを止める／後 assert する」方向に倒す。

なお **recap（動的タイトル変化）は Phase 1 で再現できず writer 未特定**。本 plan の確実な scope は **W-A による `[N] Claude Code` 上書きの阻止** とする（§6 で切り分け）。

---

## 2. 採用する fix 機構と根拠

### 2.1 既存 Master counter-rename パターンの実態（実コード確認）

`skills/cmux-team/manager/daemon.ts:2111-2122`（`SESSION_STARTED` ハンドラ Master 分岐）:

```ts
// using-cmux plugin の SessionStart hook が "[N] Claude Code" に rename
// するため、Master では hook 発火後に "[N] Master" で上書きする（A016）。
try {
  const num = message.surface.replace("surface:", "");
  await cmux.renameTab(message.surface, `[${num}] Master`);
} catch (e: any) {
  await log("error", `renameTab failed (master session_started): ${e?.message ?? e}`);
}
```

**正体は「hook 起動イベント駆動の one-shot 再 assert」**。watcher でも poll でも retry loop でもない。Claude 起動 → using-cmux hook が rename → SessionStart hook が daemon に `SESSION_STARTED` を POST → daemon ハンドラが上書きで再 rename、という決定論的な順序に乗っている。

`master.ts:124` の初回 `renameTab` は spawn 直後（claude 起動前）に呼ぶため W-A（surface 作成 ~570ms 後の default setter）に負ける可能性があるが、その後 `SESSION_STARTED` hook 受信時の counter-rename で確実に `[N] Master` に戻る。**Master は実質「2 段構え（初回 + hook 駆動の再 assert）」で守られている。**

### 2.2 各経路の現状 gap

| surface 種別 | 経路 | 初回 rename | hook 駆動の再 assert | W-A 防御 | W-B 防御 |
|---|---|---|---|---|---|
| **Master** | `master.ts:124` + `daemon.ts:2111-2122` | あり | **あり** | ✓ (hook 再 assert) | ✓ (hook 再 assert) |
| **Conductor (reserved)** | `conductor.ts:332` | あり | **無し** (claude 未起動なので SESSION_STARTED が来ない) | ✗ | N/A (claude 未起動なので W-B も発火せず) |
| **Conductor (spawn)** | `main.ts:3300` env のみ | **無し** (env で W-B 抑止のみ) | **無し** | ✗ | ✓ (env) |
| **Agent (spawn)** | `main.ts:3815` | あり (claude 起動 send 後) | **無し** | △ (claude 起動 send より後なので W-A はもう発火済の可能性が高いが順序依存) | ✓ (env) |
| **Conductor (restart)** | `main.ts:5610` 付近 | **無し** | **無し** | ✗ | **✗ (env 欠落バグ)** |

**結論**: Master と同じ「**hook 駆動の再 assert** を Conductor/Agent にも展開する」のが既存パターンの素直な拡張。reserved だけは claude 未起動のため別途扱い必要。

### 2.3 採用方針（候補 (i) を採用）

採用: **(i) 既存 Master パターンを Conductor/Agent/restart に横展開**。

| 経路 | 機構 |
|---|---|
| **Conductor (spawn / restart / クリア後の再起動)** | `daemon.ts` の `SESSION_STARTED` Conductor 分岐に counter-rename を追加（`[N] Conductor`）。Master と同じ位置・同じ形 |
| **Agent (spawn)** | `daemon.ts` の `SESSION_STARTED` Agent 分岐に counter-rename を追加（`[N] Agent`） |
| **Conductor (reserved)** | claude 未起動 → SESSION_STARTED が来ない。`conductor.ts:332` の `renameTab` 呼び出し前に **W-A 完了を待つ delay** を入れる（後述 §3.5） |
| **restart 経路の env 欠落** | `main.ts:5610` で `CMUX_NO_RENAME_TAB=1` の export を追加（W-B 防御の整合性）|

**CLAUDE.md 原則との整合**:

- ✅ **「決定論的なものはコードで」**: hook 駆動の再 assert は `SESSION_STARTED` という決定論的イベントに乗る。タイマー hack ではない。
- ✅ **「各層は自分の仕事だけをする」**: title assertion 責務は daemon に集約。spawn 側 (`main.ts`/`conductor.ts`) は初回 rename と env 設定のみ。
- ✅ **「逸脱しても安全な構造にする」**: 万一 W-A の正体や timing が変わっても、SESSION_STARTED が来れば必ず正しい title に戻る。timing window への依存は reserved 分岐のみ（§3.5 で限定スコープ化）。
- ⚠️ **「last-write-wins の競争に持ち込まない構造を優先」**: hook 駆動再 assert は実体としては「最後に書いた者が勝つ」競争だが、**競争相手（W-A / W-B）の発火順序に対し因果関係を持って後着する**（SessionStart hook は claude が起動してから発火 ＝ W-A の 570ms と W-B の rename はいずれも先行する）。timing 偶然ではなく順序保証。reserved 分岐の delay だけは弱い保証（§7 リスク参照）。
- ✅ **observability**: counter-rename が呼ばれた瞬間にログ（`title_reassert role=conductor surface=surface:N`）を出す → trace DB で「上書きが起きた / 戻した」観測が可能。observatory として一貫。

### 2.4 共通ヘルパー化の判断

3 経路で同じ「`renameTab` + try/catch + error log」コードが並ぶ。`cmux.ts` に小さな helper を切り出す:

```ts
// cmux.ts に追加
/**
 * surface のタブタイトルを assert する。renameTab の薄いラッパで、失敗時に
 * 呼び出し元コンテキスト名を含めたエラーログを残す。
 * counter-rename パターン（W-A / using-cmux SessionStart hook が来た後に
 * 上書きで再 assert）の共通化用。実装は単発で watcher/poll を持たない。
 */
export async function assertTabTitle(
  surface: string,
  title: string,
  contextForLog: string,
): Promise<void> {
  try {
    await renameTab(surface, title);
  } catch (e: any) {
    await log(
      "error",
      `assertTabTitle failed (${contextForLog}): surface=${surface} title="${title}" err=${e?.message ?? e}`,
    );
  }
}
```

呼び出し側は `await assertTabTitle(message.surface, `[${num}] Conductor`, "conductor session_started")` の 1 行。Master 既存箇所も置き換えて DRY 化（minimal scope 原則を守りつつ、後任が「Conductor だけ別実装」と誤解しないよう一貫性を担保）。

---

## 3. 変更ファイル一覧

| ファイル | 行 (おおよそ) | 変更概要 |
|---|---|---|
| `skills/cmux-team/manager/cmux.ts` | 末尾 | `assertTabTitle(surface, title, contextForLog)` ヘルパ追加。`renameTab` の薄いラッパで try/catch + error log 込み |
| `skills/cmux-team/manager/daemon.ts` | L2113-2121 (Master 分岐) | 既存 counter-rename を `assertTabTitle` 呼び出しに置換（DRY 化）。`title_reassert` ログ key で trace 可能性向上 |
| `skills/cmux-team/manager/daemon.ts` | L2197 付近 (Conductor `SESSION_STARTED` 分岐, `notifyStateChanged` 直後 or `spawnPidWatcher` 直後) | **新規追加**: `assertTabTitle(message.surface, \`[${num}] Conductor\`, "conductor session_started")` を呼ぶ。reserved → idle / disconnected → idle / assigning → running すべての分岐で claude が起動済として正しく走る |
| `skills/cmux-team/manager/daemon.ts` | L2305-2317 (Agent `SESSION_STARTED` 分岐, `notifyStateChanged` 直後) | **新規追加**: `assertTabTitle(message.surface, \`[${num}] Agent\`, "agent session_started")` |
| `skills/cmux-team/manager/conductor.ts` | L320-339 (reserved 分岐) | `renameTab` の前に W-A 完了を待つ delay（推奨 800ms; findings 実測は 570ms なのでマージン込みで 800ms）を入れる。コメントで「W-A (c11 default title setter ~570ms 後) を後着で上書きするため」と明示。`renameTab` 呼び出しは `assertTabTitle(surface, ..., "conductor reserved")` に置換 |
| `skills/cmux-team/manager/main.ts` | L5610 (restart 経路) | `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1` に **`CMUX_NO_RENAME_TAB=1` を追加**。findings §6 で指摘された bug |
| `skills/cmux-team/manager/main.ts` | L3300 / L3388 / L3654 など `CMUX_NO_RENAME_TAB=1` の export | **コメント 1 行追加**: 「using-cmux plugin v1.8.0+ の SessionStart hook (`~/.claude/plugins/cache/hummer98-using-cmux/.../plugin.json`) を抑止する env gate。delete 不可」。findings §6 で警告された「dead flag 誤認」の再発を防ぐ |
| `skills/cmux-team/manager/main.ts` | L3815 (Agent spawn 末尾の `renameTab`) | `assertTabTitle(surface, ..., "agent spawn")` に置換（DRY）。本質的な W-A 防御は §2.3 で追加する `SESSION_STARTED` 経路が担う |

**変更しないもの**:

- `commands/`, `templates/`, `docs/spec/` — runtime 仕様変更なし。実装内部の改善
- c11 binary / using-cmux plugin — 外部依存。今回 fix の射程外
- `CMUX_NO_RENAME_TAB` env そのもの — 削除も改名もしない（using-cmux が現に参照中）

---

## 4. TDD のテスト計画

### 4.1 先に書く unit test（赤）

#### T1. `cmux.assertTabTitle` の単体（`cmux.test.ts` に追加）

- 成功時: `renameTab` を 1 回呼び、戻り値 void
- `renameTab` が throw した場合: 例外を抑止し、`logger.log("error", ...)` を 1 回呼ぶ（log を spy）
- ログメッセージに `contextForLog` の文字列が含まれること

#### T2. daemon `SESSION_STARTED` Conductor 分岐の counter-rename（`daemon.test.ts` に追加）

既存の Master 用テストパターン（L4369 付近の `renameTabSpy` セットアップ）に倣う:

- セットアップ: `cmux.renameTab` を spy、Conductor state を pre-populate (reserved or running)
- 行為: `handleMessage({ type: "SESSION_STARTED", surface: "surface:42", pid: 123, ...})` を呼ぶ
- 検証: `renameTabSpy` が `("surface:42", "[42] Conductor")` で 1 回呼ばれた
- バリエーション: `prevStatus === "reserved" | "disconnected" | "assigning"` のいずれでも呼ばれる（Master と同じく無条件で呼ぶ）
- `broken` 状態 (`break` で抜ける経路) では呼ばれないこと

#### T3. daemon `SESSION_STARTED` Agent 分岐の counter-rename（`daemon.test.ts` に追加）

T2 と同形で Agent 用に。`renameTabSpy` が `("surface:N", "[N] Agent")` で呼ばれる。

#### T4. `conductor.initializeConductorSlots` の reserved 分岐 delay（`conductor.test.ts` に追加）

- セットアップ: `cmux.newSplit` / `cmux.renameTab` を spy、Bun の fake timers が使えれば fake timer、無理なら実時刻で 800ms 待つ test として書く
- 行為: 新規 reserved pane を 1 つ作る
- 検証:
  - `renameTab` 呼び出しが `newSplit` 完了から **800ms 以降** に実行された（既存 W-A の 570ms より後）
  - title 引数は `[N] Conductor`
- 既存 reserved test を壊さないこと

#### T5. restart 経路で `CMUX_NO_RENAME_TAB=1` が export される（`daemon.test.ts` or 既存 restart test）

- セットアップ: `cmux.send` を spy
- 行為: `cmdRestartTask` を相当呼び出し
- 検証: `send(conductor.surface, ...)` で送られた最初の export 行に `CMUX_NO_RENAME_TAB=1` が含まれる

### 4.2 実装（緑）

各テストを通すために §3 の変更を当てる。順序:

1. `cmux.assertTabTitle` 実装 → T1 緑
2. `daemon.ts` Master 分岐を `assertTabTitle` で置換 → 既存 Master test が変わらず緑
3. `daemon.ts` Conductor `SESSION_STARTED` 分岐に counter-rename 追加 → T2 緑
4. `daemon.ts` Agent `SESSION_STARTED` 分岐に counter-rename 追加 → T3 緑
5. `conductor.ts` reserved 分岐に delay 追加 → T4 緑
6. `main.ts` restart 経路に `CMUX_NO_RENAME_TAB=1` 追加 → T5 緑
7. `main.ts` 各所 / `main.ts:3815` の DRY 化（assertTabTitle 置換、コメント追加）→ 既存テスト緑のまま

### 4.3 既存テストの非破壊

- `master.test.ts` L190-201 の `renameTabSpy` セットアップ — Master の `assertTabTitle` 置換でも spy は引き続き `renameTab` を catch する（`assertTabTitle` 内部で `renameTab` を呼ぶため）。**変更不要**
- `daemon.test.ts` 既存の `stubs.renameTab` mocks — 同上、内部 `renameTab` 呼び出しなので spy 経路は維持
- `cwd-mismatch.integration.test.ts` の `renameTab` 参照 — 内部 mock のためそのまま動く

### 4.4 テスト実行コマンド（CLAUDE.md「既知の注意点」厳守）

`bun test` 全体実行は禁忌（O(N²) 劣化）。per-file ループで:

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-026-1779581000/skills/cmux-team/manager
# 影響を受ける可能性のあるファイルだけ先に走らせる
bun test --timeout 30000 cmux.test.ts
bun test --timeout 30000 daemon.test.ts
bun test --timeout 30000 conductor.test.ts
bun test --timeout 30000 master.test.ts

# 全 unit を最後に流す
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

---

## 5. 実 spawn 検証手順

findings §7 を本実装に合わせて精緻化（Inspector が実行できる形）:

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-026-1779581000

# 1. Manager と Master を起動（既に動いていれば skip）
elevens start

# 2. reserved Conductor pane が [N] Conductor のまま W-A に侵食されないことを確認
sleep 3   # W-A の 570ms ＋ 余裕
WORKSPACE=$(jq -r .workspace .team/team.json 2>/dev/null || echo workspace:5)
for s in $(c11 tree --workspace "$WORKSPACE" --json | jq -r '.. | .surface_ref? // empty' | grep '^surface:' | sort -u); do
  title=$(c11 get-metadata --surface "$s" --sources | grep -E "^title" || true)
  echo "$s  $title"
done
# 期待: Master surface = "[N] Master  [explicit @ ...]"
#       Conductor reserved surface = "[N] Conductor  [explicit @ ...]"
#       いずれも "Claude Code" を含まない

# 3. ready task を 1 つ assign し、kill+spawn 経路で [N] Conductor が侵食されないことを確認
elevens create-task --title "title pin test" --status ready --body "echo title-pin-ok && exit"

# 4. claude 起動後 8s 待ち（SESSION_STARTED 受信 → counter-rename 完了まで）
sleep 8
for s in $(c11 tree --workspace "$WORKSPACE" --json | jq -r '.. | .surface_ref? // empty' | grep '^surface:' | sort -u); do
  title=$(c11 get-metadata --surface "$s" --sources | grep -E "^title" || true)
  echo "$s  $title"
done
# 期待: 該当 Conductor surface = "[N] Conductor"、Claude Code への侵食なし

# 5. Agent が spawn されたら [N] Agent への遷移を確認
# (タスクが Agent を spawn するかどうかはタスク内容次第。spawn された場合のみ)

# 6. .team/logs/manager.log に counter-rename ログが残っていることを確認
grep -E "title_reassert|assertTabTitle" .team/logs/manager.log | tail -20
# 期待: Master / Conductor / (該当する場合 Agent) 経路で各 1 行以上

# 7. restart 経路の検証（main.ts L5610 修正の確認）
# 注: restart はタスクが必要なので別タスクで再現する
elevens create-task --title "restart-env-test" --status ready --body "sleep 60"
sleep 5
# restart を発火（surface を確認して実行）
elevens restart-task --task-id <ID> --journal "restart env test"
sleep 8
# 該当 Conductor の env を確認（process env を ps eww 経由で）
pid=$(jq -r ".conductors[\"surface:N\"].pid" .team/team.json)
ps eww "$pid" | tr ' ' '\n' | grep CMUX_NO_RENAME_TAB
# 期待: CMUX_NO_RENAME_TAB=1
```

検証ログは `.team/artifacts/A027-title-pin-verification.md` に保存し、本タスク close 時に成果物として参照する。

---

## 6. スコープ外 / follow-up

### 6.1 recap（動的タイトル）への対応

findings §3 Q3 / §4 末尾の通り、**recap の writer は Phase 1 で再現できず未特定**。本 plan のスコープは

> **W-A による `[N] Claude Code` 上書きの確実な阻止**

に限定する。理由:

- 採用した hook 駆動 counter-rename は `SESSION_STARTED` の **1 回しか** 走らない。仮に recap が長時間 claude セッション中の任意の時点で発火するとすれば、この機構では防げない
- ただし recap がもし `SessionStart` 経路（resume / compact / clear 後の再起動）でも来るタイプなら、本機構で副次的にカバーされる可能性がある（実証は Phase 2 で再現できてから）

**follow-up 候補（別タスクとして起票推奨、本 plan には含めない）**:

- T026-follow-up-1: recap 再現実験（長時間 claude を /tmp で interactive 起動、`get-metadata --sources` を 1s poll で全件キャプチャ）→ writer 特定 → 必要なら本機構の拡張（title watcher 化）を判断
- 上記が困難なら **本機構を入れた後に production 観察** で recap が再発するかを `.team/logs/events.jsonl` / `manager.log` の `title_reassert` 出現頻度で監視（observatory として運用）

minimal scope 原則（[[feedback_minimal_scope]]）に従い、recap 対応を投機的に膨らませない。

### 6.2 c11 fork 案 (B-1) と c11 pin protocol 案 (B-3) を今回やらない理由

findings §5 で提示された:

- **B-1**: c11 binary 側で default title setter を env opt-out できるよう改修
- **B-3**: c11 metadata に `--pin true` フラグを追加

いずれも c11 本体への変更が必要。本 plan では:

- elevens 内で完結し、c11 側変更を待たずにユーザー体験が改善する B-2 系（hook 駆動 counter-rename）を採用
- B-1/B-3 は別途 c11 upstream への提案 or elevens-private fork 検討として独立タスク（例 T027-c11-title-default-opt-out）に分離

**[[feedback_failfast_over_fallback]]**: elevens は c11 前提だが、c11 の挙動を変える要求と elevens 側 workaround は独立して進められる。c11 への要求は別レーン。

### 6.3 OSC 抑止 (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`) を入れない理由

findings §3 Q2 / Q5 の実測で **writer は両者とも `source=explicit`**（OSC 経由ではない）と確定。CLAUDE_CODE_DISABLE_TERMINAL_TITLE は claude 本体の OSC 2 emit を抑止する env であり、`rename-tab` socket call には影響しない。

入れると:

- 効かないのに「設定したから効くはず」と後任が誤解する混乱の元
- 将来 OSC 経路が増えた場合に意図しない副作用（claude 本体の他の OSC を抑止）の可能性

→ **入れない**。findings §5 の結論を踏襲。

### 6.4 reserved 分岐の delay を title watcher に置き換える案

reserved Conductor の §3.5 delay は唯一の timing-dependent 要素。より構造的には「c11 metadata `title` 変化を watch して `[N] Conductor` に戻す watcher」が観察箱原則と整合するが:

- 常駐プロセス増 = daemon 複雑度増
- W-A は 1 回しか発火しない（surface 作成 ~570ms 後の単発）ため、watcher の費用対効果が低い
- 800ms delay で実用上問題なく、検証手順（§5）で侵食ゼロを確認できる

採用見送り。recap 再現で「複数回 / 長時間で発火する」と判明したら再検討。

---

## 7. リスクと回避策

| リスク | 影響度 | 回避策 |
|---|---|---|
| **R1. W-A の timing (~570ms) が将来 c11 update で変わり、reserved の 800ms delay が足りなくなる** | 中 (reserved Conductor の表示崩れ) | (a) delay を `config.json` の `cmux.reservedRenameDelayMs` で override 可能にする（default 800、override で延長可）。(b) `.team/logs/manager.log` に「reserved rename 完了時刻 vs surface 作成時刻」を 1 行出す → trace DB で W-A timing 変化を検出可能 |
| **R2. `SESSION_STARTED` がレース / 順序逆転で多重に来た場合、counter-rename が複数回走る** | 低 (冪等、無害) | `assertTabTitle` は冪等。同じ title への再 rename は no-op 相当。trace 上はログが複数行残るが許容 |
| **R3. using-cmux plugin が新版で gate 条件を変更し、`CMUX_NO_RENAME_TAB=1` が効かなくなる** | 中 (W-B 復活) | (a) `CMUX_NO_RENAME_TAB` の export に「v1.8.0+ の plugin.json で参照」のコメントを残し、plugin update 時に再確認を促す。(b) hook 駆動 counter-rename が W-B の rename も後着で上書きするので二重防衛が効く |
| **R4. recap が production で再発し、本 fix が効かないように見える** | 中 (ユーザー認知 vs 実装の乖離) | §6.1 follow-up で recap 再現 + writer 特定を別タスク化。本 plan の commit message / PR description で「scope は W-A `[N] Claude Code` 上書き、recap は別 follow-up」と明示 |
| **R5. Master の既存 `assertTabTitle` 置換で振る舞いが変わる** | 低 | 内部 `renameTab` を呼ぶラッパなので equivalence は保たれる。既存 `daemon.test.ts` / `master.test.ts` の renameTab spy がそのまま通ることが等価性のテスト |
| **R6. 800ms delay が reserved Conductor の初期化全体を遅らせ、ユーザー体感が悪化** | 低 | 各 reserved pane の rename が直列で 800ms 待つと、N pane で `N * 800ms` 遅延。N=5 で 4s。回避: `Promise.all` で並列化（各 pane の delay は独立して走らせる）。実装上は `setTimeout` を `Promise` 化して全 pane で同時に走らせる |

---

## 8. 完了条件チェック（self-review）

- [x] §1 背景に findings 要約 + リンク
- [x] §2 採用機構と CLAUDE.md 原則整合の説明（hook 駆動再 assert は「決定論的イベント駆動」、reserved の delay は限定スコープ）
- [x] §3 変更ファイル一覧（file:line 表）
- [x] §4 TDD: 先に書くテスト → 実装 → 検証
- [x] §5 実 spawn 検証手順
- [x] §6 スコープ外 / follow-up（recap 未再現を honest に切り分け、B-1/B-3 を今回やらない理由、OSC 抑止を入れない理由）
- [x] §7 リスクと回避策
- [x] 既存 Master counter-rename の実態を読んで明記（§2.1）
- [x] minimal scope（recap は別 follow-up、c11 fork は別レーン）
