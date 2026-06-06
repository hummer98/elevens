# Plan: /elevens:watch + Conductor 自動 rebase の commit drop 対策 (T028)

## 0. 概要

drop しうる 3 経路（A: Conductor Step 8 自動 rebase / B: watch.md Step 2 `--delete-branch` / C: watch.md Step 3 自動 Edit）すべてに対し、

- 経路 B: branch を残して追跡可能性を上げる（`--delete-branch` 除去）
- 経路 C: 自動衝突解消を廃止して escalate に格上げ（`git merge --abort` 経路）
- 経路 A: Step 8-1〜8-5 の semantic resolution path 全体を escalate に集約（Step 8 conflict 時は即「判断必要レポート」へ）

を適用する。en / ja 同期。post-mortem artifact (`Axxx-watch-commit-drop-postmortem.md`) を残す。

修正対象ファイル:

| # | File | 主な変更 |
|---|------|---------|
| 1 | `commands/watch.md` | Step 2 から `--delete-branch` 除去 / Step 3 を escalate 化 / 設計方針も追従 |
| 2 | `skills/cmux-team/templates/ja/conductor-role.md` | Step 8 を「conflict 検出 → 即判断必要レポート」に統合 |
| 3 | `skills/cmux-team/templates/en/conductor-role.md` | 同上の英訳同期 |
| 4 | `docs/spec/04-templates.md` | Step 8-5 / conflict-resolution.md フォーマット節の削除 or 「廃止」追記（dangling 参照防止）⚠️ 修正範囲の境界に関する判断は §2.5 に記載 |
| 5 | `.team/artifacts/Axxx-watch-commit-drop-postmortem.md` | post-mortem（`/elevens:artifact research` 経由で作成。次番号は **A034**） |

---

## 1. 現状分析

### 1.1 `commands/watch.md` の現行記述

#### Step 2（L112-121）— PR merge 試行

```text
112: #### Step 2: PR merge 試行（squash）
113:
114: ```bash
115: gh pr merge --squash --delete-branch "$PR_URL" 2>&1 | tee /tmp/cmux-team-watch-merge.txt
116: MERGE_EXIT=${PIPESTATUS[0]}
117: ```
118:
119: - `MERGE_EXIT == 0` → **Step 4（main pull）へ**
120: - `MERGE_EXIT != 0` で stderr に `conflict` / `not mergeable` を含む → **Step 3（conflict resolve）へ**
121: - それ以外の merge 失敗（...） → user に `[escalation]` で「PR merge に失敗しました。手動で確認してください」と提示
```

⇒ **修正対象**: L115 の `--delete-branch` 除去。L120 の「conflict 時は Step 3」を「conflict 時は即 escalate」に変更。

#### Step 3（L123-143）— Conflict 検出時の resolve（**廃止対象**）

```text
123: #### Step 3: Conflict 検出時の resolve
124:
125: ```bash
126: cd "$WT"
127: git fetch origin
128: git merge origin/main 2>&1 | tee /tmp/cmux-team-watch-conflictmerge.txt
129: ```
130:
131: - `git status --short` で衝突ファイルを列挙
132: - **Edit ツールで衝突マーカーを解消**する（解消ロジックは task の内容に依存するため Master が判断）
133: - 解消できないと判断したら user に `[escalation]` で衝突ファイル一覧 + journal_summary を提示して中止
134: - 解消できたら以下を実行:
135:
136:   ```bash
137:   git add -A
138:   git commit -m "Resolve conflicts with main for T<task_id>"
139:   git push
140:   gh pr merge --squash --delete-branch "$PR_URL"
141:   ```
142:
143:   それでも fail した場合は user に `[escalation]` で投げる
```

⇒ **修正対象**: ステップ全体を廃止し、conflict 検出時 escalation へ統合。`git merge --abort` を明示。

#### 設計方針節（L13）

