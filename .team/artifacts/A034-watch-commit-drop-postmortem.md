---
id: A034
type: research
title: "watch / Conductor 自動 rebase commit drop の post-mortem (T028 構造変更)"
created: 2026-05-27
author: surface:8
task: T028
tags: [watch, conductor, rebase, postmortem, commit-drop]
---

## 背景

prototype workspace（compass-wind プロジェクト）の T181 `feat(fe/compass-wind): heading rotation 補間`（commit `99e23a6e`）で
`/elevens:watch` の自動 PR merge と Conductor Step 8 自動 rebase が組み合わさり、
commit が main から drop する事故が発生した。

本 artifact では事故の経路推定を残し、T028 で適用した構造変更（自動 Edit / 自動 rebase 続行経路の廃止）の
判断理由を記録する。一次資料は本リポジトリ `commands/watch.md` の旧 Step 2 / Step 3、
および `skills/cmux-team/templates/{ja,en}/conductor-role.md` の旧 Step 8（8-1〜8-6）。

## 調査結果

### 経路 A — Conductor 8-3 semantic resolution（自動 Edit による drop）

旧 Step 8-3 は **Conductor が Edit / Write を使ってよい唯一の例外** として位置付けられていた。

- conflict marker が出たファイルを LLM が「片方採用」で解消すると、もう片方の変更が
  Resolution の中で消えるケースがある（とくに両側がほぼ同じ箇所の異なる実装を加えた場合）
- 旧 Step 8-4 の検証（scope_violation / `bun test` / `bunx tsc --noEmit`）は **差分の missing を直接検知できない**:
  - `scope_violation` は許可ファイル集合外への変更を検知するもの。conflict file 内の片側 drop は対象外
  - `bun test` は両側 ANDED の動作をテストが要求していなければ片側だけでも pass する
  - `bunx tsc --noEmit` は文法上欠落していないため pass
- 結果として「自動解消 → 全テスト pass → ff-only merge」が成立し、人間が気付かないうちに main へ drop した状態が反映される

### 経路 B — `commands/watch.md` Step 2 `--delete-branch`

旧 Step 2 は `gh pr merge --squash --delete-branch "$PR_URL"` を実行していた。

- squash merge は main に「単一の squash commit」を残すだけで、元の feature branch の個別 commit hash は main の history に含まれない
- `--delete-branch` で remote / local の feature branch も削除されるため、merge 後に元 commit を辿る手段は **reflog（短命、worktree が残っていれば）** か **archive worktree** しかない
- 経路 A で drop が起きた場合、追跡可能性が著しく落ち、post-mortem 自体が困難になる

### 経路 C — `commands/watch.md` Step 3 自動 Edit

旧 Step 3 は **PR merge が conflict / not mergeable で失敗したとき**、Master が `git merge origin/main` を
実行して衝突マーカーを Edit ツールで解消する経路だった。

- Master 自身が LLM で「片方採用」を選ぶため、経路 A と同質の drop が起こり得る
- さらに `git push` + `gh pr merge --squash --delete-branch` の二段押しになるため、
  drop した状態の commit が main に取り込まれてから branch も消える、という二重に追跡不能な状況になる

### Manager log との対応

事故時の Manager log を本タスク worktree からは直接参照できない（compass-wind 側のもの）が、
構造的に以下のイベントが発火していたはずである:

- `Step 9 ff-only merge failed`: rebase 自体は成功したが Step 9 で local main の fast-forward に失敗 → escalate（drop は **発生していない**、ここで気付ける可能性あり）
- `conductor_done_unresolved` / `judgment_pending`: 旧 8-6 escalation 経路の発火痕跡
- これらが鳴らずに `task_completed` だけが出ているケースが経路 A のサイレント drop の signature

該当 Manager log エントリは本リポジトリ環境では確認不能。compass-wind 側 surface:N の log を確認する必要がある。

### 99e23a6e の残存確認

本タスクの worktree は elevens repo のものであり、`compass-wind` の T181 99e23a6e は **別 prototype repo** に存在する。
elevens repo 内 git log では本 SHA は不在であることを確認済み（`git log --all --format=%H | grep -i 99e23a6e` → no match）。
本リポジトリの T181 は別タスク（`await-agent` 方式への移行、commit `58e4e6d`）。

復旧確認は別 repo で以下のコマンド系列で実施する想定:

```bash
git fetch --all
git log --all --format=%H | grep -i 99e23a6e
# branch 残存確認
git branch -a --contains 99e23a6e
# 候補 branch 上にいるか
git log origin/docs/weather-data-pipeline --format=%H | grep -i 99e23a6e
```

## 比較・分析

### 自動解消を残す案 vs 廃止する案

