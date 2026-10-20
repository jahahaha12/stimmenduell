/* Spieler-Oberfläche (Handy bzw. lokaler Mitspieler am Host-PC).
   Jeder Spieler bekommt seine Zeilen und arbeitet sie in eigenem Tempo ab:
   Standbild -> "Original" (Szene mit Originalton + Text) -> "Aufnahme" (stumm, du sprichst) -> "Mein Take" -> "Weiter". */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const h = VD.h;
  const SR = A.SR;
  const TAIL_MS = 350;         // Nachlauf nach dem Ende der Zeile
  const DEFAULT_LAT_MS = 60;   // typische Mikrofon-Verzögerung, falls der Browser keine nennt

  VD.Controller = class {
    constructor(root, opt) {
      this.root = root; this.mic = opt.mic; this.profile = opt.profile; this.local = !!opt.local;
      this.onKicked = opt.onKicked || (() => {}); this.onAttention = opt.onAttention || (() => {}); this.onLeave = opt.onLeave || (() => {});
      this.canRecord = !!opt.mic; this.phase = 'lobby';
      this.ready = false; this.players = [];
      this.resetScene();
      this.top = h('header', { class: 'pc-top' });
      this.body = h('main', { class: 'pc-body' });
      this.offline = h('div', { class: 'pc-offline', hidden: true }, h('span', { class: 'spinner' }), h('p', { text: 'Verbindung verloren – verbinde neu …' }));
      root.replaceChildren(this.top, this.body, this.offline);
      this.renderTop();
      this.viewKey = '';
      this.setView('wait', () => this.vWait('Verbinde …'));
    }

    resetScene() {
      this.stopAll();
      (this.imgUrls || []).forEach((u) => URL.revokeObjectURL(u));
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
      this.imgUrls = []; this.videoUrl = null;
      if (this.vEl) { try { this.vEl.pause(); if (this.vEl.stop) this.vEl.stop(); } catch { /* ignore */ } this.vEl = null; }
      this.scene = null; this.sceneId = null; this.lines = []; this.cur = 0; this.takes = new Map();
      this.finished = false; this.loaded = false; this.roster = []; this.ui = null;
    }

    /* ---------- Verbindung ---------- */
    attach(link) {
      this.link = link;
      link.on('msg', (m) => this.onMsg(m));
      link.on('blob', (k, meta, bytes) => this.onBlob(k, meta, bytes));
      link.send({ t: 'hello', pid: this.profile.pid, name: this.profile.name, emoji: this.profile.emoji, color: this.profile.color, canRecord: this.canRecord, sceneId: this.loaded ? this.sceneId : null, ver: 2 });
      this.setOffline(false);
      if (this.loaded) this.resync();
      if (!this.local && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => (this.wake = w)).catch(() => {});
    }
    setOffline(on) { this.offline.hidden = !on; }
    send(m) { this.link && this.link.send(m); }

    /* Nach einem Verbindungsabbruch: alles Aufgenommene noch einmal schicken (der Host nimmt Doppeltes einfach an) */
    resync() {
      for (const [i, t] of this.takes) this.uploadTake(i, t);
      this.sendProg('idle');
      if (this.finished) this.send({ t: 'done' });
    }

    onMsg(m) {
      switch (m.t) {
        case 'welcome': this.profile.color = m.color || this.profile.color; this.renderTop(); if (m.snap) this.onPhase(m.snap, true); break;
        case 'reject': this.onKicked(m.reason || 'Beitritt nicht möglich.'); break;
        case 'kicked': this.onKicked('Der Host hat dich aus dem Raum entfernt.'); break;
        case 'lobby': this.players = m.players || []; if (this.phase === 'lobby') this.updateLobbyList(); break;
        case 'phase': this.onPhase(m); break;
        case 'scene': this.onScene(m); break;
        case 'assets_end': this.onAssetsEnd(m); break;
        case 'prog_all': this.roster = m.list || []; if (this.viewKey === 'submitted') this.updateRoster(); break;
        case 'toast': VD.toast(String(m.text || '').slice(0, 120)); break;
        default: break;
      }
    }

    /* ---------- Szene laden ---------- */
    async onScene(m) {
      this.resetScene();
      this.scene = m; this.sceneId = m.id;
      this.lines = (m.lines || []).map((l) => Object.assign({ img: null, orig: null }, l));
      this.videoMime = m.videoMime || '';
      this.setView('load', () => this.vWait('Szene wird geladen …'), true);
      this.canVideo = !!m.videoSize && (await VD.Video.ready(this.videoMime));
      if (this.scene !== m) return;
      this.send({ t: 'caps', video: this.canVideo });
    }

    onBlob(kind, meta, bytes) {
      if (!this.scene) return;
      if (kind === 'img') {
        const l = this.lines.find((x) => x.i === meta.i); if (!l) return;
        l.img = URL.createObjectURL(new Blob([bytes], { type: meta.mime || 'image/png' })); this.imgUrls.push(l.img);
      } else if (kind === 'orig') {
        const l = this.lines.find((x) => x.i === meta.i); if (!l) return;
        const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        l.orig = VD.audio.fromFloat(VD.i16ToF32(i16), meta.sr || 16000);
      } else if (kind === 'video') {
        this.videoUrl = URL.createObjectURL(new Blob([bytes], { type: meta.mime || 'video/ogg' }));
      }
    }

    onAssetsEnd(m) {
      if (!this.scene) return;
      if (!m.video) this.videoUrl = null;
      this.loaded = true;
      this.send({ t: 'loaded' });
      if (this.phase === 'play') this.enterPlay();
    }

    /* ---------- Rahmen ---------- */
    renderTop() {
      this.top.replaceChildren(VD.ui.avatar(this.profile, 'sm'), h('span', { class: 'pc-name', text: this.profile.name }));
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
        h('p', { class: 'lead', text: this.canRecord ? 'Sprich kurz ins Mikro: Der Balken muss ausschlagen.' : 'Ohne Mikrofon beigetreten – du kannst zuschauen, aber nicht aufnehmen.' }),
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

    /* ---------- Phasen ---------- */
    onPhase(m) {
      this.phase = m.phase;
      if (m.phase !== 'lobby') cancelAnimationFrame(this._mraf);
      if (m.phase === 'lobby') { this.resetScene(); this.setView('lobby', () => this.vLobby(), true); return; }
      if (m.phase === 'load') {
        if (m.text) this.setView('wait', () => this.vWait(m.text), true);
        else if (!this.loaded) this.setView('load', () => this.vWait('Szene wird geladen …'), true);
        return;
      }
      if (m.phase === 'play') {
        if (!this.scene || !this.lines.length || m.text) { this.setView('wait', () => this.vWait(m.text || 'Diesmal schaust du zu.'), true); return; }
        this.onAttention();
        if (this.loaded) this.enterPlay();
        return;
      }
      if (m.phase === 'final') { this.stopAll(); this.onAttention(); this.setView('final', () => this.vFinal(m), true); return; }
      this.setView('wait', () => this.vWait(m.text || 'Einen Moment …'), true);
    }

    enterPlay() {
      if (this.viewKey === 'play' || this.viewKey === 'submitted') return;
      this.cur = Math.min(this.cur, Math.max(0, this.lines.length - 1));
      this.showLine();
    }

    /* ---------- Eine Zeile bearbeiten ---------- */
    showLine() {
      this.stopAll();
      this.finished = false;
      const idx = this.cur, line = this.lines[idx], total = this.lines.length;
      const take = this.takes.get(line.i);
      const still = h('img', { class: 'dp-still', alt: '', src: line.img || '' });
      if (!line.img) still.hidden = true;
      let video = null;
      if (this.videoUrl) {
        video = this.vEl || (this.vEl = VD.Video.create(this.videoUrl, this.videoMime, 'dp-video'));
        video.hidden = true;
      }
      const sub = h('div', { class: 'dp-sub' });
      const bar = h('i', { class: 'dp-barfill' });
      const live = h('canvas', { class: 'live dp-live', 'aria-label': 'Live-Aufnahme', hidden: true });
      const status = h('p', { class: 'hint dp-status', text: take ? 'Du hast schon aufgenommen. „Mein Take“ zeigt das Ergebnis.' : 'Tippe auf „Original“, dann auf „Aufnahme“.' });
      const mk = (cls, label, fn) => h('button', { class: 'btn ' + cls, onclick: fn }, label);
      const bBack = mk('dp-back', '◀', () => this.go(-1)); bBack.setAttribute('aria-label', 'Vorherige Zeile'); bBack.disabled = idx === 0;
      const bOrig = mk('', 'Original', () => this.doOriginal());
      const bRec = mk('dp-rec', 'Aufnahme', () => this.doRecord());
      const bTake = mk('', 'Mein Take', () => this.doTake());
      const bNext = mk('primary', idx === total - 1 ? 'Fertig ▶' : 'Weiter ▶', () => this.go(1));
      bTake.disabled = !take; bNext.disabled = !take;
      this.ui = { still, video, sub, bar, live, status, bBack, bOrig, bRec, bTake, bNext, line };
      const dots = h('div', { class: 'dp-dots' }, this.lines.map((l, k) => h('i', { class: (k < idx || this.takes.has(l.i) ? 'ok ' : '') + (k === idx ? 'cur' : '') })));
      const el = h('section', { class: 'pc-view dub-play' },
        h('div', { class: 'dp-head' }, h('b', { class: 'dp-title', text: this.scene.title }), h('span', { class: 'dp-n', text: `LINE ${idx + 1}/${total}` })),
        dots,
        h('div', { class: 'dp-screen' }, still, video, sub, h('div', { class: 'dp-bar' }, bar)),
        h('p', { class: 'dp-who' }, h('b', { style: { '--c': this.profile.color }, text: line.char.toUpperCase() }), ' · Du bist dran'),
        h('p', { class: 'dp-cap', text: line.caption || '' }),
        live, status,
        h('div', { class: 'dp-btns' }, bBack, bOrig, bRec, bTake, bNext));
      this.setView('play', () => el, true);
      this.sendProg('idle');
      return el;
    }

    setBusy(kind) {
      const u = this.ui; if (!u) return;
      this.busy = kind;
      u.bOrig.classList.toggle('on', kind === 'orig'); u.bRec.classList.toggle('on', kind === 'rec'); u.bTake.classList.toggle('on', kind === 'take');
      u.bOrig.textContent = kind === 'orig' ? 'Stopp' : 'Original';
      u.bRec.textContent = kind === 'rec' ? 'Stopp' : 'Aufnahme';
      u.bTake.textContent = kind === 'take' ? 'Stopp' : 'Mein Take';
      const t = this.takes.get(u.line.i);
      u.bBack.disabled = kind != null || this.cur === 0;
      u.bNext.disabled = kind != null || !t;
      u.bOrig.disabled = kind === 'rec' || kind === 'take';
      u.bTake.disabled = kind === 'rec' || kind === 'orig' || (!t && kind !== 'take');
      u.bRec.disabled = kind === 'orig' || kind === 'take';
    }

    /* Szene abspielen: Video (falls möglich) ab dem Anfang der Zeile, dazu optional Ton */
    async playSeg(line, opt) {
      const u = this.ui;
      const dur = line.s1 - line.s0;
      const token = (this.playToken = (this.playToken || 0) + 1);
      u.sub.classList.toggle('on', !!opt.subtitle);
      if (opt.subtitle) u.sub.textContent = line.caption;
      if (u.video) {
        const v = u.video;
        try {
          await VD.Video.seek(v, line.s0);
          if (token !== this.playToken) return null;
          await v.play();
          u.video.hidden = false; u.still.hidden = true;
        } catch (e) { console.warn('Video startet nicht', e); }
      }
      if (token !== this.playToken) return null;
      const t0 = performance.now();
      if (opt.audio) this.audioHandle = VD.audio.play(opt.audio, { gain: opt.gain || 0.95, delay: 0.005 });
      u.bar.style.transition = 'none'; u.bar.style.transform = 'scaleX(0)';
      void u.bar.offsetWidth;
      u.bar.style.transition = `transform ${dur}s linear`; u.bar.style.transform = 'scaleX(1)';
      this.segTimer = setTimeout(() => { if (token === this.playToken) opt.onEnd && opt.onEnd(); }, dur * 1000 + (opt.extraMs || 0));
      return { t0, dur };
    }

    stopPlayback() {
      this.playToken = (this.playToken || 0) + 1;
      clearTimeout(this.segTimer);
      if (this.audioHandle) { this.audioHandle.stop(); this.audioHandle = null; }
      const u = this.ui;
      if (u) {
        if (u.video) { try { u.video.pause(); } catch { /* ignore */ } u.video.hidden = true; }
        if (u.still && u.line.img) u.still.hidden = false;
        u.sub.classList.remove('on');
        u.bar.style.transition = 'none'; u.bar.style.transform = 'scaleX(0)';
      }
    }
    stopAll() {
      this.stopPlayback();
      clearInterval(this._lvl);
      if (this._live) { this._live.stop(); this._live = null; }
      if (this.ui && this.ui.live) this.ui.live.hidden = true;
      this.busy = null; this.stopping = false;
    }

    async doOriginal() {
      if (this.busy === 'orig') { this.stopPlayback(); this.setBusy(null); return; }
      this.stopPlayback();
      const line = this.ui.line;
      this.setBusy('orig');
      this.ui.status.textContent = 'Original mit Ton. Merke dir Betonung und Timing.';
      await this.playSeg(line, { audio: line.orig, subtitle: true, onEnd: () => { this.stopPlayback(); this.setBusy(null); this.ui.status.textContent = 'Jetzt „Aufnahme“ drücken: Die Szene läuft stumm, du sprichst.'; } });
    }

    async doRecord() {
      const u = this.ui;
      if (this.busy === 'rec') { this.finishRecord(true); return; }
      if (!this.mic || !this.mic.running) { VD.toast('Mikrofon nicht aktiv', 'warn'); return; }
      this.stopPlayback();
      const line = u.line;
      this.setBusy('rec');
      u.status.textContent = 'Sprich jetzt! Die Szene läuft ohne Ton.';
      u.live.hidden = false;
      this._live = new VD.LiveWave(u.live, () => (this.mic ? this.mic.peak : 0), '#ff5252');
      this._live.start();
      const started = await this.playSeg(line, { subtitle: false, extraMs: TAIL_MS, onEnd: () => this.finishRecord(false) });
      if (!started) return;
      this.recMark = this.mic.mark();
      this.recDur = line.s1 - line.s0;
      this.sendProg('rec');
      clearInterval(this._lvl);
      this._lvl = setInterval(() => this.send({ t: 'lvl', v: Math.round(Math.min(1, this.mic.peak * 2) * 100) / 100 }), 120);
    }

    async finishRecord(manual) {
      if (this.busy !== 'rec' || this.stopping) return;
      this.stopping = true;
      clearInterval(this._lvl);
      this.stopPlayback();
      const u = this.ui, line = u.line;
      const sr = this.mic.sr;
      const latMs = this.micLatencyMs();
      await VD.sleep(latMs + 30);                       // kurz warten, bis die verzögerten Samples da sind
      const lat = Math.round((latMs / 1000) * sr);
      const end = Math.min(this.mic.mark(), this.recMark + Math.round(this.recDur * sr) + lat);
      const raw = this.mic.slice(this.recMark + lat, end);
      if (this._live) { this._live.stop(); this._live = null; }
      u.live.hidden = true;
      u.status.textContent = 'Verarbeite …';
      try {
        const res = await VD.audio.resample(raw, sr, SR);
        const n = A.normalize(res, SR);
        this.takes.set(line.i, { data: n.data, gainDb: n.gainDb, silent: n.silent, sent: false });
      } catch (e) {
        console.error(e); VD.toast('Aufnahme konnte nicht verarbeitet werden', 'warn');
      }
      this.stopping = false;
      if (this.ui !== u) return;                        // inzwischen woanders
      this.setBusy(null);
      const t = this.takes.get(line.i);
      u.status.textContent = !t ? 'Die Aufnahme hat nicht geklappt. Versuche es nochmal.'
        : t.silent ? 'Ich habe fast nichts gehört. Sprich näher ans Mikro und nimm nochmal auf.'
        : 'Aufgenommen. Hör dir mit „Mein Take“ das Ergebnis an – oder nimm nochmal auf.';
      this.sendProg('idle');
      this.fx('submit');
      if (manual) VD.vibrate(10);
    }

    micLatencyMs() {
      try {
        const t = this.mic.stream.getAudioTracks()[0];
        const l = t && t.getSettings && t.getSettings().latency;
        if (typeof l === 'number' && l > 0 && l < 0.5) return Math.round(l * 1000);
      } catch { /* ignore */ }
      return DEFAULT_LAT_MS;
    }

    async doTake() {
      if (this.busy === 'take') { this.stopPlayback(); this.setBusy(null); return; }
      const u = this.ui, line = u.line, t = this.takes.get(line.i);
      if (!t) return;
      this.stopPlayback();
      this.setBusy('take');
      u.status.textContent = 'Das ist dein Take: Szene ohne Originalton, dafür mit deiner Stimme.';
      await this.playSeg(line, { audio: VD.audio.fromFloat(t.data, SR), subtitle: false, onEnd: () => { this.stopPlayback(); this.setBusy(null); } });
    }

    /* ---------- Weiter / Zurück / Fertig ---------- */
    go(d) {
      if (this.busy) return;
      const u = this.ui;
      const t = this.takes.get(u.line.i);
      if (d > 0) {
        if (!t) return;
        this.uploadTake(u.line.i, t);
        if (this.cur >= this.lines.length - 1) { this.finish(); return; }
        this.cur++; this.fx('click'); this.showLine();
      } else if (this.cur > 0) {
        if (t) this.uploadTake(u.line.i, t);
        this.cur--; this.fx('click'); this.showLine();
      }
    }

    uploadTake(i, t) {
      if (!this.link) return;
      t.sent = true;
      this.link.sendBlob('take', { i, sr: SR }, new Uint8Array(VD.f32ToI16(t.data).buffer));
    }

    finish() {
      this.stopAll();
      this.finished = true;
      this.send({ t: 'done' });
      this.sendProg('done');
      this.setView('submitted', () => this.vSubmitted(), true);
      this.fx('fanfare'); VD.vibrate(30);
    }

    vSubmitted() {
      this._roster = h('div', { class: 'roster' });
      const edit = h('button', { class: 'btn ghost', onclick: () => { this.send({ t: 'undone' }); this.cur = 0; this.showLine(); } }, 'Nochmal bearbeiten');
      const el = h('section', { class: 'pc-view center' }, h('div', { class: 'check-pop' }, '✓'), h('h2', { text: 'Abgegeben!' }),
        h('p', { class: 'lead', id: 'wait-n', text: 'Warte auf die anderen …' }), this._roster, edit);
      requestAnimationFrame(() => this.updateRoster());
      return el;
    }
    updateRoster() {
      if (!this._roster || !this._roster.isConnected) return;
      const open = this.roster.filter((p) => !p.done).length;
      const w = VD.$('#wait-n', this.body); if (w) w.textContent = this.roster.length ? (open ? `Warte noch auf ${open} Spieler …` : 'Alle sind fertig!') : 'Warte auf die anderen …';
      this._roster.replaceChildren(...this.roster.map((p) => h('div', { class: 'ro-card' + (p.done ? ' done' : ''), style: { '--c': p.color } },
        VD.ui.avatar(p, 'lg'), h('b', { text: p.pid === this.profile.pid ? p.name + ' (du)' : p.name }),
        h('small', { text: p.done ? '✓ Fertig' : `Line ${p.cur}/${p.total}` }))));
    }

    sendProg(st) {
      if (!this.lines.length) return;
      this.send({ t: 'prog', cur: this.cur + 1, st: st || 'idle' });
    }

    vFinal() {
      const again = h('button', { class: 'btn primary big', onclick: () => { this.send({ t: 'again' }); this.fx('click'); } }, 'Nochmal ansehen');
      return h('section', { class: 'pc-view center' }, h('div', { class: 'medal', text: '🎬' }), h('h1', { text: 'Premiere!' }),
        h('p', { class: 'lead', text: 'Schau auf den großen Bildschirm. Dort läuft die komplette Szene mit euren Stimmen.' }), again,
        h('p', { class: 'hint', text: 'Der Host führt euch danach zurück in die Lobby.' }));
    }

    destroy() {
      this.stopAll();
      clearInterval(this._lvl); cancelAnimationFrame(this._mraf);
      try { this.wake && this.wake.release(); } catch { /* ignore */ }
    }
  };
})();
