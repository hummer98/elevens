# Task 017 実装計画書: spawn-agent が別ペイン / split / 別 workspace に Agent を起動するバグの修正

## 1. 概要

`elevens spawn-agent` 実行時、本来 Conductor 所属ペイン内に **追加タブ** として開かれるべき Agent が、条件次第で **別ペイン / split / 別 workspace** に起動してしまうバグを修正する。

原因は調査済みで、独立した 2 つの欠陥の合成:

| # | 場所 | 症状 |
|---|------|------|
| 欠陥1 | `cmux.ts:281` `getPaneForSurface` の `line.includes(surface)` | prefix 部分一致で `surface:2` が `surface:26` 等の行に誤マッチし、間違った pane を返す |
| 欠陥2 | `main.ts:3577` `newSurface(targetPane)` 直前 | `targetPane` が undefined のまま `newSurface(undefined)` が呼ばれ、`c11 new-surface` が `--pane` 無しで実行され、focused pane / focused workspace に surface を作る |

両者は独立しており、片方だけ直しても他方の経路を通って暴発し得る。本タスクでは **両方を構造的に塞ぐ**。さらに二重防御として `c11 new-surface --workspace` を明示し、focused workspace への暗黙フォールバックを物理的に塞ぐ。

CLAUDE.md の設計原則「**逸脱を防ぐより、逸脱しても安全な構造にする**」「**fail-fast over fallback**」に沿った修正。

---

## 2. 欠陥1 の確定修正方式と理由

### 確定方式: テキスト scan + 完全一致（B 案: `listSiblingSurfaces` と揃える）

`cmux.ts:274-284` `getPaneForSurface` を、`listSiblingSurfaces` (`cmux.ts:295-324`) と同じ方式に書き換える:

- 各行から `pane (pane:\d+)` で pane を捕捉
- 各行から `surface:\d+` を全て抽出
- 抽出された surface 集合に **`s === surface` で完全一致** するものがあれば、その時点の pane を返す

### 採用理由

| 案 | 採用 | 理由 |
|----|------|------|
| **A: `tree(workspace, { json: true, idFormat: "both" })` で JSON parse 厳密照合** | ❌ | `normalizeSurfaceArg` が UUID→ref 逆引き目的で JSON 経路を採っているのは妥当だが、`getPaneForSurface` は ref→pane の単純照合で済む。同ファイル内の `fetchLiveSurfaces` / `listSiblingSurfaces` も text-scan なので、これだけ JSON 化すると非対称が拡大し可読性が落ちる。tree 出力が text/JSON で 2 通り持ち回るのも observatory 視点で不利益（pane 構造を確認したい人間が JSON を読まされる）。 |
| **B: text-scan + `surface:\d+` 抽出 + `===` 完全一致** | ✅ | `listSiblingSurfaces` の既存実装パターンと完全に対称。修正範囲が 1 関数で閉じる。tree 1 回呼び出しのコストも変わらない。 |
| C: 単語境界 regex (`new RegExp(`\\b${surface}\\b`)`) | ❌ | `surface:2` の境界は `:` と `2` の間に \b があるため `surface:26` の `2` 直前の \b と区別できない。実は機能するが、`surface:\d+` 抽出 + `===` の方が意図が明示的。 |

### Pseudo-diff

```ts
// cmux.ts:274-284 (before)
export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  const output = await tree(workspace);
  const lines = output.split("\n");
  let currentPane: string | undefined;
  for (const line of lines) {
    const paneMatch = line.match(/pane (pane:\d+)/);
    if (paneMatch) currentPane = paneMatch[1];
    if (line.includes(surface) && currentPane) return currentPane;  // ★ 部分一致でバグる
  }
  return undefined;
}

// after
export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  const output = await tree(workspace);
  const lines = output.split("\n");
  let currentPane: string | undefined;
  for (const line of lines) {
    const paneMatch = line.match(/pane (pane:\d+)/);
    if (paneMatch) currentPane = paneMatch[1];
    const surfaceMatches = line.match(/surface:\d+/g);
    if (!surfaceMatches || !currentPane) continue;
    if (surfaceMatches.includes(surface)) return currentPane;  // ★ === 完全一致
  }
  return undefined;
}
```

`listSiblingSurfaces` 内の照合ロジックと挙動が一致するため、両者で「surface が tree のどの pane にあるか」の判定が常に同期する。

---

## 3. 欠陥2 の確定修正方式と理由

### 確定方式: 二段防御 (C + D)

