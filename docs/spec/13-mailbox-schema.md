# 13. Mailbox Schema

> `mailbox.*` 名前空間の formal schema 定義。surface metadata 上で agent / conductor / master が
> 自身の状態を「外部化」して報告し、Manager daemon と将来の FSM / dashboard が観測する経路の契約。

実装: [`skills/cmux-team/manager/mailbox-schema.ts`](../../skills/cmux-team/manager/mailbox-schema.ts) /
書き込み helper: [`skills/cmux-team/manager/c11-features.ts`](../../skills/cmux-team/manager/c11-features.ts) `setMailbox` /
CLI: [`skills/cmux-team/manager/mailbox-cli.ts`](../../skills/cmux-team/manager/mailbox-cli.ts) (`elevens mailbox`)

---

## 1. 位置付けと設計原則

cmux-team は **AI 観察箱（observatory）** であり（[`00-project-overview.md`](00-project-overview.md) /
[`../../CLAUDE.md`](../../CLAUDE.md)）、状態は内部に隠さず **外部化** する。`mailbox.*` は
agent / conductor / master が自身の lifecycle と意思を **surface metadata 上に書き出す形** で外部化する経路。

設計原則（CLAUDE.md「state を外部化」「構造的正しさを優先」）:

| 原則 | 適用 |
|---|---|
| state を外部化 | mailbox.* は surface metadata（c11 backend）に書く。agent の内部 state ではない |
| pull 型観察 | Manager daemon は metadata を poll する（agent からの push に依存しない） |
| 拡張余地 | 未知 `mailbox.*` key は warning にして書き込みを許す（schema 進化のため） |
| 破壊的変更を避ける | canonical key の意味・型は backward compatible にしか変えない |

v0.9.0 (T016) 以降は c11 が唯一の substrate なので、`setMailbox` は常に c11 metadata
書き込みパス上で動く（cmux 時代の opportunistic no-op 経路は撤去済み）。書き込み側は
backend 種別を意識しないインタフェースのまま (歴史的経緯は [`A029`](../../.team/artifacts/A029-c11-parity-and-phase2-prep.md) 参照)。

---

## 2. Canonical key 一覧

下表の 8 key が **型契約を持つ canonical key**。これ以外の `mailbox.*` key は warning として
扱われ書き込みは許可されるが、観測側は**無視してよい**（=コア挙動を変えない）。

