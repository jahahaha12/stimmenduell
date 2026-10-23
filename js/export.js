/* Fertige Szene speichern: Video (MP4, wenn der Browser es kann, sonst WebM; wird in Echtzeit aufgezeichnet) oder nur Ton (WAV). Läuft auf Host und Handys. */
(function () {
  const VD = (window.VD = window.VD || {});
  const X = (VD.Export = {});

  X.save = (blob, name) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  };
  X.name = (title) => (title || 'Dub Together').replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '_') + '_DubTogether';

  X.wav = (f32, sr, name) => {
    const n = f32.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
    X.save(new Blob([buf], { type: 'audio/wav' }), name + '.wav');
  };

  /* o: { videoUrl, mime, f32, sr, name, onProgress(%) } – ohne videoUrl wird nur ein schwarzes Bild aufgezeichnet */
  X.videoRec = async (o) => {
    if (!window.MediaRecorder) throw new Error('Dieser Browser kann keine Videos aufzeichnen. Nutze „Nur Ton“.');
    let v = null, ac = null, raf = 0;
    try {
      const W = 640, H = 480, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      if (o.videoUrl && (await VD.Video.ready(o.mime))) {
        v = VD.Video.create(o.videoUrl, o.mime, '');
        v.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;opacity:0;pointer-events:none;z-index:-1';
        document.body.appendChild(v);
      }
      const draw = () => {
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        if (v) {
          const src = v.isOgv ? v.querySelector('canvas') : v;
          const sw = v.isOgv ? (src && src.width) : v.videoWidth, sh = v.isOgv ? (src && src.height) : v.videoHeight;
          if (src && sw && sh) { const k = Math.min(W / sw, H / sh); g.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k); }
        }
        raf = requestAnimationFrame(draw);
      };
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ac.createMediaStreamDestination();
      const ab = ac.createBuffer(1, o.f32.length, o.sr); ab.copyToChannel(o.f32, 0);
      const src = ac.createBufferSource(); src.buffer = ab; src.connect(dest);
      const stream = cv.captureStream(30); dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : undefined);
      const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((res) => (rec.onstop = res));
      await ac.resume(); if (v) await VD.Video.seek(v, 0);
      draw(); rec.start(500);
      if (v) await v.play();
      src.start();
      const t0 = performance.now(), total = o.f32.length / o.sr;
      await new Promise((res) => { const iv = setInterval(() => { const s = (performance.now() - t0) / 1000; o.onProgress && o.onProgress(Math.min(99, Math.round((s / total) * 100))); if (s >= total + 0.3) { clearInterval(iv); res(); } }, 250); });
      rec.stop(); await stopped;
      const type = rec.mimeType || mime || 'video/webm';
      X.save(new Blob(chunks, { type }), o.name + (type.includes('mp4') ? '.mp4' : '.webm'));
    } finally {
      cancelAnimationFrame(raf);
      if (v) { try { v.pause(); v.remove(); } catch { /* ignore */ } }
      if (ac) { try { ac.close(); } catch { /* ignore */ } }
    }
  };


  const loadMuxer = () => window.Mp4Muxer ? Promise.resolve(true) : new Promise((res) => {
    const s = document.createElement('script'); s.src = 'vendor/mp4-muxer.js'; s.onload = () => res(!!window.Mp4Muxer); s.onerror = () => res(false); document.head.appendChild(s);
  });
  const W = 640, H = 480;

  /* Bevorzugt: echte MP4-Datei (WebCodecs + mp4-muxer). Spulen, Länge und Vorschau funktionieren überall. */
  X.videoMp4 = async (o) => {
    if (!window.VideoEncoder || !window.AudioEncoder || !window.VideoFrame || !window.AudioData) return false;
    if (!(await loadMuxer())) return false;
    const vCfgs = [['avc', 'avc1.42001f'], ['vp9', 'vp09.00.10.08']], aCfgs = [['aac', 'mp4a.40.2'], ['opus', 'opus']];
    let vc = null, ac = null;
    for (const [n, c] of vCfgs) { try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: 2500000, framerate: 30 })).supported) { vc = [n, c]; break; } } catch { /* nächster */ } }
    for (const [n, c] of aCfgs) { try { if ((await AudioEncoder.isConfigSupported({ codec: c, sampleRate: o.sr, numberOfChannels: 1, bitrate: 128000 })).supported) { ac = [n, c]; break; } } catch { /* nächster */ } }
    if (!vc || !ac) return false;
    let v = null, raf = 0, ve = null, ae = null;
    try {
      const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: vc[0], width: W, height: H }, audio: { codec: ac[0], numberOfChannels: 1, sampleRate: o.sr }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
      let err = null;
      ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (err = e) });
      ve.configure({ codec: vc[1], width: W, height: H, bitrate: 2500000, framerate: 30 });
      ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (err = e) });
      ae.configure({ codec: ac[1], sampleRate: o.sr, numberOfChannels: 1, bitrate: 128000 });
      // Ton direkt kodieren (geht sofort)
      for (let i = 0; i < o.f32.length; i += 4800) {
        const part = o.f32.slice(i, i + 4800);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: o.sr, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((i / o.sr) * 1e6), data: part });
        ae.encode(ad); ad.close();
      }
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      if (o.videoUrl && (await VD.Video.ready(o.mime))) {
        v = VD.Video.create(o.videoUrl, o.mime, '');
        v.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;opacity:0;pointer-events:none;z-index:-1';
        document.body.appendChild(v);
        await VD.Video.seek(v, 0);
      }
      const drawFrame = () => {
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        if (!v) return;
        const src = v.isOgv ? v.querySelector('canvas') : v;
        const sw = v.isOgv ? (src && src.width) : v.videoWidth, sh = v.isOgv ? (src && src.height) : v.videoHeight;
        if (src && sw && sh) { const k = Math.min(W / sw, H / sh); g.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k); }
      };
      if (v) { await v.play(); const w0 = performance.now(); while (performance.now() - w0 < 900 && v.currentTime < 0.03) await new Promise((r) => setTimeout(r, 8)); }
      const total = o.f32.length / o.sr, t0 = performance.now() - (v ? v.currentTime * 1000 : 0);
      let n = 0, last = -1;
      await new Promise((res, rej) => {
        const tick = () => {
          if (err) return rej(err);
          // Bildzeit kommt vom Video selbst, damit Bild und Ton exakt zusammenpassen
          const t = v ? v.currentTime : (performance.now() - t0) / 1000;
          if (t >= total || (performance.now() - t0) / 1000 > total + 3) return res();
          if (t - last >= 1 / 30 - 0.004 && t >= 0 && ve.encodeQueueSize < 8) {
            last = t; drawFrame();
            const f = new VideoFrame(cv, { timestamp: n === 0 ? 0 : Math.round(t * 1e6) });
            ve.encode(f, { keyFrame: n++ % 60 === 0 }); f.close();
            o.onProgress && o.onProgress(Math.min(99, Math.round((t / total) * 100)));
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      });
      await ve.flush(); await ae.flush(); muxer.finalize();
      X.save(new Blob([muxer.target.buffer], { type: 'video/mp4' }), o.name + '.mp4');
      return true;
    } finally {
      cancelAnimationFrame(raf);
      if (v) { try { v.pause(); v.remove(); } catch { /* ignore */ } }
      try { ve && ve.state !== 'closed' && ve.close(); ae && ae.state !== 'closed' && ae.close(); } catch { /* ignore */ }
    }
  };

  X.video = async (o) => {
    try { if (await X.videoMp4(o)) return; } catch (e) { console.warn('MP4-Export fehlgeschlagen, nutze Aufzeichnung', e); }
    return X.videoRec(o);
  };

  /* Knopfzeile mit beiden Download-Knöpfen. get() liefert { videoUrl, mime, f32, sr, title } */
  X.buttons = (get) => {
    const h = VD.h;
    let busy = false;
    const vb = h('button', { class: 'btn' }, 'Als Video speichern');
    vb.onclick = async () => {
      if (busy) return; const d = get(); if (!d) return;
      busy = true; vb.disabled = true;
      try { await X.video({ videoUrl: d.videoUrl, mime: d.mime, f32: d.f32, sr: d.sr, name: X.name(d.title), onProgress: (p) => (vb.textContent = `Speichere … ${p} %`) }); VD.toast('Video gespeichert.', 'ok'); }
      catch (e) { console.warn('Export', e); VD.toast('Speichern hat nicht geklappt: ' + (e.message || e), 'warn'); }
      busy = false; vb.disabled = false; vb.textContent = 'Als Video speichern';
    };
    const wb = h('button', { class: 'btn link' }, 'Nur Ton');
    wb.onclick = () => { const d = get(); if (d) X.wav(d.f32, d.sr, X.name(d.title)); };
    return h('div', { class: 'row center dl-row' }, h('span', { class: 'dl-pair' }, vb, wb));
  };
})();
