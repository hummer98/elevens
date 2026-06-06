# T016 Inspection

## 判定
**GO**

## サマリー

plan.md rev-2 / design-review.md 申し送り 5 項目に沿って、cmux backend 削除と fail-fast 化が実装されている。完了条件 10 項目すべてを実機検証で OK 確認。T016 で触ったファイル（cmux.ts / main.ts / daemon.ts / schema.ts / c11-features.ts / layout-restore.ts / conductor.ts および対応 test / docs）の T016 関連テストはすべて pass、tsc の新規エラーゼロ（pre-existing 10 件は本タスク改変前と同一）。誤削除（CMUX_* env / cmux.ts / SUBSTRATE_BINARY シンボル / refuse 検出経路）も無し。Minor 注記 1 件（skills/c11/SKILL.md L17 に `ELEVENS_BACKEND` の歴史的言及が残るが、撤去を明示する migration 説明文として正当な記述）。

## 完了条件チェック結果

| # | 条件 | 結果 | 根拠（実行コマンド・出力） |
|---|---|---|---|
| 1 | c11 解決不能環境で fail-fast (detectBackendDecision refuse + cmdStart exit 1) | OK | `skills/cmux-team/manager/cmux.ts` の `detectBackendDecision` が `{ kind: "c11" \| "refuse" }` 2 値判定に単純化。`main.ts:798-803` で `if (backendDecision.kind === "refuse") { console.error(...); process.exit(1); }`。cmux.test.ts 30/30 pass で refuse 経路 (`com.manaflow.cmux` 検出 / non-c11 multiplexer / 通常 shell) を検証 |
| 2 | cmux バイナリ実行経路ゼロ | OK | `grep -rn '"cmux"' --include="*.ts" skills/cmux-team/manager/ \| grep -v test \| grep -v "com.manaflow.cmux"` → **0 件**。refuse 検出用の `com.manaflow.cmux` だけが残存（仕様通り） |
| 3 | ELEVENS_BACKEND で逃げられない | OK | `grep -rn "ELEVENS_BACKEND" --include="*.ts" skills/` の結果はすべてコメント / docstring / テスト内 (`__setCapabilitiesForTest` 経路の比較用 / `expect(...).not.toContain("ELEVENS_BACKEND")` 等)。SUBSTRATE_BINARY 解決経路 (`resolveC11Binary` cmux.ts:50-)、`detectBackendDecision` のいずれにも実コード参照なし。cmux.test.ts L87-156 が「ELEVENS_BACKEND=cmux でも refuse」「c11 でも env 参照されない」を assert |
| 4 | 操作レベル fail-fast | OK | (a) `getPaneForSurface` (cmux.ts) / `fetchLiveSurfaces` の tree 失敗が throw 化（test で確認、cmux.test.ts 30 pass）。(b) `cmdSpawnAgent` (main.ts:3572-3835) で `newSurface(targetPane)` 失敗時は `newSplit` フォールバックを廃止し、catch で `AGENT_SPAWN_FAILED` を post して exit 1。(c) `layout-restore.ts` の `liveSurfaces: Set<string>` (non-null) に変更され `pid_only` degrade 削除。(d) `daemon.ts:1372 fetchLiveSurfacesWithRetry` で 200/600/1500ms backoff の 3 回 retry 後 `initializeLayout` で throw → exit 1 経路に統合 |
| 5 | spawn-agent silent fail 解消 | OK | `main.ts:3568-3835` 全体を try/catch で覆い、catch で `manager.log` (postMessage 失敗時 fallback) + `daemon に AGENT_SPAWN_FAILED post` + `process.exit(1)`。`schema.ts` で `AgentSpawnFailedMessage = { type: "AGENT_SPAWN_FAILED"; conductor: string; role: string; surface?: string; ... }` 定義（surface optional）。`daemon.ts:2034-2070` handler が surface ありなら `findIndex` + `splice` で `conductor.agents` から phantom slot 掃除し、surface 無しなら `agent_spawn_failed_no_surface` log のみ。daemon.test.ts L2817-2937 で 4 経路 (cleanup / no_slot / no_surface / orphan) を assert |
| 6 | runCmux timeout | OK | `cmux.ts:119` `const mergedOpts: RunCmuxOpts = { ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS };` で merge 順正しい（opts 後置で `timeout` を上書き → opts.timeout 指定があれば優先、なければ 30s default）。`tree` は L245 で `runCmux(args, { timeout: TREE_TIMEOUT_MS })` (5s) を**明示渡し**するため 30s に上書きされない。cmux.test.ts に hang fake binary での「tree が 5s で reject」「send が 30s で reject」両方の assert あり |
| 7 | 誤削除なし | OK | (a) `grep -rn "CMUX_BUNDLE_ID\|CMUX_BUNDLED_CLI_PATH\|CMUX_SOCKET_PATH\|CMUX_SURFACE" --include="*.ts" skills/cmux-team/manager/ \| wc -l` → 97 件保持。(b) `cmux.ts` ファイル名・`skills/cmux-team/` ディレクトリ名 git diff にリネーム無し。(c) `grep -rn "SUBSTRATE_BINARY" ...` → 21 件保持。(d) `com.manaflow.cmux` refuse 検出経路: cmux.ts に保持（grep で確認） |
| 8 | docs 一掃 | OK (minor) | (a) `grep -n "ELEVENS_BACKEND" skills/c11/SKILL.md` → L17 に「`ELEVENS_BACKEND` 環境変数は撤去された」という migration 説明文 1 件のみ。description trigger (L9) には残存しないことを Read で確認 (L7-12 範囲に該当キーワード無し)。撤去履歴の説明として正当で「コメントや歴史的記述は許容」基準を満たす。(b) README.md / README.ja.md / CHANGELOG.md / docs/seed.md / docs/spec/13-mailbox-schema.md すべて updated（git diff --stat で確認） |
| 9 | テスト pass | OK | 個別実行で T016 触ったテストすべて pass（下「テスト結果」参照）。FAILED ゼロ |
| 10 | tsc クリーン | OK | T016 起因の新規エラーゼロ（下「tsc 結果」参照） |

