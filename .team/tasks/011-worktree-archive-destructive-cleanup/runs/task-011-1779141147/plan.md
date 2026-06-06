# T011 plan.md — worktree archive 化（destructive cleanup の置き換え）

## 1. 概要・ゴール

現状、Conductor / Task の cleanup 経路で worktree が `git worktree remove --force` によって**問答無用に物理削除**されている。daemon クラッシュ → restart 時の自動 abort や、disconnect timeout、`abort-task` / `reset-conductor` / `clear-conductor` / `restart-task` / 手動 `/clear` などの「正常完了以外」の経路で同様に削除され、過去に Brainship 事例で作業内容が失われた。

本タスクでは次の変換を行う:

- **正常完了 (`CONDUCTOR_DONE success=true` / `close-task` 経由) のときだけ削除**、それ以外は **archive 化（`.team/worktrees-archive/<taskRunId>/` に物理 `mv` し、branch は保持）** する
- archive 化時に `.archive-meta.json` を残し、後から `cd` / `git log` で参照できる
- 同 task ID の archive が存在するとき、再アサインされた Conductor の prompt に archive path を埋め込み、Conductor が自律的に引き継ぎ判断できるようにする
- `elevens worktree archive {list|show|remove|prune}` の CLI を新設する
- `events.jsonl` の `worktree_archived` event 追加 + 仕様書類 (`docs/spec/16-worktree-archive.md` 新規 ほか) を更新する

設計の上位指針 (CLAUDE.md):

- 観察箱原則 — archive は **「retrospective 観察用の証拠保全」** に位置づける。`.archive-meta.json` / `events.jsonl` / `manager.log` の三層で WHEN / WHY を再構成できるようにする
- silent state mutation を作らない — archive 化も `worktree_archived` log + event でフォーマット可能な形で痕跡を残す
- 構造的正しさ — cleanup 判断を `cleanupMode` discriminated union で型強制し、「archive する / 削除する / 温存する」を呼び出し側が必ず明示する（[M4]）

---

## 2. 影響を受けるファイル一覧（実コード現状の行番号）

### 2.1 既存の `git worktree remove --force` 呼び出し（grep 結果）

| # | path:line | 呼び出し関数 / 文脈 | 本タスクでの扱い |
|---|---|---|---|
| 1 | `skills/cmux-team/manager/conductor.ts:667` | `assignTask` 失敗ロールバック (try/catch の cleanup) | **維持** — 直前に作成された空 worktree。task.md §4 の維持リスト |
| 2 | `skills/cmux-team/manager/conductor.ts:770` | `resetConductor` 内（`!preserveWorktree` 経路） | **archive 化** — 全 cleanup 経路の集約点 |
| 3 | `skills/cmux-team/manager/main.ts:5101` | `cleanupAssignedTask`（`restart-task` 経路で呼ばれる） | **archive 化** — task.md "restart-task の stale worktree" |
| 4 | `skills/cmux-team/manager/main.ts:5325` | `restartFromAborted`（aborted → ready への再起動経路） | **archive 化** — restart-task の subroute |
| 5 | `skills/cmux-team/manager/e2e.ts:335` | E2E テストの後始末 (`tearDown`) | **対象外** — test fixture cleanup なので削除のまま |

> task.md は §3 で 4 経路を archive 化対象として挙げているが、(2) `resetConductor` が disconnect_timeout / reset-conductor / clear-conductor / ABORT_TASK / SESSION_CLEAR running / assign_terminal_race / resume の集約点。
> CLI 経路は (3) restart-task と (4) restartFromAborted のみ。よって diff は **3 ファイル** に集約される。

### 2.2 `resetConductor` の呼び出し元（archive 化に伴い `cleanupMode` を渡す）

| # | path:line | 経路 | 既存 reason | cleanupMode 値 |
|---|---|---|---|---|
| A | `daemon.ts:1637` | `CONDUCTOR_CLEAR` handler (`clear-conductor` CLI) | `message.reason ?? "cleared"` (targetStatus=idle) | **`{ kind: "archive", reason: "clear_conductor" }`** ※ broken→idle 経路では cleanup は既に済んでいる（archive も既に取られている）はず → 二重 archive を防ぐ |
| B | `daemon.ts:1749` | `RESET_CONDUCTOR` handler (`reset-conductor` CLI) | `message.reason ?? "user_reset"` (targetStatus=reserved) | **`{ kind: "archive", reason: "reset_conductor" }`** |
| C | `daemon.ts:1856` | `ABORT_TASK` handler (`abort-task` CLI) | `"abort_task"` (targetStatus=reserved) | **`{ kind: "archive", reason: "abort_task" }`** |
| D | `daemon.ts:3700` | `applyAssignCommit` の terminal race | opts なし | **`{ kind: "archive", reason: "assign_terminal_race" }`** ※ task は既に closed/aborted/deleted。保守側に倒して archive |
| E | `daemon.ts:4415` | `forceCloseDisconnectedConductor` | `"disconnect_timeout"` (targetStatus=broken) | **`{ kind: "archive", reason: "disconnect_timeout" }`** |
| F | `daemon.ts:4609` | `handleConductorDone` success=false 系 / その他 | （要確認: §6-F 詳細）| 経路依存（success=false unresolved=true は `{ kind: "preserve" }`、それ以外は `{ kind: "archive", reason: "done_unresolved" }` または既存 `"other"` で archive） |
| G | `main.ts:1620` | resume/起動時の broken 復帰 | （要確認: §6-G 詳細）| **`{ kind: "archive", reason: "resume" }`** |
| **H** | **`daemon.ts:3034`** | **`SESSION_CLEAR` running 経路（ユーザー手動 `/clear`）** | **`"user_clear"` (targetStatus=reserved)** | **`{ kind: "archive", reason: "user_clear" }`** ※ [C1] 新規追加経路。手動 `/clear` 時に進行中 worktree が無言で消えていた既知バグの修正 |

> §2.2 (D) (F) (G) (H) は「task.md には明記されていないが既存 `resetConductor` 呼び出し経路」。Implementer は実コードの再 grep で経路依存を確認し、`cleanupMode` を漏れなく付与する。`cleanupMode === undefined` のときは **後方互換のため** `{ kind: "delete", reason: "legacy_fallback" }` 相当として削除にフォールバック（§5.1 contract + §6.1 参照）。新規追加された reset 呼び出しでは TypeScript の型推論により `cleanupMode` を明示しないと型が undefined になる構造のため、構造的に「archive / delete / preserve」のいずれかを必ず選ばざるを得ない（[M4]）。

### 2.3 Template / 仕様 / CLI 関連

