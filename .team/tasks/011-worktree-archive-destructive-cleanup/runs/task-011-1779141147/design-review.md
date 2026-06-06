# Design Review: T011 plan.md

## 判定

**Changes Requested**

## サマリー

plan.md は影響箇所の網羅性・データ構造定義・実装順序の妥当性が非常に高い。特に §2.2 で task.md §3 の 4 経路 (task.md 視点) を `resetConductor` の集約点として 5 箇所 + 周辺 (D)(F)(G) の 7 箇所に展開したのは設計上正しい踏み込みで、後方互換 (archiveReason 未指定 → 削除 fallback) の方針も既存 test 影響を最小化するうえで合理的。

ただし `resetConductor` の呼び出し元の**棚卸しが 1 箇所漏れており**（SESSION_CLEAR + running 経路 = `daemon.ts:3034`、user_clear 経路）、これは plan §1 の「正常完了以外は全て archive 化」「進行中タスクの worktree を物理削除しない」という第一ゴールに反する。AC §2「`disconnect_timeout` → broken 経路でも archive される」と同質の経路を見逃した状態で merge すると、user の手動 `/clear` で進捗中の worktree が無言で消える既知バグが残置される。

加えて Major レベルの整合性ズレが 4 件あり (events schema の `archived_at` 欠落、template 条件節の機能不全リスク、WRITE_COMMANDS の UX 劣化、archiveReason 未指定 fallback の事故性)、これらを plan に取り込んでから着手することを推奨する。

## Strengths（良い点）

- **影響箇所の grep ベースの実証** — §2.1 / §2.2 の path:line は (1 箇所の漏れを除き) 実コードと完全一致しており、`conductor.ts:667` を「維持」に分類した判断 (空 worktree のロールバック) も task.md §4 と整合する。
- **`resetConductor` 集約点の発見** — task.md は 4 経路を独立に列挙しているが、plan は (2) `resetConductor` を「disconnect_timeout / abort_task / reset_conductor / clear_conductor / assign_terminal_race / done_unresolved / resume の 7 経路の集約点」として明示し、`archiveReason` 1 個の opt 追加で全経路を一度に変換できる構造を引き当てている。これは「決定論的なものはコードで」(CLAUDE.md) の原則どおり。
- **冪等性・後方互換性の明示** — §5.1 で「worktreePath 不在 / archive 先既存 → throw せず skip + 既存 path return」「`archiveReason` 未指定 → 削除 fallback」と書かれており、reset 呼び出しを並走させる test fixture / 古いシナリオを壊さない。
- **observatory 三層対応** — §4.4 events + §5.1 手順 7-8 (manager.log + emitEvent) + §4.1 `.archive-meta.json` で「WHEN/WHY をどこからでも再構成できる」観察箱原則 (CLAUDE.md) に準拠。
- **R4 `git worktree prune` のタイミング** — `mv` 直後に `prune` を呼ぶことで dangling registration を掃除し、`worktree list` を汚さない解像度を示している。`.git/` がパス参照切れになるが「branch + commit graph は main repo の `.git/` に残る」モデルを R7 で正しく説明。
- **実装順序 (§10)** — Step 1〜3 が独立で並列可能 (events writer / archive lib / template) → Step 4〜8 が `archiveReason` opt 追加に連鎖する依存順、Step 9 が CLI で independent、最後 Step 10 で docs → Step 11 で全テスト。test-first を厳守し、Step 2 で archive lib unit test を pass させてから経路差し替えに進む順序は健全。

## Findings（指摘事項）

### Critical（必須修正、Approved にできない）

