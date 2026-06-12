---
id: A036
type: research
title: "c11/cmux 再起動時の claude/codex セッション復帰 — 調査結果と方針提案 (T031)"
created: 2026-06-12T06:40:43.553Z
author: surface:20
---

# c11/cmux 再起動時の claude/codex セッション復帰 — 調査結果と方針提案

- 調査日: 2026-06-12
- 環境: c11 0.51.0 (108) / macOS (Darwin 25.4.0) / codex CLI 0.139.0
- 調査者: Researcher Agent (task-031-1781245223)

## 1. 概要

c11 0.51.0 のネイティブプリミティブ（conversation store + snapshot/restore）に乗る前提で、セッション復帰を実用化するための 4 つのサブ質問を調査した。結論の要点:

1. **`DISABLE_SESSION_RESTORE` の出どころを特定した。** `~/Library/LaunchAgents/com.stage11.c11.disable-restore.plist`（2026-05-22 作成）がログイン時に `launchctl setenv CMUX_DISABLE_SESSION_RESTORE 1` を実行しており、c11 アプリが launchd 経由でこれを継承し全 PTY に伝播している。plist 削除 + `launchctl unsetenv` + c11 再起動で解除できる。
2. **snapshot/restore CLI は workspace 単位・全 workspace 一括（`--all` + set manifest）の両方をサポート済み。** 自動化は「LaunchAgent による定期 `c11 snapshot --all`」を推奨。外部プロセスからは `~/Library/Application Support/c11/last-socket-path` で socket を解決できる。
3. **codex 補完は実現可能、かつ当初想定より強い方式が見つかった。** 稼働中の codex プロセスは rollout JSONL を**書き込み用に open し続けている**ため、`lsof -p <pid>` で session id を 100% 一意に特定できる（実機で 4 プロセス全てで確認）。cwd + mtime 推定に頼る必要がない。
4. **「c11 既存プリミティブに乗る」方針は妥当**であり、調査でさらに補強された。c11 0.44.0+ には codex 用の pull-scrape strategy まで既に実装済みで、残る欠落は「同一 cwd に複数 codex pane がある場合の曖昧性」のみ。同一 cwd に複数 codex を並べる使い方では常に曖昧ケースに落ちる（現環境でも別プロジェクト `~/git/Brainship/prototype` で全 codex プロセスが同一 cwd となり実際に発生している）ため、この欠落を埋める elevens 側の薄い補完が効く。

## 2. 調査結果（サブ質問ごと）

### 2.1 DISABLE_SESSION_RESTORE の出どころ特定

**結論: LaunchAgent `com.stage11.c11.disable-restore` が launchd ユーザー環境に setenv している。**

調査の経路:

```bash
# 1) 現プロセス環境に両変数が存在
$ env | grep DISABLE_SESSION_RESTORE
C11_DISABLE_SESSION_RESTORE=1
CMUX_DISABLE_SESSION_RESTORE=1

# 2) shell rc / .envrc / c11 defaults には無し（grep ~/.zshrc 等 → ヒットなし、
#    defaults read com.stage11.c11 → restore 系キーなし）

# 3) launchd ユーザー環境にヒット
$ launchctl getenv CMUX_DISABLE_SESSION_RESTORE
1
$ launchctl print gui/$(id -u) | grep -A3 "environment ="
	environment = {
		CMUX_DISABLE_SESSION_RESTORE => 1
		...

# 4) 設定主の特定
$ grep -rl DISABLE_SESSION_RESTORE ~/Library/LaunchAgents/
/Users/yamamoto/Library/LaunchAgents/com.stage11.c11.disable-restore.plist
```

plist の内容（全文）: `RunAtLoad=true` で `/bin/launchctl setenv CMUX_DISABLE_SESSION_RESTORE 1` を実行するだけのワンショット。**作成日時は 2026-05-22 06:24**。elevens の `.team/artifacts/` / `.team/tasks/` に作成記録は無く、elevens のコードベースもこの変数を設定していない（過去に c11 の起動時 restore 挙動を止めるため手動 or 別ツールで仕込まれたものと推定。Label が `com.stage11.c11.*` 名前空間なので c11 関連の作業時に作られた可能性が高い）。

