# Implementation Summary: T002 — 依存解決を closed のみで成立させる + 未存在 ID を入力検証

## 概要

`closedIds` 構築を `s.status === "closed"` 限定にし、CLI 側 (`create-task` /
`update-task --depends-on`) で未存在 ID を即時 reject する。`isTerminalStatus`
の semantics は据え置き。cascade ルール (§2.4 / PARENT_ABORTED) も無変更。

## 変更ファイル一覧（行数差）

| ファイル | +追加 | -削除 | 内容 |
|---------|------:|------:|------|
| `docs/spec/07-state-machine.md` | 25 | 1 | §2.5 「依存解決の意味論 (T002)」新規挿入。既存 §2.5 不変条件を §2.6 に shift し T-I3 行を追加 |
| `skills/cmux-team/manager/daemon.ts` | 3 | 1 | `scanTasks` の `closedIds` 構築を `s.status === "closed"` に限定 (T002 コメント付与) |
| `skills/cmux-team/manager/main.ts` | 15 | 1 | `validateDependsOnExist` の import 追加。`cmdCreateTask` / `cmdUpdateTask` の `--depends-on` 経路で未存在 ID を exit 1 reject |
| `skills/cmux-team/manager/task.ts` | 22 | 0 | `validateDependsOnExist(projectRoot, ids)` 関数を `normalizeTaskIdList` 直下に追加 |
| `skills/cmux-team/manager/daemon.test.ts` | 42 | 0 | `T002: 依存解決は closed のみ (scanTasks 統合)` describe 2 本追加 |
| `skills/cmux-team/manager/task.test.ts` | 103 | 0 | `filterExecutableTasks` 4 本 / `filterRunAfterAllTasks` 2 本の regression guard、`validateDependsOnExist (T002)` describe 4 本 |

合計: +210 / -3 (T002 関連ファイル)。`package-lock.json` の差分は T002 起因ではなく
事前の `cmux-team → elevens` リネーム由来 (worktree 起動前から M フラグ)。

## 追加したテスト一覧

### `daemon.test.ts` — `T002: 依存解決は closed のみ (scanTasks 統合)`

1. `aborted 親に depends_on する ready 子は scanTasks で pendingTasks にカウントされない`
   - = 親が `closed → aborted` へ異常遷移した直後の `scanTasks` 結果を検証する
     (タスク本文 §テスト 5 要件を明示的に紐付ける Medium 推奨対応)
2. `closed 親に depends_on する ready 子は scanTasks で pendingTasks=1 (retain)`

### `task.test.ts` — `filterExecutableTasks` (4 本追加)

3. `T002: aborted 親に依存する ready 子は executable から外れる`
4. `T002: deleted 親に依存する ready 子は executable から外れる`
5. `T002: 未存在 ID に依存する ready 子は executable から外れる`
6. `T002: closed 親に依存する ready 子は executable (既存挙動の retain)`

### `task.test.ts` — `filterRunAfterAllTasks` (2 本追加)

