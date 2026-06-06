# T029 plan: events.jsonl への汎用 signal 投稿 CLI（best-effort 協調）

## 1. 概要

`.team/logs/events.jsonl` に **typed daemon event とは別経路** で自由 type のユーザー signal を 1 行 append できる
書き手 `emitUserSignal()` を `events-writer.ts` に追加し、薄い CLI `elevens events emit --type <name> ...`
として `events-cli.ts` に routing する。daemon round-trip 無し、新規 state file 無し、lock/lease 無し。
reader (`events --follow --types ...`) で別セッションが拾えるよう、KNOWN_EVENTS skip を「`--types` で明示購読された
event 名は通す」最小緩和する。

## 2. 変更ファイル一覧

### 既存ファイル（修正）

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/events-writer.ts` | `emitUserSignal()` / `RESERVED_EVENTS` set / 型レベル乖離検出を追加 |
| `skills/cmux-team/manager/events-cli.ts` | `runEventsCli` 入口で `args[0]==="emit"` を検出して `runEmitSubcommand()` に振る。`processLine` の KNOWN_EVENTS skip を `--types` 明示購読時のみ通す形に緩和 |
| `skills/cmux-team/manager/events-writer.test.ts` | `emitUserSignal` のテスト追加 |
| `skills/cmux-team/manager/events-cli.test.ts` | `emit` サブコマンドのテスト + reader 互換テスト追加 |
| `docs/spec/10-events-stream.md` | §6.20「user-signal（free-form event）」追加 + §8 reader 動作の更新 + §5 ヘッダ件数調整 |
| `commands/watch.md` | §reader 動作の表（L322 等）を spec §8 と整合させて更新（実装変更があるため 1 行修正） |
| `README.md` | `elevens events` 行の隣に `elevens events emit ...` を 1 行追加（任意・最小） |

### 新規ファイル

なし。

### 触らないもの（明示）

- `main.ts` — `cmdEvents()` は `args.slice(1)` をそのまま渡しており、先頭が `emit` でも変更不要
- `EventStreamRecord` union / `emitEvent()` シグネチャ — typed daemon event は完全無改変
- `EVENTS_SCHEMA_VERSION` — bump しない（add-only）
- `--types` / `--since` / `--format` の API 形 — 引数互換は維持

## 3. 設計判断（タスク §「設計上の論点」への回答）

### 3.1 free-form writer 関数のシグネチャと配置

`skills/cmux-team/manager/events-writer.ts` に **新規 export** として追加する。

```typescript
export interface UserSignalRecord {
  /** event 種別（自由文字列）。snake_case 推奨、`signal:` prefix 推奨。 */
  event: string;
  /** 短い説明。任意。 */
  message?: string;
  /** 投稿主の識別子。任意。CLI 側で env から自動補完されることがある。 */
  actor?: string;
  /** 追加メタデータ。任意。値型は最小公約数として string で固定。 */
  data?: Record<string, string>;
}

