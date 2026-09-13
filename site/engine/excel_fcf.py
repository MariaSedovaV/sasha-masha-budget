"""Чтение кумулятива FCF и накоплений напрямую из Excel (как в файле)."""

from __future__ import annotations

import json
import re
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
# На плане те же статьи — старт в кол. B, потоки сразу в месячных колонках
PLAN_MASHA_ROW = 14
PLAN_SASHA_ROW = 15
PLAN_CASH_ROW = 16
PLAN_SASHA_INV_ROW = 18


SNAPSHOT_ANALYTICS = Path(__file__).resolve().parent.parent / "static" / "snapshot" / "analytics.json"


def series_has_values(vals) -> bool:
    return any(v is not None and abs(float(v or 0)) > 0.5 for v in (vals or []))


def _load_snapshot() -> dict | None:
    if not SNAPSHOT_ANALYTICS.exists():
        return None
    try:
        return json.loads(SNAPSHOT_ANALYTICS.read_text(encoding="utf-8"))
    except Exception:
        return None


def _mln_to_rub(v):
    if v is None:
        return None
    try:
        return float(v) * 1e6
    except (TypeError, ValueError):
        return None


def _horizon_from_snapshot(kind: str) -> dict | None:
    snap = _load_snapshot()
    if not snap:
        return None
    hz = snap.get("fcf_horizon") or {}
    labels = list(hz.get("labels") or [])
    series_key = "series_plan" if kind == "plan" else "series_fact"
    monthly_key = "series_fcf_plan" if kind == "plan" else "series_fcf_fact"
    series = list(hz.get(series_key) or [])
    monthly_src = list(hz.get(monthly_key) or [])
    if kind == "fact":
        labels = labels[:12]
        series = series[:12]
        monthly_src = monthly_src[:12]
    if not series or not series_has_values(series):
        return None
    cumul = [_mln_to_rub(v) for v in series]
    closed = int(snap.get("closed_month") or 0)
    if kind == "fact" and snap.get("cumul_fact") is not None and 1 <= closed <= len(cumul):
        cumul[closed - 1] = float(snap["cumul_fact"])
    if kind == "plan" and snap.get("cumul_plan") is not None and 1 <= closed <= len(cumul):
        cumul[closed - 1] = float(snap["cumul_plan"])
    monthly = []
    for i, val in enumerate(cumul):
        if i < len(monthly_src) and monthly_src[i] is not None:
            monthly.append(_mln_to_rub(monthly_src[i]))
        elif val is None:
            monthly.append(None)
        elif i == 0 or cumul[i - 1] is None:
            monthly.append(val)
        else:
            monthly.append(val - cumul[i - 1])
    out = {
        "labels": labels or [f"{m:02d}.{BASE_YEAR}" for m in range(1, 13)],
        "cumul": cumul,
        "monthly": monthly,
        "excel": "snapshot",
    }
    if kind == "plan":
        out["end_2027"] = cumul[23] if len(cumul) > 23 else None
        out["end_2028"] = cumul[35] if len(cumul) > 35 else None
        out["end_2040"] = cumul[-1] if cumul else None
    return out


def _plan_col(year: int, month: int) -> int:
    return 3 + (year - BASE_YEAR) * 12 + (month - 1)


def _fact_col(month: int) -> int:
    return 2 + month


@lru_cache(maxsize=8)
def _workbook(path_str: str, data_only: bool = True, mtime: float = 0.0):
    return openpyxl.load_workbook(path_str, data_only=data_only)


def _wb(path: Path | None = None, data_only: bool = True):
    excel = path or find_excel()
    if not excel or not excel.exists():
        return None, None
    try:
        return _workbook(str(excel.resolve()), data_only, excel.stat().st_mtime), excel
    except Exception:
        return None, excel


def read_plan_horizon(path: Path | None = None) -> dict | None:
    """План: кумулятив и месячный ИТОГО за 2026–2040 из листа FCF ПЛАН."""
    wb, excel = _wb(path)
    result = None
    if wb and PLAN_SHEET in wb.sheetnames:
        ws = wb[PLAN_SHEET]
        labels, cumul, monthly = [], [], []
        for year in range(BASE_YEAR, PLAN_END_YEAR + 1):
            for month in range(1, 13):
                col = _plan_col(year, month)
                labels.append(f"{month:02d}.{year}")
                cumul.append(_num(ws.cell(PLAN_CUMUL_ROW, col).value))
                monthly.append(_num(ws.cell(PLAN_TOTAL_ROW, col).value))
        result = {
            "labels": labels,
            "cumul": cumul,
            "monthly": monthly,
            "excel": excel.name if excel else None,
            "end_2027": cumul[23] if len(cumul) > 23 else None,
            "end_2028": cumul[35] if len(cumul) > 35 else None,
            "end_2040": cumul[-1] if cumul else None,
        }
        if series_has_values(cumul):
            return result
    return _horizon_from_snapshot("plan") or result


