---
name: c11
description: >
  elevens のコードを書く・読む・議論する際、c11 (Stage-11-Agentics/c11) の概念や API
  を使うときに参照する。Triggers: "c11" / surface manifest / lineage / mailbox /
  flash / blueprint / snapshot / `c11 tree` / `c11 set-metadata` / `c11 send` /
  `c11 mailbox` / `c11 trigger-flash` / `CMUX_SHELL_INTEGRATION` /
  `C11_SHELL_INTEGRATION` / `CMUX_SURFACE_ID` / `CMUX_SOCKET_PATH` /
  `ELEVENS_BACKEND=c11` / cmux との差分。
  Provides: c11 の lineage・概念モデル・cmux にない独自機能・主要 CLI cheat-sheet・
  PATH wrapper 方式・elevens 4 層との接続点。本家 SKILL.md (AGPL) のフルコピーではなく、
  elevens 開発に必要な範囲の自前要約。詳細は本家へのリンクで誘導する。
---

# c11 — elevens 開発者向けリファレンス

elevens は **c11 (Stage-11-Agentics/c11) を substrate として動く**。`ELEVENS_BACKEND=c11` で c11 を使い、`cmux` (manaflow-ai/cmux) は legacy backend として残る（v0.3.0 で c11 が default 化予定）。