export async function emitUserSignal(record: UserSignalRecord): Promise<void>;
```

設計理由:

- `emitEvent(EventStreamRecord)` の discriminated union を `string` に潰すと typed daemon event 側の網羅性が失われる。
  「typed union を守る × free-form を 1 経路足す」ためには **別関数** が最小。
- 既存 `emitEvent` 内部の append ロジック（`mkdir → appendFile`、書き込み失敗時 `manager.log` に
  `events_writer_error` を残す、`schema_version`/`ts` を writer 側で注入）を **共有プライベート関数に extract** して
  両者から使う。`emitEvent` のテスト挙動は変わらない。
- record の JSON shape: `{ ts, schema_version, event, message?, actor?, data? }` の順で `JSON.stringify`。
  optional field は値が `undefined` のとき key ごと省略（既存 `emitEvent` と同等の挙動を維持）。

### 3.2 actor 自動解決

env を実装で確認した結果:

| env | 存在 | 値の例 |
|---|---|---|
| `CMUX_SURFACE` | ✓ | `surface:5` |
| `CMUX_ROLE` | ✗ | — |

→ **`process.env.CMUX_SURFACE` を唯一の自動解決ソース**にする。`CMUX_ROLE` 相当は env として存在せず、
role は hook script の `--role` flag で都度渡されているだけ。引数で `--actor` が明示されればそちらを優先。
両方無ければ record から `actor` field を完全に省略する（`"unknown"` を埋めない — 観測者がフィルタしやすい）。

CLI 側ヘルパに集約:

```typescript
function resolveActor(explicit: string | undefined): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.CMUX_SURFACE;
  return env && env.length > 0 ? env : undefined;
}
```

### 3.3 `emit` の引数 parser を `runEventsCli` 内で routing するか

**入口 1 行で振り分け、parser は別関数に切り出す**。

```typescript
export async function runEventsCli(opts: RunEventsCliOpts): Promise<number> {
  if (opts.args[0] === "emit") {
    return runEmitSubcommand({ ...opts, args: opts.args.slice(1) });
  }
  // 既存 logic（parseArgs / runOnce / runFollowLoop）はそのまま
}
```

理由:

- 既存 `parseArgs` の `KNOWN_FLAGS` / `FLAGS_WITH_VALUE` と emit 用 flags（`--type` / `--message` / `--actor` /
  `--data` / `--help`）は集合が完全に別。混ぜると相互排他チェックが膨らむ
- `runEmitSubcommand` は同期的に append 1 回呼ぶだけなので `AbortSignal` は受け取るが loop しない
  （runEventsCli の既存 stream / follow loop と lifecycle 共存しない）
- main.ts 側 (`cmdEvents`) は完全無改変

### 3.4 予約名一覧の単一ソース化

EventStreamRecord union は型なので runtime 抽出できない。**runtime set を別途定義 + 型レベル乖離検出** を採用する:

```typescript
export const RESERVED_EVENTS = new Set<string>([
  "task_created", "task_ready", "task_assigned",
  "task_completed", "task_completed_state_mismatch",
  "task_aborted", "task_sync_guard_rejected", "task_reverted_to_ready",
  "conductor_running", "conductor_recovered", "conductor_disconnected",
  "conductor_asking", "conductor_done_unresolved",
  "conductor_start_timeout", "conductor_assign_timeout", "conductor_disconnect_timeout",
  "api_error_received", "mailbox_changed",
  "artifact_added", "reload_failed", "worktree_archived",
]);

// 型レベル網羅性アサーション: 新 typed event が union に追加されたら type error で気づく。
type _AssertReservedCoversUnion =
  Exclude<EventStreamRecord["event"], typeof RESERVED_EVENTS extends Set<infer S> ? S : never> extends never
    ? true
    : never;
const _reservedExhaustivenessCheck: _AssertReservedCoversUnion = true;
void _reservedExhaustivenessCheck;
```

メンテ手順は 1 箇所（events-writer.ts）。型レベルチェックが乖離を即時 fail させる。

ハードコード set は events-cli.ts の `KNOWN_EVENTS`（17 ぶん、artifact_added / worktree_archived / mailbox_changed /
reload_failed が抜けている）とは別の責務（events-cli 側は formatter 対象、events-writer 側は予約名）なので統合しない。

### 3.5 `--data k=v` の複数指定パースと値型

- **複数指定**: `--data foo=bar --data x=1` → `{ foo: "bar", x: "1" }`（直前指定が後勝ち）
- **split**: 最初の `=` のみで split（`--data url=https://example.com` も `{ url: "https://example.com" }` として通る）
- **値型**: 文字列固定。number / bool に解釈しない（reader 側の interpret 自由度を残す、CLI 側の暗黙変換を避ける）
- **キー検証**: 空キー (`--data =v`) は exit 1。`=` を含まない (`--data foo`) も exit 1
- record 上の表現: `data: { ... }` ネスト object。空 (`{}`) なら field ごと省略

