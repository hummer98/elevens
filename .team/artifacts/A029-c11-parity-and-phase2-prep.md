---
id: A029
type: research
title: c11 0.46.0 subcommand parity 検証 + Phase 2 prep（mailbox.* / JSON-RPC）
author: surface:auto
date: 2026-05-09
related:
  - docs/seed.md
  - .team/artifacts/A028-phase1-substrate-adapter-poc.md
  - skills/cmux-team/manager/cmux.ts
---

## 要約

A028（Phase 1 PoC）の延長として、(1) cmux-team が使う subcommand の cmux 0.64.3 / c11 0.46.0 parity 確認、(2) Phase 2 で必要な mailbox.* / JSON-RPC v2 / agent state 検出 API の調査、(3) Phase 2 実装プランを記録する。

## 1. Subcommand parity（cmux 0.64.3 vs c11 0.46.0）

cmux.ts が呼ぶ全 subcommand（tree / identify / read-screen / send / send-key / new-split / new-surface / close-surface / rename-tab / rename-workspace / set-status / clear-status / notify）について `--help` 比較 + read-only な動作確認を実施。

### 完全互換（差分なし）

`identify` / `read-screen` / `send` / `send-key` / `close-surface` / `rename-tab` / `rename-workspace` / `set-status` / `clear-status` / `notify`

cmux.ts の現実装は無修正でそのまま c11 でも動く。

### c11 で要注意（cmux.ts への影響あり）

- **`tree`**: c11 default は floor plan ASCII art を前置 → output が肥大化（5KB → 数十 KB）。`TREE_TIMEOUT_MS=5_000` でタイムアウトの懸念。**対策実装済み**: `IS_C11_BACKEND` 判定で text mode のとき `--no-layout` flag を自動付与（commit 同梱）
- **`tree --json`** の default scope 差: cmux=`window`、c11=`workspace`。全 workspace を取りたい場合は明示的に `--all` か `--window` 指定が必要（cmux.ts は workspace 引数を渡しているので影響なし）

### c11 で flag 仕様変更（将来分岐必要）

- **`new-split` / `new-surface`**: cmux の `--focus <true|false>` が c11 で削除、c11 は `--no-focus` 形式。cmux.ts は現在 `--focus` を渡していないので **即時破綻はしない**。将来 focus 制御を入れる時に backend 分岐が必要

### 結論

Phase 2 移行の前提として cmux.ts の subcommand 呼び出しは **概ね互換**。要対応は tree の floor plan 抑止のみで、これは本 commit で実装済み。

---

## 2. Surface metadata (mailbox.\*) API 調査

### CLI 一覧（c11 0.46.0、実機確認）

| コマンド | 用途 |
|---|---|
| `c11 set-metadata` | surface / pane に metadata 書き込み |
| `c11 get-metadata` | metadata 読み取り（`--sources` で sidecar 同梱） |
| `c11 clear-metadata` | キー削除 |
| `c11 set-agent --type ... --task ... --role ... --model ...` | `set-metadata --source declare` の syntactic sugar |
| `c11 set-workspace-metadata` ほか workspace スコープ系 | workspace metadata の CRUD |
| `c11 claude-hook session-start\|stop\|active\|idle\|...` | Claude Code 専用 hook（stdin に JSON、内部で metadata 更新） |

### 重要な flag

- `--key K --value V --type string|number|bool|json` — 単一キー、型強制
- `--json '{...}'` — 一括 merge / replace
- `--mode merge|replace`（既定 merge、`replace` は `source=explicit` のみ）
- `--source explicit|declare|osc|heuristic` — precedence layer。書き込みは layer 別 sidecar に保存され、`get-metadata --sources` で観測可能
- `--surface` と `--pane` は排他

### 実 sample（自身の Master surface、read-only）

```
$ c11 get-metadata --surface surface:3 --json --sources
{"ok":true,"id":1,"result":{
  "metadata":{"title":"[300] Master","lifecycle_state":"active"},
  "metadata_sources":{
    "lifecycle_state":{"ts":1778335308.664,"source":"explicit"},
    "title":{"source":"explicit","ts":1778336061.084}}}}
```

### mailbox.\* の挙動

- **dotted key OK**: `mailbox.role` / `mailbox.status` / `mailbox.task` / `mailbox.progress` がそのまま flat key として通る（ネスト object に展開はされない）
- **値の型**: string / number / bool / json の 4 種。`--type json` で任意 JSON が値に入り、`get` で raw JSON 文字列として戻る
- **sidecar `metadata_sources`**: 各 key ごとに `{ts, source}` が分離保存される。precedence 異なる writer（agent と operator）が衝突しない

### 落とし穴

- `clear-metadata` 直後でも `~/Library/Application Support/c11mux/session-com.stage11.c11.json` に古い値が残る（daemon の persistence layer の遅延 sync）。実 in-memory state は API 上 clear 済みだが、replay 時に古い値を拾う可能性あり

---

## 3. Socket API v2 / JSON-RPC

### Socket path 解決順

`--socket` flag → `C11_SOCKET` → `CMUX_SOCKET_PATH` → `CMUX_SOCKET` → auto-discovery（実体 `~/Library/Application Support/c11mux/c11.sock`）

### Spec 準拠度: 部分準拠（要 wrapper）

`system.capabilities` で `protocol:"cmux-socket", version:2` を自称。

