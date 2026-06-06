# 実装計画: SUBSTRATE_BINARY のデフォルトを cmux → c11 にする

- Task: 015 / Branch: `task-015-1779267584/task`
- Planner 出力（コードは書かない）
- **改訂 rev2**: Design Review (Changes Requested) を反映。`isC11Backend(env)` の導入と `c11-features.ts:37` getCapabilities ガードの関数評価化を中心に書き換え。指摘 1〜5 をすべて反映済み。

---

## 0. 結論（先出し / rev2 で書き換え）

- **採用は案 A'**（最小、ただし pure 関数を**2 段**挟む）:
  - `cmux.ts:20` の fallback を `"cmux"` → `"c11"` に変更。
  - `cmux.ts` に `resolveSubstrateBinary(env: NodeJS.ProcessEnv): string` を pure 関数として export 追加し、`SUBSTRATE_BINARY` は `resolveSubstrateBinary(process.env)` の結果として保持。
  - **【rev2 で追加】`cmux.ts` に `isC11Backend(env: NodeJS.ProcessEnv = process.env): boolean` を pure 関数として export 追加。**
  - **【rev2 で追加】`maybeLogDeprecationNotice` (cmux.ts:100) と `getCapabilities` (c11-features.ts:37) の 2 箇所のガードを、module-load-time 定数 `IS_C11_BACKEND` から `isC11Backend(process.env)` の都度評価に置換する。**
  - **【rev2 で明示】それ以外の `IS_C11_BACKEND` 参照（`cmux.ts:247` の tree --no-layout / `main.ts:1054` の daemon_started log）は env 切替を想定しないので module-load-time 定数のまま維持する。「触る箇所」と「触らない箇所」を明示的に区分する設計判断として §2 / §5 にドキュメント化する。**

### なぜ「getCapabilities ガードも関数評価化する」のか（Design Review 指摘 1 を踏まえた追記）

- `c11-features.test.ts` / `mailbox-cli.test.ts` の cmux backend 想定 test 群は、各テスト先頭で `delete process.env.ELEVENS_BACKEND;` を呼び「cmux backend で動かす」意図を持つ。default 反転後はこれを `process.env.ELEVENS_BACKEND = "cmux";` に置換する必要があるが、**`SUBSTRATE_BINARY` / `IS_C11_BACKEND` は cmux.ts の module load 時に env を 1 度だけ読んで定数化**されるため、test 内で実行時に env を設定しても module-load-time 定数には反映されない。
- 結果として default 反転後の test process では `IS_C11_BACKEND === true` 固定となり、`if (!IS_C11_BACKEND) return null;` ガードが効かず、cmux backend 想定 test が以下の状態に陥る:
  - **偽 pass パターン**: `getCapabilities` 経路が `execFile("c11", …)` を試みて ENOENT で catch → null 返却 → assertion が「c11 backend の cache fetch 失敗」経由で結果的に pass。本来狙った「`!IS_C11_BACKEND` 早期 return」とは違う経路。観察箱として「テストが狙った経路を通っているか」を検証不能にする。
  - **真 fail パターン**: `mailbox-cli.test.ts` の `setMailbox` / `getMailbox` / `clearMailbox` 経由 test では `execFile("c11", …)` が ENOENT で失敗し、副作用なし期待 assertion が壊れる可能性。
- **`getCapabilities` ガードを `isC11Backend(process.env)` の都度評価に変えれば**、test 内で `process.env.ELEVENS_BACKEND = "cmux";` を設定後に `__resetCapabilitiesCache()` を呼ぶことで、当該 test が狙った「cmux backend 経路で no-op」を実行時に再現できる。
- `c11-features.test.ts:52` の dynamic re-import `await import(\`./c11-features?cmux-${Date.now()}.ts\` as any).catch(() => null)` は **`.ts` 拡張子末尾で bun resolver が解決できず必ず `.catch(() => null)` 経由で static import にフォールバックしている**（実コードのフォールバック存在自体が、これが効かない証拠）。getCapabilities ガードを isC11Backend(process.env) 化すれば、この dynamic re-import の成否に関わらず env 注入が効くようになる。

### module-load-time 定数を完全撤廃しない理由（案 B との境界）

- `IS_C11_BACKEND` という `export const` を撤廃して `runCmux` / e2e helpers / metadata helpers の `execFile(SUBSTRATE_BINARY, …)` を全部関数化（案 B）すると、波及 12+ 箇所 + テスト書き直し膨大。
- 一方で「`tree --no-layout` 付与判定」「`daemon_started` log の backend field」は **env 切替を意図しない**（runtime 中に backend が変わる場面が無い）ため、module-load-time 定数で支障なし。
- したがって本改修は「getCapabilities ガードと deprecation 通知の 2 箇所だけを `isC11Backend()` 関数評価に切り替え、それ以外は module-load-time 定数のまま」という **粒度の異なる扱いを明示的に区分する** 折衷設計を採る。これは [[feedback_minimal_scope]] と整合し、観察箱として test が狙った経路を通る性質も保つ。

### 案 A' vs 案 B 比較（再掲・rev2 更新）

