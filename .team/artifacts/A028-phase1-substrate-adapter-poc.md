---
id: A028
type: report
title: Phase 1 substrate adapter PoC — ELEVENS_BACKEND env 切替の実装と実機検証
author: surface:auto
date: 2026-05-09
related:
  - docs/seed.md
  - skills/cmux-team/manager/cmux.ts
  - skills/cmux-team/manager/e2e.ts
---

## 要約

`docs/seed.md` Phase 1（〜2026-05-15）で予定されていた **substrate adapter PoC** を実施。`ELEVENS_BACKEND=c11|cmux` 環境変数で multiplexer backend を切替可能にし、両 backend の `tree` まで実機で疎通確認した。

## 実装

### 影響範囲（事前調査）

- `skills/cmux-team/manager/cmux.ts:22` の `execFile("cmux", ...)` が runCmux の単一 chokepoint。全 cmux サブコマンド（new-split / send / read-screen / tree / identify / set-status / notify など）はここを通る。
- `skills/cmux-team/manager/e2e.ts:64,70,76,82` のテストユーティリティでも `execFile("cmux", ...)` が直接 4 箇所。
- `master.ts` / `conductor.ts` / `main.ts` の `buildLaunchCommand(projectRoot, "cmux-team spawn-...")` は **elevens 自身の CLI** 呼び出しで substrate ではない（変更不要）。
- `/Applications/cmux.app` のような bundle path 直接参照は **無し**。
- `CMUX_*` 系環境変数（`CMUX_SOCKET` / `CMUX_WORKSPACE_ID` 等）は c11 が同名で fallback 受理するため変更不要。
- socket file path のハードコードも無し（cmux も c11 も `cmux.sock` を共有）。

結論: substrate 呼び出しは **5 箇所**にローカライズされており、env-driven 切替で十分。

### 変更内容

**`skills/cmux-team/manager/cmux.ts`** に `SUBSTRATE_BINARY` を export し、runCmux の `execFile` に注入:

```ts
export const SUBSTRATE_BINARY: string = process.env.ELEVENS_BACKEND?.trim() || "cmux";
// ...
const { stdout, stderr } = await execFile(SUBSTRATE_BINARY, args, opts);
```

**`skills/cmux-team/manager/e2e.ts`** は `import { SUBSTRATE_BINARY } from "./cmux"` で 4 箇所の `"cmux"` リテラルを置換。

default は当面 `cmux`（seed.md 指定通り、後方互換維持）。`c11`、絶対パス、その他カスタムビルド名も透過的に受理する。

## 実機検証

### 環境

- `cmux` 0.64.3 (83) — `/opt/homebrew/bin/cmux` → `/Applications/cmux.app/.../bin/cmux`
- `c11`  0.46.0 (99) — `/Applications/c11.app/.../bin/c11`
- 両 daemon が稼働中、`ping` ともに `PONG`

### Backend 解決

| `ELEVENS_BACKEND` | `SUBSTRATE_BINARY` | `--version` 出力 |
|---|---|---|
| 未設定 | `cmux` | `cmux 0.64.3 (83)` |
| `cmux` | `cmux` | `cmux 0.64.3 (83)` |
| `c11` | `c11` | `c11 0.46.0 (99)` |

### `runCmux` 経由の `tree` 疎通

両 backend で `tree` が成功し、それぞれの multiplexer の workspace 階層を返した。

- c11: `workspace workspace:1 ...`（直下 workspace、ASCII floor plan 付き）
- cmux: `window window:1 [current] ◀ active` ...（window → workspace → pane → surface の従来構造）

出力フォーマットに**実装差分はある**が、orchestration 層は ref 文字列（`workspace:N` / `surface:N`）を主に扱うため、本 PoC の範囲では互換問題なし。詳細な互換性確認（特に `tree` の構造化部分）は Phase 2 で metadata-poll 経路に移る際に追加検証する。

### ユニットテスト

`bun install` 後に以下が pass:

- `cmux.test.ts` — fake `cmux` を `PATH` 先頭に置く既存戦略は影響なし（default 解決が `cmux` のため）
- `util.test.ts` / `agent-instructions.test.ts` / `cli-project-root.test.ts` / `config.test.ts` / `daemon.test.ts` — 全て pass

> 注: 初回テスト実行時に `update-notifier` / `zod` / `@opencode-ai/sdk` の missing dep エラーが出た。これは pre-existing で `cd skills/cmux-team/manager && bun install` で解消する。本変更とは無関係。

## 残タスク（Phase 1 終了までに）

- [ ] `cmux-team start` 相当を `ELEVENS_BACKEND=c11` で起動 → Master / Conductor / Agent spawn 全段疎通確認
- [ ] **非フォーカス workspace で PTY が起動する**ことの定量確認（seed.md 直接トリガーの regression 解消検証）
- [ ] `cmux send` / `read-screen` / `tree` の出力差を Phase 2 移行前に表化（特に空白・改行差で正規表現マッチが壊れていないか）

## 設計上の選択

### なぜ env で切替か

- config.ts に `runtime` フィールドが既にあり opencode 拡張に使われているが、substrate 切替は **process 起動時固定**で daemon 寿命中に変えない性質のもの。env は process 単位で固定される自然なスコープ。
- config 化すると persistence / migration が必要になり PoC のスコープを広げる。env なら `direnv` や shell rc で per-machine / per-workspace に変えられ、PoC 段階の柔軟性に合う。
- Phase 3（cmux サポート段階削除）で default を c11 に切替える際も、env 値の reverse default を変えるだけで済む。

### Backend literal の validation

`"c11" | "cmux"` enum で wrap せず、文字列を**そのまま** binary 名 / path として透過。理由:

- 絶対パス指定（`/opt/c11-dev/bin/c11`）でカスタムビルドを差し込めるようにするため
- `which`-style の lookup を OS（execFile）に委譲することで `PATH` の通常解決と整合
- 不正値の早期検出は execFile の ENOENT で十分（即 throw）

将来 valid set を絞る必要が出たら enum 化すればよい（破壊的でない方向の拡張）。

## 参照

- 上流 c11: https://github.com/Stage-11-Agentics/c11
- cmux upstream regression: https://github.com/manaflow-ai/cmux/issues/3798
- elevens repo: https://github.com/hummer98/elevens
