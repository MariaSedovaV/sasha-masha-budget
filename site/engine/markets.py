"""Курсы ЦБ: доллар, бат, учётная цена золота. Кэш на час."""

from __future__ import annotations


import json
import ssl
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "markets_cache.json"
TTL_SEC = 3600
CBR_DAILY = "https://www.cbr-xml-daily.ru/daily_json.js"
CBR_DAILY_ALT = "https://www.cbr.ru/scripts/XML_daily.asp"
CBR_METAL = "https://www.cbr.ru/scripts/xml_metall.asp?date_req1={d}&date_req2={d}"
CTX = ssl.create_default_context()


def _get(url: str, timeout: int = 15) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SashaMashaBudget/1.0",
            "Accept": "application/json, application/xml, text/xml, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        return resp.read()


def _load_cache() -> dict | None:
    if not CACHE_PATH.exists():
        return None
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        if time.time() - data.get("fetched_at", 0) < TTL_SEC and data.get("usd"):
            data["cached"] = True
            return data
        return data
    except Exception:
        return None


def _save_cache(payload: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload["fetched_at"] = time.time()
    CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _from_json_daily(raw: bytes) -> dict:
    data = json.loads(raw.decode("utf-8"))
    usd = data.get("Valute", {}).get("USD", {})
    thb = data.get("Valute", {}).get("THB", {})
    nom = thb.get("Nominal") or 1
    return {
        "as_of": data.get("Date"),
        "usd": {
            "value": usd.get("Value"),
            "previous": usd.get("Previous"),
            "name": usd.get("Name"),
        } if usd else None,
        "thb": {
            "value": (thb.get("Value") or 0) / nom,
            "previous": (thb.get("Previous") or 0) / nom,
            "name": thb.get("Name"),
        } if thb else None,
    }


def _from_cbr_xml(raw: bytes) -> dict:
    text = raw.decode("windows-1251")
    root = ET.fromstring(text)
    out = {"as_of": root.attrib.get("Date"), "usd": None, "thb": None}
    for val in root.findall("Valute"):
        code = val.findtext("CharCode")
        nom = float(val.findtext("Nominal") or 1)
        value = float((val.findtext("Value") or "0").replace(",", "."))
        item = {"value": value / nom, "previous": None, "name": val.findtext("Name")}
        if code == "USD":
            out["usd"] = item
        if code == "THB":
            out["thb"] = item
    return out


def _gold() -> dict | None:
    today = datetime.now()
    for delta in range(0, 8):
        day = (today - timedelta(days=delta)).strftime("%d/%m/%Y")
        try:
            xml = _get(CBR_METAL.format(d=day)).decode("windows-1251")
        except Exception:
            continue
        root = ET.fromstring(xml)
        for rec in root.findall("Record"):
            if rec.attrib.get("Code") != "1":
                continue
            price = rec.findtext("Buy") or rec.findtext("Sell")
            if not price:
                continue
            return {
                "date": rec.attrib.get("Date"),
                "value": float(price.replace(",", ".")),
                "unit": "руб. за грамм",
            }
    return None


def fetch_markets(force: bool = False) -> dict:
    cached = _load_cache()
    if cached and cached.get("usd") and not force:
        if time.time() - cached.get("fetched_at", 0) < TTL_SEC:
            cached["cached"] = True
            cached["error"] = None
            return cached

    payload = {
        "as_of": None,
        "usd": None,
        "thb": None,
        "gold_gram": None,
        "error": None,
        "cached": False,
        "next_refresh_sec": TTL_SEC,
    }
    try:
        payload.update(_from_json_daily(_get(CBR_DAILY)))
    except Exception:
        try:
            payload.update(_from_cbr_xml(_get(CBR_DAILY_ALT)))
        except Exception as exc:
            payload["error"] = f"Курсы валют: {exc}"

    try:
        payload["gold_gram"] = _gold()
    except Exception as exc:
        extra = f"Золото: {exc}"
        payload["error"] = f"{payload['error']}; {extra}" if payload["error"] else extra

    if payload.get("usd"):
        payload["error"] = None
        _save_cache(payload)
        return payload

    if cached and cached.get("usd"):
        cached["cached"] = True
        cached["error"] = payload.get("error") or "Показаны последние сохранённые курсы"
        return cached
    return payload
