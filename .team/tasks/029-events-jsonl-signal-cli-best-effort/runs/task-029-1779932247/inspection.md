# T029 Inspection Report — events.jsonl への汎用 signal 投稿 CLI（best-effort 協調）

## 1. 判定

**GO**

設計（plan + design review）と実装、テスト、spec 更新が完全に整合。Design Review §3.1（型レベル乖離検出が `as const` literal tuple パターンで実装され、実機で網羅性を検出する）と §3.2（「reader 無改修」解釈の明文化）の必須事項を含め、Done 条件 1〜5 と重点観点 1〜8 はすべて満たされている。Implementer の変更は明示スコープを越えておらず、typed daemon event の discriminated union を含む既存 export はすべて無改変。

---

## 2. テスト実行結果（実機）

作業ディレクトリ: `skills/cmux-team/manager`

| コマンド | 結果 |
|---|---|
| `bun test --timeout 30000 events-writer.test.ts` | **32 pass / 0 fail / 236 expect()** — 83ms |
| `bun test --timeout 30000 events-cli.test.ts` | **36 pass / 0 fail / 151 expect()** — 183ms |
| `bunx tsc --noEmit \| grep -c "error TS"` | **8 errors（全て既存ファイル由来）** |

`bunx tsc --noEmit` のエラー 8 件はすべて既存ベースライン由来（`c11-features.test.ts` 2 件、`c11-features.ts` 2 件、`mailbox-cli.ts` 3 件、`main.ts` 1 件）。今回変更した `events-writer.ts` / `events-cli.ts` / `events-writer.test.ts` / `events-cli.test.ts` / `i18n.ts` 由来のエラーは **ゼロ**（`bunx tsc --noEmit 2>&1 | grep -E "events-writer|events-cli|i18n\.ts"` で出力なしを確認）。

---

## 3. Done 条件チェックリスト

| # | Done 条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | `events emit --type <name> --message "..."` で events.jsonl に 1 行 append される（schema_version=2 / ts 自動付与） | ✓ | W1（writer 直）/ E1（CLI 経由）が green。schema_version=2 と ISO 8601 ts (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`) を assertion 済み |
| 2 | 別セッションが `events --follow --types <name1>,<name2>` で投稿を拾える（自由 type が KNOWN_EVENTS skip で消えない） | ✓ | E2（non-follow reader が `--types` 購読で自由 type を拾う）+ E16（follow reader が 2 件目以降 emit を tail で pickup）が green。`processLine` で `--types` 明示購読時の KNOWN_EVENTS skip 緩和 (`events-cli.ts:307-317`) が実装済み |
| 3 | daemon 停止中でも投稿・監視が機能する（events.jsonl 不在からの初回生成 + --follow tail） | ✓ | E14（events.jsonl 不在 → emit が `mkdir → appendFile` で初回生成）+ E16（同じ E2E で follow reader が初回 file を pickup）が green。daemon round-trip 経由は実装に存在しない |
| 4 | 既存 emitEvent の discriminated union 型安全性が壊れていない | ✓ | `EventStreamRecord` union（events-writer.ts:47-199）/ `emitEvent` シグネチャ（同 276）/ `EVENTS_SCHEMA_VERSION`（同 23）はすべて無改変。`writeJsonlLine` を private extract した結果も既存 emitEvent 32 件全 green。`_AssertReservedCoversUnion` (events-writer.ts:348-353) が `EventStreamRecord["event"]` を網羅対象として保持 |
| 5 | docs/spec/10-events-stream.md が更新されている | ✓ | §3 schema description / §5 ヘッダ / §5.6 user-signal / §5.7 writer 21 vs reader 17 注記 / §6.20 user-signal 詳細 / §8 reader gateline 更新 / §8.1 「reader 無改修」解釈節 / §9 関連タスクに T029 行追加 |

---

## 4. 重点観点の確認結果

### §1 テスト実行（実機）
上記 §2 のとおり実行済み。全 green。

### §2 型レベル乖離検出が実際に機能するか（必須）

`events-writer.ts:317-353` を確認。実装は Design Review §3.1 推奨どおりの `as const` literal tuple → narrow name 型パターン:

```typescript
const RESERVED_EVENTS_LIST = [ "task_created", ..., "worktree_archived" ] as const;
export type ReservedEventName = (typeof RESERVED_EVENTS_LIST)[number];
export const RESERVED_EVENTS: ReadonlySet<ReservedEventName> = new Set(RESERVED_EVENTS_LIST);
type _AssertReservedCoversUnion =
  Exclude<EventStreamRecord["event"], ReservedEventName> extends never ? true : never;
const _reservedExhaustivenessCheck: _AssertReservedCoversUnion = true;
```

