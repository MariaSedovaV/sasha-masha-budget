const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3).toLowerCase());
const DETAIL_PALETTE = [
  "#d4b483", "#6ec4c8", "#8fbea8", "#8aa4c7", "#d9897a",
  "#c4a574", "#5aadb2", "#6fa890", "#7a94b5", "#c7786a",
  "#e8d3a8", "#9ad4d7", "#a8d0bc", "#a8bdd6", "#e5a89d",
];

const FALLBACK_TREE = [
  { id: "basket", label: "Корзина", tone: "gold", categories: [], children: [] },
  { id: "expense", label: "Расходы", tone: "rose", categories: [], children: [] },
  { id: "income", label: "Доходы", tone: "sage", categories: [], children: [] },
];

const FCF_YEAR_MIN = 2026;
const FCF_YEAR_MAX = 2040;
const FCF_RANGE_DEFAULT = [2026, 2030];
const FCF_Q_LABELS = ["I", "II", "III", "IV"];
const SLICE_DEFAULT_GROUPS = ["income", "expense"];

function fcfQuarterIndex(year, quarter = 0) {
  return Number(year) * 4 + Number(quarter);
}

function fcfQuarterParts(idx) {
  const n = Math.round(Number(idx) || 0);
  const year = Math.floor(n / 4);
  const q = ((n % 4) + 4) % 4;
  return { year, q };
}

function fcfQuarterLabel(idx, withYear = true) {
  const { year, q } = fcfQuarterParts(idx);
  return withYear ? `${year} ${FCF_Q_LABELS[q]}` : FCF_Q_LABELS[q];
}

const ASSET_YEAR_MIN = 2024;
const ASSET_YEAR_MAX = 2040;
const ASSET_RANGE_DEFAULT = [2024, 2028];
const ALL_ASSET_YEARS = Array.from({ length: ASSET_YEAR_MAX - ASSET_YEAR_MIN + 1 }, (_, i) => ASSET_YEAR_MIN + i);

let state = {
  importId: null,
  txs: [],
  categories: [],
  ledger: null,
  month: 8,
  analytics: null,
  filterGroups: [...SLICE_DEFAULT_GROUPS],
  selectedCats: [],
  includeBasket: true,
  sliceDetail: false,
  fcfFrom: fcfQuarterIndex(FCF_RANGE_DEFAULT[0], 0),
  fcfTo: fcfQuarterIndex(FCF_RANGE_DEFAULT[1], 3),
  assetFrom: fcfQuarterIndex(ASSET_RANGE_DEFAULT[0], 0),
  assetTo: fcfQuarterIndex(ASSET_RANGE_DEFAULT[1], 3),
  merchants: [],
  share: null,
  showDrivers: false,
  shareBound: false,
  fcfTimelineBound: false,
  assetTimelineBound: false,
  chartExpandBound: false,
  expandedPanel: null,
  keyEvents: [],
  ledgerDirty: {},
  eventsDirty: false,
  health: null,
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
  syncAgTheme();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    setActiveView(view);
    if (view === "analytics") loadAnalytics();
    else setChartExpanded(null);
    if (view === "share") loadShare();
    if (view === "data") {
      loadDataTab();
      requestAnimationFrame(() => resizeDataGrids());
    }
  });
});

function setActiveView(view) {
  $("view-analytics").classList.toggle("hidden", view !== "analytics");
  $("view-share").classList.toggle("hidden", view !== "share");
  $("view-data").classList.toggle("hidden", view !== "data");
  const shell = $("shell");
  if (shell) shell.dataset.view = view;
  document.documentElement.dataset.view = view;
  document.documentElement.classList.toggle("data-phone", view === "data" && ledgerCompact());
}

function money(n) {
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(Math.round(n)).toLocaleString("ru-RU") + " ₽";
}

function mln(n) {
  return (n / 1e6).toFixed(2).replace(".", ",") + " млн";
}

const SNAPSHOT_VER = "61";
let txGridApi = null;
let ledgerGridApi = null;
let txGridQuiet = false;
let ledgerGridQuiet = false;

function setStatus(msg) {
  const el = $("ledger-status");
  if (el) el.textContent = msg || "";
}

function formatStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return String(iso);
    return `Обновлено ${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}`;
  }
  const day = d.getDate();
  const mon = MONTHS_SHORT[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Обновлено ${day} ${mon} ${year}, ${hh}:${mm}`;
}

function paintStamp(health) {
  const el = $("data-stamp");
  if (!el) return;
  const iso = health && (health.updated_at || health.updatedAt);
  el.textContent = iso ? formatStamp(iso) : "Обновлено — нет данных";
  if (health && health.structure_ok === false && health.structure_error) {
    el.title = "Структура Excel: " + health.structure_error;
    el.classList.add("warn");
  } else {
    el.classList.remove("warn");
    el.title = health && health.excel ? `Источник: ${health.excel}` : "Время последнего обновления";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parseMoneyInput(raw, fallback) {
  if (raw == null || raw === "") return 0;
  const n = Number(String(raw).replace(/₽/g, "").replace(/\u00a0/g, "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function agThemeName() {
  return currentTheme() === "light" ? "ag-theme-quartz" : "ag-theme-quartz-dark";
}

function syncAgTheme() {
  const cls = agThemeName();
  document.querySelectorAll(".ag-grid-host").forEach((el) => {
    el.classList.remove("ag-theme-quartz", "ag-theme-quartz-dark");
    el.classList.add(cls);
  });
}

function resizeDataGrids() {
  const view = $("shell") && $("shell").dataset.view;
  document.documentElement.classList.toggle("data-phone", view === "data" && ledgerCompact());
  if (txGridApi && typeof txGridApi.sizeColumnsToFit === "function") txGridApi.sizeColumnsToFit();
  if (ledgerGridApi) {
    applyLedgerGridLayout(ledgerGridApi);
    ledgerFitIfWide(ledgerGridApi);
  }
}

function ledgerCompact() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function ledgerFitIfWide(api) {
  if (!api || typeof api.sizeColumnsToFit !== "function") return;
  if (!ledgerCompact() && window.innerWidth >= 1100) api.sizeColumnsToFit();
}

function applyLedgerGridLayout(api) {
  if (!api) return;
  const compact = ledgerCompact();
  api.setGridOption("domLayout", compact ? "autoHeight" : "normal");
  api.setGridOption("alwaysShowHorizontalScroll", true);
  api.setGridOption("alwaysShowVerticalScroll", !compact);
  api.setGridOption("suppressColumnVirtualisation", compact);
  api.setGridOption("rowHeight", compact ? 36 : 44);
  api.setGridOption("headerHeight", compact ? 32 : 36);
  if (typeof api.setColumnWidth === "function") {
    api.setColumnWidth("category", compact ? 120 : 180, true);
    for (let i = 1; i <= 12; i += 1) api.setColumnWidth("m" + i, compact ? 104 : 108, true);
  }
}

function agGridAvailable() {
  return window.agGrid && typeof agGrid.createGrid === "function";
}

function isLocalApi() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

async function api(path, opts) {
  const name = path.replace(/^\/api\//, "").split("?")[0];
  const urls = [];
  if (isLocalApi()) urls.push(path);
  if (!opts || !opts.method || opts.method === "GET") {
    urls.push("static/snapshot/" + name + ".json?v=" + SNAPSHOT_VER + "&d=" + new Date().toISOString().slice(0, 10));
  }
  let last = new Error("Нет данных: " + path);
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (opts && opts.method && opts.method !== "GET") ? 60000 : 8000);
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
  if ($("shell") && !$("shell").dataset.view) setActiveView("analytics");
  else setActiveView(($("shell") && $("shell").dataset.view) || "analytics");
  window.addEventListener("resize", () => {
    if ($("view-data") && !$("view-data").classList.contains("hidden")) resizeDataGrids();
    Object.keys(charts || {}).forEach((id) => {
      const chart = charts[id];
      if (chart && typeof chart.resize === "function") chart.resize();
    });
  });
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  });
  bindLedgerSave();
  bindEventPop();

  let health = { closed_month: 7, excel: null };
  try {
    health = await api("/api/health");
    state.health = health;
    paintStamp(health);
    setStatus("");
  } catch (err) {
    paintStamp(null);
    setStatus("Сервер недоступен, показан сохранённый снимок.");
  }
  state.month = Math.min(12, (health.closed_month || 7) + 1);

  try {
    const ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    state.ledger = ledger;
    state.categories = ledger.categories || [];
    hydrateEvents(ledger, state.analytics);
  } catch (err) {
    state.ledger = { income: [], expense: [], categories: [] };
    state.categories = [];
  }

  try {
    await Promise.all([loadAnalytics(), loadMarkets()]);
  } catch (err) {
    setStatus("Не удалось загрузить аналитику: " + (err.message || err));
  }
  if (isLocalApi()) setInterval(loadMarkets, 60 * 60 * 1000);
}

const drop = $("drop");
const file = $("file");
if (drop && file) {
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  });
  file.addEventListener("change", () => { if (file.files[0]) upload(file.files[0]); });
}
if ($("tx-search")) $("tx-search").addEventListener("input", renderTx);
if ($("btn-apply")) $("btn-apply").addEventListener("click", applyMonth);
if ($("rule-form")) $("rule-form").addEventListener("submit", saveRule);

$("btn-reset-filters").addEventListener("click", () => {
  state.filterGroups = [...SLICE_DEFAULT_GROUPS];
  state.selectedCats = [];
  state.includeBasket = true;
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

function timelineSpecs() {
  return {
    fcf: {
      boxId: "fcf-years",
      boundKey: "fcfTimelineBound",
      fromKey: "fcfFrom",
      toKey: "fcfTo",
      unit: "quarter",
      defaults: [
        fcfQuarterIndex(FCF_RANGE_DEFAULT[0], 0),
        fcfQuarterIndex(FCF_RANGE_DEFAULT[1], 3),
      ],
      bounds: () => {
        const hz = state.analytics && state.analytics.fcf_horizon;
        const minY = Number(hz && hz.start_year) || FCF_YEAR_MIN;
        const maxY = Number(hz && hz.end_year) || FCF_YEAR_MAX;
        return { min: fcfQuarterIndex(minY, 0), max: fcfQuarterIndex(maxY, 3) };
      },
      onChange: () => paintCumul(),
    },
    asset: {
      boxId: "asset-years",
      boundKey: "assetTimelineBound",
      fromKey: "assetFrom",
      toKey: "assetTo",
      unit: "quarter",
      defaults: [
        fcfQuarterIndex(ASSET_RANGE_DEFAULT[0], 0),
        fcfQuarterIndex(ASSET_RANGE_DEFAULT[1], 3),
      ],
      bounds: () => {
        const tl = state.share && state.share.timeline;
        const minY = Number(tl && tl.start_year) || ASSET_YEAR_MIN;
        const maxY = Number(tl && tl.end_year) || ASSET_YEAR_MAX;
        return { min: fcfQuarterIndex(minY, 0), max: fcfQuarterIndex(maxY, 3) };
      },
      onChange: () => paintShare(),
    },
  };
}

function formatTimelineRange(kind, from, to) {
  const spec = timelineSpecs()[kind];
  if (!spec || spec.unit !== "quarter") return from === to ? String(from) : `${from} — ${to}`;
  const a = fcfQuarterParts(from);
  const b = fcfQuarterParts(to);
  if (from === to) return fcfQuarterLabel(from);
  const left = a.q === 0 ? String(a.year) : fcfQuarterLabel(from);
  const right = b.q === 3 ? String(b.year) : fcfQuarterLabel(to);
  return `${left} — ${right}`;
}

function clampTimelineRange(kind) {
  const spec = timelineSpecs()[kind];
  const { min, max } = spec.bounds();
  let from = Number(state[spec.fromKey]);
  let to = Number(state[spec.toKey]);
  if (!Number.isFinite(from)) from = spec.defaults[0];
  if (!Number.isFinite(to)) to = spec.defaults[1];
  from = Math.max(min, Math.min(max, Math.round(from)));
  to = Math.max(min, Math.min(max, Math.round(to)));
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  state[spec.fromKey] = from;
  state[spec.toKey] = to;
  return { min, max, from, to };
}

function yearFromTimelinePoint(box, clientX, min, max) {
  const ticks = [...box.querySelectorAll("[data-qidx], .fcf-tick")];
  if (ticks.length) {
    let best = ticks[0];
    let bestDist = Infinity;
    ticks.forEach((tick) => {
      const rect = tick.getBoundingClientRect();
      const dist = Math.abs(clientX - (rect.left + rect.width / 2));
      if (dist < bestDist) {
        bestDist = dist;
        best = tick;
      }
    });
    const q = Number(best.dataset.qidx);
    if (Number.isFinite(q)) return q;
    const y = Number(best.dataset.year);
    if (Number.isFinite(y)) return y;
  }
  const track = box.querySelector(".fcf-track");
  if (!track) return min;
  const rect = track.getBoundingClientRect();
  if (!rect.width) return min;
  const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return min + Math.round(t * (max - min));
}

function setTimelineHandleYear(kind, handle, year) {
  const spec = timelineSpecs()[kind];
  const { min, max, from, to } = clampTimelineRange(kind);
  const y = Math.max(min, Math.min(max, year));
  if (handle === "min") state[spec.fromKey] = Math.min(y, to);
  else state[spec.toKey] = Math.max(y, from);
  const next = clampTimelineRange(kind);
  if (next.from === from && next.to === to) {
    syncTimeline(kind);
    return false;
  }
  spec.onChange();
  return true;
}

function bindTimeline(kind) {
  const spec = timelineSpecs()[kind];
  const box = $(spec.boxId);
  if (!box) return;
  if (state[spec.boundKey]) {
    syncTimeline(kind);
    return;
  }
  state[spec.boundKey] = true;
  const p = kind;
  box.innerHTML = `
    <div class="fcf-timeline-head">
      <span class="year-picks-label">Горизонт</span>
      <span class="fcf-timeline-range" id="${p}-range-label"></span>
    </div>
    <div class="fcf-slider" id="${p}-slider">
      <div class="fcf-track" id="${p}-track">
        <div class="fcf-fill" id="${p}-fill"></div>
        <button type="button" class="fcf-thumb" id="${p}-thumb-min" data-handle="min" aria-label="Начало диапазона"></button>
        <button type="button" class="fcf-thumb" id="${p}-thumb-max" data-handle="max" aria-label="Конец диапазона"></button>
      </div>
      <div class="fcf-scale" id="${p}-scale"></div>
    </div>`;

  const track = box.querySelector(".fcf-track");
  const slider = box.querySelector(".fcf-slider");
  let dragHandle = null;

  const onMove = (ev) => {
    if (!dragHandle) return;
    ev.preventDefault();
    const { min, max } = clampTimelineRange(kind);
    setTimelineHandleYear(kind, dragHandle, yearFromTimelinePoint(box, ev.clientX, min, max));
  };
  const onUp = () => {
    dragHandle = null;
    box.querySelectorAll(".fcf-thumb").forEach((t) => t.classList.remove("dragging"));
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  box.querySelectorAll(".fcf-thumb").forEach((thumb) => {
    thumb.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dragHandle = thumb.dataset.handle;
      thumb.classList.add("dragging");
      thumb.focus();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    thumb.addEventListener("keydown", (ev) => {
      const handle = thumb.dataset.handle;
      const { min, max, from, to } = clampTimelineRange(kind);
      const cur = handle === "min" ? from : to;
      let next = cur;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") next = cur - 1;
      else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") next = cur + 1;
      else if (ev.key === "Home") next = min;
      else if (ev.key === "End") next = max;
      else return;
      ev.preventDefault();
      setTimelineHandleYear(kind, handle, next);
    });
  });

  if (track) {
    track.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".fcf-thumb")) return;
      const { min, max, from, to } = clampTimelineRange(kind);
      const y = yearFromTimelinePoint(box, ev.clientX, min, max);
      const handle = Math.abs(y - from) <= Math.abs(y - to) ? "min" : "max";
      dragHandle = handle;
      setTimelineHandleYear(kind, handle, y);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  if (slider) {
    slider.addEventListener("click", (ev) => {
      const qTick = ev.target.closest("[data-qidx]");
      const yTick = ev.target.closest("[data-year]");
      if (!qTick && !yTick) return;
      if ((qTick && !slider.contains(qTick)) || (yTick && !slider.contains(yTick))) return;
      const { from, to } = clampTimelineRange(kind);
      let value;
      if (qTick) {
        value = Number(qTick.dataset.qidx);
      } else if (spec.unit === "quarter") {
        const year = Number(yTick.dataset.year);
        const q1 = fcfQuarterIndex(year, 0);
        const q4 = fcfQuarterIndex(year, 3);
        if (q4 < from) value = q1;
        else if (q1 > to) value = q4;
        else value = Math.abs(q1 - from) <= Math.abs(q4 - to) ? q1 : q4;
      } else {
        value = Number(yTick.dataset.year);
      }
      if (!Number.isFinite(value)) return;
      if (value < from) setTimelineHandleYear(kind, "min", value);
      else if (value > to) setTimelineHandleYear(kind, "max", value);
      else if (Math.abs(value - from) <= Math.abs(value - to)) setTimelineHandleYear(kind, "min", value);
      else setTimelineHandleYear(kind, "max", value);
    });
  }
  syncTimeline(kind);
}

function syncTimeline(kind) {
  const spec = timelineSpecs()[kind];
  const box = $(spec.boxId);
  if (!box) return;
  const { min, max, from, to } = clampTimelineRange(kind);
  const span = Math.max(1, max - min);
  const fromPct = ((from - min) / span) * 100;
  const toPct = ((to - min) / span) * 100;
  const fill = box.querySelector(".fcf-fill");
  const minThumb = box.querySelector("[data-handle='min']");
  const maxThumb = box.querySelector("[data-handle='max']");
  const label = box.querySelector(".fcf-timeline-range");
  const scale = box.querySelector(".fcf-scale");
  const slider = box.querySelector(".fcf-slider");
  if (fill) {
    fill.style.left = fromPct + "%";
    fill.style.width = Math.max(0, toPct - fromPct) + "%";
  }
  if (minThumb) {
    minThumb.style.left = fromPct + "%";
    minThumb.setAttribute("role", "slider");
    minThumb.setAttribute("aria-valuemin", String(min));
    minThumb.setAttribute("aria-valuemax", String(to));
    minThumb.setAttribute("aria-valuenow", String(from));
    minThumb.setAttribute("aria-valuetext", spec.unit === "quarter" ? fcfQuarterLabel(from) : String(from));
  }
  if (maxThumb) {
    maxThumb.style.left = toPct + "%";
    maxThumb.setAttribute("role", "slider");
    maxThumb.setAttribute("aria-valuemin", String(from));
    maxThumb.setAttribute("aria-valuemax", String(max));
    maxThumb.setAttribute("aria-valuenow", String(to));
    maxThumb.setAttribute("aria-valuetext", spec.unit === "quarter" ? fcfQuarterLabel(to) : String(to));
  }
  if (label) label.textContent = formatTimelineRange(kind, from, to);
  if (scale) {
    if (spec.unit === "quarter") {
      const minY = fcfQuarterParts(min).year;
      const maxY = fcfQuarterParts(max).year;
      const years = [];
      for (let y = minY; y <= maxY; y++) years.push(y);
      const tickCount = years.length * 4;
      scale.style.setProperty("--fcf-ticks", String(tickCount));
      scale.style.setProperty("--fcf-years", String(years.length));
      if (slider) {
        slider.style.setProperty("--fcf-ticks", String(tickCount));
        slider.style.setProperty("--fcf-years", String(years.length));
      }
      scale.classList.add("fcf-scale-q");
      const qTicks = [];
      for (let y = minY; y <= maxY; y++) {
        for (let q = 0; q < 4; q++) {
          const idx = fcfQuarterIndex(y, q);
          const on = idx >= from && idx <= to;
          qTicks.push(
            `<button type="button" class="fcf-tick q-tick${q === 0 ? " q1" : ""}${on ? " on" : ""}" data-qidx="${idx}" data-year="${y}" aria-label="${fcfQuarterLabel(idx)}"></button>`
          );
        }
      }
      const yearLabs = [];
      years.forEach((y) => {
        const q1 = fcfQuarterIndex(y, 0);
        const q4 = fcfQuarterIndex(y, 3);
        const on = q4 >= from && q1 <= to;
        yearLabs.push(
          `<button type="button" class="fcf-year-lab${on ? " on" : ""}" data-year="${y}">${String(y).slice(2)}</button>`
        );
        yearLabs.push(
          '<span class="fcf-year-gap" aria-hidden="true"></span>'.repeat(3)
        );
      });
      scale.innerHTML =
        `<div class="fcf-q-ticks">${qTicks.join("")}</div>` +
        `<div class="fcf-q-years">${yearLabs.join("")}</div>`;
    } else {
      const years = [];
      for (let y = min; y <= max; y++) years.push(y);
      const tickCount = String(years.length);
      scale.style.setProperty("--fcf-ticks", tickCount);
      if (slider) slider.style.setProperty("--fcf-ticks", tickCount);
      scale.classList.remove("fcf-scale-q");
      const ticks = [...scale.querySelectorAll(".fcf-tick")];
      if (ticks.length !== years.length) {
        scale.innerHTML = years.map((y) => {
          const on = y >= from && y <= to;
          return `<button type="button" class="fcf-tick${on ? " on" : ""}" data-year="${y}">${String(y).slice(2)}</button>`;
        }).join("");
      } else {
        ticks.forEach((el, i) => {
          el.classList.toggle("on", years[i] >= from && years[i] <= to);
        });
      }
    }
  }
}

function bindFcfTimeline() {
  bindTimeline("fcf");
}

function resizeChartsIn(panel) {
  requestAnimationFrame(() => {
    if (!panel || !charts) return;
    panel.querySelectorAll("canvas").forEach((el) => {
      const chart = charts[el.id];
      if (chart && typeof chart.resize === "function") chart.resize();
    });
  });
}

function setChartExpanded(panel) {
  const backdrop = $("fcf-backdrop");
  const current = state.expandedPanel;
  const next = panel && current === panel ? null : panel;
  document.querySelectorAll(".panel.is-expanded").forEach((p) => p.classList.remove("is-expanded"));
  document.querySelectorAll(".chart-expand").forEach((btn) => {
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "На весь экран");
    btn.title = "На весь экран";
  });
  state.expandedPanel = next;
  document.body.classList.toggle("chart-fs", !!next);
  if (next) {
    next.classList.add("is-expanded");
    next.querySelectorAll(".chart-expand").forEach((btn) => {
      btn.setAttribute("aria-pressed", "true");
      btn.setAttribute("aria-label", "Свернуть график");
      btn.title = "Свернуть";
    });
  }
  if (backdrop) {
    backdrop.hidden = !next;
    backdrop.classList.toggle("hidden", !next);
  }
  resizeChartsIn(next || current);
}

function bindChartExpands() {
  if (state.chartExpandBound) return;
  state.chartExpandBound = true;
  document.querySelectorAll(".chart-expand").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setChartExpanded(btn.closest(".panel"));
    });
  });
  const backdrop = $("fcf-backdrop");
  if (backdrop) backdrop.addEventListener("click", () => setChartExpanded(null));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.expandedPanel) {
      ev.preventDefault();
      setChartExpanded(null);
    }
  });
}

async function upload(f) {
  setStatus("Читаю справку…");
  const fd = new FormData();
  fd.append("file", f);
  try {
    const out = await api("/api/upload", { method: "POST", body: fd });
    state.importId = out.import_id;
    const detail = await api(`/api/imports/${out.import_id}`);
    state.txs = detail.transactions;
    setStatus(`Разобрано ${out.count} операций (${out.header.period_from || "?"} — ${out.header.period_to || "?"}). Проверьте категории и запишите месяц.`);
    const monthsPresent = [...new Set(state.txs.map((t) => t.month))].sort((a, b) => a - b);
    if (monthsPresent.includes(8)) state.month = 8;
    else if (monthsPresent.length) state.month = monthsPresent[monthsPresent.length - 1];
    $("import-month").value = String(state.month);
    renderTx();
    renderPropose();
    loadImports();
    loadMerchants();
  } catch (err) {
    setStatus("Не получилось прочитать файл: " + err.message);
  }
}

function catSelect(current) {
  return state.categories.map((c) =>
    `<option ${c === current ? "selected" : ""}>${c}</option>`
  ).join("");
}

function txNoRowsText() {
  return `Нет операций за ${MONTHS[state.month - 1]}. Загрузите справку или выберите импорт слева.`;
}

function txRowData() {
  const q = (($("tx-search") && $("tx-search").value) || "").toLowerCase();
  return (state.txs || [])
    .filter((t) => t.month === state.month && (!q || (t.description || "").toLowerCase().includes(q)))
    .map((t) => ({ ...t, included: !!t.included }));
}

function txIncludedRenderer(p) {
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = !!p.value;
  inp.setAttribute("aria-label", "Учесть операцию");
  inp.addEventListener("click", (ev) => ev.stopPropagation());
  inp.addEventListener("change", () => {
    if (!!p.value === inp.checked) return;
    p.node.setDataValue("included", inp.checked);
  });
  return inp;
}

function txDateRenderer(p) {
  const t = p.data || {};
  return `${escapeHtml(t.op_date || "")}<div class="conf">${escapeHtml(t.op_time || "")} · карта ${escapeHtml(t.card || "—")}</div>`;
}

function txDescRenderer(p) {
  const t = p.data || {};
  return `${escapeHtml(t.description || "")}<div class="conf">уверенность ${escapeHtml(t.confidence ?? "—")}%</div>`;
}

async function onTxCellChanged(e) {
  if (txGridQuiet || !e.data || e.newValue === e.oldValue) return;
  const id = e.data.id;
  const revert = () => {
    txGridQuiet = true;
    e.data[e.colDef.field] = e.oldValue;
    e.api.refreshCells({ rowNodes: [e.node], columns: [e.column], force: true });
    txGridQuiet = false;
  };
  if (e.colDef.field === "included") {
    try {
      await api(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ included: e.newValue ? 1 : 0 }),
      });
      const tx = state.txs.find((x) => x.id === id);
      if (tx) tx.included = e.newValue ? 1 : 0;
      e.api.redrawRows({ rowNodes: [e.node] });
      renderPropose();
    } catch (err) {
      revert();
      setStatus("Не записалось: " + (err.message || err));
    }
    return;
  }
  if (e.colDef.field === "category") {
    try {
      await api(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: e.newValue }),
      });
      const tx = state.txs.find((x) => x.id === id);
      if (tx) {
        tx.category = e.newValue;
        tx.confidence = 99;
      }
      e.data.confidence = 99;
      e.api.refreshCells({ rowNodes: [e.node], columns: ["description"], force: true });
      renderPropose();
      loadMerchants();
    } catch (err) {
      revert();
      setStatus("Не записалось: " + (err.message || err));
    }
  }
}

function ensureTxGrid() {
  const el = $("tx-grid");
  if (!el) return null;
  syncAgTheme();
  if (!agGridAvailable()) {
    el.innerHTML = "<p class='hint'>Не загрузился AG Grid. Проверьте сеть и обновите страницу.</p>";
    return null;
  }
  if (txGridApi) return txGridApi;
  txGridApi = agGrid.createGrid(el, {
    rowData: [],
    getRowId: (p) => String(p.data.id),
    rowHeight: 48,
    headerHeight: 36,
    singleClickEdit: true,
    stopEditingWhenCellsLoseFocus: true,
    animateRows: false,
    enableBrowserTooltips: true,
    popupParent: document.body,
    overlayNoRowsTemplate: `<span class="ag-overlay-msg">${txNoRowsText()}</span>`,
    defaultColDef: {
      sortable: true,
      resizable: true,
      filter: false,
      suppressHeaderMenuButton: true,
      suppressMenu: true,
    },
    getRowClass: (p) => {
      const cls = [];
      if (!p.data) return cls;
      cls.push(p.data.amount >= 0 ? "tx-in" : "tx-out");
      if (!p.data.included) cls.push("tx-off");
      return cls;
    },
    onCellValueChanged: onTxCellChanged,
    onGridSizeChanged: (p) => p.api.sizeColumnsToFit(),
    onFirstDataRendered: (p) => p.api.sizeColumnsToFit(),
    columnDefs: [
      {
        field: "included",
        headerName: "",
        width: 52,
        maxWidth: 56,
        sortable: false,
        editable: false,
        cellRenderer: txIncludedRenderer,
      },
      {
        field: "op_date",
        headerName: "Дата",
        minWidth: 128,
        width: 148,
        cellRenderer: txDateRenderer,
        tooltipValueGetter: (p) => p.data ? `${p.data.op_date || ""} ${p.data.op_time || ""}` : "",
      },
      {
        field: "amount",
        headerName: "Сумма",
        minWidth: 110,
        width: 120,
        type: "numericColumn",
        valueFormatter: (p) => money(p.value || 0),
        cellClass: (p) => (p.value >= 0 ? "num tx-amt-in" : "num tx-amt-out"),
      },
      {
        field: "description",
        headerName: "Описание",
        flex: 1,
        minWidth: 180,
        cellRenderer: txDescRenderer,
        tooltipValueGetter: (p) => (p.data && p.data.description) || "",
      },
      {
        field: "category",
        headerName: "Статья",
        minWidth: 170,
        width: 210,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: () => ({ values: state.categories || [] }),
      },
    ],
  });
  return txGridApi;
}

function renderTx() {
  const api = ensureTxGrid();
  if (!api) return;
  api.setGridOption("overlayNoRowsTemplate", `<span class="ag-overlay-msg">${txNoRowsText()}</span>`);
  api.setGridOption("rowData", txRowData());
  requestAnimationFrame(() => api.sizeColumnsToFit());
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
    setStatus(`${MONTHS[state.month - 1]} записан в факт. Откройте аналитику — выводы пересчитались.`);
    renderPropose();
    renderLedger(state.ledger);
    await refreshDerived();
  } catch (err) {
    setStatus("Не записалось: " + err.message);
  } finally {
    $("btn-apply").disabled = false;
  }
}

async function loadDataTab() {
  if (!hasUnsavedLedger()) {
    if (!state.ledger) state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    if (!state.analytics) {
      try { state.analytics = await api("/api/analytics"); } catch {}
    }
    hydrateEvents(state.ledger, state.analytics);
  }
  renderLedger(state.ledger);
  renderEventsStrip();
  syncLedgerSaveBtn();
  requestAnimationFrame(() => resizeDataGrids());
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

function isQuarterIndex(labels, i) {
  const lab = labels && labels[i];
  if (lab != null && String(lab).includes(".")) {
    const m = Number(String(lab).split(".")[0]);
    return m === 1 || m === 4 || m === 7 || m === 10;
  }
  return i % 3 === 0;
}

function xAxisMonthQuarter(labels) {
  const light = currentTheme() === "light";
  const month = light ? "rgba(28,25,21,0.035)" : "rgba(239,232,220,0.02)";
  const quarter = light ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)";
  const dense = (labels || []).length > 18;
  return {
    grid: {
      color: (ctx) => {
        const i = Number.isFinite(ctx && ctx.index)
          ? ctx.index
          : (ctx && ctx.tick && Number.isFinite(ctx.tick.value) ? ctx.tick.value : -1);
        if (i < 0) return month;
        return isQuarterIndex(labels, i) ? quarter : month;
      },
    },
    ticks: {
      maxRotation: 0,
      autoSkip: false,
      callback: (val, i) => {
        const lab = labels[i];
        if (lab == null) return "";
        if (dense) {
          const m = Number(String(lab).split(".")[0]);
          return m === 1 ? lab : "";
        }
        return lab;
      },
    },
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
  const box = $("markets");
  if (!box) return;
  const usdDelta = mk.usd && mk.usd.previous ? mk.usd.value - mk.usd.previous : 0;
  const thbDelta = mk.thb && mk.thb.previous ? mk.thb.value - mk.thb.previous : 0;
  const stamp = mk.as_of ? `ЦБ · ${String(mk.as_of).slice(0, 10)}` : "";
  const cacheNote = mk.cached ? " · кэш 1 ч" : " · только что";
  box.innerHTML = [
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
  return `<div class="kpi compact ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ""}</div></div>`;
}

