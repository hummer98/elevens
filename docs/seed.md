# elevens — seed

> cmux-team の self-fork として、Stage 11 Agentics の **c11**（cmux の macOS Swift fork、agent-native terminal multiplexer）を substrate にした multi-agent orchestration package。
>
> 作成日: 2026-05-08

---

## なぜ elevens か（why fork）

### 直接のトリガー

cmux v0.64.0 (2026-05-05) で導入された portal lazy-mount リファクタの副作用として、**非フォーカス workspace の terminal surface が PTY を起動しない regression** が発生。`cmux send` で送ったコマンドは queue に積まれるだけで、workspace を select するまで配送されない。

- 該当箇所: `Sources/GhosttyTerminalView.swift:4793` (`attachView`) と `:5413` (`requestBackgroundSurfaceStartIfNeeded`) の `view.window != nil` ガード
- upstream issue: [manaflow-ai/cmux#3798](https://github.com/manaflow-ai/cmux/issues/3798)
- 結果: 6-8 workspace 並列運用（cmux-team の典型的な使い方）が成立しなくなった

### 構造的な背景

これは単発のバグではなく、**cmux と cmux-team の思想的乖離が表出したもの**。

| | cmux | cmux-team |
|---|---|---|
| プロダクトの中心 | リッチな GUI ターミナル + browser 統合 | headless multi-agent orchestration |
| 直近の開発方向 | file explorer / passkey / Sparkle / menu bar mode | 4 層アーキ / FSM / trace DB / web dashboard |
| socket API の優先度 | 二次（GUI 文脈のサポート機能） | **必須**（control plane） |
| 非フォーカス pane の扱い | 「見えないなら止めていい」 | 「見えなくても動き続けてほしい」 |

cmux 側の portal lazy-mount は GUI 視点では正しい最適化だが、orchestration 視点では契約違反。今後も同様の前提齟齬が起き続けることが予想される。

### c11 という選択肢

[Stage-11-Agentics/c11](https://github.com/Stage-11-Agentics/c11) は cmux の macOS Swift fork で、明示的に **"Agent-native Terminal Multiplexing for 10,000x hyperengineers"** を mission に掲げている。

c11 v0.46.0 (2026-05-06、cmux 0.64.0 の翌日) は同じ regression を**真逆のアプローチで解決**:

| | cmux 0.64.x | c11 0.46.0 |
|---|---|---|
| 非フォーカス workspace | view 階層から **dismount** | SwiftUI tree に維持 + `AppKitHiddenWrapper` (`isHidden=true`) でラップ |
| `view.window` | nil（dismount のため） | non-nil（window hierarchy に残る） |
| `requestBackgroundSurfaceStartIfNeeded` の `view.window != nil` ガード | 存在 → defer | **削除済** → 即 `createSurface` |
| PTY の起動タイミング | workspace を select するまで起動しない | 即起動、scrollback も維持 |
| 非フォーカス時のコスト削減手段 | dismount（PTY ごと止まる） | `setOcclusion(false)` で render を <2Hz に絞る |

加えて c11 には cmux に無い orchestration-friendly な primitive がある:

- **Surface Metadata (`mailbox.*`)**: 各 surface が JSON 構造化メタデータを持つ。エージェントが `mailbox.role` / `mailbox.status` / `mailbox.task` / `mailbox.progress` を書き、Manager は metadata を読むだけで状態判定可能。
- **Socket API v2 (JSON-RPC)**: text-mode CLI に依存しない構造化レスポンス。
- **Agent TUI Auto-Detection** (`AgentDetector.swift`): Claude Code / Codex / Kimi / OpenCode 等を自動検出。
- **Workspace Snapshot** (`workspace snapshot --all` + `restore <set-id>`): manifest 化された永続化と polymorphic 復元。
- **Hand-port culture**: cmux upstream の主要 fix（例: socket main-thread deadlock fix #3340）を c11 が積極的に取り込み、しかも cmux が拾わなかった範囲（`surface.*` methods）まで scope 拡張している。

詳細評価は [hummer98/cmux-team#43](https://github.com/hummer98/cmux-team/issues/43) を参照。

---

## CLI 互換性（c11 swap で何が動くか）

c11 は cmux からのフォークで **transition を意識した legacy 互換** を維持している。`CLI/c11.swift:64` のコメント:

> // Why: binary rename from `cmux` to `c11` keeps both namespaces live during transition.

### そのまま動く

- **subcommand**: `tree` / `read-screen` / `send` / `send-key` / `new-split` / `new-surface` / `select-workspace` / `notify` / `set-status` / `tab-action` 等、cmux-team が使う CLI は同名・同シグネチャで存在
- **環境変数**: `CMUX_SOCKET` / `CMUX_SOCKET_PATH` / `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` / `CMUX_SOCKET_PASSWORD` をそのまま読む（`C11_SOCKET` が優先、cmux 系は fallback）
- **socket file name**: `cmux.sock` のまま（`stableSocketFileName = "cmux.sock"` in `c11.swift:722`）

### 変更が必要

- **バイナリ呼び出し名**: `spawn("cmux", [...])` → `spawn("c11", [...])` (or env で切替)
- **app bundle path**: `/Applications/cmux.app` を直接参照していれば `/Applications/c11.app` に。cmux-team は基本参照していないはず

### c11 にしか無い primitive

cmux-team は使っていないので互換性には影響しないが、将来活用候補:
- `surface set-metadata` / `get-metadata`（`mailbox.*` の正体）
- `workspace snapshot` / `restore` / `list-snapshots`
- `surface-color` / `cancel-flash`
- v2 JSON-RPC socket method 群

---

## アーキテクチャの継承

cmux-team の本質的価値は **substrate 非依存**。以下は丸ごと持ってくる:

| 層・機能 | 状態 |
|---|---|
| 4 層アーキテクチャ (Master / Manager / Conductor / Agent) | 維持。pull 型監視、責務分離はそのまま |
| Task FSM (`docs/spec/07-state-machine.md`) | 維持 |
| `task-state.json` + CLI (create / update / close / abort / restart) | 維持 |
| Trace DB (`hook_signals` / `api_usage` / `task_sessions`) | 維持 |
| Metrics + DuckDB SQL 解析 + cohort 比較 | 維持 |
| Web dashboard (`docs/spec/12-web-dashboard.md`) | 維持 |
| Token pool (`docs/spec/09-token-pool.md`) | 維持 |
| Sync gate / `--exclusive` / `--run-after-all` task attributes | 維持 |
| Artifacts / journal protocol | 維持 |
| Templates (`{{VARIABLE}}` placeholder + `_common.md` overlay) | 維持 |
| 設計原則 (CLAUDE.md): 上位が下位を監視 / 決定論はコード / 各層は自分の仕事だけ / 構造的正しさ優先 / state を外部化 | 維持 |

substrate-specific な部分は最小:

- `skills/cmux-team/manager/cmux.ts` (cmux CLI adapter)
- `skills/cmux-team/manager/master.ts` / `conductor.ts` の launch コマンド組み立て
- 一部の docs / spec での命名

---

## 移行フェーズ

### Phase 0 — seed（now、本ドキュメント）

- ✅ elevens repo 作成、cmux-team を mirror（履歴・tag 継承）
- ✅ `docs/seed.md`（this file）
- 📌 cmux-team は当面 local + GitHub に残す（institutional memory として）

### Phase 1 — substrate adapter PoC（〜2026-05-15）

- `cmux.ts` adapter を env で backend 切替可能に（`ELEVENS_BACKEND=c11|cmux`、default は当面 cmux）
- carta workspace 等で c11 を substrate にして:
  - `cmux-team start` 相当が動く
  - Master / Conductor / Agent spawn が動く
  - **非フォーカス workspace で PTY が起動する**ことを確認（regression 解消の検証）
  - `cmux send` / `read-screen` / `tree` の出力互換性を確認

PoC で問題が出たら scope を広げる（adapter の追加、subcommand の差吸収など）。

### Phase 2 — mailbox.* / JSON-RPC 移行（〜2026-06-15）

- Conductor / Agent が surface metadata (`mailbox.role`, `mailbox.status`, `mailbox.task`, `mailbox.progress`) を書き込むように改修
- Manager が metadata-poll で状態判定する経路を追加（既存 done marker と並列稼働）
- 並列稼働期間で挙動比較・ログ収集
- AgentDetector による idle 判定への置き換え（"ing…/esc to interrupt" pattern 検出を deprecated 扱い）

### Phase 3 — cmux サポートの段階削除（〜2026-07-15）

- `ELEVENS_BACKEND` の default を c11 に切替
- cmux backend を deprecated 表示
- cmux 固有のコード paths（done marker / PID watcher の一部 / read-screen pattern detection）を削除
- README / docs を c11 native に書き換え

### Phase 4 — cleanup（タイミング判断）

- cmux-team 旧 repo を archive
- elevens を npm publish (`@hummer98/elevens` or `elevens`)
- plugin marketplace 登録
- 必要なら最終リネーム（`cmux-team` 残骸 → `elevens` 統一）

---

## 設計原則の継承と拡張

CLAUDE.md の 5 原則は維持:

1. 上位が下位を監視する（pull 型）
2. 決定論的なものはコードで、判断が必要なものは AI で
3. 各層は自分の仕事だけをする
4. 逸脱を防ぐより、逸脱しても安全な構造にする
5. 構造的正しさを優先（state machine / 専用ライブラリの積極導入）

elevens 固有で追加する原則:

6. **substrate adapter pattern を維持**: c11 に過度に密結合させず、将来 substrate 切替の余地を残す（万一 c11 が止まった場合の救命ボート）
7. **mailbox.\* first**: 状態は metadata に書く、screen-scrape はフォールバックのみ
8. **JSON-RPC 経路を優先**: text-mode CLI は legacy 扱い

---

## Risks と watching

### c11 sustainability

- Stage 11 Agentics は小規模ベンダー
- c11 自体が止まったら同じ問題（substrate ロックイン）を 2 度繰り返すリスク
- 対策:
  - substrate adapter pattern を maintain（Phase 1 の段階で確立）
  - c11 maintainer の活動度を定期 watch（commit cadence / issue 応答時間）
  - 万一の選択肢を頭に持つ: 自前 xterm.js + node-pty / 別 fork / 自前 multiplexer

### c11 自体の regression

- c11 も active 開発中なので新規 regression は起こり得る
- 対策: cmux-team で実装済みの観察箱（trace DB / metrics / events stream）を活用、socket API の挙動を定量モニタリング

### cmux fork からの divergence

- c11 は cmux のセキュリティ・レンダリング fix を hand-port しているが、いずれ完全に divergence する可能性あり
- elevens としては c11 を信頼するが、divergence 時に重要な fix が漏れる可能性は残る
- 対策: c11 changelog の継続 watching、必要に応じて upstream の fix を c11 / elevens 側に通知

---

## 用語

- **substrate**: orchestration の下にある terminal multiplexer (cmux / c11 / 将来の代替)
- **mailbox.\***: c11 surface に付与される JSON metadata の named slot（`mailbox.role`, `mailbox.status`, `mailbox.task`, `mailbox.progress` 等）
- **AppKitHiddenWrapper**: c11 が非フォーカス workspace を view 階層に維持しつつ render を抑制するためのラッパー（cmux 0.64.x の dismount アプローチとの根本的な差異）
- **portal lazy-mount**: cmux 0.64.x で導入された session restoration / 省メモリ機構。orchestration 視点では regression の原因
- **4 層 (Master / Manager / Conductor / Agent)**: 階層的監視・委譲アーキテクチャ。cmux-team から継承

---

## 参考リンク

- 上流 c11: https://github.com/Stage-11-Agentics/c11
- cmux upstream issue (regression report): https://github.com/manaflow-ai/cmux/issues/3798
- cmux-team 内 tracking issue: https://github.com/hummer98/cmux-team/issues/51
- cmux-team 内 c11 評価 issue: https://github.com/hummer98/cmux-team/issues/43
- cmux-team リポジトリ（migration 元、当面残置）: https://github.com/hummer98/cmux-team

---

*この seed は elevens の出発点を記録した不変文書。以降の判断はこのドキュメントを起点に追跡される。*
