/* Szene: aus einem Dub-Pack wird ein Spielplan.
   - jede Zeile hat Charakter, Zeitstempel im Video und Länge der Originalaufnahme
   - Charaktere werden auf Spieler verteilt (bei mehr Spielern als Charakteren gibt es mehrere "Fassungen")
   - Der fertige Mix legt alle Aufnahmen auf die Zeitachse des Videos                         */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const SR = A.SR;
  const LEAD = 0.6, TRAIL = 0.6;       // Sekunden Vor- und Nachlauf um eine Zeile
  const Scene = (VD.Scene = {});

  const toI16 = (f) => new Uint8Array(VD.f32ToI16(f).buffer);

  /* Pack -> Szene (dekodiert alle Zeilen einmal) */
  Scene.build = async function (pack, onStatus) {
    await VD.audio.ensure();
    const lines = [];
    let n = 0;
    for (const l of pack.lines) {
      onStatus && onStatus(`Bereite Zeile ${++n}/${pack.lines.length} vor …`);
      const buf = await VD.Packs.getBuffer(l);
      const mono = VD.audio.toMono(buf);
      const v24 = await VD.audio.resample(mono, buf.sampleRate, SR);
      const v16 = await VD.audio.resample(mono, buf.sampleRate, 16000);
      lines.push({ idx: lines.length, id: l.id, caption: l.caption, char: l.char, ts: l.ts, dur: buf.duration, v24, v16, imgBlob: l.imgBlob, imgUrl: l.imgUrl });
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
    return { id: VD.uid(), pack, title: pack.name, author: pack.author, dur, lines, chars: pack.chars.slice(), back24, back16 };
  };

  /* Zeilen auf Spieler verteilen. mode: 'random' | 'order'
     - Gleich viele oder weniger Spieler als Charaktere: Charaktere werden so verteilt, dass alle
       ungefähr gleich viele Zeilen haben (ein Spieler kann mehrere Charaktere sprechen).
     - Mehr Spieler als Charaktere: Die Zeilen eines Charakters werden auf mehrere Spieler aufgeteilt.
     Es gibt immer genau eine Fassung der Szene. */
  Scene.assign = function (scene, recs, mode) {
    const players = mode === 'order' ? recs.slice() : VD.shuffle(recs);
    const P = players.length;
    players.forEach((p) => { p.assign = { chars: [], lineIdx: [], ver: 0 }; });
    scene.versions = 1;
    const byChar = new Map();
    scene.chars.forEach((c) => byChar.set(c, scene.lines.filter((l) => l.char === c).map((l) => l.idx)));
    const chars = scene.chars.filter((c) => byChar.get(c).length).sort((x, y) => byChar.get(y).length - byChar.get(x).length);
    const C = chars.length;
    const give = (p, c, idxs) => { if (!p.assign.chars.includes(c)) p.assign.chars.push(c); p.assign.lineIdx.push(...idxs); };
    if (P <= C) {
      // größte Charaktere zuerst an den Spieler mit den bisher wenigsten Zeilen
      chars.forEach((c) => { const p = players.reduce((m, q) => (q.assign.lineIdx.length < m.assign.lineIdx.length ? q : m)); give(p, c, byChar.get(c)); });
    } else {
      // jeder Charakter bekommt einen Spieler, die übrigen gehen an den Charakter mit den meisten Zeilen pro Spieler
      const cnt = new Map(chars.map((c) => [c, 1]));
      for (let k = C; k < P; k++) {
        let best = null, bestVal = 0;
        chars.forEach((c) => { const n = byChar.get(c).length, v = n / cnt.get(c); if (cnt.get(c) < n && v > bestVal) { best = c; bestVal = v; } });
        if (!best) break;                      // mehr Spieler als Zeilen: der Rest schaut zu
        cnt.set(best, cnt.get(best) + 1);
      }
      let pi = 0;
      chars.forEach((c) => {
        const idxs = byChar.get(c), k = cnt.get(c);
        let at = 0;
        for (let j = 0; j < k; j++) {
          const take = Math.floor(idxs.length / k) + (j < idxs.length % k ? 1 : 0);   // fast gleich große Stücke, in Reihenfolge
          give(players[pi++], c, idxs.slice(at, at + take)); at += take;
        }
      });
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

  /* Fertiger Mix einer Fassung (Float32 @ SR). takes: Map<Spieler, Map<Zeile, {raw}>> */
  Scene.finalMix = function (scene, ver, recs) {
    const n = Math.round(scene.dur * SR);
    const out = new Float32Array(n);
    if (scene.back24) for (let i = 0; i < n; i++) out[i] = (scene.back24[i] || 0) * 0.4;
    for (const l of scene.lines) {
      const owner = recs.find((p) => p.assign && p.assign.ver === ver && p.assign.lineIdx.includes(l.idx));
      const take = owner && owner.takes && owner.takes.get(l.idx);
      const src = take ? take.raw : l.v24;                       // ohne Aufnahme: Originalstimme
      const at = Math.round((take ? l.s0 : l.ts) * SR);
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
