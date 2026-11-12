"use strict";
/*
 * Viewer: rebuilds a saved page from IndexedDB.
 *  - resources (images, CSS, fonts) become local blob: URLs
 *  - clicking a link to another saved page opens that page here
 *  - other links open online, in a new tab
 */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const saveId = params.get("s") || "";
const pageId = params.get("p") || "p0";
const fragment = params.get("f") || "";

const done = new Map();   // resource id -> blob URL
const resolving = new Set();

const viewHref = (p, f) =>
  "viewer.html?s=" + encodeURIComponent(saveId) + "&p=" + encodeURIComponent(p) + (f ? "&f=" + encodeURIComponent(f) : "");

function showError(text) {
  $("error").textContent = text;
  $("error").hidden = false;
  $("frame").hidden = true;
}

// Sequential resolution: the `resolving` set mirrors the call stack (detects cycles)
async function resUrl(id) {
  if (done.has(id)) return done.get(id);
  if (resolving.has(id)) return null;
  resolving.add(id);
  let url = null;
  try {
    const rec = await APSDB.get("assets", saveId + ":" + id);
    if (rec) {
      if (rec.kind === "css") {
        url = URL.createObjectURL(new Blob([await replaceTokens(rec.text)], { type: "text/css" }));
      } else if (rec.blob) {
        url = URL.createObjectURL(rec.blob);
      }
    }
  } finally {
    resolving.delete(id);
  }
  done.set(id, url);
  return url;
}

async function replaceTokens(text) {
  if (!text || !text.includes("aps-res:")) return text;
  const ids = Array.from(new Set(text.match(/aps-res:r\d+/g) || []));
  const map = new Map();
  for (const token of ids) map.set(token, (await resUrl(token.slice(8))) || "about:blank");
  return text.replace(/aps-res:r\d+/g, (t) => map.get(t));
}

async function main() {
  if (!saveId) return showError("No saved copy specified.");
  const save = await APSDB.get("saves", saveId);
  if (!save) return showError("Saved copy not found (deleted?).");

  const sel = $("pages");
  for (const p of save.pages || []) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = (p.depth ? "· ".repeat(p.depth) : "") + (p.title || p.url);
    if (p.id === pageId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => { location.href = viewHref(sel.value); });

  const rec = await APSDB.get("pages", saveId + ":" + pageId);
  if (!rec) return showError("Page not found in this saved copy.");
  document.title = rec.title || rec.url;
  const orig = $("orig");
  if (/^https?:\/\//i.test(rec.url)) orig.href = rec.url; else orig.hidden = true;

  const doc = new DOMParser().parseFromString(rec.html, "text/html");
  for (const el of doc.querySelectorAll("[data-aps-res]")) {
    const url = await resUrl(el.getAttribute("data-aps-res"));
    if (!url) continue;
    el.setAttribute(el.tagName === "LINK" ? "href" : "src", url);
    el.removeAttribute("data-aps-res");
  }
  for (const st of doc.querySelectorAll("style")) st.textContent = await replaceTokens(st.textContent);
  for (const el of doc.querySelectorAll("[style]")) el.setAttribute("style", await replaceTokens(el.getAttribute("style")));

  const frame = $("frame");
  frame.addEventListener("load", () => {
    const idoc = frame.contentDocument;
    if (!idoc) return;
    idoc.addEventListener("click", (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest("a[href], area[href]");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#")) return;   // anchor within the same page
      ev.preventDefault();
      const target = a.getAttribute("data-aps-page");
      if (target) {
        location.href = viewHref(target, a.getAttribute("data-aps-frag") || "");
      } else if (/^https?:\/\//i.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
      }
    });
    if (fragment) {
      const t = idoc.getElementById(fragment) || idoc.getElementsByName(fragment)[0];
      if (t) t.scrollIntoView();
    }
  });
  frame.srcdoc = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

main().catch((e) => showError("Error: " + e.message));