| path | 変更内容 |
|---|---|
| `skills/cmux-team/manager/template.ts:253-303` | `generateConductorTaskPrompt` の signature に `archivedWorktreeSection?: string` を追加。`{{ARCHIVED_WORKTREE_SECTION}}` 置換を追加（[M2] 採用案: section block placeholder） |
| `skills/cmux-team/templates/ja/conductor-task.md` | 末尾の archive 通知部分を `{{ARCHIVED_WORKTREE_SECTION}}` 1 個に置換 |
| `skills/cmux-team/manager/conductor.ts:assignTask` 内（promptFile 生成の直前 = 概ね 540-580 付近） | `findArchivesForTaskId(projectRoot, taskId)` を呼び、結果 `[0]` を `buildArchivedWorktreeSection()` で section 文字列化し `generateConductorTaskPrompt` に渡す |
| `skills/cmux-team/manager/events-writer.ts:47-161` | `EventStreamRecord` discriminated union に `worktree_archived` バリアントを追加（add-only、schema_version bump なし）。`archived_at` フィールド込み（[M1]） |
| `skills/cmux-team/manager/main.ts:297-319` | `WRITE_COMMANDS` に `worktree: new Set(["archive-remove", "archive-prune"])` を登録（[M3] 採用案: flat sub-sub command）。list / show は write 対象外 |
| `skills/cmux-team/manager/main.ts` の `isWriteCommand` ヘルパ（300 行台） | `command === "worktree"` のとき `subCmd = args[1] + "-" + args[2]` を組み立てるアダプタを 1 行追加（既存契約に最小侵襲） |
| `skills/cmux-team/manager/main.ts` のコマンド dispatcher（`cmdAbortTask` 等の末尾、6800 付近） | `worktree archive {list, show, remove, prune}` を dispatch |
| `docs/spec/10-events-stream.md` | §5.1 のテーブルに `worktree_archived` を追加、§5 の合計 17 event を 18 event へ、§6 に新規 §6.18 を追加 |
| `docs/spec/07-state-machine.md` | §6（段階計画）または §3（同時遷移）の後に「6.x cleanup 経路の archive 化」を追記 |
| `docs/spec/16-worktree-archive.md` | **新規作成**（spec 本体、§5.5 に schema） |
| `docs/spec/04-templates.md` | `{{ARCHIVED_WORKTREE_SECTION}}` placeholder を 1 件追加 |
| `docs/spec/glossary.md` | §9「Worktree / start-point 解決」に「worktree archive」用語を追加 |
| `CLAUDE.md` | 「git worktree（概要）」節に archive 化の 1 行説明を追記 |

---

## 3. 新規追加ファイル

| path | 役割 |
|---|---|
| `skills/cmux-team/manager/worktree-archive.ts` | `archiveWorktree()` / `findArchivesForTaskId()` / `removeArchive()` / `pruneArchives()` / `buildArchivedWorktreeSection()` / `parseDuration()` を集約 |
| `skills/cmux-team/manager/worktree-archive.test.ts` | unit test（archive 物理 mv、meta.json schema、find/prune/remove、section builder） |
| `skills/cmux-team/manager/worktree-archive-cli.test.ts` | CLI subcommand のスナップショット / 動作 test |
| `skills/cmux-team/manager/conductor-archive-integration.test.ts` | conductor.ts / daemon.ts 経由の経路別 integration test |
| `docs/spec/16-worktree-archive.md` | 仕様書（レイアウト / archiveWorktree contract / meta schema / Conductor prompt 連携 / CLI / 既存 cleanup 経路との関係 / retention / `.team/worktrees-archive/` 規約） |

---

## 4. データ構造

### 4.1 `.archive-meta.json` schema（v1）

```jsonc
{
  "schema_version": 1,
  "task_id": "094",                                  // canonical task id（数字のみ）
  "task_run_id": "task-094-1778998001",
  "archived_at": "2026-05-17T17:02:36.000Z",         // ISO 8601 UTC ms
  "reason": "disconnect_timeout",                    // §4.3 enum
  "original_path": ".worktrees/task-094-1778998001", // projectRoot 相対
  "branch": "task-094-1778998001/task",
  "base_branch": "main",                             // 起点ブランチ（task-state.json 参照）
  "base_sha": "abcdef1234567",                       // 起点 commit (assigned 時の base_sha)
  "last_commit_sha": "1234abcd",                     // archive 時点の HEAD（branch 先端）
  "uncommitted_changes": true,
  "conductor_surface": "surface:5",                  // 任意。null 可
  "session_id": "01HXR...",                          // 任意。null 可
  "notes": ""                                        // 任意。Implementer/Reviewer から自由追記
}
```

- `original_path` / `branch` / `base_branch` / `base_sha` は `task-state.json` の同 task entry から流用する（archive 時刻には worktree が既に mv 済みなので `git -C <archivePath>` で参照すれば最新も取れる）
- `last_commit_sha` は `git -C <archivePath> rev-parse HEAD`（mv 後）または mv 前に `git -C <worktreePath> rev-parse HEAD`
- `uncommitted_changes` は mv 前に `git -C <worktreePath> status --porcelain | head -1` で判定（行があれば true）

### 4.2 archive ディレクトリ レイアウト

```
.team/worktrees-archive/
  └── task-094-1778998001/
      ├── (元 worktree の全 file — git worktree 自体は prune 後の dangling だが、HEAD を含む `.git` リファレンスは残る)
      ├── .archive-meta.json
      └── (.git は通常 `gitdir: ../../..` の linked worktree → prune で broken になる。`.archive-meta.json` の `branch` 経由で `git log <branch>` するのが正)
```

> **重要**: `git worktree` は `.git` を `gitdir: <main repo>/.git/worktrees/<id>/` への参照ファイルとして持つ。`git worktree prune` を archive 直後に呼ぶと「mv された worktree が消えた」と認識して該当の `.git/worktrees/<id>/` も掃除する。これにより linked worktree としてのレジストレーションは消えるが、**branch (`<taskRunId>/task`) と commit graph は main repo の `.git/` 内に残る**ため、`git log <taskRunId>/task` / `git checkout <taskRunId>/task` は引き続き可能。Implementer は `worktree-archive.md` にこのモデルを明記すること。

### 4.3 `reason` enum（archive_meta + events.jsonl 共通）

| value | 発火源 |
|---|---|
| `disconnect_timeout` | `forceCloseDisconnectedConductor` → resetConductor (daemon.ts:4415) |
| `abort_task` | `ABORT_TASK` handler → resetConductor (daemon.ts:1856) |
| `reset_conductor` | `RESET_CONDUCTOR` handler → resetConductor (daemon.ts:1749) |
| `clear_conductor` | `CONDUCTOR_CLEAR` handler → resetConductor (daemon.ts:1637) ※ 通常は二重 archive を防ぐ（§7-A） |
| `user_clear` | **`SESSION_CLEAR` running 経路（ユーザー手動 `/clear`）** → resetConductor (daemon.ts:3034) [C1] |
| `restart` | `restart-task` CLI → cleanupAssignedTask + restartFromAborted (main.ts:5101 / 5325) |
| `assign_terminal_race` | `applyAssignCommit` terminal race → resetConductor (daemon.ts:3700) |
| `resume` | daemon 起動時の broken 状態復帰経路 (main.ts:1620) |
| `done_unresolved` | `handleConductorDone` で success=false かつ unresolved=false の経路（preserveWorktree が立たない異常終了系） |
| `other` | 未分類フォールバック（forward compat） |
| `legacy_fallback` | **削除経路用** — `cleanupMode === undefined` で resetConductor が呼ばれた場合の後方互換 fallback。archive ではなく **削除** されるため `.archive-meta.json` / events には現れず、log にのみ `legacy_fallback` で記録される |

### 4.4 `events.jsonl` の `worktree_archived` 追加 schema

```typescript
| {
    event: "worktree_archived";
    task_id: string;             // canonical (数字のみ)
    task_run_id: string;
    reason:
      | "disconnect_timeout"
      | "abort_task"
      | "reset_conductor"
      | "clear_conductor"
      | "user_clear"             // ★ [C1] 追加
      | "restart"
      | "assign_terminal_race"
      | "resume"
      | "done_unresolved"
      | "other";
    archive_path: string;        // projectRoot 相対
    archived_at: string;         // ★ [M1] ISO 8601 UTC。meta.json の archived_at と同値（mv 完了時刻のドメイン値、writer の自動付与 ts とは概念分離）
    branch: string;
    uncommitted_changes: boolean;
    last_commit_sha?: string;    // 取得失敗時は省略
  }
```