def read_fact_cumul_series(path: Path | None = None) -> dict | None:
    """Факт: кумулятив и ИТОГО по месяцам 2026 из листа FCF ФАКТ."""
    wb, excel = _wb(path)
    result = None
    if wb and FACT_SHEET in wb.sheetnames:
        ws = wb[FACT_SHEET]
        cumul, monthly = [], []
        for month in range(1, 13):
            col = _fact_col(month)
            cumul.append(_num(ws.cell(FACT_CUMUL_ROW, col).value))
            monthly.append(_num(ws.cell(FACT_TOTAL_ROW, col).value))
        result = {"cumul": cumul, "monthly": monthly, "excel": excel.name if excel else None}
        if series_has_values(cumul):
            return result
    snap = _horizon_from_snapshot("fact")
    if snap:
        return {"cumul": snap["cumul"], "monthly": snap["monthly"], "excel": snap.get("excel")}
    return result


def _iter_ym(start: tuple[int, int], end: tuple[int, int]):
    y, m = start
    y1, m1 = end
    while (y, m) <= (y1, m1):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


_A1_RE = re.compile(r"\$?([A-Za-z]+)\$?(\d+)")
_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def _a1(ref: str) -> tuple[int, int] | None:
    parsed = _col_row(ref)
    if not parsed:
        return None
    col, row = parsed
    return row, col


