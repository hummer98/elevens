# T019 Phase 1: タブタイトル上書き writer の特定（実測調査）

- 調査者: implementer agent (surface:58)
- 調査日時: 2026-05-23 07:09 〜 07:18 JST
- 作業ディレクトリ: `/Users/yamamoto/git/elevens/.worktrees/task-019-1779487382`
- c11 version: `0.49.3 (106)`
- 制約: コード修正なし、live surface（27/29/36/37/40/41/43/44）に書き込み禁止、observation は read-only コマンド (`c11 tree` / `c11 get-metadata --sources`) のみ

---

## 1. 調査方法

### 1.1 使ったコマンド

| 種別 | コマンド | 用途 |
|---|---|---|
| 観測 | `c11 tree` | 現状の surface 構成 |
| 観測 | `c11 get-metadata --surface surface:N --sources` | 各 surface の `title` / `terminal_type` 等の値・source・timestamp |
| 観測 | `c11 read-screen --surface <s> --lines N` | 実画面の最終出力 |
| コード調査 | `grep` / Read on `skills/cmux-team/manager/*.ts` | elevens 内 renameTab 呼び出し箇所 |
| binary 観測 | `strings /Applications/c11.app/Contents/Resources/bin/c11` | c11 内蔵 source 列挙 (`explicit\|declare\|osc\|heuristic`) |
| binary 観測 | `strings /Users/yamamoto/.local/bin/claude` | real claude binary が `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` を参照しているか |
| 実験操作 | `c11 new-split right` | 隔離 surface 作成 |
| 実験操作 | `c11 rename-tab --surface <s> "<title>"` | elevens の renameTab 経路の再現 |
| 実験操作 | `c11 set-agent --surface <s> --type <type>` | `terminal_type` declare の効果検証 |
| 実験操作 | `c11 set-title --source <src> "<title>"` | precedence gate の検証 |
| 実験操作 | `c11 send --surface <s> 'printf "\033]0;...\007"\n'` | OSC 0;TITLE\BEL を手動送信 |
| 後片付け | `c11 close-surface --surface <s>` | 実験 surface の削除 |

### 1.2 隔離 surface の作り方

- 自分の workspace (`workspace:5 elevens`) 内に `c11 new-split right` で空 shell の隔離 surface を都度作成
  - 実験 A: `surface:59`（途中 `set-agent --type claude-code` を打って terminal_type を declare した状態）
  - 実験 B: `surface:61`（`set-agent` を打たず terminal_type を declare しない状態）
- 既存 live surface（27/29/36/37/40/41/43/44）には書き込みコマンド (`send` / `rename-tab` / `set-metadata`) を一切打たず、`get-metadata` の read-only 観測のみ実施

### 1.3 env 条件

タスク文書の「条件 a/b/c × before/after」表は **claude プロセスを実際に inter­active 起動するシナリオを前提** にしているが、c11 wrapper / c11 daemon の挙動は **手動 OSC 送信 (`printf "\033]0;...\007"`)** で代用できる（claude binary は同じ OSC を吐く設計のため）。本調査では実機 interactive claude 起動は最小限に留め（API quota とリスクのため）、OSC 送信ベースで切り分けた。`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` の効果は claude binary の strings に flag が存在することで間接確認。

---

## 2. 実測結果（条件別 before/after）

### 2.1 観測 0: live surface の現状（最初の Trust 観測）

`c11 get-metadata --surface <s> --sources` の結果（一部抜粋）:

| surface | role | title | title source/ts | `terminal_type` | 備考 |
|---|---|---|---|---|---|
| 26 | Manager | `[26] Manager` | explicit @ 1779479346.575 | (なし) | 健全 |
| 27 | Conductor (live) | `[27] Claude Code` | **explicit @ 1779479348.090** | (なし) | **上書き済み** |
| 28 | reserved Conductor | `[28] Claude Code` | **explicit @ 1779479348.245** | (なし) | **上書き済み** |
| 29 | Master | `[29] Master` | explicit @ 1779479351.501 | (なし) | 健全 |
| 36/37/40/41/43/44 | idle Agent | `[NN] Claude Code` | **explicit @ 1779481369-1779481996** | (なし) | **すべて上書き済み**、`lifecycle_state = throttled` |
| 58 | 自分 (live Agent) | `[58] Agent` | explicit @ 1779487517.876 | (なし) | 観測時点では健全 |

