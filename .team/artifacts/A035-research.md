---
id: A035
type: research
title: "Conductor で Claude Code 純正 /goal を使えるか（hook衝突・完了検出二重化の実機検証）"
created: 2026-06-12T04:38:50.333Z
author: surface:20
---

# Research: Conductor を Claude Code 純正 `/goal` で goal-driven にできるか

- **Task**: 030-conductor-claude-code-goal-hook
- **Run**: task-030-1781238312
- **Author**: Researcher Agent
- **作業境界**: 調査・文書化のみ（本体コード未改修）。実機 probe は `/tmp/goal-probe-030`（worktree・本番 `.team/` 外）で実行し、終了後に削除済み。

---

## 1. 概要 / TL;DR

**判定: 条件付き可能（ただし「そのまま Conductor を goal-driven 化」は非推奨）。**

- **要件は満たす**: spawn 経路の `claude` は **v2.1.175**（要件 v2.1.139+ をクリア）。`/goal` は disable されていない（`disableAllHooks` / `allowManagedHooksOnly` どちらも未設定）。
- **hook は衝突しない**: elevens の Stop hook（`detect-ask.sh`）は**常に `exit 0` でブロックしない純粋な forwarder**。`/goal` の session-scoped Stop hook と**加算的に共存**できることを実機で確認した（benign Stop hook が `/goal` ループ中に発火しつつ `/goal` の継続判定を妨げなかった）。
- **真の問題は hook 衝突ではなく「完了検出の二系統が無協調」**: elevens の完了は `close-task` → `CONDUCTOR_DONE`（done マーカー）で駆動され、`/goal` の継続/クリアとは**完全に独立**。`/goal` を素朴に Conductor に被せると、(a) `/goal` 評価器が「達成」と判断しても `close-task` は呼ばれず task が `assigned` のまま残る、(b) `close-task` 後も `/goal` 評価器が未達なら session が継続して余計な作業を続ける、という**順序ずれ**が起きうる。
- **FSM は壊れない（が完了もしない）**: `assigned→closed` は `SESSION_IDLE` ではなく `CONDUCTOR_DONE` で遷移する。`/goal` 継続中もターン境界ごとに `SESSION_IDLE` は届くが、これは「タスク実行中の正常イベント」として無害に扱われる（`running` を維持）。つまり `/goal` は FSM を破壊しないが、FSM の完了トリガにも寄与しない。

→ 純正 `/goal` は「Conductor 内で局所的にゴール駆動ループを回す道具」としては利用可能。だが elevens の完了プロトコル（`close-task`）と `/goal` の終了条件を**一致させる接着**が別途必要で、それは結局「measurable condition + independent gate」を elevens 側 protocol に組み込む作業に等しい。**案A（思想移植）に進む価値あり**。

---

## 2. 調査結果

### 論点1 — 要件充足（バージョン / バイナリパス）

実機確認:

```
$ claude --version
2.1.175 (Claude Code)
$ which claude
/Applications/c11.app/Contents/Resources/bin/claude
```

