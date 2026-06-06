# T013 Implementation Notes — post-mortem stderr proper (parent tee)

## Summary

`maybeRespawnWithStderrRedirect` の自己再 spawn 方式 (v0.8.0) で発生した TTY visibility regression (v0.8.1 で env opt-in 暫定回避) を、**親プロセスが child の stderr を tee する parent tee 方式**に置換することで構造的に解決。reload 経路には別途 file fd を直接注入する。

8 phase (P1→P8) 全 done。新規テスト 38 件 (post-mortem-redirect: 19 / smoke: 2 / reload: 17) 全 green。残課題は仕様策定済みの軽微な follow-up のみ (後述)。

## Changed files

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/post-mortem-redirect.ts` | **完全書き換え**。自己再 spawn → parent tee 方式へ転換。新 export: `__maybeRespawnWithStderrRedirectForTest` (m1)。`signalsToForward` DI は意図的に**廃止** (parent forward しない設計のため JSDoc に理由明記) |
| `skills/cmux-team/manager/post-mortem-redirect.test.ts` | **完全書き換え**。19 test、describe ブロックで organize。`MockChildStderr` / `MockChild` / `MockLogStream` 共通 mock。`PID_UNDEFINED` Symbol で「default パラメータ罠」を排除 |
| `skills/cmux-team/manager/post-mortem-redirect.smoke.test.ts` | **新規追加**。実 spawn で child を起動し file + TTY tee throughput と exit code propagation を E2E 検証。`CMUX_TEAM_SKIP_INTEGRATION=1` で skip 可能 |
| `skills/cmux-team/manager/reload.ts` | `stdio: "inherit"` → `["inherit", "inherit", fd]` に変更。`openSync(stderr.log, "a")` で append fd を取得し、spawn 後即 close (parent fd leak 防止)。失敗 3 経路 (`stderr_log_open_failed` / `spawn_threw` / `child_pid_undefined`) すべてで logger.log + events.jsonl `reload_failed` event を emit |
| `skills/cmux-team/manager/reload.test.ts` | 17 test に拡張。3 describe ブロック (happy / failure / invariants)。stdio fd 注入、close 順序、failure path 別の event emission をすべて assert |
| `skills/cmux-team/manager/events-writer.ts` | `EventStreamRecord` に `reload_failed` event を add-only で追加 (reason: `child_pid_undefined` / `stderr_log_open_failed` / `spawn_threw`) |
| `skills/cmux-team/manager/main.ts` | `performDaemonReload` 呼び出しに `projectRoot: PROJECT_ROOT` を追加 (stderr.log path 解決のため) |
| `docs/spec/15-post-mortem-evidence.md` | §2 redirect 方式の表を更新、§5 (a) に「TTY 親プロセスから起動した場合のみ」明記、**§5.1 reload 経路の失敗通知責務を新設** (3 経路 = logger.log / heartbeat / events.jsonl)、§9 D1 を parent tee 方式に改訂 |
| `CHANGELOG.md` | `[Unreleased]` セクションに T013 fix entry を追加 (parent tee 設計 / signal forward しない理由 / reload fd 注入 / 3 経路通知 / events schema 追加) |

## Per-phase done evidence

| Phase | 完了証拠 |
|---|---|
| **P1** API 再設計 | `MaybeRespawnOptions` から `signalsToForward` 廃止、`createWriteStreamImpl` / `processStderrWriteImpl` 追加。`MaybeRespawnResult.reason` を `"already-redirected" \| "non-tty" \| "tee-completed" \| "spawn-failed"` に変更 (旧 `"respawned"` 廃止) |
| **P2** helper 本体 | `runMaybeRespawn` 関数で rotate → createWriteStream → spawn → atomic bind (data/end/exit + signal absorb) → await exit → drain → logStream.end → cleanup → exitImpl の sync flow を実装。`waitForChildExit: false` 内部フラグで test hatch を別 export 分離 (m1) |
| **P3** post-mortem test | `bun test post-mortem-redirect.test.ts` → 19 pass / 0 fail / 51 expect / 345ms |
| **P4** reload fd 注入 | `stdio: [inherit, inherit, fd]` への切替完了。`openSync` 失敗 / `spawn` throw / `pid undefined` の 3 失敗経路を独立 catch し、それぞれ `logger.log` event 名と `reload_failed` event reason を別個に発行 |
| **P5** reload test | `bun test reload.test.ts` → 17 pass / 0 fail / 54 expect / 22ms。`describe("happy path"/"failure paths"/"invariants")` の 3 ブロック構成 |
| **P6** integration smoke | `bun test post-mortem-redirect.smoke.test.ts` → 2 pass / 0 fail / 8 expect / 75ms。実 bun child を spawn し stderr が file + TTY mock 両方に届き exit code 42 / 0 が伝播することを確認 |
| **P7** spec / CHANGELOG | spec §2 / §5(a) / §5.1 (新設) / §9 D1 / §10 を更新。CHANGELOG [Unreleased] に T013 fix entry 追加 |
| **P8** 全体回帰 | manager 配下の `*.test.ts` + `state-machine/*.test.ts` + `dashboard-*.test.tsx` を全件実行。T013 関連は 100% pass。残った 3 失敗 (`project-root.test.ts` 2件 / `cli-project-root.test.ts` 1件 / `cwd-mismatch.integration.test.ts` 3件) は `main` ブランチに対する diff が 0 行で確認済み — **T013 が混入したものではなく既存の `cmux-team` → `elevens` rename 残課題**。本 task のスコープ外 |

### P3 / P5 / P6 raw test 結果

```
post-mortem-redirect.test.ts        19 pass | 0 fail | 51 expect | 345ms
post-mortem-redirect.smoke.test.ts   2 pass | 0 fail |  8 expect |  75ms
reload.test.ts                       17 pass | 0 fail | 54 expect |  22ms
```

## Design decisions (deviations from plan)

plan からの構造的逸脱は **無し**。以下は plan の補遺・行間に明示されていなかった implementation detail。

1. **`__maybeRespawnWithStderrRedirectForTest` の `waitForChildExit` フラグ位置**: plan §m1 では「test 用 hatch は別 export」とだけ書かれていたが、内部実装では `MaybeRespawnOptions & { waitForChildExit?: boolean }` 拡張型 + `runMaybeRespawn(opts, { waitForChildExit })` の internal helper にまとめた。production export (`maybeRespawnWithStderrRedirect`) は常に `waitForChildExit: true` 固定。型レベルで「production code からは呼べない」 invariant を確保。

2. **reload の `openSync` 失敗時の fall-back 方針**: plan は明示していなかったが、failure mode として「stderr fd を取れない場合 fall-back で `stdio: "inherit"` で起動」と「fail-fast で exit(1)」の 2 択があった。**fail-fast を採用**。理由: 親 tee (= parent A) が exit 直後の状況では child C の inherited stderr は壊れた pipe を継承するため SIGPIPE で死ぬ。fall-back で起動しても直後に SIGPIPE で再死する経路になるため、ユーザに「何が起きたか」を 3 経路 (logger / heartbeat / events) で確実に届ける方が UX として優れる。

3. **spawn `throw` の独立 catch**: plan は `spawn` から throw されるケースを明示していなかったが、SDK バグ / リソース不足で `spawn` 自体が throw する余地があるため `try/catch` を分けて `reload_failed` reason=`spawn_threw` を別個に emit。これにより事後 grep で「pid undefined」と「throw」を区別可能。

4. **events.jsonl emit 失敗時の挙動**: `emitEvent` 自体は best-effort 設計 (`events-writer.ts:236-261` の中で try/catch を持つ) だが、reload.ts 側で念のため `try { await emitEventImpl(...) } catch { /* best-effort */ }` で重ね包んだ。logger.log と heartbeat は別経路で動くため events.jsonl が落ちても 2 経路は機能する原則 (M3) を構造的に守る。

## Known TODOs / follow-up candidates

すべて Review n1 / n2 / n3 / 本 implementation での発見事項。**本 task の scope 外**として明示記録。

- **n3 (TTY 切断時の SIGHUP edge)**: parent が SIGHUP の default action (terminate) を許容する設計のため、TTY 切断時に親が一足先に exit すると Acceptance Criterion 5「親は child の exit code を継承する」が成立しないシナリオが残る。実害は user が exit code を観測できない (shell prompt が既に消えている) ため許容範囲だが、launchd plist 等の non-TTY 経路を整備する際 (§9 D5) は SIGHUP も absorb に倒す余地がある。

- **DropdownLog / Telemetry の `reload_failed` event 取扱**: events.jsonl reader (Web Dashboard / `cmux-team events` CLI) は本 event を未認識のまま素通しする (schema_version bump せず add-only のため compatibility は壊れない)。dashboard / CLI で表示色を付ける follow-up は別 task で。

- **smoke test の CI gating**: `post-mortem-redirect.smoke.test.ts` は実 spawn を伴うため `bun` バイナリと PATH 依存。CI 環境で問題が出るなら `CMUX_TEAM_SKIP_INTEGRATION=1` を `.github/workflows/test.yml` に追加する余地。

- **既存の pre-existing test failure**: `project-root.test.ts` (2件) / `cli-project-root.test.ts` (1件) / `cwd-mismatch.integration.test.ts` (3件) は `cmux-team` → `elevens` rename 残課題。別 task で一括修正推奨 (T013 では touch しない)。

## Verification commands

```bash
# Quick T013 unit tests
cd skills/cmux-team/manager
bun test --timeout 30000 post-mortem-redirect.test.ts
bun test --timeout 30000 post-mortem-redirect.smoke.test.ts
bun test --timeout 30000 reload.test.ts

