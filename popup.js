"use strict";

const $ = (id) => document.getElementById(id);

let currentUrl = "";
let pollTimer = null;
let openTarget = "";

function showMessage(text, kind) {
  const el = $("message");
  el.textContent = text;
  el.className = "message" + (kind ? " " + kind : "");
  el.hidden = !text;
}

function openExt(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

async function askBackground(msg) {
  try {
    const r = await chrome.runtime.sendMessage(Object.assign({ target: "background" }, msg));
    return r || { error: "No response from the extension." };
  } catch (e) {
    return { error: e.message };
  }
}

async function askOffscreen(msg) {
  try {
    return (await chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, msg))) || { state: "none" };
  } catch (e) {
    return { state: "none" };  // no active crawler module
  }
}

const isSavable = (url) => /^https?:\/\//i.test(url);

function setRunning(running) {
  $("start").hidden = running;
  $("cancel").hidden = !running;
  $("depth").disabled = running;
  $("max-pages").disabled = running;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }); }
  catch (e) { return iso || ""; }
}

async function loadRecent() {
  try {
    const saves = (await APSDB.getAll("saves"))
      .filter((s) => s.state === "done")
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""))
      .slice(0, 5);
    const ul = $("recent");
    ul.replaceChildren();
    $("recent-section").hidden = saves.length === 0;
    for (const s of saves) {
      let host = s.start_url;
      try { host = new URL(s.start_url).host; } catch (e) { /* keep the raw URL */ }
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.title = s.start_url;
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = s.title || host;
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = fmtDate(s.created) + " · " + ((s.stats && s.stats.pages) || 0) + " page(s)";
      a.append(t, m);
      a.addEventListener("click", () => openExt("viewer.html?s=" + encodeURIComponent(s.id) + "&p=p0"));
      li.appendChild(a);
      ul.appendChild(li);
    }
  } catch (e) { /* the list is optional */ }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderStatus(job) {
  const s = job.stats || {};

  if (job.state === "running") {
    setRunning(true);
    $("progress").hidden = false;
    $("result").hidden = true;
    const pct = Math.min(100, Math.round(((s.pages || 0) / job.max_pages) * 100));
    $("bar-fill").style.width = (job.phase === "resources" ? Math.max(pct, 90) : pct) + "%";
    const phase = job.phase === "resources" ? "Downloading resources and rewriting links" : "Crawling";
    $("progress-text").textContent =
      phase + " · " + (s.pages || 0) + "/" + job.max_pages + " pages · " + (s.resources || 0) + " resources";
    $("current-fetch").textContent = job.current || "";
    return;
  }

  stopPolling();
  setRunning(false);
  $("progress").hidden = true;
  $("result").hidden = false;
  $("open-save").hidden = true;

  if (job.state === "done") {
    $("result-text").textContent =
      "Done: " + s.pages + " page(s), " + s.resources + " resource(s). Skipped: " +
      s.skipped_robots + " (robots.txt), " + s.skipped_scope + " (out of scope). Errors: " + s.errors + ".";
    openTarget = "viewer.html?s=" + encodeURIComponent(job.saveId) + "&p=p0";
    $("open-save").hidden = false;
    loadRecent();
  } else if (job.state === "cancelled") {
    $("result-text").textContent = "Save cancelled (no data kept).";
  } else {
    $("result-text").textContent = "Error: " + (job.message || "unknown");
  }
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    const job = await askOffscreen({ type: "status" });
    if (job.state === "none") {
      stopPolling();
      setRunning(false);
      $("progress").hidden = true;
      return;
    }
    renderStatus(job);
  };
  tick();
  pollTimer = setInterval(tick, 700);
}

async function onStart() {
  showMessage("");
  $("result").hidden = true;
  const depth = parseInt($("depth").value, 10);
  const maxPages = Math.max(1, Math.min(parseInt($("max-pages").value, 10) || 50, 500));
  chrome.storage.local.set({ depth, maxPages });
  if (depth >= 2) {
    showMessage("Depth " + depth + ": the volume can be very large. The max pages limit still applies.", "warn");
  }
  const r = await askBackground({ type: "start", url: currentUrl, depth, maxPages });
  if (r.error && !r.busy) { showMessage(r.error, "error"); return; }
  if (r.busy) showMessage("A save is already running; following it.", "warn");
  setRunning(true);
  startPolling();
}

async function onCancel() {
  await askOffscreen({ type: "cancel" });
}

async function init() {
  $("start").addEventListener("click", onStart);
  $("cancel").addEventListener("click", onCancel);
  $("library").addEventListener("click", () => openExt("library.html"));
  $("open-save").addEventListener("click", () => { if (openTarget) openExt(openTarget); });

  const saved = await chrome.storage.local.get(["depth", "maxPages"]);
  if (saved.depth !== undefined) $("depth").value = String(saved.depth);
  if (saved.maxPages) $("max-pages").value = saved.maxPages;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = (tab && tab.url) || "";
  $("current-url").textContent = currentUrl || "URL unavailable";

  loadRecent();

  const job = await askOffscreen({ type: "status" });
  if (job.state === "running") { setRunning(true); startPolling(); return; }

  if (!isSavable(currentUrl)) {
    showMessage("This page can't be saved (only http/https pages can be).", "warn");
    return;
  }
  $("start").disabled = false;
}

init();