補足の事実関係:

- c11 バイナリ（universal binary）が読むのは `CMUX_DISABLE_SESSION_RESTORE` のみ（`strings` で確認。`C11_DISABLE_SESSION_RESTORE` は文字列として存在しない）。近傍に `didAttemptStartupSessionRestore` / `isApplyingStartupSessionRestore` があり、**アプリ起動時の前回セッション自動復元（startup session restore）をゲートするフラグ**であることが分かる。環境にある `C11_` 変種は c11 の dual-write（`CMUX_*` → `C11_*` ミラー）による派生。
- c11 は自前の session 永続化ファイル `~/Library/Application Support/c11/session-com.stage11.c11.json`（windows / sidebar / tabManager 構造、本調査中も随時更新されている）を持っており、startup restore はこれを使う。**つまり「レイアウトは再現できるがセッションが復帰しない」現状は、この disable フラグで startup restore の conversation resume 部分（あるいは全体）が殺されていることと整合する。**

**解除手順（提示のみ。実行はしていない）:**

```bash
# 1. launchd 環境から即時除去（新規起動アプリに有効）
launchctl unsetenv CMUX_DISABLE_SESSION_RESTORE

# 2. ログイン時の再設定を止める
launchctl bootout gui/$(id -u)/com.stage11.c11.disable-restore 2>/dev/null || true
rm ~/Library/LaunchAgents/com.stage11.c11.disable-restore.plist
# （削除に抵抗があれば mv で退避でも可。plist はワンショットなので bootout は失敗しても問題ない）

# 3. c11 アプリを再起動（既存プロセスは起動時に env を取り込み済みのため必須）
```

**解除後の検証手順（提示のみ）:**

1. c11 再起動後の任意ペインで `env | grep DISABLE_SESSION_RESTORE` → 何も出ないこと
2. `c11 conversation get --surface <対象surface> --json` で `can_resume: true` かつ実 id（`placeholder: false`）であることを確認
3. claude セッションを 1 つ開いて適当な会話をし、c11 を quit → 再起動
4. startup restore で workspace が再構築され、対象ペインに `claude --resume <id>`（c11 内部では `cc --resume`）が自動投入されて会話履歴が戻ることを確認
5. 戻らない場合の切り分け: `c11 conversation get` の `diagnostic_reason` を読む（strategy の判断理由が入る設計）

**注意（検証時に踏みやすい罠）:** c11 アプリ設定で `claudeCodeHooksEnabled = 0`（defaults 確認済み）になっており、c11 ペインには `CMUX_CLAUDE_HOOKS_DISABLED=1` が立つため **c11 純正の claude wrapper は完全パススルー**している。それでも現環境で claude-code の capture が 9 件 [alive] なのは、**elevens が spawn する claude に自前 hook（`SessionStart` → `c11 claude-hook session-start` 転送、`manager/main.ts`）と `--session-id` を注入しているから**。つまり:

- elevens 管理下の claude ペイン → capture される（restore 可能）
- ユーザーが手で起動した素の `claude`（`--session-id` なしで稼働中のプロセスを複数確認）→ c11 wrapper パススルーのため capture されない可能性が高い。全ペインを restore 対象にしたいなら c11 設定の Claude Code hooks を有効に戻すか、elevens 同様の hook を共通 settings に入れる必要がある。検証手順 2 で per-surface に確認すること

### 2.2 snapshot 自動化の設計案

**CLI 実仕様（`--help` 実行で確認、c11 0.51.0）:**

