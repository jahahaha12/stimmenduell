/* Host: Spielablauf, Spielerverwaltung, Wertung.
   Die Ansichten (DOM) liegen in hostviews.js und werden in den Prototyp gemischt. */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const CFG = window.VD_CONFIG;
  const SR = A.SR;
  const SKIP = { skip: true }, END = { end: true };

  const DEFAULTS = { rounds: 4, maxScene: 30, watches: 1, submitGrace: 30, syncTime: 20 };

  VD.Host = class {
    constructor(root) {
      this.root = root;
      this.players = new Map();
      this.banned = new Set();
      this.settings = Object.assign({}, DEFAULTS, VD.store.get('settings', {}));
      this.state = 'lobby';      // lobby | playing | final
      this.phase = 'lobby';
      this.round = 0;
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
      if (e.key === 's' && this.state === 'playing') this.hostSkipClip();
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
        p = { pid, color: want, score: 0, ready: false, isLocal: false };
        this.players.set(pid, p);
        p.active = this.state === 'lobby' || this.state === 'final';
        VD.sfx.play('join');
      } else if (p.link && p.link !== link) { try { p.link.close(); } catch { /* ignore */ } }
      p.name = String(m.name || 'Spieler').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, L.maxNameLength) || 'Spieler';
      p.emoji = VD.AVATARS.includes(m.emoji) ? m.emoji : '🎤';
      p.canRecord = !!m.canRecord;
      p.link = link; p.connected = true; p.lvl = 0; p.state = 'idle';
      link.on('msg', (msg) => this.onPlayerMsg(p, msg));
      link.on('blob', (k, meta, bytes) => this.onPlayerBlob(p, k, meta, bytes));
      link.on('close', () => { if (p.link === link) { p.connected = false; this.onRosterChanged(); this.progress(); } });
      const snap = p.active ? this.lastPhase : { t: 'phase', phase: 'wait', text: 'Du steigst in der nächsten Runde ein.' };
      link.send({ t: 'welcome', pid, color: p.color, score: p.score, snap: snap.phase === 'lobby' ? null : snap });
      if (this.state === 'lobby') link.send({ t: 'phase', phase: 'lobby' });
      this.onRosterChanged();
    }

    onPlayerMsg(p, m) {
      switch (m.t) {
        case 'ready': p.ready = !!m.on; this.onRosterChanged(); break;
        case 'lvl': p.lvl = VD.clamp(Number(m.v) || 0, 0, 1); this.pushLvl(p, p.lvl); break;
        case 'state': if (['recording', 'review', 'idle'].includes(m.s)) { p.state = m.s; if (m.s === 'recording') { p.lvlHist = []; } this.refreshStrip(); } break;
        case 'nudge': if (this.phase === 'sync' && p.take) { p.nudge = VD.clamp(Math.round(Number(m.ms) || 0), -1500, 1500); p.syncOk = false; if (this.syncRebuild) this.syncRebuild(); this.onNudge(p); } break;
        case 'syncok': if (this.phase === 'sync') { p.syncOk = true; this.onNudge(p); this.progress(); } break;
        case 'retake':
          if (this.phase === 'record' && p.role && this.gate) {
            if (this.retakesLeft > 0) { this.retakesLeft--; VD.toast(p.name + ' möchte die Szene nochmal aufnehmen.'); this.gate.open('retake'); }
            else p.link.send({ t: 'toast', text: 'Es gab schon zwei neue Versuche. Gib deine Aufnahme ab.' });
          }
          break;
        case 'vote': if (this.phase === 'vote' && p.active && this.voteOptions && this.voteOptions.has(m.target) && m.target !== p.pid) { p.voteTarget = m.target; this.onVoteCast(p); this.progress(); } break;
        case 'leave': this.removePlayer(p, false); break;
        default: break;
      }
    }

    pushLvl(p, v) { (p.lvlHist = p.lvlHist || []).push(v); if (p.lvlHist.length > 60) p.lvlHist.shift(); }

    onPlayerBlob(p, kind, meta, bytes) {
      if (kind !== 'take' || this.phase !== 'record' || !p.active || p.submitted || !p.role) return;
      if (meta.round !== this.round || meta.attempt !== this.attempt || bytes.byteLength % 2 || bytes.byteLength > CFG.limits.maxTakeBytes) return;
      const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      p.take = { raw: VD.i16ToF32(i16), preMs: VD.clamp(Number(meta.preMs) || 500, 0, 2000), lat: VD.clamp(Number(meta.lat) || 0, 0, 1500), silent: !!meta.silent };
      p.submitted = true; p.state = 'done';
      if (!this.firstSubmitAt) this.firstSubmitAt = Date.now();
      VD.sfx.play('submit');
      this.refreshStrip(); this.onSubmitted(p);
      this.progress();
    }

    removePlayer(p, ban) {
      if (ban) { this.banned.add(p.pid); try { p.link.send({ t: 'kicked' }); } catch { /* ignore */ } }
      try { p.link && p.link.close(); } catch { /* ignore */ }
      if (p.isLocal) this.removeLocalPlayer(true);
      this.players.delete(p.pid);
      this.onRosterChanged(); this.progress();
    }

    onRosterChanged() {
      const msg = { t: 'lobby', players: this.list().map((p) => ({ pid: p.pid, name: p.name, emoji: p.emoji, color: p.color, ready: !!p.ready, connected: p.connected, score: p.score })) };
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
      if (this.local) return;
      const mic = new VD.Mic();
      try { await mic.start(); } catch (e) { VD.toast('Kein Mikrofonzugriff: ' + (e.message === 'insecure' ? 'Seite braucht HTTPS oder localhost.' : 'Bitte erlauben.'), 'warn'); return; }
      const profile = { pid: VD.store.get('hostPid', null) || VD.uid().replace(/[^a-z0-9]/g, 'x'), name: VD.store.get('hostName', 'Host'), emoji: '🎤', color: VD.COLORS[5] };
      VD.store.set('hostPid', profile.pid);
      const dock = VD.h('aside', { class: 'local-dock' });
      const head = VD.h('button', { class: 'dock-head', onclick: () => dock.classList.toggle('min') }, VD.h('span', { text: 'Dein Mikro (dieses Gerät)' }), VD.h('i', { text: '–' }));
      const inner = VD.h('div', { class: 'pc-root dock-body' });
      dock.append(head, inner);
      this.root.append(dock);
      document.body.classList.add('has-dock');
      const pair = VD.localPair();
      const ctrl = new VD.Controller(inner, { mic, profile, local: true, onKicked: () => this.removeLocalPlayer(true), onAttention: () => dock.classList.remove('min') });
      if (innerWidth < 1100) dock.classList.add('min');
      this.local = { mic, ctrl, dock, pair, profile };
      ctrl.attach(pair.client);
      this.onHello(pair.host, { t: 'hello', pid: profile.pid, name: profile.name, emoji: profile.emoji, color: profile.color, canRecord: true });
      const p = this.players.get(profile.pid);
      if (p) p.isLocal = true;
      this.renderLobbyPlayers();
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
    }

    /* ---------- Einstellungen ---------- */
    setSetting(k, v) { this.settings[k] = v; VD.store.set('settings', this.settings); }

    /* ---------- Host-Steuerung ---------- */
    hostNext() { if (this.gate) { this.gate.open('next'); VD.sfx.play('click'); } else this.pending = 'next'; }
    hostSkipClip() { if (this.state !== 'playing') return; VD.sfx.play('click'); if (this.gate) this.gate.open('skipClip'); else this.pending = 'skipClip'; }
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
      if (r === 'skipClip') throw SKIP;
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
      const rec = this.list().filter((p) => p.connected && p.canRecord);
      if (!rec.length) { VD.toast('Mindestens ein Spieler mit Mikrofon wird gebraucht.', 'warn'); return; }
      if (!VD.Packs.enabledClips().length) { VD.toast('Aktiviere mindestens ein Pack oder lade ein Video hoch.', 'warn'); return; }
      await VD.audio.ensure();
      this.state = 'playing'; this.endRequested = false; this.pending = null; this.emptyRounds = 0;
      this.usedScenes = new Set();
      this.list().forEach((p) => { p.score = 0; p.active = p.connected; p.ready = false; });
      this.onRosterChanged();
      try {
        for (this.round = 1; this.round <= this.settings.rounds; this.round++) {
          try { await this.playRound(); }
          catch (e) { if (e === SKIP) { VD.toast('Szene übersprungen'); this.round--; this.stopAudio(); continue; } throw e; }
        }
      } catch (e) {
        if (e !== END) { console.error(e); VD.toast('Fehler im Spielablauf: ' + (e && e.message), 'warn'); }
      }
      this.stopAudio();
      this.round = Math.min(this.round, this.settings.rounds);
      await this.finalScreen();
    }

    stopAudio() {
      this.syncStop = true;
      if (this.curPlay) { this.curPlay.stop(); this.curPlay = null; }
      if (this.curBack) { this.curBack.stop(); this.curBack = null; }
      if (this.visual) { this.visual.stop(); }
    }

    /* Rolle als Zusatzinfo für die Handys */
    roleInfo(p) {
      const sc = this.scene;
      if (!p.role) return { role: null };
      return { role: { free: !!sc.free, label: p.role.label, lines: p.role.lines.map((l) => ({ text: l.text })) } };
    }

    async playRound() {
      const total = this.settings.rounds;
      this.showStage('prep', () => VD.h('div', { class: 'boot center' }, VD.h('span', { class: 'spinner big' }), VD.h('p', { class: 'lead', text: 'Nächste Szene wird vorbereitet …' })));
      this.list().forEach((p) => {
        p.active = p.connected; p.submitted = false; p.take = null; p.nudge = 0; p.syncOk = false; p.voteTarget = null;
        p.roundTotal = 0; p.roundVotes = 0; p.lvlHist = []; p.state = 'idle'; p.role = null; p.aligned = null; p._mask = null;
      });
      const recs = this.recorders();
      if (!recs.length) { VD.toast('Niemand mit Mikrofon ist verbunden.', 'warn'); throw END; }
      const scene = await VD.Scene.pick(this.settings, recs.length, this.usedScenes);
      if (!scene) { VD.toast('Es gibt keine abspielbare Szene. Prüfe die Packs und die maximale Szenenlänge.', 'warn'); throw END; }
      this.scene = scene;
      VD.Scene.assign(scene, recs);
      const cast = new Map(this.list().filter((p) => p.active).map((p) => [p.pid, p]));
      if (this.visual) this.visual.destroy();
      const visual = (this.visual = VD.Scene.visual(scene, cast));
      this.firstSubmitAt = null; this.voteOptions = null; this.clipForLate = null;
      this.retakesLeft = 2; this.attempt = 0;
      const actives = this.list().filter((p) => p.active);

      // 1) Besetzung
      this.setPhase('intro', { round: this.round, total, title: scene.title }, (p) => this.roleInfo(p));
      this.viewIntro(scene, total);
      VD.sfx.play('whoosh');
      visual.prepare();
      await this.waitPhase({ ms: 5000 });

      // 2) Countdown + Aufnahme (mit Wiederholung auf Wunsch)
      for (;;) {
        this.attempt++;
        this.list().forEach((p) => { p.take = null; p.submitted = false; p.state = 'idle'; p.lvlHist = []; });
        this.firstSubmitAt = null;
        this.setPhase('countdown', { ms: 3000, attempt: this.attempt }, (p) => (p.role ? {} : { skip: true }));
        this.viewRecord(scene, visual, true);
        await visual.prepare();
        await this.waitPhase({ ms: 3100, check: null });
        this.hideCountdown();
        await visual.play();
        const t0 = Date.now();
        this.setPhase('record', { attempt: this.attempt }, (p) => (p.role ? { cue: VD.Scene.cueFor(scene, p) } : {}));
        this.recT0 = t0;
        const hard = t0 + Math.round(scene.dur * 1000 + 60000);
        const why = await this.waitPhase({
          deadline: () => {
            let lim = hard;
            if (this.firstSubmitAt) lim = Math.min(lim, this.firstSubmitAt + this.settings.submitGrace * 1000);
            return lim;
          },
          check: () => { const r = this.recorders().filter((p) => p.role); if (!r.length || r.every((p) => p.submitted)) this.gate && this.gate.open('all'); },
          onTick: () => this.tickRecord()
        });
        visual.stop();
        if (why === 'retake') { VD.sfx.play('whoosh'); continue; }
        break;
      }

      const subs = actives.filter((p) => p.submitted && p.take && p.role);
      if (!subs.length) {
        this.setPhase('wait', { text: 'Diesmal wurde nichts aufgenommen.' });
        this.showStage('none', () => VD.h('div', { class: 'boot center' }, VD.h('h1', { text: 'Keine Aufnahmen' }), VD.h('p', { class: 'lead', text: 'Diese Szene zählt nicht. Weiter geht’s …' })));
        await this.waitPhase({ ms: 2500 });
        this.round--;
        if (++this.emptyRounds >= 2) { VD.toast('Zwei Szenen ohne Aufnahme – Spiel beendet.', 'warn'); throw END; }
        return;
      }
      this.emptyRounds = 0;

      // 3) Feinschliff: alle hören sich im Video, jeder kann seine Stimme verschieben
      await this.syncPhase(scene, subs);

      // 4) Premiere
      await this.premiere(scene, subs);

      // 5) Abstimmung
      if (subs.length >= 2) await this.votePhase(subs);

      // 6) Punkte + Ergebnis
      this.awardPoints(subs);
      await this.resultsPhase(subs);
    }

    /* Aufnahme auf die Szenenzeit legen: das Handy hat beim Eintreffen des "Los" begonnen (+ Vorlauf) */
    alignAll(scene, subs) {
      const outLen = Math.round((scene.dur + 0.4) * SR);
      scene.outLen = outLen;
      for (const p of subs) {
        const lagMs = p.take.preMs - (p.take.lat || 0);
        p.take.lag = Math.round((lagMs / 1000) * SR);
        p.autoMs = Math.round(p.take.lat || 0);
        p._mask = null;
        p.aligned = A.alignTake(p.take.raw, p.take.lag, Math.round(((p.nudge || 0) / 1000) * SR), outLen);
      }
      return outLen;
    }
    buildMix(scene, subs) {
      const outLen = this.alignAll(scene, subs);
      return VD.Scene.mixdown(scene, subs, outLen, SR);
    }

    async playMixOnce(scene, mix, opt = {}) {
      const visual = this.visual;
      await visual.play();
      const play = (this.curPlay = VD.audio.play(VD.audio.fromFloat(mix, SR), { gain: 0.95, delay: 0.01 }));
      if (scene.backing && opt.backing !== false) {
        VD.Packs.getBacking(scene.backing.pack).then((b) => { if (b && this.curPlay === play) this.curBack = VD.audio.play(b, { gain: 0.3, offset: Math.min(scene.backing.start, Math.max(0, b.duration - 0.2)), delay: 0 }); });
      }
      await Promise.race([play.done, VD.sleep(scene.dur * 1000 + 800)]);
      play.stop();
      if (this.curBack) { this.curBack.stop(); this.curBack = null; }
    }

    async syncPhase(scene, subs) {
      let mix = this.buildMix(scene, subs);
      subs.forEach((p) => p.link.send({ t: 'phase', phase: 'sync' }));
      this.bcast({ t: 'phase', phase: 'wait', text: 'Die Stimmen werden gemischt …' }, (p) => p.active && !subs.includes(p));
      this.phase = 'sync';
      this.viewSync(scene, subs, this.visual);
      VD.sfx.play('whoosh');
      this.syncStop = false;
      this.mixDirty = false;
      this.syncRebuild = () => { this.mixDirty = true; };
      const loop = (async () => {
        await VD.sleep(500);
        while (!this.syncStop) {
          if (this.mixDirty) { mix = this.buildMix(scene, subs); this.mixDirty = false; }
          await this.playMixOnce(scene, mix, { backing: true });
          this.visual.stop();
          if (this.syncStop) break;
          await VD.sleep(900);
        }
      })();
      try {
        await this.waitPhase({
          ms: this.settings.syncTime * 1000,
          check: () => { if (subs.every((p) => p.syncOk || !p.connected)) this.gate && this.gate.open('all'); }
        });
      } finally {
        this.syncStop = true; this.syncRebuild = null;
        this.stopAudio();
        await loop.catch(() => {});
      }
      this.finalMix = this.buildMix(scene, subs);
    }

    async premiere(scene, subs) {
      this.setPhase('wait', { text: 'Premiere! Schaut auf den großen Bildschirm.' });
      this.viewPremiere(scene, subs, this.visual);
      this.syncStop = false;
      await this.waitPhase({ ms: 1800 });
      for (let k = 0; k < this.settings.watches; k++) {
        await this.playMixOnce(scene, this.finalMix);
        this.visual.stop();
        await this.waitPhase({ ms: k < this.settings.watches - 1 ? 1200 : 1500 });
      }
      this.stopAudio();
    }

    async votePhase(subs) {
      this.voteOptions = new Map(subs.map((p) => [p.pid, p]));
      const options = subs.map((p) => ({ pid: p.pid, name: p.name, emoji: p.emoji, color: p.color }));
      const voters = () => this.list().filter((p) => p.connected && p.active);
      this.setPhase('vote', { options });
      this.viewVote(subs);
      await this.waitPhase({
        ms: 25000,
        check: () => { const v = voters().filter((p) => !(subs.length === 1 && subs[0] === p)); if (v.every((p) => p.voteTarget)) this.gate && this.gate.open('all'); }
      });
      const tally = new Map(subs.map((p) => [p.pid, 0]));
      voters().forEach((v) => { if (v.voteTarget && tally.has(v.voteTarget)) tally.set(v.voteTarget, tally.get(v.voteTarget) + 1); });
      subs.forEach((p) => (p.roundVotes = tally.get(p.pid) || 0));
      await this.showVoteResult(subs);
      await this.waitPhase({ ms: 2600 });
    }

    /* 100 Punkte pro Stimme, 25 fürs Mitmachen */
    awardPoints(subs) {
      for (const p of subs) {
        p.roundTotal = 25 + p.roundVotes * 100;
        p.score += p.roundTotal;
      }
    }

    async resultsPhase(subs) {
      const ranking = this.list().filter((p) => p.active).sort((a, b) => b.score - a.score);
      ranking.forEach((p, i) => {
        if (!p.connected) return;
        const sub = subs.includes(p);
        p.link.send({ t: 'phase', phase: 'results', round: this.round, votes: sub ? p.roundVotes : 0, total: sub ? p.roundTotal : 0, rank: i + 1, score: p.score });
      });
      this.phase = 'results'; this.lastPhase = { t: 'phase', phase: 'results', round: this.round, votes: 0, total: 0, rank: 0, score: 0 };
      this.onRosterChanged();
      this.viewResults(subs, ranking);
      VD.sfx.play('score');
      const best = subs.slice().sort((a, b) => b.roundTotal - a.roundTotal)[0];
      if (best) setTimeout(() => VD.confetti(0.5), 700);
      await this.waitPhase({ ms: this.round >= this.settings.rounds ? 5000 : 8000 });
    }

    async finalScreen() {
      const ranking = this.list().filter((p) => p.score > 0 || p.active).sort((a, b) => b.score - a.score);
      this.state = 'final';
      ranking.forEach((p, i) => p.connected && p.link.send({ t: 'phase', phase: 'final', rank: i + 1, score: p.score }));
      this.phase = 'final'; this.lastPhase = { t: 'phase', phase: 'final', rank: 0, score: 0 };
      this.viewFinal(ranking);
      this.updateBar();
    }

    backToLobby() {
      this.state = 'lobby'; this.phase = 'lobby';
      this.list().forEach((p) => { p.score = 0; p.ready = false; p.active = true; p.submitted = false; });
      this.lastPhase = { t: 'phase', phase: 'lobby' };
      this.bcast(this.lastPhase);
      this.onRosterChanged();
      this.gotoLobby();
    }
  };
})();
