const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3).toLowerCase());
const DETAIL_PALETTE = [
  "#d4b483", "#6ec4c8", "#8fbea8", "#8aa4c7", "#d9897a",
  "#c4a574", "#5aadb2", "#6fa890", "#7a94b5", "#c7786a",
  "#e8d3a8", "#9ad4d7", "#a8d0bc", "#a8bdd6", "#e5a89d",
];

const FALLBACK_TREE = [
  { id: "basket", label: "Корзина", tone: "gold", categories: [], children: [] },
  { id: "expense", label: "Все расходы", tone: "sage", categories: [], children: [] },
  { id: "income", label: "Доходы", tone: "sky", categories: [], children: [] },
];

const ALL_FCF_YEARS = Array.from({ length: 2040 - 2026 + 1 }, (_, i) => 2026 + i);
const ALL_ASSET_YEARS = Array.from({ length: 2040 - 2024 + 1 }, (_, i) => 2024 + i);

let state = {
  importId: null,
  txs: [],
  categories: [],
  ledger: null,
  month: 8,
  analytics: null,
  filterGroups: [],
  selectedCats: [],
  sliceDetail: false,
  fcfYears: [...ALL_FCF_YEARS],
  merchants: [],
  share: null,
  assetIds: null,
  showForecast: true,
  showDrivers: false,
  assetYears: [...ALL_ASSET_YEARS],
  shareBound: false,
  fcfYearsBound: false,
  assetYearsBound: false,
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

const SNAPSHOT_VER = "22";

function isLocalApi() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

async function api(path, opts) {
  const name = path.replace(/^\/api\//, "").split("?")[0];
  const urls = [];
  if (isLocalApi()) urls.push(path);
  if (!opts || !opts.method || opts.method === "GET") {
    urls.push("static/snapshot/" + name + ".json?v=" + SNAPSHOT_VER);
  }
  let last = new Error("Нет данных: " + path);
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        cache: "no-store",
      });
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
  const copy = JSON.parse(JSON.stringify(ledger));
  const rows = [...(copy.income || []), ...(copy.expense || [])];
  for (const add of adds) {
    const row = rows.find((r) => r.category === add.category);
    if (!row || !Array.isArray(row.fact)) continue;
    const i = Number(add.month || 1) - 1;
    if (i < 0 || i > 11) continue;
    row.fact[i] = Number(row.fact[i] || 0) + Number(add.amount || 0);
  }
  return copy;
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

$("btn-reset-filters").addEventListener("click", () => {
  state.filterGroups = [];
  state.selectedCats = [];
  state.sliceDetail = false;
  const detailBtn = $("btn-slice-detail");
  if (detailBtn) {
    detailBtn.classList.remove("on");
    detailBtn.setAttribute("aria-pressed", "false");
  }
  renderFilters();
  paintSlice();
});
$("btn-slice-detail").addEventListener("click", () => {
  state.sliceDetail = !state.sliceDetail;
  $("btn-slice-detail").classList.toggle("on", state.sliceDetail);
  $("btn-slice-detail").setAttribute("aria-pressed", state.sliceDetail ? "true" : "false");
  paintSlice();
});

function ensureYearChips(box, years, selected, resetId) {
  if (!box) return;
  const sel = new Set(selected || []);
  const labelText = (box.querySelector(".year-picks-label") || {}).textContent || "Годы";
  box.innerHTML =
    `<span class="year-picks-label">${labelText}</span>` +
    years.map((y) =>
      `<button type="button" class="chip year-chip ${sel.has(y) ? "active" : ""}" data-year="${y}" aria-pressed="${sel.has(y) ? "true" : "false"}">${y}</button>`
    ).join("") +
    `<button type="button" class="chip year-reset" id="${resetId}">Сбросить</button>`;
}

function bindFcfYears() {
  if (state.fcfYearsBound) return;
  state.fcfYearsBound = true;
  const box = $("fcf-years");
  ensureYearChips(box, ALL_FCF_YEARS, state.fcfYears, "btn-fcf-reset");
  if (box) {
    box.addEventListener("click", (e) => {
      const btn = e.target.closest(".year-chip");
      if (!btn || !box.contains(btn)) return;
      const y = Number(btn.dataset.year);
      const cur = state.fcfYears || [];
      const all = ALL_FCF_YEARS.length;
      if (cur.length === 1 && cur[0] === y) return;
      if (cur.length === all) {
        state.fcfYears = [y];
      } else if (cur.includes(y)) {
        state.fcfYears = [y];
      } else {
        state.fcfYears = [...cur, y].sort((a, b) => a - b);
      }
      paintCumul();
    });
  }
  const reset = $("btn-fcf-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      state.fcfYears = [...ALL_FCF_YEARS];
      paintCumul();
    });
  }
}

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
    await refreshDerived();
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
  if (!charts || typeof charts !== "object") charts = {};
  if (charts[id]) charts[id].destroy();
  const ctx = $(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, config);
}