| 観点 | 案 A' (採用) | 案 B (`detectBackendDecision` 結果で実体解決) |
|---|---|---|
| 修正量 | `cmux.ts` (resolveSubstrateBinary + isC11Backend 追加 / fallback 反転) + `c11-features.ts:37` の 1 行置換 + test env 注入の機械置換 + docs | `cmux.ts` を function-export 化 → `e2e.ts` / `c11-features.ts` / `main.ts` の `execFile(SUBSTRATE_BINARY, …)` 5+ 箇所と関連テスト 4 ファイル横断書き換え |
| 後方互換 | `ELEVENS_BACKEND=cmux` 明示で従来通り | 同上 |
| 実機障害の解消 | ✓ env 未設定でも c11 fallback | ✓ + auto-detect でも明示的に c11 |
| auto-detect ハンドリング | `detectBackendDecision` は refuse 判定のみ。SUBSTRATE_BINARY は env 明示 or fallback の 2 値解決 | auto-detect (`CMUX_BUNDLE_ID=com.stage11.c11`) も SUBSTRATE_BINARY に反映 |
| 既存設計判断との整合 | `cmux.ts:17` の現コメント「SUBSTRATE_BINARY 自体は module load 時に確定し続ける」と整合 | 上記コメントを撤回 |
| 観察箱としての test 経路観測 | ✓ getCapabilities ガードを関数評価化することで「cmux backend test が `isC11Backend(process.env) === false` で動いている」ことを直接 assert 可能 | ✓ ただし波及大 |
| minimal scope ([[feedback_minimal_scope]]) | ◯ | ✗ 機構が膨らむ |

**判断**: 実機障害は「fallback の default 値が誤っている」が根本原因。auto-detect で c11 と分かったときに `SUBSTRATE_BINARY` を c11 にしたいケースは、**普通にユーザが c11.app 上で起動した状況であって `ELEVENS_BACKEND` 未設定** ── これは案 A' の default 反転で十分カバーされる。逆に「cmux multiplexer 上で c11 binary を呼びたい」ような変則ケースは現実的に存在せず、存在しても `cmdStart` 経路で refuse される（kind=refuse）。

---

## 1. 現状把握

### 1.1 `cmux.ts` の関連定義（実体スニペット）

`skills/cmux-team/manager/cmux.ts:20`
```ts
export const SUBSTRATE_BINARY: string = process.env.ELEVENS_BACKEND?.trim() || "cmux";
```
`cmux.ts:76-77`
```ts
const SUBSTRATE_BASENAME = SUBSTRATE_BINARY.split("/").pop() ?? SUBSTRATE_BINARY;
export const IS_C11_BACKEND: boolean = SUBSTRATE_BASENAME === "c11";
```
`cmux.ts:42-69` `detectBackendDecision(env)`:
- env 引数を取る pure 関数（process.env 直参照なし）
- 優先順位: `ELEVENS_BACKEND` 明示 → `CMUX_BUNDLE_ID=com.stage11.c11` → `CMUX_BUNDLED_CLI_PATH` に `/c11.app/` → refuse
- `SUBSTRATE_BINARY` には**反映されない**（cmux.ts:17 が明示）

### 1.2 module-load-time 定数であることに依存しているコード

- `cmux.ts:76` 直下で `SUBSTRATE_BASENAME` を即時算出 → `IS_C11_BACKEND` を `export const` で確定。
- `cmux.ts:100` `if (IS_C11_BACKEND) return;`（deprecation 通知のガード）— **【rev2】関数評価化対象**
- `cmux.ts:247` `if (IS_C11_BACKEND && !opts?.json) args.push("--no-layout");`（c11 only flag）— module-load-time 定数のまま維持
- `c11-features.ts:37` `if (!IS_C11_BACKEND) return null;`（capabilities ガード）— **【rev2】関数評価化対象**
- `main.ts:1054` `backend: cmux.IS_C11_BACKEND ? "c11" : "cmux"`（`daemon_started` log 用）— module-load-time 定数のまま維持

**関数評価化対象 (2 箇所)** と **module-load-time 定数維持 (2 箇所)** を明示的に区分する点が rev2 の核心。

### 1.3 `detectBackendDecision` との関係（矛盾の構造）

- `cmdStart` (main.ts:794–803) は起動時に `detectBackendDecision(process.env)` を呼び refuse → exit 1。
- `kind=auto`（CMUX_BUNDLE_ID=com.stage11.c11 等で c11 と判定）の場合は起動許可するが、その時点で `SUBSTRATE_BINARY` は module load 時に "cmux" として既に確定済み → 以降 `runCmux` が `execFile("cmux", …)` を呼んでしまう。
- 本実機障害の発生条件: c11.app 上 / `ELEVENS_BACKEND` 未設定 → refuse は回避されるが SUBSTRATE_BINARY が "cmux" → cmux binary が PATH に無く Agent spawn が無言で失敗。
- **default を c11 に変えれば、`kind=auto` 経路と `SUBSTRATE_BINARY` の解決値が一致し矛盾解消。**

---

## 2. 参照箇所の網羅

### 2.1 `SUBSTRATE_BINARY` 参照（テスト除く実装コード）

| File:Line | 用途 |
|---|---|
| `skills/cmux-team/manager/cmux.ts:20` | 定義（**変更対象**） |
| `skills/cmux-team/manager/cmux.ts:76` | `SUBSTRATE_BASENAME` 派生 |
| `skills/cmux-team/manager/cmux.ts:122` | `runCmux` 内の `execFile` |
| `skills/cmux-team/manager/e2e.ts:32` | import |
| `skills/cmux-team/manager/e2e.ts:65,71,77,83` | E2E ヘルパの `execFile` 4 箇所 |
| `skills/cmux-team/manager/c11-features.ts:12` | import |
| `skills/cmux-team/manager/c11-features.ts:40,119,147,197` | capabilities / set / get / clear の `execFile` |

