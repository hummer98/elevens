# T019 Phase 2: タブタイトル上書き fix の実装計画書 (plan.md)

- 計画者: planner agent (surface:27)
- 計画日時: 2026-05-23 JST
- 作業ディレクトリ: `/Users/yamamoto/git/elevens/.worktrees/task-019-1779487382`
- 入力: 同 run の `research.md`（Phase 1 実測調査）
- 制約: 本ドキュメントは**計画のみ**。コードは書かない。

---

## 0. 前提（実コードで再確認した現在の行番号）

research.md §6.1 の行番号を実ファイルで再 grep / Read して検証した結果。**research の 5 経路表に対し、実コードでは fresh-assign の主経路 `assignTask` (conductor.ts:601) が抜けていた**ため追加する（後述の収束分析も参照）。

| # | ファイル:行（現在値） | 関数 | env 注入の機構 | 現在の env キー |
|---|---|---|---|---|
| 1 | `conductor.ts:129-135` | `launchConductor` | env Record → `backend.spawn` → `export ...` を `cmux.send` | `CMUX_SURFACE` / `CMUX_CLAUDE_HOOKS_DISABLED` / `CMUX_TEAM_MAIN_BRANCH` / `CMUX_TEAM_SKIP_SYNC_CHECK` / **`CMUX_NO_RENAME_TAB`** |
| 2 | `conductor.ts:601-606` | `assignTask`（kill+spawn の fresh-assign） | env Record → `backend.reset` → `export ...` を `cmux.send` | `CMUX_SURFACE` / `CMUX_CLAUDE_HOOKS_DISABLED` / `CMUX_TEAM_MAIN_BRANCH` / `CMUX_TEAM_SKIP_SYNC_CHECK`（NO_RENAME_TAB は無い） |
| 3 | `main.ts:3294-3305` | `cmdSpawnConductor` | `process.env.X = "1"` → `execFileSync("claude", { env: process.env })` | `CMUX_SURFACE` / **`CMUX_NO_RENAME_TAB`(3300)** / `CMUX_CLAUDE_HOOKS_DISABLED` / `ANTHROPIC_BASE_URL` |
| 4 | `main.ts:3385-3393` | `cmdLaunchMaster` | `process.env.X = "1"` → `execFileSync("claude", { env: process.env })` | `CMUX_SURFACE` / **`CMUX_NO_RENAME_TAB`(3388)** / `CMUX_CLAUDE_HOOKS_DISABLED` / `ANTHROPIC_BASE_URL` |
| 5 | `main.ts:3633-3640` | `cmdSpawnAgent` | `exportVars[]` → `cmux.send("export ...")` → `claude ...` | `ROLE` / `PROJECT_ROOT` / `CMUX_SURFACE` / **`CMUX_NO_RENAME_TAB`(3637)** / `CMUX_CLAUDE_HOOKS_DISABLED` / `CMUX_TEAM_SKIP_SYNC_CHECK` |
| 6 | `main.ts:5593` | `cmdRestartTask` | `cmux.send("export ...")` → `elevens spawn-conductor` | `CMUX_SURFACE` / `CMUX_CLAUDE_HOOKS_DISABLED`（NO_RENAME_TAB は無い） |

`CMUX_NO_RENAME_TAB` の set は **4 箇所**（conductor.ts:134 / main.ts:3300 / 3388 / 3637）+ コメント引用 **1 箇所**（conductor.ts:328）。grep で再確認済み。read は 0 箇所（research §5.2 と一致）。

**収束分析（重要）**: 実コードを追うと、claude バイナリを実際に exec する点は **3 つだけ**:

- `cmdSpawnConductor`（#3）= Conductor の唯一の claude exec 点
- `cmdLaunchMaster`（#4）= Master の唯一の claude exec 点
- `cmdSpawnAgent`（#5）= Agent の唯一の claude exec 点

#1 `launchConductor`（resume / reserved 初回）・#2 `assignTask`（fresh-assign）・#6 `cmdRestartTask`（restart）は、いずれも自前で claude を exec せず **`elevens spawn-conductor`（= cmdSpawnConductor）を子プロセスとして起動する**。よって #1/#2/#6 が `export` した env は子の `process.env` に継承され、最終的に #3 の `execFileSync(..., { env: process.env })` 経由で claude に届く。

