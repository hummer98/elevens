# 16. worktree archive — destructive cleanup の置き換え (T011)

## 1. 概要・目的

elevens は worktree 隔離により main を無傷に保つが、Conductor / Task の cleanup 経路で worktree が **問答無用に物理削除** されていた。daemon クラッシュ → 自動 abort、disconnect timeout、`abort-task` / `reset-conductor` / `clear-conductor` / `restart-task` / 手動 `/clear` などの「正常完了以外」の経路で同様に削除され、過去に Brainship 事例で作業内容が失われた。

本仕様では:

- **正常完了 (`CONDUCTOR_DONE success=true` / `close-task` 経由) のときだけ削除**、それ以外は **`.team/worktrees-archive/<taskRunId>/` に物理 `mv` し branch を保持** する (= archive 化)
- archive 化時に `.archive-meta.json` を残し、後から `cd` / `git log` で参照できる
- 同 task ID の archive が存在するとき、再アサインされた Conductor の prompt に archive path を埋め込み、Conductor が自律的に引き継ぎ判断できるようにする
- `elevens worktree archive {list|show|remove|prune}` の CLI を提供する
- `events.jsonl` に `worktree_archived` event を追加し observatory に流す

設計の上位指針 (CLAUDE.md):

- **観察箱原則** — archive は「retrospective 観察用の証拠保全」。`.archive-meta.json` / `events.jsonl` / `manager.log` の三層で WHEN / WHY を再構成する
- **silent state mutation を作らない** — archive 化も `worktree_archived` log + event でフォーマット可能な痕跡を残す
- **構造的正しさ** — cleanup 判断を `cleanupMode` discriminated union で型強制し、「archive する / 削除する / 温存する」を呼び出し側が必ず明示する

## 2. アーキテクチャ図

```
                cleanup 経路 (8 経路)
                       ↓
   conductor.ts:resetConductor(cleanupMode)
                       ↓
   ┌─────────────────────────────────────┐
   │  cleanupMode.kind  →  分岐          │
   ├─────────────────────────────────────┤
   │  "preserve"  → 何もしない           │
   │  "archive"   → archiveWorktree()    │
   │  "delete"    → git worktree remove  │
   └─────────────────────────────────────┘
                       ↓
              archiveWorktree()
                       ↓
   ┌──────────────────────────────────────────────────┐
   │ 1. git rev-parse HEAD / status --porcelain       │
   │ 2. mv worktree → .team/worktrees-archive/<id>/   │
   │ 3. git worktree prune                            │
   │ 4. .archive-meta.json (atomic write)             │
   │ 5. log("worktree_archived", ...)                 │
   │ 6. emitEvent({event: "worktree_archived", ...})  │
   └──────────────────────────────────────────────────┘
                       ↓
   ┌──────────────────────────────────────────────────┐
   │ 再アサイン時:                                    │
   │   conductor.ts:assignTask                        │
   │     → findArchivesForTaskId(projectRoot, taskId) │
   │     → buildArchivedWorktreeSection(archives[0])  │
   │     → generateConductorTaskPrompt(..., section)  │
   │     → Conductor prompt に section が埋め込まれる │
   └──────────────────────────────────────────────────┘
```

## 3. ディレクトリレイアウト

```
.team/worktrees-archive/
  └── task-094-1778998001/
      ├── (元 worktree の全 file)
      ├── .archive-meta.json
      └── (.git は linked worktree → prune で broken になるが
           branch (`task-094-1778998001/task`) は main repo の
           `.git/` 内に残る)
```

`git worktree prune` 後の archive 内 `.git` はパス参照切れの linked worktree。git 操作は main repo 側で `git log <branch>` / `git checkout <branch>` する。

## 4. `.archive-meta.json` schema (v1)

```jsonc
{
  "schema_version": 1,
  "task_id": "094",                                  // canonical (数字のみ)
  "task_run_id": "task-094-1778998001",
  "archived_at": "2026-05-17T17:02:36.000Z",         // ISO 8601 UTC ms
  "reason": "disconnect_timeout",                    // §6 enum
  "original_path": ".worktrees/task-094-1778998001", // projectRoot 相対
  "branch": "task-094-1778998001/task",
  "base_branch": "main",
  "base_sha": "abcdef1234567",
  "last_commit_sha": "1234abcd",
  "uncommitted_changes": true,
  "conductor_surface": "surface:5",
  "session_id": "01HXR...",
  "notes": ""
}
```

