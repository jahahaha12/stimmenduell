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
      const sound = h('button', { class: 'icon-btn', title: VD.t('Ton an/aus'), 'aria-label': VD.t('Ton an oder aus'), onclick: (e) => { VD.sfx.enabled = !VD.sfx.enabled; e.currentTarget.classList.toggle('off', !VD.sfx.enabled); } }, '♪');
      const full = h('button', { class: 'icon-btn', title: VD.t('Vollbild'), 'aria-label': VD.t('Vollbild'), onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } }, '⛶');
      this.dnBtn = VD.Denoise.iconEl(); this.dnBtn.hidden = true;
      const header = h('header', { class: 'h-top' }, h('div', { class: 'brand', text: window.VD_CONFIG.appName }), this.roomChip, h('div', { class: 'h-tools' }, this.dnBtn, sound, full));
      this.root.replaceChildren(header, this.stage, this.strip, this.bar);
      this.stripMap = new Map();
      this.barRefs = null;

      // Drag & Drop für Packs (nur in der Lobby). Auch im Spiel wird das Ablegen abgefangen,
      // sonst öffnet der Browser die Datei und das laufende Spiel wäre weg.
      window.addEventListener('dragover', (e) => { e.preventDefault(); if (this.state === 'lobby') document.body.classList.add('dragging'); });
      window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
      window.addEventListener('drop', async (e) => {
        e.preventDefault();
        document.body.classList.remove('dragging');
        if (this.state === 'lobby') this.importFiles(await filesFromDrop(e.dataTransfer));
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
      if (!this.code) { this.roomChip.replaceChildren(h('span', { class: 'rc-off', text: VD.t('Nur lokal') })); return; }
      const url = VD.joinUrl(this.code);
      const qr = h('div', { class: 'rc-qr', title: url });
      qr.innerHTML = qrSvg(url);
      this.roomChip.replaceChildren(h('span', { class: 'rc-l', text: VD.t('Raum') }), h('b', { class: 'rc-code', text: this.code }), qr);
    },

    /* ---------- Spielerleiste ---------- */
    refreshStrip() {
      const showing = this.state !== 'lobby';
      this.strip.hidden = !showing;
      this.dnBtn.hidden = !showing || !this.local;
      if (!showing) return;
      const ids = new Set();
      const stateText = (p) => {
        if (!p.connected) return VD.t('offline');
        if (!p.assign) return this.phase === 'load' ? '' : VD.t('schaut zu');
        if (this.phase === 'load') return p.loaded ? VD.t('bereit ✓') : VD.t('lädt …');
        if (this.phase === 'final') return '';
        return p.done ? VD.t('fertig ✓') : p.prog ? VD.t('Line {c}/{t}', { c: p.prog.cur, t: p.assign.lineIdx.length }) : VD.t('bereit');
      };
      this.list().forEach((p) => {
        ids.add(p.pid);
        let c = this.stripMap.get(p.pid);
        if (!c) {
          const fill = h('i', { class: 'vu-fill' });
          const kick = h('button', { class: 'kick', title: VD.t('Spieler entfernen'), 'aria-label': VD.t('{name} entfernen', { name: p.name }), onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.sure) { this.removePlayer(p, true); return; }
            b.dataset.sure = '1'; b.textContent = VD.t('Sicher?');
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
        const next = h('button', { class: 'btn sm', onclick: () => this.hostNext() }, h('span', { text: VD.t('Weiter') }), h('kbd', { text: VD.t('Leertaste') }));
        const end = h('button', { class: 'btn sm ghost', onclick: (e) => {
          const b = e.currentTarget;
          if (b.dataset.sure) { this.hostEnd(); return; }
          b.dataset.sure = '1'; b.firstChild.textContent = VD.t('Wirklich beenden?');
          setTimeout(() => { delete b.dataset.sure; b.firstChild.textContent = VD.t('Spiel beenden'); }, 2500);
        } }, h('span', { text: VD.t('Spiel beenden') }));
        this.bar.replaceChildren(label, h('div', { class: 'bar-btns' }, next, end));
        this.barRefs = { label, next: next.firstChild };
      }
      const w = this.list().filter((p) => p.assign && p.active);
      const fin = w.filter((p) => p.done).length;
      this.barRefs.label.textContent = ({ load: VD.t('Szene wird verteilt'), play: VD.t('Aufnahme · {fin}/{n} fertig', { fin, n: w.length }), final: VD.t('Ergebnis') })[this.phase] || '';
      this.barRefs.next.textContent = this.phase === 'play' ? VD.t('Jetzt ansehen') : this.phase === 'final' ? VD.t('Nochmal ansehen') : VD.t('Weiter');
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
      const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || VD.t('Charaktere verteilen') });
      opts.forEach((o) => {
        const b = h('button', { class: 'seg-b' + (this.settings[key] === o.v ? ' on' : ''), onclick: () => {
          this.setSetting(key, o.v);
          VD.$$('.seg-b', wrap).forEach((x) => x.classList.remove('on')); b.classList.add('on');
          VD.sfx.play('click'); this.updateLobbySummary(); this.onSettingsChanged();
        } }, o.t);
        wrap.append(b);
      });
      return h('div', { class: 'field' }, label ? h('span', { class: 'field-l', text: label }) : null, wrap, help ? h('small', { class: 'field-h', text: help }) : null);
    },

    /* Dub-Packs herunterladen: erst erklären, wohin es geht (lässt sich mit "Nicht mehr anzeigen" abschalten) */
    openPackSite() {
      const go = () => window.open(window.VD_CONFIG.packSiteUrl, '_blank', 'noopener,noreferrer');
      let skip = false;
      try { skip = localStorage.getItem('vt-skipPackInfo') === '1'; } catch { /* ignore */ }
      if (skip) { go(); return; }
      const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-t', onclick: (e) => { if (e.target === box) close(); } },
        h('div', { class: 'modal-card' },
          h('h2', { id: 'modal-t', text: VD.t('Du wirst auf eine andere Seite weitergeleitet') }),
          h('p', { class: 'modal-site', text: new URL(window.VD_CONFIG.packSiteUrl).hostname.replace(/^www\./, '') }),
          h('p', { text: VD.t('Dort gibt es Dub-Packs zum Herunterladen. Lade ein Pack als ZIP-Datei herunter und ziehe es danach hier in den Bereich „Dub-Packs“.') }),
          h('p', { class: 'muted', text: VD.t('Die Seite öffnet sich in einem neuen Tab. Das Spiel bleibt hier geöffnet.') }),
          h('div', { class: 'modal-btns' },
            h('button', { class: 'btn primary', onclick: () => { close(); go(); } }, VD.t('Weiter zu GameBanana')),
            h('button', { class: 'btn', onclick: close }, VD.t('Abbrechen'))),
          h('button', { class: 'btn link', onclick: () => { try { localStorage.setItem('vt-skipPackInfo', '1'); } catch { /* ignore */ } close(); go(); } }, VD.t('Nicht mehr anzeigen'))));
      document.addEventListener('keydown', onKey);
      document.body.append(box);
      box.querySelector('.btn.primary').focus();
    },

    /* Schalter "Wunschrolle" (nur bei Zufällig sichtbar), gleiche Optik wie der Geräusch-Filter */
    wishSwitch() {
      const b = h('button', { class: 'dn-switch', type: 'button', role: 'switch', onclick: () => {
        this.setSetting('wishes', this.settings.wishes === false);
        VD.sfx.play('click'); this.onSettingsChanged();
      } }, h('i'), h('span', { text: VD.t('Wunschrolle erlauben') }));
      this._wishBtn = b;
      this.syncWishSwitch();
      return b;
    },
    syncWishSwitch() {
      const b = this._wishBtn;
      if (!b) return;
      const on = this.settings.wishes !== false;
      b.hidden = this.settings.assign !== 'random';
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    },
    onSettingsChanged() { this.syncWishSwitch(); this.onRosterChanged(); },

    buildLobby() {
      const join = h('section', { class: 'panel join' });
      if (this.code) {
        const url = VD.joinUrl(this.code);
        const plate = h('div', { class: 'qr-plate' });
        plate.innerHTML = qrSvg(url);
        const copy = h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(url); b.textContent = VD.t('Link kopiert ✓'); setTimeout(() => (b.textContent = VD.t('Freunde einladen')), 2000); } catch { VD.toast(url); } } }, VD.t('Freunde einladen'));
        join.append(
          h('h2', { text: VD.t('Mitspielen: am Handy oder am PC') }),
          h('div', { class: 'join-row' }, plate, h('div', { class: 'join-info' },
            h('div', { class: 'code-big', 'aria-label': VD.t('Raum-Code {c}', { c: this.code.split('').join(' ') }) }, ...this.code.split('').map((ch, i) => h('span', { style: { '--i': i }, text: ch }))),
            copy)));
      } else {
        join.append(h('h2', { text: VD.t('Nur lokal') }), h('p', { class: 'muted', text: VD.t('Der Online-Raum ist nicht verfügbar. Du kannst trotzdem mit dem Mikro dieses Geräts spielen (z. B. reihum).') }));
      }

      this.lobbyRefs = { players: h('div', { class: 'players' }), packs: h('div', { class: 'pack-list' }), status: h('p', { class: 'status', 'aria-live': 'polite' }), summary: h('span', { class: 'sum' }), warn: h('p', { class: 'warn', hidden: true }), start: null };
      const localBtn = h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; if (this.local) { this._optOut = true; this.removeLocalPlayer(false); b.textContent = VD.t('Mit diesem Gerät mitspielen'); this.updateLobbySummary(); } else { this._optOut = false; await this.addLocalPlayer(); if (this.local) b.textContent = VD.t('Dieses Gerät entfernen'); this.updateLobbySummary(); } } }, this.local ? VD.t('Dieses Gerät entfernen') : VD.t('Mit diesem Gerät mitspielen'));
      if (!this._autoLocal) { this._autoLocal = true; setTimeout(async () => { await this.addLocalPlayer(); if (this.local) localBtn.textContent = VD.t('Dieses Gerät entfernen'); }, 400); }
      const players = h('section', { class: 'panel' }, h('div', { class: 'panel-h' }, h('h2', { text: VD.t('Mitspieler') }), this.lobbyRefs.summary, localBtn), this.lobbyRefs.warn, this.lobbyRefs.players, h('div', { class: 'dn-row' }, VD.Denoise.switchEl()));

      const rules = h('section', { class: 'panel rules' }, h('h2', { text: VD.t('Charaktere verteilen') }),
        this.seg('', 'assign', [{ v: 'random', t: VD.t('Zufällig') }, { v: 'order', t: VD.t('Nach Reihenfolge') }]),
        h('p', { class: 'rules-d' }, h('b', { text: VD.t('Zufällig') + ': ' }), VD.t('Die Rollen werden bei jedem Spiel neu gemischt.'), h('br'),
          h('b', { text: VD.t('Nach Reihenfolge') + ': ' }), VD.t('Der Host spricht die größte Rolle, danach folgen die Spieler nach ihrem Beitritt.')),
        this.wishSwitch(), (this.lobbyRefs.hostRoles = h('div', { class: 'roles', hidden: true }, h('span', { class: 'sub-h', text: VD.t('Deine Wunschrolle') }), h('div', { class: 'role-list' }))));

      const file = h('input', { type: 'file', multiple: true, accept: '.zip,.ini,.txt,.ogg,.ogv,.png,.jpg,.jpeg,.mp4,.webm,audio/*,video/*,image/*', hidden: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const folder = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: (e) => { this.importFiles(Array.from(e.target.files)); e.target.value = ''; } });
      const packs = h('section', { class: 'panel packs' },
        h('h2', { text: VD.t('Dub-Packs') }),
        h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => file.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
          h('strong', { text: VD.t('Dub-Pack (ZIP oder Ordner) hierher ziehen') }), h('span', { class: 'muted', text: VD.t('oder klicken zum Auswählen.') })),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => file.click() }, VD.t('Dateien wählen')), h('button', { class: 'btn sm', onclick: () => folder.click() }, VD.t('Ordner wählen')), h('button', { class: 'btn sm', onclick: () => this.openPackSite() }, VD.t('Dub-Packs herunterladen'))),
        this.lobbyRefs.status, this.lobbyRefs.packs, file, folder);

      const start = h('button', { class: 'btn primary xl', onclick: () => this.startGame() }, VD.t('Spiel starten'));
      this.lobbyRefs.start = start;
      const homeBtn = h('button', { class: 'btn link home-btn', onclick: (e) => {
        const b = e.currentTarget;
        if (!b._ask) { b._ask = true; b.textContent = VD.t('Raum wirklich schließen?'); b.classList.add('warn'); b._t = setTimeout(() => { b._ask = false; b.textContent = VD.t('Zur Startseite'); b.classList.remove('warn'); }, 4000); return; }
        clearTimeout(b._t); this.closeRoom();
      } }, VD.t('Zur Startseite'));
      const foot = h('div', { class: 'lobby-foot' }, homeBtn, start);
      this.updateLobbySummary();

      return h('div', { class: 'lobby' }, h('div', { class: 'lobby-grid' }, h('div', { class: 'col' }, join, players), h('div', { class: 'col' }, rules, packs)), foot);
    },

    updateLobbySummary() {
      if (!this.lobbyRefs) return;
      const n = this.list().filter((p) => p.connected).length;
      const pack = VD.Packs.current();
      this.lobbyRefs.summary.textContent = VD.t('{n} Spieler · {pack}', { n, pack: pack ? pack.name : VD.t('noch kein Pack') });
      const can = this.list().some((p) => p.connected && p.canRecord) && !!pack;
      const rec = this.list().filter((p) => p.connected && p.canRecord);
      const sum = this.lobbyRefs.warn;
      if (sum) {
        const chars = pack ? pack.chars : [];
        let msg = '';
        if (!this.local) msg = VD.t('Dieser PC spielt nicht mit (Mikrofon nicht freigegeben oder entfernt). Klicke „Mit diesem Gerät mitspielen“ und erlaube das Mikrofon, wenn du selbst sprechen willst.');
        else if (rec.length < chars.length && pack) msg = rec.length === 1 ? VD.t('Nur 1 Spieler mit Mikrofon: Er spricht alle Charaktere ({chars}).', { chars: chars.join(', ') }) : VD.t('{p} Spieler, {c} Charaktere: Manche sprechen mehrere Rollen.', { p: rec.length, c: chars.length });
        else if (rec.length > chars.length && pack) msg = VD.t('{p} Spieler, {c} Charaktere: Die Zeilen werden aufgeteilt, jeder bekommt fast gleich viele.', { p: rec.length, c: chars.length });
        sum.textContent = msg; sum.hidden = !msg;
      }
      this.lobbyRefs.start.disabled = !can;
      this.lobbyRefs.start.title = can ? '' : pack ? VD.t('Es braucht mindestens einen Spieler mit Mikrofon.') : VD.t('Lade zuerst ein Dub-Pack.');
    },

    renderLobbyPlayers() {
      if (this.stageKey !== 'lobby' || !this.lobbyRefs) return;
      const box = this.lobbyRefs.players;
      const ps = this.list();
      if (!ps.length) {
        box.replaceChildren(h('p', { class: 'empty', text: this.code ? VD.t('Noch niemand da. Andere treten mit dem Code bei (Handy oder PC).') : VD.t('Tippe auf „Mit diesem Gerät mitspielen“.') }));
      } else {
        box.replaceChildren(...ps.map((p) => h('div', { class: 'pcard' + (p.connected ? '' : ' off'), style: { '--c': p.color } },
          VD.ui.avatar(p, 'lg'), h('span', { class: 'pc-n', text: p.name }),
          h('em', { class: 'pc-s' }, !p.connected ? VD.t('getrennt') : !p.canRecord ? VD.t('nur zuschauen') : p.ready ? VD.t('bereit ✓') : VD.t('wartet'),
            p.wish && p.canRecord && this.wishOn() ? h('span', { class: 'pc-w', text: ' · ' + p.wish }) : null),
          h('button', { class: 'kick', 'aria-label': VD.t('{name} entfernen', { name: p.name }), title: VD.t('Entfernen'), onclick: () => this.removePlayer(p, !p.isLocal) }, '✕'))));
      }
      this.renderHostRoles();
      this.updateLobbySummary();
    },

    /* Wunschrolle für das Gerät des Hosts (Handys wählen selbst auf dem Handy) */
    renderHostRoles() {
      const box = this.lobbyRefs && this.lobbyRefs.hostRoles;
      if (!box) return;
      const me = this.list().find((p) => p.isLocal && p.canRecord);
      const pk = VD.Packs.current();
      box.hidden = !(me && pk && pk.chars.length && this.wishOn());
      if (box.hidden) return;
      box.lastChild.replaceChildren(...pk.chars.map((c) => {
        const k = pk.lines.filter((l) => l.char === c).length;
        const who = this.list().filter((p) => p.canRecord && p.wish === c);
        return h('button', { class: 'role' + (me.wish === c ? ' on' : ''), type: 'button', 'aria-pressed': String(me.wish === c), onclick: () => {
          me.wish = me.wish === c ? null : c;
          VD.sfx.play('click'); this.onRosterChanged();
        } }, h('b', { text: c }), h('small', { text: VD.lines(k) }),
        who.length ? h('span', { class: 'role-who' }, ...who.map((p) => VD.ui.avatar(p, 'xs'))) : null);
      }).concat(h('button', { class: 'role' + (!me.wish ? ' on' : ''), type: 'button', 'aria-pressed': String(!me.wish), onclick: () => {
        me.wish = null; VD.sfx.play('click'); this.onRosterChanged();
      } }, h('b', { text: VD.t('Überrasch mich') }))));
    },

    onPacksChanged() {
      // Wunschrollen, die es im neuen Pack nicht gibt, fallen weg; alle sehen die neuen Charaktere
      const pk = VD.Packs.current();
      this.list().forEach((p) => { if (p.wish && !(pk && pk.chars.includes(p.wish))) p.wish = null; });
      if (this.state === 'lobby') this.onRosterChanged();
      if (this.stageKey === 'lobby') { this.renderPacks(); this.updateLobbySummary(); }
    },

    renderPacks() {
      if (!this.lobbyRefs) return;
      const cur = VD.Packs.current();
      if (!VD.Packs.list.length) { this.lobbyRefs.packs.replaceChildren(h('p', { class: 'empty', text: VD.t('Noch kein Pack. Ziehe ein Dub-Pack hierher.') })); return; }
      this.lobbyRefs.packs.replaceChildren(...VD.Packs.list.map((p) => {
        const on = cur && cur.id === p.id;
        const thumb = h('span', { class: 'pk-thumb' }, p.iconUrl ? h('img', { src: p.iconUrl, alt: '' }) : '🎬');
        const sw = on ? h('span', { class: 'pk-on', text: VD.t('✓ Ausgewählt') }) : h('button', { class: 'btn sm', onclick: () => VD.Packs.select(p.id) }, VD.t('Auswählen'));
        return h('div', { class: 'pk' + (on ? '' : ' off') }, thumb,
          h('div', { class: 'pk-m' }, h('b', { text: p.name }), h('small', { text: `${VD.lines(p.lines.length)} · ${p.chars.join(', ')}${p.author ? ' · ' + p.author : ''}` })),
          sw, h('button', { class: 'kick', 'aria-label': VD.t('{name} löschen', { name: p.name }), title: VD.t('Pack löschen'), onclick: () => VD.Packs.remove(p.id) }, '✕'));
      }));
    },

    setStatus(t, kind) { if (this.lobbyRefs) { this.lobbyRefs.status.textContent = t || ''; this.lobbyRefs.status.className = 'status ' + (kind || ''); } },

    async importFiles(files) {
      if (!files || !files.length) return;
      this.setStatus(VD.t('Lese Dateien …'));
      try {
        const added = await VD.Packs.importFiles(files, (t) => this.setStatus(t));
        this.setStatus(VD.t(added.length === 1 ? '1 Pack geladen: {names}' : '{n} Packs geladen: {names}', { n: added.length, names: added.map((p) => p.name).join(', ') }), 'ok');
        VD.sfx.play('score');
      } catch (e) { console.error(e); this.setStatus(e.message || VD.t('Import fehlgeschlagen'), 'err'); VD.sfx.play('error'); }
    },

    /* ---------- Spiel-Ansichten ---------- */
    viewLoad(scene) {
      this.showStage('load', () => h('div', { class: 'center load' },
        h('span', { class: 'kicker', text: window.VD_CONFIG.appName }),
        h('h1', { class: 'huge title-in', text: scene.title }),
        h('p', { class: 'lead', text: VD.t('Die Szene wird an alle Spieler geschickt …') }),
        h('div', { class: 'cast', id: 'load-cast' })));
      this.updateLoad();
    },
    updateLoad() {
      const box = VD.$('#load-cast'); if (!box || this.stageKey !== 'load') return;
      box.replaceChildren(...this.list().filter((p) => p.assign && p.connected).map((p) => h('div', { class: 'cast-card' + (p.loaded ? ' ok' : ''), style: { '--c': p.color } },
        VD.ui.avatar(p, 'lg'), h('b', { text: p.name }), h('small', { text: p.loaded ? VD.t('bereit ✓') : VD.t('lädt …') }))));
    },

    /* Übersicht während der Aufnahme: jeder in seinem eigenen Tempo */
    viewPlay(scene) {
      const cards = new Map();
      const players = this.list().filter((p) => p.assign && p.loaded);
      const el = this.showStage('play', () => h('div', { class: 'playview' },
        h('div', { class: 'pv-head' },
          scene.pack.iconUrl ? h('img', { class: 'pv-icon', src: scene.pack.iconUrl, alt: '' }) : null,
          h('div', {}, h('span', { class: 'kicker', text: window.VD_CONFIG.appName }), h('h1', { text: scene.title }),
            h('p', { class: 'lead', text: VD.t('Jeder nimmt auf seinem eigenen Gerät auf, in seinem eigenen Tempo. Wer fertig ist, wartet.') }))),
        h('div', { class: 'pv-cards' }, players.map((p) => {
          const fill = h('i', { class: 'pv-fill' });
          const st = h('em', { class: 'pv-st', text: '' });
          const card = h('div', { class: 'pv-card', style: { '--c': p.color } }, VD.ui.avatar(p, 'lg'), h('b', { text: p.name }),
            h('small', { class: 'pv-char', text: p.assign.chars.join(' · ') + ' · ' + VD.lines(p.assign.lineIdx.length) }), h('div', { class: 'pv-bar' }, fill), st);
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
        st.textContent = !p.connected ? VD.t('offline') : p.done ? VD.t('Fertig ✓') : VD.t('Line {c}/{t}', { c: cur, t: total }) + (p.prog && p.prog.st === 'rec' ? ' · ' + VD.t('nimmt auf') : '');
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
        again: h('button', { class: 'btn primary xl', onclick: () => this.hostAgain() }, VD.t('Nochmal ansehen')),
        solo: h('button', { class: 'btn solo', title: VD.t('Die anderen Spieler sehen davon nichts'), onclick: () => this.hostSolo() }, VD.t('Nur für mich ansehen')),
        lobby: h('button', { class: 'btn xl', onclick: () => this.hostLobby() }, VD.t('Zurück zur Lobby'))
      };
      this.finalRefs.dl = VD.Export.buttons(() => { const c = this.finalCtx; if (!c) return null; return { videoUrl: this.fvideoUrl, mime: VD.Scene.videoMime(c.scene.pack), f32: c.mix, sr: window.VDA.SR, title: c.scene.title }; });
      this.finalRefs.btns = h('div', { class: 'col-c', hidden: true }, h('div', { class: 'row center fin-row' }, this.finalRefs.again, this.finalRefs.lobby, this.finalRefs.solo), this.finalRefs.dl);
      this.showStage('final', () => h('div', { class: 'dub premiere' },
        h('div', { class: 'rec-top' }, h('span', { class: 'kicker', text: VD.t('Ergebnis · {title}', { title: scene.title }) })),
        h('div', { class: 'dub-screen big' }, h('div', { class: 'sv' }, v)),
        this.finalRefs.chips, this.finalRefs.btns));
    },
    finalInfo(recs) {
      const r = this.finalRefs; if (!r) return;
      r.btns.hidden = true;
      r.chips.replaceChildren(...recs.map((p) => h('span', { class: 'pr-chip', style: { '--c': p.color } }, VD.ui.avatar(p, 'xs'), h('b', { text: p.name }), h('small', { class: 'muted', text: ' ' + VD.t('als {chars}', { chars: p.assign.chars.join(' + ') }) }))));
    },
    finalButtons(show) { if (this.finalRefs) this.finalRefs.btns.hidden = !show; },
  };

  Object.assign(VD.Host.prototype, views);
})();
