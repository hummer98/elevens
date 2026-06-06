# Findings: surface タブタイトル recap 上書き writer 特定

実施: 2026-05-24 / Researcher: surface:128 (Agent)
worktree: `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000`

## 1. 概要（結論）

**writer は 2 系統存在し、いずれも `source=explicit` で c11 socket 経由の `rename-tab` を呼ぶ。**

| # | writer | trigger | 発火条件 | source |
|---|---|---|---|---|
| **W-A** | **c11 binary 内部のデフォルト title setter** | surface 作成 ~570ms 後 | 常時 (terminal surface 新規作成すれば必ず) | explicit |
| **W-B** | **using-cmux plugin v1.8.0 の SessionStart hook** (`~/.claude/plugins/cache/hummer98-using-cmux/using-cmux/1.8.0/.claude-plugin/plugin.json`) | claude 起動時 | `CMUX_SURFACE_ID` 非空 AND `CMUX_NO_RENAME_TAB` 空 AND cwd で plugin が enabled | explicit (内部で `cmux rename-tab` を呼ぶ) |

タスク背景にあった「`CMUX_NO_RENAME_TAB` は dead flag」は **誤り**。using-cmux plugin v1.8.0 で実際に参照されており、Conductor の env (`main.ts` L3300) でも実際に `=1` がセットされている。実機の Conductor 28 claude process env でも `CMUX_NO_RENAME_TAB=1` を確認した（§4 参照）。

**`source=explicit` であるため、`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`（OSC 抑止）だけでは効かない。** fix は「OSC 抑止 (A)」ではなく「**explicit 上書きを止める / 上書き後に再 assert する (B)**」に倒すべき（§5）。

**recap（作業中の動的タイトル）は本フェーズで再現できなかった。** Phase 2 でより長時間 / 別 cwd / interactive 条件で追試が必要（§4 末尾の限界を参照）。

---

## 2. 実験ログ（生）

### 2.1 W-A の同定（c11 binary が surface 作成後に default title を書く）

**手順**: 新規 surface を作成し、即座に `rename-tab` で別名を付け、その後 c11 が default 書き込みでそれを上書きするかを観察。

```text
T0=1779582474.073   # c11 new-surface 直前
T1=1779582474.322   # surface:136 created (+250ms)
T2=1779582474.646   # `c11 rename-tab --surface surface:136 "[FIRST_RENAME]"` 完了 (+570ms)
get-metadata直後:    title = [FIRST_RENAME]  [explicit @ 1779582474.521]
+300ms:              title = [136] Claude Code  [explicit @ 1779582475.092]
+1.3s:               title = [136] Claude Code  [explicit @ 1779582475.092]
+3.3s:               title = [136] Claude Code  [explicit @ 1779582475.092]
```

**観察**: 自分で打った `[FIRST_RENAME]` (ts=474.521) が、約 **570 ms** 後に **c11 自身** によって `[136] Claude Code` (ts=475.092) に上書きされた。誰も claude を起動していない（shell 起動直後）。出力された screen にも `OK action=rename tab=tab:136 workspace=workspace:5` が ssh-add と direnv の間に印字されている（つまり c11 内部で rename-tab を実行している痕跡）。

これが W-A の動かぬ証拠。

### 2.2 W-B の同定（using-cmux SessionStart hook）

**手順**: surface:136 に `[136] BeforeClaude` を pin → `cd /tmp` してから `claude --dangerously-skip-permissions` を起動。  
（`/tmp` を選ぶ理由: elevens worktree 内の `.claude/settings.json` には `enabledPlugins."using-cmux@hummer98-using-cmux": false` があり、worktree 内では using-cmux hook が plugin disabled で発火しない。`/tmp` には project 設定が無いため user 設定 (`~/.claude/settings.json`) が有効 → plugin enabled。）

```text
1779582508.198  c11 rename-tab --surface surface:136 "[136] BeforeClaude"
1779582508.308  → title = [136] BeforeClaude  [explicit @ ...]
1779582508.908  send "cd /tmp; claude --dangerously-skip-permissions"
+10s 待機後:    title = [136] Claude Code  [explicit @ 1779582509.869]
```

**観察**: claude 起動から約 1 秒で title が `[136] Claude Code` に上書き。タイムスタンプ 1779582509.869 は私の rename (508.308) より後 → **last-write-wins で W-B が勝った**。  
plugin disabled な elevens worktree 内で同等のテストをした surface:131 では、claude を interactive で起動しても `[131] TestFixedC` が保持された（W-B が走らなかった）。

