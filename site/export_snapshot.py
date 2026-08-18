"""Снимок API для GitHub Pages / офлайн."""

from __future__ import annotations

import json
from pathlib import Path

from engine.categories import FILTER_GROUPS
from engine.db import get_meta, init_db, ledger_rows, pack_ledger
from engine.insights import build_insights
from engine.markets import fetch_markets
from engine.share import build_share

OUT = Path(__file__).resolve().parent / "static" / "snapshot"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = init_db()
    rows = ledger_rows(conn, 2026)
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    excel = get_meta(conn, "excel_file")
    conn.close()

    analytics = build_insights(rows, 2026, closed)
    analytics["filter_groups"] = FILTER_GROUPS
    share = build_share(rows, closed)
    try:
        markets = fetch_markets()
    except Exception:
        markets = {"usd": None, "thb": None, "gold_gram": None, "error": "нет связи"}

    payloads = {
        "analytics": analytics,
        "share": share,
        "markets": markets,
        "health": {"ok": True, "excel": excel, "closed_month": closed},
        "ledger": pack_ledger(rows, closed),
    }
    for name, data in payloads.items():
        (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    print("wrote", list(OUT.glob("*.json")))


if __name__ == "__main__":
    main()