### 2.2 `IS_C11_BACKEND` 参照（テスト除く実装コード）

| File:Line | 用途 | rev2 での扱い |
|---|---|---|
| `skills/cmux-team/manager/cmux.ts:77` | 定義 | 維持（export shape は変えない） |
| `skills/cmux-team/manager/cmux.ts:100` | `maybeLogDeprecationNotice` ガード | **`isC11Backend(process.env)` に置換** |
| `skills/cmux-team/manager/cmux.ts:247` | `tree` の `--no-layout` 付与 | module-load-time 定数のまま維持 |
| **`skills/cmux-team/manager/c11-features.ts:37`** | **`getCapabilities` ガード** | **`isC11Backend(process.env)` に置換（rev2 で新規追加）** |
| `skills/cmux-team/manager/main.ts:1054` | `daemon_started` log の `backend=` フィールド | module-load-time 定数のまま維持 |
| `skills/cmux-team/manager/main.ts:253` | コメント | 触らない |
| `skills/cmux-team/manager/main.ts:797` | コメント | 触らない |

### 2.3 `ELEVENS_BACKEND` 参照（テスト除く実装コード）

| File:Line | 用途 |
|---|---|
| `skills/cmux-team/manager/cmux.ts:13,20,29,43,55` | コメント + 解決ロジック |
| `skills/cmux-team/manager/cmux.ts:107` | `DEPRECATION_NOTICE` メッセージ本文 |
| `skills/cmux-team/manager/main.ts:1053` | コメント |

### 2.4 docs / その他参照（実装影響なし、文言更新対象）

- `README.md:77-98` / `README.ja.md:77-98` Substrate backend セクション
- `docs/seed.md:121,143` Phase 1 / Phase 3 記述
- `skills/c11/SKILL.md:9,17` description / 本文
- `CHANGELOG.md` 多数（過去履歴は触らない、新 entry 追加のみ）
- `CLAUDE.md` — 【rev2 で追加】grep 確認のみ実施（後述 §4 チェックリスト）
- `.team/artifacts/A028, A029, A030` 等は history（更新不要）

---

## 3. テストへの影響

`grep "ELEVENS_BACKEND" --include="*.test.ts"` の対象 = **4 ファイル**。rev2 で書き換えた修正方針を以下に列挙する。

### 3.1 `skills/cmux-team/manager/cmux.test.ts`

#### 3.1.1 `detectBackendDecision` テスト群（line 44–118）
- 純粋関数を env 引数渡しで呼ぶだけ。**default 反転の影響なし**。変更不要。

#### 3.1.2 `maybeLogDeprecationNotice` テスト群（line 212–266）— **修正必須（rev2 で方針確定）**
- 現状 top-level の `beforeEach` で `ELEVENS_BACKEND` を明示設定していないため、`SUBSTRATE_BINARY` は module load 時に env を読んで定数化。テスト harness の前提は「default = cmux」。
- default を c11 に変えると `IS_C11_BACKEND === true` 確定 → `maybeLogDeprecationNotice` の `if (IS_C11_BACKEND) return;` で no-op → `DEPRECATION_NOTICE` が log されない → line 248 `expect(log).toContain("DEPRECATION_NOTICE")` が fail。
- **rev2 採用方針**: `maybeLogDeprecationNotice` 内部の `if (IS_C11_BACKEND) return;` を **`if (isC11Backend(process.env)) return;`** に置換する。これにより test の `beforeEach` で `process.env.ELEVENS_BACKEND = "cmux";` を設定すれば、関数評価時に cmux backend と判定されて DEPRECATION_NOTICE が log される。
- `cmux.test.ts:241-244` のコメントブロック（テストハーネス前提の「default で cmux backend として走る」記述）を書き換え、`beforeEach` で `process.env.ELEVENS_BACKEND = "cmux"` を設定する harness に移行。`afterEach` で cleanup（restore）を入れる。

#### 3.1.3 想定する新テスト（RED から書く）
1. `resolveSubstrateBinary({})` === `"c11"`（env 空で c11 fallback）
2. `resolveSubstrateBinary({ ELEVENS_BACKEND: "cmux" })` === `"cmux"`（opt-in 維持）
3. `resolveSubstrateBinary({ ELEVENS_BACKEND: "/opt/c11/bin/c11" })` === `"/opt/c11/bin/c11"`（絶対パス透過）
4. `resolveSubstrateBinary({ ELEVENS_BACKEND: "   " })` === `"c11"`（whitespace trim 後 falsy で fallback）
5. SUBSTRATE_BINARY が module load 時に `resolveSubstrateBinary(process.env)` と一致すること（regression 防止）

**【rev2 で追加】`isC11Backend` の新テスト**:
6. `isC11Backend({})` === `true`（env 空で c11 fallback）
7. `isC11Backend({ ELEVENS_BACKEND: "cmux" })` === `false`（cmux opt-in）
8. `isC11Backend({ ELEVENS_BACKEND: "c11" })` === `true`（明示）
9. `isC11Backend({ ELEVENS_BACKEND: "/opt/c11-dev/bin/c11" })` === `true`（basename 判定）
10. `isC11Backend({ ELEVENS_BACKEND: "/opt/cmux/bin/cmux" })` === `false`（basename 判定）

