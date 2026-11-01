/* ------------------------------------------------------------------
   DUB TOGETHER – Konfiguration
   Hier kannst du Server und Grenzwerte anpassen.
------------------------------------------------------------------- */
window.VD_CONFIG = {
  appName: 'Dub Together',

  // Präfix für die Raum-IDs im Signalisierungs-Server
  roomPrefix: 'dubtogether-',

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
    maxClipsPerPack: 1500
  }
};
