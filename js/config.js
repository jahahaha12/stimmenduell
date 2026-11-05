/* ------------------------------------------------------------------
   VIBING TOGETHER – Konfiguration
   Hier kannst du Server und Grenzwerte anpassen.
------------------------------------------------------------------- */
window.VD_CONFIG = {
  // Name des Spiels (Kopfzeile, Browser-Tab, Dateinamen beim Export)
  appName: 'Vibing Together',

  // Seite, auf die der Knopf "Dub-Packs herunterladen" führt
  packSiteUrl: 'https://gamebanana.com/games/20674',

  // Präfix für die Raum-IDs im Signalisierungs-Server
  roomPrefix: 'vibingtogether-',

  // Signalisierung (nur zum Verbindungsaufbau, Audio läuft direkt P2P).
  // Leer lassen = kostenloser öffentlicher PeerJS-Cloud-Server.
  // Eigener Server (siehe README): host:'meinserver.de', port:443, path:'/', secure:true
  peer: { host: '', port: 443, path: '/', secure: true, key: 'peerjs' },

  // STUN reicht in den meisten Heimnetzen. Wenn Handys im Mobilfunknetz
  // sich nicht verbinden, trage hier einen TURN-Server ein, z. B.:
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ],

  limits: {
    maxPlayers: 8,
    maxNameLength: 14,
    maxBlobBytes: 80 * 1024 * 1024, // größte Datei Host→Handy (Video)
    maxTakeBytes: 6 * 1024 * 1024,   // größte erlaubte Aufnahme vom Handy
    maxZipBytes: 400 * 1024 * 1024,  // größte Pack-Datei
    maxClipBytes: 40 * 1024 * 1024,  // größter einzelner Sprach-Clip im Pack
    maxVideoBytes: 400 * 1024 * 1024, // größte einzelne Videodatei
    maxClipsPerPack: 1500            // mehr Zeilen pro Pack werden ignoriert
  },

  // Glas-Effekt auf Knöpfen und Boxen (js/glass.js). enabled: false schaltet ihn ganz ab.
  // Art, Farbe und Stärke der Tönung pro Element stehen in css/style.css (--lg-mode, --lg-rgb, --lg-amt).
  glass: {
    enabled: true,
    thick: 50,           // Glasdicke in Pixeln (stärkere Brechung)
    bezel: 30,           // Breite des gewölbten Randes in Pixeln
    ior: 1.5,            // Brechungsindex
    dispersion: 0.04,    // Farbsaum am Rand
    blur: 1,             // Weichzeichner in Pixeln (0 = ganz klar, 1 = ganz leicht weich)
    specular: 0.55,      // Glanzkante, 0 bis 1
    saturation: 140,     // Sättigung in Prozent
    rimWidth: 24,        // Breite des gemalten Randstreifens bei klarem Glas in Pixeln
    liveRefraction: true, // Schwebende Leisten brechen in Chrome und Edge den Inhalt dahinter echt
    maxShift: 36         // größte Verschiebung dieser Brechung in Pixeln
  },

  // Spielablauf: Zeiten und Werte, an denen man das Spielgefühl einstellen kann
  game: {
    leadSec: 0.6,          // so viele Sekunden Video laufen vor einer Zeile (Anlauf)
    trailSec: 0.6,         // so viele Sekunden laufen nach dem Ende der Originalzeile weiter
    recTailMs: 350,        // die Aufnahme läuft so lange über das Ende der Zeile hinaus
    voiceTargetDb: -20,    // Ziel-Lautstärke der Aufnahmen (dBFS); höher = lauter
    backingInMix: 0.4,     // Lautstärke von Musik/Geräuschen im fertigen Ergebnis (0 = aus, 1 = voll)
    backingInOriginal: 0.55, // Lautstärke von Musik/Geräuschen beim Knopf "Original"
    loadTimeoutMs: 90000,  // so lange wartet der Host höchstens, bis alle Geräte die Szene geladen haben
    replayDelayMs: 2500    // Vorlauf, damit bei "Nochmal ansehen" alle Geräte gleichzeitig starten
  }
};
