# タスク割り当て

## タスク内容

---
id: 010
title: Manager daemon post-mortem evidence capture 強化
priority: medium
created_at: 2026-05-17T08:31:32.058Z
---

## タスク
## 背景

2026-05-17 に Brainship/prototype で Manager daemon (PID 25813, v0.5.0、6 日稼働中) が**無言で死亡**するインシデントが発生した。manager.log の最終行 (15:58:09) から runningboardd の検知 (16:27:23) まで **29 分のギャップ**があり、daemon の正確な死亡時刻 / 死亡時の内部状態 / 死因のいずれも事後再現できなかった。

詳細な調査結果は user との会話履歴に残っているが、要点:
- macOS の DiagnosticReports に bun の crash report (.ips) が無い → launchd 経由でない死に方
- launchd に SIGKILL/SIGTERM の記録なし → 外部 kill signal でもなさそう
- stderr は c11 pane に流れて c11 自身も freeze で回収不能
- system 全体で 16:48-50 に memory pressure event 2 → memory 起源の可能性
- daemon の死と c11 freeze の前後関係すら不明

このタスクの目的は、**次回同種のクラッシュが起きた時に WHEN / WHAT / WHY の 3 軸で原因究明できる evidence を残す機構を Manager daemon に組み込むこと**。

## ゴール

次回 Manager daemon が死亡した時に、以下が事後に分かる状態にする:

| 知りたいこと | 達成手段 |
|---|---|
| WHEN: 死亡時刻 (±10s) | heartbeat file |
| WHAT: 死亡直前の内部状態 (heap / RSS / event loop / 稼働 Conductor 数) | self-telemetry jsonl |
| WHAT: 死亡時の system context (vm_stat / swap / 他 bun process) | 外部 sampler |
| WHY: JS 例外 / unhandled rejection | uncaughtException / unhandledRejection handler |
| WHY: bun runtime panic / Rust backtrace | stderr file redirect |
| WHY: 外部 kill signal | signal handler (SIGTERM/SIGINT/SIGHUP) |
| 最終ログ行が落ちないこと | logger の critical path sync write |

## 実装サブタスク (推奨優先順)

### 1. stderr を file にリダイレクト (最優先・最大インパクト)