```text
13: - **自動範囲**: `task_completed` に対する PR merge（squash + delete-branch）/ conflict resolve / main ブランチへの `git pull --ff-only` までを Master が自走する。それ以外の判断は escalate
```

⇒ **修正対象**: 「squash + delete-branch」と「conflict resolve」を方針から外す。

### 1.2 `skills/cmux-team/templates/ja/conductor-role.md` Step 8 の構造

| 節 | 役割 | 行 |
|----|------|----|
| Step 8 冒頭 | rebase target 選定 / `PRE_REBASE` 保存 / `git rebase` 実行 | 477-512 |
| 8-1 | conflict 情報収集（`ALL_CONFLICT_FILES` 積み上げ） | 514-532 |
| 8-2 | 衝突元タスク特定と仕様読み込み | 534-549 |
| 8-3 | **semantic resolution 試行**（Conductor が Edit / Write を使う唯一の例外） | 551-576 |
| 8-4 | 検証（scope_violation / bun test / tsc） | 578-621 |
| 8-5 | **成功 → conflict-resolution.md 書き出し → Step 9** | 623-627 |
| 8-6 | **escalation**（rollback + `CONDUCTOR_DONE --success false`） | 629-669 |

8-3 が「Conductor が Edit/Write してよい唯一の例外」と明記されており（L486）、本タスクの目的は **この例外そのものを廃止する** こと。

### 1.3 `skills/cmux-team/templates/en/conductor-role.md` Step 8

ja とほぼ 1:1 対応。

| 節 | 行 |
|----|------|
| Step 8 冒頭 | 431-466 |
| 8-1 | 468-486 |
| 8-2 | 488-503 |
| 8-3 | 505-529 |
| 8-4 | 531-575 |
| 8-5 | 577-581 |
| 8-6 | 583-623 |

L440 に「the only exception ... 8-3 (semantic resolution)」、L505 に「the only place where Conductor may use Edit / Write」と書かれている。これらも合わせて削除。

### 1.4 dangling 参照候補（grep 結果）

```text
docs/spec/04-templates.md:211  "Step 8 semantic resolution（T284）"  ※段落 1 つまるごと semantic resolution の説明
docs/spec/04-templates.md:215  "### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）"
docs/spec/04-templates.md:217  "Conductor は Step 8-5 で semantic resolution が成功したときに..."
docs/spec/04-templates.md:256  "`Iterations` 節は 8-3 の `git rebase --continue` ループ回数と..."
skills/cmux-team/templates/{ja,en}/conductor-role.md  8-1〜8-6 自身（修正対象）
```

8-1〜8-5 を廃止すると、`docs/spec/04-templates.md` L211（段落丸ごと）と L215-258 の「conflict-resolution.md フォーマット節」が dead spec になる。完了条件の「衝突解消経路に『自動 Edit』『自動 rebase 続行』が残っていないことを確認」に厳密に従うなら spec も touch する必要がある。判断は §2.5 参照。

### 1.5 Conductor 原則との関係

`conductor-role.md` L486（ja）/ L440（en）の「Conductor は通常コードを書かない。ただし本ステップの 8-3（semantic resolution）は唯一の例外」という記述が **本タスクの実装で完全に不要になる**。やらないこと（「やらないこと（厳守）」節 L811 / L766）の「自分でコードを書く・ファイルを編集する — Edit/Write ツールを使わない。必ず Agent に委譲する」と整合するようになる（例外節を削除することで強い禁止に戻る）。

---

## 2. 修正案（diff 単位の擬似 patch）

### 2.1 `commands/watch.md` Step 2 — `--delete-branch` 除去

#### diff（L112-121）

```diff
 #### Step 2: PR merge 試行（squash）

 ```bash
