# Task 017 impl notes — spawn-agent が別ペイン / split / 別 workspace に Agent を起動するバグの修正

## TL;DR

plan.md §2-§4 の確定方式（B 案 + C/D 二段防御 + 二重防御 `--workspace`）を実装し、TDD テスト 6 ケースを追加。cmux.test.ts 全 38 件 pass、main.test.ts 全 273 件 pass。tsc 新規エラーなし、help 文言更新済み。

## 変更内容

### 1. `skills/cmux-team/manager/cmux.ts`

#### `getPaneForSurface` を完全一致照合に置換（欠陥1）

- 旧: `line.includes(surface)` → `surface:2` が `surface:26` 等を含む行に誤マッチしていた
- 新: 各行から `surface:\d+` を全抽出し `Array.includes(surface)` で完全一致
- `listSiblingSurfaces` の照合パターンに揃え、両者の判定が常に同期するようにした
- JSDoc に「完全一致のみ・部分一致禁止」「T017 でバグ修正」を追記

#### `newSurface` シグネチャ変更（欠陥2-D + 二重防御）

- 旧: `newSurface(pane?: string): Promise<string>`
- 新: `newSurface(pane: string, opts?: { workspace?: string }): Promise<string>`
- pane が空文字 / undefined / `pane:` で始まらない場合は `pane is required` で throw
- `opts.workspace` が指定されれば c11 argv に `--workspace <ws>` を追加
- 全 caller (`main.ts:3577`) は本 PR で更新。他に呼び出し元なし（`grep -rn newSurface skills/cmux-team/manager/` で確認済み）

### 2. `skills/cmux-team/manager/main.ts`

#### `cmdSpawnAgent` (3573 付近) で targetPane fail-fast（欠陥2-C）

- `getPaneForSurface` が undefined を返したら明示的に throw
- reason に `conductor_surface` / `caller_workspace` / "pane lookup failed" を含める
- 既存の T016 catch (`main.ts:3815`) がそのまま捕捉し、`AGENT_SPAWN_FAILED` post + exit 1 経路に乗る

#### `newSurface` 呼び出しに workspace 明示

- `cmux.newSurface(targetPane, { workspace: callerWorkspace })` に変更
- callerWorkspace が undefined の場合は newSurface 内で `--workspace` を append しない

### 3. `skills/cmux-team/manager/i18n.ts`

- en `help_spawn_agent`: "Falls back to new-split right if tab creation fails" → "Fail-fast: if tab creation (pane lookup or new-surface) fails, posts AGENT_SPAWN_FAILED and exits 1 (no implicit fallback to new-split or focused pane)"
- ja `help_spawn_agent`: 同等の日本語訳に書き換え

### 4. `skills/cmux-team/manager/cmux.test.ts`

新規追加 TDD テスト（全 6 ケース、いずれも実装前は赤・実装後に緑化）:

- `getPaneForSurface prefix collision (T017)` — 3 ケース
  - `surface:2` 検索時 `surface:26` を含む行に誤マッチしない
  - `surface:27` と `surface:2` を区別
  - 1 行に複数 surface が同居しても完全一致のみ拾う
- `newSurface pane required (T017 D layer)` — 3 ケース
  - `pane=undefined` で throw
  - `pane=""` で throw
  - `pane="surface:1"` (pane: 始まりでない) で throw
- `newSurface forwards --workspace (T017 二重防御)` — 2 ケース
  - `opts.workspace` 指定時に c11 argv へ `--workspace <ws>` を渡す
  - 未指定時は `--workspace` を含めない

既存テストヘルパー `__setTreeImpl` / `writeFakeCmux` / `readFile` を踏襲し、新規 mock 機構は導入していない。

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
 38 pass
 0 fail
 62 expect() calls
Ran 38 tests across 1 file. [5.93s]
```

main.ts も変更したため main.test.ts も確認:

```
$ bun test --timeout 30000 main.test.ts
 273 pass
 0 fail
 748 expect() calls
Ran 273 tests across 1 file. [22.17s]
```

## 検証

- ✅ plan.md §6.1-6.3 の TDD テストが全 pass
- ✅ `bun test --timeout 30000 cmux.test.ts` で既存 32 件 + 新規 6 件 = 38 件全 pass
- ✅ `spawn-agent --help` の ja / en から「new-split right フォールバック」記述が消え、fail-fast 説明に書き換わっている（実 CLI 出力で確認済み）
- ✅ tsc 新規エラー無し（baseline に既存エラー 8 件あり: `c11-features.test.ts` ×2 / `c11-features.ts` ×2 / `mailbox-cli.ts` ×3 / `main.ts:1043 sleepPrevention` ×1。いずれも T017 変更箇所 (`cmux.ts` / `cmux.test.ts` / `main.ts:3577` 付近 / `i18n.ts`) とは無関係。T017 による新規エラーは 0）
- ✅ task-state grep invariant（CLAUDE.md 実装ルール）も維持（0 件）

## 残課題 / スコープ外

- `getCallerWorkspace()` が undefined を返すケースの是非は plan.md §4 でスコープ外と明記済み（別タスク）
- prefix collision の手動 e2e 再現は cmux-team-lab で別途検証する想定（plan.md §7.3）
- commit は実施せず（Conductor が完了処理で行う）
- `.team/artifacts/` への記録は実施せず（plan の作業境界）

## 変更ファイル

```
skills/cmux-team/manager/cmux.test.ts | 98 ++++++++++++++++++++++++++++++++++-
skills/cmux-team/manager/cmux.ts      | 36 +++++++++++--
skills/cmux-team/manager/i18n.ts      |  4 +-
skills/cmux-team/manager/main.ts      | 14 ++++-
4 files changed, 143 insertions(+), 9 deletions(-)
```