async function loadAnalytics() {
  const [an, ledger] = await Promise.all([
    api("/api/analytics"),
    api("/api/ledger"),
  ]);
  state.analytics = an;
  if (!hasUnsavedLedger()) {
    state.ledger = applyVoiceAddsToLedger(ledger);
    hydrateEvents(ledger, an);
  }
  if (an.updated_at) paintStamp({ ...(state.health || {}), updated_at: an.updated_at });

  const dlt = an.delta;
  const closedShort = MONTHS_SHORT[an.closed_month - 1] || "";
  const kpis = $("budget-kpis");
  if (kpis) {
    kpis.innerHTML = [
      `<div class="chip-kpi"><b>${mln(an.cumul_fact)}</b><span>факт CFCF · ${closedShort}</span></div>`,
      `<div class="chip-kpi"><b>${dlt >= 0 ? "+" : "−"}${Math.abs(dlt / 1000).toFixed(0)} тыс.</b><span>к плану на ${closedShort}</span></div>`,
      `<div class="chip-kpi"><b>${mln(an.net_worth)}</b><span>FCF + оплаченное жильё</span></div>`,
    ].join("");
  }

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

function dashboardNow() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function nowLineForLabels(labels, fallbackYear) {
  const now = dashboardNow();
  const short = MONTHS_SHORT[now.month - 1] || "сейчас";
  const label = `${short} ${String(now.year).slice(2)}`;
  let index = -1;
  (labels || []).forEach((lab, i) => {
    const s = String(lab);
    if (s.includes(".")) {
      const parts = s.split(".");
      if (Number(parts[0]) === now.month && Number(parts[1]) === now.year) index = i;
    }
  });
  if (index < 0 && fallbackYear === now.year && now.month >= 1 && now.month <= (labels || []).length) {
    index = now.month - 1;
  }
  return { index, label };
}

function factMonthCount(an) {
  const until = Number(an && an.fact_until);
  if (until > 0) return until;
  return Number(an && an.closed_month) || 0;
}

function catHasYearData(c) {
  const row = ((state.analytics && state.analytics.monthly) || []).find((r) => r.category === c);
  if (!row) return false;
  if ((row.plan || []).some((v) => Math.abs(Number(v) || 0) > 0.5)) return true;
  return catHasFact(c);
}

function catHasFact(c) {
  const row = ((state.analytics && state.analytics.monthly) || []).find((r) => r.category === c);
  if (!row) return false;
  const until = factMonthCount(state.analytics);
  return (row.fact || []).some((v, i) => i < until && Math.abs(Number(v) || 0) > 0.5);
}

function sliceFlags() {
  const g = new Set((state.filterGroups || []).filter((id) => id === "income" || id === "expense"));
  return {
    income: g.has("income"),
    expense: g.has("expense"),
    basket: !!state.includeBasket,
  };
}

function sliceHasData() {
  const f = sliceFlags();
  return f.income || f.expense || f.basket;
}

function sliceFocus() {
  const f = sliceFlags();
  if (f.income && !f.expense) return "income";
  if (f.expense && !f.income) return "expense";
  if (f.income && f.expense) return "all";
  return "none";
}

function treeNode(id) {
  return filterTree().find((n) => n.id === id) || null;
}

function treeChild(parentId, childId) {
  const node = treeNode(parentId);
  const fromParent = ((node && node.children) || []).find((c) => c.id === childId);
  return fromParent || treeNode(childId);
}

function nodeCats(node) {
  return (node && Array.isArray(node.categories)) ? node.categories : [];
}

function l1Nodes() {
  const income = treeNode("income");
  const expense = treeNode("expense");
  const nodes = [];
  if (income) nodes.push({ ...income, label: income.label || "Доходы" });
  if (expense) nodes.push({ ...expense, label: "Расходы" });
  return nodes;
}

function selectedGroupNodes() {
  const focus = sliceFocus();
  if (focus === "all" || focus === "none") return [];
  const node = treeNode(focus);
  return node ? [node] : [];
}

function incomeCats() {
  const node = treeNode("income");
  if (node && Array.isArray(node.categories) && node.categories.length) return node.categories;
  const fg = state.analytics && state.analytics.filter_groups && state.analytics.filter_groups.income;
  if (Array.isArray(fg) && fg.length) return fg;
  return ["Зарплата Саша", "Премия Саша", "Зарплата Маша", "Премия Маша", "Займы", "Подарки"];
}

function expenseCats() {
  const fg = state.analytics && state.analytics.filter_groups && state.analytics.filter_groups.expense;
  if (Array.isArray(fg) && fg.length) return fg;
  const node = treeNode("expense");
  if (node && Array.isArray(node.categories) && node.categories.length) return node.categories;
  return [];
}

function basketCats() {
  const cats = nodeCats(treeChild("expense", "basket"));
  if (cats.length) return cats;
  const fg = state.analytics && state.analytics.filter_groups && state.analytics.filter_groups.basket;
  return Array.isArray(fg) ? fg : [];
}

function largeCats() {
  const cats = nodeCats(treeChild("expense", "large"));
  if (cats.length) return cats;
  const basket = new Set(basketCats());
  return expenseCats().filter((c) => !basket.has(c));
}

function visibleExpenseCats() {
  if (state.includeBasket) {
    const all = expenseCats();
    return all.length ? all : [...largeCats(), ...basketCats()];
  }
  return largeCats();
}

function groupCats() {
  const focus = sliceFocus();
  const f = sliceFlags();
  if (focus === "income") return incomeCats().filter(catHasYearData);
  if (focus === "expense") return visibleExpenseCats().filter(catHasYearData);
  if (focus === "none" && f.basket) return basketCats().filter(catHasYearData);
  return [];
}

function activeCats() {
  const focus = sliceFocus();
  if (focus === "all") return [];
  const selected = state.selectedCats.filter(catHasYearData);
  return selected.length ? selected : groupCats();
}

function mixHex(hex, other, t) {
  const parse = (h) => {
    const s = String(h || "").replace("#", "").trim();
    if (s.length < 6) return [200, 140, 130];
    const n = parseInt(s.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(hex);
  const b = parse(other);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function roseSoft() {
  const rose = cssVar("--rose") || "#d9897a";
  return mixHex(rose, currentTheme() === "light" ? "#fff7f4" : "#f6e4df", 0.42);
}

function fcfMonthTitle(lab) {
  const parts = String(lab).split(".");
  const m = Number(parts[0]);
  const y = parts[1] || "";
  if (m >= 1 && m <= 12) return `${MONTHS[m - 1]} ${y}`;
  return String(lab);
}

function mlnShort(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(2).replace(".", ",");
}

function mlnSigned(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + Math.abs(n).toFixed(2).replace(".", ",");
}

const fcfCrosshairPlugin = {
  id: "fcfCrosshair",
  afterDatasetsDraw(chart, _args, opts) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const candidates = active.filter((a) => {
      const ds = chart.data.datasets[a.datasetIndex];
      const val = ds && ds.data ? ds.data[a.index] : null;
      return ds && !ds.isEvent && val != null && !Number.isNaN(Number(val));
    });
    let x;
    let y;
    const yMode = opts && opts.yMode;
    const idx = (candidates[0] || active[0]).index;
    if (yMode === "sum" && scales && scales.x && scales.y) {
      x = scales.x.getPixelForValue(idx);
      let total = 0;
      let any = false;
      (chart.data.datasets || []).forEach((ds, i) => {
        if (!ds || ds.isEvent) return;
        const meta = chart.getDatasetMeta(i);
        if (meta && meta.hidden) return;
        const val = ds.data ? ds.data[idx] : null;
        if (val == null || Number.isNaN(Number(val))) return;
        total += Number(val);
        any = true;
      });
      if (!any || !Number.isFinite(x)) return;
      y = scales.y.getPixelForValue(total);
    } else {
      const factPt = candidates.find((a) => {
        const lab = chart.data.datasets[a.datasetIndex].label || "";
        return lab === "CFCF факт" || lab === "FCF факт";
      });
      const flowPt = candidates.find((a) => {
        const lab = chart.data.datasets[a.datasetIndex].label || "";
        return lab === "Доходы факт" || lab === "Расходы факт";
      });
      const planPt = candidates.find((a) => {
        const lab = chart.data.datasets[a.datasetIndex].label || "";
        return lab === "CFCF план" || lab === "FCF план" || lab === "Итог план"
          || lab === "План доходов" || lab === "План расходов";
      });
      const main = factPt || flowPt || planPt || candidates[0] || active.find((a) => a.element) || active[0];
      if (!main || !main.element) return;
      x = main.element.x;
      y = main.element.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const stroke = currentTheme() === "light" ? "rgba(110,78,40,0.38)" : "rgba(232,211,168,0.38)";
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const gold = factColor();
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = gold;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = cssVar("--bg");
    ctx.stroke();
    ctx.restore();
  },
};

const fcfZeroLinePlugin = {
  id: "fcfZeroLine",
  afterDraw(chart) {
    const y = chart.scales && chart.scales.y;
    const { ctx, chartArea } = chart;
    if (!y || !chartArea) return;
    const py = y.getPixelForValue(0);
    if (!Number.isFinite(py) || py < chartArea.top || py > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = currentTheme() === "light" ? "rgba(28,25,21,0.22)" : "rgba(239,232,220,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, py);
    ctx.lineTo(chartArea.right, py);
    ctx.stroke();
    ctx.restore();
  },
};

const basketLimitPlugin = {
  id: "basketLimit",
  afterDraw(chart, _args, opts) {
    const yVal = opts && opts.value;
    if (yVal == null || !Number.isFinite(Number(yVal))) return;
    const y = chart.scales && chart.scales.y;
    const { ctx, chartArea } = chart;
    if (!y || !chartArea) return;
    const py = y.getPixelForValue(Number(yVal));
    if (!Number.isFinite(py) || py < chartArea.top + 2 || py > chartArea.bottom - 2) return;
    const rose = cssVar("--rose") || "#d9897a";
    const light = currentTheme() === "light";
    const stroke = light ? "rgba(185, 92, 78, 0.55)" : "rgba(217, 137, 122, 0.52)";
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, py);
    ctx.lineTo(chartArea.right - 2, py);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = String(opts.label || Math.round(Math.abs(Number(yVal))));
    ctx.font = "600 9px Montserrat, sans-serif";
    const padX = 5;
    const tw = ctx.measureText(label).width;
    const w = tw + padX * 2;
    const h = 13;
    const lx = chartArea.right - w - 1;
    let ly = py - h - 3;
    if (ly < chartArea.top + 1) ly = py + 3;
    if (ly + h > chartArea.bottom - 1) ly = py - h - 3;
    const r = 6;
    ctx.fillStyle = light ? "rgba(243, 238, 228, 0.92)" : "rgba(17, 19, 24, 0.88)";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx + r, ly);
    ctx.arcTo(lx + w, ly, lx + w, ly + h, r);
    ctx.arcTo(lx + w, ly + h, lx, ly + h, r);
    ctx.arcTo(lx, ly + h, lx, ly, r);
    ctx.arcTo(lx, ly, lx + w, ly, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rose;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + w / 2, ly + h / 2 + 0.5);
    ctx.restore();
  },
};

const nowLinePlugin = {
  id: "nowLine",
  afterDraw(chart, _args, opts) {
    const idx = opts && opts.index;
    if (idx == null || idx < 0) return;
    const xScale = chart.scales && chart.scales.x;
    const { ctx, chartArea } = chart;
    if (!xScale || !chartArea) return;
    const x = xScale.getPixelForValue(idx);
    if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) return;
    const color = currentTheme() === "light" ? "rgba(46, 122, 126, 0.85)" : "rgba(110, 196, 200, 0.85)";
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = opts.label || "сейчас";
    ctx.font = "600 10px Montserrat, sans-serif";
    const padX = 6;
    const w = ctx.measureText(label).width + padX * 2;
    const h = 16;
    let lx = x - w / 2;
    lx = Math.max(chartArea.left + 2, Math.min(chartArea.right - w - 2, lx));
    const ly = chartArea.top + 4;
    ctx.fillStyle = currentTheme() === "light" ? "rgba(243, 238, 228, 0.92)" : "rgba(17, 19, 24, 0.88)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 8;
    ctx.moveTo(lx + r, ly);
    ctx.arcTo(lx + w, ly, lx + w, ly + h, r);
    ctx.arcTo(lx + w, ly + h, lx, ly + h, r);
    ctx.arcTo(lx, ly + h, lx, ly, r);
    ctx.arcTo(lx, ly, lx + w, ly, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + w / 2, ly + h / 2);
    ctx.restore();
  },
};

const TROPHY_PATH =
  "M2.5.5A.5.5 0 0 1 3 0h10a.5.5 0 0 1 .5.5q0 .807-.034 1.536a3 3 0 1 1-1.133 5.89c-.79 1.865-1.878 2.777-2.833 3.011v2.173l1.425.356c.194.048.377.135.537.255L13.3 15.1a.5.5 0 0 1-.3.9H3a.5.5 0 0 1-.3-.9l1.838-1.379c.16-.12.343-.207.537-.255L6.5 13.11v-2.173c-.955-.234-2.043-1.146-2.833-3.012a3 3 0 1 1-1.132-5.89A33 33 0 0 1 2.5.5m.099 2.54a2 2 0 0 0 .72 3.935c-.333-1.05-.588-2.346-.72-3.935m10.083 3.935a2 2 0 0 0 .72-3.935c-.133 1.59-.388 2.885-.72 3.935";
const TROPHY_SVG =
  `<svg class="trophy-icon" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="${TROPHY_PATH}"/></svg>`;
const trophyIconCache = new Map();

function trophyIcon(color) {
  const key = color || "#d4b483";
  if (trophyIconCache.has(key)) return trophyIconCache.get(key);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="18" height="18" fill="${key}">` +
    `<path d="${TROPHY_PATH}"/></svg>`;
  const img = new Image(18, 18);
  trophyIconCache.set(key, img);
  img.onload = () => {
    const chart = charts && charts["chart-cumul"];
    if (chart) chart.update("none");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return img;
}

function eventAtIndex(events, index) {
  const list = (events || []).filter((e) => e.visIndex === index);
  return list.find((e) => e.icon === "trophy") || list[0];
}

function mergeChartEvents(baseEvents, indexMap, fact, plan) {
  const suppressed = new Set(
    (state.keyEvents || []).filter((e) => e.suppressed && e.auto_key).map((e) => e.auto_key)
  );
  const out = [];
  const byAuto = new Map();
  for (const e of baseEvents || []) {
    if (e.auto_key && suppressed.has(e.auto_key)) continue;
    const copy = { ...e };
    out.push(copy);
    if (copy.auto_key) byAuto.set(copy.auto_key, copy);
  }
  for (const s of visibleEvents()) {
    const year = Number(s.year) || FCF_YEAR_MIN;
    const month = Number(s.month);
    const index = (year - FCF_YEAR_MIN) * 12 + (month - 1);
    if (!indexMap || !indexMap.has(index)) continue;
    const visIndex = indexMap.get(index);
    const value = fact[visIndex] != null ? fact[visIndex] : (plan[visIndex] != null ? plan[visIndex] : 0);
    if (s.auto_key && byAuto.has(s.auto_key)) {
      const cur = byAuto.get(s.auto_key);
      cur.label = s.title || cur.label;
      if (s.category) cur.category = s.category;
      cur.visIndex = visIndex;
      continue;
    }
    const dup = out.find((e) =>
      e.visIndex === visIndex
      && (e.category || "") === (s.category || "")
      && (!s.auto_key || !e.auto_key || e.auto_key === s.auto_key)
    );
    if (dup) {
      dup.label = s.title || dup.label;
      continue;
    }
    out.push({
      index,
      visIndex,
      label: s.title,
      detail: s.category || "",
      tone: "gold",
      category: s.category || "",
      auto_key: s.auto_key || "",
      source: s.source || "manual",
      value,
    });
  }
  return out;
}

function wrapTooltipText(text, width = 44) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function sliceCellComments(row, monthIndex) {
  if (!row) return [];
  const factNote = (row.comment_fact || [])[monthIndex];
  const planNote = (row.comment_plan || [])[monthIndex];
  const lines = [];
  if (factNote) lines.push(...wrapTooltipText(factNote));
  if (planNote && planNote !== factNote) {
    const planLines = wrapTooltipText(planNote);
    if (planLines.length) {
      if (factNote) planLines[0] = "План: " + planLines[0];
      lines.push(...planLines);
    }
  }
  return lines;
}

function renderFcfHover(context, meta) {
  const el = $("fcf-hover");
  if (!el) return;
  const tooltip = context.tooltip;
  if (!tooltip || tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) {
    el.hidden = true;
    return;
  }
  const idx = tooltip.dataPoints[0].dataIndex;
  const fact = meta.fact[idx];
  const plan = meta.plan[idx];
  const fcfFact = meta.fcfFact ? meta.fcfFact[idx] : null;
  const fcfPlan = meta.fcfPlan ? meta.fcfPlan[idx] : null;
  const incFact = meta.incomeFact ? meta.incomeFact[idx] : null;
  const incPlan = meta.incomePlan ? meta.incomePlan[idx] : null;
  const expFact = meta.expenseFact ? meta.expenseFact[idx] : null;
  const expPlan = meta.expensePlan ? meta.expensePlan[idx] : null;
  const evs = (meta.events || []).filter((e) => e.visIndex === idx);
  const rows = [];
  if (fact != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch fact"></i><span>CFCF факт</span><b>${mlnShort(fact)} <em>млн</em></b></div>`);
  }
  if (plan != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch plan"></i><span>CFCF план</span><b>${mlnShort(plan)} <em>млн</em></b></div>`);
  }
  if (fcfFact != null || fcfPlan != null) {
    rows.push(`<div class="chart-hover-split"></div>`);
  }
  if (fcfFact != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch fcf-fact"></i><span>FCF факт</span><b>${mlnSigned(fcfFact)} <em>млн</em></b></div>`);
  }
  if (fcfPlan != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch fcf-plan"></i><span>FCF план</span><b>${mlnSigned(fcfPlan)} <em>млн</em></b></div>`);
  }
  if (incFact != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch income"></i><span>Доходы факт</span><b>${mlnShort(incFact)} <em>млн</em></b></div>`);
  }
  if (incPlan != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch income-plan"></i><span>Доходы план</span><b>${mlnShort(incPlan)} <em>млн</em></b></div>`);
  }
  if (expFact != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch expense"></i><span>Расходы факт</span><b>${mlnShort(Math.abs(expFact))} <em>млн</em></b></div>`);
  }
  if (expPlan != null) {
    rows.push(`<div class="chart-hover-row"><i class="swatch expense-plan"></i><span>Расходы план</span><b>${mlnShort(Math.abs(expPlan))} <em>млн</em></b></div>`);
  }
  let deltaHtml = "";
  if (fact != null && plan != null) {
    const d = fact - plan;
    const cls = d >= 0 ? "up" : "down";
    const sign = d >= 0 ? "+" : "−";
    deltaHtml += `<div class="chart-hover-delta ${cls}">${sign}${mlnShort(Math.abs(d))} к плану CFCF</div>`;
  }
  if (fcfFact != null && fcfPlan != null) {
    const d = fcfFact - fcfPlan;
    const cls = d >= 0 ? "up" : "down";
    const sign = d >= 0 ? "+" : "−";
    deltaHtml += `<div class="chart-hover-delta ${cls}">${sign}${mlnShort(Math.abs(d))} к плану FCF</div>`;
  }
  const eventsHtml = evs.map((e) => {
    const trophy = e.icon === "trophy" ? TROPHY_SVG : "";
    const cls = `chart-hover-event tone-${e.tone || "gold"}${e.icon === "trophy" ? " is-trophy" : ""}`;
    const text = `${e.label}${e.detail ? " · " + e.detail : ""}`;
    return `<div class="${cls}">${trophy}${escapeHtml(text)}</div>`;
  }).join("");
  if (!rows.length && !eventsHtml) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    `<div class="chart-hover-date">${fcfMonthTitle(meta.labels[idx])}</div>` +
    rows.join("") +
    deltaHtml +
    eventsHtml;
  el.hidden = false;
  const canvas = context.chart.canvas;
  const box = el.parentElement;
  const caretX = tooltip.caretX;
  const caretY = tooltip.caretY;
  const pad = 12;
  const tw = el.offsetWidth || 160;
  const th = el.offsetHeight || 72;
  const maxX = (box.clientWidth || canvas.clientWidth) - tw - 4;
  const maxY = (box.clientHeight || canvas.clientHeight) - th - 4;
  let left = caretX + pad;
  let top = caretY - th - 8;
  if (left > maxX) left = caretX - tw - pad;
  if (top < 4) top = caretY + 14;
  el.style.left = Math.max(4, Math.min(maxX, left)) + "px";
  el.style.top = Math.max(4, Math.min(maxY, top)) + "px";
}

