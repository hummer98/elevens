---
task: T008
title: abort 経路で broken 化させない (kill→reserved 統一)
reviewer: surface:265 (design-reviewer)
created: 2026-05-12
verdict: Approved
---

# Design Review

## 判定

Approved

## サマリ

A 案 (`ABORT_TASK` メッセージを daemon に投げて T004 RESET_CONDUCTOR と同形のシーケンスを daemon 側で実行する) は構造的に妥当で、本タスクの肝である「watcher を kill より前に停止する」順序が擬似コード R1→R2→R3→R4→R5 で正しく確保されている。プラン §2.1〜§2.6 で示された実コード参照 (`main.ts:5096-5200`, `daemon.ts:1646-1755`, `daemon.ts:2868-2929`, `daemon.ts:4265-4310`, `task.ts:581-590` の `AbortReason`, `events-writer.ts:171-193`) は全て検証済みで実装と一致している。

ステップ C「6 分時計を進めても disconnect_timeout / broken に遷移しない」は `monitorConductors` 内 `daemon.ts:4222` の `if (conductor.status === "disconnected")` ガードにより、reserved 状態であれば skip されることが構造的に保証される — テスト設計として正しい証明戦略になっている。

CLAUDE.md 原則 (state 外部化 / silent state mutation 禁止 / 観察箱の trace 一貫性) との整合も取れており、§3.4 で helper 共通化を見送りつつ「3 経路を FSM-style テストで対称化」する方針は CLAUDE.md「構造的正しさを優先」と適合する。Critical 指摘は無く、後述の Recommendations は実装中に判断すれば足りる。

## 良い点

- **R1 (watcher 停止) を kill の前に置く順序が擬似コードで明示されている** (§3.2)。これが本タスクの構造的肝で、`RESET_CONDUCTOR` (`daemon.ts:1677-1686`) と `SESSION_CLEAR running` (`daemon.ts:2896-2905`) と完全に同形になっている。
- **`conductor.taskId !== message.taskId` の stale guard** (§3.2) を入れている。abort-task と他経路 (例: SESSION_CLEAR) が race したときに古い taskId を中止しないための race 防御で、`SESSION_CLEAR running` の `message.taskRunId !== conductor.taskRunId` ガード (`daemon.ts:2860`) と発想が揃っている。
- **idempotent な markTaskAborted を活用** している前提が正しい (`task.ts:661` で reducer noop = closed/aborted/deleted 時 `idempotentSkip` を返す)。abort-task と SESSION_CLEAR の二重発火が起きても state は不変。
- **`cleanupAssignedTask` は restart-task が唯一の呼び出し元になる**ことを §3.3, §4(f.1) で明示し、削除でなく残す方針にしている。restart-task 側は今回触らない方針 (§7) と整合。
- **trace DB を `state.traceDb` 経由に移す**ことで、CLI が直接 `initDB` / `db.close()` する箇所を 1 つ削減できる。`RESET_CONDUCTOR` の `daemon.ts:1713-1727` と完全に対称な実装になる。
- **後方互換と reserved の semantic 整理** (§6) が丁寧。「ready task が無いと session 不在のまま reserved」が `idle` と同じ待機状態であるため UX 上問題なしと述べている点は妥当。
- **テスト 7 ケースのカバレッジ**が `reserved 遷移 / clock 6 分前進 / 再 assign / not_found / stale_task_id / pid undefined / cascade` を網羅しており、状態遷移の不変条件と race 系の両方を押さえている。

## 指摘事項

### Critical (Changes Requested の根拠)

- なし。

### Recommendations (Approved でも改善余地)

1. **`method=` ラベルの最終決定はテスト書き始め前に確定したい** (plan §3.2 注 1)。
   - 検証結果: `method=sigterm` を grep している箇所は本番コード (`skills/`, `docs/spec/`, `dashboard*.tsx`) には**ヒット 0 件**。production の cohort クエリ / dashboard / spec は今のところ `method` をフィルタしていない。ヒットしたのは `CHANGELOG.md:784` (リリースノート) と `.team/tasks-archive-20260510/...` (アーカイブ済み計画書) のみ。
   - → セマンティクスに忠実な新ラベル `method=kill_claude_process` を採用する案で問題なし。実装ステップ (b) で迷う必要は薄いので、plan §3.2 注 1 の「実装中に決める」ではなく **「`kill_claude_process` を採用」と plan を確定**してしまった方が後段の review や cohort 比較で揺らがない。逆に保守的に `sigterm` 互換を維持しても観察箱としては支障なし。判断はどちらでも良いが「決める」こと自体を実装前に固定したい。

2. **`restart-task` 経路は本タスクで触らないが、同型のバグを抱えたまま残る点を plan に明記したい**。
   - `cmdRestartTask` (`main.ts:5356`) は `cleanupAssignedTask` で `process.kill(pid, SIGTERM)` した直後に `CONDUCTOR_DONE success=false reason=restarted` を送るのみで、daemon に「watcher を先に止めて reserved に倒す」協調シグナルを送らない。理屈上は abort-task と同じ「kill → pid_watcher が disconnected → 5 分後 broken」race を起こしうる。
   - 本タスクの範囲外であることに異論はないが、§7 の「やらないリスト」に「`restart-task` 経路の同型 bug は別タスクで `RESTART_TASK` メッセージとして同様に集約する」と一文足しておくと、後続 reviewer / planner が次タスクを起票しやすい。