### 2.3 条件別 matrix（claude 起動有/無, env 条件）

| Test ID | surface | env at claude launch | cwd | claude mode | renameTab で pin → claude 起動後 title 変化 | 上書き writer |
|---|---|---|---|---|---|---|
| T1 | 132 | `CMUX_CLAUDE_HOOKS_DISABLED=1` (a) | elevens worktree | `claude -p` | `[132] TestFixed` 保持 (1779581931.665) | なし — `-p` は SessionStart 発火せず |
| T2 | 130 | clean (c) | elevens worktree | `claude -p` | `[130] TestFixed` 保持 (1779582001.817) | なし — `-p` は SessionStart 発火せず |
| T3 | 131 | clean (c) | elevens worktree | **interactive** | `[131] TestFixedC` 保持 (1779582045.065) | なし — **project 設定で using-cmux disabled** だから W-B 走らない |
| T4 | 136 | clean (c) | **/tmp** (project外) | **interactive** | `[136] BeforeClaude` (508.308) → `[136] Claude Code` (509.869) | **W-B** (using-cmux SessionStart hook) |
| T5 | 136 | clean (c) | /tmp | interactive で work(~30s) | `[136] Claude Code` (509.869) のまま recap rewrite 観測されず | **recap 再現できず** |
| T-bg | 136 | claude 未起動 | -- | -- | `[FIRST_RENAME]` (474.521) → `[136] Claude Code` (475.092) ~570ms | **W-A** (c11 default) |

env 詳細:
- 条件 a (`CMUX_CLAUDE_HOOKS_DISABLED=1` のみ): T1 ✅
- 条件 b (`CMUX_CLAUDE_HOOKS_DISABLED=1` + `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`): **未試験**（W-A は env と無関係に発火、W-B は OSC ではなく explicit を呼ぶため CLAUDE_CODE_DISABLE_TERMINAL_TITLE による抑止は理論上効かないと判断し、優先度を下げた。Phase 2 で完全な matrix が必要なら追試する）
- 条件 c (clean): T2/T3/T4 で試験

### 2.4 fresh c11 surface のデフォルト env スナップショット (surface:133)

```text
ENVCHECK CMUX_SURFACE_ID=514DABD9-...85F71E5DF79A
         CMUX_NO_RENAME_TAB=[]
         CMUX_CLAUDE_HOOKS_DISABLED=[1]
         CLAUDE_CODE_DISABLE_TERMINAL_TITLE=[]
         HOME=/Users/yamamoto
```

**c11 が新規 terminal surface を作る際、shell には `CMUX_CLAUDE_HOOKS_DISABLED=1` がデフォルトで入る**（wrapper の hook 注入を無効化）が、**`CMUX_NO_RENAME_TAB` は入らない**（空）。これが「素の c11 surface で claude を起動すると using-cmux の rename が走る」(T4) 原因。

### 2.5 production Conductor 28 の env 検証（タスク背景の確認）

```bash
$ ps eww 47766 | tr ' ' '\n' | grep -E "^(CMUX|CLAUDE_CODE)"
CMUX_BUNDLE_ID=com.stage11.c11
CMUX_SURFACE_ID=8210D664-...60F50
CMUX_SHELL_INTEGRATION_DIR=/Applications/c11.app/.../shell-integration
CMUX_DISABLE_SESSION_RESTORE=1
CMUX_PORT=9160
CMUX_WORKSPACE_ID=B5F605FC-...A521C2
CMUX_TAB_ID=...
CMUX_PANEL_ID=...
CMUX_SOCKET_PATH=/Users/yamamoto/Library/Application
CMUX_TEAM_SKIP_SYNC_CHECK=1
CMUX_TEAM_MAIN_BRANCH=main
CMUX_SURFACE=surface:28
CMUX_SHELL_INTEGRATION=1
CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION=1
CMUX_NO_RENAME_TAB=1                ← セット済み (main.ts L3300)
CMUX_CLAUDE_HOOKS_DISABLED=1        ← セット済み
```

→ **Conductor 28 では W-B (using-cmux) は env で gated されて発火しない**。タスク背景 (surface:27 が `[27] Claude Code` に上書きされた) と矛盾するように見えるが、原因は (a) surface:27 は "予約" 状態で claude が一度も起動していなかった = W-B は元から発火しようがない、(b) 実は writer は W-A (c11 default) だった、と説明できる。conductor.ts L317-339 の reserved 経路で `renameTab(surface, "[N] Conductor")` を一度呼ぶが、surface 作成 ~570ms 後に c11 default が `[N] Claude Code` で上書きしている。

---

