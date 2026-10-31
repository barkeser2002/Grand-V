// REST-HMAC credentials for public primary and optional own-coturn backup, issued only
// to authorised lobby sessions. Groups stay separate; no shared secret is returned or logged.
// Without a complete provider configuration the response remains direct mode.
import { createHmac, randomBytes } from 'node:crypto';

export const ICE_TTL_SEC = 600;
// No STUN defaults: only explicitly configured TURN URLs are offered.
const TURN_URL_RE = /^turns?:[A-Za-z0-9.-]+:\d{1,5}(\?transport=(udp|tcp|tls))?$/;

// Parses TURN_URLS (comma separated). Anything malformed is dropped and only counted, so a
// bad entry can never leak its text into a response or log line.
export function loadIceConfig(env = process.env) {
  const raw = typeof env.TURN_URLS === 'string' ? env.TURN_URLS : '';
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const urls = entries.filter((u) => TURN_URL_RE.test(u));
  const secret = typeof env.TURN_SECRET === 'string' ? env.TURN_SECRET.trim() : '';
  const publicEntries = (typeof env.PUBLIC_TURN_URLS === 'string' ? env.PUBLIC_TURN_URLS : '').split(',').map((s) => s.trim()).filter(Boolean);
  const publicTurn = {
    urls: publicEntries.filter((u) => TURN_URL_RE.test(u)),
    secret: typeof env.PUBLIC_TURN_SECRET === 'string' ? env.PUBLIC_TURN_SECRET.trim() : '',
  };
  return { urls, secret: secret || null, dropped: entries.length - urls.length, publicTurn };
}

// coturn REST scheme: username = "<expiry unix seconds>:<random>", credential = base64(HMAC-SHA1).
export function issueIceCredentials(config, { nowMs = Date.now(), random = () => randomBytes(8).toString('hex') } = {}) {
  if (config?.publicTurn?.secret && config.publicTurn.urls?.length) {
    const primary = issueIceCredentials(config.publicTurn, { nowMs, random });
    const backup = issueIceCredentials({ urls: config.urls, secret: config.secret }, { nowMs, random });
    return { ...primary, provider: 'public', fallbackIceServers: backup.iceServers };
  }
  if (!config || !config.secret || !config.urls || config.urls.length === 0) {
    return { iceServers: [], mode: 'direct' };
  }
  const expiresSec = Math.floor(nowMs / 1000) + ICE_TTL_SEC;
  const username = `${expiresSec}:${random()}`;
  const credential = createHmac('sha1', config.secret).update(username, 'utf8').digest('base64');
  return {
    iceServers: [{ urls: config.urls.slice(), username, credential }],
    expiresAt: new Date(expiresSec * 1000).toISOString(),
    mode: 'turn',
  };
}

const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CREDENTIAL_RE = /^[\x21-\x7e]{4,128}$/;

// Strict body for POST /api/voice/ice: exactly {room, credential}.
export function parseVoiceIce(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Gövde bir JSON nesnesi olmalı.' };
  for (const key of Object.keys(raw)) {
    if (key !== 'room' && key !== 'credential') return { error: `Bilinmeyen alan: ${key}` };
  }
  if (typeof raw.room !== 'string' || !ROOM_RE.test(raw.room)) return { error: 'Geçersiz lobi kimliği.' };
  if (typeof raw.credential !== 'string' || !CREDENTIAL_RE.test(raw.credential)) {
    return { error: 'Geçersiz oturum anahtarı.' };
  }
  return { room: raw.room, credential: raw.credential };
}