**必須フィールド**: `schema_version` / `task_id` / `task_run_id` / `archived_at` / `reason` / `branch`。これらが欠ける meta は `archive_meta_invalid` (warn) でスキップされる。

## 5. 関数 contract

### 5.1 `archiveWorktree(opts)`

```typescript
export interface ArchiveWorktreeOpts {
  projectRoot: string;
  worktreePath: string;          // absolute or projectRoot 相対
  taskRunId: string;
  taskId: string;
  branch: string;
  reason: ArchiveReason;
  conductorSurface?: string;
  sessionId?: string;
  baseBranch?: string;
  baseSha?: string;
}

export interface ArchiveWorktreeResult {
  archivePath: string;
  archivedAt: string;
  uncommittedChanges: boolean;
  lastCommitSha?: string;
  skipped?: "no_source" | "target_exists";
}
```

実装順序 (順序保証):

1. `worktreePath` 不在 → `worktree_archive_skipped reason=no_source` ログ + 早期 return (skipped: "no_source")
2. archive 先既存 → `worktree_archive_skipped reason=target_exists` + 既存 meta を読んで return (skipped: "target_exists")
3. mv 前に `git rev-parse HEAD` / `git status --porcelain` を採取
4. `mkdir -p .team/worktrees-archive/`
5. `fs.rename` (同一 fs で atomic)。失敗時 `ArchiveFailedError` throw
6. `git worktree prune` (失敗は warn のみ)
7. `.archive-meta.json` を atomic write (temp file + rename)
8. `log("worktree_archived", ...)` を manager.log
9. `emitEvent({ event: "worktree_archived", archived_at, ... })`

**`archived_at` は手順 5 直後に確定させ、meta.json と event で同値を保つ** ([M1])。

### 5.2 `findArchivesForTaskId(projectRoot, taskId)`

`.team/worktrees-archive/` 直下を走査し、`task_id` 一致の `ArchiveSummary[]` を `archived_at` **降順** で返す。

- meta 不読: `archive_meta_unreadable` (warn) で skip
- JSON parse / 必須フィールド欠落: `archive_meta_invalid` (warn) で skip
- `.archive-meta.json` 不在 entry はサイレント skip
- ディレクトリ自体不在: 空配列

呼び出し元 (`conductor.ts:assignTask`) で `findArchivesForTaskId` 自体が例外を throw した場合は、呼び出し側の catch で `archive_section_lookup_failed` (warn) をログし、archive 連携を諦めて fresh prompt 生成にフォールバックする。retrospective に「archive lookup を試みたが失敗したため空 section で続行した」事象を grep 可能にするための痕跡。

### 5.3 `removeArchive(projectRoot, taskRunId, opts?)`

- `rm -rf <archivePath>`
- `opts.deleteBranch === true` で meta 読み込み → `git branch -D <branch>` → rm
- 不在は no-op

### 5.4 `pruneArchives(projectRoot, opts)`

```typescript
opts: { olderThanMs: number; deleteBranches?: boolean; dryRun?: boolean }
```

現在時刻 - `archived_at` > `olderThanMs` のものを `removeArchive` 経由で削除。`dryRun=true` のとき削除はせず候補のみ返す。`deleteBranches` default は **false** ([m3])。

### 5.5 `buildArchivedWorktreeSection(archive?)`

- `archive === undefined` → **空文字 `""`** (template に何も埋まらず section ごと消える、[M2])
- `archive` 指定時 → markdown section (path / branch / archived_at / reason / uncommitted / last_commit_sha が実値展開された案内文)

### 5.6 `CleanupMode` discriminated union (`conductor.ts`)

```typescript
export type CleanupMode =
  | { kind: "delete"; reason: string }
  | { kind: "archive"; reason: ArchiveReason }
  | { kind: "preserve" };
```

`resetConductor(opts)` の `opts.cleanupMode` で「archive / delete / preserve」を **必ず選ばせる** 構造 ([M4])。`cleanupMode` 未指定時は後方互換のため `{ kind: "delete", reason: "legacy_fallback" }` 相当の挙動になる (Phase 2 で required 昇格予定)。

## 6. cleanup 経路の archive 化 (A〜H, 8 経路)

