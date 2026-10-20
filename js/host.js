/* Host: Spielablauf, Spielerverwaltung, Wertung.
   Die Ansichten (DOM) liegen in hostviews.js und werden in den Prototyp gemischt. */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const CFG = window.VD_CONFIG;
  const SR = A.SR;
  const END = { end: true };
  const Scene = VD.Scene;

  const DEFAULTS = { assign: 'random' };

  VD.Host = class {
    constructor(root) {
      this.root = root;
      this.players = new Map();
      this.banned = new Set();
      this.settings = Object.assign({}, DEFAULTS, VD.store.get('settings', {}));
      this.state = 'lobby';      // lobby | playing | final
      this.phase = 'lobby';
      this.lastPhase = { t: 'phase', phase: 'lobby' };
      this.pending = null;
    }

    /* ---------- Start / Netzwerk ---------- */
    async start() {
      this.buildFrame();
      this.showStage('boot', () => VD.h('div', { class: 'boot center' }, VD.h('span', { class: 'spinner big' }), VD.h('p', { class: 'lead', text: 'Raum wird erstellt …' })));
      await VD.audio.ensure();
      await VD.Packs.init();
      this.net = new VD.HostNet();
      try {
        this.code = await this.net.open();
      } catch (e) {
        this.offlineMode = true;
        this.code = null;
        VD.toast('Kein Online-Raum möglich: ' + VD.friendlyNetError(e) + ' Du kannst trotzdem allein auf diesem Gerät spielen.', 'warn');
      }
      if (this.net) {
        this.net.on('hello', (link, m) => this.onHello(link, m));
        this.net.on('error', (e) => console.warn('peer', e));
      }
      VD.Packs.on('change', () => this.onPacksChanged());
      this.updateRoomChip();
      document.addEventListener('keydown', (e) => this.onKey(e));
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => (this.wake = w)).catch(() => {});
      this.gotoLobby();
    }

    onKey(e) {
      if (/input|textarea|select/i.test((e.target.tagName || ''))) return;
      if (e.code === 'Space' && this.state === 'playing') { e.preventDefault(); this.hostNext(); }
    }

    /* ---------- Spieler ---------- */
    list() { return Array.from(this.players.values()); }
    connected() { return this.list().filter((p) => p.connected); }
    recorders() { return this.list().filter((p) => p.connected && p.active && p.canRecord); }

    onHello(link, m) {
      const L = CFG.limits;
      const pid = String(m.pid || '');
      if (!/^[a-z0-9]{6,24}$/.test(pid)) { link.send({ t: 'reject', reason: 'Ungültige Spieler-ID.' }); link.close(); return; }
      if (this.banned.has(pid)) { link.send({ t: 'reject', reason: 'Du wurdest aus diesem Raum entfernt.' }); link.close(); return; }
      let p = this.players.get(pid);
      if (!p) {
        if (this.players.size >= L.maxPlayers) { link.send({ t: 'reject', reason: 'Der Raum ist voll (max. ' + L.maxPlayers + ' Spieler).' }); link.close(); return; }
        const used = new Set(this.list().map((x) => x.color));
        const want = VD.COLORS.includes(m.color) && !used.has(m.color) ? m.color : VD.COLORS.find((c) => !used.has(c)) || VD.COLORS[0];
        p = { pid, color: want, ready: false, isLocal: false };
        this.players.set(pid, p);
        p.active = this.state === 'lobby' || this.state === 'final';
        VD.sfx.play('join');
      } else if (p.link && p.link !== link) { try { p.link.close(); } catch { /* ignore */ } }
      p.name = String(m.name || 'Spieler').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, L.maxNameLength) || 'Spieler';
      p.emoji = VD.AVATARS.includes(m.emoji) ? m.emoji : '🎤';
      p.canRecord = !!m.canRecord;
      p.link = link; p.connected = true; p.lvl = 0; p.state = 'idle';
      p.helloScene = m.sceneId || null;
      link.on('msg', (msg) => this.onPlayerMsg(p, msg));
      link.on('blob', (k, meta, bytes) => this.onPlayerBlob(p, k, meta, bytes));
      link.on('close', () => { if (p.link === link) { p.connected = false; this.onRosterChanged(); this.progress(); } });
      const snap = p.active ? this.lastPhase : { t: 'phase', phase: 'wait', text: 'Du steigst in der nächsten Runde ein.' };
      link.send({ t: 'welcome', pid, color: p.color, snap: snap.phase === 'lobby' || (p.assign && p.active && this.state === 'playing') ? null : snap });
      if (this.state === 'lobby') link.send({ t: 'phase', phase: 'lobby' });
      this.onRosterChanged();
      if (this.state === 'playing' && this.scene && p.active && p.assign && !this.phaseLoading && p.helloScene !== this.scene.id) this.sendScene(p);
      else if (this.state === 'playing' && this.scene && p.active && p.assign && p.helloScene === this.scene.id) this.sendProgress();
    }

    onPlayerMsg(p, m) {
      switch (m.t) {
        case 'ready': p.ready = !!m.on; this.onRosterChanged(); break;
        case 'lvl': p.lvl = VD.clamp(Number(m.v) || 0, 0, 1); break;
        case 'caps': if (this.scene && p.assign && !p.assetsSent) { p.assetsSent = true; this.sendAssets(p, !!m.video); } break;
        case 'loaded': if (this.scene && p.assign) { p.loaded = true; this.progress(); this.refreshStrip(); } break;
        case 'prog':
          if (p.assign) {
            p.prog = { cur: VD.clamp(Math.round(Number(m.cur) || 1), 1, p.assign.lineIdx.length || 1), st: ['idle', 'rec', 'done'].includes(m.st) ? m.st : 'idle' };
            this.sendProgress(); this.refreshStrip(); if (this.updatePlay) this.updatePlay();
          }
          break;
        case 'done': if (this.phase === 'play' && p.assign) { p.wantDone = true; this.checkDone(p); } break;
        case 'undone': if (p.assign) { p.wantDone = false; p.done = false; this.sendProgress(); this.refreshStrip(); if (this.updatePlay) this.updatePlay(); } break;
        case 'leave': this.removePlayer(p, false); break;
        default: break;
      }
    }

    /* Eine Aufnahme ist nur gültig, wenn die Zeile zu den Charakteren des Spielers gehört */
    onPlayerBlob(p, kind, meta, bytes) {
      if (kind !== 'take' || !p.active || !p.assign || (this.phase !== 'play' && this.phase !== 'load')) return;
      const i = Number(meta.i);
      if (!Number.isInteger(i) || !p.assign.lineIdx.includes(i)) return;
      if (bytes.byteLength % 2 || bytes.byteLength > CFG.limits.maxTakeBytes) return;
      const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      p.takes.set(i, { raw: VD.i16ToF32(i16), at: Date.now() });
      this.checkDone(p);
    }
    checkDone(p) {
      const full = p.assign && p.assign.lineIdx.every((i) => p.takes.has(i));
      const was = p.done;
      p.done = !!(p.wantDone && full);
      if (p.done !== was) { VD.sfx.play('submit'); this.sendProgress(); this.refreshStrip(); if (this.updatePlay) this.updatePlay(); this.progress(); }
    }

    removePlayer(p, ban) {
      if (ban) { this.banned.add(p.pid); try { p.link.send({ t: 'kicked' }); } catch { /* ignore */ } }
      try { p.link && p.link.close(); } catch { /* ignore */ }
      if (p.isLocal) this.removeLocalPlayer(true);
      this.players.delete(p.pid);
      this.onRosterChanged(); this.progress();
    }

    onRosterChanged() {
      const msg = { t: 'lobby', players: this.list().map((p) => ({ pid: p.pid, name: p.name, emoji: p.emoji, color: p.color, ready: !!p.ready, connected: p.connected })) };
      this.list().forEach((p) => p.connected && p.link.send(msg));
      this.refreshStrip();
      if (this.state === 'lobby') this.renderLobbyPlayers();
    }

    bcast(msg, filter) { this.list().forEach((p) => { if (p.connected && (!filter || filter(p))) p.link.send(msg); }); }
    setPhase(phase, extra, perPlayer) {
      this.phase = phase;
      this.lastPhase = Object.assign({ t: 'phase', phase }, extra);
      this.list().forEach((p) => { if (p.connected && p.active) p.link.send(perPlayer ? Object.assign({}, this.lastPhase, perPlayer(p)) : this.lastPhase); });
      this.refreshStrip();
      this.updateBar();
    }

    /* ---------- Lokaler Mitspieler (Mikro dieses Geräts) ---------- */
    async addLocalPlayer() {
      if (this.local || this._localBusy) return;
      this._localBusy = true;
      const mic = new VD.Mic();
      try { await mic.start(); } catch (e) { this._localBusy = false; VD.toast('Kein Mikrofonzugriff: ' + (e.message === 'insecure' ? 'Seite braucht HTTPS oder localhost.' : 'Bitte erlauben.'), 'warn'); return; }
      const profile = { pid: VD.store.get('hostPid', null) || VD.uid().replace(/[^a-z0-9]/g, 'x'), name: VD.store.get('hostName', 'Host'), emoji: '🎤', color: VD.COLORS[5] };
      VD.store.set('hostPid', profile.pid);
      const dock = VD.h('aside', { class: 'local-dock' });
      const head = VD.h('button', { class: 'dock-head', onclick: () => dock.classList.toggle('min') }, VD.h('span', { text: 'Du spielst mit (dieses Gerät)' }), VD.h('i', { text: '–' }));
      const inner = VD.h('div', { class: 'pc-root dock-body' });
      dock.append(head, inner);
      this.root.append(dock);
      document.body.classList.add('has-dock');
      const pair = VD.localPair();
      const ctrl = new VD.Controller(inner, { mic, profile, local: true, onKicked: () => this.removeLocalPlayer(true), onAttention: () => dock.classList.remove('min'), onBig: (on, key) => { dock.classList.toggle('big', on); if (on) dock.classList.remove('min'); else if (key === 'final') dock.classList.add('min'); } });
      
      this.local = { mic, ctrl, dock, pair, profile };
      this._localBusy = false;
      ctrl.attach(pair.client);
      this.onHello(pair.host, { t: 'hello', pid: profile.pid, name: profile.name, emoji: profile.emoji, color: profile.color, canRecord: true });
      const p = this.players.get(profile.pid);
      if (p) p.isLocal = true;
      this.renderLobbyPlayers();
      this.updateLobbySummary && this.updateLobbySummary();
    }
    removeLocalPlayer(fromPlayer) {
      if (!this.local) return;
      const { mic, ctrl, dock, pair, profile } = this.local;
      this.local = null;
      try { ctrl.destroy(); mic.stop(); pair.client.close(); } catch { /* ignore */ }
      dock.remove();
      document.body.classList.remove('has-dock');
      const p = this.players.get(profile.pid);
      if (p && !fromPlayer) this.players.delete(p.pid);
      this.onRosterChanged();
      this.updateLobbySummary && this.updateLobbySummary();
    }

    /* ---------- Einstellungen ---------- */
    setSetting(k, v) { this.settings[k] = v; VD.store.set('settings', this.settings); }

    /* ---------- Host-Steuerung ---------- */
    hostNext() { if (this.gate) { this.gate.open('next'); VD.sfx.play('click'); } else this.pending = 'next'; }
    hostEnd() { if (this.state !== 'playing') return; this.endRequested = true; if (this.gate) this.gate.open('end'); else this.pending = 'end'; }

    progress() { if (this.checkFn) this.checkFn(); }

    async waitPhase(o) {
      const gate = (this.gate = new VD.Gate());
      this.checkFn = o.check || null;
      const t0 = Date.now();
      if (this.pending) { const r = this.pending; this.pending = null; if (r !== 'next' || o.allowNext !== false) gate.open(r); }
      else if (o.check) o.check();
      while (!gate.done) {
        const lim = o.deadline ? o.deadline() : t0 + o.ms;
        const now = Date.now();
        if (now >= lim) { gate.open('timeout'); break; }
        await gate.wait(Math.min(200, lim - now));
        if (o.onTick) o.onTick(Date.now() - t0);
      }
      this.gate = null; this.checkFn = null;
      const r = gate.value;
      if (r === 'end') throw END;
      return r;
    }

    /* wartet, bis ein Gate geöffnet wird (z. B. Audio zu Ende) – Host kann mit "Weiter" abbrechen */
    async waitUntil(gate) {
      const r = await this.waitPhase({ deadline: () => (gate.done ? 0 : Infinity), check: () => {} });
      return r;
    }

    /* ---------- Spiel ---------- */
    async startGame() {
      const pack = VD.Packs.current();
      if (!pack) { VD.toast('Lade zuerst ein Dub-Pack in die Lobby.', 'warn'); return; }
      // Der Host spielt automatisch mit, außer er hat sich selbst entfernt
      if (!this.local && !this._optOut) await this.addLocalPlayer();
      const recs = this.list().filter((p) => p.connected && p.canRecord);
      if (!recs.length) { VD.toast('Mindestens ein Spieler mit Mikrofon wird gebraucht.', 'warn'); return; }
      await VD.audio.ensure();
      this.state = 'playing'; this.endRequested = false; this.pending = null; this.phaseLoading = true;
      this.list().forEach((p) => { p.active = p.connected; p.ready = false; p.assign = null; p.takes = new Map(); p.done = false; p.wantDone = false; p.loaded = false; p.assetsSent = false; p.prog = null; });
      this.onRosterChanged();
      try {
        await this.playScene(pack, recs);
      } catch (e) {
        if (e !== END) { console.error(e); VD.toast('Fehler im Spielablauf: ' + (e && e.message), 'warn'); }
      }
      this.stopAudio();
      this.phaseLoading = false;
      this.backToLobby();
    }

    stopAudio() {
      if (this.curPlay) { this.curPlay.stop(); this.curPlay = null; }
      if (this.fvideo) { try { this.fvideo.pause(); } catch { /* ignore */ } }
    }

    /* Szenen-Info an einen Spieler; die Medien folgen, sobald sein Gerät sagt, was es abspielen kann */
    sendScene(p) {
      const sc = this.scene;
      p.loaded = false; p.assetsSent = false;
      p.link.send({
        t: 'scene', id: sc.id, title: sc.title, author: sc.author, chars: p.assign.chars,
        videoMime: Scene.videoMime(sc.pack), videoSize: sc.pack.video.size,
        lines: p.assign.lineIdx.map((i) => { const l = sc.lines[i]; return { i, caption: l.caption, char: l.char, ts: l.ts, s0: l.s0, s1: l.s1, hasImg: !!l.imgBlob }; })
      });
      this.setPlayerPhase(p, { t: 'phase', phase: 'load' });
    }
    setPlayerPhase(p, msg) { if (p.connected) p.link.send(msg); }

    async sendAssets(p, video) {
      const sc = this.scene;
      try {
        for (const i of p.assign.lineIdx) {
          const l = sc.lines[i];
          if (l.imgBlob) await p.link.sendBlob('img', { i, mime: l.imgBlob.type || 'image/png' }, new Uint8Array(await l.imgBlob.arrayBuffer()));
          await p.link.sendBlob('orig', { i, sr: 16000 }, Scene.origBytes(sc, l));
        }
        if (video && sc.pack.video.size <= CFG.limits.maxBlobBytes) await p.link.sendBlob('video', { mime: sc.pack.video.type || Scene.videoMime(sc.pack) }, new Uint8Array(await sc.pack.video.arrayBuffer()));
        p.link.send({ t: 'assets_end', video: !!video && sc.pack.video.size <= CFG.limits.maxBlobBytes });
      } catch (e) { console.warn('Medien senden', e); }
    }

    sendProgress() {
      if (!this.scene || this.state !== 'playing') return;
      clearTimeout(this._progT);
      this._progT = setTimeout(() => {
        const list = this.list().filter((p) => p.assign && p.active).map((p) => ({ pid: p.pid, name: p.name, emoji: p.emoji, color: p.color, done: !!p.done, cur: p.prog ? p.prog.cur : 1, total: p.assign.lineIdx.length, chars: p.assign.chars }));
        this.bcast({ t: 'prog_all', list }, (p) => p.active);
      }, 120);
    }

    async playScene(pack, recs) {
      // 1) Szene vorbereiten
      this.showStage('prep', () => VD.h('div', { class: 'boot center' }, VD.h('span', { class: 'spinner big' }), VD.h('p', { class: 'lead', id: 'prep-t', text: 'Szene wird vorbereitet …' })));
      let scene;
      try { scene = await VD.Scene.build(pack, (t) => { const el = VD.$('#prep-t'); if (el) el.textContent = t; }); }
      catch (e) { console.error(e); VD.toast('Das Pack lässt sich nicht abspielen: ' + (e && e.message ? e.message : e), 'warn'); throw END; }
      this.scene = scene;
      VD.Scene.assign(scene, recs, this.settings.assign);
      recs.forEach((p) => { if (p.assign && !p.assign.lineIdx.length) p.assign = null; });   // mehr Spieler als Zeilen: Rest schaut zu
      const actives = this.list().filter((p) => p.active);
      actives.filter((p) => !p.assign).forEach((p) => { p.assign = null; });

      // 2) Medien verteilen
      this.phaseLoading = true;
      this.setPhase('load', {}, (p) => (p.assign ? {} : { text: 'Du schaust zu.' }));
      this.viewLoad(scene);
      for (const p of actives) if (p.assign && p.connected) this.sendScene(p);
      await this.waitPhase({
        ms: 90000,
        check: () => { if (actives.filter((p) => p.assign && p.connected).every((p) => p.loaded)) this.gate && this.gate.open('all'); },
        onTick: () => this.updateLoad && this.updateLoad()
      });
      this.phaseLoading = false;
      const ready = actives.filter((p) => p.assign && p.connected && p.loaded);
      if (!ready.length) { VD.toast('Kein Gerät konnte die Szene laden.', 'warn'); throw END; }
      actives.filter((p) => p.assign && !p.loaded).forEach((p) => { p.dropped = true; });

      // 3) Jeder nimmt in seinem eigenen Tempo auf
      this.setPhase('play', {}, (p) => (p.assign && p.loaded ? {} : { text: 'Du schaust zu.' }));
      this.viewPlay(scene);
      VD.sfx.play('whoosh');
      await this.waitPhase({
        deadline: () => Infinity,
        check: () => { const w = this.list().filter((p) => p.assign && p.loaded && p.connected); if (!w.length || w.every((p) => p.done)) this.gate && this.gate.open('all'); }
      });
      await this.waitPhase({ ms: 1200, allowNext: false });

      // 4) Gemeinsames Ergebnis (so oft ansehen, wie ihr wollt)
      await this.finalPhase(scene, ready);
    }

    async finalPhase(scene, players) {
      const recs = players.filter((p) => p.assign);
      this.finalCtx = { scene, recs };
      // Jeder Spieler bekommt den fertigen Ton und schaut die Szene selbst an
      try {
        const bytes = new Uint8Array(VD.f32ToI16(Scene.finalMix(scene, 0, recs)).buffer);
        await Promise.all(this.list().filter((p) => p.connected && p.assign && p.loaded && !p.isLocal && p.link).map((p) => p.link.sendBlob('mix', { sr: SR }, bytes).catch(() => {})));
      } catch (e) { console.warn('Mix senden', e); }
      this.setPhase('final', { title: scene.title });
      this.viewFinal(scene);
      let mode = 'all';
      for (;;) {
        this.finalInfo(scene, 0, recs);
        const mix = Scene.finalMix(scene, 0, recs);
        if (mode === 'all') await this.announceReplay(2500);   // alle starten gemeinsam
        await this.playFinal(scene, mix);                      // 'solo': nur auf diesem Bildschirm
        await this.waitPhase({ ms: 900, allowNext: false });
        this.finalButtons(true);
        const r = await this.waitPhase({ deadline: () => Infinity });
        this.finalButtons(false);
        mode = r === 'solo' ? 'solo' : 'all';
        if (r === 'lobby') return;
        VD.sfx.play('whoosh');
      }
    }

    /* Alle Geräte starten die Szene gemeinsam: jeder bekommt „in X ms“, abzüglich seiner halben Laufzeit */
    async announceReplay(ms) {
      for (const p of this.list()) {
        if (!p.connected || p.isLocal || !p.link || !p.assign) continue;
        try { p.link.send({ t: 'replay', in: Math.max(300, Math.round(ms - (p.link.rtt || 0) / 2)) }); } catch { /* ignore */ }
      }
      await VD.sleep(ms);
    }

    async playFinal(scene, mix) {
      const v = this.fvideo;
      const buf = VD.audio.fromFloat(mix, SR);
      let sync = null, play = null;
      if (v) {
        try { sync = await VD.Video.syncPlay(v, 0, (off, delay) => (play = VD.audio.play(buf, { gain: 0.95, delay, offset: Math.min(off, buf.duration - 0.01) }))); } catch (e) { console.warn('Video', e); }
      }
      if (!play) play = VD.audio.play(buf, { gain: 0.95, delay: 0.02 });
      this.curPlay = play;
      const done = new VD.Gate();
      play.done.then(() => done.open());
      const r = await this.waitUntil(done);
      play.stop(); if (sync) sync.stop(); if (v) v.pause();
      return r;
    }

    hostLobby() { if (this.gate) this.gate.open('lobby'); else this.pending = 'lobby'; }
    hostAgain() { if (this.gate) this.gate.open('again'); }
    hostSolo() { if (this.gate) this.gate.open('solo'); }

    backToLobby() {
      this.state = 'lobby'; this.phase = 'lobby'; this.scene = null;
      this.list().forEach((p) => { p.ready = false; p.active = true; p.assign = null; p.takes = new Map(); p.done = false; p.wantDone = false; p.prog = null; });
      this.lastPhase = { t: 'phase', phase: 'lobby' };
      this.bcast(this.lastPhase);
      this.onRosterChanged();
      if (this.fvideoUrl) { URL.revokeObjectURL(this.fvideoUrl); this.fvideoUrl = null; }
      this.fvideo = null;
      this.gotoLobby();
    }
  };
})();
