# タスク割り当て

## タスク内容

---
id: 025
title: surface 不在の残骸 Conductor を team.json から除去できる経路を追加（T021 再起票）
priority: medium
depends_on: [024]
created_by: surface:29
created_at: 2026-05-23T23:37:34.992Z
---

## タスク
> **再起票**: 旧 T021 は 2026-05-24 07:52 に disconnect_timeout で abort（C[73] が compact 後に死亡, worktree archive 済み, 実装未着手）。
> 環境不安定の調査・修正タスク **T024** の完了後に実行する（--depends-on 024）。内容は旧 T021 と同一。


## タスク
## 背景・症状

存在しない surface（観測例: surface:27）が `status: "broken"` のまま Manager の
`team.json` の `conductors[]` に居座り続け、**正規 CLI のどれでも消せない**。
surface:27 は前セッション（5/22 22:41 disconnect）の Conductor スロットの残骸で、
現在の c11 tree には存在しない（現役スロットは別 surface）。

## 根本原因（2 つの設計の噛み合わせで「詰み」になる）

1. **T250: broken は永続**（`daemon.ts:1104,1113`）。Manager 再起動でも保持し、明示的な
   `clear-conductor` / `abort-task` / `restart-task` 以外では解除しない（observatory: 壊れた事実を残す）。
2. **T251: surface 実在ガード**（`conductor.ts:758-767`）。broken を戻す唯一の経路
   `clear-conductor`（→ `CONDUCTOR_CLEAR` → `resetConductor(targetStatus:"idle")`）は、
   冒頭で `getPaneForSurface` を呼び、**surface が tree に無いと idle 要求でも `effectiveTargetStatus="broken"` に倒し戻す**（幽霊 Conductor 防止）。

→ surface ごと消滅したスロットの残骸を `team.json` から**除去する経路が存在しない**。
`clear-conductor` は「スロット再利用のため idle に戻す」目的で、surface 消滅ケースを想定していない。
Manager 再起動でも永続するため自然消滅もしない。

## 実害評価（小）

`broken` は `isAssignableStatus=false`（`schema.ts:503`）でタスク割り当て対象外。
新規タスクは現役の idle / reserved スロットで回るため**機能的実害はほぼ無い**。
害は dashboard / snapshot / team.json の見た目とスロット数カウントの圧迫のみ。

## 修正方針（いずれか、または併用。実装者が比較して選ぶ）

A. **clear-conductor の surface 不在分岐を追加**: surface が tree に無い broken Conductor に対して
   `clear-conductor` が呼ばれたら、idle に戻すのではなく **team.json の conductor エントリを削除**
   （または現役スロットへ振り直し）する。`CONDUCTOR_CLEAR` ハンドラ（`daemon.ts:1665-1693`）と
   `resetConductor`（`conductor.ts:737-`）の surface 実在分岐（L758-767）を調整。

B. **daemon 起動時 reconcile**: team.json 復元時（`daemon.ts:1090-1118` 周辺の conductor 復元）に、
   「**現スロット集合（initializeConductorSlots が作る pane 群）に含まれず、かつ surface が tree に
   実在しない broken/disconnected 残骸**」のみ drop する。

## observatory との両立（必須制約）

- **現役スロットの broken は残す**（T250 の意図＝壊れた事実の可視化を壊さない）。
- drop / 削除の対象は「**現スロットに属さない過去 surface の残骸**」に限定する。
  現役スロットで surface が一時的に missing なだけのケースを誤って消さないこと。
- 削除/除去時は journal / log（例: `conductor_pruned` 的なイベント）を必ず残し、
  retrospective 観察で「いつ・なぜ消したか」を追えるようにする（silent な state mutation を作らない）。

## 検証

- surface 不在の broken 残骸を**選んだ手段で除去でき、再起動後も復活しない**こと
- **現役スロットの broken は除去されない**（regression なし）こと
- 割り当てロジック（findIdleConductor / isAssignableStatus）に影響が無いこと
- 関連テスト（daemon.test.ts の conductor 復元 / clear-conductor / RESET_CONDUCTOR 系）が pass。
  `bun test` 全体実行は禁忌、per-file ループで。

## 参考 file:line

- `skills/cmux-team/manager/daemon.ts` CONDUCTOR_CLEAR（L1665-1693）/ conductor 復元（L1090-1118）/ broken 永続コメント群（L2129,2682,2794,3010,4360,4474）
- `skills/cmux-team/manager/conductor.ts` `resetConductor`（L737-）/ surface 実在ガード（L758-772）
- `skills/cmux-team/manager/schema.ts` `isAssignableStatus`（L503）
- `skills/cmux-team/manager/i18n.ts` clear-conductor help（L495-498）
- 仕様: `docs/spec/07-state-machine.md`（Conductor FSM / broken の位置づけ）— 更新要否を確認


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-025-1779596750` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-025-1779596750
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-025-1779596750/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/025-surface-conductor-team-json-t021/runs/task-025-1779596750
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/025-surface-conductor-team-json-t021/runs/task-025-1779596750/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


