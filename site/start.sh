#!/bin/zsh
cd "$(dirname "$0")"
if [ ! -x ../.venv/bin/python ]; then
  python3 -m venv ../.venv
  ../.venv/bin/pip install -r requirements.txt
fi
echo "Sasha & Masha | Мониторинг бюджета"
echo "Откройте http://127.0.0.1:8765"
echo "Если порт занят: ../.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8766"
../.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8765
