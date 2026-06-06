# T019 Phase 2 plan.md レビュー (design-review.md)

- レビュー者: design-reviewer agent (surface:27)
- レビュー日時: 2026-05-23 JST
- 作業ディレクトリ: `/Users/yamamoto/git/elevens/.worktrees/task-019-1779487382`
- 対象: `plan.md`（同 run）
- 入力: `research.md`（同 run、Phase 1 実測）
- 方針: コードは書かず、レビュー結果のみ出力。経路網羅・DRY 判定は実コードを開いて裏取り。

---

## 1. 総合判定

**Approved**

致命的欠陥は無い。fix 層の選定・経路網羅・テスト戦略・実機検証手順は research の実測に整合し、CLAUDE.md ガードレール（`bun test` 全体禁忌、cmux tree / EventBus / task-state 等）にも抵触しない。Minor 指摘のみ。実装は計画に従って進めて問題ない。

---

## 2. 強み

1. **収束分析が実コードに整合**: claude binary を実際に exec するのは #3/#4/#5 の 3 点のみで、#1/#2/#6 は子プロセスとして #3 に収束する、という分析は実コードで裏取り済み（後述 §6）。これにより「必須 3 点 + テスト可能な上流アンカー」という二段構えの方針が説得力を持つ。
2. **DRY の取り方が minimal-scope**: helper 関数化を斥け「マジック文字列を共有定数 1 個に集約」だけに留めた判断は妥当。3 種の env 注入機構（Record / `process.env` / `exportVars[]`）の差を無理に統一しない方が読みやすい。
3. **テスト戦略が既存パターン踏襲**: `conductor.test.ts:140-198` の `spyOn(cmux, "send")` → `sendSpy.mock.calls[0]?.[1]` 検証は実コードで現役のパターン。dead flag 撤去の回帰ガード（`not.toContain("CMUX_NO_RENAME_TAB")`）を同じ assertion 群に同居させる設計も簡潔。
4. **実機検証の決着論点が明確**: research §3.2 で未確定だった「recap がメタデータ title key に書かれるか UI overlay だけか」を §4.1 手順 6 の `--sources` 連打で直接観察して決着させる、と明示。Phase 1 の未達点を閉じる手順として十分。
5. **fallback が条件付き発動**: §4.3 を「§4.1 手順 6 で flag を付けても依然書き換わった場合に限り発動」と明記し、scope を不用意に膨らませない設計。

---

## 3. 指摘事項

### 3.1 [Minor] `conductor.ts:328` コメント整理方針が両論併記

**plan §2.3 の記述**: 「コメントから当該記述を除去する**か**『T019 で dead flag として撤去』と書き換える」と二択のまま。

**問題**: 実装者によって判断が割れる可能性。実コード (`conductor.ts:328` 周辺) を見たところ、当該コメント全体が「初回 assign 時に kill+spawn → cmdSpawnConductor が `CMUX_NO_RENAME_TAB=1` を立てるので、ここで設定したタブ名は維持される」という、本 fix 後は事実と異なる説明になる。

**Recommendation**: 削除推奨を 1 案に絞り、残すなら「T019 で `CMUX_NO_RENAME_TAB` を撤去。タブ名の固定は claude 側の `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` による OSC 抑止で実現する」と書き換える方を選ぶ、と plan 側で一本化しておく。実装ブレを防ぐ minor item。

### 3.2 [Minor] Master regression の確認観点が抽象的

**plan §4.2 の記述**: 「Master regression: `[N] Master` が**従来通り健全**…回帰が無いことを必ず確認」。

**問題**: 何を観測すれば「健全」と言えるかが暗黙。research §2.1 では Master surface (29) の `title = [29] Master [explicit @ 1779479351.501]` で固定、と読み取れるが、plan 側では具体的観測手段が抜けている。

**Recommendation**: §4.2 の Master 行に「`c11 get-metadata --surface surface:<master> --sources` で `title = [N] Master [explicit @ <renameTab ts>]` のままで `Claude Code` に書き換わっていないことを直接確認」と一行追加。`get-metadata` を統合検証の標準観測手段として明示する。

### 3.3 [Minor] interactive claude 起動の API quota 配慮

**plan §4.1 手順 5 の記述**: 「複数ターンのやり取り / ファイル読み込み等。recap はセッションが進むと出るため、数ターン回す」。

