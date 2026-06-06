# タスク割り当て

## タスク内容

---
id: 026
title: surface タブタイトルが recap で上書きされる問題の writer 特定と修正（T019 再起票）
priority: high
depends_on: [024]
created_by: surface:29
created_at: 2026-05-23T23:37:37.522Z
---

## タスク
> **再起票**: 旧 T019 は disconnect_timeout で abort（C[27], 実装未着手）。
> 環境不安定の調査・修正タスク **T024** の完了後に実行する（--depends-on 024）。内容は旧 T019 と同一。


## タスク
## 背景・症状

elevens は各 surface のタブタイトルを `[N] Master` / `[N] Conductor` / `[N] Agent` / `[N] Manager` の固定名にしている（これは**意図した正しい仕様**）。
ところが Conductor / Agent の surface で、タブタイトルが **現在動作中の作業の recap（要約）や `Claude Code` に動的に書き換わる**ことがある。
Master の固定名は守りたいので、固定名が常に勝つようにしたい。

> 注意: `[N] Claude Code` / `[N] Master` 等の固定命名そのものは正しい仕様。問題は「固定名が recap に上書きされること」。

## Master が事前に集めた証拠（live セッション surface から）

`c11 get-metadata --surface surface:N --sources` と `ps eww` の env を突き合わせた結果:

| surface | role | プロセス env | title | source |
|---|---|---|---|---|
| 29 | Master | CMUX_CLAUDE_HOOKS_DISABLED=1 | `[29] Master`（生存） | **explicit** |
| 27 | Conductor(予約) | CMUX_CLAUDE_HOOKS_DISABLED=1 | `[27] Claude Code`（上書き） | **explicit** |
| 36/37 | Agent(throttled) | — | `[36] Claude Code` | **explicit** |

ここから判明していること:

1. **elevens の `renameTab` は explicit source で書く**（Master の `[29] Master` が explicit で確認できる。実装は `cmux.ts:renameTab` → `c11 rename-tab`、内部で `tab-action rename`）。
2. 上書きされた title も **explicit**。つまり `explicit vs explicit` の last-write-wins で、**誰かが elevens の renameTab より後に explicit で title を書いている**。
3. surface:27 の claude プロセスは `CMUX_CLAUDE_HOOKS_DISABLED=1` が立っている（`ps eww` で確認）のに上書きされている → **c11 の PATH wrapper 注入 hook 経由では止まっていない**。
4. c11 SKILL.md の title precedence は `explicit > declare > osc > heuristic`。recap が OSC 由来（source=osc）なら本来 explicit に負けるはずなのに上書きされている。
   → **単純な `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`（OSC 抑止）だけでは効かない恐れがある。**
5. `CMUX_NO_RENAME_TAB` は env に立っている（conductor.ts:134, main.ts:3300/3388/3637）が、**elevens の .ts でも c11 wrapper でも一度も参照されていない dead flag**（cmux 時代の遺物）。c11 環境では no-op。

## このタスクでやること

### Phase 1: writer の特定（隔離再現）

worktree 隔離環境で、新規 surface を作って claude を起動し、env 条件を変えて title の挙動と `c11 get-metadata --sources` の provenance（source と timestamp）を before/after で実測する:

- 条件 a: `CMUX_CLAUDE_HOOKS_DISABLED=1` のみ
- 条件 b: `CMUX_CLAUDE_HOOKS_DISABLED=1` + `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`
- 条件 c: 何も付けない（素の claude）

確認したいこと:
- recap への書き換えが起きるのはどの条件か
- そのとき title の **source は osc か explicit か**（これが fix の層を決める）
- `[N] Claude Code`（idle）と recap（作業中）は別現象か同一機構か
- 書き換えの **timestamp** が elevens renameTab より後か（last-write-wins の検証）

> c11 は AGPL のため**コードは読まない**。CLI の外部観測（get-metadata --sources / tree / 挙動）だけで切り分ける。`skills/c11/SKILL.md` は自前要約なので precedence 等の記述が実挙動とズレている可能性も疑い、実測を優先する。

### Phase 2: 適切な層で fix

Phase 1 の結果に応じて最小修正を選ぶ:

- **writer が OSC(source=osc) だった場合**: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` を Master/Conductor/Agent の全 claude 起動経路に注入（env または Manager 生成 settings.json の env セクション）。注入漏れ経路がないか以下を網羅:
  - Conductor: `conductor.ts`（env object L131-134 付近）/ reserved 経路（L320-336）
  - Agent: `main.ts` cmdSpawnAgent の exportVars（L3621-3638 付近）
  - Master: `master.ts` / daemon.ts の master spawn
  - restart 経路: `main.ts` L5593 付近（現状 HOOKS_DISABLED は付くが他は要確認）
- **writer が explicit だった場合**: OSC 抑止だけでは不十分。elevens 側で固定名を確実に勝たせる仕組みを設計する（例: title を pin する c11 機構があれば利用 / 上書き検出時の再 assert / そもそも誰が explicit で書いているかを突き止めて元から断つ）。last-write-wins の競争に持ち込まない構造を優先（CLAUDE.md「決定論的なものはコードで」「逸脱しても安全な構造に」）。
- ついでに **dead flag `CMUX_NO_RENAME_TAB` の扱いを決める**（削除するか、c11 で意味を持たせるか）。set しているが効いていないのは誤解の元。

### 検証

- 修正後、Conductor / Agent を実際に spawn して作業させ、タブタイトルが `[N] Conductor` / `[N] Agent` の固定名のまま recap に侵食されないことを `c11 tree` と `get-metadata --sources` で確認。
- Master の `[N] Master` が引き続き生存することも確認（regression なし）。
- 関連テスト（master.test.ts / daemon.test.ts の renameTab 系）が通ること。`bun test` 全体実行は禁忌、per-file ループで。

## 参考 file:line

- `skills/cmux-team/manager/cmux.ts` `renameTab`（L224-231）→ `c11 rename-tab`（= `tab-action rename`, source=explicit）
- `skills/cmux-team/manager/conductor.ts` L131-134（env）/ L170 / L320-336（reserved rename）
- `skills/cmux-team/manager/main.ts` L3621-3638（Agent exportVars）/ L3798（Agent rename）/ L5593（restart）/ L3300,3388,3637(CMUX_NO_RENAME_TAB)
- `skills/cmux-team/manager/master.ts` L124 / `daemon.ts` L2115（master rename）
- `skills/c11/SKILL.md` L78-81（title metadata / precedence）, §6 wrapper/hook
- c11 wrapper: `/Applications/c11.app/Contents/Resources/bin/claude`（L101 の HOOKS_DISABLED gate / L183 HOOKS_JSON）— 読み取りのみ


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-026-1779581000` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-026-1779581000
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-026-1779581000/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/026-surface-recap-writer-t019/runs/task-026-1779581000
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/026-surface-recap-writer-t019/runs/task-026-1779581000/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。