判明事項:
- **上書きされた title の source は全て `explicit`**（`osc` ではない）→ 「last-write-wins の負け」を経由した経路で、`explicit` source で誰かが `[N] Claude Code` を上書きしている
- **どの上書き surface にも `terminal_type` の declared メタデータが存在しない**（`set-agent --type claude-code` が実行された痕跡がない）
- 健全 (`[N] Manager` / `[N] Master`) と上書き済み (`[N] Claude Code`) の差は **claude プロセスを起動するか否か**（Manager は claude を起動しない、Master/Conductor/Agent は起動する）
- 上書き済み surface の title timestamp は `1779479348` (= 2026-05-22 18:09:08 JST) 周辺で凍結し、その後 `lifecycle_state = active` / `claude.session_id` などが新しい timestamp で append されても title だけ更新されない（= manager の renameTab(`[N] Conductor` / `[N] Agent`) が **その後一度も呼ばれていない**）

### 2.2 実験 A: terminal_type=claude-code を declare した surface での OSC 反応（surface:59）

| Step | コマンド | title 値 | source@ts | 備考 |
|---|---|---|---|---|
| A0 | `new-split right --title "[TEST-A] Initial"` | (empty) | — | `--title` フラグは metadata `title` を書かない |
| A1 | `rename-tab --surface 59 "[TEST-A] Fixed-by-rename-tab"` | `[TEST-A] Fixed-by-rename-tab` | **explicit @ 1779487787.208** | **rename-tab の default source = explicit と確定** |
| A2 | `set-agent --type claude-code --model claude-opus-4-7` | (同上) | explicit @ 1779487787.208 | `model = claude-opus-4-7 [declare]` + `terminal_type = claude-code [declare]` が追加。title は未変化 |
| A3 | `send 'printf "\033]0;OSC-MANUAL-TEST\007"\n'` | **`[59] Claude Code`** | **explicit @ 1779487810.085** | **🚨 OSC 受信を契機に `[N] Claude Code` で explicit 上書きされた**。OSC ペイロード (`OSC-MANUAL-TEST`) は反映されていない |
| A4 | `set-agent --type bash-shell` （terminal_type 変更） | (同上) | (上書き残存) | terminal_type を `bash-shell` に変更 |
| A5 | `rename-tab "[TEST-A] BeforeOSC2"` | `[TEST-A] BeforeOSC2` | explicit @ 1779487879.273 | 再 rename |
| A6 | `send 'printf "\033]0;NEW-OSC\007"\n'`（同じ OSC を再送） | `[TEST-A] BeforeOSC2` | explicit @ 1779487879.273 | **terminal_type が `bash-shell` だと OSC は title を書き換えない！** |

### 2.3 実験 B: terminal_type を declare しない surface での OSC 反応（surface:61）

| Step | コマンド | title 値 | source@ts | 備考 |
|---|---|---|---|---|
| B0 | `new-split right` | (empty) | — | |
| B1 | `rename-tab "[TEST-B] NoAgent-Fixed"` | `[TEST-B] NoAgent-Fixed` | explicit @ 1779488142.883 | |
| B2 | `send 'printf "\033]0;OSC-NO-AGENT\007"\n'` | **`[61] Claude Code`** | **explicit @ 1779488144.837** | **🚨 terminal_type 未宣言でも OSC で `[N] Claude Code` が explicit に書かれた！** |
| B3 | `rename-tab "[TEST-B] After-OSC-Restored"`（復元） | `[TEST-B] After-OSC-Restored` | explicit @ 1779488170.175 | 上書き復元 |
| B4 | 3 秒待機 + `echo hello` send + 同じ OSC 再送 | (上記のまま) | explicit @ 1779488170.175 | **書き換えが再発しない！** B2 と挙動が異なる |
| B5 | `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --print "..."` を起動 | (上記のまま) | explicit @ 1779488170.175 | `--print` モードでは OSC が出力されず、書き換えなし |

### 2.4 再現性まとめ（条件マトリクス）

