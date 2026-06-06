# Task 017 検品結果（Inspector）

## 判定: **GO**

plan.md §2-§5 で定義された確定方式（B 案 + C/D 二段防御 + 二重防御 `--workspace`）が全て実装されており、TDD テストは「修正前赤・修正後緑」になる設計で実バグを capture できる。cmux.test.ts (38/38) / main.test.ts (273/273) 全 pass、新規 tsc エラー 0、help 文言更新済み、スコープ逸脱なし、CLAUDE.md 実装ルール違反なし。

minor 1 件（impl-notes の tsc baseline 件数記述）は機能影響ゼロのため GO 内で許容するが、後段「Minor 指摘」に記載。

---

## 検品観点別の検証結果

### 1. plan.md §2-§5 の実装網羅

`git diff` を 4 ファイル全件読んで plan.md §2-§5 の pseudo-diff と突き合わせ:

| 観点 | 確認結果 |
|---|---|
| **欠陥1（cmux.ts:298-309 `getPaneForSurface`）** | `line.includes(surface)` 削除済み。`line.match(/surface:\d+/g)` → `surfaceMatches.includes(surface)` で完全一致照合化。`listSiblingSurfaces` と同パターン。pseudo-diff と一致 ✅ |
| **欠陥2-C（main.ts:3580-3585）** | `if (!targetPane) throw new Error(...)`。reason に `conductor_surface` / `caller_workspace` / "pane lookup failed" / "refusing to fall back to focused pane" を含む。pseudo-diff と一致 ✅ |
| **欠陥2-D（cmux.ts:167-182 `newSurface`）** | シグネチャ `newSurface(pane: string, opts?: { workspace?: string })` に変更。`!pane.startsWith("pane:")` で throw（message: `pane is required`）。pseudo-diff と一致 ✅ |
| **二重防御（main.ts:3589 / cmux.ts:175）** | `cmux.newSurface(targetPane, { workspace: callerWorkspace })` の引き渡し済み。`newSurface` 内では `opts?.workspace` が真値のときのみ `--workspace <ws>` を args に append（undefined 時は付かない）。pseudo-diff と一致 ✅ |
| **i18n.ts（en:252, ja:1336）** | en: "Fail-fast: if tab creation (pane lookup or new-surface) fails, posts AGENT_SPAWN_FAILED and exits 1 (no implicit fallback to new-split or focused pane)" / ja: "Fail-fast: タブ作成（pane lookup または new-surface）が失敗した場合は AGENT_SPAWN_FAILED を post して exit 1 します（new-split / focused pane への暗黙フォールバックはしません）"。pseudo-diff の要件「AGENT_SPAWN_FAILED post + exit 1 / fail-fast / fallback しない」を満たす ✅ |
| **JSDoc 更新（cmux.ts:154-166, 287-297）** | `newSurface` / `getPaneForSurface` の JSDoc に T017 改修内容と理由を追記。plan §5-#4 と一致 ✅ |

T016 既存 catch (`main.ts:3826-3854`) との整合も確認。`createdSurface` が undefined のまま catch に流入するケースで `failMsg.surface` を omit する分岐が既に存在し、本タスク追加の throw（pane lookup 失敗）でも正しく機能する。

### 2. テスト品質

`git diff skills/cmux-team/manager/cmux.test.ts` で全 6 件の新規テストを精査:

