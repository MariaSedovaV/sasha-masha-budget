"""Динамика активов: ликвидность из FCF fact + недвижимость по рынку.

- Золото: 100 г × учётная цена ЦБ
- Накопления Маша/Саша: старт + потоки FCF факт (без вычета парковки из баланса Маши)
- Пхукет в портфеле только с 2029 (котлован 2026, стройка с конца 2026)
"""

from __future__ import annotations

from .categories import START_CAPITAL
from .excel_fcf import read_fact_cumul_series, read_savings_balances

YEARS = list(range(2024, 2031))
FACT_UNTIL = 2026
GOLD_GRAMS = 100.0

SPB_APT_BUY = 18_500_000.0
SPB_APT_YEAR = 2024
SPB_PARKING_BUY = 1_450_000.0
SPB_PARKING_YEAR = 2024
THAI_BUY = 21_000_000.0
THAI_YEAR = 2026
# В «Сейчас» и портфеле до 2028 Пхукет не учитываем
PHUKET_COUNT_FROM = 2029

KUINDZHI_INDEX = {
    2024: 100.0,
    2025: 108.0,
    2026: 118.0,
    2027: 124.0,
    2028: 130.0,
    2029: 136.0,
    2030: 142.0,
}
KUINDZHI_PARKING_INDEX = {
    2024: 100.0,
    2025: 110.0,
    2026: 122.0,
    2027: 128.0,
    2028: 134.0,
    2029: 140.0,
    2030: 146.0,
}

# Продажи с дек 2025, котлован / старт стройки — конец 2026 → индекс с 2026
BANGTAO_INDEX = {
    2024: 0.0,
    2025: 0.0,
    2026: 100.0,   # котлован
    2027: 112.0,   # активное строительство
    2028: 128.0,
    2029: 145.0,   # ориентир к сдаче / учёт в портфеле
    2030: 158.0,
}

