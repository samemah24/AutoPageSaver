"use strict";
/*
 * Offscreen document: hosts the crawler (DOMParser access, and fetch without CORS
 * thanks to the extension's host permissions) and answers the popup's messages.
 */
let job = null;

function status() {
  if (!job) return { state: "none" };
  const c = job.crawler;
  return {
    state: c.state,
    url: job.url,
    phase: c.phase,
    current: c.current,
    depth: c.depth,
    max_pages: c.maxPages,
    stats: Object.assign({}, c.stats),
    saveId: c.saveId,
    message: c.message,
  };
}

async function start(msg) {
  if (job && job.crawler.state === "running") {
    return { error: "A save is already running.", busy: true, status: status() };
  }
  let u;
  try { u = new URL(String(msg.url)); } catch (_) { return { error: "Invalid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "Only http/https pages can be saved." };
  }
  await APSDB.cleanupOrphans();
  const crawler = new Crawler({ url: u.href, depth: msg.depth, maxPages: msg.maxPages });
  job = { url: u.href, crawler };
  crawler.run();
  return status();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  let p;
  switch (msg.type) {
    case "start": p = start(msg); break;
    case "status": p = Promise.resolve(status()); break;
    case "cancel":
      if (job && job.crawler.state === "running") job.crawler.cancel();
      p = Promise.resolve(status());
      break;
    default: p = Promise.resolve({ error: "unknown command" });
  }
  p.then(sendResponse).catch((e) => sendResponse({ error: (e && e.message) || String(e) }));
  return true;
});