-gh pr merge --squash --delete-branch "$PR_URL" 2>&1 | tee /tmp/cmux-team-watch-merge.txt
+# branch は残す（drop 追跡可能性のため。詳細は本ファイル末尾の cleanup 方針メモを参照）
+gh pr merge --squash "$PR_URL" 2>&1 | tee /tmp/cmux-team-watch-merge.txt
 MERGE_EXIT=${PIPESTATUS[0]}
 ```

 - `MERGE_EXIT == 0` → **Step 4（main pull）へ**
-- `MERGE_EXIT != 0` で stderr に `conflict` / `not mergeable` を含む → **Step 3（conflict resolve）へ**
-- それ以外の merge 失敗（review 不足、required check 未通過、permission 不足等） → user に `[escalation]` で「PR merge に失敗しました。手動で確認してください」と提示（PR_URL と stderr 末尾を一緒に出す）。続行はしない
+- `MERGE_EXIT != 0` → user に `[escalation]` で「PR merge に失敗しました。手動で確認してください」と提示（PR_URL と stderr 末尾を一緒に出す）。conflict / not mergeable の場合は Step 3 を、それ以外の失敗（review 不足、required check 未通過、permission 不足等）はその旨を併記する。**自動の衝突解消は行わない（drop リスク回避のため）**
```

#### 設計方針節（L13）の修正

```diff
-- **自動範囲**: `task_completed` に対する PR merge（squash + delete-branch）/ conflict resolve / main ブランチへの `git pull --ff-only` までを Master が自走する。それ以外の判断は escalate
+- **自動範囲**: `task_completed` に対する PR merge（squash、branch は残す）/ main ブランチへの `git pull --ff-only` までを Master が自走する。**conflict が出た PR の自動 resolve は行わない（drop リスクを避けるため escalate に倒す）**。それ以外の判断も escalate
```

#### ファイル末尾の cleanup 方針メモ案

```markdown
## Branch cleanup 方針メモ

`gh pr merge` で `--delete-branch` を付けないため merge 後も remote/local の feature
branch が残る。これは squash merge 後でも `git log --all` / `git branch -a` で元 commit を
追跡できるようにするための意図的な選択（drop 事故の post-mortem を可能にする）。

cleanup は別タスクで運用する想定:
- 週次手動 `git branch --merged` ベースの掃除、または
- `elevens worktree archive prune` 系の整備（別タスク化）

short-term は branch が累積するので、必要なら個別に `git push origin --delete <branch>` で削除する。
```

### 2.2 `commands/watch.md` Step 3 — escalation 化

#### diff（L123-143）

```diff
-#### Step 3: Conflict 検出時の resolve
+#### Step 3: Conflict 検出時の escalation（自動 resolve は行わない）

-```bash
-cd "$WT"
-git fetch origin
-git merge origin/main 2>&1 | tee /tmp/cmux-team-watch-conflictmerge.txt
-```
-
-- `git status --short` で衝突ファイルを列挙
-- **Edit ツールで衝突マーカーを解消**する（解消ロジックは task の内容に依存するため Master が判断）
-- 解消できないと判断したら user に `[escalation]` で衝突ファイル一覧 + journal_summary を提示して中止
-- 解消できたら以下を実行:
-
-  ```bash
-  git add -A
-  git commit -m "Resolve conflicts with main for T<task_id>"
-  git push
-  gh pr merge --squash --delete-branch "$PR_URL"
-  ```
-
-  それでも fail した場合は user に `[escalation]` で投げる
+Master は **自動で衝突マーカーを解消しない**。Edit による「片方採用」で commit-level の
+変更が drop する事故を構造的に避けるため、conflict 検出時点で merge を中断して
+user に判断を委ねる。
+
+```bash
+cd "$WT"
+# merge が in-progress なら必ず中断する（衝突状態を残さない）
+if [ -f .git/MERGE_HEAD ] || [ -d "$(git rev-parse --git-dir)/rebase-merge" ] || [ -d "$(git rev-parse --git-dir)/rebase-apply" ]; then
+  git merge --abort 2>&1 || git rebase --abort 2>&1 || true
+fi
+CONFLICT_FILES=$(git status --short 2>/dev/null | grep -E '^(UU|AA|DD|AU|UA|DU|UD)' | awk '{print $NF}')
+```
+
+その上で user に以下フォーマットで escalate する（Step 2 の他 escalation と同フォーマット）:
+
+```text
+[escalation] task_completed (PR conflict — manual resolve required)
+  task_id: T<NNN>
+  pr_url: <PR_URL>
+  worktree_path: <絶対パス>
+  conflict_files:
+    - <ファイル 1>
+    - <ファイル 2>
+  journal_summary:
+    <J を多行表示>
+  → cd <絶対パス> で worktree を確認し、手動で衝突解消・push・merge してください。
+    自動 Edit はしません（drop 事故防止のため）。
+```
+
+escalate 後は **何もしない**（merge は abort 済み、worktree は温存）。続けて他 event を待つ。
```

