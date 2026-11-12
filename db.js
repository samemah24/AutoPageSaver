"use strict";
/*
 * APS storage in Chrome's internal database (IndexedDB).
 * Shared by the popup, the library, the viewer and the offscreen document
 * (all these pages share the same chrome-extension:// origin).
 *
 *  saves  : one entry per finished save (metadata + list of pages)
 *  pages  : cleaned HTML of each page   (key "<saveId>:<pageId>")
 *  assets : images, CSS, fonts          (key "<saveId>:<resId>")
 */
const APSDB = (() => {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const rq = indexedDB.open("aps", 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          db.createObjectStore("saves", { keyPath: "id" });
          db.createObjectStore("pages", { keyPath: "key" });
          db.createObjectStore("assets", { keyPath: "key" });
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => { dbPromise = null; reject(rq.error); };
      });
    }
    return dbPromise;
  }

  // `work` must only issue IndexedDB requests (no await inside)
  function run(stores, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      try { out = work(t); } catch (e) { try { t.abort(); } catch (_) { /* already finished */ } return reject(e); }
      t.oncomplete = () => resolve(out && typeof out === "object" && "result" in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("transaction aborted"));
    }));
  }

  const api = {
    get: (store, key) => run(store, "readonly", (t) => t.objectStore(store).get(key)),
    put: (store, rec) => run(store, "readwrite", (t) => { t.objectStore(store).put(rec); }),
    getAll: (store) => run(store, "readonly", (t) => t.objectStore(store).getAll()),
    getAllKeys: (store) => run(store, "readonly", (t) => t.objectStore(store).getAllKeys()),

    deleteSave: (id) => run(["saves", "pages", "assets"], "readwrite", (t) => {
      t.objectStore("saves").delete(id);
      const range = IDBKeyRange.bound(id + ":", id + ":\uffff");
      t.objectStore("pages").delete(range);
      t.objectStore("assets").delete(range);
    }),

    // Removes data left by interrupted saves (browser closed, error...)
    async cleanupOrphans() {
      const [saveIds, pageKeys, assetKeys] = await Promise.all([
        api.getAllKeys("saves"), api.getAllKeys("pages"), api.getAllKeys("assets"),
      ]);
      const known = new Set(saveIds);
      const orphans = new Set();
      for (const k of pageKeys.concat(assetKeys)) {
        const id = String(k).split(":")[0];
        if (!known.has(id)) orphans.add(id);
      }
      for (const id of orphans) await api.deleteSave(id);
      return orphans.size;
    },
  };
  return api;
})();