function placeChartHover(el, context) {
  const canvas = context.chart.canvas;
  const box = el.parentElement;
  const tooltip = context.tooltip;
  const caretX = tooltip.caretX;
  const caretY = tooltip.caretY;
  const pad = 12;
  const tw = el.offsetWidth || 160;
  const th = el.offsetHeight || 72;
  const maxX = (box.clientWidth || canvas.clientWidth) - tw - 4;
  const maxY = (box.clientHeight || canvas.clientHeight) - th - 4;
  let left = caretX + pad;
  let top = caretY - th - 8;
  if (left > maxX) left = caretX - tw - pad;
  if (top < 4) top = caretY + 14;
  el.style.left = Math.max(4, Math.min(maxX, left)) + "px";
  el.style.top = Math.max(4, Math.min(maxY, top)) + "px";
}

function renderAssetHover(context, meta) {
  const el = $("asset-hover");
  if (!el) return;
  const tooltip = context.tooltip;
  if (!tooltip || tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) {
    el.hidden = true;
    return;
  }
  const idx = tooltip.dataPoints[0].dataIndex;
  const rows = [];
  let total = 0;
  let any = false;
  tooltip.dataPoints.forEach((pt) => {
    const ds = context.chart.data.datasets[pt.datasetIndex];
    const raw = pt.raw != null ? pt.raw : (ds && ds.data ? ds.data[idx] : null);
    if (raw == null || Number.isNaN(Number(raw))) return;
    const n = Number(raw);
    total += n;
    any = true;
    rows.push(
      `<div class="chart-hover-row"><i class="swatch" style="background:${ds.borderColor}"></i>` +
      `<span>${escapeHtml(ds.label)}</span><b>${mlnShort(n)} <em>млн</em></b></div>`
    );
  });
  if (!any) {
    el.hidden = true;
    return;
  }
  const orig = meta.keep ? meta.keep[idx] : idx;
  const isForecast = orig > meta.nowFull;
  el.innerHTML =
    `<div class="chart-hover-date">${fcfMonthTitle(meta.labels[idx])}</div>` +
    rows.join("") +
    `<div class="chart-hover-split"></div>` +
    `<div class="chart-hover-row"><i class="swatch total"></i><span>Итог</span><b>${mlnShort(total)} <em>млн</em></b></div>` +
    `<div class="chart-hover-delta">${isForecast ? "прогноз" : "факт / оценка"}</div>`;
  el.hidden = false;
  placeChartHover(el, context);
}

