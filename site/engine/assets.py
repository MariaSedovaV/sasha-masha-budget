"""Динамика активов: ликвидность из FCF 2026 ФАКТ + недвижимость по рынку.

- Золото: 100 г с апреля 2025 × учётная цена ЦБ
- Наличные, накопления Маша/Саша: старт + помесячные потоки FCF 2026 ФАКТ, не ниже нуля
- Саша инвестиции: отдельно, ОФЗ с оценкой по YTM до октября 2026; с ноября ряд скрыт
- Петербург: квартира 18,5 млн с мая 2024 (котлован), ключи сен 2026; паркинг отдельно
- Пхукет: старт строительства март 2026, ключи Q3 2028, без курсовой просадки
- Горизонт: май 2024 — декабрь 2040, помесячно
"""

from __future__ import annotations

from .categories import START_CAPITAL
from .excel_fcf import (
    read_encumbrance_schedule,
    read_fact_cumul_series,
    read_savings_balances,
    read_savings_month_ends,
)

HORIZON_END = 2040
YEARS = list(range(2024, HORIZON_END + 1))
FACT_UNTIL = 2026
GOLD_GRAMS = 100.0

SPB_APT_BUY = 18_500_000.0
SPB_APT_FROM = (2024, 5)
SPB_APT_COMMISSION = (2026, 8)  # ввод в эксплуатацию
SPB_APT_KEYS = (2026, 9)  # ключи
SPB_PARKING_BUY = 1_450_000.0
SPB_PARKING_FROM = (2024, 5)
THAI_BUY = 20_922_179.0  # контракт / старт строительства, март 2026, ₽
THAI_FROM = (2026, 3)
THAI_KEYS = (2028, 9)  # ключи Q3 2028, полная оплата
GOLD_FROM = (2025, 4)
CASH_FROM = (2025, 12)
MASHA_FROM = (2025, 12)
SASHA_FROM = (2025, 12)
SASHA_INV_FROM = (2025, 12)
OFZ_YTM_DEFAULT = 0.155
OFZ_FORECAST_UNTIL = (2026, 10)
OFZ_HIDE_FROM = (2026, 11)
COMPOSE_PHUKET_FROM = 2029

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


# Узлы — конкретные месяцы (покупка / ввод / ключи), не «среднегодовой» индекс.
# 100 на дате сделки, иначе старт квартиры съезжает из‑за паркинга и интерполяции с декабря.
KUINDZHI_KNOTS = {
    (2024, 5): 100.0,   # котлован, 18,5 млн
    (2024, 12): 103.0,
    (2025, 12): 108.0,
    (2026, 8): 116.0,    # ввод
    (2026, 9): 118.0,    # ключи
    (2026, 12): 118.0,
    (2027, 12): 124.0,
    (2028, 12): 130.0,
    (2029, 12): 136.0,
    (2030, 12): 142.0,
}
KUINDZHI_PARKING_KNOTS = {
    (2024, 5): 100.0,
    (2024, 12): 104.0,
    (2025, 12): 110.0,
    (2026, 8): 120.0,
    (2026, 9): 122.0,
    (2026, 12): 122.0,
    (2027, 12): 128.0,
    (2028, 12): 134.0,
    (2029, 12): 140.0,
    (2030, 12): 146.0,
}
# Пхукет в рублях контракта: без краткосрочного курса бата (он давал ложную просадку в 2026).
BANGTAO_KNOTS = {
    (2026, 3): 100.0,    # старт строительства / контракт
    (2026, 12): 100.0,
    (2027, 12): 112.0,
    (2028, 9): 128.0,    # ключи Q3, полная оплата
    (2028, 12): 132.0,
    (2029, 12): 145.0,
    (2030, 12): 158.0,
}
KUINDZHI_CAGR = 0.035
KUINDZHI_PARKING_CAGR = 0.03
BANGTAO_CAGR = 0.04

