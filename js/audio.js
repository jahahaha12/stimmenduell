/* Web-Audio-Schicht: Kontext, Mikrofon (AudioWorklet), Wiedergabe, Effekte */
(function () {
  const VD = (window.VD = window.VD || {});

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
        case 'submit': T(600, 900, 0.12, 'triangle', 0.2); break;
        case 'whoosh': T(180, 1400, 0.35, 'sawtooth', 0.07); break;
        case 'score': T(523, 523, 0.1, 'triangle', 0.22); T(659, 659, 0.1, 'triangle', 0.22, 0.08); T(784, 784, 0.18, 'triangle', 0.22, 0.16); break;
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
      this.peak = 0; this.running = false; this.sr = 48000;
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
      this.node.connect(this.sink);
      this.src.connect(this.node);
      this.running = true;
      await this._initDenoise(ctx);
      if (VD.Denoise) VD.Denoise.attach(this);
    }
    /* Rauschunterdrückung (RNNoise): Mikro -> dn -> Aufnahme. Ausschalten leitet das Mikro direkt zur Aufnahme.
       Bei einem Fehler läuft alles ohne Unterdrückung weiter (dnReady bleibt false). */
    async _initDenoise(ctx) {
      this.dn = null; this.dnReady = false; this.denoise = false; this.dnLatMs = 0;
      if (!ctx.audioWorklet || !window.WebAssembly || !this.node) return;
      try {
        if (!ctx._vdDn) {
          ctx._vdDn = (async () => {
            const r = await fetch('vendor/rnnoise/rnnoise.wasm'); if (!r.ok) throw new Error('wasm ' + r.status);
            const module = await WebAssembly.compile(await r.arrayBuffer());
            await ctx.audioWorklet.addModule('vendor/rnnoise/denoise-worklet.js');
            return module;
          })();
        }
        const module = await ctx._vdDn;
        const dn = new AudioWorkletNode(ctx, 'vd-denoise', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { module } });
        const info = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('Zeitüberschreitung')), 4000); dn.port.onmessage = (e) => { clearTimeout(t); res(e.data); }; });
        if (!info || !info.ready) throw new Error('RNNoise startet nicht');
        dn.connect(this.node);
        this.dn = dn; this.dnReady = true; this.dnLatMs = Math.round(info.latency * 1000);
      } catch (err) { console.warn('Rauschunterdrückung nicht verfügbar', err); this.dn = null; this.dnReady = false; }
    }
    /* Ein- und ausschalten, auch während das Mikro läuft (zwischen den Aufnahmen) */
    setDenoise(on) {
      if (!this.dnReady || !this.src) return false;
      on = !!on;
      try { this.src.disconnect(); } catch { /* ignore */ }
      try { this.src.connect(on ? this.dn : this.node); } catch (e) { try { this.src.connect(this.node); } catch { /* ignore */ } on = false; }
      this.denoise = on;
      return on;
    }
    /* zusätzliche Verzögerung der Rauschunterdrückung in ms (0, wenn aus) */
    get extraLatencyMs() { return this.denoise ? this.dnLatMs : 0; }
    _push(f) {
      this.chunks.push(f); this.len += f.length;
      let pk = 0;
      for (let i = 0; i < f.length; i++) { const a = f[i] < 0 ? -f[i] : f[i]; if (a > pk) pk = a; }
      this.peak = pk;
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
      if (VD.Denoise) VD.Denoise.detach(this);
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { this.src.disconnect(); this.node.disconnect(); this.dn && this.dn.disconnect(); } catch { /* ignore */ }
    }
  };
})();
