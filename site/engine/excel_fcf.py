"""Чтение кумулятива FCF и накоплений напрямую из Excel (как в файле)."""

from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from posixpath import join as posix_join, normpath
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import openpyxl

from .seed_excel import (
    FACT_EXPENSE,
    FACT_INCOME,
    PLAN_EXPENSE,
    PLAN_INCOME,
    find_excel,
    _num,
)

BASE_YEAR = 2026
PLAN_END_YEAR = 2040
PLAN_SHEET = "FCF 2026 ПЛАН"
FACT_SHEET = "FCF 2026 ФАКТ"

PLAN_CUMUL_ROW = 51
PLAN_TOTAL_ROW = 49
FACT_CUMUL_ROW = 56
FACT_TOTAL_ROW = 54
# Балансы и месячные потоки накоплений на ФАКТ
FACT_MASHA_BAL_ROW = 14
FACT_SASHA_BAL_ROW = 15
FACT_MASHA_FLOW_ROW = 19
FACT_SASHA_FLOW_ROW = 20
FACT_CASH_BAL_ROW = 16
FACT_CASH_FLOW_ROW = 21
FACT_SASHA_INV_BAL_ROW = 18
FACT_SASHA_INV_FLOW_ROW = 23


def _plan_col(year: int, month: int) -> int:
    return 3 + (year - BASE_YEAR) * 12 + (month - 1)


def _fact_col(month: int) -> int:
    return 2 + month


@lru_cache(maxsize=4)
def _workbook(path_str: str):
    return openpyxl.load_workbook(path_str, data_only=True)


def _wb(path: Path | None = None):
    excel = path or find_excel()
    if not excel or not excel.exists():
        return None, None
    try:
        return _workbook(str(excel.resolve())), excel
    except Exception:
        return None, excel


def read_plan_horizon(path: Path | None = None) -> dict | None:
    """План: кумулятив и месячный ИТОГО за 2026–2040 из листа FCF ПЛАН."""
    wb, excel = _wb(path)
    if not wb or PLAN_SHEET not in wb.sheetnames:
        return None
    ws = wb[PLAN_SHEET]
    labels, cumul, monthly = [], [], []
    for year in range(BASE_YEAR, PLAN_END_YEAR + 1):
        for month in range(1, 13):
            col = _plan_col(year, month)
            labels.append(f"{month:02d}.{year}")
            cumul.append(_num(ws.cell(PLAN_CUMUL_ROW, col).value))
            monthly.append(_num(ws.cell(PLAN_TOTAL_ROW, col).value))
    return {
        "labels": labels,
        "cumul": cumul,
        "monthly": monthly,
        "excel": excel.name if excel else None,
        "end_2027": cumul[23] if len(cumul) > 23 else None,
        "end_2028": cumul[35] if len(cumul) > 35 else None,
        "end_2040": cumul[-1] if cumul else None,
    }


def read_fact_cumul_series(path: Path | None = None) -> dict | None:
    """Факт: кумулятив и ИТОГО по месяцам 2026 из листа FCF ФАКТ."""
    wb, excel = _wb(path)
    if not wb or FACT_SHEET not in wb.sheetnames:
        return None
    ws = wb[FACT_SHEET]
    cumul, monthly = [], []
    for month in range(1, 13):
        col = _fact_col(month)
        cumul.append(_num(ws.cell(FACT_CUMUL_ROW, col).value))
        monthly.append(_num(ws.cell(FACT_TOTAL_ROW, col).value))
    return {"cumul": cumul, "monthly": monthly, "excel": excel.name if excel else None}


