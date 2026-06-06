# タスク割り当て

## タスク内容

---
id: 015
title: SUBSTRATE_BINARY のデフォルトを cmux → c11 にする（c11 surface 上で cmux バイナリを叩く矛盾を解消）
priority: high
created_by: surface:739
created_at: 2026-05-20T08:59:44.361Z
---

## タスク
## 背景（実機で確認した障害）

KDG-lab で動いている elevens daemon の Agent spawn (surface:1011) が無言で失敗した。実機調査の結果、根本原因は **c11 surface 上で動いているのに cmux バイナリを実行している backend ミスマッチ** だった。

daemon (pid 38582) の実 env:

```
CMUX_BUNDLE_ID=com.stage11.c11                          ← c11 surface 上で起動
CMUX_BUNDLED_CLI_PATH=/Applications/c11.app/.../c11
ELEVENS_BACKEND=（未設定）
```

`skills/cmux-team/manager/cmux.ts:20`:

```ts
export const SUBSTRATE_BINARY: string = process.env.ELEVENS_BACKEND?.trim() || "cmux";
```

`ELEVENS_BACKEND` 未設定のため `SUBSTRATE_BINARY` が `"cmux"`（`/opt/homebrew/bin/cmux` = c11 とは別物の Swift 実体バイナリ）にフォールバック。c11 の `workspace:6` を cmux に問い合わせるので `cmux tree --workspace workspace:6` が失敗し、tree/send 系が断続的に壊れた。

### 矛盾の構造

`cmdStart` の `detectBackendDecision`（cmux.ts:43-66）は `CMUX_BUNDLE_ID=com.stage11.c11` を見て **c11 と auto-detect して refuse を回避する**。しかし `SUBSTRATE_BINARY` は **module load 時に `|| "cmux"` で確定したまま auto-detect 結果が反映されない**（cmux.ts:16-17 のコメント「SUBSTRATE_BINARY 自体は module load 時に確定し続ける（既存テスト互換）」）。

→ 「c11 と判定して起動を許可するが、実際にコマンドを実行するバイナリは cmux」という矛盾。c11-first を謳う v0.4.0+ の方針（CLAUDE.md / docs/seed.md Phase 3）とも食い違う。

### 観測された二次症状（参考）

- `getPaneForSurface(894)` が cmux で失敗 → `undefined` → `newSurface(undefined)` が cmux デフォルト位置に pane 作成 → Agent surface:1011 が Conductor の sibling でなく別 window に出現
- token bound 後の `cmux.send`（main.ts:3731 以降）も失敗し、claude 起動コマンドが送られず SESSION_STARTED 来ず → team.json 上 status="starting" 固着
- これらは backend ミスマッチが直れば連鎖的に解消する見込み

## やってほしいこと

`SUBSTRATE_BINARY` のデフォルトを `cmux` から `c11` にする。実装方針は 2 案あるので、テスト互換性・影響範囲を調査した上で適切な方を選んでほしい:

### 案 A（最小）: default 文字列を変える

`cmux.ts:20` を `process.env.ELEVENS_BACKEND?.trim() || "c11"` にする。cmux を使いたい場合は `ELEVENS_BACKEND=cmux` で opt-in。

### 案 B（構造的）: auto-detect 結果を SUBSTRATE_BINARY に反映

`detectBackendDecision` の判定（CMUX_BUNDLE_ID / CMUX_BUNDLED_CLI_PATH）を SUBSTRATE_BINARY 解決にも使い、「c11 surface 上なら c11、cmux surface 上なら cmux」を実体として選ぶ。module load 時定数である現状（多くのコードが前提にしている）をどう扱うかが論点。影響が大きければ案 A に倒してよい。

**方針は確定（default は c11）。** A/B の選択と、module-load-time 定数のままにするかは実装判断に委ねる。

## 影響範囲（調査の起点。網羅性は実装側で担保）

- `cmux.ts:20`（本体）、`cmux.ts:13` のコメント（「未設定で cmux」の記述を更新）
- `SUBSTRATE_BINARY` / `IS_C11_BACKEND` の参照箇所: `c11-features.ts`, `e2e.ts`, `cmux.ts` 自身など
- テスト: `SUBSTRATE_BINARY` / `ELEVENS_BACKEND` を前提にした test が 4 ファイル。default 変更で cmux 前提のアサーションが壊れる可能性 → 各 test が backend 非依存になるよう `ELEVENS_BACKEND` を明示注入する形に直すか検討
- docs: `docs/spec/05-install-and-infrastructure.md` などの backend 既定値の記述、CLAUDE.md / docs/seed.md の Phase 3 記述との整合

## 完了条件

- `ELEVENS_BACKEND` 未設定時に c11 が選択される
- `ELEVENS_BACKEND=cmux` で従来通り cmux に opt-in できる（後方互換）
- 既存テスト pass（cmux 前提テストは backend 明示注入などで修正）
- docs / コメントの「未設定で cmux」記述を更新

## 触らない / 注意

- `cmdStart` の `detectBackendDecision` の refuse ロジック自体は変えない（c11-first の意図は維持）
- `bun test` 全体実行は禁忌（CLAUDE.md 既知の注意点参照）。`cd skills/cmux-team/manager && for f in *.test.ts ...` の個別実行で

## 補足: 別途検討の余地（本タスク範囲外）

backend が正しくても multiplexer 障害時の防御として以下の弱点が残る（今回は起票しないが記録）:
- `cmux.send` に timeout が無い（cmux.ts:173、tree は 5s だが send は無制限）
- spawn-agent CLI の cmux 操作失敗が daemon に通知されず silent fail する
- `getPaneForSurface` が undefined を返すと別 window に迷子 pane が作られる


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-015-1779267584` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-015-1779267584
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-015-1779267584/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/015-substrate-binary-cmux-c11-c11-surface-cmux/runs/task-015-1779267584
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/015-substrate-binary-cmux-c11-c11-surface-cmux/runs/task-015-1779267584/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


