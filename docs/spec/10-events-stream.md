# 10. Events Stream

> 外向け event channel `.team/logs/events.jsonl` の schema 仕様。
> Manager daemon が emit し、Master の watch mode（`/cmux-team:watch`）や
> `cmux-team events` CLI から購読される。
> writer 実装は `skills/cmux-team/manager/events-writer.ts`（T358 で新設予定）。

---

## 1. 概要

events stream は Manager daemon が外部 reader 向けに公開する **イベントチャネル** である。daemon プロセス内部の `EventBus`（`notifyStateChanged` / `onStateChanged`）とは異なるレイヤーに位置し、以下の用途を満たす:

- Master の **watch mode** が状態変化（タスク完了 / Conductor 切断 / AskUserQuestion 等）をリアルタイム検出する一次ソース
- `cmux-team events` CLI が tail / filter で購読する
- 外部ツール（Slack 通知、ダッシュボード等）が JSONL を自由に消費できる append-only stream として残る

**主な reader**:

| reader | 用途 |
|--------|------|
| `cmux-team events --follow`（T359） | CLI からの tail / filter |
| Master watch mode（T360） | AskUserQuestion 等の介入要 event を検知 |
| 外部 tail（`tail -F`、log shipper 等） | 自由用途 |

**daemon 内部 EventBus との関係**:

| 観点 | EventBus（`eventBus.ts`） | events stream（本 spec） |
|------|---------------------------|--------------------------|
| スコープ | daemon プロセス内 | プロセス境界をまたぐ外向け |
| 媒体 | Node.js EventEmitter | `.team/logs/events.jsonl`（ファイル） |
| 履歴 | 残らない（fire-and-forget） | append-only で全履歴保持 |
| 用途 | TUI refresh のトリガー | 外部 reader への通知・監査 |

EventBus が「**実 state mutation → TUI refresh**」の疎結合接続を担うのに対し、events stream は「**state mutation → 外部 reader への通知**」を担う。両者は独立したチャネルである。

---

## 2. ファイル仕様

| 項目 | 値 |
|------|-----|
| path | `.team/logs/events.jsonl`（project root 相対） |
| format | JSONL（1 行 1 record） |
| 改行 | LF |
| encoding | UTF-8 |
| ordering | append-only、event 発火順。同一プロセス内では `ts` 単調増加を保証する努力義務 |
| writer | Manager daemon および `cmux-team artifacts add` CLI。それ以外の外部 writer は未サポート |
| reader | `tail -F` / `cmux-team events --follow` / Master watch mode |
| 推奨 mode | append + line-buffered fsync。truncate / `O_TRUNC` 禁止 |

複数 writer の混在は想定しない（daemon は 1 プロセスのみ稼働、`pidfile` で多重起動防止済み）。

---

## 3. 共通 field

すべての record は以下 3 field を必ず含む。各 event の §6 詳細表からは省略する。

| field | type | required | description |
|-------|------|----------|-------------|
| `ts` | string (ISO 8601 with ms + `Z`) | ✓ | event 発火時刻。例: `"2026-04-27T12:34:56.789Z"`（UTC、ミリ秒精度） |
| `event` | string (snake_case) | ✓ | event 種別。§5 の typed event 19 種（writer 側 union は 21 種で運用、reader formatter は 17 種を整形 — 末尾 §5.7 注記）のいずれか、または §6.20 user-signal の自由文字列。reader は unknown 値を受信しても skip して継続する（`--types` 明示購読時の取り扱いは §8） |
| `schema_version` | integer | ✓ | 現行値 `2`。breaking change 時に bump。詳細は §4 |

レコード例:

```json
{"ts":"2026-04-27T12:34:56.789Z","event":"task_assigned","schema_version":2,"task_id":"T357","conductor_surface":"surface:5","task_run_id":"task-357-1777260538"}
```

---

## 4. Schema versioning

