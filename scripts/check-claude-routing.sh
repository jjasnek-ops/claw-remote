#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOADER="${CLAUDE_RUNTIME_LOADER:-$SCRIPT_DIR/load_claude_runtime_env.py}"
CONFIG_PATH="${CLAUDE_RUNTIME_ROUTING_FILE:-/root/.claude/runtime-routing.json}"
SETTINGS_PATH="/root/.claude/settings.json"

echo "Config: $CONFIG_PATH"
echo

echo "[routes + backends]"
python3 - <<'PY'
import json
from pathlib import Path

path = Path("/root/.claude/runtime-routing.json")
if not path.exists():
    print("missing")
    raise SystemExit(0)

data = json.loads(path.read_text())
print(json.dumps(data, indent=2, ensure_ascii=False))
PY
echo

echo "[manual]"
python3 "$LOADER" manual --config "$CONFIG_PATH" --format pretty
echo

echo "[dispatch]"
python3 "$LOADER" dispatch --config "$CONFIG_PATH" --format pretty
echo

echo "[settings.json ANTHROPIC_*]"
python3 - <<'PY'
import json
from pathlib import Path

path = Path("/root/.claude/settings.json")
if not path.exists():
    print("missing")
    raise SystemExit(0)

obj = json.loads(path.read_text())
env = obj.get("env", {})
anthropic = {k: v for k, v in env.items() if k.startswith("ANTHROPIC_")}
print(json.dumps(anthropic, indent=2, ensure_ascii=False))
PY
echo

echo "[current shell ANTHROPIC_*]"
env | grep '^ANTHROPIC_' || echo "(none)"