### 3.2 `skills/cmux-team/manager/c11-features.test.ts` — **修正必須（rev2 で方針確定）**

各テスト先頭の `delete process.env.ELEVENS_BACKEND;`（line 51, 69, 82, 94, 108, 159）は「cmux backend として動かす」意図。
- default 反転後、これらは「c11 backend として動かす」に意味が変わってしまう。
- **【rev2 採用方針】** `delete process.env.ELEVENS_BACKEND;` を `process.env.ELEVENS_BACKEND = "cmux";` に全置換（6 箇所）。
- **【rev2 で重要】** これが「実行時に意味を持つ」のは、`getCapabilities` ガード (c11-features.ts:37) を `isC11Backend(process.env)` 関数評価に切り替えるため。単純置換だけでは module-load-time 定数依存で偽 pass / 真 fail に陥る（Design Review 指摘 1 で明示）。
- 各 test の env 設定直後に `__resetCapabilitiesCache()` を呼び、c11-features 側の cached capabilities をリセットすること（これは既存 test も同等の呼び出しがあるが、env 切替を機能させるためには明示的に必要）。
- `afterEach` の cleanup（`delete process.env.ELEVENS_BACKEND`）は既存のままでよい。
- line 191 の `if (process.env.ELEVENS_BACKEND !== "c11") return;` は逆条件（c11 環境でのみ走る test）なので変更不要。

#### 影響アサーションの例
- line 59 `expect(await isMailboxSupported()).toBe(false)` — cmux backend 前提。env を `"cmux"` で明示 + `isC11Backend()` 関数評価化により、`!isC11Backend(process.env)` が true → getCapabilities が null 返却 → isMailboxSupported() が false。**狙った経路を通る。**
- line 72-78, 87-91, 99-103 の `setMailbox` 系も同様（cmux backend だと no-op or throw 想定）。

### 3.3 `skills/cmux-team/manager/mailbox-cli.test.ts` — **修正必須（rev2 で方針確定）**

`delete process.env.ELEVENS_BACKEND;` は line 50, 60, 80, 93, 106, 133, 153, 174 の **8 箇所**。すべて c11-features.test.ts と同じ方針で `process.env.ELEVENS_BACKEND = "cmux";` に置換。
- `__resetCapabilitiesCache()` を呼ぶことで `c11-features` 側の cached capabilities もリセットされるため、env 切替後の挙動も正しい。
- `runMailboxCli` の "supported" / "set" / "get" / "clear" は内部で `getCapabilities()` / `setMailbox()` / `getMailbox()` / `clearMailbox()` を呼び、最初の関数は `isC11Backend(process.env)` ガードで早期 return（rev2 で追加）、後者 3 つは `getCapabilities` 経由で no-op となる。

### 3.4 `skills/cmux-team/manager/main.test.ts` — **変更不要**

`formatDaemonStartedDetail` テスト群（line 3789–3870）は pure 関数に `backend` を引数で渡す形でテストされているため、default 反転の影響を受けない。**現状維持**。

### 3.5 検証コマンド

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-015-1779267584/skills/cmux-team/manager
for f in cmux.test.ts c11-features.test.ts mailbox-cli.test.ts main.test.ts; do
  bun test --timeout 30000 "$f"
done
```

> **`bun test` 全体実行は禁忌**（CLAUDE.md 注意点）。上記の個別ファイル実行を厳守。

---

## 4. docs / コメント 更新箇所（rev2: 具体文言 draft を追加）

### 4.1 コード内コメント・メッセージ

| File:Line | 現状 | 変更後（具体 draft） |
|---|---|---|
| `skills/cmux-team/manager/cmux.ts:13-14` | "`ELEVENS_BACKEND=c11` で c11、`ELEVENS_BACKEND=cmux`（または未設定）で cmux。" | `Substrate binary 名（cmux 互換 multiplexer）。\n * 未設定または \`ELEVENS_BACKEND=c11\` で c11（default）、\`ELEVENS_BACKEND=cmux\` で legacy cmux。\n * 任意の文字列も受け付ける（絶対パスやカスタムビルド差し替え用）。` |
| `skills/cmux-team/manager/cmux.ts:17` | "ただし SUBSTRATE_BINARY 自体は module load 時に確定し続ける（既存テスト互換）。" | `ただし SUBSTRATE_BINARY 自体は module load 時に env を 1 回読んで確定する（auto-detect とは別経路）。\n * runtime での backend 切替は \`isC11Backend(env)\` の都度評価で対応する（test 時の env 注入が効くようにするため、deprecation 通知と getCapabilities ガードがこの方式）。` |
| `skills/cmux-team/manager/cmux.ts:107` | "cmux backend is deprecated and will become non-default in v0.3.0. Set ELEVENS_BACKEND=c11 to migrate. See docs/seed.md Phase 3." | `cmux backend is deprecated and no longer the default (v0.9.0+). Unset ELEVENS_BACKEND or set ELEVENS_BACKEND=c11 to use c11. See docs/seed.md Phase 3.` |

### 4.2 docs（具体文言 draft）

