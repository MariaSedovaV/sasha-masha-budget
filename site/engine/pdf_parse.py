"""Разбор справки Т-Банка «О движении средств»."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

import fitz

SKIP_PREFIXES = (
    "Исх.",
    "АКЦИОНЕРНОЕ",
    "РОССИЯ,",
    "ТЕЛ.:",
    "Справка о движении",
    "Седова",
    "Адрес места",
    "О продукте",
    "Дата заключения",
    "Номер договора",
    "Номер лицевого",
    "Движение средств",
    "Дата и время",
    "операции",
    "Дата",
    "списания",
    "Сумма в валюте",
    "Сумма операции",
    "в валюте карты",
    "Описание",
    "Номер",
    "карты",
    "АО «ТБанк»",
    "БИК ",
    "универсальная лицензия",
)

DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
AMT_RE = re.compile(
    r"^([+-]?)(\d[\d\s]*)\.(\d{2})\s*([₽₸$€£]|RUB|USD|KZT|EUR)$"
)
CARD_RE = re.compile(r"^\d{4}$")


def _skip(line: str) -> bool:
    if re.fullmatch(r"\d+", line) and int(line) < 100:
        return True
    return any(line.startswith(p) for p in SKIP_PREFIXES)


def _parse_amount(line: str) -> tuple[float, str] | None:
    m = AMT_RE.match(line.replace("\xa0", " "))
    if not m:
        return None
    sign, whole, frac, cur = m.groups()
    value = float((sign or "") + whole.replace(" ", "") + "." + frac)
    return value, cur


def parse_statement_pdf(data: bytes) -> dict[str, Any]:
    doc = fitz.open(stream=data, filetype="pdf")
    header = {"account": None, "holder": None, "period_from": None, "period_to": None}
    raw_lines: list[str] = []
    for page in doc:
        text = page.get_text("text")
        for ln in text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            if ln.startswith("Седова") or "Седова" in ln and header["holder"] is None:
                header["holder"] = ln
            if "лицевого счета" in ln.lower():
                m = re.search(r"(\d{20})", ln)
                if m:
                    header["account"] = m.group(1)
            if "Движение средств за период" in ln:
                m = re.search(r"(\d{2}\.\d{2}\.\d{4}).+(\d{2}\.\d{2}\.\d{4})", ln)
                if m:
                    header["period_from"], header["period_to"] = m.group(1), m.group(2)
            raw_lines.append(ln)

    clean = [ln for ln in raw_lines if not _skip(ln)]
    txs: list[dict[str, Any]] = []
    i = 0
    while i < len(clean):
        if DATE_RE.match(clean[i]) and i + 1 < len(clean) and TIME_RE.match(clean[i + 1]):
            op_date, op_time = clean[i], clean[i + 1]
            i += 2
            wo_date = wo_time = None
            if i < len(clean) and DATE_RE.match(clean[i]):
                wo_date = clean[i]
                i += 1
                if i < len(clean) and TIME_RE.match(clean[i]):
                    wo_time = clean[i]
                    i += 1
            amounts: list[tuple[float, str]] = []
            while i < len(clean):
                parsed = _parse_amount(clean[i])
                if not parsed:
                    break
                amounts.append(parsed)
                i += 1
            desc_parts: list[str] = []
            while i < len(clean) and not DATE_RE.match(clean[i]) and not _parse_amount(clean[i]):
                if CARD_RE.match(clean[i]) and desc_parts:
                    break
                desc_parts.append(clean[i])
                i += 1
            card = None
            if i < len(clean) and CARD_RE.match(clean[i]):
                card = clean[i]
                i += 1
            amt_op = amounts[0][0] if amounts else 0.0
            cur_op = amounts[0][1] if amounts else "₽"
            amt_card = amounts[1][0] if len(amounts) > 1 else amt_op
            desc = re.sub(r"\s+", " ", " ".join(desc_parts)).strip()
            dt = datetime.strptime(op_date, "%d.%m.%Y")
            txs.append(
                {
                    "op_date": dt.strftime("%Y-%m-%d"),
                    "op_time": op_time,
                    "writeoff_date": (
                        datetime.strptime(wo_date, "%d.%m.%Y").strftime("%Y-%m-%d")
                        if wo_date
                        else None
                    ),
                    "writeoff_time": wo_time,
                    "amount": round(amt_card, 2),
                    "orig_amount": round(amt_op, 2),
                    "orig_ccy": cur_op,
                    "description": desc,
                    "card": card,
                    "year": dt.year,
                    "month": dt.month,
                }
            )
        else:
            i += 1

    txs.sort(key=lambda t: (t["op_date"], t["op_time"] or ""))
    return {"header": header, "transactions": txs, "count": len(txs)}
