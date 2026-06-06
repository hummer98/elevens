# T004 design review (rev2) — `elevens reset-conductor` CLI

## 1. Decision

**Approved**

R1〜R9 と補助修正はすべて plan.md 本文の該当箇所に正しく反映されている（Revision History の言葉だけ更新で本文未反映というケースは無い）。新たな矛盾も混入していない。**実装着手可**。3 件の minor / nit を Recommendations に記したので可能なら反映されたい（任意、実装段階での補正でも可）。

## 2. Summary

rev1 で Changes Requested の根拠とした critical 1 件 (R2: `markTaskAborted` reason 型違反) と major 2 件 (R1: watcher クリーンアップ漏れ / R3: `task_sessions` 行漏れ) はすべて §3.4 擬似コード・§4 データフロー・§6 テスト計画の三箇所同時に反映されている。R4〜R9 の minor / 補助修正も本文に同期している。残課題は「§6.1 の AC マッピング表が 6 件中 3 件しか挙げていない」「§3.4 で `markTaskAborted` の戻り値 shape を仮定している」「§7 RED/GREEN の step 順で `AbortReason` 型変更が GREEN 4 にあり、step 2 の RED テスト追加時にコンパイルエラーで赤くなる経路がある」の minor 3 件のみ。

## 3. R1〜R9 の反映状況

| Rec | 反映状況 | 反映先 / コメント |
|---|---|---|
| **R1** pidWatcher / mailboxWatcher 停止 | ✅ 完全反映 | §3.4 L131-141（`isAssigned` 分岐冒頭・`markTaskAborted` 前・`killClaudeProcess` 前で 2 ステップを実行）/ §4 L233 / §6.1 AC6 の assertion / §6.2 専用テスト L292 / §6.3 mock 手順 L311。SESSION_CLEAR (daemon.ts:2784–2792) と完全同形。 |
| **R2** `AbortReason` に `"reset_conductor"` 追加 | ✅ 完全反映 | §2.1 task.ts:577–585 行 L19（"6 経路 → 7 経路" コメント更新を明記）/ §3.4 L153 で `markTaskAborted(..., "reset_conductor", journal, ...)` に確定 / §6.1 AC6 で `journal が "reason=reset_conductor;" で始まる` を assertion / §7 GREEN step 4 L325 で最初に行う手順として配置。代替案 (`"user_clear"` 流用) は採用せず、観察箱原則上望ましい (a) を選択。 |
| **R3** `task_sessions` (event="aborted") 行追加 | ✅ 完全反映 | §3.4 L162-174 で `insertTaskSession({event:"aborted", role:"conductor", surface, task_run_id, session_id})` を `markTaskAborted` 直後 try/catch で挿入 / §2.1 trace-db.ts 行 L34 / §4 L236 / §6.1 AC6 assertion / §6.2 専用テスト L293 / §6.3 mock SELECT 手順 L310。abort-task (main.ts:5106–5120) と対称。 |
| **R4** `notifyStateChanged` 明示 | ✅ 完全反映 | §3.4 L178-180 で `revertedChildren.length > 0` で `notifyStateChanged("daemon.ts:handleMessage:reset-conductor-cascade")` を `markTaskAborted` 後に明示呼び出し / §4 L237。SESSION_CLEAR running 経路 (daemon.ts:2778–2779) と同形。 |
| **R5** §6.3 fixture 補強 | ✅ 完全反映 | §6.3 L305-309 で `task.md` 本体（frontmatter `status: assigned`, `taskRunId` 等）と `task-state.json` の両方を書き出す手順を箇条書きで明記 / §2.1 main.test.ts:759-772 `setupTeamDir` 行を参照可能に追加。 |
| **R6** schema テストの配置先変更 | ✅ 完全反映 | §7 RED step 1 L319 で `schema.test.ts` の "QueueMessage discriminated union" describe (L82, L461) に追加と明記 / §6.2 L300 / §2.1 schema.test.ts 行 L38 / §2.2 で `queue.test.ts` を「queue file の write/read 統合テスト用」と明記し混同防止。 |
| **R7** §8.2 (e) events.jsonl 追加判断の未解決事項 | ✅ 完全反映 | §8.2 (e) L356 で `hook_signals` の自動取込みで足りるかを判断軸として明記し user 確認事項として列挙 / §2.1 daemon.ts:1524-1530 hook_signals pipeline 行 L32 を追加。 |
| **R8** CLI 出力文言の統一 | ✅ 完全反映 | §3.2 step 5 L84 で `oldStatus = entry.status` を保持 / step 8 L89-92 で `OK reset ${normalizedSurface} (${oldStatus} → reserved)` に確定 / §6.2 main.test.ts に出力文言テスト L299。 |
| **R9** §5 エッジケース表に 2 行追加 | ✅ 完全反映 | §5 L272 (R9-1: 並行 `TASK_CREATED` race 無し) / L273 (R9-2: `assigning` + force で旧 SESSION_ENDED 遅延着信) / §7 REFACTOR step 11 L335-338 で実機 e2e 確認項目に R9-2 を明示追加。 |