| File:Line | 現状 | 変更後（具体 draft） |
|---|---|---|
| `README.md:83` 表 c11 行 | `\| \`c11\` ... \| \`export ELEVENS_BACKEND=c11\` \| **Recommended.** Becomes the default in v0.3.0 (Phase 3, see [\`docs/seed.md\`](docs/seed.md)). \|` | `\| \`c11\` ([Stage-11-Agentics/c11](https://github.com/Stage-11-Agentics/c11)) \| default; or explicit \`export ELEVENS_BACKEND=c11\` \| **Default since v0.9.0.** Recommended. \|` |
| `README.md:84` 表 cmux 行 | `\| \`cmux\` ... \| unset, or \`export ELEVENS_BACKEND=cmux\` \| Legacy compat. Default through v0.2.x; **deprecated** ... \|` | `\| \`cmux\` ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)) \| \`export ELEVENS_BACKEND=cmux\` (legacy opt-in) \| Legacy compat. **Deprecated** — daemon emits a one-shot \`DEPRECATION_NOTICE\` warning on start. \|` |
| `README.md:86-90` migration 案内 | `The cmux backend keeps working for now but will lose default status in v0.3.0. To migrate today:\n\n\`\`\`bash\nexport ELEVENS_BACKEND=c11   # or set in your shell rc / direnv .envrc\n\`\`\`` | `c11 is the default since v0.9.0; no env var is required for new setups. If you previously pinned \`ELEVENS_BACKEND=cmux\`, unset it (or change to \`c11\`) to migrate:\n\n\`\`\`bash\nunset ELEVENS_BACKEND   # or: export ELEVENS_BACKEND=c11\n\`\`\`` |
| `README.ja.md:83` 表 c11 行 | `... \| **推奨設定。** v0.3.0 でデフォルトに昇格します（Phase 3、詳細は [\`docs/seed.md\`](docs/seed.md)）。 \|` | `\| \`c11\` ([Stage-11-Agentics/c11](https://github.com/Stage-11-Agentics/c11)) \| デフォルト。明示するなら \`export ELEVENS_BACKEND=c11\` \| **v0.9.0 以降デフォルト。** 推奨設定。 \|` |
| `README.ja.md:84` 表 cmux 行 | `... \| 未設定 または \`export ELEVENS_BACKEND=cmux\` \| レガシー互換。v0.2.x まではデフォルトですが**deprecated** ... \|` | `\| \`cmux\` ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)) \| \`export ELEVENS_BACKEND=cmux\` で opt-in \| レガシー互換。**deprecated** — daemon 起動時に \`DEPRECATION_NOTICE\` の警告を 1 度だけ出します。 \|` |
| `README.ja.md:86-90` 移行案内 | `cmux backend は当面そのまま動作しますが、v0.3.0 でデフォルトの座を譲ります。今のうちに移行するには:\n\n\`\`\`bash\nexport ELEVENS_BACKEND=c11 ...\n\`\`\`` | `c11 は v0.9.0 以降デフォルトのため、新規セットアップでは環境変数の設定は不要です。以前 \`ELEVENS_BACKEND=cmux\` を pin していた場合は、unset するか \`c11\` に変更してください:\n\n\`\`\`bash\nunset ELEVENS_BACKEND   # または: export ELEVENS_BACKEND=c11\n\`\`\`` |
| `docs/seed.md:121` Phase 1 | `\`cmux.ts\` adapter を env で backend 切替可能に（\`ELEVENS_BACKEND=c11\|cmux\`、default は当面 cmux）` | `✅ \`cmux.ts\` adapter を env で backend 切替可能に（\`ELEVENS_BACKEND=c11\|cmux\`、Phase 1 時点では default cmux）` |
| `docs/seed.md:143` Phase 3 | `- \`ELEVENS_BACKEND\` の default を c11 に切替` | `- ✅ \`ELEVENS_BACKEND\` の default を c11 に切替（v0.9.0、T015）` |
| `skills/c11/SKILL.md:9` description | `\`ELEVENS_BACKEND=c11\` / cmux との差分。` | `\`ELEVENS_BACKEND=c11\` (default since v0.9.0) / cmux との差分。` |
| `skills/c11/SKILL.md:17` | `elevens は **c11 (Stage-11-Agentics/c11) を substrate として動く**。\`ELEVENS_BACKEND=c11\` で c11 を使い、\`cmux\` (manaflow-ai/cmux) は legacy backend として残る（v0.3.0 で c11 が default 化予定）。` | `elevens は **c11 (Stage-11-Agentics/c11) を substrate として動く**。v0.9.0 以降は env 未設定でも c11 が default。\`ELEVENS_BACKEND=cmux\` で legacy cmux に opt-in 可能（deprecated）。` |

> バージョン番号は実装時点での `package.json` 値（現在 `0.8.2` → 次回 `v0.9.0` 想定）に合わせる。release 直前に最終確認。

### 4.3 CHANGELOG.md 新 entry（rev2 で追加 1 行）

次回 release セクション（`## [Unreleased]` または `## [0.9.0]`）に以下を追加:

```markdown
### Changed
- **Substrate backend default reversed**: `SUBSTRATE_BINARY` now falls back to `"c11"` instead of `"cmux"` when `ELEVENS_BACKEND` is unset (T015). Resolves the silent Agent spawn failure on c11.app when `ELEVENS_BACKEND` was unset and the cmux binary was missing from `PATH`.
- Added `resolveSubstrateBinary(env)` and `isC11Backend(env)` as pure functions exported from `skills/cmux-team/manager/cmux.ts` to make backend resolution testable without module-load-time side effects.
- **【rev2 追加】Test harness の getCapabilities ガード（`c11-features.ts:37`）と deprecation 通知ガード（`cmux.ts:100`）を `isC11Backend(process.env)` 関数評価化（推奨案 1 採用、Design Review T015 で確定）。これにより cmux backend 想定 test が runtime env 注入で意図通り動作する**。他の `IS_C11_BACKEND` 参照（tree --no-layout / daemon log）は env 切替を想定しないため module-load-time 定数のまま維持。
- `DEPRECATION_NOTICE` message updated to reflect that c11 is now the default.

### Compatibility
- `ELEVENS_BACKEND=cmux` continues to opt into the legacy cmux backend with the existing deprecation warning.
- `ELEVENS_BACKEND=/path/to/custom-c11-build` (absolute path / custom builds) is unchanged.
```