| コマンド | 要点 |
|---|---|
| `c11 snapshot [--workspace <ref>] [--out <path>] [--all] [--json]` | 無引数で現 workspace を `~/.c11-snapshots/<ulid>.json` へ。`--all` は全 workspace を一括 capture し、set manifest を `~/.c11-snapshots/sets/<set-ulid>.json` に書く。`--all` と `--workspace`/`--out` は排他 |
| `c11 restore <id-or-path> [--in-place] [--json]` | ULID（per-workspace / set 両対応）または絶対パス。set は全 workspace を一括再構築（`--in-place` 不可）。**2 回実行すると workspace が 2 つできる**（`--in-place` で置換）。`C11_SESSION_RESUME`（mirror: `CMUX_SESSION_RESUME`）が truthy のとき Claude Code ターミナルは `cc --resume <session-id>` で会話ごと復帰、unset なら fresh shell |
| `c11 list-snapshots [--json] [--sets\|--all]` | `~/.c11-snapshots/` + legacy `~/.cmux-snapshots/` をマージして新しい順に列挙 |

現状 `c11 list-snapshots` → `no snapshots`（snapshot は一度も撮られていない）。c11 本体に定期 snapshot 機構は見当たらない（バイナリ strings に autoSnapshot / snapshotInterval 等なし）。

**外部プロセスからの socket 解決:** LaunchAgent 等の c11 外プロセスには `CMUX_SOCKET_PATH` が無いが、c11 が `~/Library/Application Support/c11/last-socket-path` に現行 socket パスを書き出しているため、`c11 --socket "$(cat ~/Library/Application\ Support/c11/last-socket-path)" snapshot --all` で到達できる。

設計案の比較は §3 を参照。

### 2.3 codex 補完 wrapper の実現性

**結論: 実現可能。しかも cwd + mtime 推定ではなく `lsof` による確定的な対応付けができる。**

(a) **~/.codex/sessions/ の実構造**（23 ファイル確認）:

- パス: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601秒精度>-<session-uuid>.jsonl` — **session id はファイル名に含まれる**
- 先頭行は `type: "session_meta"` で `payload.id`（= ファイル名の uuid と同一）、`payload.cwd`、`payload.timestamp`、git 情報（branch / commit / repository_url）を持つ。以降は `event_msg` / `response_item` / `turn_context` / `compacted` の append
- `codex resume <SESSION_ID>` は codex CLI 0.139.0 で正式サポート（`codex resume --help` で確認。UUID 指定 / `--last` / picker）

(b) **session id ↔ surface の対応付けの信頼性:**

当初案（push 方式）の前提だった「JSONL から特定」よりも強い事実を実機で確認した。**codex プロセスは自分の rollout ファイルを書き込み fd で open し続けている**:

```bash
$ for pid in 8348 51632 71229 72431; do lsof -p $pid | grep 'sessions/.*jsonl'; done
codex 8348  ... 44w ... rollout-2026-06-12T00-22-37-019eb747-....jsonl
codex 51632 ... 42w ... rollout-2026-06-12T03-27-36-019eb7f0-....jsonl
codex 71229 ... 39w ... rollout-2026-06-10T22-42-28-019eb1c5-....jsonl
codex 72431 ... 33w ... rollout-2026-06-10T07-33-46-019eae85-....jsonl
```

4 プロセス全てが **同一 cwd（`/Users/yamamoto/git/Brainship/prototype`）** で、それぞれ別の rollout を保持（live cwd を `lsof -a -p <pid> -d cwd` で、rollout 先頭行の `session_meta.payload.cwd` も同値であることを確認）。pid → rollout → session id の対応は**一意・確定的**で、cwd 重複の影響を受けない。

(c) **c11 側の受け口（既存実装の確認）:**

- `c11 conversation push --kind codex --id <id> --source <hook|scrape|manual> [--cwd <path>] [--state ...]` が存在（`conversation --help` で確認）。source 優先度は `hook > scrape > manual > wrapperClaim` で、**manual push は wrapper-claim placeholder を置換できる**
- 重要な発見: c11 純正 codex wrapper（`/Applications/c11.app/Contents/Resources/bin/codex`）のコメントに設計史が明記されている。c11 0.44.0+ には **Codex strategy（次回 workspace open 時の pull-scrape）が既に実装済み**で、surface の cwd + claim 後 mtime で rollout をマッチし `codex resume <id>`（`--last` ではなく特定 id）を投入する。ただし**同一 cwd に複数候補がある曖昧ケースでは auto-resume せず state=unknown + sidebar advisory に倒す**（2026-04-27 の staging-QA 事故 = 2 ペインが同じ「最新」セッションを resume した件への対策として意図的にこの仕様）
- 現環境の conversation store: claude-code 9 件 [alive]（実 id）、codex 5 件 [unknown]（`wrapper-claim:<surface>:<ts>` placeholder）

つまり「codex の id capture の欠落」の正体は capture 機構が無いことではなく、**scrape strategy が cwd 衝突時に安全側へ倒れること**。同一リポジトリ cwd に複数 codex を並べる使い方（現環境では別プロジェクト Brainship で実際に発生している）では常に曖昧ケースに落ちるため、ここを lsof 方式の manual push で先回りして埋めるのが効く。

(d) **補完方式の設計（推奨）:**

```bash
# 概念実装: codex 起動後に走る reconciler（wrapper 内 background でも、定期 sweep でも同型）
for pid in $(pgrep -x codex); do
  rollout=$(lsof -p "$pid" 2>/dev/null | awk '/sessions\/.*\.jsonl/ {print $NF; exit}')
  [ -n "$rollout" ] || continue
  sid=$(basename "$rollout" .jsonl | sed -E 's/^rollout-[0-9T-]+-//')
  surface=$(ps eww -p "$pid" -o command= | tr ' ' '\n' | awk -F= '/^CMUX_SURFACE_ID=/{print $2; exit}')
  cwd=$(lsof -p "$pid" -d cwd 2>/dev/null | awk 'END{print $NF}')
  [ -n "$surface" ] && c11 conversation push --kind codex --id "$sid" \
      --source manual --cwd "$cwd" --surface "$surface"