| 条件 | terminal_type | trigger | 書き換え発生？ | 書き換え時 source / 値 |
|---|---|---|---|---|
| A3 | claude-code (declared) | rename-tab 直後の OSC 受信 | **Yes** | explicit / `[N] Claude Code` |
| A6 | bash-shell (declared) | rename-tab 直後の OSC 受信 | **No** | — |
| B2 | (未宣言) | rename-tab 直後の OSC 受信 | **Yes** | explicit / `[N] Claude Code` |
| B4 | (未宣言) | rename-tab → 待ち → OSC 受信 | **No** | — |
| B5 | (未宣言) | `claude --print` (非インタラクティブ) | **No** | — |

---

## 3. writer の特定

### 3.1 結論: writer は c11 自身（c11 内部のロジック）

- 書き換えの source は **explicit**（osc でも declare でもない）
  - c11 SKILL.md の precedence `explicit > declare > osc > heuristic` が正しいなら、OSC 由来の書き換えは elevens の explicit `[N] Conductor` を上書きできないはず。にもかかわらず実測では explicit で上書きされている → c11 が **内部的に explicit source で書く別経路** を持っている
- elevens のコードで `c11 set-title` や `c11 set-metadata --key title` を呼ぶ箇所は **存在しない**（grep 確認: `skills/cmux-team/manager/c11-features.ts:setMailbox` は `mailbox.*` キー専用、title key には書かない）
- c11 wrapper (`/Applications/c11.app/Contents/Resources/bin/claude`) は `CMUX_CLAUDE_HOOKS_DISABLED=1` が立つと line 101-109 で即 real claude に exec パススルーし、`c11 set-agent` も呼ばない
- ところが Conductor (`surface:27`) の env は `CMUX_CLAUDE_HOOKS_DISABLED=1` で wrapper を bypass しているのに、title は `[27] Claude Code [explicit]` に上書きされている → **wrapper 由来ではない別経路**
- 実験 B2 で **`set-agent` 呼び出し履歴がない（terminal_type 未宣言の）隔離 surface でも** `[N] Claude Code` への explicit 上書きが再現した → 書き手は wrapper の `set-agent` ではない
- 書き換え値は **`[N] Claude Code` で固定**（OSC ペイロード `OSC-NO-AGENT` / `OSC-MANUAL-TEST` は完全に無視されて c11 内部 template が使われた）

以上から、**書き手は c11 daemon 自身**（ターミナル output から OSC を受信したときに、内部の自動命名 template `[<surface_num>] Claude Code` を **explicit source で** メタデータに書く挙動）。c11 binary の strings に `"Claude Code is the default active install (grandfathered exception)"` という文字列が存在することと整合する。

### 3.2 idle (`[N] Claude Code`) と recap は同一機構か？

**同一機構と推定（直接 confirm は未達）**。根拠:
- メタデータの `title` キーは `get-metadata` で見ると上書き済み surface すべてで `[N] Claude Code` 固定。recap 文字列はメタデータ側には書かれていない
- UI で見える「タブに recap が一時的に表示される」現象は、c11 UI レイヤーが **OSC 受信時の動的ラベル表示** を別経路で描画している可能性が高い（メタデータ title key は固定値 `[N] Claude Code`、UI overlay が OSC ペイロードを一時表示）
- どちらも trigger は claude プロセスが出力する OSC 0;TITLE\BEL シーケンス → 同根

ただし「recap がメタデータ title key に書かれない（UI レイヤーのみ）」のか「メタデータにも書かれるが極めて短時間で c11 が `[N] Claude Code` に再書き換えする」のかは、interactive claude を起動して recap が出る瞬間に `--sources` を叩き続けないと確定できない（Phase 2 の検証項目）。

### 3.3 timestamp が elevens renameTab(t0) より後か？

**Yes**（実験 A で確認）:
- A1: rename-tab 後 `title = ... [explicit @ 1779487787.208]`
- A3: OSC 受信後 `title = [59] Claude Code [explicit @ 1779487810.085]`
- **22.877 秒後の last-write-wins**（OSC を契機に c11 が後から書く）

### 3.4 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` で writer は止まるか？

