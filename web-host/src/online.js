// FiveWeb shared world: AliYa browser client (MIT; LICENSE/NOTICE kept in /opt/grand-v/online)
// talking to the loopback Java world server through /mp/ws (src/online-relay.js).
// The AliYa client is served at its own absolute paths (/play/, /multiplayer/*, /i18n.js); none of
// them exist in the game mirror. Only its engine worker moves to /__online/loader.js, because
// /b/<build>/loader.js belongs to the classic game page; the worker takes every other URL from m.base.
// Everything here is off unless FIVEWEB_ONLINE=1.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { accountFromRequest } from './character-api.js';
import { HttpError, readBody, sendJson, sendError } from './http-util.js';
import { parseRelative, realInside, sendFile } from './static.js';

export const ONLINE_SERVER_ID = 'fiveweb-world';
export const ONLINE_CAPACITY = 8;
export const ONLINE_CLIENT_ROOT = '/opt/grand-v/online/client';
export const ONLINE_RUNTIME_ROOT = '/var/lib/fiveweb-online/runtime';
export const ONLINE_UPSTREAM = 'ws://127.0.0.1:8787/ws';
const FONTS = new Set(['gfxfontlib', 'font_lib_efigs', 'font_lib_chinese', 'font_lib_korean', 'font_lib_japanese'].map((n) => `/data/${n}.gfx`));
const CHARACTER_PAGE = `/character.html?server=${ONLINE_SERVER_ID}`;
const HUD_TAG = '<script src="/__grandv/game-hud.js?v=hud-3"></script>';

export function validateOnlineUpstream(value = ONLINE_UPSTREAM) {
  const u = new URL(value);
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      || u.port !== '8787' || u.pathname !== '/ws' || u.username || u.password || u.search || u.hash) {
    throw new Error('Online upstream must be a loopback ws:// address on port 8787 with path /ws');
  }
  return u.href;
}

export function onlineLimit(ctx, req, bucket) {
  const { limit, windowMs } = ctx.rateLimits[bucket];
  const result = ctx.limiter.hit(`online:${bucket}:${ctx.clientIp(req)}`, limit, windowMs);
  if (!result.allowed) throw new HttpError(429, 'Çok fazla istek. Biraz bekleyin.', { 'Retry-After': String(result.retryAfterSec) });
}

export function onlineOrigin(ctx, req) {
  if (typeof req.headers.origin !== 'string' || !ctx.allowedOrigins().includes(req.headers.origin)) {
    throw new HttpError(403, 'Bu kaynaktan istek kabul edilmiyor.');
  }
}

// The session cookie must own the character.
export function onlineCharacter(ctx, req, id) {
  const account = accountFromRequest(ctx, req);
  if (!account) throw new HttpError(401, 'Giriş yapın.');
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'Geçersiz karakter.');
  try {
    return { account, character: ctx.characters.getCharacter(account.id, id) };
  } catch (err) {
    throw new HttpError(err.status || 404, 'Karakter bulunamadı.');
  }
}

// The world server accepts at most 24 characters.
export function onlineName(character) {
  const name = Array.from(String(character.fullName).replace(/[\u0000-\u001f\u007f<>]/g, '').trim()).slice(0, 24).join('').trim();
  return name || 'Oyuncu';
}

function playQuery(origin, character) {
  const ws = new URL('/mp/ws', origin);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.searchParams.set('character', character.id);
  return new URLSearchParams({
    launcher: '1',
    mode: 'online',
    character: character.id,
    name: onlineName(character),
    server: ws.href,
    preset: character.gender === 'f' ? 'freemode_female' : 'freemode_male',
    seed: String(parseInt(character.id.slice(0, 8), 16) >>> 1),
  });
}

async function resolveFile(root, relative) {
  let realRoot;
  try { realRoot = await fs.promises.realpath(root); } catch { return null; }
  const file = await realInside(realRoot, path.join(realRoot, relative));
  if (!file) return null;
  const stat = await fs.promises.stat(file);
  return stat.isFile() ? { file, size: stat.size } : null;
}

