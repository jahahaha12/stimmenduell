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
      v = new window.OGVPlayer({ worker: true });
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

  /* Auf eine Position springen und warten, bis das Bild da ist */
  V.seek = (v, t) => new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.04 && v.readyState >= 2) return res();
    const on = () => { v.removeEventListener('seeked', on); res(); };
    v.addEventListener('seeked', on);
    try { v.currentTime = t; } catch { res(); }
    setTimeout(res, 2500);
  });
})();
