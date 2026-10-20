/* Spieler-Oberfläche (Handy bzw. lokaler Mitspieler am Host-PC).
   Läuft rein reaktiv: der Host schickt "phase"-Nachrichten, der Controller zeigt die passende Ansicht. */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const h = VD.h;
  const PRE_MS = 500;      // Vorlauf vor dem "Los", falls jemand früher anfängt
  const POST_MS = 250;     // Nachlauf nach dem Stopp-Tipp
  const SR = A.SR;

  VD.Controller = class {
    constructor(root, opt) {
      this.root = root; this.mic = opt.mic; this.profile = opt.profile; this.local = !!opt.local;
      this.onKicked = opt.onKicked || (() => {}); this.onAttention = opt.onAttention || (() => {}); this.onLeave = opt.onLeave || (() => {});
      this.canRecord = !!opt.mic; this.score = 0; this.phase = 'lobby'; this.round = 0;
      this.take = null; this.submitted = false; this.nudge = 0; this.attempt = 0; this.cue = null;
      this.ready = false; this.players = [];
      this.top = h('header', { class: 'pc-top' });
      this.body = h('main', { class: 'pc-body' });
      this.offline = h('div', { class: 'pc-offline', hidden: true }, h('span', { class: 'spinner' }), h('p', { text: 'Verbindung verloren – verbinde neu …' }));
      root.replaceChildren(this.top, this.body, this.offline);
      this.renderTop();
      this.viewKey = '';
      this.setView('wait', () => this.vWait('Verbinde …'));
    }

    /* ---------- Verbindung ---------- */
    attach(link) {
      this.link = link;
      link.on('msg', (m) => this.onMsg(m));
      link.send({ t: 'hello', pid: this.profile.pid, name: this.profile.name, emoji: this.profile.emoji, color: this.profile.color, canRecord: this.canRecord, ver: 1 });
      this.setOffline(false);
      if (!this.local && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => (this.wake = w)).catch(() => {});
    }
    setOffline(on) { this.offline.hidden = !on; }
    send(m) { this.link && this.link.send(m); }

    onMsg(m) {
      switch (m.t) {
        case 'welcome': this.profile.color = m.color || this.profile.color; this.score = m.score || 0; this.renderTop(); if (m.snap) this.onPhase(m.snap, true); break;
        case 'reject': this.onKicked(m.reason || 'Beitritt nicht möglich.'); break;
        case 'kicked': this.onKicked('Der Host hat dich aus dem Raum entfernt.'); break;
        case 'lobby': this.players = m.players || []; { const me = this.players.find((p) => p.pid === this.profile.pid); if (me) { this.score = me.score; this.ready = me.ready; this.renderTop(); } } if (this.phase === 'lobby') this.updateLobbyList(); break;
        case 'phase': this.onPhase(m); break;
        case 'toast': VD.toast(String(m.text || '').slice(0, 120)); break;
        case 'votes': this.onVotes(m); break;
        default: break;
      }
    }

    /* ---------- Rahmen ---------- */
    renderTop() {
      this.top.replaceChildren(
        VD.ui.avatar(this.profile, 'sm'),
        h('span', { class: 'pc-name', text: this.profile.name }),
        h('span', { class: 'pc-score' }, h('b', { text: String(Math.round(this.score)) }), ' Pkt')
      );
    }
    setView(key, build, force) {
      if (this.viewKey === key && !force) return this.body.firstElementChild;
      this.viewKey = key;
      const el = build();
      el.classList.add('view-in');
      this.body.replaceChildren(el);
      return el;
    }
    fx(name) { if (!this.local) { VD.sfx.play(name); } }

    /* ---------- Ansichten ---------- */
    vWait(text) {
      return h('section', { class: 'pc-view center' }, h('div', { class: 'big-ear' }, VD.ui.dots()), h('p', { class: 'lead', text }));
    }

    vLobby() {
      const meter = h('div', { class: 'meter' }, h('i'));
      const list = h('ul', { class: 'mini-players' });
      const readyBtn = h('button', { class: 'btn big ' + (this.ready ? 'ghost' : 'primary'), onclick: () => { this.ready = !this.ready; this.send({ t: 'ready', on: this.ready }); this.fx('click'); readyBtn.classList.toggle('ghost', this.ready); readyBtn.classList.toggle('primary', !this.ready); readyBtn.textContent = this.ready ? 'Bereit ✓ (tippen zum Abbrechen)' : 'Ich bin bereit'; } }, this.ready ? 'Bereit ✓ (tippen zum Abbrechen)' : 'Ich bin bereit');
      const el = h('section', { class: 'pc-view' },
        h('h2', { text: 'Du bist dabei' }),
        h('p', { class: 'lead', text: this.canRecord ? 'Sprich kurz ins Mikro: Der Balken muss ausschlagen.' : 'Ohne Mikrofon beigetreten – du kannst abstimmen, aber nicht aufnehmen.' }),
        this.canRecord ? meter : null,
        readyBtn,
        h('div', { class: 'sub' }, h('span', { class: 'sub-h', text: 'Im Raum' }), list)
      );
      this._meterEl = meter;
      this._list = list;
      this.updateLobbyList();
      this.startMeter();
      return el;
    }
    updateLobbyList() {
      if (!this._list) return;
      this._list.replaceChildren(...this.players.map((p) => h('li', { class: p.connected ? '' : 'off' }, VD.ui.avatar(p, 'xs'), h('span', { text: p.name }), p.ready ? h('em', { text: '✓' }) : null)));
    }
    startMeter() {
      cancelAnimationFrame(this._mraf);
      const loop = () => {
        if (!this._meterEl || !this._meterEl.isConnected) return;
        const v = this.mic ? Math.min(1, Math.pow(this.mic.peak * 2.2, 0.6)) : 0;
        this._meterEl.firstChild.style.transform = `scaleX(${v})`;
        this._mraf = requestAnimationFrame(loop);
      };
      loop();
    }

    vIntro(m) {
      const r = m.role;
      let card;
      if (!r) card = h('div', { class: 'role-card watch' }, h('b', { text: 'Diesmal bist du Publikum' }), h('small', { text: 'Du schaust zu und stimmst am Ende ab.' }));
      else if (r.free) card = h('div', { class: 'role-card', style: { '--c': this.profile.color } }, h('b', { text: 'Du bist: ' + (r.label || 'eine Figur') }), h('small', { text: 'Ihr vertont das Video frei. Sprecht, was passt – am besten jeder eine andere Figur.' }));
      else card = h('div', { class: 'role-card', style: { '--c': this.profile.color } },
        h('b', { text: r.lines.length === 1 ? 'Du hast eine Zeile' : `Du hast ${r.lines.length} Zeilen` }),
        h('ul', { class: 'role-lines' }, r.lines.map((l) => h('li', { text: '„' + l.text + '“' }))),
        h('small', { text: 'Sprich sie, sobald sie auf dem großen Bildschirm drankommen.' }));
      return h('section', { class: 'pc-view center' },
        h('span', { class: 'kicker', text: `Szene ${m.round} von ${m.total}` }),
        h('h1', { class: 'big-title', text: m.title }),
        card);
    }

    vCountdown(m) {
      const cd = VD.ui.countdown(m.ms || 3000, { sfx: !this.local, vibrate: !this.local });
      this._cd = cd;
      return h('section', { class: 'pc-view center' }, cd.el, h('p', { class: 'lead', text: 'Gleich bist du dran' }));
    }

    vRecord() {
      const cue = this.cue;
      const canvas = h('canvas', { class: 'cue-bar', 'aria-label': 'Zeitleiste' });
      const timer = h('span', { class: 'rec-time', text: '0,0 s' });
      const big = h('h2', { class: 'cue-big', text: '' });
      const txt = h('p', { class: 'cue-text', text: '' });
      const live = h('canvas', { class: 'live', 'aria-label': 'Live-Aufnahme' });
      const el = h('section', { class: 'pc-view center rec' },
        h('div', { class: 'rec-head' }, h('span', { class: 'rec-badge' }, h('span', { class: 'rec-dot' }), 'Aufnahme'), timer),
        cue.free ? null : canvas, big, txt, live,
        h('p', { class: 'hint', text: 'Schau auf den großen Bildschirm.' }));
      requestAnimationFrame(() => {
        this._live = new VD.LiveWave(live, () => (this.mic ? this.mic.peak : 0), '#ff5252');
        this._live.start();
        this.drawCue(canvas, big, txt, cue);
      });
      this._recTimerEl = timer;
      return el;
    }

    /* Zeitleiste + Hinweis, wann man dran ist */
    drawCue(canvas, big, txt, cue) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let last = '';
      const loop = () => {
        if (!canvas.isConnected && !big.isConnected) return;
        const t = (performance.now() - this.recT0) / 1000, total = cue.total / 1000;
        if (canvas.isConnected) {
          const w = canvas.clientWidth, hh = canvas.clientHeight;
          if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
          const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
          g.fillStyle = '#26262e'; g.fillRect(0, hh / 2 - 2, w, 4);
          const block = (l, col) => { g.fillStyle = col; const x = (l.s / total) * w, bw = Math.max(4, ((l.e - l.s) / total) * w); g.beginPath(); g.roundRect(x, hh / 2 - 9, bw, 18, 5); g.fill(); };
          cue.others.forEach((l) => block(l, '#3b3b46'));
          cue.mine.forEach((l) => block(l, this.profile.color));
          const px = Math.min(1, t / total) * w;
          g.fillStyle = '#ece9e2'; g.fillRect(px - 1, 2, 2, hh - 4);
        }
        let b = 'Warte …', x = '', mode = 'wait';
        if (!cue.free) {
          const cur = cue.mine.find((l) => t >= l.s - 0.15 && t <= l.e + 0.2);
          const nxt = cue.mine.find((l) => l.s > t);
          if (cur) { b = 'Jetzt du!'; x = '„' + cur.text + '“'; mode = 'now'; }
          else if (nxt && nxt.s - t < 4) { b = 'Gleich: in ' + Math.max(1, Math.ceil(nxt.s - t)) + ' s'; x = '„' + nxt.text + '“'; mode = 'soon'; }
          else if (!nxt) { b = 'Deine Zeilen sind durch'; mode = 'done'; }
        } else { b = 'Sprich frei!'; x = cue.label || ''; mode = 'now'; }
        const key = b + '|' + x;
        if (key !== last) { last = key; big.textContent = b; txt.textContent = x; big.dataset.mode = mode; if (mode === 'now' && !this.local) VD.vibrate(18); }
        requestAnimationFrame(loop);
      };
      loop();
    }

    vReview() {
      const t = this.take;
      const canvas = h('canvas', { class: 'wave' });
      const play = h('button', { class: 'btn', onclick: () => this.playMine(canvas, play) }, '▶ Meine Aufnahme');
      const retry = h('button', { class: 'btn', onclick: () => this.retake() }, '↺ Alle nochmal');
      const ok = h('button', { class: 'btn primary big', onclick: () => this.submit() }, 'Abgeben');
      const warn = t.silent ? h('p', { class: 'warn', text: 'Ich habe fast nichts gehört. Sprich näher ans Mikro und nimm nochmal auf.' }) : null;
      const info = !t.silent ? h('p', { class: 'hint', text: `Lautstärke automatisch angeglichen (${t.gainDb >= 0 ? '+' : '−'}${Math.abs(t.gainDb).toFixed(0)} dB)` }) : null;
      const el = h('section', { class: 'pc-view' },
        h('h2', { text: 'Wie war’s?' }), canvas, warn, info,
        h('div', { class: 'row' }, play), h('div', { class: 'row' }, retry, ok),
        h('p', { class: 'hint', text: '„Alle nochmal“ startet die Szene für alle neu (höchstens zweimal).' }));
      requestAnimationFrame(() => VD.wave.draw(canvas, t.peaks, { color: '#ffb454', progress: 1 }));
      this._reviewCanvas = canvas;
      return el;
    }

    vSubmitted() {
      return h('section', { class: 'pc-view center' }, h('div', { class: 'check-pop' }, '✓'), h('h2', { text: 'Abgegeben' }), h('p', { class: 'lead' }, 'Warte auf die anderen', VD.ui.dots()));
    }

    vSync() {
      const readout = h('b', { class: 'off-val', text: VD.fmtMs(this.nudge) });
      const track = h('div', { class: 'nudge-track' }, h('i', { class: 'nudge-knob' }));
      const upd = () => { readout.textContent = this.nudge ? VD.fmtMs(this.nudge) : 'automatisch'; track.firstChild.style.left = 50 + (VD.clamp(this.nudge, -400, 400) / 400) * 50 + '%'; };
      const step = (d) => h('button', { class: 'btn', onclick: () => { this.nudge = VD.clamp(this.nudge + d, -1500, 1500); this.send({ t: 'nudge', ms: this.nudge }); upd(); this.fx('click'); VD.vibrate(8); ok.disabled = false; ok.textContent = 'Passt'; } }, (d > 0 ? '+' : '−') + Math.abs(d));
      const ok = h('button', { class: 'btn primary big', onclick: () => { this.send({ t: 'syncok' }); ok.disabled = true; ok.textContent = 'Passt ✓'; } }, 'Passt');
      const el = h('section', { class: 'pc-view center' },
        h('h2', { text: 'Sitzt deine Stimme?' }),
        h('p', { class: 'lead', text: 'Die Szene läuft in Schleife auf dem großen Bildschirm. Kommst du zu früh, schieb deine Spur nach hinten (+). Zu spät: nach vorn (−).' }),
        readout, track,
        h('div', { class: 'row' }, step(-100), step(-20), step(20), step(100)),
        h('button', { class: 'btn ghost', onclick: () => { this.nudge = 0; this.send({ t: 'nudge', ms: 0 }); upd(); } }, 'Zurücksetzen'),
        ok);
      requestAnimationFrame(upd);
      return el;
    }

    vVote(m) {
      const opts = (m.options || []).filter((o) => o.pid !== this.profile.pid);
      this.myVote = null;
      const status = h('p', { class: 'hint', text: opts.length ? 'Tippe auf deinen Favoriten.' : 'Niemand zum Abstimmen.' });
      const btns = opts.map((o) => h('button', { class: 'vote-card', style: { '--c': o.color }, onclick: (e) => {
        this.myVote = o.pid; this.send({ t: 'vote', target: o.pid }); this.fx('vote'); VD.vibrate(20);
        btns.forEach((b) => b.classList.remove('picked')); e.currentTarget.classList.add('picked');
        status.textContent = 'Stimme abgegeben – du kannst sie noch ändern.';
      } }, VD.ui.avatar(o), h('span', { text: o.name }), h('i', { class: 'tick', text: '✓' })));
      return h('section', { class: 'pc-view' }, h('h2', { text: 'Wer war am besten – oder am lustigsten?' }), h('div', { class: 'vote-list' }, btns), status);
    }
    onVotes() { /* Zwischenstände werden nur am Host angezeigt */ }

    vResults(m) {
      const rankTxt = m.rank === 1 ? '1. Platz' : m.rank + '. Platz';
      return h('section', { class: 'pc-view center' },
        h('span', { class: 'kicker', text: `Runde ${m.round}` }),
        h('div', { class: 'pts' }, h('b', { id: 'pts-n', text: '0' }), h('span', { text: 'Punkte' })),
        h('p', { class: 'lead', text: m.total ? `${m.votes} ${m.votes === 1 ? 'Stimme' : 'Stimmen'} bekommen` : 'Diesmal nur zugeschaut' }),
        h('p', { class: 'rank', text: `Gesamt ${Math.round(m.score)} · ${rankTxt}` }));
    }

    vFinal(m) {
      const medal = m.rank === 1 ? '🏆' : m.rank === 2 ? '🥈' : m.rank === 3 ? '🥉' : '🎤';
      return h('section', { class: 'pc-view center' }, h('div', { class: 'medal', text: medal }), h('h1', { text: m.rank === 1 ? 'Du hast gewonnen!' : m.rank + '. Platz' }),
        h('p', { class: 'lead', text: `${Math.round(m.score)} Punkte` }), h('p', { class: 'hint', text: 'Der Host startet gleich eine neue Runde – oder ihr bleibt in der Lobby.' }));
    }

    /* ---------- Phasen ---------- */
    onPhase(m, silent) {
      this.phase = m.phase;
      if (['countdown', 'record', 'sync', 'vote'].includes(m.phase)) this.onAttention();
      if (m.round != null) this.round = m.round;
      if (this._live && m.phase !== 'record') { this._live.stop(); }
      if (m.phase !== 'lobby') cancelAnimationFrame(this._mraf);
      switch (m.phase) {
        case 'lobby': this.submitted = false; this.setView('lobby', () => this.vLobby(), true); break;
        case 'intro': this.take = null; this.submitted = false; this.nudge = 0; this.setView('intro', () => this.vIntro(m), true); this.fx('whoosh'); break;
        case 'countdown':
          this.take = null; this.submitted = false; this.nudge = 0; this.stopping = false;
          this.attempt = m.attempt || 0;
          if (!this.canRecord || m.skip) { this.setView('wait', () => this.vWait(this.canRecord ? 'Diesmal schaust du zu …' : 'Die anderen sprechen gerade …'), true); break; }
          this.setView('countdown', () => this.vCountdown(m), true); break;
        case 'record':
          if (!this.canRecord || !m.cue) { this.setView('wait', () => this.vWait('Die anderen sprechen gerade …'), true); break; }
          this.attempt = m.attempt || this.attempt;
          this.cue = m.cue; this.startRecording(m.cue.total + 600); break;
        case 'wait': this.setView('wait', () => this.vWait(m.text || 'Einen Moment …'), true); break;
        case 'sync':
          if (this.take && this.submitted) this.setView('sync', () => this.vSync(m), true);
          else this.setView('wait', () => this.vWait('Die Stimmen werden gemischt …'), true);
          break;
        case 'vote': this.setView('vote', () => this.vVote(m), true); break;
        case 'results': this.setView('results', () => this.vResults(m), true); this.score = m.score; this.renderTop(); requestAnimationFrame(() => { const n = VD.$('#pts-n', this.body); if (n) VD.countUp(n, m.total, 900); }); break;
        case 'final': this.setView('final', () => this.vFinal(m), true); if (m.rank === 1) { VD.confetti(1); this.fx('fanfare'); } break;
        default: break;
      }
    }

    /* ---------- Aufnahme ---------- */
    startRecording(maxMs) {
      if (!this.mic || !this.mic.running) { VD.toast('Mikrofon nicht aktiv', 'warn'); return; }
      this.recMark = this.mic.mark() - Math.round((PRE_MS / 1000) * this.mic.sr);
      this.recT0 = performance.now(); this.recMax = maxMs;
      this.setView('record', () => this.vRecord(), true);
      this.send({ t: 'state', s: 'recording' });
      clearInterval(this._lvl);
      this._lvl = setInterval(() => {
        const t = (performance.now() - this.recT0) / 1000;
        if (this._recTimerEl) this._recTimerEl.textContent = VD.fmtSec(t);
        this.send({ t: 'lvl', v: Math.round(Math.min(1, this.mic.peak * 2) * 100) / 100 });
        if (performance.now() - this.recT0 > this.recMax) this.stopRecording();
      }, 90);
    }

    async stopRecording() {
      if (this.stopping || !this.mic) return;
      this.stopping = true;
      clearInterval(this._lvl);
      this.fx('click');
      await VD.sleep(POST_MS);
      const end = this.mic.mark();
      const raw = this.mic.slice(this.recMark, end);
      this.setView('wait', () => this.vWait('Verarbeite Aufnahme …'), true);
      try {
        const res = await VD.audio.resample(raw, this.mic.sr, SR);
        const n = A.normalize(res, SR);
        this.take = { data: n.data, gainDb: n.gainDb, silent: n.silent, peaks: A.peaks(n.data, 160), durMs: Math.round((n.data.length / SR) * 1000) };
      } catch (e) {
        console.error(e); VD.toast('Aufnahme konnte nicht verarbeitet werden', 'warn');
        this.take = { data: new Float32Array(SR), gainDb: 0, silent: true, peaks: new Float32Array(160), durMs: 1000 };
      }
      this.stopping = false;
      this.send({ t: 'state', s: 'review' });
      this.setView('review', () => this.vReview(), true);
    }

    retake() {
      this.fx('click');
      this.send({ t: 'retake' });
      this.setView('wait', () => this.vWait('Frage nach einem neuen Versuch …'), true);
    }

    async submit() {
      if (!this.take || this.submitted) return;
      this.submitted = true;
      this.fx('submit'); VD.vibrate(30);
      this.setView('submitted', () => this.vSubmitted(), true);
      const i16 = VD.f32ToI16(this.take.data);
      const bytes = new Uint8Array(i16.buffer);
      this.link.sendBlob('take', { round: this.round, attempt: this.attempt, sr: SR, preMs: PRE_MS, lat: Math.round((this.link.rtt || 0) / 2), durMs: this.take.durMs, silent: this.take.silent }, bytes);
    }

    playMine(canvas, btn) {
      if (!this.take) return;
      if (this._h) { this._h.stop(); this._h = null; }
      const buf = VD.audio.fromFloat(this.take.data, SR);
      this._h = VD.audio.play(buf, { gain: 0.9 });
      this.animateHead(canvas, this._h, this.take.peaks, '#ffb454');
    }
    animateHead(canvas, handle, peaks, color) {
      const loop = () => {
        const p = Math.min(1, handle.elapsed() / handle.dur);
        VD.wave.draw(canvas, peaks, { color, progress: p, head: p });
        if (p < 1 && canvas.isConnected) requestAnimationFrame(loop); else VD.wave.draw(canvas, peaks, { color, progress: 1 });
      };
      loop();
    }

    destroy() {
      clearInterval(this._lvl); cancelAnimationFrame(this._mraf);
      if (this._live) this._live.stop();
      try { this.wake && this.wake.release(); } catch { /* ignore */ }
    }
  };
})();