- Request: `{"jsonrpc":"2.0","id":N,"method":"...","params":{}}` を受理（`jsonrpc` 省略可）
- Response 成功: `{"id":1,"ok":true,"result":{...}}` — **`jsonrpc` フィールド無し**
- Response error: `{"ok":false,"id":1,"error":{"message":"...","code":"method_not_found"}}` — **`error.code` が snake_case 文字列**（JSON-RPC 2.0 spec は数値）
- フレーミング: newline-delimited（`\n` 終端）

→ TypeScript SDK 化する際は **薄い adapter layer** が必要（`error.code: string → number map`、`jsonrpc` field の inject、`ok:false` を Promise reject に変換）。

### Method 一覧（130+、`system.capabilities` の `methods[]` から確定）

主要グループ:

- `system.*`: ping / capabilities / tree / identify / brand
- `surface.*`: list / create / close / get_metadata / set_metadata / clear_metadata / read_text / send_text / send_key / health / focus / move / split / action
- `pane.*`: list / create / surfaces / focus / resize / swap / break / join / set_metadata / get_metadata / clear_metadata
- `workspace.*`: list / create / select / close / rename / apply / set_metadata / get_metadata / clear_metadata / remote.*
- `notification.*`: create / create_for_surface / create_for_target / list / clear

### Text-mode CLI からの移行難易度: 低〜中

CLI と method 名はほぼ 1:1 対応。`--json` flag 付き CLI で raw result が取れるため、socket 直叩きへの完全移行は **最適化目的**でしか必要ない（spawn コスト削減 / latency / 同時 request 多重化）。

---

## 4. Agent state detection（AgentDetector）

**結論: AgentDetector 相当の専用 CLI / method は存在しない**（c11 0.46.0 時点）。

- `surface.health` は `type=terminal in_window=true` のような構造的健全性のみ。「agent が idle か」は判定しない
- `lifecycle_state = active|throttled` は **OS の app focus 状態**。agent の thinking/idle は反映していない
- 代替: **`c11 claude-hook stop|idle` を Claude Code の Stop hook から呼ぶ**ことで `mailbox.*` を更新する **明示的 push 経路** が用意されている（`echo '{}' | c11 claude-hook stop`）

→ **ハイブリッド戦略推奨**: 通常時は metadata-poll で `mailbox.status==idle`、stale な場合のみ pane の `read-screen` パターン検出に fallback。

---

## 5. Phase 2 実装プラン

### 優先順位（高→低）

1. **`mailbox.*` 書き込みを Conductor / Agent prompt に組み込む**（最低リスク、最大の観察効果）
   - Agent 起動時: `c11 set-agent --type claude-code --task $TASK_ID --role agent`
   - 進捗時: `c11 set-metadata --json '{"mailbox.status":"running","mailbox.progress":0.X}'`
   - 終了時: `c11 set-metadata --key mailbox.status --value done` + 既存 `done` marker（dual-write 期）
2. **Manager に metadata-poll loop を追加**（既存 `done` marker watcher と並列、shadow mode）
   - 1〜2 秒間隔で `pane.get_metadata` を JSON-RPC で叩く（CLI spawn より軽い）
   - `done` marker と metadata の到達を双方記録 → trace DB の `hook_signals` で `source=marker|metadata` と分けて統計を取る → どちらが先に来るか・取りこぼしが無いかを 1〜2 週測定
3. **AgentDetector 置換**: `claude-hook stop` を Conductor / Agent prompt の Stop hook に組み込む。`mailbox.status=idle` を真値、`read-screen` パターンは fallback only に降格
4. **JSON-RPC 直叩き SDK**: TypeScript で `c11-rpc.ts` を `skills/cmux-team/manager/` に追加。CLI は debug / one-shot 用に温存

### trace DB / state machine との結合点

- `hook_signals` テーブルに `source` カラム追加（`marker` / `metadata` / `claude-hook` / `pid-watcher`）→ FSM 入力の出処を区別
- Task FSM の `assigned → ready` 遷移トリガに「metadata.mailbox.status==done」を追加（既存 `done` marker と OR 条件、両方記録）
- `metadata_sources` の `ts` を trace DB に取り込めば、agent が status を書いた時刻と Manager が観測した時刻のラグを cohort 比較できる（観察箱原則と整合）

### 互換性維持戦略（cmux backend での fallback）

- `c11 capabilities` の有無で c11 mode / cmux mode を分岐
- `mailbox.*` 書き込みは「**書けたら書く・読めたら使う**」の opportunistic に: cmux backend では同コマンド呼び出しを capability 不在で gate
- Manager の poll loop は capability 不在なら無効化、`done` marker のみで動作
- prompt template には `{{METADATA_API_AVAILABLE}}` 系プレースホルダーを増やし、c11 環境のみで mailbox 命令が出るように

### 未調査 / 要追跡

- pane と surface 両方の `set_metadata` の precedence 解釈（CLI help では `--surface` と `--pane` は排他としか書かれていない）
- `c11 wait-for [-S] <name>` を Conductor / Agent 間 sync として活用できる可能性
- `auth.login` の `access_mode:"cmuxOnly"` の意味（remote socket 連携時に効く可能性）
- `notification.create_for_surface` で agent surface に operator 通知を出せそう（Master → Agent の out-of-band ping 経路）

---

## 6. 関連ファイル（実機絶対パス）

- `/Applications/c11.app/Contents/Resources/bin/c11` — c11 0.46.0 (build 99) CLI
- `~/Library/Application Support/c11mux/c11.sock` — daemon UNIX socket
- `~/Library/Application Support/c11mux/session-com.stage11.c11.json` — session state（metadata persistence cache）
- `~/Library/Application Support/c11mux/last-socket-path` — auto-discovery 用ヒント
