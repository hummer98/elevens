---
id: 028
title: /elevens:watch + Conductor 自動 rebase の commit drop 対策
priority: high
created_by: surface:10
created_at: 2026-05-27T01:07:49.578Z
---

## タスク
## 背景

prototype workspace (T181 compass-wind 99e23a6e feat(fe/compass-wind): heading rotation 補間) で、`/elevens:watch` の自動 PR merge と Conductor の Step 8 自動 rebase 経路が組み合わさり、commit が main から drop する事故が発生した。surface:4 Master が「elevens watch 自動 sync で drop」、surface:11 が「rebase で消えた」と表現している事象。詳細経路は本タスク起票時の会話および `commands/watch.md` / `skills/cmux-team/templates/ja/conductor-role.md` Step 8 を参照。

drop しうる自動経路は以下の 3 つで、いずれも LLM/squash により commit-level の整合性追跡を構造的に失う:

- **経路 A (Conductor Step 8 自動 rebase, conductor-role.md:488-510, 8-5)**: agent が rebase 中の衝突を「片方採用」で解消すると変更が消える。空 commit 自動 skip も同様
- **経路 B (`/elevens:watch` Step 2, watch.md:113)**: `gh pr merge --squash --delete-branch` で元 commit hash が main の history に残らず、feature branch も消えるため reflog 依存になる
- **経路 C (`/elevens:watch` Step 3, watch.md:130-145)**: Master が Edit ツールで衝突マーカーを解消する経路。LLM が片方を取り落とすと drop

Manager daemon 側の自動 git (`git pull --ff-only`) は ff-only なので drop は起きない。事故源は上記 3 経路。

## 目的

「逸脱しても安全な構造」設計原則に沿って、drop が起きても追跡 / 復旧可能な状態を恒久化する。具体的には経路 B の追跡可能性を上げ、経路 A・C の自動衝突解消を止める。squash か merge かの history 運用ポリシー自体には触らない (`--merge` への切り替えは本タスクのスコープ外)。

## やってほしいこと

1. **`commands/watch.md` Step 2 から `--delete-branch` を除去** — feature branch を残すことで、squash 後も `git log --all` / `git branch -a` から元 commit を追える状態にする。コマンド本文の差し替えと、その理由 (drop 追跡可能性) を 1〜2 行注記で残す。`gh pr merge` のあとの cleanup 方針 (週次手動 / 別タスク化のメモ) は本文末に短く触れる程度で OK
2. **`commands/watch.md` Step 3 (Conflict 検出時の resolve) 全体を escalate に格上げ** — Edit による自動衝突解消をやめ、conflict 検出時点で `[escalation]` を user に出して停止する。merge 中断 (`git merge --abort`) も含めて手順を明示する
3. **`skills/cmux-team/templates/ja/conductor-role.md` Step 8-5 の自動衝突解消も escalate に倒す** — 同じ理由で agent に commit-level 整合性判断を委ねない。Step 8 で `git rebase` が conflict した時点で、現状の 8-5 (conflict-resolution.md を書き出して Step 9 へ進む) を止め、判断必要レポート (Step 8 既存の conflict 報告フォーマット) を返して worktree を残して終了する経路に統一する。en 版 (`templates/en/conductor-role.md`) も同等に修正
4. **post-mortem artifact を 1 本書く** — `/elevens:artifact research` で `.team/artifacts/Axxx-watch-commit-drop-postmortem.md` を作成。今回の T181 compass-wind 99e23a6e drop の経路推定、Manager log の `Step 9 ff-only merge failed` / `conductor_done_unresolved` / `judgment_pending` との対応、本タスクで適用した構造変更、を残す。`origin/docs/weather-data-pipeline` に 99e23a6e が残っているかどうかは可能なら git で確認

## 確認してほしい点 (実装判断)

- watch.md Step 3 を完全に escalate にすると `/elevens:watch` の自動化価値が下がるが、drop リスクとのトレードオフでこちらを採る方針。escalation メッセージは Step 2 の他 escalation と同じフォーマットに揃える
- Conductor 側の 8-5 廃止に伴い、Step 8 の他節 (8-1〜8-4 等) との整合 / dangling 参照がないか確認
- en / ja の両 template を必ず同期する
- 修正は `commands/` と `skills/cmux-team/templates/` のみで完結する想定。Manager daemon の TypeScript コード変更は不要なはず。もし必要だと判断したら理由を artifact に残してから着手

## 完了条件

- 上記 3 ファイルの修正がコミットされている
- 修正後の watch.md / conductor-role.md を読み直して、衝突解消経路に「自動 Edit」「自動 rebase 続行」が残っていないことを確認
- post-mortem artifact が `.team/artifacts/` に存在
- PR (推奨) もしくは local ff-only merge で main に取り込まれている
