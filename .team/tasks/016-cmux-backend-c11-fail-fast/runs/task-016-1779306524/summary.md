# T016 Summary — cmux backend 撤廃 / c11 専用化 / fail-fast

## 概要

elevens を c11 substrate 専用アプリケーションとして確定し、cmux backend へのフォールバック経路を完全に撤去した。前提（c11 substrate）が解決できない／崩れた場合は無言フォールバックせず **明示的に fail-fast** する。実機障害（KDG-lab: c11 surface 上で `ELEVENS_BACKEND` 未設定 → cmux にフォールバックし tree/send が壊れ Agent spawn が無言失敗）の根本原因を構造的に解消。

**BREAKING change**（CLI インターフェース安定方針の明示的例外、ユーザー決定）。

## 完了したサブタスク（完了条件 10 項目すべて GO）

### A. backend レベルの削除（cmux.ts）
- `SUBSTRATE_BINARY = ELEVENS_BACKEND || "cmux"` フォールバックを撤去。`resolveC11Binary`（cmux.ts:50-）で c11 バイナリパス（`CMUX_BUNDLED_CLI_PATH` 一次ソース）に固定解決。`"cmux"` フォールバック禁止
- `detectBackendDecision` を `{ kind: "c11" | "refuse" }` の 2 値判定に単純化。`explicit` escape hatch（`ELEVENS_BACKEND` 明示で任意 backend を通す経路）を削除
- auto-detect 結果を実行バイナリ解決に反映。c11 解決不能なら `main.ts:798-803` で `process.exit(1)`
- `IS_C11_BACKEND` 分岐を除去し c11 動作に一本化
- `maybeLogDeprecationNotice` / `__resetDeprecationNoticeForTest` を削除

### B. 操作レベルの fail-fast 化
- `main.ts` `newSurface()` → `newSplit("right")` フォールバックを撤去。pane 解決失敗は spawn-agent をエラー停止
- `cmux.ts` `getPaneForSurface` / `fetchLiveSurfaces` の tree 失敗を **throw** 化（「surface が見つからない」と「substrate コマンド失敗」を区別）
- `layout-restore.ts` の `liveSurfaces` を `Set<string>`（non-null）化し `pid_only` degrade を削除。`daemon.ts:1372 fetchLiveSurfacesWithRetry`（200/600/1500ms backoff の 3 回 retry）後に throw → exit 1

### C. spawn-agent silent fail 解消（observatory 原則）
- `cmdSpawnAgent`（main.ts:3568-3835）を try/catch で覆い、catch で `manager.log` 記録 + daemon に `AGENT_SPAWN_FAILED` post + `process.exit(1)`
- `schema.ts` に `AgentSpawnFailedMessage`（`surface?` optional）追加。`daemon.ts:2034-2070` handler が surface ありなら `findIndex` + `splice` で phantom slot 掃除
- `cmux.send` 含む全 substrate 操作に timeout 付与（cmux.ts:119 `runCmux` 内 default `opts?.timeout ?? SEND_TIMEOUT_MS`、tree は `TREE_TIMEOUT_MS` 5s を明示渡しで維持）

### D. docs / コメント
- `docs/spec/05` 系・`docs/seed.md`・`CLAUDE.md` 相当・`README.md` / `README.ja.md`・`skills/c11/SKILL.md` の backend 記述を c11 専用に更新

## 変更ファイル（21 files, +1002 / -825）

CHANGELOG.md, README.ja.md, README.md, docs/seed.md, docs/spec/13-mailbox-schema.md, package-lock.json（0.8.1→0.8.2 version sync, benign）, skills/c11/SKILL.md, skills/cmux-team/manager/{c11-features.test.ts, c11-features.ts, cmux.test.ts, cmux.ts, conductor.ts, daemon.test.ts, daemon.ts, layout-restore.test.ts, layout-restore.ts, mailbox-cli.test.ts, main.test.ts, main.ts, schema.test.ts, schema.ts}

## テスト結果（個別実行 `bun test --timeout 30000`）

| ファイル | 結果 | テスト数 |
|---|---|---|
| cmux.test.ts | pass | 30 tests, 0 fail |
| c11-features.test.ts | pass | 10 tests, 0 fail |
| mailbox-cli.test.ts | pass | 11 tests, 0 fail |
| main.test.ts | pass | 273 tests, 0 fail |
| daemon.test.ts | pass | 239 tests, 0 fail |
| schema.test.ts | pass | 121 tests, 0 fail |
| layout-restore.test.ts | pass | 9 tests, 0 fail |

tsc: pre-existing 10 件（mailbox-cli.ts strictNullChecks 他）は T016 改変前と完全一致。**T016 起因の新規 tsc エラーゼロ**。

## 誤削除防止の確認

`CMUX_*` env（`CMUX_BUNDLE_ID` / `CMUX_SURFACE` / `CMUX_SOCKET_PATH` / `CMUX_BUNDLED_CLI_PATH`）・`cmux.ts` ファイル名・`skills/cmux-team/` ディレクトリ名・`SUBSTRATE_BINARY` シンボル名・refuse 検出用 `com.manaflow.cmux` 経路はすべて温存（仕様通り）。

## 検品

design-review: **Approved**（rev-2）。inspection: **GO**（完了条件 10/10 OK）。

## BREAKING change の周知

`ELEVENS_BACKEND=cmux` で cmux に逃げる経路は廃止。`ELEVENS_BACKEND` を `cmux` に pin している運用者は **env を unset するだけで OK**（c11 は auto-detect される）。

## 納品

ローカル ff-only マージ → main（merge SHA は close-task 時に記録）。
