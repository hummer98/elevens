# Plan: artifact 追加を events stream に emit する (Phase 1)

## 1. 背景・目的

`elevens artifacts add` / `/elevens:artifact` でアーティファクトを追加した際、`.team/logs/events.jsonl` にも task journal にも痕跡が残らないため、観察箱（observatory）として「いつ・誰が・どの種類の知見を残したか」を retrospective に追えない。 `skills/cmux-team/manager/artifact.ts::addArtifact()` はファイル書き込みのみで、何も emit していないのが原因。

このタスクでは Phase 1 として、`addArtifact()` の末尾で `events-writer` 経由に `artifact_added` event を 1 つ追加する。Phase 2 (task journal 追記) / Dashboard UI / watch skill 対応は本タスクの範囲外。

## 2. 事前調査結果

### 2.1 `skills/cmux-team/manager/events-writer.ts`

- `EventStreamRecord` は discriminated union（`event` フィールドで弁別）として export されており、`artifact.ts` から `EventStreamRecord` と `emitEvent` を import すれば足りる。
- `emitEvent(record)` は `schema_version` / `ts` を内部で自動付与する。呼び出し側は payload のみ渡す（events-writer.ts:198-223）。
- ファイルパスは `process.env.PROJECT_ROOT || process.cwd()` から `.team/logs/events.jsonl` を組み立てる（events-writer.ts:183-189）。CLI 経由 `addArtifact()` でも `main.ts:451` で `process.env.PROJECT_ROOT = PROJECT_ROOT` がプロセス先頭で必ず設定されるため、daemon プロセス外から呼んでも projectRoot は一致する。
- 書き込み失敗は throw せず `manager.log` に `events_writer_error` を残す best-effort 設計。新規 event 追加でこの挙動は変更しない。
- `EVENTS_SCHEMA_VERSION = 2`。今回の追加は新 event 追加（additive）のため schema_version bump は不要（spec §4 に明記）。

### 2.2 `skills/cmux-team/manager/artifact.ts::addArtifact()`

- 戻り値は現状 `{ id, destPath, unlinkWarning? }`（artifact.ts:170-235）。
- emit に必要な値はすべて関数内で組み立て済み:
    - `id`: `nextArtifactId()` の戻り値（artifact.ts:173）
    - `destPath`: `join(artifactsDir, destFileName)`（artifact.ts:224）
    - `meta.type` / `meta.title` / `meta.author` / `meta.task`: `existing` / `opts` から確定（artifact.ts:185-209）
- author は `opts` 指定なし。`existing.author` または `process.env.CMUX_SURFACE ?? "unknown"` から決まる（artifact.ts:180, 192, 204）。Phase 1 ではこの値をそのまま emit する。
- `addArtifact` は daemon プロセス外（CLI）から呼ばれる。`emitEvent` は POSIX `appendFile`（`O_APPEND` 相当）で書き込むため、別プロセスが同時に書いていても 1 record（数百バイト）単位で atomic に append される。lock 機構の追加は不要。

### 2.3 `skills/cmux-team/manager/events-writer.test.ts`

- テストは `createDummyProject({ setProjectRootEnv: true })` で tmp dir を `process.env.PROJECT_ROOT` に注入し、`emitEvent` 後に `readJsonl()` で全行を JSON.parse して検証する流儀（events-writer.test.ts:14-31, 162-218）。
- 追加テストは `describe("emitEvent: payload type 動作")` ブロックに `artifact_added` 用 test を 1 つ足せばよい（既存 `task_assigned` / `task_completed_state_mismatch` / `conductor_disconnected` / `api_error_received` と同じ形）。

### 2.4 `skills/cmux-team/manager/artifact.test.ts`

- **存在しない**。新規作成が必要。
- 既存 manager テストと同様、`createDummyProject` + `beforeEach`/`afterEach` で env を tmp dir に向け、`addArtifact()` を直接呼んで結果ファイルと `.team/logs/events.jsonl` を検証する。

### 2.5 `docs/spec/10-events-stream.md`

- §2 ファイル仕様: `writer` 行に「Manager daemon のみ（Phase 1）」と明記されている（10-events-stream.md:48）。 → `artifacts CLI` も writer として正規化されるため更新が必要。
- §5「合計 **16 event 種**。Task lifecycle 8 種 + Conductor lifecycle 8 種。」（10-events-stream.md:92）→ 17 種 + Artifact lifecycle 1 種を追記。
- §5 の sub-section（5.1 / 5.2）に並ぶ形で **§5.3 Artifact lifecycle（1 event）** を新設し、`artifact_added` を表 1 行で掲載。
- §6 詳細表セクションに **§6.17 `artifact_added`** を末尾追加（既存番号は触らない）。
- 脚注「17 event 種と記載されているが…」の説明は本タスクで触らない（Phase 1 後は 17 種に揃うが、注釈は v2 確定時の議論の経緯メモなのでそのまま残す）。

