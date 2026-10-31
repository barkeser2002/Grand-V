// Application shell: HTTP server, routing, origin allowlist, relay attachment, sweep timer.
import fs from 'node:fs';
import http from 'node:http';
import { validateAssetRoot } from './assets.js';
import { LobbyStore } from './lobbies.js';
import { RateLimiter } from './ratelimit.js';
import { handleApi } from './api.js';
import { handleServersApi } from './server-api.js';
import { CharacterStore } from './characters.js';
import { handleAccountApi } from './character-api.js';
import { ServerRegistry, loadServersConfig, parseServersConfig, SERVERS_CONFIG_FILE } from './server-registry.js';
import { loadResource, ResourceRuntime, serveResourceFile, RESOURCES_DIR } from './resources.js';
import { handleBatch } from './batch.js';
import { handleLog } from './logsink.js';
import { serveLauncher } from './launcher-page.js';
import { serveGamePage, GAME_PAGES } from './game-page.js';
import { serveLoader, LOADER_PATH } from './loader-page.js';
import { serveStatic } from './static.js';
import { loadPublicAssets } from './public.js';
import { SECURITY_HEADERS, HttpError, sendError, sendJson } from './http-util.js';
import { Relay } from './relay.js';
import { createOnline, isOnlinePath } from './online.js';
import { OnlineRelay } from './online-relay.js';
import { BUILD, PROTOCOL, CAPACITY, HZ } from './constants.js';

