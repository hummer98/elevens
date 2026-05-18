# elevens

Claude Code + cmux によるマルチエージェント開発オーケストレーションのプロジェクト。中核は cmux-team スキル/コマンドパッケージ。
Master（ユーザー対話）→ Manager（イベント駆動監視）→ Conductor（タスク実行）→ Agent（実作業）の4層構造。

## プロジェクトミッション

**cmux のターミナルマルチプレクサ機能を活用し、Claude Code の複数セッションを協調させて開発タスクを自律的に遂行できるようにする。**

### ゴール

1. **ユーザーは指示を出すだけ** — 実装・テスト・レビューは全てエージェントが行う
2. **進捗が見える** — cmux のペイン分割でエージェントの作業がリアルタイムに可視化される
3. **安全に失敗できる** — git worktree 隔離により main は常に無傷
4. **プラグインとして誰でもインストールできる** — Claude Code Plugin として配布
5. **観察可能性が改善サイクルを回す** — エージェント挙動を **pane（real-time）+ trace DB / metrics snapshot（retrospective）** の二層で観察可能にし、得られた洞察を prompt / hook / skill / agent 設計の改善に還元する。本プロジェクトは orchestration layer であると同時に **AI 観察箱（AI observatory）** である（README 参照）

### 観察箱 (AI Observatory) としての性格

elevens は「AI を働かせる基盤」であると同時に「**AI のふるまいを観察して洞察を得るためのプラットフォーム**」である。観察は二層構造を取る:

| 層 | 媒体 | 主な利用 |
|---|---|---|
| **real-time 観察** | cmux ペイン（人間の目） | Conductor / Agent ペインの斜め読みで「途中の挙動」をその場で検出（README "AI 観察箱" / "AI observatory" 参照） |
| **retrospective 観察** | trace DB (`hook_signals` / `api_usage` / `task_sessions`) + events.jsonl + metrics snapshot | `cmux-team metrics` / cohort 比較 / 統計検定による事後・統計的評価（`docs/spec/11-metrics.md` 参照） |

**機能追加の判断軸**: 新機能を入れる際は「observatory に資するか」（観察可能性を高めるか、観察結果から得た洞察に基づくか）を判断軸の 1 つとする。逆に観察を阻害する変更（state を内部に隠す、hook を bypass する、trace を不完全にする、pane の表示を奪う）は原則として避ける。

### 設計原則

| 原則 | 意味 |
|------|------|
| **上位が下位を監視する（pull 型）** | 下位からの push 報告に依存しない。セマンティック動作の信頼性問題を回避 |
| **決定論的なものはコードで、判断が必要なものは AI で** | イベント検出は確実に、意思決定は柔軟に |
| **各層は自分の仕事だけをする** | Master は作業しない、Agent は報告しない、Conductor はユーザーに聞かない |
| **逸脱を防ぐより、逸脱しても安全な構造にする** | worktree 隔離 + 事後レビュー |
| **構造的正しさを優先** | 状態遷移・責務分担・データフローが明示的に正しいこと。state machine・専用ライブラリを積極的に導入し、繰り返し発生するクラスのバグを構造で絶つ |

### 設計原則の背景: state tracking への構造的対応

5 原則はすべて「**transformer が state を内部で維持しなくて済む環境を設計する**」という上位原理に収束する。新規スキル・コマンド・ツール追加時のチェックリスト：

| 確認項目 | 既存実装の対応例 |
|---|---|
| **state を外部化しているか** | `task-state.json` + Task FSM、`.team/artifacts/`、trace DB |
| **silent state mutation を作っていないか** | CLI 強制（直接ファイル書き禁止 hook）、hook→daemon の決定論的経路 |
| **observer が pull で観測できるか** | Manager の pull 型監視、PID watcher、done マーカーファイル |
| **statefulness を排除できないか** | worktree-per-task 隔離、絶対パス強制、stateless CLI |

「agent が前回の state を覚えている前提」が必要になったら設計の sign of trouble。state を外部化するか、状態追跡を要求しない protocol に再設計する。

