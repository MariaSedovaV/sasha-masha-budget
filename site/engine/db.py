"""SQLite-хранилище плана, факта, импортов и операций."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "budget.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    plan REAL NOT NULL DEFAULT 0,
    fact REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'excel',
    PRIMARY KEY (year, month, category)
);

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    created_at TEXT,
    period_from TEXT,
    period_to TEXT,
    holder TEXT,
    status TEXT DEFAULT 'draft',
    tx_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    op_date TEXT NOT NULL,
    op_time TEXT,
    amount REAL NOT NULL,
    orig_amount REAL,
    orig_ccy TEXT,
    description TEXT,
    card TEXT,
    year INTEGER,
    month INTEGER,
    category TEXT,
    confidence INTEGER,
    included INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (import_id) REFERENCES imports(id)
);

CREATE TABLE IF NOT EXISTS merchant_map (
    needle TEXT PRIMARY KEY,
    category TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> sqlite3.Connection:
    conn = connect()
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def pack_ledger(rows: list[dict[str, Any]], closed: int) -> dict[str, Any]:
    from .categories import ALL_CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, MONTHS_RU

    by_cat: dict[str, dict] = {}
    for r in rows:
        item = by_cat.setdefault(
            r["category"],
            {"category": r["category"], "kind": r["kind"], "plan": [0] * 12, "fact": [0] * 12, "source": [""] * 12},
        )
        item["plan"][r["month"] - 1] = r["plan"]
        item["fact"][r["month"] - 1] = r["fact"]
        item["source"][r["month"] - 1] = r["source"]
    return {
        "year": 2026,
        "months": MONTHS_RU[1:],
        "closed_month": closed,
        "income": [by_cat[c] for c in INCOME_CATEGORIES if c in by_cat],
        "expense": [by_cat[c] for c in EXPENSE_CATEGORIES if c in by_cat],
        "categories": ALL_CATEGORIES,
    }


def ledger_rows(conn: sqlite3.Connection, year: int | None = 2026) -> list[dict[str, Any]]:
    if year is None:
        rows = conn.execute(
            "SELECT * FROM ledger ORDER BY year, kind, category, month"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM ledger WHERE year = ? ORDER BY kind, category, month",
            (year,),
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_ledger(
    conn: sqlite3.Connection,
    year: int,
    month: int,
    category: str,
    kind: str,
    plan: float | None = None,
    fact: float | None = None,
    source: str = "manual",
) -> None:
    row = conn.execute(
        "SELECT plan, fact FROM ledger WHERE year=? AND month=? AND category=?",
        (year, month, category),
    ).fetchone()
    if row:
        new_plan = row["plan"] if plan is None else plan
        new_fact = row["fact"] if fact is None else fact
        conn.execute(
            "UPDATE ledger SET plan=?, fact=?, source=? WHERE year=? AND month=? AND category=?",
            (new_plan, new_fact, source, year, month, category),
        )
    else:
        conn.execute(
            "INSERT INTO ledger(year, month, category, kind, plan, fact, source) VALUES(?,?,?,?,?,?,?)",
            (year, month, category, kind, plan or 0, fact or 0, source),
        )