export const DEFAULT_LIMITS = Object.freeze({
  create: { limit: 30, windowMs: 60 * 60 * 1000 },
  join: { limit: 256, windowMs: 60 * 1000 },
  read: { limit: 240, windowMs: 60 * 1000 },
  batch: { limit: 240, windowMs: 60 * 1000 },
  log: { limit: 60, windowMs: 60 * 1000 },
  voice: { limit: 256, windowMs: 60 * 1000 },
  ice: { limit: 256, windowMs: 60 * 1000 },
  auth: { limit: 30, windowMs: 15 * 60 * 1000 },
  bank: { limit: 60, windowMs: 60 * 1000 },
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function createApp(options = {}) {
  const { root: assetRoot } = validateAssetRoot(options.assetRoot);
  const rootReal = fs.realpathSync(assetRoot);
  const host = options.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`Listener must be loopback; got ${host}`);
  const port = options.port ?? 8097;
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  const trustProxy = options.trustProxy === true;
  const publicAssets = loadPublicAssets(options.publicDir);
  // Operator config and trusted resources are loaded (and validated) here, before any listener.
  const serverEntries = options.serversConfig !== undefined
    ? parseServersConfig(options.serversConfig)
    : loadServersConfig(options.serversConfigPath || SERVERS_CONFIG_FILE);
  const resourcesDir = options.resourcesDir || RESOURCES_DIR;
  const resources = new Map();
  for (const entry of serverEntries) {
    for (const name of entry.resources) if (!resources.has(name)) resources.set(name, loadResource(resourcesDir, name));
  }

  const store = new LobbyStore({
    now,
    pendingTtlMs: options.pendingTtlMs,
    reconnectTtlMs: options.reconnectTtlMs,
    maxLobbyAgeMs: options.maxLobbyAgeMs,
    maxLobbies: options.maxLobbies,
  });

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch(() => {});
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const relay = new Relay({
    store,
    now,
    allowedOrigins: () => allowedOrigins(),
    clientIp: (req) => clientIp(req),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    helloTimeoutMs: options.helloTimeoutMs,
    maxSockets: options.maxSockets,
    maxSocketsPerIp: options.maxSocketsPerIp,
    log,
    onlineUpgrade: (req, socket, head) => onlineRelay?.upgrade(req, socket, head),
    onlineEnabled: options.online === true,
  });
  relay.attach(server);

  const runtime = new ResourceRuntime({ resources: [...resources.values()], log });
  const registry = new ServerRegistry({
    servers: serverEntries,
    store,
    resources,
    onEvent: (name, payload) => runtime.emit(name, payload),
  });

  // Accounts, characters and money. File-backed in production (CHARACTERS_FILE), in memory otherwise.
  const characters = options.characters || new CharacterStore({ file: options.charactersFile || null, now, ...(options.characterOptions || {}) });
  const paycheckIntervalMs = options.paycheckIntervalMs ?? 10 * 60 * 1000;

  const ctx = {
    store,
    characters,
    secureCookies: typeof options.publicOrigin === 'string' && options.publicOrigin.startsWith('https:'),
    now,
    limiter: new RateLimiter({ now }),
    rateLimits: { ...DEFAULT_LIMITS, ...(options.rateLimits || {}) },
    rootReal,
    publicAssets,
    registry,
    resources,
    clientIp,
    allowedOrigins,
    log,
  };

  const onlineRelay = options.online === true ? new OnlineRelay(ctx, options) : null;
  const online = onlineRelay ? createOnline(ctx, options, onlineRelay) : null;
  ctx.onlineRelay = onlineRelay;
  ctx.online = online;
  ctx.activeProfiles = () => [...store.activeProfiles(), ...(onlineRelay?.activeProfiles() || [])];

  let sweepTimer = null;
  let paycheckTimer = null;

  // FiveM-style paycheck: every interval, each character connected through the relay is paid.
  function paychecks() {
    const seen = new Set();
    for (const profile of ctx.activeProfiles()) {
      if (!profile.characterId || seen.has(profile.characterId)) continue;
      seen.add(profile.characterId);
      characters.pay(profile.characterId, characters.salaryOf(profile.characterId), 'Maaş');
    }
    return seen.size;
  }

  function clientIp(req) {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '');
      const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function allowedOrigins() {
    const addr = server.address();
    const bound = addr && typeof addr === 'object' ? addr.port : port;
    const list = [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`];
    if (options.publicOrigin) list.push(options.publicOrigin);
    for (const o of options.allowedOrigins || []) list.push(o);
    return list;
  }

  async function route(req, res, rawPath) {
    const method = req.method;
    const readOnly = method === 'GET' || method === 'HEAD';
    if (online && isOnlinePath(rawPath)) return online.route(req, res, rawPath);
    if (rawPath === '/api/servers' || rawPath.startsWith('/api/servers/')) return handleServersApi(ctx, req, res, rawPath);
    if (rawPath.startsWith('/api/account/')) return handleAccountApi(ctx, req, res, rawPath);
    if (rawPath === '/api' || rawPath.startsWith('/api/')) return handleApi(ctx, req, res, rawPath);
    if (rawPath.startsWith('/__resources/')) return serveResourceFile(ctx, req, res, rawPath);
    if (rawPath === '/relay') return sendError(res, 426, 'WebSocket required', { Upgrade: 'websocket' });
    if (rawPath === '/data/batch' && method === 'POST') return handleBatch(ctx, req, res);
    if (rawPath === '/log' && method === 'POST') return handleLog(ctx, req, res);
    if (rawPath === '/__hostinfo' && readOnly) {
      return sendJson(res, 200, {
        build: BUILD,
        protocol: PROTOCOL,
        relay: '/relay',
        hz: HZ,
        capacity: CAPACITY,
        multiplayer: true,
      });
    }
    const asset = publicAssets.get(rawPath);
    if (asset && readOnly) {
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-cache' });
      return res.end(method === 'HEAD' ? undefined : asset.body);
    }
    if (rawPath === '/launcher.html') return serveLauncher(ctx, req, res);
    if (GAME_PAGES.has(rawPath)) return serveGamePage(ctx, req, res, rawPath);
    if (LOADER_PATH.test(rawPath)) return serveLoader(ctx, req, res, rawPath);
    if (rawPath === '/userdata' || rawPath.startsWith('/userdata/')) return sendError(res, 404, 'Bulunamadı.');
    return serveStatic(ctx, req, res, rawPath);
  }

  async function dispatch(req, res) {
    const started = now();
    const rawPath = (req.url || '/').split('?')[0];
    res.on('finish', () => {
      log(`${req.method} ${rawPath} ${res.statusCode} ${now() - started}ms`);
    });
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    try {
      await route(req, res, rawPath);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendError(res, err.status, err.message, err.headers);
        else res.end();
      } else {
        log(`error ${rawPath} ${err && err.name}`);
        if (!res.headersSent) sendError(res, 500, 'Sunucu hatası.');
        else res.end();
      }
    }
  }

  function sweep() {
    const { peers } = store.sweep();
    for (const peer of peers) peer.close(1000, 'Lobby expired');
  }

  return {
    store,
    characters,
    paychecks,
    server,
    relay,
    online,
    onlineRelay,
    registry,
    runtime,
    async listen() {
      await runtime.start();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          sweepTimer = setInterval(sweep, options.sweepIntervalMs ?? 5_000);
          sweepTimer.unref();
          if (paycheckIntervalMs > 0) {
            paycheckTimer = setInterval(paychecks, paycheckIntervalMs);
            paycheckTimer.unref();
          }
          resolve({ port: server.address().port, host });
        });
      });
    },
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      if (paycheckTimer) clearInterval(paycheckTimer);
      paycheckTimer = null;
      characters.flush();
      relay.closeAll();
      onlineRelay?.closeAll();
      await runtime.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