**問題**: research §1.3 で「実機 interactive claude 起動は最小限に留め（API quota とリスクのため）」と Phase 1 では明示的に抑制していたが、Phase 2 では未言及。隔離検証で何度も interactive を回すと quota を食う。

**Recommendation**: §4.1 に補足として「claude --print や短い ping ターンで OSC が出るかを先に確認 →出るなら最短再現で、出ないなら数ターン回す」という段階的アプローチを書き添える。**fix の妥当性判定には影響しない**ので Minor。

### 3.4 [Minor] hook 経由 trigger の検証が間接的

**plan §5 リスク欄の記述**: 「OSC 以外の trigger 残存リスク（research §4.2-2）… §4.1 手順 6 の連続観察で間接的に確認する」。

**問題**: §4.1 手順は `CMUX_CLAUDE_HOOKS_DISABLED=1` を立てた条件で実施するため、c11 wrapper / hook 経由の trigger が残っているかは原理的に検出できない。research §3.1 で「Conductor の env は `CMUX_CLAUDE_HOOKS_DISABLED=1` で wrapper を bypass しているのに上書きされている → wrapper 由来ではない」と切り分け済みなのでリスクは低いが、plan §5 の「間接的に確認」は厳密には弱い表現。

**Recommendation**: §5 リスク欄で「§4.2 統合検証は `elevens start` 経由なので wrapper / hook 経路も実質的に含む。fix 後に `[N] Claude Code` への書き換えが消えれば OSC 以外の経路は無いと判定」と表現を強める、または「hook 経由検証は §4.2 でカバー」と明示すると論理が閉じる。Minor。

### 3.5 [Minor] `util.ts` 配置の妥当性は確認済みだが invariant の所在が plan に書き残らない

**実コード裏取り**: `util.ts` は `shellQuote` / `buildLaunchCommand` のみを export しており、`conductor.ts:20` と `main.ts:63` の両方が既に import 済み。新規定数追加で循環 import は発生しない（util.ts は他ファイルから import される側で、上位 module を import していない）。

**問題（軽微）**: plan §2.1 NOTE は flag 名の失効リスクのみ。「`CMUX_CLAUDE_HOOKS_DISABLED=1` と同居させる」という invariant は plan §1 で文言として書かれているだけで、コード上のドキュメント化が薄い。

