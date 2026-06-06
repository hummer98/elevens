# Impl Summary: T024 — spawn-agent の silent state mutation 解消

## 結論

plan.md §3.1 の主成果物（`cmdSpawnAgent` への決定論的 log 2 件追加）を実装した。スコープ外項目（cmux.ts / daemon.ts / events.jsonl / spec / 新規テスト）は plan のとおり一切触っていない。design-review.md の任意指摘 #2（採用推奨）を 1 行コメントで反映し、#1 / #3 / #4 は現案維持とした。

## 変更ファイル

- `skills/cmux-team/manager/main.ts`（log 2 件追加 + コメント）

それ以外のファイルは変更なし。

## 追加した log（最終 event 名・detail）

### 変更点 A: `spawn_agent_pane_resolved`

挿入位置: `getPaneForSurface` 直後・`if (!targetPane)` の **前**（実機で L3577 の `const targetPane = ...` 直後）。

```ts
// T024: pane lookup 結果を決定論的に記録する。pane lookup 失敗時は本 log →
//   throw → catch の spawn_agent_failed の 2 行ペアになる設計。本 log を
//   `if (!targetPane)` の後ろに動かすと target_pane=(none) のケースを残せなく
//   なるため、必ず if 判定より前に置くこと。
await log(
  "spawn_agent_pane_resolved",
  `${formatSurface(conductorSurface, "C")} target_pane=${targetPane ?? "(none)"} caller_workspace=${callerWorkspace ?? "(none)"} role=${role}`,
);
```

- design-review §1 任意指摘 #2 を 4 行コメントで反映（regression 防止）。
- 失敗時は `target_pane=(none)` を残してから throw → catch の `spawn_agent_failed` が続く 2 行ペアになる。

### 変更点 B: `spawn_agent_surface_created`

挿入位置: `newSurface` 直後・`const surface = createdSurface;` の **後**（実機で L3590 直後）。

```ts
// T024: new-surface 生成結果を決定論的に記録する。CLI 側で「どの pane に
//   どの surface を生やしたか」を spawn 時点で残し、後段 (postMessage) で
//   daemon が記録する agent_spawned (daemon.ts) と pair で読めるようにする。
await log(
  "spawn_agent_surface_created",
  `${formatSurface(createdSurface, "A")} target_pane=${targetPane} conductor=${conductorSurface} role=${role} caller_workspace=${callerWorkspace ?? "(none)"}`,
);
```

- `conductor=${conductorSurface}` は plan §3.1 / design-review §1 任意指摘 #1 に従い plain string 表記を維持（既存 L1641 等のパターンと整合）。

## 実機確認した位置・引数名

- `getPaneForSurface` 呼び出し: worktree 着手時点で L3575、引数 `(conductorSurface, callerWorkspace)`。
- `newSurface` 呼び出し: L3589、引数 `(targetPane, { workspace: callerWorkspace })`。代入先 `createdSurface`、続く `const surface = createdSurface;` が L3590。
- 引数名（`conductorSurface` / `callerWorkspace` / `targetPane` / `createdSurface` / `role`）はすべて plan / review 記述と完全一致。
- `log()` シグネチャ `(event: string, detail: string)` / `formatSurface(surface, role)` 利用は既存 `spawn_agent_failed`（L3831-3834）に揃えた。`formatSurface` は L36 で既に import 済み。

## テスト結果

CLAUDE.md「`bun test` 全体実行は禁忌」に従い per-file 指定。

| テスト | 結果 |
|---|---|
| `cmux.test.ts` | **38 pass / 0 fail**（63 expect、6.30s） |
| `main.test.ts` | **273 pass / 0 fail**（748 expect、22.21s） |
| `state-machine/*.test.ts`（3 file） | 全 file pass（15 / 191 / 44 tests、計 0 fail、528 expect） |

新規 log の unit test 追加は plan §5.2 の判断（テスト負債 > 検知価値）に従い見送り。`cmux.test.ts` の prefix collision regression 新規追加も plan §5.1 default に従い見送り。

## tsc 型チェック

`bunx tsc --noEmit -p skills/cmux-team/manager` を worktree 側と main repo 側の双方で実行して比較:

| 環境 | main.ts エラー件数 |
|---|---|
| worktree（本変更含む） | 1 件（`main.ts(1043,7) TS2322`） |
| main repo（baseline） | 1 件（同 `main.ts(1043,7) TS2322`） |

→ 自分の変更で main.ts のエラーは増えていない（既存エラー 1 件のみ）。

## plan からの逸脱

なし。plan §3.1 / design-review §1〜§5 の指針どおり実装し、§3.2（cmux.ts / daemon.ts / events-writer.ts / logger.ts 無変更）も遵守。

## 完了条件チェック

- [x] §6.1-1 相当: 変更点 A / B の log 2 件が `cmdSpawnAgent` に入っている（実機 Read で位置・引数名確認済み）
- [x] §6.1-2: cmux.test.ts / main.test.ts / state-machine/*.test.ts が全 pass
- [x] §6.1-3: tsc で main.ts 関連の新規エラーは増えていない
- [x] 実装サマリー（本ファイル）を runs/task-024-1779579435/ に書き出し

## 未消化（plan §6.1-1 実機 grep 検証 / §6.2 release）

`.team/logs/manager.log` への新 log 2 行の実機出力確認（plan §6.1-1）は、本タスクの worktree からの daemon 再起動と spawn-agent 実行を伴うため implementer 着手範囲外と判断。Conductor / Master 側の close 経路で `cmux-team spawn-agent` を 1 回流して `grep -E "spawn_agent_pane_resolved|spawn_agent_surface_created" .team/logs/manager.log` を確認すれば足る（次回 spawn-agent 時に自然に検証される）。plan §6.2 の patch release は別タスクとして任せる。

## 事象A follow-up

plan §7.3 に従い follow-up task の事前起票は行わない。T024 fix を含む版で再現観察 → 出れば §7.1 仮説 H1〜H4 を参照して新規 task を起こす方針。
