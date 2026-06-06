# T029 完了サマリー — events.jsonl への汎用 signal 投稿 CLI（best-effort 協調）

## 完了したサブタスク

1. Phase 1: Planner で plan.md 作成（自由 type のユーザー signal 投稿 CLI 設計）
2. Phase 2: Design Review（Changes Requested → 必須2点を反映して self-approve）
3. Phase 3: TDD 実装（events-writer / events-cli / docs / tests）
4. Phase 4: Inspector で検品 **GO**

## 主な変更内容

- `skills/cmux-team/manager/events-writer.ts`
  - 既存 `emitEvent` の append/error 処理を private `writeJsonlLine` に extract（既存挙動不変）
  - `emitUserSignal(record)` を新 export として追加（free-form record 用、ts / schema_version は writer 側で注入）
  - `RESERVED_EVENTS_LIST` を `as const` literal tuple で定義し、型レベル乖離検出
    `_AssertReservedCoversUnion` が EventStreamRecord union と RESERVED_EVENTS の乖離を
    **実機 tsc で fail させる** ことを確認済み（Inspector 実機 verify 済み）
  - `EventStreamRecord` / `emitEvent` / `EVENTS_SCHEMA_VERSION` は完全無改変
- `skills/cmux-team/manager/events-cli.ts`
  - 入口で `args[0] === "emit"` を検出して `runEmitSubcommand` に振る
  - `parseEmitArgs` を別関数で実装（既存 `parseArgs` は無改変）
  - `--type`(必須) / `--message` / `--actor` / `--data k=v`(複数, 最初の=でsplit, 値string固定) / `--help`
  - 予約名（RESERVED_EVENTS 一致）には stderr に warn 1 行出して投稿は通す（exit 0）
  - actor 解決: `--actor` 明示 > `CMUX_SURFACE` > 省略
  - `processLine` の KNOWN_EVENTS skip を「`--types` 明示購読時のみ通す」最小緩和（regression なし）
- `docs/spec/10-events-stream.md`
  - §6.20「user-signal (free-form event)」新設（emit syntax / `signal:` prefix 推奨 /
    予約名衝突 warn / daemon 停止中の投稿・監視可 / reader での監視例 / best-effort・排他なし明記）
  - §8.1 「reader 無改修」解釈の明文化（CLI 引数 interface と既存挙動は維持、internal filter logic は最小緩和）
  - §3 / §5 / §9 を新設に合わせて更新
- `commands/watch.md`: reader 動作の表を spec §8 と整合（最小修正）
- `README.md` / `README.ja.md`: `elevens events emit ...` の 1 行を既存 `elevens events` の隣に追加
- `i18n.ts`: `help_events_emit` を en / ja 双方に追加

## テスト結果（実機・Inspector 確認）

| コマンド | 結果 |
|---|---|
| `bun test --timeout 30000 events-writer.test.ts` | **32 pass / 0 fail / 236 expect()** |
| `bun test --timeout 30000 events-cli.test.ts` | **36 pass / 0 fail / 151 expect()** |
| `bunx tsc --noEmit` | 既存ベースラインから増加なし（8 件 → 8 件、events-writer/events-cli/i18n 由来エラー 0） |

追加された主要テスト:
- W1〜W8: writer 単体（最小 emit / 全 field / optional 省略 / 並行 append / typed と混在 / error log / RESERVED runtime check）
- E1〜E16: CLI subcommand（emit + reader 互換 + 予約名 warn + actor 解決 + --data parse + 引数バリデーション + daemon 停止中 --follow integration）

## Done 条件チェック（5/5 ✓）

1. `elevens events emit --type deploy_started --message "..."` で events.jsonl に 1 行増える ✓
2. 別セッションが `elevens events --follow --types deploy_started,deploy_finished` で投稿を拾える ✓（E2 + E16）
3. daemon 停止中でも投稿・監視が機能する ✓（E14 + E16 で E2E 担保）
4. 既存 emitEvent の discriminated union 型安全性が壊れていない ✓（typed union 完全無改変、型レベル乖離検出が実機 tsc で機能）
5. docs/spec/10-events-stream.md 更新済み ✓

## 設計判断のハイライト

1. **typed union を触らず free-form を 1 経路足す**: `emitEvent`/`EventStreamRecord` を温存し、
   別 export `emitUserSignal()` を追加。append/error 処理を private `writeJsonlLine` に共通化したが
   既存 emitEvent の挙動は完全保持。
2. **「reader 無改修」の解釈**: タスク文の制約と Done 条件が衝突するため、CLI 引数 interface と
   既存挙動を維持する範囲を「無改修」と再定義し、internal filter logic（KNOWN_EVENTS skip）を
   `--types` 明示購読時のみ通す最小緩和に留めた。spec §8.1 に明文化。
3. **RESERVED_EVENTS を `as const` literal tuple で narrow**: Design Review の指摘により、
   `new Set<string>([...])` だと型が `string` に潰れ網羅性チェックが常に true になるバグを修正。
   `RESERVED_EVENTS_LIST` を `as const` 配列で narrow し、`_AssertReservedCoversUnion` 型を
   EventStreamRecord union との差分検出に使う。実機 tsc で削除 1 要素 → 型エラー、を Inspector が verify。
4. **daemon round-trip を作らない**: CLI が直接 `appendFile`（POSIX `O_APPEND` の atomicity に依存）。
   既存 writer テストの並行 100 件 emit が atomicity を担保している。

## 残課題・既知の先行課題（本タスクのスコープ外）

- **KNOWN_EVENTS / TEXT_FIELDS 17 件 vs EventStreamRecord union 21 件の乖離**:
  `mailbox_changed` / `artifact_added` / `reload_failed` / `worktree_archived` が reader formatter から
  抜けているため、`--types` 明示購読しないと skip+warn される。本タスクの KNOWN_EVENTS 緩和を
  「`--types` 明示購読時のみ通す」にしたため、これら 4 種類は依然として無印 reader で拾えない非対称が残る。
  本 T029 のスコープ外として **draft 起票は行わず spec §5.7 と本サマリーへの記録に留める**（draft 抱え込み回避）。
  将来作業時に拾い直す。
- **`CMUX_ROLE` 不在の裏取り**: Implementer の grep で `CMUX_ROLE` を env として set する経路は無いことを
  確認済み（actor 自動解決は `CMUX_SURFACE` 1 本で十分）。

## マージコミット

完了処理 Step 8〜9 で埋める。

## artifact ID

本タスクはコード変更を伴うため artifact 化しない。
