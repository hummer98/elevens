# Inspection Report: T002

## 判定

**GO**

DoD 7 項目全てを満たし、12 本の新規テストが green、tsc 新規エラーゼロ、手動 smoke
2 経路 (`create-task` / `update-task`) を Inspector 環境でも再現確認した。
cascade (PARENT_ABORTED) ルールおよび `isTerminalStatus` 利用箇所 (`daemon.ts:3181`,
`main.ts:1478`, `task.ts:881`, `team-gc.ts:357`) は無変更で局所化原則も守られている。

## DoD 充足チェック

- [x] 関連テスト個別実行で T002 由来 fail ゼロ
  - `task.test.ts`: 128 pass / 0 fail (Inspector 再実行で確認)
  - `daemon.test.ts`: 217 pass / 2 skip / 0 fail
  - `state-machine/{fsm,apply-task-actions,task-state-store}.test.ts`: 241 pass / 0 fail
- [x] `bunx tsc --noEmit` で新規エラーゼロ
  - baseline (`git stash` で T002 を退避した状態) = 8 errors / post-T002 = 8 errors。
  - errors の対象ファイル (`c11-features.test.ts`, `c11-features.ts`, `mailbox-cli.ts`, `main.ts:956`) は T002 改修箇所 (`main.ts:3999-4118` と新 import 行 74) と無関係。
