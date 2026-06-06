# タスク割り当て

## タスク内容

---
id: 027
title: surface 不在の残骸 Conductor を team.json から除去できる経路を追加（T025 再々起票・v0.9.0 で再試行）
priority: medium
created_by: surface:182
created_at: 2026-05-24T08:37:21.412Z
---

## タスク
> **再々起票（T021 → T025 → 本タスク）**: 2 回連続で disconnect_timeout abort。
> - T021 (5/24 07:52): C[73] が compact 後に死亡
> - T025 (5/24 14:07): implementer A[172] が巨大ファイル操作中（POST_TOOL_USE 330KB 連発）に crash → 直後に親 Conductor C[28] も死亡（spillover）→ disconnect_timeout
>
> **環境前提の変化（重要）**: 上記失敗は実機 v0.8.2（事象B の getPaneForSurface substring バグを含む旧版）で発生した。現在は v0.9.0 を publish + 再install + daemon 再起動済みで、事象B（空 split ペイン量産→リソース圧迫）は解消済み。本タスクはこの v0.9.0 環境での再試行。
>
> **実装上の注意（前回の spillover 死を踏まえて厳守）**:
> - daemon.ts は巨大（4400 行超）。**全読み込みを避け**、grep / 下記 file:line 周辺の部分読みに徹すること。巨大 payload が crash 誘発要因の疑いがある。
> - 修正方針は変更面積の小さい方を選ぶ。**案B（daemon 起動時 reconcile）を優先検討**し、案A（clear-conductor 分岐追加）と比較した上で決める。
> - 前回 design 成果（plan.md / design-review.md）が .team/tasks/025-surface-conductor-team-json-t021/runs/task-025-1779596750/ に残っている。参考にしてよい（worktree は別物）。

## 背景・症状

存在しない surface（観測例: surface:27）が status: "broken" のまま Manager の
team.json の conductors[] に居座り続け、**正規 CLI のどれでも消せない**。
surface:27 は前セッションの Conductor スロットの残骸で、現在の c11 tree には存在しない。

## 根本原因（2 つの設計の噛み合わせで「詰み」になる）

1. **T250: broken は永続**（daemon.ts:1104,1113）。Manager 再起動でも保持し、明示的な
   clear-conductor / abort-task / restart-task 以外では解除しない（observatory: 壊れた事実を残す）。
2. **T251: surface 実在ガード**（conductor.ts:758-767）。broken を戻す唯一の経路
   clear-conductor（→ CONDUCTOR_CLEAR → resetConductor(targetStatus:"idle")）は、
   冒頭で getPaneForSurface を呼び、**surface が tree に無いと idle 要求でも effectiveTargetStatus="broken" に倒し戻す**。

→ surface ごと消滅したスロットの残骸を team.json から**除去する経路が存在しない**。
Manager 再起動でも永続するため自然消滅もしない。

## 実害評価（小）

broken は isAssignableStatus=false（schema.ts:503）でタスク割り当て対象外。
新規タスクは現役の idle / reserved スロットで回るため**機能的実害はほぼ無い**。
害は dashboard / snapshot / team.json の見た目とスロット数カウントの圧迫のみ。

## 修正方針（いずれか、または併用。実装者が比較して選ぶ。前回注記の通り案B 優先）

A. **clear-conductor の surface 不在分岐を追加**: surface が tree に無い broken Conductor に対して
   clear-conductor が呼ばれたら、idle に戻すのではなく **team.json の conductor エントリを削除**する。
   CONDUCTOR_CLEAR ハンドラ（daemon.ts:1665-1693）と resetConductor（conductor.ts:737-）の
   surface 実在分岐（L758-767）を調整。

B. **daemon 起動時 reconcile**: team.json 復元時（daemon.ts:1090-1118 周辺）に、
   「**現スロット集合に含まれず、かつ surface が tree に実在しない broken/disconnected 残骸**」のみ drop する。

## observatory との両立（必須制約）

- **現役スロットの broken は残す**（T250 の意図＝壊れた事実の可視化を壊さない）。
- drop / 削除の対象は「**現スロットに属さない過去 surface の残骸**」に限定する。
- 削除/除去時は journal / log（例: conductor_pruned 的なイベント）を必ず残し、
  retrospective 観察で「いつ・なぜ消したか」を追えるようにする（silent な state mutation を作らない）。

## 検証

- surface 不在の broken 残骸を**選んだ手段で除去でき、再起動後も復活しない**こと
- **現役スロットの broken は除去されない**（regression なし）こと
- 割り当てロジック（findIdleConductor / isAssignableStatus）に影響が無いこと
- 関連テスト（daemon.test.ts の conductor 復元 / clear-conductor / RESET_CONDUCTOR 系）が pass。
  bun test 全体実行は禁忌、per-file ループで。

## 参考 file:line

- skills/cmux-team/manager/daemon.ts CONDUCTOR_CLEAR（L1665-1693）/ conductor 復元（L1090-1118）/ broken 永続コメント群（L2129,2682,2794,3010,4360,4474）
- skills/cmux-team/manager/conductor.ts resetConductor（L737-）/ surface 実在ガード（L758-772）
- skills/cmux-team/manager/schema.ts isAssignableStatus（L503）
- skills/cmux-team/manager/i18n.ts clear-conductor help（L495-498）
- 仕様: docs/spec/07-state-machine.md（Conductor FSM / broken の位置づけ）— 更新要否を確認


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-027-1779611841` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-027-1779611841
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-027-1779611841/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/027-surface-conductor-team-json-t025-v0-9-0/runs/task-027-1779611841
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/027-surface-conductor-team-json-t025-v0-9-0/runs/task-027-1779611841/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


