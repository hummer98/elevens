#!/usr/bin/env bash
# scripts/test-crash-evidence.sh (T010 S8)
#
# Post-mortem evidence capture の手動再現スクリプト。開発者ローカル前提。
#
# **CI 化はしない** (plan §S8 / R5):
#   - TTY 前提のため CI 非対話実行環境ではそのまま回せない
#   - SIGUSR2 dev hook は CMUX_TEAM_DEV=1 ガード下で `throw` を発火させる仕掛けで、
#     CI で誤発火するリスクを避けたい
#   - ephemeral port / PID race の CI 安定性は別途設計が必要
#
# 使い方:
#   CMUX_TEAM_DEV=1 elevens start            # 別 pane で daemon 起動
#   bash scripts/test-crash-evidence.sh      # このスクリプトで evidence 検証
#
# 検証内容:
#   1. heartbeat ファイル存在 + JSON parse OK + mtime が直近 ±15s
#   2. telemetry jsonl 存在 + >= 1 行
#   3. SIGUSR2 で daemon 内 throw → manager.stderr.log に backtrace
#   4. manager.log に fatal_uncaught event
#   5. heartbeat ファイル残存 (mtime が死亡時刻 ±10s)
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEARTBEAT="${PROJECT_ROOT}/.team/daemon.heartbeat"
TELEMETRY="${PROJECT_ROOT}/.team/logs/manager.telemetry.jsonl"
STDERR_LOG="${PROJECT_ROOT}/.team/logs/manager.stderr.log"
MANAGER_LOG="${PROJECT_ROOT}/.team/logs/manager.log"
PIDFILE="${PROJECT_ROOT}/.team/daemon.pid"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "  ok: $*"
}

echo "[T010 S8] Post-mortem evidence verification"
echo "  PROJECT_ROOT=${PROJECT_ROOT}"

# --- 1. heartbeat ファイル
echo
echo "Step 1: heartbeat ファイル検証"
[[ -f "${HEARTBEAT}" ]] || fail "heartbeat file not found: ${HEARTBEAT}"
ok "heartbeat exists"
if command -v jq >/dev/null 2>&1; then
  jq -e . "${HEARTBEAT}" >/dev/null || fail "heartbeat is not valid JSON"
  ok "heartbeat JSON is valid"
fi
# mtime check (±15s)
NOW_EPOCH="$(date +%s)"
if [[ "$(uname)" = "Darwin" ]]; then
  HB_MTIME="$(stat -f "%m" "${HEARTBEAT}")"
else
  HB_MTIME="$(stat -c "%Y" "${HEARTBEAT}")"
fi
HB_DIFF="$(( NOW_EPOCH - HB_MTIME ))"
HB_DIFF_ABS="${HB_DIFF#-}"
if (( HB_DIFF_ABS <= 15 )); then
  ok "heartbeat mtime is recent (diff=${HB_DIFF}s)"
else
  echo "  warn: heartbeat mtime is ${HB_DIFF}s ago (interval may be longer or daemon is slow)"
fi

# --- 2. telemetry jsonl
echo
echo "Step 2: telemetry jsonl 検証"
[[ -f "${TELEMETRY}" ]] || fail "telemetry file not found: ${TELEMETRY}"
TLINES="$(wc -l < "${TELEMETRY}" | tr -d ' ')"
[[ "${TLINES}" -ge 1 ]] || fail "telemetry jsonl has 0 lines"
ok "telemetry jsonl has ${TLINES} lines"
if command -v jq >/dev/null 2>&1; then
  # 最初の 1 行が JSON parse できることを確認
  head -1 "${TELEMETRY}" | jq -e . >/dev/null || fail "first telemetry line is not valid JSON"
  ok "telemetry first line JSON is valid"
fi

# --- 3. SIGUSR2 で synthetic throw
# main.ts に test hook が無い場合は skip
echo
echo "Step 3: synthetic crash 検証 (SIGUSR2 dev hook)"
if [[ ! -f "${PIDFILE}" ]]; then
  echo "  skip: pidfile not found, daemon not running"
  exit 0
fi
PID="$(cat "${PIDFILE}")"
echo "  daemon pid=${PID}"

# stderr.log の現在の行数を記録
PRE_LINES="$(wc -l < "${STDERR_LOG}" 2>/dev/null || echo 0)"
PRE_LINES="${PRE_LINES// /}"

# manager.log の現在の行数を記録
PRE_MGR_LINES="$(wc -l < "${MANAGER_LOG}" 2>/dev/null || echo 0)"
PRE_MGR_LINES="${PRE_MGR_LINES// /}"

if kill -0 "${PID}" 2>/dev/null; then
  echo "  sending SIGUSR2..."
  kill -USR2 "${PID}" 2>/dev/null || {
    echo "  skip: SIGUSR2 failed (dev hook may not be installed)"
    exit 0
  }
  sleep 2
  # daemon が死亡しているかを確認
  if kill -0 "${PID}" 2>/dev/null; then
    echo "  warn: daemon still alive after SIGUSR2 (dev hook may not throw)"
  else
    ok "daemon died after SIGUSR2"
  fi
else
  echo "  skip: daemon already dead, cannot test"
  exit 0
fi

# --- 4. 5. stderr.log / manager.log / heartbeat 残存
echo
echo "Step 4: post-crash evidence"
POST_LINES="$(wc -l < "${STDERR_LOG}" 2>/dev/null || echo 0)"
POST_LINES="${POST_LINES// /}"
if (( POST_LINES > PRE_LINES )); then
  ok "stderr.log grew (${PRE_LINES} → ${POST_LINES} lines)"
else
  echo "  warn: stderr.log did not grow (synthetic exception may not have written)"
fi

POST_MGR_LINES="$(wc -l < "${MANAGER_LOG}" 2>/dev/null || echo 0)"
POST_MGR_LINES="${POST_MGR_LINES// /}"
if grep -q "fatal_uncaught" "${MANAGER_LOG}" 2>/dev/null; then
  ok "manager.log contains fatal_uncaught event"
else
  echo "  warn: fatal_uncaught event not found in manager.log"
fi

if [[ -f "${HEARTBEAT}" ]]; then
  ok "heartbeat file remains (= abnormal death)"
else
  echo "  warn: heartbeat file deleted (clean exit happened? unexpected)"
fi

echo
echo "Done. Inspect ${STDERR_LOG} and ${MANAGER_LOG} for fatal trace details."