3. **§3.2 R5 の `resetConductor(reserved, reason="abort_task")` で `reason` 文字列を AbortReason 型と混同しないこと**。
   - `resetConductor` 第 4 引数の `reason` は ConductorState 用のフリーテキスト (`conductor.ts:704`) であり、`AbortReason` 型 (`task.ts:581-590`) ではない。`"abort_task"` 文字列は両者に偶然存在するため動くが、型シグネチャ上は別物。markTaskAborted には `AbortReason` リテラルを、resetConductor には任意文字列を渡す責務の違いを実装コメントに 1 行残しておくと意図が伝わる。

4. **`abort_signal_sent ... method=none` ログを「pid undefined のとき必ず出す」方針について** (§3.2 R4 の else 分岐)。
   - 現行 `cmdAbortTask` (`main.ts:5156`) は `cleanup.method !== "none"` のときだけ `abort_signal_sent` を出す (T260 コメント明示: 「method=none はログしない」)。plan §3.2 では method=none も常時出す挙動になっており、現行 CLI と log 量の semantics が変わる。
   - 観察箱の retrospective 分析では「kill していないことも記録」した方が cohort 比較で有用だが、既存 cohort クエリ前提が変わる可能性がある。実装時には旧挙動 (none を出さない) と新挙動 (none も出す) のどちらに合わせるか、もしくは「pid=- のみ抑制」のような中間策を一段検討しておきたい。Critical ではないが log 互換性に影響する。

5. **ステップ B/C のテストで `state.traceDb` 初期化を忘れない**こと。
   - daemon.test.ts:3552 の T004 テストは `state.traceDb = initDB(testDir)` を明示初期化している。`createDaemon(testDir)` 直後は state.traceDb が undefined のため、忘れると R3 (insertTaskSession) の assertion が「`if (state.traceDb)` で skip されるだけ」で silent green になる。plan §4(b.1) に「trace DB を initDB 経由で初期化する」一文を足すと事故りにくい。

6. **manager.log の `conductor_reset target=reserved reason=abort_task` 期待行は `resetConductor` 内で集約発行される**ため、handler 側でログを別途出さないこと (Decision D12, `conductor.ts:696`)。plan §4(g.3) の手動 E2E に「`conductor_reset target=reserved reason=abort_task`」を期待行として書いているが、ここは resetConductor が自動発行するため OK。一点、§3.2 擬似コード上で R5 後に追加 log を入れないように実装時注意してほしい (集約ポリシー D12 違反になる)。

7. **観察箱メトリクスへの影響を docs/spec/11-metrics.md にも note 追記検討**。
   - 本変更で「abort 起点の broken_count」が観測上消える。`cmux-team-analyze` の cohort クエリで `broken_count` が減ったとき「T008 マージ以降の構造的変化」と区別できるよう、変更点を `docs/spec/11-metrics.md` または release note にひと言入れたい (CHANGELOG での記載でも可)。本タスク plan の射程外なので Recommendations 止まり。

## 検証ログ

実コードを Read して plan.md の主張を確認した結果:

| plan 内の参照 | 実コードの実態 | 一致? |
|---|---|---|
| `cmdAbortTask` `main.ts:5096-5200` | `main.ts:5096` から始まり 5200 まで cleanup→markTaskAborted→insertTaskSession→CONDUCTOR_DONE→cmux.send spawn-conductor の構造 | ✅ 一致 |
| `RESET_CONDUCTOR` `daemon.ts:1646-1758` | `daemon.ts:1646` で開始、1755 で break、1758 で AGENT_TOKEN_BOUND が始まる | ✅ 一致 (1755 がより正確だが行番号誤差は Recommendation 不要レベル) |
| `SESSION_CLEAR running` `daemon.ts:2868-2929` | `daemon.ts:2868` の `if (conductor && conductor.status === "running")` から 2929 の `resetConductor(reserved, "user_clear")` まで | ✅ 一致 |
| `forceCloseDisconnectedConductor` `daemon.ts:4265` | `daemon.ts:4265` で関数開始、4310 まで | ✅ 一致 |
| `monitorConductors` disconnected ガード `daemon.ts:4222` | `if (conductor.status === "disconnected")` で囲まれた timeout 判定 | ✅ 一致 — reserved な Conductor は skip される |
| `AbortReason` に `"abort_task"` が既に含まれる | `task.ts:586` で `"abort_task"` リテラル含む | ✅ 一致 (新規追加不要) |
| `mapAbortReason("abort_task")` → `"other"` | `events-writer.ts:181-183` で `case "abort_task": case "reset_conductor": return "other";` | ✅ 一致 |
| `cleanupAssignedTask` 呼び出し元 | `main.ts:5153` (abort-task), `main.ts:5356` (restart-task) の 2 箇所のみ | ✅ 一致 — 5153 削除後は restart-task が唯一の呼び出し元 |
| `QueueMessage` discriminated union 位置 | `schema.ts:251-274`、type alias は 276-294 | ✅ 一致 |
| `resetConductor` signature | `conductor.ts:699-714` で `targetStatus: "idle" | "broken" | "reserved"`, `reason?: string` | ✅ 一致 |
| 既存 broken 期待テスト | `grep "broken.*abort\|abort.*broken" daemon.test.ts` → 0 hit。`daemon.test.ts:823` は disconnect_timeout テスト (本タスク無関係) | ✅ — assertion 更新は不要 |
| `method=sigterm` grep production hit | production 配下 (`skills/`, `docs/`) 0 件。CHANGELOG.md と tasks-archive のみヒット | ✅ — Recommendation 1 で詳述 |
| T004 テスト fixture (`daemon.test.ts:3529-3610`) | 確認、`state.traceDb = initDB(testDir)` / `pidWatcherInterval` / `mailboxWatcherStop` 仕込み / `killClaudeProcess` spy のパターンを ABORT_TASK でも再利用可能 | ✅ — Recommendation 5 の通り |
