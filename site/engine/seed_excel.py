"""Загрузка плана и факта из Excel FCF в SQLite."""

from __future__ import annotations

from pathlib import Path

import openpyxl

from .categories import EXPENSE_CATEGORIES, INCOME_CATEGORIES
from .db import set_meta, upsert_ledger

EXCEL_CANDIDATES = [
    Path("/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета/5.09.2026_Бюджет 2026.xlsx"),
    Path("/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета/16.08.2026_Бюджет 2026.xlsx"),
    Path("/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета/16.07.2026_Бюджет 2026.xlsx"),
]

PLAN_INCOME = {
    "Зарплата Саша": 5,
    "Премия Саша": 6,
    "Продажа квартиры Саша": 7,
    "Зарплата Маша": 8,
    "Премия Маша": 9,
    "Займы": 10,
    "Подарки": 11,
}
PLAN_EXPENSE = {
    "Ипотека платеж": 20,
    "Дедушка долг": 21,
    "Ремонт квартиры": 22,  # в Excel: «Ремонт в квартире»
    "Квартира Тайланд": 23,
    "Свадебное путешествие": 24,
    "Саша учеба": 25,
    "Парковка": 26,
    "Отпуска": 27,
    "Страховка": 28,
    "Налоги": 29,
    "Ребенок": 30,
    "Супермаркеты": 31,
    "Такси": 32,
    "Рестораны": 33,
    "Одежда и обувь": 34,
    "Квартплата": 35,
    "Мобильная связь": 36,
    "Товары для дома": 37,
    "Косметика": 38,
    "Развлечения": 39,
    "Бьюти процедуры": 40,
    "Парковки и штрафы": 41,
    "Бензин": 42,
    "Переводы": 43,
    "Прочее": 44,
    "Расходы на семьи": 45,
    "Подарки друг другу": 46,
    "Крупные покупки": 47,
    "Абонемент в спорт-зал": 48,
}
FACT_INCOME = PLAN_INCOME
FACT_EXPENSE = {
    "Ипотека платеж": 25,
    "Дедушка долг": 26,
    "Ремонт квартиры": 27,
    "Квартира Тайланд": 28,
    "Свадебное путешествие": 29,
    "Саша учеба": 30,
    "Парковка": 31,
    "Отпуска": 32,
    "Страховка": 33,
    "Налоги": 34,
    "Ребенок": 35,
    "Супермаркеты": 36,
    "Такси": 37,
    "Рестораны": 38,
    "Одежда и обувь": 39,
    "Квартплата": 40,
    "Мобильная связь": 41,
    "Товары для дома": 42,
    "Косметика": 43,
    "Развлечения": 44,
    "Бьюти процедуры": 45,
    "Парковки и штрафы": 46,
    "Бензин": 47,
    "Переводы": 48,
    "Прочее": 49,
    "Расходы на семьи": 50,
    "Подарки друг другу": 51,
    "Крупные покупки": 52,
    "Абонемент в спорт-зал": 53,
}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def find_excel() -> Path | None:
    root = Path("/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета")
    files = [
        p for p in root.glob("*Бюджет 2026.xlsx")
        if p.is_file() and not p.name.startswith("~$") and not p.name.startswith(".")
    ]
    if files:
        return max(files, key=lambda p: p.stat().st_mtime)
    for path in EXCEL_CANDIDATES:
        if path.exists() and not path.name.startswith("~$"):
            return path
    return None


