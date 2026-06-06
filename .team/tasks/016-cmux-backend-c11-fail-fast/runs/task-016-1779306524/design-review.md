# T016 Design Review (rev-2)

## 判定

**Approved**

## サマリー

rev-1 で指摘した Major M1-M4 と Minor m1-m4 はすべて改訂版 plan.md に反映されており、新たな Critical / Major な矛盾は見当たらない。特に以下 3 点が改善された:

1. **M1**: `AGENT_SPAWN_FAILED` schema に `surface?: string` が追加され、daemon 側 handler が `findIndex` + `splice` で `conductor.agents` の phantom slot を掃除する設計に統一された（§3.6 と §5-3 の表現も揃った）
2. **M3**: substrate 操作の timeout を **個別関数列挙** から **`runCmux` 内 default 化 (`opts.timeout ?? SEND_TIMEOUT_MS`)** に切り替えた。これで `newSurface` / `newSplit` / `getCallerSurface` / `getCallerWorkspace` も自動的に 30s timeout で保護され、`cmdSpawnAgent` 起点の `newSurface(targetPane)` (`main.ts:3583`) が hang した場合にも fail-fast 化される。`tree` は既存の `TREE_TIMEOUT_MS(5s)` を明示渡しで保持
3. **M4**: initializeLayout のリトライ実装位置が `daemon.ts:1411-1412 (initializeLayout 内、L1363 定義)` に修正された。実機 daemon.ts でも `initializeLayout` は L1363 定義・`cmux.fetchLiveSurfaces(...)` は L1412 で一致

実コード照合:

- `daemon.ts:1363` に `export async function initializeLayout(...)`、L1412 に `cmux.fetchLiveSurfaces(state.workspace ?? undefined)` 存在（plan §4-5 と一致）
- `cmux.ts:143` の `runCmux(args, opts)` を `send` / `sendKey` / `newSurface` / `newSplit` / `getCallerSurface` / `getCallerWorkspace` 等の全関数が経由しているため、§3.5 の default timeout 化で漏れなく 30s 保護が広がる構造を確認
- `skills/c11/SKILL.md:9` (description trigger) / `:17` (本文) に `ELEVENS_BACKEND` 言及が現存し、§7-4b / §6 docs テーブルでの撤去対象として正しく取り込まれている

## 前回指摘の解消状況

| 指摘 | 状態 | 備考 |
|---|---|---|
| **M1** schema に `surface?` + slot 掃除 / §3.6 と §5-3 矛盾解消 | ✅ 解消 | §3.6 (L284-298) で schema に `surface?: string` 追加・「なぜ必要か」を明記。daemon handler (L307-332 / §5-3 L619-648) で `findIndex` + `splice` 統一。AGENT_SPAWNED 後 send 失敗時の phantom slot 残留問題が構造的に解消 |
| **M2** §6 docs に `skills/c11/SKILL.md` (L9/L17) + trigger keyword 撤去 | ✅ 解消 | §6 docs テーブル L897-898 に `skills/c11/SKILL.md` 追加。§7-4b に L9 description / L17 本文の具体的書き換え方針（旧文 → 新文）を新旧対比で記載。付録 A grep 4b (`grep -n "ELEVENS_BACKEND" skills/c11/SKILL.md`) も追加 |
| **M3** `runCmux` default timeout + 全関数自動保護 + tree(5s) 維持 | ✅ 解消 | §3.5 (L224-267) で「(b) `runCmux` 内 default」を比較表付きで採用。`send` / `sendKey` / `closeSurface` / `renameTab` / `renameWorkspace` / `setStatus` / `notify` / `clearStatus` に加え `newSplit` / `newSurface` / `getCallerSurface` / `getCallerWorkspace` も自動保護される旨明記。`tree` は `TREE_TIMEOUT_MS = 5_000` の明示渡しを維持と書かれている (L263) |
| **M4** initializeLayout の所在を `daemon.ts:1411-1412` に修正 | ✅ 解消 | §4-5 (L492-541) の「所在の正確化」節で `initializeLayout` が `daemon.ts:1363` 定義・`cmux.fetchLiveSurfaces` 呼び出しが `daemon.ts:1412` であることを明記。`fetchLiveSurfacesWithRetry` ヘルパー実装も daemon.ts 内に置く設計に修正 |
| **m1** テスト削除行範囲を実 grep 結果に整合 | ✅ 解消 | §5.1 (L851-856) で `mailbox-cli.test.ts: 8 箇所 = L51/L62/L83/L97/L111/L139/L160/L182`、`c11-features.test.ts: L54/L72/L86/L99/L114/L166` を明記。文言も「`process.env.ELEVENS_BACKEND = "cmux"` を含む全 test block を削除」に統一 |
| **m2** events.jsonl 出力を phase 2 deferred として明記 | ✅ 解消 | §3.6 末尾 (L335) に「`events.jsonl` への AGENT_SPAWN_FAILED 出力は phase 2 で別途検討」を deferred として明示。§5-3 の handler 内コメントにも reference あり |
| **m3** `c11-features.ts` 早期 return 削除に伴う throw 経路の説明 | ✅ 解消 | §2.1 c11-features.ts L39 行 (L93) に「`isMailboxSupported()` の早期 return が引き続きガードするため throw 経路は実質増えない」を補記 |
| **m4** `CMUX_BUNDLED_CLI_PATH` 根拠補強 | ✅ 解消 | §3.2 (L178) に「補足 (m4)」として c11.app launch 経由でのみ設定される env / PATH 上の `c11` が常に第 2 候補 / `detectBackendDecision` と `resolveC11Binary` が同じ env と `/\/c11\.app\//` regex に依存することで判定が一致する旨を 1 行補足 |

