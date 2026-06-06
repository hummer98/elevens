# タスク割り当て

## タスク内容

---
id: 016
title: cmux backend を完全削除し c11 専用化する（フォールバック排除 / 前提が崩れたら fail-fast）
priority: high
run_after_all: true
exclusive: true
depends_on: [015]
created_by: surface:739
created_at: 2026-05-20T19:48:44.826Z
---

## タスク
## 方針（ユーザー決定）

**elevens は c11 前提のアプリケーション。** cmux backend へのフォールバックが存在すること自体が誤り。フォールバックで無理やり動かすのをやめ、前提（c11 substrate）が解決できない／崩れたら **明示的にエラー（fail-fast）** にする。「正しくエラーにならないと対処できない」。

実機障害（KDG-lab）の根本原因がこれ: c11 surface 上（`CMUX_BUNDLE_ID=com.stage11.c11`）で動いているのに `ELEVENS_BACKEND` 未設定で `SUBSTRATE_BINARY = ELEVENS_BACKEND || "cmux"` が cmux にフォールバックし、c11 の workspace を cmux バイナリに問い合わせて tree/send が壊れ、Agent spawn が無言で失敗した。`detectBackendDecision` は c11 と auto-detect して起動を許可するのに、実行バイナリ解決は cmux にフォールバックする — 設計意図と実装の乖離。

> **本タスクは T015（depends-on）の後に走る。** T015 は「default を c11 に / cmux opt-in 後方互換を維持」だが、本タスクはその opt-in 維持を**ひっくり返して cmux サポートを完全削除**する。T015 の成果（default c11 化）を土台に、cmux 分岐そのものを除去する。

## 重要な区別（誤削除防止 — 必ず守る）

**削除するのは「cmux バイナリ実行 / cmux backend 分岐 / フォールバック」であり、「`CMUX_` という名前の env や `cmux.ts` というファイル名」ではない。**

c11 substrate は cmux 互換インターフェースを提供しており、`CMUX_BUNDLE_ID` / `CMUX_SURFACE` / `CMUX_SOCKET_PATH` / `CMUX_BUNDLED_CLI_PATH` 等の `CMUX_` prefix env は **c11 自身が設定する c11 側の env**。これらを読むのは正当であり削除してはならない。`skills/cmux-team/` ディレクトリ名・`cmux.ts` ファイル名・`CMUX_*` env 参照はリネーム／削除対象外（歴史的経緯の内部名）。

着手前に `skills/c11/SKILL.md` を Read し、c11 が提供する env / CLI 互換性を確認すること（CLAUDE.md 指示）。

## A. backend レベルの削除（cmux.ts）

1. `cmux.ts:20` `SUBSTRATE_BINARY = ELEVENS_BACKEND || "cmux"` のフォールバックを撤去。c11 substrate のバイナリパスに固定解決する。解決元の優先順位（実装判断）:
   - `CMUX_BUNDLED_CLI_PATH`（c11 が設定する c11 バイナリ実体パス）を一次ソースにする
   - フォールバックで `"cmux"` を使うことは禁止。c11 バイナリが解決できなければ後述の通り起動エラー
   - カスタム c11 パス差し替え需要（絶対パス）を残すかは実装判断。残す場合も「c11 系のみ」許可し cmux は不可
2. `detectBackendDecision`（cmux.ts:42-69）の `explicit` escape hatch（`ELEVENS_BACKEND` 明示で任意 backend を通す経路、line 43-46）を削除。判定は「c11 と確定できる → 起動許可 / できない → refuse」の二択に単純化
3. auto-detect で c11 と確定した結果を **実行バイナリ解決に反映**する（現状 `SUBSTRATE_BINARY` が env のみで決まり auto-detect と独立な矛盾を解消）。c11 を解決できなければ `cmdStart` で **exit 1（fail-fast）**
4. `IS_C11_BACKEND`（cmux.ts:76-77）分岐の除去。常に c11 前提なので分岐不要 → c11 動作に一本化（`--no-layout` 等 c11-only flag は常時付与する側に倒す）
5. `maybeLogDeprecationNotice`（cmux.ts:97-109）と `__resetDeprecationNoticeForTest` を削除（cmux 容認 warn が不要に）
6. `ELEVENS_BACKEND` env の扱い: cmux を選べないようにする。env 自体を廃止するか、c11 系パス差し替え専用に再定義するかは実装判断（ただし cmux への逃げ道は塞ぐ）

