/* Rauschunterdrückung (RNNoise): Einstellung gilt pro Gerät, standardmäßig an. Schalter in Lobby und Spielkopf. */
(function () {
  const VD = (window.VD = window.VD || {});
  const h = VD.h;
  const D = (VD.Denoise = new VD.Emitter());
  D.mics = new Set();
  D.enabled = VD.store.get('denoise', true) !== false;

  D.ready = () => Array.from(D.mics).some((m) => m.dnReady);
  D.busy = () => Array.from(D.mics).some((m) => m.busy);
  D._apply = (m) => { if (m.dnReady && !m.busy) m.setDenoise(D.enabled); };
  D.attach = (m) => { D.mics.add(m); D._apply(m); D.emit('change'); };
  D.detach = (m) => { D.mics.delete(m); D.emit('change'); };

  D.toggle = () => {
    if (!D.ready()) { VD.toast('Rauschunterdrückung ist in diesem Browser nicht verfügbar.', 'warn'); return; }
    if (D.busy()) { VD.toast('Während der Aufnahme lässt sich der Filter nicht umschalten.'); return; }
    D.enabled = !D.enabled; VD.store.set('denoise', D.enabled);
    D.mics.forEach(D._apply); D.emit('change');
  };
  /* Wird nach jeder Aufnahme aufgerufen, damit eine gesperrte Änderung nachgezogen wird */
  D.refresh = () => { D.mics.forEach(D._apply); D.emit('change'); };

  const state = () => D.ready() && D.enabled;
  const title = () => (!D.ready() ? 'Rauschunterdrückung nicht verfügbar' : D.enabled ? 'Hintergrundgeräusche filtern: an' : 'Hintergrundgeräusche filtern: aus');

  /* Schalter mit Beschriftung (Lobby) */
  D.switchEl = () => {
    const b = h('button', { class: 'dn-switch', type: 'button', role: 'switch', onclick: () => { D.toggle(); VD.sfx && VD.sfx.play('click'); } }, h('i'), h('span', { text: 'Hintergrundgeräusche filtern' }));
    const sync = () => { b.setAttribute('aria-checked', String(state())); b.classList.toggle('on', state()); b.classList.toggle('na', !D.ready()); b.title = title(); };
    const f = () => { if (!b.isConnected && b._seen) { D.off('change', f); return; } b._seen = b._seen || b.isConnected; sync(); };
    D.on('change', f); sync();
    return b;
  };
  /* Kleiner Knopf für Kopfzeilen */
  D.iconEl = () => {
    const b = h('button', { class: 'icon-btn dn-icon', type: 'button', 'aria-label': 'Hintergrundgeräusche filtern', onclick: () => D.toggle() }, '≋');
    const sync = () => { b.classList.toggle('off', !state()); b.title = title(); b.setAttribute('aria-pressed', String(state())); };
    const f = () => { if (!b.isConnected && b._seen) { D.off('change', f); return; } b._seen = b._seen || b.isConnected; sync(); };
    D.on('change', f); sync();
    return b;
  };
})();
