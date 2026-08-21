(function () {
  const NOTES_KEY = "sasha-masha-notes";
  const BUDGET_ADDS_KEY = "sasha-masha-budget-adds";
  const HOME = "https://mariasedovav.github.io/sasha-masha/";
  const LINKS = {
    home: HOME,
    budget: "https://mariasedovav.github.io/sasha-masha-budget/",
    pitanie: "https://mariasedovav.github.io/sasha-masha-pitanie/",
    zametki: "https://mariasedovav.github.io/sasha-masha-zametki/",
    goals: HOME + "#цели",
  };

  const EXPENSE_CATS = [
    ["Ипотека платеж", ["ипотека"]],
    ["Дедушка долг", ["дедушка", "долг дедушки"]],
    ["Ремонт квартиры", ["ремонт"]],
    ["Квартира Тайланд", ["тайланд", "таиланд"]],
    ["Свадебное путешествие", ["свадебн", "медовый"]],
    ["Саша учеба", ["учеба", "учёба"]],
    ["Парковка", ["абонемент парков", "парковка маши"]],
    ["Отпуска", ["отпуск"]],
    ["Страховка", ["страхов"]],
    ["Налоги", ["налог"]],
    ["Ребенок", ["ребенок", "ребёнок", "дети"]],
    ["Супермаркеты", ["супермаркет", "продукт", "пятероч", "магнит", "перекрёст", "перекрест", "вкусвилл", "еда"]],
    ["Такси", ["такси", "яндекс го", "uber", "каршеринг"]],
    ["Рестораны", ["ресторан", "кафе", "кофе", "обед", "ужин"]],
    ["Одежда и обувь", ["одежд", "обув", "платье", "кроссов"]],
    ["Квартплата", ["квартплат", "жкх", "коммунал"]],
    ["Мобильная связь", ["связь", "мтс", "мегафон", "билайн", "теле2", "мобильн"]],
    ["Товары для дома", ["дом", "ikeа", "икеа", "хоз"]],
    ["Косметика", ["косметик"]],
    ["Развлечения", ["развлеч", "кино", "театр", "концерт"]],
    ["Бьюти процедуры", ["бьюти", "маникюр", "стрижк", "салон"]],
    ["Парковки и штрафы", ["штраф", "парковк"]],
    ["Бензин", ["бензин", "заправк"]],
    ["Переводы", ["перевод"]],
    ["Прочее", ["прочее", "разное"]],
    ["Расходы на семьи", ["семьи", "родител"]],
    ["Подарки друг другу", ["подарок", "подарки"]],
    ["Крупные покупки", ["крупн", "техник"]],
    ["Абонемент в спорт-зал", ["спорт", "зал", "фитнес"]],
  ];

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function currentMonth() {
    return new Date().getMonth() + 1;
  }
  function monthName(n) {
    return ["январе","феврале","марте","апреле","мае","июне","июле","августе","сентябре","октябре","ноябре","декабре"][n - 1];
  }
  function onPath(re) {
    return re.test(location.pathname);
  }
  function already(url) {
    try {
      const u = new URL(url, location.href);
      return location.origin === u.origin && location.pathname.replace(/\/+$/, "") === u.pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
  }

  function parseAmount(text) {
    const raw = norm(text);
    let m = raw.match(/(\d[\d\s]{0,12}\d|\d+)\s*(?:тыс|к\b)/);
    if (m) return Number(String(m[1]).replace(/\s/g, "")) * 1000;
    m = raw.match(/(\d[\d\s]{0,12}\d|\d+)\s*(?:руб|р |₽)?/);
    if (m) return Number(String(m[1]).replace(/\s/g, ""));
    return null;
  }
  function matchCategory(text) {
    const n = norm(text);
    let best = null;
    let bestLen = 0;
    for (const [name, aliases] of EXPENSE_CATS) {
      const keys = [norm(name), ...aliases];
      for (const key of keys) {
        if (key && n.includes(key) && key.length >= bestLen) {
          best = name;
          bestLen = key.length;
        }
      }
    }
    return best;
  }

  function loadNotes() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "null");
      return {
        sasha: Array.isArray(raw?.sasha) ? raw.sasha : [],
        masha: Array.isArray(raw?.masha) ? raw.masha : [],
      };
    } catch {
      return { sasha: [], masha: [] };
    }
  }
  function addNote(person, text) {
    const notes = loadNotes();
    notes[person].push({ id: uid(), text, done: false, at: Date.now(), updatedAt: Date.now() });
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    if (window.SashaCloud && typeof window.SashaCloud.setNotes === "function") {
      window.SashaCloud.setNotes(notes);
    }
  }
  function addExpense(category, amount) {
    const month = currentMonth();
    const year = new Date().getFullYear();
    let list = [];
    try { list = JSON.parse(localStorage.getItem(BUDGET_ADDS_KEY) || "[]"); } catch {}
    if (!Array.isArray(list)) list = [];
    list.push({ id: uid(), year, month, category, amount, at: Date.now(), updatedAt: Date.now() });
    localStorage.setItem(BUDGET_ADDS_KEY, JSON.stringify(list));
    if (window.SashaCloud && typeof window.SashaCloud.setBudgetAdds === "function") {
      window.SashaCloud.setBudgetAdds(list);
    }
    return { month, year };
  }
  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ru-RU";
      u.rate = 1.02;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  }

  function go(url) {
    if (already(url)) {
      if (onPath(/sasha-masha-zametki/) && typeof window.sashaNotesReload === "function") window.sashaNotesReload();
      if (onPath(/sasha-masha-budget/) && typeof window.sashaBudgetReload === "function") window.sashaBudgetReload();
      return false;
    }
    setTimeout(() => { location.href = url; }, 650);
    return true;
  }

  function handleCommand(raw) {
    const text = String(raw || "").trim();
    const n = norm(text);
    if (!n) return { say: "Скажите ещё раз — я не расслышала." };

    if (/(помощ|умеешь|сценари|что можешь|help)/.test(n)) {
      return { say: "Могу открыть бюджет, питание, заметки или цели. Добавить дело Саше или Маше. Записать трату в категорию этого месяца. Интернет сама не ищу — но могу открыть поиск Яндекса." };
    }
    if (/(найди|погугли|поиск|что такое|кто такой|загугли)/.test(n)) {
      const q = text.replace(/^(найди|погугли|поиск|что такое|кто такой|загугли)\s+/i, "").trim() || text;
      return { say: "Сама в интернет не хожу. Открыла поиск Яндекса — там уже можно посмотреть.", search: q };
    }
    if (/(бюджет|мониторинг|деньг|финанс|fcf)/.test(n)) {
      return { say: already(LINKS.budget) ? "Мы уже в бюджете." : "Открываю мониторинг бюджета.", open: LINKS.budget };
    }
    if (/(питани|еда|рацион|меню|рецепт)/.test(n)) {
      return { say: already(LINKS.pitanie) ? "Мы уже в питании." : "Открываю питание.", open: LINKS.pitanie };
    }
    if (/(заметк|список дел|туду|todo)/.test(n) && !/(добав|запиш|напомн)/.test(n)) {
      return { say: already(LINKS.zametki) ? "Мы уже в заметках." : "Открываю заметки.", open: LINKS.zametki };
    }
    if (/(цел[иь]|горизонт|желани)/.test(n) && !/(добав|новую цель)/.test(n)) {
      return { say: "Открываю цели.", goals: true };
    }
    if (/(домой|главн|экосистем|лендинг)/.test(n)) {
      return { say: "Возвращаю на главную.", home: true };
    }
    if (/(светл(ая|ую) тем|темн(ая|ую) тем|переключ.*тем)/.test(n)) {
      return { say: "Переключаю тему.", theme: true };
    }

    const person = /(маше|маши|для маши)\b/.test(n) ? "masha" : /(саше|саши|для саши)\b/.test(n) ? "sasha" : null;
    const wantsTask = /(дело|задач|напомн|запиш|добав)/.test(n);
    if (person && (wantsTask || /^(маше|саше)\b/.test(n))) {
      let task = text
        .replace(/^(пожалуйста|давай|можешь)\s+/i, "")
        .replace(/^(добавь|запиши|напомни|поставь)\s+(дело\s+)?/i, "")
        .replace(/^(дело\s+)?(маше|маши|саше|саши|для маши|для саши)\s*[:\-–]?\s*/i, "")
        .replace(/^(маше|саше)\s+/i, "")
        .trim();
      if (!task || task.length < 2) {
        return { say: person === "masha" ? "Какое дело добавить Маше?" : "Какое дело добавить Саше?" };
      }
      addNote(person, task);
      const who = person === "masha" ? "Маше" : "Саше";
      return { say: `Добавила дело ${who}: «${task}». Оно уже в заметках.`, open: LINKS.zametki };
    }

    const amount = parseAmount(text);
    const cat = matchCategory(text);
    const wantsMoney = /(добав|запиш|потрат|трат|затрат|минус|списал)/.test(n) || (amount && cat);
    if (wantsMoney && amount && cat) {
      const { month } = addExpense(cat, amount);
      return {
        say: `Записала ${amount.toLocaleString("ru-RU")} ₽ в «${cat}» за ${monthName(month)}. Сумма появится в факте на вкладке «Данные».`,
        open: LINKS.budget,
      };
    }
    if (wantsMoney && amount && !cat) {
      return { say: `Сумму ${amount.toLocaleString("ru-RU")} ₽ услышала. В какую категорию записать — такси, рестораны, супермаркеты?` };
    }
    if (wantsMoney && cat && !amount) {
      return { say: `Категория «${cat}» есть. Назовите сумму цифрами.` };
    }
    return { say: "Не расслышала сценарий. Можно: «открой бюджет», «добавь Маше купить молоко», «запиши 1500 в такси»." };
  }

  function injectCss() {
    if (document.getElementById("assist-css")) return;
    const s = document.createElement("style");
    s.id = "assist-css";
    s.textContent = `
.assist-fab{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:80;border:0;background:var(--gold,#d4b483);color:var(--on-accent,#1a140c);border-radius:999px;padding:14px 18px;font:700 12px Montserrat,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;box-shadow:0 16px 40px rgba(0,0,0,.28)}
.assist-fab.hidden{display:none!important}
.assist-panel{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:85;width:min(420px,calc(100vw - 24px));height:min(560px,calc(100dvh - 24px));display:flex;flex-direction:column;background:var(--panel,rgba(23,26,34,.92));color:var(--ink,#efe8dc);border:1px solid var(--line,rgba(239,232,220,.08));border-radius:24px;backdrop-filter:blur(22px);box-shadow:0 24px 70px rgba(0,0,0,.32);overflow:hidden}
.assist-panel.hidden{display:none!important}
.assist-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 16px 12px;border-bottom:1px solid var(--line,rgba(239,232,220,.08))}
.assist-head .eyebrow{margin:0 0 4px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold,#d4b483);font-weight:600}
.assist-head strong{display:block;font-size:16px;letter-spacing:-.03em}
.assist-close{border:1px solid var(--line,rgba(239,232,220,.08));background:var(--bg-2,#12141b);color:inherit;border-radius:999px;padding:8px 12px;font:600 11px Montserrat,sans-serif;cursor:pointer}
.assist-log{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.assist-msg{max-width:92%;padding:10px 12px;border-radius:16px;font-size:13px;line-height:1.45}
.assist-msg.bot{background:var(--bg,#0b0c10);border:1px solid var(--line,rgba(239,232,220,.08));align-self:flex-start}
.assist-msg.user{background:color-mix(in srgb,var(--gold,#d4b483) 22%,var(--bg,#0b0c10));align-self:flex-end}
.assist-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 10px}
.assist-chips button{border:1px solid var(--line,rgba(239,232,220,.08));background:var(--bg-2,#12141b);color:var(--muted,#9a9286);border-radius:999px;padding:6px 10px;font:600 11px Montserrat,sans-serif;cursor:pointer}
.assist-form{display:grid;gap:8px;padding:0 16px max(16px,env(safe-area-inset-bottom))}
.assist-form input{width:100%;border:1px solid var(--line,rgba(239,232,220,.08));background:var(--bg,#0b0c10);color:inherit;border-radius:999px;padding:11px 14px;font:500 14px Montserrat,sans-serif;outline:none}
.assist-mic{border:1px solid var(--gold,#d4b483);background:color-mix(in srgb,var(--gold,#d4b483) 16%,var(--bg,#0b0c10));color:var(--gold-2,#e8d3a8);border-radius:999px;min-height:46px;font:700 12px Montserrat,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;touch-action:none}
.assist-mic.holding{background:var(--gold,#d4b483);color:var(--on-accent,#1a140c)}
.assist-form button[type=submit]{border:0;background:var(--gold,#d4b483);color:var(--on-accent,#1a140c);border-radius:999px;min-height:42px;font:700 12px Montserrat,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
@media (max-width:720px){.assist-panel{right:0;left:0;bottom:0;width:100%;height:min(78dvh,640px);border-radius:24px 24px 0 0}}
`;
    document.head.appendChild(s);
  }

  function injectDom() {
    if (document.getElementById("assist-panel")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <button type="button" class="assist-fab" id="assist-open">Помощник</button>
      <section class="assist-panel hidden" id="assist-panel" hidden>
        <header class="assist-head">
          <div><p class="eyebrow">семейный помощник</p><strong>Текстом или голосом</strong></div>
          <button type="button" class="assist-close" id="assist-close">Закрыть</button>
        </header>
        <div class="assist-log" id="assist-log"></div>
        <div class="assist-chips">
          <button type="button" data-assist="открой бюджет">бюджет</button>
          <button type="button" data-assist="открой питание">питание</button>
          <button type="button" data-assist="открой заметки">заметки</button>
          <button type="button" data-assist="открой цели">цели</button>
          <button type="button" data-assist="добавь Маше купить молоко">дело Маше</button>
          <button type="button" data-assist="запиши 1500 в такси">трата</button>
        </div>
        <form class="assist-form" id="assist-form">
          <input id="assist-input" type="text" maxlength="240" placeholder="Открой бюджет, добавь Саше дело…" autocomplete="off" />
          <button type="button" class="assist-mic" id="assist-mic">Зажать и говорить</button>
          <button type="submit">Отправить</button>
        </form>
      </section>`;
    document.body.appendChild(wrap);
  }

  function bootAssistant() {
    injectCss();
    injectDom();
    const panel = document.getElementById("assist-panel");
    const log = document.getElementById("assist-log");
    const form = document.getElementById("assist-form");
    const input = document.getElementById("assist-input");
    const mic = document.getElementById("assist-mic");
    const openBtn = document.getElementById("assist-open");
    const closeBtn = document.getElementById("assist-close");
    if (!panel || !form) return;

    function addMsg(role, text) {
      const el = document.createElement("div");
      el.className = "assist-msg " + role;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    function run(text, fromVoice) {
      addMsg("user", text);
      const res = handleCommand(text);
      addMsg("bot", res.say);
      if (fromVoice) speak(res.say);
      if (res.theme) document.getElementById("theme-toggle")?.click();
      if (res.goals) {
        const btn = document.getElementById("open-goals");
        if (btn) btn.click();
        else location.href = LINKS.goals;
      }
      if (res.home) {
        const btn = document.getElementById("back-hub");
        if (btn) btn.click();
        else if (!already(LINKS.home)) location.href = LINKS.home;
      }
      if (res.search) window.open("https://yandex.ru/search/?text=" + encodeURIComponent(res.search), "_blank", "noopener");
      if (res.open) go(res.open);
    }

    openBtn.addEventListener("click", () => {
      panel.classList.remove("hidden");
      panel.hidden = false;
      openBtn.classList.add("hidden");
      if (!log.childElementCount) {
        addMsg("bot", "Привет. Могу открыть разделы, добавить дело Саше или Маше и записать трату в категорию этого месяца. Зажмите кнопку и говорите — или напишите.");
      }
      input.focus();
    });
    closeBtn.addEventListener("click", () => {
      panel.classList.add("hidden");
      panel.hidden = true;
      openBtn.classList.remove("hidden");
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      run(text, false);
    });
    panel.querySelectorAll("[data-assist]").forEach((chip) => {
      chip.addEventListener("click", () => run(chip.dataset.assist, false));
    });

    const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    let holding = false;
    let buffer = "";
    function stopListen() {
      holding = false;
      mic.classList.remove("holding");
      mic.textContent = "Зажать и говорить";
      try { rec && rec.stop(); } catch {}
    }
    function startListen() {
      if (!SpeechAPI) {
        addMsg("bot", "Голос в этом браузере недоступен. Напишите командой — или откройте Chrome.");
        return;
      }
      holding = true;
      buffer = "";
      mic.classList.add("holding");
      mic.textContent = "Слушаю…";
      rec = new SpeechAPI();
      rec.lang = "ru-RU";
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (event) => {
        let out = "";
        for (let i = 0; i < event.results.length; i += 1) out += event.results[i][0].transcript;
        buffer = out.trim();
        input.value = buffer;
      };
      rec.onerror = () => stopListen();
      rec.onend = () => {
        mic.classList.remove("holding");
        mic.textContent = "Зажать и говорить";
        if (holding) return;
        const said = (buffer || input.value).trim();
        if (said) {
          input.value = "";
          run(said, true);
        }
      };
      try { rec.start(); } catch { stopListen(); }
    }
    mic.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      mic.setPointerCapture?.(e.pointerId);
      startListen();
    });
    mic.addEventListener("pointerup", (e) => { e.preventDefault(); stopListen(); });
    mic.addEventListener("pointercancel", (e) => { e.preventDefault(); stopListen(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootAssistant);
  else bootAssistant();
})();