**理論上は止まる、ただし実機 interactive claude 起動による完全 verification は未達**。根拠:
- real claude binary の strings に `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 文字列が存在 → claude 本体が OSC タイトル出力を抑止する env として実装されている
- 実験 B5 で `claude --print` 起動（非インタラクティブ・OSC を出さないモード）では title 書き換えが発生しなかった → OSC を出さない経路では writer が起動しない
- 上記 2 点から、interactive 起動でも `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` で claude が OSC を吐かなければ c11 の writer は起動しないと推定できる
- ただし、**c11 が OSC 以外の trigger（例えば socket 経由の `claude-hook` イベント）からも `[N] Claude Code` を書く別経路を持っていないか**は本実験では否定しきれない（要 Phase 2 検証）

---

## 4. fix 層の結論

### 4.1 断定: fix は **claude 側の OSC 抑止**（`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`）が最小最善

根拠:
- writer は c11（≒ AGPL、コードを読めない / patch を直接当てられない）
- writer は `terminal_type` 宣言の有無に関係なく動く（実験 B2）→ elevens 側で「`set-agent` を打たない」「terminal_type を declare しない」だけでは止まらない
- writer の trigger は **OSC エスケープシーケンス**（実験 A3/B2 で確認） → OSC を発生源（claude binary）で抑止すれば trigger が起きない
- 実験 B5 で OSC を発さない claude 起動モードでは書き換えが発生しなかった → 抑止経路として有効

逆に **OSC 抑止だけで足りない（= 「explicit writer を構造的に抑える」必要がある）** ケースは、本調査の範囲では再現できなかった。OSC を完全に止めれば c11 writer も止まると推定。

### 4.2 ただし残るリスクと Phase 2 で検証すべきこと

1. **interactive claude 起動 + `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` で実際に title が `[N] Conductor` / `[N] Agent` のまま固定されるか**（本調査では未達）
2. **OSC 以外の trigger が c11 内部にあるか**（claude-hook 経由など。CMUX_CLAUDE_HOOKS_DISABLED=1 で hook を bypass している前提では関係しないはずだが、確認は必要）
3. **`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` が将来の claude version で失効しないか**（claude binary に依存）

### 4.3 上流 fix の選択肢（参考）

- **c11 にバグ報告**: 「OSC 受信時に source=explicit で書いているが、precedence 仕様 `explicit > osc` と矛盾する。source=osc で書くべき」 → 修正されれば elevens 側の `[N] Conductor`(explicit) が勝つようになる
- ただし c11 は AGPL でコードを読めない / 修正タイミングを elevens がコントロールできない → **elevens 側の workaround を優先**

---

## 5. dead flag `CMUX_NO_RENAME_TAB` の現状（grep 結果）

### 5.1 set されている箇所（書き込み専用）

| ファイル:行 | 設定値 | 文脈 |
|---|---|---|
| `skills/cmux-team/manager/main.ts:3300` | `process.env.CMUX_NO_RENAME_TAB = "1"` | `cmdSpawnConductor` 起動時 |
| `skills/cmux-team/manager/main.ts:3388` | `process.env.CMUX_NO_RENAME_TAB = "1"` | `cmdLaunchMaster` 起動時 |
| `skills/cmux-team/manager/main.ts:3637` | `CMUX_NO_RENAME_TAB=1`（exportVars に追加） | `cmdSpawnAgent` の Agent shell 環境変数 |
| `skills/cmux-team/manager/conductor.ts:134` | `CMUX_NO_RENAME_TAB: "1"` | `launchConductor` の env オブジェクト |

### 5.2 参照されている箇所

- **elevens 自身: 0 件**（コメント引用を除く）
  - `conductor.ts:328` はコメント引用のみ（`// 初回 assign 時に kill+spawn → cmdSpawnConductor が CMUX_NO_RENAME_TAB=1 を立てるので …`）
- **c11 wrapper (`/Applications/c11.app/Contents/Resources/bin/claude`): 0 件**（grep 確認済）
- **c11 binary (`/Applications/c11.app/Contents/Resources/bin/c11`): 0 件**（`strings | grep CMUX_NO_RENAME_TAB` 0 件）

### 5.3 結論