def read_savings_balances(closed_month: int, path: Path | None = None) -> dict | None:
    """Ликвидные позиции = старт (кол. B) + сумма месячных потоков.

    Маша накопления: стр. 13/18 (без вычета парковки из формулы августа).
    Саша накопления: стр. 14/19 + Саша инвестиции 17/22 (как в «Разделение_деньги»).
    Наличные: Доллары дома стр. 15/20.
    """
    wb, excel = _wb(path)
    if not wb or FACT_SHEET not in wb.sheetnames:
        return None
    ws = wb[FACT_SHEET]

    def start_plus_flows(bal_row: int, flow_row: int) -> float:
        start = _num(ws.cell(bal_row, 2).value)
        flows = sum(
            _num(ws.cell(flow_row, _fact_col(m)).value)
            for m in range(1, closed_month + 1)
        )
        return start + flows

    masha = start_plus_flows(FACT_MASHA_BAL_ROW, FACT_MASHA_FLOW_ROW)
    sasha_sav = start_plus_flows(FACT_SASHA_BAL_ROW, FACT_SASHA_FLOW_ROW)
    sasha_inv = start_plus_flows(FACT_SASHA_INV_BAL_ROW, FACT_SASHA_INV_FLOW_ROW)
    cash = start_plus_flows(FACT_CASH_BAL_ROW, FACT_CASH_FLOW_ROW)
    return {
        "masha": masha,
        "sasha": sasha_sav + sasha_inv,
        "sasha_savings": sasha_sav,
        "sasha_invest": sasha_inv,
        "cash": cash,
        "excel": excel.name if excel else None,
        "method": "start_plus_flows",
    }


NS_MAIN = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_TC = {"tc": "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"}
NS_T = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"

FACT_ROW_CAT = {row: cat for cat, row in {**FACT_INCOME, **FACT_EXPENSE}.items()}
PLAN_ROW_CAT = {row: cat for cat, row in {**PLAN_INCOME, **PLAN_EXPENSE}.items()}


def _col_row(ref: str) -> tuple[int, int] | None:
    letters, digits = "", ""
    for ch in str(ref):
        if ch.isalpha():
            letters += ch
        elif ch.isdigit():
            digits += ch
    if not letters or not digits:
        return None
    col = 0
    for ch in letters.upper():
        col = col * 26 + (ord(ch) - 64)
    return col, int(digits)


def _clean_classic_comment(text: str) -> str:
    raw = (text or "").replace("\xa0", " ").strip()
    if not raw:
        return ""
    if "[Threaded comment]" in raw:
        parts = []
        if "Comment:" in raw:
            rest = raw.split("Comment:", 1)[1]
            for chunk in rest.split("Reply:"):
                piece = " ".join(chunk.split()).strip()
                if piece:
                    parts.append(piece)
        return " · ".join(parts)
    lines = raw.splitlines()
    if lines and lines[0].endswith(":"):
        raw = "\n".join(lines[1:]).strip()
    return " ".join(raw.split()).strip()


def _parse_threaded_comments(data: bytes) -> dict[str, str]:
    root = ET.fromstring(data)
    grouped: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for node in root.findall("tc:threadedComment", NS_TC):
        ref = node.get("ref")
        if not ref:
            continue
        text_el = node.find("tc:text", NS_TC)
        text = "".join(text_el.itertext()).strip() if text_el is not None else ""
        text = " ".join(text.split())
        if not text:
            continue
        grouped[ref].append((node.get("dT") or "", text))
    return {
        ref: " · ".join(text for _, text in sorted(items))
        for ref, items in grouped.items()
    }


def _parse_classic_comments(data: bytes) -> dict[str, str]:
    root = ET.fromstring(data)
    out: dict[str, str] = {}
    clist = root.find("m:commentList", NS_MAIN)
    if clist is None:
        return out
    for comment in clist.findall("m:comment", NS_MAIN):
        ref = comment.get("ref")
        chunks = []
        for node in comment.iter(NS_T):
            if node.text:
                chunks.append(node.text)
            if node.tail:
                chunks.append(node.tail)
        cleaned = _clean_classic_comment("".join(chunks))
        if ref and cleaned:
            out[ref] = cleaned
    return out


