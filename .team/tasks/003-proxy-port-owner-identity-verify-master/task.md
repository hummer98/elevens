---
id: 003
title: proxy port 再利用時の owner identity verify (静かな master 未登録事故の防止)
priority: high
created_by: surface:128
created_at: 2026-05-10T04:55:39.550Z
---

## タスク
## 背景

`elevens start` が proxy port (デフォルト 60372) を「proxy_reused」と判定して再利用するロジックは、**その port を listen しているプロセスが本当に自分のプロジェクトの proxy か** を verify していない。

その結果、別プロジェクト (例: 旧 cmux-team repo / 別 path の elevens) の daemon が同じ port を孤児として握り続けている場合、こちらの新 daemon は「再利用」したつもりで全 POST を**他プロジェクトの daemon に流してしまう**。

特に `MASTER_REGISTERED` / `CONDUCTOR_REGISTERED` POST が失われると:
- `registerSelf` は HTTP 200 を受け取るので fail-fast に引っかからず `master_self_register` ログまで到達する
- しかし新 daemon の `state.masters` は空のまま、`team.json` の `masters: []` も空のまま
- ユーザーから見ると Master を spawn したのに登録されない**静かな失敗**になり、原因特定に時間がかかる

実例: 2026-05-10 に `/Users/yamamoto/git/cmux-team` (リネーム前 repo) の daemon (PID 39221, 2日5時間稼働) が port 60372 を握ったまま放置されており、`/Users/yamamoto/git/elevens` の daemon (PID 67460) が `proxy_reused port=60372` と判定 → Master U[124] の登録 POST が旧 daemon へ流れて消失した。再現ログは `.team/logs/manager.log` の 2026-05-10T13:24:27〜13:25:27 付近を参照。

## 実装内容

### 1. proxy に \`GET /api/identify\` を追加

\`skills/cmux-team/manager/proxy.ts\` に identify エンドポイントを追加し、以下を返す:

\`\`\`json
{
  \"project_root\": \"/Users/.../elevens\",
  \"daemon_pid\": 8978,
  \"version\": \"0.4.1\",
  \"started_at\": \"2026-05-10T13:31:14+09:00\"
}
\`\`\`

\`project_root\` は proxy 起動時に握っている daemon の cwd / \`state.projectRoot\` から取得する。

### 2. proxy_reused 判定の前に identify verify を必須化

\`main.ts\` の daemon boot path で \`proxy_reused\` ログを出している箇所を探し、再利用判定の手前に以下を入れる:

- 既存 \`.team/proxy-port\` を読む
- そこに書かれた port に対して \`GET /api/identify\` を timeout 付きで叩く
- レスポンスが取れなかった (proxy 死亡) → proxy-port を捨てて新規 spawn
- \`project_root\` が現プロジェクト (daemon の \`state.projectRoot\`) と一致しない → **proxy_reused を諦め、新しい port で proxy を起動**。\`proxy_owner_mismatch\` を warn ログに出す (旧 owner の path / pid を含める)
- 一致 → 通常通り再利用

### 3. registerSelf 側の cross-check (防御深度)

\`MASTER_REGISTERED\` / \`CONDUCTOR_REGISTERED\` の HTTP レスポンスに daemon pid を含めて返す (\`{ ok: true, daemon_pid: <pid> }\`)。

\`registerSelf\` (main.ts L1997 付近) はレスポンスから daemon_pid を取り出し、\`team.json\` の \`manager.pid\` と照合する。不一致なら fail-fast (exit 1) してエラーメッセージで「proxy が他プロジェクトの daemon に転送している可能性。\`.team/proxy-port\` を削除して \`elevens start\` をやり直してください」と案内する。

team.json がまだ書かれていない初回起動順序の場合 (registerSelf が先着) に false positive を出さないよう、team.json 不在 / manager.pid 未設定なら skip する。

### 4. テスト

\`skills/cmux-team/manager/\` 配下にテストを追加:

- ケース A: 別 project_root を返す偽 proxy を別 port で立てて \`.team/proxy-port\` にその port を書き、daemon を起動 → \`proxy_owner_mismatch\` ログが出て**新 port で proxy_started** されること
- ケース B: \`.team/proxy-port\` の port が誰も listen していない (proxy 死亡) → fallback で新 port で proxy_started されること
- ケース C: 同一 project_root を返す proxy なら通常通り \`proxy_reused\` されること
- ケース D: registerSelf cross-check — daemon pid 不一致を返す proxy に POST → registerSelf が exit 1

## 触るファイル (調査範囲)

- \`skills/cmux-team/manager/proxy.ts\` — identify エンドポイント追加、レスポンス整形
- \`skills/cmux-team/manager/main.ts\` — proxy_reused 判定箇所 / \`registerSelf\` の cross-check 追加
- \`skills/cmux-team/manager/daemon.ts\` — \`MASTER_REGISTERED\` / \`CONDUCTOR_REGISTERED\` ハンドラのレスポンスに daemon pid を載せる箇所
- 新規テストファイル

## 注意

- \`bun test\` 全体実行は禁忌 (CLAUDE.md 参照)。touched ファイル単位で \`bun test --timeout 30000 <file>\` を実行すること
- proxy_reused / proxy_started を判定する箇所は cmux-team 由来のため、設計に違和感があれば \`docs/spec/\` 該当章 (boot path / 05-install-and-infrastructure.md 周辺) を確認・更新する
- 旧 cmux-team package との互換は不要 (npm 上で消滅予定)。本タスクは elevens 同士の別 repo 並走シナリオも防ぐ汎用 fix が目的