def _month_fact_stats(plan_ws, fact_ws, month: int) -> dict:
    fc = 2 + month
    pc = 3 + (month - 1)
    eq = nz_f = 0
    inc_f = exp_f = inc_p = 0.0
    for cat, row in FACT_INCOME.items():
        fv = fact_ws.cell(row, fc).value
        pv = plan_ws.cell(PLAN_INCOME[cat], pc).value
        fn, pn = _num(fv), _num(pv)
        inc_f += fn
        inc_p += pn
        if abs(fn) > 0.5:
            nz_f += 1
        if fv is not None and abs(fn - pn) < 1:
            eq += 1
    for cat, row in FACT_EXPENSE.items():
        fv = fact_ws.cell(row, fc).value
        pv = plan_ws.cell(PLAN_EXPENSE[cat], pc).value
        fn, pn = _num(fv), _num(pv)
        exp_f += fn
        if abs(fn) > 0.5:
            nz_f += 1
        if fv is not None and abs(fn - pn) < 1:
            eq += 1
    income_matches = abs(inc_f - inc_p) <= 1
    plan_echo = income_matches and eq >= 10 and eq >= 0.7 * max(nz_f, 1)
    actual = (not plan_echo) and nz_f > 0
    complete = actual and inc_f > 1000 and nz_f >= 12
    return {
        "actual": actual,
        "complete": complete,
        "plan_echo": plan_echo,
        "nz": nz_f,
        "income": inc_f,
        "expense": exp_f,
    }


def classify_fact_months(plan_ws, fact_ws) -> tuple[int, int]:
    """Последний закрытый месяц и последний месяц с живым фактом (не копия плана)."""
    closed = 0
    until = 0
    for month in range(1, 13):
        stats = _month_fact_stats(plan_ws, fact_ws, month)
        if not stats["actual"]:
            continue
        until = month
        if stats["complete"]:
            closed = month
    if not until:
        until = closed or 8
    if not closed:
        closed = until
    return closed, until


def seed_from_excel(conn, path: Path | None = None) -> str:
    excel = path or find_excel()
    if not excel:
        raise FileNotFoundError("Не найден файл бюджета Excel")

    from .excel_fcf import clear_excel_cache
    from .excel_sync import ExcelStructureError, now_stamp, read_events_sheet, validate_excel
    from .db import replace_key_events

    clear_excel_cache()
    try:
        validate_excel(excel)
        set_meta(conn, "structure_ok", "1")
        set_meta(conn, "structure_error", "")
    except ExcelStructureError as exc:
        set_meta(conn, "structure_ok", "0")
        set_meta(conn, "structure_error", str(exc))
        conn.commit()
        raise

    wb = openpyxl.load_workbook(excel, data_only=True)
    plan = wb["FCF 2026 ПЛАН"]
    fact = wb["FCF 2026 ФАКТ"]
    closed, fact_until = classify_fact_months(plan, fact)

    # План: колонки по годам 2026–2040 (по 12 месяцев), как в Excel
    for year in range(2026, 2041):
        for month in range(1, 13):
            col = 3 + (year - 2026) * 12 + (month - 1)
            for cat, row in PLAN_INCOME.items():
                upsert_ledger(
                    conn, year, month, cat, "income",
                    plan=_num(plan.cell(row, col).value), source="excel",
                )
            for cat, row in PLAN_EXPENSE.items():
                upsert_ledger(
                    conn, year, month, cat, "expense",
                    plan=_num(plan.cell(row, col).value), source="excel",
                )

    # Факт только 2026. Окт–дек в листе ФАКТ часто = копия плана — это не факт.
    year = 2026
    for month in range(1, 13):
        col = 2 + month  # C=3 for January
        live = month <= fact_until
        src = "excel" if month <= closed else ("partial" if live else "forecast")
        for cat, row in FACT_INCOME.items():
            upsert_ledger(
                conn, year, month, cat, "income",
                fact=_num(fact.cell(row, col).value) if live else 0.0,
                source=src,
            )
        for cat, row in FACT_EXPENSE.items():
            upsert_ledger(
                conn, year, month, cat, "expense",
                fact=_num(fact.cell(row, col).value) if live else 0.0,
                source=src,
            )

    set_meta(conn, "excel_file", excel.name)
    set_meta(conn, "excel_mtime", str(int(excel.stat().st_mtime)))
    set_meta(conn, "seeded", "1")
    set_meta(conn, "closed_month", str(closed))
    set_meta(conn, "fact_until", str(fact_until))
    set_meta(conn, "updated_at", now_stamp())
    sheet_events = read_events_sheet(excel)
    if sheet_events is not None:
        replace_key_events(conn, sheet_events)
    conn.commit()
    return excel.name