→ **runtime 正しさだけなら #3/#4/#5 の 3 点に注入すれば全ロール・全経路をカバーできる**（#1/#2/#6 は #3 へ収束するため冗長）。ただし #3/#4 は CLI exec 関数で **unit テストが困難**。#1/#2/#5/#6 は `cmux.send` spy で **テスト可能**。この非対称性を踏まえて §2・§3 の方針を決める。

---

## 1. 方針サマリー

**採用 fix**: 全 claude spawn 経路の env に `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` を注入し、claude が OSC タイトルシーケンスを出力しないようにする（research §4.1）。

**なぜこの層か（1-2 行）**: writer は c11 daemon 自身（OSC 受信を契機に内部 template `[N] Claude Code` を source=explicit で書く）であり、c11 は AGPL でパッチ不可（research §3.1 / §4.1）。trigger は claude が出す OSC のみで、発生源（claude binary）で OSC を止めれば writer は起動しない（実験 B5 = `--print` で OSC 無し → 書き換え無し / research §2.3, §4.1）。

**注入の invariant（実装の指針）**: 「**`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` は、claude spawn 用に `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定している全箇所に同居させる**」。これを単一ルールとすることで、(a) claude exec チョークポイント #3/#4/#5 を確実に押さえ、(b) テスト可能な上流 #1/#2/#6 にもアンカーを置ける（§3）。`CMUX_NO_RENAME_TAB` という別 flag と並んで設定されている既存パターンに正確に倣う。

**同時に dead flag `CMUX_NO_RENAME_TAB` を削除**（research §5.3 / §6.2）。set 4 箇所 + コメント 1 箇所。read 0 のため挙動変化なし。

---

## 2. 変更点の詳細（ファイル別）

### 2.1 DRY 検討と結論

- **既存に「claude spawn 共通 env を組み立てる関数」は存在しない**（`baseEnv`/`claudeEnv`/`buildEnv` 等を grep → 0 件）。env は 3 種の機構で各サイトにインライン展開されている: ① env Record オブジェクト（#1/#2）、② `process.env.X="1"` 代入（#3/#4）、③ `KEY=VAL` 文字列の `exportVars[]`（#5/#6）。
- 機構が 3 種あるため**フル helper 関数（env を組み立てて返す）は割に合わない**（呼び出し側で 3 通りに変換が必要になり、かえって読みにくい）。minimal-scope の観点でも過剰。
- **採用する DRY 措置（軽量・単一 source of truth）**: マジック文字列 `"CLAUDE_CODE_DISABLE_TERMINAL_TITLE"` の重複だけを排除する共有定数を 1 つ導入する。

  ```ts
  // 置き場所候補: util.ts（buildLaunchCommand と同居。conductor.ts / main.ts 双方が既に import）
  // claude を起動する全経路で、c11 daemon による OSC タイトル上書き(T019)を抑止する env。
  // CMUX_CLAUDE_HOOKS_DISABLED と同じ「全 claude spawn が必要とする env」クラス。
  // NOTE(T019): この flag は claude binary の OSC タイトル出力抑止に依存する。将来の
  //   claude version で flag 名が変わると失効しうる（§5 リスク参照）。
  export const CLAUDE_DISABLE_TITLE_ENV = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" } as const;
  ```

  - env Record 機構（#1/#2）: `{ ...env, ...CLAUDE_DISABLE_TITLE_ENV }` もしくは 1 キー追記。
  - `process.env` 機構（#3/#4）: `Object.assign(process.env, CLAUDE_DISABLE_TITLE_ENV)`。
  - `exportVars[]` 機構（#5）/ shell export（#6）: `` `${k}=${v}` `` を 1 行 push（または定数のキー名を参照して `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` を追記）。

  > 置き場所は実装者裁量。util.ts が無難だが、循環 import を避けられるならローカル定数でもよい。**唯一の必須要件は「キー名/値の literal を 1 箇所に集約し、各サイトはそれを参照する」**こと。

### 2.2 各サイトへの注入（co-location ルール）

`CMUX_CLAUDE_HOOKS_DISABLED=1` の隣に `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`（= 上記定数）を追加する。対象は §0 の #1〜#6 の **6 サイト全部**。

| # | サイト | 追加内容 | 役割 |
|---|---|---|---|
| 1 | `conductor.ts:129-135` env Record | キー追加 | resume / reserved 初回 Conductor。**テストアンカー** |
| 2 | `conductor.ts:601-606` env Record | キー追加 | fresh-assign（kill+spawn）。**テストアンカー（既存テスト拡張）** |
| 3 | `main.ts:3300` 付近 `process.env` | `Object.assign` | Conductor の claude exec チョークポイント（全 Conductor 経路が収束） |
| 4 | `main.ts:3388` 付近 `process.env` | `Object.assign` | Master の唯一 exec 点 |
| 5 | `main.ts:3637` `exportVars[]` | 1 行 push | Agent の唯一 exec 点。**テストアンカー** |
| 6 | `main.ts:5593` shell export | 文字列追記 | restart。**テストアンカー** |

**冗長性についての判断**: runtime 的には #1/#2/#6 は #3 に収束するため冗長。それでも 6 サイト全てに置くことを推奨する理由は 2 つ —
(a) **テスト可能性**: #1/#2/#5/#6 は `cmux.send` 経由で export 文字列を spy 検証できる。#3/#4 は CLI exec 関数で unit テスト困難なため、上流アンカーが実質的なテスト網になる（§3）。
(b) **self-documenting / 防御的多重化**: 各サイトが「この経路は OSC を抑止する」と読めることで、将来の経路追加時の見落としを減らす。invariant が単純（hooks-disabled と同居）なので散らかさない。

> minimal-scope を厳格に取り、テストを #1/#2 だけに割り切るなら #6 を省いて #3 に委ねる選択も可能。ただし #3/#4/#5 の 3 チョークポイントは**必須**（ここを抜くと該当ロールが素通りする）。実装者は「3 必須 + 上流アンカー」を最低ラインとする。

### 2.3 `CMUX_NO_RENAME_TAB` の削除

- **削除する set（4 箇所）**: `conductor.ts:134` / `main.ts:3300` / `main.ts:3388` / `main.ts:3637`。
- **整理するコメント（1 箇所）**: `conductor.ts:328`（`// 初回 assign 時に kill+spawn → cmdSpawnConductor が CMUX_NO_RENAME_TAB=1 を立てるので …`）。dead flag であることが本タスクで確定したので、コメントから当該記述を除去するか「T019 で dead flag として撤去」と書き換える。
- **削除前の安全確認（実施済み）**: `*.test.ts` / `state-machine/*.test.ts` に `CMUX_NO_RENAME_TAB` 参照 **0 件**（grep 確認済み）。よって削除でテストは壊れない。実装時にも念のため `grep -rn CMUX_NO_RENAME_TAB skills/` を再実行し、コメント引用以外の残存が無いことを最終確認する。

