(function (global) {
  const CONFIG_URL = "https://mariasedovav.github.io/sasha-masha/cloud-config.json";
  const GIST_ID = "3ed81968af537a456e6586467e4a7a7a";
  const GIST_RAW = "https://gist.githubusercontent.com/MariaSedovaV/" + GIST_ID + "/raw/family-cloud.json";
  const GIST_API = "https://api.github.com/gists/" + GIST_ID;
  const LOCAL_CLOUD = "sasha-masha-cloud";
  const NOTES_KEY = "sasha-masha-notes";
  const BUDGET_KEY = "sasha-masha-budget-adds";
  const FAV_KEY = "sasha-masha-favorite-recipes";
  const PIN_KEY = "sasha-masha-weekly-ration";

  const listeners = [];
  let snapshot = empty();
  let storeUrl = "";
  let chain = Promise.resolve();
  let lastJson = "";
  let started = false;

  function empty() {
    return {
      notes: { sasha: [], masha: [] },
      budgetAdds: [],
      favorites: {},
      pinned: { id: null, at: 0 },
      rev: 0,
    };
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function stamp(item) {
    const t = Number(item?.updatedAt || item?.at || 0);
    return t;
  }

  function mergeItems(a, b) {
    const map = new Map();
    for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      if (!item || item.id == null) continue;
      const prev = map.get(String(item.id));
      if (!prev || stamp(item) >= stamp(prev)) map.set(String(item.id), item);
    }
    return [...map.values()].sort((x, y) => Number(x.at || 0) - Number(y.at || 0));
  }

  function mergeFavs(a, b) {
    const out = { ...(a || {}) };
    const src = b || {};
    for (const key of Object.keys(src)) {
      const cur = out[key];
      const next = src[key];
      if (!cur || Number(next?.at || 0) >= Number(cur?.at || 0)) out[key] = next;
    }
    return out;
  }

  function mergePinned(a, b) {
    const left = a || { id: null, at: 0 };
    const right = b || { id: null, at: 0 };
    return Number(right.at || 0) >= Number(left.at || 0) ? right : left;
  }

  function mergeState(a, b) {
    const left = a || empty();
    const right = b || empty();
    return {
      notes: {
        sasha: mergeItems(left.notes?.sasha, right.notes?.sasha),
        masha: mergeItems(left.notes?.masha, right.notes?.masha),
      },
      budgetAdds: mergeItems(left.budgetAdds, right.budgetAdds),
      favorites: mergeFavs(left.favorites, right.favorites),
      pinned: mergePinned(left.pinned, right.pinned),
      rev: Math.max(Number(left.rev || 0), Number(right.rev || 0)),
    };
  }

  function visibleNotes(list) {
    return (list || []).filter((t) => !t.deleted);
  }

  function favArray(map) {
    return Object.keys(map || {}).filter((k) => map[k] && map[k].on);
  }

  function fromLegacy() {
    const notes = readJson(NOTES_KEY, { sasha: [], masha: [] }) || { sasha: [], masha: [] };
    const budgetAdds = readJson(BUDGET_KEY, []) || [];
    const favList = readJson(FAV_KEY, []) || [];
    const pinRaw = localStorage.getItem(PIN_KEY);
    const favorites = {};
    if (Array.isArray(favList)) {
      favList.forEach((key) => { favorites[key] = { on: true, at: 1 }; });
    }
    return {
      notes: {
        sasha: Array.isArray(notes.sasha) ? notes.sasha : [],
        masha: Array.isArray(notes.masha) ? notes.masha : [],
      },
      budgetAdds: Array.isArray(budgetAdds) ? budgetAdds : [],
      favorites,
      pinned: { id: pinRaw ? Number(pinRaw) : null, at: pinRaw ? 1 : 0 },
      rev: 0,
    };
  }

  function persistLocal(state) {
    snapshot = clone(state);
    writeJson(LOCAL_CLOUD, snapshot);
    writeJson(NOTES_KEY, {
      sasha: visibleNotes(snapshot.notes.sasha),
      masha: visibleNotes(snapshot.notes.masha),
    });
    writeJson(BUDGET_KEY, snapshot.budgetAdds.filter((x) => !x.deleted));
    writeJson(FAV_KEY, favArray(snapshot.favorites));
    try {
      if (snapshot.pinned && snapshot.pinned.id) localStorage.setItem(PIN_KEY, String(snapshot.pinned.id));
      else localStorage.removeItem(PIN_KEY);
    } catch {}
  }

  function notify() {
    listeners.forEach((fn) => {
      try { fn(clone(snapshot)); } catch {}
    });
    try { if (typeof global.sashaNotesReload === "function") global.sashaNotesReload(); } catch {}
    try { if (typeof global.sashaBudgetReload === "function") global.sashaBudgetReload(); } catch {}
    try { if (typeof global.sashaPitanieReload === "function") global.sashaPitanieReload(); } catch {}
  }

  async function loadConfig() {
    storeUrl = GIST_RAW;
    try {
      const res = await fetch(CONFIG_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg && cfg.raw) storeUrl = cfg.raw;
      }
    } catch {}
    return true;
  }

  async function remoteGet() {
    const urls = [
      (storeUrl || GIST_RAW) + "?t=" + Date.now(),
      "https://mariasedovav.github.io/sasha-masha/family-cloud.json?t=" + Date.now(),
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!res.ok) continue;
        const text = await res.text();
        const data = JSON.parse(text);
        if (data && typeof data === "object") return data;
      } catch {}
    }
    return empty();
  }

  async function remotePut(state) {
    const encoded = JSON.stringify(state);
    const gistBody = JSON.stringify({
      files: { "family-cloud.json": { content: encoded } },
    });
    const gistRes = await fetch(GIST_API, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: gistBody,
    });
    if (gistRes.ok) return true;
    const dispatchRes = await fetch("https://api.github.com/repos/MariaSedovaV/sasha-masha/dispatches", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "family-cloud", client_payload: { snapshot: state } }),
    });
    if (dispatchRes.ok || dispatchRes.status === 204) return true;
    throw new Error("cloud-put " + gistRes.status);
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function core(state) {
    return JSON.stringify({
      notes: state?.notes || {},
      budgetAdds: state?.budgetAdds || [],
      favorites: state?.favorites || {},
      pinned: state?.pinned || {},
    });
  }

  async function pullMergePush(localExtra) {
    let local = mergeState(fromLegacy(), readJson(LOCAL_CLOUD, empty()));
    if (localExtra) local = mergeState(local, localExtra);
    persistLocal(local);

    if (!storeUrl) await loadConfig();
    if (!storeUrl) return snapshot;

    let remote = empty();
    try { remote = await remoteGet() || empty(); } catch { return snapshot; }

    let merged = mergeState(remote, local);
    persistLocal(merged);
    if (core(merged) === core(remote)) {
      lastJson = JSON.stringify(merged);
      return snapshot;
    }
    merged.rev = Number(merged.rev || 0) + 1;
    persistLocal(merged);
    try {
      await remotePut(merged);
      lastJson = JSON.stringify(merged);
      const check = await remoteGet();
      const again = mergeState(check, merged);
      if (core(again) !== core(merged)) {
        again.rev = Number(again.rev || 0) + 1;
        persistLocal(again);
        await remotePut(again);
        lastJson = JSON.stringify(again);
      }
    } catch {}
    return snapshot;
  }

  function start() {
    if (started) return;
    started = true;
    snapshot = mergeState(fromLegacy(), readJson(LOCAL_CLOUD, empty()));
    persistLocal(snapshot);
    enqueue(async () => {
      await pullMergePush();
      notify();
    });
    setInterval(() => {
      enqueue(async () => {
        const before = JSON.stringify(snapshot);
        await pullMergePush();
        if (JSON.stringify(snapshot) !== before) notify();
      });
    }, 4000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        enqueue(async () => {
          await pullMergePush();
          notify();
        });
      }
    });
    global.addEventListener("online", () => {
      enqueue(async () => {
        await pullMergePush();
        notify();
      });
    });
  }

  function applyPatch(mutator) {
    return enqueue(async () => {
      const next = clone(snapshot);
      mutator(next);
      persistLocal(next);
      notify();
      await pullMergePush(next);
      notify();
      return snapshot;
    });
  }

  global.SashaCloud = {
    start,
    snapshot() { return clone(snapshot); },
    subscribe(fn) { if (typeof fn === "function") listeners.push(fn); },
    setNotes(notes) {
      return applyPatch((s) => {
        s.notes = {
          sasha: mergeItems(s.notes.sasha, notes?.sasha),
          masha: mergeItems(s.notes.masha, notes?.masha),
        };
      });
    },
    replaceNotes(notes) {
      return applyPatch((s) => { s.notes = notes; });
    },
    setBudgetAdds(list) {
      return applyPatch((s) => { s.budgetAdds = mergeItems(s.budgetAdds, list); });
    },
    setFavorite(key, on) {
      return applyPatch((s) => {
        s.favorites[key] = { on: !!on, at: Date.now() };
      });
    },
    setFavoritesArray(arr) {
      return applyPatch((s) => {
        const now = Date.now();
        const set = new Set(arr || []);
        Object.keys(s.favorites).forEach((key) => {
          if (!set.has(key) && s.favorites[key]?.on) s.favorites[key] = { on: false, at: now };
        });
        set.forEach((key) => { s.favorites[key] = { on: true, at: now }; });
      });
    },
    setPinned(id) {
      return applyPatch((s) => {
        s.pinned = { id: id || null, at: Date.now() };
      });
    },
  };

  snapshot = mergeState(fromLegacy(), readJson(LOCAL_CLOUD, empty()));

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window);