### 2.3 `skills/cmux-team/templates/ja/conductor-role.md` Step 8 — 統合 escalate 化

**設計判断**: 8-1〜8-5 を全廃し、Step 8 を「rebase 試行 → conflict 出たら即 escalate（rollback + 判断必要レポート）」の単一節に圧縮する。8-6 の rollback / `CONDUCTOR_DONE --success false` / 構造化レポート構文は既に escalation 経路として完成されているため、それを Step 8 のメインフローに昇格させる。

#### Step 8 冒頭（L477-512）の修正

```diff
 ### Step 8: {{MAIN_BRANCH}} に rebase する（conflict は semantic に自解決する）
+ ### Step 8: {{MAIN_BRANCH}} に rebase する（conflict 時は判断必要レポートで停止する）

 commit 後、worktree 内で最新の main を取り込み、その上に自分の commit を rebase する。
 これにより main 側で conflict が surface することを防ぎ、納品時に常に fast-forward できる状態にする。

-> **Conductor 原則との関係（例外扱い）**: Conductor は通常コードを書かない。ただし本ステップの 8-3（semantic resolution）は**唯一の例外**で、conflict marker が出たファイルに限り Conductor 自身が Edit / Write を使って統合してよい。詳細は 8-3 参照。
+> **Conductor 原則の徹底**: Conductor は **conflict marker が出たファイルを含め、いかなる場合も Edit / Write を使って衝突を解消しない**。conflict が出た時点で rollback して判断必要レポートを返し、worktree を残して終了する（T028 で `semantic resolution` 経路は廃止）。
```

#### 「rebase が conflict で失敗した場合」分岐（L510-512）の差し替え

```diff
 rebase が成功した場合 → Step 9（納品）へ進む。

-rebase が conflict で失敗した場合 → **即 abort せず、以下 8-1〜8-6 のフローで semantic resolution を試みる**。
+rebase が conflict で失敗した場合 → **以下 8-1（情報収集）→ 8-2（rollback）→ 8-3（escalation）の最小フローで判断必要レポートを返して終了する**。Conductor は conflict marker を Edit / Write で書き換えない。
```

#### 新 8-1（情報収集、現 8-1 と 8-2 の最小版を統合）

```markdown
#### 8-1. conflict 情報収集（report 用、最小限）

判断必要レポートに添える情報を集める。Edit はしない。

```bash
CONFLICT_FILES=$(git diff --name-only --diff-filter=U | sort -u)
git status                                          # report 添付用
git log --oneline HEAD..ORIG_HEAD                   # 衝突元 commit 一覧
# 衝突元 task ID を抽出（commit message 末尾の (TXXX)）
CONFLICT_TASK_ID=$(git log --format=%s HEAD..ORIG_HEAD | grep -oE '\(T[0-9]+\)' | head -1 | tr -d '()T')
```

ファイルごとの diff dump は report 容量が膨らむので **付けない**。人間が worktree で `git diff` を見れば足りる。
```

#### 新 8-2（rollback、現 8-6 の rollback ブロックを昇格）

```markdown
#### 8-2. rollback

```bash
GIT_DIR=$(git rev-parse --git-dir)
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  git rebase --abort
else
  # PRE_REBASE は Step 8 冒頭で保持済み（保持は引き続き必要、変更なし）
  git reset --hard "$PRE_REBASE"