| key | 値型 | 例 | 意味 |
|---|---|---|---|
| `mailbox.role` | string (literal union, [§3](#3-mailboxrole-値)) | `"implementer"` | 書き手の役割。`{{ROLE_ID}}` の正規値 |
| `mailbox.status` | string (literal union, [§4](#4-mailboxstatus-値)) | `"running"` | lifecycle 状態 |
| `mailbox.task` | string | `"T123"` / `"123"` | 関連 task の ID（自由形式、TNNN 推奨） |
| `mailbox.task_run_id` | string | `"task-123-1715240000"` | TaskRun の一意 ID |
| `mailbox.progress` | number ∈ [0, 1] | `0.5` | 進捗。dashboard が進捗バーに使う想定 |
| `mailbox.started_at` | ISO 8601 string | `"2026-05-09T10:00:00.000Z"` | 開始時刻 |
| `mailbox.completed_at` | ISO 8601 string | `"2026-05-09T11:00:00.000Z"` | 完了時刻 |
| `mailbox.error` | string | `"context window exceeded"` | エラーメッセージ（status=error/aborted と組み合わせる） |

### 2.1 ISO 8601 timestamp の許容形式

正規表現で以下の形式を受け入れる:

```
YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)
```

例: `2026-05-09T10:00:00Z` / `2026-05-09T10:00:00.123Z` / `2026-05-09T19:00:00+09:00`。

`yesterday` のような自由形式や Unix epoch は弾く。`normalizeIso8601` は parse 可能な ISO 8601
入力を `2026-05-09T10:00:00.000Z` 形式（UTC + ms 3 桁）に揃える。

---

## 3. `mailbox.role` 値

`{{ROLE_ID}}` テンプレート変数（[`04-templates.md`](04-templates.md)）に展開される値の網羅。
8 件の Agent role は `schema.ts` の [`AgentRole`](../../skills/cmux-team/manager/schema.ts) と一致する。

| 値 | 書き手 |
|---|---|
| `master` | Master（ユーザー対話セッション） |
| `conductor` | Conductor |
| `agent` | role 種別が判らない agent 全般（上位互換） |
| `researcher` | Researcher Agent |
| `architect` | Architect Agent |
| `planner` | Planner Agent |
| `design-reviewer` | Design Reviewer Agent |
| `implementer` | Implementer Agent |
| `inspector` | Inspector Agent |
| `dockeeper` | DocKeeper Agent |
| `task-manager` | Task Manager Agent |

エイリアス（`impl` / `reviewer`）は **mailbox 経由では書かない** こと。書き込み前に
`normalizeAgentRole` で canonical 値に直してから set する責務は呼び出し側にある。

---

## 4. `mailbox.status` 値

| 値 | 意味 | 書き込みタイミング |
|---|---|---|
| `running` | 作業中 | agent / conductor 起動直後 |
| `done` | 正常完了 | 完了直前（既存 `done` marker と dual-write） |
| `idle` | アイドル状態 | conductor の待機、claude-hook idle 経路 |
| `error` | エラーで停止 | 例外・rate limit・auth fail などで継続不能になったとき |
| `aborted` | 外部要因で中止 | abort-task / disconnect timeout などで forced close |

`normalizeMailboxStatus` は trim + lowercase で `"DONE"` / `"  done  "` を canonical に揃える。

---

## 5. ライフサイクル別 書き込みパターン

```text
                    role / task / task_run_id / started_at
                    status=running
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
        起動直後         進捗時           完了直前
                    progress=0..1     status=done
                                       completed_at
                                          OR
                                       status=error|aborted
                                       error="..."
```

### 5.1 起動直後（agent / conductor）

```bash
elevens mailbox set --json '{
  "mailbox.role": "implementer",
  "mailbox.status": "running",
  "mailbox.task": "T123",
  "mailbox.started_at": "2026-05-09T10:00:00.000Z"
}'
```

実装は [`templates/{ja,en}/common-header.md`](../../skills/cmux-team/templates/) の
"Status reporting (mailbox)" セクションを参照。

### 5.2 進捗時（任意）

```bash
elevens mailbox set --json '{"mailbox.progress": 0.5, "mailbox.status": "running"}'
```

### 5.3 完了直前（done）

```bash
elevens mailbox set --key mailbox.status --value done
```

既存の `done` marker（`.team/output/conductor-N/done`）と **dual-write**。Manager は
両方を観測でき、片方でも完了と見なす（[`A029`](../../.team/artifacts/A029-c11-parity-and-phase2-prep.md) §3）。

### 5.4 エラー / 中止

```bash
elevens mailbox set --json '{"mailbox.status": "error", "mailbox.error": "context exceeded"}'
```

---

## 6. 観測側（reader）の契約

### 6.1 現状（Phase 2）

- **Manager daemon**: `watchMailbox` (`c11-features.ts`) で 1.5s 間隔 poll、変化を
  trace DB の `hook_signals` に `source='metadata'` で記録（[`daemon-mailbox-watcher.ts`](../../skills/cmux-team/manager/daemon-mailbox-watcher.test.ts)）

### 6.2 将来想定 consumer（実装時に本 spec に追記する）

| consumer | 利用 key | 挙動 |
|---|---|---|
| Task FSM | `mailbox.status` | `status==done` を検出したら既存 done marker と OR で `assigned → closed` 遷移 |
| Web dashboard | `mailbox.progress` / `mailbox.role` | conductor / agent ペイン横に進捗バーを描画 |
| Inspector / retro | `mailbox.error` | error クラスタリング、cohort 比較 |

### 6.3 reader の防御規約

- canonical key は **spec 準拠の値で読む**（`mailbox.status` を `string` ではなく `MailboxStatus` として typed に扱う）
- 未知 `mailbox.*` key は **debug log のみで挙動は変えない**（forward compat）
- 値が型違反のときは無視 + warn log（観測側はクラッシュしない）

---

## 7. Validator / Normalizer の使い方

### 7.1 書き込み側

`setMailbox` は default で `validate: "warn"` モード。型違反は manager.log に warn 出力するが
書き込み自体は続行する（既存呼び出し元の挙動を破壊しない）。

```ts
import { setMailbox } from "./c11-features";

// default (warn): 検証失敗を log するが書き込みは続行
await setMailbox(target, { "mailbox.status": "running" });

// strict: 検証失敗で throw（書き込み前にガード）
await setMailbox(target, payload, { validate: "strict" });

// off: 完全 skip（旧 opportunistic 挙動）
await setMailbox(target, payload, { validate: "off" });
```

### 7.2 読み取り側

```ts
import { validateMailboxPayload, normalizeMailboxPayload } from "./mailbox-schema";

const raw = await getMailbox(target);
const normalized = normalizeMailboxPayload(raw ?? {});
const r = validateMailboxPayload(normalized);
if (r.ok) {
  const status = r.value["mailbox.status"]; // typed as MailboxStatus | undefined
  // ...
} else {
  // r.errors / r.warnings を log
}
```

---

## 8. Schema 進化のルール

mailbox schema は外部 contract（agent prompt template / dashboard / FSM）に組み込まれるため、
**backward compatible な変更のみ許可** する。

### 8.1 許される変更（additive）

- 新しい canonical key を追加（既存 reader は無視で OK）
- `MailboxRole` / `MailboxStatus` に新値を追加（既存 writer / reader は古い値を引き続き扱える）
- 新しい normalizer / validator helper の追加

### 8.2 許されない変更（breaking）

- 既存 canonical key の **削除**（reader が壊れる）
- 既存 canonical key の **意味の変更**
- `MailboxRole` / `MailboxStatus` から既存値を削除
- 値型の不互換変更（string → number 等）

### 8.3 Deprecation 手順

1. 新しい canonical key を追加（spec に「old_key の後継」と明記）
2. writer 側で **dual-write** 期間を設ける（複数 release）
3. reader 側で新 key を fallback として読む期間を経たあと
4. 最低 1 メジャーバージョン後に old key を「optional / soft-deprecated」と spec に記載
5. 削除は最低 2 メジャーバージョン後（CHANGELOG に記録）

未知 `mailbox.*` key を warning にする方針はこの soft-deprecation を回しやすくするため。

---

## 9. テスト

| ファイル | 観点 |
|---|---|
| [`mailbox-schema.test.ts`](../../skills/cmux-team/manager/mailbox-schema.test.ts) | canonical key の正常 / 型違反 / 未知 key warning / normalizer pure 性 |
| [`c11-features.test.ts`](../../skills/cmux-team/manager/c11-features.test.ts) | `setMailbox` の `validate: "strict"` / `"warn"` / `"off"` 経路 |
| [`mailbox-cli.test.ts`](../../skills/cmux-team/manager/mailbox-cli.test.ts) | CLI 経由で validate route が走る smoke |

---

## 10. 関連 spec / artifact

- [`04-templates.md`](04-templates.md) — `{{ROLE_ID}}` プレースホルダ仕様
- [`07-state-machine.md`](07-state-machine.md) — Task FSM（将来 `mailbox.status` で遷移）
- [`A029`](../../.team/artifacts/A029-c11-parity-and-phase2-prep.md) — mailbox.* 設計の発端
- [`A031`](../../.team/artifacts/A031-claude-hook-and-daemon-smoke.md) — claude-hook 経由の status 書き込み運用知見