---

## 3. TDD 戦略（テストファースト）

### 3.1 テスト実行コマンド（厳守）

**`bun test` 全体実行は禁忌**（O(N²) で 13 分ハング / CLAUDE.md）。per-file ループを使う:

```bash
cd skills/cmux-team/manager
for f in conductor.test.ts master.test.ts daemon.test.ts; do bun test --timeout 30000 "$f"; done
```

新規/変更したテストファイルだけを回す。最低でも `conductor.test.ts`（主戦場）+ 既存 env 関連（`master.test.ts` / `daemon.test.ts`）の回帰確認。

### 3.2 既存テストの env 検証パターン（倣う対象を実読済み）

- `conductor.test.ts:140-198`「assignTask 状態遷移」: `spyOn(cmux, "send")` で `sendSpy` を取り、`sendSpy.mock.calls[0]?.[1]`（= 1 回目の送信 = `export ...` 行）を `toContain("CMUX_SURFACE=...")` で検証している。**この既存 spy 機構をそのまま使う。**
- `backend`（`claude-code-backend.ts:94-98 / 157-161`）は env Record を `export KEY=VAL ...\n` に変換して `cmux.send` する。よって #1 `launchConductor`(spawn) / #2 `assignTask`(reset) の env Record に flag を足せば、`cmux.send` の export 文字列に現れ、spy で検証できる。
- `master.test.ts:187-222`「spawnMaster launch 文字列」: `spawnMaster` は `cd '<root>' && elevens spawn-master` を送るだけで **env を export しない**（Master の env は `cmdLaunchMaster` の `process.env` 内でのみ設定）。→ **Master の flag は manager レイヤの unit テストでは検証不能**（§3.4）。

### 3.3 追加する unit テスト（テスト可能なサイト）

**`conductor.test.ts`**:

1. **assignTask（#2、既存テストを拡張）** — `assignTask 成功後…` テスト内の export 行アサーションに追記:
   - `expect(sendSpy.mock.calls[0]?.[1]).toContain("CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1")`
   - `expect(sendSpy.mock.calls[0]?.[1]).not.toContain("CMUX_NO_RENAME_TAB")` ← dead flag 撤去の回帰ガードを兼ねる