## 残課題

なし。

## 実装者への申し送り

設計上のクリティカルな論点はすべて解消されている。実装フェーズで以下のみ留意:

1. **AGENT_SPAWN_FAILED の `surface` 引き回し（§5-2 / §5-3）**: `cmdSpawnAgent` 内で `createdSurface` を `try` 外側 `let` で宣言し、`newSurface` 成功直後に代入、`catch` で `postMessage(..., surface: createdSurface)` に乗せる手順は §5-2 L658-678 に図示済み。`newSurface` 自体が失敗した場合は `createdSurface === undefined` のまま `postMessage` に流れる（daemon 側 handler は `if (message.surface)` ガード付きなので state 変更なしで終わる）。この「undefined 経路」も daemon.test.ts のスモークテスト（§5.1）で必ず assert すること

2. **`runCmux` default timeout 化（§3.5 / §5-1）**: `mergedOpts = { ...opts, timeout: opts?.timeout ?? SEND_TIMEOUT_MS }` の merge 順を間違えると、`tree` の `{ timeout: TREE_TIMEOUT_MS }` (5s) が上書きされて 30s になり、tree の早期失敗検出が壊れる。実装時は cmux.test.ts に「`tree` 呼び出しが 5s で reject される」 / 「`send` 呼び出しが 30s で reject される」の双方を hang fake binary で検証する unit test を入れること（§5.1 にも該当テストの追加が記載済み）

3. **`fetchLiveSurfacesWithRetry` の `sleep` ヘルパー（§4-5）**: daemon.ts に `sleep` ユーティリティが既存しなければ inline 実装か小ヘルパー追加が必要。`new Promise(r => setTimeout(r, ms))` の 1 行で十分。`await log("tree_fetch_retry", ...)` を retry 毎に書くため、observatory 原則的にもログが pull で観測可能になる

4. **付録 A の grep 4b**: 実装完了時に `grep -n "ELEVENS_BACKEND" skills/c11/SKILL.md` で 0 件であることを必ず確認する（M2 の撤去漏れを防ぐ最後のセーフティネット）

5. **BREAKING change の周知**: §Step 10 にあるとおり、`elevens close-task` の journal に「`ELEVENS_BACKEND` を `cmux` に pin している運用者は migration 必要（env を unset するだけで OK）」を明示すること

## 良い点（rev-1 から維持）

- 改訂履歴を冒頭に節として置き、rev-1 → rev-2 の変更点を箇条書きでトレース可能にしてある（M1-M4 / m1-m4 ごとに対応箇所を明示）。設計レビューの再現性が高い
- §3.5 の (a) vs (b) 比較表で `runCmux` default 化の YAGNI 適合性を明示的に論じており、「保護を取り損なう方が事故になる」という観察箱原則の判断軸が言語化されている
- M1 の slot 掃除を §3.6 / §5-3 の両方に書き、しかも「dashboard / UI 反映と events.jsonl 連携は phase 2 で別 issue」と将来分を明示的に切り出している。scope creep を構造的に防いでいる
- §4-5 の `fetchLiveSurfacesWithRetry` 実装案がコード片で示され、`await log("tree_fetch_retry", ...)` で retry を pull 観測可能にしている。post-mortem evidence (T010) の観察箱原則と整合
