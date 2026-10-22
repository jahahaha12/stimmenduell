/* Gemeinsame UI-Bausteine für Host-Bildschirm und Handy */
(function () {
  const VD = (window.VD = window.VD || {});
  const h = VD.h;

  VD.ui = {
    avatar(p, cls = '') {
      return h('span', { class: 'avatar ' + cls, style: { '--c': p.color || '#888' }, 'aria-hidden': 'true' }, p.emoji || '🎤');
    },

    /* Countdown mit Ring: 3 · 2 · 1 · Los! */
    countdown(ms = 3000, opt = {}) {
      const n = Math.max(1, Math.round(ms / 1000));
      const ring = h('div', { class: 'cd-ring' });
      ring.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="cd-track" cx="50" cy="50" r="45"/><circle class="cd-arc" cx="50" cy="50" r="45"/></svg>';
      const num = h('span', { class: 'cd-num', 'aria-live': 'assertive' });
      const el = h('div', { class: 'cd' }, ring, num);
      let i = n, timer = null, cancelled = false, resolve;
      const done = new Promise((r) => (resolve = r));
      const restart = () => {
        const arc = VD.$('.cd-arc', ring);
        arc.style.animation = 'none'; void arc.getBoundingClientRect(); arc.style.animation = '';
        num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      };
      const tick = () => {
        if (cancelled) return;
        if (i > 0) {
          num.textContent = String(i); restart();
          if (opt.sfx !== false) VD.sfx.play('tick');
          if (opt.vibrate) VD.vibrate(15);
          i--; timer = setTimeout(tick, 1000);
        } else {
          num.textContent = opt.goText || 'Los!'; el.classList.add('go'); restart();
          if (opt.sfx !== false) VD.sfx.play('go');
          if (opt.vibrate) VD.vibrate([40, 30, 80]);
          resolve();
        }
      };
      tick();
      return { el, done, cancel() { cancelled = true; clearTimeout(timer); } };
    },

    dots() { return h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')); },

    /* senkrechter Pegel (Mischpult-Kanal) */
    vu() { return h('div', { class: 'vu' }, h('i', { class: 'vu-fill' })); },

    /* Aufklappbare Hilfe */
    hint(text) { return h('p', { class: 'hint', text }); }
  };
})();