### 補助的修正の反映状況

| 補助修正 | 反映状況 | 反映先 |
|---|---|---|
| `starting` 中 reset の race 注記ログ (`reset_during_starting`) | ✅ 反映 | §5 L264 / §7 step 11 L338 / §8.1 L348 |
| CLI pre-check と真値の race 明示 | ✅ 反映 | §3.2 step 6 L85 / §4 L224「best-effort UX, 真値は daemon 側」 |
| `assigning` + force での `promptSentAt`/`promptBytes` クリア assertion | ✅ 反映 | §6.2 L294 専用テスト / §8.1 L346 末尾 |
| `cleanupAssignedTask` 重複の確定 (YAGNI) | ✅ 反映 | §3.6 L212-214 新節 / §7 step 9 L333 |
| task.md の queue file 表記乖離脚注 | ✅ 反映 | §2.2 L44 |

## 4. 新たな Findings

### 4.1 [minor] §6.1 AC マッピング表が 6 件中 3 件しかカバーしていない

task.md L52-58 の受け入れ条件は **6 件**（AC1: CLI 追加 + help / AC2: `CMUX_SURFACE` 自動解決 / AC3: `RESET_CONDUCTOR` 処理 / AC4: broken/disconnected 復旧 / AC5: --force なし reject / AC6: --force あり abort+reserved）あるが、plan §6.1 の AC → テスト対応表は **AC4 / AC5 / AC6 の 3 件のみ**。

実際には §6.2 「追加カバレッジ」表に AC1 (`reset-conductor: 出力文言が ...`) / AC2 (`reset-conductor: CMUX_SURFACE env で auto-resolve できる`) / AC3 (`reset-conductor: --surface 指定で RESET_CONDUCTOR が POST される` + `daemon.test.ts` の各 case) が **個別には存在する**ため、テスト計画自体は完備している。

ただし「受け入れ条件 6 件すべてに対応するテストが具体化されているか」を一覧で示せていない構造的不備があり、実装者が自己検査する際に取りこぼす可能性がある。

**指摘理由**: 観点 3「テスト計画が実装可能か」の「受け入れ条件 6 件すべてに対応するテストが具体化されているか」に直接対応する不備。

### 4.2 [minor] §3.4 擬似コードが `markTaskAborted` の戻り値 shape を仮定している

§3.4 L154-155:
```ts
const result = await markTaskAborted(state.projectRoot, conductor.taskId,
  "reset_conductor", journal, { taskTitle: conductor.taskTitle ?? "" });
revertedChildren = result?.revertedChildren ?? [];
```

`markTaskAborted` の現行戻り値型に `revertedChildren: string[]` フィールドが含まれている保証は plan 内では明示されていない（§2.1 L31 でも import 元と引数のみ記載で戻り値型は触れず）。SESSION_CLEAR running 経路（daemon.ts:2756-2817）が `revertedChildren` をどう取得しているかが手本として妥当だが、もし `markTaskAborted` が戻り値で revertedChildren を返さず副作用 (state mutation) のみであれば、別 API（例えば `loadTaskState` を再 read して比較）で取得する必要がある。

`result?.revertedChildren ?? []` の Optional chaining でガードはされているため戻り値が undefined でも runtime error にはならないが、その場合 `revertedChildren.length > 0` の条件が永遠に false となり R4 の `notifyStateChanged` 明示呼び出しが死に行になる。

**推奨対応**: §2.1 か §3.4 の補注で、`markTaskAborted` の戻り値型を 1 行確認するか「SESSION_CLEAR と同じ取得経路を用いる」と明記。実装時に `task.ts` を読んで確認すれば判明する事項なので Changes Requested には至らない。

