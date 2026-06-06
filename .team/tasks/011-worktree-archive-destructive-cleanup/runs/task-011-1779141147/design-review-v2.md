# Design Review v2: T011 plan.md

## 判定

**Approved**

## サマリー

前回 Changes Requested の Critical [C1] + Major [M1]〜[M4] + Minor [m1]〜[m10] の **計 15 件すべてが plan.md に取り込まれており**、改訂による新規の Critical / Major 級の整合性ズレも検出されない。特に [C1] (`daemon.ts:3034` SESSION_CLEAR running, user_clear) は §2.2 (H) / §4.3 / §4.4 / §6.1 / §9.4-4 / §12 AC の 6 箇所すべてに展開されており、第一ゴール「正常完了以外は archive 化」が手動 `/clear` 経路まで含めて満たされた。[M4] の `CleanupMode` discriminated union 化も `preserveWorktree` との後方互換移行戦略まで明示されており、Phase 2 で required 昇格させる TODO も §13 に書かれている。実装に着手して良い。

## 前回指摘の取り込み状況

| 指摘 | 状態 | コメント |
|---|---|---|
| [C1] SESSION_CLEAR 経路 (daemon.ts:3034, user_clear) | ✅取り込み済 | §2.2 (H) 行 49 / §4.3 reason enum 行 132 / §4.4 event reason union 行 152 / §6.1 before-after 行 474-481 / §9.4-4 archive-user_clear test 行 727 / §12 AC 行 824 の **6 箇所すべて**に展開済み。Implementer 向け補足 §13 行 840 にも「(H) = SESSION_CLEAR running は手動 `/clear` 時の進行中 worktree 保全に必須」と明記 |
| [M1] events schema に archived_at 追加 | ✅取り込み済 | §4.4 行 159 で `archived_at: string;` 追加 / §5.1 手順 6・8 行 249-251 で「meta.json と event の `archived_at` は必ず同値」を明文化 / 行 166 で `ts` (writer flush 時刻) と `archived_at` (mv 完了ドメイン値) の概念分離を説明 / §9.2 行 710 で `ts` と `archived_at` が並列して JSON line に出る test 追加 |
| [M2] section block placeholder への変更 | ✅取り込み済 | template は `{{ARCHIVED_WORKTREE_SECTION}}` 1 個に一本化（§7.1 行 568-573）。`buildArchivedWorktreeSection(undefined)` → 空文字で section 全体が prompt から消える設計（§5.5 行 322）。これにより前回指摘の「`cd ` カレント維持で `cat .archive-meta.json` 走らせるリスク」は構造的に発生不能。§7.4 04-templates.md 追記 (行 622-626) / §9.5 integration test (行 736-738) 込み |
| [M3] WRITE_COMMANDS flat 化 | ✅取り込み済 | §2.3 行 61 で `worktree: new Set(["archive-remove", "archive-prune"])` 採用、`isWriteCommand` 側に `args[1] + "-" + args[2]` を subCmd として組み立てるアダプタを 1 行追加 (行 62) / §11 R8 (行 810) で採用案明記 / list/show は write 対象外で cwd 外から oncall 確認可能の UX 維持 / §9.6.1 cli-project-root.test.ts に `isWriteCommand("worktree", "archive-list") === false`, `("worktree", "archive-remove") === true` のアダプタ検証 test 追加 |
| [M4] cleanupMode discriminated union | ✅取り込み済 | §5.1 行 221-224 で `CleanupMode = { kind: "delete" \| "archive" \| "preserve" }` union 定義 / `ResetConductorOpts.cleanupMode?: CleanupMode` 追加 (行 230) / `preserveWorktree` opt は DEPRECATED で両方サポート、`cleanupMode` 優先 (行 231, 236) / 未指定時は `{ kind: "delete", reason: "legacy_fallback" }` で後方互換 (行 235) / Phase 2 で required 昇格 TODO を `conductor.ts:resetConductor` にコメント (行 401) / §6.1 行 391-438 で実装の before-after 提示 / §11 R12 (行 814) と §13 (行 838) で「社会的契約ではなく型レベルの構造的防御」と明記 |
| [m1] positional 引数 10 個問題 | ✅取り込み済 | [M2] section block 一本化により positional 引数増は **1 個のみ** (`archivedWorktreeSection: string = ""`, §7.2 行 588)。前回懸念の「10 個に膨らみ取り違いリスク」は緩和され、options object 化への移行は不要に |
| [m2] §11 R1 の表現矛盾 | ✅取り込み済 | §11 R1 行 803 を「**規約上発生不可** — `taskRunId` は ... unique。同時に同 task が assigned になることはない（task FSM が `assigned` 単一性を保証）。**規約上発生しないが念のため `archiveWorktree()` の target_exists skip で no-op**」に書き換え済み。冪等性主張との整合取れている |
| [m3] prune の deleteBranches default false の運用ガイド | ✅取り込み済 | §5.4 行 312 で「default は **false**」明記 + 「Phase 2 retention 自動化と合わせて branch 削除戦略を `docs/spec/16-worktree-archive.md` §retention に書く」/ §11 R6 (行 808) で「Phase 2 で `deleteBranches` default を再検討」/ §8.1 §11 retention 章で branch 削除戦略 + Phase 1/Phase 2 境界明記 (行 646) |
| [m4] integration test 8 + 2 = 10 件 + test 番号体系統一 | ✅取り込み済 | §9.4 行 720-733 で 10 ケース構成、test 番号体系 `archive-<reason>` で統一を明記 (行 722)。8 経路 (A-H) archive test + 2 regression (success=delete / judgment=preserve) で AC §12 マッピングが取りやすい |
| [m5] CLI 名 elevens vs cmux-team 明記 | ✅取り込み済 | §8.1 §9 CLI 章で「CLI 名 `elevens` vs `cmux-team` の関係 1 行明記 [m5]」(行 644) / §13 Implementer 補足 行 844 で「CLI 名は `elevens` と `cmux-team` 両対応」明記 |
| [m6] findArchivesForTaskId 壊れた meta ログ event 名 | ✅取り込み済 | §5.2 行 282-284 で `archive_meta_unreadable` (I/O 失敗・ENOENT・EACCES) と `archive_meta_invalid` (JSON parse 失敗・必須フィールド欠落) を明確に分離 + 必須フィールド列挙 (schema_version, task_id, task_run_id, archived_at, reason, branch) / §8.1 §6 (行 641) でも spec への記載指示あり / §9.1 test (行 699-700) でも両方を独立 case 化 |
| [m7] worktrees-archive 書き込み経路規約 | ✅取り込み済 | §8.1 §12 で「`.team/worktrees-archive/` の write 経路規約（**daemon 専有領域**、CLI 経由でのみ操作 [m7]）」を spec の章として独立 (行 647) / §13 行 845 でも「daemon / CLI 経由のみで操作。手書き禁止を spec §12 に明記」 |
| [m8] cli-project-root.test.ts 追加 | ✅取り込み済 | §9.6.1 (行 750-754) で `cli-project-root.test.ts` に test 追加が新規 sub-section として明記。read/write の judgment + adapter `isWriteCommand("worktree", "archive-XXX")` の真偽値検証も入った |
| [m9] dry-run と yes の優先順序 | ✅取り込み済 | §5.6 行 354 で「両方指定された場合は `--dry-run` を優先（削除前確認に倒す保守側設計）」を明文化 / §8.1 §9 (行 644) で「`--dry-run` と `--yes` の優先順序 [m9]」を spec 章に含める指示 / §9.6 行 748 で test case 追加（併用時 dry-run 優先で削除されない） |
| [m10] worktreePath が archive 先に移動した assertion | ✅取り込み済 | §9.4 各 archive test (行 724-729) で「worktreePath が `.team/worktrees-archive/...` に移動」を assertion として明示 / §11 R5 (行 807) でも「`worktreePath が ... に移動した` assert も §9.4 に追加 [m10]」明記 |