- **C (caller-side fail-fast)**: `cmdSpawnAgent` (`main.ts:3573-3577`) で `targetPane` が undefined を検知したら、その時点で明示的に `throw new Error(...)` する。`reason` には conductor surface / caller workspace / 「pane lookup failed」を含める。既存の try/catch ブロックがそのまま受け、`AGENT_SPAWN_FAILED` を daemon に POST し exit 1 で抜ける（T016 fail-fast 経路にそのまま乗る）。
- **D (callee-side guard)**: `newSurface(pane?: string)` を **`newSurface(pane: string, opts?: { workspace?: string })`** にシグネチャ変更。pane が空文字 / undefined 相当（runtime check）なら関数内で throw。

### 採用理由

| 案 | 採用 | 理由 |
|----|------|------|
| C のみ | ❌ | spawn-agent 1 経路は塞げるが、将来別の caller が `newSurface(undefined)` を書いても何も止まらない。「逸脱しても安全な構造」原則に反する。 |
| D のみ | ❌ | newSurface 関数では「なぜ pane が undefined になったか」のコンテキスト（conductor surface など）が分からないので、エラーメッセージが弱くなる。caller 側で先に意味のある reason を投げる方が観察箱として有益。 |
| **C + D (二段防御)** | ✅ | C で「conductor surface に対する pane lookup 失敗」と意味付き reason を投げ、D で「caller がうっかり undefined を渡す」も物理的に塞ぐ。両層で防御するので、片方の修正が将来 regress しても他方で食い止まる。修正コストも `newSurface` の唯一の呼び出し元は `main.ts:3577` のみなので、シグネチャ変更の波及は無い。 |

### Pseudo-diff

```ts
// cmux.ts:154-163 (after; D + 二重防御 [次節] を同時に組み込む)
export async function newSurface(
  pane: string,
  opts?: { workspace?: string },
): Promise<string> {
  if (!pane || !pane.startsWith("pane:")) {
    throw new Error(`newSurface: pane is required (got ${JSON.stringify(pane)})`);
  }
  const args = ["new-surface", "--pane", pane];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  const { stdout } = await runCmux(args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create surface: ${stdout}`);
  }
  return surface;
}
```

```ts
// main.ts:3573-3577 (after; C)
const callerWorkspace = await cmux.getCallerWorkspace();
const targetPane = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);
if (!targetPane) {
  throw new Error(
    `pane lookup failed: conductor_surface=${conductorSurface} caller_workspace=${callerWorkspace ?? "(none)"} ` +
    `(c11 tree did not return a pane containing the conductor surface; refusing to fall back to focused pane)`,
  );
}
createdSurface = await cmux.newSurface(targetPane, { workspace: callerWorkspace });
```

throw された Error は `cmdSpawnAgent` 既存の try/catch (`main.ts:3815`) で捕捉され、`AGENT_SPAWN_FAILED` POST + `spawn_agent_failed` log + exit 1 に乗る。新規 daemon ハンドラ追加は不要。

### T016 既存 fail-fast 経路との整合

- T016 で導入された fail-fast catch (`main.ts:3814-3842`) は「newSurface / send / renameTab 等の substrate 操作が throw した場合」を捕捉する。
- 本タスクで追加する throw は **substrate 操作の前** に起きる（pane lookup 失敗）。`createdSurface` は undefined のまま catch に流入する。
- 既存 catch ロジックは `createdSurface` の有無を分岐済み（surface フィールドは `createdSurface` がある場合のみ含める）。`reason` は `e?.message ?? String(e)` で組み立てる。
- 結果として daemon の `daemon.ts:2035-2070` ハンドラ（surface 未確定経路を扱う既存分岐）に正しく流れる。

---

## 4. 二重防御（欠陥3 相当）の採否と理由

### 採否: **採用** (`newSurface` に `--workspace callerWorkspace` を明示)

`newSurface(pane, { workspace: callerWorkspace })` で `c11 new-surface --pane <pane> --workspace <workspace>` を発行する。

### 採用理由

- 現状 `newSurface` は `--workspace` を一切渡していない。c11 が `--pane <pane>` を受け取ってもなお内部的に focused workspace を優先する実装になっていた場合（あるいは将来そう変わった場合）に focused workspace へ流れる可能性が残る。
- `callerWorkspace` は `getCallerWorkspace()` ですでに取得済み（spawn-agent コール元の Conductor は通常 caller workspace に居る）。追加コストは 0。
- 上記 D で `pane: string` を必須化したことと組み合わさり、「`new-surface` は必ず明示的な pane と workspace を伴って発行される」状態が構造的に保証される。

### 副作用回避

- `callerWorkspace` は `getCallerWorkspace()` 内で c11 identify 失敗時に undefined を返す設計。`newSurface(pane, { workspace: undefined })` の場合は `--workspace` を args に積まない（既存の `send` / `tree` と同じ defensive 取り扱い）。
- `getCallerWorkspace()` 自体が undefined を返すケースの是非は本タスクのスコープ外（別タスクで対応）。スコープを膨らませない。

---

## 5. 変更対象ファイルと変更点の一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/cmux.ts` | `getPaneForSurface`: `line.includes(surface)` を `surface:\d+` 抽出 + `===` 完全一致に置換 |
| 2 | `skills/cmux-team/manager/cmux.ts` | `newSurface(pane?: string)` を `newSurface(pane: string, opts?: { workspace?: string })` にシグネチャ変更。`!pane.startsWith("pane:")` で throw。`opts.workspace` があれば `--workspace <ws>` を args に追加 |
| 3 | `skills/cmux-team/manager/main.ts` | `cmdSpawnAgent` (3573-3577): `targetPane` が undefined のとき throw（reason に conductor surface / caller workspace / "pane lookup failed" を含める）。`newSurface(targetPane, { workspace: callerWorkspace })` で workspace 明示 |
| 4 | `skills/cmux-team/manager/cmux.ts` 冒頭コメント | `getPaneForSurface` JSDoc に「surface ref の完全一致のみマッチ（部分一致禁止）」を追記 |
| 5 | `skills/cmux-team/manager/cmux.test.ts` | 欠陥1 prefix collision regression テスト追加、`newSurface` の pane 必須テスト追加、`--workspace` argv 検証テスト追加 |
| 6 | `skills/cmux-team/manager/i18n.ts` | `help_spawn_agent` (en: 252-253, ja: 1336-1337) の "Falls back to new-split right if tab creation fails" / "タブ作成に失敗した場合は new-split right にフォールバックします" を削除し、「`AGENT_SPAWN_FAILED` を post して exit 1」「Fail-fast: tab creation 失敗は spawn 全体を中止する」相当の記述に書き換える |

