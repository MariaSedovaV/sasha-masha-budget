"""Динамика активов: ликвидность из FCF fact + недвижимость по рынку.

- Золото: 100 г с апреля 2025 × учётная цена ЦБ
- Наличные с декабря 2025; накопления Маша/Саша с января 2026
- Петербург: квартира и паркинг с мая 2024
- Пхукет в портфеле с марта 2026 (доля = оплачено / контракт × рынок)
- Горизонт: май 2024 — декабрь 2040, помесячно
"""

from __future__ import annotations

from .categories import START_CAPITAL
from .excel_fcf import read_fact_cumul_series, read_savings_balances

HORIZON_END = 2040
YEARS = list(range(2024, HORIZON_END + 1))
FACT_UNTIL = 2026
GOLD_GRAMS = 100.0

SPB_APT_BUY = 18_500_000.0
SPB_APT_FROM = (2024, 5)
SPB_PARKING_BUY = 1_450_000.0
SPB_PARKING_FROM = (2024, 5)
THAI_BUY = 21_000_000.0
THAI_FROM = (2026, 3)
THAI_PAID_UNTIL = (2029, 12)
GOLD_FROM = (2025, 4)
CASH_FROM = (2025, 12)
MASHA_FROM = (2026, 1)
SASHA_FROM = (2026, 1)

MONTHS_FROM = (2024, 5)


def _extend_linear(base: dict[int, float], end: int, step: float) -> dict[int, float]:
    out = dict(base)
    last_y = max(out)
    last_v = float(out[last_y])
    for y in range(last_y + 1, end + 1):
        last_v = last_v + step
        out[y] = round(last_v, 4)
    return out


def _extend_cagr(base: dict[int, float], end: int, rate: float) -> dict[int, float]:
    """После последнего известного года — сложный процент от текущего индекса, не +N пунктов."""
    out = dict(base)
    last_y = max(out)
    last_v = float(out[last_y])
    for y in range(last_y + 1, end + 1):
        last_v *= 1 + rate
        out[y] = round(last_v, 4)
    return out


# До 2030 — ориентиры по ЖК; дальше рост от текущего уровня, а не одна и та же прибавка.
KUINDZHI_INDEX = _extend_cagr(
    {2024: 100.0, 2025: 108.0, 2026: 118.0, 2027: 124.0, 2028: 130.0, 2029: 136.0, 2030: 142.0},
    HORIZON_END,
    0.035,
)
KUINDZHI_PARKING_INDEX = _extend_cagr(
    {2024: 100.0, 2025: 110.0, 2026: 122.0, 2027: 128.0, 2028: 134.0, 2029: 140.0, 2030: 146.0},
    HORIZON_END,
    0.03,
)
BANGTAO_INDEX = _extend_cagr(
    {2026: 100.0, 2027: 112.0, 2028: 128.0, 2029: 145.0, 2030: 158.0},
    HORIZON_END,
    0.04,
)
FX_USD = _extend_linear(
    {2024: 92.0, 2025: 90.0, 2026: 86.6, 2027: 88.0, 2028: 90.0, 2029: 92.0, 2030: 94.0},
    HORIZON_END,
    2.0,
)
FX_THB = _extend_linear(
    {2024: 2.65, 2025: 2.60, 2026: 2.63, 2027: 2.66, 2028: 2.70, 2029: 2.74, 2030: 2.78},
    HORIZON_END,
    0.04,
)
GOLD_GRAM = _extend_linear(
    {2024: 7800, 2025: 9800, 2026: 12240, 2027: 13000, 2028: 13800, 2029: 14600, 2030: 15400},
    HORIZON_END,
    800,
)


def _tie_thb_to_usd(usd: dict[int, float], thb: dict[int, float]) -> dict[int, float]:
    """После 2030 бат в рублях следует за долларом (THB/USD относительно стабилен)."""
    out = dict(thb)
    anchor_usd = usd[2030]
    anchor_thb = thb[2030]
    if anchor_usd <= 0:
        return out
    for y in range(2031, HORIZON_END + 1):
        out[y] = round(anchor_thb * usd[y] / anchor_usd, 4)
    return out


