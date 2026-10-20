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

  /* Charaktere auf Spieler verteilen. mode: 'random' | 'order'
     Weniger Spieler als Charaktere: ein Spieler spricht mehrere Charaktere.
     Mehr Spieler als Charaktere: es entstehen mehrere "Fassungen" derselben Szene. */
  Scene.assign = function (scene, recs, mode) {
    const players = mode === 'order' ? recs.slice() : VD.shuffle(recs);
    const C = scene.chars.length, P = players.length;
    players.forEach((p) => { p.assign = { chars: [], lineIdx: [], ver: 0 }; });
    scene.versions = Math.max(1, Math.ceil(P / C));
    if (P <= C) scene.chars.forEach((c, k) => players[k % P].assign.chars.push(c));
    else players.forEach((p, j) => { p.assign.chars.push(scene.chars[j % C]); p.assign.ver = Math.floor(j / C); });
    scene.lines.forEach((l) => players.forEach((p) => { if (p.assign.chars.includes(l.char)) p.assign.lineIdx.push(l.idx); }));
    return players;
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
