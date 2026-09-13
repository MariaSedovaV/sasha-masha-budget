"""Ключевые выводы и рекомендации — пересчитываются при обновлении факта."""

from __future__ import annotations

from calendar import monthrange
from copy import deepcopy

from .categories import (
    BASKET_CATEGORIES,
    BASKET_LIMIT,
    EXPENSE_CATEGORIES,
    FAMILY_GIFTS_YEAR_LIMIT,
    FILTER_GROUPS,
    FILTER_TREE,
    INCOME_CATEGORIES,
    OPERATING_INCOME,
    RESTAURANT_YEAR_LIMIT,
    SAVINGS_GOAL,
    START_CAPITAL,
)
from .excel_fcf import read_cell_comments, read_fact_cumul_series, read_plan_horizon

# Горизонт кумулятива FCF: факт 2026, план до конца 2040
FCF_END_YEAR = 2040
BASE_YEAR = 2026

# Как в Excel ИТОГО: зарплаты/премии/продажа − расходы (без займов и подарков)
FCF_CORE_INCOME = {
    "Зарплата Саша",
    "Премия Саша",
    "Продажа квартиры Саша",
    "Зарплата Маша",
    "Премия Маша",
}


def _sum(rows, months, cats, field) -> float:
    return sum(r[field] for r in rows if r["month"] in months and r["category"] in cats)


def _reconcile_plan_flows(series_plan, series_income_plan, series_expense_plan, series_fcf_plan) -> None:
    """Месячные доходы/расходы/FCF должны сходиться с шагом CFCF (Excel-кумулятив)."""
    prev = None
    for i, cumul in enumerate(series_plan):
        monthly = None
        if cumul is not None and prev is not None:
            monthly = round(float(cumul) - float(prev), 2)
        if cumul is not None:
            prev = float(cumul)
        if monthly is None:
            continue
        inc = float(series_income_plan[i] or 0)
        exp = float(series_expense_plan[i] or 0)
        led_fcf = inc + exp
        stored = series_fcf_plan[i]
        if stored is not None and abs(float(stored) - monthly) <= 0.35 and abs(led_fcf - monthly) <= 0.35:
            continue
        series_fcf_plan[i] = monthly
        if monthly < led_fcf - 0.35:
            series_expense_plan[i] = round(monthly - inc, 2)
        elif monthly > led_fcf + 0.35:
            series_income_plan[i] = round(monthly - exp, 2)


def _month_net(rows, month: int, field: str, *, core_income: bool = False) -> float:
    """Доходы − расходы. core_income=True — как строка ИТОГО в Excel (без займов/подарков)."""
    def ok_inc(r):
        if r["month"] != month or r["kind"] != "income":
            return False
        if core_income and r["category"] not in FCF_CORE_INCOME:
            return False
        return True

    inc = sum(r[field] for r in rows if ok_inc(r))
    exp = sum(r[field] for r in rows if r["month"] == month and r["kind"] == "expense")
    return inc - exp


def last_complete_month(rows, meta_closed: int | None = None) -> int:
    if meta_closed:
        return int(meta_closed)
    months = sorted({r["month"] for r in rows if r["source"] in ("excel", "import", "manual")})
    return max(months) if months else 7


def _has_year_data(rows_y, cat: str) -> bool:
    for r in rows_y:
        if r["category"] != cat:
            continue
        if abs(r.get("plan") or 0) > 0.5:
            return True
        if r.get("source") in ("forecast",):
            continue
        if abs(r.get("fact") or 0) > 0.5:
            return True
    return False