| 観点 | 残す案（旧 T284） | 廃止する案（T028） |
|---|---|---|
| 速度 | conflict が出ても人手なく解消 | conflict 出たら人間判断必要 |
| 安全性 | LLM 判断ミスで commit が drop しうる | drop はゼロ（衝突状態で停止） |
| 検知容易性 | scope_violation / test / tsc では片側 drop を捕捉できない | rebase conflict が必ず人間に escalate される |
| 追跡可能性 | `--delete-branch` で原 commit を失う | branch を残すので原 commit を辿れる |
| 観察箱としての価値 | 自動解消の挙動を pane で観察できる利点はある | drop 事故が観察可能（escalation event として残る）方が観察箱の核心に合致 |

**判断**: elevens の設計原則「逸脱を防ぐより、逸脱しても安全な構造にする」「決定論的なものはコードで、判断が必要なものは AI で」に照らすと、
commit-level の merge 判断は **人間判断（あるいは task として再投入された別 Conductor 判断）に倒すのが構造的に正しい**。
LLM の片方採用は決定論的にも非決定論的にも信頼できる挙動ではないため、自動経路から外す。

### docs/spec/04-templates.md を touch した理由

タスク本文（plan.md §5）には「修正は `commands/` と `skills/cmux-team/templates/` のみで完結する想定」
と書かれているが、完了条件には「衝突解消経路に『自動 Edit』『自動 rebase 続行』が残っていないことを確認」とある。

`docs/spec/04-templates.md` には以下の dead spec 化する記述が含まれていた:

- L211 段落: `**Step 8 semantic resolution（T284）:**` の段落（semantic resolution 経路の仕様説明）
- L215-258 節: `### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）` 全体

これらを残すと「spec には書いてあるが実装では廃止」という dangling 状態になり、
将来このタスクの経緯を知らない人間 / agent が「Step 8-5 でこのファイルを書き出すはず」と
spec を信じて再実装してしまうリスクがある（観察箱としての信頼性を損なう）。

**フル削除はしない** ことで歴史を残しつつ、「廃止 (T028)」の注記を追加して dangling 参照を絶つ。

## 結論

### 本タスク（T028）で適用した構造変更

1. **`commands/watch.md` Step 2 から `--delete-branch` を除去**（経路 B の追跡可能性向上）
   - squash merge 後も remote/local branch を残す
   - ファイル末尾に「Branch cleanup 方針メモ」を追加し、累積する branch の cleanup は別タスク運用にする旨を明示
2. **`commands/watch.md` Step 3 全体を escalation 化**（経路 C の自動 Edit 廃止）
   - `git merge --abort` / `git rebase --abort` で merge / rebase 状態を必ず中断
   - conflict 検出時は user に `[escalation]` でレポートして待機（自動 push / merge は行わない）
3. **`skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8 を圧縮**（経路 A の自動 rebase 続行経路を廃止）
   - 旧 8-1〜8-5（ALL_CONFLICT_FILES iteration / Edit による自動解消 / scope_violation・test・tsc 検証 / conflict-resolution.md 書き出し）を全削除
   - 新構造: 8-1 conflict 情報収集（report 用、最小限）→ 8-2 rollback → 8-3 escalation（[判断必要] レポート + `failure_mode=rebase_conflict`）
   - 冒頭の「Conductor 原則の例外扱い」注記を「Conductor は conflict でも Edit / Write しない」に書き換え（やらないこと節と整合）
4. **`docs/spec/04-templates.md` の関連節に「廃止 (T028)」注記**を追加（dangling spec 防止）
   - Step 8 semantic resolution 段落 → `Step 8 conflict handling（T028 で semantic resolution は廃止）` に書き換え
   - conflict-resolution.md フォーマット節 → 「廃止: T028」の注記を頭に置き、本文は歴史保存

### 残課題

- **branch cleanup の運用**: `--delete-branch` を外したぶん、累積 branch をどう掃除するか。
  週次手動 (`git branch --merged`) か、`cmux-team archive prune` 系の整備（別タスク化候補）
- **compass-wind 側 99e23a6e の復旧手順確認**: 本リポジトリ管轄外のため別 repo で確認が必要
- **conflict-resolution.md フォーマット節を spec から完全削除するかどうか**: 現状は歴史保存。
  将来 spec をクリーンアップする際に判断
- **TypeScript daemon 側コードへの影響なし**: `task_completed_state_mismatch` / `conductor_done_unresolved` /
  `judgment_pending` 等の event は既存実装で発火するため、新規 TS コード変更は不要

### 関連ファイル / 参照

- `commands/watch.md`（T028 修正済）
- `skills/cmux-team/templates/ja/conductor-role.md`（T028 修正済、Step 8 圧縮）
- `skills/cmux-team/templates/en/conductor-role.md`（T028 修正済、ja と同期）
- `docs/spec/04-templates.md`（T028 修正済、「廃止 (T028)」注記）
- `.team/tasks/028-elevens-watch-conductor-rebase-commit-drop/task.md`
- `.team/tasks/028-elevens-watch-conductor-rebase-commit-drop/runs/task-028-1779844069/plan.md`
