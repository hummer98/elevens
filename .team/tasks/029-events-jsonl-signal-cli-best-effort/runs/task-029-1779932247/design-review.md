# Design Review: T029 events.jsonl への汎用 signal 投稿 CLI（best-effort 協調）

## 1. 判定

**Changes Requested**

主な理由: §3.4 の型レベル乖離検出 `_AssertReservedCoversUnion` が **TypeScript 上で常に true となり、union 網羅性を検査できない**（RESERVED_EVENTS のメンテ漏れを構造で防ぐという plan の主張が成立しない）。これは plan 上のロジックバグなので実装着手前に修正が必要。

他の設計判断（typed union 非破壊・writer 別関数・KNOWN_EVENTS 最小緩和・actor 自動解決・直接 appendFile）は実コードと spec を照らして妥当。修正後 Approved 相当の品質。

---

## 2. 良い点

- **typed daemon event の `EventStreamRecord` discriminated union を一切触らず、`emitUserSignal()` を別 export として足す** 設計（§3.1）は task 要件「typed union を壊さない × free-form を 1 経路足す」を最小コストで満たす。`emitEvent` の append/error 処理を private `writeJsonlLine` に extract する案も、既存テスト挙動を変えない範囲で良いリファクタ。
- **daemon round-trip を経由せず直接 `appendFile` する** 判断（§3.6）が、Done 条件「daemon 停止中でも投稿・監視できる」と整合。POSIX `O_APPEND` の atomicity は既存 `events-writer.test.ts` の並行 100 件 emit テストで担保済み。新規 state file / lock / lease を作らないという task §「スコープ」も完全遵守。
- **KNOWN_EVENTS 緩和を「`--types` 明示購読時のみ通す」最小に絞った** 判断（§3.7）。実コード `events-cli.ts:303-307` を読むと unknown event は問答無用で skip + warn される（`--types` filter 行 311 は KNOWN_EVENTS check の後ろにある）ので、Done 条件「`elevens events --follow --types deploy_started` で別セッションが拾える」と確実に衝突する。緩和なしで Done を満たす素直な道は無い。既存テスト #10（`events-cli.test.ts:541-563`）は `args: []` で `--types` を渡していないので、緩和後も `unknown event=foo_event_unknown` の skip + warn は green を維持する。
- **CLI 入口で `args[0] === "emit"` を見て別 parser に振る** 構成（§3.3）。既存 `parseArgs` の KNOWN_FLAGS / FLAGS_WITH_VALUE と emit 用 flag 集合が完全に交わらないので、混ぜると相互排他 check が爆発する分析は妥当。`main.ts:cmdEvents` への影響無しも事実。
- **actor 解決を `process.env.CMUX_SURFACE` 一本に絞り、未解決時は field ごと省略**（§3.2）。`"unknown"` 埋めをせずフィルタしやすい形にした観察性志向は CLAUDE.md「observatory に資するか」の判断軸に沿う。
- **テスト計画が Done 条件と 1:1 で対応**: 特に E2（reader 互換）と E14（daemon 停止中 = events.jsonl 不在からの first append）が Done 条件直結。W6（typed と user signal の混在 append）が typed event 非破壊の retrospective 検証になる。

---

## 3. 指摘事項

### 3.1 【必須】§3.4 の型レベル乖離検出が成立していない

**plan のコード**:

```typescript
export const RESERVED_EVENTS = new Set<string>([
  "task_created", /* … */, "worktree_archived",
]);

type _AssertReservedCoversUnion =
  Exclude<EventStreamRecord["event"], typeof RESERVED_EVENTS extends Set<infer S> ? S : never> extends never
    ? true
    : never;
```

**なぜ問題か**:

- `new Set<string>([...literal...])` の **型** は `Set<string>` であり、リテラル narrowing は起きない。
- 結果として `typeof RESERVED_EVENTS extends Set<infer S> ? S : never` は `string` に解決される。
- `Exclude<EventStreamRecord["event"], string>` は `never` になる（全 event 名は string のサブタイプ）ので、`extends never ? true : never` は **常に `true`**。
- つまり「`EventStreamRecord` union に新 event が追加されたが RESERVED_EVENTS に追加し忘れた」状態でも tsc は通る。plan が §6.1 で「型レベルチェックが乖離を即時 fail させる」と書いている保証は得られない。
- W8 の runtime check が二重防衛として残るが、これは「runtime test を書き忘れていれば気付かない」ので structural には弱い。

**推奨対応**:

`as const` literal tuple を中継して narrow した名前型を作り、それで `Set` を初期化する。例:

```typescript
const RESERVED_EVENTS_LIST = [
  "task_created", "task_ready", "task_assigned",
  "task_completed", "task_completed_state_mismatch",
  "task_aborted", "task_sync_guard_rejected", "task_reverted_to_ready",
  "conductor_running", "conductor_recovered", "conductor_disconnected",
  "conductor_asking", "conductor_done_unresolved",
  "conductor_start_timeout", "conductor_assign_timeout", "conductor_disconnect_timeout",
  "api_error_received", "mailbox_changed",
  "artifact_added", "reload_failed", "worktree_archived",
] as const;

export type ReservedEventName = typeof RESERVED_EVENTS_LIST[number];
export const RESERVED_EVENTS: ReadonlySet<ReservedEventName> =
  new Set(RESERVED_EVENTS_LIST);

// EventStreamRecord["event"] のうち RESERVED_EVENTS に無いものがあれば型エラー
type _AssertReservedCoversUnion =
  Exclude<EventStreamRecord["event"], ReservedEventName> extends never ? true : never;
const _reservedExhaustivenessCheck: _AssertReservedCoversUnion = true;
void _reservedExhaustivenessCheck;
```

これで `EventStreamRecord` に新 typed event を追加して RESERVED_EVENTS_LIST を更新し忘れると tsc が fail する。W8（runtime）と合わせて二重防衛が成立する。

### 3.2 【必須】task §「スコープ」の「reader（events-cli）は無改修」との不一致を design-review として明記しておくべき

plan §3.7 は KNOWN_EVENTS skip ロジックを変更する。これは事実上 events-cli.ts の挙動変更であり、task 文「reader（events-cli）は **無改修**」とは矛盾する。plan は「CLI 引数の interface 形状は無改修、内部 filter logic のみ」と整理しているが、これは task 文の **解釈の重み付け** を変えている。

**なぜ問題か**: 解釈の妥当性自体は支持できる（Done 条件と「監視側は既に揃っている」というタスク本文を優先するなら、最小緩和以外で Done を満たす道は実質ない）。しかしこの解釈変更を plan 内の §3.7 だけで自己完結させると、レビュー後の歴史的経緯が見えにくい。

**推奨対応**:

- plan §3.7 冒頭に「task §スコープの『reader 無改修』は CLI 引数 interface（`--types` / `--since` / `--format` / `--follow`）と既存挙動（`--types` 無指定時の skip + warn）を維持する範囲と解釈する。internal filter logic は最小限緩和する」と **解釈の宣言** を 1 段落明文化する。
- もしくは Master / 起票者へ「reader 無改修 vs Done 条件」の選択を escalation し、明示の OK を取ってから実装に進む。
- 代替案として一応「別 CLI（例: `elevens signals --follow`）を新設して既存 reader を完全温存」も検討余地はあるが、それは task 本文「監視（read）側は既に揃っている: `elevens events --follow --types <names>` ... これがそのまま使えること」と相反するので **本 plan の判断（最小緩和）が正しい**。escalation した上でこの結論を文章化するのが望ましい。

### 3.3 【推奨】KNOWN_EVENTS と spec §5 の event 数（17 vs 19/21）の乖離が現状放置されている件を補足

実コードを読むと:

- `events-cli.ts:166-241` の `TEXT_FIELDS` / `KNOWN_EVENTS` には **17 event** しか含まれていない（`api_error_received` までで止まっており、`mailbox_changed` / `artifact_added` / `reload_failed` / `worktree_archived` が抜けている）。
- 一方で `EventStreamRecord` union（events-writer.ts）は **21 event**、spec §5 は **19 event 種**（うち `api_error_received` / `mailbox_changed` は §6 に無い記載差）と既に乖離している。
- そのため現状でも `mailbox_changed` / `artifact_added` / `worktree_archived` / `reload_failed` が events.jsonl に書かれると、reader は無印で skip + warn を出してしまう（`--types` で明示購読しないと拾えない）。

**なぜ問題か**: 本 T029 の scope ではないが、plan §3.7 の「`--types` 明示購読時のみ通す」緩和を入れた後、これら 4 種の typed event も「`--types` で明示購読しないと拾えない event」に格下げされたまま残る。本タスク完了後の状態が「typed event の半分は無印で skip される / user signal は `--types` で拾える」という奇妙な非対称になる。

**推奨対応**:

- plan §6 リスク表または §6.3「確認ポイント」に「KNOWN_EVENTS の 17 件 vs typed union 21 件の乖離は別タスク（後続 issue）扱い」と明記する。
- 余裕があれば本 T029 の中で **TEXT_FIELDS に 4 つの欠落 event を追加** することを minor scope creep として許容する判断もある（formatter 追加 4 件、20-30 行程度）。やる/やらないを plan に明記しておくべき。
- spec §6.20 を新設する Step 1 のついでに、spec §5 のヘッダ（「合計 19 event 種 ...」）を `EventStreamRecord` union の実装と整合させる reconciliation を入れるかどうかも plan に明記。