- [x] 新規テスト 12 本 green (DoD 6+ 充足)
  - `filterExecutableTasks`: 4 本 (aborted/deleted/未存在/closed retain)
  - `filterRunAfterAllTasks`: 2 本 (aborted block / closed retain — Low #6 推奨対応済)
  - `validateDependsOnExist`: 4 本 (空配列 / 全実在 / 単一未存在 / 複数で先頭 ID)
  - `scanTasks` 統合 (`daemon.test.ts`): 2 本 (aborted 親 → pendingTasks=0 / closed 親 → pendingTasks=1)
- [x] `docs/spec/07-state-machine.md` §2.5 「依存解決の意味論 (T002)」が新規挿入され、§2.5 不変条件が §2.6 に shift、T-I3 行 (`closedIds = { id : status==="closed" }`) が追加されている (line 262-291)。
- [x] 手動 smoke: Inspector 環境でも以下を再現確認
  - `create-task --title smoke --depends-on 9999` → `Error: depends_on task 9999 not found in .team/tasks/` / exit=1 / `.team/tasks/` 無汚染
  - `update-task --task-id 001 --depends-on 9999` (tmp project + ready 状態) → 同じ error / exit=1
- [x] cascade (PARENT_ABORTED) ルールは未変更
  - `git diff HEAD -- skills/cmux-team/manager/task.ts` の差分は `validateDependsOnExist` の追加のみ (line 261-285)。`cascadeAbortToChildrenInPlace` (line 770) / `cascadeAbortToChildren` alias (line 797) / reducer 側 (`state-machine/`) いずれも無変更。
- [x] `closedIds` 構築修正は `daemon.ts:3170-3179` の 1 か所のみ。`isTerminalStatus` 定義 (`task.ts:826`) と他参照 4 箇所 (`daemon.ts:3181`, `main.ts:1478`, `task.ts:881`, `team-gc.ts:357`) は `grep -n` で全て無変更を確認。

## Findings（発見事項）

### Critical（GO 阻害）

なし。

### Major（修正推奨）

なし。

### Minor（改善余地）

1. **impl-summary の tsc エラー数「16」が actual と乖離**
   - impl-summary §「tsc 結果」は「全体エラー数 = 16 (baseline と完全一致)」と書いているが、Inspector 再実行 (`bunx tsc --noEmit | grep -E "^[a-zA-Z].*\(\d+,\d+\): error" | wc -l`) では 8 errors。
   - 「T002 新規エラーゼロ」という核心の主張は正しい (baseline 8 = post-T002 8)。数値の根拠 (どの基準で 16 と数えたか — 多行 type description を 1 件と数えるか別件と数えるか等) を impl-summary 中に補足すると将来読み返した人の混乱を避けられる。

2. **`update-task` smoke 手順の `unset PROJECT_ROOT` だけでは再現性が不十分**
   - impl-summary 記載の手順を Inspector がそのまま実行したところ、シェル環境変数 `PROJECT_ROOT=/Users/yamamoto/git/elevens` が継承されて elevens 本体プロジェクトに対する update が走り、本体側 task 001 が closed のため smoke 結果と異なる error message が出た。
   - `PROJECT_ROOT="$TMP" bun run ...main.ts ...` のように **プロセス起動時に明示的に上書き** すれば再現可。impl-summary §「手動 smoke 結果」の手順例を「`unset PROJECT_ROOT && PROJECT_ROOT="$TMP" bun run ...`」に補強すると将来の再現性が上がる。
   - これは **smoke 結果自体の真偽には影響しない** (Inspector で別経路で再現確認済)。

3. **worktree HEAD が main より遅れているため `git diff main` の見え方が混乱を招く**
   - 本 worktree の HEAD は `bc6cc8b` (release v0.4.1) で、main にはその後 `9adbed5` (T001: close-task --force で aborted → closed) が積まれている。
   - `git diff main` で見ると T001 の差分が逆向きに見えるが、`git diff HEAD` で見れば T002 の純粋な差分だけが綺麗に出る。Inspector はこの点を verify 済 (T002 改修は HEAD 比較で 6 ファイル / 純差分は意図通り)。
   - merge / rebase 時に main の T001 はそのまま preserve される。本タスクのスコープ問題ではないが、PR レビュー時に `git diff main` ベースで確認すると T001 の打ち消しに見えるノイズが出る可能性がある。レビューレシピに `git diff $(git merge-base HEAD main) HEAD` または `git diff HEAD` を案内するとよい。

4. **`package-lock.json` の差分が同梱されている**
   - 内容は `@hummer98/cmux-team@4.28.1` → `@hummer98/elevens@0.4.1` への rename 由来 (5 行 +/-)。impl-summary §「変更ファイル一覧」の備考で正しく「T002 起因ではなく事前のリネーム由来」と切り分けられている。
   - 別途 main 側で lockfile を更新するコミットを入れるか、本マージで取り込むかの判断は scope 外だが、PR description でこの 5 行が T002 とは独立であることを明記すると review が早い。

## Fix Required（NOGO の場合）

該当なし (GO)。

## 検証実行ログ

### テスト

```
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 task.test.ts
  → 128 pass / 0 fail / 236 expect (247ms)
$ bun test --timeout 30000 daemon.test.ts
  → 217 pass / 2 skip / 0 fail / 753 expect (9.08s)
$ bun test --timeout 30000 ./state-machine/fsm.test.ts \
    ./state-machine/apply-task-actions.test.ts \
    ./state-machine/task-state-store.test.ts
  → 241 pass / 0 fail / 497 expect (209ms)
```

T002 由来の新規テスト 12 本がいずれも green。既存テストの regression なし。

### tsc

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
  → 8 errors total (c11-features.test.ts ×2, c11-features.ts ×2,
                    mailbox-cli.ts ×3, main.ts:956 ×1)
$ git stash && bunx tsc --noEmit | grep -c "error TS"
  → 8 (baseline)
$ git stash pop
```

新規導入エラー: **0** 件。

### 手動 smoke (Inspector 再現)

```
# create-task: PROJECT_ROOT を tmp project に向けて実行
$ TMP=$(mktemp -d) && mkdir -p "$TMP/.team/tasks"
$ cd "$TMP" && PROJECT_ROOT="$TMP" bun run \
    /Users/.../skills/cmux-team/manager/main.ts \
    create-task --title smoke --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1
$ ls "$TMP/.team/tasks"
(empty — 副作用なし、無汚染を確認)

# update-task: 001 fixture を ready で seed
$ TMP=$(mktemp -d)
$ mkdir -p "$TMP/.team/tasks/001-foo"
$ cat > "$TMP/.team/tasks/001-foo/task.md" <<EOF
---
id: 001
title: foo
priority: medium
status: ready
created_at: 2026-05-10T00:00:00Z
---
## タスク
fixture
EOF
$ echo '{"001":{"status":"ready"}}' > "$TMP/.team/task-state.json"
$ cd "$TMP" && PROJECT_ROOT="$TMP" bun run \
    /Users/.../skills/cmux-team/manager/main.ts \
    update-task --task-id 001 --depends-on 9999
Error: depends_on task 9999 not found in .team/tasks/
exit=1
```

両経路とも **仕様文言完全一致** + exit 1 + worktree の `.team/` 無汚染を確認。

### 構造確認

```
$ git diff HEAD -- skills/cmux-team/manager/daemon.ts
  → +2 / -1 (line 3170-3179, T002 コメント + closedIds filter のみ)
$ git diff HEAD -- skills/cmux-team/manager/task.ts
  → +22 / -0 (validateDependsOnExist 関数の追加のみ、line 264-285)
$ git diff HEAD -- skills/cmux-team/manager/main.ts
  → +15 / -1 (import 1行 + cmdCreateTask / cmdUpdateTask 各 7 行の検証ブロック)
$ git diff HEAD -- docs/spec/07-state-machine.md
  → +25 / -1 (§2.5 新規 24 行 + 不変条件 T-I3 + heading shift)
$ git diff HEAD -- skills/cmux-team/manager/task.test.ts
  → +103 / -0 (12 本の新規テスト + 最小 fixture helper)
$ git diff HEAD -- skills/cmux-team/manager/daemon.test.ts
  → +42 / -0 (T002 describe 2 本)
$ grep -n "isTerminalStatus" skills/cmux-team/manager/{daemon,main,task,team-gc}.ts
  → 6 箇所すべて未変更 (定義 1 + 参照 5)
```

`closedIds` 構築修正の局所化、`isTerminalStatus` の semantics 据え置き、cascade 経路の無変更を全て確認。