- **[C1] `daemon.ts:3034` (SESSION_CLEAR + running + user_clear) 経路の `resetConductor` 呼び出しが §2.2 から漏れている。**
  実コード grep:
  ```
  daemon.ts:1637  CONDUCTOR_CLEAR        (plan §2.2 A) ✅
  daemon.ts:1749  RESET_CONDUCTOR        (plan §2.2 B) ✅
  daemon.ts:1856  ABORT_TASK             (plan §2.2 C) ✅
  daemon.ts:3034  SESSION_CLEAR running  (★ plan に無い) ❌
  daemon.ts:3700  applyAssignCommit      (plan §2.2 D) ✅
  daemon.ts:4415  disconnect_timeout     (plan §2.2 E) ✅
  daemon.ts:4609  handleConductorDone    (plan §2.2 F) ✅
  main.ts:1620    unique_violation       (plan §2.2 G) ✅
  ```
  `daemon.ts:3034` は user が Conductor pane で手動 `/clear` を打った場合の経路で、現状 `targetStatus: "reserved", reason: "user_clear"` を opts に渡している。**この経路は archive 化対象から漏れると、user が手動 `/clear` した瞬間に進行中タスクの worktree (uncommitted 変更を含む) が物理削除される**。これはまさに本タスクが解消すべき「`reset-conductor` / `clear-conductor` (recovery 系) でも問答無用に消える」(task.md §背景) と同質の症状であり、AC「正常 CONDUCTOR_DONE 以外は archive される」を満たさない。
  
  対処:
  - §2.2 表に `H | daemon.ts:3034 | SESSION_CLEAR running (user manual /clear) | "user_clear" → archiveReason="user_clear"` 行を追加
  - §4.3 reason enum に `user_clear` を追加 (`abort_task` と並ぶ user-initiated 系として)
  - §4.4 events schema の `reason` union にも `"user_clear"` を追加
  - §6.1 daemon.ts:3034 の resetConductor 呼び出しに `archiveReason: "user_clear"` を付与する before/after を書く
  - §9.4 integration test に 8 ケース目「SESSION_CLEAR running 経路で archive される (reason=user_clear)」を追加
  - §12 AC 対応表で「`elevens reset-conductor` / `clear-conductor`」の行が手動 `/clear` 経路もカバーするよう明示

### Major（強く推奨、Approved 可だが対応すべき）

- **[M1] `events.jsonl` の `worktree_archived` event schema に `archived_at` フィールドが欠落しており、task.md §8 と乖離。**
  task.md §8 の仕様例 (task.md:146) には `"archived_at": "..."` が含まれるが、plan §4.4 の TypeScript union には `archived_at` が無い。events-writer.ts:214 を見ると `ts` (`schema_version` と同時に自動付与) は writer 側で attach するため、`ts` を `archived_at` 代替として運用することは可能だが、`archived_at` は **`.archive-meta.json` の `archived_at` と等値である必要のあるドメイン値** であり、`ts` (write 時刻) と概念分離した方が retrospective 分析の精度が上がる (mv 完了時刻 vs writer flush 時刻のズレ)。
  
  対処: §4.4 schema に `archived_at: string;` を追加し、`emitEvent` 引数に meta.json と同じ ISO 文字列を渡すよう §5.1 手順 8 を補足する。
  
- **[M2] `{{ARCHIVED_WORKTREE_PATH}}` の条件節を「空文字置換 + Conductor の読み飛ばし判断」に委ねる設計は機能不全リスクが高い。**
  §7.1 template は `cd {{ARCHIVED_WORKTREE_PATH}}` という具体的なコマンドラインを含む。archive 不在時に空文字に置換すると、Conductor の prompt には:
  ```
  1. `cd ` で前回作業を確認
  ```
  という不完全コマンドが残り、`{{ARCHIVED_WORKTREE_PATH}} が空でなければ` の条件節を読み飛ばさずに実行する Conductor (新規 sub-agent ほど起こりやすい) が `cd `（カレント維持）→ `cat .archive-meta.json` (絶対パスなし、worktreeルートの相対) という想定外の挙動に走る可能性がある。これは特に sub-agent prompt の「指示は順番に実行する」訓練と相性が悪い。
  
  対処案 (どちらでも可、plan の最終 R&D 時点で選択):
  1. `templates/ja/conductor-task.md` で archive セクション全体を `{{ARCHIVED_WORKTREE_SECTION}}` 1 個の placeholder にまとめ、`generateConductorTaskPrompt` 側で archive 有無に応じて section block を組み立てる (有: §7.1 の文面 / 無: 空文字)。これなら `{{#if}}` 風 syntax は不要で、`docs/spec/04-templates.md` に 1 placeholder 追加で済む。
  2. archive 不在時の文面は「(該当なし: 前回 attempt は無い)」のように人間にも sub-agent にも明示的な no-op テキストにする (現状の「空文字 + 条件節」より安全)。

