"use strict";

const $ = (id) => document.getElementById(id);
const open = new Set();
let saves = [];

const viewUrl = (id, pageId) => "viewer.html?s=" + encodeURIComponent(id) + "&p=" + encodeURIComponent(pageId || "p0");
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : "#");
const lc = (s) => (s || "").toLowerCase();

function fmtSize(b) {
  if (!b) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); }
  catch (e) { return iso || ""; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(cls, text, href, external) {
  const a = el("a", cls, text);
  a.href = href;
  a.target = "_blank";
  a.rel = external ? "noopener noreferrer" : "noopener";
  return a;
}

async function load() {
  try {
    saves = (await APSDB.getAll("saves"))
      .filter((s) => s.state === "done")
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    let usage = "";
    try { usage = " · " + fmtSize((await navigator.storage.estimate()).usage) + " used in Chrome"; }
    catch (e) { /* estimate unavailable */ }
    $("sub").textContent = saves.length + " save(s)" + usage;
  } catch (e) {
    $("sub").textContent = "Could not read the database: " + e.message;
    saves = [];
  }
  render();
}

async function remove(s) {
  if (!confirm("Permanently delete the saved copy \"" + (s.title || s.start_url) + "\"?")) return;
  try { await APSDB.deleteSave(s.id); }
  catch (e) { alert("Could not delete: " + e.message); }
  load();
}

function render() {
  const q = lc($("q").value.trim());
  const list = $("list");
  list.replaceChildren();
  let shown = 0;

  for (const s of saves) {
    const pages = s.pages || [];
    const matches = q ? pages.filter((p) => lc(p.title).includes(q) || lc(p.url).includes(q)) : [];
    const selfMatch = q && (lc(s.title).includes(q) || lc(s.start_url).includes(q));
    if (q && !matches.length && !selfMatch) continue;
    shown++;

    const card = el("div", "card");
    let host = s.start_url;
    try { host = new URL(s.start_url).host; } catch (e) { /* keep the raw URL */ }
    card.appendChild(el("h2", "", s.title || host));

    const stats = s.stats || {};
    card.appendChild(el("div", "meta",
      s.start_url + " · " + fmtDate(s.created) + " · " + (stats.pages || 0) + " page(s) · depth " +
      s.depth + " · " + fmtSize(s.size_bytes)));

    const row = el("div", "row");
    row.appendChild(link("btn primary", "Open saved copy", viewUrl(s.id, "p0")));
    row.appendChild(link("btn", "Original page (online)", safeHref(s.start_url), true));
    const toggle = el("button", "", "Pages (" + pages.length + ")");
    toggle.addEventListener("click", () => {
      if (open.has(s.id)) open.delete(s.id); else open.add(s.id);
      render();
    });
    row.appendChild(toggle);
    const del = el("button", "danger", "Delete");
    del.addEventListener("click", () => remove(s));
    row.appendChild(del);
    card.appendChild(row);

    if (open.has(s.id) || (q && matches.length)) {
      const ul = el("ul", "pages");
      for (const p of (q && matches.length ? matches : pages)) {
        const li = el("li");
        li.appendChild(link("", p.title || p.url, viewUrl(s.id, p.id)));
        li.appendChild(el("span", "badge", "level " + p.depth));
        li.appendChild(el("small", "", p.url));
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }
    list.appendChild(card);
  }

  const empty = $("empty");
  empty.hidden = shown > 0;
  if (shown === 0) {
    empty.textContent = saves.length
      ? "No results for this search."
      : "No saves yet. Open a web page and use the extension icon.";
  }
}

$("q").addEventListener("input", render);
load();
