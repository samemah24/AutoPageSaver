"use strict";
/*
 * Auto Page Saver - crawler (runs inside the extension's offscreen document).
 *
 *  - breadth-first crawl down to the chosen depth (0 to 3)
 *  - page cap, set of already-seen URLs (prevents loops)
 *  - robots.txt honoured (Allow/Disallow, wildcards, Crawl-delay); per-host politeness
 *  - downloads images, CSS (including url() and @import) and fonts
 *  - HTML cleaning (scripts removed) and link rewriting towards the local copy
 *  - storage in IndexedDB (see db.js)
 *
 * Known limitation: Chrome forbids changing the User-Agent header of a fetch, so
 * robots.txt is evaluated for the "AutoPageSaver" token and then for "*".
 */

const UA_TOKEN = "autopagesaver";
const CFG = {
  MAX_DEPTH: 3,
  HARD_MAX_PAGES: 500,
  TIMEOUT: 15000,                    // ms per request
  MAX_BYTES: 10 * 1024 * 1024,       // per file
  MAX_TOTAL_BYTES: 500 * 1024 * 1024,
  MAX_RESOURCES: 4000,
  PAGE_DELAY: 500,                   // minimum ms between two pages of the same site
  ASSET_DELAY: 100,                  // minimum ms between two resources on the same host
  CONCURRENCY: 4,
  MAX_CSS_NESTING: 3,
};
const CANCELLED = new Error("cancelled");

// MediaWiki namespaces to skip (useful for Wikipedia; names are the French ones)
const WIKI_SKIP = /\/wiki\/(Spécial|Special|Discussion|Talk|Utilisateur|User|Aide|Help|Wikipédia|Wikipedia|Modèle|Template|Catégorie|Category|Portail|Portal):/i;

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  css: "text/css",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isHttp = (u) => u.protocol === "http:" || u.protocol === "https:";

function normalizeUrl(href) {
  const u = new URL(href);
  u.hash = "";
  return u.href;
}

function guessType(url) {
  try {
    const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
    return (m && MIME_BY_EXT[m[1].toLowerCase()]) || "application/octet-stream";
  } catch (_) { return "application/octet-stream"; }
}

function decodeText(buf, contentType, sniffMeta) {
  let charset = (/charset=["']?([^;"'\s]+)/i.exec(contentType || "") || [])[1];
  if (!charset && sniffMeta) {
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 4096));
    const m = /<meta[^>]+charset=["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(head);
    if (m) charset = m[1];
  }
  try { return new TextDecoder(charset || "utf-8").decode(buf); }
  catch (_) { return new TextDecoder("utf-8").decode(buf); }
}

async function readLimited(resp, max) {
  if (!resp.body) {
    const b = new Uint8Array(await resp.arrayBuffer());
    if (b.length > max) throw new Error("file too large");
    return b;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { reader.cancel().catch(() => {}); throw new Error("file too large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- robots.txt
function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if ((field === "allow" || field === "disallow") && value !== "") {
        cur.rules.push({ allow: field === "allow", pattern: value });
      } else if (field === "crawl-delay") {
        const n = parseFloat(value);
        if (!isNaN(n) && n >= 0) cur.delay = n;
      }
    }
  }
  const specific = groups.filter((g) => g.agents.includes(UA_TOKEN));
  const use = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const delays = use.map((g) => g.delay).filter((d) => d !== null);
  return {
    rules: use.flatMap((g) => g.rules),
    delay: delays.length ? Math.min(Math.max(...delays), 10) * 1000 : 0,
  };
}

function patternToRegex(pattern) {
  const src = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
  return new RegExp("^" + src);
}

function robotsAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.re) r.re = patternToRegex(r.pattern);
    if (r.re.test(path)) {
      if (!best || r.pattern.length > best.pattern.length ||
          (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

class RobotsCache {
  constructor() { this.cache = new Map(); }
  entry(origin) {
    if (!this.cache.has(origin)) this.cache.set(origin, this._load(origin));
    return this.cache.get(origin);
  }
  async _load(origin) {
    try {
      const resp = await fetch(origin + "/robots.txt", {
        credentials: "omit", signal: AbortSignal.timeout(CFG.TIMEOUT),
      });
      if (resp.status >= 400 && resp.status < 500) return { rules: [], delay: 0 };  // no robots.txt
      if (!resp.ok) return { disallowAll: true };                                    // server error: be cautious
      const buf = await readLimited(resp, 512 * 1024);
      return parseRobots(decodeText(buf, resp.headers.get("content-type"), false));
    } catch (_) {
      return { disallowAll: true };                                                  // network error: be cautious
    }
  }
  async allowed(url) {
    const u = new URL(url);
    const e = await this.entry(u.origin);
    return e.disallowAll ? false : robotsAllowed(e.rules, u.pathname + u.search);
  }
  async delay(url) {
    const e = await this.entry(new URL(url).origin);
    return e.delay || 0;
  }
}

// ---------------------------------------------------------------- throughput tools
class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const r = this.q.shift();
    if (r) r(); else this.n++;
  }
}

class Throttle {
  constructor() { this.next = new Map(); }
  async wait(host, delayMs) {
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) || 0);
    this.next.set(host, at + delayMs);
    if (at > now) await sleep(at - now);
  }
}