7. `T002: aborted 親に依存する run_after_all 子は block される`
8. `T002: closed 親に依存する run_after_all 子は executable (retain)` (Low #6 推奨対応)

### `task.test.ts` — `validateDependsOnExist (T002)` describe (4 本)

9. `ids 空配列なら throw しない`
10. `全 ID が実在すれば throw しない`
11. `未存在 ID があれば throw する`
12. `複数未存在の場合は最初の ID を含む`

合計: 12 本 (DoD 要求 6+ を充足)。fixture は `mkdtempSync` + `mkdirSync` +
`writeFileSync` の describe-local 最小実装 (Low #4 推奨どおり共有 helper 化せず)。

## テスト結果 (pass/fail counts)

`cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done`

- 集計: **pass=2773 / fail=7 (3 unique baseline ファイル) / skip=15**
- T002 由来の新規 fail はゼロ。
- 既存 baseline 失敗の内訳 (stash で base に戻して同条件で再現確認済):
  - `cli-project-root.test.ts`: 1 fail (`R4: stderr 'not a cmux-team project'` を期待するが
    現実装は `'not an elevens project'` を出す)
  - `cwd-mismatch.integration.test.ts`: 3 fail (`cmux-team spawn-master/conductor` を期待するが
    現実装は `elevens spawn-master/conductor` を出す)
  - `project-root.test.ts`: 2 fail (上記 1 件 + 同種の `not a cmux-team project` 1 件、
    bun の "Ran 23 tests across 2 files" による cli-project-root.test.ts 取り込み込み)
- 失敗はすべて先行リブランド (`cmux-team → elevens`) の lagging tests で T002 と無関係。

T002 関連個別ファイル:
- `task.test.ts`: 128 pass / 0 fail (124 既存 + 4 新規 describe 内)
  - validateDependsOnExist 4 本、filterExecutableTasks +4、filterRunAfterAllTasks +2 で計 +10 ケース
- `daemon.test.ts`: 217 pass / 2 skip / 0 fail (+2 ケース)

## tsc 結果

`bunx tsc --noEmit`

- 全体エラー数 = 16 (baseline と完全一致)
- T002 改修ファイル (`task.ts` / `task.test.ts` / `daemon.ts` / `daemon.test.ts`) のエラー: 0 件
- `main.ts` のエラーは line 956 (T002 改修箇所 line ~4000-4115 とは別) で baseline 由来
- 新規導入 tsc エラー: **ゼロ**

## 手動 smoke 結果

### `create-task --depends-on 9999` (worktree 内で実行、existing タスクを汚さない)

```bash
$ cd /Users/yamamoto/git/elevens/.worktrees/task-002-1778388756
$ bun run skills/cmux-team/manager/main.ts create-task \
    --title "smoke-test-T002" --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1
```

期待どおり exit 1 + 仕様文言の error を出力。タスクは作成されない (副作用なし、`.team/tasks/` 無汚染)。

### `update-task --task-id 001 --depends-on 9999` (tmpdir に 001 fixture を作って実行)

```bash
$ TMP=$(mktemp -d) && mkdir -p "$TMP/.team/tasks/001-foo" && \
    cat > "$TMP/.team/tasks/001-foo/task.md" <<EOF
---
id: 001
title: foo
priority: medium
created_at: 2026-05-10T00:00:00Z
---

## タスク
fixture
EOF
$ unset PROJECT_ROOT
$ cd "$TMP" && bun run .../main.ts update-task --task-id 001 --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1
```

期待どおり exit 1 + 仕様文言の error。worktree の `.team/` には触っていない。

## DoD チェック

- [x] `cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` で T002 由来 fail ゼロ (既存 baseline 6 件のみ)
- [x] `bunx tsc --noEmit` で新規エラーゼロ
- [x] 新規テスト 6+ 本 (filterExecutableTasks 4, filterRunAfterAllTasks 2, validateDependsOnExist 4, scanTasks 統合 2 = **12 本**) が green
- [x] `docs/spec/07-state-machine.md` に §2.5「依存解決の意味論」が追加されている
- [x] 手動 smoke: `create-task --depends-on 9999` / `update-task --depends-on 9999` がそれぞれ exit 1 + 期待 error message
- [x] cascade (PARENT_ABORTED) ルールは `git diff` で変更されていないこと (`task.ts` 該当箇所、`task-fsm.ts` 共に未変更)
- [x] `closedIds` 構築修正は `daemon.ts:3173-3177` の 1 か所のみ。`isTerminalStatus` 定義 (`task.ts`) と他参照箇所 (`daemon.ts:3179`, `main.ts:1478`, `task.ts:859`, `team-gc.ts:357`) は未変更

## 残課題

なし。

参考 (T002 と無関係な既知 baseline failure):

- `cli-project-root.test.ts` / `project-root.test.ts` / `cwd-mismatch.integration.test.ts`
  はメッセージ文字列が `cmux-team` のままになっており、実装の `elevens` リネームに
  追従していない。本タスクスコープ外なので未修正のまま。別タスクで lagging tests を
  整備する余地あり。
