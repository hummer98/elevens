# T002 Summary: 依存解決を closed のみで成立させる + 未存在 ID を入力検証

## 完了したサブタスク

| Phase | 担当 | 成果物 | 結果 |
|-------|------|--------|------|
| 1. Plan | Planner Agent (surface:135) | `plan.md` (462 行) | 完了 |
| 2. Design Review | Design Reviewer Agent (surface:137) | `design-review.md` | **Approved** (Medium 2 件 / Low 4 件、Implementer に注入) |
| 3. Implementation | Implementer Agent (surface:138) | `impl-summary.md` + 6 ファイル変更 | 全 DoD 充足 |
| 4. Inspection | Inspector Agent (surface:150) | `inspection.md` | **GO** (Critical/Major ゼロ、Minor 4 件は実装影響なし) |

## 変更ファイル一覧

| ファイル | +追加 | -削除 | 内容 |
|---------|------:|------:|------|
| `docs/spec/07-state-machine.md` | 25 | 1 | §2.5「依存解決の意味論 (T002)」新規挿入。既存 §2.5 不変条件を §2.6 に shift し T-I3 行を追加 |
| `skills/cmux-team/manager/daemon.ts` | 3 | 1 | `scanTasks` の `closedIds` 構築を `s.status === "closed"` に限定 |
| `skills/cmux-team/manager/main.ts` | 15 | 1 | `validateDependsOnExist` import + `cmdCreateTask` / `cmdUpdateTask` で未存在 ID を exit 1 reject |
| `skills/cmux-team/manager/task.ts` | 22 | 0 | `validateDependsOnExist(projectRoot, ids)` 関数を追加 |
| `skills/cmux-team/manager/daemon.test.ts` | 42 | 0 | `T002: 依存解決は closed のみ (scanTasks 統合)` describe 2 本 |
| `skills/cmux-team/manager/task.test.ts` | 103 | 0 | filterExecutableTasks 4 本 / filterRunAfterAllTasks 2 本 / validateDependsOnExist 4 本 |
| `package-lock.json` | 5 | 5 | T002 起因ではなく事前 `cmux-team → elevens` リネーム由来 |

## テスト結果

- `task.test.ts`: 128 pass / 0 fail (12 本中 10 本が新規。残り 2 本は daemon.test.ts 側の scanTasks 統合)
- `daemon.test.ts`: 217 pass / 2 skip / 0 fail
- `state-machine/{fsm,apply-task-actions,task-state-store}.test.ts`: 241 pass / 0 fail
- T002 由来の新規 fail: **ゼロ**
- 既存 baseline failure (cli-project-root / project-root / cwd-mismatch.integration): T002 と無関係 (`cmux-team → elevens` リネームの lagging tests)

## tsc 結果

- baseline 8 errors / post-T002 8 errors（差分ゼロ）
- T002 改修ファイル (`task.ts`, `daemon.ts`, `main.ts:3999-4118`, テストファイル群) のエラーは 0

## 手動 smoke

```
$ create-task --title smoke --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1

$ update-task --task-id 001 --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1
```

両経路とも仕様文言完全一致、exit 1、`.team/tasks/` 無汚染を Inspector でも再現確認。

## マージコミット / PR

ローカル ff-only マージ完了:

- merge SHA: `c610973`
- merged-into: `main`

## 残課題

実装本体には残課題なし。Inspector の Minor 観察:

1. impl-summary の tsc エラー数表記 (16) と Inspector 再実行値 (8) の乖離 — 数え方の差で本質に影響なし。
2. `update-task` smoke 手順の `unset PROJECT_ROOT` 単体では不十分（`PROJECT_ROOT="$TMP" bun run ...` が確実）。
3. PR レビュー時は `git diff $(git merge-base HEAD main) HEAD` または `git diff HEAD` を使うことを推奨（worktree HEAD が main 比で遅れているため `git diff main` は T001 を逆向きに見せる）。
4. `package-lock.json` 5 行 +/- は T002 と独立（cmux-team → elevens リネーム由来）。

別タスク提案（既存 lagging tests で T002 と無関係）:
- `cli-project-root.test.ts` / `project-root.test.ts` / `cwd-mismatch.integration.test.ts` に残る `cmux-team` ハードコード文字列を `elevens` に追従させる lagging test 整備。
