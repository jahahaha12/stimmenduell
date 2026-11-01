/* Video-Zwischenspeicher auf dem Handy: dasselbe Pack wird in weiteren Runden nicht noch einmal übertragen.
   Fehler (privater Modus, wenig Speicher) werden still ignoriert, dann wird einfach normal geladen. */
(function () {
  const VD = (window.VD = window.VD || {});
  const KEEP = 2;   // höchstens zwei Videos merken
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('dubtogether-cache', 1);
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
        const all = (await run('readonly', (s) => s.getAll())) || [];
        const old = all.filter((x) => x.key !== key).sort((a, b) => a.t - b.t);
        await run('readwrite', (s) => { old.slice(0, Math.max(0, old.length - (KEEP - 1))).forEach((x) => s.delete(x.key)); return s.put({ key, mime, bytes: copy, t: Date.now() }); });
      } catch { /* kein Speicher: egal */ }
    }
  };
})();