> **`ts` vs `archived_at`** — `ts` (events-writer.ts が自動付与する write 時刻) は「event が flush された時刻」、`archived_at` は「mv が完了した時刻（ドメイン値）」。両者は通常ミリ秒オーダーで一致するが、writer flush が遅延する場合は差が出るため retrospective 分析では `archived_at` を信用する。

`schema_version` は bump しない（add-only）。

---

## 5. 関数 contract

### 5.1 `archiveWorktree(opts)` と `ResetConductorOpts` cleanupMode 型

```typescript
// skills/cmux-team/manager/worktree-archive.ts

export type ArchiveReason =
  | "disconnect_timeout"
  | "abort_task"
  | "reset_conductor"
  | "clear_conductor"
  | "user_clear"
  | "restart"
  | "assign_terminal_race"
  | "resume"
  | "done_unresolved"
  | "other";

export interface ArchiveWorktreeOpts {
  projectRoot: string;
  worktreePath: string;          // absolute or projectRoot 相対（どちらでも受ける）
  taskRunId: string;
  taskId: string;                // canonical (数字のみ)
  branch: string;                // 例: "task-094-1778998001/task"
  reason: ArchiveReason;
  conductorSurface?: string;
  sessionId?: string;
  baseBranch?: string;
  baseSha?: string;
}

export interface ArchiveWorktreeResult {
  archivePath: string;           // projectRoot 相対
  archivedAt: string;            // ISO 8601 UTC（meta.json と event の archived_at と一致）
  uncommittedChanges: boolean;
  lastCommitSha?: string;
}

export async function archiveWorktree(
  opts: ArchiveWorktreeOpts,
): Promise<ArchiveWorktreeResult>;
```

そして [M4] の対処として `ResetConductorOpts` の cleanup 関連を discriminated union 化:

```typescript
// skills/cmux-team/manager/conductor.ts

export type CleanupMode =
  | { kind: "delete"; reason: string }
  | { kind: "archive"; reason: ArchiveReason }
  | { kind: "preserve" };

export interface ResetConductorOpts {
  targetStatus?: "idle" | "broken" | "reserved";
  reason?: string;
  killClaudeProcess?: boolean;
  cleanupMode?: CleanupMode;                  // ★ [M4] 新規。未指定は legacy_fallback (delete) 扱い
  preserveWorktree?: boolean;                 // ★ DEPRECATED — `cleanupMode: { kind: "preserve" }` と等価。Phase 2 で削除。移行期間は両方サポート (§6.1 参照)
}
```

- `cleanupMode` 未指定 → `{ kind: "delete", reason: "legacy_fallback" }` 相当の挙動（後方互換）。Phase 2 で `cleanupMode` を required に昇格させる TODO コメントを `conductor.ts:resetConductor` に書く
- `preserveWorktree: true` は `cleanupMode: { kind: "preserve" }` と等価。両方指定された場合は `cleanupMode` を優先。Implementer は新規呼び出しでは `cleanupMode` のみを使い、`preserveWorktree` は既存呼び出しの段階的移行に使う
- 新規 `resetConductor()` 呼び出しを追加する開発者は `cleanupMode` を必ず明示する（型推論で undefined が露呈する設計）

実装手順（順序保証）:

1. `worktreePath` が存在しない / archive 先が既存 → `worktree_archive_skipped reason=no_source|target_exists` ログ + 早期 return。**throw しない**（呼び出し元の冪等性確保）
2. mv 前に worktree の状態を採取:
   - `git -C <worktreePath> rev-parse HEAD` → `last_commit_sha`（失敗時は undefined）
   - `git -C <worktreePath> status --porcelain` → 1 行でもあれば `uncommitted_changes=true`
3. `.team/worktrees-archive/` を `mkdir -p`
4. `mv <worktreePath> <archivePath>`（Node.js `fs.rename`、同一 fs 前提で atomic）
   - 失敗時は throw（呼び出し元が log + 削除フォールバックを判断できるよう error code を含む独自エラー型 `ArchiveFailedError` を投げる）
5. `git worktree prune`（cwd=projectRoot、`execFile`）— mv で broken になった linked worktree registration を掃除
6. `.archive-meta.json` を archivePath 直下に書き出し（atomic write: temp file + rename）。`archived_at` は手順 4 完了直後に `new Date().toISOString()` で確定させた値を使う
7. `log("worktree_archived", "task_id=... task_run_id=... reason=... path=... uncommitted=...")` を `manager.log` に
8. `emitEvent({ event: "worktree_archived", archived_at: <手順 6 で確定した同じ ISO 文字列>, ... })` で `events.jsonl` に。**meta.json と event の `archived_at` は必ず同値**（[M1]）
9. `notifyStateChanged` は **emit しない**（dashboard refresh 対象ではない — observatory への通知は events.jsonl 経由）
10. `ArchiveWorktreeResult` を return

冪等性:

- 同 taskRunId の archive が既存 → `worktree_archive_skipped reason=target_exists` ログ + 既存 archivePath を return（呼び出し元が後続処理を続行できる）
- worktreePath が存在しない → `worktree_archive_skipped reason=no_source` ログ + archivePath を「論理的に期待される値」で return（呼び出し元の null チェック不要）

### 5.2 `findArchivesForTaskId(projectRoot, taskId)`

```typescript
export interface ArchiveSummary {
  archivePath: string;          // projectRoot 相対
  taskRunId: string;
  taskId: string;
  archivedAt: string;
  reason: ArchiveReason;
  branch: string;
  uncommittedChanges: boolean;
  lastCommitSha?: string;
}

export async function findArchivesForTaskId(
  projectRoot: string,
  taskId: string,                // canonical (数字のみ)
): Promise<ArchiveSummary[]>;
```

- `.team/worktrees-archive/` 直下の各 directory の `.archive-meta.json` を読み、`task_id` 一致のものを `archived_at` **降順**で return
- meta 読込失敗（壊れた JSON / 欠損）は warn ログ後 skip — エラーは throw しない
  - **ログ event 名（[m6]）**:
    - **`archive_meta_unreadable`** — `readFile` 失敗 / I/O エラー（ENOENT, EACCES 等）
    - **`archive_meta_invalid`** — JSON parse 失敗 / 必須フィールド欠落（schema_version, task_id, task_run_id, archived_at, reason, branch のいずれかが欠ける）
- ディレクトリが存在しない場合は空配列を return

### 5.3 `removeArchive(projectRoot, taskRunId, opts?)`

```typescript
export async function removeArchive(
  projectRoot: string,
  taskRunId: string,
  opts?: { deleteBranch?: boolean },
): Promise<void>;
```

- `rm -rf <archivePath>`
- `opts.deleteBranch === true` で `git branch -D <branch>`（meta から branch を取り出してから rm するので順序: meta 読み込み → branch 削除 → rm -rf）
- 不在は no-op

### 5.4 `pruneArchives(projectRoot, opts)`

```typescript
export async function pruneArchives(
  projectRoot: string,
  opts: { olderThanMs: number; deleteBranches?: boolean; dryRun?: boolean },
): Promise<{ pruned: string[]; skipped: string[] }>;
```