### 4.4 CLAUDE.md grep 確認（rev2 で追加チェックリスト）

実装フェーズで以下を実行し、Substrate backend / ELEVENS_BACKEND default に関する記述が CLAUDE.md および docs 横断で取りこぼされていないか確認する:

```bash
cd /Users/yamamoto/git/elevens/.worktrees/task-015-1779267584
grep -n "ELEVENS_BACKEND\|SUBSTRATE\|substrate\|default.*cmux\|cmux.*default" CLAUDE.md docs/**/*.md README.md README.ja.md skills/c11/SKILL.md skills/cmux-team/SKILL.md 2>/dev/null
```

- 既知の予測: CLAUDE.md 本体には Substrate backend / ELEVENS_BACKEND の default 値に関する明示記述は **無い**（grep 結果は line 78 / 84 の c11 SKILL.md / substrate ライブラリ言及のみ）。grep 実施は「default が変わった」事実が予期せぬ箇所で残っていないことの確認のため必須。
- 万一 CLAUDE.md / docs/spec/ 配下に「default は cmux」相当の記述が残っていたら、§4.2 と同じ調子で「v0.9.0 以降 default は c11」に更新する。

### 4.5 version 文字列の二重管理回避指針

- 具体的バージョン番号 (`v0.9.0`) は **CHANGELOG.md に集約**し、SKILL.md / README / seed.md では「v0.9.0 以降」「最新リリース時点で default」程度の言及に留める方針を §4.2 の draft 文言で具現化した。
- ただし PEPC とリリース時の package.json バージョン値が一致しないリスクは残るので、release 時に再 grep する。

---

## 5. 案 A'/B の選択と根拠（再掲・サマリ）

採用: **案 A'**（fallback 反転 + `resolveSubstrateBinary(env)` + `isC11Backend(env)` の 2 つの pure 関数追加 + getCapabilities ガードと deprecation 通知ガードの関数評価化）。
- module-load-time 定数の構造を「触る箇所」と「触らない箇所」で明示区分する設計判断は rev2 で確立。
- 案 B は `SUBSTRATE_BINARY` を「実行時に評価される値」に変える破壊的リファクタを要求するが、本タスクのスコープ「実機障害の解消」「c11-first 方針との整合」「観察箱として test が狙った経路を通る」を満たすには不要。
- minimal scope（[[feedback_minimal_scope]]）と整合し、既存テスト 4 ファイルへの波及も「env 明示注入への置換 + 関数評価化対象 1 行の書き換え」という単純な mechanical edit で済む。

### 5.1 module-load-time 定数を **部分的に** 維持する是非（rev2 で書き換え）

- **「触る箇所」**: `maybeLogDeprecationNotice` ガード / `getCapabilities` ガード → test 内で env 注入を機能させる必要があるため `isC11Backend(env)` 関数評価化。
- **「触らない箇所」**: `tree --no-layout` 付与 / `daemon_started` log の backend field → runtime で backend が変わる場面が無く、module-load-time 定数で支障なし。
- この区分は「test 経路観測のために必要な箇所だけを最小限関数化する」観察箱原則（CLAUDE.md「observatory に資するか」）と整合する。

---

## 6. TDD 手順（実装フェーズ用 / rev2 で書き換え）

> Planner（本ドキュメント）はコードを書かない。以下は Implementer 向けの実行順。

### Step 1: RED — 新テスト追加（`cmux.test.ts`）

`describe("resolveSubstrateBinary (T015)")` を追加し、§3.1.3 の 1〜5 ケース。
`describe("isC11Backend (T015)")` を追加し、§3.1.3 の 6〜10 ケース。
- まだ `resolveSubstrateBinary` / `isC11Backend` は未実装なので import エラー or assertion fail で RED。

### Step 2: GREEN — `cmux.ts` を最小変更

```ts
// cmux.ts
export function resolveSubstrateBinary(env: NodeJS.ProcessEnv): string {
  return env.ELEVENS_BACKEND?.trim() || "c11";
}

export function isC11Backend(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = resolveSubstrateBinary(env);
  const basename = binary.split("/").pop() ?? binary;
  return basename === "c11";
}

export const SUBSTRATE_BINARY: string = resolveSubstrateBinary(process.env);
// IS_C11_BACKEND は維持（runtime 不変の参照箇所が依存している）
const SUBSTRATE_BASENAME = SUBSTRATE_BINARY.split("/").pop() ?? SUBSTRATE_BINARY;
export const IS_C11_BACKEND: boolean = SUBSTRATE_BASENAME === "c11";
```
- コメント（line 13-18）も §4.1 の draft に合わせて更新。

### Step 3: RED → GREEN — 既存テストの環境前提と実装 2 箇所を関数評価に切替

