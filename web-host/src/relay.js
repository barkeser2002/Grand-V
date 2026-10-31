// /relay WebSocket endpoint. Protocol and close reasons follow LauncherApp/rust/src/relay.rs:
// check/join hello with protocol 1, key/room/build/map validation, welcome/joined/pose/left,
// 30-token rate bucket refilled at 25/s, duplicate-sequence suppression, heartbeat
// pings every interval, and a 2048-byte message ceiling. Room state lives in LobbyStore,
// so capacity and reservations are decided in the same synchronous step as the join.
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { PROTOCOL, HZ, CAPACITY, SUPPORTED_MAPS } from './constants.js';

const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const BUILD_RE = /^[A-Za-z0-9._-]{1,96}$/;
const KEY_MAX = 128;
const RATE_BURST = 30;
const RATE_PER_SEC = 25;
const SEQ_MAX = 2147483647;
const MODEL_MAX = 4294967295;
const POSITION_LIMIT = 20000;
const ROTATION_LIMIT = 360;
const OUTBOUND_LIMIT = 1 << 20;
// Voice signalling rides the same authenticated socket but has its own frame ceiling and its
// own token bucket, so a signalling burst never spends pose budget (and never closes the socket).
const POSE_FRAME_MAX = 2048;
const VOICE_FRAME_MAX = 32768;
const VOICE_RATE_BURST = 40;
const VOICE_RATE_PER_SEC = 20;
const VOICE_SDP_MAX = 16384;
const VOICE_CANDIDATE_MAX = 1024;
const PEER_ID_RE = /^[0-9a-f]{16}$/;
const PRINTABLE_RE = /^[\r\n\x20-\x7e]*$/;
const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };

const vec = (a, limit) =>
  Array.isArray(a) &&
  a.length === 3 &&
  a.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit);

const hasOnly = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const printable = (s, max) => typeof s === 'string' && s.length <= max && PRINTABLE_RE.test(s);

// Strict validation of a voice-signal frame. Only the three signal kinds pass, unknown fields
// are refused (so a client-supplied `from` is a spoof attempt and is rejected), and values are
// copied. The sender id is never read from the frame; the relay adds it when forwarding.
export function validateVoiceSignal(v) {
  if (!isPlainObject(v) || v.type !== 'voice-signal' || !hasOnly(v, ['type', 'target', 'signal'])) {
    throw new Error('Invalid voice signal');
  }
  if (typeof v.target !== 'string' || !PEER_ID_RE.test(v.target)) throw new Error('Invalid voice signal');
  const s = v.signal;
  if (!isPlainObject(s)) throw new Error('Invalid voice signal');
  if (s.type === 'offer' || s.type === 'answer') {
    if (!hasOnly(s, ['type', 'sdp'])) throw new Error('Invalid voice signal');
    if (!printable(s.sdp, VOICE_SDP_MAX) || s.sdp.length === 0 || !s.sdp.startsWith('v=0')) {
      throw new Error('Invalid SDP');
    }
    return { target: v.target, signal: { type: s.type, sdp: s.sdp } };
  }
  if (s.type === 'ice') {
    if (!hasOnly(s, ['type', 'candidate', 'sdpMid', 'sdpMLineIndex'])) throw new Error('Invalid voice signal');
    if (typeof s.candidate !== 'string' || !s.candidate.startsWith('candidate:')) throw new Error('Invalid candidate');
    if (!printable(s.candidate, VOICE_CANDIDATE_MAX) || s.candidate.includes('\n') || s.candidate.includes('\r')) {
      throw new Error('Invalid candidate');
    }
    const out = { type: 'ice', candidate: s.candidate };
    if (s.sdpMid !== undefined && s.sdpMid !== null) {
      if (typeof s.sdpMid !== 'string' || s.sdpMid.length > 32 || !/^[\x21-\x7e]*$/.test(s.sdpMid)) {
        throw new Error('Invalid candidate');
      }
      out.sdpMid = s.sdpMid;
    }
    if (s.sdpMLineIndex !== undefined && s.sdpMLineIndex !== null) {
      if (!Number.isInteger(s.sdpMLineIndex) || s.sdpMLineIndex < 0 || s.sdpMLineIndex > 7) {
        throw new Error('Invalid candidate');
      }
      out.sdpMLineIndex = s.sdpMLineIndex;
    }
    return { target: v.target, signal: out };
  }
  throw new Error('Invalid voice signal');
}