- 現在時刻 - `archived_at` > `olderThanMs` のものを `removeArchive` 経由で削除
- `dryRun: true` のとき削除はせず pruned 候補のみ返す（CLI の確認 prompt で使う）
- `deleteBranches` default は **false**（[m3]）。Phase 2 retention 自動化と合わせて branch 削除戦略を `docs/spec/16-worktree-archive.md` §retention に書く

### 5.5 `buildArchivedWorktreeSection(archive?)` — [M2] section block builder

```typescript
export function buildArchivedWorktreeSection(
  archive: ArchiveSummary | undefined,
): string;
```

- `archive === undefined` → **空文字 `""` を return**（template に何も埋め込まれない = section が「丸ごと存在しない」状態）
- `archive` が与えられた場合は、以下の section 文字列を組み立てて return:

```markdown
## 前回 attempt の archive について

このタスクは前回 daemon クラッシュ / abort / reset などで中断され、再アサインされたものです。

1. `cd <archive.archivePath>` で前回作業を確認
   - `cat .archive-meta.json` で archive 理由・最終 commit・uncommitted の有無
   - `git log --oneline <archive.branch> -10` で前回どこまで commit されたか
   - `git status` で uncommitted な作業がないか
2. 引き継ぎ判断:
   - 続行できそう → `git cherry-pick` / patch 適用で新 worktree に取り込む
   - 別アプローチが必要 → archive は無視して fresh start、判断理由を journal に残す
3. 判断結果を journal に明記してから本作業に入る
```

- archive path / branch を Conductor の prompt 内で **実値として展開**するため、`cd ` の後ろが空になるという [M2] のリスクは構造的に発生しない
- 旧 archive が複数あった場合は `findArchivesForTaskId` の戻り `[0]`（最新）のみを section に埋め込む（§7.3 参照）

### 5.6 CLI: `elevens worktree archive ...`

| サブ | 実装関数 | write 扱い | 出力例 |
|---|---|---|---|
| `list [--task-id N] [--format json\|text]` | `cmdWorktreeArchiveList` | **read** | text: `taskRunId archived_at reason branch uncommitted` のテーブル |
| `show <taskRunId>` | `cmdWorktreeArchiveShow` | **read** | meta.json 全体 + `git log --oneline <branch> -10` + archive path |
| `remove <taskRunId> [--delete-branch]` | `cmdWorktreeArchiveRemove` | **write** (`archive-remove`) | `OK removed task-094-1778998001` |
| `prune --older-than <duration> [--dry-run] [--yes]` | `cmdWorktreeArchivePrune` | **write** (`archive-prune`) | dry-run: 削除候補一覧 / 確定: `OK pruned N archive(s)` |

`--older-than` の duration parser: `30d` / `12h` / `7d12h` 等の humanized 文字列を ms に変換する `parseDuration()` ヘルパを `worktree-archive.ts` に export 形で実装（CLI と `pruneArchives` 両方から使う）。

**`--dry-run` と `--yes` の優先順序（[m9]）**: 両方指定された場合は `--dry-run` を優先する（削除前確認に倒す保守側設計）。`--yes` は `--dry-run` が指定されていないときのみ「対話 confirm prompt を skip して即削除」として機能する。この仕様を `docs/spec/16-worktree-archive.md` の CLI 章にも明記。

---

## 6. 経路の差し替え詳細（before/after）

> Implementer は §2.2 の (D) (F) (G) **(H)** も含めて漏れなく差し替えること。task.md の 4 経路はあくまで「主要 4 経路」。

### 6.1 経路 A〜E, H: `resetConductor` 統合（conductor.ts:763-786）

**Before** (conductor.ts:763-786):

```typescript
// 2. worktree 削除（冪等: 既に削除済みでもエラーにしない）
if (!opts?.preserveWorktree) {
  if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
    try {
      await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
        cwd: projectRoot,
      });
    } catch (e: any) {
      await log("cleanup_failed", `resetConductor worktree remove: ...`);
    }
    if (conductor.taskRunId) {
      const branch = `${conductor.taskRunId}/task`;
      try {
        await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
      } catch (e: any) {
        await log("cleanup_failed", `resetConductor branch delete: ...`);
      }
    }
  }
}
```

**After** ([M4] discriminated union による型強制 + 後方互換):

```typescript
// 2. worktree cleanup — cleanupMode で「archive / delete / preserve」を必ず選ばせる構造に
//   - cleanupMode: { kind: "preserve" } または preserveWorktree=true: 温存（既存）
//   - cleanupMode: { kind: "archive", reason }: archive 化（branch も残す）
//   - cleanupMode: { kind: "delete", reason } または未指定: 削除（後方互換）
const cleanupMode: CleanupMode =
  opts?.cleanupMode
  ?? (opts?.preserveWorktree
    ? { kind: "preserve" }
    : { kind: "delete", reason: "legacy_fallback" });
// TODO(T011-phase2): cleanupMode を required に昇格させ、preserveWorktree opt と legacy_fallback path を削除する。

if (cleanupMode.kind === "preserve") {
  // 温存: 何もしない
} else if (cleanupMode.kind === "archive" && conductor.worktreePath && existsSync(conductor.worktreePath) && conductor.taskRunId && conductor.taskId) {
  try {
    await archiveWorktree({
      projectRoot,
      worktreePath: conductor.worktreePath,
      taskRunId: conductor.taskRunId,
      taskId: conductor.taskId,
      branch: `${conductor.taskRunId}/task`,
      reason: cleanupMode.reason,
      conductorSurface: conductor.surface,
      sessionId: conductor.sessionId,
    });
  } catch (e: any) {
    await log("cleanup_failed", `resetConductor archive failed: ${formatExecError(e)}`);
    // archive 失敗時は削除にフォールバックせず温存（user に判断委ねる）
  }
} else if (cleanupMode.kind === "delete" && conductor.worktreePath && existsSync(conductor.worktreePath)) {
  // 削除経路（後方互換、legacy_fallback 含む）— cleanupMode.reason を log に残す
  try {
    await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
      cwd: projectRoot,
    });
  } catch (e: any) {
    await log("cleanup_failed", `resetConductor worktree remove (cleanup_reason=${cleanupMode.reason}): ${formatExecError(e)}`);
  }
  if (conductor.taskRunId) {
    const branch = `${conductor.taskRunId}/task`;
    try {
      await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
    } catch (e: any) {
      await log("cleanup_failed", `resetConductor branch delete (cleanup_reason=${cleanupMode.reason}): ${formatExecError(e)}`);
    }
  }
}
```

呼び出し側 (`daemon.ts` / `main.ts`) で `cleanupMode` を §2.2 の表に従って付与する:

```typescript
// daemon.ts:4415 (forceCloseDisconnectedConductor) — 経路 E
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "broken",
  reason: "disconnect_timeout",
  cleanupMode: { kind: "archive", reason: "disconnect_timeout" },   // ★ [M4]
}, ccBackend(state.backend));

// daemon.ts:1856 (ABORT_TASK handler) — 経路 C
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "reserved",
  reason: "abort_task",
  cleanupMode: { kind: "archive", reason: "abort_task" },           // ★ [M4]
}, ccBackend(state.backend));

// daemon.ts:1749 (RESET_CONDUCTOR handler) — 経路 B
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "reserved",
  reason: message.reason ?? "user_reset",
  cleanupMode: { kind: "archive", reason: "reset_conductor" },      // ★ [M4]
}, ccBackend(state.backend));

// daemon.ts:1637 (CONDUCTOR_CLEAR handler) — 経路 A
// 注: broken→idle のとき worktree は通常もう存在しない（直前に broken 化したときに archive 済）
//     existsSync ガードが入っているので二重 archive にはならないが、明示的に archive を渡しておく
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "idle",
  reason: message.reason ?? "cleared",
  cleanupMode: { kind: "archive", reason: "clear_conductor" },      // ★ [M4]（防御的）
}, ccBackend(state.backend));

// daemon.ts:3034 (SESSION_CLEAR running, user 手動 /clear) — 経路 H [C1]
// 現状: { targetStatus: "reserved", reason: "user_clear" } のみで archive なし → 進行中 worktree が無言で消えていた既知バグ。
// 本タスクで cleanupMode: { kind: "archive", reason: "user_clear" } を追加し、手動 /clear でも作業を保全する。
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "reserved",
  reason: "user_clear",
  cleanupMode: { kind: "archive", reason: "user_clear" },           // ★ [C1] 新規追加
}, ccBackend(state.backend));

// daemon.ts:3700 (applyAssignCommit terminal race) — 経路 D
await resetConductor(updated, state.projectRoot, state.workspace ?? undefined, {
  cleanupMode: { kind: "archive", reason: "assign_terminal_race" }, // ★ [M4]（既存は opts 自体 undefined）
}, ccBackend(state.backend));

// main.ts:1620 (resume 起動時の broken 復帰) — 経路 G
// （現状を §6 実装時に再 grep。preserveWorktree=true 経路と区別して archive 化）
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  targetStatus: "broken",
  reason: "resume",
  cleanupMode: { kind: "archive", reason: "resume" },               // ★ [M4]
}, ccBackend(state.backend));
```

`handleConductorDone`（経路 F、daemon.ts:4609）は success / unresolved の組み合わせで分岐:

- `success === true` → そもそも `resetConductor` を経由せず close-task 経路で worktree を **削除**
- `success === false && unresolved === true`（judgment_pending）→ `cleanupMode: { kind: "preserve" }`（旧 `preserveWorktree: true` と等価）
- `success === false && unresolved === false`（異常終了系）→ `cleanupMode: { kind: "archive", reason: "done_unresolved" }`

### 6.2 経路: `assignTask` 失敗ロールバック（conductor.ts:663-676）

**変更なし**（task.md §4 維持）。直前に作成された空 worktree であり、内容保全の価値がない。

### 6.3 経路 (3): `cleanupAssignedTask`（main.ts:5072-5122）

`restart-task` から呼ばれる。**worktree remove 部分を archive 化**:

```typescript
// main.ts:5095-5118 を archiveWorktree に置き換え
if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
  if (conductor.taskRunId && conductor.taskId) {
    try {
      await archiveWorktree({
        projectRoot: PROJECT_ROOT,
        worktreePath: conductor.worktreePath,
        taskRunId: conductor.taskRunId,
        taskId: conductor.taskId,
        branch: `${conductor.taskRunId}/task`,
        reason: "restart",
        conductorSurface: conductor.surface,
      });
    } catch (e: any) {
      await log("cleanup_failed", `restart-task archive: ${formatExecError(e)}`);
    }
  } else {
    // taskRunId/taskId 不明（基本起きない）→ 既存挙動（remove + branch -D）にフォールバック
  }
}
```

### 6.4 経路 (4): `restartFromAborted`（main.ts:5314-5346）

aborted → ready 経路。`worktree remove` を archive に置き換え:

```typescript
if (stale.worktreePath && existsSync(stale.worktreePath)) {
  if (stale.taskRunId) {
    try {
      await archiveWorktree({
        projectRoot: PROJECT_ROOT,
        worktreePath: stale.worktreePath,
        taskRunId: stale.taskRunId,
        taskId,
        branch: `${stale.taskRunId}/task`,
        reason: "restart",
      });
    } catch (e) {
      await log("cleanup_failed", `restart-task aborted archive: ${formatExecError(e)}`);
    }
  } else {
    // 既存 fallback
  }
}
// 既存の `git branch -D <branch>` は archiveWorktree が branch を残すので削除する
```

---

## 7. Conductor template への archive 通知

### 7.1 template 編集（[M2] section block placeholder）

`skills/cmux-team/templates/ja/conductor-task.md` の末尾を以下に置換:

```markdown
{{ARCHIVED_WORKTREE_SECTION}}
```

- archive 不在時 → `buildArchivedWorktreeSection(undefined) === ""` で template にセクション全体が **存在しなくなる**（不完全コマンド `cd ` が prompt に残るリスクがない、[M2] の Critical 修正）
- archive 存在時 → §5.5 の section 文字列が path / branch 込みで埋め込まれる

### 7.2 `generateConductorTaskPrompt` 拡張

```typescript
export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch: string | undefined,
  taskDir: string | undefined,
  mainBranch: string,
  archivedWorktreeSection: string = "",  // ★ [M2] / [m1] section block 一本化で positional 引数は 1 個増のみ
): Promise<string> {
  // ...
  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    // ...
    .replace(/\{\{ARCHIVED_WORKTREE_SECTION\}\}/g, archivedWorktreeSection);  // ★ [M2]
  // ...
}
```

### 7.3 `assignTask` での組み立て

`conductor.ts:assignTask` 内で `generateConductorTaskPrompt` を呼ぶ直前に:

```typescript
const archives = await findArchivesForTaskId(projectRoot, taskId);
const archivedSection = buildArchivedWorktreeSection(archives[0]);
// findArchivesForTaskId は archived_at 降順 → [0] が最新
const promptFile = await generateConductorTaskPrompt(
  projectRoot,
  taskRunId,
  taskId,
  // ...
  mainBranch,
  archivedSection,
);
```

> 旧 archive (`archived_at` 古い順) は無視し、最新 1 件のみ Conductor に渡す。Conductor が「複数 archive のどれを使うか」を判断するのは過剰負荷で、また連続中断のケースでは最新の進捗のみ価値がある。
> 旧 archive を一覧で見たい場合は `elevens worktree archive list --task-id <id>` を Conductor が自発的に叩く（section 文面に補足として書いておく）。

### 7.4 `docs/spec/04-templates.md` 更新

`{{ARCHIVED_WORKTREE_SECTION}}` の placeholder 仕様を 1 件追加:

| placeholder | 値 | 空文字許容 | 用途 |
|---|---|---|---|
| `{{ARCHIVED_WORKTREE_SECTION}}` | 同 task ID の最新 archive 情報を含む markdown section（複数行、archive path / branch 入り）。archive 不在時は空文字 | 可（archive 不在時） | Conductor の引き継ぎ判断 |

---

## 8. ドキュメント更新

### 8.1 `docs/spec/16-worktree-archive.md`（新規）

章構成:

