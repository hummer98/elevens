---
id: 018
title: Conductor/Agent のタブタイトルが [N] Claude Code に書き換わる回帰の調査・修正（c11 SessionStart hook）
priority: high
created_by: surface:29
created_at: 2026-05-22T20:37:29.306Z
---

## タスク
## 症状

surface のタブタイトルが、elevens が付けた `[N] Conductor` / Agent 名から **`[N] Claude Code`** に書き換わることがある（条件依存）。ユーザーは「c11 本体の暗黙的 hook が原因では」と推測しており、調査の結果その推測が正しいと確定した。

## 原因（確定）

### 正体: c11 wrapper が注入する SessionStart hook
`/Applications/c11.app/Contents/Resources/bin/claude`（c11 の PATH wrapper）は、c11 ターミナル内で `claude` 起動時に `--settings <tempfile>` で 6 個の hook を注入する（wrapper L183 の HOOKS_JSON）:
- `SessionStart → c11 claude-hook session-start` ほか stop / session-end / notification / prompt-submit / pre-tool-use

この `c11 claude-hook session-start`（c11 本体側）が surface の title を claude デフォルト表示名 **`[N] Claude Code`** に設定する。これが書き換えの実体。

### 唯一効く抑止は CMUX_CLAUDE_HOOKS_DISABLED=1
wrapper L101:
```bash
if [[ "$IN_C11" == "0" || "${CMUX_CLAUDE_HOOKS_DISABLED:-}" == "1" ]] || ! c11_socket_available; then
  exec "$REAL_CLAUDE" "$@"   # hook 注入せずパススルー
fi
```
hook 注入を止められるのは **claude プロセスの実 env に `CMUX_CLAUDE_HOOKS_DISABLED=1` がある**場合のみ。
- **`CMUX_NO_RENAME_TAB` は wrapper にも `c11 claude-hook --help` の env にも一切登場しない**。これは using-cmux（旧 cmux）時代の env で、c11 substrate へ移行（T015/T016 で cmux backend 撤廃）した後の `c11 claude-hook session-start` は参照していない。

### 回帰の経緯: T432 の修正が c11 で無効化
CHANGELOG T432 は「reserved Conductor のタブ名が `[N] Claude Code` に上書きされる問題」を `launchConductor()` の env に **`CMUX_NO_RENAME_TAB=1`** を追加して修正した。しかし c11 移行でこの env が無効になったため、**reserved Conductor 経路で回帰**している。

### 実機の証拠
- 現在の `c11 tree`: 本来 `[27] Conductor` `[28] Conductor` であるべき surface が **`[27] Claude Code` `[28] Claude Code`** に化けている（surface:36〜44 も `[N] Claude Code`）。一方 elevens が `renameTab` で明示設定した `[26] Manager` `[29] Master` は維持。
- `.team/logs/manager.log`（2026-05-23 04:49）: `conductor_reserved C[27]` / `conductor_reserved C[28]` で起動された reserved Conductor が該当。

## 発生する経路（claude プロセス実 env に HOOKS_DISABLED が届かないもの）

1. **reserved Conductor の初回 assign 起動**（最有力。今回の証拠）。`conductor.ts:328` のコメントが言及する kill+spawn → `cmdSpawnConductor` 経路。`cmdSpawnConductor`（main.ts:3300-3301）は `process.env` に `CMUX_NO_RENAME_TAB=1` + `CMUX_CLAUDE_HOOKS_DISABLED=1` を立てるが、claude を `cmux.send(surface, "...")` でペインのシェルに送って起動する場合、process.env ではなく **送信コマンドの inline env / 先行 export** に HOOKS_DISABLED が無いと claude に渡らない。ここを要確認。
2. **send 経由の再起動**（main.ts:5593）は `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1` を先行 send しており一応カバーされている（NO_RENAME_TAB は無いが HOOKS_DISABLED があるので可）。reserved/launch 経路が同等になっているか比較する。
3. **c11 restore（再起動復元）**: c11 が `cc --resume <id>` で claude を起動するため、elevens の env は構造的に付かない。elevens 単独では塞げない（下記対策2）。

## 修正方針（実装判断は Agent に委ねる。論点）

1. **`CMUX_NO_RENAME_TAB` 依存の撤廃**。全 claude 起動経路（特に reserved Conductor / launchConductor / send 経由）で `CMUX_CLAUDE_HOOKS_DISABLED=1` が **claude プロセスの実 env に確実に渡る**ことを保証する。send 起動経路は inline env prefix（`CMUX_CLAUDE_HOOKS_DISABLED=1 claude ...`）か先行 export を全経路で統一。reserved → launch 経路の env 注入を main.ts:5593 の restart 経路と突き合わせる。
2. **restore 経路の self-heal**（elevens の env が構造的に付かない経路への対策）。elevens は自前 hook を `conductor-settings.json` 経由で `--settings` 注入しており SessionStart hook を持つ。起動後に `cmux.renameTab(surface, "[N] Conductor")` を呼び戻してタイトルを再設定する案。c11 hook と elevens hook の発火順序に注意（c11 が後勝ちなら効かない）。minimal scope を優先し、Manager の定期巡回 self-heal は次善とする。
3. **ドキュメント/コメント更新**。`CMUX_NO_RENAME_TAB` が c11 では無効である旨を CLAUDE.md / docs/spec / 関連コメントに明記。CHANGELOG に T432 回帰として記録。

## 検証

- 手動: reserved Conductor を起動し、初回タスク assign で claude が起動した後に `c11 tree` でタブ名が `[N] Conductor` のまま維持されることを確認。
- 手動: `CMUX_CLAUDE_HOOKS_DISABLED=1` 付き / 無しで claude を c11 内起動し、title 上書きの有無を比較（hook が原因であることの再現）。
- 既存テスト: `cd skills/cmux-team/manager && bun test --timeout 30000 conductor.test.ts`（spawn-conductor 関連）。`bun test` 全体実行は禁忌。

## 関連ファイル
- c11 wrapper: `/Applications/c11.app/Contents/Resources/bin/claude`（L101 gating, L183 HOOKS_JSON）※ AGPL のため読むのみ・取り込み禁止
- `skills/cmux-team/manager/conductor.ts`（env 設定 L115/131/134/603、reserved 経路コメント L328）
- `skills/cmux-team/manager/main.ts`（cmdSpawnConductor L3300-3301、spawn-master L3388-3389、spawn-agent L3637-3638、restart send 経路 L5593）
- `skills/cmux-team/manager/cmux.ts`（renameTab L224-231）
- `skills/c11/SKILL.md`（§6 PATH wrapper / hook、§4 title metadata、L226 パススルー条件）
- `CHANGELOG.md`（T432: 旧 NO_RENAME_TAB 修正の記録）
