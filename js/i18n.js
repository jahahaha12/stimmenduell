/* Sprachen: Der deutsche Text ist gleichzeitig der Schlüssel. Fehlt eine Übersetzung, erscheint Englisch, dann Deutsch.
   Neue Sprache: Datei js/lang/xx.js nach dem Vorbild von en.js anlegen und in index.html einbinden. */
(function () {
  const VD = (window.VD = window.VD || {});
  const dict = {};
  const LANGS = [
    { c: 'de', n: 'Deutsch' }, { c: 'en', n: 'English' }, { c: 'es', n: 'Español' }, { c: 'fr', n: 'Français' },
    { c: 'pt', n: 'Português' }, { c: 'ru', n: 'Русский' }, { c: 'hi', n: 'हिन्दी' }
  ];
  const codes = LANGS.map((l) => l.c);
  const get = () => { try { return localStorage.getItem('vt-lang'); } catch { return null; } };
  let lang = get();
  if (!codes.includes(lang)) {
    const nav = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']).map((x) => String(x).toLowerCase().slice(0, 2));
    lang = nav.find((x) => codes.includes(x)) || 'en';
  }

  VD.LANGS = LANGS;
  VD.lang = lang;
  VD.missing = new Set();
  VD.addLang = (code, words) => { dict[code] = Object.assign(dict[code] || {}, words); };
  VD.setLang = (code) => { try { localStorage.setItem('vt-lang', code); } catch { /* ignore */ } location.reload(); };

  /* Text in der eingestellten Sprache; {name} im Text wird durch p.name ersetzt */
  VD.t = (key, p) => {
    let s = (dict[lang] && dict[lang][key]) || (lang !== 'de' && dict.en && dict.en[key]) || key;
    if (lang !== 'de' && !(dict[lang] && key in dict[lang])) VD.missing.add(key);   // zum Prüfen (Konsole: VD.missing): Texte ohne Übersetzung
    if (typeof s === 'function') s = s(p || {});
    if (p) s = s.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? p[k] : m));
    return s;
  };
  /* "3 Zeilen" / "1 Zeile" */
  VD.lines = (n) => VD.t(n === 1 ? '{n} Zeile' : '{n} Zeilen', { n });

  /* Statischer Text in index.html: data-i18n (Inhalt), data-i18n-ph (Platzhalter), data-i18n-aria (aria-label) */
  VD.applyI18n = () => {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = VD.t(e.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach((e) => { e.placeholder = VD.t(e.getAttribute('data-i18n-ph')); });
    document.querySelectorAll('[data-i18n-aria]').forEach((e) => { e.setAttribute('aria-label', VD.t(e.getAttribute('data-i18n-aria'))); });
    const app = (window.VD_CONFIG && window.VD_CONFIG.appName) || 'Vibing Together';
    const md = document.querySelector('meta[name=description]');
    if (md) md.content = VD.t('{app} – synchronisiert Filmszenen mit Freunden, direkt im Browser.', { app });
    document.title = app;
    // Schriftzug auf der Startseite: erstes Wort / Rest (zwei Zeilen-Teile wie im Design)
    const wm = document.querySelector('.wordmark');
    if (wm) { const [a, ...b] = app.split(' '); wm.setAttribute('aria-label', app); wm.replaceChildren(VD.h('span', { text: a }), b.length ? VD.h('span', { text: b.join(' ') }) : ''); }
  };

  /* Sprachwahl (Auswahlfeld); Wechsel lädt die Seite neu, der Raum-Code in der Adresse bleibt erhalten */
  VD.langPicker = () => {
    const sel = VD.h('select', { class: 'lang-pick', 'aria-label': 'Language', title: 'Language', onchange: (e) => VD.setLang(e.target.value) },
      ...LANGS.map((l) => VD.h('option', { value: l.c, text: l.n })));
    sel.value = lang;
    return sel;
  };
})();
