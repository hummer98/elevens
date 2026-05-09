---
id: A031
type: report
title: c11 claude-hook 仕様確認 + daemon mailbox watcher の round-trip smoke
author: surface:auto
date: 2026-05-10
related:
  - .team/artifacts/A029-c11-parity-and-phase2-prep.md
  - .team/artifacts/A030-mailbox-watch-and-pty-validation.md
  - skills/cmux-team/manager/daemon.ts
  - skills/cmux-team/manager/main.ts
---

## 1. daemon mailbox watcher の round-trip smoke（PROJECT_ROOT 隔離）

### Setup

`/tmp/elevens-smoke-<ts>/` を fresh PROJECT_ROOT として作成し、`initDB` で trace DB を、`emitEvent` 経由で `events.jsonl` を生成する harness（`/tmp/elevens-mailbox-smoke.ts`）を実行。`spawnConductorMailboxWatcher(state, conductor)` で c11 surface:5 に対する watcher を起動し、別シェルから `elevens mailbox set/clear` を打って round-trip を観察。

### 結果

```
[smoke] PROJECT_ROOT=/tmp/elevens-smoke-1778347223636
[smoke] surface=surface:5 backend=c11
[smoke] watcher started, sleeping 8s for external mailbox.* events...

[smoke] hook_signals MAILBOX_CHANGED rows = 2
   2026-05-09T17:20:28.177Z metadata { kind: "added",   key: "mailbox.smoke_status", value: "running" }
   2026-05-09T17:20:29.919Z metadata { kind: "changed", key: "mailbox.smoke_status", value: "done", previous: "running" }

[smoke] events.jsonl lines = 2
   2026-05-09T17:20:28.177Z mailbox_changed surface:5 added:mailbox.smoke_status
   2026-05-09T17:20:29.919Z mailbox_changed surface:5 changed:mailbox.smoke_status
```

- **trace DB**: `hook_signals` に `type='MAILBOX_CHANGED'` / `source='metadata'` で 2 行記録（既存 source enum と非衝突）
- **events.jsonl**: `mailbox_changed` 2 行（1 tick = 1 record）
- 3 番目の clear イベントは 8 秒の harness window と poll interval (1.5s) のタイミングで取りこぼし。プロダクションでは watcher は daemon 寿命中ずっと動くため問題にならない

### 確認できたこと

- `spawnConductorMailboxWatcher` が **本番のコードパス**（real traces.db, real events.jsonl, real c11 daemon）を通って動く
- mailbox.* の設定 → daemon watcher 検知 → trace DB / events stream 記録の dual-write が成立
- ConductorState に保存した `mailboxWatcherStop` で teardown も成立

---

## 2. c11 `claude-hook` の仕様確認（重要な発見）

### 検証

```
$ c11 --json get-metadata --surface surface:5
  → metadata: { title, lifecycle_state }

$ echo '{"session_id":"abc","stop_hook_active":true,...}' | c11 claude-hook stop --surface surface:5
OK

$ c11 --json get-metadata --surface surface:5
  → metadata: { title, lifecycle_state }   # 変化なし
```

### 結論: `c11 claude-hook stop` は surface metadata を **書き換えない**

- `OK` を返す（exit 0）が、`get-metadata` で見える `metadata` / `metadata_sources` は不変
- workspace metadata / pane metadata も同様に変化なし
- c11 capabilities の method 一覧にも agent/hook 系の write method は無い（あるのは `workspace.remote.terminal_session_end` のみ）

### 解釈

A029 §4 で「`c11 claude-hook stop` で mailbox.\* が自動更新される」と仮説したが、**外形的には外部 API を通した可視 metadata は変化しない**。c11 daemon の内部 state（sidebar UI の表示、surface の "idle" 表記など）には作用している可能性が高いが、**`watchMailbox` で観測できる経路には乗らない**。

### 再評価された Phase 2 のレイヤー分担

| 経路 | 何をする | 観測できるか |
|---|---|---|
| `elevens mailbox set --key mailbox.status --value done` | surface metadata に explicit な mailbox.\* を書き込む | ✅ `watchMailbox` / `get-metadata` |
| `c11 claude-hook stop` | c11 daemon に session lifecycle を signal | ✅ c11 内蔵 UI / ❌ get-metadata |

→ **両方を併用するのが正解**。前者で構造化観察、後者で c11 native の UI 連動。本リリースの commit `612462c` は両方を hook script で並行発火する。

---

## 3. Phase 2 完了状況（A029 plan 対応）

| A029 計画項目 | 状態 | コミット |
|---|---|---|
| mailbox.\* を Conductor / Agent prompt に組み込む | ✅ | `769ef58` |
| Manager の metadata-poll loop | ✅ | `309537c`（実機 round-trip 確認 §1） |
| AgentDetector 置換（claude-hook stop） | ✅（ただし上記 §2 caveat） | `612462c` |
| JSON-RPC 直叩き SDK | ⏳ deferred — CLI 経由で十分 | — |

## 4. 次セッション以降の宿題

- **dual-write 期間の比較統計**: trace DB の `hook_signals WHERE source='metadata'` と既存 `done` marker 経由の到達タイミング差を cohort 比較。1〜2 週運用してから `cmux-team-analyze` で集計
- **2nd workspace を blueprint 経由で作成して workspace-level non-focus PTY 検証**（Phase 1 task #7 の本来スコープ、A030 から継続）
- **JSON-RPC 直叩き SDK** は CLI spawn コストが問題化したら着手
- **mailbox.\* schema の formalize**: 現状 `mailbox.role` / `mailbox.status` を non-formal で書いているが、`docs/spec/` に正式 schema を置いて将来の Manager 機能（task FSM 統合等）の足場にする
