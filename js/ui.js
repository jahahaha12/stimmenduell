/* Gemeinsame UI-Bausteine für Host-Bildschirm und Handy */
(function () {
  const VD = (window.VD = window.VD || {});
  const h = VD.h;

  VD.ui = {
    avatar(p, cls = '') {
      return h('span', { class: 'avatar ' + cls, style: { '--c': p.color || '#888' }, 'aria-hidden': 'true' }, p.emoji || '🎤');
    },

    dots() { return h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')); }

  };
})();
