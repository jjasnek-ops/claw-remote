#!/bin/bash
# Clear stale claw-openclaw.py listeners before systemd starts a backend.
set -euo pipefail

PORT="${1:?usage: clear-claw-port.sh <port>}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

PIDS="$(ss -H -tlnp "sport = :${PORT}" 2>/dev/null \
  | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
  | sort -u)"

if [[ -z "$PIDS" ]]; then
  exit 0
fi

for pid in $PIDS; do
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [[ "$cmd" != *"claw-openclaw.py"* ]]; then
    echo "Port $PORT is occupied by non-claw process $pid: $cmd" >&2
    exit 1
  fi

  echo "Stopping stale claw-openclaw.py listener on port $PORT: pid=$pid"
  kill -INT "$pid" 2>/dev/null || true
done

for _ in $(seq 1 10); do
  if ! ss -H -tlnp "sport = :${PORT}" 2>/dev/null | grep -q .; then
    exit 0
  fi
  sleep 1
done

for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing stale claw-openclaw.py listener on port $PORT: pid=$pid"
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

if ss -H -tlnp "sport = :${PORT}" 2>/dev/null | grep -q .; then
  echo "Port $PORT is still occupied after cleanup" >&2
  exit 1
fi