| テスト | 「形だけ」でないか | 評価 |
|---|---|---|
| `surface:2 検索時 surface:26 を含む行に誤マッチしない` | pre-fix `line.includes("surface:2")` は `surface:26` を含む行で true を返し pane:1 を誤返却、post-fix は完全一致で pane:2 を返す。**バグを直接 capture** | ✅ |
| `surface:27 も surface:2 と区別される` | pre-fix では `getPaneForSurface("surface:2")` が pane:9 を返してしまう（誤）— post-fix で pane:10。**バグを直接 capture** | ✅ |
| `1 行に複数 surface が同居しても完全一致のみ拾う` | この設定では pre-fix でも pane:5 を返すため差別化力は弱いが、新実装の同行同居パース（`surface:\d+/g` グローバル抽出）が機能することの positive case として有効 | △（弱いが許容） |
| `pane=undefined → throw` | 旧シグネチャ `newSurface(pane?: string)` では throw されず c11 に走り別経路を呼んでしまうため、ガードの存在を実機で検証 | ✅ |
| `pane='' → throw` | 同上、空文字でも throw されることを保証 | ✅ |
| `pane が 'pane:' で始まらない → throw` | `surface:1` 渡し時にも throw、validation strict 化を保証 | ✅ |
| `opts.workspace 指定時 c11 argv に --workspace <ws>` | fake c11 binary の argv tee で実 c11 invocation を検証。argv に `--workspace workspace:42` 含むこと確認 | ✅ |
| `opts.workspace 未指定時は --workspace を含めない` | undefined 時に args に append されない defensive 取り扱いを保証 | ✅ |

ヘルパー利用も既存パターンに準拠（`__setTreeImpl` / `writeFakeCmux` / `readFile`）。新規 mock 機構の導入なし。

**TDD 整合性の裏取り（修正コードを stash した状態で新テストを実行）:**
```
$ git stash -- skills/cmux-team/manager/cmux.ts skills/cmux-team/manager/i18n.ts skills/cmux-team/manager/main.ts
$ cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
 32 pass
 6 fail
```
新規 6 件のうち全てが **修正前は赤・修正後は緑** に転じることを実機で確認 ✅。形だけのテストではない。

### 3. テスト実行（裏取り）

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts
 38 pass
 0 fail
 62 expect() calls
Ran 38 tests across 1 file. [6.57s]

$ bun test --timeout 30000 main.test.ts
 273 pass
 0 fail
 748 expect() calls
Ran 273 tests across 1 file. [22.26s]
```
impl-notes 主張と一致。`bun test` 全体実行は CLAUDE.md 既知の注意点 (13 分ハング) に従って行わず ✅。

### 4. tsc 新規エラー

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
c11-features.test.ts(138,14): error TS2722
c11-features.test.ts(180,20): error TS2322
c11-features.ts(268,22): error TS2345
c11-features.ts(276,49): error TS2322
mailbox-cli.ts(29,9): error TS18048
mailbox-cli.ts(30,20): error TS18048
mailbox-cli.ts(44,23): error TS2345
main.ts(1043,7): error TS2322
```
**main 比較を実施**（`git stash` で T017 変更を退避して同じ tsc 実行）し、エラー集合が完全に一致することを確認。**本タスクが追加した新規 tsc エラーは 0** ✅。

ただし impl-notes は「baseline 既存エラー は main.ts:1043 sleepPrevention の 1 件のみ」と書いているが、実際には 8 件（c11-features.test.ts / c11-features.ts / mailbox-cli.ts / main.ts の合計）が baseline で存在する。**いずれも T017 変更箇所 (cmux.ts / cmux.test.ts / main.ts:3577 付近 / i18n.ts) とは無関係**のため機能影響はないが、impl-notes の記述は不正確。

### 5. help 整合

```
$ /Users/yamamoto/git/elevens/.worktrees/task-017-1779480085/bin/elevens spawn-agent --help
  - Fail-fast: タブ作成（pane lookup または new-surface）が失敗した場合は AGENT_SPAWN_FAILED を post して exit 1 します（new-split / focused pane への暗黙フォールバックはしません）

$ LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 /Users/yamamoto/git/elevens/.worktrees/task-017-1779480085/bin/elevens spawn-agent --help
  - Fail-fast: if tab creation (pane lookup or new-surface) fails, posts AGENT_SPAWN_FAILED and exits 1 (no implicit fallback to new-split or focused pane)
```
en / ja 両方で「new-split right フォールバック」「Falls back to new-split right」が消え、fail-fast 説明に書き換わっていることを実機 CLI で確認 ✅。i18n.ts ソース側にも grep で stale 文字列がないことを確認 (`grep -n "Falls back to new-split\|new-split right\|タブ作成に失敗" → no matches`)。