**実機 verify**: `RESERVED_EVENTS_LIST` 末尾の `"worktree_archived"` を一時コメントアウト → `bunx tsc --noEmit` 実行 → **`events-writer.ts(352,7): error TS2322: Type 'true' is not assignable to type 'never'.`** を確認（`Exclude<...>` が `"worktree_archived"` を返し、`extends never ? true : never` が `never` に解決され `true` 代入が型エラーになる挙動）。

確認後、変更を元に戻し `git diff -- skills/cmux-team/manager/events-writer.ts | grep -E "worktree_archived|INSPECTOR"` で復元検証（`+  "worktree_archived",` のみ表示、`INSPECTOR` 痕跡なし）。tsc エラー総数も 8 に復帰。

→ 「常に true ではなく union 乖離を即時 fail させる」設計上の主張が **実機で機能する** ことを確認。

### §3 「reader 無改修」解釈の明文化（必須）

`docs/spec/10-events-stream.md` §8.1（新設）に明記:

> T029 task 文の §スコープには「reader（events-cli）は無改修」と記載されているが、本 spec ではこれを「CLI 引数 interface（`--types` / `--since` / `--format` / `--follow`）と既存挙動（`--types` 無指定時の unknown event skip + warn）を維持する範囲」と解釈する。`processLine` 内部 filter logic は §6.20 Done 条件（自由 type を `--types` で購読して拾える）を満たすため最小限緩和する。

`events-cli.ts:307-317` の緩和実装は spec §8.1 の宣言と一致:

```typescript
if (!KNOWN_EVENTS.has(event)) {
  // --types で明示購読された event 名は通す（free-form user-signal の Done 条件を満たすため）。
  // --types 無指定時は従来どおり skip + warn（regression なし）。
  if (!(ctx.parsed.types && ctx.parsed.types.has(event))) {
    ctx.stderr.write(`warn: skipping record with unknown event=${event} ...\n`);
    return;
  }
}
```

regression テスト E15（`--types` 無指定で `signal:unsubscribed` を skip + warn）が green で「`--types` 無指定時は従来挙動を維持」を担保。`commands/watch.md:322` の reader 動作表も spec §8.1 と整合させて更新済み。

### §4 typed union 非破壊

- `EventStreamRecord` union（events-writer.ts:47-199、21 種）: 無改変
- `emitEvent(record: EventStreamRecord): Promise<void>`（同 276）: 無改変
- `EVENTS_SCHEMA_VERSION = 2`（同 23）: bump せず維持
- `writeJsonlLine` 共通化（同 248）: `emitEvent` / `emitUserSignal` 双方から呼ばれるが、`mkdir → appendFile` の順 / `events_writer_error` のログ / `code=` `stack=` の detail 付与 / catch ネスト失敗時の silent drop は旧 `emitEvent` の挙動を完全保持
- W6（typed emit と user-signal を交互に 3 件 append し行順保持・全件 JSON.parse 可）が green
- 既存 emit テスト 24 件（emitEvent: schema 適合 / 並行 append / payload type 動作 / mapAbortReason 全網羅）すべて green

### §5 emit 実装の正しさ

| 項目 | 実装 | テスト |
|---|---|---|
| actor 解決 (`--actor` > `CMUX_SURFACE` > 省略) | `resolveActor` (events-cli.ts:629-633) | E4 / E5 / E6 ✓ |
| 予約名 warn (投稿は通す / exit 0) | `RESERVED_EVENTS.has(parsed.type as never)` 後 stderr 出力 (events-cli.ts:662-667) | E3 ✓ |
| `--data k=v` 複数指定 | `data[k] = dv` で後勝ち (events-cli.ts:606) | E7 ✓ |
| 最初の `=` で split | `v.indexOf("=")` 経由 (events-cli.ts:597-606) | E8（`url=https://example.com/?a=1&b=2`）✓ |
| 値 string 固定 | `Record<string, string>` 型 + `v.slice(eq+1)` 文字列代入 | E7 / E8 ✓ |
| `--type` 必須 / 空エラー | `parseEmitArgs` 末尾の `type === undefined \|\| type.length === 0` (events-cli.ts:610-614) | E9 / E9b ✓ |
| `--data` `=` 無し → exit 1 | `if (eq < 0) throw new ArgError` (events-cli.ts:598-600) | E10 ✓ |
| `--data` 空キー → exit 1 | `if (k.length === 0) throw new ArgError` (events-cli.ts:601-604) | E11 ✓ |
| 未知 flag → exit 1 | `EMIT_KNOWN_FLAGS` 不在で throw (events-cli.ts:582-584) | E12 ✓ |
| optional field 省略 | `enriched.X = ...` を if-guard で囲み undefined / 空文字 / 空 `{}` で key ごと省略 (events-writer.ts:369-380) | W1 / W3 / W4 / E6 ✓ |
| `data: {}` 空 object のとき省略 | `Object.keys(record.data).length > 0` ガード | W4 ✓ |