| # | path:line | 経路 | cleanupMode |
|---|---|---|---|
| A | `daemon.ts:1638` | `CONDUCTOR_CLEAR` (broken→idle) | `{ kind: "archive", reason: "clear_conductor" }` |
| B | `daemon.ts:1752` | `RESET_CONDUCTOR` (reserved) | `{ kind: "archive", reason: "reset_conductor" }` |
| C | `daemon.ts:1861` | `ABORT_TASK` (reserved) | `{ kind: "archive", reason: "abort_task" }` |
| D | `daemon.ts:3711` | `applyAssignCommit` terminal race | `{ kind: "archive", reason: "assign_terminal_race" }` |
| E | `daemon.ts:4432` | `forceCloseDisconnectedConductor` (broken) | `{ kind: "archive", reason: "disconnect_timeout" }` |
| F | `daemon.ts:4628` | `handleConductorDone` success/unresolved 分岐 | `success=true` → `delete` / `unresolved=true` → `preserve` / それ以外 → `archive: done_unresolved` |
| G | `main.ts:1631` | resume 起動時の broken 復帰 | `{ kind: "archive", reason: "resume" }` |
| H | `daemon.ts:3042` | **SESSION_CLEAR running (手動 `/clear`) [C1]** | `{ kind: "archive", reason: "user_clear" }` |

### `reason` enum

| value | 発火源 |
|---|---|
| `disconnect_timeout` | 経路 E |
| `abort_task` | 経路 C |
| `reset_conductor` | 経路 B |
| `clear_conductor` | 経路 A |
| `user_clear` | 経路 H (手動 `/clear`) [C1] |
| `restart` | `cleanupAssignedTask` / `restartFromAborted` (main.ts) |
| `assign_terminal_race` | 経路 D |
| `resume` | 経路 G |
| `done_unresolved` | 経路 F の異常終了系 |
| `other` | 未分類フォールバック |
| `legacy_fallback` | `cleanupMode` 未指定時の後方互換 fallback (= delete) |

`legacy_fallback` は **削除** されるため `.archive-meta.json` / events には現れず、`manager.log` の `worktree_delete_legacy_fallback` のみで識別可能 (`grep` で列挙)。

## 7. Conductor prompt への連携

### 7.1 template placeholder

`skills/cmux-team/templates/{ja,en}/conductor-task.md` の末尾に `{{ARCHIVED_WORKTREE_SECTION}}` を埋める。`buildArchivedWorktreeSection(undefined)` が空文字を返すため、archive 不在時は section ごと template から消える ([M2])。

### 7.2 `generateConductorTaskPrompt` signature

```typescript
export async function generateConductorTaskPrompt(
  projectRoot, taskRunId, taskId, taskContent, worktreePath, outputDir,
  baseBranch, taskDir, mainBranch,
  archivedWorktreeSection: string = "",   // ★ T011 新規
): Promise<string>;
```

### 7.3 `assignTask` 内での組み立て

`generateConductorTaskPrompt` 直前で:

```typescript
const archives = await findArchivesForTaskId(projectRoot, taskId);
const archivedSection = buildArchivedWorktreeSection(archives[0]);
// findArchivesForTaskId は archived_at 降順 → [0] が最新
```

旧 archive (`archived_at` 古い順) は無視し、最新 1 件のみ Conductor に渡す。複数 archive のどれを使うかは Conductor が `elevens worktree archive list --task-id <id>` で自発的に探す。

## 8. CLI: `elevens worktree archive ...`

| サブ | write | 出力 |
|---|---|---|
| `list [--task-id N] [--format json\|text]` | read | text: `taskRunId\tarchived_at\treason\tbranch\tuncommitted` のテーブル |
| `show <taskRunId>` | read | meta.json + `git log --oneline <branch> -10` |
| `remove <taskRunId> [--delete-branch]` | write | `OK removed task-094-1778998001` (+ `(with branch)` 付与) |
| `prune --older-than <duration> [--dry-run] [--yes]` | write | dry-run: 削除候補一覧 / 確定: `OK pruned N archive(s)` |

CLI 名は `elevens` / `cmux-team` 両対応 (既存 dispatcher 通り)。

`--older-than` の duration parser: `parseDuration()` (`worktree-archive.ts`) が `30d` / `12h` / `7d12h` / `500ms` / `90s` / `5m` 等を ms へ変換する。

**`--dry-run` と `--yes` の優先順序 ([m9])**: 両方指定された場合は **`--dry-run` を優先** する (削除前確認に倒す保守側設計)。`--yes` は `--dry-run` が指定されていないときのみ「対話 confirm を skip して即削除」として機能する。`--yes` も `--dry-run` もない場合は exit 1 (confirm 要求)。

### WRITE_COMMANDS への登録 ([M3])

```typescript
worktree: new Set(["archive-remove", "archive-prune"])
```