### 6. スコープ逸脱・退行リスク

| 観点 | 結果 |
|---|---|
| plan スコープ外の変更（getCallerWorkspace 改修等）混入 | `getCallerWorkspace` の実装 (cmux.ts:439) は無変更。呼び出し側 (main.ts:1453 / 1465 / 3574 / 4125) のうち 3574 のみ T017 で `callerWorkspace` を `newSurface` の opts に渡す変更を入れている。getCallerWorkspace の undefined 取扱い改修 (plan §4 で別タスクと明記) は手付かず ✅ |
| `newSurface` シグネチャ変更で他 caller が壊れていないか | `grep -rn newSurface skills/cmux-team/manager/` で実 caller は `main.ts:3589` の 1 箇所のみ（他は comment / test / docstring）。本 PR で全更新済み ✅ |
| CLAUDE.md 実装ルール準拠 | (a) `tree(workspace)` で workspace 引数を明示 ✅、(b) 空 catch `{}` の新規追加なし ✅、(c) EventBus / task-state / hook 改変なし（本タスクと無関係） ✅ |
| `bun test` 全体実行禁忌 | 検品中もファイル単位実行に限定 ✅ |
| spawn-agent 失敗率変化リスク | plan §8.2 想定通り、これまで silent に間違った pane に立っていたケースが顕在化される（観察箱原則上望ましい）。挙動変化は documented |

---

## Minor 指摘（GO 内、後続改善が望ましい）

| # | ファイル / 観点 | 内容 | 修正の必要性 |
|---|---|---|---|
| M1 | `impl-notes.md` L87 | 「baseline で既に存在する `main.ts:1043 sleepPrevention` の 1 件のみ」の記述は不正確。実際には c11-features / mailbox-cli / main.ts(1043) の合計 8 件が baseline に存在する。いずれも T017 変更箇所とは無関係のため機能影響なし。後段のレビュアー混乱回避のため記述を補正できると望ましい | 任意（次回 docs/spec 更新時にあわせて修正で可） |
| M2 | `cmux.test.ts` 「1 行に複数 surface が同居しても完全一致のみ拾う」 | このケースは pre-fix の `line.includes("surface:2")` でも pane:5 を返す（surface:2 が当該行に実在するため）。pre/post の差別化力は弱い。バグ捕捉は test1/test2 が担っているため致命ではないが、本テストは「`surface:26` と `surface:2` が同行同居して `getPaneForSurface("surface:2")` が **誤って `surface:26` 側にマッチして別 pane を返す**」配置（例えば隣接 pane に target がある）に書き換えると pre-fix 赤化テストとして強化できる | 任意（minor improvement） |

これらは GO の妨げではない。M1 は impl-notes の事実記述精度の話、M2 はテストの差別化力の改善余地。

---

## 完了条件チェック（plan.md §「完了条件」）

| # | 条件 | 結果 |
|---|---|---|
| 1 | §6.1-6.3 の TDD テストが全て pass | ✅ 38/38 |
| 2 | `bun test --timeout 30000 cmux.test.ts` で既存テスト含め全 pass | ✅ |
| 3 | `spawn-agent --help` ja/en から "new-split right フォールバック" 記述が消えている | ✅ en/ja 両方で実機確認 |
| 4 | T016 fail-fast 経路 (AGENT_SPAWN_FAILED post + slot cleanup) が新 throw に対しても正しく動く | ✅ catch (`main.ts:3826-3854`) は `createdSurface` undefined 分岐済み、新 throw も同経路に乗る |
| 5 | pseudo-diff が `cmux.ts` / `main.ts` / `i18n.ts` / `cmux.test.ts` に反映されている | ✅ 4 ファイル全件確認 |

すべての完了条件を満たす。**GO**。
