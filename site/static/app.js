const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const GROUPS = [
  { id: "basket", label: "Корзина 230" },
  { id: "large", label: "Крупные" },
  { id: "expense", label: "Все расходы" },
  { id: "income", label: "Доходы" },
];

let state = {
  importId: null,
  txs: [],
  categories: [],
  ledger: null,
  month: 8,
  analytics: null,
  filterGroup: "basket",
  selectedCats: [],
  sliceMode: "month",
  merchants: [],
  share: null,
};

const $ = (id) => document.getElementById(id);

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sasha-theme", theme);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "Тёмная" : "Светлая";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f3eee4" : "#0b0c10");
  if (state.analytics) {
    paintCumul();
    paintSlice();
  }
  if (state.share) paintShare();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    $("view-analytics").classList.toggle("hidden", view !== "analytics");
    $("view-share").classList.toggle("hidden", view !== "share");
    $("view-data").classList.toggle("hidden", view !== "data");
    if (view === "analytics") loadAnalytics();
    if (view === "share") loadShare();
    if (view === "data") loadDataTab();
  });
});

function money(n) {
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(Math.round(n)).toLocaleString("ru-RU") + " ₽";
}

function mln(n) {
  return (n / 1e6).toFixed(2).replace(".", ",") + " млн";
}

function isLocalApi() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

async function api(path, opts) {
  const name = path.replace(/^\/api\//, "").split("?")[0];
  const urls = [];
  if (isLocalApi()) urls.push(path);
  if (!opts || !opts.method || opts.method === "GET") {
    urls.push("static/snapshot/" + name + ".json");
  }
  let last = new Error("Нет данных: " + path);
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        return data;
      }
      last = new Error((await res.text()) || res.statusText);
    } catch (err) {
      last = err;
    }
    if (opts && opts.method && opts.method !== "GET") break;
  }
  throw last;
}

function applyVoiceAddsToLedger(ledger) {
  if (!ledger) return ledger;
  let adds = [];
  try { adds = JSON.parse(localStorage.getItem("sasha-masha-budget-adds") || "[]"); } catch {}
  if (!Array.isArray(adds) || !adds.length) return ledger;
  const rows = [...(ledger.income || []), ...(ledger.expense || [])];
  for (const add of adds) {
    const row = rows.find((r) => r.category === add.category);
    if (!row || !Array.isArray(row.fact)) continue;
    const i = Number(add.month || 1) - 1;
    if (i < 0 || i > 11) continue;
    row.fact[i] = Number(row.fact[i] || 0) + Number(add.amount || 0);
  }
  return ledger;
}

async function boot() {
  applyTheme(currentTheme());
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  });
  const sel = $("import-month");
  sel.innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  sel.addEventListener("change", () => {
    state.month = Number(sel.value);
    renderPropose();
    renderTx();
  });

  let health = { closed_month: 7, excel: null };
  try {
    health = await api("/api/health");
    $("upload-status").textContent = health.excel
      ? `История из ${health.excel}. Закрытый месяц: ${MONTHS[health.closed_month - 1]}.`
      : "";
  } catch (err) {
    $("upload-status").textContent = "Сервер недоступен, показан сохранённый снимок.";
  }
  state.month = Math.min(12, (health.closed_month || 7) + 1);
  sel.value = String(state.month);

  try {
    const ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    state.ledger = ledger;
    state.categories = ledger.categories || [];
    $("rule-cat").innerHTML = state.categories.map((c) => `<option>${c}</option>`).join("");
  } catch (err) {
    state.ledger = { income: [], expense: [], categories: [] };
    state.categories = [];
  }

  try {
    await Promise.all([loadAnalytics(), loadMarkets()]);
  } catch (err) {
    $("upload-status").textContent = "Не удалось загрузить аналитику: " + (err.message || err);
  }
  if (isLocalApi()) setInterval(loadMarkets, 60 * 60 * 1000);
}

const drop = $("drop");
const file = $("file");
drop.addEventListener("click", () => file.click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});
file.addEventListener("change", () => { if (file.files[0]) upload(file.files[0]); });

$("tx-search").addEventListener("input", renderTx);
$("btn-apply").addEventListener("click", applyMonth);
$("rule-form").addEventListener("submit", saveRule);