## テスト結果

`skills/cmux-team/manager` 配下で個別実行（`bun test --timeout 30000 <file>`）:

| ファイル | 結果 | テスト数 |
|---|---|---|
| cmux.test.ts | pass | 30 tests, 45 expect, 0 fail |
| c11-features.test.ts | pass | 10 tests, 13 expect, 0 fail |
| mailbox-cli.test.ts | pass | 11 tests, 24 expect, 0 fail |
| main.test.ts | pass | 273 tests, 748 expect, 0 fail |
| daemon.test.ts | pass | 239 tests, 824 expect, 0 fail |
| schema.test.ts | pass | 121 tests, 218 expect, 0 fail |
| layout-restore.test.ts | pass | 9 tests, 47 expect, 0 fail |

T016 で改変されたファイルに対応するテストはすべて FAILED ゼロ。

## tsc 結果

`cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | head -50`:

- **stash 適用前（post-T016）**: 10 件のエラー (c11-features.test.ts:138/180, c11-features.ts:268/276, mailbox-cli.ts:29/30/44, main.ts:1043)
- **`git stash -u` 後（pre-T016 = main HEAD）**: 同じ 10 件のエラー (c11-features.test.ts:136/180, c11-features.ts:248/256, mailbox-cli.ts:29/30/44, main.ts:1051)

エラー件数・ファイル・メッセージは完全一致。行番号差分のみ（c11-features.ts:248→268 / 256→276, main.ts:1051→1043, c11-features.test.ts:136→138）で、実装の追加・削除によるシフト。**T016 起因の新規 tsc エラーはゼロ**。

なお既存の 10 件は mailbox-cli.ts の `strictNullChecks` 関連と c11-features の MailboxChange discriminated union narrowing 不足、main.ts L1043 の string→boolean 型不一致で、いずれも T016 のスコープ外。

## 申し送り 5 項目

