// Environment configuration. The listener is loopback-only by design: public exposure
// happens through the parent's reverse proxy, never by binding a public address here.
import path from 'node:path';

export const DEFAULT_ASSET_ROOT = '/var/www/grandv/mirror/playgta5.com';
const LOOPBACK = new Map([
  ['127.0.0.1', '127.0.0.1'],
  ['localhost', '127.0.0.1'],
]);

export function parseOrigin(value, { requireHttps = false } = {}) {
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (requireHttps && u.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be an https origin');
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Invalid origin scheme: ${value}`);
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error(`Invalid origin (no path, query or credentials allowed): ${value}`);
  }
  return u.origin;
}

export function loadConfig(env = process.env) {
  const hostRaw = env.HOST || '127.0.0.1';
  const host = LOOPBACK.get(hostRaw);
  if (!host) throw new Error(`HOST must be loopback (127.0.0.1 or localhost); got ${hostRaw}`);

  const portRaw = env.PORT === undefined || env.PORT === '' ? '8097' : env.PORT;
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
    throw new Error(`PORT must be an integer 1-65535; got ${portRaw}`);
  }

  const assetRoot = path.resolve(env.ASSET_ROOT || DEFAULT_ASSET_ROOT);
  const publicOrigin = env.PUBLIC_ORIGIN ? parseOrigin(env.PUBLIC_ORIGIN, { requireHttps: true }) : '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseOrigin(s));

  const charactersFile = env.CHARACTERS_FILE ? path.resolve(env.CHARACTERS_FILE) : '';
  return { host, port: Number(portRaw), assetRoot, publicOrigin, allowedOrigins, charactersFile,
    online: env.FIVEWEB_ONLINE === '1',
    onlineClientRoot: '/opt/grand-v/online/client',
    onlineRuntimeRoot: '/var/lib/fiveweb-online/runtime',
    onlineUpstream: 'ws://127.0.0.1:8787/ws',
  };
}