このドキュメントは elevens 開発時に Claude が参照する用の自前要約。本家の正規スキルは [Stage-11-Agentics/c11/skills/c11/SKILL.md](https://github.com/Stage-11-Agentics/c11/blob/main/skills/c11/SKILL.md)（AGPL-3.0-or-later, 537行）。**API の最終真実はそちら**。ここに書いてあるのは elevens 開発で頻出する範囲の cheat-sheet。

## 1. lineage と elevens との関係

```
GNU Screen (1987) → tmux (2007) → cmux (2026 Feb, manaflow-ai)
                                     ↓
                                  c11 (2026 Apr, Stage-11-Agentics)
```

- c11 は cmux のソース fork ではなく、思想と一部機能（embedded browser など）を継承した **macOS native ターミナル**。Swift/AppKit + libghostty。
- elevens は元々 cmux-team として cmux 上で動いていた。**c11 = "Stage 11" → eleven** の語呂で **elevens** に rebrand 済み（v0.3.x 系）。
- cmux 互換 env (`CMUX_*`) は c11 でも引き続き dual-read。primary は `C11_*`。

## 2. 環境検出

```bash
# c11 / cmux 内かどうか
[ "$CMUX_SHELL_INTEGRATION" = "1" ] || [ "$C11_SHELL_INTEGRATION" = "1" ]
```

子プロセスに渡る env var:

| 変数 | 内容 | 備考 |
|---|---|---|
| `CMUX_SURFACE_ID` / `C11_SURFACE_ID` | 自分の surface UUID | **正しい**。タブ・送信ターゲット指定に使う |
| `CMUX_WORKSPACE_ID` / `C11_WORKSPACE_ID` | workspace UUID | |
| `CMUX_TAB_ID` | **要注意**: c11 の現バージョンでは workspace UUID が誤って入る。tab-scoped command は `--surface "$CMUX_SURFACE_ID"` を必ず明示する |
| `CMUX_SOCKET_PATH` / `C11_SOCKET_PATH` | Unix domain socket | デフォルト `/tmp/cmux.sock` |
| `CMUX_SOCKET_PASSWORD` | socket auth | |
| `CMUX_AGENT_TYPE` / `_MODEL` / `_TASK` / `_ROLE` | エージェント宣言 pre-seed | spawning shell が設定 |

## 3. 概念モデル（4 階層）

```
Window (macOS top-level)
 └─ Workspace (sidebar tab; title / git branch / cwd / ports / notifications)
     └─ Pane (split region within a workspace)
         └─ Surface (terminal | browser | markdown viewer; pane 内では tab として複数持てる)
```

ref は UUID / short ref / index どれでも: `window:1`, `workspace:1`, `pane:2`, `surface:3`, `tab:1`

## 4. cmux にない c11 独自機能（差分が一番重要）

### 4.1 Surface manifest

各 surface に紐づく **open-ended JSON metadata blob**（per-surface 上限 64 KiB）。socket 経由で全エージェントが read/write できる。

**Canonical keys**（c11 が UI に rendering する）:

| Key | Type | Renders |
|---|---|---|
| `role` | string ≤64 | sidebar label |
| `status` | string ≤32 | sidebar pill |
| `task` | string ≤128 | sidebar monospace tag |
| `model` | string ≤64 | sidebar chip |
| `progress` | number 0.0–1.0 | sidebar progress bar |
| `terminal_type` | string ≤32 | sidebar chip |
| `title` | string ≤256 | titlebar + sidebar tab label |
| `description` | markdown subset ≤2048 | titlebar expanded region |

それ以外の key は free-form。**precedence**: `explicit > declare > osc > heuristic`。

```bash
c11 set-metadata --surface "$CMUX_SURFACE_ID" --key status --value "running"
c11 set-metadata --surface "$CMUX_SURFACE_ID" --json '{"role":"reviewer","progress":0.4}'
c11 get-metadata                    # 自分の blob
c11 get-metadata --sources          # provenance 付き
c11 clear-metadata --key task
```

> **注意**: surface-write commands では `--surface "$CMUX_SURFACE_ID"` を必ず明示する。env-var default は古い c11 binary では他者の surface に書く事故を起こす。

### 4.2 Lineage chain (`::`) in titles

サブエージェントを spawn する pane では title に親子関係を `::` で連結:

```
Login Button :: MA Review :: Claude
```

- **親が先、子が後**。各 segment は短く（sidebar は右端から truncate）。
- **sibling workers**（オペレーターが peer pane を並べた場合）は `::` を使わず `Feature Left` / `Feature Right` 等の positional anchor。
- 既存 lineage がある状態で rename するときは `c11 get-titlebar-state` で prefix を読み、trailing segment だけ書き換える。

elevens の文脈: Conductor → Agent spawn 時にこの convention を使うと sidebar で階層が読める。

### 4.3 Inter-agent mailbox

per-workspace の **メッセージング primitive**。任意のエージェントが `_outbox/` に envelope を書くと、c11 in-process dispatcher が validate → recipient の inbox に copy → stdin-delivery 設定なら framed `<c11-msg>` block が PTY に流れ込む。

```bash
c11 mailbox send --to watcher --body "build green sha=abc"
c11 mailbox send --to watcher --topic ci.status --body "..." \
  --reply-to watcher --in-reply-to <ulid>
c11 mailbox recv --drain   # 自分の inbox を drain
c11 mailbox tail           # _dispatch.log を follow
c11 mailbox trace <ulid>   # 1 envelope の dispatch event 列
```

- envelope schema は `spec/mailbox-envelope.v1.schema.json`（version=1, ULID id, RFC3339 ts, body ≤4096 chars）
- **Stage 2 では `--to` 必須**（topic-only fan-out は Stage 3 以降）
- 受信時のデフォルト protocol: 自分が呼んでる tool 終了まで待つ → system message 扱いで処理 → `id` で dedupe（at-least-once 配信）→ 返信は `reply_to`/`from` 宛に `in_reply_to=<original-id>` で

elevens で agent 間調整が必要なら `.team/queue/` ではなく c11 mailbox を使う方が native。

### 4.4 Surface flash

非同期の attention primitive。pane content + sidebar workspace row に visual pulse を出す。

```bash
c11 trigger-flash --surface <ref>                    # one-shot
c11 trigger-flash --surface <ref> --persistent       # operator が dismiss するまで継続
c11 trigger-flash --surface <ref> --persistent --color "#FF5C5C"
c11 cancel-flash --surface <ref>
```

- `--persistent` は「いつか見て」用。focus を奪わない。focus 中の surface に出すと自動で one-shot に degrade。
- `flash_state` metadata key で他エージェントが poll 可能（`persistent` か空）
- 既存の cmux notification と違い、**focus を奪わずに operator の注意を引く**ためのチャネル。

### 4.5 Blueprint / Snapshot / Restore

```bash
c11 new-workspace --layout <path|name>      # blueprint からワークスペース構築
c11 snapshot                                 # 現在の workspace を ~/.c11-snapshots/<ulid>.json に保存
c11 list-snapshots
c11 restore <ulid>                           # 復元（fresh shells）
C11_SESSION_RESUME=1 c11 restore <ulid>     # Claude Code session も resume
```

`WorkspaceApplyPlan` という統一フォーマットで、blueprint も snapshot も同じ shape。`SurfaceSpec.command` が明示されてれば registry より優先。

### 4.6 Markdown / Browser surface

terminal 以外の surface type が first-class:

- `c11 new-pane --type markdown --file <path>` — live preview pane
- `c11 new-pane --type browser --url <url>` — embedded WKWebView
- `c11 browser click / snapshot / fill / reload / eval` — 自動操作 API

cmux にも browser はあったが、c11 は markdown も pane 化できる点が拡張。

### 4.7 Conversation store / session resume

`Resources/bin/claude` wrapper が `--session-id <uuid>` を毎回 mint し、`SessionStart` hook が `~/.cmuxterm/claude-hook-sessions.json` に登録する。`c11 restore` 時に `cc --resume <id>` で会話履歴ごと復元できる。

## 5. 主要 CLI cheat-sheet

```bash
# Orient
c11 identify                                 # 自分の workspace/surface/pane refs (JSON)
c11 tree                                     # 現 workspace の floor plan + hierarchy
c11 tree --json                              # 構造化（pixel/percent rect, split path）
c11 tree --no-layout                         # hierarchy のみ
c11 tree --window | --all                    # スコープ拡大

# Identity / titlebar
c11 set-agent --type claude-code --model claude-opus-4-7
c11 rename-tab       --surface "$CMUX_SURFACE_ID" "TICKET-42 Plan"
c11 set-description  --surface "$CMUX_SURFACE_ID" "Planning the migration ..."
c11 get-titlebar-state

# Splits / panes / surfaces
c11 new-split <left|right|up|down>           # 新 pane は必ず terminal
c11 new-pane --type browser --url <url>      # 新 pane の type 指定
c11 new-surface --pane <pane-ref>            # 既存 pane に tab 追加
c11 new-surface --no-focus                   # focus を奪わずに作成
c11 resize-pane --pane <ref> -L|-R|-U|-D --amount <px>
c11 focus-pane --pane <ref> --workspace <ref>

# Send / read
c11 send "echo hello"                        # type only（submit しない）
c11 send-key enter                           # キー単独送信
c11 send --workspace $WS --surface $SURF "..." \
  && c11 send-key --workspace $WS --surface $SURF enter
c11 read-screen --lines 80
c11 read-screen --scrollback --lines 200

# Sidebar reporting (c11 子プロセスのみ)
c11 set-status task "3/5 complete" --icon "play.fill" --color "#00FF00"
c11 set-progress 0.6 --label "3/5 subtasks"
c11 log --source "agent-name" "Finished step"
c11 list-status

# Workspace
c11 new-workspace
c11 select-workspace --workspace workspace:N
```

## 6. PATH wrapper 方式（hook の正体）

c11 は **`~/.claude/settings.json` を一切書き換えない**。代わりに c11 内のターミナルでのみ PATH 先頭に `c11.app/Contents/Resources/bin/claude` が入り、wrapper が真の `claude` を `exec` する前に以下を動的注入:

```bash
exec claude --session-id <uuid> --settings /tmp/c11-claude-hooks-$$.json "$@"
```

- hook 設定は **ephemeral tempfile**（`/tmp/c11-claude-hooks-$$.json`）
- 注入される hook は 6 個、全部 `c11 claude-hook <name>` ローカル CLI 呼び出し:
  - `SessionStart` (10s) — session_id 登録（resume 用）
  - `Stop` (10s) — sidebar status クリア
  - `SessionEnd` (1s) — Ctrl+C クリーンアップ
  - `Notification` (10s) — sidebar 通知
  - `UserPromptSubmit` (10s) — status を Running に
  - `PreToolUse` (5s, async) — permission grant 後の Needs input クリア
- c11 外、socket 不通、`CMUX_CLAUDE_HOOKS_DISABLED=1` のいずれかで完全パススルー。
- **永続書き込み先は `~/.cmuxterm/claude-hook-sessions.json` のみ**（session resume index）。tenant config (`~/.claude/settings.json`, `~/.codex/*` 等) は不変。
- `c11 install <tui>` は **rejected / off the table**。SKILL.md の references にあるその記述は古い doc artifact。

> elevens の `bin/` で `claude` を直接呼ばず c11 内で起動させる、という設計はこの wrapper を経由させるため。`claude --dangerously-skip-permissions` を子 pane で起動するのが c11 推奨パターン。`claude -p` (headless) は launchd reparent で auth chain が切れるので使わない。

## 7. PTY-only reach（c11 send の限界）

`c11 send` / `c11 send-key` は **target surface の PTY にバイト書込みするだけ**。AppKit responder chain には届かないので:

- TextBox 入力欄、設定パネル、sidebar コントロール、find overlay 等の UI は **CLI から駆動できない**
- 必要なら AccessibilityAPI / AppleScript、または c11 app 側に socket handler を追加する

## 8. elevens × c11 の交差点

elevens 4 層と c11 surface manifest の対応:

| elevens 概念 | c11 で表現 |
|---|---|
| Manager (daemon) | 独立した c11 surface (Master のサブ pane でもよい) |
| Conductor pane (常駐) | surface manifest: `role=conductor`, `task=<id>`, `status=running\|idle` |
| Agent (spawn) | new-pane 内の terminal + lineage `Conductor :: Agent :: <ticket>` |
| `.team/team.json` の masters/conductors | c11 surface metadata と二重持ちにせず、**c11 を source of truth** にする方向で統合検討 |
| `.team/output/conductor-N/done` マーカー | c11 mailbox の completion envelope で代替できる可能性 |
| 進捗 (`task-state.json`) | sidebar の `progress` / `status` で operator から見える |

elevens の **observability 思想 (4 層 + trace DB)** と c11 の **agent-native subagent visibility** は相性が良い。Manager の pull 型監視は c11 surface manifest を polling する方向に発展できる。

## 9. AGPL について

c11 本体および本家 SKILL.md は **AGPL-3.0-or-later**。elevens は MIT。

- このドキュメントは API 名・概念・公知事実の自前要約であり、本家 SKILL.md 文章のコピーではない（fair use 範囲）
- 本家 SKILL.md / source を直接コピーする場合は AGPL の derivative work になるため、必ず分離管理（vendor submodule 等）する

## 10. 詳細を本家で読む

- 本家 SKILL.md: <https://github.com/Stage-11-Agentics/c11/blob/main/skills/c11/SKILL.md>
- API リファレンス: `skills/c11/references/api.md` (本家)
- Orchestration パターン: `skills/c11/references/orchestration.md`
- Metadata 仕様: `skills/c11/references/metadata.md`
- Mailbox guide: `docs/c11-mailbox-guide.md`
- Mailbox envelope schema: `spec/mailbox-envelope.v1.schema.json`
- Session resume: `skills/c11/references/claude-resume.md`

API の挙動・引数仕様で迷ったら **必ず本家を確認**する。c11 はまだ active 開発中で、env var dual-read (`CMUX_*` ↔ `C11_*`) のような移行中の項目もあり、ここの記述が遅れている可能性がある。
