---
id: 029
title: events.jsonl への汎用 signal 投稿 CLI（best-effort 協調）
priority: medium
created_by: surface:10
created_at: 2026-05-28T01:22:26.441Z
---

## タスク
## 背景・意図

複数 Master / セッションが本番 deploy や git merge を行う。厳密な排他/lock/lease は不要で、
「誰かが deploy する/した」を投稿し、他セッションがそれを監視して**作業や実機確認のタイミングを計る**だけの
best-effort 待ち合わせ signal が欲しい（A034 系の協調要件、ユーザー明示）。

監視（read）側は既に揃っている: `elevens events --follow --types <names> [--format json|text]`
（events-cli.ts）は任意 event 名で filter できる。**不足しているのは投稿（write）側のみ。**
events.jsonl への書き込みは現状 daemon 内部の `emitEvent()` 経由だけで、ユーザーが任意 signal を
投稿する CLI が無い。

## スコープ（最小限・厳守）

- lock / lease / 排他 / 二重実行ガードは**作らない**。best-effort signal broadcast に限定。
- reader（events-cli）は**無改修**。`--follow --types` がそのまま使えること。
- 新規 state file を作らない。daemon round-trip 不要（後述）。

## やること

1. **投稿 CLI を追加**: `elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...`
   - `.team/logs/events.jsonl` に 1 record append。`schema_version` / `ts` は既存 writer ロジックを
     再利用して自動付与（手書きで形式ズレを作らない — events-writer.ts の責務分担を踏襲）。
   - `event` フィールド = ユーザー指定の `--type`（自由文字列）。`message` / `actor` / `data` は任意。
     `actor` 省略時は現在の surface / role を解決できれば埋める（できなければ省略可）。
   - **daemon 停止中でも投稿・監視できること**を要件とする（CLI が直接 append。協調 signal の可用性 >
     書き込み一元化。POSIX の小サイズ append は atomic）。実装方式（直接 append か daemon 経由か）は
     この要件を満たす範囲で実装者判断。

2. **型（EventStreamRecord union）の扱い**: union は task/conductor ライフサイクル専用の閉じた
   discriminated union。自由 type を許すために discriminant を `string` に潰すのは避ける。
   daemon 用 `emitEvent(typed)` は温存し、ユーザー signal は別経路（free-form record を受ける薄い
   関数 / variant）で書く設計を検討。reader は既に `Record<string,unknown>` 汎用なので read は通る。
   → 「typed daemon event を壊さず free-form を1経路足す」最小構成を実装者が選ぶ。

3. **予約名との衝突回避（soft）**: daemon 予約 event 名（task_*/conductor_*/artifact_added 等）と
   衝突すると監視が濁る。hard block はしない（best-effort のため）が、(a) docs に prefix 規約を明記
   （例: ユーザー signal は `signal:` prefix 推奨、または `deploy_*` のような運用語彙）、
   (b) 予約名と完全一致する `--type` には stderr に warn を出す（投稿自体は通す）程度に留める。

4. **docs**: docs/spec/10-events-stream.md に user-signal（汎用投稿）セクションを追加。
   - emit CLI の syntax、free-form type 規約、reader での監視例
     （`elevens events --follow --types deploy_started,deploy_finished`）を記載。
   - 「best-effort・排他なし」を明記。
   - commands/ に該当があれば追記（無ければ docs/spec のみで可）。

5. **テスト**: emit → events.jsonl に 1 行 append される / schema_version・ts が付与される /
   既存 reader の `--types <name>` で拾える、を最小ケースで検証。
   （注意: `bun test` 全体実行は禁忌。個別ファイルで実行。）

## Done 条件

- `elevens events emit --type deploy_started --message "..."` で events.jsonl に行が増える。
- 別セッションが `elevens events --follow --types deploy_started,deploy_finished` で投稿を拾える。
- daemon 停止中でも投稿・監視が機能する。
- 既存 task/conductor event の型安全性（emitEvent の discriminated union）が壊れていない。
- docs/spec/10-events-stream.md が更新されている。
