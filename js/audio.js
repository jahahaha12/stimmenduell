/* Web-Audio-Schicht: Kontext, Mikrofon (AudioWorklet), Wiedergabe, Effekte, Waveform-Zeichnung */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;

  const audio = (VD.audio = {
    ctx: null,
    async ensure() {
      if (!audio.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audio.ctx = new AC({ latencyHint: 'interactive' });
      }
      if (audio.ctx.state !== 'running') { try { await audio.ctx.resume(); } catch { /* ignore */ } }
      return audio.ctx;
    },
    fromFloat(f32, sr) {
      const b = audio.ctx.createBuffer(1, Math.max(1, f32.length), sr);
      b.copyToChannel(f32, 0);
      return b;
    },
    toMono(buf) {
      if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
      const n = buf.length, out = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
      }
      return out;
    },
    decode(arrayBuffer) {
      return new Promise((res, rej) => {
        const p = audio.ctx.decodeAudioData(arrayBuffer, res, rej);
        if (p && p.catch) p.catch(rej);
      });
    },
    async resample(f32, from, to) {
      if (from === to) return f32;
      const len = Math.max(1, Math.ceil((f32.length * to) / from));
      const off = new OfflineAudioContext(1, len, to);
      const b = off.createBuffer(1, f32.length, from);
      b.copyToChannel(f32, 0);
      const s = off.createBufferSource();
      s.buffer = b; s.connect(off.destination); s.start();
      const r = await off.startRendering();
      return r.getChannelData(0).slice();
    },
    /* Spielt einen AudioBuffer. Gibt {stop(), t0, dur, done:Promise} zurück. */
    play(buffer, o = {}) {
      const ctx = audio.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.value = o.gain == null ? 1 : o.gain;
      src.connect(g); g.connect(o.dest || ctx.destination);
      const t0 = ctx.currentTime + (o.delay || 0.02);
      src.start(t0, o.offset || 0);
      let stopped = false;
      const done = new Promise((r) => { src.onended = () => { stopped = true; r(); }; });
      return {
        t0, dur: buffer.duration - (o.offset || 0), done,
        stop() { if (stopped) return; try { src.stop(); } catch { /* ignore */ } },
        elapsed() { return Math.max(0, ctx.currentTime - t0); }
      };
    }
  });

  /* ------------------------------ Effekte ------------------------------ */
  VD.sfx = {
    enabled: true,
    vol: 0.5,
    _tone(f0, f1, dur, type = 'sine', gain = 0.25, delay = 0) {
      const ctx = audio.ctx;
      if (!ctx || ctx.state !== 'running' || !VD.sfx.enabled) return;
      const t = ctx.currentTime + delay;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const peak = gain * VD.sfx.vol;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    play(name) {
      const T = VD.sfx._tone;
      switch (name) {
        case 'click': T(520, 380, 0.07, 'triangle', 0.18); break;
        case 'join': T(440, 440, 0.09, 'sine', 0.22); T(660, 660, 0.14, 'sine', 0.22, 0.09); break;
        case 'tick': T(880, 880, 0.09, 'square', 0.1); break;
        case 'go': T(1320, 1320, 0.28, 'square', 0.14); T(1760, 1760, 0.3, 'sine', 0.16, 0.02); break;
        case 'submit': T(600, 900, 0.12, 'triangle', 0.2); break;
        case 'whoosh': T(180, 1400, 0.35, 'sawtooth', 0.07); break;
        case 'judge': T(330, 330, 0.12, 'triangle', 0.2); break;
        case 'score': T(523, 523, 0.1, 'triangle', 0.22); T(659, 659, 0.1, 'triangle', 0.22, 0.08); T(784, 784, 0.18, 'triangle', 0.22, 0.16); break;
        case 'vote': T(700, 1000, 0.1, 'sine', 0.22); break;
        case 'error': T(220, 140, 0.25, 'sawtooth', 0.12); break;
        case 'fanfare':
          [523, 659, 784, 1047].forEach((f, i) => T(f, f, 0.22, 'triangle', 0.24, i * 0.11));
          T(1047, 1047, 0.7, 'triangle', 0.22, 0.46); T(784, 784, 0.7, 'sine', 0.14, 0.46);
          break;
        default: break;
      }
    }
  };

  /* ------------------------------ Mikrofon ------------------------------ */
  const WORKLET_SRC = `
class VdRec extends AudioWorkletProcessor {
  constructor(){ super(); this.b = new Float32Array(1024); this.n = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.b[this.n++] = ch[i];
        if (this.n === 1024) { this.port.postMessage(this.b); this.b = new Float32Array(1024); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('vd-rec', VdRec);`;

  /* Das Mikro läuft dauerhaft ("scharf") und füllt einen Ringpuffer. Eine Aufnahme ist nur ein
     Ausschnitt [mark - Vorlauf, Ende]. Dadurch gibt es keine Start-Latenz und kein abgeschnittenes
     Wort, wenn jemand etwas früher losspricht. */
  VD.Mic = class {
    constructor() {
      this.chunks = []; this.base = 0; this.len = 0; this.keep = 0;
      this.peak = 0; this.rms = 0; this.running = false; this.sr = 48000;
    }
    async start() {
      const ctx = await audio.ensure();
      this.ctx = ctx; this.sr = ctx.sampleRate; this.keep = this.sr * 50;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('insecure');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
      this.src = ctx.createMediaStreamSource(this.stream);
      this.sink = ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(ctx.destination);
      try {
        if (!ctx._vdWorklet) {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(url);
          ctx._vdWorklet = true;
        }
        this.node = new AudioWorkletNode(ctx, 'vd-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        this.node.port.onmessage = (e) => this._push(e.data);
      } catch (err) {
        console.warn('AudioWorklet nicht verfügbar, nutze ScriptProcessor', err);
        this.node = ctx.createScriptProcessor(1024, 1, 1);
        this.node.onaudioprocess = (e) => this._push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      this.src.connect(this.node); this.node.connect(this.sink);
      this.running = true;
      this.latencyMs = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000);
    }
    _push(f) {
      this.chunks.push(f); this.len += f.length;
      let s = 0, pk = 0;
      for (let i = 0; i < f.length; i++) { const v = f[i]; s += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      this.rms = Math.sqrt(s / f.length); this.peak = pk;
      while (this.len > this.keep && this.chunks.length > 1) { const c = this.chunks.shift(); this.len -= c.length; this.base += c.length; }
    }
    get total() { return this.base + this.len; }
    mark() { return this.total; }
    slice(a, b) {
      b = b == null ? this.total : b; a = Math.max(a, this.base);
      const out = new Float32Array(Math.max(0, b - a));
      let pos = this.base;
      for (const c of this.chunks) {
        const cs = pos, ce = pos + c.length;
        if (ce > a && cs < b) {
          const from = Math.max(a, cs) - cs, to = Math.min(b, ce) - cs;
          out.set(c.subarray(from, to), Math.max(a, cs) - a);
        }
        pos = ce;
      }
      return out;
    }
    stop() {
      this.running = false;
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { this.src.disconnect(); this.node.disconnect(); } catch { /* ignore */ }
    }
  };

  /* ------------------------------ Waveform ------------------------------ */
  VD.wave = {
    fit(canvas) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    },
    /* Balken-Waveform. o: {progress, color, dim, shift (px), glow, bar, gap, head, mirrorBase} */
    draw(canvas, peaks, o = {}) {
      const { ctx, w, h } = VD.wave.fit(canvas);
      if (!o.keep) ctx.clearRect(0, 0, w, h);
      if (!peaks || !peaks.length) return;
      const bar = o.bar || 3, gap = o.gap == null ? 2 : o.gap, step = bar + gap;
      const bars = Math.max(1, Math.floor((w - 2) / step));
      const color = o.color || '#a97bff';
      const prog = o.progress == null ? 1 : o.progress;
      const shift = o.shift || 0;
      ctx.save();
      if (o.glow) { ctx.shadowColor = color; ctx.shadowBlur = o.glow; }
      for (let i = 0; i < bars; i++) {
        const x = i * step + shift;
        if (x < -bar || x > w) continue;
        const a = Math.floor((i / bars) * peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
        let m = 0;
        for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
        const amp = Math.max(1.5, Math.pow(m, 0.7) * h * 0.46);
        ctx.globalAlpha = (i / bars <= prog ? 1 : (o.dimAlpha == null ? 0.28 : o.dimAlpha)) * (o.alpha == null ? 1 : o.alpha);
        ctx.fillStyle = color;
        const y = h / 2 - amp;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, bar, amp * 2, bar / 2); ctx.fill(); }
        else ctx.fillRect(x, y, bar, amp * 2);
      }
      ctx.restore();
      if (o.head != null) {
        const x = Math.round(o.head * w) + 0.5;
        ctx.save();
        ctx.strokeStyle = '#f4f1ea'; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 4); ctx.stroke();
        ctx.restore();
      }
    }
  };

  /* Live-Waveform (scrollt von rechts nach links), liest Pegel über getLevel() */
  VD.LiveWave = class {
    constructor(canvas, getLevel, color = '#ff4d4d') {
      this.c = canvas; this.get = getLevel; this.color = color; this.vals = []; this.run = false; this._t = 0;
    }
    start() { if (this.run) return; this.run = true; this.vals = []; const loop = (t) => { if (!this.run) return; if (t - this._t > 32) { this._t = t; this.vals.push(this.get()); this.draw(); } requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
    stop() { this.run = false; }
    draw() {
      const { ctx, w, h } = VD.wave.fit(this.c);
      ctx.clearRect(0, 0, w, h);
      const bar = 4, gap = 3, step = bar + gap, n = Math.floor(w / step);
      while (this.vals.length > n) this.vals.shift();
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color; ctx.shadowBlur = 10;
      const off = n - this.vals.length;
      for (let i = 0; i < this.vals.length; i++) {
        const v = Math.min(1, Math.pow(this.vals[i] * 3.2, 0.6));
        const amp = Math.max(2, v * h * 0.46);
        const x = (off + i) * step;
        ctx.globalAlpha = 0.35 + 0.65 * (i / this.vals.length);
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, h / 2 - amp, bar, amp * 2, 2); ctx.fill(); }
        else ctx.fillRect(x, h / 2 - amp, bar, amp * 2);
      }
      ctx.globalAlpha = 1;
    }
  };

  /* Konfetti auf einem Vollbild-Canvas */
  VD.confetti = function (power = 1) {
    if (VD.reducedMotion()) return;
    let c = VD.$('#confetti');
    if (!c) { c = VD.h('canvas', { id: 'confetti' }); document.body.append(c); }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const parts = [];
    const N = Math.round(120 * power);
    for (let i = 0; i < N; i++) {
      parts.push({
        x: innerWidth / 2 + VD.rand(-80, 80), y: innerHeight * 0.55,
        vx: VD.rand(-9, 9), vy: VD.rand(-17, -6), g: VD.rand(0.25, 0.4),
        s: VD.rand(5, 10), r: VD.rand(0, 6), vr: VD.rand(-0.3, 0.3), col: VD.pick(VD.COLORS), life: VD.rand(70, 130)
      });
    }
    let f = 0;
    const loop = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const p of parts) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vx *= 0.99; p.life--;
        if (p.life > 0 && p.y < innerHeight + 20) {
          alive++;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
          ctx.globalAlpha = Math.min(1, p.life / 30); ctx.fillStyle = p.col;
          ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
        }
      }
      if (alive && f++ < 400) requestAnimationFrame(loop); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    loop();
  };
})();
