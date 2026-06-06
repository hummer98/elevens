# T024 完了サマリー

## タスク
連続 disconnect_timeout abort + 空 split ペイン量産の調査・修正（T017 再発疑い）

## 結論（root cause）
事象B（空 split ペイン量産）の物理原因は **実機 PATH 上の `elevens` が published `@hummer98/elevens@0.8.2`** であったこと。この版の `getPaneForSurface`（cmux.ts L271-286）は `line.includes(surface)` の **substring match バグ**を持ち、`surface:11` が `surface:110/113/115/116` を含む行に誤マッチして誤った pane を返す → spawn-agent がその pane に split で空ペインを生やしていた。
- git log 上、v0.8.2 release (2a08770) は T017 fix (ea6dc57) より**前**。よって v0.8.2 は T017 fix を含まない。
- **HEAD では ea6dc57 で完全一致照合に修正済み**。コードでの再修正は不要。**実機解消には本 fix を含む patch release + 再 install が必要**。

事象A（disconnect_timeout / compact → Conductor 死）は spawn-agent split とは別系統。本タスクのスコープ外として follow-up 仮説（H1-H4）を artifact に記録。

## 実施したフロー
- Phase 1 Planner（A[124]）: 実機 env で findings を独立再確認 → plan.md 作成
- Phase 2 Design Review（A[125]）: **Approved**（file:line 実機検証済み）
- Phase 3 Implementer（A[126]）: cmdSpawnAgent に log 2 件追加
- Phase 4 Inspector（A[127]）: **GO**（テスト 561 pass、tsc 新規エラー 0、root cause 裏取り）

## コード成果物（observatory ギャップ解消）
`skills/cmux-team/manager/main.ts` の `cmdSpawnAgent` に決定論的 log 2 件を追加（+17 行）:
- `spawn_agent_pane_resolved`（getPaneForSurface 直後・if(!targetPane) の前。失敗時 target_pane=(none) を残す）
- `spawn_agent_surface_created`（newSurface 成功代入後。どの pane にどの surface を生やしたか記録）

これにより、事象B の根本欠陥「pane 解決・surface 生成が manager.log に一切残らない」（silent state mutation）を解消。

## スコープ外（plan §2.3 のとおり実施せず）
- published v0.8.2 の substring バグ再修正（HEAD で fix 済み）
- events.jsonl への event 追加・spec 更新（minimal scope）
- 新規テストファイル（既存 prefix collision test で十分）
- 事象A の修正

## テスト結果
per-file（CLAUDE.md「bun test 全体禁忌」遵守）: cmux.test.ts 38 pass / main.test.ts 273 pass / state-machine 3 file（15+191+44）pass = **計 561 pass / 0 fail**。tsc 新規エラー 0（既存 main.ts:1043 TS2322 1 件のみ、baseline と同一）。

## 残作業・follow-up
- **release が必要**: 実機 elevens を v0.8.2 → 本 fix 含む最新版に上げないと事象B は実機から消えない（plan §6.2）。
- **事象A は事前起票せず**（plan §7.3）: T024 fix を含む版で再現観察。H4（spillover）が当たれば fix で消える可能性。消えなければ artifact の H1-H3 を順に切り分けて新規 task を起こす。
- 新 log 2 行の実機 grep 検証は次回 spawn-agent で自然に確認される。

## 納品
ローカル ff-only マージ（main）。詳細は close-task journal 参照。