def _sum_cat(rows, months, cats, field) -> float:
    return sum(r[field] for r in rows if r["month"] in months and r["category"] in cats)


def _month_net_core(rows, month: int, field: str) -> float:
    core = {
        "Зарплата Саша",
        "Премия Саша",
        "Продажа квартиры Саша",
        "Зарплата Маша",
        "Премия Маша",
    }
    inc = sum(
        r[field]
        for r in rows
        if r["month"] == month and r["kind"] == "income" and r["category"] in core
    )
    exp = sum(r[field] for r in rows if r["month"] == month and r["kind"] == "expense")
    return inc - exp


def liquid_from_ledger(rows: list[dict], closed_month: int, gold_price: float) -> dict:
    """Ликвидность: FCF cumul + позиции из FCF факт (старт + потоки)."""
    ytd = list(range(1, closed_month + 1))
    excel_fact = read_fact_cumul_series()
    if excel_fact and closed_month >= 1:
        cumul = excel_fact["cumul"][closed_month - 1]
    else:
        cumul = START_CAPITAL + sum(_month_net_core(rows, m, "fact") for m in ytd)

    balances = read_savings_balances(closed_month)
    gold = GOLD_GRAMS * gold_price
    if balances:
        masha = max(0.0, balances["masha"])
        sasha = max(0.0, balances["sasha"])
        cash = max(0.0, balances.get("cash", 0.0))
        allocated = gold + masha + sasha + cash
        if cumul > allocated:
            masha += cumul - allocated
    else:
        sasha = _sum_cat(
            rows, ytd, ["Зарплата Саша", "Премия Саша", "Продажа квартиры Саша"], "fact"
        )
        masha = _sum_cat(rows, ytd, ["Зарплата Маша", "Премия Маша"], "fact")
        cash = max(0.0, cumul - gold - masha - sasha)

    return {
        "liquid_total": cumul,
        "cash": cash,
        "gold": gold,
        "gold_grams": GOLD_GRAMS,
        "gold_price": gold_price,
        "sasha": sasha,
        "masha": masha,
        "sasha_savings": (balances or {}).get("sasha_savings"),
        "sasha_invest": (balances or {}).get("sasha_invest"),
        "sasha_income_ytd": _sum_cat(
            rows, ytd, ["Зарплата Саша", "Премия Саша", "Продажа квартиры Саша"], "fact"
        ),
        "masha_income_ytd": _sum_cat(rows, ytd, ["Зарплата Маша", "Премия Маша"], "fact"),
        "source": "excel_fcf_fact" if balances else "ledger_fallback",
    }


def _blend(series: dict, live: float | None, year: int = 2026) -> dict:
    out = dict(series)
    if live and live > 0:
        out[year] = float(live)
    return out


def _iter_months(start: tuple[int, int], end: tuple[int, int]) -> list[tuple[int, int]]:
    y, m = start
    y1, m1 = end
    out = []
    while (y, m) <= (y1, m1):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _ym_key(year: int, month: int) -> int:
    return year * 12 + month


def _at_or_after(year: int, month: int, start: tuple[int, int]) -> bool:
    return (year, month) >= start


def _year_end_at(table: dict[int, float], year: int, month: int) -> float:
    """Годовая точка = конец декабря. Внутри года — линейная интерполяция."""
    years = sorted(k for k, v in table.items() if v is not None)
    if not years:
        return 0.0
    if year < years[0]:
        return float(table[years[0]])
    if year > years[-1]:
        return float(table[years[-1]])
    end = float(table[year])
    prev = year - 1
    start = float(table[prev]) if prev in table else end
    return start + (end - start) * (month / 12.0)


