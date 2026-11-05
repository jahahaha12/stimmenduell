/* ------------------------------------------------------------------
   Glas-Effekt für Knöpfe (WebGL-Shader)

   Hinter den Text jedes Knopfes kommt eine kleine Zeichenfläche (<canvas>), auf die der Shader
   eine Glasform malt: Brechung am Rand (Snelliussches Gesetz), leichter Farbsaum, Glanzkante.
   Formeln nach dem Artikel "Liquid Glass in the Browser" (kube.io), Code selbst geschrieben.

   So ist es aufgebaut:
   - Der Shader bricht ein Bild des Seitenhintergrunds (die wandernden Farblichter, siehe paintScene).
   - Ein einziger WebGL-Kontext bedient alle Knöpfe. Gezeichnet wird nur, wenn sich etwas ändert
     (Größe, Zustand, Hover, Fenstergröße), nicht in jedem Bild.
   - Welche Elemente Glas bekommen, steht in SEL. Farbe und Stärke der Tönung stehen im CSS
     (--lg-rgb, --lg-amt, --lg-amt-hover), Zahlen für die Form in config.js (VD_CONFIG.glass).
   - Geht etwas schief (kein WebGL, Kontext verloren), verschwindet das Glas einfach wieder und
     die Knöpfe sehen aus wie vorher.
------------------------------------------------------------------- */
(function () {
  'use strict';
  const VD = (window.VD = window.VD || {});
  const CFG = Object.assign(
    { enabled: true, thick: 50, bezel: 30, ior: 1.5, dispersion: 0.04, blur: 2, specular: 0.4, saturation: 140, rimWidth: 14 },
    (window.VD_CONFIG || {}).glass
  );

  /* Diese Elemente werden Glas. Nicht dabei: Textknöpfe (.link), Schalter, Video und Audiospur.
     Knöpfe und Boxen im Normalfall ("fill"): Das Glas ersetzt den Hintergrund des Elements.
     Schwebende Leisten, Hinweise und Fenster ("rim", im CSS --lg-mode: rim): Sie liegen über anderem Inhalt,
     dessen Weichzeichnung erhalten bleiben soll. Hier malt das Glas nur den Rand, die Mitte bleibt wie sie war. */
  const BUTTONS = '.btn:not(.link), .role, .icon-btn, .seg-b.on, .av-opt';
  const BOXES = '.home-card, .join-card, .panel, .room-chip, .pcard, .code-big span, .cast-card, .pv-card, .ro-card, .h-top, .h-bar, .pc-top, .lobby-foot, .toast, .modal-card, .ch';
  const SEL = BUTTONS + ', ' + BOXES;
  const LIGHT = [-0.6, -0.8];   // Lichtrichtung (oben links)
  const ON = 'glass-on';        // Klasse an Elementen, die gerade Glas tragen

  /* ---------- Shader ---------- */
  const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
  /* u_off/u_view: wo der Knopf im Fenster liegt, damit der passende Ausschnitt des Hintergrunds gebrochen wird. */
  const FS = [
    'precision highp float;',
    'uniform vec2 u_view; uniform vec2 u_off; uniform vec2 u_size; uniform sampler2D u_src;',
    'uniform float u_radius;',
    'uniform float u_thick; uniform float u_bezel; uniform float u_ior; uniform float u_disp;',
    'uniform float u_blur; uniform float u_sat; uniform float u_tint; uniform vec3 u_tintCol;',
    'uniform float u_spec; uniform float u_dpr; uniform vec2 u_light; uniform float u_rimw;',
    'float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }',
    'float sd(vec2 q){ return sdRoundBox(q, u_size * 0.5, u_radius); }',
    'vec2 grad(vec2 q){ vec2 e = vec2(1.0, 0.0); return normalize(vec2(sd(q + e.xy) - sd(q - e.xy), sd(q + e.yx) - sd(q - e.yx)) + vec2(1e-6)); }',
    'vec3 tex(vec2 p){ vec2 w = p + u_off; return texture2D(u_src, vec2(w.x / u_view.x, 1.0 - w.y / u_view.y)).rgb; }',
    'vec2 refr(vec3 N, float ior, float depthZ){',
    '  vec3 R = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / ior);',
    '  return R.xy / max(-R.z, 0.05) * depthZ;',
    '}',
    'void main(){',
    '  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);',
    '  vec2 q = p - u_size * 0.5;',
    '  float d = sd(q);',
    '  if (d > 1.0 * u_dpr) { gl_FragColor = vec4(0.0); return; }',
    '  float depth = -d;',
    '  float t = clamp(depth / u_bezel, 0.0, 1.0);',
    '  float om = 1.0 - t; float om3 = om * om * om;',
    '  float h = pow(max(1.0 - om3 * om, 0.0), 0.25);',
    '  float dh = min(om3 / pow(max(1.0 - om3 * om, 1e-4), 0.75), 6.0);',
    '  float slope = (u_thick / u_bezel) * dh;',
    '  vec2 g = grad(q);',
    '  vec3 N = normalize(vec3(g * slope, 1.0));',
    '  float depthZ = h * u_thick + u_thick * 0.25;',
    '  vec2 oR = refr(N, u_ior - u_disp, depthZ);',
    '  vec2 oG = refr(N, u_ior, depthZ);',
    '  vec2 oB = refr(N, u_ior + u_disp, depthZ);',
    '  vec3 col = vec3(0.0);',
    '  for (int i = 0; i < 12; i++) {',
    '    float fi = float(i);',
    '    float r = sqrt((fi + 0.5) / 12.0);',
    '    float a = fi * 2.39996;',
    '    vec2 o = vec2(cos(a), sin(a)) * r * u_blur;',
    '    col.r += tex(p + oR + o).r;',
    '    col.g += tex(p + oG + o).g;',
    '    col.b += tex(p + oB + o).b;',
    '  }',
    '  col /= 12.0;',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(lum), col, u_sat);',
    '  col = mix(col, u_tintCol, u_tint);',
    '  float edge = 1.0 - smoothstep(0.0, 2.4 * u_dpr + u_bezel * 0.16, depth);',
    '  float f = dot(g, u_light);',
    '  float rim = max(f, 0.0) + 0.45 * max(-f, 0.0);',
    '  col += vec3(rim * rim * edge * u_spec * 0.95);',
    '  col += vec3((1.0 - smoothstep(0.0, u_bezel, depth)) * 0.05);',
    '  float aa = 1.0 - smoothstep(-1.0 * u_dpr, 0.75 * u_dpr, d);',
    '  float a = aa;',
    '  if (u_rimw > 0.0) a *= 1.0 - smoothstep(0.0, u_rimw, depth);',   // nur Randstreifen (Modus rim)
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a);',   // außerhalb der Form durchsichtig
    '}'
  ].join('\n');

  /* ---------- Zustand ---------- */
  let gl = null, glCanvas = null, prog = null, sceneTex = null, running = false;
  const U = {};
  const sceneCv = document.createElement('canvas');
  let vw = 0, vh = 0, dpr = 1;
  const reg = new Map();     // Element -> { cv, ctx, visible, dirty, hover, pos }
  const queue = new Set();   // Elemente, die neu gezeichnet werden müssen
  let raf = 0, ro = null, io = null, mo = null, scrollT = 0, resizeT = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---------- Hintergrund-Bild: Nachbau der Farblichter aus dem CSS (body::before) ---------- */
  function rgbOf(c, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function paintScene() {
    vw = Math.max(1, innerWidth); vh = Math.max(1, innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = 0.5;   // Der Hintergrund ist weich, die halbe Auflösung genügt
    sceneCv.width = Math.max(2, Math.round(vw * k)); sceneCv.height = Math.max(2, Math.round(vh * k));
    const c = sceneCv.getContext('2d');
    c.setTransform(k, 0, 0, k, 0, 0);
    c.fillStyle = css('--bg') || '#000'; c.fillRect(0, 0, vw, vh);
    const vmax = Math.max(vw, vh) / 100;
    const bx = -20 * vmax, by = -20 * vmax, bw = vw + 40 * vmax, bh = vh + 40 * vmax;   // body::before reicht 20vmax über den Rand
    c.globalAlpha = 0.95;
    [['--orb-1', 0.18, 0.22, 38, 0.55, [109, 77, 255]], ['--orb-2', 0.82, 0.3, 34, 0.42, [31, 111, 255]], ['--orb-3', 0.6, 0.88, 30, 0.32, [255, 61, 139]]].forEach((o) => {
      const [r, g, b] = rgbOf(css(o[0]), o[5]);
      const x = bx + bw * o[1], y = by + bh * o[2], R = o[3] * vmax;
      const gr = c.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + o[4] + ')');
      gr.addColorStop(0.7, 'rgba(' + r + ',' + g + ',' + b + ',0)');
      c.fillStyle = gr; c.fillRect(0, 0, vw, vh);
    });
    c.globalAlpha = 1;
    // Abdunkeln zum Rand (body::after)
    c.save(); c.translate(vw * 0.5, vh * 0.4); c.scale(vw * 1.3, vh);
    const vg = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    vg.addColorStop(0.35, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    c.fillStyle = vg; c.fillRect(-2, -2, 4, 4); c.restore();
    if (gl) {
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sceneCv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
  }

  /* ---------- WebGL ---------- */
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'Shader-Fehler');
    return s;
  }
  function initGL() {
    glCanvas = document.createElement('canvas'); glCanvas.width = 256; glCanvas.height = 128;
    const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
    gl = glCanvas.getContext('webgl', opts) || glCanvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('Kein WebGL');
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'Link-Fehler');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['u_view', 'u_off', 'u_size', 'u_src', 'u_radius', 'u_thick', 'u_bezel', 'u_ior', 'u_disp', 'u_blur', 'u_sat', 'u_tint', 'u_tintCol', 'u_spec', 'u_dpr', 'u_light', 'u_rimw'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    sceneTex = gl.createTexture();
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
    glCanvas.addEventListener('webglcontextrestored', () => { start(); });
  }

  function num(v, fallback) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }
  function radiusPx(cs, W, H) {
    const raw = (cs.borderTopLeftRadius || '0').split(' ')[0];
    const v = num(raw, 0);
    const px = raw.endsWith('%') ? v / 100 * Math.min(W, H) : v;
    return Math.min(px, Math.min(W, H) / 2);
  }

  /* Einen Knopf zeichnen: Shader -> gemeinsame GL-Fläche -> Zeichenfläche des Knopfes */
  function draw(el, st) {
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (st.cv.width !== pw || st.cv.height !== ph) { st.cv.width = pw; st.cv.height = ph; }
    if (glCanvas.width < pw || glCanvas.height < ph) { glCanvas.width = Math.max(glCanvas.width, pw); glCanvas.height = Math.max(glCanvas.height, ph); }
    const cs = getComputedStyle(el);
    const parts = cs.getPropertyValue('--lg-rgb').trim().split(/[\s,]+/).map(Number);
    const rgb = parts.length === 3 && parts.every(Number.isFinite) ? parts : [255, 255, 255];
    const amt = num(cs.getPropertyValue(st.hover ? '--lg-amt-hover' : '--lg-amt'), 0.12);
    const rect = el.getBoundingClientRect();
    const offX = (rect.left + (rect.width - W) / 2 + el.clientLeft) * dpr;   // auch während einer Skalierung ungefähr richtig
    const offY = (rect.top + (rect.height - H) / 2 + el.clientTop) * dpr;
    const minHalf = Math.min(W, H) / 2;

    gl.viewport(0, 0, pw, ph);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(U.u_src, 0);
    gl.uniform2f(U.u_view, vw * dpr, vh * dpr);
    gl.uniform2f(U.u_off, offX, offY);
    gl.uniform2f(U.u_size, pw, ph);
    gl.uniform1f(U.u_radius, radiusPx(cs, W, H) * dpr);
    gl.uniform1f(U.u_thick, CFG.thick * dpr);
    gl.uniform1f(U.u_bezel, Math.max(2, Math.min(CFG.bezel, minHalf - 1)) * dpr);
    gl.uniform1f(U.u_ior, CFG.ior);
    gl.uniform1f(U.u_disp, CFG.dispersion);
    gl.uniform1f(U.u_blur, CFG.blur * dpr);
    gl.uniform1f(U.u_sat, CFG.saturation / 100);
    gl.uniform1f(U.u_tint, Math.min(1, Math.max(0, amt)));
    gl.uniform3f(U.u_tintCol, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    gl.uniform1f(U.u_spec, CFG.specular);
    gl.uniform1f(U.u_dpr, dpr);
    gl.uniform1f(U.u_rimw, st.rim ? CFG.rimWidth * dpr : 0);
    const ll = Math.hypot(LIGHT[0], LIGHT[1]);
    gl.uniform2f(U.u_light, LIGHT[0] / ll, LIGHT[1] / ll);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    st.ctx.clearRect(0, 0, pw, ph);
    st.ctx.drawImage(glCanvas, 0, glCanvas.height - ph, pw, ph, 0, 0, pw, ph);   // GL zählt von unten
  }

  /* ---------- Warteschlange: wenige Knöpfe pro Bild, nur sichtbare ---------- */
  function schedule() { if (!raf && running) raf = requestAnimationFrame(pump); }
  function mark(el) {
    const st = reg.get(el);
    if (!st) return;
    st.dirty = true; queue.add(el); schedule();
  }
  function markAll() { reg.forEach((_, el) => mark(el)); }
  function pump() {
    raf = 0;
    if (!running || !gl || gl.isContextLost()) return;
    let n = 0;
    for (const el of queue) {
      queue.delete(el);
      const st = reg.get(el);
      if (!st || !st.visible) continue;   // unsichtbar: bleibt "dirty", kommt beim Einblenden dran
      try { draw(el, st); st.dirty = false; } catch (e) { fail(e); return; }
      if (++n >= 10) break;
    }
    if (queue.size) schedule();
  }

  /* ---------- Elemente an- und abmelden ---------- */
  function attach(el) {
    if (reg.has(el) || !el.isConnected) return;
    const cv = document.createElement('canvas');
    cv.className = 'lg-canvas'; cv.setAttribute('aria-hidden', 'true');
    const cs = getComputedStyle(el);
    const st = { cv, ctx: cv.getContext('2d'), visible: false, dirty: true, hover: false, pos: false, rim: cs.getPropertyValue('--lg-mode').trim() === 'rim' };
    if (cs.position === 'static') { el.style.position = 'relative'; st.pos = true; }
    // Unter der Maus nur dann neu zeichnen, wenn sich die Tönung dabei ändert (große Boxen sparen so Rechenzeit)
    if (num(cs.getPropertyValue('--lg-amt-hover'), 0) !== num(cs.getPropertyValue('--lg-amt'), 0)) {
      st.on = () => { st.hover = true; mark(el); };
      st.off = () => { st.hover = false; mark(el); };
      el.addEventListener('pointerenter', st.on);
      el.addEventListener('pointerleave', st.off);
    }
    el.classList.add(ON, st.rim ? 'glass-rim' : 'glass-fill');
    el.prepend(cv);
    reg.set(el, st);
    ro.observe(el); io.observe(el);
  }
  function release(el) {
    const st = reg.get(el);
    if (!st) return;
    reg.delete(el); queue.delete(el);
    ro.unobserve(el); io.unobserve(el);
    if (st.on) { el.removeEventListener('pointerenter', st.on); el.removeEventListener('pointerleave', st.off); }
    el.classList.remove(ON, 'glass-rim', 'glass-fill');
    if (st.pos) el.style.position = '';
    st.cv.remove();
  }
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(SEL)) attach(root);
    root.querySelectorAll(SEL).forEach(attach);
  }
  function sweep() { reg.forEach((_, el) => { if (!el.isConnected) release(el); }); }

  function onMutations(recs) {
    let removed = false;
    for (const r of recs) {
      if (r.type === 'attributes') {
        const el = r.target;
        if (!(el instanceof Element)) continue;
        if (el.matches(SEL)) { if (reg.has(el)) mark(el); else attach(el); } else release(el);
      } else {
        r.addedNodes.forEach(scan);
        if (r.removedNodes.length) {
          removed = true;
          // Hat jemand den Inhalt eines Knopfes ersetzt (textContent), setzen wir die Glasfläche wieder ein
          const st = reg.get(r.target);
          if (st && !st.cv.isConnected) r.target.prepend(st.cv);
        }
      }
    }
    if (removed) sweep();
  }

  /* ---------- Start / Ende ---------- */
  function start() {
    if (running || CFG.enabled === false) return false;
    try { if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return false; } catch { /* ältere Browser */ }
    try {
      initGL();
      paintScene();
    } catch (e) { fail(e); return false; }
    ro = new ResizeObserver((es) => es.forEach((e) => mark(e.target)));
    io = new IntersectionObserver((es) => es.forEach((e) => {
      const st = reg.get(e.target);
      if (!st) return;
      st.visible = e.isIntersecting;
      if (st.visible && st.dirty) mark(e.target);
    }), { rootMargin: '120px' });
    mo = new MutationObserver(onMutations);
    running = true;
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return true;
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mo) mo.disconnect();
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    mo = ro = io = null;
    Array.from(reg.keys()).forEach(release);
    queue.clear();
    gl = null;
  }
  function fail(e) {
    console.warn('Glas-Effekt aus:', e && e.message ? e.message : e);
    stop();
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (running) { paintScene(); markAll(); } }, 150);
  });
  // Beim Scrollen wandert der Hintergrund hinter den Knöpfen: nach dem Scrollen einmal neu zeichnen
  window.addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => { if (running) markAll(); }, 150);
  }, { passive: true, capture: true });

  VD.Glass = { start, stop, get active() { return running; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