# Full manager regression (per CLAUDE.md)
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

## Acceptance Criteria 対応

| # | 基準 | 状態 | 確認 |
|---|---|---|---|
| 1 | Bun runtime panic / Rust crate panic / libc abort が `manager.stderr.log` に残る | ✅ | post-mortem-redirect.ts:253 `childStderr.on("data", chunk => logStream.write(chunk))` で child の fd 2 raw を全文 file 書き出し |
| 2 | `elevens start` で stdout/stderr が TTY に通常通り見える | ✅ | post-mortem-redirect.ts:256-260 `processStderrWriteImpl(chunk)` で TTY 同時 write。stdout は `stdio[1] = "inherit"` で素通し |
| 3 | child spawn 失敗時 TTY と file 両方にエラーが出る | ✅ | post-mortem-redirect.ts:227-247 `if (!child.pid)` ブロックで両者に write してから exit(1) |
| 4 | Ctrl+C で graceful shutdown が **1 回だけ**走る | ✅ | parent は SIGINT / SIGTERM を absorb (no-op listener) し forward しない。kernel pgroup broadcast で child 側 fatal-handlers が 1 回だけ動く。post-mortem-redirect.test.ts line 281 で `child.kill` mock が呼ばれないことを assert |
| 5 | 親プロセスは child の exit code を継承する | ✅ | `deriveExitCode(code, signal)` で code → 128+signo → 1 の優先で導出。post-mortem-redirect.test.ts で exit 7 → 7、SIGINT → 130、SIGTERM → 143 を assert。smoke test で実 spawn 経路でも 42 / 0 を確認 |
