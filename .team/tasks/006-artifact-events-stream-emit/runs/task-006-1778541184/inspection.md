# Inspection: T006 artifact 追加を events stream に emit する (Phase 1)

- Worktree: `/Users/yamamoto/git/elevens/.worktrees/task-006-1778541184`
- Inspector surface: `surface:265`
- 検品基準: `runs/task-006-1778541184/plan.md`

## 1. 変更ファイル一覧

```
docs/spec/10-events-stream.md                  | 25 +++++++++++++++---
docs/spec/glossary.md                          |  2 +-
package-lock.json                              |  4 +--
skills/cmux-team/manager/artifact.ts           | 11 ++++++++
skills/cmux-team/manager/events-writer.test.ts | 36 ++++++++++++++++++++++++++
skills/cmux-team/manager/events-writer.ts      | 12 +++++++++
skills/cmux-team/manager/artifact.test.ts      | (新規 / 147 行)
```

> 注: `main` と `HEAD` (8edf828) は同一コミット。本タスクの変更は全て working tree に未コミットの状態（worktree 内）。Conductor が commit していない可能性があるが、Inspector は内容検品のみ実施。

## 2. plan.md スコープ遵守の確認

### Step 1: `EventStreamRecord` union に `artifact_added` variant 追加 — ✅

`events-writer.ts:150-160` に union 末尾 variant として追加。`artifact_id` / `artifact_path` / `artifact_type` / `title` / `author` は required、`task_id` のみ optional。plan の field 表と完全一致。`schema_version` bump 無し（add-only ルール遵守）。

既存 variant (`api_error_received` / `mailbox_changed`) と同じ「Why / schema_version bump 無し」の 3 行コメントが付与されており、コード規約と整合している。

### Step 2: `addArtifact()` の末尾で `emitEvent` を呼ぶ — ✅

`artifact.ts:235-243` に追加。配置は plan の指示通り「`unlink` try/catch 直後・`return` 直前」。

- import 行 (`artifact.ts:7`) も追加済み
- `artifact_path` は `join(".team/artifacts", destFileName)` で **projectRoot 相対** （絶対パスではない）
- `task_id` は `...(meta.task ? { task_id: meta.task } : {})` で frontmatter `task:` 無し時に omit される
- emit は `await` されるが `emitEvent` 自体が内部 try/catch で吸収するため throw 経路は発生しない → `addArtifact` の戻り値・throw 挙動は変化していない（best-effort 性質維持）

軽微な気付き: `artifact_type: meta.type ?? "research"` / `title: meta.title ?? ""` / `author: meta.author ?? defaultAuthor` と防御的 fallback を入れている。plan の「meta.X をそのまま使う」よりやや厚いが、`meta` を組み立てる側 (181-208 行) で既に default を入れているので実害なし。挙動に影響無し。

### Step 3: `docs/spec/10-events-stream.md` の更新 — ✅（小さな指摘 1 件）

3 箇所いずれも修正済み:
1. §2 `writer` 行: 「Manager daemon および `cmux-team artifacts add` CLI」へ更新（10-events-stream.md:48）
2. §3 `event` field 説明 / §5 冒頭 / 合計種数: 16 → 17（10-events-stream.md:63, 92）
3. §5.3 Artifact lifecycle 表 1 行追加（10-events-stream.md:122-126）
4. §6.17 `artifact_added` 詳細表追加（10-events-stream.md:303-315）

§6 sub-section 番号は 6.1〜6.17 まで連続している（既存 6.1〜6.16 を維持し、新規 6.17 を末尾追加）。

§5 種数（17）= §5.1 (8) + §5.2 (8) + §5.3 (1) = 17 で整合。

plan 指示通り **§5 直下の脚注「v2 schema 確定版に列挙されている event は本節の 16 種である」はそのまま残置**。Phase 1 完了で実体は 17 種に整列したため脚注内容は経緯メモとしてやや古びるが、これは plan §2.5 注で「触らない」と明記されている範囲なので OK。

**📝 軽微な指摘**: `docs/spec/00-project-overview.md:157` に「schema v2、16 event 種、T357」という description が残っており、§5 ヘッダー（17 種）と不一致。plan §2.5 の事前確認リストには `00-project-overview.md` は含まれていないため厳密にはスコープ外だが、観察箱としての spec 一貫性のために併せて更新するのが望ましい。NOGO 判定にはしないが follow-up として記載しておく。

### Step 4: writer round-trip テスト (T1/T2) — ✅

`events-writer.test.ts:219-251` に追加:
- T1 `artifact_added: 全 field が round-trip する`: 7 field 全てを emit→readback で一致確認
- T2 `task_id 省略時は record に含まれない`: `"task_id" in rec === false` を assert

既存 `api_error_received` テスト直後への追加で、ファイル内の配置 / 流儀（`readJsonl()` + `JSON.parse`）も既存と統一。