### 3.6 直接 append の atomicity

既存 `emitEvent` と同じく **`appendFile()` 1 回呼び**で足りる。

- POSIX: `O_APPEND` での `write()` < `PIPE_BUF` (≥512B) は atomic。1 record は数 KB 以下を想定（巨大 `--message`
  や `--data` を投げる use case は無い）
- 既存 `events-writer.test.ts` の「Promise.all で 100 件並行 emit → 全行 JSON.parse 成功」テストがこれを担保済み
- daemon 停止中の CLI 投稿でも同様（writer は同一実装）
- 上限の予防策として `JSON.stringify` 後のサイズ > 4096B なら stderr に soft warn（投稿は通す）を 1 行出す

### 3.7 reader 互換性（KNOWN_EVENTS skip の最小緩和）— **追加の重要決定**

タスクには「reader は無改修」と書かれているが、調査の結果 `events-cli.ts:303-307` の
`if (!KNOWN_EVENTS.has(event)) { ... skip ... }` が **Done 条件「`elevens events --follow --types deploy_started`
で別セッションが拾える」と衝突** していることが判明した（自由 type は KNOWN_EVENTS に無いので skip される）。

**最小変更**: `--types` で明示購読された event 名は KNOWN_EVENTS に無くても通す。フィルタなしの全件読みでは
従来通り skip + warn を維持する。

```typescript
// processLine(): 既存
if (!KNOWN_EVENTS.has(event)) {
  // 変更: --types で明示購読されていれば通す。されていなければ従来通り skip+warn。
  if (!(ctx.parsed.types && ctx.parsed.types.has(event))) {
    ctx.stderr.write(`warn: skipping record with unknown event=${event} ...\n`);
    return;
  }
}
```

この緩和は:

- **既存テスト #10「event=foo_event_unknown は skip + warn」を破壊しない**（テストは `--types` 指定無し）
- forward-compat（writer が新 typed event を追加し古い reader が動くケース）の skip 挙動は保持
- user signal は **明示購読モデル** として spec に明記する
- CLI 引数の interface 形状は無改修（`--types`/`--follow` の意味は変わらない、内部 filter logic のみ）

### 3.8 予約名衝突 warn

`--type` の値が `RESERVED_EVENTS` に含まれる場合のみ:

```
warn: --type <name> は typed daemon event 名と衝突します（投稿は通します）。
      `signal:` prefix の使用を推奨します。例: --type signal:deploy_started
```

を `stderr` に 1 行書いてから投稿する。exit 0。spec に prefix 規約（`signal:` 推奨、`deploy_*` も慣例として可）
を明記。

## 4. 実装ステップ（TDD 順序）

### Step 1: spec docs を先に確定（契約優先）

- `docs/spec/10-events-stream.md` を編集:
  - §5 概要表に「User signal（free-form, 1 event family）」を 1 行追加し合計 event 数を更新
  - §6.20 新節「User signal (free-form event)」を追加（schema / 推奨 prefix / 予約名衝突挙動 /
    daemon 停止中の投稿可 / reader 動作）
  - §8「Reader 実装ガイドライン」を「unknown event は **`--types` で明示購読された場合は通す**、
    それ以外は skip + warn」に更新
  - §9 関連 / §後続タスク表に T029 を追加
- `commands/watch.md` L322 の「未知 `event` は KNOWN_EVENTS で skip + warn」を spec §8 と整合させて
  最小修正（watch は `--types` で明示 filter している運用なので実害なし、表現の整合だけ）
- 既存テストへの影響を再確認（spec 変更が test を壊さないこと）

### Step 2: emitUserSignal の RED テスト

`events-writer.test.ts` に以下を追加:

- `W1` 最小: `emitUserSignal({ event: "signal:deploy_started" })` → 1 行 append、`schema_version=2` / `ts` ISO 8601 /
  `event` / 他 field 無し