## 判断基準と優先順位

### タスクの優先順位（高→低）

1. **バグ修正** — 既存機能が壊れている場合は最優先
2. **実験で発見された問題の修正** — 実際に動かして判明した issue
3. **ユーザー体験の改善** — インストール・起動・操作が簡単になる変更
4. **ドキュメントの正確性** — README や SKILL.md が実装と乖離していれば修正
5. **新機能** — 新しいエージェントロールやコマンドの追加
6. **最適化** — パフォーマンス、トークン消費、レート制限対策

### 判断に迷ったとき

- **実験で検証してから本実装** — cmux-team-lab 等で試してから SKILL.md に反映
- **既存の動作を壊さない** — CLI コマンドのインターフェースを安定させる（内部実装の書き換えは制約しない）
- **ユーザーに聞く** — 設計判断で迷ったらユーザーの判断を仰ぐ

## リポジトリ構造

```
elevens/
├── skills/cmux-team/
│   ├── SKILL.md              # 4層アーキテクチャ定義スキル
│   ├── manager/              # Manager daemon（TypeScript / Bun）
│   └── templates/            # エージェントプロンプトテンプレート
├── skills/cmux-agent-role/SKILL.md  # サブエージェント行動規範スキル
├── skills/c11/SKILL.md       # c11 substrate リファレンス（自前要約; AGPL コピー不可）
├── commands/                 # スラッシュコマンド定義
├── docs/spec/                # 統合仕様書（実装と同期）
└── bin/                      # CLI エントリポイント
```

**c11 (Stage-11-Agentics/c11) 関連の概念・API・cmux との差分が必要なときは `skills/c11/SKILL.md` を Read する。** elevens は c11 を substrate として動くため、surface manifest / lineage / mailbox / flash / blueprint / `c11 tree` / `set-metadata` / wrapper 経由 hook 等を頻繁に扱う。

**elevens の仕様・挙動について質問された場合は、`docs/spec/` の該当ファイルを Read して回答すること。**

| ファイル | 内容 |
|---------|------|
| `docs/spec/glossary.md` | 用語集（用語 → 一次定義場所のインデックス） |
| `docs/spec/00-project-overview.md` | プロジェクト概要・4層アーキテクチャ |
| `docs/spec/01-skill-cmux-team.md` | cmux-team スキルの仕様 |
| `docs/spec/04-templates.md` | テンプレート変数仕様（`{{VARIABLE}}` 全一覧） |
| `docs/spec/05-install-and-infrastructure.md` | インストール・レイアウト・config・worktree 解決 |
| `docs/spec/07-state-machine.md` | Conductor / Task FSM・cascade・CONDUCTOR_DONE・Ready sync guard |
| `docs/spec/08-runtime-boundary.md` | Deliverable 型・close-task 仕様 |
| `docs/spec/09-token-pool.md` | Token pool — `cmux-team token` CLI・DB スキーマ・選択アルゴリズム・設定 |
| `docs/spec/11-metrics.md` | Metrics taxonomy（6 軸）・data source・CodeDNA 評価判定基準 |
| `docs/spec/14-epic.md` | Epic（PoC）— 上位 orchestration の達成ゴール単位、Epic Planner（`/loop`）、Hybrid done 判定、budget |

## スキル・コマンドの追加・修正方法

### スキルの追加

1. `skills/<skill-name>/SKILL.md` を作成
2. YAML frontmatter に `name`, `description`（トリガー条件を含む）を記載
3. Markdown 本文にスキルの知識・プロトコルを記述

### コマンドの追加

1. `commands/<command-name>.md` を作成
2. YAML frontmatter に `allowed-tools`, `description` を記載
3. Markdown 本文に手順・引数仕様・注意事項を記述（`$ARGUMENTS` で引数を参照）

### テンプレートの追加

