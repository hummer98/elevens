---
id: A033
type: research
title: "T024: spawn-agent split 再発の root cause（実機 v0.8.2 が T017 fix 前）と事象A follow-up 仮説"
created: 2026-05-24T00:01:56.328Z
author: surface:28
task: 024
---

## 背景

直近 2 タスク（T021, T019）が連続で `disconnect_timeout` により abort し、同時間窓で「空の split ペイン」（surface:110/113/115/116）が量産された。T017（spawn-agent の Agent 起動先が別 pane/split になる不具合, ea6dc57 で fix・merged）の再発が疑われた。事象は 2 系統に切り分けられた。

- **事象A** — Conductor が無言で死に `disconnect_timeout` で task が abort（compact 直後から崩れる）
- **事象B** — 空の split ペインが量産され、しかも `manager.log` に一切記録されない

## 調査結果

### 事象B の確定 root cause: 実機が T017 fix 前の published v0.8.2

実機 PATH 上の `elevens` は `/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/lib/node_modules/@hummer98/elevens`（published `@hummer98/elevens@0.8.2`）。この版の `getPaneForSurface`（`cmux.ts:271-286`）は

```ts
if (line.includes(surface) && currentPane) return currentPane;  // L279
```

という **substring match バグ**を持つ。`surface:11` を探すと `surface:110` / `surface:113` / `surface:115` / `surface:116` を含む行に誤マッチし、誤った pane を返す。spawn-agent はその誤 pane に対し `new-surface`（progressive split）を発行 → 中身のない `[N] Claude Code` が量産された。

HEAD（worktree）の `getPaneForSurface`（`cmux.ts:298-310`）は既に

```ts
const surfaceMatches = line.match(/surface:\d+/g);
if (surfaceMatches.includes(surface)) return currentPane;  // 完全一致
```

に修正済み（T017 fix = ea6dc57）。git log 上、`2a08770 chore: release v0.8.2` は `ea6dc57`（T017 fix）より**前**のコミットなので、**v0.8.2 tarball には T017 fix が含まれていない**ことが構造的に確定する。

→ **コードでの再修正は不要。実機解消には本 fix を含む patch release + ユーザー環境の再 install が必須。**

### 観察箱としての真の欠陥（本タスクで修正した点）

上記の物理原因が起きていた時、`manager.log` には split / new-surface / 110・113・115・116 の手がかりが**一切残らなかった**。CLAUDE.md「silent state mutation を作らない」「observer が pull で観測できる」原則に反する。HEAD でも cmdSpawnAgent は pane 解決 / newSurface 生成を log していなかった。

そこで `cmdSpawnAgent`（`main.ts`）に決定論的 log 2 件を追加した:
- `spawn_agent_pane_resolved`（getPaneForSurface 直後・`if (!targetPane)` の前。pane 解決結果を残す。失敗時 `target_pane=(none)` を残してから throw → catch の `spawn_agent_failed` と 2 行ペア）
- `spawn_agent_surface_created`（newSurface 成功代入後。どの pane にどの surface を生やしたか + conductor/role/caller_workspace を残す）

これで今後 substrate 側の問題等で pane 誤解決が再発しても、`manager.log` の grep だけで「どの conductor から、どの workspace を caller として、どの pane に、どの surface を作ったか」を再構成できる。

### スコープ外と判断した項目（minimal scope）

- published v0.8.2 の substring バグ再修正（HEAD で fix 済み）
- `events.jsonl` への agent lifecycle event 追加（`docs/spec/10-events-stream.md` §5 が意図的に Agent lifecycle を含まない。manager.log で観察可能性ギャップは埋まる）／ spec 更新
- 新規テストファイル（`cmux.test.ts:347-394` の prefix collision regression test が surface:2 vs surface:26/27 で同クラスをカバー済み）

## 事象A の follow-up 仮説（未着手・再現観察待ち）

事象A（`disconnect_timeout` abort）は spawn-agent split とは別系統。観測パターン: Conductor が compact 起動 → compact 中/直後にセッションが無言で死亡 → PID watcher / SESSION_ENDED で disconnected → DISCONNECT_TIMEOUT_SEC(300s) 超過 → forced close → `task_aborted reason=disconnect_timeout`。

| # | 仮説 | 検証の取っかかり |
|---|------|------------------|
| H1 | compact が token pool / proxy 経由で 401 / rate limit を引き Claude Code が落ちる | `manager.log` の `token_pool_*` / `proxy.ts` の 4xx / compact 直前後の `api_usage` |
| H2 | compact が大量 context 圧縮で Claude Code 内部 OOM / crash | Conductor pane 最終出力 / `.team/output/conductor-N/` 末尾 / macOS crash log (`~/Library/Logs/DiagnosticReports/`) |
| H3 | compact 中の state mutation で daemon が意図せず disconnected 判定 | `manager.log` の `SESSION_ENDED` reason / `task-state.json` journal / `hook_signals` の SessionEnd |
| H4 | 事象B の巻き添え（別 pane に作られた Agent の死亡を Conductor 死と誤観測）= A・B が同一系統の二次症状 | **T024 fix を含む版で再現待ち。消えれば H4、残れば H1→H3 を順に検証** |

**検証順序**: まず T024 fix（+ release）を含む版で再現観察（H4 検証）→ 再発すれば H1〜H3 を trace DB（`api_usage` / `hook_signals` / `task_sessions`）を起点に切り分け。CLAUDE.md「risk 小 follow-up は draft 保留せず」に従い、事前 task 起票はせず再発時に本記録を参照して 1 分で起票する方針。

## 結論

1. 事象B の真因は実機の古い v0.8.2（T017 fix 前）。**release で実機解消する**。コード再修正は不要。
2. observatory ギャップ（pane 解決・surface 生成が無記録）を log 2 件で解消した（本タスクのコード成果物）。
3. 事象A は別系統。H1-H4 仮説を記録。T024 fix 後の再現観察で H4 を最初に検証する。
