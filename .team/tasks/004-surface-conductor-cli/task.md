---
id: 004
title: surface ターミナルから Conductor をリセットする CLI を追加
priority: medium
created_by: surface:119
created_at: 2026-05-10T05:24:55.210Z
---

## タスク
## 背景

現状、Conductor が `broken` / `disconnected` に倒れたあとの復旧手段が無い。`daemon.ts` のコメントに `broken_requires_manual_clear` とあるが対応する CLI は未実装で、ユーザーは:

- daemon 全体を再起動する
- `team.json` を直接編集する（規約違反）

の二択しかない。Brainship/prototype で実際にこの状況に遭遇（surface:46 が pid 死亡 → broken、surface:47 に Master と Conductor が二重登録 → broken）。pane 単位の局所復旧手段が欲しい。

## 仕様案

新規 CLI: `elevens reset-conductor [--surface <s>] [--force]`

### 引数

- `--surface <s>`: 対象 Conductor surface。省略時は `CMUX_SURFACE` 環境変数から自動解決（`resolveCallerSurfaceOrExit` 流用）。pane 内シェルから自分自身をリセットするユースケースを default 想定
- `--force`: assigned 中の Conductor をリセット可能にする。指定なしなら assigned 中は拒否

### 挙動

1. queue 経由で Manager に `RESET_CONDUCTOR` メッセージを送信（`TASK_CREATED` と同じ `.team/queue/incoming/` 流儀）
2. Manager 側 `handleMessage` で受信し、対象 surface の Conductor entry に対して:
   - assigned 中で `--force` 指定なし → reject + ログ
   - assigned 中で `--force` 指定あり → 紐付く task を `abort-task` 相当で止める（journal に "reset-conductor by user" を記録）
   - 既存の `resetConductor` 関数（conductor.ts）を呼んで:
     - claude プロセスがあれば kill
     - `state.conductors` の対象 entry を `reserved` に戻す（taskId / taskRunId / sessionId / pid をクリア）
     - pane のタブ名を `[N] Conductor` に戻す
3. リセット後は次の `findIdleConductor` で拾える状態になり、新しい task assign 時に kill+spawn 経路で claude が再起動する

### 適用可能な状態

- `broken` / `disconnected` / `reserved` / `idle` → 常に OK
- `assigning` / `running` (assigned) → `--force` 必須

### 既存資産

- `conductor.ts:resetConductor` は既存（`abort-task` 経路で使われている）
- queue protocol は `.team/queue/incoming/` で確立済み
- surface 自動解決は `resolveCallerSurfaceOrExit` 流用可

## 受け入れ条件

- [ ] `elevens reset-conductor` CLI が main.ts に追加され、help にも記載される
- [ ] `--surface` 省略時に `CMUX_SURFACE` から自動解決
- [ ] Manager 側で `RESET_CONDUCTOR` メッセージを処理
- [ ] broken / disconnected からの復旧で次の task assign が成功するテスト
- [ ] assigned 中の `--force` なしで reject されるテスト
- [ ] assigned 中の `--force` ありで task が abort され surface が reserved に戻るテスト

## Out of scope

- Master surface 用の reset コマンド（必要なら別タスク）
- TUI からの GUI 操作（CLI のみ）

## 観察箱原則との整合

ユーザーが pane を見て「これ壊れてる」と気づいた瞬間に、その場で復旧できる経路を提供する。real-time 観察 → 介入 のサイクルを閉じる。