## 3. 実装ステップ

### Step 1: `EventStreamRecord` union に `artifact_added` を追加

**file**: `skills/cmux-team/manager/events-writer.ts`

`EventStreamRecord` の末尾（最後の `}` の前、`mailbox_changed` 等と同じ階層）に variant を 1 つ足す。

```ts
| {
    event: "artifact_added";
    artifact_id: string;          // "A045" 形式
    artifact_path: string;        // projectRoot 相対の .team/artifacts/A045-xxx.md
    artifact_type: string;        // research / decision / session / spec / report
    title: string;
    author: string;               // surface ID（surface:100 等）または "unknown"
    task_id?: string;             // frontmatter `task:` がある場合のみ
  }
```

`schema_version` は bump しない（additive ルールに従う / spec §4）。

### Step 2: `addArtifact()` の末尾で `emitEvent` を呼ぶ

**file**: `skills/cmux-team/manager/artifact.ts`

- ファイル上部の import に `import { emitEvent } from "./events-writer";` を追加（既存 import に並べる）。
- `addArtifact` 内、`unlink(opts.srcPath)` の try/catch ブロック直後（`return { id, destPath, unlinkWarning };` の **直前**）で emit する。`destPath` を `opts.projectRoot` 相対に変換する（既存 `.team/artifacts/` 配下の `destFileName` を組み立てる側のコードがあるので `join(".team/artifacts", destFileName)` で構成する）。
- 渡す値は関数内で既に確定している `id` / `meta.type` / `meta.title` / `meta.author` / `meta.task` をそのまま使う。`task_id` は `meta.task` が `undefined` の場合は payload から omit する（`...(meta.task ? { task_id: meta.task } : {})` 形式）。
- emit は best-effort（`emitEvent` 自体が throw しない設計）なので、`addArtifact` の return path は変えない。

**戻り値の型変更は不要**（呼び出し側 `main.ts:6303-6316` の handling もそのまま）。

### Step 3: spec を更新

**file**: `docs/spec/10-events-stream.md`

3 箇所を編集:

1. **§2 ファイル仕様の `writer` 行**: 「Manager daemon のみ（Phase 1）。CLI 等の外部からの emit は未サポート」→ 「Manager daemon および `cmux-team artifacts add` CLI。それ以外の外部 writer は未サポート」に更新。
2. **§5 冒頭**: 「合計 **16 event 種**。Task lifecycle 8 種 + Conductor lifecycle 8 種。」→ 「合計 **17 event 種**。Task lifecycle 8 種 + Conductor lifecycle 8 種 + Artifact lifecycle 1 種。」に更新。脚注（17 種記載と乖離していた件）はそのまま残す。
3. **§5.3 Artifact lifecycle（1 event）** を新設し、`6.17 / artifact_added / artifact が追加された / observatory での知見追跡` の 1 行を表で記載。
4. **§6.17 `artifact_added`** を §6 末尾に追加。field 表は Step 1 で定義した 7 field（うち `task_id` のみ optional）を記載。「`addArtifact()` の末尾で emit。author は呼び出し時 env / 既存 frontmatter から決定する」旨を本文 1〜2 行で補足。

`schema_version` bump は **しない**（§4 additive ルール）。

### Step 4: writer の round-trip テスト追加

**file**: `skills/cmux-team/manager/events-writer.test.ts`

`describe("emitEvent: payload type 動作")` ブロック内、`api_error_received` テストの直後に test を追加。

- `emitEvent({ event: "artifact_added", artifact_id: "A045", artifact_path: ".team/artifacts/A045-foo.md", artifact_type: "research", title: "調査", author: "surface:100", task_id: "T038" })` を呼ぶ → `readJsonl()` の 1 行目に全 field が含まれることを assert。
- `task_id` を省略した場合に `"task_id" in rec` が `false` になることも 1 ケース確認（`conductor_disconnected` の既存テストと同じパターン）。

### Step 5: `addArtifact` の events 連携テストを新規追加

**file**: `skills/cmux-team/manager/artifact.test.ts`（新規作成）