\`elevens start\` が daemon を spawn する経路で、stdout/stderr を \`.team/logs/manager.stderr.log\` に直接書き出すよう変更する。bun panic の Rust backtrace / \`console.error\` / unhandled exception trace を確実に file に残すための土台。

- 起動時に既存 stderr.log があれば \`.1\` に rotate (過去 1 世代保全)
- spawn 時に file fd を stdio に渡す形式 (detached 起動でも親 process 切断後も書き続ける)
- 既存の manager.log への logger 出力経路はそのまま (両方に出る形)

### 2. heartbeat file

10s 間隔で \`.team/daemon.heartbeat\` を touch (内容: ISO 8601 timestamp + 軽い state metadata = pid / open task 数 / open Conductor 数 等)。新 daemon 起動時に既存 heartbeat の最終 mtime を読んで \`pidfile_stale_detected\` ログに含める。

- 起動コストの観点で interval は 10s 程度 (1s は disk I/O 過多)
- shutdown 経路で heartbeat に「clean exit: reason=X」を書いてから消す (= 残っていれば異常終了の証拠)

### 3. process.on('uncaughtException') / 'unhandledRejection') / SIGTERM, SIGINT, SIGHUP handler

handler は **sync 書き込み**で manager.log と stderr.log の両方に「fatal trace / signal received」を残してから process.exit する。SIGKILL / SIGSEGV / OOM-kill は捕えられないことは仕様として割り切る (それらは stderr.log や heartbeat の不在で検出する)。

- handler 内で async I/O を avoid (stack の途中で process が死ぬので fs.writeFileSync / fs.appendFileSync を使う)
- 既存の logger.ts を二重呼び出しすると logger 自体の bug で trap loop に陥る可能性があるので、**handler は logger を経由せず直接 file write** で安全側に倒す
- signal handler は「clean shutdown 経路に転流」する選択もあるが、まずは「signal を受けた事実を記録してから exit」のシンプル設計

### 4. self-telemetry を \`.team/logs/manager.telemetry.jsonl\` に 30s 毎 append

各 sample は:
\`\`\`json
{
  "ts": "2026-05-17T15:58:30.000Z",
  "rss_mb": 187,
  "heap_used_mb": 142,
  "heap_total_mb": 178,
  "external_mb": 5,
  "event_loop_lag_ms": 4,
  "open_conductors": 2,
  "open_agents": 1,
  "open_tasks": 3,
  "uptime_sec": 518400
}
\`\`\`

- bun の \`process.memoryUsage()\` / \`process.resourceUsage()\` を活用
- event loop lag は \`setImmediate\` の callback 遅延で測る
- circular rotation: 直近 N MB or N 件で先頭から削除 (回し続けても disk 圧迫しない)
- daemon が「自殺」する前の **trajectory を残す**ことが本質 (heap が単調増していたら leak 型 OOM、burst していたら別系統)

### 5. logger に critical path 用 sync write API

現状の logger.ts は buffer 付き append の可能性 (要調査)。fatal handler / shutdown 経路で使う **強制 fsync 版 logger** を追加。普段の event log は async のまま (perf 劣化を避ける)。

- 既存の \`log()\` と並ぶ \`logSync()\` などの追加で API 切替
- 最後の数行が buffer に残って失われる事故を防ぐ

### 6. 外部 sampler (launchd plist で 30s 毎、別 process)

daemon が死んでも生き残る system context source。launchd plist は **opt-in install** (\`elevens install-watchdog\` 的な subcommand で配布、強制しない)。

- sample 内容: \`vm_stat\` の free/wired/compressed pages、\`ps -o pid,rss,vsz,command -p \$(pgrep bun)\`、\`uptime\` (load average)
- 出力先: \`.team/logs/system.jsonl\`
- 既存の manager.telemetry.jsonl と timestamp で join 可能な schema

### 7. (調査タスク) bun 自体の crash report 設定を確認

bun に \`BUN_CRASH_REPORT\` / \`--crash-report\` 系の env / flag があるか確認し、あれば設定する。bun runtime の native crash 種別が更に詳しく取れる可能性。なければ「bun 側に feature request」のメモを Artifact (research) に残す。

## 仕様判断ポイント (Agent に委ねる)

- heartbeat / telemetry の polling interval は default を提案するが、 user が \`.team/team.json\` 等で override できる方が良いか
- stderr rotate の世代数 (1 か 2 か 3 か)
- telemetry jsonl の circular rotation 閾値 (file size or 件数)
- 6 の外部 sampler は本タスクスコープに入れるか別タスクに切るか (launchd plist 配布は plugin user 体験への影響大なので慎重に)

## Acceptance Criteria

- [ ] \`.team/logs/manager.stderr.log\` が daemon spawn 時に作られ、bun の stderr 全部がそこに行く (手動再現: daemon 内で \`throw new Error(...)\` → stderr.log に stack trace が残る)
- [ ] \`.team/daemon.heartbeat\` が 10s 毎に更新される。daemon kill -9 後に file が残存し mtime が死亡時刻 (±10s) を示す
- [ ] daemon 内で \`throw\` した時、manager.log に fatal trace が sync で書かれ、process が exit する
- [ ] daemon に \`kill -TERM\` を送ると、manager.log に「signal received: SIGTERM」が記録されてから exit
- [ ] \`.team/logs/manager.telemetry.jsonl\` に 30s 毎にメトリクスが append される
- [ ] (6 を本タスクに含めるなら) \`elevens install-watchdog\` で launchd plist が install され、daemon と独立に system.jsonl が更新される
- [ ] docs/spec/ に新規 spec (例: 15-post-mortem-evidence.md) を追加、CLAUDE.md にも該当 section を追加
- [ ] 既存 test (manager 配下) が pass

## 参考

- 同種の死亡パターン: Brainship/prototype 2026-05-17 (会話履歴参照)
- 関連 spec: docs/spec/05-install-and-infrastructure.md (Manager daemon 起動経路)
- 関連実装: skills/cmux-team/manager/{main.ts, daemon.ts, logger.ts}


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/elevens/.worktrees/task-010-1779006692` 内で行う。
```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-010-1779006692
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-010-1779006692/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/elevens/.team/tasks/010-manager-daemon-post-mortem-evidence-capture/runs/task-010-1779006692
```

結果サマリーは `/Users/yamamoto/git/elevens/.team/tasks/010-manager-daemon-post-mortem-evidence-capture/runs/task-010-1779006692/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `elevens close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`elevens send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