// ---------------------------------------------------------------- crawler
class Crawler {
  constructor({ url, depth, maxPages }) {
    this.startUrl = normalizeUrl(url);
    this.host = new URL(this.startUrl).host;
    this.depth = Math.max(0, Math.min(parseInt(depth, 10) || 0, CFG.MAX_DEPTH));
    this.maxPages = Math.max(1, Math.min(parseInt(maxPages, 10) || 50, CFG.HARD_MAX_PAGES));
    this.saveId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

    this.stats = { pages: 0, resources: 0, skipped_robots: 0, skipped_scope: 0, errors: 0 };
    this.phase = "waiting";
    this.current = "";
    this.state = "running";
    this.message = "";
    this.lastError = "";

    this.visited = new Set();
    this.seenOutOfScope = new Set();
    this.pageIds = new Map();     // normalised url -> page id
    this.pages = [];              // {id, url, finalUrl, depth, title}
    this.resPromises = new Map(); // resource url -> Promise<id|null>
    this.resSeq = 0;
    this.pageSeq = 0;
    this.resCount = 0;
    this.bytes = 0;

    this.cancelCtrl = new AbortController();
    this.robots = new RobotsCache();
    this.throttle = new Throttle();
    this.sem = new Semaphore(CFG.CONCURRENCY);
  }

  cancel() { this.cancelCtrl.abort(); }
  check() { if (this.cancelCtrl.signal.aborted) throw CANCELLED; }