FX_USD = {2024: 92.0, 2025: 90.0, 2026: 86.6, 2027: 88.0, 2028: 90.0, 2029: 92.0, 2030: 94.0}
FX_THB = {2024: 2.65, 2025: 2.60, 2026: 2.63, 2027: 2.66, 2028: 2.70, 2029: 2.74, 2030: 2.78}
GOLD_GRAM = {2024: 7800, 2025: 9800, 2026: 12240, 2027: 13000, 2028: 13800, 2029: 14600, 2030: 15400}


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
    """Ликвидность из КУМУЛЯТИВНЫЙ ИТОГ; накопления — старт + потоки FCF факт."""
    ytd = list(range(1, closed_month + 1))
    excel_fact = read_fact_cumul_series()
    if excel_fact and closed_month >= 1:
        cumul = excel_fact["cumul"][closed_month - 1]
    else:
        cumul = START_CAPITAL + sum(_month_net_core(rows, m, "fact") for m in ytd)

    balances = read_savings_balances(closed_month)
    if balances:
        masha = max(0.0, balances["masha"])
        sasha = max(0.0, balances["sasha"])
    else:
        sasha = _sum_cat(
            rows, ytd, ["Зарплата Саша", "Премия Саша", "Продажа квартиры Саша"], "fact"
        )
        masha = _sum_cat(rows, ytd, ["Зарплата Маша", "Премия Маша"], "fact")

    gold = GOLD_GRAMS * gold_price
    allocated = gold + masha + sasha
    if allocated > cumul and cumul > 0:
        rest = max(0.0, cumul - gold)
        total_sav = masha + sasha
        if total_sav > 0:
            masha = rest * (masha / total_sav)
            sasha = rest * (sasha / total_sav)
        else:
            masha = sasha = 0.0
        cash = 0.0
    else:
        cash = max(0.0, cumul - allocated)

    return {
        "liquid_total": cumul,
        "cash": cash,
        "gold": gold,
        "gold_grams": GOLD_GRAMS,
        "gold_price": gold_price,
        "sasha": sasha,
        "masha": masha,
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


def build_asset_timeline(rows: list[dict], closed_month: int = 7, markets: dict | None = None) -> dict:
    markets = markets or {}
    usd = _blend(FX_USD, (markets.get("usd") or {}).get("value"))
    thb = _blend(FX_THB, (markets.get("thb") or {}).get("value"))
    live_gold = (markets.get("gold_gram") or {}).get("value") or GOLD_GRAM[2026]
    gold_px = _blend(GOLD_GRAM, live_gold)
    liq = liquid_from_ledger(rows, closed_month, gold_px[2026])

    thai_paid = _sum_cat(rows, list(range(1, closed_month + 1)), ["Квартира Тайланд"], "fact")
    base_thb = thb[2026]

    def series_from_2026(base_2026: float, year: int) -> float | None:
        if year < 2026:
            return None
        if year == 2026:
            return base_2026
        return base_2026 * (1 + 0.025 * (year - 2026))

    def spb_apt(year: int) -> float:
        if year < SPB_APT_YEAR:
            return 0.0
        return SPB_APT_BUY * (KUINDZHI_INDEX[year] / KUINDZHI_INDEX[SPB_APT_YEAR])

    def spb_park(year: int) -> float:
        if year < SPB_PARKING_YEAR:
            return 0.0
        return SPB_PARKING_BUY * (KUINDZHI_PARKING_INDEX[year] / KUINDZHI_PARKING_INDEX[SPB_PARKING_YEAR])

    def phuket_market(year: int) -> float | None:
        if year < THAI_YEAR or BANGTAO_INDEX.get(year, 0) <= 0:
            return None
        idx = BANGTAO_INDEX[year] / BANGTAO_INDEX[THAI_YEAR]
        fx = thb[year] / base_thb
        return THAI_BUY * idx * fx

    def paid_by_year(year: int) -> float:
        if year < THAI_YEAR:
            return 0.0
        if year <= 2026:
            return thai_paid
        progress = min(1.0, (year - 2026) / 3.0)
        return thai_paid + max(0.0, THAI_BUY - thai_paid) * progress

    def phuket_equity(year: int) -> float | None:
        """В портфеле только с 2029; до этого — None (не в «Сейчас»)."""
        if year < PHUKET_COUNT_FROM:
            return None
        market = phuket_market(year)
        if market is None:
            return None
        paid = paid_by_year(year)
        return market * min(1.0, paid / THAI_BUY)

    cash_s = [series_from_2026(liq["cash"], y) for y in YEARS]
    masha_s = [series_from_2026(liq["masha"], y) for y in YEARS]
    sasha_s = [series_from_2026(liq["sasha"], y) for y in YEARS]
    gold_s = [None if y < 2026 else round(GOLD_GRAMS * gold_px[y]) for y in YEARS]
    spb_s = [round(spb_apt(y) + spb_park(y)) for y in YEARS]
    phuket_s = []
    for y in YEARS:
        v = phuket_equity(y)
        phuket_s.append(None if v is None else round(v))

    assets = [
        {"id": "cash", "label": "Наличные", "kind": "liquid", "from_year": 2026, "series": [None if v is None else round(v) for v in cash_s]},
        {"id": "masha", "label": "Накопления Маша", "kind": "liquid", "from_year": 2026, "series": [None if v is None else round(v) for v in masha_s]},
        {"id": "sasha", "label": "Накопления Саша", "kind": "liquid", "from_year": 2026, "series": [None if v is None else round(v) for v in sasha_s]},
        {"id": "gold", "label": "Золото", "kind": "liquid", "from_year": 2026, "series": gold_s, "note": f"{GOLD_GRAMS:.0f} г × {gold_px[2026]:,.0f} ₽/г"},
        {"id": "spb", "label": "Недвижимость Петербург", "kind": "property", "from_year": 2024, "series": spb_s, "note": "ЖК «Куинджи»: квартира + паркинг"},
        {"id": "phuket", "label": "Недвижимость Пхукет", "kind": "property", "from_year": PHUKET_COUNT_FROM, "series": phuket_s, "note": f"So Origin Bangtao · в портфеле с {PHUKET_COUNT_FROM} · оплачено {thai_paid/1e6:.2f} из {THAI_BUY/1e6:.0f} млн"},
    ]

    i_now = YEARS.index(2026)
    i_2030 = YEARS.index(2030)
    portfolio = []
    for i in range(len(YEARS)):
        vals = [a["series"][i] for a in assets if a["series"][i] is not None]
        portfolio.append(round(sum(vals)) if vals else None)

    now = portfolio[i_now] or 0
    then = portfolio[i_2030] or 0
    current = {a["id"]: (a["series"][i_now] or 0) for a in assets}

    property_shares = [
        {
            "name": "Куинджи · квартира",
            "value": round(spb_apt(2026)),
            "buy": SPB_APT_BUY,
            "buy_year": 2024,
            "shares": [{"owner": "Саша", "share": 1.0}],
            "note": f"покупка 2024 · рынок × индекс {KUINDZHI_INDEX[2026]:.0f}/100",
        },
        {
            "name": "Куинджи · паркинг",
            "value": round(spb_park(2026)),
            "buy": SPB_PARKING_BUY,
            "buy_year": 2024,
            "shares": [{"owner": "Маша", "share": 1.0}],
            "note": f"покупка 2024 · рынок × индекс {KUINDZHI_PARKING_INDEX[2026]:.0f}/100",
        },
        {
            "name": "Bangtao · So Origin",
            "value": 0,
            "buy": THAI_BUY,
            "buy_year": 2026,
            "shares": [{"owner": "Маша", "share": 0.5}, {"owner": "Саша", "share": 0.5}],
            "note": (
                f"котлован 2026 · стройка с конца 2026 · в «Сейчас» не входит · "
                f"учёт с {PHUKET_COUNT_FROM} · оплачено {thai_paid/1e6:.2f} из {THAI_BUY/1e6:.0f} млн"
            ),
        },
    ]

    return {
        "years": YEARS,
        "fact_until": FACT_UNTIL,
        "assets": assets,
        "portfolio": portfolio,
        "current": current,
        "property_shares": property_shares,
        "liquid": liq,
        "thai_paid": thai_paid,
        "thai_contract": THAI_BUY,
        "phuket_count_from": PHUKET_COUNT_FROM,
        "drivers": {
            "usd": {"unit": "₽/$", "series": [usd[y] for y in YEARS]},
            "thb": {"unit": "₽/฿", "series": [thb[y] for y in YEARS]},
            "gold": {"unit": "₽/г", "series": [gold_px[y] for y in YEARS]},
            "kuindzhi": {"unit": "индекс", "series": [KUINDZHI_INDEX[y] for y in YEARS]},
            "bangtao": {"unit": "индекс", "series": [BANGTAO_INDEX[y] for y in YEARS]},
        },
        "kpis": {
            "now": now,
            "forecast_2030": then,
            "delta_to_2030": then - now,
            "delta_pct": round((then / now - 1) * 100, 1) if now else 0,
            "breakdown_now": {
                "cash": current["cash"],
                "masha": current["masha"],
                "sasha": current["sasha"],
                "gold": current["gold"],
                "spb": current["spb"],
                "phuket": current["phuket"],
            },
        },
        "assumptions": [
            f"Золото: {GOLD_GRAMS:.0f} г × учётная цена ЦБ ({gold_px[2026]:,.0f} ₽/г).",
            "Ликвидность FCF = КУМУЛЯТИВНЫЙ ИТОГ на листе FCF факт.",
            "Накопления Маша/Саша = старт (кол. B) + сумма месячных потоков (стр. 18/19), без вычета парковки из баланса Маши.",
            "Куинджи: 18,5 + 1,45 млн с 2024, оценка = покупка × индекс.",
            f"Пхукет So Origin: продажи с дек 2025, котлован/стройка с конца 2026; в портфеле только с {PHUKET_COUNT_FROM}.",
            "2027–2030 — консервативный сценарий, не инвестсовет.",
        ],
        "sources": [
            "FCF 2026 ФАКТ — кумулятив и накопления",
            "ЖК «Куинджи» (RBI) — ориентиры лотов",
            "So Origin Bangtao Beach — freehold, ~200 м от пляжа",
            f"ЦБ РФ — USD, THB, золото ({gold_px[2026]:,.0f} ₽/г)",
        ],
    }