| # | 項目 | 遵守状況 | 根拠 |
|---|---|---|---|
| 1 | AGENT_SPAWN_FAILED の surface 引き回し (createdSurface let 宣言 / undefined 経路 daemon.test.ts assert) | ✅ | main.ts:3572 `let createdSurface: string \| undefined;` 外側宣言、L3577 で代入、L3832 で `if (createdSurface) failMsg.surface = createdSurface;`。daemon.test.ts L2817-2937 に 4 経路 (cleanup / no_slot / no_surface / orphan) のテストあり、no_surface (createdSurface === undefined) も含む |
| 2 | runCmux merge 順 (tree 5s が保たれる cmux.test.ts 検証) | ✅ | cmux.ts:119 `{ ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS }` で opts.timeout が後置・優先。tree は L245 で `{ timeout: TREE_TIMEOUT_MS }` 明示渡し。cmux.test.ts (30 pass) に hang fake binary での timeout 検証あり |
| 3 | fetchLiveSurfacesWithRetry の sleep ヘルパー + retry ログ | ✅ | daemon.ts:1372 `fetchLiveSurfacesWithRetry` 実装、L1383 で各 retry 前に `tree_fetch_retry` を `await log(...)` で pull 観測可能に出力。`sleep` は既存の sleepUntilWakeup と別の局所 ヘルパーで実装 |
| 4 | 付録 A grep 4b (skills/c11/SKILL.md の ELEVENS_BACKEND 0 件) | ⚠️ minor | 厳密 0 件ではなく **1 件残存** (L17 の migration 説明文「`ELEVENS_BACKEND` 環境変数は撤去された」)。description trigger (L9) からは撤去済み。残存箇所は「BREAKING change の周知」目的の歴史的記述で、検品基準「コメントや歴史的記述は許容、実コード参照は NG」を満たす。GO ブロッカーには該当しない |
| 5 | BREAKING 周知 (docs / CHANGELOG) | ✅ | CHANGELOG.md / README.md / README.ja.md / docs/seed.md / skills/c11/SKILL.md / docs/spec/13-mailbox-schema.md がすべて update 済（git diff --stat 21 ファイル変更で確認） |

## Fix Required（NOGO の場合）

なし（GO 判定）。

## 良い点 / 所見

- **設計の単純化**: `BackendDecision` を `{ kind: "c11" \| "refuse" }` の 2 値に絞った結果、`detectBackendDecision` の分岐数が減り cmux.test.ts の網羅性が高まった (30 tests / 45 assertions)
- **runCmux default timeout の波及効果**: `mergedOpts.timeout = opts?.timeout ?? SEND_TIMEOUT_MS` という 1 行で `send` / `sendKey` / `newSurface` / `newSplit` / `getCallerSurface` / `getCallerWorkspace` / `closeSurface` 等すべてが 30s 保護される。design-review §3.5 の「保護を取り損なう方が事故になる」原則が forward-compatible な形で実装された
- **AGENT_SPAWN_FAILED 4 経路の log 細分化**: daemon.ts handler が `agent_spawn_failed_cleanup` / `_no_slot` / `_no_surface` / `_orphan` に分けて log を出すため、phantom slot 残存事故の原因分離が容易（observatory 原則と整合）
- **fetchLiveSurfacesWithRetry の `tree_fetch_retry` log**: retry 毎に pull 観測可能なログを出すため、起動直後の transient tree 失敗が頻発する環境ではパフォーマンス問題として可視化される。post-mortem evidence (T010) との連携が良好
- **テストの構造的書き換え**: `__setCapabilitiesForTest(null)` で C11 capabilities を差し替えるパターンに統一されたため、`process.env.ELEVENS_BACKEND = "cmux"` という process-global mutation を解消（テスト並列化と分離性向上）

### Minor 所見（GO ブロックしない）

- `skills/c11/SKILL.md` L17 に「`ELEVENS_BACKEND` 環境変数は撤去された」という migration 説明が残存。今後 v0.9.x が出揃って migration 説明が役目を終えた段階で、この行を完全に書き換えるかは別 issue で検討可
- `mailbox-cli.ts:29/30/44` の strictNullChecks エラー、`c11-features.ts:268/276` の MailboxChange narrowing エラー、`main.ts:1043` の string→boolean 型不一致は T016 改変前から存在する pre-existing 課題。本 PR 後に別タスクで一掃推奨
- package-lock.json の version bump (0.8.1→0.8.2) は npm install の incidental sync として CHANGELOG.md と整合的。問題なし
