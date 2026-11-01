/* Deutsche Übersetzung für fremdsprachige Untertitel (kostenloser Dienst MyMemory, läuft nur beim Host).
   Jedes Pack wird einmal übersetzt und mit dem Pack gespeichert. Ohne Internet oder bei erreichtem Tageslimit
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
      const e = new Error('Übersetzung nicht möglich'); e.limit = Number(j.responseStatus) === 429 || /MYMEMORY WARNING/i.test(out || ''); throw e;
    }
    return out.trim();
  }

  async function translate(caption) {
    const t = clean(caption);
    if (t.length < 2 || looksGerman(t) || !/\p{L}/u.test(t)) return '';
    let out;
    try { out = await ask(t, 'autodetect|de'); }
    catch (e) { if (e.limit || !EN.test(t)) throw e; out = await ask(t, 'en|de'); }   // falls die Spracherkennung nicht klappt und es nach Englisch aussieht
    return out && !same(out, t) ? out.slice(0, 240) : '';
  }

  const running = new Map();
  let failedAt = 0;   // Dienst nicht erreichbar oder Limit erreicht: 5 Minuten lang nicht erneut versuchen (kein Warten beim Spielstart)
  VD.Translate = {
    /* Übersetzt alle Zeilen eines Packs (einmal); maxMs begrenzt das Warten beim Spielstart */
    pack(pack, maxMs) {
      if (!pack || pack.trDone || navigator.onLine === false || Date.now() - failedAt < 300000) return Promise.resolve();
      if (!running.has(pack.id)) {
        running.set(pack.id, (async () => {
          let ok = true;
          for (const l of pack.lines) {
            if (typeof l.tr === 'string') continue;
            try { l.tr = await translate(l.caption); }
            catch (e) { if (e.limit || e.name === 'TypeError' || e.name === 'TimeoutError') { ok = false; failedAt = Date.now(); break; } l.tr = ''; }   // offline/Limit: später nochmal; sonst: keine Übersetzung
          }
          if (ok) pack.trDone = true;
          VD.Packs.save(pack);
        })().finally(() => running.delete(pack.id)));
      }
      const job = running.get(pack.id);
      return maxMs ? Promise.race([job, VD.sleep(maxMs)]) : job;
    }
  };
})();