1. `skills/cmux-team/templates/<role-name>.md` を作成
2. `{{VARIABLE}}` プレースホルダーを使用（変数一覧は `docs/spec/04-templates.md` 参照）
3. Conductor（または Manager）が spawn 時にテンプレート変数を置換し `.team/prompts/` に書き出す

## コーディング規約

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- スキルは YAML frontmatter + Markdown
- コマンドは YAML frontmatter（`allowed-tools`, `description`）+ Markdown
- テンプレートは `{{VARIABLE}}` プレースホルダーを使用
- README.md やユーザー向けテキストは日本語

別プロジェクト（mado, Dear 等）の `.team/` 調査は `.claude/skills/elevens-investigate/SKILL.md` を参照（npm publish 対象外）。

## 実装ルール（ガードレール）

詳細は `.team/agent-instructions/implementer.md` を参照。**絶対に守るべき制約のみ抜粋：**

- **cmux tree**: `tree(workspace)` / `validateSurface(surface, workspace)` を使う（workspace 省略禁止）
- **ログ**: 外部コマンド失敗時は `stderr` / `stdout` を必ず detail に含める。空の `catch {}` 禁止
- **EventBus**: `notifyStateChanged` / `onStateChanged` のみ使用可。`bus.emit` / `bus.on` の直接呼び出し禁止。`logger.ts` からの `eventBus.ts` import 禁止（循環依存）
- **task-state**: `applyTaskEvent` / `updateTaskSessionId` 経由のみ。`daemon.ts` / `main.ts` で `taskState[...] =` / `saveTaskState(` を直接書いてはいけない。taskId は `/^\d{1,4}$/` に強制（write 時 throw、load 時 drop）
- **hook**: hook shell には分岐ロジックを持たせない。全イベントを daemon に転送する

## プロンプト編集ルール（厳守）

**テンプレート (`skills/cmux-team/templates/*.md`) がソースオブトゥルース。** ランタイムプロンプト (`.team/prompts/*.md`) は派生物であり、直接編集してはならない。

| やること | やらないこと |
|---------|-------------|
| `skills/cmux-team/templates/master.md` を編集 | `.team/prompts/master.md` を直接編集 |
| 編集後に `cmux-team start` で再生成 | ランタイムだけ書き換えて「動いた」で終わり |

プロンプトを変更する場合: テンプレートを編集 → `.team/prompts/` にコピー（または `cmux-team start` で再生成）→ コミット・リリース。

## Manager プロトコル（概要）

TypeScript daemon（`skills/cmux-team/manager/main.ts`）として Bun で実行。

- **ログ**: `.team/logs/manager.log`（`cmux-team status` でログ末尾を表示）
- **タスク検出**: `task-state.json` で `status: ready` のタスクを検出し idle Conductor に割り当てる
- **Conductor は spawn しない**: 起動時に作成された固定ペインにタスクを送信するだけ
- **完了検出**: done マーカーファイル（`.team/output/conductor-N/done`）+ PID ベース生存確認（`spawnPidWatcher`）
- **アイドル化**: open tasks ゼロで待機、`[TASK_CREATED]` 通知で起床
- **多重起動防止**: `.team/daemon.pid` を `writeFile({ flag: "wx" })` で atomic に取得
- **Sub-agent 共通 overlay (T413)**: `.team/agent-instructions/_common.md` に置くと、Master / Conductor / Agent 全 sub-agent prompt の `{{PROJECT_COMMON_INSTRUCTIONS}}` 位置に展開される（per-role overlay は引き続き `<role>.md`）
- **Post-mortem evidence (T010)**: daemon は `.team/daemon.heartbeat` (10s sync write) / `.team/logs/manager.stderr.log` (OS fd 2 redirect、Bun runtime panic も残る) / `.team/logs/manager.telemetry.jsonl` (30s 間隔の self-telemetry) を書き続ける。死亡時の WHEN/WHAT/WHY 再構成に使う。詳細は `docs/spec/15-post-mortem-evidence.md`

### タスクの作成・更新は CLI 経由（直接ファイル操作禁止）

`.team/tasks/` への直接ファイル書き込みは hook でブロックされる。

