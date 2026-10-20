/* Clip-Packs: Import aus ZIP / Ordner / Einzeldateien / Link, Speicherung in IndexedDB.
   Erwartet das bekannte Community-Format: ein Ordner mit WAV/MP3/OGG-Zeilen, optional
   Bilder mit gleichem Namen, _pack_filler_image / _icon, bei Dub-Packs dub_video.* und _backing_track.*
   Zusätzlich: ganz normale Videodateien (mp4, webm, …) werden zu "Video-Packs" – die Spieler vertonen sie frei. */
(function () {
  const VD = (window.VD = window.VD || {});
  const CFG = window.VD_CONFIG;
  const LIM = CFG.limits;

  const AUDIO_EXT = /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac)$/i;
  const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
  const SPECIAL = /^(_backing_track|dub_video)\./i;
  const WRAP = /^(audio|sounds?|clips?|samples?|voices?|wav|ogg|mp3|dub|lines)$/i;

  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const stem = (n) => n.replace(/\.[^.]+$/, '');
  const keyOf = (s) => stem(baseOf(String(s))).toLowerCase();
  const natural = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

  function normEntry(e) {
    let p = String(e.path).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    const segs = p.split('/');
    if (segs.includes('__MACOSX') || segs.some((s) => s.startsWith('.')) || /^(thumbs\.db|desktop\.ini)$/i.test(baseOf(p))) return null;
    return { path: p, size: e.size || 0, read: e.read };
  }

  function titleFrom(base, dub) {
    let s = stem(base), start = null;
    if (dub) {
      const m = s.match(/[_-](\d+)-(\d{1,3})$/);
      if (m) { start = parseInt(m[1], 10) + parseInt(m[2], 10) / Math.pow(10, m[2].length); s = s.slice(0, m.index); }
    }
    s = s.replace(/^\d+[\s._-]+/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s || stem(base);
    return { title: s.charAt(0).toUpperCase() + s.slice(1), start };
  }

  /* Best-Effort: unbekannte Metadaten-JSONs (der Editor im Original speichert intern) auswerten */
  function applyMeta(pack, json) {
    const pick = (o, keys) => { for (const k of keys) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim(); return null; };
    const byKey = new Map(pack.clips.map((c) => [keyOf(c.file), c]));
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const nm = pick(json, ['name', 'title', 'pack_name', 'packName', 'display_name', 'displayName', 'heading']);
      if (nm) pack.name = nm.slice(0, 60);
      const au = pick(json, ['author', 'creator', 'author_name', 'authorName', 'by']);
      if (au) pack.author = au.slice(0, 40);
      const ds = pick(json, ['description', 'desc', 'readme', 'about']);
      if (ds) pack.desc = ds.slice(0, 300);
    }
    const visit = (node, hint, depth) => {
      if (node == null || depth > 6) return;
      if (Array.isArray(node)) { node.forEach((n) => visit(n, null, depth + 1)); return; }
      if (typeof node !== 'object') return;
      let clip = null;
      for (const k of ['file', 'filename', 'file_name', 'path', 'sample', 'clip', 'name', 'id']) {
        if (typeof node[k] === 'string') { clip = byKey.get(keyOf(node[k])); if (clip) break; }
      }
      if (!clip && hint) clip = byKey.get(keyOf(hint));
      if (clip) {
        const cap = pick(node, ['caption', 'subtitle', 'subtitles', 'text', 'line', 'quote', 'transcript', 'display_name', 'displayName', 'title']);
        if (cap && !clip.caption) clip.caption = cap.slice(0, 160);
        for (const k of ['start', 'start_time', 'startTime', 'timestamp', 'time', 'dub_start']) if (typeof node[k] === 'number') { clip.start = node[k]; break; }
      }
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') visit(v, k, depth + 1);
    };
    visit(json, null, 0);
  }

  const guessMime = (n) => {
    const e = (n.match(/\.([^.]+)$/) || [])[1];
    return ({ wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ogv: 'video/ogg', mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4' })[(e || '').toLowerCase()] || '';
  };
  const typed = (blob, name) => (blob.type ? blob : new Blob([blob], { type: guessMime(name) }));

  /* Länge einer Videodatei lesen (0 = nicht abspielbar in diesem Browser) */
  function probeVideo(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const u = URL.createObjectURL(blob);
      let fin = false;
      const done = (d) => { if (fin) return; fin = true; URL.revokeObjectURL(u); v.removeAttribute('src'); try { v.load(); } catch { /* ignore */ } resolve(d); };
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => done(isFinite(v.duration) ? v.duration : 0);
      v.onerror = () => done(0);
      setTimeout(() => done(0), 10000);
      v.src = u;
    });
  }

  async function buildVideoPack(entries, fallbackName, onStatus) {
    const vids = entries.filter((e) => VIDEO_EXT.test(e.path) && !SPECIAL.test(baseOf(e.path)));
    if (!vids.length) return null;
    vids.sort((a, b) => natural.compare(a.path, b.path));
    const pack = { id: 'p_' + VD.uid(), name: fallbackName.replace(/_+/g, ' ').slice(0, 60), author: '', desc: '', kind: 'video', clips: [], iconBlob: null, fillerBlob: null, video: null, backing: null, createdAt: Date.now() };
    let n = 0, bad = 0;
    for (const e of vids.slice(0, 60)) {
      if (e.size && e.size > LIM.maxVideoBytes) { bad++; continue; }
      onStatus && onStatus(`Lese Video ${++n}/${Math.min(vids.length, 60)} …`);
      const blob = typed(await e.read(), e.path);
      const dur = await probeVideo(blob);
      if (dur < 2) { bad++; continue; }
      pack.clips.push({ id: 'c_' + VD.uid(), file: baseOf(e.path), title: titleFrom(baseOf(e.path), false).title, caption: '', start: null, blob, imgBlob: null, dur, isVideo: true });
    }
    pack.skipped = bad;
    return pack.clips.length ? pack : (bad ? { failed: bad } : null);
  }

  async function buildPacks(rawEntries, fallbackName, onStatus) {
    const entries = rawEntries.map(normEntry).filter(Boolean);
    const audio = entries.filter((e) => AUDIO_EXT.test(e.path) && !SPECIAL.test(baseOf(e.path)));
    const groups = new Map();
    for (const e of audio) {
      const root = (() => { const segs = dirOf(e.path) ? dirOf(e.path).split('/') : []; while (segs.length && WRAP.test(segs[segs.length - 1])) segs.pop(); return segs.join('/'); })();
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(e);
    }
    const near = (root, re) => {
      let best = null, bestScore = 9;
      for (const e of entries) {
        if (!re.test(baseOf(e.path))) continue;
        const d = dirOf(e.path);
        const sc = d === root ? 0 : root && d.startsWith(root + '/') ? 1 : d === '' || root.startsWith(d + '/') ? 2 : 9;
        if (sc < bestScore) { best = e; bestScore = sc; }
      }
      return best;
    };
    const out = [];
    for (const [root, list] of groups) {
      list.sort((a, b) => natural.compare(a.path, b.path));
      const videoE = near(root, /^dub_video\.(ogv|mp4|webm|m4v)$/i);
      const backE = near(root, /^_backing_track\.[a-z0-9]+$/i);
      const iconE = near(root, /^_icon\.(png|jpe?g|webp|gif)$/i) || near(root, /^_pack_filler_image\.(png|jpe?g|webp|gif)$/i);
      const fillerE = near(root, /^_pack_filler_image\.(png|jpe?g|webp|gif)$/i);
      const imgByKey = new Map();
      for (const e of entries) if (IMG_EXT.test(e.path) && !baseOf(e.path).startsWith('_')) imgByKey.set(dirOf(e.path) + '/' + keyOf(e.path), e);
      const rawName = root ? baseOf(root) : fallbackName;
      const pack = {
        id: 'p_' + VD.uid(), name: rawName.replace(/[_]+/g, ' ').slice(0, 60), author: '', desc: '', kind: videoE ? 'dub' : 'voice',
        clips: [], iconBlob: null, fillerBlob: null, video: null, backing: null, createdAt: Date.now()
      };
      let done = 0;
      for (const e of list.slice(0, LIM.maxClipsPerPack)) {
        if (e.size && e.size > LIM.maxClipBytes) continue;
        onStatus && onStatus(`Lese ${pack.name}: ${++done}/${Math.min(list.length, LIM.maxClipsPerPack)}`);
        const blob = typed(await e.read(), e.path);
        if (blob.size > LIM.maxClipBytes || blob.size < 64) continue;
        const { title, start } = titleFrom(baseOf(e.path), !!videoE);
        const img = imgByKey.get(dirOf(e.path) + '/' + keyOf(e.path));
        pack.clips.push({ id: 'c_' + VD.uid(), file: baseOf(e.path), title, caption: '', start, blob, imgBlob: img ? typed(await img.read(), img.path) : null });
        if (done % 8 === 0) await VD.sleep(0);
      }
      if (!pack.clips.length) continue;
      if (videoE) pack.video = typed(await videoE.read(), videoE.path);
      if (backE) pack.backing = typed(await backE.read(), backE.path);
      if (iconE) pack.iconBlob = typed(await iconE.read(), iconE.path);
      if (fillerE) pack.fillerBlob = typed(await fillerE.read(), fillerE.path);
      for (const e of entries) {
        if (!/\.json$/i.test(e.path) || (e.size && e.size > 2e6)) continue;
        const d = dirOf(e.path);
        if (!(d === root || (root && d.startsWith(root + '/')) || d === '')) continue;
        try { applyMeta(pack, JSON.parse(await (await e.read()).text())); } catch { /* unbekanntes Format -> ignorieren */ }
      }
      out.push(pack);
    }
    const vp = await buildVideoPack(entries, groups.size || fallbackName === 'Eigene Clips' ? 'Eigene Videos' : fallbackName, onStatus);
    if (vp && vp.failed) throw new Error('Das Video lässt sich in diesem Browser nicht abspielen. Mit MP4 (H.264) oder WebM klappt es am zuverlässigsten.');
    if (vp) out.push(vp);
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
      const clean = { ...pack, _backBuf: undefined, iconUrl: undefined, fillerUrl: undefined, clips: pack.clips.map((c) => ({ ...c, imgUrl: undefined })) };
      return idb.tx('readwrite', (s) => s.put(clean));
    },
    all() { return idb.tx('readonly', (s) => s.getAll()); },
    del(id) { return idb.tx('readwrite', (s) => s.delete(id)); }
  };

  function hydrate(pack) {
    const u = (b) => (b ? URL.createObjectURL(b) : null);
    pack.iconUrl = u(pack.iconBlob); pack.fillerUrl = u(pack.fillerBlob);
    pack.clips.forEach((c) => { c.imgUrl = u(c.imgBlob); });
    return pack;
  }

  /* ---------- Link-Import ---------- */
  class BlockedError extends Error { constructor(msg, url) { super(msg); this.code = 'blocked'; this.url = url; } }

  async function fetchWithProgress(url, onProgress) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body || !onProgress) return r.blob();
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (got > LIM.maxZipBytes) throw new Error('Datei zu groß');
      onProgress(got, total);
    }
    return new Blob(parts, { type: r.headers.get('content-type') || '' });
  }

  async function fetchViaRoutes(url, onProgress) {
    const routes = [];
    const proxied = (base) => base + (base.includes('?') ? '' : '?url=') + encodeURIComponent(url);
    if (CFG.proxyUrl) routes.push(proxied(CFG.proxyUrl));
    routes.push(url);
    if (/^https?:$/.test(location.protocol)) routes.push(proxied('/proxy'));
    let last = null;
    for (const r of routes) {
      try { return await fetchWithProgress(r, onProgress); } catch (e) { last = e; }
    }
    throw new BlockedError('Der Browser darf diese Adresse nicht direkt laden (CORS).', url);
  }

  const isZipBlob = async (b) => { const h = new Uint8Array(await b.slice(0, 4).arrayBuffer()); return h[0] === 0x50 && h[1] === 0x4b; };

  const Packs = (VD.Packs = Object.assign(new VD.Emitter(), {
    list: [],
    enabled: VD.store.get('packsEnabled', {}),
    isEnabled(p) { return this.enabled[p.id] !== false; },
    setEnabled(p, on) { this.enabled[p.id] = !!on; VD.store.set('packsEnabled', this.enabled); this.emit('change'); },

    async init() {
      this.list = [this._demo()];
      try {
        const saved = await idb.all();
        (saved || []).sort((a, b) => a.createdAt - b.createdAt).forEach((p) => this.list.push(hydrate(p)));
      } catch (e) { console.warn('IndexedDB nicht verfügbar – Packs gelten nur für diese Sitzung', e); }
      this.emit('change');
    },

    _demo() {
      return {
        id: 'demo', builtin: true, name: 'Demo-Stimmen', author: 'Stimmenduell', kind: 'demo',
        desc: '12 synthetische Stimm-Clips zum Sofort-Loslegen.',
        clips: VD.DEMO_SPECS.map((s) => ({ id: 'demo_' + s.id, title: s.title, caption: s.caption, file: s.id, spec: s, start: null }))
      };
    },

    async _add(packs) {
      for (const p of packs) {
        hydrate(p);
        this.list.push(p);
        try { await idb.put(p); } catch (e) { VD.toast('Pack „' + p.name + '“ konnte nicht dauerhaft gespeichert werden (Speicher voll?). Es gilt nur für diese Sitzung.', 'warn'); }
      }
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
          if (!packs.length) throw new Error('„' + f.name + '“ enthält weder Sprach-Clips (WAV, MP3, OGG) noch Videos (MP4, WebM).');
          added.push(...(await this._add(packs)));
        } else if (f.webkitRelativePath) folder.push({ path: f.webkitRelativePath, size: f.size, read: async () => f });
        else loose.push({ path: f.name, size: f.size, read: async () => f });
      }
      if (folder.length) {
        const packs = await buildPacks(folder, 'Ordner-Pack', onStatus);
        if (!packs.length) throw new Error('Im Ordner wurden weder Sprach-Clips noch Videos gefunden.');
        added.push(...(await this._add(packs)));
      }
      if (loose.length) {
        const packs = await buildPacks(loose, 'Eigene Clips', onStatus);
        if (!packs.length) { if (!added.length) throw new Error('Keine unterstützten Dateien (ZIP, Video wie MP4 oder WebM, Audio wie WAV, MP3, OGG).'); }
        else added.push(...(await this._add(packs)));
      }
      return added;
    },

    /* GameBanana-Seite (…/mods/123), Download-Link (…/dl/123) oder direkte ZIP-Adresse */
    async importFromUrl(input, onStatus) {
      let url;
      try { url = new URL(input.trim()); } catch { throw new Error('Das ist keine gültige Adresse.'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Nur http(s)-Adressen sind erlaubt.');
      const targets = [];
      const m = url.pathname.match(/^\/(mods|sounds|tools|wips)\/(\d+)/i);
      if (/(^|\.)gamebanana\.com$/i.test(url.hostname) && m) {
        const model = { mods: 'Mod', sounds: 'Sound', tools: 'Tool', wips: 'Wip' }[m[1].toLowerCase()];
        onStatus && onStatus('Frage GameBanana nach den Dateien …');
        const apiUrl = `https://gamebanana.com/apiv11/${model}/${m[2]}/DownloadPage`;
        const jsonBlob = await fetchViaRoutes(apiUrl);
        let info; try { info = JSON.parse(await jsonBlob.text()); } catch { throw new Error('GameBanana hat keine lesbare Antwort geliefert.'); }
        for (const f of (info._aFiles || []).slice(0, 4)) {
          if (/\.zip$/i.test(f._sFile || '') && f._sDownloadUrl && (!f._nFilesize || f._nFilesize < LIM.maxZipBytes)) targets.push({ url: f._sDownloadUrl, name: f._sFile });
        }
        if (!targets.length) throw new Error('Auf dieser Seite gibt es keine ZIP-Datei zum Laden.');
      } else targets.push({ url: url.href, name: baseOf(url.pathname) || 'pack.zip' });

      const added = [];
      for (const t of targets) {
        const blob = await fetchViaRoutes(t.url, (got, total) => onStatus && onStatus(`Lade ${t.name}: ${(got / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`));
        if (!(await isZipBlob(blob))) throw new Error('Die Antwort ist keine ZIP-Datei.');
        onStatus && onStatus('Entpacke …');
        const packs = await buildPacks(await entriesFromZip(blob), stem(t.name), onStatus);
        if (!packs.length) throw new Error('Keine Clips oder Videos in „' + t.name + '“ gefunden.');
        added.push(...(await this._add(packs)));
      }
      return added;
    },

    async remove(id) {
      const p = this.list.find((x) => x.id === id);
      if (!p || p.builtin) return;
      this.list = this.list.filter((x) => x.id !== id);
      try { await idb.del(id); } catch { /* ignore */ }
      this.emit('change');
    },

    _cache: new Map(),
    async getBuffer(clip) {
      if (this._cache.has(clip.id)) return this._cache.get(clip.id);
      await VD.audio.ensure();
      let buf;
      if (clip.spec) buf = await VD.synthClip(clip.spec);
      else buf = await VD.audio.decode(await clip.blob.arrayBuffer());
      this._cache.set(clip.id, buf);
      if (this._cache.size > 10) this._cache.delete(this._cache.keys().next().value);
      return buf;
    },

    async getBacking(pack) {
      if (!pack.backing) return null;
      if (pack._backBuf) return pack._backBuf;
      try { await VD.audio.ensure(); pack._backBuf = await VD.audio.decode(await pack.backing.arrayBuffer()); }
      catch { pack.backing = null; }
      return pack._backBuf || null;
    },

    enabledClips() {
      const out = [];
      for (const p of this.list) if (this.isEnabled(p)) for (const c of p.clips) out.push({ pack: p, clip: c });
      return out;
    }
  }));
  VD.PackErrors = { BlockedError };
})();