// Mirrors relay.rs `snapshot`: only well-formed pose frames pass; values are copied.
export function validatePose(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v.type !== 'pose') {
    throw new Error('Unsupported message');
  }
  if (!Number.isSafeInteger(v.seq) || v.seq < 0 || v.seq > SEQ_MAX) throw new Error('Invalid sequence');
  if (!Number.isSafeInteger(v.model) || v.model < 0 || v.model > MODEL_MAX) throw new Error('Invalid model');
  if (!vec(v.position, POSITION_LIMIT)) throw new Error('Invalid position');
  if (!vec(v.rotation, ROTATION_LIMIT)) throw new Error('Invalid rotation');
  return { seq: v.seq, model: v.model, position: v.position.slice(), rotation: v.rotation.slice() };
}

function refuse(socket, status, message) {
  const body = Buffer.from(message, 'utf8');
  const head =
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(head, 'utf8'), body]));
}

export const DEFAULT_MAX_SOCKETS = 512;

// Public display name of a seat: the character name, else the join nickname. Text only.
function displayName(seat) {
  const raw = (seat.profile && seat.profile.name) || seat.nickname || '';
  return String(raw).replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
}
export const DEFAULT_MAX_PER_IP = 128;

export class Relay {
  constructor({
    store,
    now = Date.now,
    allowedOrigins,
    clientIp = (req) => req.socket.remoteAddress || 'unknown',
    heartbeatIntervalMs = 20_000,
    helloTimeoutMs = 5_000,
    maxSockets = DEFAULT_MAX_SOCKETS,
    maxSocketsPerIp = DEFAULT_MAX_PER_IP,
    log = () => {},
    onlineEnabled = false,
    onlineUpgrade = null,
  }) {
    this.store = store;
    this.now = now;
    this.allowedOrigins = allowedOrigins;
    this.clientIp = clientIp;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.helloTimeoutMs = helloTimeoutMs;
    this.maxSockets = maxSockets;
    this.maxSocketsPerIp = maxSocketsPerIp;
    this.log = log;
    this.onlineEnabled = onlineEnabled === true;
    this.onlineUpgrade = onlineUpgrade;
    this.live = new Set();
    this.closing = new WeakSet();
    this.perIp = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_FRAME_MAX, perMessageDeflate: false });
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
  }

  // Terminates every live relay socket (shutdown).
  closeAll() {
    for (const ws of this.live) ws.terminate();
  }

  #upgrade(req, socket, head) {
    const rawUrl = req.url || '';
    if (rawUrl.split('?')[0] === '/mp/ws' && this.onlineEnabled && this.onlineUpgrade) {
      return this.onlineUpgrade(req, socket, head);
    }
    if (rawUrl.split('?')[0] !== '/relay') return refuse(socket, 404, 'Not found');
    if (rawUrl.includes('?')) return refuse(socket, 400, 'Invalid relay URL');
    const origin = req.headers.origin;
    if (!origin || !this.allowedOrigins().includes(origin)) {
      return refuse(socket, 403, 'WebSocket origin does not match game website');
    }
    const ip = this.clientIp(req);
    if (this.live.size >= this.maxSockets || (this.perIp.get(ip) || 0) >= this.maxSocketsPerIp) {
      return refuse(socket, 503, 'Server full');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#session(ws, ip));
  }

  #session(ws, ip) {
    this.live.add(ws);
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    let heartbeat = null;
    let session = null;
    const helloTimer = setTimeout(() => this.#close(ws, 1008, 'Invalid or incomplete request'), this.helloTimeoutMs);

    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (heartbeat) clearInterval(heartbeat);
      this.live.delete(ws);
      const n = (this.perIp.get(ip) || 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
      if (session) this.#leave(session);
    });

    ws.once('message', (data, isBinary) => {
      clearTimeout(helloTimer);
      const hello = isBinary ? undefined : parseJson(data);
      if (hello === undefined) return this.#close(ws, 1008, 'Invalid or incomplete request');
      const verdict = this.#admit(hello);
      if (verdict.error) {
        this.log(`relay rejected: ${verdict.error}`);
        return this.#close(ws, 1008, verdict.error);
      }
      if (verdict.checkOnly) {
        const players = verdict.lobby.seats.filter((s) => s && s.state === 'active').length;
        ws.send(JSON.stringify({ type: 'checked', players, capacity: verdict.lobby.capacity || CAPACITY }));
        return this.#close(ws, 1000, 'Check complete');
      }

      const peer = this.#peer(ws);
      try {
        this.store.claim(verdict.room, verdict.key, peer);
      } catch (err) {
        return this.#close(ws, 1008, err.message);
      }
      const seat = verdict.lobby.seats.find((s) => s && s.peer === peer);
      peer.name = seat ? displayName(seat) : '';
      const others = verdict.lobby.seats
        .filter((s) => s && s.state === 'active' && s.peer && s.peer !== peer)
        .map((s) => s.peer);
      const names = {};
      for (const p of others) if (p.name) names[p.id] = p.name;
      peer.send({ type: 'welcome', protocol: PROTOCOL, id: peer.id, peers: others.map((p) => p.id), names, hz: HZ });
      for (const other of others) {
        if (other.lastPose) {
          peer.send({ type: 'pose', id: other.id, ...other.lastPose });
        }
        other.send(peer.name ? { type: 'joined', id: peer.id, name: peer.name } : { type: 'joined', id: peer.id });
      }
      this.log(`relay joined room ${verdict.room} (${others.length + 1}/${verdict.lobby.capacity || CAPACITY})`);

      session = {
        peer,
        room: verdict.room,
        lobby: verdict.lobby,
        lastSeq: null,
        tokens: RATE_BURST,
        last: this.now(),
        voiceTokens: VOICE_RATE_BURST,
        voiceLast: this.now(),
      };
      ws.on('message', (payload, binary) => this.#onMessage(ws, session, payload, binary));
      let awaitingPong = false;
      ws.on('pong', () => {
        awaitingPong = false;
      });
      heartbeat = setInterval(() => {
        if (awaitingPong) return this.#close(ws, 1008, 'Heartbeat timeout');
        awaitingPong = true;
        try {
          ws.ping();
        } catch (_) {
          /* socket already gone; close handler cleans up */
        }
      }, this.heartbeatIntervalMs);
    });
  }

  // Validates the hello frame exactly in the order relay.rs uses.
  #admit(hello) {
    if (hello === null || typeof hello !== 'object' || Array.isArray(hello)) {
      return { error: 'Protocol mismatch' };
    }
    const checkOnly = hello.type === 'check';
    if (!(checkOnly || hello.type === 'join') || hello.protocol !== PROTOCOL) {
      return { error: 'Protocol mismatch' };
    }
    const key = typeof hello.key === 'string' ? hello.key.trim() : '';
    if (!key || key.length > KEY_MAX) return { error: 'Join key rejected' };
    if (typeof hello.room !== 'string' || !ROOM_RE.test(hello.room)) return { error: 'Invalid room' };
    if (
      typeof hello.build !== 'string' ||
      !BUILD_RE.test(hello.build) ||
      typeof hello.map !== 'string' ||
      !SUPPORTED_MAPS.includes(hello.map)
    ) {
      return { error: 'Invalid build/map' };
    }
    // check refreshes an unclaimed reservation; it never consumes it.
    const hit = this.store.authenticate(hello.room, key, { touch: checkOnly });
    if (!hit) return { error: 'Join key rejected' };
    if (hit.lobby.build !== hello.build || hit.lobby.map !== hello.map) {
      return { error: 'Room build/map mismatch' };
    }
    return { checkOnly, room: hello.room, key, lobby: hit.lobby };
  }

  #peer(ws) {
    const id = randomBytes(8).toString('hex');
    return {
      id,
      lastPose: null,
      send: (obj) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > OUTBOUND_LIMIT) return this.#close(ws, 1013, 'Receiver stalled');
        ws.send(JSON.stringify(obj));
      },
      close: (code, reason) => this.#close(ws, code, reason),
    };
  }

  #onMessage(ws, session, data, isBinary) {
    if (isBinary) return this.#close(ws, 1008, 'Unsupported message');
    const parsed = parseJson(data);
    if (parsed === undefined) return this.#close(ws, 1008, 'Invalid JSON');
    if (parsed !== null && typeof parsed === 'object' && parsed.type === 'voice-signal') {
      return this.#onVoice(ws, session, parsed);
    }
    if (data.length > POSE_FRAME_MAX) return this.#close(ws, 1008, 'Message too large');

    const now = this.now();
    session.tokens = Math.min(RATE_BURST, session.tokens + ((now - session.last) / 1000) * RATE_PER_SEC);
    session.last = now;
    if (session.tokens < 1) return this.#close(ws, 1008, 'Message rate exceeded');
    session.tokens -= 1;

    let pose;
    try {
      pose = validatePose(parsed);
    } catch (err) {
      return this.#close(ws, 1008, err.message);
    }
    if (session.lastSeq !== null && pose.seq <= session.lastSeq) return;
    session.lastSeq = pose.seq;
    if (this.store.getLobby(session.room) !== session.lobby) return;
    session.peer.lastPose = {
      seq: pose.seq,
      model: pose.model,
      position: pose.position,
      rotation: pose.rotation,
    };

    const out = {
      type: 'pose',
      seq: pose.seq,
      model: pose.model,
      position: pose.position,
      rotation: pose.rotation,
      id: session.peer.id,
    };
    for (const seat of session.lobby.seats) {
      if (seat && seat.state === 'active' && seat.peer && seat.peer !== session.peer) seat.peer.send(out);
    }
  }

  // Voice signalling: its own bucket. Over-budget signals are dropped silently so a burst can
  // never disconnect the pose stream; malformed signals close the socket like malformed poses.
  // Signals only reach an active seat of the same lobby; anything else (self, unknown or
  // departed peer) is dropped, because a peer can leave while a candidate is in flight.
  #onVoice(ws, session, parsed) {
    const now = this.now();
    session.voiceTokens = Math.min(
      VOICE_RATE_BURST,
      session.voiceTokens + ((now - session.voiceLast) / 1000) * VOICE_RATE_PER_SEC,
    );
    session.voiceLast = now;
    if (session.voiceTokens < 1) return;
    session.voiceTokens -= 1;

    let frame;
    try {
      frame = validateVoiceSignal(parsed);
    } catch (err) {
      return this.#close(ws, 1008, err.message);
    }
    if (this.store.getLobby(session.room) !== session.lobby) return;
    if (frame.target === session.peer.id) return;
    const target = session.lobby.seats.find(
      (s) => s && s.state === 'active' && s.peer && s.peer.id === frame.target,
    );
    if (!target) return;
    target.peer.send({ type: 'voice-signal', from: session.peer.id, signal: frame.signal });
  }

  #leave(session) {
    const info = this.store.detach(session.room, session.peer);
    for (const other of info.remaining) other.send({ type: 'left', id: session.peer.id });
  }

  // Idempotent: a socket is closed once. Floods of over-budget frames reach here repeatedly
  // while the close handshake is in flight, and each call must not add another listener.
  #close(ws, code, reason) {
    if (this.closing.has(ws)) return;
    this.closing.add(ws);
    try {
      ws.close(code, reason);
    } catch (_) {
      /* already closing */
    }
    const kill = setTimeout(() => ws.terminate(), 2000);
    kill.unref();
    ws.once('close', () => clearTimeout(kill));
  }
}

function parseJson(data) {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch (_) {
    return undefined;
  }
}
