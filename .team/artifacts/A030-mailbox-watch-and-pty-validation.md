---
id: A030
type: report
title: mailbox watch CLI + 非アクティブ surface PTY 起動検証
author: surface:auto
date: 2026-05-10
related:
  - .team/artifacts/A028-phase1-substrate-adapter-poc.md
  - .team/artifacts/A029-c11-parity-and-phase2-prep.md
  - skills/cmux-team/manager/c11-features.ts
  - skills/cmux-team/manager/mailbox-cli.ts
  - skills/cmux-team/templates/ja/common-header.md
  - skills/cmux-team/templates/en/common-header.md
---

## 1. mailbox CLI と template 統合

A029 plan の最高優先項目「mailbox.\* を Conductor / Agent prompt に組み込む」を実施。

### 実装

- `mailbox-cli.ts`: `elevens mailbox set/get/clear/watch/supported` を提供
  - target は `--surface` / `--pane`（未指定時は `$CMUX_SURFACE_ID` / `$CMUX_SURFACE` を fallback）
  - `--type` で string / number / bool / json コーシャン
  - cmux backend では opportunistic no-op (exit 0) で agent prompt が backend を意識する必要なし
- `c11-features.ts` に `watchMailbox(target, onChange, opts)` を追加
  - `mailbox.*` prefix のキーのみ対象（surface 標準の title / lifecycle_state を除外）
  - 1.5 秒間隔の poll、AbortSignal で停止
  - 差分のみ通知（added / changed / removed）
- `common-header.md` (ja/en) template に lifecycle 申告 instruction を追加
  - 開始時: `mailbox set --json '{"mailbox.role":"<ROLE>","mailbox.status":"running"}'`
  - 完了直前: `mailbox set --key mailbox.status --value done`
  - 既存 `done` marker と dual-write

### 実機 smoke test

```
$ ELEVENS_BACKEND=c11 elevens mailbox watch --surface surface:3 --interval-ms 500 &
$ ELEVENS_BACKEND=c11 elevens mailbox set --surface surface:3 --key mailbox.watch_test --value first
$ ELEVENS_BACKEND=c11 elevens mailbox set --surface surface:3 --key mailbox.watch_test --value second
$ ELEVENS_BACKEND=c11 elevens mailbox clear --surface surface:3 --key mailbox.watch_test
```

watch 出力:
```
2026-05-09T16:04:38.081Z added mailbox.watch_test "first"
2026-05-09T16:04:40.331Z changed mailbox.watch_test "second" prev="first"
2026-05-09T16:04:41.831Z removed mailbox.watch_test  prev="second"
```

`added` / `changed` / `removed` の三相が正しく検知されることを確認。

### 重要な実装上の発見

c11 の `--json` flag は **global flag**（subcommand より前に置く必要がある）。subcommand の後に置くと無視されて text 出力になる。例: `c11 get-metadata --json` は text、`c11 --json get-metadata` は JSON。`set-metadata` の `--json '{...}'` は payload 引数（別の意味）なので subcommand の後でよい。c11-features.ts では get-metadata で `["--json", "get-metadata", ...]` の順序を採用。

---

## 2. 非アクティブ surface PTY 起動検証（Phase 1 task #7、surface レベル）

### 背景

seed.md の直接トリガーは「**非フォーカス workspace の terminal surface が PTY を起動しない regression**」（cmux 0.64.x）。c11 は `AppKitHiddenWrapper` で view 階層に維持しつつ render を抑制する設計で、PTY は維持される。本検証はこれを実機で確認する。

### 検証範囲と限界

ローカル c11 daemon に **workspace は 1 つのみ**（`workspace:1`）。完全な workspace-level non-focus 検証には 2nd workspace の作成が必要だが、c11 は `workspace new --blueprint <path>` 経由でしか作成できないため manual setup が必要。**本回は同 workspace 内の非アクティブ surface（`surface:5`、`[selected]` フラグなし、`◀ active` も無し）に対する PTY 動作を確認**。

### 結果

```bash
# 送信前: surface:5 は npm publish の履歴が残っているがフォーカスは surface:3 にある
$ c11 send --surface surface:5 "echo ELEVENS_PTY_TEST_$(date +%s)"
$ c11 send-key --surface surface:5 "Enter"
$ c11 read-screen --surface surface:5 --lines 30 | grep -c ELEVENS_PTY_TEST_1778342714
2  # コマンド echo + 実行結果の 2 回出現
```

→ surface:5 の PTY は alive、`c11 send` がフォーカス遷移なしで届き、shell が実行 → 結果が screen に反映された。

### Workspace レベル検証の TODO

- 2nd workspace を blueprint で作成する手順を確立
- 2nd workspace の surface に対して focused workspace を維持したまま `send` → PTY 実行が観測できることを確認
- できれば cmux 0.64.x で同じ検証を行い、明確な regression / fix の対比を取る

これは別セッションで実施推奨（c11 のユーザー workspace を破壊しないよう注意）。

---

## 3. Phase 2 進捗まとめ（A029 plan に対する達成度）

| A029 計画項目 | 状態 |
|---|---|
| mailbox.\* を Conductor / Agent prompt に組み込む | ✅ template 改修 + CLI wrapper 完成、cmux backend で no-op |
| Manager の metadata-poll loop | △ 部品（`watchMailbox`、`mailbox watch` CLI）は完成、daemon 側 wiring は未着手 |
| AgentDetector 置換（`claude-hook stop`） | ⏳ 未着手 |
| JSON-RPC 直叩き SDK | ⏳ 未着手（CLI 経由で十分機能しているため後回し） |

## 4. 次セッション推奨タスク

1. **daemon に `watchMailbox` を組み込む**: `daemon.ts` の Conductor lifecycle で per-Conductor watcher を起動、`mailbox.status==done` / `running` イベントを `events-writer` 経由で trace DB に記録。`source=metadata` カラムを `hook_signals` に追加し、既存 `done` marker と並列稼働期間で取り損ね・遅延を統計取得
2. **2nd workspace を blueprint で作成して workspace-level PTY 検証** を完遂（task #7 の本来スコープ）
3. **`claude-hook stop` 統合**: Stop hook 設定で `c11 claude-hook stop` を呼び、`mailbox.status` 自動更新経路を確立