def _prune_filters(rows_y) -> tuple[dict, list]:
    live = {
        cat
        for cat in INCOME_CATEGORIES + EXPENSE_CATEGORIES
        if _has_year_data(rows_y, cat)
    }
    groups = {key: [c for c in cats if c in live] for key, cats in FILTER_GROUPS.items()}
    tree = []
    for node in deepcopy(FILTER_TREE):
        cats = [c for c in (node.get("categories") or []) if c in live]
        children = []
        for child in node.get("children") or []:
            cc = [c for c in (child.get("categories") or []) if c in live]
            if cc:
                children.append({**child, "categories": cc})
        if node["id"] in ("income", "expense"):
            tree.append({**node, "categories": cats, "children": children})
            continue
        if cats or children:
            tree.append({**node, "categories": cats, "children": children})
    return groups, tree


def _month_end(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}-{monthrange(year, month)[1]:02d}"


def _cal_fields(year: int, month: int) -> dict:
    return {"calendar": True, "date": _month_end(year, month), "year": year, "month": month}


def _build_fcf_horizon(rows, closed: int, fact_until: int | None = None, stored_events=None) -> dict:
    """Факт 2026 до последнего живого месяца; план 2026–2040 из Excel КУМУЛЯТИВНЫЙ ИТОГ."""
    n_months = (FCF_END_YEAR - BASE_YEAR + 1) * 12
    labels = []
    series_plan = []
    series_fact = []
    series_income_plan = []
    series_income_fact = []
    series_expense_plan = []
    series_expense_fact = []
    series_fcf_plan = []
    series_fcf_fact = []
    events = []

    excel_plan = read_plan_horizon()
    excel_fact = read_fact_cumul_series()
    until = max(int(fact_until or closed), int(closed or 0))

    income_plan_by_ym = {}
    income_fact_by_ym = {}
    expense_plan_by_ym = {}
    expense_fact_by_ym = {}
    thailand_plan_by_ym = {}
    large_plan_by_ym = {}
    mortgage_plan_by_ym = {}
    parking_plan_by_ym = {}
    for r in rows:
        if r.get("year", BASE_YEAR) < BASE_YEAR or r.get("year", BASE_YEAR) > FCF_END_YEAR:
            continue
        key = (r.get("year", BASE_YEAR), r["month"])
        if r["kind"] == "income":
            income_plan_by_ym[key] = income_plan_by_ym.get(key, 0) + r["plan"]
            income_fact_by_ym[key] = income_fact_by_ym.get(key, 0) + r["fact"]
        elif r["kind"] == "expense":
            expense_plan_by_ym[key] = expense_plan_by_ym.get(key, 0) + r["plan"]
            expense_fact_by_ym[key] = expense_fact_by_ym.get(key, 0) + r["fact"]
        if r["category"] == "Квартира Тайланд":
            thailand_plan_by_ym[key] = thailand_plan_by_ym.get(key, 0) + r["plan"]
        if r["category"] == "Ипотека платеж":
            mortgage_plan_by_ym[key] = mortgage_plan_by_ym.get(key, 0) + r["plan"]
        if r["category"] == "Парковка":
            parking_plan_by_ym[key] = parking_plan_by_ym.get(key, 0) + r["plan"]
        if r["category"] in ("Парковка", "Крупные покупки", "Отпуска"):
            large_plan_by_ym[key] = large_plan_by_ym.get(key, 0) + r["plan"]

    # Fallback, если Excel недоступен: наращиваем кумулятив по ИТОГО-логике
    cumul_plan = START_CAPITAL
    cumul_fact = START_CAPITAL

    for i in range(n_months):
        year = BASE_YEAR + i // 12
        month = (i % 12) + 1
        labels.append(f"{month:02d}.{year}")

        if excel_plan and i < len(excel_plan["cumul"]):
            series_plan.append(round(excel_plan["cumul"][i] / 1e6, 2))
        else:
            plan_rows = [r for r in rows if r.get("year", BASE_YEAR) == year]
            if not plan_rows:
                plan_rows = [r for r in rows if r.get("year", BASE_YEAR) == BASE_YEAR]
                plan_net = _month_net(plan_rows, month, "plan", core_income=True)
            else:
                plan_net = _month_net(plan_rows, month, "plan", core_income=True)
            cumul_plan += plan_net
            series_plan.append(round(cumul_plan / 1e6, 2))

        if year == BASE_YEAR and month <= until:
            fact_net = _month_net(rows, month, "fact", core_income=True)
            cumul_fact += fact_net
            series_fact.append(round(cumul_fact / 1e6, 2))
        else:
            series_fact.append(None)

        inc_plan = income_plan_by_ym.get((year, month), 0)
        exp_plan = expense_plan_by_ym.get((year, month), 0)
        series_income_plan.append(round(inc_plan / 1e6, 2))
        series_expense_plan.append(round(-exp_plan / 1e6, 2))
        series_fcf_plan.append(round((inc_plan - exp_plan) / 1e6, 2))
        if year == BASE_YEAR and month <= until:
            inc_fact = income_fact_by_ym.get((year, month), 0)
            exp_fact = expense_fact_by_ym.get((year, month), 0)
            series_income_fact.append(round(inc_fact / 1e6, 2))
            series_expense_fact.append(round(-exp_fact / 1e6, 2))
            series_fcf_fact.append(round((inc_fact - exp_fact) / 1e6, 2))
        else:
            series_income_fact.append(None)
            series_expense_fact.append(None)
            series_fcf_fact.append(None)

        th = thailand_plan_by_ym.get((year, month), 0)
        prev_cfcf = series_plan[-2] if len(series_plan) >= 2 else None
        cur_cfcf = series_plan[-1] if series_plan else None
        cfcf_drop = 0.0
        if prev_cfcf is not None and cur_cfcf is not None:
            cfcf_drop = (float(prev_cfcf) - float(cur_cfcf)) * 1e6
        thai_final = year == 2028 and month == 8 and cfcf_drop >= 3_000_000
        if th >= 1_000_000 or thai_final:
            trophy = year == 2028
            amt = th if th >= 1_000_000 else cfcf_drop
            mark = cur_cfcf
            events.append(
                {
                    "index": i,
                    "label": "Готовность квартиры Пхукет" if trophy else "Платёж Таиланд",
                    "detail": _mln(amt) if trophy else f"план {th / 1e6:.2f} млн ₽",
                    "tone": "gold",
                    "value": mark,
                    "category": "Квартира Тайланд",
                    "auto_key": f"auto:thailand:{year}:{month}",
                    **_cal_fields(year, month),
                    **({"icon": "trophy"} if trophy else {}),
                }
            )
        if year == BASE_YEAR and month == closed:
            events.append(
                {
                    "index": i,
                    "label": "Закрытый месяц",
                    "detail": f"факт {series_fact[-1]:.2f} млн ₽" if series_fact[-1] is not None else "",
                    "tone": "sage",
                    "value": series_fact[-1],
                    "category": "",
                    "auto_key": f"auto:closed:{year}:{month}",
                    **_cal_fields(year, month),
                }
            )
        park = parking_plan_by_ym.get((year, month), 0)
        parking_named = year == 2026 and month == 8 and park >= 500_000
        if parking_named:
            events.append(
                {
                    "index": i,
                    "label": "Выкуп парковки Куинджи",
                    "detail": _tys(park),
                    "tone": "gold",
                    "value": series_plan[-1],
                    "category": "Парковка",
                    "auto_key": f"auto:parking:{year}:{month}",
                    **_cal_fields(year, month),
                }
            )
        large = large_plan_by_ym.get((year, month), 0)
        if large >= 500_000 and th < 1_000_000 and not parking_named:
            large_cat = "Крупные покупки"
            large_amt = 0.0
            for cat in ("Парковка", "Крупные покупки", "Отпуска"):
                amt = sum(
                    r["plan"] for r in rows
                    if r.get("year", BASE_YEAR) == year and r["month"] == month and r["category"] == cat
                )
                if amt > large_amt:
                    large_amt = amt
                    large_cat = cat
            events.append(
                {
                    "index": i,
                    "label": "Крупный расход",
                    "detail": f"{large / 1e3:.0f} тыс. план",
                    "tone": "rose",
                    "value": series_plan[-1],
                    "category": large_cat,
                    "auto_key": f"auto:large:{year}:{month}:{large_cat}",
                    **_cal_fields(year, month),
                }
            )
        if year == 2030 and month == 3:
            mort = mortgage_plan_by_ym.get((year, month), 0)
            if mort > 0.5:
                events.append(
                    {
                        "index": i,
                        "label": "Погашение ипотеки",
                        "detail": _mln(mort),
                        "tone": "gold",
                        "icon": "trophy",
                        "value": series_plan[-1],
                        "category": "Ипотека платеж",
                        "auto_key": f"auto:mortgage:{year}:{month}",
                        **_cal_fields(year, month),
                    }
                )

    _reconcile_plan_flows(series_plan, series_income_plan, series_expense_plan, series_fcf_plan)

    seen = set()
    uniq = []
    for e in events:
        key = (e["index"], e["label"], e.get("auto_key") or "")
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)

    return {
        "labels": labels,
        "series_plan": series_plan,
        "series_fact": series_fact,
        "series_income_plan": series_income_plan,
        "series_income_fact": series_income_fact,
        "series_expense_plan": series_expense_plan,
        "series_expense_fact": series_expense_fact,
        "series_fcf_plan": series_fcf_plan,
        "series_fcf_fact": series_fcf_fact,
        "series_forecast": [],
        "events": merge_stored_events(uniq, stored_events or [], series_plan, series_fact),
        "start_year": BASE_YEAR,
        "end_year": FCF_END_YEAR,
        "source": "excel_cumul" if excel_plan else "ledger",
    }


