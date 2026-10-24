/* Dub-Packs: Import aus ZIP oder Ordner, Speicherung in IndexedDB.
   Format (Community-Packs für Choicer Voicer, z. B. von GameBanana):
     _pack_info.ini      title="…"  icon="icon.png"  authors=["…"]
     dub_video.ogv       das Video (stumm abzuspielen), auch mp4/webm
     _backing_track.ogg  Musik/Geräusche ohne Stimmen (optional)
     NN_name.ogg         Originalzeile (Sprache)
     NN_name.ini         caption="…"  dub_timestamps=[3.829]  dub_characters=["Brian"]
     NN_name.png         Standbild zur Zeile                                              */
(function () {
  const VD = (window.VD = window.VD || {});
  const CFG = window.VD_CONFIG;
  const LIM = CFG.limits;

  const AUDIO_EXT = /\.(ogg|oga|opus|wav|mp3|m4a|aac|flac)$/i;
  const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
  const VIDEO_RE = /^dub_video\.(ogv|mp4|m4v|webm)$/i;
  const BACK_RE = /^_backing_track\.[a-z0-9]+$/i;

  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const stem = (n) => n.replace(/\.[^.]+$/, '');
  const natural = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

  function normEntry(e) {
    const p = String(e.path).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    const segs = p.split('/');
    if (segs.includes('__MACOSX') || segs.some((s) => s.startsWith('.')) || /^(thumbs\.db|desktop\.ini)$/i.test(baseOf(p))) return null;
    return { path: p, size: e.size || 0, read: e.read };
  }

  /* Einfache ini-Dateien: key=value, Werte sind JSON-artig ("Text", [1.5], ["A","B"]) */
  function parseIni(text) {
    const o = {};
    for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      try { o[m[1]] = JSON.parse(m[2]); } catch { o[m[1]] = m[2].replace(/^"|"$/g, ''); }
    }
    return o;
  }

  const guessMime = (n) => {
    const e = (n.match(/\.([^.]+)$/) || [])[1];
    return ({ wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ogv: 'video/ogg', mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4' })[(e || '').toLowerCase()] || '';
  };
  const typed = (blob, name) => (blob.type && !/octet-stream/.test(blob.type) ? blob : new Blob([blob], { type: guessMime(name) }));

  const probeVideo = (blob) => VD.Video.probe(blob);

  async function buildPacks(rawEntries, fallbackName, onStatus) {
    const entries = rawEntries.map(normEntry).filter(Boolean);
    const videos = entries.filter((e) => VIDEO_RE.test(baseOf(e.path)));
    const anyIni = entries.some((e) => /\.ini$/i.test(e.path) && !baseOf(e.path).startsWith('_'));
    if (!videos.length) {
      if (anyIni || entries.some((e) => AUDIO_EXT.test(e.path))) throw new Error('Das ist kein Dub-Pack: Die Datei „dub_video“ (ogv, mp4 oder webm) fehlt.');
      return [];
    }
    const out = [];
    for (const ve of videos) {
      const D = dirOf(ve.path);
      const mine = entries.filter((e) => dirOf(e.path) === D);
      const info = mine.find((e) => /^_pack_info\.ini$/i.test(baseOf(e.path)));
      const meta = info ? parseIni(await (await info.read()).text()) : {};
      const byStem = new Map();
      for (const e of mine) {
        const b = baseOf(e.path);
        if (b.startsWith('_') || VIDEO_RE.test(b)) continue;
        const k = stem(b).toLowerCase();
        if (!byStem.has(k)) byStem.set(k, {});
        const g = byStem.get(k);
        if (AUDIO_EXT.test(b)) g.audio = e; else if (/\.ini$/i.test(b)) g.ini = e; else if (IMG_EXT.test(b)) g.img = e;
      }
      const keys = Array.from(byStem.keys()).sort(natural.compare);
      const pack = {
        id: 'p_' + VD.uid(), kind: 'dub', name: String(meta.title || (D ? baseOf(D) : fallbackName)).slice(0, 80),
        author: Array.isArray(meta.authors) ? meta.authors.join(', ').slice(0, 60) : String(meta.authors || '').slice(0, 60),
        lines: [], chars: [], video: null, backing: null, iconBlob: null, createdAt: Date.now()
      };
      let n = 0;
      for (const k of keys) {
        const g = byStem.get(k);
        if (!g.audio || !g.ini) continue;
        const ini = parseIni(await (await g.ini.read()).text());
        const ts = Array.isArray(ini.dub_timestamps) ? Number(ini.dub_timestamps[0]) : Number(ini.dub_timestamps);
        if (!isFinite(ts) || ts < 0) continue;
        if (g.audio.size && g.audio.size > LIM.maxClipBytes) continue;
        onStatus && onStatus(`Lese ${pack.name}: Zeile ${++n}/${keys.length}`);
        const chars = Array.isArray(ini.dub_characters) ? ini.dub_characters : ini.dub_characters ? [ini.dub_characters] : [];
        const ch = String(chars[0] || 'Sprecher').slice(0, 30);
        pack.lines.push({
          id: 'l_' + VD.uid(), file: baseOf(g.audio.path), caption: String(ini.caption || '').slice(0, 240), char: ch, ts,
          blob: typed(await g.audio.read(), g.audio.path), imgBlob: g.img ? typed(await g.img.read(), g.img.path) : null
        });
        if (n % 6 === 0) await VD.sleep(0);
      }
      if (!pack.lines.length) throw new Error('Im Pack gibt es keine Zeilen mit Zeitstempel (.ini mit dub_timestamps).');
      pack.lines.sort((a, b) => a.ts - b.ts);
      pack.chars = Array.from(new Set(pack.lines.map((l) => l.char)));
      if (ve.size && ve.size > LIM.maxVideoBytes) throw new Error('Das Video ist größer als ' + Math.round(LIM.maxVideoBytes / 1048576) + ' MB.');
      onStatus && onStatus('Lese Video …');
      pack.video = typed(await ve.read(), ve.path);
      pack.videoName = baseOf(ve.path);
      pack.videoDur = await probeVideo(pack.video);
      if (!pack.videoDur) throw new Error('Dein Browser kann dieses Video nicht abspielen (Format nicht unterstützt).');
      const be = mine.find((e) => BACK_RE.test(baseOf(e.path)));
      if (be) pack.backing = typed(await be.read(), be.path);
      const iconName = String(meta.icon || 'icon.png').toLowerCase();
      const ie = mine.find((e) => baseOf(e.path).toLowerCase() === iconName) || mine.find((e) => /^icon\.(png|jpe?g|webp)$/i.test(baseOf(e.path)));
      if (ie) pack.iconBlob = typed(await ie.read(), ie.path);
      out.push(pack);
    }
    return out;
  }

  async function entriesFromZip(blob, depth = 0) {
    if (blob.size > LIM.maxZipBytes) throw new Error('ZIP ist größer als ' + Math.round(LIM.maxZipBytes / 1048576) + ' MB.');
    const zip = await JSZip.loadAsync(blob);
    const entries = [];
    let total = 0;
    zip.forEach((path, file) => {
      if (file.dir) return;
      const size = (file._data && file._data.uncompressedSize) || 0;
      total += size;
      entries.push({ path, size, read: () => file.async('blob') });
    });
    if (entries.length > 20000 || total > 2.5e9) throw new Error('ZIP enthält zu viele oder zu große Dateien.');
    if (depth < 1) {
      for (const e of entries.slice()) {
        if (/\.zip$/i.test(e.path) && e.size < LIM.maxZipBytes) {
          try { const inner = await entriesFromZip(await e.read(), depth + 1); const pre = dirOf(e.path); inner.forEach((i) => entries.push({ ...i, path: (pre ? pre + '/' : '') + stem(baseOf(e.path)) + '/' + i.path })); } catch { /* ignore */ }
        }
      }
    }
    return entries;
  }

  /* ---------- IndexedDB ---------- */
  const idb = {
    db: null,
    open() {
      if (idb.db) return Promise.resolve(idb.db);
      return new Promise((res, rej) => {
        try {
          // Alter Projektname; bleibt, damit bereits gespeicherte Packs erhalten bleiben
          const r = indexedDB.open('stimmenduell', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('packs', { keyPath: 'id' });
          r.onsuccess = () => { idb.db = r.result; res(idb.db); };
          r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      });
    },
    async tx(mode, fn) {
      const db = await idb.open();
      return new Promise((res, rej) => { const t = db.transaction('packs', mode); const r = fn(t.objectStore('packs')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    },
    put(pack) {
      const clean = { ...pack, _backBuf: undefined, iconUrl: undefined };
      return idb.tx('readwrite', (s) => s.put(clean));
    },
    all() { return idb.tx('readonly', (s) => s.getAll()); },
    del(id) { return idb.tx('readwrite', (s) => s.delete(id)); }
  };

  function hydrate(pack) {
    pack.iconUrl = pack.iconBlob ? URL.createObjectURL(pack.iconBlob) : null;
    return pack;
  }

  VD.Packs = Object.assign(new VD.Emitter(), {
    list: [],
    selId: VD.store.get('packSel', null),

    async init() {
      this.list = [];
      try {
        const saved = await idb.all();
        (saved || []).filter((p) => p.kind === 'dub' && p.lines).sort((a, b) => a.createdAt - b.createdAt).forEach((p) => this.list.push(hydrate(p)));
      } catch (e) { console.warn('IndexedDB nicht verfügbar – Packs gelten nur für diese Sitzung', e); }
      this.emit('change');
    },

    current() { return this.list.find((p) => p.id === this.selId) || this.list[this.list.length - 1] || null; },
    select(id) { this.selId = id; VD.store.set('packSel', id); this.emit('change'); },

    async _add(packs) {
      for (const p of packs) {
        hydrate(p);
        this.list.push(p);
        try { await idb.put(p); } catch (e) { VD.toast('Pack „' + p.name + '“ konnte nicht dauerhaft gespeichert werden (Speicher voll?). Es gilt nur für diese Sitzung.', 'warn'); }
      }
      if (packs.length) { this.selId = packs[packs.length - 1].id; VD.store.set('packSel', this.selId); }
      this.emit('change');
      return packs;
    },

    /* Dateien aus <input>, Drag&Drop oder Ordnerauswahl */
    async importFiles(files, onStatus) {
      files = Array.from(files);
      const added = [];
      const loose = [], folder = [];
      for (const f of files) {
        if (/\.zip$/i.test(f.name)) {
          onStatus && onStatus('Entpacke ' + f.name + ' …');
          const packs = await buildPacks(await entriesFromZip(f), stem(f.name), onStatus);
          if (!packs.length) throw new Error('„' + f.name + '“ ist kein Dub-Pack (dub_video und .ini-Dateien fehlen).');
          added.push(...(await this._add(packs)));
        } else if (f.webkitRelativePath) folder.push({ path: f.webkitRelativePath, size: f.size, read: async () => f });
        else loose.push({ path: f.name, size: f.size, read: async () => f });
      }
      for (const group of [folder, loose]) {
        if (!group.length) continue;
        const packs = await buildPacks(group, 'Dub-Pack', onStatus);
        if (!packs.length) { if (!added.length) throw new Error('Das ist kein Dub-Pack. Ziehe die ZIP-Datei oder den ganzen Pack-Ordner hinein.'); }
        else added.push(...(await this._add(packs)));
      }
      return added;
    },

    async remove(id) {
      const p = this.list.find((x) => x.id === id);
      if (!p) return;
      this.list = this.list.filter((x) => x.id !== id);
      if (p.iconUrl) URL.revokeObjectURL(p.iconUrl);   // Vorschaubild freigeben
      try { await idb.del(id); } catch { /* ignore */ }
      this.emit('change');
    },

    _cache: new Map(),
    async getBuffer(line) {
      if (this._cache.has(line.id)) return this._cache.get(line.id);
      await VD.audio.ensure();
      const buf = await VD.audio.decode(await line.blob.arrayBuffer());
      this._cache.set(line.id, buf);
      if (this._cache.size > 40) this._cache.delete(this._cache.keys().next().value);
      return buf;
    },

    async getBacking(pack) {
      if (!pack.backing) return null;
      if (pack._backBuf) return pack._backBuf;
      try { await VD.audio.ensure(); pack._backBuf = await VD.audio.decode(await pack.backing.arrayBuffer()); }
      catch { pack.backing = null; }
      return pack._backBuf || null;
    }
  });
})();