### §6 スコープ遵守

| 確認項目 | 結果 |
|---|---|
| lock / lease / 排他 | **無し**（`fs.appendFile` 1 回呼びのみ。POSIX `O_APPEND` の atomicity に依存） |
| 新規 state file | **無し**（events.jsonl 1 本に集約） |
| daemon round-trip | **無し**（`runEmitSubcommand` から直接 `emitUserSignal` を呼ぶ） |
| 4096B warn | **未実装**（Design Review §3.5 の除外指示どおり）。spec §6.20 にも warn 規約は記載されていない |
| KNOWN_EVENTS 17/21 乖離 | **本タスクで弄っていない**（`TEXT_FIELDS` に `mailbox_changed` / `artifact_added` / `reload_failed` / `worktree_archived` の formatter は追加されていない）。spec §5.7 で follow-up 扱いと明記 |
| typed union 構造変更 | **無し**（`EventStreamRecord` / `emitEvent` 完全無改変） |

### §7 daemon 停止中 --follow integration（E16）

`events-cli.test.ts:1112-1162`（E16）が integration test として実装され green。手順:

1. events.jsonl 不在の状態で `emit --type signal:x --message "first"` を実行 → 初回ファイル生成
2. 同じプロジェクトに対し `--follow --types signal:x --pollIntervalMs 20` reader を起動
3. reader が 1 件目を pickup するのを `waitUntil` で待つ
4. 後続 `emit --type signal:x --message "second"` を別 invocation で実行
5. reader が 2 件目を pickup するのを `waitUntil` で待つ
6. abort → reader exit 0 / 出力に `"first"` と `"second"` 両方含まれる

→ Done 条件 §3「daemon 停止中でも投稿・監視」を E2E 相当で担保。

### §8 ガードレール

- **外部コマンド失敗時の stderr/stdout を detail に**: `writeJsonlLine` の catch で `err.code` / `err.message` / `err.stack.split("\n")[0]` を `events_writer_error` log の detail に含めている（events-writer.ts:253-266）
- **空 catch の有無**: events-writer.ts:262-264 / events-cli.ts:430-433 / 365-368 / 446-450 / 471-475 の catch はすべて意図的に飲む経路で、いずれもコメントで理由を明記（logger fail / AbortError / 二重 close / 一時的に file が消えた）。新規の silent catch は無い
- **cmux tree workspace 省略**: 該当変更なし（events-writer / events-cli は cmux tree を呼ばない）

---

## 5. Fix Required

なし（GO）。

### Minor 指摘（blocking ではないが補足）

1. **package-lock.json の `version` フィールド**: ブートストラップ副作用で `0.8.2 → 0.10.1` に変化している。タスクの作業指示どおり「検品対象外、Conductor が revert 予定」とのことなので問題ないが、最終 commit 前に確認すること。
2. **spec §5.7 で writer union 21 vs reader formatter 17 の乖離を follow-up として明文化**: 本タスクのスコープを越えるが、follow-up task を起票するかどうかは Master 判断（KNOWN_EVENTS 緩和を「`--types` 明示購読時のみ通す」にしたため、`mailbox_changed` / `artifact_added` / `reload_failed` / `worktree_archived` は引き続き `--types` 明示無しでは skip + warn される現状非対称が残る）。Design Review §3.3 と同じ指摘で、本タスクで直さない判断は plan §6.3 で示唆されている。
3. **i18n.ts は en / ja 双方に `help_events_emit` キーを追加**: 既存 i18n 構造に従った正しい改修。重複定義ではなく locale 別の同名キー（en: 656、ja: 1782）であることを `grep -n "help_events_emit:" i18n.ts` で確認済み。

以上、検品終了。
