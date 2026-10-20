/* Allgemeine Helfer. Alles hängt am globalen Objekt VD. */
(function () {
  const VD = (window.VD = window.VD || {});

  VD.$ = (s, r = document) => r.querySelector(s);
  VD.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* DOM-Builder. Texte immer als textContent -> kein XSS durch Spielernamen/Packs. */
  VD.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
        }
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  VD.clear = (el) => { el.replaceChildren(); return el; };
  VD.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  VD.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  VD.lerp = (a, b, t) => a + (b - a) * t;
  VD.ease = (t) => 1 - Math.pow(1 - t, 3);
  VD.rand = (a, b) => a + Math.random() * (b - a);
  VD.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  VD.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  VD.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* localStorage mit try/catch (Privater Modus etc.) */
  VD.store = {
    get(k, d) { try { const v = localStorage.getItem('vd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('vd.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
  };

  /* Base64 für Binärdaten über den JSON-Datenkanal */
  VD.b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x2000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
    return btoa(s);
  };
  VD.unb64 = (str, into, offset) => {
    const bin = atob(str);
    const out = into || new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[(offset || 0) + i] = bin.charCodeAt(i);
    return bin.length;
  };

  VD.f32ToI16 = (f) => {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    return o;
  };
  VD.i16ToF32 = (i16) => {
    const o = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) o[i] = i16[i] / 0x8000;
    return o;
  };

  VD.fmtSec = (s) => (Math.round(s * 10) / 10).toFixed(1).replace('.', ',') + ' s';
  /* Automatische Sync-Korrektur verständlich ausdrücken */
  VD.fmtAuto = (ms) => (Math.abs(ms) < 15 ? 'perfekt im Takt' : Math.abs(Math.round(ms)) + ' ms ' + (ms > 0 ? 'später' : 'früher') + ' gestartet');
  VD.fmtMs = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '±') + Math.abs(Math.round(ms)) + ' ms';

  /* Mini-EventEmitter */
  VD.Emitter = class {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return this; }
    off(ev, fn) { this._l[ev] = (this._l[ev] || []).filter((f) => f !== fn); }
    emit(ev, ...a) { for (const f of (this._l[ev] || []).slice()) { try { f(...a); } catch (e) { console.error(e); } } }
  };

  /* Gate: Phase kann von außen (Host-Button, Ereignis) vorzeitig beendet werden. */
  VD.Gate = class {
    constructor() { this.done = false; this.value = undefined; this.p = new Promise((r) => (this._r = r)); }
    open(v = 'open') { if (!this.done) { this.done = true; this.value = v; this._r(v); } }
    /* wartet auf open() oder Timeout (ms). Gibt den Grund zurück. */
    wait(ms) {
      let t;
      const timer = new Promise((r) => (t = setTimeout(() => r('timeout'), ms)));
      return Promise.race([this.p, timer]).finally(() => clearTimeout(t));
    }
  };

  /* Zahl hochzählen */
  VD.countUp = (el, to, ms = 900, suffix = '') => {
    const from = 0, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = Math.round(VD.lerp(from, to, VD.ease(k))) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* Toast */
  VD.toast = (msg, kind = '') => {
    let box = VD.$('#toasts');
    if (!box) { box = VD.h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
    const t = VD.h('div', { class: 'toast ' + kind, text: msg });
    box.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3800);
  };

  /* Ripple + Press-Feedback für alle .btn */
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn, .chip-btn');
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    const s = VD.h('span', { class: 'ripple' });
    s.style.left = e.clientX - r.left + 'px';
    s.style.top = e.clientY - r.top + 'px';
    b.append(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });

  VD.vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ } };

  VD.AVATARS = ['🎤', '🦊', '🐙', '🦄', '🐸', '🤖', '👻', '🐯', '🦖', '🍕', '🚀', '🎸'];
  /* Kanalfarben wie an einem Mischpult */
  VD.COLORS = ['#ff6b6b', '#ffb454', '#f2e65c', '#5fd68a', '#4fd1e0', '#6aa2ff', '#a98bff', '#ff7ac6'];

  VD.reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
})();
