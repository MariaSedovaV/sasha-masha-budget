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
    "Ипотека платеж": 19,
    "Дедушка долг": 20,
    "Ремонт квартиры": 21,
    "Квартира Тайланд": 22,
    "Свадебное путешествие": 23,
    "Саша учеба": 24,
    "Парковка": 25,
    "Отпуска": 26,
    "Страховка": 27,
    "Налоги": 28,
    "Ребенок": 29,
    "Супермаркеты": 30,
    "Такси": 31,
    "Рестораны": 32,
    "Одежда и обувь": 33,
    "Квартплата": 34,
    "Мобильная связь": 35,
    "Товары для дома": 36,
    "Косметика": 37,
    "Развлечения": 38,
    "Бьюти процедуры": 39,
    "Парковки и штрафы": 40,
    "Бензин": 41,
    "Переводы": 42,
    "Прочее": 43,
    "Расходы на семьи": 44,
    "Подарки друг другу": 45,
    "Крупные покупки": 46,
    "Абонемент в спорт-зал": 47,
}
FACT_INCOME = PLAN_INCOME
FACT_EXPENSE = {
    "Ипотека платеж": 24,
    "Дедушка долг": 25,
    "Ремонт квартиры": 26,
    "Квартира Тайланд": 27,
    "Свадебное путешествие": 28,
    "Саша учеба": 29,
    "Парковка": 30,
    "Отпуска": 31,
    "Страховка": 32,
    "Налоги": 33,
    "Ребенок": 34,
    "Супермаркеты": 35,
    "Такси": 36,
    "Рестораны": 37,
    "Одежда и обувь": 38,
    "Квартплата": 39,
    "Мобильная связь": 40,
    "Товары для дома": 41,
    "Косметика": 42,
    "Развлечения": 43,
    "Бьюти процедуры": 44,
    "Парковки и штрафы": 45,
    "Бензин": 46,
    "Переводы": 47,
    "Прочее": 48,
    "Расходы на семьи": 49,
    "Подарки друг другу": 50,
    "Крупные покупки": 51,
    "Абонемент в спорт-зал": 52,
}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def find_excel() -> Path | None:
    for path in EXCEL_CANDIDATES:
        if path.exists():
            return path
    root = Path("/Users/Sedova.Maria/Desktop/Саша/Мониторинг бюджета")
    files = sorted(root.glob("*Бюджет 2026.xlsx"), reverse=True)
    return files[0] if files else None


def seed_from_excel(conn, path: Path | None = None) -> str:
    excel = path or find_excel()
    if not excel:
        raise FileNotFoundError("Не найден файл бюджета Excel")

    wb = openpyxl.load_workbook(excel, data_only=True)
    plan = wb["FCF 2026 ПЛАН"]
    fact = wb["FCF 2026 ФАКТ"]

    # План: колонки 2026 (C–N), 2027 (O–Z), 2028 (AA–AL) — как в Excel
    for year in (2026, 2027, 2028):
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

    # Факт только 2026
    year = 2026
    for month in range(1, 13):
        col = 2 + month  # C=3 for January
        for cat, row in FACT_INCOME.items():
            upsert_ledger(
                conn, year, month, cat, "income",
                fact=_num(fact.cell(row, col).value), source="excel",
            )
        for cat, row in FACT_EXPENSE.items():
            upsert_ledger(
                conn, year, month, cat, "expense",
                fact=_num(fact.cell(row, col).value), source="excel",
            )

        # Август закрыт в выгрузке 5.09; сентябрь — частичный; окт–дек — ещё план
        if month == 9:
            conn.execute(
                "UPDATE ledger SET source='partial' WHERE year=? AND month=?",
                (year, month),
            )
        elif month >= 10:
            conn.execute(
                "UPDATE ledger SET source='forecast' WHERE year=? AND month=?",
                (year, month),
            )

    set_meta(conn, "excel_file", excel.name)
    set_meta(conn, "seeded", "1")
    set_meta(conn, "closed_month", "8")
    conn.commit()
    return excel.name