- spawn 経路の claude も**同一バイナリ**。Conductor は `cmdSpawnConductor` 内で `execFileSync("claude", claudeArgs, { env: process.env })` を呼ぶ（`skills/cmux-team/manager/main.ts:3392`）。`claude` は PATH 解決され、`command -v claude` = 上記 c11.app バンドル版に一致する。
- 公式要件: `/goal` requires Claude Code **v2.1.139 or later**（[goal docs](https://code.claude.com/docs/en/goal.md) の Note）。**2.1.175 ≥ 2.1.139 → 充足**。
- `/goal` 無効化条件（同 docs "Requirements"）: `disableAllHooks` が任意レベルで設定、または managed settings の `allowManagedHooksOnly`。**生成される `*-conductor-settings.json` にどちらも無い**（`generateConductorSettings` の全文を確認、`main.ts:3053-3191`）。Conductor は `--dangerously-skip-permissions` 起動（`main.ts:3255`）で trust dialog 要件も満たす（実機 probe でも trust エラーなく `/goal` が走った）。

**結論（論点1）**: 要件は完全に満たす。

### 論点2 — hook 衝突（Stop hook の取り合い）

**elevens 側 Stop hook の実体**: Conductor の `--settings` に注入される `*-conductor-settings.json` の `hooks.Stop` は、`detect-ask.sh`（`DETECT_ASK_SCRIPT`）1 本だけ（`main.ts:3146-3155`）。その本体は:

```bash
# cmux-team Stop hook forwarder (T189)
PAYLOAD="$(cat)"
... printf '{"type":"SESSION_STOP",...}' | elevens send --from-stdin || true
printf %s "$PAYLOAD" | c11 claude-hook stop 2>/dev/null || true
exit 0
```

→ **stdin を読んで daemon に転送するだけ。`decision: block` を一切返さず常に `exit 0`**（`main.ts` の `DETECT_ASK_SCRIPT` 定義）。ASK/IDLE の判定は hook ではなく**daemon 側 `classifyStopPayload`**（`classify-stop.ts`）が transcript 末尾から事後分類する pull 型。

**`/goal` 側の機構**（[goal docs](https://code.claude.com/docs/en/goal.md) "How evaluation works"）:
> `/goal` is a wrapper around a session-scoped prompt-based Stop hook. ... A "no" tells Claude to keep working ... A "yes" clears the goal.

→ `/goal` は**セッションスコープの Stop hook を別途登録**し、turn 毎に小型モデルが評価して block（継続）/ allow（終了）を決める。

**衝突するか**: Claude Code は同一 Stop イベントに複数 hook を登録でき、すべて実行する。elevens の forwarder は allow 固定なので、`/goal` の block 判定を上書き/妨害しない（block と allow が混在したら block が勝ち継続する）。逆に forwarder は `/goal` の継続有無に関わらず毎ターン daemon へ `SESSION_STOP` を送るが、これは無害（論点4 参照）。

**env による hook 制御の確認**:
- `CMUX_CLAUDE_HOOKS_DISABLED=1` は Conductor spawn 時に必ず注入される（`main.ts:3352`、`conductor.ts:131,618`、`main.ts:5756` の restart 経路）。ただしこれは **cmux ラッパー側 hook を無効化する env であって、Claude Code の `disableAllHooks` ではない**。elevens はラッパー hook を切ったうえで自前 hook を `claude --settings` で動的注入する設計（`docs/spec/05-install-and-infrastructure.md:40`）。よって Claude Code の hooks システム自体は生きており、`/goal` は使える。
- `.envrc` / `direnv` 依存は spawn 経路では不要（同 spec、explicit export が authoritative）。

**実機検証**（隔離環境、論点5 と共通）: elevens の forwarder を模した benign Stop hook（`exit 0`、ログ追記のみ）を `--settings` に入れた状態で `/goal` を headless 実行 → `/goal` は正常に走り、Stop hook も発火（`stop-hook.log` に 1 行）、両者が**共存**した。

**結論（論点2）**: **衝突しない**。elevens の Stop hook が allow 固定 forwarder である構造ゆえ、`/goal` の Stop hook と加算共存できる。片方が無効化される事象も観測されなかった。

### 論点3 — 完了検出の二重化

elevens の完了検出は **Manager の pull 型**:
- Conductor が `close-task` CLI を実行 → `CONDUCTOR_DONE`（`success=true`）メッセージを daemon へ送信（`main.ts:4847-4865`）。
- done マーカーファイル + PID watcher で Manager が検出（CLAUDE.md「完了検出」、`docs/spec/07-state-machine.md:338`「正常完了 → `close-task` → `CONDUCTOR_DONE success=true`」）。

`/goal` の完了は **session 内ループの評価器が「達成」と判断 → goal を clear** するだけで、`close-task` を呼ぶ責務は持たない。両者は**独立した別系統**。具体的な干渉リスク:

1. **取りこぼし**: `/goal` 評価器が「達成」と判断して clear しても、Conductor が `close-task` を呼ばなければ task は `assigned` のまま。Manager は done マーカー/PID 死亡を待ち続け、最終的に disconnect timeout で forced close になるまで宙吊り。
2. **行き過ぎ**: Conductor が `close-task` を呼んで完了報告しても、`/goal` 評価器が「未達」と判断すれば session は継続し、closed 後の worktree（`CONDUCTOR_DONE success=true` で**物理削除される**、`docs/spec/07-state-machine.md:471`）に対して追加作業を試みて壊れる恐れ。

**結論（論点3）**: データ破壊的な二重発火ではないが、**「`/goal` の終了」と「`close-task` の完了」が無協調**。素朴な被せ方では順序ずれ（宙吊り / closed 後継続）が起きる。両者を一致させる接着が必須。

### 論点4 — FSM 齟齬（`SESSION_IDLE` と `assigned→closed`）

`docs/spec/07-state-machine.md` と daemon 実装の照合:

- **`assigned→closed` のトリガは `CONDUCTOR_DONE` であって `SESSION_IDLE` ではない**（spec L270 `assigned --> closed : CLOSE`、L338-339 の遷移表。`SESSION_IDLE` は Conductor 状態機械側の event で Task FSM を遷移させない）。
- daemon の `SESSION_IDLE` ハンドラ（`daemon.ts:2986-3093`）は Conductor の liveness 管理のみ（`asking→running/idle`、`disconnected→running/idle`、`starting→idle`）。`taskRunId` がある間は `running` を維持し、**task を close しない**。コード内コメントが明示: 「Stop hook はターン境界ごとに発火するため、**タスク実行中でも `SESSION_IDLE` は来る**」（`daemon.ts:3043`）。
- `SESSION_STOP` は `classifyStopPayload` で ASK/IDLE に分類され（`daemon.ts:2951-2983`）、`AskUserQuestion` が無ければ `SESSION_IDLE` に合成 → 上記の無害経路へ。

→ `/goal` が継続中に毎ターン `SESSION_IDLE` を流しても、Manager は「実行中の正常イベント」として吸収する。**FSM は破壊されない**。一方で `/goal` の継続は `CONDUCTOR_DONE` を生まないので、**FSM の完了にも寄与しない**（論点3 の宙吊りと表裏）。

**結論（論点4）**: 齟齬による誤遷移は起きない（`SESSION_IDLE` は完了トリガではない）。ただし `/goal` は完了トリガを供給しないため、完了は依然 `close-task` 頼み。

### 論点5 — 最小実験（実施した）

**実施した。** 本番 `.team/` を汚さないため `/tmp/goal-probe-030`（worktree 外）で隔離実行し、終了後に `rm -rf` 済み。本番 proxy（`ANTHROPIC_BASE_URL=http://127.0.0.1:60372`）と `CMUX_SURFACE` 等は `env -u` で除去し、`timeout 150` で hard cap。

**セットアップ**: elevens の `detect-ask.sh` を模した benign Stop forwarder（stdin を読みログ追記、`exit 0`）を `--settings` の `hooks.Stop` に登録:

```json
{ "hooks": { "Stop": [ { "matcher": "",
  "hooks": [ { "type": "command", "command": "bash /tmp/goal-probe-030/stop-fwd.sh", "timeout": 5000 } ] } ] } }
```

**実行**:
```
env -u ANTHROPIC_BASE_URL -u CMUX_SURFACE -u CMUX_CLAUDE_HOOKS_DISABLED \
  timeout 150 claude --dangerously-skip-permissions \
    --settings /tmp/goal-probe-030/settings.json \
    -p "/goal create a file named DONE.txt containing the text OK ...; or stop after 2 turns"
```

**結果**（`exit=0`）:
- 出力: 「DONE.txt を作成しました(内容: `OK`)。ゴール条件を満たしたので完了です。」
- `DONE.txt` が `OK` 内容で生成された（`/goal` の作業ターンが実走）。
- `stop-hook.log` に `STOP_HOOK_FIRED` が **1 行**（benign Stop hook が `/goal` ループと共存して発火、かつ `/goal` の達成判定を妨げなかった）。

**この実験が示すこと**: ① 純正 `/goal` が v2.1.175 + `--dangerously-skip-permissions` + ユーザー `--settings`（Stop hook 入り）で起動・完走する、② allow 固定の Stop hook が `/goal` と共存する（論点2 の裏付け）、③ trust dialog 要件は `--dangerously-skip-permissions` で満たされる。

**この実験が示さないこと**: 完全な Conductor 環境（proxy 経由・本物の `conductor-settings.json`・role prompt・`close-task` 連携）での E2E。論点3 の「`/goal` clear と `close-task` の無協調」は静的解析（コード/spec 読み合わせ）に基づく推論で、実 Conductor での再現は未実施（本番 state 破壊リスクと時間制約のため見送り）。

---

## 3. 判定

**条件付き可能。**

| 論点 | 評価 |
|------|------|
| 1 要件充足 | ✅ 満たす（v2.1.175 ≥ 2.1.139、disable 条件なし、trust は skip-permissions で充足） |
| 2 hook 衝突 | ✅ 衝突しない（elevens Stop hook は allow 固定 forwarder で `/goal` と加算共存。実機確認済み） |
| 3 完了検出 | ⚠️ 無協調（`/goal` clear と `close-task`/`CONDUCTOR_DONE` が独立 → 順序ずれリスク） |
| 4 FSM 齟齬 | ✅ 誤遷移なし（`assigned→closed` は `CONDUCTOR_DONE` 駆動、`SESSION_IDLE` 無害） |

**根拠**: 技術的前提（要件・hook 共存）はクリアで「純正 `/goal` は Conductor セッション内で動かせる」。だが elevens の完了は `close-task` という明示 CLI アクションで駆動される pull 型プロトコルであり、`/goal` の session-scoped 終了条件と**接続されていない**。`/goal` をそのまま被せても「ゴール駆動ループ」と「タスク完了プロトコル」が二重管理になり、宙吊り/行き過ぎを生む。→ **「そのまま使える」ではなく「動かせるが、完了プロトコルとの接着を自作する必要がある」= 条件付き可能。**

---

## 4. Recommendation

**案A（measurable condition + independent gate の思想移植）に進むべき。** 純正 `/goal` を Conductor に直接被せる選択（案: 純正そのまま利用）は**非推奨**。理由:

1. `/goal` の評価器は **transcript-only**（[docs](https://code.claude.com/docs/en/goal.md) "It does not call tools, so it can only judge what Claude has already surfaced"）。「テストが通った」と Conductor が書けば実行せずとも達成扱いになりうる。elevens が重視する**独立検証（independent gate）には構造的に不足**。
2. 完了プロトコル（`close-task`/`CONDUCTOR_DONE`/done マーカー/worktree 物理削除）と `/goal` 終了条件が無協調（論点3）。接着を書くなら、結局「measurable condition を定義し、独立 gate で判定して `close-task` を駆動する」elevens 固有のループになる。これは案A そのもの。
3. elevens の設計原則「上位が下位を pull 監視」「決定論はコード、判断は AI」に対し、`/goal` は session 内自律ループ（下位が自走）で**思想が逆向き**。純正をそのまま採ると observatory 性（Manager pull 監視・trace 完全性）を損なう懸念。

**進む順序（層1 / 層2）**: **層1（measurable condition の言語化・テンプレート化）から**着手すべき。

- **層1 先行**: Conductor/Agent の task prompt 規約に「測定可能な done 条件（コマンド名・exit code・成果物パス等、実行でしか生成できない証拠）」を必須化する。これは既存の `close-task --deliverable-kind`（`docs/spec/07-state-machine.md:224`）と親和的で、テンプレート（`skills/cmux-team/templates/`）+ spec 改訂のみで read-side 寄りに導入できる。`/goal` から借りるべきは**この condition 記述法**であって評価器ではない。
- **層2 後続**: 独立 gate（Conductor とは別 surface/別モデルが transcript+実行証拠を検証して `close-task` 可否を判定）は層1 の condition が固まってから。daemon/FSM への配線を伴うため、最小スコープを別途設計し PoC で検証する。

> 純正 `/goal` の使いどころが全く無いわけではない: Conductor 配下の **Agent** が単一の閉じた作業（例: 「全テスト green になるまで」）を回す局所ツールとしてなら、完了プロトコルと衝突しない範囲で実験的に併用する余地はある。ただし本タスクの主題（Conductor 全体の goal-driven 化）には案A が適。

---

## 5. 参考文献・出典

**公式ドキュメント**
- Claude Code `/goal` docs — https://code.claude.com/docs/en/goal （要件 v2.1.139+、評価器 transcript-only、disableAllHooks/allowManagedHooksOnly での無効化、trust 要件、session-scoped prompt-based Stop hook）
- `.md` 版 — https://code.claude.com/docs/en/goal.md

**elevens コード（worktree: tracked files）**
- `skills/cmux-team/manager/main.ts:3053-3191` — `generateConductorSettings`（Conductor の hooks 全文、Stop=detect-ask.sh、disableAllHooks 無し）
- `skills/cmux-team/manager/main.ts`（`DETECT_ASK_SCRIPT` 定義）— Stop forwarder が `exit 0` 固定でブロックしない
- `skills/cmux-team/manager/main.ts:3247-3265` — `buildConductorClaudeArgs`（`--dangerously-skip-permissions` / `--settings` / slash command 無効化フラグ無し）
- `skills/cmux-team/manager/main.ts:3301-3399` — `cmdSpawnConductor`（`CMUX_CLAUDE_HOOKS_DISABLED=1` 注入 `:3352`、`execFileSync("claude",...)` `:3392`）
- `skills/cmux-team/manager/main.ts:4847-4865` — `CONDUCTOR_DONE` 送信（完了は close-task 駆動）
- `skills/cmux-team/manager/classify-stop.ts` — daemon 側 pull 型 ASK/IDLE 分類
- `skills/cmux-team/manager/daemon.ts:2951-3093` — `SESSION_STOP`→`SESSION_IDLE` 合成と liveness 管理（task を close しない）

**spec / CLAUDE.md**
- `docs/spec/07-state-machine.md:224,270,338-340,471` — `assigned→closed` は `CONDUCTOR_DONE` 駆動、worktree 物理削除条件
- `docs/spec/05-install-and-infrastructure.md:40` — `CMUX_CLAUDE_HOOKS_DISABLED=1` は cmux ラッパー hook 無効化 + `--settings` 動的注入が authoritative

**実機コマンド**
- `claude --version` → `2.1.175 (Claude Code)`
- `which claude` → `/Applications/c11.app/Contents/Resources/bin/claude`
- 隔離 `/goal` probe（`/tmp/goal-probe-030`、実行後削除）→ `exit=0`、`DONE.txt` 生成、benign Stop hook が共存発火