1. 概要・目的
2. アーキテクチャ図（cleanup 経路から archive への流れ、prompt 連携、CLI、events）
3. ディレクトリレイアウト（§4.2）
4. `.archive-meta.json` schema（§4.1）
5. `archiveWorktree()` contract（§5.1）
6. `findArchivesForTaskId()` contract（§5.2、`archive_meta_unreadable` / `archive_meta_invalid` ログ event 名 明記）
7. cleanup 経路の archive 化（§6 の対応表 — A〜H の 8 経路）
8. Conductor prompt への連携（§7、`{{ARCHIVED_WORKTREE_SECTION}}` section block 設計）
9. CLI（§5.6、CLI 名 `elevens` vs `cmux-team` の関係 1 行明記 [m5]、`--dry-run` と `--yes` の優先順序 [m9]）
10. events.jsonl 連携（§4.4、`archived_at` と `ts` の概念分離 [M1]）
11. retention / GC（Phase 2 で別タスク扱い）+ branch 削除戦略（[m3]）+ Phase 1 操作と Phase 2 自動化の境界
12. `.team/worktrees-archive/` の write 経路規約（**daemon 専有領域**、CLI 経由でのみ操作 [m7]）
13. リスク と対処（§11）
14. 関連 spec / glossary 参照

### 8.2 `docs/spec/07-state-machine.md` 追記

「§6 段階計画」直後に **§6.5 cleanup 経路の archive 化** を追加（または §3「Conductor ↔ Task の同時遷移」の末尾）:

- worktree 物理削除は **`CONDUCTOR_DONE success=true` 経路（`close-task`）のみ**
- それ以外の `assigned → aborted` / `assigned → reserved` / `assigned → broken` / `running → reserved`（手動 `/clear`）等の遷移では archive 化
- archive 化された worktree は branch ごと保存され、`elevens worktree archive show` で参照可能
- `judgment_pending`（D2）は **in-place 温存**（archive ではない）
- 詳細は `docs/spec/16-worktree-archive.md` を参照

### 8.3 `docs/spec/10-events-stream.md` 追記

- §1 の概要に「Conductor / Task lifecycle + Artifact lifecycle + **Worktree lifecycle**」と章を追加
- §5 のテーブルに `worktree_archived` を追加、合計 18 event に
- §6.18 として `worktree_archived` schema を §4.4 のとおり追記（`archived_at` フィールド込み [M1]）

### 8.4 `docs/spec/glossary.md` 追記

§9「Worktree / start-point 解決」に追加:

| 用語 | 一次定義 | 補足 |
|---|---|---|
| worktree archive | `docs/spec/16-worktree-archive.md` | 異常終了系の cleanup 経路で worktree を `.team/worktrees-archive/<taskRunId>/` に退避する仕組み |

### 8.5 `docs/spec/04-templates.md` 追記

§7.4 のとおり `{{ARCHIVED_WORKTREE_SECTION}}` placeholder を 1 件追加。

### 8.6 `CLAUDE.md` 追記

「git worktree（概要）」節に 1 行追加:

```
- 正常完了以外の cleanup 経路（abort / reset / disconnect / restart / 手動 /clear）では `.team/worktrees-archive/<taskRunId>/` に退避（archive 化）し、branch を残す。詳細は `docs/spec/16-worktree-archive.md`
```

---

## 9. テスト計画

### 9.1 unit test — `worktree-archive.test.ts`

- `archiveWorktree()` ハッピーパス: ダミー worktree（git init 済の小さな fixture）を archive → archivePath 存在 / meta.json schema 一致 / branch が残っている / meta の `archived_at` と return 値の `archivedAt` が一致
- `archiveWorktree()` 冪等性: worktreePath 不在 → no-op return（meta 値が論理整合）
- `archiveWorktree()` target_exists: 同 taskRunId の archive 既存 → skip ログ + 既存 path を return（既存 archive を破壊しないこと）
- `archiveWorktree()` mv 失敗: archivePath が file として既存 → `ArchiveFailedError` throw
- `uncommitted_changes` 検出: `echo foo > x.txt`（add せず）で archive → meta.json `uncommitted_changes=true`
- `findArchivesForTaskId()`: 3 つの archive（同 task_id 2 つ + 別 task_id 1 つ）を作って → 同 task_id 2 件が archived_at 降順で返る
- `findArchivesForTaskId()` 壊れた meta: `.archive-meta.json` が不正 JSON → `archive_meta_invalid` warn ログ + skip
- `findArchivesForTaskId()` 読み込み不能: パーミッション無し / 欠損 → `archive_meta_unreadable` warn ログ + skip
- `removeArchive()`: archive + branch（`--delete-branch`）削除確認
- `pruneArchives()` dryRun: `pruned: [..]` を返し物理削除しない / 確定モードで rm
- `parseDuration()` helper: `30d` → 30*24*3600*1000 等
- `buildArchivedWorktreeSection(undefined)` → 空文字
- `buildArchivedWorktreeSection(archive)` → 期待される markdown section（path / branch / archived_at が展開されている）

### 9.2 unit test — `events-writer.test.ts`（既存ファイル拡張）

- `emitEvent({ event: "worktree_archived", archived_at: "...", ... })` が events.jsonl の 1 行 JSON として writable
- 出力された JSON line に `ts`（writer 自動付与）と `archived_at`（呼び出し側指定）が両方含まれ、別フィールドとして並ぶ [M1]
- `schema_version` が現行 (`2`) のまま（bump していないこと）

### 9.3 unit test — template

`template.test.ts` に新規 case 追加（既存テストファイルがあるか確認、なければ `template.test.ts` を新設）:

- `generateConductorTaskPrompt(..., archivedWorktreeSection = "## 前回 attempt...")` → 結果に section 文字列が埋め込まれる
- `archivedWorktreeSection = ""`（default）→ template に `{{ARCHIVED_WORKTREE_SECTION}}` が残っていない（空文字に置換され、section 全体が prompt から消えている）

### 9.4 integration test — `conductor-archive-integration.test.ts`（新規、計 10 ケース）

各経路で archive 化されるかを daemon FSM 経由で検証（既存 `daemon.test.ts` のパターンを踏襲）。test 番号体系は `archive-<reason>` で統一 [m4]:

1. **`archive-disconnect_timeout`**: conductor を disconnected 状態に置き、`forceCloseDisconnectedConductor` を呼ぶ → archivePath 存在 / meta.reason=`disconnect_timeout` / worktreePath が `.team/worktrees-archive/...` に移動 [m10]
2. **`archive-abort_task`**: `ABORT_TASK` message を handleMessage に流す → archive 存在 / reason=`abort_task` / worktreePath が `.team/worktrees-archive/...` に移動
3. **`archive-reset_conductor`**: `RESET_CONDUCTOR` message → reason=`reset_conductor` / worktreePath が `.team/worktrees-archive/...` に移動
4. **`archive-user_clear`** (★ [C1] 新規): `SESSION_CLEAR` message を running 状態の conductor に流す（taskRunId 一致で manualUserInitiated 判定）→ daemon.ts:3034 経路を通過 → archive 存在 / reason=`user_clear` / worktreePath が `.team/worktrees-archive/...` に移動
5. **`archive-restart-assigned`**: cleanupAssignedTask を直接呼ぶ → reason=`restart` / worktreePath が `.team/worktrees-archive/...` に移動
6. **`archive-restart-aborted`**: restartFromAborted → reason=`restart` / worktreePath が `.team/worktrees-archive/...` に移動
7. **`archive-assign_terminal_race`**: applyAssignCommit で task が既に closed 状態のときに opts 未指定で resetConductor 呼ばれる経路 → reason=`assign_terminal_race` / archive 存在
8. **`archive-resume`**: daemon 起動時に broken 状態の conductor を resume → reason=`resume` / archive 存在
9. **`regression-success-deletes`**（regression）: handleConductorDone success=true → archive されない / worktreePath が削除されている
10. **`regression-judgment-preserves`**（regression）: handleConductorDone success=false unresolved=true → archive されない / worktreePath 温存（`cleanupMode: { kind: "preserve" }`）

