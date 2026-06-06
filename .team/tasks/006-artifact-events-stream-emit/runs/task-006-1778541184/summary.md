# Task 006: artifact 追加を events stream に emit (Phase 1)

## 完了サマリー

`addArtifact()` が events stream に `artifact_added` event を emit するようになった。`.team/logs/events.jsonl` を tail する dashboard / watch / retro / trace-task から artifact 生成イベントを追えるようになる（observatory layer の一部完成）。

## 変更ファイル

- `skills/cmux-team/manager/events-writer.ts` — `EventStreamRecord` union に `artifact_added` variant を追加
- `skills/cmux-team/manager/artifact.ts` — `addArtifact()` 末尾で `emitEvent` を呼び出し
- `skills/cmux-team/manager/events-writer.test.ts` — round-trip テスト (T1, T2) を追加
- `skills/cmux-team/manager/artifact.test.ts` — 新規作成 (T3, T4, T5)
- `docs/spec/10-events-stream.md` — §2 writer 行 / §5 event 種数 (16→17) / §5.3 Artifact lifecycle / §6.17 を追加
- `docs/spec/glossary.md` — events stream のエントリで「16 event 種」→「17 event 種」に更新
- `package-lock.json` — 環境差分による軽微同期

## テスト結果

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 events-writer.test.ts  # 22 pass / 0 fail
bun test --timeout 30000 artifact.test.ts        # 6 pass / 0 fail
```

`bunx tsc --noEmit` で触ったファイルに関連する型エラーは 0 件。

## フェーズログ

| Phase | Agent | Surface | 結果 |
|-------|-------|---------|------|
| 1 Plan | Planner | surface:414 | plan.md 161 行（事前調査ベース） |
| 3 Impl | Implementer | surface:416 | TDD で T1-T5 を pass、spec 更新 |
| 4 Inspect | Inspector | surface:419 | **GO** |

## Inspector 検品結果（要約）

- plan.md の Step 1-5 をすべて遵守
- 範囲外変更なし（Phase 2 journal 追記 / Dashboard / watch には未着手）
- 既存テスト regression なし、tsc 問題なし
- emit は best-effort（`addArtifact` の戻り値・throw 挙動を変更していない）
- spec 内部整合: §5 冒頭 17 = §5.1 (8) + §5.2 (8) + §5.3 (1)

## Follow-up（任意・本タスク範囲外）

Inspector が GO 判定のうえで指摘した任意 follow-up:

1. `docs/spec/00-project-overview.md:157` の events-stream description 内の「16 event 種」記述を「17 event 種」に同期する（spec 内部整合をさらに厳密化）。本タスクで `glossary.md` は更新済みだが project-overview の docs table description は未更新。
2. 別タスクで起票するか、次回 spec touch 時に併せて修正する。

## 範囲外（明示・別タスクで検討）

- Phase 2: task journal への `artifact_added` 追記（`addArtifact` から CLI spawn or library API 呼び出しの設計選択肢あり）
- Dashboard UI 側で artifact event を時系列に表示する変更
- `/elevens:watch` skill 側で artifact_added を取り扱う変更（events stream には自動で流れる）
- Dashboard `cmux-team events` CLI のデフォルトフィルタ変更
