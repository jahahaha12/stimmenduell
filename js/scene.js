/* Szene: aus einem Dub-Pack wird ein Spielplan.
   - jede Zeile hat Charakter, Zeitstempel im Video und Länge der Originalaufnahme
   - Charaktere werden auf Spieler verteilt (bei mehr Spielern als Charakteren werden die Zeilen aufgeteilt)
   - Der fertige Mix legt alle Aufnahmen auf die Zeitachse des Videos                         */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const SR = A.SR;
  const LEAD = 0.6, TRAIL = 0.6;       // Sekunden Vor- und Nachlauf um eine Zeile
  const Scene = (VD.Scene = {});

  const toI16 = (f) => new Uint8Array(VD.f32ToI16(f).buffer);

  /* Pack -> Szene (dekodiert alle Zeilen einmal) */
  const decoded = new WeakMap();   // pro Pack einmal dekodiert; weitere Runden starten sofort
  Scene.build = async function (pack, onStatus) {
    const hit = decoded.get(pack);
    if (hit) return { id: VD.uid(), pack, title: pack.name, author: pack.author, dur: hit.dur, lines: hit.lines.map((l) => Object.assign({}, l)), chars: pack.chars.slice(), back24: hit.back24, back16: hit.back16 };
    await VD.audio.ensure();
    const lines = [];
    let n = 0;
    for (const l of pack.lines) {
      onStatus && onStatus(`Bereite Zeile ${++n}/${pack.lines.length} vor …`);
      const buf = await VD.Packs.getBuffer(l);
      const mono = VD.audio.toMono(buf);
      const v16 = await VD.audio.resample(mono, buf.sampleRate, 16000);
      lines.push({ idx: lines.length, id: l.id, caption: l.caption, char: l.char, ts: l.ts, dur: buf.duration, v16, imgBlob: l.imgBlob });
    }
    const dur = Math.max(pack.videoDur || 0, ...lines.map((l) => l.ts + l.dur + TRAIL));
    lines.forEach((l) => { l.s0 = Math.max(0, l.ts - LEAD); l.s1 = Math.min(dur, l.ts + l.dur + TRAIL); });
    let back24 = null, back16 = null;
    const bb = await VD.Packs.getBacking(pack);
    if (bb) {
      const m = VD.audio.toMono(bb);
      back24 = await VD.audio.resample(m, bb.sampleRate, SR);
      back16 = await VD.audio.resample(m, bb.sampleRate, 16000);
    }
    decoded.set(pack, { dur, lines, back24, back16 });
    return { id: VD.uid(), pack, title: pack.name, author: pack.author, dur, lines: lines.map((l) => Object.assign({}, l)), chars: pack.chars.slice(), back24, back16 };
  };

  /* Zeilen fair auf Spieler verteilen. mode: 'random' | 'order'
     0. Wunschrollen (p.wish) bekommt der Spieler sicher. Wünschen sich mehrere denselben Charakter, teilen sie ihn.
     1. Die übrigen Charaktere werden ganz verteilt (größte zuerst an den, der bisher am wenigsten hat).
        Ist das fair, bleibt jeder Charakter bei einer Stimme.
     2. Sonst werden Charaktere in zusammenhängende Stücke geteilt, bis alle gleich viele Zeilen haben (höchstens eine Zeile Unterschied).
     Wer schon durch seinen Wunsch mehr hat, bekommt nichts dazu. Bei 'order' bekommt der erste Spieler (der Host) die größte Rolle.
     Mehr Spieler als Zeilen: der Rest schaut zu. */
  Scene.assign = function (scene, recs, mode, useWishes) {
    const players = mode === 'order' ? recs.slice() : VD.shuffle(recs);
    if (!players.length) return players;
    const byChar = new Map();
    scene.chars.forEach((c) => byChar.set(c, scene.lines.filter((l) => l.char === c).map((l) => l.idx)));
    let chars = scene.chars.filter((c) => byChar.get(c).length);
    if (mode !== 'order') chars = VD.shuffle(chars);              // gleich große Charaktere zufällig
    chars.sort((x, y) => byChar.get(y).length - byChar.get(x).length);
    const give = (p, c, idxs) => { if (!idxs.length) return; if (!p.assign.chars.includes(c)) p.assign.chars.push(c); p.assign.lineIdx.push(...idxs); };
    const load = (p) => p.assign.lineIdx.length;

    // 0) Wunschrollen: jeder bekommt seinen Wunsch-Charakter komplett. Nur wenn sonst für Spieler ohne Wunsch
    //    zu wenig übrig bliebe, wird bei den größten Wunsch-Rollen etwas abgezogen (die Zeilen gehen an die anderen).
    const total = chars.reduce((s, c) => s + byChar.get(c).length, 0);
    const wished = new Map();
    if (useWishes !== false && mode !== 'order') players.forEach((p) => { if (p.wish && chars.includes(p.wish)) { if (!wished.has(p.wish)) wished.set(p.wish, []); wished.get(p.wish).push(p); } });
    const want = [];                                          // [Spieler, Charakter, Zeilen laut Wunsch]
    wished.forEach((ps, c) => { const n = byChar.get(c).length; ps.forEach((p, j) => want.push([p, c, Math.floor(n / ps.length) + (j < n % ps.length ? 1 : 0)])); });
    const served = want.filter((w) => w[2] > 0).length;      // Wunsch-Spieler, die wirklich Zeilen ihrer Rolle bekommen
    const room = total - (players.length - served);   // mindestens eine Zeile bleibt für jeden ohne Wunsch übrig
    let cap = Math.max(0, ...want.map((w) => w[2]));
    while (cap > 1 && want.reduce((s, w) => s + Math.min(w[2], cap), 0) > room) cap--;
    const avail = new Map();                                  // Zeilen, die noch zu verteilen sind, je Charakter
    const plan = [];                                          // [Spieler, Charakter, Zeilen]
    chars.forEach((c) => {
      const ps = wished.get(c), idxs = byChar.get(c);
      if (!ps) { avail.set(c, idxs.slice()); return; }
      let at = 0;
      want.filter((w) => w[1] === c).forEach(([p, , k0]) => { const k = Math.min(k0, cap); plan.push([p, c, idxs.slice(at, at + k)]); at += k; });
      if (at < idxs.length) avail.set(c, idxs.slice(at));
    });
    // Gleich viele Charaktere wie Spieler und mindestens ein Wunsch: jeder bekommt genau einen ganzen Charakter
    // (Wunsch-Charakter oder einen der übrigen), ohne Aufteilen. Bei doppelten Wünschen gilt die normale Verteilung.
    if (wished.size && chars.length === players.length && [...wished.values()].every((ps) => ps.length === 1)) {
      players.forEach((p) => { p.assign = { chars: [], lineIdx: [] }; });
      wished.forEach((ps, c) => give(ps[0], c, byChar.get(c)));
      const free = players.filter((p) => !p.assign.chars.length);
      chars.filter((c) => !wished.has(c)).forEach((c, i) => give(free[i], c, byChar.get(c)));
      players.forEach((p) => p.assign.lineIdx.sort((x, y) => x - y));
      return players;
    }
    const start = () => {
      players.forEach((p) => { p.assign = { chars: [], lineIdx: [] }; });
      plan.forEach(([p, c, idxs]) => give(p, c, idxs));
    };
    const rest = chars.filter((c) => avail.has(c));
    start();
    const base = new Map(players.map((p) => [p, load(p)]));
    // Ziel pro Spieler: die übrigen Zeilen auffüllen, immer an den mit den wenigsten (bei Gleichstand in Spieler-Reihenfolge)
    const target = new Map(base);
    let R = rest.reduce((s, c) => s + avail.get(c).length, 0);
    while (R-- > 0) { const p = players.reduce((m, q) => (target.get(q) < target.get(m) ? q : m)); target.set(p, target.get(p) + 1); }
    const full = players.filter((p) => base.get(p) >= target.get(p));   // durch Wunsch schon genug (oder mehr Spieler als Zeilen)
    const fair = () => {
      if (full.some((p) => load(p) !== base.get(p))) return false;
      const open = players.filter((p) => !full.includes(p));
      if (!open.length) return true;
      const l = open.map(load);
      return Math.max(...l) - Math.min(...l) <= 1 && open.every((p) => load(p) > 0);
    };

    // 1) ganze Charaktere
    const open = players.filter((p) => !full.includes(p));
    if (open.length) rest.forEach((c) => { const p = open.reduce((m, q) => (load(q) < load(m) ? q : m)); give(p, c, avail.get(c)); });
    if (!fair()) {
      // 2) aufteilen bis zum Ziel
      start();
      const cap = (p) => target.get(p) - load(p);
      for (const c of rest) {
        let left = avail.get(c).slice();
        while (left.length) {
          const can = players.filter((p) => cap(p) > 0);
          if (!can.length) break;
          // erst wer den ganzen Rest aufnehmen kann (Charakter bleibt zusammen), sonst wer am meisten Platz hat
          const fit = can.filter((p) => cap(p) >= left.length);
          const p = fit.length ? fit.reduce((m, q) => (cap(q) < cap(m) ? q : m)) : can.reduce((m, q) => (cap(q) > cap(m) ? q : m));
          const k = Math.min(cap(p), left.length);
          give(p, c, left.slice(0, k)); left = left.slice(k);
        }
      }
    }
    players.forEach((p) => p.assign.lineIdx.sort((x, y) => x - y));
    return players;
  };

  /* Hüllkurve der Originalstimme einer Zeile über die Zeitachse s0..s1 (0..100), für die Wellenform am Handy */
  Scene.peaks = function (line, n) {
    n = n || 160;
    const out = new Array(n).fill(0), d = (line.s1 - line.s0) / n;
    let mx = 0;
    for (let b = 0; b < n; b++) {
      const t0 = line.s0 + b * d;
      const i0 = Math.max(0, Math.floor((t0 - line.ts) * 16000)), i1 = Math.min(line.v16.length, Math.ceil((t0 + d - line.ts) * 16000));
      let m = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(line.v16[i]); if (v > m) m = v; }
      out[b] = m; if (m > mx) mx = m;
    }
    return out.map((v) => (mx > 0 ? Math.round((v / mx) * 100) : 0));
  };

  /* Originalton einer Zeile für den Knopf "Original": Stimme + Musik/Geräusche, mono 16 kHz */
  Scene.origBytes = function (scene, line) {
    const n = Math.round((line.s1 - line.s0) * 16000);
    const out = new Float32Array(n);
    if (scene.back16) { const o = Math.round(line.s0 * 16000); for (let i = 0; i < n; i++) out[i] = (scene.back16[o + i] || 0) * 0.55; }
    const off = Math.round((line.ts - line.s0) * 16000);
    for (let i = 0; i < line.v16.length && off + i < n; i++) out[off + i] += line.v16[i];
    let pk = 0; for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
    if (pk > 0.95) { const k = 0.95 / pk; for (let i = 0; i < n; i++) out[i] *= k; }
    return toI16(out);
  };

  /* Fertiger Mix (Float32 @ SR): Aufnahmen der Spieler (p.takes: Map<Zeile, {raw}>), fehlende Zeilen bleiben still */
  Scene.finalMix = function (scene, recs) {
    const n = Math.round(scene.dur * SR);
    const out = new Float32Array(n);
    if (scene.back24) for (let i = 0; i < n; i++) out[i] = (scene.back24[i] || 0) * 0.4;
    for (const l of scene.lines) {
      const owner = recs.find((p) => p.assign && p.assign.lineIdx.includes(l.idx));
      const take = owner && owner.takes && owner.takes.get(l.idx);
      if (!take) continue;                                        // ohne Aufnahme bleibt die Zeile still (keine Originalstimme)
      const src = take.raw, at = Math.round(l.s0 * SR);
      for (let i = 0; i < src.length && at + i < n; i++) out[at + i] += src[i];
    }
    let pk = 0; for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
    if (pk > 0.92) { const k = 0.92 / pk; for (let i = 0; i < n; i++) out[i] *= k; }
    return out;
  };

  Scene.videoMime = (pack) => {
    const n = (pack.videoName || '').toLowerCase();
    if (/\.ogv$/.test(n)) return 'video/ogg; codecs="theora"';
    if (/\.webm$/.test(n)) return 'video/webm';
    return 'video/mp4';
  };
})();