- **現行 `schema_version = 2`**。本 spec で確定する schema を v2 として扱う。
- 背景: issue #42 の iteration 1 を v1 ドラフトとして追跡し、棚卸し後の確定版を v2 と位置づけたため、初版の `schema_version` は `1` ではなく `2` から始まる。
- **bump 条件（breaking change）**:
    - 既存 event の必須 field を削除
    - 既存 event の必須 field の意味変更（型変更含む）
    - event 名の rename
- **bump しないケース（additive）**:
    - 新 event の追加
    - 既存 event への optional field 追加
    - `reason` / `kind` 等の enum への値追加
- **bump 方針**: bump は spec 改訂と同時に行い、writer / reader の両方を一気に切り替える。並行 schema は維持しない。reader は `schema_version` を見て古い / 新しいレコードを skip + 警告ログするフォールバック実装を持つこと（§8）。

---

## 5. Event 一覧

合計 **19 typed event 種** + **User signal（free-form, 1 event family）**。Task lifecycle 8 種 + Conductor lifecycle 8 種 + Artifact lifecycle 1 種 + Worktree lifecycle 1 種 + Daemon lifecycle 1 種、加えてユーザー側 best-effort 投稿用の自由 type 名 event（§6.20）。

### 5.1 Task lifecycle（8 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.1 | `task_created` | `create-task` で新規 task 作成 | task 一覧 refresh |
| 6.2 | `task_ready` | task が `ready` に昇格（sync guard 通過後） | assign 待ちキュー観測 |
| 6.3 | `task_assigned` | Conductor に割り当て成功 | running task の追跡 |
| 6.4 | `task_completed` | 正常完了（`close-task` 経由） | Master が PR merge / cleanup を判断 |
| 6.5 | `task_completed_state_mismatch` | T274 auto-close 経路の異常完了 | Master 介入要 |
| 6.6 | `task_aborted` | あらゆる abort 遷移 | Master 介入要 |
| 6.7 | `task_sync_guard_rejected` | Ready 昇格時の sync guard reject | user escalation |
| 6.8 | `task_reverted_to_ready` | `assigned → ready` 巻き戻し（救済経路） | retry 観測 |