`isWriteCommand` 側で `command === "worktree" && args[1] && args[2]` のとき `subCmd = args[1] + "-" + args[2]` を組み立てるアダプタを 1 行追加。list / show は **write 対象外**で oncall が cwd 外から確認可能。

## 9. events.jsonl 連携

`worktree_archived` event の schema (`schema_version` は bump しない、add-only):

```typescript
{
  event: "worktree_archived";
  task_id: string;
  task_run_id: string;
  reason: ArchiveReason;        // §6 enum
  archive_path: string;         // projectRoot 相対
  archived_at: string;          // ISO 8601 UTC、meta.json と同値 [M1]
  branch: string;
  uncommitted_changes: boolean;
  last_commit_sha?: string;
}
```

**`ts` vs `archived_at` ([M1])** — `ts` は writer 自動付与の「event flush 時刻」、`archived_at` は「mv 完了時刻 (ドメイン値)」。両者は通常ミリ秒オーダーで一致するが、retrospective 分析では `archived_at` を信用する。

## 10. retention / GC (Phase 2)

Phase 1 PoC では **自動 GC なし**。手動運用:

```bash
# 30 日以上経過した archive を一覧
elevens worktree archive prune --older-than 30d --dry-run

# 確定削除
elevens worktree archive prune --older-than 30d --yes

# branch ごと削除
elevens worktree archive prune --older-than 30d --yes --delete-branches
```

**branch 削除戦略 ([m3])**: Phase 1 default は **false** (branch を残す)。理由は「archive を後から `git cherry-pick` で取り込みたい」ユースケース。Phase 2 で retention 自動化と合わせて再検討する。

## 11. `.team/worktrees-archive/` の write 経路規約 ([m7])

`.team/worktrees-archive/` は **daemon / CLI 経由でのみ操作** すること。手動で `mv` / `rm -rf` してはならない (meta.json と git branch state の整合が崩れる)。

- archive 作成: `archiveWorktree()` のみ (daemon 経路で自動実行)
- archive 削除: `removeArchive()` / `pruneArchives()` (CLI 経由)
- archive 検査: `findArchivesForTaskId()` (CLI 経由 / Conductor prompt 連携で自動利用)

## 12. リスクと対処

| # | リスク | 対処 |
|---|---|---|
| R1 | 同 taskRunId の archive を作る race | `taskRunId` は unique。万一の場合 `target_exists` で skip (no-op) |
| R2 | `mv` 中の crash recovery | 同一 fs の rename は POSIX で atomic。違う fs (EXDEV) で失敗時は worktree が元場所に残り次回 restart で再 archive |
| R3 | branch 名衝突 | `<taskRunId>/task` の taskRunId が unique。直接 push / commit は禁止、cherry-pick で取り込む |
| R4 | `git worktree prune` のタイミング | `archiveWorktree()` 内で mv 完了直後に必ず呼ぶ (meta.json 書き出し前)。失敗は warn のみ (fatal にしない) |
| R5 | 既存テスト fixture が `.worktrees/` 削除を前提 | cleanupMode 未指定経路は legacy_fallback で削除維持 (後方互換) |
| R6 | `.team/worktrees-archive/` がディスクを食う | `prune` CLI を提供、Phase 2 で retention 自動化 |
| R7 | archive の `.git/` が dangling | meta.json の `branch` を main repo 側で参照 (`git log <branch>`) |
| R8 | WRITE_COMMANDS の階層問題 | flat 展開 `archive-remove` / `archive-prune` + isWriteCommand アダプタ |
| R9 | 二重 archive | `archiveWorktree()` の existsSync ガード + `target_exists` skip で no-op |
| R10 | `archived_at` 昇順ソート時のロケール依存 | ISO 8601 string は字句順 = 時刻順、`localeCompare` で安全 |
| R11 | archive 中の Conductor 再起動 race | `archiveWorktree` は同期 `await` で順序保証 |
| R12 | `cleanupMode` legacy_fallback の事故性 | Phase 2 で required 昇格 + `preserveWorktree` opt 削除 (TODO コメント残す) |

## 13. 関連 spec / glossary

- `docs/spec/07-state-machine.md` §6.5 cleanup 経路の archive 化
- `docs/spec/10-events-stream.md` §6.18 worktree_archived schema
- `docs/spec/04-templates.md` `{{ARCHIVED_WORKTREE_SECTION}}` placeholder
- `docs/spec/glossary.md` §9 worktree archive 用語