done
```

surface の特定も codex プロセス環境の `CMUX_SURFACE_ID`（`ps eww` で読める）から確定的に取れるため、**wrapper を被せずとも「定期 reconciler」だけで成立する**。1 ペイン 1 codex の前提も不要。

残検証事項（実装タスク側で確認）: ① `conversation push` の `--surface` フラグ受理（help の Surface resolution 記述上は flag or env だが push での明示確認）、② restore 時に scrape strategy が manual の実 id を尊重するか（優先度上 scrape > manual だが、曖昧 scrape が manual 実 id を unknown で上書きしない事の確認）。

### 2.4 方針確認

**「フルスクラッチ wrapper + 独自レイアウト記憶は不採用、c11 既存プリミティブに乗る」方針は妥当。調査結果はこれを強く補強する。**

- レイアウト記憶: c11 が `WorkspaceApplyPlan` 統一フォーマット（blueprint = snapshot 同形）+ set manifest + 内蔵 startup session store を既に持つ。独自実装は車輪の再発明どころか、c11 の restore セマンティクス（`--in-place` の冪等性、focus policy、resume command 合成）と二重管理になり確実に divergence する
- conversation 復帰: claude 側は wrapper の `--session-id` mint + hook capture + `cc --resume` 合成が完成しており、elevens 管理下では elevens 自前 hook が既に `c11 claude-hook session-start` へ転送して接続済み。codex 側も scrape strategy まで実装済みで、欠落は「cwd 衝突時の曖昧性解決」だけ。これは §2.3 の lsof reconciler（数十行の read-only スクリプト + `conversation push`）で埋まる
- elevens の設計原則との整合: conversation store / snapshot は **state の外部化**（c11 が一次管理）、reconciler は **pull 型・決定論的**（lsof/ps の観測 → CLI push）、復帰失敗時は `diagnostic_reason` で**観測可能**。fail-fast 原則（c11 前提・フォールバック不採用）とも一致する

唯一の方針上の注意: 現環境は「c11 の機能が壊れている」のではなく「**復帰機能が明示的に無効化されている**（LaunchAgent）+ **snapshot を一度も撮っていない**」状態。まず §2.1 の解除と素の復帰検証を先に行い、その結果を見てから自動化・補完の実装に進むのが正しい順序。

## 3. 比較・分析: snapshot 自動化の選択肢

| 選択肢 | 仕組み | 長所 | 短所 | 評価 |
|---|---|---|---|---|
| **(A) LaunchAgent 定期実行** | `StartInterval`（例: 600s）で `c11 --socket "$(cat .../last-socket-path)" snapshot --all` | 実装最小（plist 1 枚 + スクリプト 1 本）。c11 死亡直前の状態も最大 interval 分の鮮度で残る。c11 非稼働時は socket 不達で無害に skip | クラッシュ直前 interval 分は失われる。snapshot ファイルが溜まる（要 rotation） | **推奨**。決定論的・読み取り専用・c11 を改造しない |
| (B) 終了フック | c11 quit 時に snapshot | 終了時点の完全な状態 | c11 に quit hook の口が無い（CLI/strings から未確認）。クラッシュ時は撮れず本来の目的（不意の死への備え）に弱い | 単独では不採用。c11 側に機能があれば (A) と併用 |
| (C) elevens daemon に組み込み | Manager daemon の interval timer から snapshot | 既存プロセスに同居、`.team/config.json` で設定可 | elevens が動いている workspace でしか撮れない。daemon の責務が太る（minimal scope 原則に反する） | 次点。(A) で得た知見を後から daemon に移すのは容易 |
| (D) 独自スナップショット実装 | 独自に tree + env を記録 | — | 車輪の再発明。`WorkspaceApplyPlan` と divergence | 不採用（前提どおり） |

(A) の補足設計:

- 保存先はネイティブ既定（`~/.c11-snapshots/`）のまま使い、rotation は「sets を N 世代残して古い per-workspace snapshot を削除」する小スクリプトを同 LaunchAgent 内で実行
- 復元 wrapper は薄く: `elevens restore-workspaces [<set-id>]` → 引数なしなら `c11 list-snapshots --sets` の最新 set を `C11_SESSION_RESUME=1 c11 restore <set-id>` で投入するだけ。重複 workspace 防止のため「既に同名 workspace が開いている場合は警告して中断」程度のガードのみ
- なお §2.1 の解除が完了すれば startup restore（内蔵 session store）が平常系を担うため、snapshot 自動化の役割は「クラッシュ・誤 quit・複数日前の状態に戻る」ための**保険レイヤ**と位置づけるのが正しい

## 4. 結論・推奨事項

実施順序つきの推奨アクション（起票すべきタスク案）:

1. **[Task 案] DISABLE_SESSION_RESTORE 解除と素の復帰検証**（人間 or Master 主導・破壊的検証を含むため通常 Task にせず手動推奨）
   §2.1 の解除手順 → 検証手順 1–5 を実施。c11 startup restore + claude resume が素で機能することを確認する。**他の全ての施策の前提**。あわせて c11 設定 `claudeCodeHooksEnabled=0` の意図（elevens 通知との重複回避）と「素の claude ペインが capture されない」トレードオフをどちらに倒すか決める
2. **[Task 案] codex reconciler の実装**（小・効果大）
   §2.3(d) の lsof + `ps eww` + `conversation push --source manual` reconciler を `elevens` CLI サブコマンド（例: `elevens codex-reconcile`）として実装し、まず手動実行で [unknown] 5 件が実 id 化されることを確認。残検証 2 点（`--surface` 受理 / manual と scrape の優先度挙動）もここで潰す。安定したら LaunchAgent or daemon interval に昇格
3. **[Task 案] snapshot 自動化 (A 案) の導入**
   LaunchAgent + `snapshot --all` + rotation + `restore-workspaces` 薄 wrapper。1 の検証完了後に着手（startup restore が生きれば優先度は下がる＝保険レイヤ）
4. **[Artifact 案]** 本調査の確定事実（LaunchAgent の存在と作成日、lsof 方式の実証、c11 Codex strategy の存在）を `/elevens:artifact research` で登録（Conductor の完了処理に委ねる）

却下した選択肢: フルスクラッチ wrapper + 独自レイアウト記憶（§2.4）、quit hook 単独方式（§3-B）、codex の cwd+mtime 推定だけに頼る補完（lsof 方式が上位互換、§2.3）。