## 新規発見事項

### Critical

なし。

### Major

なし。

### Minor

- **[v2-m1] `legacy_fallback` 経路の observatory trace の弱さ**: §4.3 / §6.1 で「`cleanupMode === undefined` → `{ kind: "delete", reason: "legacy_fallback" }` で削除」となっており、events.jsonl には `worktree_archived` は emit されない（archive ではなく削除なので妥当）。ただし `manager.log` 側にも archive 経路と違って独立した event 名が無く、`cleanup_failed` の場合のみ `cleanup_reason=legacy_fallback` が残る (§6.1 行 428, 435)。**正常系の legacy_fallback delete は痕跡が一切残らない**。Phase 1 中の移行検証で「想定外の legacy_fallback 経由削除が起きていないか」を後追いしたい場合に困る。対処案: §6.1 の delete 経路に `await log("worktree_delete_legacy_fallback", "task_id=... task_run_id=... cleanup_reason=...")` を 1 行追加して、grep で検出可能にする（成功時も失敗時も）。観察箱原則 (CLAUDE.md「機能追加の判断軸: observatory に資するか」) を踏むなら +1 行のコストで価値あり。**Approved 判定を妨げない** — Phase 2 で `cleanupMode` required 昇格すれば legacy_fallback は消えるため、暫定の trace で十分。