def _liquid_path(base_now: float, year: int, month: int, start: tuple[int, int], closed: tuple[int, int]) -> float | None:
    """До закрытого месяца держим факт (истории помесячно нет); дальше +2.5% годовых."""
    if not _at_or_after(year, month, start):
        return None
    if (year, month) <= closed:
        return base_now
    years_ahead = (_ym_key(year, month) - _ym_key(*closed)) / 12.0
    return base_now * (1 + 0.025 * years_ahead)


def build_asset_timeline(rows: list[dict], closed_month: int = 7, markets: dict | None = None) -> dict:
    markets = markets or {}
    usd = _blend(FX_USD, (markets.get("usd") or {}).get("value"))
    thb = _tie_thb_to_usd(usd, _blend(FX_THB, (markets.get("thb") or {}).get("value")))
    live_gold = (markets.get("gold_gram") or {}).get("value") or GOLD_GRAM[2026]
    gold_px = _blend(GOLD_GRAM, live_gold)
    liq = liquid_from_ledger(rows, closed_month, gold_px[2026])

    thai_paid_now = _sum_cat(rows, list(range(1, closed_month + 1)), ["Квартира Тайланд"], "fact")
    thai_paid_by_m = {}
    running = 0.0
    for m in range(1, 13):
        running += _sum_cat(rows, [m], ["Квартира Тайланд"], "fact")
        thai_paid_by_m[m] = running

    closed = (2026, closed_month)
    months = _iter_months(MONTHS_FROM, (HORIZON_END, 12))
    labels = [f"{m:02d}.{y}" for y, m in months]
    now_index = next((i for i, ym in enumerate(months) if ym == closed), 0)
    base_thb = thb[2026] or 1.0

    def paid_at(year: int, month: int) -> float:
        if not _at_or_after(year, month, THAI_FROM):
            return 0.0
        if year == 2026 and month <= closed_month:
            return float(thai_paid_by_m.get(month, thai_paid_now))
        if (year, month) <= closed:
            return 0.0
        t0 = _ym_key(*closed)
        t1 = _ym_key(*THAI_PAID_UNTIL)
        t = _ym_key(year, month)
        progress = min(1.0, max(0.0, (t - t0) / max(1, t1 - t0)))
        return thai_paid_now + max(0.0, THAI_BUY - thai_paid_now) * progress

    def spb_apt_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, SPB_APT_FROM):
            return None
        idx = _year_end_at(KUINDZHI_INDEX, year, month)
        return SPB_APT_BUY * (idx / KUINDZHI_INDEX[SPB_APT_FROM[0]])

    def spb_park_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, SPB_PARKING_FROM):
            return None
        idx = _year_end_at(KUINDZHI_PARKING_INDEX, year, month)
        return SPB_PARKING_BUY * (idx / KUINDZHI_PARKING_INDEX[SPB_PARKING_FROM[0]])

    def phuket_market_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, THAI_FROM):
            return None
        idx_now = _year_end_at(BANGTAO_INDEX, year, month)
        base_idx = BANGTAO_INDEX[THAI_FROM[0]] or 100.0
        if base_idx <= 0 or idx_now <= 0:
            return None
        fx = _year_end_at(thb, year, month) / base_thb
        return THAI_BUY * (idx_now / base_idx) * fx

    def phuket_equity_at(year: int, month: int) -> float | None:
        market = phuket_market_at(year, month)
        if market is None:
            return None
        paid = paid_at(year, month)
        return market * min(1.0, paid / THAI_BUY) if THAI_BUY else None

    def gold_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, GOLD_FROM):
            return None
        if (year, month) == closed:
            return GOLD_GRAMS * float(gold_px[2026])
        return GOLD_GRAMS * _year_end_at(gold_px, year, month)

    cash_s, masha_s, sasha_s, gold_s, spb_s, phuket_s = [], [], [], [], [], []
    for year, month in months:
        cash_s.append(_liquid_path(liq["cash"], year, month, CASH_FROM, closed))
        masha_s.append(_liquid_path(liq["masha"], year, month, MASHA_FROM, closed))
        sasha_s.append(_liquid_path(liq["sasha"], year, month, SASHA_FROM, closed))
        gold_s.append(gold_at(year, month))
        apt = spb_apt_at(year, month)
        park = spb_park_at(year, month)
        if apt is None and park is None:
            spb_s.append(None)
        else:
            spb_s.append((apt or 0) + (park or 0))
        phuket_s.append(phuket_equity_at(year, month))

    def rnd_series(series):
        return [None if v is None else round(v) for v in series]

    assets = [
        {"id": "cash", "label": "Наличные", "kind": "liquid", "from_year": CASH_FROM[0], "from_month": CASH_FROM[1], "series": rnd_series(cash_s)},
        {"id": "masha", "label": "Накопления Маша", "kind": "liquid", "from_year": MASHA_FROM[0], "from_month": MASHA_FROM[1], "series": rnd_series(masha_s)},
        {"id": "sasha", "label": "Накопления Саша", "kind": "liquid", "from_year": SASHA_FROM[0], "from_month": SASHA_FROM[1], "series": rnd_series(sasha_s)},
        {
            "id": "gold",
            "label": "Золото",
            "kind": "liquid",
            "from_year": GOLD_FROM[0],
            "from_month": GOLD_FROM[1],
            "series": rnd_series(gold_s),
            "note": f"покупка апрель 2025 · {GOLD_GRAMS:.0f} г × {gold_px[2026]:,.0f} ₽/г",
        },
        {
            "id": "spb",
            "label": "Недвижимость Петербург",
            "kind": "property",
            "from_year": SPB_APT_FROM[0],
            "from_month": SPB_APT_FROM[1],
            "series": rnd_series(spb_s),
            "note": "ЖК «Куинджи»: квартира + паркинг, май 2024",
        },
        {
            "id": "phuket",
            "label": "Недвижимость Пхукет",
            "kind": "property",
            "from_year": THAI_FROM[0],
            "from_month": THAI_FROM[1],
            "series": rnd_series(phuket_s),
            "note": (
                f"So Origin Bangtao · с марта 2026 · оплачено {thai_paid_now/1e6:.2f} из {THAI_BUY/1e6:.0f} млн"
            ),
        },
    ]

    portfolio = []
    for i in range(len(months)):
        vals = [a["series"][i] for a in assets if a["series"][i] is not None]
        portfolio.append(round(sum(vals)) if vals else None)

    now = portfolio[now_index] or 0
    i_2030 = next((i for i, (y, m) in enumerate(months) if y == 2030 and m == 12), now_index)
    i_2040 = next((i for i, (y, m) in enumerate(months) if y == HORIZON_END and m == 12), len(months) - 1)
    then_2030 = portfolio[i_2030] or 0
    then = portfolio[i_2040] or 0
    current = {a["id"]: (a["series"][now_index] or 0) for a in assets}
    # «Сейчас» и состав — без Пхукета (котлован); на графике портфеля он остаётся.
    now_headline = max(0, now - (current.get("phuket") or 0))

    apt_now = spb_apt_at(2026, closed_month) or 0
    park_now = spb_park_at(2026, closed_month) or 0
    phuket_mkt_now = phuket_market_at(2026, closed_month) or THAI_BUY

    property_shares = [
        {
            "name": "Куинджи · квартира",
            "value": round(apt_now),
            "buy": SPB_APT_BUY,
            "buy_year": 2024,
            "shares": [{"owner": "Саша", "share": 1.0}],
            "note": f"покупка май 2024 · рынок × индекс {KUINDZHI_INDEX[2026]:.0f}/100",
        },
        {
            "name": "Куинджи · паркинг",
            "value": round(park_now),
            "buy": SPB_PARKING_BUY,
            "buy_year": 2024,
            "shares": [{"owner": "Маша", "share": 1.0}],
            "note": f"покупка май 2024 · рынок × индекс {KUINDZHI_PARKING_INDEX[2026]:.0f}/100",
        },
        {
            "name": "Bangtao · So Origin",
            "value": round(phuket_mkt_now),
            "buy": THAI_BUY,
            "buy_year": 2026,
            "shares": [{"owner": "Маша", "share": 0.5}, {"owner": "Саша", "share": 0.5}],
            "note": (
                f"покупка март 2026 · рынок {phuket_mkt_now/1e6:.1f} млн · "
                f"в портфеле доля оплаты {thai_paid_now/1e6:.2f} из {THAI_BUY/1e6:.0f} млн"
            ),
        },
    ]

    usd_m = [_year_end_at(usd, y, m) for y, m in months]
    thb_m = [_year_end_at(thb, y, m) for y, m in months]
    gold_m = [_year_end_at(gold_px, y, m) for y, m in months]
    usd_m[now_index] = float(usd[2026])
    thb_m[now_index] = float(thb[2026])
    gold_m[now_index] = float(gold_px[2026])

    return {
        "years": YEARS,
        "labels": labels,
        "granularity": "month",
        "now_index": now_index,
        "now_year": 2026,
        "now_month": closed_month,
        "start_year": MONTHS_FROM[0],
        "end_year": HORIZON_END,
        "fact_until": FACT_UNTIL,
        "assets": assets,
        "portfolio": portfolio,
        "current": current,
        "property_shares": property_shares,
        "liquid": liq,
        "thai_paid": thai_paid_now,
        "thai_contract": THAI_BUY,
        "phuket_count_from": THAI_FROM[0],
        "horizon_end": HORIZON_END,
        "drivers": {
            "usd": {"unit": "₽/$", "series": usd_m},
            "thb": {"unit": "₽/฿", "series": thb_m},
            "gold": {"unit": "₽/г", "series": gold_m},
            "kuindzhi": {"unit": "индекс", "series": [_year_end_at(KUINDZHI_INDEX, y, m) for y, m in months]},
            "bangtao": {"unit": "индекс", "series": [_year_end_at(BANGTAO_INDEX, y, m) for y, m in months]},
        },
        "kpis": {
            "now": now_headline,
            "now_with_phuket": now,
            "forecast_2030": then_2030,
            "forecast_2040": then,
            "delta_to_2030": then_2030 - now_headline,
            "delta_to_2040": then - now_headline,
            "delta_pct": round((then / now_headline - 1) * 100, 1) if now_headline else 0,
            "breakdown_now": {
                "cash": current["cash"],
                "masha": current["masha"],
                "sasha": current["sasha"],
                "gold": current["gold"],
                "spb": current["spb"],
                "phuket": 0,
            },
        },
        "assumptions": [
            f"Золото: куплено в апреле 2025, {GOLD_GRAMS:.0f} г × цена ЦБ на закрытый месяц ({gold_px[2026]:,.0f} ₽/г).",
            "Наличные — с декабря 2025; накопления Маша и Саша — с января 2026. До закрытого месяца на графике факт (без выдуманной внутригодовой траектории), далее +2,5% годовых.",
            "Куинджи: квартира и паркинг с мая 2024. До 2030 — индекс ЖК, с 2031 — 3,5% и 3% годовых от текущего уровня.",
            f"Пхукет: на графике портфеля с марта 2026 как доля оплаты ({thai_paid_now/1e6:.2f} из {THAI_BUY/1e6:.0f} млн) × рынок. В «Сейчас» и составе не входит — до сдачи. До 2030 индекс Bangtao, с 2031 — 4% годовых в батах.",
            "USD: 2026 — курс ЦБ; к 2030 сценарий 94 ₽; далее +2 ₽/год (~2%/год), близко к разрыву инфляции 4% РФ / 2% США при цели ЦБ. Это сценарий, не прогноз ЦБ.",
            f"2027–{HORIZON_END} — сценарий, не инвестсовет.",
        ],
        "sources": [
            "FCF 2026 ФАКТ — кумулятив, накопления, доллары, инвестиции",
            "ЖК «Куинджи» (RBI)",
            "So Origin Bangtao Beach — freehold",
            f"ЦБ РФ — USD, THB, золото ({gold_px[2026]:,.0f} ₽/г)",
        ],
    }