3-a. **`cmux.ts:100` の `maybeLogDeprecationNotice` ガードを関数評価化**:
```ts
if (isC11Backend(process.env)) return;
```
3-b. **`c11-features.ts:37` の `getCapabilities` ガードを関数評価化**:
```ts
// c11-features.ts:12 で IS_C11_BACKEND の import を isC11Backend に置換
import { SUBSTRATE_BINARY, isC11Backend } from "./cmux";
// :37
if (!isC11Backend(process.env)) return null;
```
3-c. **`cmux.test.ts:212-266` `maybeLogDeprecationNotice` テスト**:
- `beforeEach` で `process.env.ELEVENS_BACKEND = "cmux";` 明示注入。`afterEach` で restore。
- line 241-244 のコメントブロックを「test harness が `isC11Backend(process.env) === false` で動く」に書き換え。
- **【rev2 追加】観察箱として狙った経路を assert**: deprecation 通知 test 内で `expect(isC11Backend(process.env)).toBe(false);` を追加して「cmux backend 経路で動いている」ことを明示。

3-d. **`c11-features.test.ts`**:
- `delete process.env.ELEVENS_BACKEND;`（6 箇所: line 51, 69, 82, 94, 108, 159）→ `process.env.ELEVENS_BACKEND = "cmux";`
- env 設定直後に `__resetCapabilitiesCache()` を呼ぶ（既存呼び出しがある test はそのまま、無い test には追加）。
- **【rev2 追加】観察箱 assert**: 各 cmux backend 想定 test の冒頭（env 設定後）で `expect(isC11Backend(process.env)).toBe(false);` を追加して経路観測を確実化。

3-e. **`mailbox-cli.test.ts`**:
- `delete process.env.ELEVENS_BACKEND;`（8 箇所: line 50, 60, 80, 93, 106, 133, 153, 174）→ `process.env.ELEVENS_BACKEND = "cmux";`
- **【rev2 追加】観察箱 assert**: 各 cmux backend 想定 test の冒頭で `expect(isC11Backend(process.env)).toBe(false);` を追加。

### Step 4: GREEN — テスト個別実行で全 pass + 経路観測 assertion が走っていることを確認

```bash
cd skills/cmux-team/manager
for f in cmux.test.ts c11-features.test.ts mailbox-cli.test.ts main.test.ts; do
  bun test --timeout 30000 "$f"
done
```

**【rev2 追加】GREEN 確認の防御**:
- Step 3-d / 3-e で追加した `expect(isC11Backend(process.env)).toBe(false);` が pass していること = cmux backend 想定 test が**狙った経路を通っている**証拠。
- `isC11Backend(process.env) === true` が混入していたら（rev2 の関数評価化漏れ）、Step 3-d / 3-e の assert で確実に検出される。
- これにより「偽 pass（ENOENT catch 経由）」を構造的に排除する。

### Step 5: docs / コメント更新（§4 の draft をそのまま反映）

- `cmux.ts:13-18, 107` のコメント / メッセージ → §4.1 の draft 通り
- `c11-features.ts:12` の import 変更（`IS_C11_BACKEND` → `isC11Backend`）
- `README.md:83-90` Substrate backend 表 + 移行案内 → §4.2 の draft 通り
- `README.ja.md:83-90` 同上
- `docs/seed.md:121,143` Phase 1 / Phase 3 → §4.2 の draft 通り
- `skills/c11/SKILL.md:9,17` → §4.2 の draft 通り
- `CHANGELOG.md` 新 entry → §4.3 の文面そのまま追加
- **【rev2 追加】CLAUDE.md / docs 横断 grep（§4.4）を実施し、想定外の「default cmux」記述が残っていないか確認**

### Step 6: 手動 smoke（任意、CI 不要）

```bash
# default が c11 になっていることを確認
unset ELEVENS_BACKEND
bun -e 'import("./skills/cmux-team/manager/cmux.ts").then(m => console.log({s: m.SUBSTRATE_BINARY, c11: m.IS_C11_BACKEND, isC11: m.isC11Backend(process.env)}))'
# expected: { s: 'c11', c11: true, isC11: true }

# opt-in 維持の確認
ELEVENS_BACKEND=cmux bun -e 'import("./skills/cmux-team/manager/cmux.ts").then(m => console.log({s: m.SUBSTRATE_BINARY, c11: m.IS_C11_BACKEND, isC11: m.isC11Backend(process.env)}))'
# expected: { s: 'cmux', c11: false, isC11: false }
```

---

## 7. 触らない / 注意

- `detectBackendDecision` の **refuse ロジック自体は変更しない**（c11-first の意図維持、タスク制約より）。
- `IS_C11_BACKEND` の export shape を維持（`cmux.ts:247` の tree --no-layout / `main.ts:1054` の log フィールドが依存）。**ただし `cmux.ts:100` の deprecation 通知ガードと `c11-features.ts:37` の getCapabilities ガードでの参照は `isC11Backend(process.env)` に置換する。**
- `c11-features.ts` / `e2e.ts` / `main.ts` の `SUBSTRATE_BINARY` 参照は読み替えなしでそのまま動く。
- `bun test` 全体実行禁止。個別ファイル実行のみ。
- `CHANGELOG.md` の **過去エントリは触らない**（"v0.3.0 で default 化予定" 等の歴史的記述は残す）。新エントリのみ追加。
- `.team/artifacts/A028` 等の過去 artifact も触らない。

---

## 8. 完了条件（タスク完了の判定基準 / rev2 で追加項目あり）

