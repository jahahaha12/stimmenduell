/* Szenen: aus den Packs wird pro Runde eine Szene zusammengestellt.
   Eine Szene = ein stummes Bild (Video oder Bühne) + Zeitachse mit Zeilen, die je ein Spieler spricht.
   - Dub-Pack mit Video:  aufeinanderfolgende Zeilen des Videos (Original-Stimmen bleiben stumm)
   - Video-Pack:          ein ganzes Video, alle vertonen frei
   - Sprach-Pack/Demo:    Zeilen werden hintereinander gesetzt, gezeigt auf einer Bühne mit Sprechblasen */
(function () {
  const VD = (window.VD = window.VD || {});
  const h = VD.h;
  const rnd = (n) => Math.floor(Math.random() * n);
  const LEAD = 1.0, TAIL = 1.0, GAP = 0.9;

  const Scene = (VD.Scene = {});

  function weighted(packs) {
    let total = packs.reduce((a, p) => a + p.clips.length, 0);
    let r = Math.random() * total;
    for (const p of packs) { r -= p.clips.length; if (r <= 0) return p; }
    return packs[packs.length - 1];
  }

  /* ---------- Zusammenstellen ---------- */
  Scene.pick = async function (S, nRec, used) {
    const packs = VD.Packs.list.filter((p) => VD.Packs.isEnabled(p) && p.clips.length);
    if (!packs.length) return null;
    const want = VD.clamp(Math.max(3, nRec), 2, 8);
    const maxS = S.maxScene;
    for (let attempt = 0; attempt < 14; attempt++) {
      const pack = weighted(packs);
      let scene = null;
      try {
        if (pack.kind === 'video') scene = videoScene(pack, maxS, used);
        else {
          const timed = pack.video ? pack.clips.filter((c) => c.start != null).sort((a, b) => a.start - b.start) : [];
          scene = timed.length >= 2 ? await dubScene(pack, timed, want, maxS, used) : await voiceScene(pack, want, maxS, used);
        }
      } catch (e) { console.warn('Szene übersprungen', e); }
      if (scene) { used.add(scene.key); return scene; }
    }
    // alles schon benutzt -> von vorn
    if (used.size) { used.clear(); return Scene.pick(S, nRec, used); }
    return null;
  };

  function videoScene(pack, maxS, used) {
    const cands = pack.clips.filter((c) => c.isVideo && c.dur >= 2 && !used.has(pack.id + ':' + c.id));
    if (!cands.length) return null;
    const c = cands[rnd(cands.length)];
    return { id: VD.uid(), key: pack.id + ':' + c.id, title: c.title, packName: pack.name, free: true, lines: [], dur: Math.min(c.dur, maxS), video: { blob: c.blob, start: 0 }, backing: null };
  }

  async function dubScene(pack, timed, want, maxS, used) {
    // lieber an einer Stelle beginnen, ab der noch genug Zeilen folgen
    const maxStart = Math.max(0, timed.length - want);
    let order = timed.map((_, i) => i).filter((i) => i <= maxStart && !used.has(pack.id + ':' + timed[i].id));
    if (!order.length) order = timed.map((_, i) => i).filter((i) => !used.has(pack.id + ':' + timed[i].id));
    if (!order.length) return null;
    const i0 = order[rnd(order.length)];
    const lines = [];
    let prevEnd = null;
    for (let k = i0; k < timed.length && lines.length < want; k++) {
      const c = timed[k];
      const buf = await VD.Packs.getBuffer(c);
      const end = c.start + buf.duration;
      if (lines.length && (end - lines[0].abs > maxS - LEAD - TAIL || c.start - prevEnd > 8)) break;
      lines.push({ abs: c.start, absEnd: end, text: c.caption || c.title });
      prevEnd = end;
    }
    if (!lines.length) return null;
    const ws = Math.max(0, lines[0].abs - LEAD);
    const dur = lines[lines.length - 1].absEnd + TAIL - ws;
    lines.forEach((l) => { l.s = l.abs - ws; l.e = l.absEnd - ws; });
    return { id: VD.uid(), key: pack.id + ':' + timed[i0].id, title: pack.name, packName: pack.name, free: false, lines, dur,
      video: { blob: pack.video, start: ws }, backing: pack.backing ? { pack, start: ws } : null };
  }

  async function voiceScene(pack, want, maxS, used) {
    let pool = VD.shuffle(pack.clips.filter((c) => !c.isVideo && !used.has(pack.id + ':' + c.id)));
    if (pool.length < Math.min(2, pack.clips.length)) pool = VD.shuffle(pack.clips.filter((c) => !c.isVideo));
    const lines = [];
    let t = LEAD;
    for (const c of pool) {
      if (lines.length >= want) break;
      const buf = await VD.Packs.getBuffer(c);
      if (lines.length >= 2 && t + buf.duration + TAIL > maxS) continue;
      lines.push({ s: t, e: t + buf.duration, text: c.caption || c.title, clipId: c.id });
      t += buf.duration + GAP;
    }
    if (lines.length < 1) return null;
    const dur = lines[lines.length - 1].e + TAIL;
    return { id: VD.uid(), key: pack.id + ':' + lines.map((l) => l.clipId).join(','), title: pack.name, packName: pack.name, free: false, lines, dur, video: null, backing: null,
      cover: pack.fillerUrl || pack.iconUrl || null };
  }

  /* ---------- Rollen ---------- */
  Scene.assign = function (scene, recs) {
    recs.forEach((p) => { p.role = null; });
    if (scene.free) { recs.forEach((p, i) => { p.role = { free: true, idx: i, label: 'Figur ' + (i + 1), lines: [] }; }); return; }
    const order = VD.shuffle(recs.slice());
    scene.lines.forEach((l, i) => {
      const p = order[i % order.length];
      l.pid = p.pid;
      if (!p.role) p.role = { free: false, idx: i, label: '', lines: [] };
      p.role.lines.push(l);
    });
  };

  /* Was ein Spieler als Hinweis bekommt (Handy) */
  Scene.cueFor = function (scene, p) {
    const others = scene.lines.filter((l) => l.pid !== p.pid).map((l) => ({ s: l.s, e: l.e }));
    return { total: Math.round(scene.dur * 1000), free: !!scene.free, mine: p.role ? p.role.lines.map((l) => ({ s: l.s, e: l.e, text: l.text })) : [], others, label: p.role ? p.role.label : '' };
  };

  /* ---------- Mischen ---------- */
  function maskFor(lines, n, sr) {
    const pad = 0.45, f = Math.max(1, Math.round(0.08 * sr));
    const g = new Float32Array(n);
    for (const l of lines) {
      const a = Math.max(0, Math.round((l.s - pad) * sr)), b = Math.min(n, Math.round((l.e + pad) * sr));
      for (let i = a; i < b; i++) { const w = Math.min(1, (i - a) / f, (b - i) / f); if (w > g[i]) g[i] = w; }
    }
    return g;
  }

  /* subs: Spieler mit p.aligned (auf die Szenenzeit ausgerichtet). Stimmen außerhalb der eigenen Zeilen werden stumm geschaltet. */
  Scene.mixdown = function (scene, subs, outLen, sr) {
    const out = new Float32Array(outLen);
    for (const p of subs) {
      const a = p.aligned;
      if (!a) continue;
      let g = null;
      if (!scene.free && p.role) { if (!p._mask || p._mask.length !== outLen) p._mask = maskFor(p.role.lines, outLen, sr); g = p._mask; }
      for (let i = 0; i < outLen; i++) out[i] += g ? a[i] * g[i] : a[i];
    }
    let peak = 0;
    for (let i = 0; i < outLen; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
    if (peak > 0.9) { const k = 0.9 / peak; for (let i = 0; i < outLen; i++) out[i] *= k; }
    return out;
  };

  /* ---------- Bild: Video oder Bühne ---------- */
  Scene.visual = function (scene, cast) {
    const castList = Array.from(cast.values());
    const byPid = cast;
    const el = h('div', { class: 'sv' });
    const sub = h('div', { class: 'sv-sub', 'aria-live': 'off' });
    let mode = 'stage', video = null, stageEl = null, avatars = new Map();
    let playing = false, t0 = 0, endTimer = null, url = null;

    function buildStage() {
      mode = 'stage';
      const row = h('div', { class: 'sv-cast' });
      avatars = new Map();
      const shown = scene.free ? castList : castList.filter((p) => scene.lines.some((l) => l.pid === p.pid));
      shown.forEach((p) => { const a = h('div', { class: 'sv-who', style: { '--c': p.color } }, VD.ui.avatar(p, 'xl'), h('b', { text: p.name })); avatars.set(p.pid, a); row.append(a); });
      stageEl = h('div', { class: 'sv-stage' }, scene.cover ? h('img', { class: 'sv-cover', src: scene.cover, alt: '' }) : null, h('div', { class: 'sv-title', text: scene.title }), row);
      el.replaceChildren(stageEl, sub);
    }

    if (scene.video && scene.video.blob) {
      try {
        url = URL.createObjectURL(scene.video.blob);
        video = h('video', { class: 'sv-video', playsinline: true, preload: 'auto' });
        video.muted = true; video.defaultMuted = true; video.controls = false;
        video.src = url;
        video.addEventListener('error', () => { if (mode === 'video') { video = null; buildStage(); } });
        mode = 'video';
        el.replaceChildren(video, sub);
      } catch (e) { buildStage(); }
    } else buildStage();

    const ready = new Promise((res) => {
      if (mode !== 'video') return res();
      const ok = () => res();
      video.addEventListener('loadeddata', ok, { once: true });
      video.addEventListener('error', ok, { once: true });
      setTimeout(ok, 6000);
    });

    const seek = (t) => new Promise((res) => {
      if (!video) return res();
      if (Math.abs(video.currentTime - t) < 0.04 && video.readyState >= 2) return res();
      const on = () => { video.removeEventListener('seeked', on); res(); };
      video.addEventListener('seeked', on);
      try { video.currentTime = t; } catch { res(); }
      setTimeout(res, 1500);
    });

    const api = {
      el, mode: () => mode,
      ready,
      async prepare() { await ready; if (mode === 'video') await seek(scene.video.start); },
      async play() {
        clearTimeout(endTimer);
        await ready;
        if (mode === 'video' && video) {
          await seek(scene.video.start);
          try { await video.play(); } catch (e) { console.warn('Video startet nicht', e); }
        }
        playing = true; t0 = performance.now();
        endTimer = setTimeout(() => api.stop(), scene.dur * 1000 + 250);
      },
      stop() {
        clearTimeout(endTimer);
        playing = false;
        if (video) { try { video.pause(); video.currentTime = scene.video.start; } catch { /* ignore */ } }
      },
      time() {
        if (!playing) return 0;
        if (mode === 'video' && video) return Math.min(scene.dur, Math.max(0, video.currentTime - scene.video.start));
        return Math.min(scene.dur, (performance.now() - t0) / 1000);
      },
      isPlaying: () => playing,
      /* Untertitel + Sprecher hervorheben */
      tick() {
        const t = api.time();
        let active = null;
        if (playing) for (const l of scene.lines) if (t >= l.s - 1.2 && t <= l.e) { active = l; break; }
        avatars.forEach((a, pid) => a.classList.toggle('talk', !!active && active.pid === pid && t >= active.s));
        if (!active) { sub.replaceChildren(); sub.classList.remove('on'); sub._k = null; return; }
        const k = active.s + ':' + active.pid;
        sub.classList.add('on'); sub.classList.toggle('soon', t < active.s);
        if (sub._k !== k) {
          sub._k = k;
          const p = byPid.get(active.pid);
          sub.replaceChildren(h('span', { class: 'who', style: { '--c': p ? p.color : '#888' }, text: p ? p.name : '' }), h('span', { class: 'txt', text: '„' + active.text + '“' }));
        }
      },
      destroy() { api.stop(); if (url) URL.revokeObjectURL(url); url = null; }
    };
    return api;
  };
})();