- `createDummyProject({ prefix: "cmux-artifact-test-", subdirs: ["logs", "artifacts"] })` でテスト用 project を作る。`subdirs` に `artifacts` を含めることで `.team/artifacts/` を事前 mkdir しておく（`addArtifact` 内で `mkdir({ recursive: true })` するので必須ではないが明示しておく）。
- 入力ファイルを tmp に書き、`addArtifact({ projectRoot, srcPath, type: "research", title: "テスト" })` を実行 → `.team/logs/events.jsonl` を読み、`event === "artifact_added"` の record が 1 行 append されていることを確認する。`artifact_id` が `A001` 形式、`artifact_path` が `.team/artifacts/A001-*.md` 形式で始まることを assert。
- 入力 frontmatter に `task: T038` を含めた別ケース → `task_id: "T038"` が record に含まれることを assert。
- frontmatter `task:` 無しケース → `task_id` field が omit されていることを assert。
- 既存 `parseArtifactMeta` / `validateArtifact` / `nextArtifactId` の pure テストも本ファイルに最小限同居させてよい（task 範囲外なので skip 可、ただし新規ファイルなのでせっかくなら 1〜2 個の sanity test を入れておくと将来 regression に強い）。

## 4. テスト戦略

### 追加するテストケース一覧

| # | file | テスト名 | 検証内容 |
|---|------|----------|----------|
| T1 | `events-writer.test.ts` | `artifact_added: 全 field が round-trip する` | event 名 / artifact_id / artifact_path / artifact_type / title / author / task_id が emit→readback で一致 |
| T2 | `events-writer.test.ts` | `artifact_added: task_id 省略時は record に含まれない` | `"task_id" in rec === false` |
| T3 | `artifact.test.ts`（新規） | `addArtifact: 成功すると events.jsonl に artifact_added が append される` | 1 行 append + artifact_id が A001 形式 + artifact_path が `.team/artifacts/` 配下 |
| T4 | `artifact.test.ts`（新規） | `addArtifact: frontmatter に task が含まれていれば task_id が emit される` | record に `task_id: "T038"` |
| T5 | `artifact.test.ts`（新規） | `addArtifact: frontmatter に task が無ければ task_id は omit される` | `"task_id" in rec === false` |

### 検証コマンド

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 events-writer.test.ts
bun test --timeout 30000 artifact.test.ts
```

`bun test` 全体実行は CLAUDE.md の禁忌（O(N²) ハング）。個別ファイル実行で確認する。

### spec の一貫性確認

- `docs/spec/10-events-stream.md` の §5 冒頭の event 種数（17）と §5.1 + §5.2 + §5.3 の合計、および §6 sub-section 末尾（6.17）が一致していること
- `schema_version = 2` のまま（bump していない）

## 5. リスク・確認事項

### リスク

| 内容 | 影響 | 緩和策 |
|------|------|--------|
| `addArtifact` が daemon 外プロセスから呼ばれた際、`process.env.PROJECT_ROOT` 未設定で events.jsonl が誤った場所に書かれる | events.jsonl の分散・観察データ欠落 | CLI 経路 (`main.ts:451`) で env が必ずセットされることを確認済み。テスト経路は `createDummyProject({ setProjectRootEnv: true })` で env を注入するため OK。それ以外から `addArtifact` を直接呼ぶ経路は現時点なし |
| 既存 daemon と CLI が同時に events.jsonl に append → torn write | reader が JSON parse 失敗 | POSIX `O_APPEND` は単一 `write()` を atomic に保証（events.jsonl の 1 record は数百バイトで PIPE_BUF 4KB 以内）。spec §8 で reader は parse 失敗 line を skip する forward-compat 設計のため致命的にならない |
| emit 失敗で `addArtifact` の戻り値に影響 | CLI 終了コード変化・ユーザーへの誤表示 | `emitEvent` は内部で try/catch して throw しない（events-writer.ts:206-222）。`addArtifact` の return path は変更不要 |
| spec §5 冒頭の event 種数が複数箇所（脚注含む）で食い違う | 仕様の信頼性低下 | Step 3 で「合計 17 event 種」に統一しつつ脚注は v2 確定経緯メモとしてそのまま残す |

### 確認事項（Implementer が着手前に確認すること）

1. `addArtifact` を呼ぶ箇所は本タスクの実装変更時点で `main.ts:6303` 経由 1 箇所のみ。テスト経由を除き他に呼び出しが追加されていないこと（`grep -rn "addArtifact("`）。
2. `events-writer.ts` の `EventStreamRecord` への variant 追加で TypeScript 型エラーが他箇所に波及しないこと（`emitEvent` を `switch (record.event)` でハンドリングしている reader は本 worktree 内にまだ存在しないが、`bun check` / `bun build` で確認）。
3. `docs/spec/10-events-stream.md` の §5 冒頭「16 event 種」を 17 に更新する際、`07-state-machine.md` / `glossary.md` / README 内で「16 event」と明記している箇所が無いか念のため grep（変更が広がるなら本 plan を更新する）。

### 範囲外（明示）

- Phase 2: task journal への追記（別タスク。本タスクで `applyTaskEvent` への配線は触らない）
- Dashboard UI の `artifact_added` 表示
- `/elevens:watch` skill での `artifact_added` 取り扱い
- `cmux-team events` CLI フィルタ default の変更
