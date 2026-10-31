// /api/* routes: public lobby list, create, join (guest reservation), release.
// Credentials travel only in JSON bodies and responses, never in URLs or logs.
import { sendJson, sendError, readBody, HttpError } from './http-util.js';
import { parseCreate, parseJoin, parseRelease, parseLobbyId } from './validate.js';
import { LobbyError } from './lobbies.js';
import { loadIceConfig, issueIceCredentials, parseVoiceIce } from './voice-ice.js';

const BODY_LIMIT = 4096;
const JSON_TYPE = /^application\/json(\s*;.*)?$/i;

const JOIN_PATH = /^\/api\/lobbies\/([^/]+)\/join$/;
const RELEASE_PATH = /^\/api\/lobbies\/([^/]+)\/release$/;
const VOICE_ICE_PATH = '/api/voice/ice';
const VOICE_ICE_LIMIT = { limit: 256, windowMs: 60 * 1000 };

function requireJson(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Gövde application/json olmalı.');
  }
}

function checkOrigin(ctx, req) {
  const origin = req.headers.origin;
  if (origin !== undefined && !ctx.allowedOrigins().includes(origin)) {
    throw new HttpError(403, 'Bu kaynaktan istek kabul edilmiyor.');
  }
}

function limitOrFail(ctx, req, bucket) {
  const { limit, windowMs } = ctx.rateLimits[bucket];
  const verdict = ctx.limiter.hit(`${bucket}:${ctx.clientIp(req)}`, limit, windowMs);
  if (!verdict.allowed) {
    throw new HttpError(429, 'Çok fazla istek. Biraz bekleyin.', { 'Retry-After': String(verdict.retryAfterSec) });
  }
}

function lobbyError(err) {
  if (err instanceof LobbyError) return new HttpError(err.status, err.message);
  return err;
}

function listLobbies(ctx, req, res) {
  limitOrFail(ctx, req, 'read');
  const lobbies = ctx.store.listOpen().slice(0, 100);
  sendJson(res, 200, { lobbies, generatedAt: new Date(ctx.now()).toISOString() });
}

async function createLobby(ctx, req, res) {
  checkOrigin(ctx, req);
  limitOrFail(ctx, req, 'create');
  const input = parseCreate(await readJsonBody(req));
  let created;
  try {
    created = ctx.store.createLobby(input);
  } catch (err) {
    throw lobbyError(err);
  }
  sendJson(res, 201, {
    lobby: created.lobby,
    session: {
      role: 'host',
      credential: created.credential,
      expiresAt: created.seatExpiresAt,
    },
    launchPath: `/launcher.html?lobby=${created.lobby.id}`,
  });
}

async function readJsonBody(req) {
  requireJson(req);
  const text = (await readBody(req, BODY_LIMIT)).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
}

async function joinLobby(ctx, req, res, id) {
  checkOrigin(ctx, req);
  limitOrFail(ctx, req, 'join');
  parseLobbyId(id);
  const input = parseJoin(await readJsonBody(req));
  let reserved;
  try {
    reserved = ctx.store.reserve(id, input.nickname);
  } catch (err) {
    throw lobbyError(err);
  }
  sendJson(res, 200, {
    lobby: reserved.lobby,
    session: { role: 'guest', credential: reserved.credential, expiresAt: reserved.seatExpiresAt },
    launchPath: `/launcher.html?lobby=${reserved.lobby.id}`,
  });
}

async function releaseLobbySeat(ctx, req, res, id) {
  checkOrigin(ctx, req);
  limitOrFail(ctx, req, 'join');
  parseLobbyId(id);
  const input = parseRelease(await readJsonBody(req));
  const info = ctx.store.release(id, input.credential);
  if (!info.released) throw new HttpError(404, 'Oturum bulunamadı veya süresi doldu.');
  if (info.peer) {
    info.peer.close(1000, 'Released');
    for (const other of info.remaining) other.send({ type: 'left', id: info.peer.id });
  }
  sendJson(res, 200, { released: true });
}

// TURN REST credentials for voice. Origin is required (browsers always send it), the per-client
// bucket is checked before the body is read, and the session must be a live or pending seat of
// the named lobby. The env is read per call and passed as a plain config object.
async function voiceIce(ctx, req, res) {
  const origin = req.headers.origin;
  if (!origin || !ctx.allowedOrigins().includes(origin)) {
    throw new HttpError(403, 'Bu kaynaktan istek kabul edilmiyor.');
  }
  const limit = (ctx.rateLimits && ctx.rateLimits.voice) || VOICE_ICE_LIMIT;
  const verdict = ctx.limiter.hit(`voice:${ctx.clientIp(req)}`, limit.limit, limit.windowMs);
  if (!verdict.allowed) {
    throw new HttpError(429, 'Çok fazla istek. Biraz bekleyin.', { 'Retry-After': String(verdict.retryAfterSec) });
  }
  const input = parseVoiceIce(await readJsonBody(req));
  if (input.error) throw new HttpError(400, input.error);
  const hit = ctx.store.authenticate(input.room, input.credential);
  if (!hit) throw new HttpError(403, 'Oturum doğrulanamadı.');
  const config = loadIceConfig(process.env);
  sendJson(res, 200, issueIceCredentials(config, { nowMs: ctx.now() }));
}

// Dispatches /api/*. Method mismatches answer 405 with Allow; unknown paths 404 JSON.
export async function handleApi(ctx, req, res, rawPath) {
  const method = req.method;
  if (rawPath === VOICE_ICE_PATH) {
    if (method !== 'POST') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'POST' });
    return voiceIce(ctx, req, res);
  }
  if (rawPath === '/api/lobbies') {
    if (method === 'GET' || method === 'HEAD') return listLobbies(ctx, req, res);
    if (method === 'POST') return createLobby(ctx, req, res);
    return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD, POST' });
  }
  let m = JOIN_PATH.exec(rawPath);
  if (m) {
    if (method !== 'POST') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'POST' });
    return joinLobby(ctx, req, res, m[1]);
  }
  m = RELEASE_PATH.exec(rawPath);
  if (m) {
    if (method !== 'POST') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'POST' });
    return releaseLobbySeat(ctx, req, res, m[1]);
  }
  return sendError(res, 404, 'Bulunamadı.');
}
