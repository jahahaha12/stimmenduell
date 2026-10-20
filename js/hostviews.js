/* Host-Bildschirm: alle Ansichten (Lobby, Runden, Ergebnis, Finale) */
(function () {
  const VD = (window.VD = window.VD || {});
  const A = window.VDA;
  const h = VD.h;
  const SR = A.SR;

  function qrSvg(url) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url); qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { console.warn('QR', e); return ''; }
  }

  async function filesFromDrop(dt) {
    const entries = Array.from(dt.items || []).map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return Array.from(dt.files);
    const out = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name });
        out.push(f);
      } else if (entry.isDirectory) {
        const r = entry.createReader(), all = [];
        for (;;) { const b = await new Promise((res, rej) => r.readEntries(res, rej)); if (!b.length) break; all.push(...b); }
        for (const e of all) await walk(e, path + entry.name + '/');
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  const views = {
    /* ---------- Rahmen ---------- */
    buildFrame() {
      this.stage = h('main', { class: 'h-stage', id: 'stage' });
      this.strip = h('footer', { class: 'h-strip', id: 'strip' });
      this.bar = h('div', { class: 'h-bar', id: 'hbar', hidden: true });
      this.roomChip = h('div', { class: 'room-chip' });
      const sound = h('button', { class: 'icon-btn', title: 'Ton an/aus', 'aria-label': 'Ton an oder aus', onclick: (e) => { VD.sfx.enabled = !VD.sfx.enabled; e.currentTarget.classList.toggle('off', !VD.sfx.enabled); } }, '♪');
      const full = h('button', { class: 'icon-btn', title: 'Vollbild', 'aria-label': 'Vollbild', onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } }, '⛶');
      const header = h('header', { class: 'h-top' }, h('div', { class: 'brand', text: 'Stimmenduell' }), this.roomChip, h('div', { class: 'h-tools' }, sound, full));
      this.root.replaceChildren(header, this.stage, this.strip, this.bar);
      this.stripMap = new Map();
      this.barRefs = null;

      // Drag & Drop für Packs (nur in der Lobby)
      const stop = (e) => { e.preventDefault(); };
      window.addEventListener('dragover', (e) => { if (this.state === 'lobby') { stop(e); document.body.classList.add('dragging'); } });
      window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
      window.addEventListener('drop', async (e) => {
        document.body.classList.remove('dragging');
        if (this.state !== 'lobby') return;
        stop(e);
        this.importFiles(await filesFromDrop(e.dataTransfer));
      });
      this.stripLoop();
    },

    showStage(key, build) {
      this.stageKey = key;
      const el = build();
      el.classList.add('stage-view', 'view-in');
      this.stage.replaceChildren(el);
      return el;
    },

    updateRoomChip() {
      if (!this.code) { this.roomChip.replaceChildren(h('span', { class: 'rc-off', text: 'Nur lokal' })); return; }
      const url = VD.joinUrl(this.code);
      const qr = h('div', { class: 'rc-qr', title: url });
      qr.innerHTML = qrSvg(url);
      this.roomChip.replaceChildren(h('span', { class: 'rc-l', text: 'Raum' }), h('b', { class: 'rc-code', text: this.code }), qr);
    },

    /* ---------- Spielerleiste ---------- */
    refreshStrip() {
      const showing = this.state !== 'lobby';
      this.strip.hidden = !showing;
      if (!showing) return;
      const ids = new Set();
      const stateText = (p) => (!p.connected ? 'offline' : !p.active ? 'wartet' : this.phase === 'record' ? ({ idle: 'bereit', recording: 'nimmt auf', review: 'prüft', done: 'abgegeben ✓' }[p.state] || '') : '');
      this.list().forEach((p) => {
        ids.add(p.pid);
        let c = this.stripMap.get(p.pid);
        if (!c) {
          const fill = h('i', { class: 'vu-fill' });
          const kick = h('button', { class: 'kick', title: 'Spieler entfernen', 'aria-label': p.name + ' entfernen', onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.sure) { this.removePlayer(p, true); return; }
            b.dataset.sure = '1'; b.textContent = 'Sicher?';
            setTimeout(() => { delete b.dataset.sure; b.textContent = '✕'; }, 2500);
          } }, '✕');
          c = { el: h('div', { class: 'ch' }), fill, kick, name: h('span', { class: 'ch-name' }), score: h('b', { class: 'ch-score' }), st: h('em', { class: 'ch-st' }), av: h('span') };
          c.el.append(c.av, h('div', { class: 'ch-meta' }, c.name, c.st), c.score, h('div', { class: 'vu' }, fill), kick);
          this.strip.append(c.el);
          this.stripMap.set(p.pid, c);
        }
        c.el.style.setProperty('--c', p.color);
        c.el.classList.toggle('off', !p.connected || !p.active);
        c.el.classList.toggle('done', this.phase === 'record' && p.state === 'done');
        const av = VD.ui.avatar(p, 'sm'); c.av.replaceWith(av); c.av = av;
        c.name.textContent = p.name; c.st.textContent = stateText(p);
        const s = Math.round(p.score);
        if (c.score.textContent !== String(s)) { c.score.textContent = String(s); c.score.classList.remove('bump'); void c.score.offsetWidth; c.score.classList.add('bump'); }
      });
      for (const [pid, c] of this.stripMap) if (!ids.has(pid)) { c.el.classList.add('out'); setTimeout(() => c.el.remove(), 250); this.stripMap.delete(pid); }
    },
    stripLoop() {
      const loop = () => {
        for (const [pid, c] of this.stripMap) {
          const p = this.players.get(pid);
          if (!p) continue;
          const live = this.phase === 'record' && p.state === 'recording' ? p.lvl : 0;
          p._vu = (p._vu || 0) * 0.8 + live * 0.2;
          c.fill.style.transform = `scaleY(${Math.min(1, Math.pow(p._vu * 1.4, 0.7))})`;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    /* ---------- Steuerleiste ---------- */
    updateBar() {
      const on = this.state === 'playing';
      this.bar.hidden = !on;
      document.body.classList.toggle('playing', on);
      if (!on) return;
      if (!this.barRefs) {
        const label = h('span', { class: 'bar-l' });
        const next = h('button', { class: 'btn sm', onclick: () => this.hostNext() }, 'Weiter', h('kbd', { text: 'Leertaste' }));
        const skip = h('button', { class: 'btn sm', onclick: () => this.hostSkipClip() }, 'Szene überspringen', h('kbd', { text: 'S' }));
        const end = h('button', { class: 'btn sm ghost', onclick: (e) => {
          const b = e.currentTarget;
          if (b.dataset.sure) { this.hostEnd(); return; }
          b.dataset.sure = '1'; b.firstChild.textContent = 'Wirklich beenden?';
          setTimeout(() => { delete b.dataset.sure; b.firstChild.textContent = 'Spiel beenden'; }, 2500);
        } }, h('span', { text: 'Spiel beenden' }));
        this.bar.replaceChildren(label, h('div', { class: 'bar-btns' }, next, skip, end));
        this.barRefs = { label };
      }
      const names = { intro: 'Besetzung', countdown: 'Countdown', record: 'Aufnahme', sync: 'Feinschliff', wait: 'Premiere', vote: 'Abstimmung', results: 'Ergebnis' };
      this.barRefs.label.textContent = `Szene ${Math.min(this.round, this.settings.rounds)}/${this.settings.rounds} · ${names[this.phase] || ''}`;
    },

    /* ---------- Lobby ---------- */
    gotoLobby() {
      this.state = 'lobby'; this.phase = 'lobby';
      this.refreshStrip(); this.updateBar();
      document.body.classList.remove('playing');
      this.showStage('lobby', () => this.buildLobby());
      this.renderLobbyPlayers(); this.renderPacks();
    },

    seg(label, key, opts, help) {
      const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
      opts.forEach((o) => {
        const b = h('button', { class: 'seg-b' + (this.settings[key] === o.v ? ' on' : ''), onclick: () => {
          this.setSetting(key, o.v);
          VD.$$('.seg-b', wrap).forEach((x) => x.classList.remove('on')); b.classList.add('on');
          VD.sfx.play('click'); this.updateLobbySummary();
        } }, o.t);
        wrap.append(b);
      });
      return h('div', { class: 'field' }, h('span', { class: 'field-l', text: label }), wrap, help ? h('small', { class: 'field-h', text: help }) : null);
    },

    buildLobby() {
      const join = h('section', { class: 'panel join' });
      if (this.code) {
        const url = VD.joinUrl(this.code);
        const plate = h('div', { class: 'qr-plate' });
        plate.innerHTML = qrSvg(url);
        const copy = h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(url); b.textContent = 'Kopiert ✓'; } catch { VD.toast(url); } } }, 'Link kopieren');
        join.append(
          h('h2', { text: 'Handy zücken und beitreten' }),
          h('div', { class: 'join-row' }, plate, h('div', { class: 'join-info' },
            h('p', { class: 'muted', text: 'QR-Code scannen oder diese Seite öffnen und den Code eingeben:' }),
            h('div', { class: 'code-big', 'aria-label': 'Raum-Code ' + this.code.split('').join(' ') }, ...this.code.split('').map((ch, i) => h('span', { style: { '--i': i }, text: ch }))),
            h('p', { class: 'join-url', text: location.host + location.pathname }),
            copy)));
      } else {
        join.append(h('h2', { text: 'Nur lokal' }), h('p', { class: 'muted', text: 'Der Online-Raum ist nicht verfügbar. Du kannst trotzdem mit dem Mikro dieses Geräts spielen (z. B. reihum).' }));
      }

      this.lobbyRefs = { players: h('div', { class: 'players' }), packs: h('div', { class: 'pack-list' }), status: h('p', { class: 'status', 'aria-live': 'polite' }), help: h('div', { class: 'pack-help', hidden: true }), summary: h('span', { class: 'sum' }), start: null };
      const localBtn = h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; if (this.local) { this.removeLocalPlayer(false); b.textContent = 'Mit diesem Gerät mitspielen'; } else { await this.addLocalPlayer(); if (this.local) b.textContent = 'Dieses Gerät entfernen'; } } }, this.local ? 'Dieses Gerät entfernen' : 'Mit diesem Gerät mitspielen');
      const players = h('section', { class: 'panel' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Spieler' }), localBtn), this.lobbyRefs.players);

      const rules = h('section', { class: 'panel rules' }, h('h2', { text: 'Regeln' }),
        this.seg('Szenen', 'rounds', [2, 4, 6, 8].map((v) => ({ v, t: String(v) }))),
        this.seg('Längste Szene', 'maxScene', [{ v: 20, t: '20 s' }, { v: 30, t: '30 s' }, { v: 45, t: '45 s' }, { v: 60, t: '60 s' }], 'Lange Videos werden auf diese Länge gekürzt.'),
        this.seg('Premiere ansehen', 'watches', [{ v: 1, t: '1×' }, { v: 2, t: '2×' }]),
        this.seg('Abgabe-Frist nach der ersten Aufnahme', 'submitGrace', [{ v: 15, t: '15 s' }, { v: 30, t: '30 s' }, { v: 60, t: '60 s' }]));

      const file = h('input', { type: 'file', multiple: true, accept: '.zip,video/*,audio/*,.mp4,.webm,.mov,.m4v,.wav,.mp3,.ogg', hidden: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const folder = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const linkIn = h('input', { type: 'url', class: 'inp', placeholder: 'https://gamebanana.com/mods/…', 'aria-label': 'Link zu einem Pack', onkeydown: (e) => { if (e.key === 'Enter') this.importLink(linkIn.value); } });
      const packs = h('section', { class: 'panel packs' },
        h('h2', { text: 'Szenen & Packs' }),
        h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => file.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
          h('strong', { text: 'Videos, ZIP-Packs oder Audio-Dateien hierher ziehen' }), h('span', { class: 'muted', text: 'Ein Video (MP4/WebM) wird zur Szene, die ihr frei vertont. Dub-Packs von GameBanana bringen die Zeilen mit.' })),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => file.click() }, 'Dateien wählen'), h('button', { class: 'btn sm', onclick: () => folder.click() }, 'Ordner wählen')),
        h('div', { class: 'link-row' }, linkIn, h('button', { class: 'btn sm primary', onclick: () => this.importLink(linkIn.value) }, 'Per Link laden')),
        this.lobbyRefs.status, this.lobbyRefs.help, this.lobbyRefs.packs, file, folder);

      const start = h('button', { class: 'btn primary xl', onclick: () => this.startGame() }, 'Spiel starten');
      this.lobbyRefs.start = start;
      const foot = h('div', { class: 'lobby-foot' }, this.lobbyRefs.summary, start);
      this.updateLobbySummary();

      return h('div', { class: 'lobby' }, h('div', { class: 'lobby-grid' }, h('div', { class: 'col' }, join, players), h('div', { class: 'col' }, rules, packs)), foot);
    },

    updateLobbySummary() {
      if (!this.lobbyRefs) return;
      const n = this.list().filter((p) => p.connected).length;
      const clips = VD.Packs.enabledClips().length;
      this.lobbyRefs.summary.textContent = `${n} Spieler · ${clips} Clips aktiv · ${this.settings.rounds} Szenen`;
      const can = this.list().some((p) => p.connected && p.canRecord) && clips > 0;
      this.lobbyRefs.start.disabled = !can;
      this.lobbyRefs.start.title = can ? '' : clips ? 'Es braucht mindestens einen Spieler mit Mikrofon.' : 'Aktiviere mindestens ein Pack.';
    },

    renderLobbyPlayers() {
      if (this.stageKey !== 'lobby' || !this.lobbyRefs) return;
      const box = this.lobbyRefs.players;
      const ps = this.list();
      if (!ps.length) {
        box.replaceChildren(h('p', { class: 'empty', text: this.code ? 'Noch niemand da. Scannt den QR-Code mit dem Handy.' : 'Tippe auf „Mit diesem Gerät mitspielen“.' }));
      } else {
        box.replaceChildren(...ps.map((p) => h('div', { class: 'pcard' + (p.connected ? '' : ' off'), style: { '--c': p.color } },
          VD.ui.avatar(p, 'lg'), h('span', { class: 'pc-n', text: p.name }),
          h('em', { class: 'pc-s', text: !p.connected ? 'getrennt' : !p.canRecord ? 'nur Abstimmen' : p.ready ? 'bereit ✓' : 'wartet' }),
          h('button', { class: 'kick', 'aria-label': p.name + ' entfernen', title: 'Entfernen', onclick: () => this.removePlayer(p, !p.isLocal) }, '✕'))));
      }
      this.updateLobbySummary();
    },

    onPacksChanged() { if (this.stageKey === 'lobby') { this.renderPacks(); this.updateLobbySummary(); } },

    renderPacks() {
      if (!this.lobbyRefs) return;
      this.lobbyRefs.packs.replaceChildren(...VD.Packs.list.map((p) => {
        const on = VD.Packs.isEnabled(p);
        const thumb = h('span', { class: 'pk-thumb' }, p.iconUrl ? h('img', { src: p.iconUrl, alt: '' }) : p.builtin ? '🎙' : p.kind === 'video' ? '🎬' : '♫');
        const sw = h('label', { class: 'switch sm' }, h('input', { type: 'checkbox', checked: on ? true : null, 'aria-label': p.name + ' aktivieren', onchange: (e) => VD.Packs.setEnabled(p, e.target.checked) }), h('span', { class: 'sw' }));
        return h('div', { class: 'pk' + (on ? '' : ' off') }, thumb,
          h('div', { class: 'pk-m' }, h('b', { text: p.name }), h('small', { text: `${p.clips.length} ${p.kind === 'video' ? (p.clips.length === 1 ? 'Video' : 'Videos') : 'Clips'}${p.kind === 'dub' ? ' · Dub mit Video' : ''}${p.author ? ' · ' + p.author : ''}` })),
          sw, p.builtin ? null : h('button', { class: 'kick', 'aria-label': p.name + ' löschen', title: 'Pack löschen', onclick: () => VD.Packs.remove(p.id) }, '✕'));
      }));
    },

    setStatus(t, kind) { if (this.lobbyRefs) { this.lobbyRefs.status.textContent = t || ''; this.lobbyRefs.status.className = 'status ' + (kind || ''); } },

    async importFiles(files) {
      if (!files || !files.length) return;
      this.setStatus('Lese Dateien …'); this.lobbyRefs && (this.lobbyRefs.help.hidden = true);
      try {
        const added = await VD.Packs.importFiles(files, (t) => this.setStatus(t));
        this.setStatus(`${added.length} Pack${added.length === 1 ? '' : 's'} geladen: ${added.map((p) => p.name).join(', ')}`, 'ok');
        VD.sfx.play('score');
      } catch (e) { console.error(e); this.setStatus(e.message || 'Import fehlgeschlagen', 'err'); VD.sfx.play('error'); }
    },

    async importLink(url) {
      if (!url || !url.trim()) { this.setStatus('Füge zuerst einen Link ein.', 'err'); return; }
      this.lobbyRefs.help.hidden = true; this.setStatus('Verbinde …');
      try {
        const added = await VD.Packs.importFromUrl(url, (t) => this.setStatus(t));
        this.setStatus(`${added.length} Pack${added.length === 1 ? '' : 's'} geladen: ${added.map((p) => p.name).join(', ')}`, 'ok');
        VD.sfx.play('score');
      } catch (e) {
        if (e && e.code === 'blocked') {
          this.setStatus('Der Browser blockiert den direkten Download.', 'err');
          const help = this.lobbyRefs.help; help.hidden = false;
          const open = /^https?:\/\//i.test(url.trim()) ? h('a', { class: 'btn sm', href: url.trim(), target: '_blank', rel: 'noopener noreferrer' }, 'Seite öffnen') : null;
          help.replaceChildren(h('p', { text: 'GameBanana erlaubt keinen Download direkt aus dem Browser. So geht es trotzdem: Datei dort herunterladen und dann hier ins Fenster ziehen. Mit „node server.js“ oder dem Cloudflare-Worker aus der README klappt der Link-Import automatisch.' }), open);
        } else this.setStatus(e.message || 'Import fehlgeschlagen', 'err');
        VD.sfx.play('error');
      }
    },

    /* ---------- Szenen-Ansichten ---------- */
    viewIntro(scene, total) {
      const cast = this.list().filter((p) => p.active && p.role);
      const watchers = this.list().filter((p) => p.active && !p.role);
      const cards = cast.map((p, i) => h('div', { class: 'cast-card', style: { '--c': p.color, '--i': i } },
        VD.ui.avatar(p, 'xl'), h('b', { text: p.name }),
        h('small', { text: scene.free ? 'vertont frei' : `${p.role.lines.length} ${p.role.lines.length === 1 ? 'Zeile' : 'Zeilen'}` })));
      this.showStage('intro', () => h('div', { class: 'intro center' },
        h('span', { class: 'kicker', text: `Szene ${this.round} von ${total}` }),
        h('h1', { class: 'huge title-in', text: scene.title }),
        h('p', { class: 'lead', text: scene.free ? 'Das Video läuft ohne Originalton. Ihr sprecht alles selbst ein – ruft euch zu, wer wen spricht.' : 'Das Bild läuft ohne Originalton. Jeder spricht seine eigenen Zeilen, wenn sie dran sind.' }),
        h('div', { class: 'cast' }, cards),
        watchers.length ? h('p', { class: 'hint', text: 'Diesmal nur Publikum: ' + watchers.map((p) => p.name).join(', ') }) : null));
    },

    /* Zeitleiste: pro Spieler eine Spur mit seinen Zeilen */
    laneView(scene) {
      const rows = this.list().filter((p) => p.active && p.role).map((p) => {
        const ph = h('i', { class: 'ph' });
        const track = h('div', { class: 'lane-track' }, ...p.role.lines.map((l) => h('span', { class: 'lane-block', style: { left: (l.s / scene.dur) * 100 + '%', width: Math.max(0.8, ((l.e - l.s) / scene.dur) * 100) + '%' } })), ph);
        const st = h('em', { class: 'lane-st', text: '' });
        const el = h('div', { class: 'lane', style: { '--c': p.color } }, h('div', { class: 'lane-who' }, VD.ui.avatar(p, 'xs'), h('b', { text: p.name })), track, st);
        return { p, ph, st, el };
      });
      return { rows, el: h('div', { class: 'lanes' }, rows.map((r) => r.el)) };
    },

    viewRecord(scene, visual, withCountdown) {
      const cd = withCountdown ? VD.ui.countdown(3000, { sfx: true }) : null;
      const overlay = cd ? h('div', { class: 'dub-cd' }, cd.el, h('p', { class: 'lead', text: 'Handy bereithalten – gleich läuft die Szene!' })) : null;
      const timer = h('span', { class: 'rec-clock', text: '0,0 s' });
      const badge = h('span', { class: 'rec-badge', hidden: true }, h('span', { class: 'rec-dot' }), 'Aufnahme läuft');
      const lanes = scene.free ? null : this.laneView(scene);
      const again = this.attempt > 1 ? h('span', { class: 'hint', text: `Versuch ${this.attempt}` }) : null;
      const pending = h('span', { class: 'hint', text: '' });
      this.recView = { timer, badge, overlay, cd, pending, t0: 0 };
      this.showStage('record', () => h('div', { class: 'dub' },
        h('div', { class: 'rec-top' }, h('span', { class: 'kicker', text: `Szene ${this.round}: ${scene.title}` }), again, badge, timer),
        h('div', { class: 'dub-screen' }, visual.el, overlay),
        lanes ? lanes.el : h('p', { class: 'hint center', text: 'Alle sprechen gleichzeitig – ihr habt die ganze Szene lang Zeit.' }),
        pending));
      const stateText = { idle: 'bereit', recording: 'nimmt auf …', review: 'prüft …', done: 'abgegeben ✓' };
      const loop = () => {
        if (this.stageKey !== 'record') return;
        visual.tick();
        if (lanes) {
          const f = scene.dur ? visual.time() / scene.dur : 0;
          for (const r of lanes.rows) {
            r.ph.style.left = f * 100 + '%'; r.ph.style.opacity = visual.isPlaying() ? 1 : 0;
            r.st.textContent = this.phase === 'record' ? stateText[r.p.state] || '' : '';
            r.el.classList.toggle('live', r.p.state === 'recording');
            r.el.classList.toggle('done', r.p.state === 'done');
          }
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    hideCountdown() {
      const r = this.recView; if (!r) return;
      if (r.cd) r.cd.cancel();
      if (r.overlay) r.overlay.remove();
      r.badge.hidden = false; r.t0 = Date.now();
    },
    tickRecord() {
      const r = this.recView; if (!r || this.stageKey !== 'record') return;
      r.timer.textContent = VD.fmtSec((Date.now() - (r.t0 || Date.now())) / 1000);
      const open = this.list().filter((p) => p.active && p.role && !p.submitted).length;
      r.pending.textContent = this.firstSubmitAt && open ? `Warte auf ${open} ${open === 1 ? 'Spieler' : 'Spieler'} …` : '';
    },
    onSubmitted() { /* Anzeige läuft über die Animationsschleife in viewRecord */ },

    viewSync(scene, subs, visual) {
      const rows = subs.map((p) => {
        const val = h('b', { class: 'off-val', text: VD.fmtMs(0) });
        const ok = h('span', { class: 'sy-ok', text: '✓' });
        const el = h('div', { class: 'sync-row', style: { '--c': p.color } }, h('div', { class: 'sr-who' }, VD.ui.avatar(p, 'sm'), h('b', { text: p.name })), h('div', { class: 'sr-info' }, val, ok));
        return { p, val, ok, el };
      });
      this.syncRows = rows;
      const clock = h('span', { class: 'rec-clock', text: '' });
      this.showStage('sync', () => h('div', { class: 'dub' },
        h('div', { class: 'rec-top' }, h('span', { class: 'kicker', text: 'Feinschliff' }), clock),
        h('div', { class: 'dub-screen' }, visual.el),
        h('p', { class: 'lead center-lead', text: 'Sitzt jede Stimme? Wer zu früh oder zu spät ist, verschiebt die Spur am Handy und tippt „Passt“.' }),
        h('div', { class: 'sync-rows' }, rows.map((r) => r.el))));
      const t0 = performance.now();
      const loop = (now) => {
        if (this.stageKey !== 'sync') return;
        visual.tick();
        clock.textContent = Math.ceil(Math.max(0, this.settings.syncTime - (now - t0) / 1000)) + ' s';
        for (const r of rows) {
          r.val.textContent = (r.p.nudge ? VD.fmtMs(r.p.nudge) : 'automatisch');
          r.ok.classList.toggle('on', !!r.p.syncOk);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    onNudge() { /* Anzeige läuft über die Animationsschleife in viewSync */ },

    viewPremiere(scene, subs, visual) {
      const chips = subs.map((p) => h('span', { class: 'pr-chip', style: { '--c': p.color } }, VD.ui.avatar(p, 'xs'), h('b', { text: p.name })));
      this.showStage('premiere', () => h('div', { class: 'dub premiere' },
        h('div', { class: 'rec-top' }, h('span', { class: 'kicker', text: `Premiere · ${scene.title}` })),
        h('div', { class: 'dub-screen big' }, visual.el),
        h('div', { class: 'pr-cast' }, chips)));
      const loop = () => {
        if (this.stageKey !== 'premiere') return;
        visual.tick();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    viewVote(subs) {
      this.voteCards = new Map();
      const cards = subs.map((p) => {
        const count = h('b', { class: 'vc-n', text: '' });
        const el = h('div', { class: 'vcard', style: { '--c': p.color } }, VD.ui.avatar(p, 'xl'), h('b', { text: p.name }), count);
        this.voteCards.set(p.pid, { el, count });
        return el;
      });
      this.voterChips = new Map();
      const chips = this.list().filter((p) => p.connected && p.active).map((p) => {
        const c = h('span', { class: 'vchip', style: { '--c': p.color }, title: p.name }, VD.ui.avatar(p, 'xs'));
        this.voterChips.set(p.pid, c);
        return c;
      });
      this.showStage('vote', () => h('div', { class: 'vote center' },
        h('span', { class: 'kicker', text: 'Abstimmung' }),
        h('h1', { text: 'Wer war am besten – oder am lustigsten?' }),
        h('p', { class: 'lead', text: 'Stimmt auf euren Handys ab. Für sich selbst darf man nicht stimmen.' }),
        h('div', { class: 'vcards' }, cards),
        h('div', { class: 'voters' }, chips)));
    },
    onVoteCast(p) { const c = this.voterChips && this.voterChips.get(p.pid); if (c) c.classList.add('done'); VD.sfx.play('vote'); },
    async showVoteResult(subs) {
      const max = Math.max(0, ...subs.map((p) => p.roundVotes));
      for (const p of subs) {
        const c = this.voteCards.get(p.pid);
        if (!c) continue;
        await VD.sleep(450);
        c.count.textContent = p.roundVotes + (p.roundVotes === 1 ? ' Stimme' : ' Stimmen');
        c.el.classList.add('counted');
        if (max > 0 && p.roundVotes === max) c.el.classList.add('top');
        VD.sfx.play('judge');
      }
    },

    viewResults(subs, ranking) {
      const maxScore = Math.max(1, ...ranking.map((p) => p.score));
      const best = subs.slice().sort((a, b) => b.roundTotal - a.roundTotal)[0];
      const last = this.round >= this.settings.rounds;
      const rows = ranking.map((p, i) => {
        const sub = subs.includes(p);
        const num = h('b', { class: 'rs-n', text: '0' });
        const fill = h('i', { class: 'rs-fill' });
        const row = h('div', { class: 'rs-row' + (best === p ? ' best' : ''), style: { '--c': p.color, '--i': i } },
          h('span', { class: 'rs-rank', text: String(i + 1) }), VD.ui.avatar(p, 'sm'),
          h('div', { class: 'rs-main' }, h('div', { class: 'rs-top' }, h('b', { text: p.name }), best === p ? h('span', { class: 'crown', text: '👑' }) : null,
            h('small', { text: sub ? `+${p.roundTotal}  (${p.roundVotes} ${p.roundVotes === 1 ? 'Stimme' : 'Stimmen'})` : '+0' })),
          h('div', { class: 'rs-bar' }, fill)), num);
        setTimeout(() => { fill.style.transform = `scaleX(${p.score / maxScore})`; VD.countUp(num, p.score, 1000); }, 300 + i * 120);
        return row;
      });
      this.showStage('results', () => h('div', { class: 'results' },
        h('span', { class: 'kicker', text: `Szene ${this.round} von ${this.settings.rounds}` }),
        h('h1', { text: last ? 'Alle Szenen vertont' : 'Zwischenstand' }), h('div', { class: 'rs-rows' }, rows)));
    },

    viewFinal(ranking) {
      const top = ranking.slice(0, 3);
      const order = [top[1], top[0], top[2]]; // Silber, Gold, Bronze
      const heights = { 0: '72%', 1: '100%', 2: '56%' };
      const pod = order.map((p, i) => p ? h('div', { class: 'pod p' + (i === 1 ? 1 : i === 0 ? 2 : 3), style: { '--c': p.color, '--h': heights[i] } },
        VD.ui.avatar(p, 'xl'), h('b', { text: p.name }), h('span', { class: 'pod-score', text: Math.round(p.score) + ' Pkt' }), h('div', { class: 'pod-block' }, h('i', { text: i === 1 ? '1' : i === 0 ? '2' : '3' }))) : h('div', { class: 'pod empty' }));
      const rest = ranking.slice(3).map((p, i) => h('li', {}, h('span', { text: String(i + 4) }), VD.ui.avatar(p, 'xs'), h('b', { text: p.name }), h('em', { text: Math.round(p.score) + ' Pkt' })));
      const again = h('button', { class: 'btn primary xl', onclick: async () => { this.backToLobby(); await VD.sleep(50); this.startGame(); } }, 'Nochmal spielen');
      const lobby = h('button', { class: 'btn xl', onclick: () => this.backToLobby() }, 'Zurück zur Lobby');
      this.showStage('final', () => h('div', { class: 'final' },
        h('span', { class: 'kicker', text: 'Der Abspann' }),
        h('h1', { text: top[0] ? top[0].name + ' gewinnt!' : 'Unentschieden' }),
        h('div', { class: 'podium' }, pod), rest.length ? h('ol', { class: 'rest' }, rest) : null,
        h('div', { class: 'row center' }, again, lobby)));
      VD.sfx.play('fanfare'); setTimeout(() => VD.confetti(1.4), 500);
    }
  };

  Object.assign(VD.Host.prototype, views);
})();