### 5.2 Conductor lifecycle（8 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.9 | `conductor_running` | `assigning → running` 遷移 / `disconnected → running` resume | task 開始の確認 |
| 6.10 | `conductor_recovered` | `disconnected → idle/running` 復帰 | 自然回復の可視化 |
| 6.11 | `conductor_disconnected` | `disconnected` 状態に入った | 切断 通知 |
| 6.12 | `conductor_asking` | AskUserQuestion 受信（Notification hook） | watch mode の主用途 |
| 6.13 | `conductor_done_unresolved` | `CONDUCTOR_DONE success=false unresolved=true`（T269） | Master 介入要（最強 signal） |
| 6.14 | `conductor_start_timeout` | `STARTING_TIMEOUT_SEC`（60s）超過 | 起動失敗の検知 |
| 6.15 | `conductor_assign_timeout` | `ASSIGNING_TIMEOUT_SEC`（60s）超過 | assign 失敗の検知 |
| 6.16 | `conductor_disconnect_timeout` | `DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告 | user 介入の窓を提供 |

### 5.3 Artifact lifecycle（1 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.17 | `artifact_added` | artifact が追加された | observatory での知見追跡 |

### 5.4 Worktree lifecycle（1 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.18 | `worktree_archived` | cleanup 経路で worktree が `.team/worktrees-archive/` に archive された (T011) | 作業内容の保全観測・retrospective 分析 |

### 5.5 Daemon lifecycle（1 event）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.19 | `reload_failed` | TUI `r` reload で child の spawn が失敗した (T013) | Master / TUI の異常検知（3 経路通知のうち events.jsonl 担当、spec §15.5.1） |

### 5.6 User signal（free-form, 1 event family）

| # | event | 概要 | 主な reader 用途 |
|---|-------|------|------------------|
| 6.20 | 自由文字列 | `elevens events emit --type <name> ...` 経由でユーザー / スクリプト / 別セッションが投稿する best-effort signal | セッション間の軽量協調（deploy 通知 / pair-programming hand-off / 自前 milestone 観測等） |

### 5.7 writer union と reader formatter の現状差分（注記）

- writer 側 `EventStreamRecord` union（`events-writer.ts`）は **21 種** を持つ（上記 19 種 + `api_error_received` + `mailbox_changed` — いずれも add-only で schema_version は bump しない）
- reader 側 `events-cli.ts` の `TEXT_FIELDS` / `KNOWN_EVENTS` は **17 種** で、`mailbox_changed` / `artifact_added` / `reload_failed` / `worktree_archived` の formatter が未追加
- この乖離は T029 のスコープ外で、独立 follow-up として扱う。本節は事実の記録（spec §5 ヘッダ / 内訳表は現状の運用範囲 19 を維持）

---

## 6. 各 event の payload schema

> 共通 field（`ts` / `event` / `schema_version`）は各表から省略。
> surface ID は `surface:N` 形式（cmux の `identify` 出力に揃える）を一次表記とする。`conductor-1` 等の人間可読名は別名であり、writer 実装（T358）では surface ID をそのまま埋める。

### 6.1 `task_created`

新規 task が `create-task` CLI で作成された時に emit。`status: ready` で作成された場合は直後に `task_ready` も emit される。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | `T123` 形式（`TNNN`）。slug は含めない |
| `title` | string | ✓ | task.md frontmatter の `title:` |

### 6.2 `task_ready`

`update-task --status ready` 成功時 / `create-task --status ready` 成功時に emit。sync state guard を通過済み。reject 時は本 event は出ず、代わりに `task_sync_guard_rejected`（§6.7）が出る。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |

### 6.3 `task_assigned`

`assignTask` 成功（`ASSIGN(ok)`）。Conductor が `assigning → running` に進む経路の起点。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | 例: `surface:5` |
| `task_run_id` | string | ✓ | `task-NNN-TIMESTAMP` 形式 |

### 6.4 `task_completed`

正常完了。`CONDUCTOR_DONE success=true` 経路で `assigned → closed` 遷移後に emit。T274 auto-close（state が `assigned` のまま DONE が返る経路）は **本 event ではなく** `task_completed_state_mismatch`（§6.5）を出す。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | 絶対パス。Master が PR merge 後に cleanup する判断材料 |
| `journal_summary` | string | ✓ | task-state.json の journal から末尾 N 件を要約した文字列。空でも `""` を出す |

### 6.5 `task_completed_state_mismatch`

T274 auto-close 経路。Conductor が `close-task` を呼ばずに DONE を返した（`success=true` だが state が `assigned` のまま）異常完了。watch mode では本 event を受信したら `journal_summary` を必ず読み、user 介入を判断する。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `missing_close_task`（現状唯一の値。将来追加余地） |
| `worktree_path` | string | ✓ | |
| `journal_summary` | string | ✓ | |

### 6.6 `task_aborted`

`assigned → aborted` または `draft/ready → aborted` のすべての遷移で emit。reason で発火源を区別する。cascade（親 abort → ready 子 → draft）は **本 event を出さない**（§ Implementer 注意 / cascade スコープ）。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | 下表 6 値のいずれか |
| `journal_summary` | string | ✓ | |

`reason` enum（6 値）:

| value | 発火源 |
|-------|--------|
| `judgment_pending` | `CONDUCTOR_DONE success=false unresolved=true`（T269）。並行して `conductor_done_unresolved`（§6.13）も emit |
| `disconnect_timeout` | `DISCONNECT_TIMEOUT_SEC`（300s）超過の forced close 完了後 |
| `user_clear` | `running` 中に手動 `/clear` を検出（`SESSION_CLEAR(manual)`） |
| `assign_failed` | `ASSIGN(err)` のうち sync guard 以外の理由（sync guard reject は `task_sync_guard_rejected` に切り出される） |
| `resume_marked_aborted` | resume 時に `task-state.json` 上で既に `aborted` だった task を確認した記録 |
| `other` | 上記いずれにも該当しないフォールバック（将来用） |

### 6.7 `task_sync_guard_rejected`

`update-task --status ready` / `create-task --status ready` 時の sync state guard で reject された場合に emit。`task_aborted reason=assign_failed` から切り出した独立 event。watch mode はこの event を受信した時点で user に escalation する。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `kind` | string enum | ✓ | `diverged` / `uncommitted` / `detached` / `auto_pull_failed` |
| `detail` | string | ✓ | 詳細メッセージ（`git status` / `git pull` stderr 等） |
| `main_branch` | string | ✓ | `mainBranch` 解決値（例: `main`） |

### 6.8 `task_reverted_to_ready`

D1〜D4 / M1 / M3 の救済経路で `assigned → ready` に巻き戻った時に emit。reason で再起原因を伝える。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `reason` | string enum | ✓ | `worktree_missing` / `launch_failed` / `unmatched` / `unique_violation` / `overflow` |

### 6.9 `conductor_running`

Conductor が `assigning → running` に進んだ時、または `disconnected → running` で resume した時に emit。task_id とのペアリング確認用。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | ✓ | running 中の task |

### 6.10 `conductor_recovered`

`disconnected → idle/running`（PID watcher または `SESSION_STARTED` の再到達）で復帰した時に emit。`conductor_disconnected`（§6.11）とペアになる。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `new_status` | string enum | ✓ | `idle` / `running` |

### 6.11 `conductor_disconnected`

`SESSION_ENDED(stop)` / `PID_DIED` / `ASSIGN(err=conductor)` で disconnected に入った時に emit。timeout 前の警告は §6.16。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `reason` | string enum | ✓ | `session_ended` / `pid_dead` / `assign_failed` |
| `task_id` | string | optional | disconnected 時に running 中だった task ID（idle 状態で disconnect した場合は省略可） |

### 6.12 `conductor_asking`

`SESSION_ASK`（Notification hook の AskUserQuestion）で `asking` 状態に入った時に emit。Master watch mode の主用途のひとつ。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `question` | string | ✓ | AskUserQuestion 本文 |

### 6.13 `conductor_done_unresolved`

`CONDUCTOR_DONE success=false unresolved=true`（T269 judgment_pending 経路）。Master 介入要の最強 signal。本 event の emit と並行して `task_aborted reason=judgment_pending`（§6.6）も emit される。**重複ではなく、「Conductor の終了原因」と「Task の状態確定」を別軸で記録する設計**。reader は両方を index して同じ `task_id` で関連付ける。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | |
| `conductor_surface` | string | ✓ | |
| `worktree_path` | string | ✓ | preserveWorktree 経路なので worktree は残っている |
| `journal_summary` | string | ✓ | |

### 6.14 `conductor_start_timeout`

`STARTING_TIMEOUT_SEC`（60s）超過。`starting → disconnected` に入った時に emit。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `elapsed_ms` | integer | ✓ | timeout 値（既定 60000） |

### 6.15 `conductor_assign_timeout`

`ASSIGNING_TIMEOUT_SEC`（60s）超過。`assigning → disconnected` 遷移時に emit。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_run_id` | string | ✓ | timeout した assignment の `taskRunId` |
| `elapsed_ms` | integer | ✓ | 既定 60000 |