function chartInteraction() {
  return { mode: "nearest", intersect: true };
}

function legendOpts(extra) {
  return {
    position: "bottom",
    labels: { boxWidth: 10 },
    onHover: () => {},
    ...(extra || {}),
  };
}

async function refreshDerived() {
  await Promise.all([loadAnalytics(), loadShare()]);
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
    `<div class="chip-kpi"><b>${dlt >= 0 ? "+" : "−"}${Math.abs(dlt / 1000).toFixed(0)} тыс.</b><span>опережение плана</span></div>`,
    `<div class="chip-kpi"><b>${mln(an.net_worth)}</b><span>FCF+ жилье (опер. прогноз до конца года)</span></div>`,
  ].join("");

  themeCharts();
  paintCumul();
  renderFilters();
  paintSlice();

  $("conclusions").innerHTML = an.conclusions.map((c) =>
    `<article class="pulse ${c.tone}"><i class="dot"></i><div><h4>${c.title}</h4><p>${c.text}</p></div></article>`
  ).join("");

  $("recs").innerHTML = an.recommendations.map((r) =>
    `<article class="rec"><div class="rec-n">${r.n}</div><div>
      <div class="rec-tag">${r.tag}</div><h4>${r.title}</h4><p>${r.text}</p></div></article>`
  ).join("");
}

function filterTree() {
  const an = state.analytics;
  if (an && Array.isArray(an.filter_tree) && an.filter_tree.length) return an.filter_tree;
  return FALLBACK_TREE.map((n) => ({
    ...n,
    categories: (an && an.filter_groups && an.filter_groups[n.id]) || [],
  }));
}

function selectedGroupNodes() {
  const tree = filterTree();
  const ids = new Set(state.filterGroups || []);
  return tree.filter((n) => ids.has(n.id));
}

function groupCats() {
  if (!(state.filterGroups || []).length) return [];
  const set = new Set();
  selectedGroupNodes().forEach((n) => (n.categories || []).forEach((c) => set.add(c)));
  return [...set];
}

function activeCats() {
  if (!(state.filterGroups || []).length) return [];
  return state.selectedCats.length ? state.selectedCats : groupCats();
}

function incomeCats() {
  const tree = filterTree();
  const node = tree.find((n) => n.id === "income");
  if (node && Array.isArray(node.categories) && node.categories.length) return node.categories;
  const fg = state.analytics && state.analytics.filter_groups && state.analytics.filter_groups.income;
  if (Array.isArray(fg) && fg.length) return fg;
  return ["Зарплата Саша", "Премия Саша", "Зарплата Маша", "Премия Маша", "Займы", "Подарки"];
}

function expenseCats() {
  const fg = state.analytics && state.analytics.filter_groups && state.analytics.filter_groups.expense;
  if (Array.isArray(fg) && fg.length) return fg;
  const tree = filterTree();
  const node = tree.find((n) => n.id === "expense");
  if (node && Array.isArray(node.categories) && node.categories.length) return node.categories;
  return [];
}

