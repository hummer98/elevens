---
id: 008
title: abort 経路で broken 化させない (kill→reserved 統一)
priority: high
created_by: surface:267
created_at: 2026-05-12T09:10:16.281Z
---

## タスク
## 背景

`broken` は本来 `disconnect_timeout` / `launch_failed` / `worktree_missing` / `unmatched` 等の **異常** 用ステータスだが、現状 **abort 運用の正常な副産物として恒常的に生成される** バグがある。状態機械として「broken=異常」の意味が崩れている。

### 観測された再現 (2026-05-12 prototype workspace)

```
15:07:38  abort_signal_sent task_id=037 surface=C[271] method=sigterm pid=96815
15:07:38  conductor_reset C[271] targetStatus=idle reason=done
15:07:41  session_ended C[271] pid=96815 status=disconnected reason=pid_watcher
15:07:41  conductor_disconnected C[271] reason=pid_dead
15:12:41  conductor_disconnect_timeout C[271] elapsed=300s
15:12:41  conductor_broken C[271] reason=disconnect_timeout   ← ★これ
```

ユーザー意図の `abort-task` が、何もしない 5 分間を挟んで勝手に broken 化する。

## 根本原因

`cmdAbortTask` (`main.ts:5096`) は Conductor PID に SIGTERM を投げる (`abort_signal_sent` at 5158) が、daemon 側の Conductor 状態管理は kill を予期していない。結果:

1. SIGTERM で Conductor の Claude Code session が死亡
2. pid_watcher が dead を検出 → `conductor_disconnected reason=pid_dead`
3. 5 分間 SESSION_STARTED 来ず → `forceCloseDisconnectedConductor` (`daemon.ts:4265`) → `resetConductor targetStatus="broken" reason="disconnect_timeout"`

つまり「状態管理上の宣言 (idle / done)」と「実体 (kill された dead session)」がズレている。

## 既に正解パターンを持っている経路

**T004 で導入した RESET_CONDUCTOR 経路** (`daemon.ts:1646-1758`) は **kill → watcher 停止 → reserved** の正しいシーケンスを採用済み:

```
isAssigned 時:
  1. clearInterval(pidWatcherInterval) + mailboxWatcherStop()    ← watcher を先に止める
  2. markTaskAborted(...)
  3. insertTaskSession(event="aborted")
  4. conductor.pid = undefined; backend.killClaudeProcess(pid)
  5. resetConductor(..., { targetStatus: "reserved", reason: "..." })
```

**SESSION_CLEAR running 経路** (`daemon.ts:2906-2929`) も同形を採用済み。

つまり「kill するなら reserved に倒し、watcher を先に止めて誤検出を防ぐ」は既に確立した社内 paradigm。abort-task 経路だけがこの形に揃っていない。

## 修正方針

`abort-task` 経路を T004 RESET_CONDUCTOR と同形のシーケンスに揃える。

### 実装箇所

- `cmdAbortTask` (`main.ts:5096` 〜) で abort_signal_sent を送る部分の前後
- または daemon 側に `ABORT_TASK` メッセージとして集約し、daemon 内で T004 と同じ helper を呼ぶ形に統一する（推奨）

具体的な選択肢:

| 選択肢 | 内容 | 影響範囲 |
|---|---|---|
| **A** | `cmdAbortTask` から daemon に「ABORT_TASK」message を投げ、daemon 側で T004 と同じシーケンスを実行（kill→watcher 停止→reserved）。`abort_signal_sent` ログは daemon 側で出す | main.ts 簡素化 + daemon.ts に新 message handler |
| B | `cmdAbortTask` 側で main プロセスが kill する前に「abort 中」マーカーを team.json / task-state.json に書き、daemon の pid_watcher は abort 中の disconnect を broken に昇格させない | 状態追加が分散して fragile |

**A 推奨** — T004 helper を再利用できるため最小変更で構造的に正しくなる。SESSION_CLEAR/RESET_CONDUCTOR/ABORT_TASK が全部「kill→reserved」で統一される。

### 期待挙動

1. ユーザーが `elevens abort-task --task-id N` 実行
2. daemon が ABORT_TASK message を受信
3. T004 と同形シーケンスで watcher 停止 → markTaskAborted → kill → `targetStatus: "reserved"` で reset
4. 結果: Conductor が即時 `reserved` 状態 (session 無しでも正常な待機状態)
5. pid_watcher は既に停止されているので `conductor_disconnected` ログは出ない
6. 5 分後の `disconnect_timeout` → broken は発生しない
7. 次の ready task が来れば spawn-conductor-cli で session 再起動 → assigning → running

### テスト

- `daemon.test.ts` に新規ケース:
  - abort 直後に Conductor.status = "reserved"、pidWatcherInterval = undefined
  - clock を 6 分進めても disconnect_timeout / broken に遷移しない
  - その後 ready task を投入すると reserved → assigning → running
- 既存の `cmdAbortTask` テストの assertion 更新（broken 期待があれば reserved に変更）

## 範囲外（別議論）

- 案 C: `disconnect_timeout` を broken と別ステータス（例: `stale`）に分離 — 状態数増加で下流影響が広い。今回は abort パスを直して broken の意味を本来の「異常」に取り戻すだけにする
- 案 B: abort 時に kill しない運用（session reuse） — context 汚染リスクで別議論
- `forceCloseDisconnectedConductor` (`daemon.ts:4265`) 自体の挙動変更 — 真の disconnect_timeout（kill 以外で session が応答しなくなった場合）には引き続き必要なので残す

## 参考

- `elevens reset-conductor` CLI (T004) と `SESSION_CLEAR` 経路で確立した「kill→watcher停止→reserved」paradigm
- CLAUDE.md §「設計原則」: **decision-deterministic-by-code**、**transformer が state を内部で維持しなくて済む環境を設計する**
- ユーザー指摘: 「Conductor の kill 運用にしたら broken ステータスは整合性が取れない」 — 本タスクの起点