### 9.5 integration test — Conductor prompt への埋め込み

- `assignTask` を、同 taskId の archive がある状態で呼ぶ → 生成された prompt file に `{{ARCHIVED_WORKTREE_SECTION}}` が **section 文字列に置換**されている（archive path / branch が実値展開されている）
- archive がない状態で呼ぶ → prompt 内に `{{ARCHIVED_WORKTREE_SECTION}}` が残っていない（空文字に置換され、section 全体が消えている）

### 9.6 CLI test — `worktree-archive-cli.test.ts`（新規）

- `elevens worktree archive list` → 0 件で empty テーブル、N 件で N 行
- `list --task-id N` で filter
- `list --format json` で JSON 出力
- `show <id>` で meta 出力 + git log 出力（git fixture のセットアップ要）
- `remove <id>` で archive ディレクトリ消滅、`--delete-branch` で branch 消滅
- `prune --older-than 30d --dry-run` で削除候補のみ表示、`--older-than 30d --yes` で実削除
- `prune --older-than 30d --dry-run --yes` 併用時は `--dry-run` を優先（削除されない）[m9]

### 9.6.1 CLI write gate test（`cli-project-root.test.ts` 追加 [m8]）

- `worktree archive list` / `show` は **read** 扱い → cwd 外でも prompt 出ない
- `worktree archive remove` / `prune` は **write** 扱い → cwd 外で `--project-root-confirm` なしだと reject される
- `isWriteCommand("worktree", "archive-list")` → false, `isWriteCommand("worktree", "archive-remove")` → true 等のアダプタ検証

### 9.7 既存 test の影響調査・補修

以下を bun test で個別に実行して回帰確認:

- `cleanup.test.ts`
- `conductor.test.ts`（特に worktreePath 周辺の assertion）
- `daemon.test.ts`（resetConductor 経路、abort-task 経路、disconnect_timeout 経路、SESSION_CLEAR running 経路の test）
- `main.test.ts`（restart-task 経路）
- `state-machine/fsm.test.ts`（task_aborted reason の網羅性）

> CLAUDE.md「`bun test` 全体実行は禁忌」に従い、ファイル個別に `bun test --timeout 30000 <file>` で回す。

期待される影響:

- `cleanupMode` を渡していない既存 test 呼び出しは「後方互換: legacy_fallback で削除」経路を通り pass のはず
- `preserveWorktree: true` を渡している既存 test は `cleanupMode === undefined` で `preserveWorktree` フラグから `{ kind: "preserve" }` への自動変換が走り、挙動は維持される
- worktreePath が削除されていることを assert している test は影響なし（archive 化していない経路だから）
- ただし `conductor.test.ts:100` のような「`.worktrees` ディレクトリが存在しない」assertion は、archive 化経路を通る test に作り替える際に注意

---

## 10. 実装順序（test-first）

各 step 単位で `bun test --timeout 30000 <該当 file>` が pass する状態をマイルストーンとする。

| Step | 内容 | 検証 |
|---|---|---|
| 1 | `events-writer.ts` の `EventStreamRecord` に `worktree_archived` variant を追加（`archived_at` フィールド込み、writer 拡張のみ、emit 呼び出しはまだ無し）[M1] | `bun test events-writer.test.ts`（既存 test pass / 新規 test 1 件で writable + `ts`/`archived_at` 並列確認） |
| 2 | `worktree-archive.ts` を新規作成（`archiveWorktree` / `findArchivesForTaskId` / `removeArchive` / `pruneArchives` / `buildArchivedWorktreeSection` / `parseDuration`）+ test | `bun test worktree-archive.test.ts` |
| 3 | `template.ts` の `generateConductorTaskPrompt` 拡張（`archivedWorktreeSection` 追加、[M2]）+ `templates/ja/conductor-task.md` の section placeholder 化 | template test |
| 4 | `conductor.ts:resetConductor` に `cleanupMode` discriminated union opts 追加 + archive 経路の実装（cleanupMode 未指定は legacy_fallback で既存削除挙動）[M4] | `bun test conductor.test.ts daemon.test.ts` |
| 5 | `daemon.ts` の **6 箇所**（§2.2 (A)-(E) **+ (H) [C1]**）の resetConductor 呼び出しに `cleanupMode` 付与 + integration test 追加（10 ケース構成）| `bun test conductor-archive-integration.test.ts` |
| 6 | `main.ts:cleanupAssignedTask` を archive 化 | `bun test main.test.ts`（restart-task 系） |
| 7 | `main.ts:restartFromAborted` を archive 化 + `main.ts:1620` resume 経路に `cleanupMode` 付与 | `bun test main.test.ts` |
| 8 | `conductor.ts:assignTask` で `findArchivesForTaskId` + `buildArchivedWorktreeSection` を呼び `generateConductorTaskPrompt` に渡す | `bun test conductor.test.ts` の prompt 生成系 |
| 9 | CLI `elevens worktree archive {list,show,remove,prune}` を main.ts に dispatch 追加 + `WRITE_COMMANDS` に `worktree: new Set(["archive-remove", "archive-prune"])` 登録 + `isWriteCommand` アダプタ [M3] | `bun test worktree-archive-cli.test.ts cli-project-root.test.ts` |
| 10 | ドキュメント更新（`docs/spec/16-worktree-archive.md` 新規、`07` / `10` / `glossary.md` / `04-templates.md` / `CLAUDE.md` 追記） | 目視 + dockeeper skill |
| 11 | 全関連 test を通す: `for f in cleanup.test.ts conductor.test.ts daemon.test.ts main.test.ts worktree-archive*.test.ts state-machine/*.test.ts cli-project-root.test.ts; do bun test --timeout 30000 "$f"; done` | 全 pass |

> Step 1〜4 が独立性高い。Step 5〜8 は順次依存。Step 9 は独立。Step 5 は SESSION_CLEAR 経路追加で範囲が広がるが Step 番号は維持。

---

## 11. リスクと対処

