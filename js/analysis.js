/* ------------------------------------------------------------------
   Signalanalyse (reines JS, ohne DOM -> auch in Node testbar)
   - Normalisierung (Lautstärke-Angleich)
   - Ausrichten einer Aufnahme auf die Szenen-Zeitachse
   - Wellenform-Spitzen für die Anzeige
------------------------------------------------------------------- */
(function (root) {
  'use strict';
  const A = {};
  const TWO_PI = Math.PI * 2;

  A.SR = 24000; // Übertragungs- und Analyse-Samplerate

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const log10 = Math.log10 || ((v) => Math.log(v) / Math.LN10);

  /* Hochpass 1. Ordnung (entfernt Gleichanteil & Brummen) */
  A.highpass = function (x, sr, fc) {
    const y = new Float32Array(x.length);
    const rc = 1 / (TWO_PI * (fc || 80));
    const dt = 1 / sr;
    const a = rc / (rc + dt);
    let py = 0, px = x.length ? x[0] : 0;
    for (let i = 0; i < x.length; i++) {
      const v = a * (py + x[i] - px);
      y[i] = v; py = v; px = x[i];
    }
    return y;
  };

  A.percentile = function (arr, p) {
    if (!arr.length) return 0;
    const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
    return s[clamp(Math.floor(p * (s.length - 1)), 0, s.length - 1)];
  };

  /* RMS in dB pro Frame (hopN Samples, Fenster = 1.5 * hop) */
  A.envDb = function (x, hopN) {
    const win = Math.round(hopN * 1.5);
    const n = Math.max(0, Math.floor(x.length / hopN));
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const s = f * hopN, e = Math.min(x.length, s + win);
      let sum = 0;
      for (let i = s; i < e; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / Math.max(1, e - s));
      out[f] = 20 * log10(rms + 1e-9);
    }
    return out;
  };

  A.zcrFrames = function (x, hopN) {
    const n = Math.max(0, Math.floor(x.length / hopN));
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const s = f * hopN, e = Math.min(x.length, s + hopN);
      let c = 0;
      for (let i = s + 1; i < e; i++) if ((x[i - 1] >= 0) !== (x[i] >= 0)) c++;
      out[f] = c / Math.max(1, e - s - 1);
    }
    return out;
  };

  /* Lautstärke-Normalisierung: misst den Pegel nur auf "aktiven" Frames
     (Sprache), hebt leise Stimmen an, begrenzt Spitzen weich. */
  A.normalize = function (x, sr, opt) {
    const o = Object.assign({ targetDb: -20, peakDb: -1.5, maxGainDb: 40, minGainDb: -24 }, opt);
    const y = A.highpass(x, sr, 80);
    const hopN = Math.round(sr * 0.02);
    const db = A.envDb(y, hopN);
    if (db.length < 3) return { data: y, gainDb: 0, levelDb: -120, silent: true, noiseDb: -120 };
    const noise = A.percentile(db, 0.2);
    const maxDb = A.percentile(db, 0.98);
    const thr = Math.max(noise + 8, maxDb - 35, -62);
    let pow = 0, cnt = 0;
    for (let i = 0; i < db.length; i++) if (db[i] > thr) { pow += Math.pow(10, db[i] / 10); cnt++; }
    const silent = cnt < 3 || maxDb < -58 || maxDb - noise < 8;
    if (silent) return { data: y, gainDb: 0, levelDb: maxDb, silent: true, noiseDb: noise };
    const level = 10 * log10(pow / cnt);
    const gainDb = clamp(o.targetDb - level, o.minGainDb, o.maxGainDb);
    const g = Math.pow(10, gainDb / 20);
    const lim = Math.pow(10, o.peakDb / 20), knee = lim * 0.7, span = lim - knee;
    for (let i = 0; i < y.length; i++) {
      let v = y[i] * g;
      const a = Math.abs(v);
      if (a > knee) v = Math.sign(v) * (knee + span * Math.tanh((a - knee) / span));
      y[i] = v;
    }
    return { data: y, gainDb, levelDb: level, silent: false, noiseDb: noise };
  };

  A.peaks = function (x, n) {
    const out = new Float32Array(n);
    if (!x.length) return out;
    const step = x.length / n;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * step), e = Math.max(s + 1, Math.floor((i + 1) * step));
      let m = 0;
      for (let k = s; k < e && k < x.length; k++) { const v = Math.abs(x[k]); if (v > m) m = v; }
      out[i] = m;
    }
    return out;
  };

  /* Aufnahme so zuschneiden, dass sie an der Referenz ausgerichtet ist.
     nudge > 0: Aufnahme wird später abgespielt. */
  A.alignTake = function (take, lag, nudge, outLen) {
    const out = new Float32Array(outLen);
    const off = lag - (nudge || 0);
    for (let i = 0; i < outLen; i++) {
      const k = i + off;
      out[i] = k >= 0 && k < take.length ? take[k] : 0;
    }
    return out;
  };

  root.VDA = A;
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
