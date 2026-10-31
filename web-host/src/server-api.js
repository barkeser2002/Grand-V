// /api/servers routes (dedicated named servers). Dispatched by app.js before the legacy
// /api/lobbies routes. No create endpoint exists: servers come only from config/servers.json.
import { sendJson, sendError, readBody, HttpError } from './http-util.js';
import { parseJoin } from './validate.js';
import { LobbyError } from './lobbies.js';
import { publicManifest } from './resources.js';
import { accountFromRequest } from './character-api.js';
import { AccountError } from './characters.js';
import { ONLINE_SERVER_ID } from './online.js';

const BODY_LIMIT = 4096;
const JSON_TYPE = /^application\/json(\s*;.*)?$/i;
const SERVER_PATH = /^\/api\/servers(?:\/([a-z0-9][a-z0-9-]{1,39})(?:\/(join|resources|players))?)?$/;

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

async function readJsonBody(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Gövde application/json olmalı.');
  const text = (await readBody(req, BODY_LIMIT)).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
}

function asHttp(err) {
  if (err instanceof LobbyError) return new HttpError(err.status, err.message);
  return err;
}

export async function handleServersApi(ctx, req, res, rawPath) {
  const method = req.method;
  const m = SERVER_PATH.exec(rawPath);
  if (!m) return sendError(res, 404, 'Bulunamadı.');
  const [, id, action] = m;
  if (!id) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD' });
    limitOrFail(ctx, req, 'read');
    const servers = ctx.registry.list();
    if (ctx.online) servers.unshift(ctx.online.listing());
    return sendJson(res, 200, { servers, generatedAt: new Date(ctx.now()).toISOString() });
  }
  // The shared world (AliYa server) is entered from the character screen via /api/online/join.
  if (ctx.online && id === ONLINE_SERVER_ID) {
    if (action === 'join') return sendError(res, 409, 'Ortak dünyaya karakter ekranından girilir.');
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD' });
    limitOrFail(ctx, req, 'read');
    if (action === 'players') return sendJson(res, 200, { server: id, players: ctx.online.players(), generatedAt: new Date(ctx.now()).toISOString() });
    if (action === 'resources') return sendJson(res, 200, { server: id, resources: [] });
    return sendError(res, 404, 'Bulunamadı.');
  }
  if (!ctx.registry.has(id)) return sendError(res, 404, 'Bulunamadı.');
  if (action === 'resources') {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD' });
    limitOrFail(ctx, req, 'read');
    const resources = ctx.registry.resourcesFor(id);
    return sendJson(res, 200, { server: id, resources: resources.map((r) => publicManifest(id, r)) });
  }
  if (action === 'players') {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD' });
    limitOrFail(ctx, req, 'read');
    return sendJson(res, 200, { server: id, players: ctx.registry.players(id), generatedAt: new Date(ctx.now()).toISOString() });
  }
  if (action === 'join') {
    if (method !== 'POST') return sendError(res, 405, 'İzin verilmeyen yöntem.', { Allow: 'POST' });
    checkOrigin(ctx, req);
    limitOrFail(ctx, req, 'join');
    const input = parseJoin(await readJsonBody(req));
    let nickname = input.nickname;
    let profile = null;
    let character = null;
    if (input.characterId) {
      // Character join: the session cookie must own the character; its name is the in-game name.
      const acc = ctx.characters ? accountFromRequest(ctx, req) : null;
      if (!acc) throw new HttpError(401, 'Giriş yapın.');
      try {
        character = ctx.characters.getCharacter(acc.id, input.characterId);
      } catch (err) {
        if (err instanceof AccountError) throw new HttpError(err.status, err.message);
        throw err;
      }
      if (ctx.store.dropProfile(character.id).active) throw new HttpError(409, 'Bu karakter zaten oyunda.');
      nickname = character.fullName.slice(0, 40);
      profile = { characterId: character.id, name: character.fullName };
    }
    let handoff;
    try {
      handoff = ctx.registry.join(id, nickname, profile);
    } catch (err) {
      throw asHttp(err);
    }
    if (character) handoff.character = { id: character.id, name: character.fullName };
    return sendJson(res, 200, handoff);
  }
  return sendError(res, 404, 'Bulunamadı.');
}