```bash
cmux-team create-task --title "タイトル" --status draft --body "説明"
cmux-team update-task --task-id 112 --status ready
```

> `.team/artifacts/` は直接ファイル作成が前提。`.team/tasks/` は CLI 経由のみ。混同しないこと。

**assigned 状態のタスクファイル編集は禁止。** 変更が必要な場合は `abort-task` で中止 → 新タスク作成。

## タスク属性

| 属性 | 意味 | CLI フラグ |
|------|------|-----------|
| `run_after_all: true` | 全 open タスクが closed になってから実行（非排他 drain）。assigned 中は normal の新規 assignment を停止するが、他の `run_after_all` とは並走可 | `--run-after-all` |
| `exclusive: true` | drain 後に単独実行。assigned の間は他の全 assignment を停止 | `--exclusive` |

- `--exclusive` 同士は共存可能（ID 昇順に順次排他実行）
- `--exclusive` と非排他 `--run-after-all` は共存不可
- 詳細な FSM 仕様は `docs/spec/07-state-machine.md` を参照

## Epic（PoC）

Task / Artifact と並ぶ第三のカテゴリ。「達成したい E2E シナリオと勘所」をユーザーが定義し、
細かい Task 分解・実装判断は **Epic Planner**（`/loop` 自律エージェント）に委譲する上位 orchestration layer。
Master / Manager / Conductor / Agent の 4 層に**上から覆いかぶさる形**で動く。

### CLI（PoC）

```bash
# 新規作成
elevens epic create --title "TITLE" --body "INTENT" [--budget-token 500000] [--budget-iteration 30] [--budget-hours 24]

# 一覧 / 詳細
elevens epic list [--status active|blocked|closed|aborted|all]
elevens epic show E001

# 状態操作（人間 / Master 経路のみ）
elevens epic resume E001 [--budget-token N] [--budget-iteration N] [--budget-hours H]  # blocked → active
elevens epic abort  E001 [--journal TEXT]                                                # → aborted
```

### Task との link

```bash
elevens create-task --title "..." --status ready --epic-id E001 --body "..."
```

`--epic-id E001` を付けた Task は frontmatter に `epic_id: E001` として記録され、`epic show E001` で逆引きされる。

### Status FSM（4 値）

`active`（Planner 稼働中）→ `closed`（done、Planner が evidence 付きで closed に書き換える）/ `blocked`（budget 超過 / 判断保留 → Master 介入）/ `aborted`（中止）。
詳細は `docs/spec/14-epic.md` §4。

### Epic Planner の起動（Phase 1 PoC = 手動）

別ペインで Claude Code を起動し、`skills/cmux-team/templates/ja/epic-planner.md` の内容をシステムプロンプト相当として読み込ませ、
担当 Epic ID（例: `E001`）を伝えて `/loop` を起動する。
Phase 2 で `elevens epic start E001` が daemon 経由で専用 pane を spawn する想定。

### Hybrid done 判定

Planner が `status=closed` に遷移するときは **evidence を Journal に必ず記録**する:
Intent の Done 条件と、それを満たした証拠（テスト結果 / 関連 Task ID と closed 状態 / artifact 参照 / 判定理由）。
evidence 抜きの closed は仕様違反。`docs/spec/14-epic.md` §7 を参照。

### Budget 超過時

Planner は自身で `status=blocked` に書き換え `/loop` を抜ける。Master / 人間が `elevens epic resume`（budget 増額可）か `abort` を判断。
詳細は `docs/spec/14-epic.md` §8。

> Phase 1 PoC スコープ: CLI + epic.md + Planner template + 手動 `/loop`。daemon 統合 / 自動 spawn / abort cascade / budget hard enforcement は Phase 2。

## 通信プロトコル

### .team/ ディレクトリ構造（主要）