- `W2` 全 field: `event`/`message`/`actor`/`data` 込み round-trip
- `W3` optional field 省略時に record key ごと省略される（`"actor" in rec === false`）
- `W4` `data: {}` 空 object のときは `data` key を省略
- `W5` 並行 5 件 → 全行 JSON.parse 成功 + 行数一致
- `W6` `emitEvent`（既存 typed）と混在 append → 行順保持・全件パース可
- `W7` 書き込み失敗時に throw しない / `manager.log` に `events_writer_error` を残す（既存 emitEvent と同等）
- `W8` RESERVED_EVENTS に「全 typed event 名が含まれている」を runtime でも確認（型レベルアサートと別経路の保険）

### Step 3: emitUserSignal の GREEN 実装

`events-writer.ts` を編集:

- 既存 `emitEvent` の append/error handling を private `writeJsonlLine(line, eventName)` に extract
- `emitUserSignal(record)` を追加（上記シグネチャ）
- `RESERVED_EVENTS` set + 型レベル乖離検出 const を追加
- `EVENTS_SCHEMA_VERSION` / 既存 export は無改変

### Step 4: emit サブコマンド + reader 互換の RED テスト

`events-cli.test.ts` に追加:

- `E1` `emit --type signal:deploy_started --message "started"` → exit 0、stderr 空、events.jsonl 1 行追加
- `E2` `E1` の続きで `runEventsCli({ args: ["--types", "signal:deploy_started"] })` (= reader) が
  その 1 行を stdout に出力する（**KNOWN_EVENTS 緩和の Done 条件動作確認**）
- `E3` `emit --type task_completed --message "fake"` → stderr に予約名 warn、exit 0、行は追加される
- `E4` `CMUX_SURFACE=surface:42` set + `emit --type signal:x` → record.actor === "surface:42"
- `E5` `--actor manual` 明示 → env より優先
- `E6` env 未設定 + `--actor` 省略 → record に `actor` field 無し
- `E7` `--data foo=bar --data x=1` → record.data === `{foo:"bar", x:"1"}`
- `E8` `--data foo=https://example.com/?a=1&b=2` → 最初の `=` で split、値は full URL
- `E9` `--type` 欠落 / `--type ""` → exit 1、stderr に説明
- `E10` `--data` 値が `=` を含まない (`--data foo`) → exit 1
- `E11` `--data =v` 空キー → exit 1
- `E12` 未知 flag `--bogus` → exit 1
- `E13` `--help` → exit 0、usage 出力
- `E14` daemon 停止相当（events.jsonl が無い状態）で `emit` → mkdir 後に append 成功（最初の 1 件で
  ファイル生成）。Reader 側の「not found なら exit 1」挙動は emit 経路には適用しない
- `E15` 既存テスト #10「event=foo は --types なしで skip + warn」が引き続き green であること
  （新規 test として明示し regression を見張る。既存 #10 はそのまま残す）

### Step 5: emit サブコマンド + KNOWN_EVENTS 緩和の GREEN 実装

`events-cli.ts` を編集:

- `runEventsCli` 入口に `if (opts.args[0] === "emit") return runEmitSubcommand(...);`
- `runEmitSubcommand(opts)` を追加（parser + actor 解決 + 予約名 warn + emitUserSignal 呼び出し）
- emit 用引数 parser を別関数 `parseEmitArgs` に置く（既存 `parseArgs` には触らない）
- `processLine` の KNOWN_EVENTS skip を §3.7 のとおり緩和
- emit の help テキストは i18n の `help_events` には混ぜず、emit 独自のサブ help を追加（`help_events_emit`）

### Step 6: ドキュメント更新の仕上げ

- README.md の `elevens events` 行隣に 1 行追加: `elevens events emit --type <name> [--message ...] [--actor ...] [--data k=v]...`
- spec §6.20 に実装版の確定 syntax を反映（Step 1 で書いたものに微修正があれば取り込む）

## 5. テスト計画

### 5.1 ケース一覧

§4 Step 2 (W1–W8) と Step 4 (E1–E15) の合計 23 ケース。最小ケースは:

