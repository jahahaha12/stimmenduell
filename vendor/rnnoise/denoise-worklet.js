/* AudioWorklet: Hintergrundgeräusche mit RNNoise unterdrücken.
   RNNoise arbeitet mit 48 kHz in Blöcken zu 480 Werten (10 ms). Läuft der Audio-Kontext mit einer anderen
   Rate, wird hier hin und her umgerechnet. Die feste Verzögerung wird per Nachricht gemeldet. */
const FRAME = 480, RATE = 48000;

class Lin {                         // einfacher Umrechner (lineare Interpolation) für Sprache
  constructor(step) { this.step = step; this.pos = 0; this.prev = 0; }
  feed(x, emit) { while (this.pos < 1) { emit(this.prev + (x - this.prev) * this.pos); this.pos += this.step; } this.pos -= 1; this.prev = x; }
}

class VdDenoise extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const o = (opt && opt.processorOptions) || {};
    this.ok = false;
    try {
      const imports = { a: { a: (n) => { try { this.mem.grow(Math.ceil((n - this.mem.buffer.byteLength) / 65536)); this.refresh(); return 1; } catch (e) { return 0; } },
                              b: (d, s, n) => { new Uint8Array(this.mem.buffer).copyWithin(d, s, s + n); } } };
      const inst = new WebAssembly.Instance(o.module, imports);
      const x = inst.exports;
      this.mem = x.c; this.x = x; x.d();            // d: Initialisierung, e: init, f: create, g: malloc, h: destroy, i: free, j: process
      this.state = x.f();
      this.ptr = x.g(FRAME * 4);
      this.refresh();
      this.ok = !!this.state && !!this.ptr;
    } catch (e) { this.ok = false; }
    this.sr = sampleRate;
    this.same = Math.abs(this.sr - RATE) < 1;
    this.up = this.same ? null : new Lin(this.sr / RATE);       // sr -> 48 kHz
    this.down = this.same ? null : new Lin(RATE / this.sr);     // 48 kHz -> sr
    this.inBuf = new Float32Array(FRAME); this.n = 0;
    this.ring = new Float32Array(16384); this.rd = 0; this.wr = 0;
    this.margin = this.same ? 0 : 8;                             // kleiner Vorrat gegen Lücken beim Umrechnen
    this.first = true;
    // RNNoise selbst verzögert um einen Block (Überlappung), dazu kommt der Eingangsblock: zusammen 20 ms
    this.latency = (2 * FRAME) / RATE + this.margin / this.sr;
    this.port.postMessage({ ready: this.ok, latency: this.latency });
  }
  refresh() { this.f32 = new Float32Array(this.mem.buffer); }
  push(v) { this.ring[this.wr & 16383] = v; this.wr++; }
  frame() {
    const p = this.ptr >> 2;
    if (this.f32.buffer !== this.mem.buffer) this.refresh();
    const g = this.f32;
    for (let i = 0; i < FRAME; i++) g[p + i] = this.inBuf[i] * 32768;
    this.x.j(this.state, this.ptr, this.ptr);
    if (this.first) { this.first = false; for (let i = 0; i < this.margin; i++) this.push(0); }
    const out = this.f32;
    for (let i = 0; i < FRAME; i++) {
      const v = out[p + i] / 32768;
      if (this.same) this.push(v); else this.down.feed(v, (y) => this.push(y));
    }
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.ok) { if (inp) out.set(inp); return true; }
    for (let i = 0; i < out.length; i++) {
      out[i] = this.wr > this.rd ? this.ring[this.rd++ & 16383] : 0;
      const x = inp ? inp[i] : 0;
      const take = (v) => { this.inBuf[this.n++] = v; if (this.n === FRAME) { this.n = 0; this.frame(); } };
      if (this.same) take(x); else this.up.feed(x, take);
    }
    return true;
  }
}
registerProcessor('vd-denoise', VdDenoise);