fi
```
```

#### 新 8-3（escalation、現 8-6 の通知 / レポート部分を昇格）

```markdown
#### 8-3. escalation（判断必要レポート）

完了通知を `--success false --reason "<短い日本語>"` で送信する（**reason は必須**。空だと
manager.log の `conductor_done_unresolved` に `reason=-` で残りデバッグ不能になる）:

```bash
elevens send CONDUCTOR_DONE --surface $CMUX_SURFACE \
  --success false \
  --reason "Step 8 rebase conflict: <衝突元 task ID / branch / 衝突ファイル要約>"
```

完了レポートは【判断必要】を明記し、**構造化**して以下を伝える:

- `conflict_summary`: 衝突ファイル一覧 + rebase target + 衝突元 commit の要約（task ID 含む）
- `failure_mode`: `rebase_conflict`（T028 以降の単一値。`spec_divergence` / `iteration_limit` 等は廃止）
- `required_input`: 人間に必要な判断（どのブランチをどう merge / rebase するか）
- worktree は削除せず残す（人間が手動で rebase / 再投入できるよう）
- タスク状態: `aborted` に遷移します（worktree / branch は温存）。再投入するには `elevens restart-task --task-id <TASK_ID>` を実行してください。中止したい場合はそのまま放置するか `elevens delete-task --task-id <TASK_ID>` で削除します。

**この場合 `close-task` は呼ばない。** daemon 側で task-state を `aborted` に倒し、journal に `conductor_done_unresolved` を記録します（reason=judgment_pending）。人間は `restart-task` で再投入するか判断します。
```

#### 廃止する旧節

- 旧 8-3（semantic resolution 試行）— **全削除**
- 旧 8-4（検証 (1) scope_violation / (2) bun test / (3) tsc）— **全削除**（rebase で conflict が出なければ rebase 自体は決定論的に通るので、検証 step が必要だった元々の動機は「自動解消したものを検証する」点にあり、自動解消を廃止する以上不要）
- 旧 8-5（conflict-resolution.md 書き出し）— **全削除**
- 旧 8-6（rollback + escalation）— **新 8-2 / 8-3 に昇格して統合**

#### Step 8 冒頭の `ALL_CONFLICT_FILES = ""` / `PRE_REBASE` 周り

```diff
 PRE_REBASE=$(git rev-parse HEAD)

-# 8-1 の ALL_CONFLICT_FILES スナップショット用（iteration loop で積み上げる）
-ALL_CONFLICT_FILES=""
-
 git rebase "$REBASE_TARGET"
```

`PRE_REBASE` は新 8-2 の rollback で引き続き使うので残す。`ALL_CONFLICT_FILES` / `ITERATION_LIMIT` 等の iteration 系変数は不要になるので削除。

### 2.4 `skills/cmux-team/templates/en/conductor-role.md` Step 8 — 英訳同期

ja の修正と 1:1 対応で適用する。以下に diff 抜粋（フル diff は実装時に ja を参照しつつ生成）:

#### 冒頭の例外節（L440）

```diff
-> **Relationship to the Conductor principle (exception)**: Conductor normally does not write code. However, 8-3 (semantic resolution) is the **only exception** — the Conductor itself may use Edit / Write to integrate the two sides, but only on files where conflict markers have appeared. See 8-3 for details.
+> **Conductor principle (strict)**: The Conductor must NOT use Edit / Write to resolve conflicts under any circumstance, even on files with active conflict markers. On rebase conflict, roll back and return a [Judgment Required] report, then exit with the worktree preserved (the `semantic resolution` path was removed in T028).
```

#### 分岐文（L466）

```diff
-If rebase fails due to conflicts → **do not abort immediately. Instead, follow 8-1 through 8-6 below to attempt semantic resolution.**
+If rebase fails due to conflicts → **gather minimal context (8-1), roll back (8-2), and return a [Judgment Required] report (8-3). The Conductor must not attempt semantic resolution.**
```