**変更しないもの**:
- `daemon.ts` の AGENT_SPAWN_FAILED ハンドラ — 既存ロジックが新 throw をそのまま扱える
- `templates/{en,ja}/conductor.md` / `conductor-role.md` — `spawn-agent` 失敗時の handling は既存記述 (exit code 0 確認 → 次へ) で問題なく、本修正で挙動は変わらない
- `schema.ts` — `AgentSpawnFailedMessage` schema は変更不要

---

## 6. テスト戦略（TDD で先に書くテスト）

すべて `skills/cmux-team/manager/cmux.test.ts` に追加。既存 `__setTreeImpl` / fake binary パターンを踏襲する。

### 6.1 欠陥1: `getPaneForSurface` prefix collision regression

```ts
describe("getPaneForSurface prefix collision (T017)", () => {
  afterEach(() => __setTreeImpl(null));

  test("surface:2 検索時 surface:26 を含む行に誤マッチしない (tree 出力順: surface:26 が先)", async () => {
    // pane:1 に surface:26、pane:2 に target の surface:2 が居る
    const fake = [
      "workspace workspace:1",
      "  pane pane:1",
      "    surface:26",
      "  pane pane:2",
      "    surface:2",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:2");
  });

  test("surface:27 も同様に surface:2 とは区別される", async () => {
    const fake = [
      "workspace workspace:1",
      "  pane pane:9",
      "    surface:27",
      "  pane pane:10",
      "    surface:2",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:27", "workspace:1")).toBe("pane:9");
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:10");
  });

  test("1 行に複数 surface が同居していても完全一致のみ拾う", async () => {
    // 「pane pane:5  surface:26 surface:2」のように同行同居しても surface:2 は pane:5 と判定すべき
    const fake = [
      "workspace workspace:1",
      "  pane pane:5",
      "    surface:26 surface:2",
    ].join("\n");
    __setTreeImpl(async () => fake);
    expect(await getPaneForSurface("surface:2", "workspace:1")).toBe("pane:5");
  });
});
```

### 6.2 欠陥2: `newSurface` の pane 必須化（D 層）