function syncFcfYearChips() {
  const box = $("fcf-years");
  if (!box) return;
  const years = new Set(state.fcfYears || []);
  box.querySelectorAll(".year-chip").forEach((btn) => {
    const on = years.has(Number(btn.dataset.year));
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function paintCumul() {
  const an = state.analytics;
  if (!an) return;
  themeCharts();
  bindFcfYears();
  syncFcfYearChips();

  const hz = an.fcf_horizon;
  const gold = factColor();
  const muted = cssVar("--muted");
  const yearSet = new Set(state.fcfYears || []);

  let labels = [];
  let plan = [];
  let fact = [];
  let events = [];
  let keep = [];

  if (hz && Array.isArray(hz.labels)) {
    hz.labels.forEach((lab, i) => {
      const y = Number(String(lab).split(".")[1]);
      if (yearSet.has(y)) keep.push(i);
    });
    labels = keep.map((i) => hz.labels[i]);
    plan = keep.map((i) => hz.series_plan[i]);
    fact = keep.map((i) => hz.series_fact[i]);
    const indexMap = new Map(keep.map((orig, vis) => [orig, vis]));
    events = (hz.events || [])
      .filter((e) => indexMap.has(e.index))
      .map((e) => ({ ...e, visIndex: indexMap.get(e.index) }));
  } else {
    labels = MONTHS.map((m) => m.slice(0, 3));
    plan = an.series_plan || [];
    fact = an.series_fact || [];
  }

  const eventData = labels.map((_, i) => {
    const ev = events.find((e) => e.visIndex === i);
    if (!ev) return null;
    if (fact[i] != null) return fact[i];
    if (plan[i] != null) return plan[i];
    return 0;
  });

  const datasets = [
    {
      label: "План",
      data: plan,
      borderColor: muted,
      backgroundColor: "transparent",
      tension: 0.25,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
    },
    {
      label: "Факт",
      data: fact,
      borderColor: gold,
      backgroundColor: hexFade(gold, 0.16),
      fill: true,
      tension: 0.25,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 0,
    },
    {
      label: "Ключевое событие",
      data: eventData,
      borderColor: gold,
      backgroundColor: gold,
      showLine: false,
      pointRadius: (ctx) => (eventData[ctx.dataIndex] == null ? 0 : 6),
      pointHoverRadius: 8,
      pointStyle: "rectRot",
      order: 0,
      isEvent: true,
    },
  ];

  paintChart("chart-cumul", {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true, axis: "xy" },
      plugins: {
        legend: legendOpts(),
        tooltip: {
          enabled: true,
          filter: (item) => item.dataset.isEvent && item.raw != null,
          callbacks: {
            title: () => "",
            label: (ctx) => {
              const ev = events.find((e) => e.visIndex === ctx.dataIndex);
              if (!ev) return null;
              return [ev.label, ev.detail, labels[ctx.dataIndex]].filter(Boolean);
            },
          },
        },
      },
      scales: {
        ...scaleOpts(),
        y: { ...scaleOpts().y, title: { display: true, text: "млн ₽", color: muted } },
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
  const tree = filterTree();
  const limit = state.analytics ? Math.round(state.analytics.basket_limit / 1000) : 230;
  const selected = new Set(state.filterGroups || []);
  $("filters").innerHTML = tree.map((g) => {
    const label = g.id === "basket" ? `Корзина ${limit}` : g.label;
    const on = selected.has(g.id);
    return `<button class="chip l1-${g.id} ${on ? "active" : ""}" data-g="${g.id}" aria-pressed="${on}">${label}</button>`;
  }).join("");
  $("filters").querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.g;
      const cur = new Set(state.filterGroups || []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      state.filterGroups = [...cur];
      const allowed = new Set(groupCats());
      state.selectedCats = state.selectedCats.filter((c) => allowed.has(c));
      renderFilters();
      paintSlice();
    });
  });
  renderFilterNest();
}

function renderFilterNest() {
  const nest = $("filter-nest");
  if (!nest) return;
  const nodes = selectedGroupNodes();
  if (!nodes.length) {
    nest.classList.add("hidden");
    nest.innerHTML = "";
    nest.removeAttribute("data-tone");
    return;
  }

  nest.classList.remove("hidden");
  const tone = nodes[0].tone || "gold";
  nest.dataset.tone = tone;

  const blocks = [];
  const seenBlock = new Set();
  const selectedIds = new Set(state.filterGroups || []);
  nodes.forEach((node) => {
    const children = node.children || [];
    if (children.length) {
      children.forEach((child) => {
        // Не дублировать «Корзину», если она уже выбрана как корневой фильтр
        if (selectedIds.has(child.id) && child.id !== node.id) return;
        if (seenBlock.has(child.id)) return;
        seenBlock.add(child.id);
        blocks.push({
          id: child.id,
          label: child.label,
          categories: child.categories || [],
          parentId: node.id,
        });
      });
    } else {
      if (seenBlock.has(node.id)) return;
      seenBlock.add(node.id);
      blocks.push({
        id: node.id,
        label: node.label,
        categories: node.categories || [],
        parentId: node.id,
      });
    }
  });

  const selected = new Set(state.selectedCats);
  nest.innerHTML = blocks.map((block) => {
    const cats = block.categories || [];
    const chips = cats.map((c) =>
      `<button type="button" class="chip l2 cat-pick ${selected.has(c) ? "active" : ""}" data-c="${c}">${c}</button>`
    ).join("");
    return `<div class="filter-subgroup" data-block="${block.id}">
      <div class="filter-subgroup-head"><span>${block.label}</span></div>
      <div class="filter-cats">${chips}</div>
    </div>`;
  }).join("");

  nest.querySelectorAll(".cat-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.c;
      if (state.selectedCats.includes(cat)) {
        state.selectedCats = state.selectedCats.filter((c) => c !== cat);
      } else {
        state.selectedCats = [...state.selectedCats, cat];
      }
      renderFilterNest();
      paintSlice();
    });
  });
}

