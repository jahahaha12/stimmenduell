/* Übersetzung der Untertitel in die eingestellte Sprache (kostenloser Dienst MyMemory). Das macht jedes Gerät selbst
   für seine eigenen Zeilen; Ergebnisse bleiben auf dem Gerät gespeichert. Ohne Internet oder bei erreichtem Tageslimit
   gibt es einfach keine Übersetzung; das Spiel läuft normal weiter. */
(function () {
  const VD = (window.VD = window.VD || {});
  const API = 'https://api.mymemory.translated.net/get';
  // Wörter, die es (fast) nur im Deutschen gibt; ein Treffer reicht
  const DE = /\b(ich|nicht|und|ist|bin|bist|sind|auch|noch|schon|aber|oder|wenn|dann|kein|keine|mein|meine|dein|deine|habe|haben|hab|kann|jetzt|hier|mit|auf|für|ein|eine|einen|der|das|den|dem|du|wir|ihr|nein|doch|mal|nur|sehr|gut|sag|bitte|danke|warum|wieso|weil|alles|nichts|geil|scheiße|ja|sie|es|wollen|machen|gehen|kommen|sein|wird|werden|hat|hast|soll|muss|mich|dich|uns|euch|ihm|ihn|wo|wer|weg|kommt|geht|macht|tja|na|oh mann)\b/i;
  const EN = /\b(the|you|what|are|is|i|it|to|of|my|me|this|that|do|don't|no|yes|your|we|he|she|they|have|got|just|oh|hey|why|how|can|not|and)\b/i;
  const looksGerman = (t) => /[äöüß]/i.test(t) || DE.test(t);
  // "[Peter] “Text”" -> "Text"
  const clean = (t) => String(t || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^[\s"“”„«»']+|[\s"“”„«»']+$/g, '').trim();
  const same = (a, b) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  async function ask(text, pair) {
    const r = await fetch(API + '?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(pair), { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const out = j && j.responseData && j.responseData.translatedText;
    if (Number(j.responseStatus) !== 200 || typeof out !== 'string' || /MYMEMORY WARNING|INVALID|PLEASE SELECT/i.test(out)) {
      const e = new Error(VD.t('Übersetzung nicht möglich')); e.limit = Number(j.responseStatus) === 429 || /MYMEMORY WARNING/i.test(out || ''); throw e;
    }
    return out.trim();
  }

  async function translate(caption, lang) {
    const t = clean(caption);
    if (t.length < 2 || !/\p{L}/u.test(t)) return '';
    if (lang === 'de' && looksGerman(t)) return '';
    if (lang === 'en' && !looksGerman(t) && EN.test(t)) return '';
    let out;
    try { out = await ask(t, 'autodetect|' + lang); }
    catch (e) { if (e.limit || lang === 'en' || !EN.test(t)) throw e; out = await ask(t, 'en|' + lang); }   // falls die Spracherkennung nicht klappt und es nach Englisch aussieht
    return out && !same(out, t) ? out.slice(0, 240) : '';
  }

  /* Gespeicherte Übersetzungen (höchstens 600, die ältesten fallen weg) */
  const KEY = 'vt-tr';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { cache = {}; }
  const keep = (k, v) => {
    cache[k] = v;
    const ks = Object.keys(cache);
    if (ks.length > 600) ks.slice(0, ks.length - 600).forEach((x) => delete cache[x]);
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  };

  let failedAt = 0;   // Dienst nicht erreichbar oder Limit erreicht: 5 Minuten lang nicht erneut versuchen
  VD.Translate = {
    /* Übersetzt die Texte nacheinander in die eingestellte Sprache; onEach(text, übersetzung) kommt für jeden Text */
    async run(captions, onEach, isStale) {
      const lang = VD.lang;
      const todo = [];
      for (const c of captions) {
        const k = lang + '|' + c;
        if (typeof cache[k] === 'string') onEach(c, cache[k]); else todo.push(c);
      }
      for (const c of todo) {
        if (isStale && isStale()) return;
        if (navigator.onLine === false || Date.now() - failedAt < 300000) return;
        try { const tr = await translate(c, lang); keep(lang + '|' + c, tr); onEach(c, tr); }
        catch (e) { if (e.limit || e.name === 'TypeError' || e.name === 'TimeoutError') { failedAt = Date.now(); return; } keep(lang + '|' + c, ''); }
      }
    }
  };
})();