def merge_stored_events(auto_events, stored, series_plan, series_fact) -> list[dict]:
    suppressed = {e.get("auto_key") for e in stored if e.get("suppressed") and e.get("auto_key")}
    overrides = {
        e.get("auto_key"): e
        for e in stored
        if e.get("auto_key") and not e.get("suppressed")
    }
    out = []
    used_keys = set()
    for e in auto_events:
        key = e.get("auto_key") or ""
        if key and key in suppressed:
            continue
        if key and key in overrides:
            ov = overrides[key]
            e = {
                **e,
                "label": ov.get("title") or e["label"],
                "category": ov.get("category") if ov.get("category") is not None else e.get("category"),
            }
        out.append(e)
        if key:
            used_keys.add(key)
    for s in stored:
        if s.get("suppressed"):
            continue
        key = s.get("auto_key") or ""
        if key and key in used_keys:
            continue
        year = int(s.get("year") or BASE_YEAR)
        month = int(s.get("month") or 0)
        if month < 1 or month > 12:
            continue
        index = (year - BASE_YEAR) * 12 + (month - 1)
        if index < 0:
            continue
        val = None
        if index < len(series_fact) and series_fact[index] is not None:
            val = series_fact[index]
        elif index < len(series_plan):
            val = series_plan[index]
        out.append({
            "index": index,
            "label": s.get("title") or "Событие",
            "detail": s.get("category") or "",
            "tone": "gold",
            "value": val,
            "category": s.get("category") or "",
            "auto_key": key,
            "source": s.get("source") or "manual",
            **_cal_fields(year, month),
        })
        if key:
            used_keys.add(key)
    seen = set()
    uniq = []
    for e in out:
        k = (e.get("index"), e.get("label"), e.get("category") or "", e.get("auto_key") or "")
        if k in seen:
            continue
        seen.add(k)
        uniq.append(e)
    return uniq