function paintCumul() {
  const an = state.analytics;
  if (!an) return;
  themeCharts();
  bindFcfTimeline();
  bindChartExpands();
  const hover = $("fcf-hover");
  if (hover) hover.hidden = true;

  const hz = an.fcf_horizon;
  const gold = factColor();
  const muted = cssVar("--muted");
  const sage = cssVar("--sage");
  const rose = cssVar("--rose");
  const { from, to } = clampTimelineRange("fcf");

  let labels = [];
  let plan = [];
  let fact = [];
  let incomePlan = [];
  let incomeFact = [];
  let expensePlan = [];
  let expenseFact = [];
  let fcfPlan = [];
  let fcfFact = [];
  let events = [];
  let keep = [];

  const netFlow = (inc, exp) => {
    if (inc == null && exp == null) return null;
    return (Number(inc) || 0) + (Number(exp) || 0);
  };

  if (hz && Array.isArray(hz.labels)) {
    hz.labels.forEach((lab, i) => {
      const { month, year } = monthYearFromLabel(lab);
      const q = Number.isFinite(month) && month >= 1
        ? fcfQuarterIndex(year, Math.floor((month - 1) / 3))
        : fcfQuarterIndex(year, 0);
      if (q >= from && q <= to) keep.push(i);
    });
    labels = keep.map((i) => hz.labels[i]);
    plan = keep.map((i) => hz.series_plan[i]);
    fact = keep.map((i) => hz.series_fact[i]);
    incomePlan = keep.map((i) => (hz.series_income_plan || [])[i]);
    incomeFact = keep.map((i) => (hz.series_income_fact || [])[i]);
    expensePlan = keep.map((i) => (hz.series_expense_plan || [])[i]);
    expenseFact = keep.map((i) => (hz.series_expense_fact || [])[i]);
    fcfPlan = keep.map((i, vis) => {
      const v = (hz.series_fcf_plan || [])[i];
      return v == null ? netFlow(incomePlan[vis], expensePlan[vis]) : v;
    });
    fcfFact = keep.map((i, vis) => {
      const v = (hz.series_fcf_fact || [])[i];
      return v == null ? netFlow(incomeFact[vis], expenseFact[vis]) : v;
    });
    const indexMap = new Map(keep.map((orig, vis) => [orig, vis]));
    events = mergeChartEvents(
      (hz.events || [])
        .filter((e) => indexMap.has(e.index))
        .map((e) => ({ ...e, visIndex: indexMap.get(e.index) })),
      indexMap,
      fact,
      plan
    );
  } else {
    labels = MONTHS.map((m) => m.slice(0, 3));
    plan = an.series_plan || [];
    fact = an.series_fact || [];
    const indexMap = new Map(labels.map((_, i) => [i, i]));
    events = mergeChartEvents([], indexMap, fact, plan);
  }

  const eventData = labels.map((_, i) => {
    const ev = eventAtIndex(events, i);
    if (!ev) return null;
    if (ev.icon === "trophy") {
      if (fact[i] != null) return fact[i];
      if (plan[i] != null) return plan[i];
    }
    if (ev.value != null && Number.isFinite(Number(ev.value))) return Number(ev.value);
    if (fact[i] != null) return fact[i];
    if (plan[i] != null) return plan[i];
    return 0;
  });

  const hasFlows = incomePlan.some((v) => v != null) || expensePlan.some((v) => v != null);
  const flowLine = {
    fill: "origin",
    tension: 0.35,
    pointRadius: 0,
    pointHoverRadius: 3,
    spanGaps: false,
    pointStyle: "line",
  };
  const barCommon = {
    type: "bar",
    borderWidth: 0,
    borderRadius: 3,
    borderSkipped: false,
    maxBarThickness: 18,
    categoryPercentage: 0.72,
    barPercentage: 0.88,
    skipNull: true,
  };
  const datasets = [
    {
      label: "CFCF факт",
      data: fact,
      borderColor: gold,
      backgroundColor: "transparent",
      fill: false,
      tension: 0.25,
      borderWidth: 2.6,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 1.5,
      pointStyle: "line",
      spanGaps: false,
      order: 1,
    },
    {
      label: "CFCF план",
      data: plan,
      borderColor: muted,
      backgroundColor: "transparent",
      borderDash: [5, 4],
      tension: 0.25,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 1.5,
      pointStyle: "line",
      spanGaps: false,
      fill: false,
      order: 2,
    },
    {
      ...barCommon,
      label: "FCF факт",
      data: fcfFact,
      backgroundColor: hexFade(gold, 0.48),
      hoverBackgroundColor: hexFade(gold, 0.7),
      order: 3,
    },
    {
      ...barCommon,
      label: "FCF план",
      data: fcfPlan,
      backgroundColor: hexFade(gold, 0.14),
      hoverBackgroundColor: hexFade(gold, 0.28),
      borderColor: hexFade(gold, 0.7),
      borderWidth: 1,
      order: 4,
    },
    {
      label: "Доходы факт",
      data: incomeFact,
      borderColor: sage,
      backgroundColor: hexFade(sage, 0.16),
      borderWidth: 1,
      order: 5,
      ...flowLine,
    },
    {
      label: "Доходы план",
      data: incomePlan,
      borderColor: sage,
      backgroundColor: hexFade(sage, 0.05),
      borderDash: [4, 3],
      borderWidth: 1,
      order: 6,
      ...flowLine,
    },
    {
      label: "Расходы факт",
      data: expenseFact,
      borderColor: rose,
      backgroundColor: hexFade(rose, 0.16),
      borderWidth: 1,
      order: 5,
      ...flowLine,
    },
    {
      label: "Расходы план",
      data: expensePlan,
      borderColor: rose,
      backgroundColor: hexFade(rose, 0.05),
      borderDash: [4, 3],
      borderWidth: 1,
      order: 6,
      ...flowLine,
    },
    {
      label: "Ключевое событие",
      data: eventData,
      borderColor: gold,
      backgroundColor: gold,
      showLine: false,
      pointRadius: (ctx) => {
        if (eventData[ctx.dataIndex] == null) return 0;
        const compact = ledgerCompact();
        const trophy = eventAtIndex(events, ctx.dataIndex)?.icon === "trophy";
        if (compact) return trophy ? 12 : 7;
        return trophy ? 9 : 6;
      },
      pointHoverRadius: (ctx) => {
        const compact = ledgerCompact();
        const trophy = eventAtIndex(events, ctx.dataIndex)?.icon === "trophy";
        if (compact) return trophy ? 14 : 9;
        return trophy ? 11 : 8;
      },
      pointHitRadius: ledgerCompact() ? 18 : 10,
      pointBorderWidth: (ctx) => (eventAtIndex(events, ctx.dataIndex)?.icon === "trophy" ? 0 : 1),
      pointStyle: (ctx) => {
        const ev = eventAtIndex(events, ctx.dataIndex);
        return ev && ev.icon === "trophy" ? trophyIcon(gold) : "rectRot";
      },
      order: 0,
      isEvent: true,
    },
  ];
  const visible = hasFlows
    ? datasets
    : datasets.filter((ds) => !String(ds.label).startsWith("Доходы") && !String(ds.label).startsWith("Расходы"));

  const nowMark = nowLineForLabels(labels, Number(an.year) || 2026);
  const nowIdx = nowMark.index;
  const nowLabel = nowMark.label;

  const grid = currentTheme() === "light" ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)";

  paintChart("chart-cumul", {
    type: "line",
    plugins: [fcfCrosshairPlugin, fcfZeroLinePlugin, nowLinePlugin],
    data: { labels, datasets: visible },
    options: {
      maintainAspectRatio: false,
      animation: { duration: 180 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendOpts({
          labels: {
            boxWidth: 10,
            font: { size: 10 },
            filter: (item) => item.text !== "Ключевое событие",
          },
        }),
        tooltip: {
          enabled: false,
          external: (ctx) => renderFcfHover(ctx, {
            labels, plan, fact, fcfPlan, fcfFact, incomePlan, incomeFact, expensePlan, expenseFact, events,
          }),
        },
        nowLine: nowIdx >= 0 ? { index: nowIdx, label: nowLabel } : { index: -1 },
      },
      scales: {
        ...scaleOpts(),
        x: {
          ...scaleOpts().x,
          ...xAxisMonthQuarter(labels),
          offset: true,
        },
        y: {
          ...scaleOpts().y,
          title: { display: true, text: "млн ₽", color: muted },
          grid: {
            color: (ctx) => (ctx.tick && ctx.tick.value === 0
              ? (currentTheme() === "light" ? "rgba(28,25,21,0.22)" : "rgba(239,232,220,0.18)")
              : grid),
          },
        },
      },
    },
  });
  if (state.expandedPanel) resizeChartsIn(state.expandedPanel);
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
  const selected = new Set((state.filterGroups || []).filter((id) => id === "income" || id === "expense"));
  const basketOn = !!state.includeBasket;
  $("filters").innerHTML = l1Nodes().map((g) => {
    const on = selected.has(g.id);
    if (g.id === "expense") {
      return `<div class="chip-wrap l1-expense ${on ? "active" : ""} ${basketOn ? "basket-on" : ""}">
        <button type="button" class="basket-orb" role="switch" aria-checked="${basketOn}"
          title="Корзина ${limit} тыс. — повседневные расходы внутри фильтра «Расходы»"
          aria-label="Корзина ${limit} тыс.">
          <span class="basket-orb-label">${limit}</span>
          <span class="basket-orb-check" aria-hidden="true">✓</span>
        </button>
        <button type="button" class="chip l1-expense ${on ? "active" : ""}" data-g="expense" aria-pressed="${on}">Расходы</button>
      </div>`;
    }
    return `<button type="button" class="chip l1-${g.id} ${on ? "active" : ""}" data-g="${g.id}" aria-pressed="${on}">${g.label}</button>`;
  }).join("");

  const orb = $("filters").querySelector(".basket-orb");
  if (orb) {
    orb.addEventListener("click", (e) => {
      e.stopPropagation();
      state.includeBasket = !state.includeBasket;
      if (sliceFocus() === "expense") {
        const allowed = new Set(groupCats());
        state.selectedCats = state.selectedCats.filter((c) => allowed.has(c));
      }
      renderFilters();
      paintSlice();
    });
  }

  $("filters").querySelectorAll(".chip[data-g]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.g;
      const cur = new Set((state.filterGroups || []).filter((x) => x === "income" || x === "expense"));
      if (cur.has(id) && cur.size > 1) {
        cur.clear();
        cur.add(id);
      } else if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      state.filterGroups = [...cur];
      if (sliceFocus() === "all" || sliceFocus() === "none") state.selectedCats = [];
      else {
        const allowed = new Set(groupCats());
        state.selectedCats = state.selectedCats.filter((c) => allowed.has(c));
      }
      renderFilters();
      paintSlice();
    });
  });
  renderFilterNest();
}