KUINDZHI_INDEX = _extend_cagr(
    {y: KUINDZHI_KNOTS[(y, 12)] for y in range(2024, 2031)},
    HORIZON_END,
    KUINDZHI_CAGR,
)
KUINDZHI_PARKING_INDEX = _extend_cagr(
    {y: KUINDZHI_PARKING_KNOTS[(y, 12)] for y in range(2024, 2031)},
    HORIZON_END,
    KUINDZHI_PARKING_CAGR,
)
BANGTAO_INDEX = _extend_cagr(
    {2026: 100.0, 2027: 112.0, 2028: 132.0, 2029: 145.0, 2030: 158.0},
    HORIZON_END,
    BANGTAO_CAGR,
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
        masha = max(0.0, float(balances["masha"] or 0.0))
        sasha = max(0.0, float(balances["sasha"] or 0.0))
        cash = max(0.0, balances.get("cash", 0.0))
        sasha_invest = float(balances.get("sasha_invest") or 0.0)
    else:
        sasha = _sum_cat(
            rows, ytd, ["Зарплата Саша", "Премия Саша", "Продажа квартиры Саша"], "fact"
        )
        masha = _sum_cat(rows, ytd, ["Зарплата Маша", "Премия Маша"], "fact")
        cash = max(0.0, cumul - gold - masha - sasha)
        sasha_invest = 0.0

    return {
        "liquid_total": cumul,
        "cash": cash,
        "gold": gold,
        "gold_grams": GOLD_GRAMS,
        "gold_price": gold_price,
        "sasha": sasha,
        "masha": masha,
        "sasha_savings": (balances or {}).get("sasha_savings", sasha),
        "sasha_invest": sasha_invest,
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


def _interp_knots(
    knots: dict[tuple[int, int], float],
    year: int,
    month: int,
    after_cagr: float | None = None,
) -> float:
    """Линейно между узлами (год, месяц); после последнего — сложный процент."""
    key = (year, month)
    points = sorted(knots)
    if not points:
        return 0.0
    if key in knots:
        return float(knots[key])
    if key <= points[0]:
        return float(knots[points[0]])
    last = points[-1]
    if key >= last:
        last_v = float(knots[last])
        if not after_cagr:
            return last_v
        months_ahead = _ym_key(year, month) - _ym_key(*last)
        return last_v * ((1 + after_cagr) ** (months_ahead / 12.0))
    for a, b in zip(points, points[1:]):
        if a <= key <= b:
            n0, n1, n = _ym_key(*a), _ym_key(*b), _ym_key(year, month)
            w = (n - n0) / (n1 - n0) if n1 != n0 else 1.0
            return float(knots[a]) + (float(knots[b]) - float(knots[a])) * w
    return float(knots[last])


def _liquid_at(
    series: dict[tuple[int, int], float] | None,
    year: int,
    month: int,
    start: tuple[int, int],
    fallback: float | None = None,
) -> float | None:
    if not _at_or_after(year, month, start):
        return None
    if series is not None and (year, month) in series:
        return float(series[(year, month)])
    return fallback


def _ofz_ytm(markets: dict | None) -> tuple[float, str]:
    """Доходность ОФЗ: RGBEY с Мосбиржи, иначе 15,5%."""
    raw = (markets or {}).get("ofz_ytm") or {}
    val = raw.get("value") if isinstance(raw, dict) else raw
    try:
        ytm = float(val)
    except (TypeError, ValueError):
        ytm = OFZ_YTM_DEFAULT
    if ytm > 1:
        ytm /= 100.0
    if not (0.02 <= ytm <= 0.40):
        ytm = OFZ_YTM_DEFAULT
    src = (raw.get("name") if isinstance(raw, dict) else None) or "RGBI"
    return ytm, src


def ofz_market_path(
    start: float,
    flows: dict[tuple[int, int], float] | None,
    ytm: float,
    accrue_until: tuple[int, int] = OFZ_FORECAST_UNTIL,
    end: tuple[int, int] = (HORIZON_END, 12),
) -> dict[tuple[int, int], float]:
    """Номинал ОФЗ + помесячный пересчёт цены по YTM до октября 2026, затем поток плана."""
    flows = flows or {}
    value = float(start or 0.0)
    out: dict[tuple[int, int], float] = {(2025, 12): value}
    monthly_rate = float(ytm) / 12.0
    for year, month in _iter_months((2026, 1), end):
        if (year, month) <= accrue_until and value > 0:
            value *= 1.0 + monthly_rate
        value += float(flows.get((year, month), 0.0) or 0.0)
        if value < 0:
            value = 0.0
        out[(year, month)] = value
    return out


def build_asset_timeline(rows: list[dict], closed_month: int = 7, markets: dict | None = None) -> dict:
    markets = markets or {}
    usd = _blend(FX_USD, (markets.get("usd") or {}).get("value"))
    thb = _tie_thb_to_usd(usd, _blend(FX_THB, (markets.get("thb") or {}).get("value")))
    live_gold = (markets.get("gold_gram") or {}).get("value") or GOLD_GRAM[2026]
    gold_px = _blend(GOLD_GRAM, live_gold)
    liq = liquid_from_ledger(rows, closed_month, gold_px[2026])
    savings_paths = read_savings_month_ends(closed_month) or {}
    ofz_ytm, ofz_src = _ofz_ytm(markets)
    ofz_start = float(savings_paths.get("sasha_invest_start") or liq.get("sasha_invest") or 1_550_000)
    ofz_path = ofz_market_path(
        ofz_start,
        savings_paths.get("sasha_invest_flows"),
        ofz_ytm,
    )

    thai_paid_now = _sum_cat(rows, list(range(1, closed_month + 1)), ["Квартира Тайланд"], "fact")

    closed = (2026, closed_month)
    months = _iter_months(MONTHS_FROM, (HORIZON_END, 12))
    labels = [f"{m:02d}.{y}" for y, m in months]
    now_index = next((i for i, ym in enumerate(months) if ym == closed), 0)

    def spb_apt_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, SPB_APT_FROM):
            return None
        idx = _interp_knots(KUINDZHI_KNOTS, year, month, KUINDZHI_CAGR)
        return SPB_APT_BUY * (idx / 100.0)

    def spb_park_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, SPB_PARKING_FROM):
            return None
        idx = _interp_knots(KUINDZHI_PARKING_KNOTS, year, month, KUINDZHI_PARKING_CAGR)
        return SPB_PARKING_BUY * (idx / 100.0)

    def phuket_market_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, THAI_FROM):
            return None
        idx = _interp_knots(BANGTAO_KNOTS, year, month, BANGTAO_CAGR)
        return THAI_BUY * (idx / 100.0)

    def phuket_equity_at(year: int, month: int) -> float | None:
        # Контракт на старте строительства: на графике — рыночная оценка объекта, не доля оплаты.
        return phuket_market_at(year, month)

    def gold_at(year: int, month: int) -> float | None:
        if not _at_or_after(year, month, GOLD_FROM):
            return None
        if (year, month) == closed:
            return GOLD_GRAMS * float(gold_px[2026])
        return GOLD_GRAMS * _year_end_at(gold_px, year, month)

    cash_s, masha_s, sasha_s, ofz_s, gold_s, spb_s, park_s, phuket_s = [], [], [], [], [], [], [], []
    for year, month in months:
        cash_s.append(_liquid_at(savings_paths.get("cash"), year, month, CASH_FROM, liq["cash"]))
        masha_s.append(_liquid_at(savings_paths.get("masha"), year, month, MASHA_FROM, liq["masha"]))
        sasha_s.append(
            _liquid_at(
                savings_paths.get("sasha_savings") or savings_paths.get("sasha"),
                year,
                month,
                SASHA_FROM,
                liq["sasha"],
            )
        )
        ofz_s.append(_liquid_at(ofz_path, year, month, SASHA_INV_FROM, ofz_start))
        gold_s.append(gold_at(year, month))
        spb_s.append(spb_apt_at(year, month))
        park_s.append(spb_park_at(year, month))
        phuket_s.append(phuket_equity_at(year, month))

    ofz_last = 0.0
    ofz_to_masha = 0.0
    for i, (year, month) in enumerate(months):
        if (year, month) < OFZ_HIDE_FROM:
            if ofz_s[i] is not None:
                ofz_last = float(ofz_s[i])
            continue
        if ofz_to_masha <= 0 and ofz_last:
            ofz_to_masha = ofz_last
        ofz_s[i] = None
        if masha_s[i] is not None:
            masha_s[i] = float(masha_s[i]) + ofz_to_masha

    def rnd_series(series):
        return [None if v is None else round(v) for v in series]

    assets = [
        {"id": "cash", "label": "Наличные", "kind": "liquid", "from_year": CASH_FROM[0], "from_month": CASH_FROM[1], "series": rnd_series(cash_s)},
        {
            "id": "masha",
            "label": "Накопления Маша",
            "kind": "liquid",
            "from_year": MASHA_FROM[0],
            "from_month": MASHA_FROM[1],
            "series": rnd_series(masha_s),
            "note": "кумулятив FCF 2026 ФАКТ, строка «Маша накопления»; с прогноза — плюс нераспределённый FCF месяца",
        },
        {
            "id": "sasha",
            "label": "Накопления Саша",
            "kind": "liquid",
            "from_year": SASHA_FROM[0],
            "from_month": SASHA_FROM[1],
            "series": rnd_series(sasha_s),
            "note": "кумулятив FCF 2026 ФАКТ, строка «Саша накопления»",
        },
        {
            "id": "sasha_invest",
            "label": "Саша инвестиции",
            "kind": "liquid",
            "from_year": SASHA_INV_FROM[0],
            "from_month": SASHA_INV_FROM[1],
            "series": rnd_series(ofz_s),
            "note": (
                f"ОФЗ · старт {ofz_start/1e6:.2f} млн ₽ · "
                f"оценка по {ofz_src} {ofz_ytm*100:.1f}% до октября 2026 · "
                f"с ноября 2026 ряд скрыт, остаток в накоплениях Маша"
            ),
        },
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
            "note": "ЖК «Куинджи»: квартира 18,5 млн, котлован май 2024, ключи сен 2026",
        },
        {
            "id": "parking",
            "label": "Паркинг Петербург",
            "kind": "property",
            "from_year": SPB_PARKING_FROM[0],
            "from_month": SPB_PARKING_FROM[1],
            "series": rnd_series(park_s),
            "note": "ЖК «Куинджи»: паркинг 1,45 млн, май 2024",
        },
        {
            "id": "phuket",
            "label": "Недвижимость Пхукет",
            "kind": "property",
            "from_year": THAI_FROM[0],
            "from_month": THAI_FROM[1],
            "series": rnd_series(phuket_s),
            "note": (
                f"So Origin Bangtao · старт строительства март 2026 · "
                f"ключи Q3 2028 · контракт {THAI_BUY/1e6:.2f} млн ₽"
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
    liq = dict(liq)
    liq["masha"] = current.get("masha") or 0
    liq["sasha"] = current.get("sasha") or 0
    liq["sasha_savings"] = current.get("sasha") or 0
    liq["sasha_invest"] = current.get("sasha_invest") or 0
    liq["ofz_ytm"] = ofz_ytm
    liq["ofz_src"] = ofz_src
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
            "note": (
                f"котлован май 2024 · 18,5 млн ₽ · ввод авг 2026 · ключи сен 2026 · "
                f"сейчас {apt_now/1e6:.2f} млн"
            ),
        },
        {
            "name": "Куинджи · паркинг",
            "value": round(park_now),
            "buy": SPB_PARKING_BUY,
            "buy_year": 2024,
            "shares": [{"owner": "Маша", "share": 1.0}],
            "note": f"покупка май 2024 · 1,45 млн ₽ · сейчас {park_now/1e6:.2f} млн",
        },
        {
            "name": "Bangtao · So Origin",
            "value": round(phuket_mkt_now),
            "buy": THAI_BUY,
            "buy_year": 2026,
            "shares": [{"owner": "Маша", "share": 0.5}, {"owner": "Саша", "share": 0.5}],
            "note": (
                f"старт строительства март 2026 · ключи Q3 2028 при полной оплате · "
                f"контракт {THAI_BUY/1e6:.2f} млн ₽ · сейчас {phuket_mkt_now/1e6:.2f} млн · "
                f"оплачено {thai_paid_now/1e6:.2f} млн"
            ),
        },
    ]

    usd_m = [_year_end_at(usd, y, m) for y, m in months]
    thb_m = [_year_end_at(thb, y, m) for y, m in months]
    gold_m = [_year_end_at(gold_px, y, m) for y, m in months]
    usd_m[now_index] = float(usd[2026])
    thb_m[now_index] = float(thb[2026])
    gold_m[now_index] = float(gold_px[2026])

    enc_sched = read_encumbrance_schedule()

    def remaining_encumbrance(after_year: int, after_month: int) -> dict:
        thai = 0.0
        mort = 0.0
        for row in enc_sched:
            if (int(row["year"]), int(row["month"])) > (after_year, after_month):
                thai += float(row.get("thai") or 0.0)
                mort += float(row.get("mortgage") or 0.0)
        return {
            "thai": round(thai),
            "mortgage": round(mort),
            "total": round(thai + mort),
        }

    def parts_at(index: int, year: int) -> dict[str, float]:
        out = {}
        for a in assets:
            val = a["series"][index]
            amount = 0.0 if val is None else float(val)
            if a["id"] == "phuket" and year < COMPOSE_PHUKET_FROM:
                amount = 0.0
            out[a["id"]] = round(amount)
        return out

    composition_years = [y for y in YEARS if y >= FACT_UNTIL]
    composition = {"years": composition_years, "phuket_from": COMPOSE_PHUKET_FROM, "by_year": {}}
    for year in composition_years:
        if year == FACT_UNTIL:
            idx = now_index
            as_of = (FACT_UNTIL, closed_month)
        else:
            idx = next((i for i, (y, m) in enumerate(months) if y == year and m == 12), now_index)
            as_of = (year, 12)
        parts = parts_at(idx, year)
        total = sum(parts.values())
        enc = remaining_encumbrance(*as_of)
        composition["by_year"][str(year)] = {
            "as_of_year": as_of[0],
            "as_of_month": as_of[1],
            "parts": parts,
            "total": round(total),
            "encumbrance": enc,
            "total_after_encumbrance": round(max(0.0, total - enc["total"])),
        }

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
            "kuindzhi": {"unit": "индекс", "series": [_interp_knots(KUINDZHI_KNOTS, y, m, KUINDZHI_CAGR) for y, m in months]},
            "bangtao": {"unit": "индекс", "series": [_interp_knots(BANGTAO_KNOTS, y, m, BANGTAO_CAGR) for y, m in months]},
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
                "sasha_invest": current.get("sasha_invest") or 0,
                "gold": current["gold"],
                "spb": current["spb"],
                "parking": current.get("parking") or 0,
                "phuket": 0,
            },
        },
        "composition": composition,
        "encumbrance_schedule": enc_sched,
        "assumptions": [
            f"Золото: куплено в апреле 2025, {GOLD_GRAMS:.0f} г × цена ЦБ на закрытый месяц ({gold_px[2026]:,.0f} ₽/г).",
            "Наличные («Доллары дома»), накопления Маша и Саша: старт 2026 плюс помесячные потоки строк FCF 2026 ФАКТ. Остаток не ниже нуля. С прогноза (после закрытого месяца) нераспределённый FCF месяца — в накопления Маша. С 2027 — потоки FCF ПЛАН плюс тот же остаток.",
            (
                f"Саша инвестиции — отдельно: ОФЗ, старт {ofz_start/1e6:.2f} млн ₽. "
                f"Цена до октября 2026 — помесячно по доходности {ofz_src} {ofz_ytm*100:.1f}% годовых. "
                f"С ноября 2026 ряд на графике не показывается; остаток учтён в накоплениях Маша."
            ),
            "Куинджи, квартира: 18,5 млн ₽ в мае 2024 (котлован). Ввод — август 2026, ключи — сентябрь 2026. Паркинг 1,45 млн ₽ — отдельный ряд. С 2031: +3,5% и +3% годовых.",
            f"Пхукет: старт строительства март 2026, контракт {THAI_BUY/1e6:.2f} млн ₽; ключи и полная оплата — Q3 2028. Оценка в рублях контракта по стройке, без краткосрочного курса бата (он давал ложную просадку сразу после покупки). В «Состав» входит с 2029. На графике портфеля — с марта 2026. С 2031 — +4% годовых.",
            "Обременение: будущие платежи по Таиланду (до 2028) и ипотеке (последний платёж в 2030) относительно выбранного периода состава.",
            "USD: 2026 — курс ЦБ; к 2030 сценарий 94 ₽; далее +2 ₽/год. Это сценарий, не прогноз ЦБ.",
            f"2027–{HORIZON_END} — сценарий, не инвестсовет.",
        ],
        "sources": [
            "FCF 2026 ФАКТ — кумулятив накоплений Маша/Саша, доллары, Саша инвестиции",
            f"Мосбиржа {ofz_src} — доходность ОФЗ для оценки инвестиций",
            "ЖК «Куинджи» (RBI)",
            "So Origin Bangtao Beach — freehold",
            f"ЦБ РФ — USD, THB, золото ({gold_px[2026]:,.0f} ₽/г)",
        ],
    }