2. **launchConductor（#1、新規テスト）** — fresh / 非 resume 経路で flag が export されることを検証:
   - `spyOn(cmux, "send")` を張り、git init 済みの `testDir` で `launchConductor(testDir, "surface:100", { mainBranch: "main" })` を呼ぶ（既存 throw テストと同じ setup 流用）。
   - 1 回目の `cmux.send`（= backend.spawn が出す `export ...`）が `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` を含み、`CMUX_NO_RENAME_TAB` を含まないことをアサート。
   - 注意: `renameTab` も呼ばれる（`[100] Conductor`）。`spyOn(cmux, "renameTab")` も mock しておく。

> #5 `cmdSpawnAgent` / #6 `cmdRestartTask` / #3 `cmdSpawnConductor` / #4 `cmdLaunchMaster` は巨大な CLI コマンド関数（team.json 読み込み・postMessage・token 選択・execFileSync 等の副作用が密）で、現状 **直接 unit テストするハーネスが無い**（grep で `exportVars` を assert するテストは存在しないことを確認済み）。これらを unit テストするためだけの大規模リファクタは本タスクのスコープ外とする（minimal-scope）。

### 3.4 main.ts CLI サイト（#3/#4/#5/#6）のカバレッジ方針

- **第一義は §4 の実機検証**（Conductor / Master / Agent の各 surface を実起動して title 固定を確認）。これが #3/#4/#5 の authoritative なカバレッジ。
- **value drift 防止**は §2.1 の共有定数（単一 source of truth）で担保。各サイトは定数を参照するので literal がズレない。
- **任意（実装者裁量、推奨はしない）**: もし #5 のユニット検証が欲しければ、`cmdSpawnAgent` の `exportVars` 構築だけを純粋関数 `buildAgentSpawnExportVars(...)` に抽出して単体テストする手はある。ただしスコープ拡大なので、やるなら別途小タスク化を検討。

---

## 4. 実機検証手順（最重要 — Phase 1 の未達点を必ず閉じる）

research §3.4 / §4.2 / §6.3 の通り、`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` の効果は **strings + `--print` からの推定のみで、interactive claude での実証が未達**。Phase 2 では必ず実機 interactive で閉じる。

### 4.1 隔離環境での単体検証（claude 単体 + OSC 抑止 flag）

live surface（27/29/36/37/40/41/43/44 等）には一切書き込まない。`c11 new-split right` で**隔離 surface** を作って実施し、終了後 `c11 close-surface` で必ず後片付けする。