### 6.16 `conductor_disconnect_timeout`

`DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告。`disconnected → broken` への遷移自体は forced close 完了後に `task_aborted reason=disconnect_timeout`（§6.6）を出す。本 event は user 介入の窓を提供するための事前通知。

| field | type | required | description |
|-------|------|----------|-------------|
| `conductor_surface` | string | ✓ | |
| `task_id` | string | optional | broken 化対象の task（idle 中に disconnect していた場合は省略可） |
| `elapsed_ms` | integer | ✓ | 既定 300000 |

### 6.17 `artifact_added`

`cmux-team artifacts add`（および `/elevens:artifact` 経由）でアーティファクトが追加された時に emit。`addArtifact()`（`skills/cmux-team/manager/artifact.ts`）の末尾で `events-writer` 経由に書き出す。`author` は呼び出し時の `process.env.CMUX_SURFACE` または既存 frontmatter の `author:` から決定する（未設定なら `"unknown"`）。`task_id` は frontmatter の `task:` がある場合のみ含まれる。

| field | type | required | description |
|-------|------|----------|-------------|
| `artifact_id` | string | ✓ | `A045` 形式（`ANNN`） |
| `artifact_path` | string | ✓ | projectRoot 相対のパス。例: `.team/artifacts/A045-foo.md` |
| `artifact_type` | string | ✓ | `research` / `decision` / `session` / `spec` / `report` |
| `title` | string | ✓ | frontmatter `title:` |
| `author` | string | ✓ | surface ID（例: `surface:100`）または `"unknown"` |
| `task_id` | string | optional | frontmatter `task:` が指定された場合のみ（例: `T038`） |

### 6.18 `worktree_archived`

T011: 「正常完了以外」の cleanup 経路で worktree が `.team/worktrees-archive/<taskRunId>/` に物理 `mv` で archive された時に emit。`archiveWorktree()` (`skills/cmux-team/manager/worktree-archive.ts`) の末尾で `events-writer` 経由に書き出す。

| field | type | required | description |
|-------|------|----------|-------------|
| `task_id` | string | ✓ | canonical task id (数字のみ、例: `"094"`) |
| `task_run_id` | string | ✓ | 例: `"task-094-1778998001"` |
| `reason` | string | ✓ | `disconnect_timeout` / `abort_task` / `reset_conductor` / `clear_conductor` / `user_clear` / `restart` / `assign_terminal_race` / `resume` / `done_unresolved` / `other` |
| `archive_path` | string | ✓ | projectRoot 相対。例: `".team/worktrees-archive/task-094-1778998001"` |
| `archived_at` | string | ✓ | ISO 8601 UTC。`mv` 完了時刻のドメイン値で、meta.json `archived_at` と同値。`ts` (writer 自動付与の event flush 時刻) とは概念分離 [M1] |
| `branch` | string | ✓ | 例: `"task-094-1778998001/task"` (archive 後も main repo に残る) |
| `uncommitted_changes` | boolean | ✓ | mv 前の `git status --porcelain` 行数 > 0 |
| `last_commit_sha` | string | optional | mv 前の `git rev-parse HEAD`。取得失敗時は省略 |

詳細は `docs/spec/16-worktree-archive.md` を参照。

### 6.19 `reload_failed`

T013: TUI `r` キー reload で `performDaemonReload` (`skills/cmux-team/manager/reload.ts`) が child の spawn に失敗した時に emit。reload 失敗は (i) `manager.log` の `daemon_reload_*` event、(ii) `daemon.heartbeat` の mtime 停止、(iii) 本 event の **3 経路** で並列通知される（`docs/spec/15-post-mortem-evidence.md` §5.1 参照）。schema_version は bump しない（add-only）。

| field | type | required | description |
|-------|------|----------|-------------|
| `reason` | string enum | ✓ | `child_pid_undefined` / `stderr_log_open_failed` / `spawn_threw` |
| `detail` | string | ✓ | 詳細メッセージ（spawn error message / errno 等） |

### 6.20 User signal（free-form event）

> 別経路: `emitUserSignal()` （`events-writer.ts`）。typed daemon event 用の `emitEvent(EventStreamRecord)` とは別 export で、discriminated union を一切壊さない。
> CLI: `elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...`

ユーザー / スクリプト / 別セッションが events.jsonl に **自由 type 名の signal を 1 行 append** するための経路。Manager daemon の round-trip を経由せず、CLI が直接 `appendFile` する。**best-effort** — lock / lease / 排他は無く、新しい state file も作らない。daemon が停止中でも投稿・監視できる（投稿: emit が `mkdir → append` で初回ファイル生成、監視: 既存 reader が file tail のみで動く）。

| field | type | required | description |
|-------|------|----------|-------------|
| `event` | string | ✓ | 自由 type 名。snake_case 推奨。後述の `signal:` prefix 推奨 |
| `message` | string | optional | 短い説明文 |
| `actor` | string | optional | 投稿主の識別子。`--actor` 明示 > `CMUX_SURFACE` env 自動補完。未解決なら field ごと省略 |
| `data` | object | optional | 追加メタデータ。値は文字列固定（reader 側の interpret 自由度を残す）。空 `{}` のときは field ごと省略 |

#### 推奨命名規約

- **`signal:` prefix を強く推奨**: `signal:deploy_started` / `signal:milestone_reached` 等。typed daemon event との混同防止 + reader の `--types` 絞り込みが容易
- `deploy_*` / `milestone_*` 等の慣例 prefix も可（typed event 名と衝突しない範囲で）

#### 予約名衝突 warn

`--type` の値が typed daemon event の予約名（`task_created` / `task_ready` / ... / `worktree_archived` の 21 種、`RESERVED_EVENTS` 集合）と一致する場合、CLI は **stderr に warn を 1 行出してから投稿を通す**（exit 0、hard block しない）:

```
warn: --type <name> は typed daemon event 名と衝突します（投稿は通します）。
      `signal:` prefix の使用を推奨します。例: --type signal:deploy_started