function renderFilterNest() {
  const nest = $("filter-nest");
  if (!nest) return;
  const focus = sliceFocus();
  const nodes = selectedGroupNodes();
  if (focus === "all" || !nodes.length) {
    nest.classList.add("hidden");
    nest.innerHTML = "";
    nest.removeAttribute("data-tone");
    return;
  }

  nest.classList.remove("hidden");
  const tone = nodes[0].tone || "gold";
  nest.dataset.tone = tone;
  const limit = state.analytics ? Math.round(state.analytics.basket_limit / 1000) : 230;

  const blocks = [];
  const seenBlock = new Set();
  nodes.forEach((node) => {
    const children = (node.children || [])
      .filter((child) => !(focus === "expense" && child.id === "basket" && !state.includeBasket))
      .map((child) => ({
        ...child,
        label: child.id === "basket" ? `Корзина ${limit}` : child.label,
        categories: (child.categories || []).filter(catHasYearData),
      }))
      .filter((child) => child.categories.length);
    if (children.length) {
      children.forEach((child) => {
        if (seenBlock.has(child.id)) return;
        seenBlock.add(child.id);
        blocks.push({
          id: child.id,
          label: child.label,
          categories: child.categories,
          parentId: node.id,
        });
      });
    } else {
      if (seenBlock.has(node.id)) return;
      seenBlock.add(node.id);
      const raw = focus === "expense" ? visibleExpenseCats() : (node.categories || []);
      const cats = raw.filter(catHasYearData);
      if (!cats.length) return;
      blocks.push({
        id: node.id,
        label: node.label,
        categories: cats,
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

function formatSliceNetTooltip(v) {
  if (v == null || Number.isNaN(Number(v))) return "";
  const n = Number(v);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.round(Math.abs(n)).toLocaleString("ru-RU")} тыс.`;
}

function sliceResultLabel(showFcf) {
  return showFcf ? "FCF" : "Итог";
}

function fcfOverlayDatasets(netF, netP, prefix) {
  const gold = factColor();
  const hole = cssVar("--bg") || "#0b0c10";
  const mark = {
    type: "line",
    tension: 0.25,
    pointRadius: 3.2,
    pointHoverRadius: 5,
    pointStyle: "circle",
    spanGaps: false,
    fill: false,
  };
  return [
    {
      ...mark,
      label: `${prefix} факт`,
      data: netF,
      borderColor: gold,
      backgroundColor: gold,
      borderWidth: 2.4,
      pointBackgroundColor: gold,
      pointBorderColor: gold,
      pointBorderWidth: 0,
      order: 0,
    },
    {
      ...mark,
      label: `${prefix} план`,
      data: netP,
      borderColor: gold,
      backgroundColor: "transparent",
      borderDash: [5, 4],
      borderWidth: 1.7,
      pointBackgroundColor: hole,
      pointBorderColor: gold,
      pointBorderWidth: 1.7,
      order: 1,
    },
  ];
}

function hideSliceLegend() {
  const el = $("slice-legend");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
  el.classList.remove("only-income", "only-expense");
}

function renderSliceLegend(incomeItems, expenseItems, titles = {}) {
  const el = $("slice-legend");
  if (!el) return;
  if (!incomeItems.length && !expenseItems.length) {
    hideSliceLegend();
    return;
  }
  const itemHtml = (it) =>
    `<span class="slice-legend-item"><i class="slice-legend-swatch" style="background:${it.color}"></i>${escapeHtml(it.label)}</span>`;
  const col = (kind, items, title) => {
    const head = title ? `<div class="slice-legend-title">${escapeHtml(title)}</div>` : "";
    return `<div class="slice-legend-col ${kind}">${head}<div class="slice-legend-items">${items.map(itemHtml).join("")}</div></div>`;
  };
  el.hidden = false;
  el.classList.toggle("only-income", expenseItems.length === 0);
  el.classList.toggle("only-expense", incomeItems.length === 0);
  el.innerHTML =
    col("income", incomeItems, titles.income || "") +
    `<div class="slice-legend-rule" aria-hidden="true"></div>` +
    col("expense", expenseItems, titles.expense || "");
}

function paintSlice() {
  const an = state.analytics;
  if (!an) return;
  themeCharts();
  const byCat = Object.fromEntries((an.monthly || []).map((r) => [r.category, r]));
  const factUntil = factMonthCount(an);
  const sage = cssVar("--sage") || "#8fbea8";
  const rose = cssVar("--rose") || "#d9897a";
  const roseLite = roseSoft();
  const muted = cssVar("--muted");
  const indices = Array.from({ length: 12 }, (_, i) => i);
  const labels = MONTHS.map((m) => m.slice(0, 3));
  const flags = sliceFlags();
  const focus = sliceFocus();
  const overview = focus === "all";
  const showFcf = flags.income && (flags.expense || flags.basket);
  const incAll = incomeCats();
  const incSet = new Set(incAll);
  const nowMark = nowLineForLabels(labels, Number(an.year) || 2026);
  const slicePlugins = [fcfZeroLinePlugin, fcfCrosshairPlugin, nowLinePlugin, basketLimitPlugin];
  const limit = Math.round((an.basket_limit || 230000) / 1000);

  const sumFact = (cats, i) =>
    i < factUntil ? cats.reduce((s, c) => s + ((byCat[c] && byCat[c].fact[i]) || 0), 0) / 1000 : null;
  const sumPlan = (cats, i) =>
    cats.reduce((s, c) => s + ((byCat[c] && byCat[c].plan[i]) || 0), 0) / 1000;

  const flowFrom = (incList, expList) => {
    const incF = indices.map((i) => sumFact(incList, i));
    const expF = indices.map((i) => {
      const v = sumFact(expList, i);
      return v == null ? null : -Math.abs(v);
    });
    const incP = indices.map((i) => sumPlan(incList, i));
    const expP = indices.map((i) => -Math.abs(sumPlan(expList, i)));
    const netF = indices.map((i) => {
      if (incF[i] == null && expF[i] == null) return null;
      return (incF[i] || 0) + (expF[i] || 0);
    });
    const netP = indices.map((i) => (incP[i] || 0) + (expP[i] || 0));
    return { incF, expF, incP, expP, netF, netP };
  };

  const nestCats = (focus === "income" || focus === "expense") ? activeCats() : [];
  const pick = (list) => {
    const filtered = (list || []).filter(catHasYearData);
    if (!nestCats.length) return filtered;
    const allow = new Set(nestCats);
    return filtered.filter((c) => allow.has(c));
  };

  const inc = flags.income ? pick(incAll) : [];
  const basketList = flags.basket ? pick(basketCats()) : [];
  const largeList = flags.expense ? pick(largeCats()) : [];
  const exp = [...basketList, ...largeList];
  const flow = flowFrom(inc, exp);
  const resultName = sliceResultLabel(overview || showFcf);

  const basketF = indices.map((i) => {
    const v = sumFact(basketList, i);
    return v == null ? null : -Math.abs(v);
  });
  const largeF = indices.map((i) => {
    const v = sumFact(largeList, i);
    return v == null ? null : -Math.abs(v);
  });
  const largeFloatF = indices.map((i) => {
    if (largeF[i] == null && basketF[i] == null) return null;
    const from = basketF[i] || 0;
    return [from, from + (largeF[i] || 0)];
  });

  const barValue = (raw, parsedY) => {
    if (Array.isArray(raw) && raw.length >= 2) return Number(raw[1] || 0) - Number(raw[0] || 0);
    if (parsedY && typeof parsedY === "object") {
      return Number(parsedY.end ?? parsedY.y ?? 0) - Number(parsedY.start ?? parsedY.base ?? 0);
    }
    return parsedY;
  };

  const sliceTooltip = () => ({
    enabled: true,
    filter: (item) => item.raw != null,
    callbacks: {
      label: (ctx) => {
        const v = barValue(ctx.raw, ctx.parsed && ctx.parsed.y);
        if (v == null) return null;
        const lab = ctx.dataset.label || "";
        if (lab.startsWith("FCF") || lab.startsWith("Итог")) {
          return `${lab}: ${formatSliceNetTooltip(v)}`;
        }
        return `${lab}: ${Number(v).toFixed(0)}`;
      },
    },
  });

  const overviewLegendLabels = {
    boxWidth: 10,
    font: { size: 10 },
    generateLabels(chart) {
      const gen = Chart.defaults.plugins.legend.labels.generateLabels;
      const items = gen.call(Chart.defaults.plugins.legend.labels, chart);
      const hasExpFact = items.some((it) => it.text === "Расходы факт");
      const out = [];
      items.forEach((it) => {
        const t = String(it.text || "");
        if (t.startsWith("Корзина") && t.includes("факт")) {
          if (!hasExpFact) out.push({ ...it, text: "Расходы факт" });
          return;
        }
        if (t.startsWith("Корзина") || t === `План ${limit}`) return;
        out.push(it);
      });
      return out;
    },
  };

  const flowChartOpts = (extra = {}) => ({
    maintainAspectRatio: false,
    interaction: extra.interaction || { mode: "index", intersect: false },
    layout: { padding: { right: extra.basketLimit != null ? 28 : 8 } },
    plugins: {
      legend: extra.hideLegend
        ? { display: false }
        : legendOpts({ labels: extra.legendLabels || { boxWidth: 10, font: { size: 10 }, filter: extra.legendFilter } }),
      tooltip: extra.tooltip || sliceTooltip(),
      nowLine: nowMark.index >= 0 ? { index: nowMark.index, label: nowMark.label } : { index: -1 },
      basketLimit: extra.basketLimit != null
        ? { value: extra.basketLimit, label: extra.basketLimitLabel || String(Math.abs(extra.basketLimit)) }
        : false,
    },
    scales: {
      ...scaleOpts(),
      x: {
        ...scaleOpts().x,
        ...xAxisMonthQuarter(labels),
        stacked: !!extra.stacked,
        offset: true,
      },
      y: {
        ...scaleOpts().y,
        stacked: !!extra.stacked,
        suggestedMin: extra.basketLimit != null ? extra.basketLimit : undefined,
        title: { display: true, text: "тыс. ₽", color: muted },
        grid: {
          color: (ctx) => (ctx.tick && ctx.tick.value === 0
            ? (currentTheme() === "light" ? "rgba(28,25,21,0.22)" : "rgba(239,232,220,0.18)")
            : (currentTheme() === "light" ? "rgba(28,25,21,0.08)" : "rgba(239,232,220,0.05)")),
        },
      },
    },
  });

  const barDs = (label, data, color, extra = {}) => ({
    type: "bar",
    label,
    data,
    backgroundColor: hexFade(color, extra.alpha != null ? extra.alpha : 0.72),
    hoverBackgroundColor: color,
    borderRadius: extra.radius != null ? extra.radius : 4,
    grouped: false,
    categoryPercentage: 0.58,
    barPercentage: 0.92,
    order: extra.order != null ? extra.order : 3,
    stack: extra.stack,
  });
  const planDs = (label, data, color) => ({
    type: "line",
    label,
    data,
    borderColor: color,
    backgroundColor: "transparent",
    borderDash: [5, 4],
    tension: 0.25,
    borderWidth: 1.8,
    pointRadius: 0,
    pointHoverRadius: 4,
    order: 2,
  });

  if (!sliceHasData()) {
    hideSliceLegend();
    paintChart("chart-slice", {
      type: "bar",
      plugins: slicePlugins,
      data: { labels, datasets: [] },
      options: flowChartOpts(),
    });
    return;
  }

  const paintFlowOverview = () => {
    hideSliceLegend();
    const datasets = [];
    if (flags.income) {
      datasets.push(barDs("Доходы факт", flow.incF, sage));
      datasets.push(planDs("План доходов", flow.incP, sage));
    }
    if (flags.basket) {
      datasets.push(barDs(`Корзина ${limit} факт`, basketF, roseLite, { alpha: 0.88, order: 4 }));
    }
    if (flags.expense) {
      datasets.push(barDs("Расходы факт", flags.basket ? largeFloatF : largeF, rose, { order: 5 }));
      datasets.push(planDs("План расходов", flow.expP, rose));
    } else if (flags.basket) {
      datasets.push(planDs(`План ${limit}`, indices.map((i) => -Math.abs(sumPlan(basketList, i))), roseLite));
    }
    if (showFcf) datasets.push(...fcfOverlayDatasets(flow.netF, flow.netP, resultName));
    paintChart("chart-slice", {
      type: "bar",
      plugins: slicePlugins,
      data: { labels, datasets },
      options: flowChartOpts({
        legendLabels: overviewLegendLabels,
        basketLimit: flags.basket ? -limit : null,
        basketLimitLabel: String(limit),
      }),
    });
  };

  if (!state.sliceDetail) {
    paintFlowOverview();
    return;
  }

  const cats = overview ? [] : activeCats();
  const detailCats = (overview || focus === "none" ? [...inc, ...exp] : cats).filter(catHasFact);
  const datasets = [];
  const incomePart = detailCats.filter((c) => incSet.has(c));
  const expensePart = detailCats.filter((c) => !incSet.has(c));
  const incomeLegend = [];
  const expenseLegend = [];
  incomePart.forEach((c, idx) => {
    const color = DETAIL_PALETTE[idx % DETAIL_PALETTE.length];
    incomeLegend.push({ label: c, color });
    datasets.push({
      label: c,
      cat: c,
      kind: "income",
      data: indices.map((i) => (i < factUntil ? ((byCat[c] && byCat[c].fact[i]) || 0) / 1000 : null)),
      backgroundColor: color,
      borderRadius: idx === incomePart.length - 1 ? 4 : 0,
      stack: "income",
      order: 3,
    });
  });
  expensePart.forEach((c, idx) => {
    const color = DETAIL_PALETTE[(idx + 4) % DETAIL_PALETTE.length];
    expenseLegend.push({ label: c, color });
    datasets.push({
      label: c,
      cat: c,
      kind: "expense",
      data: indices.map((i) => {
        if (i >= factUntil) return null;
        const v = ((byCat[c] && byCat[c].fact[i]) || 0) / 1000;
        return -Math.abs(v);
      }),
      backgroundColor: color,
      borderRadius: idx === expensePart.length - 1 ? 4 : 0,
      stack: "expense",
      order: 3,
    });
  });
  if (!datasets.length) {
    paintFlowOverview();
    return;
  }
  renderSliceLegend(incomeLegend, expenseLegend, {
    income: flags.income && incomeLegend.length ? "Доходы" : "",
    expense: flags.expense && expenseLegend.length ? "Расходы" : "",
  });
  if (focus === "income") datasets.push({ ...planDs("План доходов", flow.incP, sage), pointHitRadius: 0 });
  else if (focus === "expense") datasets.push({ ...planDs("План расходов", flow.expP, rose), pointHitRadius: 0 });
  else if (focus === "none" && flags.basket) {
    datasets.push({ ...planDs(`План ${limit}`, indices.map((i) => -Math.abs(sumPlan(basketList, i))), roseLite), pointHitRadius: 0 });
  } else if (showFcf) {
    fcfOverlayDatasets(flow.netF, flow.netP, resultName).forEach((ds) => {
      datasets.push({ ...ds, pointHitRadius: 0, pointHoverRadius: 0 });
    });
  }
  paintChart("chart-slice", {
    type: "bar",
    plugins: [fcfZeroLinePlugin, nowLinePlugin, basketLimitPlugin],
    data: { labels, datasets },
    options: flowChartOpts({
      stacked: true,
      hideLegend: true,
      basketLimit: flags.basket ? -limit : null,
      basketLimitLabel: String(limit),
      interaction: chartInteraction(),
      tooltip: {
        enabled: true,
        mode: "nearest",
        intersect: true,
        displayColors: false,
        filter: (item) => {
          const ds = item.dataset || (item.chart && item.chart.data && item.chart.data.datasets[item.datasetIndex]);
          return !!(ds && ds.cat && item.raw != null && Math.abs(Number(item.raw)) > 0.05);
        },
        callbacks: {
          title: (items) => {
            const ctx = items && items[0];
            if (!ctx) return "";
            const month = MONTHS[ctx.dataIndex] || "";
            return `${ctx.dataset.label}${month ? " · " + month : ""}`;
          },
          label: (ctx) => {
            const cat = ctx.dataset.cat;
            const factAbs = Math.abs(Number(ctx.parsed && ctx.parsed.y) || 0);
            const planAbs = ((byCat[cat] && byCat[cat].plan[ctx.dataIndex]) || 0) / 1000;
            const lines = [
              `Факт: ${Math.round(factAbs).toLocaleString("ru-RU")} тыс.`,
              `План: ${Math.round(planAbs).toLocaleString("ru-RU")} тыс.`,
            ];
            if (planAbs > 0.5) {
              const pct = ((factAbs - planAbs) / planAbs) * 100;
              if (Math.abs(pct) >= 0.5) {
                const sign = pct > 0 ? "+" : "−";
                lines.push(`к плану ${sign}${Math.abs(pct).toFixed(0)}%`);
              }
            }
            return lines;
          },
          footer: (items) => {
            const ctx = items && items[0];
            if (!ctx || !ctx.dataset.cat) return [];
            return sliceCellComments(byCat[ctx.dataset.cat], ctx.dataIndex);
          },
        },
        footerColor: muted,
        footerFont: { size: 10, weight: "normal", lineHeight: 1.35 },
        footerAlign: "left",
        footerMarginTop: 8,
      },
    }),
  });
}
function bindShareControls() {
  if (state.shareBound) return;
  state.shareBound = true;
  const drivers = $("show-drivers");
  if (drivers) {
    drivers.addEventListener("change", () => {
      state.showDrivers = drivers.checked;
      paintShare();
    });
  }
}

function monthYearFromLabel(lab) {
  const s = String(lab);
  if (s.includes(".")) {
    const parts = s.split(".");
    return { month: Number(parts[0]), year: Number(parts[1]) };
  }
  return { month: 12, year: Number(s) };
}

function keepTimelineIndexes(tl, from, to, unit = "year") {
  const labels = tl.labels || (tl.years || []).map(String);
  const keep = [];
  labels.forEach((lab, i) => {
    const { month, year } = monthYearFromLabel(lab);
    if (unit === "quarter") {
      const q = fcfQuarterIndex(year, Math.floor((Math.max(1, month) - 1) / 3));
      if (q >= from && q <= to) keep.push(i);
    } else if (year >= from && year <= to) {
      keep.push(i);
    }
  });
  return { labels, keep };
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

const ASSET_COLORS = {
  cash: "#d4b483",
  masha: "#6ec4c8",
  sasha: "#8fbea8",
  sasha_invest: "#d4a017",
  gold: "#8aa4c7",
  spb: "#d9897a",
  parking: "#c4a574",
  phuket: "#5aadb2",
};

function assetColor(i, id) {
  if (id && ASSET_COLORS[id]) return ASSET_COLORS[id];
  return DETAIL_PALETTE[i % DETAIL_PALETTE.length];
}

function paintShare() {
  const data = state.share;
  if (!data) return;
  const tl = data.timeline;
  themeCharts();
  bindChartExpands();

  if (tl) {
    const k = tl.kpis || {};
    $("share-hero-kpis").innerHTML = [
      `<div class="chip-kpi"><b>${mln(k.now || 0)}</b><span>Сейчас</span></div>`,
      `<div class="chip-kpi"><b>${mln(k.forecast_2040 != null ? k.forecast_2040 : k.forecast_2030 || 0)}</b><span>Прогноз к 2040</span></div>`,
      `<div class="chip-kpi"><b>${(k.delta_pct >= 0 ? "+" : "") + (k.delta_pct || 0)}%</b><span>+ к 2040</span></div>`,
    ].join("");

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
  }

  if (tl) {
    bindTimeline("asset");
    const hover = $("asset-hover");
    if (hover) hover.hidden = true;
    const { from, to } = clampTimelineRange("asset");
    const { labels: allLabels, keep } = keepTimelineIndexes(tl, from, to, "quarter");
    const labels = keep.map((i) => allLabels[i]);
    const nowMark = nowLineForLabels(allLabels);
    let nowFull = nowMark.index;
    if (nowFull < 0 && Number.isFinite(tl.now_index)) nowFull = tl.now_index;
    const nowIdx = keep.indexOf(nowFull);
    const nowLabel = nowMark.index >= 0
      ? nowMark.label
      : `${MONTHS[(Number(tl.now_month) || 8) - 1].slice(0, 3).toLowerCase()} ${String(tl.now_year || 2026).slice(2)}`;
    if ($("show-drivers")) $("show-drivers").checked = state.showDrivers;

    const datasets = (tl.assets || []).map((a, i) => {
      const color = assetColor(i, a.id);
      const series = keep.map((idx) => {
        const v = a.series[idx];
        return v == null ? null : v / 1e6;
      });
      return {
        label: a.label,
        data: series,
        borderColor: color,
        backgroundColor: "transparent",
        fill: false,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: false,
        segment: {
          borderDash: (ctx) => {
            const orig = keep[ctx.p1DataIndex];
            return orig > nowFull ? [6, 4] : undefined;
          },
        },
      };
    });

    paintChart("chart-assets", {
      type: "line",
      plugins: [fcfCrosshairPlugin, nowLinePlugin],
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false,
        animation: { duration: 180 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: legendOpts(),
          tooltip: {
            enabled: false,
            external: (ctx) => renderAssetHover(ctx, { labels, keep, nowFull, datasets }),
          },
          fcfCrosshair: { yMode: "sum" },
          nowLine: nowIdx >= 0 ? { index: nowIdx, label: nowLabel } : { index: -1 },
        },
        scales: {
          ...scaleOpts(),
          y: {
            ...scaleOpts().y,
            stacked: false,
            title: { display: true, text: "млн ₽", color: cssVar("--muted") },
          },
          x: {
            ...scaleOpts().x,
            ...xAxisMonthQuarter(labels),
          },
        },
      },
    });

    const wrap = $("drivers-wrap");
    if (wrap) wrap.classList.toggle("hidden", !state.showDrivers);
    if (state.showDrivers && tl.drivers) {
      const driverKeys = [
        { id: "usd", label: "Доллар, ₽", axis: "y" },
        { id: "thb", label: "Бат, ₽", axis: "y" },
        { id: "gold", label: "Золото, тыс.₽/г", axis: "y1", scale: 1000 },
      ];
      paintChart("chart-drivers", {
        type: "line",
        plugins: [nowLinePlugin],
        data: {
          labels,
          datasets: driverKeys.map((d, i) => {
            const series = (tl.drivers[d.id] || {}).series || [];
            const scale = d.scale || 1;
            return {
              label: d.label,
              data: keep.map((idx) => {
                const raw = series[idx];
                return raw == null ? null : raw / scale;
              }),
              borderColor: DETAIL_PALETTE[i],
              backgroundColor: "transparent",
              tension: 0.25,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              yAxisID: d.axis,
              segment: {
                borderDash: (ctx) => (keep[ctx.p1DataIndex] > nowFull ? [6, 4] : undefined),
              },
            };
          }),
        },
        options: {
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: legendOpts({ labels: { boxWidth: 8, font: { size: 10 } } }),
            tooltip: {
              enabled: true,
              filter: (item) => item.raw != null,
              callbacks: {
                title: (items) => items[0] ? fcfMonthTitle(items[0].label) : "",
                label: (ctx) => {
                  const v = Number(ctx.raw);
                  if (ctx.dataset.yAxisID === "y1") return `${ctx.dataset.label}: ${v.toFixed(2)}`;
                  return `${ctx.dataset.label}: ${v.toFixed(3)}`;
                },
              },
            },
            nowLine: nowIdx >= 0 ? { index: nowIdx, label: nowLabel } : { index: -1 },
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
            x: {
              ...scaleOpts().x,
              ticks: {
                autoSkip: true,
                maxTicksLimit: 12,
                maxRotation: 0,
              },
            },
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
    .map((a, i) => ({ id: a.id, label: a.label, value: cur[a.id] || 0, color: assetColor(i, a.id) }))
    .filter((x) => x.value > 0 && x.id !== "phuket");
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
      `<div class="share-row"><span>Накопления Саша</span><b>${money(liq.sasha || 0)}</b></div>` +
      `<div class="share-row"><span>Саша инвестиции · ОФЗ${liq.ofz_ytm ? ` · ${(Number(liq.ofz_ytm) * 100).toFixed(1)}%` : ""}</span><b>${money(liq.sasha_invest || 0)}</b></div>`;
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

function ledgerRowData(ledger) {
  const src = ledger || state.ledger;
  if (!src) return [];
  return [...(src.income || []), ...(src.expense || [])].map((r) => {
    const row = {
      category: r.category,
      kind: r.kind,
      sources: Array.isArray(r.source) ? r.source.slice() : [],
    };
    (r.fact || []).forEach((v, i) => {
      row["m" + (i + 1)] = v;
    });
    return row;
  });
}

function monthField(i) {
  return "m" + (i + 1);
}

function eventKey(year, month, category) {
  return `${year}-${month}-${category || ""}`;
}

function visibleEvents() {
  return (state.keyEvents || []).filter((e) => !e.suppressed && e.title);
}

function eventForCell(category, month, year) {
  const y = year || (state.ledger && state.ledger.year) || 2026;
  return visibleEvents().find((e) =>
    Number(e.year) === y && Number(e.month) === month && (e.category || "") === (category || "")
  ) || null;
}

function hasUnsavedLedger() {
  return Object.keys(state.ledgerDirty || {}).length > 0 || state.eventsDirty;
}

function hydrateEvents(ledger, analytics) {
  const fromAn = (analytics && analytics.key_events) || [];
  const fromLed = (ledger && ledger.key_events) || [];
  state.keyEvents = (fromAn.length ? fromAn : fromLed).map((e) => ({ ...e }));
  state.ledgerDirty = {};
  state.eventsDirty = false;
}

function markLedgerDirty() {
  syncLedgerSaveBtn();
}

function syncLedgerSaveBtn() {
  const btn = $("btn-ledger-save");
  if (!btn) return;
  const dirty = hasUnsavedLedger();
  btn.disabled = !dirty;
  btn.classList.toggle("on", dirty);
  btn.title = isLocalApi()
    ? (dirty ? "Записать в тот же Excel и обновить графики" : "Нет несохранённых правок")
    : "Сохранение в Excel доступно на домашнем сервере";
}

function ledgerMonthCol(i) {
  return {
    field: monthField(i),
    headerName: MONTHS[i].slice(0, 3),
    headerTooltip: MONTHS[i],
    minWidth: ledgerCompact() ? 104 : 108,
    width: ledgerCompact() ? 104 : 108,
    flex: ledgerCompact() ? 0 : 1,
    suppressSizeToFit: ledgerCompact(),
    editable: true,
    type: "numericColumn",
    valueFormatter: (p) => (p.value == null || p.value === "" ? "" : Math.round(Number(p.value)).toLocaleString("ru-RU")),
    valueParser: (p) => parseMoneyInput(p.newValue, Number(p.oldValue) || 0),
    cellClass: "num",
    cellClassRules: {
      "cell-forecast": (p) => (p.data && p.data.sources && p.data.sources[i]) === "forecast",
      "cell-partial": (p) => (p.data && p.data.sources && p.data.sources[i]) === "partial",
      "cell-manual": (p) => (p.data && p.data.sources && p.data.sources[i]) === "manual",
      "cell-event": (p) => !!eventForCell(p.data && p.data.category, i + 1),
    },
    cellRenderer: (p) => {
      const wrap = document.createElement("div");
      wrap.className = "ledger-cell";
      const val = document.createElement("span");
      val.className = "ledger-cell-val";
      val.textContent = p.value == null || p.value === "" ? "" : Math.round(Number(p.value)).toLocaleString("ru-RU");
      wrap.appendChild(val);
      const ev = eventForCell(p.data && p.data.category, i + 1);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "ledger-star" + (ev ? " on" : "");
      star.title = ev ? ev.title : "Сделать ключевым событием";
      star.setAttribute("aria-label", star.title);
      star.textContent = ev ? "★" : "☆";
      star.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openEventEditor(p.data.category, i + 1, ev);
      });
      wrap.appendChild(star);
      return wrap;
    },
  };
}

function onLedgerCellChanged(e) {
  if (ledgerGridQuiet || !e.data) return;
  if (e.oldValue === e.newValue) return;
  if (Number(e.oldValue) === Number(e.newValue)) return;
  const field = e.colDef.field || "";
  if (!/^m\d+$/.test(field)) return;
  const month = Number(field.slice(1));
  const value = parseMoneyInput(e.newValue, Number(e.oldValue) || 0);
  const key = `${e.data.category}::${month}`;
  state.ledgerDirty[key] = { category: e.data.category, month, value };
  if (e.data.sources) e.data.sources[month - 1] = "manual";
  const pack = [...(state.ledger.income || []), ...(state.ledger.expense || [])]
    .find((r) => r.category === e.data.category);
  if (pack && Array.isArray(pack.fact)) pack.fact[month - 1] = value;
  setStatus("Есть несохранённые правки");
  markLedgerDirty();
}

function renderEventsStrip() {
  const box = $("events-strip");
  if (!box) return;
  const list = visibleEvents().slice().sort((a, b) => (a.year - b.year) || (a.month - b.month));
  if (!list.length) {
    box.innerHTML = "<span class='hint'>Пока нет ключевых событий — нажмите звезду на ячейке.</span>";
    return;
  }
  box.innerHTML = list.map((e, idx) => {
    const when = `${MONTHS_SHORT[(e.month || 1) - 1]} ${String(e.year).slice(2)}`;
    const cat = e.category ? ` · ${e.category}` : "";
    return `<button type="button" class="event-chip" data-idx="${idx}" title="${escapeHtml((e.title || "") + cat)}"><span class="event-chip-when">${escapeHtml(when)}</span><span class="event-chip-title">${escapeHtml(e.title || "")}</span></button>`;
  }).join("");
  box.querySelectorAll(".event-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const e = list[Number(btn.dataset.idx)];
      if (e) openEventEditor(e.category || "", Number(e.month), e, Number(e.year));
    });
  });
}

let eventEdit = null;

function bindEventPop() {
  const pop = $("event-pop");
  if (!pop || pop.dataset.bound) return;
  pop.dataset.bound = "1";
  $("event-pop-save").addEventListener("click", () => {
    const title = ($("event-pop-title").value || "").trim();
    if (!eventEdit) return closeEventPop();
    if (!title) {
      setStatus("Введите название события или уберите метку");
      return;
    }
    upsertLocalEvent(eventEdit, title, false);
    closeEventPop();
  });
  $("event-pop-del").addEventListener("click", () => {
    if (!eventEdit) return closeEventPop();
    upsertLocalEvent(eventEdit, "", true);
    closeEventPop();
  });
  $("event-pop-cancel").addEventListener("click", closeEventPop);
  document.addEventListener("mousedown", (e) => {
    const box = $("event-pop");
    if (!box || box.hidden) return;
    if (box.contains(e.target) || e.target.closest(".ledger-star") || e.target.closest(".events-strip .event-chip")) return;
    closeEventPop();
  });
}

function openEventEditor(category, month, ev, year) {
  const y = year || (state.ledger && state.ledger.year) || 2026;
  eventEdit = { category: category || "", month, year: y, auto_key: ev && ev.auto_key };
  const pop = $("event-pop");
  if (!pop) return;
  $("event-pop-meta").textContent = `${category || "месяц"} · ${MONTHS[month - 1]} ${y}`;
  $("event-pop-title").value = ev && ev.title ? ev.title : "";
  pop.hidden = false;
  pop.classList.remove("hidden");
  $("event-pop-title").focus();
}

function closeEventPop() {
  const pop = $("event-pop");
  if (pop) {
    pop.hidden = true;
    pop.classList.add("hidden");
  }
  eventEdit = null;
}

function upsertLocalEvent(edit, title, remove) {
  const year = edit.year;
  const month = edit.month;
  const category = edit.category || "";
  const autoKey = edit.auto_key || "";
  let found = (state.keyEvents || []).find((e) => {
    if (autoKey && e.auto_key === autoKey) return true;
    return Number(e.year) === year && Number(e.month) === month && (e.category || "") === category && !e.suppressed;
  });
  if (remove) {
    if (found && found.auto_key) {
      found.suppressed = 1;
      found.title = found.title || title;
    } else if (found) {
      state.keyEvents = state.keyEvents.filter((e) => e !== found);
    }
  } else if (found) {
    found.title = title;
    found.suppressed = 0;
    found.category = category;
    found.month = month;
    found.year = year;
  } else {
    state.keyEvents = state.keyEvents || [];
    state.keyEvents.push({
      year, month, category, title,
      source: autoKey ? "auto" : "manual",
      auto_key: autoKey,
      suppressed: 0,
    });
  }
  state.eventsDirty = true;
  markLedgerDirty();
  renderEventsStrip();
  if (ledgerGridApi) ledgerGridApi.refreshCells({ force: true });
  if (state.analytics) paintCumul();
  setStatus("Есть несохранённые правки");
}

function bindLedgerSave() {
  const btn = $("btn-ledger-save");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", commitLedger);
}

async function commitLedger() {
  const btn = $("btn-ledger-save");
  if (ledgerGridApi && typeof ledgerGridApi.stopEditing === "function") ledgerGridApi.stopEditing();
  if (!isLocalApi()) {
    setStatus("Сохранение в Excel доступно на домашнем сервере.");
    return;
  }
  const cells = Object.values(state.ledgerDirty || {});
  const events = (state.keyEvents || []).map((e) => ({
    year: Number(e.year) || 2026,
    month: Number(e.month),
    category: e.category || "",
    title: e.title || "",
    source: e.source || "manual",
    auto_key: e.auto_key || "",
    suppressed: e.suppressed ? 1 : 0,
  }));
  if (!cells.length && !state.eventsDirty) return;
  if (btn) btn.disabled = true;
  setStatus("Записываю в Excel и обновляю графики…");
  try {
    const payload = {
      year: (state.ledger && state.ledger.year) || 2026,
      cells,
    };
    if (state.eventsDirty) payload.events = events;
    const res = await api("/api/ledger/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.ledgerDirty = {};
    state.eventsDirty = false;
    state.health = { ...(state.health || {}), ...res };
    paintStamp(state.health);
    state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    const an = await api("/api/analytics");
    state.analytics = an;
    hydrateEvents(state.ledger, an);
    renderLedger(state.ledger);
    renderEventsStrip();
    themeCharts();
    paintCumul();
    renderFilters();
    paintSlice();
    if (state.share) {
      try { await loadShare(); } catch {}
    }
    setStatus(`Сохранено в ${res.excel || "Excel"}. Графики обновлены.`);
    syncLedgerSaveBtn();
  } catch (err) {
    setStatus("Не записалось: " + (err.message || err));
    syncLedgerSaveBtn();
  }
}

function ensureLedgerGrid() {
  const el = $("ledger-wrap");
  if (!el) return null;
  syncAgTheme();
  if (!agGridAvailable()) {
    el.innerHTML = "<p class='hint'>Не загрузился AG Grid. Проверьте сеть и обновите страницу.</p>";
    return null;
  }
  if (ledgerGridApi) return ledgerGridApi;
  ledgerGridApi = agGrid.createGrid(el, {
    rowData: [],
    getRowId: (p) => p.data.category,
    rowHeight: 44,
    headerHeight: 36,
    singleClickEdit: true,
    stopEditingWhenCellsLoseFocus: true,
    enterNavigatesVertically: true,
    enterNavigatesVerticallyAfterEdit: true,
    animateRows: false,
    enableBrowserTooltips: true,
    popupParent: document.body,
    overlayNoRowsTemplate: "<span class='ag-overlay-msg'>Нет строк факта.</span>",
    alwaysShowHorizontalScroll: true,
    alwaysShowVerticalScroll: !ledgerCompact(),
    suppressColumnVirtualisation: ledgerCompact(),
    domLayout: ledgerCompact() ? "autoHeight" : "normal",
    defaultColDef: {
      sortable: true,
      resizable: true,
      filter: false,
      suppressHeaderMenuButton: true,
      suppressMenu: true,
    },
    getRowClass: (p) => {
      if (!p.data) return [];
      return p.data.kind === "income" ? ["ledger-in"] : ["ledger-out"];
    },
    onCellValueChanged: onLedgerCellChanged,
    onGridSizeChanged: (p) => ledgerFitIfWide(p.api),
    onFirstDataRendered: (p) => {
      applyLedgerGridLayout(p.api);
      ledgerFitIfWide(p.api);
    },
    columnDefs: [
      {
        field: "category",
        headerName: "Статья",
        pinned: "left",
        lockPinned: true,
        minWidth: ledgerCompact() ? 112 : 150,
        width: ledgerCompact() ? 120 : 180,
        flex: 0,
        suppressSizeToFit: true,
        editable: false,
        cellClass: (p) => (p.data && p.data.kind === "income" ? "ledger-cat-in" : "ledger-cat-out"),
      },
      ...MONTHS.map((_, i) => ledgerMonthCol(i)),
    ],
  });
  return ledgerGridApi;
}

function renderLedger(ledger) {
  const api = ensureLedgerGrid();
  if (!api) return;
  ledgerGridQuiet = true;
  api.setGridOption("rowData", ledgerRowData(ledger));
  ledgerGridQuiet = false;
  requestAnimationFrame(() => ledgerFitIfWide(api));
}

window.addEventListener("beforeunload", (e) => {
  if (!hasUnsavedLedger()) return;
  e.preventDefault();
  e.returnValue = "";
});

window.sashaBudgetReload = async function () {
  if (hasUnsavedLedger()) return;
  try {
    state.ledger = applyVoiceAddsToLedger(await api("/api/ledger"));
    if ($("ledger-wrap")) renderLedger(state.ledger);
  } catch {}
};

boot().catch((err) => { setStatus(err.message); });
