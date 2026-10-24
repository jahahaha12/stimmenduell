/* Einstieg: Startseite, Beitritt (Handy), Host-Start */
(function () {
  const VD = window.VD;
  const $ = VD.$;
  const screens = ['home', 'join', 'host', 'player'];
  const show = (name) => screens.forEach((s) => { $('#v-' + s).hidden = s !== name; });

  /* Spieler-ID pro Browser-Tab, damit ein Neuladen wieder in den Raum findet */
  function getPid() {
    try {
      let p = sessionStorage.getItem('vd.pid');
      if (!p) { p = VD.uid(); sessionStorage.setItem('vd.pid', p); }
      return p;
    } catch { return VD.uid(); }
  }

  const params = new URLSearchParams(location.search);
  const cleanCode = (s) => (s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  /* ---------- Startseite ---------- */
  const touchFirst = matchMedia('(pointer: coarse)').matches && innerWidth < 900;
  document.body.classList.toggle('touch-first', touchFirst);

  $('#btn-host').addEventListener('click', async () => {
    show('host');
    document.body.classList.add('is-host');
    const host = new VD.Host($('#v-host'));
    window.__host = host;
    try { await host.start(); } catch (e) { console.error(e); VD.toast('Start fehlgeschlagen: ' + e.message, 'warn'); }
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = cleanCode($('#code-in').value);
    if (c.length !== 4) { $('#code-in').classList.add('shake'); setTimeout(() => $('#code-in').classList.remove('shake'), 500); return; }
    showJoin(c);
  });
  $('#code-in').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });

  /* ---------- Beitritt ---------- */
  let joinCode = '';
  let avatar = VD.store.get('emoji', VD.AVATARS[Math.floor(Math.random() * VD.AVATARS.length)]);

  function showJoin(code) {
    joinCode = code;
    show('join');
    $('#join-code').textContent = code;
    $('#name-in').value = VD.store.get('name', '');
    $('#insecure').hidden = window.isSecureContext;
    $('#btn-join').disabled = !window.isSecureContext;
    const pick = $('#avatar-pick');
    pick.replaceChildren(...VD.AVATARS.map((a) => VD.h('button', { type: 'button', role: 'radio', 'aria-checked': String(a === avatar), class: 'av-opt' + (a === avatar ? ' on' : ''), 'aria-label': 'Symbol ' + a, onclick: (e) => {
      avatar = a; VD.$$('.av-opt', pick).forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
      e.currentTarget.classList.add('on'); e.currentTarget.setAttribute('aria-checked', 'true'); VD.vibrate(8);
    } }, a)));
    setTimeout(() => $('#name-in').focus(), 50);
  }
  $('#btn-join-back').addEventListener('click', () => { history.replaceState(null, '', location.pathname); show('home'); });
  $('#profile-form').addEventListener('submit', (e) => { e.preventDefault(); doJoin(true); });
  $('#btn-join-nomic').addEventListener('click', () => {
    if (!$('#name-in').value.trim()) { $('#name-in').focus(); return; }
    doJoin(false);
  });

  function joinError(msg) { const el = $('#join-err'); el.textContent = msg; el.hidden = !msg; }

  async function doJoin(withMic) {
    const name = $('#name-in').value.trim();
    if (!name) { $('#name-in').focus(); return; }
    joinError('');
    const btns = [$('#btn-join'), $('#btn-join-nomic')];
    btns.forEach((b) => (b.disabled = true));
    $('#btn-join').classList.add('busy');
    VD.store.set('name', name); VD.store.set('emoji', avatar);
    try {
      await VD.audio.ensure();
      let mic = null;
      if (withMic) {
        mic = new VD.Mic();
        try { await mic.start(); }
        catch (err) {
          const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          const none = err && err.name === 'NotFoundError';
          joinError(denied ? 'Der Zugriff aufs Mikrofon wurde blockiert. Erlaube ihn in den Browser-Einstellungen für diese Seite und versuche es nochmal – oder tritt ohne Mikrofon bei.'
            : none ? 'Es wurde kein Mikrofon gefunden.' : 'Das Mikrofon lässt sich nicht starten: ' + (err.message || err.name));
          throw err;
        }
      }
      const profile = { pid: getPid(), name, emoji: avatar, color: VD.store.get('color', VD.COLORS[Math.floor(Math.random() * VD.COLORS.length)]) };
      const net = new VD.ClientNet();
      let link;
      try { link = await net.connect(joinCode); }
      catch (err) { joinError(VD.friendlyNetError(err)); if (mic) mic.stop(); throw err; }

      show('player');
      document.body.classList.add('is-player');
      let kicked = false;
      const ctrl = new VD.Controller($('#v-player'), {
        mic, profile,
        onKicked: (msg) => { kicked = true; ctrl.destroy(); try { net.close(); } catch { /* ignore */ } if (mic) mic.stop(); showEnded(msg); },
        onLeave: () => { kicked = true; ctrl.destroy(); if (mic) mic.stop(); setTimeout(() => { try { net.close(); } catch { /* ignore */ } location.href = location.pathname; }, 250); }
      });
      window.__ctrl = ctrl;
      ctrl.attach(link);
      keepAlive(net, link, ctrl, () => kicked);
    } catch (err) {
      console.warn('Beitritt fehlgeschlagen', err);
      btns.forEach((b) => (b.disabled = !window.isSecureContext && b === $('#btn-join')));
    } finally {
      $('#btn-join').classList.remove('busy');
      if (window.isSecureContext) $('#btn-join').disabled = false;
      $('#btn-join-nomic').disabled = false;
    }
  }

  /* Bei Verbindungsabbruch automatisch neu verbinden (gleiche Spieler-ID -> Punkte bleiben) */
  function keepAlive(net, link, ctrl, isKicked) {
    const onClose = async () => {
      if (isKicked()) return;
      ctrl.setOffline(true);
      for (let i = 0; i < 40 && !isKicked(); i++) {
        await VD.sleep(i === 0 ? 700 : 2500);
        try {
          try { net.close(); } catch { /* ignore */ }
          const n2 = new VD.ClientNet();
          const l2 = await n2.connect(joinCode);
          net.hb = n2.hb; net.link = l2; net.peer = n2.peer;
          ctrl.attach(l2);
          l2.on('close', onClose);
          return;
        } catch (e) { /* weiter versuchen */ }
      }
      if (!isKicked()) showEnded('Die Verbindung zum Host ist abgebrochen.');
    };
    link.on('close', onClose);
  }

  function showEnded(msg) {
    const root = $('#v-player');
    root.replaceChildren(VD.h('main', { class: 'pc-body' }, VD.h('section', { class: 'pc-view center view-in' },
      VD.h('h2', { text: 'Raus aus dem Raum' }), VD.h('p', { class: 'lead', text: msg }),
      VD.h('button', { class: 'btn primary big', onclick: () => { location.href = location.pathname; } }, 'Zur Startseite'))));
  }

  /* ---------- Start ---------- */
  window.addEventListener('error', (e) => console.error(e.error || e.message));
  window.addEventListener('beforeunload', (e) => {
    if (window.__host && window.__host.state === 'playing') { e.preventDefault(); e.returnValue = ''; }
  });

  const room = cleanCode(params.get('room'));
  if (room.length === 4) showJoin(room);
  else show('home');
})();