### 4.3 [minor] §7 RED → GREEN 順で `AbortReason` 型追加が後ろ倒し

§7 step 順序:
- RED step 2: `daemon.test.ts` に「force=true で running → reserved + aborted + task_sessions 行 + watcher 停止」テスト追加
- GREEN step 4: `task.ts:577–585` の `AbortReason` union に `"reset_conductor"` 追加

step 2 で追加するテストの中で `markTaskAborted(..., "reset_conductor", ...)` をモック越しに呼び出す test setup を書こうとすると、TypeScript の strict 型チェックで **AbortReason union が "reset_conductor" を含まないため step 2 時点でテストが書けない**（コンパイル fail で RED にすら到達しない可能性）。

ただし step 2 のテスト assertion 自体は `journal が "reason=reset_conductor;" で始まる` という文字列マッチであり、`markTaskAborted` 呼び出しを mock しなくても daemon の handleMessage 経由で間接的に動かす test design なら型エラーは出ない。実際 §6.3 の fixture 仕様は `markTaskAborted` を直接呼ばず handleMessage 経由で走らせる前提。

**推奨対応**: 厳密にするなら GREEN step 4 (`AbortReason` 追加) を **RED step 1 の前に置く**（型変更だけは TDD の前段で済ます）か、§7 冒頭に「step 4 の AbortReason 追加は型のみの変更で先行実施可」と注記する。実装者が混乱しなければ現状でも可。

## 5. Recommendations

優先度の高い順に記載。Changes Requested ではないので任意対応で良い。

### Rec1 (推奨): §6.1 AC マッピング表を 6 件すべて拡張

§6.1 の表に以下 3 行を追加して全 AC をマップする:

| AC | テストファイル | テスト名 | 主な assertion |
|---|---|---|---|
| AC1: CLI が main.ts に追加され help にも記載 | `main.test.ts` + 手動確認 | `reset-conductor: 出力文言が "OK reset <surface> (<oldStatus> → reserved)" 形式である` + `bun run main.ts reset-conductor --help` | 出力文字列マッチ + help テキスト存在確認 |
| AC2: `--surface` 省略時 `CMUX_SURFACE` から自動解決 | `main.test.ts` | `reset-conductor: CMUX_SURFACE env で auto-resolve できる` | env 設定下で `receivedMessages[0].surface` が期待値 |
| AC3: Manager 側で `RESET_CONDUCTOR` を処理 | `daemon.test.ts` 全 case + `schema.test.ts` | 全 RESET_CONDUCTOR テスト | discriminatedUnion パース + handleMessage の各分岐 |

### Rec2 (任意): §3.4 補注に `markTaskAborted` 戻り値型確認を 1 行

L154 のコメントに「※ `markTaskAborted` の戻り値型に `revertedChildren` が含まれる前提。実装着手時に task.ts を確認」を 1 行追加。または §2.1 の `markTaskAborted` 行に戻り値型を追記。

### Rec3 (任意): §7 step 順の補強

§7 冒頭に注記を追加:
> step 4 (`AbortReason` への `"reset_conductor"` 追加) は型変更のみで RED テスト追加 (step 1〜3) の前に先行実施しても良い。strict mode 下で test 内に `"reset_conductor"` リテラルが現れる場合は型エラー回避のため step 4 を先行させる。

## 6. 既承認項目（rev1 で問題なしと判定済み、rev2 でも維持）

- §2.1 / §2.2 / §2.3 の既存コード調査は正確
- §3.1 schema 配置設計
- §3.2 CLI ヘルパー流用方針 (R8 反映後)
- §3.3 i18n 追加方針
- §3.4 daemon ハンドラの全体構造 (R1〜R4 反映後)
- §3.5 pane タブ名は本タスクスコープ外
- §3.6 cleanupAssignedTask 抽出見送り (YAGNI 確定)
- §4 データフロー図 (R1/R3/R4 反映後)
- §5 エッジケース表 (R9 + 補助修正反映後、包括的)
- §7 TDD 順序の枠組み（minor 4.3 を除けば妥当）
- §8.1 リスク列挙
- §8.2 (a)〜(e) 未解決事項

---

レビュー終了。Implementer に渡せる状態。Rec1〜Rec3 は実装中に補正可能なため Approved とする。
