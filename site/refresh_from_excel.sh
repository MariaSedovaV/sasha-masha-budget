#!/bin/zsh
set -euo pipefail
ROOT="/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета"
SITE="$ROOT/site"
LOGDIR="$SITE/data"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/refresh.log"
exec >>"$LOG" 2>&1
echo "---- $(date '+%Y-%m-%d %H:%M:%S') ----"
cd "$SITE"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PY="$ROOT/.venv/bin/python"
else
  PY="$(command -v python3)"
fi
export PYTHONPATH="$SITE"
"$PY" "$SITE/refresh_from_excel.py" --publish
echo "ok"
