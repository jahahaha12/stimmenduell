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
      this.onKicked = opt.onKicked || (() => {}); this.onAttention = opt.onAttention || (() => {}); this.onBig = opt.onBig || (() => {}); this.onLeave = opt.onLeave || (() => {});
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
      this.imgUrls = []; this.stillUrl = null; this.videoUrl = null; this.vAr = 0; this.mix = null; this.stopPremiere && this.stopPremiere();
      if (this.vEl) { try { this.vEl.pause(); if (this.vEl.stop) this.vEl.stop(); } catch { /* ignore */ } this.vEl = null; }
      this.scene = null; this.sceneId = null; this.lines = []; this.cur = 0; this.takes = new Map();
      this.finished = false; this.loaded = false; this.roster = []; this.ui = null; this.fin = null;
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
      for (const [i, t] of this.takes) this.uploadTake(i, t, true);
      this.sendProg('idle');
      if (this.finished) this.send({ t: 'done' });
    }

    onMsg(m) {
      switch (m.t) {
        case 'welcome': this.profile.color = m.color || this.profile.color; this.renderTop(); if (m.snap) this.onPhase(m.snap, true); break;
        case 'reject': this.onKicked(m.reason || 'Beitritt nicht möglich.'); break;
        case 'kicked': this.onKicked('Der Host hat dich aus dem Raum entfernt.'); break;
        case 'closed': this.onKicked('Der Host hat den Raum geschlossen.'); break;
        case 'lobby': this.players = m.players || []; if (this.phase === 'lobby') this.updateLobbyList(); break;
        case 'phase': this.onPhase(m); break;
        case 'scene': this.onScene(m); break;
        case 'assets_end': this.onAssetsEnd(m); break;
        case 'replay': this.onReplay(Number(m.in) || 1500); break;
        case 'prog_all': this.roster = m.list || []; if (this.viewKey === 'submitted' || this.viewKey === 'spectate') this.updateRoster(); break;
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
      // Zuschauer bleiben bei der Fortschrittsanzeige; die Medien laden im Hintergrund
      if (!m.watch) this.setView('load', () => this.vWait('Szene wird geladen …'), true);
      this.canVideo = !!m.videoSize && (await VD.Video.ready(this.videoMime));
      if (this.scene !== m) return;
      // Video schon von einer früheren Runde auf diesem Gerät? Dann muss es nicht noch einmal übertragen werden
      let hit = null;
      if (this.canVideo && !this.local && m.videoKey) hit = await VD.VideoCache.get(m.videoKey);
      if (this.scene !== m) return;
      if (hit) { this.videoUrl = URL.createObjectURL(new Blob([hit.bytes], { type: hit.mime || 'video/ogg' })); const ar = VD.Video.aspect(new Uint8Array(hit.bytes)); if (ar > 0.3 && ar < 4) this.vAr = ar; }
      this.send({ t: 'caps', video: this.canVideo, cached: !!hit });
    }

    onBlob(kind, meta, bytes) {
      if (!this.scene) return;
      if (kind === 'img' && this.scene.watch) {
        if (meta.still && !this.stillUrl) { this.stillUrl = URL.createObjectURL(new Blob([bytes], { type: meta.mime || 'image/png' })); this.imgUrls.push(this.stillUrl); }
      } else if (kind === 'img') {
        const l = this.lines.find((x) => x.i === meta.i); if (!l) return;
        l.img = URL.createObjectURL(new Blob([bytes], { type: meta.mime || 'image/png' })); this.imgUrls.push(l.img);
      } else if (kind === 'orig') {
        const l = this.lines.find((x) => x.i === meta.i); if (!l) return;
        const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        l.orig = VD.audio.fromFloat(VD.i16ToF32(i16), meta.sr || 16000);
      } else if (kind === 'mix') {
        const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        this.mix = VD.audio.fromFloat(VD.i16ToF32(i16), meta.sr || 24000);
        // Zuschauer: Ergebnis kam erst nach dem Start an -> Ansicht neu aufbauen, beim nächsten „Nochmal ansehen“ läuft es mit
        if (this.viewKey === 'final' && !this.fin) { this.setView('final', () => this.vFinal(), true); if (this.fin) this.fin.status.textContent = 'Bereit! Beim nächsten „Nochmal ansehen“ bist du dabei.'; }
      } else if (kind === 'video') {
        this.videoUrl = URL.createObjectURL(new Blob([bytes], { type: meta.mime || 'video/ogg' }));
        const ar = VD.Video.aspect(bytes); if (ar > 0.3 && ar < 4) this.vAr = ar;
        if (!this.local && this.scene.videoKey) VD.VideoCache.put(this.scene.videoKey, meta.mime, bytes);
      }
    }

    onAssetsEnd(m) {
      if (!this.scene) return;
      if (!m.video) this.videoUrl = null;
      this.loaded = true;
      this.send({ t: 'loaded' });
      if (this.phase === 'play' && !this.scene.watch) this.enterPlay();
    }

    /* ---------- Rahmen ---------- */
    renderTop() {
      // Im Spiel sitzt der Filter-Knopf oben; der Host hat ihn in seiner eigenen Kopfzeile
      const dn = this.canRecord && !this.local && this.phase !== 'lobby' ? VD.Denoise.iconEl() : null;
      this.top.replaceChildren(VD.ui.avatar(this.profile, 'sm'), h('span', { class: 'pc-name', text: this.profile.name }), ...(dn ? [dn] : []));
    }
    setView(key, build, force) {
      if (this.viewKey === key && !force) return this.body.firstElementChild;
      this.viewKey = key;
      this.onBig(key === 'play' || key === 'submitted' || key === 'load', key);
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
      const readyBtn = h('button', { class: 'btn big ' + (this.ready ? 'ghost' : 'primary'), onclick: () => { this.ready = !this.ready; this.send({ t: 'ready', on: this.ready }); this.fx('click'); readyBtn.classList.toggle('ghost', this.ready); readyBtn.classList.toggle('primary', !this.ready); readyBtn.textContent = this.ready ? 'Bereit ✓' : 'Ich bin bereit'; } }, this.ready ? 'Bereit ✓' : 'Ich bin bereit');
      const el = h('section', { class: 'pc-view' },
        h('h2', { text: 'Du bist dabei' }),
        h('p', { class: 'lead', text: this.canRecord ? 'Sprich kurz ins Mikro: Der Balken muss ausschlagen.' : 'Ohne Mikrofon beigetreten – du kannst zuschauen, aber nicht aufnehmen.' }),
        this.canRecord ? meter : null,
        readyBtn,
        this.canRecord ? VD.Denoise.switchEl() : null,
        h('div', { class: 'sub' }, h('span', { class: 'sub-h', text: 'Im Raum' }), list),
        this.local ? null : h('button', { class: 'btn link home-btn', onclick: () => { this.send({ t: 'leave' }); this.onLeave(); } }, 'Zur Startseite')
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
      const was = this.phase;
      this.phase = m.phase;
      if ((was === 'lobby') !== (m.phase === 'lobby')) this.renderTop();
      if (m.phase !== 'lobby') cancelAnimationFrame(this._mraf);
      if (m.phase === 'lobby') { this.resetScene(); this.setView('lobby', () => this.vLobby(), true); return; }
      if (m.spectate) { this.stopAll(); this.setView('spectate', () => this.vSpectate(m), true); return; }
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
    /* Rahmen passt sich dem echten Seitenverhältnis des Videos an */
    fitScreen(screen, video) {
      const apply = () => {
        const w = video && video.videoWidth, hh = video && video.videoHeight;
        if (w && hh) { this.vAr = w / hh; }
        if (this.vAr) screen.style.aspectRatio = String(this.vAr);
        return !!(w && hh);
      };
      if (apply() || !video) return;
      video.addEventListener('loadedmetadata', apply);
      let n = 0; const t = setInterval(() => { if (apply() || ++n > 20 || !screen.isConnected) clearInterval(t); }, 250);
    }
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
      const live = h('canvas', { class: 'dp-live', 'aria-label': 'Wellenform: Original und deine Aufnahme' });
      const status = h('p', { class: 'hint dp-status', text: '' });
      const mk = (cls, label, fn) => h('button', { class: 'btn ' + cls, onclick: fn }, label);
      const bBack = mk('dp-back', '◀', () => this.go(-1)); bBack.setAttribute('aria-label', 'Vorherige Zeile'); bBack.disabled = idx === 0;
      const bOrig = mk('', 'Original', () => this.doOriginal());
      const bRec = mk('dp-rec', 'Aufnahme', () => this.doRecord());
      const bTake = mk('', 'Mein Take', () => this.doTake());
      const bNext = mk('primary', idx === total - 1 ? 'Fertig ▶' : 'Weiter ▶', () => this.go(1));
      bTake.disabled = !take; bNext.disabled = !take;
      this.ui = { still, video, sub, bar, live, status, bBack, bOrig, bRec, bTake, bNext, line };
      this.wv = { orig: (line.pk || []).map((v) => v / 100), mine: take ? this.peaksOf(take.data, line) : [], pos: null, run: false };
      requestAnimationFrame(() => this.waveRender());
      const screen = h('div', { class: 'dp-screen' }, still, video, sub, h('div', { class: 'dp-bar' }, bar));
      this.fitScreen(screen, video);
      const dots = h('div', { class: 'dp-dots' }, this.lines.map((l, k) => h('i', { class: (k < idx || this.takes.has(l.i) ? 'ok ' : '') + (k === idx ? 'cur' : '') })));
      const el = h('section', { class: 'pc-view dub-play' },
        h('div', { class: 'dp-head' }, h('b', { class: 'dp-title', text: this.scene.title }), h('span', { class: 'dp-n', text: `LINE ${idx + 1}/${total}` })),
        dots,
        screen,
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
      if (this.mic) { this.mic.busy = kind === 'rec'; if (kind !== 'rec' && VD.Denoise) VD.Denoise.refresh(); }
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
      let vt0 = line.s0, sync = null;
      if (u.video) {
        const v = u.video;
        try {
          sync = await VD.Video.syncPlay(v, line.s0, opt.audio ? (off, delay) => (this.audioHandle = VD.audio.play(opt.audio, { gain: opt.gain || 0.95, delay, offset: Math.min(off, opt.audio.duration - 0.01) })) : null);
          if (token !== this.playToken) { sync.stop(); return null; }
          this.syncStop = sync.stop; vt0 = sync.vt0;
          // Video erst zeigen, wenn ein frisches Bild läuft; der Ablauf (und die Aufnahme) wartet nicht darauf
          VD.Video.frameReady(u.video, sync.vt0).then(() => { if (token === this.playToken) { u.video.hidden = false; u.still.hidden = true; } });
        } catch (e) { console.warn('Video startet nicht', e); }
      }
      if (token !== this.playToken) return null;
      const t0 = performance.now();
      if (opt.audio && !this.audioHandle) this.audioHandle = VD.audio.play(opt.audio, { gain: opt.gain || 0.95, delay: 0.005 });
      const lead = Math.max(0, vt0 - line.s0);
      const rest = Math.max(0.2, dur - lead);
      u.bar.style.transition = 'none'; u.bar.style.transform = `scaleX(${lead / dur})`;
      void u.bar.offsetWidth;
      u.bar.style.transition = `transform ${rest}s linear`; u.bar.style.transform = 'scaleX(1)';
      this.segTimer = setTimeout(() => { if (token === this.playToken) opt.onEnd && opt.onEnd(); }, rest * 1000 + (opt.extraMs || 0));
      return { t0, dur, vt0 };
    }

    stopPlayback() {
      this.playToken = (this.playToken || 0) + 1;
      if (this.syncStop) { this.syncStop(); this.syncStop = null; }
      this.waveStop();
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
      this.busy = null; this.stopping = false;
    }

    async doOriginal() {
      if (this.busy === 'orig') { this.stopPlayback(); this.setBusy(null); return; }
      this.stopPlayback();
      const line = this.ui.line;
      this.setBusy('orig');
      this.ui.status.textContent = '';
      await this.playSeg(line, { audio: line.orig, subtitle: true, onEnd: () => { this.stopPlayback(); this.setBusy(null); this.ui.status.textContent = ''; } });
    }

    async doRecord() {
      const u = this.ui;
      if (this.busy === 'rec') { this.finishRecord(true); return; }
      if (!this.mic || !this.mic.running) { VD.toast('Mikrofon nicht aktiv', 'warn'); return; }
      this.stopPlayback();
      const line = u.line;
      this.setBusy('rec');
      u.status.textContent = '';
      const started = await this.playSeg(line, { subtitle: false, extraMs: TAIL_MS, onEnd: () => this.finishRecord(false) });
      if (!started) return;
      this.recMark = this.mic.mark();
      this.waveStart('rec', started, line);
      this.recShift = Math.max(0, (started.vt0 || line.s0) - line.s0);   // Video lief schon ein Stück, als die Aufnahme begann
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
      u.status.textContent = 'Verarbeite …';
      try {
        const res = await VD.audio.resample(raw, sr, SR);
        const n = A.normalize(res, SR);
        const pad = Math.round((this.recShift || 0) * SR);
        if (pad > 0) { const d = new Float32Array(pad + n.data.length); d.set(n.data, pad); n.data = d; }
        this.takes.set(line.i, { data: n.data, gainDb: n.gainDb, silent: n.silent, sent: false });
        if (this.wv && this.ui === u) { this.wv.mine = this.peaksOf(n.data, line); this.waveRender(); }
      } catch (e) {
        console.error(e); VD.toast('Aufnahme konnte nicht verarbeitet werden', 'warn');
      }
      this.stopping = false;
      if (this.ui !== u) return;                        // inzwischen woanders
      this.setBusy(null);
      const t = this.takes.get(line.i);
      u.status.textContent = !t ? 'Die Aufnahme hat nicht geklappt. Versuche es nochmal.'
        : t.silent ? 'Ich habe fast nichts gehört. Sprich näher ans Mikro und nimm nochmal auf.'
        : '';
      this.sendProg('idle');
      this.fx('submit');
      if (manual) VD.vibrate(10);
    }

    /* ---------- Wellenform: Original (lila) und eigene Aufnahme (grün) ---------- */
    peaksOf(data, line) {
      const N = 160, total = line.s1 - line.s0, out = new Array(N).fill(0), per = (total * SR) / N;
      let mx = 0;
      for (let b = 0; b < N; b++) {
        const i0 = Math.floor(b * per), i1 = Math.min(data.length, Math.floor((b + 1) * per));
        let m = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(data[i]); if (v > m) m = v; }
        out[b] = m; if (m > mx) mx = m;
      }
      return out.map((v) => (mx > 0.002 ? v / mx : 0));
    }
    waveStart(mode, started, line) {
      const w = this.wv; if (!w) return;
      const dur = line.s1 - line.s0, lead = Math.max(0, (started.vt0 || line.s0) - line.s0);
      w.mode = mode; w.run = true; w.dur = dur; w.t0 = started.t0 - lead * 1000;
      if (mode === 'rec') { w.lat = (this.micLatencyMs() + 10) / 1000; w.mine = new Array(160).fill(0); w.raw = new Array(160).fill(0); w.rmax = 0; }
      const tick = () => {
        if (!w.run || this.wv !== w) return;
        w.pos = Math.min(1, Math.max(0, (performance.now() - w.t0) / 1000 / dur));
        if (mode === 'rec' && this.mic) {
          // Wie nach der Aufnahme: auf den lautesten Moment normiert, frühere Balken passen sich mit an
          // Das Mikrofon meldet mit Verzögerung: Der Pegel gehört zu einem früheren Zeitpunkt (so wie bei der fertigen Aufnahme)
          const tPos = Math.max(0, ((performance.now() - w.t0) / 1000 - w.lat) / dur);
          const b = Math.min(159, Math.floor(tPos * 160)); const pk = this.mic.peak || 0;
          if (pk > w.raw[b]) w.raw[b] = pk;
          if (pk > w.rmax) w.rmax = pk;
          const ref = Math.max(w.rmax, 0.01);
          for (let k = 0; k < 160; k++) w.mine[k] = Math.min(1, w.raw[k] / ref);
        }
        this.waveRender();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    waveStop() { const w = this.wv; if (!w) return; w.run = false; w.pos = null; this.waveRender(); }
    waveRender() {
      const w = this.wv, c = this.ui && this.ui.live;
      if (!w || !c || !c.isConnected) return;
      const dpr = window.devicePixelRatio || 1, cw = c.clientWidth, ch = c.clientHeight;
      if (!cw || !ch) return;
      if (c.width !== Math.round(cw * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
      g.fillStyle = 'rgba(255,255,255,.03)'; g.fillRect(0, 0, cw, ch);
      const mid = ch / 2;
      const area = (arr, fill, stroke) => {
        if (!arr || !arr.length) return;
        const n = arr.length;
        g.beginPath(); g.moveTo(0, mid);
        for (let i = 0; i < n; i++) g.lineTo(((i + 0.5) / n) * cw, mid - Math.max(1, arr[i] * (mid - 3)));
        g.lineTo(cw, mid);
        for (let i = n - 1; i >= 0; i--) g.lineTo(((i + 0.5) / n) * cw, mid + Math.max(1, arr[i] * (mid - 3)));
        g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke();
      };
      area(w.orig, 'rgba(169,123,255,.55)', 'rgba(196,163,255,.9)');
      area(w.mine, 'rgba(38,214,170,.8)', 'rgba(120,240,205,.95)');
      if (w.pos != null) { g.fillStyle = '#fff'; g.fillRect(Math.round(w.pos * cw) - 1, 0, 2, ch); }
    }

    micLatencyMs() {
      const extra = this.mic.extraLatencyMs || 0;   // Rauschunterdrückung verzögert um ca. 20 ms
      try {
        const t = this.mic.stream.getAudioTracks()[0];
        const l = t && t.getSettings && t.getSettings().latency;
        if (typeof l === 'number' && l > 0 && l < 0.5) return Math.round(l * 1000) + extra;
      } catch { /* ignore */ }
      return DEFAULT_LAT_MS + extra;
    }

    async doTake() {
      if (this.busy === 'take') { this.stopPlayback(); this.setBusy(null); return; }
      const u = this.ui, line = u.line, t = this.takes.get(line.i);
      if (!t) return;
      this.stopPlayback();
      this.setBusy('take');
      u.status.textContent = '';
      const st = await this.playSeg(line, { audio: VD.audio.fromFloat(t.data, SR), subtitle: false, onEnd: () => { this.stopPlayback(); this.setBusy(null); } });
      if (st) this.waveStart('take', st, line);
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

    /* Jeder Take wird nur einmal geschickt; eine neue Aufnahme ist ein neues Objekt mit sent: false.
       force: nach einem Verbindungsabbruch alles noch einmal schicken. */
    uploadTake(i, t, force) {
      if (!this.link || (t.sent && !force)) return;
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
    /* Zuschauen: Fortschritt der anderen, wie nach dem Abgeben */
    vSpectate(m) {
      this._roster = h('div', { class: 'roster' });
      const el = h('section', { class: 'pc-view center' }, h('h2', { text: m.title || 'Gleich bist du dabei' }),
        h('p', { class: 'lead', text: m.text || '' }), h('p', { class: 'hint', id: 'wait-n', text: '' }), this._roster);
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
      this.fin = null;
      if (!this.local && this.scene && this.scene.watch && !this.mix) {
        return h('section', { class: 'pc-view center' }, h('div', { class: 'medal', text: '🎬' }), h('h1', { text: 'Premiere!' }),
          h('p', { class: 'lead', text: 'Das Ergebnis wird gerade auf dein Gerät geladen …' }), h('p', { class: 'hint', text: 'Bis dahin läuft es beim Host auf dem Bildschirm.' }));
      }
      if (this.local || !this.mix || !this.scene) {
        return h('section', { class: 'pc-view center' }, h('div', { class: 'medal', text: '🎬' }), h('h1', { text: 'Premiere!' }),
          h('p', { class: 'lead', text: this.local ? 'Die Szene läuft auf diesem Bildschirm.' : 'Die Szene läuft beim Host auf dem Bildschirm.' }),
          h('p', { class: 'hint', text: 'Der Host führt euch danach zurück in die Lobby.' }));
      }
      const first = this.lines.find((l) => l.img), stillSrc = first ? first.img : this.stillUrl;
      const still = h('img', { class: 'dp-still', alt: '', src: stillSrc || '' }); if (!stillSrc) still.hidden = true;
      let video = null;
      if (this.videoUrl) { video = this.vEl || (this.vEl = VD.Video.create(this.videoUrl, this.videoMime, 'dp-video')); video.hidden = true; }
      const bar = h('i', { class: 'dp-barfill' });
      const status = h('p', { class: 'hint dp-status', text: '' });
      this.fin = { still, video, bar, status };
      const screen = h('div', { class: 'dp-screen' }, still, video, h('div', { class: 'dp-bar' }, bar));
      this.fitScreen(screen, video);
      return h('section', { class: 'pc-view dub-play' },
        h('div', { class: 'dp-head' }, h('b', { class: 'dp-title', text: this.scene.title }), h('span', { class: 'dp-n', text: 'PREMIERE' })),
        screen,
        status,
        VD.Export.buttons(() => this.mix ? { videoUrl: this.videoUrl, mime: this.videoMime, f32: this.mix.getChannelData(0), sr: this.mix.sampleRate, title: this.scene.title } : null),
        h('p', { class: 'hint', text: 'Der Host startet gemeinsame Wiederholungen und führt euch danach zurück in die Lobby.' }));
    }
    /* Gemeinsamer Start vom Host */
    onReplay(inMs) {
      const f = this.fin; if (!f || this.viewKey !== 'final' || !this.mix) return;
      this.stopPremiere();
      f.status.textContent = 'Gleich geht es los …';
      clearTimeout(this.replayTimer);
      this.playPremiere(true, inMs);
      this.replayTimer = setTimeout(() => { if (this.fin === f) f.status.textContent = ''; }, inMs);
    }
    async playPremiere(auto, inMs) {
      const f = this.fin; if (!f || this.viewKey !== 'final' || !this.mix) return;
      if (this.finPlaying) return;
      this.finPlaying = true;
      if (!auto && f.status) f.status.textContent = '';
      const token = (this.finToken = (this.finToken || 0) + 1);
      const dur = this.mix.duration;
      try {
        if (f.video) {
          const sync = await VD.Video.syncPlay(f.video, 0, (off, delay) => (this.finAudio = VD.audio.play(this.mix, { gain: 0.95, delay, offset: Math.min(off, dur - 0.01) })), inMs != null ? { inMs } : {});
          this.finSync = sync;
          if (token !== this.finToken) { sync.stop(); return; }
          VD.Video.frameReady(f.video, sync.vt0 || 0).then(() => { if (token === this.finToken) { f.video.hidden = false; f.still.hidden = true; } });
        }
      } catch (e) { console.warn('Video startet nicht', e); }
      if (token !== this.finToken) return;
      if (!this.finAudio) this.finAudio = VD.audio.play(this.mix, { gain: 0.95, delay: inMs != null ? Math.max(0.02, inMs / 1000) : 0.02 });
      f.bar.style.transition = 'none'; f.bar.style.transform = 'scaleX(0)'; void f.bar.offsetWidth;
      f.bar.style.transition = `transform ${dur}s linear`; f.bar.style.transform = 'scaleX(1)';
      this.finTimer = setTimeout(() => { if (token === this.finToken) this.stopPremiere(true); }, dur * 1000 + 300);
    }
    stopPremiere(ended) {
      this.finToken = (this.finToken || 0) + 1; this.finPlaying = false;
      if (this.finSync) { this.finSync.stop(); this.finSync = null; }
      clearTimeout(this.finTimer);
      if (this.finAudio) { try { this.finAudio.stop(); } catch { /* ignore */ } this.finAudio = null; }
      const f = this.fin; if (!f) return;
      if (f.video) { try { f.video.pause(); } catch { /* ignore */ } }
      if (ended && f.status) f.status.textContent = '';
      f.bar.style.transition = 'none'; f.bar.style.transform = 'scaleX(0)';
    }

    destroy() {
      this.stopAll();
      clearInterval(this._lvl); cancelAnimationFrame(this._mraf);
      try { this.wake && this.wake.release(); } catch { /* ignore */ }
    }
  };
})();
