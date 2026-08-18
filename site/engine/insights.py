"""Ключевые выводы и рекомендации — пересчитываются при обновлении факта."""

from __future__ import annotations

from .categories import (
    BASKET_CATEGORIES,
    BASKET_LIMIT,
    EXPENSE_CATEGORIES,
    FAMILY_GIFTS_YEAR_LIMIT,
    FILTER_GROUPS,
    INCOME_CATEGORIES,
    RESTAURANT_YEAR_LIMIT,
    SAVINGS_GOAL,
)


def _sum(rows, months, cats, field) -> float:
    return sum(r[field] for r in rows if r["month"] in months and r["category"] in cats)


def _month_net(rows, month: int, field: str) -> float:
    inc = sum(
        r[field]
        for r in rows
        if r["month"] == month and r["kind"] == "income" and r["category"] != "Займы"
    )
    exp = sum(r[field] for r in rows if r["month"] == month and r["kind"] == "expense")
    return inc - exp


def last_complete_month(rows, meta_closed: int | None = None) -> int:
    if meta_closed:
        return int(meta_closed)
    months = sorted({r["month"] for r in rows if r["source"] in ("excel", "import", "manual")})
    return max(months) if months else 7


def build_insights(rows: list[dict], year: int = 2026, closed_month: int | None = None) -> dict:
    closed = last_complete_month(rows, closed_month)
    ytd = list(range(1, closed + 1))
    start = 9_000_000

    cumul_plan = start
    cumul_fact = start
    series_plan = []
    series_fact = []
    for m in range(1, 13):
        cumul_plan += _month_net(rows, m, "plan")
        series_plan.append(round(cumul_plan / 1_000_000, 2))
        if m <= closed:
            cumul_fact += _month_net(rows, m, "fact")
            series_fact.append(round(cumul_fact / 1_000_000, 2))
        else:
            series_fact.append(None)

    fact_closed = start + sum(_month_net(rows, m, "fact") for m in ytd)
    plan_closed = start + sum(_month_net(rows, m, "plan") for m in ytd)
    delta = fact_closed - plan_closed

    fcf_income = [c for c in INCOME_CATEGORIES if c != "Займы"]
    income_plan = _sum(rows, ytd, fcf_income, "plan")
    income_fact = _sum(rows, ytd, fcf_income, "fact")
    exp_plan = _sum(rows, ytd, EXPENSE_CATEGORIES, "plan")
    exp_fact = _sum(rows, ytd, EXPENSE_CATEGORIES, "fact")

    rest_fact = _sum(rows, ytd, ["Рестораны"], "fact")
    rest_plan = _sum(rows, ytd, ["Рестораны"], "plan")
    family_fact = _sum(rows, ytd, ["Расходы на семьи"], "fact")
    thailand_fact = _sum(rows, ytd, ["Квартира Тайланд"], "fact")
    thailand_plan = _sum(rows, list(range(1, 13)), ["Квартира Тайланд"], "plan")
    thailand_left = max(0, thailand_plan - thailand_fact)

    basket_months = []
    basket_ok = 0
    for m in ytd:
        spent = _sum(rows, [m], BASKET_CATEGORIES, "fact")
        planned = _sum(rows, [m], BASKET_CATEGORIES, "plan")
        basket_months.append({"month": m, "fact": spent, "plan": planned})
        if spent <= BASKET_LIMIT:
            basket_ok += 1

    cat_rows = []
    for cat in BASKET_CATEGORIES + ["Крупные покупки", "Парковка", "Отпуска"]:
        p = _sum(rows, ytd, [cat], "plan")
        f = _sum(rows, ytd, [cat], "fact")
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
    if delta >= 0:
        conclusions.append(
            {
                "tone": "good",
                "title": "Факт опережает план по кумулятиву FCF",
                "text": (
                    f"На конец {_month_name(closed)} кумулятив факта { _mln(fact_closed) } "
                    f"против плана { _mln(plan_closed) }: плюс { _tys(delta) }. "
                    "Это главная метрика модели (зарплаты и премии минус расходы)."
                ),
            }
        )
    else:
        conclusions.append(
            {
                "tone": "bad",
                "title": "Факт отстаёт от плана по кумулятиву FCF",
                "text": (
                    f"На конец {_month_name(closed)} факт { _mln(fact_closed) } "
                    f"против плана { _mln(plan_closed) }: минус { _tys(-delta) }."
                ),
            }
        )

    conclusions.append(
        {
            "tone": "info",
            "title": "Доходы перекрывают перерасход корзины" if income_fact - income_plan > exp_fact - exp_plan else "Перерасход корзины сильнее прироста доходов",
            "text": (
                f"Доходы C5:C9 за {closed} мес.: план {_mln(income_plan)}, факт {_mln(income_fact)} "
                f"({_signed(income_fact - income_plan)}). Расходы: план {_mln(exp_plan)}, "
                f"факт {_mln(exp_fact)} ({_signed(exp_fact - exp_plan)})."
            ),
        }
    )

    if rest_fact > RESTAURANT_YEAR_LIMIT:
        conclusions.append(
            {
                "tone": "bad",
                "title": "Лимит ресторанов уже пробит",
                "text": (
                    f"Рестораны { _tys(rest_fact) } при годовом потолке 150 тыс. "
                    f"и плане { _tys(rest_plan) }. Факт ближе к 2025 году (~64 тыс./мес.), "
                    "чем к заложенным 10 тыс./мес."
                ),
            }
        )

    conclusions.append(
        {
            "tone": "warn" if basket_ok < closed / 2 else "info",
            "title": f"Корзина 230 тыс. выдержана в {basket_ok} из {closed} месяцев",
            "text": "Правило п. 7. Исключения — месяцы с крупными покупками, отпусками и выкупом парковки.",
        }
    )

    if thailand_left > 1_000_000:
        conclusions.append(
            {
                "tone": "warn",
                "title": "Впереди крупный платёж за Таиланд",
                "text": (
                    f"Оплачено { _mln(thailand_fact) } из { _mln(thailand_plan) }. "
                    f"Остаток { _mln(thailand_left) } — в плане на сентябрь. "
                    f"Даже с опережением FCF это просадит ликвидность."
                ),
            }
        )

    if closed == 8:
        conclusions.append(
            {
                "tone": "info",
                "title": "Август можно закрывать справкой",
                "text": "Загрузите справку о движении средств за август, проверьте авторазнос и подтвердите месяц.",
            }
        )

    recs = []
    if rest_fact > RESTAURANT_YEAR_LIMIT:
        recs.append(
            {
                "n": "01",
                "tag": "рестораны",
                "title": "Пересобрать лимит на еду вне дома",
                "text": (
                    f"Уже { _tys(rest_fact) } при потолке 150 тыс. "
                    "Либо поднять норму до 30–35 тыс./мес., либо на остаток года ходить реже."
                ),
            }
        )
    if thailand_left > 0:
        recs.append(
            {
                "n": "02",
                "tag": "ликвидность",
                "title": "Сверить кассу к сентябрьскому платежу",
                "text": (
                    f"Остаток за Таиланд { _mln(thailand_left) }. "
                    "Смотреть живые депозиты Маши и Саши, не кумулятив FCF."
                ),
            }
        )

    parking_fact = _sum(rows, ytd, ["Парковка"], "fact")
    net_worth = fact_closed + thailand_fact + parking_fact
    recs.append(
        {
            "n": "03",
            "tag": "цель 12 млн",
            "title": "12 млн с учётом недвижимости",
            "text": (
                f"Цель 12 млн = FCF + оплаченный Таиланд + паркинг. "
                f"Сейчас { _mln(fact_closed) } + { _mln(thailand_fact) } + { _mln(parking_fact) } "
                f"= { _mln(net_worth) }. "
                + (
                    "Цель закрыта. Квартира в Петербурге в сумму не входит — в модели нет оценки."
                    if net_worth >= SAVINGS_GOAL
                    else f"До цели { _mln(SAVINGS_GOAL - net_worth) }. Петербург в расчёт не входит — нет оценки."
                )
            ),
        }
    )
    if family_fact < FAMILY_GIFTS_YEAR_LIMIT:
        recs.append(
            {
                "n": "04",
                "tag": "семья",
                "title": "Подарки семьям пока с запасом",
                "text": f"{ _tys(family_fact) } из 100 тыс. за год. Крупные всплески лучше бронировать заранее.",
            }
        )
    recs.append(
        {
            "n": str(len(recs) + 1).zfill(2),
            "tag": "данные",
            "title": "Править категории в интерфейсе",
            "text": "На вкладке «Данные» магазин запоминается. Следующая справка разнесётся уже по вашим правилам.",
        }
    )

    monthly = []
    for cat in INCOME_CATEGORIES + EXPENSE_CATEGORIES:
        plan = [_sum(rows, [m], [cat], "plan") for m in range(1, 13)]
        fact = [_sum(rows, [m], [cat], "fact") for m in range(1, 13)]
        monthly.append({"category": cat, "kind": "income" if cat in INCOME_CATEGORIES else "expense", "plan": plan, "fact": fact})

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
        "series_plan": series_plan,
        "series_fact": series_fact,
        "basket_months": basket_months,
        "categories": cat_rows,
        "monthly": monthly,
        "conclusions": conclusions,
        "recommendations": recs,
        "filter_groups": FILTER_GROUPS,
    }


def _month_name(m: int) -> str:
    names = ["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
    return names[m]


def _mln(n: float) -> str:
    return f"{n / 1_000_000:.2f} млн ₽".replace(".", ",")


def _tys(n: float) -> str:
    return f"{n / 1_000:.0f} тыс. ₽"


def _signed(n: float) -> str:
    sign = "+" if n >= 0 else "−"
    return f"{sign}{abs(n) / 1_000:.0f} тыс."