## B. 操作レベルの fail-fast 化（前提が崩れたらエラー）

7. `main.ts:3582-3586` `newSurface()` 失敗 → `newSplit("right")` フォールバックを撤去。pane 解決失敗は spawn-agent を**エラーで停止**し、daemon に失敗を通知する（下記 C と統合）
8. `cmux.ts:271-285` `getPaneForSurface` が tree 失敗時に `undefined` を返して握り潰す挙動を見直し。tree 失敗（substrate 不通）は **throw** して呼び出し側にエラー伝播。「surface が単に見つからない」と「substrate コマンド自体が失敗」を区別し、後者は fail-fast
9. `layout-restore.ts:96-101` tree degrade（`liveSurfaces === null`）時の `pid_only` 保守継続を見直し。substrate 不通での復元続行をやめ、起動を中断/エラーにする。**ただし** 起動直後の一時的 tree 失敗で過度に脆くしないよう、リトライ有無は実装判断（substrate が恒常的に不通なら fail-fast、が原則）

## C. spawn-agent の silent fail 解消（observatory 原則）

10. `cmdSpawnAgent`（main.ts:3435-）のトップレベルで cmux 操作失敗を捕捉し、**daemon に失敗を通知**（`AGENT_SPAWN_FAILED` 的な POST、または manager.log への明示エラー記録）してから非ゼロ exit。現状は token bound 後の `cmux.send`（main.ts:3731 以降）失敗が CLI プロセスの stderr 止まりで daemon に残らず「何のエラーも返さず終了」になる。失敗を観測可能にする

11. `cmux.send`（cmux.ts:165-174）に timeout を付与（現状 timeout 指定なし。tree は 5s だが send は無制限で multiplexer hang 時に固まる）。hang を fail-fast に倒す

## D. 影響範囲（調査の起点。網羅は実装側で担保）

- `cmux.ts`（本体・コメント）、`c11-features.ts`、`e2e.ts`、`main.ts`、`layout-restore.ts`、`daemon.ts`
- `IS_C11_BACKEND` / `SUBSTRATE_BINARY` / `ELEVENS_BACKEND` / `detectBackendDecision` / `maybeLogDeprecationNotice` の全参照箇所
- テスト: `SUBSTRATE_BINARY` / `ELEVENS_BACKEND` / `detectBackendDecision` / deprecation を前提にした test（cmux 前提アサーションは c11 前提に書き換え or 削除）
- docs: `docs/spec/05-install-and-infrastructure.md`、`docs/seed.md`（Phase 3 / cmux deprecation 記述）、`CLAUDE.md`、`README.md` / `README.ja.md` の backend 記述を c11 専用に更新

## 完了条件

- c11 を解決できない環境で `elevens start` が **明示エラーで exit**（無言フォールバックしない）
- cmux バイナリを実行する経路が存在しない（grep で `"cmux"` リテラル実行が無いこと）
- `ELEVENS_BACKEND=cmux` で cmux に逃げられない
- 操作レベル（#7-9）が substrate 不通時に握り潰さずエラー化
- spawn-agent の失敗が daemon に観測される（#10）/ `cmux.send` に timeout（#11）
- 既存テスト pass（cmux 前提テストは c11 前提に修正）
- docs / コメントの cmux backend 記述を一掃

## 注意

- `bun test` 全体実行は禁忌（CLAUDE.md 既知の注意点）。個別実行で
- `CMUX_*` env / `cmux.ts` / `skills/cmux-team/` のリネームはしない（上記「重要な区別」参照）
- これは CLI インターフェース安定方針（CLAUDE.md）の例外。ユーザー明示の方針転換


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-016-1779306524` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-016-1779306524
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-016-1779306524/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/016-cmux-backend-c11-fail-fast/runs/task-016-1779306524
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/016-cmux-backend-c11-fail-fast/runs/task-016-1779306524/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


