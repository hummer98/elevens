---
id: 006
title: artifact 追加を events stream に emit
priority: medium
created_by: surface:267
created_at: 2026-05-11T23:12:41.428Z
---

## タスク
## 背景

`elevens artifacts add` / `/elevens:artifact` でアーティファクトを追加しても、events stream (`.team/logs/events.jsonl`) にも task の journal にも痕跡が残らない。`addArtifact()` (`skills/cmux-team/manager/artifact.ts:170`) はファイルを書くだけで何も emit していない。

結果として:
- Web Dashboard で「いつ・どのタスクからアーティファクトが生まれたか」を時系列で追えない
- `/elevens:watch` から artifact 作成イベントを拾えない
- retro / trace-task で artifact 生成の文脈を再構成できない（git log を別途見るしかない）

## 変更内容（Phase 1: events stream への emit のみ）

### 1. event 型を追加

`skills/cmux-team/manager/events-writer.ts` の `EventName` union に新規 variant を追加:

```ts
| {
    event: "artifact_added";
    artifact_id: string;          // 例: "A045"
    artifact_path: string;        // .team/artifacts/A045-xxx.md（projectRoot 相対）
    artifact_type: string;        // research / decision / session / spec / report
    title: string;
    author: string;               // surface ID（例: surface:100）
    task_id?: string;             // フロントマター `task:` がある場合のみ
  }
```

### 2. emit 呼び出しを差し込む

`skills/cmux-team/manager/artifact.ts::addArtifact()` の末尾（unlink 後・return 前）で events-writer の append 関数を呼ぶ。

- `addArtifact` は現在 events-writer を import していないので、依存を増やす必要あり
- artifact.ts は CLI から直接呼ばれる（daemon プロセス外）ので、events-writer の append 関数が daemon 外からも安全に書ける形になっているか先に確認すること（`.team/logs/events.jsonl` への append-only write が前提なら問題ないはず）

### 3. ドキュメント更新

- `docs/spec/10-events-stream.md` の event 型一覧に `artifact_added` を追加
- `CLAUDE.md` の Artifacts 節は変更不要（events 経路で拾える旨は spec 側に集約）

### 4. テスト

- `events-writer.test.ts` 相当に `artifact_added` の round-trip テストを追加
- `artifact.test.ts` で `addArtifact()` 呼び出し後に events.jsonl に該当行が出ることを確認

## 範囲外（別タスクで検討）

- **Phase 2: task journal への追記** — フロントマター `task:` が付いている artifact について、対象 task の journal に "artifact added: A045 …" を `update-task --journal` 経由で追記する。`addArtifact` から CLI を spawn する/library API を呼ぶ設計の選択肢があるので、必要性が出てから別タスクで設計
- Dashboard UI 側で artifact イベントを表示する変更
- `/elevens:watch` skill 側で artifact_added を処理する変更（自動的に拾えるはずだが、表示有無は別途検討）

## 確認手順

1. `cd skills/cmux-team/manager && bun test --timeout 30000 events-writer.test.ts artifact.test.ts`
2. 実機で `elevens artifacts add some.md` を実行 → `elevens events --types artifact_added` で 1 行出ることを確認
3. `elevens artifacts add` の `--task <id>` 指定時に event 内の `task_id` が入っていることを確認

## 参考

Master ↔ ユーザー会話で「artifact 追加が journal に残らないなら、events stream に流したい」と合意（dashboard / retro / watch で拾うのが目的）。
