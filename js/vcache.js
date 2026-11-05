/* Video-Zwischenspeicher auf dem Handy: dasselbe Pack wird in weiteren Runden nicht noch einmal übertragen.
   Fehler (privater Modus, wenig Speicher) werden still ignoriert, dann wird einfach normal geladen. */
(function () {
  const VD = (window.VD = window.VD || {});
  const KEEP = 2;   // höchstens zwei Videos merken
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('vibingtogether-cache', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('video', { keyPath: 'key' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => { const t = db.transaction('video', mode); const r = fn(t.objectStore('video')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  };
  VD.VideoCache = {
    async get(key) {
      try { const r = await run('readonly', (s) => s.get(key)); return r && r.bytes ? r : null; } catch { return null; }
    },
    async put(key, mime, bytes) {
      try {
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        // Nur die Schlüssel lesen (nicht die Videos selbst), sonst lägen kurz alle gespeicherten Videos im Speicher
        const keys = ((await run('readonly', (s) => s.getAllKeys())) || []).filter((k) => k !== key);
        const order = VD.store.get('vcacheOrder', []).filter((k) => keys.includes(k));   // älteste zuerst
        const known = keys.filter((k) => !order.includes(k)).concat(order);   // unbekannte gelten als die ältesten
        const drop = known.slice(0, Math.max(0, known.length - (KEEP - 1)));
        await run('readwrite', (s) => { drop.forEach((k) => s.delete(k)); return s.put({ key, mime, bytes: copy, t: Date.now() }); });
        VD.store.set('vcacheOrder', known.filter((k) => !drop.includes(k)).concat(key));
      } catch { /* kein Speicher: egal */ }
    }
  };
})();