**Recommendation**: 共有定数の docstring に「**invariant**: この定数は `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定する全 claude spawn サイトに同居させる」と一行入れることを plan §2.1 で推奨しておく。将来の経路追加時の見落とし防止。Minor。

---

## 4. 必須修正

なし（Approved）。§3 の指摘はすべて Minor で、実装フェーズで拾えば足りる。

---

## 5. リスク確認（plan に盛り込めている）

| リスク | plan 内の対応箇所 | 妥当性 |
|---|---|---|
| flag が claude version で失効 | §5 + §2.1 NOTE(T019) コメント | 妥当。検知手段（§4.1 再実行）も明示 |
| OSC 以外の trigger 残存 | §4.3 fallback（条件付き発動） | 妥当（§3.4 で表現を強めると尚良） |
| dead flag 削除でテスト破損 | §2.3 grep 確認 + §3.3 回帰 assertion | 妥当。`*.test.ts` 参照 0 件を裏取り済み |
| `bun test` 全体実行禁忌 | §3.1 で per-file ループ明示 | CLAUDE.md ガードレール遵守 |
| live surface への書き込み | §4.1 隔離 surface + close-surface 後片付け明示 | research と同方針 |
| Master / Conductor / Agent 経路漏れ | §0 + §2.2 で #3/#4/#5 を必須チョークポイントと指定 | 実コードで裏取り済み（§6） |

---

## 6. 確認した実コード

レビュー中に実際に開いて plan の主張を裏取りしたファイル:行:

| ファイル:行 | 確認内容 |
|---|---|
| `skills/cmux-team/manager/conductor.ts:125-174` | #1 `launchConductor` の env Record に `CMUX_NO_RENAME_TAB: "1"` が含まれる（line 134）。`buildLaunchCommand` import (`./util` から、line 20)。`cmux.renameTab` 呼び出し (line 170)。`backend.spawn` 経由で env が `cmux.send("export ...")` に変換される（後述）。 |
| `skills/cmux-team/manager/conductor.ts:580-622` | #2 `assignTask` の env Record に `CMUX_NO_RENAME_TAB` が**含まれない**こと (line 601-606)。backend.reset 経由 (line 618)。 |
| `skills/cmux-team/manager/conductor.ts:320-335` | #1 reserved 経路の `cmux.renameTab(surface, [N] Conductor)` (line 332) と、line 328 の `CMUX_NO_RENAME_TAB=1` コメント引用。 |
| `skills/cmux-team/manager/main.ts:3280-3349` | #3 `cmdSpawnConductor` の `process.env.CMUX_NO_RENAME_TAB = "1"` (line 3300) / `CMUX_CLAUDE_HOOKS_DISABLED = "1"` (line 3301) / `execFileSync("claude", ..., { env: process.env })` (line 3341-3345)。 |
| `skills/cmux-team/manager/main.ts:3356-3393` | #4 `cmdLaunchMaster` の `process.env.CMUX_NO_RENAME_TAB = "1"` (line 3388) / `CMUX_CLAUDE_HOOKS_DISABLED = "1"` (line 3389)。 |
| `skills/cmux-team/manager/main.ts:3616-3650` | #5 `cmdSpawnAgent` の `exportVars[]` に `CMUX_NO_RENAME_TAB=1` (line 3637) / `CMUX_CLAUDE_HOOKS_DISABLED=1` (line 3638) / `CMUX_TEAM_SKIP_SYNC_CHECK=1` (line 3639) が並ぶ構造。 |
| `skills/cmux-team/manager/main.ts:5582-5605` | #6 `cmdRestartTask` の `cmux.send(conductor.surface, "export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1\n")` (line 5593)。`CMUX_NO_RENAME_TAB` は**含まれない**。 |
| `skills/cmux-team/manager/claude-code-backend.ts:90-105` | `backend.spawn` が env Record を `export KEY=VAL ...\n` に変換して `cmux.send` する経路 (line 94-100)。plan §3.2 の主張と一致。 |
| `skills/cmux-team/manager/claude-code-backend.ts:145-167` | `backend.reset` が同様に env Record を `export ...` に変換 (line 157-163)。 |
| `skills/cmux-team/manager/util.ts:1-30` | `shellQuote` / `buildLaunchCommand` 以外の export なし。conductor.ts と main.ts の両方が import 済み（`conductor.ts:20` / `main.ts:63`）。共有定数追加で循環 import の懸念なし。 |
| `skills/cmux-team/manager/conductor.test.ts:1-198` | sendSpy パターン (line 145, 181-182) が plan §3.3 で踏襲する pattern と一致。`assignTask 状態遷移` describe (line 140-198) は env export 行 `sendSpy.mock.calls[0]?.[1]` を `toContain` で検証する形。 |
| `skills/cmux-team/manager/master.test.ts:185-222` | `spawnMaster` テストは launch 文字列 (`cd '...' && elevens spawn-master\n`) のみ検証し env を export しない。plan §3.2 の「Master の flag は manager レイヤの unit テストでは検証不能」が正しい。 |

### 6.1 grep ベースの再確認

- `grep -rn "CMUX_NO_RENAME_TAB" skills/` で plan §2.3 の通り**set 4 箇所 + コメント 1 箇所**を確認:
  - `main.ts:3300` / `main.ts:3388` / `main.ts:3637` / `conductor.ts:134` (set)
  - `conductor.ts:328` (comment)
- `grep -rn "CLAUDE_CODE_DISABLE_TERMINAL_TITLE" skills/` → **0 件**。未注入であることを確認（fix が新規導入扱いで正しい）。

---

## 7. 判定総括

plan は research の実測（OSC が trigger / writer は c11 explicit writer）を正しく踏まえ、claude binary 側で OSC を抑止する最小修正案を提示している。経路網羅（#3/#4/#5 必須 + テスト可能な上流アンカー）、DRY 措置（共有定数 1 個）、TDD 戦略（既存 sendSpy パターン踏襲）、実機検証（隔離 + before/after 対照 + `--sources` 連打で title key 遷移観察）はいずれも実コードと整合し、CLAUDE.md ガードレールにも抵触しない。

実装フェーズに進んで問題ない。§3 の Minor 指摘（コメント整理方針一本化 / Master regression の観測手段明示 / API quota 配慮 / hook 経由検証の表現強化 / 共有定数 docstring に invariant 明記）は実装中に軽く拾えば十分。

---

（design-review.md ここまで）