function readOnly(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'İzin verilmeyen yöntem.', { Allow: 'GET, HEAD' });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

function sendText(req, res, body, type) {
  const data = Buffer.from(body, 'utf8');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function isOnlinePath(rawPath) {
  return rawPath.startsWith('/api/online/') || rawPath === '/api/remote-config' || rawPath === '/api/language'
    || rawPath === '/play' || rawPath === '/play/' || rawPath === '/__online/loader.js'
    || rawPath === '/__online/LICENSE' || rawPath === '/__online/NOTICE.md'
    || rawPath.startsWith('/multiplayer/') || rawPath === '/i18n.js'
    || rawPath === '/engine/online/game.wasm' || FONTS.has(rawPath) || rawPath === '/mp/ws';
}

export function createOnline(ctx, options, relay) {
  const clientRoot = options.onlineClientRoot || ONLINE_CLIENT_ROOT;
  const runtimeRoot = options.onlineRuntimeRoot || ONLINE_RUNTIME_ROOT;
  const upstream = validateOnlineUpstream(options.onlineUpstream || ONLINE_UPSTREAM);
  const origin = () => options.publicOrigin || ctx.allowedOrigins()[0];
  let health = { at: 0, ok: false, pending: null };

  // World server health (loopback /health), cached for 5 s.
  function refreshHealth() {
    if (health.pending || Date.now() - health.at < 5000) return health.pending || Promise.resolve(health.ok);
    const url = new URL(upstream);
    url.protocol = 'http:';
    url.pathname = '/health';
    health.pending = new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode === 200); });
      request.setTimeout(1500, () => { request.destroy(); resolve(false); });
      request.on('error', () => resolve(false));
    }).then((ok) => { health = { at: Date.now(), ok, pending: null }; return ok; });
    return health.pending;
  }

  // Entry for GET /api/servers (same shape as ServerRegistry.list()).
  function listing() {
    refreshHealth();
    const connected = relay.size;
    return {
      id: ONLINE_SERVER_ID,
      name: 'FiveWeb Ortak Dünya',
      description: 'Beta: oyuncular, NPC\'ler ve araçlar aynı dünyada; silah, hasar, ölüm ve yeniden doğma sunucuda. En fazla 8 oyuncu.',
      connected,
      reserved: 0,
      capacity: ONLINE_CAPACITY,
      status: connected >= ONLINE_CAPACITY || !health.ok ? 'full' : 'online',
      tags: ['ortak dünya', 'pvp', 'npc', 'beta'],
      resources: [],
      voice: false,
      compatibility: 'fiveweb-world-v1',
      kind: 'online',
      ready: health.ok,
    };
  }

  async function route(req, res, rawPath) {
    if (rawPath === '/api/online/status') {
      readOnly(req);
      onlineLimit(ctx, req, 'read');
      const roster = relay.roster();
      return sendJson(res, 200, { enabled: true, capacity: ONLINE_CAPACITY, players: roster.length, playersList: roster, ready: await refreshHealth() });
    }
    if (rawPath === '/api/online/join') {
      if (req.method !== 'POST') throw new HttpError(405, 'İzin verilmeyen yöntem.', { Allow: 'POST' });
      onlineOrigin(ctx, req);
      onlineLimit(ctx, req, 'join');
      if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Gövde application/json olmalı.');
      let body;
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'Geçersiz JSON.');
      }
      const { character } = onlineCharacter(ctx, req, body && body.characterId);
      if (!(await refreshHealth())) throw new HttpError(503, 'Ortak dünya sunucusu şu an kapalı.');
      if (relay.size >= ONLINE_CAPACITY && !relay.has(character.id)) throw new HttpError(409, 'Ortak dünya dolu.');
      return sendJson(res, 200, { launchPath: `/play/?${playQuery(origin(), character)}`, character: { id: character.id, name: character.fullName } });
    }
    if (rawPath === '/api/remote-config') {
      readOnly(req);
      return sendJson(res, 200, { source: 'remote', stale: false, config: { oltitle: 'FiveWeb Ortak Dünya' } });
    }
    if (rawPath === '/api/language') {
      readOnly(req);
      return sendJson(res, 200, { preference: 'system', resolved: null, revision: 1 });
    }
    if (rawPath === '/play' || rawPath === '/play/') {
      readOnly(req);
      onlineLimit(ctx, req, 'read');
      const url = new URL(req.url, 'http://localhost');
      let character;
      try { ({ character } = onlineCharacter(ctx, req, url.searchParams.get('character'))); } catch (_) {
        return redirect(res, CHARACTER_PAGE);
      }
      // Reloads arrive with the launch fields stripped by the client; rebuild them server-side.
      const want = playQuery(origin(), character);
      const exact = [...want].every(([k, v]) => url.searchParams.getAll(k).length === 1 && url.searchParams.get(k) === v);
      if (rawPath === '/play' || !exact) return redirect(res, `/play/?${want}`);
      const found = await resolveFile(clientRoot, 'index.html');
      if (!found) return sendError(res, 503, 'Ortak dünya istemcisi kurulu değil.');
      let html = (await fs.promises.readFile(found.file, 'utf8'))
        .replace(/new Worker\(BASE\s*\+\s*(['"])\/loader\.js\1\)/, "new Worker('/__online/loader.js')");
      // FiveWeb phone/bank HUD (F6) for the selected character.
      const session = JSON.stringify({ serverId: ONLINE_SERVER_ID, characterId: character.id, characterName: character.fullName.slice(0, 40) }).replaceAll('<', '\\u003c');
      const hud = ctx.publicAssets && ctx.publicAssets.has('/__grandv/game-hud.js') ? HUD_TAG : '';
      html = html.replace(/<\/head>/i, `<!-- Shared-world client: AliYa-chen/gtav-web-multiplayer-launcher (MIT), see /__online/LICENSE and /__online/NOTICE.md --><script>try{sessionStorage.setItem('grandv.lobby.session.v1',JSON.stringify(${session}))}catch(e){}</script>${hud}</head>`);
      return sendText(req, res, html, 'text/html; charset=utf-8');
    }
    if (rawPath === '/__online/LICENSE' || rawPath === '/__online/NOTICE.md') {
      readOnly(req);
      const found = await resolveFile(path.dirname(clientRoot), path.basename(rawPath));
      if (!found) return sendError(res, 404, 'Bulunamadı.');
      return sendText(req, res, await fs.promises.readFile(found.file, 'utf8'), 'text/plain; charset=utf-8');
    }
    if (rawPath === '/__online/loader.js' || rawPath === '/i18n.js' || rawPath.startsWith('/multiplayer/')) {
      readOnly(req);
      const relative = rawPath === '/__online/loader.js' ? 'loader.js' : rawPath.slice(1);
      let decoded;
      try { decoded = decodeURIComponent(relative); } catch { return sendError(res, 400, 'Geçersiz yol.'); }
      const parsed = parseRelative(decoded);
      if (parsed.status || !parsed.segments.length || !/\.(?:js|css)$/.test(decoded)) return sendError(res, 404, 'Bulunamadı.');
      const found = await resolveFile(clientRoot, parsed.segments.join('/'));
      if (!found) return sendError(res, 404, 'Bulunamadı.');
      res.setHeader('Cache-Control', 'no-cache');
      return sendFile(req, res, found.file, found.size);
    }
    if (rawPath === '/engine/online/game.wasm' || FONTS.has(rawPath)) {
      readOnly(req);
      const found = await resolveFile(runtimeRoot, FONTS.has(rawPath) ? `fonts/${path.basename(rawPath)}` : 'online/game.wasm');
      if (!found) return sendError(res, 404, 'Bulunamadı.');
      return sendFile(req, res, found.file, found.size);
    }
    if (rawPath === '/mp/ws') return sendError(res, 426, 'WebSocket required', { Upgrade: 'websocket' });
    return sendError(res, 404, 'Bulunamadı.');
  }

  refreshHealth();
  return { route, listing, players: () => relay.roster(), ready: refreshHealth, clientRoot, runtimeRoot, upstream };
}