- **[M3] `WRITE_COMMANDS` で `worktree: true` (全 subcommand write 扱い) は list/show 経路の UX を不必要に毀損する。**
  §2.3 / §11 R8 で plan 自身が認めている通り、`worktree archive list` / `show` は read 操作だが、`worktree: true` で登録すると `--project-root` と cwd 不一致時に `runWriteGate` が発火し、user 対話 prompt が出る。これは oncall が cwd 外から archive を確認したい場合 (まさに本タスクの大事な user story) に逆効果。
  既存パターン `artifacts: new Set(["add"])` / `epic: new Set(["create", "resume", "abort"])` (main.ts:316-318) を踏襲し、 sub-sub command を `archive-remove` / `archive-prune` のように **flat に展開** すれば 2 階層 dispatcher のまま write 限定が可能:
  ```ts
  worktree: new Set(["archive-remove", "archive-prune"]),
  ```
  この場合、コマンド受け側 (dispatcher) では `args[1] === "archive" && args[2] === "remove"` を `worktree archive-remove` と等価に扱うアダプタ層を入れるか、もしくは `isWriteCommand(command, args[1] + "-" + args[2])` のように subCmd を組み立てる。後者は既存契約に最小侵襲。
  
  代替案 (plan §11 R8 の current design の維持): list/show を WRITE_COMMANDS 外に置きたい強い動機があるなら、3 階層に拡張するよりも先に「`worktree archive list` を `worktree-archive list` のような hyphen-joined command に rename」も検討に値する (既存 dispatcher と整合)。**少なくとも「全 subcommand write 扱い」は採用すべきでない。**

- **[M4] `archiveReason` 未指定で削除 fallback する後方互換設計は、新規 reset 呼び出し追加時の事故源になりやすい。**
  §13 で「reviewer が git diff で禁止チェックすること」と書かれているが、これは構造的防御ではなく社会的契約。CLAUDE.md「**逸脱を防ぐより、逸脱しても安全な構造にする**」「**構造的正しさを優先**」の原則に照らすと、型レベルで「archive する／明示的に削除する」を必ず選ばせる設計が望ましい:
  ```ts
  archiveReason: ArchiveReason | { skipArchive: true; reason: string };
  ```
  あるいは:
  ```ts
  cleanupMode: { kind: "delete"; reason: string } | { kind: "archive"; reason: ArchiveReason };
  ```
  `cleanupMode` が optional のままだと undefined → 既存挙動 (削除) で test 互換は取れるが、新規呼び出しを追加する開発者が必ず一方を選ばざるを得ない設計のほうが長期的に安全。
  
  この変更を §10 Step 4 (resetConductor opts 拡張) と一緒に入れるのが最小コスト。後方互換が必要なら一時的に default を `{ kind: "delete", reason: "legacy_fallback" }` にして移行期間を設けてもよい (Phase 2 で外す)。

### Minor（参考、対応任意）

- **[m1] `generateConductorTaskPrompt` の positional 引数が 10 個に膨らむ。** §7.2 で `archivedWorktreePath: string = ""` を 10 番目 positional として追加する設計。引数順の取り違いリスクが上がる。options object 化 (`(projectRoot, taskRunId, opts: {...})`) で readability を上げる選択肢を §10 Step 3 で検討するか、最低限 [M2] と一緒に section block placeholder への一本化を採用すれば引数は 9 個のまま (placeholder 文字列だけが変わる)。
- **[m2] `archive 先既存` の意味整合。** §11 R1 では「`taskRunId` unique のため発生不可」と書いているが、§5.1 では「target_exists → skip + 既存 path return」と冪等性を主張。R1 を「念のため target_exists を skip するが、規約上発生しない」と書き直して矛盾を解消するのが読み手に親切。
- **[m3] `prune` の `deleteBranches?: boolean` default が false。** branch を残し続けると 30d 経過後の archive を prune しても branch ref がリポジトリに残存 → `git branch --merged` のノイズが累積する。retention 自動化 Phase 2 と合わせて branch 削除戦略を仕様書 §11 (retention) に書き込むと良い。
- **[m4] §9.4 integration test の test 経路が 7 件。** §2.2 の 7 経路 (A〜G) + [C1] で挙げた SESSION_CLEAR 経路 = 8 経路に増えるはずなので、integration test ケースも 8 + 2 regression = 10 件構成にする (test 番号体系を `archive-経路名` で揃えるとレビュー時の AC マッピングが楽)。
- **[m5] CLI 名 `elevens` vs `cmux-team`。** plan §1 / task.md は `elevens worktree archive list` だが、現状 main.ts dispatcher の sibling commands (`abort-task`, `restart-task`) は `cmux-team` バイナリでも `elevens` ラッパでも到達する設計のはず。新規 CLI を入れる際に bin/ レイアウトの差分 (もしあれば) を `docs/spec/16-worktree-archive.md` の CLI 章で 1 行明記しておくと、user が `cmux-team worktree archive ...` と `elevens worktree archive ...` のどちらでも動くことが伝わる。
- **[m6] `findArchivesForTaskId` の壊れた meta 読み込み skip + warn ログ (§5.2)。** ログ event 名が plan に記載されていない。`archive_meta_unreadable` / `archive_meta_invalid` などの命名を §5.2 に明記し、retrospective grep の鍵に揃える (observatory 原則)。
- **[m7] `.team/worktrees-archive/` への直接 write が hook ブロック対象になっていないか確認。** CLAUDE.md「`.team/tasks/` への直接ファイル書き込みは hook でブロックされる」とあるが、`.team/artifacts/` のように特例パスもある。`archiveWorktree` は manager daemon 内から `mv` するので skill 経由 CLI hook の対象外で問題ないはずだが、§8.x の spec 内に「`.team/worktrees-archive/` は daemon 専有領域 (CLI 経由でのみ操作)」と明記しておくと user/agent が誤って手書きしないルートが閉じる。
- **[m8] `WRITE_COMMANDS` 登録時の test。** §9.6 で「`--project-root-confirm` なしで write は CWD 外で reject される」を test 化する記述あり。これは cli-project-root.test.ts に既存パターンがあるはずなので、そこに追加する形で揃えると test 場所が自然。
- **[m9] `pruneArchives` の dryRun と `--yes` の関係。** §5.5 CLI 表で `prune --older-than ... [--dry-run] [--yes]` と書かれているが、dry-run と yes の併用挙動 (dry-run が優先 / yes が override) を CLI helper の本文か spec §9 で明示する。
- **[m10] §11 R5 既存 test fixture 影響。** archive 経路を test するときに `existsSync(conductor.worktreePath) === false` を assert している既存 test は変わらず通るが、「worktreePath が `.team/worktrees-archive/...` に移動した」ことを 追加で assert したい test を §9.4 で網羅すること。

