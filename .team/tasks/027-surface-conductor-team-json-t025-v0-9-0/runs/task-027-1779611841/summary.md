# T027 結果サマリー

surface 不在の残骸 Conductor（status:"broken"）を team.json から除去できる経路を追加した（T021 → T025 → T027 再々起票、v0.9.0 環境で完遂）。

## 採用方針: 案A + 案B 併用

- **案B（構造的根治）**: `planLayoutRestore()` で `status==="broken" && !surfaceExists` を pidAlive 短絡より**前**に discard。daemon 起動時 reconcile で「現スロットに属さない過去 surface の残骸」を自然消滅させる。
- **案A（escape hatch）**: `CONDUCTOR_CLEAR` ハンドラで surface 不在時に idle 復帰でなく team.json entry を削除。ユーザーが今すぐ消せる経路を確保。

タスク指示は「案B優先で検討」だったが、B 単独だと daemon 再起動を強要する UX 退行になる（現に stuck している surface:27 を今すぐ消せない）。Design Review で「B を主・A を副」の位置付けが指示趣旨と整合と判定され Approved。

## 変更ファイル

| ファイル | 変更 | 内容 |
|---|---|---|
| `skills/cmux-team/manager/layout-restore.ts` | +14 | 案B: broken+surface不在 を discard |
| `skills/cmux-team/manager/daemon.ts` | +56 | 案A: CONDUCTOR_CLEAR 削除分岐（watcher 2連停止含む）+ applyDiscardOnly の conductor_pruned 分離 |
| `skills/cmux-team/manager/i18n.ts` | +4 | clear-conductor help（英日両方） |
| `docs/spec/07-state-machine.md` | +9 | T027 段落 + C-I6 invariant |
| `skills/cmux-team/manager/layout-restore.test.ts` | +83 | 案B の 6 ケース |
| `skills/cmux-team/manager/daemon.test.ts` | +347 | 案A + boot prune + watcher teardown |

※ `package-lock.json` の version bump (0.8.2→0.9.0) は bootstrap の npm install が生成したノイズのため commit 前に revert した。

## observatory 両立

- 現役スロット（surface 実在）の broken は drop しない（T250 の意図を保持）。
- 削除は必ず `conductor_pruned` で log（CLI 起点=`reason=user_clear_surface_missing` pid/alive 付き、boot 起点=`reason=broken_surface_missing`）。silent state mutation なし。

## 検証結果

- `layout-restore.test.ts`: 15 pass / 0 fail
- `daemon.test.ts`: 251 pass / 2 skip / 0 fail
- `bunx tsc --noEmit`: 0 errors
- Inspector 独立検品: **GO**（10項目全 PASS）

## 試行錯誤（crash 対応）

このマシンで 30+ の Claude プロセスが同時稼働しメモリ逼迫しており、Agent が `daemon.test.ts`（253テスト・47秒・大量出力）を agent 内で実行中に **OOM crash（pid_watcher 検出）**する事象が頻発した:

- **Implementer A[200]**: 実装を**完了後**に crash（impl-summary.md 書き込み前）。実装ファイルは全て揃っていたため、Conductor が直接テスト・tsc を実行して検証し、再 spawn せず続行。
- **Inspector A[209]**: 起動 ~78秒で crash（重いテスト実行中の OOM 疑い）。
- **Inspector A[212]（再試行）**: 重い daemon.test.ts の再実行を禁止し Conductor 検証結果を正本採用させる軽量プロンプトで再 spawn → 正常完了・GO 判定。

v0.9.0 では Conductor への spillover 死は発生せず（事象B 解消の効果）、Agent 単体の OOM 死に留まった。

## フェーズ

Plan → Design Review (Approved) → Impl (crash後 Conductor 検証で完遂) → Inspection (GO)。
