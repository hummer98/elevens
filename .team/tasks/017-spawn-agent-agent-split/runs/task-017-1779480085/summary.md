# Task 017 結果サマリー: spawn-agent が別ペイン / split / 別 workspace に Agent を起動するバグの修正

## 概要

`elevens spawn-agent` 実行時、本来 Conductor 所属ペイン内に**追加タブ**として開かれるべき Agent が、条件次第で**別ペイン / split / 別 workspace** に起動してしまうバグを修正した。原因は独立した 2 つの欠陥の合成。

## 修正内容

### 欠陥1: getPaneForSurface の部分文字列マッチ（prefix 衝突）
`skills/cmux-team/manager/cmux.ts` の `getPaneForSurface` で `line.includes(surface)` を使っていたため、`surface:2` 検索時に `surface:26` 等を含む行へ誤マッチし間違った pane を返していた。各行から `surface:\d+` を全抽出して `=== surface` で完全一致する方式へ置換（`listSiblingSurfaces` と同じ照合パターンに対称化）。JSDoc に「完全一致のみ・部分一致禁止」を追記。

### 欠陥2: targetPane=undefined 時のフォールバック起動
- **欠陥2-C（main.ts cmdSpawnAgent）**: `getPaneForSurface` が undefined を返したとき、`newSurface(undefined)` に到達する前に明示的に throw。reason に `conductor_surface` / `caller_workspace` / "pane lookup failed" / "refusing to fall back to focused pane" を含める。既存の T016 catch が `AGENT_SPAWN_FAILED` post + exit 1 経路に乗せる。
- **欠陥2-D（cmux.ts newSurface）**: シグネチャを `newSurface(pane: string, opts?: { workspace?: string })` に変更し pane 必須化（空 / `pane:` 始まりでなければ throw）。
- **二重防御**: `newSurface(targetPane, { workspace: callerWorkspace })` で `--workspace` を明示渡し（undefined 時は付けない）。focused workspace への暗黙フォールバックを物理的に塞ぐ。

### ドキュメント整合
`skills/cmux-team/manager/i18n.ts` の `help_spawn_agent`（en / ja 両方）から「new-split right にフォールバック」記述を削除し、fail-fast（AGENT_SPAWN_FAILED post + exit 1、暗黙フォールバックなし）の説明に書き換え。

## 変更ファイル

```
skills/cmux-team/manager/cmux.test.ts | 104 +++++  (TDD 回帰テスト 6 ケース追加)
skills/cmux-team/manager/cmux.ts      |  36 ++++   (getPaneForSurface 完全一致化 / newSurface pane 必須化 + --workspace)
skills/cmux-team/manager/i18n.ts      |   4 +-    (help_spawn_agent en/ja 文言)
skills/cmux-team/manager/main.ts      |  14 +++   (cmdSpawnAgent targetPane fail-fast + workspace 明示)
4 files changed, 149 insertions(+), 9 deletions(-)
```

## テスト結果

- `cmux.test.ts`: **38 pass / 0 fail**（既存 32 + 新規 6）
- `main.test.ts`: **273 pass / 0 fail**
- 新規 6 ケースは TDD で先に書き、production code を `git stash` で退避した状態で全件赤・修正後に緑になることを実機検証（Inspector / minor 修正の両方で裏取り）
- tsc 新規エラー 0（baseline 8 件はいずれも T017 変更箇所と無関係）
- `spawn-agent --help`（en / ja）から「new-split right フォールバック」記述が消えたことを実機 CLI で確認

## フロー

中規模フロー（Plan → Impl → Inspection）で実行。
- Phase 1 Plan: plan.md 作成（B案 + C/D 二段防御 + 二重防御を確定）
- Phase 3 Impl: TDD 実装
- Phase 4 Inspection: **GO**（独立裏取り済み）。minor 指摘 2 件（M2: テスト差別化力強化 / M1: impl-notes の tsc 件数補正）を完了処理前に対応

## 残課題 / スコープ外

- `getCallerWorkspace()` が undefined を返すケースの是非は本タスクのスコープ外（plan.md §4 で明記）
- prefix collision の手動 e2e 再現は cmux-team-lab で別途検証想定（自動テスト + コードレビューで担保済み）

## 納品

ローカル ff-only マージ（main へ）。マージコミットは後段で記録。
