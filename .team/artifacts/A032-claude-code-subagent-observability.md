---
id: A032
type: research
title: "Claude Code Task tool subagent の observability 実証"
created: 2026-05-10T06:38:00+09:00
author: surface:71325200-4BDC-4440-AD84-AF84699B6256
tags: [subagent, metrics, observability, claude-code, hybrid-spawn]
---

# Claude Code Task tool subagent の observability 実証

## 背景

elevens は現状 **spawn-agent** 方式（独立 claude プロセスを c11 pane に立てて Conductor から制御）で 4 層オーケストレーションを実装している。c11 v2.1.x で Claude Code subagent 一覧が footer/sidebar から気軽に見えるようになったため、**全タスクを Task tool subagent に一本化できないか** が議題になった。

事前検討（claude-code-guide による机上調査）では「subagent は親と同じ `session_id` を共有し、transcript が interleave されるためメトリクス粒度が劣化する」という結論が出ていた。本実証は実機 (Claude Code v2.1.138 / c11 / opus) でこの仮説を検証することが目的。

## 調査結果

### 環境

- 親 claude session: `8d4fd5cc-a092-486d-8652-2ba4743b1d71` (本会話)
- c11 surface 内、`CMUX_CLAUDE_HOOKS_DISABLED=1`（c11 wrapper の hook 注入なし）
- general-purpose subagent を Task tool で 1 個 spawn → self-introspection を bash で実行

### 1. subagent の env / process では識別不能

subagent から `env` / `ps` を確認:

- `CLAUDE_CODE_SESSION_ID` は親と完全同一
- `subagent_id` / `agent_id` / `parent_session_id` 系の env は **存在しない**
- subagent の bash は親 claude プロセス (PID 87188) の **直接の子**。中間に独立 claude プロセスは介在しない → **in-process 駆動**

つまり subagent が「実行中の自分の identity」を bash 経由で知る手段はない。

### 2. transcript はファイル分離されている (重要発見)

`~/.claude/projects/-Users-yamamoto-git-elevens/` の実レイアウト:

```
├── 8d4fd5cc-...-2ba4743b1d71.jsonl              # 親 transcript (1 ファイル)
└── 8d4fd5cc-...-2ba4743b1d71/                   # 親 session ディレクトリ
    ├── subagents/
    │   ├── agent-a2f7e369ffa9dfe7d.jsonl        # subagent ごとに独立 JSONL
    │   ├── agent-a2f7e369ffa9dfe7d.meta.json
    │   ├── agent-a05d24880d97341a3.jsonl
    │   └── agent-a05d24880d97341a3.meta.json
    └── tool-results/toolu_*.txt                  # 大型 tool 出力スピル
```

**ファイル名に agent_id が直接乗る**。

### 3. meta.json の中身

```json
{
  "agentType": "general-purpose",
  "description": "Subagent self-introspection 実証"
}
```

→ subagent の役割（cohort 軸）が外部から取得可能。

### 4. subagent JSONL レコード構造

最初の user message のフィールド:

```
agentId        : "a2f7e369ffa9dfe7d"      # ★ 各レコードに agent_id が直接乗る
isSidechain    : true                       # ★ 親 main chain と区別するフラグ
sessionId      : "8d4fd5cc-...-2ba4743b1d71"  # 親と同一（共有）
parentUuid     : null                       # subagent 起点
promptId       : "ae8d16f4-57d8-..."
type           : "user"
cwd            : "/Users/yamamoto/git/elevens"
gitBranch      : "main"
version        : "2.1.138"
timestamp      : "2026-05-09T21:37:49.096Z"
```

### 5. token 消費

assistant message に `message.usage.input_tokens` / `output_tokens` が記録される。本実証では `in=6, out=555`。**subagent 単位で token 消費を分離計測可能**。

### 6. SubagentStart / SubagentStop hook

本実証では `CMUX_CLAUDE_HOOKS_DISABLED=1` のため未検証。事前調査では:

- `SubagentStart` / `SubagentStop` hook は実在
- payload に `agent_id` を含む
- `PreToolUse` / `PostToolUse` に agent_id が乗るかは未確認 (要追試)

## 比較・分析

事前仮説と実態の差分:

| 観測項目 | 事前仮説 | 実態 |
|---|---|---|
| transcript の interleave | 親と同一ファイルに混在 | **subagent ごとに独立 JSONL** |
| agent_id の取得手段 | hook payload のみ | ファイル名 + meta.json + JSONL レコードの 3 重 |
| token 集計の粒度 | 親に集約され分離不能 | `message.usage` を agentId で集計可能 |
| cohort 軸 (subagent type) | 取得困難 | `meta.json.agentType` で取れる |
| 並列 subagent の分離 | interleave 順序の解析必要 | ファイル単位で完全分離 |

事前仮説のうち **transcript interleave と粒度劣化は誤り**。実機では `agentId` がファイル/メタ/レコードに三重で記録され、JSONL transcript の tail/sweep だけで完全な subagent observability rail が構築できる。OTel rail を立てる必要すらない。

elevens の現行 trace DB (`hook_signals` / `api_usage` / `task_sessions`) に `agentId` 列を追加し、`~/.claude/projects/<...>/subagents/` を data source に組み込めば、subagent 単位の cohort 比較・統計検定が成立する。

メトリクス劣化を理由に subagent 一本化を退ける根拠は失われた。判断軸は以下に絞られる:

| 観点 | spawn-agent (現行) | subagent (Task tool) |
|---|---|---|
| metrics 観測性 | ◎ session 別 | ◎ agent_id 別 (ファイル分離) |
| token pool 分散 | ◎ Agent ごとに別 token | △ 親 session に集中 |
| 耐障害性 | ◎ 独立 PID + worktree 隔離 | △ 親プロセスと運命共同体 |
| spatial 観察 (32-inch 並列) | ◎ pane 並置 | △ /agents UI 切替 |
| real-time UX | ○ pane 切替 | ◎ footer/sidebar 即可視 |

## 結論

1. **subagent でも observability は完全に成立する**。ファイル分離 + `agentId` フィールドで `agent_id` 単位の trace 集計・cohort 分析が可能。
2. 残る判断軸は **token pool 分散・耐障害性・spatial 観察**。これらが必要なワークロード（重い実装、長時間タスク、並列観察対象）には spawn-agent を維持すべき。
3. **Hybrid 方針**: 軽量 / 短命 / 観察対象でないタスク（review, scout, summary, /artifact 要約）は subagent、重い / 並列観察対象は spawn-agent に振り分ける。

### next action 候補

- `subagents/agent-*.jsonl` を tail-based に trace DB へ sink する POC
- `SubagentStart` / `SubagentStop` hook の追試 (`CMUX_CLAUDE_HOOKS_DISABLED=1` 解除環境)
- `docs/spec/11-metrics.md` の data source 一覧に `~/.claude/projects/<...>/subagents/` を追加
- task 属性に `runtime: subagent | spawn-agent` を加えて Hybrid 分岐できるよう拡張 (Phase 4 候補)

### 参考

- 関連: A002-claude-code-hook-events.md
- 実機観察 path: `~/.claude/projects/-Users-yamamoto-git-elevens/8d4fd5cc-.../subagents/`
- [GitHub anthropics/claude-code Issue #7881](https://github.com/anthropics/claude-code/issues/7881) — `agent_id` 周りの議論
