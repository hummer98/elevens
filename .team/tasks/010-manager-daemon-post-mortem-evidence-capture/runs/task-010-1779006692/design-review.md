## Verdict: Approved

## Summary

改訂版 plan v2 は前回指摘の 7 件すべてに具体的かつ構造的な対応を入れている。中核は **R1 採用 (a)**: `installCrashHandler` の `uncaughtException`/`unhandledRejection` listener を撤去し fatal-handlers.ts に完全集約する設計に転換した点と、**R2**: reload.ts への `--__post-mortem-redirected` 伝播を独立サブタスク **S5.1** として切り出した点。これにより前回 critical 2 件（handler 順序前提誤り / reload 伝播漏れ）はいずれも構造で解消されており、main.test.ts / daemon.test.ts への影響評価・shutdown signature の bind 具体例・S8 の CI 統合可否 decision・S9 spec の §5 重複経路節・D6 別タスク起票指示も計画書に明記された。新規 critical 0 件、新規 major 0 件、minor inconsistency 1 件（§3.2 と §S6 で signal bind の所在記述が衝突）のみ。R1〜R7 全 resolved。

## 前回 Findings の解消状況

| ID | Severity | 内容（要点） | 状態 | 反映箇所 |
|---|---|---|---|---|
| F1 | critical | handler 順序の前提誤り（`process.exit` 同期 terminate により後続 listener が走らない） | **Resolved** | §2.2 / §S2（pidfile.ts listener 撤去 + fatal-handlers.ts 集約）/ §3.2 / §3.3 / §5.1（順序問題の構造的解消を明記）/ §D7 新設 |
| F2 | critical | reload.ts の `--__post-mortem-redirected` 伝播がサブタスク欠落 | **Resolved** | §3.2 表に reload.ts 追加 / **§S5.1 新設**（args 変更 + assertion）/ §9 実装順序に組込 |
| F3 | major | `shutdown(signal?)` bind 経路の具体化 | **Resolved** | §S6 完了条件に SIGINT/SIGTERM/SIGHUP + onQuit("dashboard_quit") + onFullQuit("dashboard_full_quit") の bind 例を列挙 / §2.2 |
| F4 | major | `main.test.ts` / `daemon.test.ts` への影響評価不足 | **Resolved** | §S6 検証に両ファイル `bun test` + `grep "shutdown(" *.test.ts` を明記 / §5.3 |
| F5 | minor | `scripts/test-crash-evidence.sh` の CI 統合可否 | **Resolved** | §S8 で「開発者ローカル前提、CI 化は別タスク」と明示的に decide |
| F6 | minor | fatal trace 重複経路の spec 反映 | **Resolved** | §S9 に「**5. fatal trace の重複経路**」節追加。R1 改訂後に (b) 経路が実質消えることも明記 |
| F7 | nice-to-have | D6 (bun crash report) 別タスク起票指示 | **Resolved** | §D7 末尾に `cmux-team create-task --status draft ...` の具体コマンド + artifact 作成手順を明記 |

## Findings

### N1 (minor) — §3.2 と §S6 で signal bind の所在記述が衝突している

§3.2 「main.ts 変更概要」の (5) は

> `process.on("SIGINT", () => shutdown("SIGINT"))` / `process.on("SIGTERM", () => shutdown("SIGTERM"))` / `process.on("SIGHUP", () => shutdown("SIGHUP"))` の bind を明示化

と main.ts 側で bind するように書いてある。一方 §S6 完了条件の「signal bind を明示化（R3 反映）」末尾には

> fatal-handlers.ts の signal listener と同じ pattern。fatal-handlers 側で install するなら main.ts 側は重複を避けるため install しない — どちらか一方に集約する。**採用**: fatal-handlers.ts に集約し、main.ts 側の `process.on("SIGINT", shutdown)` 等は撤去

とあり、最終採用は「fatal-handlers.ts に集約 / main.ts 側は撤去」である。§3.2 (5) の記述が R3 反映前のドラフトのまま残っており、実装時に「結局どちらに書くか」で迷う原因になる。critical 級ではないが、最終 plan として decision がブレている点は実装着手前に解消すべき。

なお、`fatal-handlers.ts` に集約する場合でも fatal-handlers.ts 内の signal listener が `onShutdown(signal)` を await する仕様（§S2 完了条件で明記）と整合するので、設計自体の問題はない。表記の調整のみ。

## Recommendations

### N1 対応（SHOULD、実装着手前に解消）

§3.2 の main.ts 変更概要 (5) を以下のいずれかに書き換える:

- **採用 A（fatal-handlers.ts 集約 — §S6 と整合）**:
  > (5) 既存の `process.on("SIGINT", shutdown)` / `process.on("SIGTERM", shutdown)` 直接 bind を**撤去**。SIGINT / SIGTERM / SIGHUP の listener は fatal-handlers.ts の `installFatalHandlers({ onShutdown })` 経由で install され、shutdown 呼び出しに signal 名を渡す責務もそちらが負う。
- 採用 B（main.ts に bind を残す）に変更する場合は §S6 完了条件側を書き換える必要があるが、`installFatalHandlers` が `onShutdown` を受け取る設計（§S2 で明記）と二重 bind になる risk があるため非推奨。

採用 A に揃え、§S6 の該当文と一貫させるのが最小差分。

---

R1〜R7 すべて resolved、新規 critical / major 0 件。N1 は表記の整合性問題で実装の構造を変えるものではないため Approved 判定。実装着手時に N1 を反映してから S1 から逐次着手すること。
