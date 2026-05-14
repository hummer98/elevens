# 14. Epic（PoC）

> Task / Artifact と並ぶ第三のカテゴリ。「達成したい E2E シナリオと勘所」をユーザーが定義し、
> 細かい Task 分解と実装判断は Epic Planner（`/loop` 自律エージェント）に委譲する。
> Master / Manager / Conductor / Agent の 4 層構造の **上位 orchestration layer**。

実装: [`skills/cmux-team/manager/epic.ts`](../../skills/cmux-team/manager/epic.ts) /
CLI: [`skills/cmux-team/manager/main.ts`](../../skills/cmux-team/manager/main.ts) (`elevens epic`) /
template: [`skills/cmux-team/templates/ja/epic-planner.md`](../../skills/cmux-team/templates/ja/epic-planner.md)

**Phase 1 PoC** — 本仕様は最小実装 (CLI + epic.md + Planner template + 手動 `/loop`) を定義する。
daemon 統合 / dashboard / 自動 spawn / 自動 budget enforcement は Phase 2 以降。

---

## 1. 位置付けと設計意図

| 観点 | Task | Artifact | **Epic** |
|---|---|---|---|
| 本質 | 「やること」単位作業 | 「わかったこと」知見記録 | 「達成したいゴール」上位目標 |
| ライフサイクル | FSM 6 値 (`draft/ready/...`) | immutable | 4 値 (`active/blocked/closed/aborted`) |
| 書き込み主体 | CLI 強制（hook block） | 誰でも直接 | CLI 強制（hook block） |
| ファイル形態 | `.team/tasks/NNN-slug/task.md` (dir) | `.team/artifacts/ANNN-slug.md` (file) | `.team/epics/ENNN-slug.md` (file) |
| 実行主体 | Conductor / Agent | 無し（受動） | Epic Planner (`/loop`) |
| 親子関係 | `depends_on` で Task 同士 | `task:` で Task 参照 | Epic → 複数 Task（`epic_id` で逆引き） |

### なぜ独立カテゴリにするか

- **FSM 形状が違う**: Task は single-assignment、Epic は再分解 cycle あり
- **書き込みポリシーが違う**: Task は state machine 制約、Artifact は immutable、Epic は Planner が prose を頻繁に書き換える
- **関係グラフが違う**: Epic を Task に押し込むと「Task が Task を spawn する」再帰になり observability が崩れる

設計原則 (CLAUDE.md「state を外部化」「構造的正しさを優先」) :

| 原則 | Epic での適用 |
|---|---|
| state を外部化 | epic.md (frontmatter + body) のみが source of truth。Planner は wakeup ごとに cold start で read |
| pull 型観察 | Planner は外向きに push せず、Master / dashboard は epic.md を pull で観察 |
| 各層は自分の仕事だけ | Master = intake / 承認、Planner = 分解 / 再分解 / done 判定、Conductor / Agent = 実作業（既存どおり） |
| 安全に失敗 | budget 超過時は `blocked` で自動停止、escalate して人間判断を仰ぐ |
| 構造的正しさ | system 管理は status (4 値) と budget limits のみ。残りは prose（minimal structured surface） |

---

## 2. ファイルレイアウト

```
.team/epics/
└── E001-<slug>.md     # 単一 markdown ファイル（frontmatter + body）
```

- ID は `E` + 3 桁 zero-pad（`E001` 〜 `E999`）。Artifact (`A001`) と同じ pattern
- ファイル名は `E001-<slug>.md`。slug は title から自動生成
- ディレクトリ構造は持たない（attempts/ 等は本文 journal に prose で集約する設計判断）

---

## 3. Frontmatter スキーマ

```yaml
---
id: E001
title: "ユーザーが artifact を全文検索できる"
status: active                # active | blocked | closed | aborted
created: 2026-05-15T09:00:00.000Z
updated: 2026-05-15T10:30:00.000Z   # optional, Planner が更新
created_by: surface:1         # author surface（Master が作成）
budget:
  token: 500000               # 累計 input + output token 上限
  iteration: 30               # /loop wakeup 回数の上限
  wall_clock_hours: 24        # epic start からの経過時間上限（hours）
---
```

### 必須フィールド

- `id` / `title` / `status` / `created` / `created_by` / `budget.*` (3 全部)

### budget 制約

