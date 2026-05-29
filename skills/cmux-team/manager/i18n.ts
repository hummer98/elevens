/**
 * i18n — 国際化サポート
 *
 * 言語検出優先順位: CMUX_TEAM_LANG > LC_ALL > LC_MESSAGES > LANG
 * デフォルト: 英語 (en)
 */

export type Locale = "ja" | "en";

function detectLocale(): Locale {
  const envVars = [
    process.env.CMUX_TEAM_LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const v of envVars) {
    if (v?.startsWith("ja")) return "ja";
  }
  return "en";
}

export const locale: Locale = detectLocale();

// --- メッセージ定義 ---

const en = {
  // ── T247: project-local agent instructions overlay ─────────────────────────
  /** `{{PROJECT_INSTRUCTIONS}}` 展開時に overlay 本文の先頭に付ける見出し文字列 */
  project_instructions_heading: "Project-Specific Instructions",
  /** `{{PROJECT_COMMON_INSTRUCTIONS}}` 展開時に overlay 本文の先頭に付ける見出し（T413） */
  project_common_instructions_heading: "Project Common Instructions",

  // ── エラー・ステータスメッセージ ──────────────────────────────────────────────
  not_in_cmux:
    "❌ Not running in a cmux session. Please run this command inside cmux.",
  daemon_not_running:
    "Error: daemon is not running (proxy-port file not found)",
  team_not_started_start: "Team not started. Run `start` to initialize.",
  team_not_started: "Team not started.",
  no_running_agents: "No running agents.",
  no_artifacts: "No artifacts found.",
  artifact_id_required:
    "Error: artifact ID is required\nUsage: elevens artifacts show <id>",
  artifact_id_required_open:
    "Error: artifact ID is required\nUsage: elevens artifacts open <id>",
  search_query_required:
    "Error: search query is required\nUsage: elevens artifacts search <query>",
  artifact_add_file_required:
    "Error: file path is required\nUsage: elevens artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]",
  dashboard_startup_hint:
    "Hint: Run 'elevens start' in a TTY environment",
  task_section_header: "Task",

  // ── テンプレートメッセージ（tf() で変数展開） ────────────────────────────────
  artifact_not_found: "Artifact {id} not found",
  no_artifacts_matching: 'No artifacts matching "{query}"',
  artifact_add_file_not_found: "Error: file not found: {path}",
  artifact_added: "Added {id} → {path}",
  dashboard_startup_failed: "❌ Dashboard startup failed: {message}",
  abort_journal_default: "Aborted: T{id} {title}",
  restart_journal_default: "Restarted: T{id} {title}",
  delete_journal_default: "Deleted: T{id} {title}",

  // ── テンプレートエラーメッセージ ──────────────────────────────────────────────
  template_dir_not_found:
    "Template directory not found. Please run: npm install -g @hummer98/elevens",
  conductor_role_template_not_found:
    "Conductor role template not found. Please run: npm install -g @hummer98/elevens",
  conductor_task_template_not_found:
    "Conductor task template not found. Please run: npm install -g @hummer98/elevens",

  // ── e2e.ts ────────────────────────────────────────────────────────────────────
  e2e_daemon_not_confirmed:
    "  WARNING: daemon startup not confirmed. Continuing tests.",
  e2e_master_not_found:
    "  WARNING: Master surface not found (Master spawn may have failed)",
  e2e_team_json_failed: "  WARNING: team.json read failed: {message}",
  e2e_scenario1_title: "  Running 3 tasks with chained dependencies:",
  e2e_scenario1_tasks: "  Task 1 (research) → Task 2 (design) → Task 3 (impl)\n",

  // ── ヘルプテキスト ────────────────────────────────────────────────────────────
  /**
   * Task 440: 全 help_<cmd> の末尾に showHelp() で append される共通オプション。
   * read 系・write 系で同じ文字列を使い、`--project-root-confirm` は write 系コマンドで
   * のみ有効である旨を文中に明示する。
   */
  help_common_options: `Common options:
  --project-root <path>      override project root (read by default; writes require confirmation)
  --project-root-confirm     bypass cross-project write gate (write commands only;
                             also: CMUX_TEAM_PROJECT_ROOT_CONFIRM=1 env)`,

  help_start: `
elevens start -- launch daemon + spawn Master + show dashboard

Usage:
  elevens start [--layout=<wide|16x9>] [--sleep-prevention=<off|idle|aggressive>] [--no-sleep-prevention]

Options:
  --layout <wide|16x9>     layout mode (default: 16x9, or config.json layout)
                           - 16x9: top full-width + bottom split, 2 Conductors (default)
                           - wide: 2x2 layout, 3 Conductors
  --sleep-prevention <m>   macOS sleep prevention mode (default: aggressive)
                           - aggressive: caffeinate -dis (block display + idle + system sleep, default since T256)
                           - idle:       caffeinate -i  (block user-idle sleep only; allows display sleep)
                           - off:        no caffeinate
                           also configurable via .team/config.json "sleepPrevention"
  --no-sleep-prevention    disable macOS sleep prevention (equivalent to --sleep-prevention off)

Notes:
  - Must be run inside a cmux session (CMUX_SOCKET_PATH is required)
  - Starts daemon + logging proxy + layout panes + Master
  - Priority: --layout > .team/config.json "layout" > "16x9"
  - CMUX_TEAM_MAX_CONDUCTORS env var overrides layout-derived max
    (16x9 still creates only 2 panes; extra conductors are clamped)
  - Dashboard is displayed with keyboard shortcuts for interaction
  - Sleep prevention: on macOS, caffeinate is used while any agent is active.
    aggressive=caffeinate -dis (block display + idle + system sleep),
    idle=caffeinate -i (user-idle only), off=disabled. Boolean values in
    .team/config.json are accepted for backward compatibility (true → aggressive, false → off).
    Priority: --no-sleep-prevention > --sleep-prevention <mode> > .team/config.json "sleepPrevention" > "aggressive"
`,

  help_send: `
elevens send -- send a message to the queue

Usage:
  elevens send <type> [options]

Types and required/optional options:
  TASK_CREATED
    --task-id <id>          task ID (required)
    --task-file <path>      task file path (required)

  TASK_UPDATED
    --task-id <id>          task ID (required)
    --task-file <path>      task file path (required)

  CONDUCTOR_DONE
    --surface <surface>     Conductor surface ID (required)
    --success <bool>        success/failure (optional, default true)
    --reason <text>         reason (optional)
    --exit-code <number>    exit code (optional)
    --session-id <id>       session ID (optional)
    --transcript-path <p>   transcript path (optional)

  CONDUCTOR_REGISTERED
    --surface <surface>     Conductor surface ID (required)

  AGENT_SPAWNED
    --conductor-surface <s> Conductor surface ID (required)
    --surface <surface>     Agent surface ID (required)
    --role <role>           role name (optional)
    --task-title <title>    task title (optional)

  SESSION_STARTED
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (required)
    --session-id <id>       session ID (optional)

  SESSION_ENDED
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)
    --reason <text>         reason (optional)

  SESSION_ACTIVE
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SESSION_IDLE
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SESSION_CLEAR
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SHUTDOWN
    (no options)

Examples:
  elevens send TASK_CREATED --task-id 035 --task-file .team/tasks/035-example.md
  elevens send SHUTDOWN
  elevens send CONDUCTOR_DONE --surface surface:210 --success true
`,

  help_status: `
elevens status -- show team status

Usage:
  elevens status [options]

Options:
  --log <N>     number of log lines to show (optional, default 10)

Examples:
  elevens status
  elevens status --log 20

Token Pool (T323):
  When token pool is enabled (CMUX_TEAM_TOKEN_POOL=1 / config / global yaml),
  the status output prepends a token pool header (capacity / next reset) and
  appends per-surface handle / utilization / cap_pct columns. When disabled,
  the layout is identical to the legacy output.
  See: elevens pool status   for the full per-token dashboard.
`,

  help_spawn_conductor: `
elevens spawn-conductor -- launch Claude Code for Conductor on the current surface (self-register)

Usage:
  elevens spawn-conductor [--resume <session-id>] [--task-prompt <path>] [--model <model>]

Environment:
  CMUX_SURFACE  Conductor surface ID (optional; falls back to cmux identify caller.surface_ref)

Options:
  --resume <session-id>     resume an existing session via 'claude --resume' (no new session-id)
  --task-prompt <path>      atomic prompt injection — passed as a positional CLI arg to claude (T421/D7)
  --model <model>           model to use (default: config.models.conductor or "{model}")

Notes:
  - Normally invoked by Manager when assigning a task (kill + spawn flow), but can be invoked
    manually from a cmux pane for debugging (CMUX_SURFACE will be auto-detected).
  - Self-registers via CONDUCTOR_REGISTERED POST so the Manager can match this surface to a
    pre-reserved entry (T421).
  - Dynamically resolves logging proxy port and exec's Claude Code.
  - Launched with --dangerously-skip-permissions.
  - T421: this command replaces the deprecated 'elevens conductor' / 'elevens resume'.
`,

  help_spawn_agent: `
elevens spawn-agent -- launch a sub-agent

Usage:
  elevens spawn-agent --conductor-surface <surface> --role <role> (--prompt <text> | --prompt-file <path>) [options]

Options:
  --conductor-surface <surface>   Conductor surface ID (required)
  --role <role>                   agent role name (required)
  --prompt <text>                 inline prompt (mutually exclusive with --prompt-file, one required)
  --prompt-file <path>            prompt file path (mutually exclusive with --prompt, one required)
  --task-title <title>            task title (optional, used for tab name)
  --model <model>                 model to use (default: config.models.agent or "{model}")

Examples:
  elevens spawn-agent --conductor-surface surface:210 --role researcher --prompt "Research the API endpoints"
  elevens spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md

Notes:
  - Creates an Agent as a tab within the Conductor pane
  - Fail-fast: if tab creation (pane lookup or new-surface) fails, posts AGENT_SPAWN_FAILED and exits 1 (no implicit fallback to new-split or focused pane)
  - AGENT_SPAWNED message is automatically sent to the queue
`,

  help_agents: `
elevens agents -- list running agents

Usage:
  elevens agents

Options:
  (none)
`,

  help_kill_agent: `
elevens kill-agent -- stop an agent

Usage:
  elevens kill-agent --surface <surface>

Options:
  --surface <surface>     surface ID of the Agent to stop (required)

Examples:
  elevens kill-agent --surface surface:215
`,

  help_close_agent: `
elevens close-agent -- close an agent (normal exit)

Usage:
  elevens close-agent --surface <surface>

Options:
  --surface <surface>     surface ID of the Agent to close (required)

Notes:
  - Use this when the Agent finished normally (e.g. approved by inspector).
  - Unlike kill-agent, this records status=completed in the agent done marker.
  - For crash/abort, prefer kill-agent which records status=crashed.

Examples:
  elevens close-agent --surface surface:215
`,

  help_send_agent: `
elevens send-agent -- send a message to an Agent spawned by this Conductor

Usage:
  elevens send-agent --surface <agent-surface> [--no-return] <message>

Options:
  --surface <agent-surface>   target Agent surface (required)
  --no-return                 skip sending Enter after the message
  <message>                   message body (quoted)

Environment:
  CMUX_SURFACE                caller Conductor surface (falls back to cmux identify)

Examples:
  elevens send-agent --surface surface:382 "Please resume from plan.md section 3"
  elevens send-agent --surface surface:382 --no-return "partial line"

Notes:
  - Only Agents spawned by the caller Conductor are allowed (verified via .team/team.json)
  - Self-send (caller == target) and other Conductors' Agents are rejected
  - Retries up to 5 × 200ms when the Agent is not yet registered in team.json
`,

  help_create_task: `
elevens create-task -- create a task

Usage:
  elevens create-task --title <title> [options]

Options:
  --title <title>         task title (required)
  --body <text>           task body (optional)
  --priority <priority>   priority: high / medium / low (optional, default medium)
  --status <status>       initial status: draft / ready (optional, default draft)
  --depends-on <ids>      dependency task IDs (comma-separated, e.g. "081,082") (optional)
  --base-branch <branch>  merge target branch (optional, default: none → merges to main)
  --run-after-all         run after all regular tasks complete (optional)
  --exclusive             run exclusively: after drain, block all other assignments
                          until this task is closed (implies --run-after-all)
  --force                 bypass the ready sync-state check (use with caution)
  --skip-fetch            skip 'git fetch' before the ready sync-state check
  --no-auto-pull          on behind-ff while on <mainBranch>, skip the auto
                          'git pull --ff-only' and warn instead

Examples:
  elevens create-task --title "Fix bug" --status ready --body "Login screen error"
  elevens create-task --title "Add feature" --priority high
  elevens create-task --title "Refactor" --depends-on "081,082" --status ready
  elevens create-task --title "hotfix" --base-branch develop --status ready
  elevens create-task --title "Release v3.5.0" --run-after-all --status ready
  elevens create-task --title "Release v3.53.0" --exclusive --status ready

Notes:
  - If status is ready, a TASK_CREATED message is automatically sent
    and the daemon assigns it to an idle Conductor
  - If draft, it will not be assigned. Use update-task --status ready to start
  - Only one --run-after-all task may exist at a time (error if one already exists unclosed)
  - The run_after_all task runs automatically after all regular tasks are closed
  - --exclusive implies --run-after-all (drain) and additionally blocks all other
    task assignments while this task is running (resumes after it closes)
  - Multiple --exclusive tasks may coexist; they run sequentially in ID order.
    A non-exclusive --run-after-all cannot coexist with any unclosed --exclusive
    task (create-task errors with RUN_AFTER_ALL_CONFLICT in either direction)
  - When status is ready, elevens verifies local <mainBranch> vs origin/<mainBranch>
    and rejects create on diverged / uncommitted / detached states. Bypass with
    --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
  - On behind-ff while <mainBranch> is checked out, elevens auto-runs
    'git pull --ff-only origin <mainBranch>' and rejects create if it fails.
    Use --no-auto-pull to skip the auto-pull (warn-only). On other branches /
    detached, behind-ff is already warn-only.
`,

  help_update_task: `
elevens update-task -- update a task

Usage:
  elevens update-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --status <status>       new status (optional)
  --title <title>         new title (optional)
  --body <text>           new body (optional)
  --depends-on <ids>      dependency task IDs (comma-separated, e.g. "081,082") (optional)
  --no-exclusive          remove exclusive: true / run_after_all: true from the
                          task frontmatter (cancels exclusive/drain semantics)
  --force                 bypass the ready sync-state check (use with caution)
  --skip-fetch            skip 'git fetch' before the ready sync-state check
  --no-auto-pull          on behind-ff while on <mainBranch>, skip the auto
                          'git pull --ff-only' and warn instead

  * At least one of --status, --title, --body, --depends-on, or --no-exclusive is required

Examples:
  elevens update-task --task-id 035 --status ready
  elevens update-task --task-id 035 --title "New title" --body "New description"
  elevens update-task --task-id 035 --depends-on "081,082"
  elevens update-task --task-id 035 --no-exclusive

Notes:
  - Tasks in assigned (running) state cannot be updated
  - Closed tasks cannot be updated (create a new task instead)
  - Changing status to ready automatically sends a TASK_CREATED message
  - When transitioning to ready, elevens verifies local <mainBranch> vs
    origin/<mainBranch> and rejects on diverged / uncommitted / detached. Bypass
    with --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
  - On behind-ff while <mainBranch> is checked out, elevens auto-runs
    'git pull --ff-only origin <mainBranch>' and rejects update if it fails.
    Use --no-auto-pull to skip the auto-pull (warn-only).
`,

  help_close_task: `
elevens close-task -- mark a task as complete (closed)

Usage:
  elevens close-task --task-id <id> --deliverable-kind <kind> [kind-specific flags] [--journal <text>] [--force]

Options:
  --task-id <id>                  task ID (required)
  --deliverable-kind <kind>       deliverable kind (required, one of: files, merged, pr, none)
  --deliverable <path>            file path (repeatable; required when kind=files)
  --merged-into <branch>          merge target branch name (required when kind=merged)
  --merge-sha <sha>               merge commit SHA (required when kind=merged)
  --pr-url <url>                  pull request URL (required when kind=pr)
  --journal <text>                completion journal (optional, recorded on success)
  --force                         force-close a running (assigned) task

Examples:
  # local ff-only merge (the most common case)
  elevens close-task --task-id 035 --deliverable-kind merged \\
    --merged-into task-035/task --merge-sha $(git rev-parse task-035/task) \\
    --journal "Implementation complete, tests passed"

  # GitHub PR
  elevens close-task --task-id 036 --deliverable-kind pr \\
    --pr-url https://github.com/owner/repo/pull/42 --journal "PR opened"

  # investigation / docs-only delivery (no branch produced)
  elevens close-task --task-id 037 --deliverable-kind files \\
    --deliverable .team/artifacts/A042.md --deliverable docs/spec/01-x.md \\
    --journal "Research summary delivered"

  # no deliverable (e.g. spec turned out already satisfied)
  elevens close-task --task-id 038 --deliverable-kind none --journal "Already satisfied by T294"

Notes:
  - --deliverable-kind is mandatory; running without it exits 1
  - kind-specific flags are mutually exclusive across kinds (e.g. --pr-url is rejected for kind=merged)
  - Assigned (running) tasks require --force to close regardless of kind
  - Legacy closed rows (before T295) load with deliverable=undefined for read-back compatibility;
    only the creation path is a breaking change
`,

  help_abort_task: `
elevens abort-task -- abort a running task (sets to aborted)

Usage:
  elevens abort-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        abort journal (optional, default: "Aborted: T{id} {title}")

Examples:
  elevens abort-task --task-id 035
  elevens abort-task --task-id 035 --journal "Aborted due to direction change"

Notes:
  - Only tasks in assigned (running) state can be aborted
  - Stops the Conductor's sub-agents and the Conductor itself
  - Removes the worktree and changes task status to aborted
  - Conductor automatically restarts to idle state
`,

  help_restart_task: `
elevens restart-task -- restart an assigned or aborted task (re-queues as ready)

Usage:
  elevens restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        restart journal (optional, default: "Restarted: T{id} {title}")

Examples:
  elevens restart-task --task-id 035                                    # works for both assigned and aborted
  elevens restart-task --task-id 035 --journal "Conductor crashed, retrying"

Notes:
  - Only tasks in assigned or aborted state can be restarted
  - For assigned: performs the same cleanup as abort-task (stops agents, removes worktree)
  - For aborted: removes residual worktree/branch left over from the abort
  - Sets status back to ready instead of aborted
  - Sends TASK_CREATED notification for automatic re-assignment
`,

  help_clear_conductor: `
elevens clear-conductor -- remove a broken Conductor from the pool (does NOT close the surface)

Usage:
  elevens clear-conductor --surface <id>

Options:
  --surface <id>   surface ID (e.g. 112 or surface:112)

Examples:
  elevens clear-conductor --surface 112
  elevens clear-conductor --surface surface:112

Notes:
  - Only Conductors currently in broken state can be cleared
  - For other states, use abort-task / restart-task
  - The surface is left completely untouched (never closed). The Manager simply
    stops treating it as a Conductor: the entry is dropped, maxConductors is
    decremented by 1, and any re-registration from that surface is rejected
  - maxConductors returns to the configured value on daemon restart / 'cmux-team start'
  - Worktree / branch residue is already cleaned up at the broken transition
`,

  help_reset_conductor: `
elevens reset-conductor -- reset a Conductor surface to the reserved state

Usage:
  elevens reset-conductor [--surface <id>] [--force]

Options:
  --surface <id>   surface ID (e.g. 112 or surface:112). When omitted, resolves
                   from CMUX_SURFACE env or "cmux identify" (the pane shell)
  --force          allow reset of an assigned Conductor (assigning / running / asking).
                   The associated task is aborted (journal: "reason=reset_conductor; ...")

Examples:
  elevens reset-conductor                                # reset the surface running this shell
  elevens reset-conductor --surface 112
  elevens reset-conductor --surface surface:112 --force  # abort the running task and reset

Notes:
  - Resets any-state Conductor (broken / disconnected / idle / reserved / error / starting)
    to "reserved", at which point findIdleConductor picks it up on the next tick
  - Assigned states (assigning / running / asking) require --force
  - Use this when you spot a stuck or broken Conductor in your pane and want to recover
    locally without restarting the entire daemon (observatory: real-time → intervention loop)
`,

  help_delete_task: `
elevens delete-task -- delete a task (sets to deleted)

Usage:
  elevens delete-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        deletion journal (optional, default: "Deleted: T{id} {title}")
  --force                 force-delete a closed or aborted task (assigned still requires abort-task)

Examples:
  elevens delete-task --task-id 035
  elevens delete-task --task-id 035 --journal "No longer needed"
  elevens delete-task --task-id 035 --force                 # delete a closed/aborted task

Notes:
  - draft / ready tasks can be deleted without --force
  - closed / aborted tasks require --force (assigned must use abort-task first)
  - assigned tasks cannot be deleted with --force; use abort-task / restart-task
  - deleted tasks are terminal; re-deletion is a no-op (rejected with exit 1)
  - Sets status to deleted in task-state.json
  - A record remains in the journal
`,

  help_trace_task: `
elevens trace-task -- display session history for a task

Usage:
  elevens trace-task <task-id> [options]

Options:
  --no-metrics           hide the Token Usage / By role / By model metrics section
  --summary              show summary mode (stub for future)

Examples:
  elevens trace-task 141
  elevens trace-task 141 --no-metrics
  elevens trace-task 141 --summary

Output includes:
  - Base: base branch / SHA / source (when available)
  - Deliverable: recorded at close-task time (kind + details), or "-" for legacy rows
  - Token Usage: totals (requests / input / output / cache create / cache read / cache hit rate / duration)
  - By role / By model: token usage breakdown (tasks predating T305 show a single fallback line)
`,

  help_trace_hooks: `
elevens trace-hooks -- display hook signal history received by the daemon

Usage:
  elevens trace-hooks [options]

Options:
  --type <TYPE>          filter by hook type (e.g. SESSION_STARTED, SESSION_ENDED,
                         SESSION_IDLE, SESSION_CLEAR, AGENT_SPAWNED, SESSION_ASK,
                         CONDUCTOR_DONE, NOTIFICATION)
  --surface <surface>    filter by surface (accepts "surface:665", "665", "C[665]")
  --task-run <id>        filter by task_run_id (e.g. "task-217-1776294106")
  --role <ROLE>          filter by NOTIFICATION role column (master/conductor/agent/unknown)
  --task-id <id>         filter by NOTIFICATION task_id column (e.g. "265")
  --limit <N>            max rows to display (default: 50, newest first)
  --json                 emit JSON array instead of tabular output

Examples:
  elevens trace-hooks
  elevens trace-hooks --type SESSION_ENDED --limit 20
  elevens trace-hooks --surface C[665]
  elevens trace-hooks --task-run task-217-1776294106 --json
  elevens trace-hooks --type NOTIFICATION --role agent
  elevens trace-hooks --type NOTIFICATION --task-id 265

Notes:
  - Reads from .team/traces/traces.db (hook_signals table)
  - Rows are ordered by id DESC (newest first)
  - DETAIL column shows non-null source/reason/task_run_id/question
  - For NOTIFICATION rows, DETAIL shows role/task_id/agent_role/ntype/message
  - question/message is truncated to 60 chars; use --json to see full payload
`,

  help_events: `
elevens events -- tail / filter the events stream

Usage:
  elevens events [options]
  elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...

Options:
  --follow, -f             tail -F equivalent (rotate aware). Stream new lines until SIGINT.
  --types <list>           comma-separated event type filter (exact match).
                           e.g. --types task_completed,task_aborted
                           (empty list "" / ", ," is rejected with exit 1)
  --since <when>           filter records older than the given threshold.
                           duration: 5m / 1h / 2d
                           ISO 8601: 2026-04-27T12:00:00Z
  --format json|text       output format (default: json -- raw JSONL)
                           text: <ts> <event> <key=value...> (debug only)

Notes:
  - Records that fail to parse or have unsupported schema_version are skipped
    with a warning to stderr (spec section 8 forward-compat).
  - Unknown event records are skipped with a warning unless their event name is
    explicitly subscribed via --types (spec section 8.1 / 6.20 user-signal).
  - --format text omits journal_summary fields to keep one record per line.
  - --follow re-opens the file after rotate (inode change or size shrink),
    re-emitting from the new file's head; the consumer must dedupe if needed.
  - SIGINT exits with code 0 (graceful shutdown). If your CI scripts need to
    distinguish SIGINT from normal EOF, this is a follow-up consideration.
  - 'emit' subcommand posts a free-form user signal directly to events.jsonl
    (no daemon round-trip; works while daemon is stopped). See 'emit --help'.

Exit codes:
  0  normal exit (EOF without --follow, or SIGINT during --follow)
  1  argument error / events.jsonl not found
`,

  help_events_emit: `
elevens events emit -- append a free-form user signal to events.jsonl

Usage:
  elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...

Options:
  --type <name>            (required) event type name. snake_case recommended.
                           'signal:' prefix is strongly recommended (e.g. signal:deploy_started).
  --message <text>         short human-readable description (optional).
  --actor <id>             actor identifier (optional). Default: $CMUX_SURFACE.
                           Omitted entirely from the record if neither --actor nor
                           CMUX_SURFACE is set.
  --data k=v               key/value metadata. Repeatable. Split on the first '='.
                           Values are stored as strings (no type inference).
  --help, -h               show this help.

Examples:
  elevens events emit --type signal:deploy_started --message "rolling out v1.2.3"
  elevens events emit --type signal:deploy_finished --data version=v1.2.3 --data env=prod

Notes:
  - best-effort: no lock / lease / mutex. POSIX O_APPEND atomicity is the only guarantee.
  - works while the daemon is stopped (CLI writes events.jsonl directly).
  - If --type matches a reserved typed daemon event name (e.g. task_completed), a
    warning is printed to stderr but the record is still appended (exit 0).

Exit codes:
  0  normal exit (record appended; reserved-name warning still exits 0)
  1  argument error (missing --type, malformed --data, unknown flag, etc.)
`,

  help_metrics: `
elevens metrics -- per-task / per-period aggregate of events.jsonl + hook_signals + api_usage

Subcommands:
  snapshot                 write a daily snapshot JSON for cohort comparison.
  compare                  compare baseline vs comparison cohorts (diff + statistical tests).
  health                   check that snapshot files are present for the recent N days.
  query                    run an ad-hoc DuckDB SQL query across traces.db / events.jsonl / snapshots.

Usage:
  elevens metrics [options]

Options:
  --task-id <id>           filter to a single task (only with --group-by task; default).
  --since <when>           lower bound for the aggregation window.
                           duration: 5m / 1h / 2d
                           ISO 8601: 2026-04-27T12:00:00Z
  --format json|text|csv   output format (default: json).
                           text: key=value per record. csv: RFC 4180.
  --group-by task|day|week aggregation key (default: task).
                           week: ISO week, Monday start.

Output (--group-by task):
  array of per-task records: task_id, outcome, duration_ms, tool_calls, tool_failure_rate,
  time_to_first_edit_ms, tokens.

Output (--group-by day|week):
  array of per-bucket records: tasks_assigned/completed/aborted, completion_rate, abort_rate,
  forced_close_rate, deny_rate, tool_call_total, stddev, duration mean/stddev, tokens_total.

Notes:
  - "deny_rate" = (PRE_TOOL_USE_DENIED count) / (PRE_TOOL_USE count) within the bucket window.
    Currently this only counts the Conductor's Bash deny script (cmux send/send-key block);
    it does NOT cover all PreToolUse exit-2 hooks. Treat it as a "elevens Bash deny rate"
    rather than a generic hook block rate.
  - Tool calls are joined to tasks via task_sessions.session_id MIN(task_id).
    Hooks fired before task_assigned (no matching session_started row) are dropped.
  - tool_response.content is truncated to 1KB at hook receive time; success / error fields are kept.

Exit codes:
  0  normal exit
  1  argument error / events.jsonl or traces.db not found
`,

  help_metrics_snapshot: `
elevens metrics snapshot -- write a daily metrics snapshot as a JSON fact

Usage:
  elevens metrics snapshot [--date YYYY-MM-DD] [--out <path>] [--force] [--allow-outside-project]

Options:
  --date YYYY-MM-DD            UTC date to snapshot (default: yesterday UTC).
  --out <path>                 output file path (default: .team/metrics/snapshots/YYYY-MM-DD.json).
                               relative paths resolve under projectRoot.
  --force                      overwrite an existing snapshot file.
  --allow-outside-project      permit --out outside projectRoot (path traversal opt-in).

Notes:
  - The snapshot date is interpreted in UTC. The window is [date 00:00Z, date+1 00:00Z).
  - Atomic write: a temp file is renamed into place, so partial writes do not persist.
  - schema_version is increment-only; past snapshots are never regenerated.
  - Recommended schedule: 00:05 UTC daily (= 09:05 JST), so the previous UTC day is closed.

Exit codes:
  0  snapshot written
  1  argument error / events.jsonl or traces.db missing / target exists without --force
`,

  help_metrics_compare: `
elevens metrics compare -- diff a baseline snapshot range against a comparison range

Usage:
  elevens metrics compare --baseline FROM..TO --comparison FROM..TO [options]

Options:
  --baseline FROM..TO          inclusive YYYY-MM-DD..YYYY-MM-DD range (UTC).
  --comparison FROM..TO        inclusive YYYY-MM-DD..YYYY-MM-DD range (UTC).
  --format json|text           output format (default: json).
  --snapshot-dir <path>        directory holding YYYY-MM-DD.json snapshots
                               (default: .team/metrics/snapshots/).
  --allow-outside-project      permit --snapshot-dir outside projectRoot.

Output:
  metrics:  per-metric { baseline_mean, comparison_mean, delta, delta_pct, t_test, mann_whitney }
  rates:    completion_rate, abort_rate, forced_close_rate diffs (z-test)
  alarms:   list of alarms exceeding DEFAULT_ALARM_THRESHOLDS (direction-aware)
  samples:  { baseline_n, comparison_n }
  skipped_files: snapshot files that were skipped (schema_version mismatch / parse error)
  missing:  YYYY-MM-DD dates with no snapshot file in either range

Exit codes:
  0  no alarm
  1  argument error / IO error
  2  alarm raised (CI integration)
`,

  help_metrics_health: `
elevens metrics health -- check that recent snapshot files are present

Usage:
  elevens metrics health [--days N] [--snapshot-dir <path>] [--format json|text]

Options:
  --days N                     check the last N UTC days (default: 7).
  --snapshot-dir <path>        snapshot directory (default: .team/metrics/snapshots/).
  --format json|text           output format (default: json).
  --allow-outside-project      permit --snapshot-dir outside projectRoot.

Output:
  { missing: ["YYYY-MM-DD", ...], count: <missing count>, days_checked: N }

Exit codes:
  0  no gaps
  1  one or more days missing / argument error
`,

  help_metrics_query: `
elevens metrics query -- run an ad-hoc DuckDB SQL across traces.db / events.jsonl / snapshots

Usage:
  elevens metrics query --sql '<SQL>' [--format json|csv|tsv|table] [--explain]
  echo '<SQL>' | elevens metrics query [--format ...] [--explain]

Options:
  --sql <SQL>                  SQL to execute. Wins over stdin when both are provided.
  --format json|csv|tsv|table  output format (default: table).
                               Maps to DuckDB CLI flags: -json / -csv / -csv -separator $'\\t' / -box.
  --explain                    prefix the user SQL with EXPLAIN (read query plan).

Pre-attached sources (read-only):
  t.api_usage              SQLite ATTACH from .team/traces/traces.db
  t.hook_signals           same
  t.task_sessions          same
  t.rate_limit_snapshots   same
  events                   read_json() view over .team/logs/events.jsonl (newline_delimited)
  snapshots                read_json() view over .team/metrics/snapshots/*.json (one row per file)
  snapshots_per_task       UNNEST(snapshots.per_task), pre-joined with snapshot_date / window

Environment:
  DUCKDB_BIN               path to the duckdb binary (overrides $PATH).
                           DuckDB 0.10+ recommended (for the -box format flag).

Notes:
  - Sources that are missing on disk are skipped silently with a stderr warning.
    e.g. running on a fresh project without traces.db still allows 'SELECT 1'.
  - The connection is in-memory; ATTACH is READ_ONLY. Your queries cannot mutate facts.
  - For recipe libraries, see the analyze skill (skills/cmux-team-analyze/SKILL.md).

Exit codes:
  0  query exited normally
  1  argument error / 'duckdb' binary not found / stdin empty
  *  any other code is relayed from the duckdb child process
`,

  help_spawn_master: `
elevens spawn-master -- launch Claude Code for Master (self-register)

Usage:
  elevens spawn-master [--model <model>]

Options:
  --model <model>   model to use (default: config.models.master or "{model}")

Notes:
  - Registers itself with daemon via MASTER_REGISTERED before launching Claude Code
  - Fails with exit 1 if daemon is not running (.team/proxy-port unreachable)
  - Can be invoked from any pane to add a new Master to the running daemon
  - Dynamically resolves logging proxy port and exec's Claude Code
  - Generates Master prompt then launches with --dangerously-skip-permissions
`,

  help_artifacts: `
elevens artifacts -- manage artifacts (add moves the file, not copy)

Usage:
  elevens artifacts [subcommand] [options]

Subcommands:
  (none)                  list artifacts (default)
  add <file>             move a file into .team/artifacts/ (source is removed on success)
  show <id>              show artifact content
  open <id>              open artifact in markdown viewer
  search <query>         full-text search artifacts

Options:
  --type <type>           filter by type: research / decision / session / spec / report (optional)
  --task <id>             filter by related task ID (optional)
  --sort <field>          sort by: created / updated (optional, default created)
  --validate              validate frontmatter of all artifacts
  --type <type>           (add) artifact type: research / decision / session / spec / report
  --title <title>         (add) artifact title
  --task <id>             (add) related task ID
  --tags <tag1,tag2>      (add) comma-separated tags
  --project-root <path>   (add) override project root (destination .team/artifacts/ lives under this)

Examples:
  elevens artifacts
  elevens artifacts add ./research-notes.md
  elevens artifacts add ./design.md --type decision --title "Auth method selection"
  elevens artifacts show A001
  elevens artifacts open A001
  elevens artifacts search "authentication"
  elevens artifacts --type research --task T038
  elevens artifacts --validate
`,

  help_await_task: `
elevens await-task -- wait for a task to complete (closed/aborted)

Usage:
  elevens await-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required, comma-separated for multiple: 108,109)
  --timeout <seconds>     timeout in seconds (default: 3600)

On completion:
  - closed: prints summary.md to stdout, exits 0
  - aborted: prints abort reason to stderr, exits 1
  - timeout: prints timeout message to stderr, exits 2

Examples:
  elevens await-task --task-id 108
  elevens await-task --task-id 108,109 --timeout 7200
`,

  help_get_agent_instructions: `
elevens get-agent-instructions -- print the project-local overlay for an overlay role

Usage:
  elevens get-agent-instructions --role <role>

Options:
  --role <role>           overlay role: 8 agent roles + master + conductor (required)
                          aliases: impl → implementer, reviewer → design-reviewer

Notes:
  - Reads .team/agent-instructions/<role>.md under PROJECT_ROOT
  - Prints the file content to stdout (trailing newline preserved)
  - If the overlay file does not exist, prints nothing and exits 0
  - Unknown role → exit 1 with error on stderr
  - master / conductor overlays are applied to .team/prompts/master.md and
    .team/prompts/conductor-role.md by generateMasterPrompt /
    generateConductorRolePrompt at daemon start (T342)
`,

  help_set_agent_instructions: `
elevens set-agent-instructions -- write the project-local overlay for an overlay role

Usage:
  elevens set-agent-instructions --role <role> (--body <text> | --from-file <path> | --from-stdin)

Options:
  --role <role>           overlay role: 8 agent roles + master + conductor (required)
  --body <text>           overlay body as inline text (mutually exclusive with --from-file/--from-stdin)
  --from-file <path>      read overlay body from a file (mutually exclusive)
  --from-stdin            read overlay body from stdin (mutually exclusive)

Notes:
  - Creates .team/agent-instructions/ if missing
  - Overlay body cannot exceed 100 KB (exits 1 otherwise)
  - Unknown role → exit 1 (strict; overlay writer is a user entry point)
  - Prints "OK role=<role> bytes=<n>" to stdout on success
`,

  help_delete_agent_instructions: `
elevens delete-agent-instructions -- remove the project-local overlay for an overlay role

Usage:
  elevens delete-agent-instructions --role <role>

Notes:
  - Overlay role: 8 agent roles + master + conductor
  - Prints "DELETED=true" if the file was removed, "DELETED=false" if it did not exist
  - Exits 0 in both cases (deletion is idempotent)
  - Unknown role → exit 1 with error on stderr
`,

  help_list_agent_instructions: `
elevens list-agent-instructions -- list all overlay roles with their overlay status

Usage:
  elevens list-agent-instructions

Notes:
  - Prints one line per role in OVERLAY_ROLES order (8 agent roles, then master, then conductor)
  - "<role> ✓ <n> bytes" if the overlay exists, "<role> ✗" otherwise
`,

  help_main: `elevens — multi-agent development orchestration

Usage:
  elevens --version                          show version
  elevens start                              launch daemon + spawn Master
  elevens send TASK_CREATED --task-id <id> --task-file <path>
  elevens send SHUTDOWN
  elevens status                             show status
  elevens spawn-conductor [--resume <session-id>] [--task-prompt <path>] [--model <model>]
  elevens spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
                                              (agent roles only — master/conductor reserved for system prompt overlay)
  elevens agents                             list running agents
  elevens close-agent --surface <surface>    close an agent (normal exit)
  elevens kill-agent --surface <surface>     kill an agent (crash/force)
  elevens clear-conductor --surface <id>     reset a broken Conductor (broken -> idle)
  elevens reset-conductor [--surface <id>] [--force]   reset a Conductor surface to reserved
  elevens send-agent --surface <surface> <message>    send a message to a spawned Agent
  elevens create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all] [--exclusive]
  elevens update-task --task-id <id> --status <status>
  elevens close-task --task-id <id> [--journal <text>]
  elevens await-task --task-id <id> [--timeout <sec>]    wait for task completion
  elevens abort-task --task-id <id> [--journal <text>]  abort a running task
  elevens restart-task --task-id <id> [--journal <text>] restart an assigned or aborted task
  elevens delete-task --task-id <id> [--journal <text>] delete a task
  elevens trace-task <task-id>              display session history for a task
  elevens trace-hooks                        display hook signal history
  elevens events [--follow] [--types ...] [--since ...] [--format json|text]
                                              tail / filter the events stream (.team/logs/events.jsonl)
  elevens metrics [--task-id ...] [--since ...] [--format json|text|csv] [--group-by task|day|week]
                                              aggregate task / tool / token metrics from events.jsonl + hook_signals + api_usage
  elevens spawn-master                       launch Master (auto-resolves proxy)
  elevens artifacts                              list artifacts
  elevens artifacts add <file>                   move a file into .team/artifacts/
  elevens artifacts show <id>                    show artifact
  elevens artifacts open <id>                    open in markdown viewer
  elevens artifacts search <query>               full-text search
  elevens artifacts --validate                   validate frontmatter
  elevens get-agent-instructions --role <role>   print project-local overlay (agent roles + master/conductor)
  elevens set-agent-instructions --role <role> (--body <t> | --from-file <p> | --from-stdin)  write overlay
  elevens delete-agent-instructions --role <role> remove overlay
  elevens list-agent-instructions                 list overlay status per role (10 roles)
  elevens pool status                            show token pool dashboard (T323)

Common options:
  --project-root <path>      override project root (read-only by default; writes require confirmation)
  --project-root-confirm     bypass the cross-project write gate (use with care)
                             also: CMUX_TEAM_PROJECT_ROOT_CONFIRM=1 env

For details on each command: elevens <command> --help`,

  // ── gh-cache (T272) ───────────────────────────────────────────────────────
  gh_not_a_github_repo:
    "Error: not a git repository, or origin is not GitHub / GHE.\n" +
    "  elevens issue/pr requires a git repo with an origin on github.com or an enterprise instance.",
  gh_auth_missing:
    "Error: No GitHub token found for host {host}.\n" +
    "  checked: {checked}\n" +
    "Run one of:\n" +
    "  gh auth login\n" +
    "  export GITHUB_TOKEN=<your token>",
  gh_rate_limit_exhausted:
    "Error: GitHub rate limit exhausted. remaining={remaining} reset_at={reset_at}\n" +
    "  Try `elevens issue list --stale-ok` to read from cache without syncing.",
  gh_me_not_resolved:
    "Error: @me cannot be resolved. Run `elevens gh sync` first so the cache knows your viewer login.",
  gh_unknown_subcommand:
    "Unknown subcommand: {sub}. Run `elevens gh --help`.",
  gh_cache_not_initialized:
    "Error: gh-cache.db is empty. Run `elevens gh sync --full` first.",
  gh_stale_warning:
    "Warning: last full sync was {days} days ago. Consider `elevens gh sync --full`.",
  gh_issue_empty: "(no issues / PRs matched)",
  gh_sync_success:
    "Synced {mode}: issues={issues} comments={comments} reviews={reviews} duration={duration_ms}ms",
  gh_sync_not_modified: "Not modified (304). last_sync={last_sync}",
  gh_status_header: "GitHub cache status",
  gh_status_last_full: "Last full sync:        {when}",
  gh_status_last_incremental: "Last incremental sync: {when}",
  gh_status_host: "host:                  {host}",
  gh_status_repo: "repo:                  {owner}/{repo}",
  gh_status_viewer: "viewer:                {viewer}",
  gh_status_issue_counts:
    "issue:                 {total} (open={open}, closed={closed})",
  gh_status_pr_counts:
    "PR:                    {total} (open={open}, closed={closed}, merged={merged})",
  gh_status_comments: "comments:              {count}",
  gh_status_rate: "rate limit:            {remaining} / {limit} (reset {reset})",
  gh_status_token: "token hash:            {hash}",
  gh_status_never_synced: "(never)",
  gh_tui_tab_title: "Issues",
  gh_tui_help_line:
    "[R] sync  [Enter/O] open in viewer  [B] open in browser",
  gh_tui_syncing: "Syncing...",
  gh_tui_disabled_non_git:
    "Issues tab disabled (not a git repo or origin not GitHub).",
  gh_tui_disabled_no_auth:
    "Issues tab needs authentication: run `gh auth login` or set GITHUB_TOKEN.",
  gh_help: `elevens gh — GitHub issue/PR cache management

Usage:
  elevens gh sync [--full]          sync issues/PRs into .team/gh-cache.db
  elevens gh status                 show cache status + rate limit

Flags:
  --full    fetch the last 500 issues/PRs (plus attachments) from scratch
            (use on first run, after token rotation, or once a month)

Without --full, sync uses If-None-Match + since= to fetch only changes.
Non-git directories / non-GitHub origins exit 2. Missing auth exits 3.
Rate-limit exhaustion exits 4.`,

  // ── T307: dashboard Metrics タブ ──────────────────────────────────────────────
  metrics_tab_title: "Metrics",
  // T354: 旧 "Rate limit (per-minute)" を Rate Limit Projection に置き換え
  metrics_section_rate_limit_projection: "Rate Limit Projection",
  metrics_section_pool_tokens: "Pool Tokens (selectable: {count})",
  metrics_long_term: "long-term",
  metrics_recent_15m: "recent 15m",
  metrics_before_reset: "before reset",
  metrics_pool_no_selectable: "(no selectable tokens)",
  metrics_pool_no_data: "no data",
  metrics_pool_marker_legend: "(* = reset passed, effectively cleared)",
  metrics_label_risk: "RISK",
  metrics_label_no_data: "no data",
  metrics_label_idle: "idle",
  metrics_loading: "loading metrics…",
  metrics_caption_from: "from: {role}/{surface} ({age}s ago)",
  metrics_proxy_idle: "proxy idle? last seen {age}s ago",
  // T415: Web ダッシュボード URL 行 + O キーヘルプ
  metrics_url_label: "Open dashboard",
  metrics_url_not_running: "Web dashboard: not running",
  metrics_open_browser_hint: "Open in browser",

  // ── T435: dashboard keybinding labels (status bar / help overlay) ────────
  key_help: "help",
  key_quit: "quit",
  key_full_quit: "full quit",
  key_cancel: "back",
  key_reload: "reload",
  key_nav_up: "up",
  key_nav_down: "down",
  key_nav_scroll: "scroll",
  key_nav_select: "select",
  key_nav_top: "top",
  key_nav_bottom: "bottom",
  key_nav_half_page_down: "half page down",
  key_nav_half_page_up: "half page up",
  key_tab_journal: "journal",
  key_tab_artifacts: "artifacts",
  key_tab_log: "log",
  key_tab_settings: "settings",
  key_tab_issues: "issues",
  key_tab_metrics: "metrics",
  key_tab_next: "next tab",
  key_tab_prev: "prev tab",
  key_open_primary: "open",
  key_open_browser: "browser",
  key_artifact_sort: "sort",
  key_artifact_filter: "filter",
  key_artifact_search: "search (NYI)",
  key_artifact_copy_path: "copy path",
  toast_copy_success: "Copied",
  toast_copy_failed: "Copy failed",
  toast_pbcopy_unavailable: "pbcopy not available",
  chord_pending_indicator: "c-",
  key_issues_sync: "sync",
  key_modal_confirm: "yes",
  key_modal_cancel: "cancel",
  key_modal_full_quit_prompt: "Full quit: close all surfaces and shut down?",
  // help overlay headings
  help_overlay_title: "Keyboard shortcuts",
  help_overlay_hint_close: "Esc / ?: close help",
  help_category_system: "System",
  help_category_navigation: "Navigation",
  help_category_tab: "Tab",
  help_category_open: "Open",
  help_category_action: "Action",
};

