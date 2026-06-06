# タスク割り当て

## タスク内容

---
id: 013
title: post-mortem stderr の proper 実装: parent tee で TTY 表示 + file 両立
priority: medium
created_at: 2026-05-19T05:22:44.663Z
---

## タスク
## 背景

v0.8.0 で導入した `cmdStart` 冒頭の self-respawn による stderr→file redirect が、TTY 親プロセスを spawn 直後に `exit(0)` させる構造上、**TTY mode で子プロセスの起動失敗エラーが file (`manager.stderr.log`) に消え、user の TTY には何も表示されない silent fail を引き起こす UX regression** を起こした (KDG-lab 2026-05-19 で `daemon already running` エラーが見えない事故が発生)。

v0.8.1 で **auto-respawn を default disable** にする hotfix を入れたが (`CMUX_TEAM_POST_MORTEM_REDIRECT=1` で opt-in 化)、これにより v0.8.0 で実現していた **bun runtime panic / Rust crate panic / libc abort の file 捕捉** が default では効かなくなった。本タスクで proper な実装に置き換えて両立する。

## ゴール

- bun runtime panic を `manager.stderr.log` に書き残せる (v0.8.0 と同等の post-mortem evidence)
- かつ `elevens start` を TTY で打った user に正常な出力が見える (v0.8.1 hotfix と同等の UX)
- 子プロセスの起動失敗エラー (daemon already running 等) は TTY にも file にも両方表示される
- `Ctrl+C` で子プロセスを kill できる (現状の v0.8.0 では detached child が残る)

## 実装方針: parent tee アーキテクチャ

```
親 (TTY) ──┬─ open stderr.log
           ├─ spawn child --__post-mortem-redirected with stdio=['inherit','inherit','pipe']
           ├─ child.stderr.pipe(stderr.log via fs createWriteStream) + child.stderr.pipe(process.stderr)
           ├─ forward SIGINT/SIGTERM to child
           ├─ wait child exit
           └─ exit with child's exit code
```

要点:
- 親は **child を foreground で wait** し、process group / TTY の所有権を保つ
- 子の `stderr` は `pipe` で受け取り、**`manager.stderr.log` と `process.stderr` の両方に tee**
- 子の `stdout` は `inherit` で TTY に直結 (v0.8.1 と同等の visibility)
- SIGINT/SIGTERM を child に forward して Ctrl+C で正常 shutdown 可能に
- 親は child の終了コードを継承

bun の child_process は `stdio: 'pipe'` を返した場合 readable stream を expose しているので、`stream.pipe(writeStream)` で file 書き、別途 `data` event で `process.stderr.write` する形が標準的。

## エッジケース

1. **bun runtime panic が tee path 外 (write 失敗) で起きる場合**
   → child の stderr stream は OS level で kill 時にも flush される。pipe で受ければ親は確実に拾える。
2. **親プロセスがクラッシュしたら子はどうなる？**
   → child は process group の lead じゃない (parent が lead)。親 kill 時に SIGHUP で巻き込まれる懸念があるので、`spawn` 時に `detached: false` (default) で OK だが、SIGHUP handle 検討が必要。
3. **stderr.log rotation**
   → 既存の rotate ロジックは spawn 前に動く。pipe 経路でも適用可能。
4. **tee の overhead**
   → stderr の流量は通常少ない (普段は ほぼゼロ)。perf 影響なし。

## Acceptance Criteria

- [ ] `CMUX_TEAM_POST_MORTEM_REDIRECT` 環境変数が無くても default で stderr が file & TTY 両方に流れる
- [ ] `elevens start` を打ったとき、エラーが起きれば TTY に表示される (`daemon already running` 等)
- [ ] 子の bun runtime panic / process.exit(1) も `manager.stderr.log` に記録される (再現 test: child の起動オプションで意図的に panic させて確認)
- [ ] Ctrl+C で daemon が正常に shutdown する
- [ ] 親プロセスは child の exit code を継承する
- [ ] v0.8.1 hotfix で disable した opt-in env (`CMUX_TEAM_POST_MORTEM_REDIRECT`) は廃止 or backward-compat 用に残す
- [ ] 既存 test (`post-mortem-redirect.test.ts`) を tee 経路に書き直し、test cases を拡張 (起動失敗系 / SIGINT forward 系)
- [ ] CHANGELOG に「v0.8.1 hotfix の proper fix」として記録
- [ ] spec (`docs/spec/15-post-mortem-evidence.md`) を tee 設計に更新

## 関連

- v0.8.0 リリース commit: `c147df9` (post-mortem evidence capture T010)
- v0.8.1 hotfix commit: `b97433f`
- 事案: KDG-lab で daemon already running エラーが silent fail した 2026-05-19 incident
- spec: `docs/spec/15-post-mortem-evidence.md` §S5 (redirect 設計)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-013-1779168164` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-013-1779168164
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-013-1779168164/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/013-post-mortem-stderr-proper-parent-tee-tty-file/runs/task-013-1779168164
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/013-post-mortem-stderr-proper-parent-tee-tty-file/runs/task-013-1779168164/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。

{{ARCHIVED_WORKTREE_SECTION}}