| # | リスク | 評価 | 対処 |
|---|---|---|---|
| R1 | **同 taskRunId の archive を作る race**（active worktree が並走中） | **規約上発生不可** — `taskRunId` は `task-XXX-TIMESTAMP` 形式で unique。同時に同 task が assigned になることはない（task FSM が `assigned` 単一性を保証）。**規約上発生しないが念のため `archiveWorktree()` の target_exists skip で no-op** [m2] | 念のため `archiveWorktree()` で archive 先既存時は no-op（skip） |
| R2 | **`mv` 中の crash recovery** | 同一 fs 上の rename は POSIX で atomic。`.worktrees/` も `.team/worktrees-archive/` も同 projectRoot 配下 → 通常同 fs | 違う fs（projectRoot を symlink で別 fs にしている等）の場合 `EXDEV` で失敗 → `cleanup_failed` ログ + worktree は元場所に残る（次回 restart で再 archive 試行） |
| R3 | **branch 名衝突**（archive 復元時に元 branch が残存） | `<taskRunId>/task` の taskRunId が unique なので原理上衝突なし。ただし `archive-meta` を引き継いで cherry-pick する Conductor が手動でブランチを切り直したときに事故り得る | 仕様書 `16-worktree-archive.md` に「archive の branch には直接 push / commit せず、cherry-pick で取り込む」を明記 |
| R4 | **`git worktree prune` のタイミング** | mv 直後に `prune` を呼ばないと、main repo の `.git/worktrees/<id>/` に dangling registration が残り、`git worktree list` の出力を汚す | `archiveWorktree()` の手順 5 で `git worktree prune` を必ず呼ぶ。失敗は warn ログのみ（fatal にしない） |
| R5 | **既存テスト fixture が `.worktrees/` 削除を前提** | `cleanup.test.ts` / `conductor.test.ts` / `daemon.test.ts` 等で assertion 多数 | `cleanupMode` を渡さない経路は既存挙動を維持する後方互換設計 (§6.1) で吸収。新規 archive 化 test は専用 integration test で書く。「worktreePath が `.team/worktrees-archive/...` に移動した」assert も §9.4 に追加 [m10] |
| R6 | **`.team/worktrees-archive/` がディスクを食い続ける** | retention 自動化は Phase 2（task.md Non-goals 通り） | `elevens worktree archive prune --older-than 30d` を提供し、CLAUDE.md / spec に運用ガイドを記載。Phase 2 で `deleteBranches` default を再検討 [m3] |
| R7 | **archive の `.git/` が dangling になり worktree 内 git 操作不可** | `git worktree prune` 後の archive 内 `.git` はパス参照切れの linked worktree | meta.json の `branch` を main repo 側で参照 (`git -C <projectRoot> log <branch>`) が正。`worktree-archive.md` のトラブルシュート節に明記 |
| R8 | **WRITE_COMMANDS の階層問題**（`worktree` の subcommand の subcommand を分岐したい） | 現行構造 `Record<string, true \| Set<string>>` は 2 階層のみ | **採用案 [M3]**: `worktree: new Set(["archive-remove", "archive-prune"])` で flat に展開。`isWriteCommand` 側で `args[1] + "-" + args[2]` を subCmd として組み立てるアダプタを 1 行追加。list / show は **write 対象外** のままで oncall が cwd 外から確認可能 |
| R9 | **二重 archive**（CONDUCTOR_CLEAR で broken→idle のときに既に archive 済みの worktree を再 archive しようとする / SESSION_CLEAR running の後で CONDUCTOR_CLEAR が来る場合も同様） | `forceCloseDisconnectedConductor` / SESSION_CLEAR running で archive 後、CLI `clear-conductor` で再度 `resetConductor` が呼ばれる | `archiveWorktree()` の existsSync ガード + target_exists skip で no-op。clear-conductor 経路の test で確認 |
| R10 | **`archived_at` 昇順ソート時のロケール依存** | ISO 8601 string は字句順 = 時刻順なので問題なし | `findArchivesForTaskId` で `Array.sort((a,b) => b.archived_at.localeCompare(a.archived_at))` |
| R11 | **archive 中の Conductor 再起動 race**（archive 完了前に新 assignTask が走り `findArchivesForTaskId` が古い結果 / 未完了状態を返す） | `archiveWorktree` は同期 `await` で順序保証 | resetConductor の archive 完了を `await` してから notifyStateChanged → 次の scanTasks tick で再 assign となる順序を保証 |
| R12 | **`cleanupMode` legacy_fallback の事故性** | `archiveReason` 未指定 → 削除 fallback の社会的契約に依存していた問題 [M4] | discriminated union で `{ kind: "delete" / "archive" / "preserve" }` を必ず選ばせる構造に変更。`cleanupMode` 未指定時のみ legacy_fallback (delete) として後方互換。Phase 2 で `cleanupMode` required 昇格・`preserveWorktree` opt 削除の TODO を `conductor.ts:resetConductor` に書く |

---

## 12. Acceptance Criteria 対応チェックリスト

| AC | 対応 plan section |
|---|---|
| ✅ `elevens abort-task` 実行後、worktree が `.team/worktrees-archive/<taskRunId>/` に移動し meta.json に reason=`abort_task` | §6.1 + §9.4-2 |
| ✅ disconnect_timeout 経路でも archive される | §6.1 + §9.4-1 |
| ✅ `reset-conductor` / `clear-conductor` / **手動 `/clear`（SESSION_CLEAR running）** で archive される [C1] | §6.1 + §9.4-3 + §9.4-4 |
| ✅ `restart-task` 経路で stale worktree が archive されたうえで新 worktree が作成される | §6.3 + §6.4 + §9.4-5/6 |
| ✅ 正常 CONDUCTOR_DONE では従来通り削除（archive されない） | §6.2 維持リスト + §9.4-9 |
| ✅ judgment_pending では in-place 温存 | §6.1 `cleanupMode: { kind: "preserve" }` + §9.4-10 |
| ✅ archive を含む task が再アサインされたとき Conductor の prompt に `{{ARCHIVED_WORKTREE_SECTION}}` が埋まる | §7 + §9.5 |
| ✅ `elevens worktree archive {list,show,remove,prune}` が動く | §5.6 + §9.6 |
| ✅ `events.jsonl` に `worktree_archived` event（`archived_at` フィールド含む）| §4.4 + §5.1 手順 8 + §9.2 |
| ✅ `docs/spec/16-worktree-archive.md` 新規 + 関連 spec 更新 | §8 |
| ✅ 既存の cleanup / abort-task / restart-task / reset-conductor 周りの test が pass | §9.7 + §10 Step 11 |

---

## 13. Implementer 向け補足

- **`cleanupMode` discriminated union により「archive する / 削除する / 温存する」の選択は型強制**。Phase 1 では `cleanupMode === undefined` のみ legacy_fallback (delete) として後方互換だが、Phase 2 で required に昇格させる予定。新規 `resetConductor()` 呼び出しを書くときは TypeScript の型補完で 3 択のいずれかを必ず明示する。reviewer は git diff で `cleanupMode` 明示の有無をチェックすればよい（社会的契約ではなく型レベルの構造的防御）[M4]
- **`emitEvent` の引数は discriminated union なので、TypeScript の型補完で reason の取り得る値が見える**。enum 拡張時はここを最初に直す
- **task.md の 4 経路 + plan §2.2 の (D)(F)(G)(H) すべてに `cleanupMode` を漏れなく付与**。(H) = SESSION_CLEAR running は手動 `/clear` 時の進行中 worktree 保全に必須（[C1]）。grep で `resetConductor(` の全呼び出しを reviewer が再確認
- **`assignTask` 内の `findArchivesForTaskId` + `buildArchivedWorktreeSection` 呼び出しは worktree 作成より前 / 後どちらでも良いが、`generateConductorTaskPrompt` の直前にまとめる**のが読みやすい
- **`docs/spec/16-worktree-archive.md` は spec として最終ソースオブトゥルース**。実装と乖離が出たら spec を直す（実装側のヒューリスティクスではない）
- **CLI の `parseDuration` は `pruneArchives` の中ではなく `worktree-archive.ts` の export helper として作る**。CLI と pruneArchives 両方から使う
- **CLI 名は `elevens` と `cmux-team` 両対応**（既存 dispatcher のとおり）。`docs/spec/16-worktree-archive.md` の CLI 章に 1 行明記 [m5]
- **`.team/worktrees-archive/` は daemon / CLI 経由のみで操作**。手書き禁止を spec §12 に明記 [m7]
- **events.jsonl の `archived_at` は meta.json と同値を必ず保つ**。手順 6 で確定させた ISO 文字列を手順 8 でも使う [M1]