#### 新 8-1 / 8-2 / 8-3 の英訳

ja の対応する節をそのまま英訳する。旧 8-3 / 8-4 / 8-5（L505-581）は全削除。旧 8-6（L583-623）の rollback と send/report 部分を新 8-2 / 8-3 に統合する。

### 2.5 `docs/spec/04-templates.md` — Step 8-5 / conflict-resolution.md フォーマット節の整理

タスク本文には「修正は `commands/` と `skills/cmux-team/templates/` のみで完結する想定」と書かれている。一方で完了条件には「修正後の watch.md / conductor-role.md を読み直して、衝突解消経路に『自動 Edit』『自動 rebase 続行』が残っていないことを確認」とある。

**Planner の推奨**: `docs/spec/04-templates.md` L211（Step 8 semantic resolution 段落）と L215-258（conflict-resolution.md フォーマット節）は dead spec 化するため、**最低限「廃止（T028）」の注記を 1 行入れて節タイトルを変更する**程度の修正は加える。フル削除はしない（spec の歴史を残すため）。判断理由を §3 の post-mortem artifact に明記する（タスク本文の「もし必要だと判断したら理由を artifact に残してから着手」に従う）。

#### 修正案（diff）

```diff
-**Step 8 semantic resolution（T284）:** rebase conflict 発生時、Conductor は即 abort せず semantic 自解決を試みる。...（中略）...worktree / branch は温存する。
+**Step 8 conflict handling（T028 で semantic resolution は廃止）:** rebase conflict 発生時、Conductor は Edit / Write を使った semantic 自解決を行わず、最小情報を集めて rollback し、`failure_mode=rebase_conflict` の【判断必要】レポートを返して worktree / branch を温存して終了する。旧 T284 で導入した semantic resolution path（8-1 ALL_CONFLICT_FILES / 8-3 Edit / 8-4 scope_violation・test・tsc / 8-5 conflict-resolution.md 書き出し）は T028 で削除した。
```

```diff
-### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）
+### conflict-resolution.md フォーマット（廃止: T028）

-Conductor は Step 8-5 で semantic resolution が成功したときに、以下のフォーマットで `<OUTPUT_DIR>/conflict-resolution.md` を書き出す。...
+T028 で Step 8-5（semantic resolution 成功時）が廃止されたため、本フォーマットは現在 Conductor によって書き出されない。歴史的経緯として残す。新規実装は本節を参照しないこと。
```

> 上記が **Inspector の追加確認対象**になるので、Inspector フェーズで `04-templates.md` の dangling な記述が残っていないか改めて grep する。

---

## 3. post-mortem artifact の構成案

### 3.1 作成手段

`/elevens:artifact research` で次番号 **A034** として作成。次番号は `ls .team/artifacts/` で `A033-research-findings.md` が最新なので A034 を採用。タスク本文の指示は `Axxx-watch-commit-drop-postmortem.md` というスラグ。

```bash
elevens artifact create \
  --type research \
  --title "watch / Conductor 自動 rebase commit drop の post-mortem (T028 構造変更)"
# → .team/artifacts/A034-watch-commit-drop-postmortem.md が生成される想定
```

> ⚠️ `/elevens:artifact` skill 経由が default（CLAUDE.md の規定）。**直接 Write は避ける**。生成後に Edit で本文を埋める。

### 3.2 章立て案

