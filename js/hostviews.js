/* Host-Bildschirm: alle Ansichten (Lobby, Laden, Aufnahme, Ergebnis) */
(function () {
  const VD = (window.VD = window.VD || {});
  const h = VD.h;

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
      this.dnBtn = VD.Denoise.iconEl(); this.dnBtn.hidden = true;
      const header = h('header', { class: 'h-top' }, h('div', { class: 'brand', text: 'Dub Together' }), this.roomChip, h('div', { class: 'h-tools' }, this.dnBtn, sound, full));
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
      this.dnBtn.hidden = !showing || !this.local;
      if (!showing) return;
      const ids = new Set();
      const stateText = (p) => {
        if (!p.connected) return 'offline';
        if (!p.assign) return this.phase === 'load' ? '' : 'schaut zu';
        if (this.phase === 'load') return p.loaded ? 'bereit ✓' : 'lädt …';
        if (this.phase === 'final') return '';
        return p.done ? 'fertig ✓' : p.prog ? `Line ${p.prog.cur}/${p.assign.lineIdx.length}` : 'bereit';
      };
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
          c = { el: h('div', { class: 'ch' }), fill, kick, name: h('span', { class: 'ch-name' }), st: h('em', { class: 'ch-st' }), av: h('span') };
          c.el.append(c.av, h('div', { class: 'ch-meta' }, c.name, c.st), h('div', { class: 'vu' }, fill), kick);
          this.strip.append(c.el);
          this.stripMap.set(p.pid, c);
        }
        c.el.style.setProperty('--c', p.color);
        c.el.classList.toggle('off', !p.connected || !p.active);
        c.el.classList.toggle('done', !!p.done);
        const av = VD.ui.avatar(p, 'sm'); c.av.replaceWith(av); c.av = av;
        c.name.textContent = p.name; c.st.textContent = stateText(p);
      });
      for (const [pid, c] of this.stripMap) if (!ids.has(pid)) { c.el.classList.add('out'); setTimeout(() => c.el.remove(), 250); this.stripMap.delete(pid); }
    },
    stripLoop() {
      const loop = () => {
        // Im Hintergrund-Tab oder bei versteckter Leiste (Lobby) gibt es nichts zu zeichnen
        if (!document.hidden && !this.strip.hidden) {
          for (const [pid, c] of this.stripMap) {
            const p = this.players.get(pid);
            if (!p) continue;
            const live = p.prog && p.prog.st === 'rec' ? p.lvl : 0;
            p._vu = (p._vu || 0) * 0.8 + live * 0.2;
            const sc = p._vu < 0.002 ? 0 : Math.min(1, Math.pow(p._vu * 1.4, 0.7));
            if (c._sc !== sc && !(c._sc === 0 && sc === 0)) { c._sc = sc; c.fill.style.transform = `scaleY(${sc})`; }
          }
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
        const next = h('button', { class: 'btn sm', onclick: () => this.hostNext() }, h('span', { text: 'Weiter' }), h('kbd', { text: 'Leertaste' }));
        const end = h('button', { class: 'btn sm ghost', onclick: (e) => {
          const b = e.currentTarget;
          if (b.dataset.sure) { this.hostEnd(); return; }
          b.dataset.sure = '1'; b.firstChild.textContent = 'Wirklich beenden?';
          setTimeout(() => { delete b.dataset.sure; b.firstChild.textContent = 'Spiel beenden'; }, 2500);
        } }, h('span', { text: 'Spiel beenden' }));
        this.bar.replaceChildren(label, h('div', { class: 'bar-btns' }, next, end));
        this.barRefs = { label, next: next.firstChild };
      }
      const w = this.list().filter((p) => p.assign && p.active);
      const fin = w.filter((p) => p.done).length;
      this.barRefs.label.textContent = ({ load: 'Szene wird verteilt', play: `Aufnahme · ${fin}/${w.length} fertig`, final: 'Ergebnis' })[this.phase] || '';
      this.barRefs.next.textContent = this.phase === 'play' ? 'Jetzt ansehen' : this.phase === 'final' ? 'Nochmal ansehen' : 'Weiter';
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
      const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || 'Charaktere verteilen' });
      opts.forEach((o) => {
        const b = h('button', { class: 'seg-b' + (this.settings[key] === o.v ? ' on' : ''), onclick: () => {
          this.setSetting(key, o.v);
          VD.$$('.seg-b', wrap).forEach((x) => x.classList.remove('on')); b.classList.add('on');
          VD.sfx.play('click'); this.updateLobbySummary();
        } }, o.t);
        wrap.append(b);
      });
      return h('div', { class: 'field' }, label ? h('span', { class: 'field-l', text: label }) : null, wrap, help ? h('small', { class: 'field-h', text: help }) : null);
    },

    buildLobby() {
      const join = h('section', { class: 'panel join' });
      if (this.code) {
        const url = VD.joinUrl(this.code);
        const plate = h('div', { class: 'qr-plate' });
        plate.innerHTML = qrSvg(url);
        const copy = h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(url); b.textContent = 'Link kopiert ✓'; setTimeout(() => (b.textContent = 'Freunde einladen'), 2000); } catch { VD.toast(url); } } }, 'Freunde einladen');
        join.append(
          h('h2', { text: 'Mitspielen: am Handy oder am PC' }),
          h('div', { class: 'join-row' }, plate, h('div', { class: 'join-info' },
            h('div', { class: 'code-big', 'aria-label': 'Raum-Code ' + this.code.split('').join(' ') }, ...this.code.split('').map((ch, i) => h('span', { style: { '--i': i }, text: ch }))),
            copy)));
      } else {
        join.append(h('h2', { text: 'Nur lokal' }), h('p', { class: 'muted', text: 'Der Online-Raum ist nicht verfügbar. Du kannst trotzdem mit dem Mikro dieses Geräts spielen (z. B. reihum).' }));
      }

      this.lobbyRefs = { players: h('div', { class: 'players' }), packs: h('div', { class: 'pack-list' }), status: h('p', { class: 'status', 'aria-live': 'polite' }), help: h('div', { class: 'pack-help', hidden: true }), summary: h('span', { class: 'sum' }), warn: h('p', { class: 'warn', hidden: true }), start: null };
      const localBtn = h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; if (this.local) { this._optOut = true; this.removeLocalPlayer(false); b.textContent = 'Mit diesem Gerät mitspielen'; this.updateLobbySummary(); } else { this._optOut = false; await this.addLocalPlayer(); if (this.local) b.textContent = 'Dieses Gerät entfernen'; this.updateLobbySummary(); } } }, this.local ? 'Dieses Gerät entfernen' : 'Mit diesem Gerät mitspielen');
      if (!this._autoLocal) { this._autoLocal = true; setTimeout(async () => { await this.addLocalPlayer(); if (this.local) localBtn.textContent = 'Dieses Gerät entfernen'; }, 400); }
      const players = h('section', { class: 'panel' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Spieler' }), this.lobbyRefs.summary, localBtn), this.lobbyRefs.warn, this.lobbyRefs.players, h('div', { class: 'dn-row' }, VD.Denoise.switchEl()));

      const rules = h('section', { class: 'panel rules' }, h('h2', { text: 'Charaktere verteilen' }),
        this.seg('', 'assign', [{ v: 'random', t: 'Zufällig' }, { v: 'order', t: 'Nach Reihenfolge' }]),
        h('p', { class: 'rules-d' }, h('b', { text: 'Zufällig: ' }), 'Die Rollen werden bei jedem Spiel neu gemischt.', h('br'),
          h('b', { text: 'Nach Reihenfolge: ' }), 'Der Host spricht die größte Rolle, danach folgen die Spieler nach ihrem Beitritt.'));

      const file = h('input', { type: 'file', multiple: true, accept: '.zip,.ini,.txt,.ogg,.ogv,.png,.jpg,.jpeg,.mp4,.webm,audio/*,video/*,image/*', hidden: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const folder = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const packs = h('section', { class: 'panel packs' },
        h('h2', { text: 'Dub-Packs' }),
        h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => file.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
          h('strong', { text: 'Dub-Pack (ZIP oder Ordner) hierher ziehen' }), h('span', { class: 'muted', text: 'oder klicken zum Auswählen.' })),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => file.click() }, 'Dateien wählen'), h('button', { class: 'btn sm', onclick: () => folder.click() }, 'Ordner wählen')),
        this.lobbyRefs.status, this.lobbyRefs.help, this.lobbyRefs.packs, file, folder);

      const start = h('button', { class: 'btn primary xl', onclick: () => this.startGame() }, 'Spiel starten');
      this.lobbyRefs.start = start;
      const homeBtn = h('button', { class: 'btn link home-btn', onclick: (e) => {
        const b = e.currentTarget;
        if (!b._ask) { b._ask = true; b.textContent = 'Raum wirklich schließen?'; b.classList.add('warn'); b._t = setTimeout(() => { b._ask = false; b.textContent = 'Zur Startseite'; b.classList.remove('warn'); }, 4000); return; }
        clearTimeout(b._t); this.closeRoom();
      } }, 'Zur Startseite');
      const foot = h('div', { class: 'lobby-foot' }, homeBtn, start);
      this.updateLobbySummary();

      return h('div', { class: 'lobby' }, h('div', { class: 'lobby-grid' }, h('div', { class: 'col' }, join, players), h('div', { class: 'col' }, rules, packs)), foot);
    },

    updateLobbySummary() {
      if (!this.lobbyRefs) return;
      const n = this.list().filter((p) => p.connected).length;
      const pack = VD.Packs.current();
      this.lobbyRefs.summary.textContent = `${n} Spieler · ${pack ? pack.name : 'noch kein Pack'}`;
      const can = this.list().some((p) => p.connected && p.canRecord) && !!pack;
      const rec = this.list().filter((p) => p.connected && p.canRecord);
      const sum = this.lobbyRefs.warn;
      if (sum) {
        const chars = pack ? pack.chars : [];
        let msg = '';
        if (!this.local) msg = 'Dieser PC spielt nicht mit (Mikrofon nicht freigegeben oder entfernt). Klicke „Mit diesem Gerät mitspielen“ und erlaube das Mikrofon, wenn du selbst sprechen willst.';
        else if (rec.length < chars.length && pack) msg = rec.length === 1 ? `Nur 1 Spieler mit Mikrofon: Er spricht alle Charaktere (${chars.join(', ')}).` : `${rec.length} Spieler, ${chars.length} Charaktere: Manche sprechen mehrere Rollen.`;
        else if (rec.length > chars.length && pack) msg = `${rec.length} Spieler, ${chars.length} Charaktere: Die Zeilen werden aufgeteilt, jeder bekommt fast gleich viele.`;
        sum.textContent = msg; sum.hidden = !msg;
      }
      this.lobbyRefs.start.disabled = !can;
      this.lobbyRefs.start.title = can ? '' : pack ? 'Es braucht mindestens einen Spieler mit Mikrofon.' : 'Lade zuerst ein Dub-Pack.';
    },

    renderLobbyPlayers() {
      if (this.stageKey !== 'lobby' || !this.lobbyRefs) return;
      const box = this.lobbyRefs.players;
      const ps = this.list();
      if (!ps.length) {
        box.replaceChildren(h('p', { class: 'empty', text: this.code ? 'Noch niemand da. Andere treten mit dem Code bei (Handy oder PC).' : 'Tippe auf „Mit diesem Gerät mitspielen“.' }));
      } else {
        box.replaceChildren(...ps.map((p) => h('div', { class: 'pcard' + (p.connected ? '' : ' off'), style: { '--c': p.color } },
          VD.ui.avatar(p, 'lg'), h('span', { class: 'pc-n', text: p.name }),
          h('em', { class: 'pc-s', text: !p.connected ? 'getrennt' : !p.canRecord ? 'nur zuschauen' : p.ready ? 'bereit ✓' : 'wartet' }),
          h('button', { class: 'kick', 'aria-label': p.name + ' entfernen', title: 'Entfernen', onclick: () => this.removePlayer(p, !p.isLocal) }, '✕'))));
      }
      this.updateLobbySummary();
    },

    onPacksChanged() { if (this.stageKey === 'lobby') { this.renderPacks(); this.updateLobbySummary(); } },

    renderPacks() {
      if (!this.lobbyRefs) return;
      const cur = VD.Packs.current();
      if (!VD.Packs.list.length) { this.lobbyRefs.packs.replaceChildren(h('p', { class: 'empty', text: 'Noch kein Pack. Ziehe ein Dub-Pack hierher.' })); return; }
      this.lobbyRefs.packs.replaceChildren(...VD.Packs.list.map((p) => {
        const on = cur && cur.id === p.id;
        const thumb = h('span', { class: 'pk-thumb' }, p.iconUrl ? h('img', { src: p.iconUrl, alt: '' }) : '🎬');
        const sw = on ? h('span', { class: 'pk-on', text: '✓ Ausgewählt' }) : h('button', { class: 'btn sm', onclick: () => VD.Packs.select(p.id) }, 'Auswählen');
        return h('div', { class: 'pk' + (on ? '' : ' off') }, thumb,
          h('div', { class: 'pk-m' }, h('b', { text: p.name }), h('small', { text: `${p.lines.length} Zeilen · ${p.chars.join(', ')}${p.author ? ' · ' + p.author : ''}` })),
          sw, h('button', { class: 'kick', 'aria-label': p.name + ' löschen', title: 'Pack löschen', onclick: () => VD.Packs.remove(p.id) }, '✕'));
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


    /* ---------- Spiel-Ansichten ---------- */
    viewLoad(scene) {
      this.showStage('load', () => h('div', { class: 'center load' },
        h('span', { class: 'kicker', text: 'Dub Together' }),
        h('h1', { class: 'huge title-in', text: scene.title }),
        h('p', { class: 'lead', text: 'Die Szene wird an alle Spieler geschickt …' }),
        h('div', { class: 'cast', id: 'load-cast' })));
      this.updateLoad();
    },
    updateLoad() {
      const box = VD.$('#load-cast'); if (!box || this.stageKey !== 'load') return;
      box.replaceChildren(...this.list().filter((p) => p.assign && p.connected).map((p) => h('div', { class: 'cast-card' + (p.loaded ? ' ok' : ''), style: { '--c': p.color } },
        VD.ui.avatar(p, 'lg'), h('b', { text: p.name }), h('small', { text: p.loaded ? 'bereit ✓' : 'lädt …' }))));
    },

    /* Übersicht während der Aufnahme: jeder in seinem eigenen Tempo */
    viewPlay(scene) {
      const cards = new Map();
      const players = this.list().filter((p) => p.assign && p.loaded);
      const el = this.showStage('play', () => h('div', { class: 'playview' },
        h('div', { class: 'pv-head' },
          scene.pack.iconUrl ? h('img', { class: 'pv-icon', src: scene.pack.iconUrl, alt: '' }) : null,
          h('div', {}, h('span', { class: 'kicker', text: 'Dub Together' }), h('h1', { text: scene.title }),
            h('p', { class: 'lead', text: 'Jeder nimmt auf seinem eigenen Gerät auf, in seinem eigenen Tempo. Wer fertig ist, wartet.' }))),
        h('div', { class: 'pv-cards' }, players.map((p) => {
          const fill = h('i', { class: 'pv-fill' });
          const st = h('em', { class: 'pv-st', text: '' });
          const card = h('div', { class: 'pv-card', style: { '--c': p.color } }, VD.ui.avatar(p, 'lg'), h('b', { text: p.name }),
            h('small', { class: 'pv-char', text: p.assign.chars.join(' · ') + ` · ${p.assign.lineIdx.length} ${p.assign.lineIdx.length === 1 ? 'Zeile' : 'Zeilen'}` }), h('div', { class: 'pv-bar' }, fill), st);
          cards.set(p.pid, { card, fill, st, p });
          return card;
        }))));
      this.playCards = cards;
      this.updatePlay();
      return el;
    },
    updatePlay() {
      if (!this.playCards || this.stageKey !== 'play') return;
      for (const { card, fill, st, p } of this.playCards.values()) {
        const total = p.assign.lineIdx.length || 1;
        const cur = p.prog ? p.prog.cur : 1;
        const f = p.done ? 1 : (cur - 1) / total;
        fill.style.transform = `scaleX(${f})`;
        card.classList.toggle('done', !!p.done);
        card.classList.toggle('live', !p.done && p.prog && p.prog.st === 'rec');
        st.textContent = !p.connected ? 'offline' : p.done ? 'Fertig ✓' : `Line ${cur}/${total}` + (p.prog && p.prog.st === 'rec' ? ' · nimmt auf' : '');
      }
      this.updateBar();
    },

    /* Ergebnis: das fertig vertonte Video */
    viewFinal(scene) {
      if (this.fvideoUrl) URL.revokeObjectURL(this.fvideoUrl);
      this.fvideoUrl = URL.createObjectURL(scene.pack.video);
      const v = VD.Video.create(this.fvideoUrl, VD.Scene.videoMime(scene.pack), 'sv-video');
      this.fvideo = v;
      this.finalRefs = {
        chips: h('div', { class: 'pr-cast' }),
        again: h('button', { class: 'btn primary xl', onclick: () => this.hostAgain() }, 'Nochmal ansehen'),
        solo: h('button', { class: 'btn solo', title: 'Die anderen Spieler sehen davon nichts', onclick: () => this.hostSolo() }, 'Nur für mich ansehen'),
        lobby: h('button', { class: 'btn xl', onclick: () => this.hostLobby() }, 'Zurück zur Lobby')
      };
      this.finalRefs.dl = VD.Export.buttons(() => { const c = this.finalCtx; if (!c) return null; return { videoUrl: this.fvideoUrl, mime: VD.Scene.videoMime(c.scene.pack), f32: c.mix, sr: window.VDA.SR, title: c.scene.title }; });
      this.finalRefs.btns = h('div', { class: 'col-c', hidden: true }, h('div', { class: 'row center fin-row' }, this.finalRefs.again, this.finalRefs.lobby, this.finalRefs.solo), this.finalRefs.dl);
      this.showStage('final', () => h('div', { class: 'dub premiere' },
        h('div', { class: 'rec-top' }, h('span', { class: 'kicker', text: `Ergebnis · ${scene.title}` })),
        h('div', { class: 'dub-screen big' }, h('div', { class: 'sv' }, v)),
        this.finalRefs.chips, this.finalRefs.btns));
    },
    finalInfo(recs) {
      const r = this.finalRefs; if (!r) return;
      r.btns.hidden = true;
      r.chips.replaceChildren(...recs.map((p) => h('span', { class: 'pr-chip', style: { '--c': p.color } }, VD.ui.avatar(p, 'xs'), h('b', { text: p.name }), h('small', { class: 'muted', text: ' als ' + p.assign.chars.join(' + ') }))));
    },
    finalButtons(show) { if (this.finalRefs) this.finalRefs.btns.hidden = !show; },
  };

  Object.assign(VD.Host.prototype, views);
})();
