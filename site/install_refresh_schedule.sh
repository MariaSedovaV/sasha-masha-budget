#!/bin/zsh
set -euo pipefail
ROOT="/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета"
PLIST_SRC="$ROOT/site/launchd/com.sasha-masha.budget-refresh.plist"
DEST="$HOME/Library/LaunchAgents/com.sasha-masha.budget-refresh.plist"
chmod +x "$ROOT/site/refresh_from_excel.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/site/data"
cp "$PLIST_SRC" "$DEST"
launchctl bootout "gui/$(id -u)/com.sasha-masha.budget-refresh" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/com.sasha-masha.budget-refresh"
echo "Расписание: каждый день в 21:00 — обновление графиков из Excel (с проверкой структуры)."
launchctl print "gui/$(id -u)/com.sasha-masha.budget-refresh" | grep -E "state =|runs =|interval|Weekday|Hour" || true
