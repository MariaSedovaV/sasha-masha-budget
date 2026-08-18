"""Авторазнос операций справки по статьям FCF Excel."""

from __future__ import annotations

import re
from typing import Iterable

# Порядок важен: первое совпадение побеждает.
# Сопоставление собрано по справке Т-Банка 01.01–16.08.2026 и статьям FCF / СВОД.
RULES: list[tuple[str, str, int]] = [
    (r"кэшбэк|привет,?\s*мир", "Кэшбэк", 95),
    (
        r"внутренний перевод на вклад|частичное изъятие вклада|закрытие вклада|"
        r"внутрибанковский перевод|перевод с договора|перевод средств на вклад",
        "Между своими счетами",
        94,
    ),
    (r"40702810006000102400|парк(овк|ing)|osipchuk", "Парковка", 93),
    (r"pegas thailand|intourcom|travelask|safe travels|авиасейлс|nordwind|biletix|kupibilet|yp\*kupibilet", "Отпуска", 90),
    (r"штраф|гибдд", "Парковки и штрафы", 90),
    (r"md\.\*?zsd|зсд|ural(sky|skij) most|uralskij most", "Парковки и штрафы", 88),
    (r"azs|газпромнефть|tatneft|бензин", "Бензин", 90),
    (r"whoosh|scooters|самокат(?! )|яндекс.*самокат", "Такси", 86),
    (r"yandex\*.*go|yandex\*.*taxi|яндекс.*такси|taxi", "Такси", 92),
    (r"samokat|lavka|lenta|лента|vkusvill|вкусвилл|perekrestok|перекресток|"
     r"pyaterochka|пятерочка|magnit|магнит|metro tpp|korzinka|семейный|"
     r"produkty|фрукты|ovoschi|sber\*5411\*samokat", "Супермаркеты", 92),
    (r"yandex\*5411\*(lavka|dkrit|yandex)|yandex\*5411\*edarit", "Супермаркеты", 90),
    (r"yandex\*5814\*eda|yamiyami|яндекс.*еда", "Рестораны", 90),
    (r"ivi\.ru|mirazh|мираж|qtickets|кино|музей|muze|ledovyy|боулинг|"
     r"сервисы яндекса|netmonet|a\.paywall", "Развлечения", 88),
    (r"фитнес|fitnes|bushido|абонемент", "Абонемент в спорт-зал", 88),
    (r"beauty|стрижк|маникюр|zakanail|zielinski", "Бьюти процедуры", 88),
    (r"apteka|аптека|поликлиник|мед\.|medis|профме", "Прочее", 80),
    (r"mts|мтс|mbank\.mts|lgs esim|мобильн", "Мобильная связь", 90),
    (r"wildberries|wb\*|ozon|яндекс.*market|yandex\*5399\*market", "Крупные покупки", 82),
    (r"12 storeez|henderson|одежд|oversize", "Одежда и обувь", 88),
    (r"ulybka radugi|косметик|zielinski", "Косметика", 86),
    (r"maxidom|м\.видео|лаборатория мебели|товары для дома", "Товары для дома", 86),
    (r"gosuslugi|госуслуги|налог|epgu|ufk ", "Налоги", 84),
    (r"внешний перевод по номеру|перевод по номеру телефона", "Переводы", 88),
    (r"банковский перевод\. банк гпб|мир perevod|mtsdeng", "Переводы", 80),
    (r"пополнение\. система быстрых платежей|пополнение\. сбербанк", "Зарплата Маша", 70),
    (r"авито|avito", "Прочее", 72),
    (r"снятие наличных", "Прочее", 75),
    (r"красное.?[&и ].*белое|krasnoe|winelab|wine bar|вино", "Рестораны", 78),
    (
        r"picceriya|soficoffee|uppetit|steakhaus|kotiki|starik khinkal|"
        r"carbonico|wine bar|katernaneve|tokino|cafe|restoran|kafe |"
        r"vkusno-i tochka|bufet|fud servis|pyshechka|ognivo|morozhenoe|"
        r"ryumochnaya|banya |baggins|surf coffee|gringo|bubble tea|"
        r"loft |vendos|teremok|chajkhona|papa gril|prokhinkali|"
        r"kofeynya|street coffee|amy cafe|pravda kofe|bonch coffee|"
        r"the sizzle|du nord|mumu burgers|dzamiko|orda piter|cekh|"
        r"bekicer|unity |stolovaya|xplat|coffee|кофе|шаурма|grill|"
        r"ресторан|кафе|пицц|бургер|стейк",
        "Рестораны",
        74,
    ),
]


def categorize(description: str, amount: float, learned: Iterable[tuple[str, str]] | None = None) -> tuple[str, int]:
    text = (description or "").lower()
    text = text.replace("ё", "е")

    if learned:
        for needle, category in learned:
            if needle and needle.lower() in text:
                return category, 99

    rounded = abs(round(float(amount)))
    if rounded in (72_500, 724_500, 652_500):
        return "Парковка", 88

    refund = re.match(
        r"^(отмена операции оплаты|возврат средств по оплате|возврат средств по|возврат покупки через сбп\.?)\s*",
        text,
    )
    if refund:
        inner = text[refund.end():].strip()
        if inner and inner != text:
            cat, conf = categorize(inner, -abs(amount), None)
            return cat, max(60, conf - 10)
        return "Прочее", 55

    for pattern, category, conf in RULES:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return category, conf

    if amount > 0:
        return "Зарплата Маша", 40
    return "Прочее", 40
