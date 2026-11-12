"use strict";
/*
 * Service worker: creates the offscreen document (which hosts the crawler) on demand
 * and forwards the popup's commands to it.
 */
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Parse the HTML of the pages being saved and run the crawl in the background.",
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function sendToOffscreen(msg) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (r !== undefined) return r;
      lastErr = new Error("no response from the crawler module");
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw lastErr;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return false;
  (async () => {
    await ensureOffscreen();
    return sendToOffscreen(Object.assign({}, msg, { target: "offscreen" }));
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: (e && e.message) || String(e) }));
  return true;
});
