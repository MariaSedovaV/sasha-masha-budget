"""Ключевые выводы и рекомендации — пересчитываются при обновлении факта."""

from __future__ import annotations

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
from .excel_fcf import read_fact_cumul_series, read_plan_horizon

# Горизонт кумулятива FCF: факт 2026, план до конца 2028
FCF_END_YEAR = 2028
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


def _build_fcf_horizon(rows, closed: int) -> dict:
    """Факт 2026 (до closed); план 2026–2028 из Excel КУМУЛЯТИВНЫЙ ИТОГ."""
    n_months = (FCF_END_YEAR - BASE_YEAR + 1) * 12
    labels = []
    series_plan = []
    series_fact = []
    events = []

    excel_plan = read_plan_horizon()
    excel_fact = read_fact_cumul_series()

    thailand_plan_by_ym = {}
    large_plan_by_ym = {}
    for r in rows:
        if r.get("year", BASE_YEAR) < BASE_YEAR or r.get("year", BASE_YEAR) > FCF_END_YEAR:
            continue
        key = (r.get("year", BASE_YEAR), r["month"])
        if r["category"] == "Квартира Тайланд":
            thailand_plan_by_ym[key] = thailand_plan_by_ym.get(key, 0) + r["plan"]
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

        if year == BASE_YEAR and month <= closed:
            if excel_fact and month - 1 < len(excel_fact["cumul"]) and excel_fact["cumul"][month - 1]:
                series_fact.append(round(excel_fact["cumul"][month - 1] / 1e6, 2))
                cumul_fact = excel_fact["cumul"][month - 1]
            else:
                fact_net = _month_net(rows, month, "fact", core_income=True)
                cumul_fact += fact_net
                series_fact.append(round(cumul_fact / 1e6, 2))
        else:
            series_fact.append(None)

        th = thailand_plan_by_ym.get((year, month), 0)
        if th >= 1_000_000:
            events.append(
                {
                    "index": i,
                    "label": "Платёж Таиланд",
                    "detail": f"план {th / 1e6:.2f} млн ₽",
                    "tone": "gold",
                    "value": series_plan[-1],
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
                }
            )
        large = large_plan_by_ym.get((year, month), 0)
        if large >= 500_000 and th < 1_000_000:
            events.append(
                {
                    "index": i,
                    "label": "Крупный расход",
                    "detail": f"{large / 1e3:.0f} тыс. план",
                    "tone": "rose",
                    "value": series_plan[-1],
                }
            )

    seen = set()
    uniq = []
    for e in events:
        key = (e["index"], e["label"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)

    return {
        "labels": labels,
        "series_plan": series_plan,
        "series_fact": series_fact,
        "series_forecast": [],
        "events": uniq,
        "start_year": BASE_YEAR,
        "end_year": FCF_END_YEAR,
        "source": "excel_cumul" if excel_plan else "ledger",
    }


def build_insights(rows: list[dict], year: int = 2026, closed_month: int | None = None) -> dict:
    closed = last_complete_month(rows, closed_month)
    ytd = list(range(1, closed + 1))
    rows_y = [r for r in rows if r.get("year", year) == year]

    horizon = _build_fcf_horizon(rows, closed)

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
            else "≈2 млн ₽"
        )
        dip_2026 = horizon["series_plan"][11] if len(horizon["series_plan"]) > 11 else None
        conclusions.append(
            {
                "tone": "good",
                "title": "План FCF: просадка 2026 → восстановление к 2027",
                "text": (
                    f"К дек. 2026 план ~{_mln((dip_2026 or 0) * 1e6) if dip_2026 is not None else '—'}"
                    f" из‑за Таиланда и крупных покупок, но к дек. 2027 уже {_mln(plan_end_2027)}; "
                    f"к концу 2028 — {end_2028_txt}. Горизонт важнее одного «минусового» месяца."
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
    # FCF + оплаченное жильё (как раньше ~12,9 млн) — без вычета будущих месяцев плана
    net_worth = fact_closed + thailand_fact + parking_fact
    fcf_eoy = fact_closed  # для текста рекомендаций: текущий факт как база

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


    monthly = []
    for cat in INCOME_CATEGORIES + EXPENSE_CATEGORIES:
        plan = [_sum(rows_y, [m], [cat], "plan") for m in range(1, 13)]
        fact = [_sum(rows_y, [m], [cat], "fact") for m in range(1, 13)]
        monthly.append(
            {
                "category": cat,
                "kind": "income" if cat in INCOME_CATEGORIES else "expense",
                "plan": plan,
                "fact": fact,
            }
        )

    return {
        "year": year,
        "closed_month": closed,
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
        "basket_months": basket_months,
        "categories": cat_rows,
        "monthly": monthly,
        "conclusions": conclusions,
        "recommendations": recs,
        "filter_groups": FILTER_GROUPS,
        "filter_tree": FILTER_TREE,
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
