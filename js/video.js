/* Video-Wiedergabe. Chrome und Edge spielen Ogg/Theora (das Format der Dub-Packs) nicht mehr ab.
   Dann wird ogv.js (WebAssembly-Decoder, vendor/ogv) als Ersatz geladen. Das Video ist immer stumm,
   der Ton kommt aus der Web-Audio-Ausgabe des Spiels. */
(function () {
  const VD = (window.VD = window.VD || {});
  const V = (VD.Video = {});
  let loading = null;
  // ogv.js bricht beim Springen interne Downloads ab; das ist normal und kein Fehler
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r && r.name === 'AbortError' && /ogv-/.test(r.stack || '')) e.preventDefault(); });

  const isOgg = (mime) => /ogg|ogv|theora/i.test(mime || '');
  V.native = (mime) => { try { return !!document.createElement('video').canPlayType(isOgg(mime) ? 'video/ogg; codecs="theora"' : (mime || '')); } catch { return false; } };

  function loadOgv() {
    if (window.OGVPlayer) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'vendor/ogv/ogv-es2017.js';
      s.onload = () => {
        try { window.OGVLoader.base = 'vendor/ogv'; resolve(!!window.OGVPlayer && (!window.OGVCompat || window.OGVCompat.supported('OGVPlayer'))); }
        catch { resolve(false); }
      };
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return loading;
  }

  /* Vorbereiten: true, wenn dieses Video hier abspielbar ist */
  V.ready = async (mime) => {
    if (V.native(mime)) return true;
    if (isOgg(mime)) return loadOgv();
    return false;
  };

  /* Videoelement erzeugen (V.ready vorher aufrufen) */
  V.create = (url, mime, cls) => {
    let v;
    if (!V.native(mime) && isOgg(mime) && window.OGVPlayer) {
      v = new window.OGVPlayer({ worker: true, webGL: false });
      v.muted = true;
      v.className = cls || '';
      v.src = url;
      v.isOgv = true;
    } else {
      v = document.createElement('video');
      v.className = cls || ''; v.playsInline = true; v.preload = 'auto';
      v.muted = true; v.defaultMuted = true; v.src = url;
    }
    return v;
  };

  /* Seitenverhältnis aus dem Theora-Header (Ogg), 0 wenn unbekannt */
  V.aspect = (bytes) => {
    try {
      const n = Math.min(bytes.length - 40, 4096);
      for (let i = 0; i < n; i++) {
        if (bytes[i] === 0x80 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x65 && bytes[i + 4] === 0x6f && bytes[i + 5] === 0x72 && bytes[i + 6] === 0x61) {
          const o = i + 7 + 3 + 4; // Signatur, Version, FMBW/FMBH
          const w = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
          const h = (bytes[o + 3] << 16) | (bytes[o + 4] << 8) | bytes[o + 5];
          const p = o + 6 + 2 + 8; // PICX, PICY, FRN, FRD
          const pn = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
          const pd = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
          if (w && h) return (w * (pn && pd ? pn / pd : 1)) / h;
        }
      }
    } catch { /* ignore */ }
    return 0;
  };

  /* Länge in Sekunden, 0 = nicht abspielbar */
  V.probe = async (blob) => {
    const mime = blob.type || '';
    if (!(await V.ready(mime))) return 0;
    return new Promise((resolve) => {
      const u = URL.createObjectURL(blob);
      const v = V.create(u, mime);
      let fin = false;
      const done = (d) => { if (fin) return; fin = true; try { v.pause(); } catch { /* ignore */ } URL.revokeObjectURL(u); if (v.isOgv) { try { v.stop && v.stop(); } catch { /* ignore */ } } else { v.removeAttribute('src'); } resolve(d); };
      // ogv.js kennt die Länge ohne Server-Index oft nicht (0): Video ist trotzdem abspielbar
      v.addEventListener('loadedmetadata', () => done(isFinite(v.duration) && v.duration > 0 ? v.duration : 1));
      v.addEventListener('error', () => done(0));
      setTimeout(() => done(0), 15000);
    });
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Bild und Ton gemeinsam starten und im Gleichlauf halten.
     Das Video braucht einen Moment, bis es wirklich läuft (besonders mit ogv.js); der Ton startet erst dann
     und gleicht Startverzögerung sowie die Ausgabe-Latenz des Audiogeräts aus.
     makeAudio(offset, delay) startet den Ton und liefert { stop, elapsed } (oder null ohne Ton). */
  V.syncPlay = async (v, from, makeAudio, opt = {}) => {
    if (v.isOgv && v.hidden) V.clear(v);   // nur wenn unsichtbar: ein sichtbares Video würde sonst schwarz
    const ctx = VD.audio && VD.audio.ctx, outLat = (ctx && ctx.outputLatency) || 0;
    let off = 0, vt0 = from, handle = null, firstCheck = 0.6;
    if (opt.inMs != null) {
      // Gemeinsamer Start: Der Ton beginnt zum vereinbarten Zeitpunkt T (hörbar, also abzüglich der Geräte-Latenz),
      // das Video wird vorher bereitgestellt und kurz davor gestartet. Der Gleichlauf-Check holt den Rest nach.
      const T = performance.now() + opt.inMs;
      await V.seek(v, from);
      const wait = T - performance.now() - 40;
      if (wait > 0) await sleep(wait);
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      const delay = Math.max(0.005, (T - performance.now()) / 1000 - outLat);
      handle = makeAudio ? makeAudio(0, delay) : null;
      firstCheck = 0.3;
    } else {
      await V.seek(v, from); await v.play();
      const t0 = performance.now();
      while (performance.now() - t0 < 900 && v.currentTime < from + 0.03) await sleep(8);
      vt0 = v.currentTime;
      const delay = 0.03;
      off = Math.max(0, vt0 - from) + delay + outLat;
      handle = makeAudio ? makeAudio(off, delay) : null;
    }
    let iv = 0;
    if (handle) {
      iv = setInterval(() => {
        const e = handle.elapsed();
        if (e < firstCheck + outLat) return;
        const want = from + off + (e - outLat) + 0.05;      // kleiner Vorlauf, weil ein Sprung selbst etwas dauert
        if (Math.abs(v.currentTime - (want - 0.05)) > 0.1) { try { v.currentTime = want; } catch { /* ignore */ } }
      }, 300);
    }
    return { handle, vt0, off, stop() { clearInterval(iv); } };
  };

  /* Auf eine Position springen und warten, bis das Bild da ist */
  /* Bildfläche leeren, damit kein Rest vom vorigen Abspielen stehen bleibt (ogv.js zeichnet nur Änderungen) */
  V.clear = (v) => {
    try {
      const c = v && v.querySelector && v.querySelector('canvas');
      if (!c) return;
      const g2 = c.getContext('2d');
      if (g2) { g2.fillStyle = '#000'; g2.fillRect(0, 0, c.width, c.height); return; }
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    } catch { /* ignore */ }
  };

  /* Wartet, bis nach dem Start wirklich ein frisches Bild läuft (sonst blitzt kurz ein altes Bild auf) */
  V.frameReady = async (v, t) => {
    const t0 = performance.now();
    while (performance.now() - t0 < 700 && !(v.currentTime >= t + 0.12)) await sleep(12);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };

  V.seek = (v, t) => new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.04 && v.readyState >= 2) return res();
    const on = () => { v.removeEventListener('seeked', on); res(); };
    v.addEventListener('seeked', on);
    try { v.currentTime = t; } catch { res(); }
    setTimeout(res, 2500);
  });
})();