document.querySelectorAll("#slice-mode button[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#slice-mode button[data-mode]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.sliceMode = btn.dataset.mode;
    paintSlice();
  });
});
$("btn-reset-filters").addEventListener("click", () => {
  state.filterGroup = "basket";
  state.selectedCats = [];
  renderFilters();
  paintSlice();
});

async function upload(f) {
  $("upload-status").textContent = "Читаю справку…";
  const fd = new FormData();
  fd.append("file", f);
  try {
    const out = await api("/api/upload", { method: "POST", body: fd });
    state.importId = out.import_id;
    const detail = await api(`/api/imports/${out.import_id}`);
    state.txs = detail.transactions;
    $("upload-status").textContent =
      `Разобрано ${out.count} операций (${out.header.period_from || "?"} — ${out.header.period_to || "?"}). Проверьте категории и запишите месяц.`;
    const monthsPresent = [...new Set(state.txs.map((t) => t.month))].sort((a, b) => a - b);
    if (monthsPresent.includes(8)) state.month = 8;
    else if (monthsPresent.length) state.month = monthsPresent[monthsPresent.length - 1];
    $("import-month").value = String(state.month);
    renderTx();
    renderPropose();
    loadImports();
    loadMerchants();
  } catch (err) {
    $("upload-status").textContent = "Не получилось прочитать файл: " + err.message;
  }
}

function catSelect(current) {
  return state.categories.map((c) =>
    `<option ${c === current ? "selected" : ""}>${c}</option>`
  ).join("");
}

function renderTx() {
  const q = ($("tx-search").value || "").toLowerCase();
  const body = document.querySelector("#tx-table tbody");
  const rows = state.txs.filter((t) => t.month === state.month && (!q || (t.description || "").toLowerCase().includes(q)));
  body.innerHTML = rows.map((t) => {
    const cls = t.amount >= 0 ? "in" : "out";
    const off = t.included ? "" : "off";
    return `<tr class="${cls} ${off}" data-id="${t.id}">
      <td><input type="checkbox" ${t.included ? "checked" : ""} data-act="inc"></td>
      <td>${t.op_date}<div class="conf">${t.op_time || ""} · карта ${t.card || "—"}</div></td>
      <td class="num">${money(t.amount)}</td>
      <td>${t.description || ""}<div class="conf">уверенность ${t.confidence}%</div></td>
      <td><select data-act="cat">${catSelect(t.category)}</select></td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="conf">Нет операций за ${MONTHS[state.month - 1]}. Загрузите справку или выберите импорт слева.</td></tr>`;
  body.querySelectorAll("tr[data-id]").forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-act="inc"]').addEventListener("change", async (e) => {
      await api(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ included: e.target.checked }),
      });
      const tx = state.txs.find((x) => x.id === id);
      tx.included = e.target.checked ? 1 : 0;
      renderTx();
      renderPropose();
    });
    tr.querySelector('[data-act="cat"]').addEventListener("change", async (e) => {
      await api(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: e.target.value }),
      });
      const tx = state.txs.find((x) => x.id === id);
      tx.category = e.target.value;
      tx.confidence = 99;
      renderPropose();
      loadMerchants();
    });
  });
}

function currentFact(category) {
  const pack = [...(state.ledger.income || []), ...(state.ledger.expense || [])]
    .find((r) => r.category === category);
  return pack ? pack.fact[state.month - 1] : 0;
}

async function renderPropose() {
  if (!state.importId) {
    $("propose").innerHTML = "";
    return;
  }
  const sum = await api(`/api/imports/${state.importId}/summary?year=2026&month=${state.month}`);
  const cats = Object.keys(sum.by_category).sort((a, b) => sum.by_category[b] - sum.by_category[a]);
  $("propose").innerHTML = cats.map((c) => {
    const pdf = sum.by_category[c];
    const now = currentFact(c);
    const d = pdf - now;
    const cls = d > 50 ? "delta-up" : d < -50 ? "delta-down" : "";
    return `<div class="prop"><b>${c}</b><div>PDF ${money(pdf)}</div><div class="${cls}">факт ${money(now)}</div></div>`;
  }).join("") || "<p class='hint'>Нет учтённых операций за этот месяц.</p>";
}