```markdown
---
id: A034
type: research
title: watch / Conductor 自動 rebase commit drop の post-mortem (T028 構造変更)
created: 2026-05-27
author: surface:N
---

# 背景

prototype workspace (T181 compass-wind 99e23a6e `feat(fe/compass-wind): heading rotation 補間`) で
`/elevens:watch` の自動 PR merge と Conductor Step 8 自動 rebase が組み合わさり、commit が main から drop する事故が発生。
surface:4 / surface:11 の発言、および本リポジトリ `commands/watch.md` / `skills/cmux-team/templates/ja/conductor-role.md` Step 8 を一次資料として整理する。

# 事故の経路推定

## 経路 A — Conductor 8-3 semantic resolution（自動 Edit による drop）
- 旧 Step 8-3 で agent が conflict marker を「片方採用」で解消すると、もう片方の変更が消える
- 8-4 検証（scope_violation / bun test / tsc）は変更の "missing" を直接検知できない（テストが両側 ANDED を要求していなければ pass する）

## 経路 B — watch.md Step 2 `--delete-branch`
- `gh pr merge --squash --delete-branch` は merge 後 feature branch を remote / local とも削除
- squash で元 commit hash も main の history に残らないため、reflog（短命）か archive worktree しか追跡手段がない

## 経路 C — watch.md Step 3 自動 Edit
- Master が Edit ツールで衝突マーカーを解消する経路。LLM が片方を取り落とすと drop（A と同質）

## Manager log との対応
- `Step 9 ff-only merge failed` … rebase 自体は成功したが Step 9 で local main が ff されず escalate
- `conductor_done_unresolved` / `judgment_pending` … 旧 8-6 escalation 経路が発火していた可能性
- 該当 Manager log エントリ（worktree task-028 環境からは確認不能、別プロジェクトの surface:N の log を要参照）

## 99e23a6e の残存確認

> 本タスクの worktree は elevens repo のもので、`compass-wind` の T181 99e23a6e は **別 prototype repo** に存在する。
> elevens 内 git log では本 SHA は不在（本リポジトリの T181 は await-agent 方式への移行 `58e4e6d`）。
> 確認用コマンド案（別 repo で実行する想定）:

```bash
git fetch --all
git log --all --format=%H | grep -i 99e23a6e
# branch 残存
git branch -a --contains 99e23a6e
# origin/docs/weather-data-pipeline 上にいるか
git log origin/docs/weather-data-pipeline --format=%H | grep -i 99e23a6e
```

# 本タスクで適用した構造変更（T028）

1. `commands/watch.md` Step 2 から `--delete-branch` を除去（経路 B の追跡可能性向上）
2. `commands/watch.md` Step 3 全体を escalate 化、`git merge --abort` で中断（経路 C の自動 Edit 廃止）
3. `skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8-1〜8-5（semantic resolution）を全廃、Step 8 を「conflict → rollback → 判断必要レポート」の単一フローに圧縮（経路 A の自動 rebase 続行を廃止）
4. `docs/spec/04-templates.md` の関連節に「廃止 (T028)」注記を追加

# 残課題

- branch cleanup の運用（`--delete-branch` を外したぶん、累積 branch をどう掃除するか）
- `cmux-team archive prune` 系の整備（別タスク化候補）
- 本リポジトリ管轄外 (compass-wind を持つ prototype repo) における 99e23a6e 復旧手順の確認
- conflict-resolution.md フォーマット節を spec から完全削除するかどうかの判断（現状は歴史保存）
```

---

## 4. 作業順序とリスク

### 4.1 修正順

1. `commands/watch.md` Step 2 / Step 3 / 設計方針節 を編集（独立、副作用なし）
2. `skills/cmux-team/templates/ja/conductor-role.md` Step 8 を統合・圧縮
3. `skills/cmux-team/templates/en/conductor-role.md` Step 8 を同期（必ず ja と同時 commit で）
4. `docs/spec/04-templates.md` の L211 段落と L215-258 節に「廃止 (T028)」注記
5. post-mortem artifact 作成（`/elevens:artifact research` → 生成された A034 ファイルを Edit で埋める）
6. 自己 grep で残骸チェック（§4.3）
7. `git add -A && git commit && (PR or local ff-only merge)`

### 4.2 依存関係

| 修正 | 依存先 |
|------|--------|
| ja conductor-role | なし（独立に直せる） |
| en conductor-role | ja の修正と同じ committee で同期（人間レビュー時に両側を比べる） |
| docs/spec/04-templates.md | conductor-role.md の修正後（dangling 参照の確認のため） |
| post-mortem artifact | 上記すべて完了後（artifact 本文に「適用した構造変更」を書くため） |

### 4.3 修正後の再 grep（Inspector / Implementer 両方で確認）

```bash
# 自動 Edit / 自動 rebase 続行が残っていないか
grep -rn "Edit ツールで衝突マーカー\|自動.*衝突解消\|semantic resolution\|conflict-resolution.md\|--delete-branch\|8-5\|ITERATION_LIMIT\|ALL_CONFLICT_FILES" \
  commands/ skills/cmux-team/templates/ docs/spec/

