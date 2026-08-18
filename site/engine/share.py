"""Разделение накоплений и недвижимости — вкладки Excel «Разделение_*»."""

from __future__ import annotations

from pathlib import Path

import openpyxl

from .seed_excel import find_excel

# Снимок с вкладок «Разделение_деньги» / «Разделение_недвижимость» на 16.08.2026
FALLBACK = {
    "savings": [
        {"owner": "Саша", "label": "Саша накопления", "amount": 3_155_685},
        {"owner": "Маша", "label": "Маша накопления", "amount": 1_771_487},
    ],
    "cash_from_sasha": [
        {
            "year": 2023,
            "amount": 1_046_360,
            "comment": "Без переводов, кредита банку, такси, ресторанов, одежды, мобильной связи, сервисов банка",
        },
        {
            "year": 2024,
            "amount": -524_540,
            "comment": "Без переводов, кредита банку, такси, ресторанов, одежды, мобильной связи, сервисов банка",
        },
        {
            "year": 2025,
            "amount": 451_006,
            "comment": "Без переводов, ресторанов, одежды, мобильной связи",
        },
        {"year": 2026, "amount": 1_977_742, "comment": "2026"},
    ],
    "property": [
        {"name": "Квартира Тайланд", "owner": "Маша", "share": 0.5, "comment": None},
        {"name": "Квартира Тайланд", "owner": "Саша", "share": 0.5, "comment": None},
        {"name": "Квартира Петербург", "owner": "Саша", "share": 1.0, "comment": None},
        {"name": "Парковочное место", "owner": "Маша", "share": 1.0, "comment": None},
    ],
}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def read_split_sheets(excel: Path | None = None) -> dict:
    path = excel or find_excel()
    data = {
        "savings": list(FALLBACK["savings"]),
        "cash_from_sasha": list(FALLBACK["cash_from_sasha"]),
        "property": list(FALLBACK["property"]),
        "source": "snapshot",
    }
    if not path or not path.exists():
        return data
    try:
        wb = openpyxl.load_workbook(path, data_only=True)
    except Exception:
        return data

    if "Разделение_деньги" in wb.sheetnames:
        ws = wb["Разделение_деньги"]
        savings = []
        cash = []
        for r in range(2, (ws.max_row or 1) + 1):
            name = ws.cell(r, 1).value
            amount = _num(ws.cell(r, 2).value)
            comment = ws.cell(r, 3).value
            if not name:
                continue
            label = str(name).strip()
            if "Саша накопления" in label:
                savings.append({"owner": "Саша", "label": label, "amount": amount})
            elif "Маша накопления" in label:
                savings.append({"owner": "Маша", "label": label, "amount": amount})
            elif "наличные" in label.lower():
                year = comment if isinstance(comment, int) else None
                if year is None and comment:
                    digits = "".join(ch for ch in str(comment) if ch.isdigit())
                    year = int(digits[-4:]) if len(digits) >= 4 else None
                cash.append(
                    {
                        "year": year,
                        "amount": amount,
                        "comment": None if isinstance(comment, int) else (str(comment) if comment else None),
                    }
                )
        if savings:
            data["savings"] = savings
        if cash:
            data["cash_from_sasha"] = cash

    if "Разделение_недвижимость" in wb.sheetnames:
        ws = wb["Разделение_недвижимость"]
        props = []
        for r in range(2, (ws.max_row or 1) + 1):
            name = ws.cell(r, 1).value
            owner = ws.cell(r, 2).value
            share = _num(ws.cell(r, 3).value)
            comment = ws.cell(r, 4).value
            if name and owner:
                props.append(
                    {
                        "name": str(name).strip(),
                        "owner": str(owner).strip(),
                        "share": share,
                        "comment": str(comment) if comment else None,
                    }
                )
        if props:
            data["property"] = props
    data["source"] = path.name
    return data


def build_share(rows: list[dict], closed_month: int = 7) -> dict:
    data = read_split_sheets()
    months = list(range(1, closed_month + 1))
    thailand = sum(
        r["fact"] for r in rows if r["category"] == "Квартира Тайланд" and r["month"] in months
    )
    parking = sum(r["fact"] for r in rows if r["category"] == "Парковка" and r["month"] in months)

    values = {
        "Квартира Тайланд": thailand,
        "Парковочное место": parking,
        "Квартира Петербург": None,
    }

    grouped: dict[str, dict] = {}
    for item in data["property"]:
        pack = grouped.setdefault(
            item["name"],
            {"name": item["name"], "value": values.get(item["name"]), "shares": []},
        )
        pack["shares"].append(
            {
                "owner": item["owner"],
                "share": item["share"],
                "value": None if pack["value"] is None else pack["value"] * item["share"],
            }
        )

    sasha = next((x["amount"] for x in data["savings"] if x["owner"] == "Саша"), 0)
    masha = next((x["amount"] for x in data["savings"] if x["owner"] == "Маша"), 0)
    known_prop = sum(v or 0 for v in values.values())

    return {
        "source": data["source"],
        "savings": data["savings"],
        "cash_from_sasha": data["cash_from_sasha"],
        "property": list(grouped.values()),
        "totals": {
            "sasha_cash": sasha,
            "masha_cash": masha,
            "cash": sasha + masha,
            "property_known": known_prop,
        },
    }
