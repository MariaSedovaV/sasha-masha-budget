"""Sasha & Masha | Мониторинг бюджета."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine.categories import (
    ALL_CATEGORIES,
    EXPENSE_CATEGORIES,
    FILTER_GROUPS,
    INCOME_CATEGORIES,
    MONTHS_RU,
)
from engine.categorize import categorize
from engine.db import get_meta, init_db, ledger_rows, set_meta, upsert_ledger
from engine.insights import build_insights
from engine.markets import fetch_markets
from engine.pdf_parse import parse_statement_pdf
from engine.seed_excel import seed_from_excel
from engine.share import build_share

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="Sasha & Masha | Мониторинг бюджета")


@app.on_event("startup")
def startup() -> None:
    conn = init_db()
    if get_meta(conn, "seeded") != "1":
        seed_from_excel(conn)
    conn.close()


class CellPatch(BaseModel):
    year: int
    month: int
    category: str
    field: str
    value: float


class TxPatch(BaseModel):
    category: Optional[str] = None
    included: Optional[bool] = None


class MerchantPatch(BaseModel):
    needle: str
    category: str


class ApplyBody(BaseModel):
    year: int
    month: int
    replace_categories: Optional[List[str]] = None


def _learned(conn):
    rows = conn.execute("SELECT needle, category FROM merchant_map").fetchall()
    return [(r["needle"], r["category"]) for r in rows]


@app.get("/api/health")
def health():
    conn = init_db()
    excel = get_meta(conn, "excel_file")
    closed = get_meta(conn, "closed_month", "7")
    conn.close()
    return {"ok": True, "excel": excel, "closed_month": int(closed)}


@app.get("/api/ledger")
def api_ledger(year: int = 2026):
    conn = init_db()
    rows = ledger_rows(conn, year)
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    conn.close()
    by_cat: dict[str, dict] = {}
    for r in rows:
        item = by_cat.setdefault(
            r["category"],
            {"category": r["category"], "kind": r["kind"], "plan": [0] * 12, "fact": [0] * 12, "source": [""] * 12},
        )
        item["plan"][r["month"] - 1] = r["plan"]
        item["fact"][r["month"] - 1] = r["fact"]
        item["source"][r["month"] - 1] = r["source"]
    income = [by_cat[c] for c in INCOME_CATEGORIES if c in by_cat]
    expense = [by_cat[c] for c in EXPENSE_CATEGORIES if c in by_cat]
    return {
        "year": year,
        "months": MONTHS_RU[1:],
        "closed_month": closed,
        "income": income,
        "expense": expense,
        "categories": ALL_CATEGORIES,
    }


@app.patch("/api/ledger")
def api_patch_ledger(body: CellPatch):
    if body.field not in ("plan", "fact"):
        raise HTTPException(400, "field must be plan or fact")
    kind = "income" if body.category in INCOME_CATEGORIES else "expense"
    conn = init_db()
    upsert_ledger(
        conn,
        body.year,
        body.month,
        body.category,
        kind,
        plan=body.value if body.field == "plan" else None,
        fact=body.value if body.field == "fact" else None,
        source="manual",
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/analytics")
def api_analytics(year: int = 2026):
    conn = init_db()
    rows = ledger_rows(conn, year)
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    data = build_insights(rows, year, closed)
    conn.close()
    data["filter_groups"] = FILTER_GROUPS
    return data


@app.get("/api/share")
def api_share(year: int = 2026):
    conn = init_db()
    rows = ledger_rows(conn, year)
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    data = build_share(rows, closed)
    conn.close()
    return data


@app.get("/api/taxonomy")
def api_taxonomy():
    return {
        "categories": ALL_CATEGORIES,
        "income": INCOME_CATEGORIES,
        "expense": EXPENSE_CATEGORIES,
        "filter_groups": FILTER_GROUPS,
        "months": MONTHS_RU[1:],
    }


@app.get("/api/transactions")
def api_list_tx(
    q: str = "",
    month: Optional[int] = None,
    import_id: Optional[int] = None,
    limit: int = 500,
):
    conn = init_db()
    sql = "SELECT * FROM transactions WHERE 1=1"
    args: list = []
    if import_id:
        sql += " AND import_id=?"
        args.append(import_id)
    if month:
        sql += " AND month=?"
        args.append(month)
    if q:
        sql += " AND LOWER(description) LIKE ?"
        args.append(f"%{q.lower()}%")
    sql += " ORDER BY op_date DESC, id DESC LIMIT ?"
    args.append(limit)
    rows = conn.execute(sql, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/markets")
def api_markets(force: int = 0):
    return fetch_markets(force=bool(force))


@app.get("/api/merchants")
def api_merchants():
    conn = init_db()
    rows = conn.execute("SELECT needle, category FROM merchant_map ORDER BY needle").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/merchants")
def api_merchant_save(body: MerchantPatch):
    needle = (body.needle or "").strip().lower()
    if not needle:
        raise HTTPException(400, "empty needle")
    conn = init_db()
    conn.execute(
        "INSERT INTO merchant_map(needle, category) VALUES(?, ?) "
        "ON CONFLICT(needle) DO UPDATE SET category=excluded.category",
        (needle, body.category),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/merchants")
def api_merchant_delete(needle: str):
    conn = init_db()
    conn.execute("DELETE FROM merchant_map WHERE needle=?", (needle.lower(),))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/imports")
def api_imports():
    conn = init_db()
    rows = conn.execute("SELECT * FROM imports ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/imports/{import_id}")
def api_import_detail(import_id: int):
    conn = init_db()
    imp = conn.execute("SELECT * FROM imports WHERE id=?", (import_id,)).fetchone()
    if not imp:
        conn.close()
        raise HTTPException(404, "import not found")
    txs = conn.execute(
        "SELECT * FROM transactions WHERE import_id=? ORDER BY op_date, op_time",
        (import_id,),
    ).fetchall()
    conn.close()
    return {"import": dict(imp), "transactions": [dict(t) for t in txs]}


@app.patch("/api/transactions/{tx_id}")
def api_patch_tx(tx_id: int, body: TxPatch):
    conn = init_db()
    row = conn.execute("SELECT * FROM transactions WHERE id=?", (tx_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "transaction not found")
    if body.category:
        conn.execute("UPDATE transactions SET category=? WHERE id=?", (body.category, tx_id))
        needle = (row["description"] or "").strip()[:80]
        if needle:
            conn.execute(
                "INSERT INTO merchant_map(needle, category) VALUES(?, ?) "
                "ON CONFLICT(needle) DO UPDATE SET category=excluded.category",
                (needle.lower(), body.category),
            )
    if body.included is not None:
        conn.execute("UPDATE transactions SET included=? WHERE id=?", (1 if body.included else 0, tx_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Нужен PDF справки о движении средств")
    data = await file.read()
    parsed = parse_statement_pdf(data)
    if parsed["count"] == 0:
        raise HTTPException(400, "Не удалось прочитать операции из PDF")

    conn = init_db()
    learned = _learned(conn)
    now = datetime.now().isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO imports(filename, created_at, period_from, period_to, holder, status, tx_count) "
        "VALUES(?,?,?,?,?,?,?)",
        (
            file.filename,
            now,
            parsed["header"].get("period_from"),
            parsed["header"].get("period_to"),
            parsed["header"].get("holder"),
            "draft",
            parsed["count"],
        ),
    )
    import_id = cur.lastrowid
    for tx in parsed["transactions"]:
        cat, conf = categorize(tx["description"], tx["amount"], learned)
        conn.execute(
            "INSERT INTO transactions(import_id, op_date, op_time, amount, orig_amount, orig_ccy, "
            "description, card, year, month, category, confidence, included) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                import_id,
                tx["op_date"],
                tx["op_time"],
                tx["amount"],
                tx["orig_amount"],
                tx["orig_ccy"],
                tx["description"],
                tx["card"],
                tx["year"],
                tx["month"],
                cat,
                conf,
                0 if cat in ("Между своими счетами", "Кэшбэк") else 1,
            ),
        )
    conn.commit()
    conn.close()
    return {"import_id": import_id, "count": parsed["count"], "header": parsed["header"]}


@app.get("/api/imports/{import_id}/summary")
def api_import_summary(import_id: int, year: int = 2026, month: Optional[int] = None):
    conn = init_db()
    txs = conn.execute(
        "SELECT * FROM transactions WHERE import_id=? AND included=1",
        (import_id,),
    ).fetchall()
    conn.close()
    if month:
        txs = [t for t in txs if t["year"] == year and t["month"] == month]
    by_cat: dict[str, float] = {}
    by_month: dict[int, dict[str, float]] = {}
    for t in txs:
        # расходы — отрицательные суммы; в FCF храним абсолют расходов
        if t["amount"] < 0:
            add = -t["amount"]
            if t["category"] in INCOME_CATEGORIES:
                continue
        else:
            add = t["amount"]
        by_cat[t["category"]] = by_cat.get(t["category"], 0) + add
        mm = by_month.setdefault(t["month"], {})
        mm[t["category"]] = mm.get(t["category"], 0) + add
    return {"by_category": by_cat, "by_month": by_month}


@app.post("/api/imports/{import_id}/apply")
def api_apply(import_id: int, body: ApplyBody):
    conn = init_db()
    txs = conn.execute(
        "SELECT * FROM transactions WHERE import_id=? AND included=1 AND year=? AND month=?",
        (import_id, body.year, body.month),
    ).fetchall()
    if not txs:
        conn.close()
        raise HTTPException(400, "Нет операций за выбранный месяц")

    totals: dict[str, float] = {}
    for t in txs:
        cat = t["category"]
        if cat in ("Между своими счетами", "Кэшбэк"):
            continue
        if t["amount"] < 0:
            if cat in INCOME_CATEGORIES:
                continue
            totals[cat] = totals.get(cat, 0) + (-t["amount"])
        else:
            if cat in EXPENSE_CATEGORIES:
                totals[cat] = totals.get(cat, 0) - t["amount"]  # возврат уменьшает расход
            else:
                totals[cat] = totals.get(cat, 0) + t["amount"]

    allowed = set(body.replace_categories or (INCOME_CATEGORIES + EXPENSE_CATEGORIES))
    for cat, value in totals.items():
        if cat not in allowed:
            continue
        kind = "income" if cat in INCOME_CATEGORIES else "expense"
        fact_value = max(0, value) if kind == "expense" else value
        upsert_ledger(conn, body.year, body.month, cat, kind, fact=fact_value, source="import")

    conn.execute("UPDATE imports SET status='applied' WHERE id=?", (import_id,))
    closed = int(get_meta(conn, "closed_month", "7") or 7)
    if body.month > closed:
        set_meta(conn, "closed_month", str(body.month))
    conn.commit()
    conn.close()
    return {"ok": True, "updated": list(totals.keys())}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