```

reader 側は `data` フィールドの有無や `task_id` 等 typed payload の不在で typed event と user signal を区別できる。

#### Reader 動作（重要）

別セッションが `elevens events --follow --types signal:deploy_started,signal:deploy_finished` でこの signal を拾えるよう、`events-cli.ts` の `processLine` は「unknown event は **`--types` で明示購読された場合のみ通す**、それ以外は従来通り skip + warn」と動く。詳細は §8。

#### 投稿例

```bash
# 単発投稿（最小）
elevens events emit --type signal:deploy_started --message "rolling out v1.2.3"

# data field 付き
elevens events emit --type signal:deploy_finished --data version=v1.2.3 --data env=prod

# actor を明示
elevens events emit --type signal:milestone --actor surface:42 --message "phase 2 unlocked"

# 別セッションが拾う
elevens events --follow --types signal:deploy_started,signal:deploy_finished --format text
```

#### スコープ外（明示）

| 項目 | 理由 |
|------|------|
| lock / lease / 排他 | best-effort 設計。POSIX `O_APPEND` の atomicity に依存する |
| 新規 state file | events.jsonl 1 本に集約 |
| daemon round-trip | CLI が直接 append（daemon 停止中でも投稿可） |
| 予約名 hard block | warn のみ（task 要件） |
| `--data` の type 推論 | string 固定（reader 側で解釈） |
| rotate / retention 個別ポリシー | §7 に従う |

---

## 7. Retention policy

**方針: 無制限 append（rotate なし）+ GC は別タスクで横断的に扱う**

- `events.jsonl` は単一ファイルへ append 専用
- rotate / archive / 自動削除は **行わない**
- 既存の `.team/logs/manager.log` および `.team/traces/traces.db` も同様に単一 append + 自動 GC 未実装。`events.jsonl` だけ rotate ポリシーを別建てにすると一貫性が崩れる
- watch mode の live tail と相性が良い（rotate すると fd 切り替え時に event ロストリスク）
- reader は単純な append-only stream として扱える
- 生成レートが低い（task 1 件あたり 5〜10 record 程度の見積もり）

手動 GC 運用例:

```bash
# 直近 100,000 行に圧縮（live tail 中の操作は非推奨）
tail -n 100000 .team/logs/events.jsonl > .team/logs/events.jsonl.tmp
mv .team/logs/events.jsonl.tmp .team/logs/events.jsonl
```

> **将来の retention 設計は `.team/` 全体の GC ポリシーとして別タスクで扱う**。`events.jsonl` 単独で rotate / size limit を入れることはしない。

---

## 8. Reader 実装ガイドライン

writer は本 spec のとおり emit するが、reader は **forward-compatible** に書くこと:

- `schema_version` が想定より大きい record は **skip + 警告ログ**（強制 abort しない）
- 未知 `event` 値は **skip + 警告ログ**（強制 abort しない）。ただし `--types` で明示購読された event 名は通す（§6.20 user-signal の Done 条件「`elevens events --follow --types signal:deploy_started` で別セッションが拾える」を満たすため）
- 必須 field 欠損は **警告ログ + skip**
- `reason` enum / `kind` enum は将来値追加を許容するため、watch logic は exhaustive switch ではなく default branch を持つこと
- JSON parse 失敗行は **skip + 警告ログ**（部分書き込みの torn write を許容）

reader の責務は「自分が知っている event を正しく扱う」ことであり、「unknown を遮断する」ことではない。

### 8.1 「reader 無改修」原則と user-signal 緩和の解釈

T029 task 文の §スコープには「reader（events-cli）は無改修」と記載されているが、本 spec ではこれを **「CLI 引数 interface（`--types` / `--since` / `--format` / `--follow`）と既存挙動（`--types` 無指定時の unknown event skip + warn）を維持する範囲」** と解釈する。`processLine` 内部 filter logic は §6.20 Done 条件（自由 type を `--types` で購読して拾える）を満たすため最小限緩和する。

具体的には:

- `--types` **無指定**時の unknown event 受信 → 従来どおり skip + warn（regression なし）
- `--types signal:foo` 等で **明示購読** された unknown event → 通す（user-signal を Done 条件で拾うため）

緩和は user-signal のためだけでなく、writer 側 union が `EventStreamRecord` で 21 種に到達している一方で reader 側 `KNOWN_EVENTS` が 17 種に留まっている既存の差分（§5.7）に対しても、`--types` 明示購読時の取り扱いを統一する。

---

## 9. 関連 spec / 関連タスク

- [`07-state-machine.md`](07-state-machine.md) — Conductor / Task FSM の遷移と本 spec の event 名の対応関係。`task_completed_state_mismatch` / `task_reverted_to_ready` / `conductor_disconnect_timeout` 等の発火条件を裏付ける一次資料
- [`08-runtime-boundary.md`](08-runtime-boundary.md) — Deliverable / `close-task` 仕様（`task_completed` の前提）
- [`glossary.md`](glossary.md) §10「コミュニケーション系」 — `events stream` / `event channel` / `EventBus` / `Trace DB` の用語定義

**後続タスク**:

- T358 — writer 実装（`events-writer.ts` 新設、daemon の各 state mutation point からの emit 配線）
- T359 — `cmux-team events` CLI（tail / filter / `--follow`）
- T360 — Master watch mode（本 stream を購読して介入要 event で user に escalate する `/cmux-team:watch` コマンド）
- T361 — CLAUDE.md / README への反映（Master / Manager プロトコル節、外部連携節）
- T029 — `elevens events emit` CLI（best-effort user-signal、§6.20）と `processLine` の `--types` 明示購読時 unknown-event 緩和（§8.1）

**設計議論の経緯**: issue #42（schema iteration 1 → iteration 2 = v2 確定版の決着まで）。

---
