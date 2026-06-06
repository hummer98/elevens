# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-004-1778405194` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-004-1778405194
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-004-1778405194/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/004-surface-conductor-cli/runs/task-004-1778405194
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/004-surface-conductor-cli/runs/task-004-1778405194/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