  // ---------- network
  async fetchLimited(url, baseDelay) {
    const host = new URL(url).host;
    await this.throttle.wait(host, Math.max(baseDelay, await this.robots.delay(url)));
    this.check();
    await this.sem.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.TIMEOUT);
    const onCancel = () => ctrl.abort();
    this.cancelCtrl.signal.addEventListener("abort", onCancel);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      if (Number(resp.headers.get("content-length") || 0) > CFG.MAX_BYTES) throw new Error("file too large");
      const buf = await readLimited(resp, CFG.MAX_BYTES);
      const contentType = resp.headers.get("content-type") || "";
      return {
        buf,
        contentType,
        type: contentType.split(";")[0].trim().toLowerCase(),
        finalUrl: resp.url || url,
      };
    } finally {
      clearTimeout(timer);
      this.cancelCtrl.signal.removeEventListener("abort", onCancel);
      this.sem.release();
    }
  }

  inScope(url) {
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    if (!isHttp(u)) return false;
    if (u.host !== this.host) return false;
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch (_) { /* keep the original */ }
    return !WIKI_SKIP.test(path);
  }

  baseFor(doc, pageUrl) {
    const b = doc.querySelector("base[href]");
    if (b) { try { return new URL(b.getAttribute("href"), pageUrl).href; } catch (_) { /* ignored */ } }
    return pageUrl;
  }

  // ---------- execution
  async run() {
    try {
      await this._run();
      this.state = "done";
      this.phase = "done";
    } catch (e) {
      await APSDB.deleteSave(this.saveId).catch(() => {});
      if (e === CANCELLED) { this.state = "cancelled"; this.phase = "cancelled"; }
      else { this.state = "error"; this.phase = "error"; this.message = (e && e.message) || String(e); }
    }
    this.current = "";
  }

  async _run() {
    const parser = new DOMParser();
    this.phase = "crawling";
    const queue = [[this.startUrl, 0]];
    let head = 0;
    this.visited.add(this.startUrl);

    while (head < queue.length && this.stats.pages < this.maxPages) {
      this.check();
      const [url, d] = queue[head++];
      this.current = url;
      if (!(await this.robots.allowed(url))) { this.stats.skipped_robots++; continue; }

      let r;
      try { r = await this.fetchLimited(url, CFG.PAGE_DELAY); }
      catch (e) { this.check(); this.stats.errors++; this.lastError = e.message; continue; }
      if (!/^(text\/html|application\/xhtml\+xml)$/.test(r.type)) continue;

      let finalUrl = url;
      try { finalUrl = normalizeUrl(r.finalUrl); } catch (_) { /* keep url */ }
      if (finalUrl !== url) {
        if (!this.inScope(finalUrl)) { this.stats.skipped_scope++; continue; }
        if (this.pageIds.has(finalUrl)) continue;
        this.visited.add(finalUrl);
      }

      const text = decodeText(r.buf, r.contentType, true);
      const doc = parser.parseFromString(text, "text/html");
      const title = (doc.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
      const id = "p" + this.pageSeq++;
      this.pageIds.set(url, id);
      this.pageIds.set(finalUrl, id);
      this.pages.push({ id, url, finalUrl, depth: d, title });
      await APSDB.put("pages", {
        key: this.saveId + ":" + id, saveId: this.saveId, pageId: id,
        url, finalUrl, depth: d, title, html: text, size: text.length,
      });
      this.stats.pages++;

      if (d < this.depth) {
        const base = this.baseFor(doc, finalUrl);
        for (const a of doc.querySelectorAll("a[href]")) {
          if (queue.length - head >= this.maxPages * 3) break;  // enough pages already queued
          const raw = a.getAttribute("href");
          if (!raw || raw.startsWith("#")) continue;
          let u;
          try { u = new URL(raw, base); } catch (_) { continue; }
          if (!isHttp(u)) continue;
          const nxt = normalizeUrl(u.href);
          if (this.visited.has(nxt)) continue;
          if (!this.inScope(nxt)) {
            if (!this.seenOutOfScope.has(nxt)) { this.seenOutOfScope.add(nxt); this.stats.skipped_scope++; }
            continue;
          }
          this.visited.add(nxt);
          queue.push([nxt, d + 1]);
        }
      }
    }

    if (this.stats.pages === 0) {
      throw new Error(this.stats.skipped_robots
        ? "The start page is disallowed by robots.txt."
        : "Could not download the start page" + (this.lastError ? " (" + this.lastError + ")" : "") + ".");
    }

    // Phase 2: resources + rewriting (the full set of saved pages is now known)
    this.phase = "resources";
    let pagesBytes = 0;
    for (const p of this.pages) {
      this.check();
      this.current = p.url;
      const rec = await APSDB.get("pages", this.saveId + ":" + p.id);
      rec.html = await this.processPage(rec);
      rec.size = rec.html.length;
      pagesBytes += rec.size;
      await APSDB.put("pages", rec);
    }
    this.check();

    const sorted = this.pages.slice().sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
    await APSDB.put("saves", {
      id: this.saveId,
      state: "done",
      start_url: this.startUrl,
      title: (this.pages[0] && this.pages[0].title) || "",
      created: new Date().toISOString(),
      depth: this.depth,
      max_pages: this.maxPages,
      stats: this.stats,
      size_bytes: pagesBytes + this.bytes,
      pages: sorted.map((p) => ({ id: p.id, url: p.url, title: p.title, depth: p.depth })),
    });
  }

  // ---------- cleaning + rewriting of a page
  async processPage(rec) {
    const doc = new DOMParser().parseFromString(rec.html, "text/html");
    const base = this.baseFor(doc, rec.finalUrl);

    // 1. active content removed: saved pages are plain documents
    doc.querySelectorAll(
      "script, iframe, frame, frameset, object, embed, applet, base, " +
      'meta[http-equiv="refresh" i], meta[http-equiv="content-security-policy" i], ' +
      'link[rel~="preload"], link[rel~="prefetch"], link[rel~="modulepreload"], ' +
      'link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="prerender"]'
    ).forEach((e) => e.remove());
    doc.querySelectorAll("*").forEach((el) => {
      for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      }
      el.removeAttribute("nonce");
      el.removeAttribute("integrity");
      el.removeAttribute("crossorigin");
    });
    doc.querySelectorAll("form").forEach((f) => f.removeAttribute("action"));

    // 2. links: to the local copy if the page is saved, otherwise an online link
    doc.querySelectorAll("a[href], area[href]").forEach((a) => {
      const raw = a.getAttribute("href");
      if (/^\s*javascript:/i.test(raw)) { a.removeAttribute("href"); return; }
      if (raw.startsWith("#")) return;
      let abs;
      try { abs = new URL(raw, base); } catch (_) { return; }
      if (!isHttp(abs)) return;
      a.setAttribute("href", abs.href);
      a.removeAttribute("ping");
      const id = this.pageIds.get(normalizeUrl(abs.href));
      if (id) {
        a.setAttribute("data-aps-page", id);
        if (abs.hash) a.setAttribute("data-aps-frag", abs.hash.slice(1));
      }
    });

    // 3. resources
    const tasks = [];
    const addRes = (el, attr, raw, kind) => {
      let abs;
      try { abs = new URL(raw, base); } catch (_) { return; }
      if (!isHttp(abs)) return;
      el.setAttribute(attr, abs.href);  // online fallback if the download fails
      tasks.push(this.getResource(abs.href, kind, []).then((id) => {
        if (id) el.setAttribute("data-aps-res", id);
      }));
    };

    doc.querySelectorAll("picture source").forEach((s) => s.remove());
    doc.querySelectorAll("img").forEach((img) => {
      let src = img.getAttribute("src");
      const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
      if ((!src || src.startsWith("data:")) && lazy) src = lazy;
      if (!src) {
        const ss = img.getAttribute("srcset");
        if (ss) src = ss.split(",")[0].trim().split(/\s+/)[0];
      }
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.removeAttribute("loading");
      if (!src || src.startsWith("data:")) return;
      addRes(img, "src", src, "any");
    });
    doc.querySelectorAll("link[href]").forEach((l) => {
      const rel = (l.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet")) addRes(l, "href", l.getAttribute("href"), "css");
      else if (rel.includes("icon")) addRes(l, "href", l.getAttribute("href"), "any");
    });
    doc.querySelectorAll("style").forEach((st) => {
      tasks.push(this.processCss(st.textContent, base, []).then((css) => { st.textContent = css; }));
    });
    doc.querySelectorAll("[style]").forEach((el) => {
      tasks.push(this.processCss(el.getAttribute("style"), base, []).then((css) => el.setAttribute("style", css)));
    });

    await Promise.all(tasks);
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  // ---------- resources
  getResource(rawUrl, kind, chain) {
    let key;
    try { const u = new URL(rawUrl); u.hash = ""; key = u.href; } catch (_) { return Promise.resolve(null); }
    if (chain.includes(key)) return Promise.resolve(null);  // circular @import
    if (this.resPromises.has(key)) return this.resPromises.get(key);
    const p = Promise.race([
      this._loadResource(key, kind, chain).catch(() => null),
      sleep(60000).then(() => null),
    ]);
    this.resPromises.set(key, p);
    return p;
  }

  async _loadResource(url, kind, chain) {
    if (this.resCount >= CFG.MAX_RESOURCES || this.bytes >= CFG.MAX_TOTAL_BYTES) return null;
    if (!(await this.robots.allowed(url))) { this.stats.skipped_robots++; return null; }
    this.resCount++;
    let r;
    try { r = await this.fetchLimited(url, CFG.ASSET_DELAY); }
    catch (_) { this.stats.errors++; return null; }

    const id = "r" + this.resSeq++;
    const key = this.saveId + ":" + id;
    let rec;
    if (kind === "css" || r.type === "text/css") {
      let text = decodeText(r.buf, r.contentType, false);
      if (chain.length < CFG.MAX_CSS_NESTING) text = await this.processCss(text, r.finalUrl || url, chain.concat(url));
      rec = { key, saveId: this.saveId, resId: id, url, kind: "css", text, size: text.length };
    } else {
      const type = r.type && r.type !== "application/octet-stream" ? r.type : guessType(url);
      rec = { key, saveId: this.saveId, resId: id, url, kind: "bin", type, blob: new Blob([r.buf], { type }), size: r.buf.length };
    }
    await APSDB.put("assets", rec);
    this.bytes += rec.size;
    this.stats.resources++;
    return id;
  }

  // Downloads the url(...) and @import references of a stylesheet and replaces them with "aps-res:<id>"
  async processCss(text, baseUrl, chain) {
    if (!text || (!/url\(/i.test(text) && !/@import/i.test(text))) return text;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi;
    const refs = new Map();  // raw -> {abs, kind}
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[2] !== undefined ? m[2] : m[4]) || "";
      if (!raw || raw.startsWith("data:") || raw.startsWith("#") || refs.has(raw)) continue;
      let abs;
      try { abs = new URL(raw, baseUrl); } catch (_) { continue; }
      if (!isHttp(abs)) continue;
      refs.set(raw, { abs: abs.href, kind: m[4] !== undefined || /\.css($|\?)/i.test(abs.pathname + abs.search) ? "css" : "any" });
    }
    if (!refs.size) return text;

    await Promise.all(Array.from(refs.values()).map(async (ref) => {
      ref.id = await this.getResource(ref.abs, ref.kind, chain);
    }));

    return text.replace(re, (full, q, u, q2, imp) => {
      const raw = u !== undefined ? u : imp;
      const ref = refs.get(raw);
      if (!ref) return full;
      const target = ref.id ? "aps-res:" + ref.id : ref.abs;  // fallback: absolute URL
      return u !== undefined ? "url(" + q + target + q + ")" : "@import " + q2 + target + q2;
    });
  }
}
