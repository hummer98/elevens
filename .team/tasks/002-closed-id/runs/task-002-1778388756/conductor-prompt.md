# タスク割り当て

## タスク内容

---
id: 002
title: 依存解決を closed のみで成立させる + 未存在 ID を入力検証
priority: high
created_by: surface:119
created_at: 2026-05-10T04:52:36.801Z
---

## タスク
## 背景

surface:47 (`/Users/yamamoto/git/Brainship/prototype`) で実際に発生した事象:

1. T013 が `depends_on: [012]` で created
2. T012 が assigned 中に user が `abort_task`
3. PARENT_ABORTED cascade で T013 が ready → draft に降格（journal: `parent_aborted: 012`）
4. user が T013 を `update-task --status ready` で再 ready 化
5. **T012 が aborted（terminal）扱いで `closedIds` に入っているため、T013 が executable 判定を通過してアサイン候補になっている**
6. user 自身は journal に「T011 closed 後に restart 予定」と書いており、T013 が動くのは意図に反する

根本原因: `daemon.ts:3173-3177` で `closedIds` を `isTerminalStatus`（closed / aborted / deleted）で構築している。aborted 親も「依存解決済み」と扱われる。

加えて `--depends-on 9999`（実在しない ID）が CLI で素通り、ready 化しても永久 block になるゾンビ ready の問題もある。

## 仕様

### ルール

- **依存解決は `closed` のみで成立**
- aborted / deleted 親、および未存在 ID に依存する子は block
- cascade（PARENT_ABORTED reducer）は既存挙動維持: 親が aborted / deleted に遷移したとき `ready` 子は `draft` に降格
- user は block された子を以下のいずれかで解決:
  - 親を `restart-task` / `close-task --force`（T001）で closed に持っていく
  - 子の `--depends-on` を編集して依存先を変更
  - 子を `abort-task` / `delete-task`

### 実装

#### 1. `daemon.ts:3173-3177` の `closedIds` 構築修正

```ts
// before
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => isTerminalStatus(s.status))
    .map(([id]) => id)
);

// after
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed")
    .map(([id]) => id)
);
```

`task.ts:805 isTerminalStatus` は他箇所（terminal 判定）で使われ続けるので置き換えない。新ロジックは `closedIds` 構築のみに局所化。

#### 2. CLI 入力検証（未存在 ID）

`cmdCreateTask` / `cmdUpdateTask`:

- `normalizeTaskIdList` で format 検証後、各 ID が `.team/tasks/` に存在することをチェック
- 未存在なら `Error: depends_on task <id> not found in .team/tasks/` で exit 1
- `--force` bypass は **付けない**（タイポは直すべき、未来のタスクへの依存は順序を守る）

実装場所候補:
- `task.ts` に `validateDependsOnExist(projectRoot, ids): Promise<void>` を追加
- `cmdCreateTask` (`main.ts:3995` 付近) と `cmdUpdateTask` (`main.ts:4099` 付近) の両方で呼ぶ

#### 3. spec 更新

`docs/spec/07-state-machine.md`:
- 「依存解決の意味論」節を新設（または既存節に追記）
- 「依存解決は親が `closed` のときのみ成立。aborted / deleted / 未存在 ID は block」を明記
- cascade ルール (2.4) は変更なしを再確認

### テスト

`task.test.ts` または `daemon.test.ts`（適切な test file）:

- aborted 親に依存する ready 子が `filterExecutableTasks` の結果に含まれないこと
- deleted 親に依存する ready 子も同様
- 未存在 ID に依存する ready 子も同様
- closed 親に依存する ready 子は含まれること（既存挙動維持）
- 親が closed → aborted （RESTART で書き換わる経路はないが、close-task → abort-task の異常系想定）に遷移した瞬間、子が executable から外れること
- run_after_all タスクの依存判定（`filterRunAfterAllTasks`）も同じルールが適用されていること

CLI 入力検証:
- `create-task --depends-on 9999` で未存在 ID なら exit 1
- `update-task --depends-on 9999` でも exit 1
- 既存タスク ID なら通常通り通る
- 複数 ID の一部が未存在なら exit 1（最初の未存在 ID を error message に含める）

## 観察可能性

- `filterExecutableTasks` で除外された理由を debug log に追加することも検討（今回は scope 外、後追いで判断）
- events.jsonl への影響なし（cascade ログは既存通り）

## 非対象

- `--force` bypass 経路の追加
- TUI / dashboard での「block 理由」可視化（必要なら別タスク）
- T001 (close-task --force で aborted → closed) との連携テスト（T001 で別途）

## 関連

- T001: aborted → closed への上書き経路（このタスクで block された子を user が解放する手段の一つ）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-002-1778388756` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-002-1778388756
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-002-1778388756/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/002-closed-id/runs/task-002-1778388756
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/002-closed-id/runs/task-002-1778388756/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
