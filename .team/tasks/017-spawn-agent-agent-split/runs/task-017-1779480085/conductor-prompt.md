# タスク割り当て

## タスク内容

---
id: 017
title: spawn-agent の Agent 起動先が別ペイン/split になる不具合の調査・修正
priority: high
created_by: surface:29
created_at: 2026-05-22T19:55:41.027Z
---

## タスク
## 症状

Conductor が subagent (Agent) を起動する `spawn-agent` 実行時、本来「Conductor の所属ペインに追加タブ (c11 new-surface --pane)」で開くべきところが、**別ペイン**あるいは **split** で起動することがある（毎回ではなく条件依存）。

## 調査で特定した原因（2点）

### 欠陥1: `getPaneForSurface` の surface 照合が部分文字列マッチ（prefix 衝突）

`skills/cmux-team/manager/cmux.ts:281`
```ts
if (line.includes(surface) && currentPane) return currentPane;
```
`line.includes(surface)` は完全一致ではなく部分一致。conductorSurface が例えば `surface:2` のとき、tree 出力の `surface:26` `surface:27` … を含む行に誤マッチし、**間違った pane を返す**。tree の出力順次第で本来の Conductor pane より先に別 surface 行へ当たると、その pane にタブを作ってしまう → 「違うペインに出る」。
- 対照的に同ファイルの `listSiblingSurfaces`（cmux.ts:312）は `s === surface` の**完全一致**で正しい。getPaneForSurface だけが部分一致になっている非対称性自体が傍証。

### 欠陥2: targetPane が undefined のとき `newSurface(undefined)` がフォールバック起動する

`skills/cmux-team/manager/main.ts:3574-3577`
```ts
const callerWorkspace = await cmux.getCallerWorkspace();
const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);
createdSurface = await cmux.newSurface(targetPane);  // targetPane が undefined でもそのまま呼ぶ
```
`getPaneForSurface` が undefined を返しても `newSurface(undefined)` をそのまま実行する。`cmux.ts:154-156` で `--pane` が無いと `c11 new-surface`（pane 指定なし）になる。

実機の `c11 new-surface --help` より:
- `--pane <id|ref>` 省略時、c11 は対象 pane を自動選択する
- `--workspace ... (default: $CMUX_WORKSPACE_ID)` で workspace も自動解決

このとき c11 は **focused pane / focused workspace** に surface を作る挙動になり得る。実機 `c11 identify` で caller(workspace:5) と focused(workspace:1) が乖離していることを確認済み。ユーザーが elevens 以外の workspace/pane をフォーカスしていると、そこに surface が作られる → 「split で、しかも違うペイン」。

**重要**: T016 で入った fail-fast は「newSurface が throw したとき」のみ。targetPane=undefined で newSurface が **成功してしまう** ケースは fail-fast の網にかからない。これが穴。

### 補足: 実ログの痕跡

`.team/logs/manager.log:1955`
```
[2026-05-20T02:55:44] error getPaneForSurface failed: S[934] Command failed: cmux tree --workspace workspace:1
```
focused 側 workspace を tree に渡して失敗している経路が過去にも発生している。

## 修正方針（実装判断は Agent に委ねる。以下は調査で見えた論点）

1. **欠陥1**: `getPaneForSurface` の surface 照合を完全一致にする。最も堅牢なのは `tree(workspace, { json: true, idFormat: \"both\" })` で JSON パースし surface.ref/id を厳密照合する方式（`normalizeSurfaceArg`（main.ts:556-592）が既に採用）。または `listSiblingSurfaces` と同じ `surface:\d+` 抽出 + `s === surface` 完全一致に揃える。テキスト正規表現で済ませるなら単語境界を付ける。

2. **欠陥2**: targetPane が undefined のときは `c11 new-surface`（pane なし）に**フォールバックさせず fail-fast** する（CLAUDE.md / プロジェクト方針「fail-fast over fallback」に沿う）。spawn-agent 側で undefined を検知したら AGENT_SPAWN_FAILED を post して exit 1。`newSurface` 自体に pane 必須化を入れる選択肢もある。

3. **二重防御（任意）**: `newSurface` に `--workspace callerWorkspace` も明示的に渡し、focused workspace への暗黙フォールバックを物理的に塞ぐ。pane が取れていれば pane から workspace は自明だが、安全側の冗長化。

## 検証

- 単体: `getPaneForSurface` に prefix 衝突する surface 番号配置（例: 探索対象 surface:2, tree に surface:26 が先行）を与え、誤った pane を返さないこと。
- 単体: targetPane undefined 時に newSurface(undefined) が呼ばれず fail-fast すること。
- 既存テスト: `cd skills/cmux-team/manager && bun test --timeout 30000 cmux.test.ts`（および spawn-agent 関連 test）。`bun test` 全体実行は禁忌。
- 手動: 複数 workspace を開き、elevens 以外の workspace をフォーカスした状態で Conductor から Agent を spawn し、Conductor ペインにタブとして開くことを確認。

## 関連ファイル
- `skills/cmux-team/manager/cmux.ts`（getPaneForSurface:274-284 / newSurface:154-163 / listSiblingSurfaces:295-324 / getCallerWorkspace:413-421）
- `skills/cmux-team/manager/main.ts`（cmdSpawnAgent:3565-3843、特に 3574-3577）
- `skills/cmux-team/templates/en/conductor.md`（spawn-agent 呼び出し、--conductor-surface \$CMUX_SURFACE）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-017-1779480085` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-017-1779480085
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-017-1779480085/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/017-spawn-agent-agent-split/runs/task-017-1779480085
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/017-spawn-agent-agent-split/runs/task-017-1779480085/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


