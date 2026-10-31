// /mp/ws: authenticated bridge from the browser to the loopback AliYa world server.
// The browser never chooses the upstream address, the in-game name or the resume identity:
// the name comes from the owned character, resume tokens only from what the world server
// issued for that same account and character. Bounded buffers, one socket per character.
import WebSocket, { WebSocketServer } from 'ws';
import { onlineCharacter, onlineName, onlineOrigin, onlineLimit, validateOnlineUpstream, ONLINE_CAPACITY } from './online.js';

const MAX_PAYLOAD = 64 * 1024; // the world server's own frame limit
const BUFFER_LIMIT = 1 << 20;
const PREOPEN_LIMIT = 16;
const PER_IP = 8;
const HELLO_TIMEOUT_MS = 20_000;
const PING_MS = 20_000;
const RESUME_TTL_MS = 30 * 60 * 1000;
const MAX_RESUMES = 2048;
const RESUME_ERRORS = new Set(['resume_denied', 'invalid_resume', 'resume_expired']);
const PASS_CODES = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);
const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' };

function refuse(socket, status) {
  try { socket.end(`HTTP/1.1 ${status} ${STATUS[status] || 'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
}

function closeSocket(ws, code = 1000, reason = '') {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.close(PASS_CODES.has(code) || (code >= 3000 && code <= 4999) ? code : 1011, Buffer.byteLength(reason) <= 120 ? reason : '');
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  } catch {
    try { ws.terminate(); } catch { /* gone */ }
  }
}

export class OnlineRelay {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.upstream = validateOnlineUpstream(options.onlineUpstream || undefined);
    this.log = options.log || (() => {});
    this.sessions = new Map(); // characterId -> session
    this.perIp = new Map();
    this.resumes = new Map(); // `${accountId}:${characterId}` -> { client_id, resume_token, expires }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  }

  get size() { return this.sessions.size; }
  has(characterId) { return this.sessions.has(characterId); }

  // Public roster for the server browser (names only).
  roster() {
    return [...this.sessions.values()].map((s) => ({ name: s.name, state: s.profiled ? 'playing' : 'joining' }));
  }

  // Characters inside the world (paychecks, phone contacts).
  activeProfiles() {
    return [...this.sessions.values()].filter((s) => s.profiled)
      .map((s) => ({ accountId: s.accountId, characterId: s.characterId, name: s.name }));
  }

  closeAll() {
    for (const s of [...this.sessions.values()]) s.stop(1001, 'Server shutting down');
    this.resumes.clear();
  }

  upgrade(req, socket, head) {
    let account, character, ip;
    try {
      if ((req.url || '').split('?')[0] !== '/mp/ws') return refuse(socket, 404);
      onlineOrigin(this.ctx, req);
      onlineLimit(this.ctx, req, 'join');
      const id = new URL(req.url, 'http://localhost').searchParams.get('character');
      ({ account, character } = onlineCharacter(this.ctx, req, id));
      ip = this.ctx.clientIp(req);
    } catch (err) {
      return refuse(socket, err && err.status ? err.status : 400);
    }
    // The same character reconnecting replaces its old socket (the world server does the same).
    const previous = this.sessions.get(character.id);
    if (previous) previous.stop(4001, 'Replaced by a new connection');
    if (this.sessions.size >= ONLINE_CAPACITY || (this.perIp.get(ip) || 0) >= PER_IP) return refuse(socket, 503);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#session(ws, account, character, ip));
  }

  #remember(key, message) {
    const now = Date.now();
    for (const [k, v] of this.resumes) if (v.expires <= now) this.resumes.delete(k);
    this.resumes.delete(key);
    while (this.resumes.size >= MAX_RESUMES) this.resumes.delete(this.resumes.keys().next().value);
    this.resumes.set(key, { client_id: message.client_id, resume_token: message.resume_token, expires: now + RESUME_TTL_MS });
  }

  #session(browser, account, character, ip) {
    const old = this.sessions.get(character.id);
    if (old) old.stop(4001, 'Replaced by a new connection');
    const key = `${account.id}:${character.id}`;
    const s = { accountId: account.id, characterId: character.id, name: onlineName(character), profiled: false, closed: false, stop: () => {} };
    this.sessions.set(character.id, s);
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    const pending = [];
    let helloSeen = false;
    let browserAlive = true;
    const upstream = new WebSocket(this.upstream, { handshakeTimeout: 5000, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, followRedirects: false });
    const helloTimer = setTimeout(() => s.stop(4008, 'Join timeout'), HELLO_TIMEOUT_MS);
    const ping = setInterval(() => {
      if (!browserAlive) return s.stop(4008, 'Connection lost');
      browserAlive = false;
      try { browser.ping(); } catch { s.stop(1011, 'Connection lost'); }
    }, PING_MS);
    helloTimer.unref?.();
    ping.unref?.();

    s.stop = (code = 1000, reason = '') => {
      if (s.closed) return;
      s.closed = true;
      s.profiled = false;
      clearTimeout(helloTimer);
      clearInterval(ping);
      if (this.sessions.get(character.id) === s) this.sessions.delete(character.id);
      const n = (this.perIp.get(ip) || 1) - 1;
      if (n > 0) this.perIp.set(ip, n); else this.perIp.delete(ip);
      pending.length = 0;
      closeSocket(browser, code, reason);
      closeSocket(upstream, 1000, '');
    };

    const forward = (target, text) => {
      if (s.closed || target.readyState !== WebSocket.OPEN) return;
      if (target.bufferedAmount > BUFFER_LIMIT) return s.stop(1013, 'Connection too slow');
      target.send(text, (err) => { if (err) s.stop(1011, 'Send failed'); });
    };

    upstream.on('open', () => {
      if (s.closed) return closeSocket(upstream);
      for (const text of pending.splice(0)) forward(upstream, text);
    });
    upstream.on('message', (data, binary) => {
      if (s.closed) return;
      if (binary) return s.stop(1003, 'Unsupported data');
      const text = data.toString('utf8');
      if (!s.profiled) {
        let message = null;
        try { message = JSON.parse(text); } catch { /* forwarded as is */ }
        if (message && message.type === 'error' && RESUME_ERRORS.has(message.code)) this.resumes.delete(key);
        if (message && message.type === 'profile' && typeof message.client_id === 'string' && message.client_id.length <= 128) {
          s.profiled = true;
          if (typeof message.resume_token === 'string' && message.resume_token.length > 0 && message.resume_token.length <= 512) this.#remember(key, message);
          this.log(`online joined (${this.sessions.size}/${ONLINE_CAPACITY})`);
        }
      }
      forward(browser, text);
    });
    upstream.on('close', (code, reason) => s.stop(code, Buffer.isBuffer(reason) ? reason.toString('utf8') : ''));
    upstream.on('error', () => s.stop(1011, 'Shared world unavailable'));
    upstream.on('unexpected-response', (_request, response) => { response.resume(); s.stop(1011, 'Shared world unavailable'); });

    browser.on('pong', () => { browserAlive = true; });
    browser.on('close', () => s.stop());
    browser.on('error', () => s.stop());
    browser.on('message', (data, binary) => {
      if (s.closed) return;
      if (binary) return s.stop(1003, 'Unsupported data');
      browserAlive = true;
      let text = data.toString('utf8');
      if (!helloSeen || text.includes('"hello"')) {
        let message;
        try { message = JSON.parse(text); } catch { return s.stop(1007, 'Invalid message'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return s.stop(1007, 'Invalid message');
        if (message.type === 'hello') {
          message.name = s.name;
          delete message.client_id;
          delete message.resume_token;
          if (!helloSeen) {
            helloSeen = true;
            clearTimeout(helloTimer);
            const saved = this.resumes.get(key);
            if (saved && saved.expires > Date.now()) {
              message.client_id = saved.client_id;
              message.resume_token = saved.resume_token;
            } else this.resumes.delete(key);
          }
          text = JSON.stringify(message);
        }
      }
      if (upstream.readyState === WebSocket.OPEN) return forward(upstream, text);
      if (upstream.readyState !== WebSocket.CONNECTING || pending.length >= PREOPEN_LIMIT) return s.stop(1013, 'Shared world unavailable');
      pending.push(text);
    });
  }
}