### 3.4 【推奨】E14 の Done 条件カバレッジを補強

plan §5.1 / §4 Step 4 E14 は「events.jsonl が無い状態で emit → mkdir 後に append 成功」までを書いているが、task の Done 条件「**daemon 停止中でも投稿・監視が機能する**」の **監視側** を test で押さえていない。

**なぜ問題か**: plan は「監視側は既存 reader が file tail のみで daemon 不要なので追加テスト不要、既存テスト #2 で担保済み」と書いているが、既存 #2 は「fixture の raw 行が順序保持で stdout に出る」（非 follow）であり、**`--follow` で daemon 停止中の append を tail できるか** は covered とは言いがたい。

**推奨対応**:

- E16（追加）として「daemon 停止相当（events.jsonl が無い → emit が初回生成 → 同時に `--follow --types signal:x` で待っている reader が拾う）」の integration test を 1 ケース追加する。`pollIntervalMs` を短く差し込んで秒以下で完了させられるので追加コストは小さい。
- もしくは plan §5.3 手動 E2E に「daemon を `cmux-team kill` で落とした状態で T1（watcher）→ T2（publisher）の 2 ペア」を **必須確認** として明示する（既に §5.3 に類似記述はあるが必須/任意の区別がない）。

### 3.5 【推奨】§3.6 の 4096B soft warn は scope 外として除外する選択を検討

plan §3.6 末尾の「`JSON.stringify` 後のサイズ > 4096B なら stderr に soft warn」は best-effort 要件に対し over-engineering 寄り。

**なぜ問題か**:

- task §「やること」の 1〜5 / Done 条件のどこにも warn の要件はない。
- 4096B は POSIX `PIPE_BUF` の **最小保証** で、Linux では 4096、macOS ではより大きい。warn のしきい値として誤解を招く（4096B 超だから torn-write、ではない）。
- best-effort という方針に「サイズ可視化」を足すのは観察性向上に資するが、本 T029 の最小スコープには載らない。

**推奨対応**:

- 本タスクからは外す（実装しない）か、別 artifact (`Axxx-research`) に「将来の atomicity 検証用」として 1 ケース観察するか。
- もし残すなら spec §6.20 に「writer は推奨上限 4096B、超過時は stderr に warn を出す（best-effort）」を明記し、CLI help にも書く（実装側の責務として閉じる）。

### 3.6 【補足】actor 自動解決の `CMUX_ROLE` 不在の裏取り

plan §3.2 は「`CMUX_ROLE` は env として存在せず、role は hook script の `--role` flag で都度渡されているだけ」と判定している。実コードでこれが完全に裏取りできたかは plan からは読み取れない（grep 結果の引用なし）。

**推奨対応**:

- 実装着手前に `rg -n "CMUX_ROLE|process\.env\.CMUX_ROLE" skills/ commands/ bin/` で grep を 1 回走らせ、結果を plan の §3.2 の根拠として 1 行追記する。万一 hook script や test util が `CMUX_ROLE` を set している経路があれば、actor 解決のソースに含めるか議論が必要になる。

---

## 4. Recommendations（Implementer が次に取るべきアクション）

1. **plan §3.4 を 3.1 の `as const` literal tuple パターンに書き換える**（必須）。これだけは実装着手前に直す。型レベル乖離検出が plan の主張通りに機能するかどうかは Implementer がローカルで `bun tsc --noEmit` 相当（または `tsc --strict`）で「RESERVED_EVENTS_LIST から要素を 1 つ削った状態」で型エラーが出ることを確認してから commit する。
2. **plan §3.7 の冒頭で「reader 無改修」解釈の明文化を 1 段落追加**（必須）。task 文との解釈差を歴史的経緯として残す。
3. **KNOWN_EVENTS と spec §5 / `EventStreamRecord` union の 17/19/21 件乖離を「本 T029 で直すか否か」 を plan §6 で明示**（推奨）。直さないなら follow-up task を `cmux-team create-task --status draft` で起票しておく。
4. **E14 を補強して daemon 停止中の `--follow` integration test を 1 ケース追加**（推奨）。`pollIntervalMs` を短く差し込めば数秒で完了する。
5. **§3.6 の 4096B soft warn を残す/外すを明示**（推奨）。残すなら spec §6.20 と CLI help に書く。
6. **§3.2 の `CMUX_ROLE` 不在を grep で裏取り** し、plan に 1 行根拠を追加（推奨）。
7. 上記 1〜2 を反映した plan で再レビュー不要（**self-approve**）として実装に進んで良い。3〜6 は plan の文書品質向上であり、blocking ではない。
