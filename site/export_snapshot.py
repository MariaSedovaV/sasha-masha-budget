"""Снимок API для GitHub Pages / офлайн."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from engine.db import get_meta, init_db, ledger_rows, list_key_events, pack_ledger
from engine.insights import build_insights
from engine.markets import fetch_markets
from engine.share import build_share

OUT = Path(__file__).resolve().parent / "static" / "snapshot"
DOCS_OUT = Path(__file__).resolve().parent.parent / "docs" / "static" / "snapshot"


def main(also_docs: bool = True) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = init_db()
    rows = ledger_rows(conn, None)
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    until = int(get_meta(conn, "fact_until", str(closed)) or closed)
    excel = get_meta(conn, "excel_file")
    stored = list_key_events(conn)
    updated_at = get_meta(conn, "updated_at")
    structure_ok = get_meta(conn, "structure_ok", "1") != "0"
    structure_error = get_meta(conn, "structure_error") or ""
    conn.close()

    analytics = build_insights(rows, 2026, closed, until, stored)
    analytics["updated_at"] = updated_at
    rows_2026 = [r for r in rows if r.get("year", 2026) == 2026]
    share = build_share(rows_2026, closed)
    try:
        markets = fetch_markets()
    except Exception:
        markets = {"usd": None, "thb": None, "gold_gram": None, "error": "нет связи"}

    ledger = pack_ledger(rows_2026, closed)
    ledger["key_events"] = analytics.get("key_events") or stored
    ledger["updated_at"] = updated_at

    payloads = {
        "analytics": analytics,
        "share": share,
        "markets": markets,
        "health": {
            "ok": True,
            "excel": excel,
            "closed_month": closed,
            "fact_until": until,
            "updated_at": updated_at,
            "structure_ok": structure_ok,
            "structure_error": structure_error,
        },
        "ledger": ledger,
    }
    for name, data in payloads.items():
        (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    if also_docs:
        DOCS_OUT.mkdir(parents=True, exist_ok=True)
        for name in payloads:
            shutil.copy2(OUT / f"{name}.json", DOCS_OUT / f"{name}.json")
    print("wrote", list(OUT.glob("*.json")))


if __name__ == "__main__":
    main()