function deviationTooltipParts(fact, plan) {
  if (plan == null || !Number.isFinite(plan) || plan === 0) {
    return { text: `План: ${fact == null ? "—" : Number(fact).toFixed(1)}`, color: cssVar("--muted") };
  }
  const pct = ((fact - plan) / plan) * 100;
  const sign = pct > 0 ? "+" : "";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "·";
  const color = pct > 0 ? "#3d9a6a" : pct < 0 ? "#c45c4a" : cssVar("--muted");
  return {
    text: `План: ${plan.toFixed(1)} · отклонение ${arrow} ${sign}${pct.toFixed(0)}%`,
    color,
  };
}

function paintSlice() {
  const an = state.analytics;
  if (!an) return;
  themeCharts();
  const byCat = Object.fromEntries((an.monthly || []).map((r) => [r.category, r]));
  const closed = an.closed_month;
  const gold = factColor();
  const sky = cssVar("--sky") || "#8aa4c7";
  const sage = cssVar("--sage") || "#8fbea8";
  const muted = cssVar("--muted");
  const indices = Array.from({ length: 12 }, (_, i) => i);
  const labels = MONTHS.map((m) => m.slice(0, 3));
  const overview = !(state.filterGroups || []).length;

  if (overview) {
    const inc = incomeCats();
    const exp = expenseCats();
    const sumFact = (cats, i) =>
      i < closed ? cats.reduce((s, c) => s + ((byCat[c] && byCat[c].fact[i]) || 0), 0) / 1000 : null;
    const sumPlan = (cats, i) =>
      cats.reduce((s, c) => s + ((byCat[c] && byCat[c].plan[i]) || 0), 0) / 1000;

    if (state.sliceDetail) {
      const datasets = [];
      inc.forEach((c, idx) => {
        datasets.push({
          label: c,
          cat: c,
          kind: "income",
          data: indices.map((i) => (i < closed ? ((byCat[c] && byCat[c].fact[i]) || 0) / 1000 : null)),
          backgroundColor: DETAIL_PALETTE[idx % DETAIL_PALETTE.length],
          borderRadius: idx === inc.length - 1 ? 4 : 0,
          stack: "income",
          order: 1,
        });
      });
      exp.forEach((c, idx) => {
        const color = DETAIL_PALETTE[(idx + 4) % DETAIL_PALETTE.length];
        datasets.push({
          label: c,
          cat: c,
          kind: "expense",
          data: indices.map((i) => (i < closed ? ((byCat[c] && byCat[c].fact[i]) || 0) / 1000 : null)),
          backgroundColor: color,
          borderRadius: idx === exp.length - 1 ? 4 : 0,
          stack: "expense",
          order: 1,
        });
      });
      paintChart("chart-slice", {
        type: "bar",
        data: { labels, datasets },
        options: {
          maintainAspectRatio: false,
          interaction: chartInteraction(),
          plugins: {
            legend: legendOpts({ labels: { boxWidth: 8, font: { size: 10 } } }),
            tooltip: {
              enabled: true,
              filter: (item) => item.raw != null,
              callbacks: {
                label: (ctx) => {
                  const cat = ctx.dataset.cat;
                  const plan = ((byCat[cat] && byCat[cat].plan[ctx.dataIndex]) || 0) / 1000;
                  const bits = deviationTooltipParts(ctx.raw, plan);
                  return `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(1)} · ${bits.text}`;
                },
                labelTextColor: (ctx) => {
                  const cat = ctx.dataset.cat;
                  const plan = ((byCat[cat] && byCat[cat].plan[ctx.dataIndex]) || 0) / 1000;
                  return deviationTooltipParts(ctx.raw, plan).color;
                },
              },
            },
          },
          scales: {
            ...scaleOpts(),
            x: { ...scaleOpts().x, stacked: true },
            y: { ...scaleOpts().y, stacked: true, title: { display: true, text: "тыс. ₽", color: muted } },
          },
        },
      });
    } else {
      paintChart("chart-slice", {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              type: "bar",
              label: "Доходы факт",
              data: indices.map((i) => sumFact(inc, i)),
              backgroundColor: sky,
              borderRadius: 4,
              order: 2,
            },
            {
              type: "bar",
              label: "Расходы факт",
              data: indices.map((i) => sumFact(exp, i)),
              backgroundColor: sage,
              borderRadius: 4,
              order: 2,
            },
            {
              type: "line",
              label: "План доходов",
              data: indices.map((i) => sumPlan(inc, i)),
              borderColor: muted,
              backgroundColor: "transparent",
              tension: 0.25,
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 5,
              order: 1,
            },
            {
              type: "line",
              label: "План расходов",
              data: indices.map((i) => sumPlan(exp, i)),
              borderColor: muted,
              backgroundColor: "transparent",
              borderDash: [5, 4],
              tension: 0.25,
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 5,
              order: 1,
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          interaction: chartInteraction(),
          plugins: {
            legend: legendOpts(),
            tooltip: { enabled: true, filter: (item) => item.raw != null },
          },
          scales: {
            ...scaleOpts(),
            x: { ...scaleOpts().x, stacked: false },
            y: { ...scaleOpts().y, stacked: false, title: { display: true, text: "тыс. ₽", color: muted } },
          },
        },
      });
    }
    return;
  }

  const cats = activeCats();
  const planTotal = indices.map((i) => cats.reduce((s, c) => s + ((byCat[c] && byCat[c].plan[i]) || 0), 0) / 1000);

  if (state.sliceDetail && cats.length) {
    const datasets = cats.map((c, idx) => ({
      label: c,
      cat: c,
      data: indices.map((i) => (i < closed ? ((byCat[c] && byCat[c].fact[i]) || 0) / 1000 : null)),
      backgroundColor: DETAIL_PALETTE[idx % DETAIL_PALETTE.length],
      borderRadius: idx === cats.length - 1 ? 4 : 0,
      stack: "fact",
      order: 1,
    }));
    paintChart("chart-slice", {
      type: "bar",
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false,
        interaction: chartInteraction(),
        plugins: {
          legend: legendOpts({ labels: { boxWidth: 8, font: { size: 10 } } }),
          tooltip: {
            enabled: true,
            filter: (item) => item.raw != null,
            callbacks: {
              label: (ctx) => {
                const cat = ctx.dataset.cat;
                const plan = ((byCat[cat] && byCat[cat].plan[ctx.dataIndex]) || 0) / 1000;
                const bits = deviationTooltipParts(ctx.raw, plan);
                return `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(1)} · ${bits.text}`;
              },
              labelTextColor: (ctx) => {
                const cat = ctx.dataset.cat;
                const plan = ((byCat[cat] && byCat[cat].plan[ctx.dataIndex]) || 0) / 1000;
                return deviationTooltipParts(ctx.raw, plan).color;
              },
              footer: (items) => {
                const i = items[0] && items[0].dataIndex;
                if (i == null) return "";
                const factSum = items.reduce((s, it) => s + (it.parsed.y || 0), 0);
                const planSum = cats.reduce((s, c) => s + ((byCat[c] && byCat[c].plan[i]) || 0), 0) / 1000;
                return `Факт вместе: ${factSum.toFixed(1)} · план ${planSum.toFixed(1)} тыс.`;
              },
            },
          },
        },
        scales: {
          ...scaleOpts(),
          x: { ...scaleOpts().x, stacked: true },
          y: { ...scaleOpts().y, stacked: true, title: { display: true, text: "тыс. ₽", color: muted } },
        },
      },
    });
  } else {
    const fact = indices.map((i) => (i < closed
      ? cats.reduce((s, c) => s + ((byCat[c] && byCat[c].fact[i]) || 0), 0) / 1000
      : null));
    paintChart("chart-slice", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "План, тыс.", data: planTotal, backgroundColor: planColor(), borderRadius: 4 },
          { label: "Факт, тыс.", data: fact, backgroundColor: gold, borderRadius: 4 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: chartInteraction(),
        plugins: {
          legend: legendOpts(),
          tooltip: { enabled: true },
        },
        scales: {
          ...scaleOpts(),
          y: { ...scaleOpts().y, title: { display: true, text: "тыс. ₽", color: muted } },
        },
      },
    });
  }
}