- **emit → events.jsonl に 1 行 append**: W1, E1
- **schema_version=2 / ts 自動付与**: W1
- **reader (`--types <name>`) で拾える**: E2（最重要 — Done 条件直結）
- **daemon 停止中でも投稿・監視できる**: E14（投稿側）。監視側は既存 reader が file tail のみで daemon 不要なので
  追加テスト不要（events.jsonl が存在しさえすれば read できる、既存テスト #2 で担保済み）
- **既存 typed event の型安全性が壊れていない**: W6 + RESERVED_EVENTS の型レベルアサート + `bun test ./events-writer.test.ts`
  既存ケースの green 維持

### 5.2 実行コマンド（**`bun test` 全体実行は禁忌**）

```bash
cd skills/cmux-team/manager

# writer 側
bun test --timeout 30000 events-writer.test.ts

# CLI 側
bun test --timeout 30000 events-cli.test.ts

# 影響範囲確認（events を直接 import している test の全 green を念のため）
bun test --timeout 30000 dashboard-events.test.tsx 2>/dev/null || true
```

### 5.3 手動 E2E 確認（実機）

別ターミナル 2 つで:

```bash
# T1 (watcher)
elevens events --follow --types signal:deploy_started,signal:deploy_finished --format text

# T2 (publisher)
elevens events emit --type signal:deploy_started --message "rolling out v1.2.3"
sleep 5
elevens events emit --type signal:deploy_finished --data version=v1.2.3 --data env=prod
```

T1 に 2 件出ること、`CMUX_SURFACE` が set されていれば actor が自動補完されることを確認。
daemon を `cmux-team kill` で落とした状態でも同じ手順で投稿・監視できることを確認。

## 6. リスク・スコープ外

### 6.1 リスク

| リスク | 対策 |
|---|---|
| 自由 type の濫用で events.jsonl が肥大化 | spec §7 の retention policy（無制限 append + 別タスクで GC）に従う。本タスクで rotate は導入しない |
| 予約名 warn を無視して typed event 名で投稿される | hard block しない方針（タスク §3 指示）。reader 側は data fields を見て typed event と user signal を区別できる（user signal は task_id 等の typed payload を持たない） |
| KNOWN_EVENTS 緩和が想定外の reader 挙動変更を起こす | **`--types` で明示購読された場合のみ通す** に限定。既存テスト #10（`--types` なしでの自動 skip）はそのまま green |
| 型レベル乖離検出が build 環境差で fail する | TypeScript の `Exclude` 型は十分枯れている。tsc strict / Bun 双方で動くシンプルなパターンに留める |
| RESERVED_EVENTS のメンテ漏れ | 型レベルアサート + W8 の runtime テストで二重防衛 |

### 6.2 スコープ外（明示）

タスク要件に従い、本実装では **以下を作らない**:

- ❌ lock / lease / 排他 / 二重実行ガード
- ❌ daemon round-trip（CLI が直接 file append する）
- ❌ 新規 state file（events.jsonl 1 本のみ）
- ❌ 予約名の hard block（warn のみ）
- ❌ `--data` の type 推論（string 固定）
- ❌ rotate / retention（spec §7 に従う）
- ❌ Master template (`skills/cmux-team/templates/master.md`) への自動 watch 組み込み
  （spec §10 「Master template への自動 watch 組み込みは Phase 2」の方針継続）
- ❌ `emit` の dry-run / batch / file-input モード

### 6.3 確認ポイント（実装者へ）

- `events-writer.ts` の `emitEvent` 既存 export とテスト挙動は完全無改変であること
- `EVENTS_SCHEMA_VERSION` は bump しない（v2 のまま）
- `commands/watch.md` の挙動が変わらないこと（`--types` で明示購読しているので KNOWN_EVENTS 緩和の影響を受けない）
- daemon 動作中でも CLI emit が並行 append で torn-write を起こさないこと（W5 / E1 が担保）