`CMUX_NO_RENAME_TAB` は **誰も読まない完全な dead flag**。子プロセスに env を伝えても効力なし。元々は wrapper / c11 daemon に「Tab rename を抑止せよ」と伝える設計だったと推測されるが、consumer が未実装 / 削除されたまま。fix 実装時に同時削除すべき（または再利用するなら c11 側との protocol 設計が必要）。

---

## 6. fix 候補の提案（次フェーズ Planner 向け）

### 6.1 推奨: 最小修正案 — 全 claude spawn 経路に `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` を注入

writer の trigger（OSC）を発生源で止める方針。注入が必要な経路は以下:

| ファイル:行 | 経路 | 現状 env | 追加すべき env |
|---|---|---|---|
| `skills/cmux-team/manager/conductor.ts:129-135` | `launchConductor` (resume / 初回 reserved の Conductor 起動) | `CMUX_SURFACE` / `CMUX_CLAUDE_HOOKS_DISABLED=1` / `CMUX_TEAM_MAIN_BRANCH` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` / `CMUX_NO_RENAME_TAB=1` | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |
| `skills/cmux-team/manager/main.ts:3294-3305` | `cmdSpawnConductor`（assign 時の kill+spawn） | `CMUX_NO_RENAME_TAB=1` / `CMUX_CLAUDE_HOOKS_DISABLED=1` / `ANTHROPIC_BASE_URL` | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |
| `skills/cmux-team/manager/main.ts:3385-3392` | `cmdLaunchMaster` | 同上 | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |
| `skills/cmux-team/manager/main.ts:3628-3640` | `cmdSpawnAgent` の `exportVars` | `ROLE` / `PROJECT_ROOT` / `CMUX_SURFACE` / `CMUX_NO_RENAME_TAB=1` / `CMUX_CLAUDE_HOOKS_DISABLED=1` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |
| `skills/cmux-team/manager/main.ts:5593` | `cmdRestartTask` の restart 経路 | `CMUX_SURFACE` / `CMUX_CLAUDE_HOOKS_DISABLED=1` | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` |

5 箇所すべてに同じ env を追加すれば、4 ロール（Master / Conductor / Agent）と 1 経路（restart）の全 claude spawn が抑止される。Manager は claude を起動しないため対象外。

### 6.2 同時に dead flag を削除

5.2 で示した `CMUX_NO_RENAME_TAB` の 4 箇所の set 文を削除する。コメント引用 (`conductor.ts:328`) も整理する。

### 6.3 効果検証（Phase 2 で実施）

1. 上記 fix を当てた状態で `elevens start` → Conductor / Agent / Master の各 surface の title が `[N] <Role>` のまま保たれ、`get-metadata --sources` で source=explicit が elevens の renameTab timestamp で固定することを確認
2. interactive claude session で recap が出る作業をさせて、title が `[N] Claude Code` や recap に書き換わらないことを確認
3. もし依然書き換わる場合は「OSC 以外の trigger」の存在が確定。その場合の追加 fix 候補:
   - **renameTab の後追い再実行**: SESSION_STARTED hook を契機に `[N] <Role>` を 1〜2 秒後にもう一度 explicit 書き込み（race 解消）
   - **mailbox `mailbox.role` などで UI 側にロール表示を逃がす**: title を c11 に任せて、別 metadata key で UI 表示を制御

### 6.4 上流（c11）への報告（並行）

- 「`rename-tab` / 自動命名で source=explicit を書いているが、`explicit > osc` の precedence 仕様と矛盾する。**c11 自身の自動命名は source=heuristic か source=declare 相当が望ましい**」と c11 にバグ報告
- 報告すれば elevens の `[N] Conductor (explicit)` が precedence 上 勝つようになり、env 注入が不要になる将来パスがあり得る

---

## 7. 補足: live surface の干渉禁止について

調査中、live surface（27 = Conductor / 29 = Master / 36/37/40/41/43/44 = idle Agents）には `c11 send` / `c11 rename-tab` / `c11 set-metadata` を一度も発行していない。`c11 get-metadata` のみで観測した（read-only）。

実験用に作成した surface（59、61）は調査完了後に `c11 close-surface` で確実に閉じる（後片付け）。