async function applyMonth() {
  if (!state.importId) return;
  $("btn-apply").disabled = true;
  try {
    await api(`/api/imports/${state.importId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: 2026, month: state.month }),
    });
    state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    $("upload-status").textContent = `${MONTHS[state.month - 1]} записан в факт. Откройте аналитику — выводы пересчитались.`;
    renderPropose();
    renderLedger(state.ledger);
  } catch (err) {
    $("upload-status").textContent = "Не записалось: " + err.message;
  } finally {
    $("btn-apply").disabled = false;
  }
}

async function loadDataTab() {
  if (!state.ledger) state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
  renderLedger(state.ledger);
  await Promise.all([loadImports(), loadMerchants()]);
  if (!state.importId) {
    const imports = await api("/api/imports");
    if (imports[0]) await openImport(imports[0].id);
  } else {
    renderTx();
    renderPropose();
  }
}

async function loadImports() {
  const rows = await api("/api/imports");
  $("import-list").innerHTML = rows.map((r) =>
    `<div class="import-item ${r.id === state.importId ? "active" : ""}" data-id="${r.id}">
      <div><b>${r.filename || "справка"}</b><div class="conf">${r.period_from || "—"} · ${r.tx_count} оп. · ${r.status}</div></div>
    </div>`
  ).join("") || "<p class='hint'>Пока нет загрузок.</p>";
  $("import-list").querySelectorAll(".import-item").forEach((el) => {
    el.addEventListener("click", () => openImport(Number(el.dataset.id)));
  });
}

async function openImport(id) {
  state.importId = id;
  const detail = await api(`/api/imports/${id}`);
  state.txs = detail.transactions;
  const monthsPresent = [...new Set(state.txs.map((t) => t.month))].sort((a, b) => a - b);
  if (monthsPresent.length && !monthsPresent.includes(state.month)) {
    state.month = monthsPresent[monthsPresent.length - 1];
    $("import-month").value = String(state.month);
  }
  loadImports();
  renderTx();
  renderPropose();
}

async function loadMerchants() {
  state.merchants = await api("/api/merchants");
  $("merchant-list").innerHTML = state.merchants.map((m) =>
    `<div class="merchant-item" data-needle="${encodeURIComponent(m.needle)}">
      <span title="${m.needle}">${m.needle}</span>
      <select>${catSelect(m.category)}</select>
      <button class="btn ghost" type="button" data-act="del">×</button>
    </div>`
  ).join("") || "<p class='hint'>Правил ещё нет — они появятся после правок статей.</p>";
  $("merchant-list").querySelectorAll(".merchant-item").forEach((el) => {
    const needle = decodeURIComponent(el.dataset.needle);
    el.querySelector("select").addEventListener("change", async (e) => {
      await api("/api/merchants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needle, category: e.target.value }),
      });
    });
    el.querySelector('[data-act="del"]').addEventListener("click", async () => {
      await api("/api/merchants?needle=" + encodeURIComponent(needle), { method: "DELETE" });
      loadMerchants();
    });
  });
}

async function saveRule(e) {
  e.preventDefault();
  const needle = $("rule-needle").value.trim();
  if (!needle) return;
  await api("/api/merchants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ needle, category: $("rule-cat").value }),
  });
  $("rule-needle").value = "";
  loadMerchants();
}

let charts = {};
function paintChart(id, config) {
  if (charts[id]) charts[id].destroy();
  const ctx = $(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, config);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeCharts() {
  Chart.defaults.font.family = "Montserrat";
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
}

function scaleOpts() {
  const grid = currentTheme() === "light" ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)";
  return {
    x: { grid: { color: grid }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
    y: { grid: { color: grid } },
  };
}

function planColor() {
  return currentTheme() === "light" ? "rgba(111,103,92,.45)" : "rgba(154,146,134,.45)";
}

function factColor() {
  return cssVar("--gold");
}

async function loadMarkets() {
  let mk;
  try {
    mk = await api("/api/markets");
  } catch {
    mk = { usd: null, thb: null, gold_gram: null, error: "нет связи" };
  }
  const usdDelta = mk.usd && mk.usd.previous ? mk.usd.value - mk.usd.previous : 0;
  const thbDelta = mk.thb && mk.thb.previous ? mk.thb.value - mk.thb.previous : 0;
  const stamp = mk.as_of ? `ЦБ · ${String(mk.as_of).slice(0, 10)}` : "";
  const cacheNote = mk.cached ? " · кэш 1 ч" : " · только что";
  $("markets").innerHTML = [
    kpi("Доллар США", mk.usd ? mk.usd.value.toFixed(2) + " ₽" : "нет данных",
      mk.usd ? `${usdDelta >= 0 ? "+" : ""}${usdDelta.toFixed(2)} к вчера${cacheNote}` : (mk.error || "ЦБ недоступен"),
      usdDelta),
    kpi("Тайский бат", mk.thb ? mk.thb.value.toFixed(3) + " ₽" : "нет данных",
      mk.thb ? `${thbDelta >= 0 ? "+" : ""}${thbDelta.toFixed(3)} за 1 ฿ · для Таиланда` : "нужен для Таиланда",
      thbDelta),
    kpi("Золото, грамм", mk.gold_gram ? money(mk.gold_gram.value) : "нет данных",
      mk.gold_gram ? `учётная цена ЦБ · ${mk.gold_gram.date || stamp}` : (mk.error || "")),
  ].join("");
}

function kpi(label, value, sub, delta) {
  const cls = delta > 0 ? "up" : delta < 0 ? "down" : "";
  return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ""}</div></div>`;
}

async function loadAnalytics() {
  const [an, ledger] = await Promise.all([
    api("/api/analytics"),
    api("/api/ledger"),
  ]);
  state.analytics = an;
  state.ledger = applyVoiceAddsToLedger(ledger);
  $("analytics-period").textContent =
    `Январь — ${MONTHS[an.closed_month - 1]} 2026 · цель 12 млн с недвижимостью`;

  const dlt = an.delta;
  $("budget-kpis").innerHTML = [
    `<div class="chip-kpi"><b>${mln(an.cumul_fact)}</b><span>факт FCF</span></div>`,
    `<div class="chip-kpi"><b>${dlt >= 0 ? "+" : "−"}${Math.abs(dlt / 1000).toFixed(0)} тыс.</b><span>к плану</span></div>`,
    `<div class="chip-kpi"><b>${mln(an.net_worth)}</b><span>FCF + жильё</span></div>`,
  ].join("");

  themeCharts();
  paintCumul();
  renderFilters();
  paintSlice();

  $("conclusions").innerHTML = an.conclusions.map((c) =>
    `<article class="pulse ${c.tone}"><i class="dot"></i><div><h4>${c.title}</h4><p>${c.text}</p></div></article>`
  ).join("");

  $("recs").innerHTML = an.recommendations.map((r) => {
    const progress = r.tag === "цель 12 млн"
      ? `<div class="bar"><i style="width:${Math.min(100, (an.net_worth / an.savings_goal) * 100)}%"></i></div>`
      : "";
    return `<article class="rec"><div class="rec-n">${r.n}</div><div>
      <div class="rec-tag">${r.tag}</div><h4>${r.title}</h4><p>${r.text}</p>${progress}</div></article>`;
  }).join("");
}

function groupCats() {
  const an = state.analytics;
  if (!an) return [];
  return an.filter_groups[state.filterGroup] || an.filter_groups.basket;
}

function activeCats() {
  return state.selectedCats.length ? state.selectedCats : groupCats();
}

function paintCumul() {
  const an = state.analytics;
  if (!an) return;
  themeCharts();
  const gold = factColor();
  paintChart("chart-cumul", {
    type: "line",
    data: {
      labels: MONTHS.map((m) => m.slice(0, 3)),
      datasets: [
        { label: "План", data: an.series_plan, borderColor: cssVar("--muted"), backgroundColor: "transparent", tension: 0.25, borderWidth: 1.5, pointRadius: 2 },
        { label: "Факт", data: an.series_fact, borderColor: gold, backgroundColor: hexFade(gold, 0.16), fill: true, tension: 0.25, borderWidth: 2, pointRadius: 3 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
      scales: {
        ...scaleOpts(),
        y: { ...scaleOpts().y, title: { display: true, text: "млн ₽", color: cssVar("--muted") } },
      },
    },
  });
}

function hexFade(hex, alpha) {
  const h = hex.replace("#", "").trim();
  if (h.length < 6) return hex;
  const n = parseInt(h.slice(0, 6), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderFilters() {
  const limit = state.analytics ? Math.round(state.analytics.basket_limit / 1000) : 230;
  $("filters").innerHTML = GROUPS.map((g) => {
    const label = g.id === "basket" ? `Корзина ${limit}` : g.label;
    return `<button class="chip l1-${g.id} ${state.filterGroup === g.id ? "active" : ""}" data-g="${g.id}">${label}</button>`;
  }).join("");
  $("filters").querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filterGroup = btn.dataset.g;
      state.selectedCats = [];
      renderFilters();
      renderCatPicks();
      paintSlice();
    });
  });
  renderCatPicks();
}

function renderCatPicks() {
  const an = state.analytics;
  const selected = new Set(state.selectedCats);
  const pool = groupCats();
  $("cat-picks").innerHTML = pool.map((c) =>
    `<button class="chip l2 cat-pick ${selected.has(c) ? "active" : ""}" data-c="${c}">${c}</button>`
  ).join("");
  $("cat-picks").querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.c;
      const already = state.selectedCats.includes(cat);
      if (!already) state.selectedCats = [...state.selectedCats, cat];
      else if (state.selectedCats.length > 1) state.selectedCats = state.selectedCats.filter((c) => c !== cat);
      renderCatPicks();
      paintSlice();
    });
  });
}