## Recommendations（具体的な修正案）

- **§2.2 の表に SESSION_CLEAR running 経路 (`daemon.ts:3034`, reason=`user_clear`) を追加し、§4.3 reason enum / §4.4 event reason union / §6.1 before-after diff / §9.4 integration test に展開する** (C1 の対処)。
- **§4.4 events schema に `archived_at: string` を追加し、§5.1 手順 8 で meta.json と同じ ISO 文字列を `emitEvent` に渡すことを明記** (M1 の対処)。
- **§7.1 で archive 通知部分を section-block placeholder (`{{ARCHIVED_WORKTREE_SECTION}}` 等) にまとめる**、または archive 不在時の文面を「(該当なし)」等の明示的 no-op テキストに置き換える設計に変更し、§7.2 / §7.4 / `docs/spec/04-templates.md` 追記を更新 (M2 の対処)。
- **§2.3 / §11 R8 を「`worktree: new Set(["archive-remove", "archive-prune"])`」案に差し替える**。`isWriteCommand` 呼び出し側で `args[1] + "-" + args[2]` を subCmd として扱うアダプタを 1 行追加 (M3 の対処)。
- **§5.1 `ArchiveWorktreeOpts` と `ResetConductorOpts` を「archive する／明示的に削除する」を必ず選ばせる discriminated union に変更**。中間期間として default を `{ kind: "delete", reason: "legacy_fallback" }` に置けば既存 test を破壊しない (M4 の対処、§10 Step 4 と同時)。
- **§9.4 の integration test ケースを 7 → 8 + 2 regression = 10 件に増やし、test 番号体系を `archive-disconnect_timeout` / `archive-abort_task` / `archive-user_clear` / ... のように `archive-<reason>` で揃える** (m4 + C1 + AC マッピング容易化)。
- **§5.2 で `findArchivesForTaskId` が壊れた meta を skip する際の warn ログ event 名 (`archive_meta_unreadable` / `archive_meta_invalid` 等) を明記する** (m6)。
- **§8.1 章構成 (13 章) に「retention」「branch 削除戦略」「`.team/worktrees-archive/` の write 経路規約」を含めることを明記** (m3 + m7)。retention は Phase 2 とはいえ「Phase 1 の操作と Phase 2 の自動化の境界」を spec に書いておくと運用時に迷わない。
- **§13 Implementer 向け補足の「git diff で禁止チェック」を、M4 を取り込めば「archive vs delete の選択が型強制されている」に書き換える** (M4 とセット)。