function bindShareControls() {
  if (state.shareBound) return;
  state.shareBound = true;
  const forecast = $("show-forecast");
  const drivers = $("show-drivers");
  if (forecast) {
    forecast.addEventListener("change", () => {
      state.showForecast = forecast.checked;
      paintShare();
    });
  }
  if (drivers) {
    drivers.addEventListener("change", () => {
      state.showDrivers = drivers.checked;
      paintShare();
    });
  }
  const filtersReset = $("btn-asset-filters-reset");
  if (filtersReset) {
    filtersReset.addEventListener("click", () => {
      state.assetIds = null;
      paintShare();
    });
  }
  bindAssetYears();
}

function bindAssetYears() {
  if (state.assetYearsBound) return;
  state.assetYearsBound = true;
  const box = $("asset-years");
  ensureYearChips(box, ALL_ASSET_YEARS, state.assetYears, "btn-asset-years-reset");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".year-chip");
    if (!btn || !box.contains(btn)) return;
    const y = Number(btn.dataset.year);
    const cur = state.assetYears || [];
    const all = ALL_ASSET_YEARS.length;
    if (cur.length === 1 && cur[0] === y) return;
    if (cur.length === all) {
      state.assetYears = [y];
    } else if (cur.includes(y)) {
      state.assetYears = [y];
    } else {
      state.assetYears = [...cur, y].sort((a, b) => a - b);
    }
    paintShare();
  });
  const yearsReset = $("btn-asset-years-reset");
  if (yearsReset) {
    yearsReset.addEventListener("click", () => {
      state.assetYears = [...ALL_ASSET_YEARS];
      paintShare();
    });
  }
}