## 3. 確認したい問いへの回答

### Q1: recap への書き換えが起きるのはどの条件か (a/b/c のどれで止まり、どれで起きるか)

**直接的回答**: 本フェーズで **recap 上書きは再現できなかった**。`/tmp` で interactive claude を起動 (T4) し、tool 使用込みで 30+ 秒作業させても title は `[136] Claude Code` のままで recap には変化しなかった。

ただし `[N] Claude Code`（idle 時 / SessionStart 時の上書き）については:
- 条件 c + plugin enabled cwd: 上書き発生 (T4)
- 条件 c + plugin disabled cwd (elevens worktree): 上書き起きない (T3)
- 条件 a + plugin disabled cwd + `-p`: 上書き起きない (T1)
- 条件 b は未試験（§2.3 参照）

### Q2: そのとき title の source は osc か explicit か

**`explicit`** — W-A も W-B も `c11/cmux rename-tab` (= `tab-action --action rename`) を呼んでいる。get-metadata --sources で全件 `[explicit @ ts]`。OSC 由来は一度も観測されなかった。  
**→ これが最重要点。OSC 抑止 (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`) では止まらない。**

### Q3: `[N] Claude Code` (idle 時) と recap (作業中) は別現象か同一機構か

**実証的回答**: recap を再現できなかったため断定不可。  
**推論**: `[N] Claude Code` の主たる writer は W-A (c11 default) + W-B (using-cmux hook) で、いずれも explicit。recap がもし observed 通り「`[27] Claude Code` のような固定的でない動的タイトル（作業内容要約）」だとすれば、

- (推論 a) 同一機構説: claude 本体が OSC 2 (`\e]2;<recap>\a`) を emit し、c11 socket integration がそれを captureして explicit として set している。→ source=explicit と矛盾しない。
- (推論 b) 別機構説: 別の hook (using-cmux の他イベント、または別 plugin) が claude のセマンティック状態を pulling して rename している。

**いずれも本フェーズの実測根拠は無い。**

### Q4: 書き換えの timestamp が elevens renameTab より後か (last-write-wins の検証)

**Yes**。

- W-A: 私の `c11 rename-tab "[FIRST_RENAME]"` 完了 ts=1779582474.521 → c11 default 上書き ts=1779582475.092 (約 +570 ms 後)
- W-B: 私の `c11 rename-tab "[136] BeforeClaude"` ts=1779582508.308 → using-cmux hook 上書き ts=1779582509.869 (約 +1.5 s 後、claude 起動含む)

last-write-wins が成立しており、後発の書き手が常に勝つ。

### Q5: 条件 b (CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1) で recap 上書きが止まるか否か

**未試験**。ただし Q2 で writer が explicit と確定したため、**理論的には止まらない**: CLAUDE_CODE_DISABLE_TERMINAL_TITLE は claude 本体の OSC 2 emit を抑止する env であり、explicit 経路 (W-A / W-B どちらも `rename-tab` socket call) には影響しない。Phase 2 で重要なら追試可能だが、優先度は低い。

---

## 4. writer の特定

**`[N] Claude Code` writer 主要 2 系統**（いずれも source=explicit）:

### W-A: **c11 binary 内部の default title setter**（再現性 100%, 常時発火）

- どこ: c11 process 内部 (AGPL のため source 確認不可)。外部観測のみ。
- いつ: terminal surface 新規作成から **約 570 ms 後**
- 何を: `[{surface_num}] Claude Code` を `tab-action --action rename` 相当で書く (source=explicit, 内部呼び出しと推定)
- 観測痕跡: 新しい surface の screen output に `OK action=rename tab=tab:N workspace=workspace:N` が ssh-add の直後・direnv の直前に印字される
- env で disable する手段: **無い**（env による gate を持たず、必ず走る）
- 影響範囲: reserved Conductor / spawn 直後の Master/Agent / restart 後の Conductor — **すべての fresh terminal surface**

### W-B: **using-cmux plugin v1.8.0 の SessionStart hook**（claude 起動時のみ）

- どこ: `/Users/yamamoto/.claude/plugins/cache/hummer98-using-cmux/using-cmux/1.8.0/.claude-plugin/plugin.json`
  ```json
  {"hooks": {"SessionStart": [{"matcher": "", "hooks": [{"type": "command",
   "command": "if [ -n \"$CMUX_SURFACE_ID\" ] && [ -z \"$CMUX_NO_RENAME_TAB\" ]; then REF=$(cmux identify | jq -r '.caller.surface_ref'); NUM=$(echo \"$REF\" | cut -d: -f2); cmux rename-tab --surface \"$REF\" \"[$NUM] Claude Code\"; fi"
  }]}]}}
  ```
- いつ: Claude Code session 開始時 (interactive claude のみ; `claude -p` print mode では発火しない)
- 何を: `cmux rename-tab` (legacy cmux 0.64.3 binary 経由で c11 socket と互換通信) で `[N] Claude Code` を書く (source=explicit)
- gate: 
  1. `CMUX_SURFACE_ID` が空でない（c11 terminal なら自動 set される）
  2. `CMUX_NO_RENAME_TAB` が空（**Conductor/Agent では `=1` で gated**, Conductor 28 で確認済）
  3. cwd の `.claude/settings.json` で plugin が enabled
- 影響範囲: 
  - **`/Users/yamamoto/git/elevens/` 配下では plugin disabled** なので発火しない（main repo と全 worktree の `.claude/settings.json` で `"using-cmux@hummer98-using-cmux": false`）
  - elevens 以外の cwd で claude を起動した場合のみ発火

### writer ではないと判明したもの

- **OSC 2 経由のタイトル emit**: 観測されず（全件 explicit）
- **shell hook (`_cmux_precmd`, `_ghostty_precmd`, etc.)**: rename を一切呼ばない（grep 0 件、§2.4 で hook 列挙済）
- **c11 wrapper script** (`/Applications/c11.app/Contents/Resources/bin/claude`): rename を呼ばない（grep 0 件; HOOKS_DISABLED gate と HOOKS_JSON 注入のみ）

### recap (動的タイトル) の writer

**本フェーズで再現できず、writer 未特定**。最有力候補は (1) claude 本体の OSC 2 emit を c11 が explicit に格上げして書き戻す経路、(2) 別 hook 経路。Phase 2 で必要なら以下で追試する:
- long-running claude session を /tmp で動かし、recap タイトルの正規パターン (e.g. `Code agent: <verb>`) を grep で待ち受ける
- `c11 get-metadata --surface ... --sources` を 1s 毎に poll して title 変化を全件キャプチャ

---

## 5. fix 層の推奨

**結論: (B) explicit 上書きを止める / 後 assert する構造に倒す。** (A) の OSC 抑止案は本質的に効かない（writer が explicit だから）。

### 推奨実装の選択肢 (優先順位順)

#### **B-1: c11 側の default title setter (W-A) を抑止する CLI/env を c11 に要望する** — 最も根本的

c11 が `[N] Claude Code` を default title として書く挙動を、env (例 `C11_DISABLE_DEFAULT_TITLE=1`) や `c11 new-surface --no-default-title` 等の opt-out で抑止できれば、elevens 側の renameTab だけで決着する。  
c11 は AGPL fork なので elevens project で fork-and-patch も可能だが、upstream に PR か elevens-private fork が現実的。短期では (B-2/B-3) で凌ぐ。

#### **B-2: elevens 側で「rename 後に c11 default が来ても再 assert する」pin 機構** — 短期で実装可能、確実

Master が daemon.ts L2111-2122 で既にやっているパターンを **Conductor / Agent / restart に展開**。

具体的には conductor.ts (reserved L332)・main.ts (cmdSpawnConductor L3300, cmdSpawnAgent L3654-3656, restart L5610) で renameTab を呼んだあと、

```ts
// W-A の default title (約 570ms 遅延で来る) を上書きするため遅延 re-rename
await new Promise(r => setTimeout(r, 1500));
await cmux.renameTab(surface, fixedTitle);
```

または「title 変化を watch して固定名と異なれば即座に再 assert」する小さな watcher を spawn する（pull 型監視原則と整合）。

**注入漏れ候補経路 (B-2 適用箇所一覧):**
| ファイル | 行 | 経路 |
|---|---|---|
| `conductor.ts` | L320-339 | reserved Conductor pane → `[N] Conductor` |
| `main.ts` | L3300-3338 (cmdSpawnConductor) | 通常 Conductor spawn → `[N] Conductor` |
| `main.ts` | L3654-3656 (Agent exportVars) / L3798 (Agent rename) | Agent spawn → `[N] Agent` |
| `main.ts` | L5610 (restart 経路) | **`CMUX_NO_RENAME_TAB=1` の export が抜けている**（要修正、それ自体は W-B 抑止の話） |
| `daemon.ts` | L2115 | Master → `[N] Master` (既に counter-rename 実装済、参考にできる) |
| `master.ts` | L124 | Master spawn 経路 |

#### **B-3: pin 機能を c11 metadata 側で持たせる** — 中期、protocol 拡張

`c11 set-metadata --surface ... --key title --value "[N] Conductor" --pin true`（pin が立つと以降 explicit < pin で守られる）を c11 に追加。AGPL fork で実装可能。  
これが入れば B-2 の defer/re-assert は不要。

### W-B (using-cmux hook) の取扱

elevens 配下では project settings.json で plugin disabled なので **W-B は元から発火しない**。気にする必要なし。  
W-B が問題化するのは「elevens config 外で elevens daemon が surface を扱う」場合だが、現状そのシナリオは無い。

---

## 6. dead flag CMUX_NO_RENAME_TAB の扱い提案

**実測で disprove された**: タスク背景の「elevens .ts でも c11 wrapper でも一度も参照されていない dead flag」は誤りで、

- using-cmux plugin v1.8.0 の SessionStart hook が `[ -z "$CMUX_NO_RENAME_TAB" ]` で参照している（§4 W-B）
- 実機 Conductor 28 の claude process env に `CMUX_NO_RENAME_TAB=1` が現在も入っている（§2.5）
- elevens main.ts でも複数箇所で export している (L3300, L3388, L3654)

**提案: そのまま残す（削除しない）**。理由:

1. using-cmux が外部 plugin として参照しており、削除すると elevens 配下の Conductor/Agent surface で claude を起動した瞬間 using-cmux が rename を打ってくる可能性が復活する（現状 project settings.json で plugin disable しているので二重防衛、片方外しても無防備にしたくない）
2. 名前が `RENAME_TAB` で意図が明瞭、misleading な dead flag ではない
3. ただし **コメントを 1 行足して**「これは using-cmux plugin v1.8.0 以降の SessionStart hook を抑止するための env gate である（plugin.json 内部で参照）」と書き残せば後任の誤解を防げる

ついでに `main.ts` L5610 (restart) で `CMUX_NO_RENAME_TAB=1` export が **抜けている** のは修正すべきバグ:

```ts
// 現状 (L5610 付近):
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
// 修正:
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_NO_RENAME_TAB=1\n`);
```