# 出てきた箇所が以下のいずれかであることを確認:
#  (a) docs/spec/04-templates.md の「廃止 (T028)」注記そのもの
#  (b) docs/spec/16-worktree-archive.md の `--delete-branch`（こちらは別機能で残す）
# それ以外の hit は残骸なので追加修正。
```

### 4.4 リスクと緩和

| リスク | 緩和 |
|--------|------|
| docs/spec/04-templates.md を触ることでタスク本文の「`commands/` と `skills/cmux-team/templates/` のみで完結」想定から外れる | post-mortem artifact に判断理由（dangling spec 防止）を明記。fully delete ではなく注記追加にとどめる |
| `gh pr merge` から `--delete-branch` を外したことで branch が累積する | watch.md 末尾に cleanup 方針メモを追加（週次手動 / 別タスク化） |
| en / ja の同期漏れ | Implementer が両ファイルを同時に開いて diff を見ながら編集。Inspector が両側を grep して同期確認 |
| `docs/spec/16-worktree-archive.md` の `--delete-branch`（worktree archive 機能の `remove --delete-branch` フラグ）も grep で hit するが、こちらは独立した worktree archive 機能のもので **触らない** | §4.3 の grep 結果確認時に明示的に除外。Implementer に注意喚起する |
| Manager daemon TypeScript コードへの影響 | タスク本文の通り「不要なはず」。`task_completed_state_mismatch` / `conductor_done_unresolved` / `judgment_pending` 等の event は既存実装で発火するので、新規コード変更は不要。**Implementer は念のため `manager.log` 関連 grep を行い、TypeScript 変更が無用であることを確認** |
| `bun test` 全体実行禁止（CLAUDE.md） | 本タスクは template / commands / docs のみの修正で TS code を触らないため、test 全実行は不要。tsc は不要 |

### 4.5 完了条件チェックリスト

- [ ] `commands/watch.md` Step 2 から `--delete-branch` 除去 + 注記追加
- [ ] `commands/watch.md` Step 3 が escalate に格上げ済み、`git merge --abort` 経路明記
- [ ] `commands/watch.md` 設計方針節も追従更新
- [ ] `commands/watch.md` 末尾に branch cleanup 方針メモを追加
- [ ] `skills/cmux-team/templates/ja/conductor-role.md` Step 8 の 8-1〜8-5 削除、新 8-1 (info) / 8-2 (rollback) / 8-3 (escalation) に圧縮
- [ ] `skills/cmux-team/templates/en/conductor-role.md` 同期完了
- [ ] `docs/spec/04-templates.md` L211 段落 と conflict-resolution.md フォーマット節に「廃止 (T028)」注記
- [ ] `.team/artifacts/A034-watch-commit-drop-postmortem.md` 作成（`/elevens:artifact research` 経由）
- [ ] §4.3 の grep で残骸 0（除外対象を除く）
- [ ] commit / PR or local ff-only merge 完了

---

## 5. 作業境界（再掲）

- 本タスクは template / command / docs / artifact のみ。**TypeScript コード変更は不要**
- daemon プロセス再起動は不要（テンプレートは spawn-agent 起動時に展開、watch.md はその場で読まれる）
- en / ja の同期は **必ず同一コミット**で行う