```ts
describe("newSurface pane required (T017 D layer)", () => {
  test("pane=undefined → throw（型 cast で undefined を強制した場合）", async () => {
    await expect(newSurface(undefined as unknown as string)).rejects.toThrow(/pane is required/);
  });

  test("pane='' (空文字) → throw", async () => {
    await expect(newSurface("")).rejects.toThrow(/pane is required/);
  });

  test("pane が 'pane:' で始まらない → throw", async () => {
    await expect(newSurface("surface:1")).rejects.toThrow(/pane is required/);
  });
});
```

### 6.3 二重防御: `newSurface` が `--workspace` を c11 に渡す

fake binary が argv を file に書き出すパターンで検証する:

```ts
describe("newSurface forwards --workspace (T017 二重防御)", () => {
  test("opts.workspace 指定時 c11 argv に --workspace <ws> が含まれる", async () => {
    const argvFile = join(testDir, "argv.txt");
    await writeFakeCmux(`
      printf '%s\\n' "$@" > "${argvFile}"
      # newSurface は stdout 2 列目の 'surface:N' を parse する
      echo "ok surface:100"
    `);
    await newSurface("pane:7", { workspace: "workspace:42" });
    const argv = (await readFile(argvFile, "utf-8")).split("\n").filter(Boolean);
    expect(argv).toContain("new-surface");
    expect(argv).toContain("--pane");
    expect(argv).toContain("pane:7");
    expect(argv).toContain("--workspace");
    expect(argv).toContain("workspace:42");
  });

  test("opts.workspace 未指定時は --workspace を含めない", async () => {
    const argvFile = join(testDir, "argv.txt");
    await writeFakeCmux(`
      printf '%s\\n' "$@" > "${argvFile}"
      echo "ok surface:101"
    `);
    await newSurface("pane:7");
    const argv = (await readFile(argvFile, "utf-8")).split("\n").filter(Boolean);
    expect(argv).not.toContain("--workspace");
  });
});
```

### 6.4 spawn-agent 統合（C 層）— 可能なら main.test.ts に追加

`cmdSpawnAgent` 全体の統合テストは proxy/throttle/token pool 依存が重いため、本タスクのスコープでは **`getPaneForSurface` が undefined を返した状態**を `__setTreeImpl` で再現し、`newSurface` が呼ばれずに throw されることを確認するレベルで十分。完全 e2e は手動検証手順 (§7) で吸収する。

```ts
// 統合テストが実装容易な範囲なら追加。難しければ手動検証で代替。
// 期待: pane lookup 失敗 → "pane lookup failed" を含む reason の AGENT_SPAWN_FAILED が postMessage される。
```

### 6.5 既存テストの後方互換確認

- `getPaneForSurface (T016 で fail-fast 化)` (`cmux.test.ts:275-296`): 既存テストは `getPaneForSurface("surface:10", ...)` を完全一致で評価しているため、本修正後も全て pass する見込み。差異なし。
- `listSiblingSurfaces` 既存テスト: 一切触らない（実装も変えない）。

---

## 7. 検証手順

### 7.1 自動テスト

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 cmux.test.ts
```

- TDD で先に §6.1-6.3 のテストを書く → 失敗を確認する
- `cmux.ts` を修正 → 全テスト pass を確認する
- main.test.ts に統合テストを追加する場合のみ:
  ```bash
  bun test --timeout 30000 main.test.ts
  ```

**禁忌**: `cd skills/cmux-team/manager && bun test` (引数なし) は O(N²) 級劣化で 13 分以上ハング。CLAUDE.md「既知の注意点」参照。必ずファイル単位で実行する。

### 7.2 ヘルプ整合性確認

```bash
cd skills/cmux-team/manager
bun run ../../../bin/elevens spawn-agent --help
LANG=ja_JP.UTF-8 bun run ../../../bin/elevens spawn-agent --help  # ja
```

「new-split right にフォールバック」「Falls back to new-split right」が消えていることを目視確認。

### 7.3 手動 e2e（optional / 推奨）

worktree 内で:

```bash
# 1. ビルド
cd skills/cmux-team/manager && bun install

# 2. テスト用に prefix-collision を意図的に再現する surface 構成を用意
#    （例: surface:2 と surface:26 が異なる pane に居る tree 状態）

# 3. spawn-agent を Conductor surface=surface:2 で発行
bun run bin/elevens spawn-agent --conductor-surface surface:2 \
  --role researcher --prompt "ping"