---

## 7. 実装後の検証手順 (Phase 2 で実 spawn して確認するときの memo)

実装 (B-2 想定: 遅延 re-rename か title pin watcher) 後、以下で侵食しないことを確認する:

```bash
# 1. Manager と Master を起動
cmux-team start

# 2. 5 Conductor pane を予約 (reserved → [N] Conductor 表示)
# (Master が start 時に勝手にやる; 表示が [N] Conductor になっているか確認)
sleep 5
c11 tree --workspace workspace:5 | grep -E "Conductor|Master|Agent"

# 3. ready task を 1 つ assign し、初回 spawn-conductor 経路を踏む
cmux-team create-task --title "title pin test" --status ready --body "echo hello and exit"

# 4. claude 起動後 5s 待って title が [N] Conductor のまま侵食されないことを確認
sleep 30
for s in $(c11 tree --workspace workspace:5 | grep -oE "surface:[0-9]+" | sort -u); do
  echo "=== $s ==="
  c11 get-metadata --surface $s --sources | grep title
done

# 期待: Master surface = [N] Master, Conductor surface = [N] Conductor,
#       Agent surface (もしあれば) = [N] Agent。すべて "Claude Code" にならない。

# 5. Agent spawn + 数十秒の実作業で recap タイトルが起きないかも観察
#    (recap 再現が本来 Phase 1 でできなかったので、Phase 2 では production 環境で実観測する価値あり)
sleep 120
for s in ... ; do
  c11 get-metadata --surface $s --sources | grep title
done

# 6. restart 経路の検証 (main.ts L5610 export 欠落の修正後)
cmux-team conductor reset --surface surface:N
sleep 30
c11 get-metadata --surface surface:N --sources | grep title
# 期待: [N] Conductor のまま
```

実装側に「title 変化を観測したら自動再 assert する watcher」を入れた場合は、`.team/logs/manager.log` に再 assert ログ (`title_reassert surface=surface:N from=[N] Claude Code to=[N] Conductor`) を吐かせる設計にしておくと、本問題の再発検知が観察箱として機能する（CLAUDE.md §observatory 原則）。

---

## 後始末

実験で作成した surface (実験完了後に close 済み):
- surface:130, 131, 132, 133, 134, 135, 136 → 全件 `c11 close-surface` で削除完了

close 直後の tree 確認結果: 上記 surface は全て tree から消え、production surface (26 Manager / 29 Master / 28 Conductor / 36-44 Agent / 113 / 128 自分) のみ残存。リーク無し。