- [ ] `ELEVENS_BACKEND` 未設定で `SUBSTRATE_BINARY === "c11"` / `IS_C11_BACKEND === true` / `isC11Backend(process.env) === true`
- [ ] `ELEVENS_BACKEND=cmux` で `SUBSTRATE_BINARY === "cmux"` / `IS_C11_BACKEND === false` / `isC11Backend(process.env) === false`（後方互換）
- [ ] `cmux.test.ts` / `c11-features.test.ts` / `mailbox-cli.test.ts` / `main.test.ts` の個別実行が全て pass
- [ ] `resolveSubstrateBinary` の新規 5 ケースが pass（RED → GREEN）
- [ ] **【rev2】`isC11Backend` の新規 5 ケースが pass（RED → GREEN）**
- [ ] **【rev2】`c11-features.ts:37` の getCapabilities ガードが `isC11Backend(process.env)` に置換済み**
- [ ] **【rev2】cmux backend 想定 test が `isC11Backend(process.env) === false` を明示 assert している（観察箱として経路観測可能）**
- [ ] `cmux.ts:13-18` / `cmux.ts:107` のコメント・メッセージ更新（§4.1 の draft 通り）
- [ ] `README.md` / `README.ja.md` の Substrate backend セクション更新（§4.2 の draft 通り）
- [ ] `docs/seed.md` Phase 1 / Phase 3 の完了マーキング（§4.2 の draft 通り）
- [ ] `skills/c11/SKILL.md:9, 17` の「予定 → 済み」変更（§4.2 の draft 通り）
- [ ] **【rev2】`CHANGELOG.md` 新 entry 追加（§4.3 の文面、test harness 関数評価化の経緯も含む）**
- [ ] **【rev2】CLAUDE.md / docs 横断 grep 確認（§4.4）を実施し、取りこぼした「default cmux」記述が無いことを確認**
- [ ] 手動 smoke (unset / =cmux) で実機挙動確認

---

## 9. リスク評価（rev2 で追加項目あり）

| リスク | 影響度 | 対応 |
|---|---|---|
| `maybeLogDeprecationNotice` / `getCapabilities` の関数評価化が他テストに波及 | 低 | 関数評価化対象は明示的に 2 箇所のみ。他の `IS_C11_BACKEND` 利用箇所（tree --no-layout / daemon log）は runtime 中に env 切替する想定が無く、module-load-time 定数のままで安全 |
| 【rev2 追加】`c11-features.ts:12` の import 変更（`IS_C11_BACKEND` 追加削除 + `isC11Backend` 追加）が他参照に波及 | 低 | `c11-features.ts` 内部での `IS_C11_BACKEND` 参照は line 37 のみ。他は `SUBSTRATE_BINARY` のみ参照 |
| `ELEVENS_BACKEND=cmux` で運用していたユーザの DEPRECATION_NOTICE メッセージ更新が breaking と取られる | 低 | 通知の存在条件は不変（cmux backend のみ）。文言の更新は警告強化として許容範囲 |
| `c11-features.test.ts` / `mailbox-cli.test.ts` の env 注入を `=cmux` に変える機械的置換ミス | 低 | grep + diff で 6 + 8 = 14 箇所を厳密に確認。rev2 では各 test に `expect(isC11Backend(process.env)).toBe(false);` の明示 assert を追加するため、置換漏れがあれば即座に test fail で検出される |
| 【rev2 追加】観察箱 assert (`expect(isC11Backend(process.env)).toBe(false)`) を追加することで test の意図が逆方向に伝わる | 極低 | コメントで「cmux backend 想定の経路観測 assert」と明示する |
| sub-process / E2E テスト（リポジトリ内に他に存在しないか？） | 低 | grep で `SUBSTRATE_BINARY` / `ELEVENS_BACKEND` を全網羅済み。`e2e.ts` は spec 用ヘルパで test file ではない |
| 別 worktree / npm 公開済みパッケージへの影響 | 低 | env 明示注入で従来挙動を再現できるため、`ELEVENS_BACKEND=cmux` を export している既存運用は無影響 |

---

## 10. 参考（調査時に確認した周辺事実）

- `package.json` 現バージョン: `0.8.2`（次回 `v0.9.0` を想定）
- v0.4.0 で `detectBackendDecision` を pure 関数として分離済み → 今回の改修と整合的
- v0.4.0 までは「auto-detect で c11 と分かったら refuse 回避」だが SUBSTRATE_BINARY は未連動 → これが実機障害の構造
- CHANGELOG.md は過去履歴 (line 100-189, 244-250) に substrate adapter PoC / refuse 経路の進化が記録されているが、いずれも今回触らない
- `.team/artifacts/A028` の Phase 1 PoC 結果が `SUBSTRATE_BINARY` 導入の起点（default cmux の経緯記録）
- **【rev2 追加】** Design Review (`design-review.md`) で Recommendations 案 1（c11-features.ts の getCapabilities ガードも関数評価化）を採用。観察箱としての test 経路観測力を保ちつつ、module-load-time 定数を完全撤廃しない折衷設計を確立。
- **【rev2 追加】** `c11-features.test.ts:52` の dynamic re-import (`await import(\`./c11-features?cmux-${Date.now()}.ts\`)`) は `.ts` 拡張子末尾で bun resolver が解決できず必ず catch fallback → static import → module cache の同一 instance が返る。これに依存した env 注入は機能していない。getCapabilities ガードを isC11Backend(process.env) 化することでこの脆弱性も解消される。