const ja: typeof en = {
  // ── T247: project-local agent instructions overlay ─────────────────────────
  project_instructions_heading: "プロジェクト固有の追加指示",
  project_common_instructions_heading: "プロジェクト共通の追加指示",

  // ── エラー・ステータスメッセージ ──────────────────────────────────────────────
  not_in_cmux: "❌ cmux 環境外です。cmux 内で実行してください。",
  daemon_not_running:
    "Error: daemon が起動していません（proxy-port が見つかりません）",
  team_not_started_start: "チーム未起動。`start` で起動してください。",
  team_not_started: "チーム未起動。",
  no_running_agents: "稼働中のエージェントはありません。",
  no_artifacts: "アーティファクトが見つかりません",
  artifact_id_required:
    "Error: アーティファクト ID を指定してください\nUsage: elevens artifacts show <id>",
  artifact_id_required_open:
    "Error: アーティファクト ID を指定してください\nUsage: elevens artifacts open <id>",
  search_query_required:
    "Error: 検索クエリを指定してください\nUsage: elevens artifacts search <query>",
  artifact_add_file_required:
    "Error: ファイルパスを指定してください\nUsage: elevens artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]",
  dashboard_startup_hint:
    "ヒント: TTY 環境で elevens start を実行してください",
  task_section_header: "タスク",

  // ── テンプレートメッセージ ────────────────────────────────────────────────────
  artifact_not_found: "アーティファクト {id} が見つかりません",
  no_artifacts_matching: '"{query}" に一致するアーティファクトが見つかりません',
  artifact_add_file_not_found: "Error: ファイルが見つかりません: {path}",
  artifact_added: "追加しました {id} → {path}",
  dashboard_startup_failed: "❌ ダッシュボード起動失敗: {message}",
  abort_journal_default: "中断: T{id} {title}",
  restart_journal_default: "再実行: T{id} {title}",
  delete_journal_default: "削除: T{id} {title}",

  // ── テンプレートエラーメッセージ ──────────────────────────────────────────────
  template_dir_not_found:
    "Template directory not found. npm install -g @hummer98/elevens を実行してください",
  conductor_role_template_not_found:
    "Conductor role template not found. npm install -g @hummer98/elevens を実行してください",
  conductor_task_template_not_found:
    "Conductor task template not found. npm install -g @hummer98/elevens を実行してください",

  // ── e2e.ts ────────────────────────────────────────────────────────────────────
  e2e_daemon_not_confirmed: "  WARNING: daemon 起動未確認。テストを続行します。",
  e2e_master_not_found:
    "  WARNING: Master surface が見つかりません（Master spawn に失敗した可能性）",
  e2e_team_json_failed: "  WARNING: team.json 読み取り失敗: {message}",
  e2e_scenario1_title: "  3 つのタスクを連鎖依存で実行:",
  e2e_scenario1_tasks: "  Task 1 (調査) → Task 2 (設計) → Task 3 (実装)\n",

  // ── ヘルプテキスト ────────────────────────────────────────────────────────────
  /**
   * Task 440: 全 help_<cmd> の末尾に showHelp() で append される共通オプション。
   * read 系・write 系で同じ文字列を使い、`--project-root-confirm` は write 系コマンドで
   * のみ有効である旨を文中に明示する。
   */
  help_common_options: `共通オプション:
  --project-root <path>      project root を上書き（read はデフォルト許可、write は確認 prompt）
  --project-root-confirm     cross-project write gate を skip（write コマンド限定。
                             env: CMUX_TEAM_PROJECT_ROOT_CONFIRM=1 でも可）`,

  help_start: `
elevens start -- daemon 起動 + Master spawn + ダッシュボード表示

Usage:
  elevens start [--layout=<wide|16x9>] [--sleep-prevention=<off|idle|aggressive>] [--no-sleep-prevention]

Options:
  --layout <wide|16x9>     レイアウトモード (デフォルト: 16x9、または config.json の layout)
                           - 16x9: 上段フル幅 + 下段 2 分割、Conductor x2（デフォルト）
                           - wide: 2x2 レイアウト、Conductor x3
  --sleep-prevention <m>   macOS スリープ抑止モード（デフォルト: aggressive）
                           - aggressive: caffeinate -dis（display+idle+system 全抑止、T256 以降のデフォルト）
                           - idle:       caffeinate -i  （user idle のみ抑止、display sleep は許可）
                           - off:        caffeinate を起動しない
                           .team/config.json の "sleepPrevention" でも設定可能
  --no-sleep-prevention    macOS スリープ抑止を無効化（--sleep-prevention off と等価）

Notes:
  - cmux 環境内で実行する必要があります（CMUX_SOCKET_PATH が必要）
  - daemon + ロギングプロキシ + レイアウト pane + Master を起動します
  - 優先順位: --layout > .team/config.json の "layout" > "16x9"
  - CMUX_TEAM_MAX_CONDUCTORS 環境変数は layout 派生値を上書きします
    （16x9 は 2 pane のみ作成、超過分は clamp されます）
  - ダッシュボードが表示され、キーボードショートカットで操作できます
  - スリープ抑止: macOS では稼働中エージェントがある間 caffeinate を実行します。
    aggressive=caffeinate -dis（display + idle + system sleep を抑止）、
    idle=caffeinate -i（user idle のみ抑止）、off=無効。
    .team/config.json の boolean 値も後方互換で受理します（true → aggressive、false → off）。
    優先順位: --no-sleep-prevention > --sleep-prevention <mode> > .team/config.json の "sleepPrevention" > "aggressive"
`,

  help_send: `
elevens send -- キューにメッセージを送信

Usage:
  elevens send <type> [options]

Types と必須/任意オプション:
  TASK_CREATED
    --task-id <id>          タスク ID（必須）
    --task-file <path>      タスクファイルパス（必須）

  TASK_UPDATED
    --task-id <id>          タスク ID（必須）
    --task-file <path>      タスクファイルパス（必須）

  CONDUCTOR_DONE
    --surface <surface>     Conductor の surface ID（必須）
    --success <bool>        成功/失敗（任意、デフォルト true）
    --reason <text>         理由（任意）
    --exit-code <number>    終了コード（任意）
    --session-id <id>       セッション ID（任意）
    --transcript-path <p>   トランスクリプトパス（任意）

  CONDUCTOR_REGISTERED
    --surface <surface>     Conductor の surface ID（必須）

  AGENT_SPAWNED
    --conductor-surface <s> Conductor の surface ID（必須）
    --surface <surface>     Agent の surface ID（必須）
    --role <role>           ロール名（任意）
    --task-title <title>    タスクタイトル（任意）

  SESSION_STARTED
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（必須）
    --session-id <id>       セッション ID（任意）

  SESSION_ENDED
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）
    --reason <text>         理由（任意）

  SESSION_ACTIVE
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SESSION_IDLE
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SESSION_CLEAR
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SHUTDOWN
    （オプションなし）

Examples:
  elevens send TASK_CREATED --task-id 035 --task-file .team/tasks/035-example.md
  elevens send SHUTDOWN
  elevens send CONDUCTOR_DONE --surface surface:210 --success true
`,

  help_status: `
elevens status -- チームのステータスを表示

Usage:
  elevens status [options]

Options:
  --log <N>     ログ末尾の表示行数（任意、デフォルト 10）

Examples:
  elevens status
  elevens status --log 20

Token Pool (T323):
  token pool 機能が有効な場合（CMUX_TEAM_TOKEN_POOL=1 / config / global yaml）、
  ヘッダー直後に pool 情報（capacity / next reset）を表示し、Master / Conductor /
  Agent 行に handle / 使用率 / cap_pct を付与します。OFF 時は既存レイアウト維持。
  全 token 一覧は: elevens pool status
`,

  help_spawn_conductor: `
elevens spawn-conductor -- 現在の surface で Conductor 用 Claude Code を起動・登録

Usage:
  elevens spawn-conductor [--resume <session-id>] [--task-prompt <path>] [--model <model>]

Environment:
  CMUX_SURFACE  Conductor の surface ID（任意。未指定時は cmux identify の caller.surface_ref から自動解決）

Options:
  --resume <session-id>     既存セッションを 'claude --resume' で復元（新規 session-id は発行しない）
  --task-prompt <path>      起動時にプロンプトファイルパスを CLI 引数として atomic 注入（T421/D7）
  --model <model>           使用するモデル（デフォルト: config.models.conductor or "{model}"）

Notes:
  - 通常は Manager がタスク assign 時（kill+spawn 経路）に呼び出しますが、
    cmux ペイン内から手動で実行することもできます（CMUX_SURFACE は自動検出）。
  - CONDUCTOR_REGISTERED POST で自己登録し、Manager が pre-reserved entry とマッチさせます（T421）。
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します。
  - --dangerously-skip-permissions で起動されます。
  - T421: 旧 'elevens conductor' / 'elevens resume' を本コマンドに統合しました（後方互換なし）。
`,

  help_spawn_agent: `
elevens spawn-agent -- サブエージェントを起動

Usage:
  elevens spawn-agent --conductor-surface <surface> --role <role> (--prompt <text> | --prompt-file <path>) [options]

Options:
  --conductor-surface <surface>   Conductor の surface ID（必須）
  --role <role>                   エージェントのロール名（必須）
  --prompt <text>                 インラインプロンプト（--prompt-file と排他、どちらか必須）
  --prompt-file <path>            プロンプトファイルパス（--prompt と排他、どちらか必須）
  --task-title <title>            タスクタイトル（任意、タブ名に使用）
  --model <model>                 使用するモデル（デフォルト: config.models.agent or "{model}"）

Examples:
  elevens spawn-agent --conductor-surface surface:210 --role researcher --prompt "調査してください"
  elevens spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md

Notes:
  - Conductor ペイン内にタブとして Agent を作成します
  - Fail-fast: タブ作成（pane lookup または new-surface）が失敗した場合は AGENT_SPAWN_FAILED を post して exit 1 します（new-split / focused pane への暗黙フォールバックはしません）
  - AGENT_SPAWNED メッセージが自動的にキューに送信されます
`,

  help_agents: `
elevens agents -- 稼働中のエージェント一覧を表示

Usage:
  elevens agents

Options:
  なし
`,

  help_kill_agent: `
elevens kill-agent -- エージェントを停止

Usage:
  elevens kill-agent --surface <surface>

Options:
  --surface <surface>     停止する Agent の surface ID（必須）

Examples:
  elevens kill-agent --surface surface:215
`,

  help_close_agent: `
elevens close-agent -- Agent を正常終了

Usage:
  elevens close-agent --surface <surface>

Options:
  --surface <surface>     正常終了する Agent の surface ID（必須）

Notes:
  - Agent が正常完了した場合（Inspector で GO 判定済み等）に使用する。
  - kill-agent と違い、agent done マーカーに status=completed が記録される。
  - クラッシュや強制停止には kill-agent を使う（status=crashed として記録）。

Examples:
  elevens close-agent --surface surface:215
`,

  help_send_agent: `
elevens send-agent -- この Conductor が spawn した Agent にメッセージを送る

Usage:
  elevens send-agent --surface <agent-surface> [--no-return] <message>

Options:
  --surface <agent-surface>   送信先 Agent の surface（必須）
  --no-return                 送信後の Enter を抑制
  <message>                   メッセージ本文（シェルでクォート）

Environment:
  CMUX_SURFACE                呼び出し側 Conductor の surface（未設定時は cmux identify）

Examples:
  elevens send-agent --surface surface:382 "plan.md の 3 節から再開してください"
  elevens send-agent --surface surface:382 --no-return "途中行"

Notes:
  - 呼び出し元 Conductor が spawn した Agent のみに送信可（.team/team.json で検証）
  - 自己送信や他 Conductor の Agent は拒否
  - team.json 未反映の場合は 200ms × 5 回までリトライ
`,

  help_create_task: `
elevens create-task -- タスクを作成

Usage:
  elevens create-task --title <title> [options]

Options:
  --title <title>         タスクタイトル（必須）
  --body <text>           タスク本文（任意）
  --priority <priority>   優先度: high / medium / low（任意、デフォルト medium）
  --status <status>       初期ステータス: draft / ready（任意、デフォルト draft）
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
  --base-branch <branch>  マージ先ブランチ（任意、デフォルト: 指定なし → main にマージ）
  --run-after-all         全通常タスク完了後に実行（任意）
  --exclusive             排他実行: drain 後、自身が closed になるまで他の全 assignment を停止
                          （--run-after-all を暗黙に含む。リリースや移行作業向け）
  --force                 ready 昇格時の sync state チェックをバイパス（注意して使用）
  --skip-fetch            sync state チェック前の 'git fetch' を省略
  --no-auto-pull          behind-ff + <mainBranch> checkout 時の自動 'git pull --ff-only'
                          を抑止し warn 扱いで続行する

Examples:
  elevens create-task --title "バグ修正" --status ready --body "ログイン画面のエラー"
  elevens create-task --title "新機能追加" --priority high
  elevens create-task --title "リファクタ" --depends-on "081,082" --status ready
  elevens create-task --title "hotfix" --base-branch develop --status ready
  elevens create-task --title "リリース v3.5.0" --run-after-all --status ready
  elevens create-task --title "リリース v3.53.0" --exclusive --status ready

Notes:
  - status が ready の場合、TASK_CREATED メッセージが自動送信され、
    daemon が idle Conductor に割り当てます
  - draft の場合は割り当てされません。update-task --status ready で開始できます
  - --run-after-all タスクはシステム内に1つだけ存在可能です（未クローズの
    run_after_all タスクがあるとエラーになります）
  - run_after_all タスクは全通常タスクが closed になった後に自動実行されます
  - --exclusive は --run-after-all（drain）を暗黙に含み、さらに自身が assigned の間
    他の全タスク assignment を停止します（closed になると再開）
  - --exclusive タスク同士は共存可能で、ID 昇順に順次排他実行されます。
    非排他 --run-after-all と --exclusive は共存できません（どちら側から起票しても
    create-task が RUN_AFTER_ALL_CONFLICT でエラーになります）
  - status=ready で作成するとき、local <mainBranch> と origin/<mainBranch> の整合性を
    検査し、diverged / uncommitted / detached は reject されます。
    バイパスは --force または CMUX_TEAM_SKIP_SYNC_CHECK=1
  - behind-ff かつ <mainBranch> を checkout 中の場合、elevens が
    'git pull --ff-only origin <mainBranch>' を自動実行し、失敗すると create を reject します。
    --no-auto-pull で auto-pull を抑止して warn 扱いに切り替えられます
    （他ブランチ checkout 中 / detached の behind-ff は元から warn のみ）
`,

  help_update_task: `
elevens update-task -- タスクを更新

Usage:
  elevens update-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --status <status>       新しいステータス（任意）
  --title <title>         新しいタイトル（任意）
  --body <text>           新しい本文（任意）
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
  --no-exclusive          frontmatter から exclusive: true / run_after_all: true を除去
                          （exclusive / drain 待ちセマンティクスをキャンセル）
  --force                 ready 昇格時の sync state チェックをバイパス（注意して使用）
  --skip-fetch            sync state チェック前の 'git fetch' を省略
  --no-auto-pull          behind-ff + <mainBranch> checkout 時の自動 'git pull --ff-only'
                          を抑止し warn 扱いで続行する

  ※ --status, --title, --body, --depends-on, --no-exclusive のうち少なくとも1つが必要

Examples:
  elevens update-task --task-id 035 --status ready
  elevens update-task --task-id 035 --title "新タイトル" --body "新しい説明"
  elevens update-task --task-id 035 --depends-on "081,082"
  elevens update-task --task-id 035 --no-exclusive

Notes:
  - assigned（実行中）のタスクは更新できません
  - closed のタスクは更新できません（新しいタスクを作成してください）
  - status を ready に変更すると TASK_CREATED メッセージが自動送信されます
  - ready への遷移時に local <mainBranch> と origin/<mainBranch> の整合性を検査し、
    diverged / uncommitted / detached は reject されます。バイパスは --force
    または CMUX_TEAM_SKIP_SYNC_CHECK=1
  - behind-ff かつ <mainBranch> を checkout 中の場合、elevens が
    'git pull --ff-only origin <mainBranch>' を自動実行し、失敗すると update を reject します。
    --no-auto-pull で auto-pull を抑止して warn 扱いに切り替えられます
`,

  help_close_task: `
elevens close-task -- タスクを完了（closed）にする

Usage:
  elevens close-task --task-id <id> --deliverable-kind <kind> [kind 別フラグ] [--journal <text>] [--force]

Options:
  --task-id <id>                  タスク ID（必須）
  --deliverable-kind <kind>       納品方式（必須。files / merged / pr / none のいずれか）
  --deliverable <path>            ファイルパス（kind=files のとき 1 件以上必須。複数指定可）
  --merged-into <branch>          マージ先ブランチ名（kind=merged で必須）
  --merge-sha <sha>               マージコミット SHA（kind=merged で必須）
  --pr-url <url>                  Pull Request URL（kind=pr で必須）
  --journal <text>                完了ジャーナル（任意）
  --force                         assigned（実行中）タスクを強制クローズ

Examples:
  # ローカル ff-only マージ（最も多いパターン）
  elevens close-task --task-id 035 --deliverable-kind merged \\
    --merged-into task-035/task --merge-sha $(git rev-parse task-035/task) \\
    --journal "実装完了、テストパス"

  # GitHub PR 納品
  elevens close-task --task-id 036 --deliverable-kind pr \\
    --pr-url https://github.com/owner/repo/pull/42 --journal "PR を open"

  # 調査系・ドキュメントのみ（branch を残さない納品）
  elevens close-task --task-id 037 --deliverable-kind files \\
    --deliverable .team/artifacts/A042.md --deliverable docs/spec/01-x.md \\
    --journal "リサーチ結果納品"

  # 納品物なし（例: 既に T294 で満たされていた）
  elevens close-task --task-id 038 --deliverable-kind none --journal "T294 で既に充足"

Notes:
  - --deliverable-kind は必須です。未指定時は exit 1 になります
  - kind 別フラグは排他（例: kind=merged のとき --pr-url は reject されます）
  - assigned（実行中）タスクは kind を指定しても --force が必要です
  - T295 以前の旧 closed 行は読み取り時に deliverable=undefined として扱われます
    （破壊的変更は作成側のみ）
`,

  help_abort_task: `
elevens abort-task -- 実行中タスクを中止（aborted）にする

Usage:
  elevens abort-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        中止ジャーナル（任意、デフォルト: "中断: T{id} {title}"）

Examples:
  elevens abort-task --task-id 035
  elevens abort-task --task-id 035 --journal "方針変更のため中止"

Notes:
  - assigned（実行中）のタスクのみ中止できます
  - Conductor の sub-agent と Conductor 自体を停止します
  - worktree を削除し、タスク状態を aborted に変更します
  - Conductor は自動的に idle 状態に再起動します
`,

  help_restart_task: `
elevens restart-task -- assigned または aborted のタスクを再実行（ready に戻す）

Usage:
  elevens restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        再実行ジャーナル（任意、デフォルト: "再実行: T{id} {title}"）

Examples:
  elevens restart-task --task-id 035                                    # assigned / aborted どちらでも実行可
  elevens restart-task --task-id 035 --journal "Conductor がクラッシュしたため再実行"

Notes:
  - assigned（実行中）または aborted のタスクを再実行できます
  - assigned からは abort-task と同じクリーンアップを実行（エージェント停止、worktree 削除）
  - aborted からは abort 時に残った worktree / ブランチの残骸のみ削除します
  - ステータスを aborted ではなく ready に戻します
  - TASK_CREATED 通知により自動再割り当てされます
`,

  help_clear_conductor: `
elevens clear-conductor -- broken Conductor をプールから外す（surface は閉じません）

Usage:
  elevens clear-conductor --surface <id>

Options:
  --surface <id>   surface ID（例: 112 または surface:112）

Examples:
  elevens clear-conductor --surface 112
  elevens clear-conductor --surface surface:112

Notes:
  - broken 状態の Conductor のみクリアできます
  - 他の状態は abort-task / restart-task を使ってください
  - surface には一切触れません（絶対に閉じない）。Manager がその surface を
    Conductor として扱わなくなるだけです: entry を削除し、maxConductors を 1 減らし、
    その surface からの再登録を拒否します
  - maxConductors は daemon 再起動 / "cmux-team start" で config 値に戻ります
  - worktree / branch 残骸は broken 遷移時点で既に掃除済みのため、ここでは行いません
`,

  help_reset_conductor: `
elevens reset-conductor -- Conductor surface を reserved 状態にリセットする

Usage:
  elevens reset-conductor [--surface <id>] [--force]

Options:
  --surface <id>   surface ID（例: 112 または surface:112）。省略時は
                   CMUX_SURFACE env → "cmux identify"（pane シェル）から自動解決
  --force          assigned 系（assigning / running / asking）の Conductor も
                   リセット可能にする。紐付くタスクは aborted に変更され、
                   journal に "reason=reset_conductor; ..." を記録する

Examples:
  elevens reset-conductor                                # 実行中の pane の surface をリセット
  elevens reset-conductor --surface 112
  elevens reset-conductor --surface surface:112 --force  # 実行中のタスクを止めてリセット

Notes:
  - 任意状態の Conductor（broken / disconnected / idle / reserved / error / starting）を
    "reserved" に戻し、次の tick で findIdleConductor が拾えるようにします
  - assigned 系（assigning / running / asking）は --force が必要です
  - pane で「壊れている」と気づいた瞬間に、daemon 全体を再起動せず局所復旧する用途
    （observatory: real-time 観察 → 介入のサイクルを閉じる）
`,

  help_delete_task: `
elevens delete-task -- タスクを削除（deleted）にする

Usage:
  elevens delete-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）
  --force                 closed / aborted のタスクを強制削除する（assigned は依然 abort-task が必要）

Examples:
  elevens delete-task --task-id 035
  elevens delete-task --task-id 035 --journal "不要になったため削除"
  elevens delete-task --task-id 035 --force                  # closed / aborted を強制削除

Notes:
  - draft / ready のタスクは --force なしで削除できます
  - closed / aborted のタスクは --force が必要です（assigned はまず abort-task で止めてください）
  - assigned のタスクは --force でも削除できません（abort-task / restart-task を使用）
  - deleted は終端状態で、再削除は exit 1 になります
  - task-state.json の status が deleted に設定されます
  - Journal タブに記録が残ります
`,

  help_trace_task: `
elevens trace-task -- タスクのセッション履歴を表示

Usage:
  elevens trace-task <task-id> [options]

Options:
  --no-metrics           Token Usage / By role / By model セクションを非表示にする
  --summary              要約モード（将来拡張用スタブ）

Examples:
  elevens trace-task 141
  elevens trace-task 141 --no-metrics
  elevens trace-task 141 --summary

Output includes:
  - Base 行: base branch / SHA / source（記録がある場合）
  - Deliverable 行: close-task 時に記録された納品方式（kind + 詳細）。旧行は "-"
  - Token Usage: 全体集計（requests / input / output / cache create / cache read / cache hit rate / duration）
  - By role / By model: role 別・model 別の内訳（T305 以前のタスクはフォールバック行 1 行のみ）
`,

  help_trace_hooks: `
elevens trace-hooks -- daemon が受信した hook シグナル履歴を表示

Usage:
  elevens trace-hooks [options]

Options:
  --type <TYPE>          hook type で絞り込み（SESSION_STARTED / SESSION_ENDED /
                         SESSION_IDLE / SESSION_CLEAR / AGENT_SPAWNED / SESSION_ASK /
                         CONDUCTOR_DONE / NOTIFICATION など）
  --surface <surface>    surface で絞り込み（"surface:665" / "665" / "C[665]" 受理）
  --task-run <id>        task_run_id で絞り込み（例: "task-217-1776294106"）
  --role <ROLE>          NOTIFICATION の role 列で絞り込み（master/conductor/agent/unknown）
  --task-id <id>         NOTIFICATION の task_id 列で絞り込み（例: "265"）
  --limit <N>            最大表示件数（デフォルト: 50、新しい順）
  --json                 tabular の代わりに JSON 配列を出力

Examples:
  elevens trace-hooks
  elevens trace-hooks --type SESSION_ENDED --limit 20
  elevens trace-hooks --surface C[665]
  elevens trace-hooks --task-run task-217-1776294106 --json
  elevens trace-hooks --type NOTIFICATION --role agent
  elevens trace-hooks --type NOTIFICATION --task-id 265

Notes:
  - .team/traces/traces.db の hook_signals テーブルから読み込みます
  - id DESC（新しい順）で並びます
  - DETAIL カラムには source/reason/task_run_id/question のうち値があるものだけ表示
  - NOTIFICATION 行では role/task_id/agent_role/ntype/message が DETAIL に出ます
  - question/message は 60 文字で truncate されます。完全なデータは --json を使用
`,

  help_events: `
elevens events -- events stream の tail / filter

Usage:
  elevens events [options]
  elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...

Options:
  --follow, -f             tail -F 相当（rotate 対応）。SIGINT までストリーミング
  --types <list>           カンマ区切りで event type を絞る（完全一致）
                           例: --types task_completed,task_aborted
                           空 ("" / ", ,") は exit 1
  --since <when>           しきい値より古いレコードを除外
                           duration: 5m / 1h / 2d
                           ISO 8601: 2026-04-27T12:00:00Z
  --format json|text       出力形式（既定: json -- 生の JSONL）
                           text: <ts> <event> <key=value...>（デバッグ用）

注意:
  - JSON パース失敗 / schema_version 不一致のレコードは stderr に warn を出して skip
    （spec §8 forward-compat）
  - 未知 event のレコードは stderr に warn を出して skip。ただし --types で
    明示購読された event 名は通る（spec §8.1 / §6.20 user-signal）
  - --format text は journal_summary を省略し 1 行 1 record を保つ
  - --follow は rotate 検知（inode 変化 or サイズ縮小）で新ファイル先頭から
    再出力する（重複は consumer 側で dedupe）
  - SIGINT は exit 0（graceful shutdown）。CI で SIGINT と通常 EOF を区別したい場合は
    follow-up 課題

  - 'emit' サブコマンドは free-form user signal を events.jsonl に直接 append する
    （daemon round-trip 不要 / daemon 停止中でも動く）。詳細は 'emit --help'。

Exit codes:
  0  正常終了（非 follow 時の EOF / follow 時の SIGINT）
  1  引数エラー / events.jsonl が無い
`,

  help_events_emit: `
elevens events emit -- free-form user signal を events.jsonl に append する

Usage:
  elevens events emit --type <name> [--message <text>] [--actor <id>] [--data k=v]...

Options:
  --type <name>            (必須) event type 名。snake_case 推奨。
                           'signal:' prefix を強く推奨（例: signal:deploy_started）。
  --message <text>         短い説明文（任意）
  --actor <id>             投稿主の識別子（任意）。既定: $CMUX_SURFACE。
                           --actor も CMUX_SURFACE も未設定なら record から field ごと省略
  --data k=v               メタデータ key/value。複数指定可。最初の '=' で split。
                           値は文字列固定（型推論しない）
  --help, -h               このヘルプを表示

例:
  elevens events emit --type signal:deploy_started --message "rolling out v1.2.3"
  elevens events emit --type signal:deploy_finished --data version=v1.2.3 --data env=prod

注意:
  - best-effort: lock / lease / mutex なし。POSIX O_APPEND atomicity に依存
  - daemon 停止中でも動く（CLI が events.jsonl を直接 write）
  - --type が typed daemon event の予約名（例: task_completed）と一致した場合は
    stderr に warn を出すが投稿は通す（exit 0）

Exit codes:
  0  正常終了（record append 完了 / 予約名 warn でも exit 0）
  1  引数エラー（--type 欠落 / --data 不正形式 / 未知 flag 等）
`,

  help_metrics: `
elevens metrics -- events.jsonl + hook_signals + api_usage を per-task / 期間で集計する

Subcommands:
  snapshot                 cohort 比較用に日次 snapshot JSON を書き出す。
  compare                  baseline と comparison cohort を比較（diff + 統計検定）。
  health                   直近 N 日の snapshot ファイルが揃っているか確認する。
  query                    traces.db / events.jsonl / snapshots を横断する DuckDB ad-hoc SQL を実行する。

Usage:
  elevens metrics [options]

Options:
  --task-id <id>           1 タスクにフィルタ（--group-by task=既定 のみで有効）
  --since <when>           集計の下限。
                           duration: 5m / 1h / 2d
                           ISO 8601: 2026-04-27T12:00:00Z
  --format json|text|csv   出力 format（既定: json）
                           text: key=value 1 行 / csv: RFC 4180
  --group-by task|day|week 集計キー（既定: task）
                           week は ISO week（月曜開始）

出力 (--group-by task):
  per-task オブジェクト配列: task_id, outcome, duration_ms, tool_calls, tool_failure_rate,
  time_to_first_edit_ms, tokens を含む。

出力 (--group-by day|week):
  per-bucket オブジェクト配列: tasks_assigned / completed / aborted, completion_rate, abort_rate,
  forced_close_rate, deny_rate, tool_call_total, stddev, duration mean/stddev, tokens_total を含む。

注意:
  - "deny_rate" = (PRE_TOOL_USE_DENIED 件数) / (PRE_TOOL_USE 件数) で計算される。
    現状これは Conductor の Bash deny script（cmux send / send-key の block）のみを数えており、
    PreToolUse hook が exit 2 で deny したケースを網羅していない。
    「elevens の Bash deny 率」と読むべきで、汎用的な hook block 率ではない。
  - tool call と task の紐付けは task_sessions.session_id を MIN(task_id) で集約して JOIN する。
    task_assigned 前に発火した hook（session_started 未到達）は集計から除外される。
  - tool_response.content は hook 受信時点で 1KB に切り詰められる（success / error フラグは保持）。

Exit codes:
  0  正常終了
  1  引数エラー / events.jsonl または traces.db が無い
`,

  help_metrics_snapshot: `
elevens metrics snapshot -- 1 日分の metrics snapshot を JSON として書き出す

Usage:
  elevens metrics snapshot [--date YYYY-MM-DD] [--out <path>] [--force] [--allow-outside-project]

Options:
  --date YYYY-MM-DD            snapshot 対象の日（UTC）。省略時は「昨日 UTC」。
  --out <path>                 出力ファイル（既定: .team/metrics/snapshots/YYYY-MM-DD.json）。
                               相対パスは projectRoot を起点に解決される。
  --force                      既存ファイルを上書きする。
  --allow-outside-project      --out が projectRoot 外でも許可（path traversal opt-in）。

注意:
  - snapshot_date は UTC 基準。window は [date 00:00Z, date+1 00:00Z)。
  - atomic write: temp file → fs.rename で原子的に反映するため partial write が永続化されない。
  - schema_version は increment-only / 過去 snapshot は再生成しない（fact 性を保つ）。
  - 推奨スケジュール: 00:05 UTC 日次（= JST 09:05）。前日 UTC が確定済みのタイミング。

Exit codes:
  0  snapshot 書き出し成功
  1  引数エラー / events.jsonl or traces.db 不在 / 既存ファイルあり (--force 無し)
`,

  help_metrics_compare: `
elevens metrics compare -- baseline / comparison 2 期間の cohort 比較

Usage:
  elevens metrics compare --baseline FROM..TO --comparison FROM..TO [options]

Options:
  --baseline FROM..TO          両端含む YYYY-MM-DD..YYYY-MM-DD（UTC）。
  --comparison FROM..TO        両端含む YYYY-MM-DD..YYYY-MM-DD（UTC）。
  --format json|text           出力 format（既定: json）。
  --snapshot-dir <path>        snapshot 保管ディレクトリ（既定: .team/metrics/snapshots/）。
  --allow-outside-project      --snapshot-dir が projectRoot 外でも許可。

出力:
  metrics:  metric ごとに { baseline_mean, comparison_mean, delta, delta_pct, t_test, mann_whitney }
  rates:    completion_rate / abort_rate / forced_close_rate の差分（z-test）
  alarms:   DEFAULT_ALARM_THRESHOLDS を超える signal リスト（direction を考慮）
  samples:  { baseline_n, comparison_n }
  skipped_files: schema_version 不一致 / parse 失敗で skip した snapshot
  missing:  どちらの range にも snapshot ファイルが無い YYYY-MM-DD

Exit codes:
  0  alarm なし
  1  引数エラー / IO エラー
  2  alarm あり（CI 連携用）
`,

  help_metrics_health: `
elevens metrics health -- 直近 snapshot 欠損チェック

Usage:
  elevens metrics health [--days N] [--snapshot-dir <path>] [--format json|text]

Options:
  --days N                     直近 N 日の UTC snapshot をチェック（既定: 7）。
  --snapshot-dir <path>        snapshot ディレクトリ（既定: .team/metrics/snapshots/）。
  --format json|text           出力 format（既定: json）。
  --allow-outside-project      --snapshot-dir が projectRoot 外でも許可。

出力:
  { missing: ["YYYY-MM-DD", ...], count: <欠損数>, days_checked: N }

Exit codes:
  0  欠損なし
  1  欠損あり / 引数エラー
`,

  help_metrics_query: `
elevens metrics query -- traces.db / events.jsonl / snapshots を横断する DuckDB ad-hoc SQL

Usage:
  elevens metrics query --sql '<SQL>' [--format json|csv|tsv|table] [--explain]
  echo '<SQL>' | elevens metrics query [--format ...] [--explain]

Options:
  --sql <SQL>                  実行する SQL。stdin と同時指定された場合は --sql を優先する。
  --format json|csv|tsv|table  出力 format（既定: table）。
                               DuckDB CLI flag に直結: -json / -csv / -csv -separator $'\\t' / -box。
  --explain                    user SQL を EXPLAIN で prefix（query plan を見る）。

事前 attach 済みの source（read-only）:
  t.api_usage              .team/traces/traces.db を SQLite ATTACH
  t.hook_signals           同上
  t.task_sessions          同上
  t.rate_limit_snapshots   同上
  events                   .team/logs/events.jsonl の read_json() view（newline_delimited）
  snapshots                .team/metrics/snapshots/*.json の read_json() view（1 ファイル = 1 行）
  snapshots_per_task       UNNEST(snapshots.per_task) を snapshot_date / window と pre-join

環境変数:
  DUCKDB_BIN               duckdb binary のパス（$PATH より優先）。
                           DuckDB 0.10+ 推奨（-box flag のため）。

注意:
  - 不在 source は stderr に warn を出して silent に skip。
    例: traces.db が無い fresh project でも 'SELECT 1' は通る。
  - 接続は in-memory、ATTACH は READ_ONLY。fact を mutate することはできない。
  - recipe ライブラリは analyze skill を参照（skills/cmux-team-analyze/SKILL.md）。

Exit codes:
  0  正常終了
  1  引数エラー / 'duckdb' binary 不在 / stdin が空
  *  その他は duckdb 子プロセスの exit code をそのまま relay する
`,

  help_spawn_master: `
elevens spawn-master -- Master 用 Claude Code を起動（self-register）

Usage:
  elevens spawn-master [--model <model>]

Options:
  --model <model>   使用するモデル（デフォルト: config.models.master or "{model}"）

Notes:
  - Claude Code 起動前に MASTER_REGISTERED を daemon へ POST して自己登録します
  - daemon が起動していない場合は exit 1 で失敗します（.team/proxy-port 不在）
  - 任意のペインから実行できます — 起動中の daemon に新しい Master を追加する用途に利用可能
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します
  - Master プロンプトを生成してから --dangerously-skip-permissions で起動されます
`,

  help_artifacts: `
elevens artifacts -- アーティファクト管理（add は move 動作）

Usage:
  elevens artifacts [subcommand] [options]

Subcommands:
  (なし)                  アーティファクト一覧表示（デフォルト）
  add <file>             ファイルを .team/artifacts/ に **移動** する（成功時にソース削除）
  show <id>              アーティファクトの内容を表示
  open <id>              Markdown ビューアでアーティファクトを開く
  search <query>         アーティファクトを全文検索

Options:
  --type <type>           タイプでフィルタ: research / decision / session / spec / report（任意）
  --task <id>             関連タスク ID でフィルタ（任意）
  --sort <field>          ソート基準: created / updated（任意、デフォルト created）
  --validate              全アーティファクトのフロントマターを検証
  --type <type>           (add) アーティファクトのタイプ: research / decision / session / spec / report
  --title <title>         (add) アーティファクトのタイトル
  --task <id>             (add) 関連タスク ID
  --tags <tag1,tag2>      (add) カンマ区切りのタグ
  --project-root <path>   (add) プロジェクトルートを上書き（dest の .team/artifacts/ がここ基準になる）

Examples:
  elevens artifacts
  elevens artifacts add ./research-notes.md
  elevens artifacts add ./design.md --type decision --title "認証方式の選定"
  elevens artifacts show A001
  elevens artifacts open A001
  elevens artifacts search "認証"
  elevens artifacts --type research --task T038
  elevens artifacts --validate
`,

  help_await_task: `
elevens await-task -- タスクの完了（closed/aborted）を待機する

Usage:
  elevens await-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須、カンマ区切りで複数指定可: 108,109）
  --timeout <seconds>     タイムアウト秒数（デフォルト: 3600）

完了時の挙動:
  - closed: summary.md を stdout に出力して exit 0
  - aborted: abort 理由を stderr に出力して exit 1
  - timeout: タイムアウトメッセージを stderr に出力して exit 2

Examples:
  elevens await-task --task-id 108
  elevens await-task --task-id 108,109 --timeout 7200
`,

  help_get_agent_instructions: `
elevens get-agent-instructions -- 指定 overlay ロールの project-local overlay を表示

Usage:
  elevens get-agent-instructions --role <role>

Options:
  --role <role>           overlay ロール: Agent 8 ロール + master + conductor（必須）
                          エイリアス: impl → implementer, reviewer → design-reviewer

Notes:
  - PROJECT_ROOT 配下の .team/agent-instructions/<role>.md を読みます
  - 内容を stdout に出力します（末尾改行保持）
  - overlay ファイルが無い場合は何も出力せず exit 0
  - 未知 role は stderr にエラーを出して exit 1
  - master / conductor の overlay は daemon 起動時に generateMasterPrompt /
    generateConductorRolePrompt が .team/prompts/master.md /
    .team/prompts/conductor-role.md に展開する (T342)
`,

  help_set_agent_instructions: `
elevens set-agent-instructions -- 指定 overlay ロールの project-local overlay を書き込む

Usage:
  elevens set-agent-instructions --role <role> (--body <text> | --from-file <path> | --from-stdin)

Options:
  --role <role>           overlay ロール: Agent 8 ロール + master + conductor（必須）
  --body <text>           overlay 本文をインラインテキストで指定（--from-file/--from-stdin と排他）
  --from-file <path>      overlay 本文をファイルから読み取り（排他）
  --from-stdin            overlay 本文を stdin から読み取り（排他）

Notes:
  - .team/agent-instructions/ が無ければ作成します
  - overlay 本文は 100 KB を超えるとエラー（exit 1）
  - 未知 role は exit 1（strict — overlay writer はユーザー入口のため）
  - 成功時に "OK role=<role> bytes=<n>" を stdout に出力
`,

  help_delete_agent_instructions: `
elevens delete-agent-instructions -- 指定 overlay ロールの project-local overlay を削除

Usage:
  elevens delete-agent-instructions --role <role>

Notes:
  - overlay ロール: Agent 8 ロール + master + conductor
  - 削除成功時 "DELETED=true"、存在しなかった場合 "DELETED=false" を出力
  - どちらも exit 0（削除は冪等）
  - 未知 role は stderr にエラーを出して exit 1
`,

  help_list_agent_instructions: `
elevens list-agent-instructions -- 全 overlay ロールの overlay 有無を一覧表示

Usage:
  elevens list-agent-instructions

Notes:
  - OVERLAY_ROLES の順で 1 ロール 1 行ずつ出力（Agent 8 ロール → master → conductor）
  - overlay あり: "<role> ✓ <n> bytes"
  - overlay なし: "<role> ✗"
`,

  help_main: `elevens — マルチエージェント開発オーケストレーション

Usage:
  elevens --version                          バージョン表示
  elevens start                              daemon 起動 + Master spawn
  elevens send TASK_CREATED --task-id <id> --task-file <path>
  elevens send SHUTDOWN
  elevens status                             ステータス表示
  elevens spawn-conductor [--resume <session-id>] [--task-prompt <path>] [--model <model>]
  elevens spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
                                              （Agent ロールのみ — master/conductor は overlay 専用）
  elevens agents                             稼働中エージェント一覧
  elevens close-agent --surface <surface>    Agent を正常終了
  elevens kill-agent --surface <surface>     Agent を強制停止（crash 扱い）
  elevens clear-conductor --surface <id>     broken Conductor をリセット（broken → idle）
  elevens reset-conductor [--surface <id>] [--force]   Conductor surface を reserved にリセット
  elevens send-agent --surface <surface> <message>    Agent にメッセージ送信
  elevens create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all] [--exclusive]
  elevens update-task --task-id <id> --status <status>
  elevens close-task --task-id <id> [--journal <text>]
  elevens await-task --task-id <id> [--timeout <sec>]    タスク完了待ち
  elevens abort-task --task-id <id> [--journal <text>] 実行中タスクを中止
  elevens restart-task --task-id <id> [--journal <text>] assigned または aborted のタスクを再実行
  elevens delete-task --task-id <id> [--journal <text>] タスクを削除
  elevens trace-task <task-id>              タスクのセッション履歴を表示
  elevens trace-hooks                        hook シグナル履歴を表示
  elevens events [--follow] [--types ...] [--since ...] [--format json|text]
                                              events ストリームを tail / filter（.team/logs/events.jsonl）
  elevens metrics [--task-id ...] [--since ...] [--format json|text|csv] [--group-by task|day|week]
                                              events.jsonl + hook_signals + api_usage を per-task / 期間で集計
  elevens spawn-master                      Master 起動（proxy 自動解決）
  elevens artifacts                              アーティファクト一覧
  elevens artifacts add <file>                   ファイルを .team/artifacts/ に移動
  elevens artifacts show <id>                    アーティファクト表示
  elevens artifacts open <id>                    Markdown ビューアで開く
  elevens artifacts search <query>               全文検索
  elevens artifacts --validate                   フロントマター検証
  elevens get-agent-instructions --role <role>   project-local overlay を表示（Agent ロール + master/conductor）
  elevens set-agent-instructions --role <role> (--body <t> | --from-file <p> | --from-stdin)  overlay を書き込み
  elevens delete-agent-instructions --role <role> overlay を削除
  elevens list-agent-instructions                 ロールごとの overlay 有無を一覧（10 ロール）
  elevens pool status                            token pool ダッシュボード表示 (T323)

共通オプション:
  --project-root <path>      project root を上書き（read はデフォルト許可、write は確認 prompt）
  --project-root-confirm     cross-project write gate を skip（write コマンド限定）
                             env: CMUX_TEAM_PROJECT_ROOT_CONFIRM=1 でも可

各コマンドの詳細: elevens <command> --help`,

  // ── gh-cache (T272) ───────────────────────────────────────────────────────
  gh_not_a_github_repo:
    "Error: git リポジトリ外、または origin が GitHub / GHE ではありません。\n" +
    "  elevens issue/pr は origin が github.com または Enterprise インスタンスである必要があります。",
  gh_auth_missing:
    "Error: host {host} の GitHub トークンが見つかりません。\n" +
    "  確認先: {checked}\n" +
    "以下のいずれかを実行してください:\n" +
    "  gh auth login\n" +
    "  export GITHUB_TOKEN=<your token>",
  gh_rate_limit_exhausted:
    "Error: GitHub API のレート制限に到達しました。remaining={remaining} reset_at={reset_at}\n" +
    "  `elevens issue list --stale-ok` でキャッシュから読み取れます（同期せずに表示）。",
  gh_me_not_resolved:
    "Error: @me を解決できません。先に `elevens gh sync` を実行して viewer login をキャッシュしてください。",
  gh_unknown_subcommand:
    "Unknown subcommand: {sub}. `elevens gh --help` を参照してください。",
  gh_cache_not_initialized:
    "Error: gh-cache.db が空です。先に `elevens gh sync --full` を実行してください。",
  gh_stale_warning:
    "Warning: 最後の full sync から {days} 日経過しています。`elevens gh sync --full` の実行を検討してください。",
  gh_issue_empty: "(該当する issue / PR はありません)",
  gh_sync_success:
    "同期完了 {mode}: issues={issues} comments={comments} reviews={reviews} duration={duration_ms}ms",
  gh_sync_not_modified: "変更なし (304)。last_sync={last_sync}",
  gh_status_header: "GitHub cache status",
  gh_status_last_full: "最終 full sync:        {when}",
  gh_status_last_incremental: "最終 incremental sync: {when}",
  gh_status_host: "host:                  {host}",
  gh_status_repo: "repo:                  {owner}/{repo}",
  gh_status_viewer: "viewer:                {viewer}",
  gh_status_issue_counts:
    "issue:                 {total} (open={open}, closed={closed})",
  gh_status_pr_counts:
    "PR:                    {total} (open={open}, closed={closed}, merged={merged})",
  gh_status_comments: "comments:              {count}",
  gh_status_rate: "rate limit:            {remaining} / {limit} (reset {reset})",
  gh_status_token: "token hash:            {hash}",
  gh_status_never_synced: "(未実行)",
  gh_tui_tab_title: "Issues",
  gh_tui_help_line:
    "[R] 同期  [Enter/O] ビューアで開く  [B] ブラウザで開く",
  gh_tui_syncing: "同期中...",
  gh_tui_disabled_non_git:
    "Issues タブは無効（git リポジトリでないか、origin が GitHub ではありません）。",
  gh_tui_disabled_no_auth:
    "Issues タブには認証が必要です。`gh auth login` を実行するか GITHUB_TOKEN を設定してください。",
  gh_help: `elevens gh — GitHub issue/PR キャッシュ管理

Usage:
  elevens gh sync [--full]          issue/PR を .team/gh-cache.db に同期
  elevens gh status                 キャッシュ状態とレート制限を表示

Flags:
  --full    直近 500 件の issue/PR（とその添付）を最初から取得する
            （初回実行・トークンローテーション後・月次メンテ時に使用）

--full なしの場合、If-None-Match + since= で差分だけを取得します。
非 git ディレクトリ / 非 GitHub origin は exit 2、認証欠如は exit 3、
レート制限到達は exit 4 で終了します。`,

  // ── T307: dashboard Metrics タブ ──────────────────────────────────────────────
  metrics_tab_title: "Metrics",
  metrics_section_rate_limit_projection: "Rate Limit Projection",
  metrics_section_pool_tokens: "Pool Tokens (selectable: {count})",
  metrics_long_term: "long-term",
  metrics_recent_15m: "recent 15m",
  metrics_before_reset: "before reset",
  metrics_pool_no_selectable: "(no selectable tokens)",
  metrics_pool_no_data: "no data",
  metrics_pool_marker_legend: "(* = reset passed, effectively cleared)",
  metrics_label_risk: "RISK",
  metrics_label_no_data: "no data",
  metrics_label_idle: "idle",
  metrics_loading: "loading metrics…",
  metrics_caption_from: "from: {role}/{surface} ({age}s ago)",
  metrics_proxy_idle: "proxy idle? last seen {age}s ago",
  metrics_url_label: "Open dashboard",
  metrics_url_not_running: "Web dashboard: not running",
  metrics_open_browser_hint: "Open in browser",

  // ── T435: dashboard keybinding labels (status bar / help overlay) ────────
  key_help: "ヘルプ",
  key_quit: "終了",
  key_full_quit: "完全終了",
  key_cancel: "戻る",
  key_reload: "再読込",
  key_nav_up: "上",
  key_nav_down: "下",
  key_nav_scroll: "スクロール",
  key_nav_select: "選択",
  key_nav_top: "先頭",
  key_nav_bottom: "末尾",
  key_nav_half_page_down: "半画面下",
  key_nav_half_page_up: "半画面上",
  key_tab_journal: "journal",
  key_tab_artifacts: "artifacts",
  key_tab_log: "log",
  key_tab_settings: "settings",
  key_tab_issues: "issues",
  key_tab_metrics: "metrics",
  key_tab_next: "次タブ",
  key_tab_prev: "前タブ",
  key_open_primary: "開く",
  key_open_browser: "ブラウザ",
  key_artifact_sort: "ソート",
  key_artifact_filter: "フィルタ",
  key_artifact_search: "検索 (未実装)",
  key_artifact_copy_path: "パスコピー",
  toast_copy_success: "コピー済",
  toast_copy_failed: "コピー失敗",
  toast_pbcopy_unavailable: "pbcopy が利用不可",
  chord_pending_indicator: "c-",
  key_issues_sync: "同期",
  key_modal_confirm: "はい",
  key_modal_cancel: "キャンセル",
  key_modal_full_quit_prompt: "完全終了: すべての surface を閉じてシャットダウンしますか？",
  help_overlay_title: "キーボードショートカット",
  help_overlay_hint_close: "Esc / ?: ヘルプを閉じる",
  help_category_system: "システム",
  help_category_navigation: "ナビゲーション",
  help_category_tab: "タブ",
  help_category_open: "開く",
  help_category_action: "アクション",
};

const messages = { en, ja };

/**
 * ロケールに応じたメッセージを返す。
 * vars を渡すと {key} プレースホルダーを置換する。
 */
export function t(key: keyof typeof en, vars?: Record<string, string>): string {
  const str = messages[locale][key] ?? messages.en[key] ?? key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);
}

/**
 * 明示 locale 指定版の `t()`。`t()` がプロセス起動時の `locale` に固定されるのに対し、
 * こちらは locale を引数で受け取るため、locale 切替のテスト・overlay 展開時の
 * 明示指定などに使う（T247）。
 */
export function tFor(loc: Locale, key: keyof typeof en, vars?: Record<string, string>): string {
  const str = messages[loc][key] ?? messages.en[key] ?? key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);
}