1. 隔離 surface を作る: `c11 new-split right`（得られた surface 番号を `S` とする）。
2. `S` に `[S] Conductor` 相当の固定名を打つ: `c11 rename-tab --surface surface:S "[S] Conductor"`。
3. `c11 get-metadata --surface surface:S --sources` で `title = [S] Conductor [explicit @ t0]` を記録。
4. `S` の shell で **flag 付き**に interactive claude を起動: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 CMUX_CLAUDE_HOOKS_DISABLED=1 claude`（実プロジェクトと同条件にするため hooks-disabled も付ける）。
5. claude に **recap が出る程度の実作業**をさせる（複数ターンのやり取り / ファイル読み込み等。recap はセッションが進むと出るため、数ターン回す）。
6. recap が出た瞬間前後で `c11 get-metadata --surface surface:S --sources` を**繰り返し**叩き、`title` が `[S] Conductor [explicit @ t0]` のまま固定で、`[S] Claude Code` や recap 文字列に書き換わらないことを確認する。
7. **対照（flag 無し）**: 別の隔離 surface で flag を付けずに同じ操作をし、`[S] Claude Code` への explicit 上書きが**発生する**ことを確認（fix が効いている証拠 = before/after の差分）。
8. 検証後、作成した隔離 surface を全て `c11 close-surface` で閉じる。

> research §3.2 の通り「recap がメタデータ title key に書かれるのか UI overlay だけか」は未確定。手順 6 で `--sources` を連打して **メタデータ title key の値の遷移**を直接観察し、ここで決着させる（Phase 2 の確定項目）。

### 4.2 統合検証（`elevens start` 全経路）

fix + テストが green になった後、worktree 内ではなく実プロジェクトで（または隔離した検証用 dir で）`elevens start` 相当を起こし、4 ロールの surface を確認する:

- **Conductor**: assign を 1 件流し、当該 Conductor surface の title が `[N] Conductor` のまま固定（`get-metadata --sources` で source=explicit が elevens の renameTab timestamp で凍結、`[N] Claude Code` に飛ばない）。
- **Agent**: Conductor から spawn-agent された Agent surface の title が `[N] Agent` のまま固定。
- **Master regression**: `[N] Master` が**従来通り健全**（research §2.1 で Master は元々健全だが、`CMUX_NO_RENAME_TAB` 削除や env 追加で壊れていないこと=回帰が無いことを必ず確認）。
- **restart 経路**: `restart-task` を 1 回流し、再起動後の Conductor title が `[N] Conductor` を維持。

### 4.3 fallback（条件付き — writer が止まらなかった場合のみ発動）

§4.1 手順 6 で **flag を付けても依然 `[N] Claude Code` / recap に書き換わった**場合に限り、research §6.3.3 の追加策を発動する（それ以外では実装しない＝scope を膨らませない）:

- **(優先) renameTab の後追い再実行**: SESSION_STARTED hook（または spawn 後の固定ディレイ）を契機に、`[N] <Role>` を 1〜2 秒後にもう一度 explicit で書き込み、c11 の後追い上書きに last-write-wins で勝つ。
- **(代替) mailbox 等の別 metadata key へ退避**: title は c11 に委ね、`mailbox.role` 等 別キーで UI 表示にロールを逃がす。

> fallback は「OSC 抑止だけでは writer が止まらない」ことが実機で確定した場合の保険。発動条件・どちらを採るかは実機結果を見て判断（その時点で plan を追記 or 別タスク化）。

---

## 5. リスク・スコープ境界

- **c11 は AGPL でコード変更不可**。本 fix はあくまで elevens 側 workaround（claude の OSC 出力を止める）。c11 の内部 explicit-writer 経路自体は直さない。
- **flag 失効リスク**: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` は claude binary 依存（strings に存在を確認済みだが undocumented の可能性）。将来の claude version で flag 名変更 / 廃止により失効しうる。→ §2.1 共有定数に `NOTE(T019)` コメントで明記し、失効時の検知は §4.1 の実機検証手順を再実行すれば分かるようにしておく。
- **OSC 以外の trigger 残存リスク**（research §4.2-2）: c11 が socket/hook 経由など OSC 以外の経路でも `[N] Claude Code` を書く可能性は実験で否定しきれていない。`CMUX_CLAUDE_HOOKS_DISABLED=1` で hook を bypass している前提では関係しないはずだが、§4.1 手順 6 の連続観察で間接的に確認する。残っていれば §4.3 fallback へ。
- **スコープ外**:
  - c11 へのバグ報告（research §6.4 「自動命名は source=explicit でなく heuristic/declare 相当が望ましい」）は**本タスクでは扱わない**。並行 issue として別途起票が望ましい旨だけ記す。
  - main.ts CLI 関数（#3/#4/#5/#6）の unit テスト化のための大規模リファクタは scope 外（§3.4）。
  - opencode backend 経路は対象外（claude 固有 OSC の問題であり、`CLAUDE_CODE_DISABLE_TERMINAL_TITLE` は claude binary 専用）。

---

## 6. 実装順序チェックリスト（実装者向け）

1. `grep -rn CMUX_NO_RENAME_TAB skills/` で現状（set 4 + comment 1、read 0）を再確認。
2. （テストファースト）`conductor.test.ts` に §3.3 の 2 テストを追加 → `bun test --timeout 30000 conductor.test.ts` で **red** を確認。
3. §2.1 の共有定数 `CLAUDE_DISABLE_TITLE_ENV` を導入（util.ts 等）。
4. §2.2 の 6 サイト（最低 #3/#4/#5 必須 + 上流アンカー）に flag を co-location で注入。
5. §2.3 の `CMUX_NO_RENAME_TAB` set 4 箇所削除 + コメント 1 箇所整理。
6. `for f in conductor.test.ts master.test.ts daemon.test.ts; do bun test --timeout 30000 "$f"; done` で **green** を確認（dead flag 削除の回帰含む）。
7. §4.1 隔離検証（before/after 対照付き）→ §4.2 統合検証（4 ロール + restart、Master regression）。
8. 実機で writer が止まらなければ §4.3 fallback 発動を判断（止まれば不要）。
9. コミット（テンプレート編集は無し＝本 fix は manager コードのみ。`.team/prompts/` 再生成は不要）。

---

（plan.md ここまで。実装は本計画に従って別フェーズで行う。）