def pack_display_events(horizon_events, stored) -> list[dict]:
    by_key = {}
    out = []
    for s in stored:
        row = {
            "year": int(s.get("year") or BASE_YEAR),
            "month": int(s.get("month") or 0),
            "category": s.get("category") or "",
            "title": s.get("title") or "",
            "source": s.get("source") or "manual",
            "auto_key": s.get("auto_key") or "",
            "suppressed": 1 if s.get("suppressed") else 0,
        }
        out.append(row)
        if row["auto_key"]:
            by_key[row["auto_key"]] = row
    for e in horizon_events:
        key = e.get("auto_key") or ""
        if key and key in by_key:
            continue
        year = int(e.get("year") or (BASE_YEAR + int(e.get("index") or 0) // 12))
        month = int(e.get("month") or (int(e.get("index") or 0) % 12 + 1))
        dup = next(
            (
                row for row in out
                if not row.get("suppressed")
                and row["year"] == year
                and row["month"] == month
                and row["category"] == (e.get("category") or "")
                and row["title"] == e.get("label")
            ),
            None,
        )
        if dup:
            continue
        row = {
            "year": year,
            "month": month,
            "category": e.get("category") or "",
            "title": e.get("label") or "",
            "source": e.get("source") or ("auto" if key else "manual"),
            "auto_key": key,
            "suppressed": 0,
        }
        out.append(row)
        if key:
            by_key[key] = row
    return out


def build_insights(
    rows: list[dict],
    year: int = 2026,
    closed_month: int | None = None,
    fact_until: int | None = None,
    stored_events: list[dict] | None = None,
) -> dict:
    closed = last_complete_month(rows, closed_month)
    until = max(int(fact_until or closed), closed)
    ytd = list(range(1, closed + 1))
    rows_y = [r for r in rows if r.get("year", year) == year]

    horizon = _build_fcf_horizon(rows, closed, until, stored_events)

    series_plan_y = horizon["series_plan"][:12]
    series_fact_y = horizon["series_fact"][:12]

    excel_fact = read_fact_cumul_series()
    excel_plan = read_plan_horizon()

    if excel_fact and closed >= 1:
        fact_closed = excel_fact["cumul"][closed - 1]
    else:
        fact_closed = START_CAPITAL + sum(
            _month_net(rows_y, m, "fact", core_income=True) for m in ytd
        )

    if excel_plan and closed >= 1:
        plan_closed = excel_plan["cumul"][closed - 1]
    else:
        plan_closed = START_CAPITAL + sum(
            _month_net(rows_y, m, "plan", core_income=True) for m in ytd
        )

    delta = fact_closed - plan_closed

    income_plan = _sum(rows_y, ytd, OPERATING_INCOME, "plan")
    income_fact = _sum(rows_y, ytd, OPERATING_INCOME, "fact")
    exp_plan = _sum(rows_y, ytd, EXPENSE_CATEGORIES, "plan")
    exp_fact = _sum(rows_y, ytd, EXPENSE_CATEGORIES, "fact")

    rest_fact = _sum(rows_y, ytd, ["Рестораны"], "fact")
    family_fact = _sum(rows_y, ytd, ["Расходы на семьи"], "fact")
    thailand_fact = _sum(rows_y, ytd, ["Квартира Тайланд"], "fact")
    thailand_plan = _sum(rows_y, list(range(1, 13)), ["Квартира Тайланд"], "plan")
    thailand_left = max(0, thailand_plan - thailand_fact)

    basket_months = []
    basket_ok = 0
    for m in ytd:
        spent = _sum(rows_y, [m], BASKET_CATEGORIES, "fact")
        planned = _sum(rows_y, [m], BASKET_CATEGORIES, "plan")
        basket_months.append({"month": m, "fact": spent, "plan": planned})
        if spent <= BASKET_LIMIT:
            basket_ok += 1

    cat_rows = []
    for cat in BASKET_CATEGORIES + ["Крупные покупки", "Парковка", "Отпуска"]:
        p = _sum(rows_y, ytd, [cat], "plan")
        f = _sum(rows_y, ytd, [cat], "fact")
        cat_rows.append(
            {
                "category": cat,
                "plan": p,
                "fact": f,
                "delta": f - p,
                "avg": f / max(1, len(ytd)),
            }
        )
    cat_rows.sort(key=lambda x: x["delta"], reverse=True)

    conclusions = []

    # 1. Запас ликвидности к сентябрьскому платежу Таиланда (ещё не в закрытых месяцах)
    thai_sep_plan = _sum(rows_y, [9], ["Квартира Тайланд"], "plan")
    if closed < 9 and thai_sep_plan >= 500_000:
        cover = fact_closed / thai_sep_plan if thai_sep_plan else 0
        conclusions.append(
            {
                "tone": "warn" if cover < 1.2 else "info",
                "title": "Следующий платёж Таиланда — конец сентября",
                "text": (
                    f"В плане на сентябрь {_mln(thai_sep_plan)}; в факте до августа ещё не проведён. "
                    f"Текущий кумулятив FCF {_mln(fact_closed)} "
                    f"{'покрывает платёж с запасом' if cover >= 1.2 else 'почти вровень с платежом — держать кассу отдельно'} "
                    f"(×{cover:.1f})."
                ),
            }
        )

    # 2. Где факт сильнее/слабее плана (не общий delta, а драйвер)
    overs = [c for c in cat_rows if c["delta"] > 50_000]
    unders = [c for c in cat_rows if c["delta"] < -50_000]
    if overs:
        top = overs[0]
        conclusions.append(
            {
                "tone": "warn",
                "title": f"Главный перерасход YTD — {top['category']}",
                "text": (
                    f"Факт {_tys(top['fact'])} против плана {_tys(top['plan'])}: "
                    f"+{_tys(top['delta'])}. Это тянет кумулятив вниз сильнее остальных статей корзины/крупных."
                ),
            }
        )
    elif unders:
        top = unders[0]
        conclusions.append(
            {
                "tone": "good",
                "title": f"Экономия против плана — {top['category']}",
                "text": (
                    f"Факт {_tys(top['fact'])} при плане {_tys(top['plan'])}: "
                    f"{_tys(top['delta'])}. Часть запаса {_tys(delta)} к плану как раз отсюда."
                ),
            }
        )

    if delta >= 0:
        conclusions.append(
            {
                "tone": "good",
                "title": f"Запас к плану FCF: +{_tys(delta)}",
                "text": (
                    f"Кумулятив на {_month_name(closed)}: факт {_mln(fact_closed)} vs план {_mln(plan_closed)}. "
                    "Метрика из строк КУМУЛЯТИВНЫЙ ИТОГ Excel (без займов в ИТОГО)."
                ),
            }
        )
    else:
        conclusions.append(
            {
                "tone": "bad",
                "title": f"Отставание от плана FCF: {_tys(delta)}",
                "text": (
                    f"Факт {_mln(fact_closed)} против плана {_mln(plan_closed)} "
                    f"на конец {_month_name(closed)}."
                ),
            }
        )

    plan_end_2027 = None
    if excel_plan and excel_plan.get("end_2027") is not None:
        plan_end_2027 = excel_plan["end_2027"]
    elif len(horizon["series_plan"]) >= 24:
        plan_end_2027 = horizon["series_plan"][23] * 1e6

    if plan_end_2027 is not None and plan_end_2027 > 0:
        end_2028_txt = (
            _mln(excel_plan["end_2028"])
            if excel_plan and excel_plan.get("end_2028") is not None
            else "—"
        )
        end_2040_txt = (
            _mln(excel_plan["end_2040"])
            if excel_plan and excel_plan.get("end_2040") is not None
            else (
                _mln(horizon["series_plan"][-1] * 1e6)
                if horizon.get("series_plan") and horizon["series_plan"][-1] is not None
                else "—"
            )
        )
        dip_2026 = horizon["series_plan"][11] if len(horizon["series_plan"]) > 11 else None
        conclusions.append(
            {
                "tone": "good",
                "title": "План FCF: горизонт до 2040",
                "text": (
                    f"К дек. 2026 план ~{_mln((dip_2026 or 0) * 1e6) if dip_2026 is not None else '—'}"
                    f" из‑за Таиланда и крупных покупок; к дек. 2027 — {_mln(plan_end_2027)}, "
                    f"к концу 2028 — {end_2028_txt}, к 2040 — {end_2040_txt}."
                ),
            }
        )

    failed = [b for b in basket_months if b["fact"] > BASKET_LIMIT]
    if failed:
        names = ", ".join(_month_name(b["month"]) for b in failed[:4])
        worst = max(failed, key=lambda b: b["fact"])
        conclusions.append(
            {
                "tone": "warn",
                "title": f"Корзина 230 тыс. пробита в {len(failed)} мес.",
                "text": (
                    f"Месяцы: {names}. Пик — {_month_name(worst['month'])}: "
                    f"{_tys(worst['fact'])} при лимите {_tys(BASKET_LIMIT)}."
                ),
            }
        )
    else:
        conclusions.append(
            {
                "tone": "good",
                "title": "Корзина 230 тыс. держится все закрытые месяцы",
                "text": f"Правило п. 7 соблюдено в {len(ytd)} из {len(ytd)} месяцев.",
            }
        )

    if rest_fact > RESTAURANT_YEAR_LIMIT:
        left_m = max(1, 12 - closed)
        burn = rest_fact / max(1, closed)
        conclusions.append(
            {
                "tone": "bad",
                "title": "Рестораны: лимит года уже исчерпан",
                "text": (
                    f"{_tys(rest_fact)} при потолке {_tys(RESTAURANT_YEAR_LIMIT)}. "
                    f"Средний темп ~{_tys(burn)}/мес. — на оставшиеся {left_m} мес. "
                    "имеет смысл жёсткий потолок или перенос встреч домой."
                ),
            }
        )
    elif rest_fact > RESTAURANT_YEAR_LIMIT * 0.7:
        conclusions.append(
            {
                "tone": "warn",
                "title": "Рестораны близко к годовому потолку",
                "text": (
                    f"{_tys(rest_fact)} из {_tys(RESTAURANT_YEAR_LIMIT)} "
                    f"({100 * rest_fact / RESTAURANT_YEAR_LIMIT:.0f}%). Остаток на {12 - closed} мес. — "
                    f"{_tys(max(0, RESTAURANT_YEAR_LIMIT - rest_fact))}."
                ),
            }
        )

    # trim to 5 most useful
    conclusions = conclusions[:5]

    parking_fact = _sum(rows_y, ytd, ["Парковка"], "fact")
    # FCF + оплаченное жильё (как раньше ~12,9 млн)
    net_worth = fact_closed + thailand_fact + parking_fact

    recs = []
    if closed < 9 and thai_sep_plan >= 500_000:
        recs.append(
            {
                "n": f"{len(recs)+1:02d}",
                "tag": "тайланд",
                "title": "Зарезервировать сентябрьский платёж",
                "text": (
                    f"Выделить {_mln(thai_sep_plan)} на конец сентября до прочих трат — "
                    "платёж ещё не в факте, но уже в плане."
                ),
            }
        )
    if overs:
        top = overs[0]
        recs.append(
            {
                "n": f"{len(recs)+1:02d}",
                "tag": top["category"].lower()[:18],
                "title": f"Сжать «{top['category']}» до плана",
                "text": (
                    f"Перерасход {_tys(top['delta'])}. Целевой потолок на остаток года — "
                    f"не выше плана YTD + план оставшихся месяцев."
                ),
            }
        )
    if rest_fact > RESTAURANT_YEAR_LIMIT * 0.85:
        recs.append(
            {
                "n": f"{len(recs)+1:02d}",
                "tag": "рестораны",
                "title": "Заморозить рестораны до нового лимита",
                "text": (
                    f"Уже {_tys(rest_fact)} при годе {_tys(RESTAURANT_YEAR_LIMIT)}. "
                    "До января — только исключения с лимитом на месяц."
                ),
            }
        )
    gap = SAVINGS_GOAL - net_worth
    recs.append(
        {
            "n": f"{len(recs)+1:02d}",
            "tag": "цель 12 млн",
            "title": "12 млн с учётом жилья к концу года",
            "text": (
                f"FCF {_mln(fact_closed)} + Таиланд оплаченный {_mln(thailand_fact)} "
                f"+ паркинг {_mln(parking_fact)} = {_mln(net_worth)}"
                + (f" (до цели ещё {_mln(gap)})." if gap > 0 else " — цель уже перекрыта по этой метрике.")
            ),
        }
    )
    if family_fact < FAMILY_GIFTS_YEAR_LIMIT * 0.5 and len(recs) < 4:
        recs.append(
            {
                "n": f"{len(recs)+1:02d}",
                "tag": "семья",
                "title": "Подарки семьям — запас по лимиту",
                "text": f"{_tys(family_fact)} из {_tys(FAMILY_GIFTS_YEAR_LIMIT)} за год; можно планировать Q4 без срыва потолка.",
            }
        )
    for i, r in enumerate(recs):
        r["n"] = f"{i+1:02d}"


    comments = read_cell_comments()
    monthly = []
    for cat in INCOME_CATEGORIES + EXPENSE_CATEGORIES:
        plan = [_sum(rows_y, [m], [cat], "plan") for m in range(1, 13)]
        fact = [_sum(rows_y, [m], [cat], "fact") for m in range(1, 13)]
        notes = comments.get(cat) or {}
        item = {
            "category": cat,
            "kind": "income" if cat in INCOME_CATEGORIES else "expense",
            "plan": plan,
            "fact": fact,
        }
        fact_notes = notes.get("fact") or [None] * 12
        plan_notes = notes.get("plan") or [None] * 12
        if any(fact_notes):
            item["comment_fact"] = fact_notes
        if any(plan_notes):
            item["comment_plan"] = plan_notes
        monthly.append(item)

    filter_groups, filter_tree = _prune_filters(rows_y)

    return {
        "year": year,
        "closed_month": closed,
        "fact_until": until,
        "cumul_fact": fact_closed,
        "cumul_plan": plan_closed,
        "delta": delta,
        "income_plan": income_plan,
        "income_fact": income_fact,
        "expense_plan": exp_plan,
        "expense_fact": exp_fact,
        "restaurants": rest_fact,
        "restaurant_limit": RESTAURANT_YEAR_LIMIT,
        "basket_limit": BASKET_LIMIT,
        "basket_ok_months": basket_ok,
        "thailand_left": thailand_left,
        "thailand_paid": thailand_fact,
        "parking_paid": parking_fact,
        "net_worth": net_worth,
        "savings_goal": SAVINGS_GOAL,
        "series_plan": series_plan_y,
        "series_fact": series_fact_y,
        "fcf_horizon": horizon,
        "calendar_events": [
            {
                "id": f"fcf-{e['index']}-{e['label']}",
                "date": e["date"],
                "title": e["label"],
                "detail": e.get("detail") or "",
                "icon": e.get("icon") or "star",
                "tone": e.get("tone") or "gold",
            }
            for e in (horizon.get("events") or [])
            if e.get("calendar") and e.get("date")
        ],
        "key_events": pack_display_events(horizon.get("events") or [], stored_events or []),
        "basket_months": basket_months,
        "categories": cat_rows,
        "monthly": monthly,
        "conclusions": conclusions,
        "recommendations": recs,
        "filter_groups": filter_groups,
        "filter_tree": filter_tree,
    }


def _month_name(m: int) -> str:
    names = [
        "",
        "января",
        "февраля",
        "марта",
        "апреля",
        "мая",
        "июня",
        "июля",
        "августа",
        "сентября",
        "октября",
        "ноября",
        "декабря",
    ]
    return names[m]


def _mln(n: float) -> str:
    return f"{n / 1_000_000:.2f} млн ₽".replace(".", ",")


def _tys(n: float) -> str:
    return f"{n / 1_000:.0f} тыс. ₽"