def _strip_excel_expr(expr: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch == "'":
            j = expr.find("'", i + 1)
            if j < 0:
                out.append(expr[i:])
                break
            out.append(expr[i : j + 1])
            i = j + 1
            continue
        if ch.isspace():
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


class _ExcelEval:
    """Считает формулы FCF, если data_only не сохранил кэш (открытый Excel)."""

    def __init__(self, formulas_wb, values_wb, force_formula: dict[str, set[int]] | None = None):
        self.formulas = formulas_wb
        self.values = values_wb
        self.force_formula = force_formula or {}
        self.cache: dict[tuple[str, int, int], float] = {}

    def cell(self, sheet: str, row: int, col: int, stack: set | None = None) -> float:
        key = (sheet, row, col)
        if key in self.cache:
            return self.cache[key]
        stack = stack or set()
        if key in stack:
            return 0.0
        stack.add(key)
        raw = None
        cached = None
        try:
            raw = self.formulas[sheet].cell(row, col).value
        except KeyError:
            self.cache[key] = 0.0
            return 0.0
        try:
            cached = self.values[sheet].cell(row, col).value
        except KeyError:
            cached = None
        force = row in self.force_formula.get(sheet, set())
        if not force and isinstance(cached, (int, float)):
            self.cache[key] = float(cached)
            return self.cache[key]
        if isinstance(raw, (int, float)):
            self.cache[key] = float(raw)
            return self.cache[key]
        if raw is None or raw == "":
            if isinstance(cached, (int, float)):
                self.cache[key] = float(cached)
                return self.cache[key]
            self.cache[key] = 0.0
            return 0.0
        if isinstance(raw, str) and raw.startswith("="):
            val = self._expr(sheet, raw[1:], stack)
            self.cache[key] = val
            return val
        self.cache[key] = _num(raw)
        return self.cache[key]

    def _expr(self, sheet: str, expr: str, stack: set) -> float:
        tokens = self._tokenize(_strip_excel_expr(expr))
        return self._eval_tokens(sheet, tokens, stack)

    def _tokenize(self, expr: str) -> list:
        tokens: list = []
        i = 0
        n = len(expr)
        while i < n:
            ch = expr[i]
            if ch in "+-*/()":
                tokens.append(ch)
                i += 1
                continue
            if ch == "'":
                j = expr.find("'", i + 1)
                name = expr[i + 1 : j]
                i = j + 1
                if i < n and expr[i] == "!":
                    i += 1
                m = _A1_RE.match(expr[i:])
                if not m:
                    raise ValueError("sheet ref at " + expr[i:])
                tokens.append(("sheet", name, m.group(0)))
                i += len(m.group(0))
                continue
            if expr[i : i + 4].upper() == "SUM(":
                depth = 1
                j = i + 4
                while j < n and depth:
                    if expr[j] == "(":
                        depth += 1
                    elif expr[j] == ")":
                        depth -= 1
                    j += 1
                tokens.append(("sum", expr[i + 4 : j - 1]))
                i = j
                continue
            m = _A1_RE.match(expr[i:])
            if m:
                tokens.append(("ref", m.group(0)))
                i += len(m.group(0))
                continue
            m = _NUM_RE.match(expr[i:])
            if m:
                tokens.append(float(m.group(0)))
                i += len(m.group(0))
                continue
            raise ValueError("cannot parse " + expr[i : i + 40])
        return tokens

    def _value_tok(self, sheet: str, tok, stack: set) -> float:
        if isinstance(tok, (int, float)):
            return float(tok)
        kind = tok[0]
        if kind == "ref":
            parsed = _a1(tok[1])
            if not parsed:
                return 0.0
            r, c = parsed
            return self.cell(sheet, r, c, stack)
        if kind == "sheet":
            parsed = _a1(tok[2])
            if not parsed:
                return 0.0
            r, c = parsed
            return self.cell(tok[1], r, c, stack)
        if kind == "sum":
            inner = tok[1]
            left, right = inner.split(":")
            a = _a1(left)
            b = _a1(right)
            if not a or not b:
                return 0.0
            r1, c1 = a
            r2, c2 = b
            total = 0.0
            for rr in range(min(r1, r2), max(r1, r2) + 1):
                for cc in range(min(c1, c2), max(c1, c2) + 1):
                    total += self.cell(sheet, rr, cc, stack)
            return total
        raise ValueError(tok)

    def _eval_tokens(self, sheet: str, tokens: list, stack: set) -> float:
        prec = {"+": 1, "-": 1, "*": 2, "/": 2}
        out: list = []
        ops: list = []
        unary = True
        for tok in tokens:
            if tok in ("+", "-") and unary:
                out.append(0.0)
                ops.append(tok)
                unary = False
                continue
            if tok == "(":
                ops.append(tok)
                unary = True
                continue
            if tok == ")":
                while ops and ops[-1] != "(":
                    out.append(ops.pop())
                if ops:
                    ops.pop()
                unary = False
                continue
            if tok in prec:
                while ops and ops[-1] in prec and prec[ops[-1]] >= prec[tok]:
                    out.append(ops.pop())
                ops.append(tok)
                unary = True
                continue
            out.append(self._value_tok(sheet, tok, stack))
            unary = False
        while ops:
            out.append(ops.pop())
        st: list[float] = []
        for item in out:
            if item in ("+", "-", "*", "/"):
                b = st.pop()
                a = st.pop() if st else 0.0
                if item == "+":
                    st.append(a + b)
                elif item == "-":
                    st.append(a - b)
                elif item == "*":
                    st.append(a * b)
                else:
                    st.append(a / b if b else 0.0)
            else:
                st.append(float(item))
        return st[0] if st else 0.0


def read_savings_month_ends(closed_month: int, path: Path | None = None) -> dict | None:
    """Помесячные остатки: старт (кол. B) + сумма месячных потоков, не ниже нуля.

    Потоки — строки 19–21 и 23 FCF 2026 ФАКТ (сен–дек часто тянут план), с 2027 — FCF ПЛАН.
    Не берём строки баланса 14–16 как есть: у Маши в августе там повторно вычитается парковка.
    """
    closed = max(0, min(12, int(closed_month or 0)))
    formulas_wb, excel = _wb(path, data_only=False)
    values_wb, _ = _wb(path, data_only=True)
    if not formulas_wb or FACT_SHEET not in formulas_wb.sheetnames:
        return None
    ev = _ExcelEval(
        formulas_wb,
        values_wb or formulas_wb,
        force_formula={
            FACT_SHEET: {14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 49, 50, 54},
            PLAN_SHEET: {14, 15, 16, 17, 18, 49},
        },
    )

    def fact_start(row: int) -> float:
        return ev.cell(FACT_SHEET, row, 2)

    def fact_balance(row: int, month: int) -> float:
        return ev.cell(FACT_SHEET, row, _fact_col(month))

    def fact_flow(row: int, month: int) -> float:
        return ev.cell(FACT_SHEET, row, _fact_col(month))

    def plan_flow(row: int, year: int, month: int) -> float:
        if PLAN_SHEET not in formulas_wb.sheetnames or year < BASE_YEAR:
            return 0.0
        return ev.cell(PLAN_SHEET, row, _plan_col(year, month))

    def path_from_balance(bal_row: int, plan_row: int) -> dict[tuple[int, int], float]:
        start = fact_start(bal_row)
        out: dict[tuple[int, int], float] = {(2025, 12): start}
        for month in range(1, 13):
            out[(BASE_YEAR, month)] = fact_balance(bal_row, month)
        last = out[(BASE_YEAR, 12)]
        extra = 0.0
        for year, month in _iter_ym((BASE_YEAR + 1, 1), (PLAN_END_YEAR, 12)):
            extra += plan_flow(plan_row, year, month)
            out[(year, month)] = last + extra
        return out

    def flows_2026(flow_row: int, plan_row: int) -> dict[tuple[int, int], float]:
        out: dict[tuple[int, int], float] = {}
        for month in range(1, 13):
            out[(BASE_YEAR, month)] = fact_flow(flow_row, month)
        for year, month in _iter_ym((BASE_YEAR + 1, 1), (PLAN_END_YEAR, 12)):
            out[(year, month)] = plan_flow(plan_row, year, month)
        return out

    def path_from_flows(start: float, flows: dict[tuple[int, int], float], extras: dict[tuple[int, int], float] | None = None) -> dict[tuple[int, int], float]:
        extras = extras or {}
        value = float(start or 0.0)
        out: dict[tuple[int, int], float] = {(2025, 12): max(0.0, value)}
        for year, month in _iter_ym((BASE_YEAR, 1), (PLAN_END_YEAR, 12)):
            value += float(flows.get((year, month), 0.0) or 0.0)
            value += float(extras.get((year, month), 0.0) or 0.0)
            value = max(0.0, value)
            out[(year, month)] = value
        return out

    def fact_balance_extras(bal_row: int) -> dict[tuple[int, int], float]:
        """Константы вроде +11137 в формулах кумулятива FACT (свободные деньги)."""
        extras: dict[tuple[int, int], float] = {}
        try:
            ws = formulas_wb[FACT_SHEET]
        except KeyError:
            return extras
        for month in range(1, 13):
            raw = ws.cell(bal_row, _fact_col(month)).value
            if not isinstance(raw, str) or not raw.startswith("="):
                continue
            extra = 0.0
            for num in re.findall(r"(?<![A-Za-z])\+(\d+(?:\.\d+)?)", raw):
                extra += float(num)
            if extra:
                extras[(BASE_YEAR, month)] = extra
        return extras

    masha_flows = flows_2026(FACT_MASHA_FLOW_ROW, PLAN_MASHA_ROW)
    sasha_flows = flows_2026(FACT_SASHA_FLOW_ROW, PLAN_SASHA_ROW)
    cash_flows = flows_2026(FACT_CASH_FLOW_ROW, PLAN_CASH_ROW)
    inv_flows = flows_2026(FACT_SASHA_INV_FLOW_ROW, PLAN_SASHA_INV_ROW)

    formula_extras = fact_balance_extras(FACT_MASHA_BAL_ROW)
    leftover_extras: dict[tuple[int, int], float] = {}
    fcf_month: dict[tuple[int, int], float] = {}
    for month in range(1, 13):
        fcf_month[(BASE_YEAR, month)] = fact_flow(FACT_TOTAL_ROW, month)
    for year, month in _iter_ym((BASE_YEAR + 1, 1), (PLAN_END_YEAR, 12)):
        fcf_month[(year, month)] = plan_flow(PLAN_TOTAL_ROW, year, month)
    # С закрытого месяца: нераспределённый FCF (то, что не ушло в Сашу/наличные/ОФЗ) — в Машу.
    for year, month in _iter_ym((BASE_YEAR, 1), (PLAN_END_YEAR, 12)):
        if (year, month) <= (BASE_YEAR, closed or 0):
            continue
        parked = (
            max(0.0, float(masha_flows.get((year, month), 0.0) or 0.0))
            + max(0.0, float(sasha_flows.get((year, month), 0.0) or 0.0))
            + max(0.0, float(cash_flows.get((year, month), 0.0) or 0.0))
            + max(0.0, float(inv_flows.get((year, month), 0.0) or 0.0))
        )
        leftover = float(fcf_month.get((year, month), 0.0) or 0.0) - parked
        if leftover > 0.5:
            leftover_extras[(year, month)] = leftover

    masha_extras: dict[tuple[int, int], float] = {}
    for year, month in _iter_ym((BASE_YEAR, 1), (PLAN_END_YEAR, 12)):
        if (year, month) <= (BASE_YEAR, closed or 0):
            extra = float(formula_extras.get((year, month), 0.0) or 0.0)
        else:
            extra = float(leftover_extras.get((year, month), 0.0) or 0.0)
        if extra:
            masha_extras[(year, month)] = extra

    masha = path_from_flows(
        fact_start(FACT_MASHA_BAL_ROW),
        masha_flows,
        masha_extras,
    )
    sasha_sav = path_from_flows(fact_start(FACT_SASHA_BAL_ROW), sasha_flows)
    cash = path_from_flows(
        fact_start(FACT_CASH_BAL_ROW),
        cash_flows,
        fact_balance_extras(FACT_CASH_BAL_ROW),
    )
    sasha_inv_nominal = path_from_balance(FACT_SASHA_INV_BAL_ROW, PLAN_SASHA_INV_ROW)
    return {
        "masha": masha,
        "sasha_savings": sasha_sav,
        "sasha_invest": sasha_inv_nominal,
        "sasha": sasha_sav,
        "cash": cash,
        "masha_flows": masha_flows,
        "sasha_flows": sasha_flows,
        "cash_flows": cash_flows,
        "sasha_invest_flows": inv_flows,
        "sasha_invest_start": fact_start(FACT_SASHA_INV_BAL_ROW),
        "excel": excel.name if excel else None,
        "closed_month": closed,
        "method": "start_plus_flows_floor",
    }


def read_savings_balances(closed_month: int, path: Path | None = None) -> dict | None:
    """Снимок на закрытый месяц: старт + сумма факт-потоков по строке."""
    paths = read_savings_month_ends(closed_month, path)
    if not paths:
        return None
    closed = max(0, min(12, int(closed_month or 0)))
    key = (2026, closed) if closed else (2025, 12)

    def at(name: str) -> float:
        return float((paths.get(name) or {}).get(key, 0.0))

    return {
        "masha": at("masha"),
        "sasha": at("sasha"),
        "sasha_savings": at("sasha_savings"),
        "sasha_invest": at("sasha_invest"),
        "cash": at("cash"),
        "excel": paths.get("excel"),
        "closed_month": closed,
        "method": "start_plus_flows_floor",
    }


PLAN_MORTGAGE_ROW = 20
PLAN_THAI_ROW = 23
ENCUMBRANCE_THAI_UNTIL = (2028, 12)
ENCUMBRANCE_MORTGAGE_UNTIL = (2030, 12)


def read_encumbrance_schedule(path: Path | None = None) -> list[dict]:
    """Будущие платежи по Таиланду (до 2028) и ипотеке (до 2030) из FCF ПЛАН."""
    formulas_wb, _excel = _wb(path, data_only=False)
    values_wb, _ = _wb(path, data_only=True)
    if not formulas_wb or PLAN_SHEET not in formulas_wb.sheetnames:
        return []
    ev = _ExcelEval(
        formulas_wb,
        values_wb or formulas_wb,
        force_formula={PLAN_SHEET: {PLAN_MORTGAGE_ROW, PLAN_THAI_ROW}},
    )
    out = []
    for year, month in _iter_ym((BASE_YEAR, 1), ENCUMBRANCE_MORTGAGE_UNTIL):
        thai = 0.0
        if (year, month) <= ENCUMBRANCE_THAI_UNTIL:
            thai = ev.cell(PLAN_SHEET, PLAN_THAI_ROW, _plan_col(year, month))
        mort = ev.cell(PLAN_SHEET, PLAN_MORTGAGE_ROW, _plan_col(year, month))
        if abs(thai) < 0.5 and abs(mort) < 0.5:
            continue
        out.append({
            "year": year,
            "month": month,
            "thai": max(0.0, float(thai or 0.0)),
            "mortgage": max(0.0, float(mort or 0.0)),
        })
    return out


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