function paintSlice() {
  const an = state.analytics;
  if (!an) return;
  const cats = activeCats();
  const byCat = Object.fromEntries((an.monthly || []).map((r) => [r.category, r]));
  const closed = an.closed_month;
  const gold = factColor();
  if (state.sliceMode === "month") {
    const plan = MONTHS.map((_, i) => cats.reduce((s, c) => s + ((byCat[c] && byCat[c].plan[i]) || 0), 0) / 1000);
    const fact = MONTHS.map((_, i) => i < closed
      ? cats.reduce((s, c) => s + ((byCat[c] && byCat[c].fact[i]) || 0), 0) / 1000
      : null);
    paintChart("chart-slice", {
      type: "bar",
      data: {
        labels: MONTHS.map((m) => m.slice(0, 3)),
        datasets: [
          { label: "План, тыс.", data: plan, backgroundColor: planColor(), borderRadius: 4 },
          { label: "Факт, тыс.", data: fact, backgroundColor: gold, borderRadius: 4 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
        scales: scaleOpts(),
      },
    });
  } else {
    const rows = cats.map((c) => {
      const plan = ((byCat[c] && byCat[c].plan) || []).slice(0, closed).reduce((a, b) => a + b, 0);
      const fact = ((byCat[c] && byCat[c].fact) || []).slice(0, closed).reduce((a, b) => a + b, 0);
      return { c, plan, fact, delta: fact - plan };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
    paintChart("chart-slice", {
      type: "bar",
      data: {
        labels: rows.map((r) => r.c),
        datasets: [
          { label: "План, тыс.", data: rows.map((r) => r.plan / 1000), backgroundColor: planColor(), borderRadius: 4 },
          { label: "Факт, тыс.", data: rows.map((r) => r.fact / 1000), backgroundColor: gold, borderRadius: 4 },
        ],
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
        scales: {
          x: { grid: { color: currentTheme() === "light" ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)" } },
          y: { grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }
}

async function loadShare() {
  const data = await api("/api/share");
  state.share = data;
  paintShare();
}

function paintShare() {
  const data = state.share;
  if (!data) return;
  $("share-source").textContent = data.source
    ? `Источник: ${data.source}. Наличные от Саши входят в долю Маши.`
    : "";
  $("share-cash-kpis").innerHTML = [
    `<div class="chip-kpi"><b>${mln(data.totals.sasha_cash)}</b><span>Саша</span></div>`,
    `<div class="chip-kpi"><b>${mln(data.totals.masha_cash)}</b><span>Маша с наличными</span></div>`,
    `<div class="chip-kpi"><b>${mln(data.totals.cash)}</b><span>вместе</span></div>`,
  ].join("");
  $("share-prop-kpis").innerHTML = [
    `<div class="chip-kpi"><b>50 / 50</b><span>Таиланд</span></div>`,
    `<div class="chip-kpi"><b>Саша</b><span>Петербург 100%</span></div>`,
    `<div class="chip-kpi"><b>Маша</b><span>паркинг 100%</span></div>`,
  ].join("");

  const sasha = cssVar("--gold");
  const masha = cssVar("--l2");
  themeCharts();
  paintChart("chart-savings", {
    type: "doughnut",
    data: {
      labels: ["Саша", "Маша"],
      datasets: [{
        data: [data.totals.sasha_cash, data.totals.masha_cash],
        backgroundColor: [sasha, masha],
        borderWidth: 0,
      }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${money(ctx.raw)}` } },
      },
    },
  });

  const cashSum = data.totals.cash_from_sasha || 0;
  $("cash-from-sasha").innerHTML =
    "<h3>Как сложилась доля Маши</h3>" +
    `<div class="share-row"><span>Маша накопления</span><b>${money(data.totals.masha_own || 0)}</b></div>` +
    `<div class="share-row"><span>Наличные от Саши, сумма лет</span><b>${money(cashSum)}</b></div>` +
    `<div class="share-row"><span>Итого Маша</span><b>${money(data.totals.masha_cash)}</b></div>` +
    "<h3>Наличные Маши от Саши по годам</h3>" +
    data.cash_from_sasha.map((r) =>
      `<div class="share-row"><span>${r.year || ""}</span><b>${money(r.amount)}</b><span class="conf">${r.comment || ""}</span></div>`
    ).join("");

  const labels = data.property.map((p) => p.name.replace("Квартира ", "").replace("Парковочное место", "Паркинг"));
  const onSasha = cssVar("--on-accent");
  const onMasha = cssVar("--l2-on");
  paintChart("chart-property", {
    type: "bar",
    plugins: [{
      id: "barPctLabels",
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = "600 13px Montserrat, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        chart.data.datasets.forEach((ds, di) => {
          const meta = chart.getDatasetMeta(di);
          if (meta.hidden) return;
          ctx.fillStyle = di === 0 ? onSasha : onMasha;
          meta.data.forEach((el, i) => {
            const v = ds.data[i];
            if (!v) return;
            const { x, y, base } = el.getProps(["x", "y", "base"], true);
            ctx.fillText(`${v}%`, x, (y + base) / 2);
          });
        });
        ctx.restore();
      },
    }],
    data: {
      labels,
      datasets: [
        {
          label: "Саша",
          data: data.property.map((p) => {
            const row = p.shares.find((s) => s.owner === "Саша");
            return row ? Math.round(row.share * 100) : 0;
          }),
          backgroundColor: sasha,
          borderRadius: 4,
        },
        {
          label: "Маша",
          data: data.property.map((p) => {
            const row = p.shares.find((s) => s.owner === "Маша");
            return row ? Math.round(row.share * 100) : 0;
          }),
          backgroundColor: masha,
          borderRadius: 4,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}%`,
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          title: { display: true, text: "%", color: cssVar("--muted") },
          ticks: { callback: (v) => v + "%" },
          grid: { color: currentTheme() === "light" ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)" },
        },
      },
    },
  });

  $("property-table").innerHTML = data.property.map((p) => {
    const shares = p.shares.map((s) => `${s.owner} ${Math.round(s.share * 100)}%`).join(" · ");
    return `<div class="share-row"><span>${p.name}</span><b>${shares}</b></div>`;
  }).join("");
}

function renderLedger(ledger) {
  const rows = [...ledger.income, ...ledger.expense];
  const months = MONTHS;
  const head = ["Статья", ...months.map((m) => m.slice(0, 3))].map((h) => `<th>${h}</th>`).join("");
  const body = rows.map((r) => {
    const cells = r.fact.map((v, i) =>
      `<td class="num"><input data-cat="${r.category}" data-month="${i + 1}" value="${Math.round(v)}"></td>`
    ).join("");
    return `<tr><td>${r.category}</td>${cells}</tr>`;
  }).join("");
  $("ledger-wrap").innerHTML = `<table class="ledger"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $("ledger-wrap").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const value = Number(String(inp.value).replace(/\s/g, "").replace(",", "."));
      await api("/api/ledger", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: 2026,
          month: Number(inp.dataset.month),
          category: inp.dataset.cat,
          field: "fact",
          value,
        }),
      });
      state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    });
  });
}

boot().catch((err) => { $("upload-status").textContent = err.message; });