def _workbook_sheets(z: ZipFile) -> dict[str, str]:
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to: dict[str, str] = {}
    for rel in rels:
        rid, target = rel.get("Id"), rel.get("Target")
        if rid and target:
            rid_to[rid] = normpath(posix_join("xl", target))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    out: dict[str, str] = {}
    for sheet in wb.findall("m:sheets/m:sheet", NS_MAIN):
        name = sheet.get("name")
        rid = sheet.get(f"{{{NS_R}}}id")
        path = rid_to.get(rid)
        if name and path:
            out[name] = path
    return out


def _sheet_comment_files(z: ZipFile, sheet_xml: str) -> dict[str, str]:
    folder, name = sheet_xml.rsplit("/", 1)
    rels_path = f"{folder}/_rels/{name}.rels"
    out: dict[str, str] = {}
    if rels_path not in z.namelist():
        return out
    rels = ET.fromstring(z.read(rels_path))
    for rel in rels:
        typ = rel.get("Type") or ""
        target = rel.get("Target")
        if not target:
            continue
        abs_target = normpath(posix_join(folder, target))
        if typ.endswith("/threadedComment"):
            out["threaded"] = abs_target
        elif typ.endswith("/comments"):
            out["comments"] = abs_target
    return out


def _comments_for_sheet(z: ZipFile, sheet_xml: str) -> dict[str, str]:
    files = _sheet_comment_files(z, sheet_xml)
    merged: dict[str, str] = {}
    comments_path = files.get("comments")
    if comments_path and comments_path in z.namelist():
        merged.update(_parse_classic_comments(z.read(comments_path)))
    threaded_path = files.get("threaded")
    if threaded_path and threaded_path in z.namelist():
        merged.update(_parse_threaded_comments(z.read(threaded_path)))
    return merged


def _empty_comment_year() -> dict[str, list]:
    return {"plan": [None] * 12, "fact": [None] * 12}


def _put_comment(store: dict, cat: str | None, field: str, month: int, text: str) -> None:
    if not cat or not text or not (1 <= month <= 12):
        return
    row = store.setdefault(cat, _empty_comment_year())
    prev = row[field][month - 1]
    row[field][month - 1] = f"{prev} · {text}" if prev and prev != text else text


def _parse_cell_comments(path: Path) -> dict[str, dict[str, list]]:
    store: dict[str, dict[str, list]] = {}
    with ZipFile(path) as z:
        sheets = _workbook_sheets(z)
        fact_xml = sheets.get(FACT_SHEET)
        plan_xml = sheets.get(PLAN_SHEET)
        if fact_xml:
            for ref, text in _comments_for_sheet(z, fact_xml).items():
                parsed = _col_row(ref)
                if not parsed:
                    continue
                col, row = parsed
                _put_comment(store, FACT_ROW_CAT.get(row), "fact", col - 2, text)
        if plan_xml:
            for ref, text in _comments_for_sheet(z, plan_xml).items():
                parsed = _col_row(ref)
                if not parsed:
                    continue
                col, row = parsed
                if col < 3:
                    continue
                offset = col - 3
                year = BASE_YEAR + offset // 12
                month = offset % 12 + 1
                if year != BASE_YEAR:
                    continue
                _put_comment(store, PLAN_ROW_CAT.get(row), "plan", month, text)
    return store


@lru_cache(maxsize=4)
def _cell_comments_cached(path_str: str, mtime: int) -> dict[str, dict[str, list]]:
    return _parse_cell_comments(Path(path_str))


def read_cell_comments(path: Path | None = None) -> dict[str, dict[str, list]]:
    """Комментарии Excel к ячейкам плана/факта 2026: {category: {plan: [12], fact: [12]}}."""
    excel = path or find_excel()
    if not excel or not excel.exists():
        return {}
    try:
        return _cell_comments_cached(str(excel.resolve()), int(excel.stat().st_mtime))
    except Exception:
        return {}


def clear_excel_cache() -> None:
    _workbook.cache_clear()
    _cell_comments_cached.cache_clear()