```
.team/
├── tasks/             # タスクファイル（CLI 経由でのみ作成・更新）
├── task-state.json    # タスク状態管理（status: draft/ready/assigned/closed）
├── artifacts/         # Axxx — 知見の記録（直接ファイル作成）
├── output/            # Conductor/Agent の出力（taskRunId 別）
├── logs/              # manager.log + manager.stderr.log + manager.telemetry.jsonl + traces/bodies/
├── traces/            # SQLite トレースDB（traces.db）
├── queue/             # メッセージキュー（incoming/ + processed/）
├── daemon.pid         # daemon 多重起動防止の pidfile
├── daemon.heartbeat   # Manager daemon 死亡時刻検出用 (T010)
└── team.json          # チーム構成（daemon が自動更新。直接書き込み禁止）
```

### 進捗情報の取得方法

**ユーザーは Manager の surface（TUI）をリアルタイムに見ているため、エージェントから `cmux-team status` 等のコマンド案内は不要。**

| 情報 | 取得方法 |
|------|---------|
| Manager の状態 | `cmux-team status` または `cat .team/logs/manager.log` |
| 稼働中 Master / Conductor | `jq .masters .team/team.json` / `jq .conductors .team/team.json` |
| open task 数 | `cat .team/task-state.json` |
| metric サマリ（task lifecycle / tool call / token） | `cmux-team metrics --since 7d` または `cmux-team metrics --group-by day --format csv` |
| Web ダッシュボード（time-series グラフ・分布・drill-down） | `cat .team/team.json \| jq -r .dashboardServer.url` で URL 取得（ephemeral port、daemon 再起動で変わる）。詳細は `docs/spec/12-web-dashboard.md` |

> メトリクス解析・cohort 比較・trace DB の ad-hoc 探索 (DuckDB SQL) は `cmux-team-analyze` skill を参照（CLI: `cmux-team metrics query`）。

### events stream（opt-in watch mode 用）

Manager daemon は外向け event channel として `.team/logs/events.jsonl` に
状態変化を JSONL で append-only に書き出す（schema は `docs/spec/10-events-stream.md` 参照）。

- **default 無効**。user が `/cmux-team:watch` を能動 invoke したときのみ Master が監視を開始する
- 過去 event の遡及処理は行わない（state は外部に持たない）
- `cmux-team events [--follow] [--types <names>] [--format json|tsv]` CLI で tail / filter 可能
- 詳細仕様は `docs/spec/10-events-stream.md`、watch mode の挙動は `commands/watch.md` を参照

> Master template (`skills/cmux-team/templates/master.md`) への自動 watch 組み込みは Phase 2 で別途検討（本節は外部公開チャネルの存在告知のみ）。将来 default 化を検討するかは別 issue で議論する。

## Ready 昇格時の sync state ガード

`cmux-team create-task --status ready` / `update-task --status ready` は昇格前に local と `origin/<mainBranch>` の sync state を判定する。

- `diverged` / `uncommitted` / `detached` → exit 1（`ready_rejected`）
- `behind-ff` + `mainBranch` checkout 中 → **自動 `git pull --ff-only origin <mainBranch>`**。失敗したら exit 1（`ready_auto_pull_failed`）
- `behind-ff` + 他ブランチ checkout 中 / `no-remote` → 警告のみ、昇格続行
- bypass: `--force`（一回限り、sync check 全体 skip）/ `--no-auto-pull`（auto-pull のみ抑止して warn 扱いに）/ `CMUX_TEAM_SKIP_SYNC_CHECK=1`（Conductor/Agent 環境に自動注入）

詳細は `docs/spec/07-state-machine.md` および `docs/spec/05-install-and-infrastructure.md` を参照。

## git worktree（概要）

すべての作業は `.worktrees/<taskRunId>/` 内で行う。main ブランチは常に無傷。

- start-point 優先順位: `explicit`（`base_branch:` 明示）→ `config-local-ahead` → `config-origin` → `config-local` → `head-fallback`
- 正常完了以外の cleanup 経路（abort / reset / disconnect / restart / 手動 `/clear`）では `.team/worktrees-archive/<taskRunId>/` に退避（archive 化）し、branch を残す。詳細は `docs/spec/16-worktree-archive.md`
- 詳細は `docs/spec/05-install-and-infrastructure.md` を参照