### Step 5: `addArtifact` events 連携テスト (T3/T4/T5) — ✅

`artifact.test.ts` 新規作成（147 行）:
- T3 (40-64 行): plain memo → `events.jsonl` に `artifact_added` 1 行 append、`artifact_id` が `A001` 形式、`artifact_path` が `^\.team/artifacts/A001-.*\.md$` にマッチ
- T4 (66-87 行): frontmatter `task: T038` 入り → record に `task_id: "T038"`
- T5 (89-104 行): frontmatter `task:` 無し → `"task_id" in rec === false`

加えて plan §3 Step 5 末尾の「sanity test も最小限同居」推奨に従い、`parseArtifactMeta` / `validateArtifact` / `nextArtifactId` の pure helper test を 3 つ追加 (107-146 行)。本タスクで導入した新規ファイルだけに含まれ、別ファイルの既存 test を弄っていない。

## 3. テスト実行結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 events-writer.test.ts
 22 pass / 0 fail / 164 expect() calls — [79.00ms]

$ cd skills/cmux-team/manager && bun test --timeout 30000 artifact.test.ts
 6 pass / 0 fail / 19 expect() calls — [30.00ms]
```

events-writer 既存 20 テストも全 pass（regression 無し）。

## 4. TypeScript 型エラー確認

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "(artifact|events-writer)"
(空 — 触ったファイル周辺にエラーなし)
```

`tsc --noEmit` 全体では `c11-features.test.ts` / `c11-features.ts` / `mailbox-cli.ts` / `main.ts` 等に既存エラーが残っているが、いずれも `artifact.ts` / `events-writer.ts` / 2 つの test ファイルとは無関係（main にも存在する pre-existing error）。本タスクでエラーを **増やしていない**。

## 5. 範囲外変更チェック

| 範囲 | 触ったか | 評価 |
|------|---------|------|
| Phase 2: task journal (`applyTaskEvent`) 配線 | 触っていない | ✅ |
| Dashboard UI で `artifact_added` を表示 | 触っていない | ✅ |
| `/elevens:watch` skill での artifact_added 取り扱い | 触っていない | ✅ |
| `cmux-team events` CLI filter default 変更 | 触っていない | ✅ |
| `addArtifact` の戻り値型変更 | 不変 | ✅ |

`grep -rn "addArtifact("` 経路についても新規 caller 追加なし。

### `package-lock.json` の差分について

`package-lock.json` が `0.4.1 → 0.5.0` に変化しているが、これは `package.json` (main で既に 0.5.0) と lockfile の不整合が `bun install` 等で解消された自動同期。plan に明記された変更ではないが、実装者が手動で書いた変更ではなく工具による生成物。**実害なし**だが、コミット時には diff として残るので注意。

### `docs/spec/glossary.md` の追加変更について

plan §2.5 確認事項 #3 は「事前 grep」止まりで明示的な更新指示は無いが、`glossary.md` の events stream エントリで「16 event 種」が残っていたものを「17 event 種」に修正している。観察箱としての spec 内部整合を保つ最小限の追加更新であり、スコープ外とは判定しない。

## 6. コード品質チェック

| 観点 | 結果 |
|------|------|
| emit が `addArtifact` の戻り値・throw 挙動を変えていないか（best-effort か） | ✅ `emitEvent` 内 try/catch で吸収。`addArtifact` の return は不変 |
| `task_id` optional 扱いが plan 通り | ✅ `frontmatter task:` 無しなら spread で omit |
| `artifact_path` が projectRoot 相対 | ✅ `join(".team/artifacts", destFileName)` で `.team/artifacts/...` 形式 |
| §5 冒頭の event 種数 == §5.1+§5.2+§5.3 合計 | ✅ 17 = 8+8+1 |
| §6 sub-section 番号連続 | ✅ 6.1〜6.17 連番 |
| `schema_version` bump | ✅ 2 のまま（add-only） |
| 不要なコメント追加 | ✅ 既存 variant (`api_error_received` / `mailbox_changed`) と同等の Why コメントのみ |

## 7. CLAUDE.md ルール遵守

- ✅ `.team/tasks/` への直接書き込み無し
- ✅ hook bypass 無し
- ✅ `bus.emit` / `bus.on` 直接呼び出し無し（`emitEvent` 経由のみ）
- ✅ `task-state` の直接書き換え無し
- ✅ 空の `catch {}` 無し

## 8. 結論 / Follow-up

- **必須対応なし**: plan で要求された Step 1〜5 は全て遂行され、テストも tsc も pass。
- **任意 follow-up**（NOGO 条件ではない）:
  1. `docs/spec/00-project-overview.md:157` の events-stream description を「17 event 種」に同期しておくと spec 内部整合が完全になる（別タスク化でも可）。
  2. `package-lock.json` の自動同期分はコミット時にメッセージで触れておくと履歴が読みやすい。

## 判定: GO
