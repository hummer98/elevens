# T026 完了サマリー: surface タブタイトル `[N] Claude Code` 上書き fix

## 結論

surface のタブタイトルが c11 default title setter（**W-A**）等によって固定名 `[N] Conductor` / `[N] Agent` から `[N] Claude Code` に上書きされる問題を、**Master が既に行っている「SESSION_STARTED hook 駆動の counter-rename」を Conductor / Agent / restart / reserved に横展開**して修正した。Inspector 判定 **GO**。

## Phase 別の成果

### Phase 1: writer 特定（findings.md, researcher surface:128）
- **W-A** = c11 binary の default title setter。surface 作成 ~570ms 後に `[N] Claude Code` を **source=explicit** で書く。常時発火、env で無効化不可。
- **W-B** = using-cmux plugin v1.8.0 の SessionStart hook。gate は `[ -n "$CMUX_SURFACE_ID" ] && [ -z "$CMUX_NO_RENAME_TAB" ]` + plugin enabled cwd。elevens worktree では plugin disabled のため発火せず。
- 両 writer とも source=explicit → **OSC 抑止（`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`）では効かない**ことを確定。
- `CMUX_NO_RENAME_TAB` は **dead flag ではない**（using-cmux が参照、Conductor env が =1 を設定）。
- recap（作業要約への動的書き換え）は本フェーズでは**再現できず**、follow-up 扱い。

### Phase 2-3: 計画→設計レビュー→実装
- plan.md（surface:137）→ design-review.md（surface:138, **Approved 条件付き / Recommendations #1-#9**）→ TDD 実装。
- fix 方針: SESSION_STARTED という決定論的イベントに乗って後着で counter-rename。OSC 抑止は入れない（writer が explicit のため無意味）。last-write-wins の競争に持ち込まない構造（CLAUDE.md 原則準拠）。

### Phase 4: 検品（inspection.md, inspector surface:157）
- **総合判定 GO**。Fix Required なし。Recs #1-#8 全反映、実装タスク 1-8 網羅、テスト 6 ファイル 0 fail、tsc 新規エラー 0、構造原則違反なし。

## 変更ファイル（9 ファイル）

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/cmux.ts` | `assertTabTitle(surface, title, contextForLog)` ヘルパ追加（L245-261）。成功時 `title_reassert` log / 失敗時 `title_reassert_failed` error log で例外抑止。observatory 原則で再発を pull 観測可能に |
| `skills/cmux-team/manager/daemon.ts` | Master counter-rename を assertTabTitle 化（L2111-2117）。Conductor SESSION_STARTED 分岐に counter-rename 追加（L2225-2231、mailboxWatcher 直後、broken 早期 break では非到達）。Agent 分岐にも追加（L2319-2325、main.ts:2932 hook 引用コメント付き） |
| `skills/cmux-team/manager/conductor.ts` | reserved 分岐の遅延 re-rename を追加（L299-356）。`resolveReservedRenameDelayMs` で config 読込、各 pane の delay 付き re-rename を `Promise.all` で**並列化**（W-A ~570ms を後着上書き、N pane でも合計遅延一定） |
| `skills/cmux-team/manager/config.ts` | `cmux.reservedRenameDelayMs` config 追加（L121-149、default 800ms、clamp [0,60000]） |
| `skills/cmux-team/manager/main.ts` | restart 経路に `CMUX_NO_RENAME_TAB=1` 追加（L5618-5625）。export 3 箇所（L3300/3389/3656）に「dead flag ではない、削除不可」コメント。Agent spawn 末尾 renameTab を assertTabTitle 化（L3823, DRY） |
| `cmux.test.ts` | T1: assertTabTitle 成功/失敗テスト |
| `daemon.test.ts` | T2: Conductor counter-rename（4 状態 + broken 非発火）/ T3: Agent counter-rename |
| `conductor.test.ts` | T4: reserved 遅延 re-rename + Rec #2 並列化検証（実時刻測定） |
| `main.test.ts` | T5: restart 経路の env 全部入り static assert |

## テスト結果（per-file、`bun test` 全体は禁忌）

cmux 40 pass / conductor 55 pass 3 skip / daemon 242 pass 2 skip / main 274 pass / master 22 pass / config 63 pass — **全 0 fail**。
tsc: 新規エラー **0 件**（baseline HEAD と stash 比較で確認。既存 8 件は c11-features / mailbox-cli / main.ts:1043 で本変更と無関係）。

## 試行錯誤・環境メモ

- 実装 Agent が 2 回（surface:139, 142）、検品 Agent が 1 回（surface:154）、いずれも **pid_watcher crash**。10:09-10:27 の窓で idle だった planner(137)/design-reviewer(138) も同時 crash しており、特定 Agent ではなく**一過性の環境 event**（token 枯渇でも sleep/wake でもないことを確認: 全 token max-x20 selectable、wake_detected なし、daemon/c11/32 claude プロセス健在）。
- 実装は 2 体の Agent によって完成しており（result.md は crash で未生成）、Conductor が独立にテスト + tsc baseline 比較で green を確認。その後 Inspector(157, retry)が正常完走し GO 判定。

## 申し送り（follow-up、本 PR スコープ外）

- **recap への動的書き換え**: Phase 1 で再現できず未対処。production で `grep title_reassert .team/logs/manager.log` + `c11 get-metadata --sources` で継続観察し、再現したら別タスクで対応。
- `reservedRenameDelayMs` の docs/spec 追記（minimal scope 原則で本 PR には含めない）。

## 納品

ローカル ff-only マージで `main` へ。commit / マージ SHA は close-task 時に記録。