# 4. 結果確認
#    - SURFACE=surface:NNN が surface:2 と同 pane に作られたこと
#    - c11 tree で pane 構造を視認
c11 tree
```

prefix collision を再現するのが難しい場合は、本リリースでは自動テスト + コードレビューで十分とみなし、e2e は別途 cmux-team-lab で検証する。

### 7.4 リグレッション確認

- `cmux-team status` で daemon が正常起動していること
- 既存タスクで spawn-agent が成功する系統が壊れていないこと（最低 1 タスク = 1 Agent で確認）

---

## 8. 想定リスク・既存挙動への影響

### 8.1 API 破壊変更

| 変更 | リスク | 評価 |
|------|--------|------|
| `newSurface(pane?: string)` → `newSurface(pane: string, opts?: { workspace?: string })` | callers が break する | 全 caller (`main.ts:3577`) を本 PR で更新する。`grep -rn newSurface skills/cmux-team/manager/` で他に呼び出し元なしを確認済み。テストファイルでは未呼び出し（cmux.test.ts は newSurface を import せず）。**外部 API ではない**（internal モジュール内のみで使われる）ため影響軽微。 |
| `getPaneForSurface` の照合方式変更 | text-parse 仕様変更で false-negative が出る可能性 | tree 出力の `surface:N` 表記は c11 substrate の安定 wire format（`fetchLiveSurfaces` / `listSiblingSurfaces` も同じ regex を採用）。仕様が変わらない限り regression なし。 |

### 8.2 spawn-agent の失敗率変化

- これまで「pane lookup が部分一致で何かしらの pane を返してしまい、結果的に間違った pane に Agent が立つ」ケースは、修正後 **fail-fast (exit 1)** に変わる。「動いていたものが動かなくなる」リスクがあるが、これは **誤った pane に立っていた状態が正しく検知される** ことを意味する。観察箱原則上望ましい変化。
- 失敗時の reason は `AGENT_SPAWN_FAILED` メッセージに含まれて dashboard / log で観測可能。

### 8.3 c11 substrate 依存

- 二重防御で `--workspace` を渡す変更は、c11 が `--workspace` をサポートしている前提に立つ。`send` / `tree` 等は既に `--workspace` を使っており、`new-surface` も対応していると想定（`skills/c11/SKILL.md` のリファレンスから）。c11 が未対応であれば即座に発覚し、fail-fast 経路に乗る。
- 未対応が判明した場合は `opts.workspace` 引き渡しを取り下げて再リリース可能（C/D 層は workspace 非依存）。

### 8.4 ドキュメント整合

- i18n.ts のヘルプ修正は user-facing。下流で参考にしている docs/spec/ や README に「new-split right フォールバック」記述があれば併せて更新が必要だが、`grep -rn "new-split right" docs/ README.md skills/cmux-team/templates/` で検出されたものは過去の T016 直後にすでに整理済み（テンプレート側に該当記述なし）。

### 8.5 既存 fail-fast 経路 (T016) との衝突

- T016 で導入された catch (`main.ts:3815`) は再利用するのみで、新規ロジックを追加しない。`createdSurface` 未確定経路（surface 未生成）は既に daemon.ts:2063 で扱われている。
- 既存テスト `daemon.test.ts` の AGENT_SPAWN_FAILED 系統テストは現状のまま pass する見込み（メッセージ schema を変えないため）。

### 8.6 Trace / metrics への影響

- `spawn_agent_failed` log の頻度が一時的に上昇する可能性（これまで silent に間違った pane に立っていたケースが顕在化）。これは観察箱の意図する挙動。
- `task_sessions` テーブルへの `agent_spawned` 行は newSurface 成功後に insert される（main.ts:3793-3805）。本修正で newSurface 自体が走らないケースが増えるため、`agent_spawned` 行は減り、代わりに `spawn_agent_failed` log が増える。dashboard 側で両方を可視化できるため metric は破綻しない。

---

## 完了条件

1. §6.1-6.3 の TDD テストが全て pass
2. `bun test --timeout 30000 cmux.test.ts` で既存テストを含め全 pass
3. `spawn-agent --help` の ja / en から "new-split right フォールバック" 記述が消えている
4. 既存の T016 fail-fast 経路 (AGENT_SPAWN_FAILED post + slot cleanup) が新 throw に対しても正しく動く
5. pseudo-diff レベルで明示した修正が `cmux.ts` / `main.ts` / `i18n.ts` / `cmux.test.ts` に反映されている

実装は別の Implementer Agent が本計画に従って行う。