## エラーリカバリ

| 障害 | 検出者 | 対応 |
|------|--------|------|
| Agent クラッシュ | Conductor | `cmux-team await-agent` が STATUS=crashed で exit 10 → Conductor が判断 |
| Conductor クラッシュ | Manager | `spawnPidWatcher` が PID 死亡を検出 → `disconnected` → timeout 後 forced close |
| Manager クラッシュ | Master | Manager が応答なし → 再 spawn |
| API レート制限 | 各層 | 待機して再試行、同時 Agent 数を削減 |

state 遷移・cascade・CONDUCTOR_DONE 分岐・rebase conflict 自解決の詳細は `docs/spec/07-state-machine.md` を参照。

## Post-mortem evidence (T010)

Manager daemon が無言で死亡しても WHEN/WHAT/WHY を再構成できるよう、4 軸の永続 file を残す。

| 知りたいこと | 媒体 | 取得方法 |
|---|---|---|
| WHEN (死亡時刻 ±10s) | `.team/daemon.heartbeat` | `stat .team/daemon.heartbeat` の mtime と JSON 内 `ts`。残存していれば異常終了の証拠 |
| WHAT (RSS / heap / event loop / open task) | `.team/logs/manager.telemetry.jsonl` | `tail -20 ... | jq -c '{ts,rss_mb,heap_used_mb,event_loop_lag_ms,open_tasks}'` |
| WHY (JS 例外 / signal) | `.team/logs/manager.log` の `fatal_uncaught` / `fatal_unhandled_rejection` / `signal_received` | `grep -E "fatal_uncaught\|signal_received" .team/logs/manager.log` |
| WHY (Bun runtime panic / Rust panic / libc abort) | `.team/logs/manager.stderr.log` (+ `.1` rotate) | `tail -50 .team/logs/manager.stderr.log` |

config override は `.team/config.json` の `postMortem.{heartbeatIntervalMs,telemetryIntervalMs,telemetryMaxBytes,stderrRotateGenerations}`。手動再現は `scripts/test-crash-evidence.sh` (開発者ローカル前提)。詳細仕様は `docs/spec/15-post-mortem-evidence.md`。

## 既知の注意点

- **Trust 確認**: 新しいディレクトリでの起動時に「Trust this folder?」が出る。タイミングによっては手動介入が必要
- **パーミッション確認**: 最初の確認で「Yes, and allow Claude to edit its own settings for this session」を選択すること
- **API レート制限**: 複数エージェント同時実行で API 過負荷になりやすい。Claude Max 推奨
- **`bun test` 全体実行は禁忌**: O(N²) 級劣化で 13 分以上ハング。`cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` を使う。詳細は `.team/artifacts/A021-research.md` および `.github/workflows/test.yml`。根本対策後に撤去予定
- **トレース検索**: `cmux-team trace-task <id>`

## Artifacts（知見の記録）

調査結果・設計判断・セッション要約は `.team/artifacts/Axxx-<slug>.md` に保存する。

| | Txxx（タスク） | Axxx（アーティファクト） |
|---|---|---|
| 本質 | 「やること」の管理 | 「わかったこと」の記録 |
| 誰が作る | Master / ユーザー（CLI 経由） | 誰でも（`/artifact` 優先、直接作成は spec 厳守時のみ） |

- `type`: `research` / `decision` / `session` / `spec` / `report`
- `author`: surface ID 文字列（例: `surface:100`）
- **新規作成は `/elevens:artifact <type> <タイトル>` を default とする。** `commands/artifact.md` 規定の frontmatter (`id` / `type` / `title` / `created` / `author`) と type 別本文構造（research → 背景／調査結果／比較・分析／結論 等）を漏れなく揃えるため。直接 `Write` は spec を完全遵守できる場合のみ許容（フィールド欠落・章立て逸脱を見落としやすいので非推奨）。