- `budget` は **limits のみを宣言**。consumption は trace DB から派生（[§8](#8-budget)）
- いずれか 1 つが上限に達すると Planner は自身で `status=blocked` に遷移して停止

### Validation

- `status` は 4 値のうちのいずれか
- `budget.token` / `budget.iteration` は正の整数
- `budget.wall_clock_hours` は正の数値（小数許容）
- `created` / `updated` は ISO 8601

---

## 4. Status FSM（4 値）

```
active ──(Planner: done 主張 + evidence)──> closed
   │
   │──(Planner: budget 超過 / 自己判断 blocked)──> blocked ──(Master: resume)──> active
   │                                                    └──(Master: abort)──> aborted
   │
   └──(Master: abort)──> aborted
```

| 状態 | 意味 | 遷移元 | 遷移先 |
|---|---|---|---|
| `active` | Planner が `/loop` で稼働中 / 再分解中 | (新規 create) | `blocked` / `closed` / `aborted` |
| `blocked` | budget 超過 / Planner が判断保留 → 人間判断待ち | `active` | `active` (resume) / `aborted` |
| `closed` | done 判定済み（evidence あり、不可逆） | `active` | （終端） |
| `aborted` | 中止（不可逆） | `active` / `blocked` | （終端） |

**Terminal 判定**: `closed` / `aborted` の 2 値。Planner の `/loop` は terminal で停止する。

### 遷移経路

| 経路 | 主体 | CLI / 操作 |
|---|---|---|
| `create` → `active` | Master（または Planner 自身が初期化完了時） | `elevens epic create ...` |
| `active` → `closed` | Planner | epic.md を直接 Edit（status と journal の evidence を更新） |
| `active` → `blocked` | Planner | 同上（budget 超過 / 判断保留時） |
| `blocked` → `active` | Master / 人間 | `elevens epic resume E001` |
| `active` / `blocked` → `aborted` | Master / 人間 | `elevens epic abort E001` |

> **Phase 1 PoC**: status 遷移は **Planner が epic.md を直接 Edit** することで行う（Task の CLI 強制と異なる）。
> Master の `resume` / `abort` のみ CLI 経由。Phase 2 で全遷移を CLI 化するか検討する。

---

## 5. Markdown body 規約

frontmatter 以降の本文は **3 セクション**を推奨（必須ではない、Planner の判断で構成可）:

```markdown
## Intent（E2E シナリオ + 勘所）

ユーザーが Master との対話で書き下した部分。**start 後は immutable**（Planner は変更しない）。

- 達成したい E2E シナリオ（具体的に。「ユーザーが X して Y を見られる」）
- 設計の勘所 / アーキテクチャ制約（守ってほしい不変条件）
- Done 条件（測定可能な記述。テスト名・出力例・UI 動作など）

## Current Plan（Planner が随時更新）

現在の Task 分解と進捗。Planner が `/loop` 各 wakeup で必要に応じて書き換える。

- [ ] T101: ...
- [x] T102: ... (closed)
- [ ] T103: ...

## Journal（append-only）

Planner の意思決定ログ。新しいエントリは下に追記する（**逆順にしない**、append-only）。

### 2026-05-15T09:30:00Z — initial planning
...

### 2026-05-15T11:15:00Z — re-plan after T102 closed
...
```

### 規約

- **Intent は immutable**: Master が start 後は変更しない。変更したい場合は abort → 新 Epic
- **Current Plan は overwrite OK**: Planner が随時上書き
- **Journal は append-only**: 過去エントリを編集しない（observatory 原則 — 履歴を残す）

---

## 6. Task との link

Task frontmatter に `epic_id` フィールドを追加し、Epic → Task の親子関係を表現する。

```yaml
# .team/tasks/NNN-slug/task.md
---
id: 042
title: ...
epic_id: E001            # ← 追加（optional）
created_by: surface:1
...
---
```

- `epic_id` は **optional**。Epic 配下でない Task は付けない（既存 Task は影響を受けない）
- CLI: `elevens create-task --epic-id E001 ...`
- 逆引き: `elevens epic show E001` は `epic_id: E001` の Task を一覧表示する

### Cascade（Phase 2）

- Epic abort → 配下 active Task の自動 abort cascade は **Phase 2**。PoC では Planner / 人間が手動で abort
- 既存の `depends_on` cascade (PARENT_ABORTED) には影響を与えない

---

## 7. Hybrid done 判定

Epic の `done`（`status=closed` への遷移）は Planner が判定するが、**evidence 必須**。

### Evidence の最低要件

`status=active → closed` 時に Planner は journal に以下を含むエントリを追記する:

1. **Done 条件の参照** — Intent の Done 条件を引用または箇条書きで列挙
2. **各条件への evidence**:
   - テスト結果（`bun test` の output / pass log）
   - 関連 Task ID と closed 状態
   - artifact 参照（`A042-validation-report.md` 等）
   - 必要に応じて trace 抜粋
3. **判定理由** — なぜ「全部満たした」と判断したか（1〜3 段落の prose）

### Evidence なし closed の扱い

- Planner が evidence 抜きで `status=closed` を書いた場合、それは仕様違反（spec gaming）
- Phase 2 で自動 lint（journal に evidence セクションがあるか）を検討するが、PoC では人間レビューで担保

---

## 8. Budget

### Limits（frontmatter）

3 軸の上限を `budget.*` で宣言:

- `budget.token`: Planner + 全 child Conductor / Agent の累計 input + output token
- `budget.iteration`: Planner の `/loop` wakeup 回数
- `budget.wall_clock_hours`: epic `created` からの経過時間（hours）

### Consumption（trace DB から派生）

書き込みは **limits のみ**。consumption は読み取り時に trace DB を query して計算する:

```sql
-- token 消費（Planner session + Epic 配下 Task の session すべて）
SELECT SUM(input_tokens + output_tokens) AS tokens
FROM api_usage
WHERE task_id IN (
  SELECT id FROM tasks WHERE epic_id = 'E001'
)
   OR session_id IN (
  SELECT session_id FROM task_sessions WHERE epic_id = 'E001'
);
```

> Phase 1 PoC では Planner が自己観察として trace DB を query する想定。
> CLI `elevens epic show` で同じ計算を行い、人間にも budget 消費が見える。

### Overflow 時の挙動

- いずれかの limit に到達 → Planner は自身で `status=blocked` に遷移し journal にエントリを追記して停止
- Master / 人間が `elevens epic resume E001` で再開（budget を増額した場合）か `abort` する
- Phase 2 で daemon side の hard enforcement（Planner pane の自動 kill 等）を検討

---

## 9. CLI surface（Phase 1）

```bash
# 新規作成（draft 相当）
elevens epic create --title "TITLE" [--body "INTENT"] [--budget-token 500000] [--budget-iteration 30] [--budget-hours 24]

# 一覧
elevens epic list [--status active|blocked|closed|aborted|all]

# 詳細表示（frontmatter + body + Task 配下一覧 + budget 消費）
elevens epic show E001

# blocked → active（Planner 再開）
elevens epic resume E001 [--budget-token N] [--budget-iteration N] [--budget-hours N]

# active / blocked → aborted
elevens epic abort E001 [--reason "..."]
```

**Phase 1 では `start` サブコマンドは提供しない。** Planner の `/loop` は **手動起動**:

```bash
# 別ペインで Claude Code を起動 → epic-planner.md template を読み込んだ状態で /loop を実行
# 詳細は CLAUDE.md および epic-planner.md template 参照
```

Phase 2 で `elevens epic start E001` が daemon 経由で専用 pane を spawn する想定。

---

## 10. 既存 spec / glossary との関係

- [`07-state-machine.md`](07-state-machine.md): Task FSM は影響なし。`epic_id` は frontmatter optional 拡張
- [`08-runtime-boundary.md`](08-runtime-boundary.md): close-task の Deliverable 仕様は影響なし
- [`11-metrics.md`](11-metrics.md): trace DB スキーマ拡張なし（Task の `epic_id` は frontmatter 経由で間接結合）
- [`glossary.md`](glossary.md): Epic / epic_id / Epic Planner / Epic FSM 状態を追加（本仕様の作成と同時に更新）

---

## 11. Phase 2 候補（PoC 後）

- `elevens epic start` で daemon が専用 Planner pane を spawn
- Epic abort → 配下 active Task の cascade abort
- budget hard enforcement（pane 自動 kill）
- events stream (`.team/logs/events.jsonl`) への epic state 変更 emit
- Web dashboard の epic surface（時系列・budget gauge）
- Hybrid done の evidence lint（自動チェック）
- Master template の `epic_intake` 手順組み込み
- E2E test platform 統合（Done 条件を実行可能テストとして書ける拡張）
