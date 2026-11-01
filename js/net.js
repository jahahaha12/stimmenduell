/* Netzwerk: WebRTC über PeerJS. Host = Raum, Handys = Clients.
   Der Signalisierungs-Server vermittelt nur den Verbindungsaufbau; Audio läuft direkt P2P.
   Jede Verbindung wird als "Link" gekapselt (auch der lokale Mitspieler am Host-PC). */
(function () {
  const VD = (window.VD = window.VD || {});
  const CFG = window.VD_CONFIG;
  const CHUNK = 15000;   // bleibt unter der PeerJS-Grenze von 16300 Byte pro Nachricht
  // Größte Datei, die eine Seite annimmt: Handys bekommen das Video, der Host nur Aufnahmen.
  // Geprüft wird schon bei der Ankündigung, bevor Speicher reserviert wird.
  const MAX_TO_CLIENT = CFG.limits.maxBlobBytes;
  const MAX_TO_HOST = CFG.limits.maxTakeBytes;

  /* Peer-Parameter dürfen per URL überschrieben werden (?peerhost=...&peerport=...) */
  const q = () => new URLSearchParams(location.search);
  VD.peerOptions = function () {
    const p = q();
    const o = { debug: 0, config: { iceServers: CFG.iceServers } };
    const host = p.get('peerhost') || CFG.peer.host;
    if (host) {
      o.host = host;
      o.port = Number(p.get('peerport') || CFG.peer.port);
      o.path = p.get('peerpath') || CFG.peer.path;
      const sec = p.get('peersecure');
      o.secure = sec != null ? sec !== '0' : !!CFG.peer.secure;
      o.key = CFG.peer.key;
    }
    return o;
  };
  VD.peerQuery = function () {
    const p = q(), out = new URLSearchParams();
    ['peerhost', 'peerport', 'peerpath', 'peersecure'].forEach((k) => { if (p.get(k) != null) out.set(k, p.get(k)); });
    return out.toString();
  };
  VD.joinUrl = function (code) {
    const extra = VD.peerQuery();
    return location.origin + location.pathname + '?room=' + code + (extra ? '&' + extra : '');
  };

  /* ---------- Link-Basis ---------- */
  class Link extends VD.Emitter {
    constructor() { super(); this.open = true; this.lastSeen = Date.now(); }
  }

  class RemoteLink extends Link {
    constructor(conn, { autoPong = false, maxBlob = MAX_TO_CLIENT } = {}) {
      super();
      this.conn = conn; this.autoPong = autoPong; this.maxBlob = maxBlob; this.rx = new Map();
      conn.on('data', (d) => this._onData(d));
      conn.on('close', () => this._closed());
      conn.on('error', () => this._closed());
    }
    _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
    _onData(m) {
      this.lastSeen = Date.now();
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'ping': if (this.autoPong) this.send({ t: 'pong', ts: m.ts }); return;
        case 'pong':
          if (typeof m.ts === 'number') {
            const r = Date.now() - m.ts;
            if (r >= 0 && r < 5000) { (this.rtts = this.rtts || []).push(r); if (this.rtts.length > 6) this.rtts.shift(); this.rtt = Math.min(...this.rtts); }
          }
          return;
        case 'bs': // Blob-Start
          if (typeof m.size !== 'number' || m.size < 0 || m.size > this.maxBlob || typeof m.n !== 'number' || typeof m.id !== 'string' || m.id.length > 40 || this.rx.size >= 4) return;
          for (const [k, v] of this.rx) if (Date.now() - v.t > 60000) this.rx.delete(k);
          if (this.rx.size >= 4) return;
          this.rx.set(m.id, { t: Date.now(), kind: String(m.kind), meta: m.meta || {}, bytes: new Uint8Array(m.size), got: 0, n: m.n, cs: m.cs || CHUNK });
          return;
        case 'bc': {
          const r = this.rx.get(m.id);
          if (!r || !Number.isInteger(m.i) || m.i < 0) return;
          const d = m.d instanceof ArrayBuffer ? new Uint8Array(m.d) : m.d;
          const off = m.i * r.cs;
          if (!(d instanceof Uint8Array) || off + d.length > r.bytes.length || d.length > r.cs) return;
          r.bytes.set(d, off);
          r.got++;
          return;
        }
        case 'be': {
          const r = this.rx.get(m.id);
          if (!r) return;
          this.rx.delete(m.id);
          if (r.got === r.n) this.emit('blob', r.kind, r.meta, r.bytes);
          return;
        }
        default: this.emit('msg', m);
      }
    }
    send(msg) { try { if (this.open && this.conn.open) this.conn.send(msg); } catch (e) { console.warn('send', e); } }
    async sendBlob(kind, meta, bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes.buffer || bytes);
      const id = VD.uid();
      const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
      this.send({ t: 'bs', id, kind, meta, n, size: bytes.length, cs: CHUNK });
      for (let i = 0; i < n; i++) {
        const dc = this.conn.dataChannel;
        while (dc && dc.bufferedAmount > 1.5e6 && this.open) await VD.sleep(15);
        if (!this.open) return;
        this.send({ t: 'bc', id, i, d: bytes.slice(i * CHUNK, (i + 1) * CHUNK).buffer });
        if (i % 24 === 23) await VD.sleep(0);
      }
      this.send({ t: 'be', id });
    }
    close() { const was = this.open; this.open = false; try { this.conn.close(); } catch { /* ignore */ } if (was) this.emit('close'); }
  }

  /* Lokaler Mitspieler: zwei Enden, Nachrichten gehen direkt hin und her. */
  class LocalLink extends Link {
    constructor() { super(); this.peerLink = null; }
    send(msg) { const o = this.peerLink; if (!o || !o.open) return; const c = JSON.parse(JSON.stringify(msg)); queueMicrotask(() => o.emit('msg', c)); }
    async sendBlob(kind, meta, bytes) { const o = this.peerLink; if (!o || !o.open) return; const b = bytes.slice(); queueMicrotask(() => o.emit('blob', kind, JSON.parse(JSON.stringify(meta || {})), b)); }
    close() { if (!this.open) return; this.open = false; this.emit('close'); if (this.peerLink && this.peerLink.open) { this.peerLink.open = false; this.peerLink.emit('close'); } }
  }
  VD.localPair = function () {
    const a = new LocalLink(), b = new LocalLink();
    a.peerLink = b; b.peerLink = a;
    return { host: a, client: b };
  };

  /* ---------- Host ---------- */
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // ohne I und O
  const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

  VD.HostNet = class extends VD.Emitter {
    constructor() { super(); this.links = new Set(); }
    async open() {
      for (let tries = 0; tries < 8; tries++) {
        const code = makeCode();
        try { await this._openPeer(CFG.roomPrefix + code); this.code = code; break; }
        catch (e) { if (e && e.type === 'unavailable-id') continue; throw e; }
      }
      if (!this.code) throw new Error('Kein freier Raum-Code gefunden');
      this.timer = setInterval(() => {
        const now = Date.now();
        for (const l of this.links) if (l.open && now - l.lastSeen > 14000) l.close();
      }, 4000);
      return this.code;
    }
    _openPeer(id) {
      return new Promise((resolve, reject) => {
        let ready = false;
        const peer = new Peer(id, VD.peerOptions());
        const t = setTimeout(() => { if (!ready) { try { peer.destroy(); } catch { /* ignore */ } reject(new Error('Signalisierungs-Server nicht erreichbar')); } }, 12000);
        peer.on('open', () => { ready = true; clearTimeout(t); this.peer = peer; resolve(); });
        peer.on('error', (e) => { if (!ready) { clearTimeout(t); try { peer.destroy(); } catch { /* ignore */ } reject(e); } else this.emit('error', e); });
        peer.on('disconnected', () => { if (!peer.destroyed) { try { peer.reconnect(); } catch { /* ignore */ } } });
        peer.on('connection', (conn) => this._onConn(conn));
      });
    }
    _onConn(conn) {
      const link = new RemoteLink(conn, { autoPong: true, maxBlob: MAX_TO_HOST });
      this.links.add(link);
      let first = true;
      link.on('msg', (m) => { if (first) { first = false; if (m.t === 'hello') this.emit('hello', link, m); else link.close(); } });
      link.on('close', () => this.links.delete(link));
      setTimeout(() => { if (first) link.close(); }, 10000);
    }
    close() { clearInterval(this.timer); try { this.peer && this.peer.destroy(); } catch { /* ignore */ } }
  };

  /* ---------- Client (Handy) ---------- */
  VD.ClientNet = class extends VD.Emitter {
    async connect(code) {
      this.code = code;
      let conn;
      try {
        await new Promise((resolve, reject) => {
          const peer = new Peer(VD.peerOptions());
          this.peer = peer;
          const t = setTimeout(() => reject(new Error('Signalisierungs-Server nicht erreichbar')), 12000);
          peer.on('open', () => { clearTimeout(t); resolve(); });
          peer.on('error', (e) => { clearTimeout(t); reject(e); });
        });
        conn = this.peer.connect(CFG.roomPrefix + code, { reliable: true, serialization: 'binary' });
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Keine Antwort vom Host (Netzwerk/Firewall?)')), 15000);
          conn.on('open', () => { clearTimeout(t); resolve(); });
          conn.on('error', (e) => { clearTimeout(t); reject(e); });
          this.peer.on('error', (e) => { clearTimeout(t); reject(e); });
        });
      } catch (e) {
        // Fehlgeschlagener Versuch: Verbindung zum Signalisierungs-Server wieder schließen
        try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
        this.peer = null;
        throw e;
      }
      this.link = new RemoteLink(conn);
      this.link.on('close', () => this._stop());
      const pingNow = () => this.link.send({ t: 'ping', ts: Date.now() });
      [0, 300, 700, 1200, 2000].forEach((d) => setTimeout(pingNow, d));
      this.hb = setInterval(() => {
        this.link.send({ t: 'ping', ts: Date.now() });
        if (Date.now() - this.link.lastSeen > 10000) this.link.close();
      }, 4000);
      return this.link;
    }
    _stop() { clearInterval(this.hb); }
    close() { this._stop(); try { this.link && this.link.close(); this.peer && this.peer.destroy(); } catch { /* ignore */ } }
  };

  VD.friendlyNetError = function (e) {
    const t = e && e.type;
    if (t === 'peer-unavailable') return 'Raum nicht gefunden. Prüfe den Code und ob der Host das Spiel noch geöffnet hat.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Der Verbindungs-Server ist nicht erreichbar. Prüfe deine Internetverbindung.';
    if (t === 'webrtc') return 'WebRTC-Verbindung fehlgeschlagen. Ein anderes WLAN oder ein TURN-Server hilft (siehe README).';
    return (e && e.message) || 'Verbindung fehlgeschlagen.';
  };
})();