- **[v2-m2] `notifyStateChanged` を emit しない判断 (§5.1 手順 9, 行 252) の根拠補強**: 「dashboard refresh 対象ではない — observatory への通知は events.jsonl 経由」と書かれているが、現状 dashboard が archive 数 / 最新 archive を表示しない仕様であることを背景として明示するか、あるいは「将来 dashboard に archive widget を載せる場合は events.jsonl tail で吸う」という方針を §8 spec の「Phase 2」章に 1 行入れると将来の判断材料になる。**Approved 判定を妨げない** — minimal-scope 原則 (MEMORY.md [Feedback: minimal scope]) からして read side 拡張で済む話なので、Phase 1 plan に含めない判断は妥当。

- **[v2-m3] §6.1 経路 F (handleConductorDone) の cleanupMode 確定が「§6 実装時に再 grep」依存**: 行 47, 489 で経路 F (handleConductorDone success=false 系) と経路 G (main.ts:1620 resume) の cleanupMode 値が「§6 実装時に再 grep」「現状を §6 実装時に再 grep」と書かれており、Implementer に判断を委ねている。経路 F の分岐ロジックは §6.1 末尾 (行 497-501) で `success/unresolved` の 3 通りに正しく分類されているので問題ないが、経路 G (resume) は §6.1 行 488-494 で「`{ kind: "archive", reason: "resume" }`」と確定しているのに §2.2 表の G 行 (行 48) では「（要確認: §6-G 詳細）」のままで表現がブレている。**Approved 判定を妨げない** — Implementer は §6 の確定値を採用すれば良いが、§2.2 表を「`{ kind: "archive", reason: "resume" }` ※ §6.1 で確定」のように同期させると plan 内整合が増す。

## Approved / Changes Requested の判断理由

- **Critical: 0 件** — [C1] が完全に取り込まれ、`daemon.ts:3034` 経路を含む全 8 経路 (A〜H) と integration test 4 (archive-user_clear) で網羅されている。手動 `/clear` で進行中 worktree が消える既知バグの修正経路が plan に閉じ込められた。
- **Major: 0 件** — [M1] (archived_at) / [M2] (section block) / [M3] (WRITE_COMMANDS flat) / [M4] (CleanupMode union) の 4 件すべてが構造的・型レベルで取り込まれ、特に [M4] は CLAUDE.md「逸脱を防ぐより、逸脱しても安全な構造にする」「構造的正しさを優先」の原則に沿った discriminated union 化で社会的契約から型強制に昇格した。`preserveWorktree` opt との後方互換戦略も Phase 2 までの移行 TODO 込みで明示されている。
- **Minor: 0 件 (前回指摘) + 3 件 (新規・対応任意)** — 前回 minor は 10 件すべて取り込み済み。新規 [v2-m1]〜[v2-m3] は observatory 側の改善余地で、Approved を妨げる性質ではない。
- **改訂による新規不整合**: 検出されない。`opts?.cleanupMode ?? (opts?.preserveWorktree ? { kind: "preserve" } : { kind: "delete", reason: "legacy_fallback" })` の優先順位 (§6.1 行 397-400) は §5.1 行 236 の「両方指定された場合は `cleanupMode` を優先」と整合。経路 F の `success/unresolved` 3 分岐も型矛盾なし。
- **AC §12 カバレッジ**: 11 件すべて plan section と対応がついており、抜けなし。`elevens worktree archive {list,show,remove,prune}` / `events.jsonl` `worktree_archived` event (archived_at 含む) / `docs/spec/16-worktree-archive.md` 新規 + 関連 spec 更新 / 既存 test 個別実行 (CLAUDE.md「`bun test` 全体実行は禁忌」遵守) まで含む。
- **§10 実装順序の妥当性**: Step 1 (events writer 変種追加) → Step 2 (archive lib + test) → Step 3 (template) は独立で並列可能、Step 4 (resetConductor cleanupMode 拡張) → Step 5 (daemon 6 箇所 + integration test 10 ケース) → Step 6〜8 が依存連鎖、Step 9 (CLI) は独立、Step 10-11 (docs + 全 test)。test-first 厳守。[C1] による daemon 経路追加 (5 → 6 箇所) も Step 番号は維持されており、ロードマップとして実装着手可能。

判定基準（Critical 0 + Major 0〜2 + 対応明示で Approved）を満たすため **Approved** で確定。Implementer はこの plan に沿って実装に進んで良い。新規 minor [v2-m1]〜[v2-m3] は実装中に余裕があれば取り込むか、Phase 2 で別タスクとして扱う判断で可。