function syncAssetYearChips() {
  const box = $("asset-years");
  if (!box) return;
  const years = new Set(state.assetYears || []);
  box.querySelectorAll(".year-chip").forEach((btn) => {
    const on = years.has(Number(btn.dataset.year));
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

async function loadShare() {
  try {
    const data = await api("/api/share");
    state.share = data;
    bindShareControls();
    const shareView = $("view-share");
    if (shareView && !shareView.classList.contains("hidden")) {
      paintShare();
      requestAnimationFrame(() => {
        ["chart-assets", "chart-savings", "chart-property", "chart-drivers"].forEach((id) => {
          if (charts[id]) charts[id].resize();
        });
      });
    }
  } catch (err) {
    const lead = $("share-source");
    if (lead) lead.textContent = "Не удалось загрузить вклад: " + (err.message || err);
    console.error(err);
  }
}

function assetColor(i) {
  return DETAIL_PALETTE[i % DETAIL_PALETTE.length];
}

function paintShare() {
  const data = state.share;
  if (!data) return;
  const tl = data.timeline;
  themeCharts();

  if (tl) {
    const k = tl.kpis || {};
    $("share-hero-kpis").innerHTML = [
      `<div class="chip-kpi"><b>${mln(k.now || 0)}</b><span>Сейчас</span></div>`,
      `<div class="chip-kpi"><b>${mln(k.forecast_2040 != null ? k.forecast_2040 : k.forecast_2030 || 0)}</b><span>Прогноз к 2040</span></div>`,
      `<div class="chip-kpi"><b>${(k.delta_pct >= 0 ? "+" : "") + (k.delta_pct || 0)}%</b><span>+ к 2040</span></div>`,
    ].join("");

    const cur = tl.current || {};
    $("share-cash-kpis").innerHTML = (tl.assets || []).map((a) =>
      `<div class="chip-kpi"><b>${mln(cur[a.id] != null ? cur[a.id] : 0)}</b><span>${a.label}</span></div>`
    ).join("");

    const propKpis = $("share-prop-kpis");
    if (propKpis) {
      const props = data.property || tl.property_shares || [];
      propKpis.innerHTML = props.map((p) => {
        const shares = (p.shares || []).map((s) => `${s.owner} ${Math.round(s.share * 100)}%`).join(" · ");
        return `<article class="prop-card">
          <div class="prop-card-top">
            <h4>${p.name}</h4>
            <span class="prop-share">${shares}</span>
          </div>
          <p class="prop-note">${p.note || ""}</p>
          <b class="prop-value">${money(p.value || 0)}</b>
        </article>`;
      }).join("");
    }
  } else if (data.totals) {
    $("share-cash-kpis").innerHTML = [
      `<div class="chip-kpi"><b>${mln(data.totals.cash || 0)}</b><span>Наличные</span></div>`,
      `<div class="chip-kpi"><b>${mln(data.totals.masha_cash || 0)}</b><span>Накопления Маша</span></div>`,
      `<div class="chip-kpi"><b>${mln(data.totals.sasha_cash || 0)}</b><span>Накопления Саша</span></div>`,
      `<div class="chip-kpi"><b>${mln(data.totals.gold || 0)}</b><span>Золото</span></div>`,
      `<div class="chip-kpi"><b>${mln(data.totals.spb || 0)}</b><span>Недвижимость Петербург</span></div>`,
      `<div class="chip-kpi"><b>${mln(data.totals.phuket || 0)}</b><span>Недвижимость Пхукет</span></div>`,
    ].join("");
  }

  if (tl) {
    const filterActive = Array.isArray(state.assetIds);
    const ids = new Set(filterActive ? state.assetIds : (tl.assets || []).map((a) => a.id));
    $("asset-filters").innerHTML = tl.assets.map((a, i) =>
      `<button type="button" class="chip ${filterActive && ids.has(a.id) ? "active" : ""}" data-asset="${a.id}" style="border-color:${assetColor(i)}">${a.label}</button>`
    ).join("");
    $("asset-filters").querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.asset;
        if (state.assetIds == null) {
          state.assetIds = [id];
        } else {
          const cur = new Set(state.assetIds);
          if (cur.has(id)) cur.delete(id);
          else cur.add(id);
          state.assetIds = cur.size ? [...cur] : null;
        }
        paintShare();
      });
    });

    bindAssetYears();
    syncAssetYearChips();
    const yearSet = new Set(state.assetYears || []);
    const years = (tl.years || []).filter((y) => yearSet.has(y));
    const yearIdx = years.map((y) => tl.years.indexOf(y));
    const factUntil = tl.fact_until;
    if ($("show-forecast")) $("show-forecast").checked = state.showForecast;
    if ($("show-drivers")) $("show-drivers").checked = state.showDrivers;

    const activeAssets = tl.assets.filter((a) => ids.has(a.id));
    const datasets = activeAssets.map((a) => {
      const color = assetColor(tl.assets.findIndex((x) => x.id === a.id));
      const series = yearIdx.map((idx) => {
        const v = a.series[idx];
        return v == null ? null : v / 1e6;
      });
      return {
        label: a.label,
        data: series.map((v, j) => (v == null ? null : (years[j] <= factUntil || state.showForecast ? v : null))),
        borderColor: color,
        backgroundColor: "transparent",
        fill: false,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 5,
        segment: {
          borderDash: (ctx) => {
            const y = years[ctx.p1DataIndex];
            return y > factUntil ? [6, 4] : undefined;
          },
        },
      };
    });

    paintChart("chart-assets", {
      type: "line",
      data: { labels: years.map(String), datasets },
      options: {
        maintainAspectRatio: false,
        interaction: chartInteraction(),
        plugins: {
          legend: legendOpts(),
          tooltip: {
            enabled: true,
            filter: (item) => item.raw != null,
            callbacks: {
              afterBody: (items) => {
                const y = Number(items[0] && items[0].label);
                return y > factUntil ? "прогноз" : "факт / оценка";
              },
              label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)} млн ₽`,
            },
          },
        },
        scales: {
          ...scaleOpts(),
          y: {
            ...scaleOpts().y,
            stacked: false,
            title: { display: true, text: "млн ₽", color: cssVar("--muted") },
          },
          x: { ...scaleOpts().x },
        },
      },
    });

    const wrap = $("drivers-wrap");
    if (wrap) wrap.classList.toggle("hidden", !state.showDrivers);
    if (state.showDrivers && tl.drivers) {
      // Курсы 2024→2040 независимо от фильтра годов портфеля
      const fxYears = tl.years || [];
      const fxIdx = fxYears.map((_, i) => i);
      const driverKeys = [
        { id: "usd", label: "Доллар, ₽", axis: "y" },
        { id: "thb", label: "Бат, ₽", axis: "y" },
        { id: "gold", label: "Золото, тыс.₽/г", axis: "y1", scale: 1000 },
      ];
      paintChart("chart-drivers", {
        type: "line",
        data: {
          labels: fxYears.map(String),
          datasets: driverKeys.map((d, i) => {
            const series = (tl.drivers[d.id] || {}).series || [];
            const scale = d.scale || 1;
            return {
              label: d.label,
              data: fxIdx.map((idx) => {
                const raw = series[idx];
                return raw == null ? null : raw / scale;
              }),
              borderColor: DETAIL_PALETTE[i],
              backgroundColor: "transparent",
              tension: 0.25,
              borderWidth: 2,
              pointRadius: 3,
              pointHoverRadius: 5,
              yAxisID: d.axis,
            };
          }),
        },
        options: {
          maintainAspectRatio: false,
          interaction: chartInteraction(),
          plugins: {
            legend: legendOpts({ labels: { boxWidth: 8, font: { size: 10 } } }),
            tooltip: {
              enabled: true,
              filter: (item) => item.raw != null,
              callbacks: {
                label: (ctx) => {
                  const v = Number(ctx.raw);
                  if (ctx.dataset.yAxisID === "y1") return `${ctx.dataset.label}: ${v.toFixed(2)}`;
                  return `${ctx.dataset.label}: ${v.toFixed(3)}`;
                },
              },
            },
          },
          scales: {
            y: {
              ...scaleOpts().y,
              title: { display: true, text: "USD / THB, ₽", color: cssVar("--muted") },
            },
            y1: {
              position: "right",
              grid: { drawOnChartArea: false },
              title: { display: true, text: "золото", color: cssVar("--muted") },
            },
            x: scaleOpts().x,
          },
        },
      });
    }

    $("share-assumptions").innerHTML = (tl.assumptions || []).map((t) => `<li>${t}</li>`).join("");
    $("share-sources").innerHTML = (tl.sources || []).map((t) => `<li>${t}</li>`).join("");
  }

  const assets = (tl && tl.assets) || [];
  const cur = (tl && tl.current) || {};
  const donutItems = assets
    .map((a, i) => ({ label: a.label, value: cur[a.id] || 0, color: assetColor(i) }))
    .filter((x) => x.value > 0);
  paintChart("chart-savings", {
    type: "doughnut",
    data: {
      labels: donutItems.length ? donutItems.map((x) => x.label) : ["Нет данных"],
      datasets: [{
        data: donutItems.length ? donutItems.map((x) => x.value) : [1],
        backgroundColor: donutItems.length ? donutItems.map((x) => x.color) : [cssVar("--muted")],
        borderWidth: 0,
      }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: "55%",
      interaction: chartInteraction(),
      plugins: {
        legend: legendOpts({ labels: { boxWidth: 8, font: { size: 10 } } }),
        tooltip: { enabled: true, callbacks: { label: (ctx) => `${ctx.label}: ${money(ctx.raw)}` } },
      },
    },
  });

  const liq = (tl && tl.liquid) || {};
  const cashBox = $("cash-from-sasha");
  if (cashBox) {
    const gPrice = liq.gold_price
      ? `${Number(liq.gold_price).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₽/г`
      : "";
    const gGrams = liq.gold_grams != null ? `${liq.gold_grams} г` : "100 г";
    cashBox.innerHTML =
      "<h3>Ликвидность</h3>" +
      `<div class="share-row"><span>Всего</span><b>${money(liq.liquid_total || 0)}</b></div>` +
      `<div class="share-row"><span>Наличные</span><b>${money(liq.cash || 0)}</b></div>` +
      `<div class="share-row"><span>Золото${gPrice ? ` · ${gGrams} × ${gPrice}` : ""}</span><b>${money(liq.gold || 0)}</b></div>` +
      `<div class="share-row"><span>Накопления Маша</span><b>${money(liq.masha || 0)}</b></div>` +
      `<div class="share-row"><span>Накопления Саша</span><b>${money(liq.sasha || 0)}</b></div>`;
  }

  const props = data.property || (tl && tl.property_shares) || [];
  const labels = props.map((p) => p.name.replace("Куинджи · ", "").replace("Bangtao · ", ""));
  const sasha = cssVar("--gold");
  const masha = cssVar("--l2");
  const onSasha = cssVar("--on-accent");
  const onMasha = cssVar("--l2-on");
  paintChart("chart-property", {
    type: "bar",
    plugins: [{
      id: "barPctLabels",
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = "600 12px Montserrat, sans-serif";
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
          data: props.map((p) => {
            const row = (p.shares || []).find((s) => s.owner === "Саша");
            return row ? Math.round(row.share * 100) : 0;
          }),
          backgroundColor: sasha,
          borderRadius: 4,
        },
        {
          label: "Маша",
          data: props.map((p) => {
            const row = (p.shares || []).find((s) => s.owner === "Маша");
            return row ? Math.round(row.share * 100) : 0;
          }),
          backgroundColor: masha,
          borderRadius: 4,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: chartInteraction(),
      plugins: {
        legend: legendOpts(),
        tooltip: {
          enabled: true,
          callbacks: {
            label: (ctx) => {
              const p = props[ctx.dataIndex];
              const share = ctx.raw;
              const val = p ? Math.round((p.value || 0) * share / 100) : 0;
              return `${ctx.dataset.label}: ${share}% · ${money(val)}`;
            },
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

  const propTable = $("property-table");
  if (propTable) propTable.innerHTML = "";
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
      await refreshDerived();
    });
  });
}

window.sashaBudgetReload = async function () {
  try {
    state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    if ($("ledger-wrap")) renderLedger(state.ledger);
  } catch {}
};

boot().catch((err) => { $("upload-status").textContent = err.message; });
