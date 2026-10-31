// /api/account routes: register, login, logout, me, characters, bank. Session is an HttpOnly
// cookie; every state-changing request must carry an allowed Origin (CSRF guard).
import { sendJson, sendError, readBody, HttpError } from './http-util.js';
import { AccountError } from './characters.js';

export const COOKIE = 'fw_session';
const BODY_LIMIT = 4096;
const JSON_TYPE = /^application\/json(\s*;.*)?$/i;
const CHAR_PATH = /^\/api\/account\/characters\/([0-9a-f]{16})(?:\/(bank|transactions|job|items|vehicles|houses|contacts|appearance|garage))?$/;
const ID = (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);

export function readCookie(req, name = COOKIE) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieHeader(ctx, req, token, maxAgeSec) {
  const secure = ctx.secureCookies || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

function requireOrigin(ctx, req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !ctx.allowedOrigins().includes(origin)) {
    throw new HttpError(403, 'Bu kaynaktan istek kabul edilmiyor.');
  }
}

function limit(ctx, req, bucket) {
  const { limit: n, windowMs } = ctx.rateLimits[bucket];
  const verdict = ctx.limiter.hit(`${bucket}:${ctx.clientIp(req)}`, n, windowMs);
  if (!verdict.allowed) throw new HttpError(429, 'Çok fazla istek. Biraz bekleyin.', { 'Retry-After': String(verdict.retryAfterSec) });
}

async function body(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Gövde application/json olmalı.');
  let value;
  try {
    value = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Geçersiz JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Gövde bir JSON nesnesi olmalı.');
  return value;
}

export function accountFromRequest(ctx, req) {
  return ctx.characters.accountForToken(readCookie(req));
}

function requireAccount(ctx, req) {
  const acc = accountFromRequest(ctx, req);
  if (!acc) throw new HttpError(401, 'Giriş yapın.');
  return acc;
}

const method = (req, allowed) => {
  if (!allowed.includes(req.method)) throw new HttpError(405, 'İzin verilmeyen yöntem.', { Allow: allowed.join(', ') });
};

export async function handleAccountApi(ctx, req, res, rawPath) {
  try {
    return await route(ctx, req, res, rawPath);
  } catch (err) {
    if (err instanceof AccountError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

async function route(ctx, req, res, rawPath) {
  const store = ctx.characters;
  const ttl = Math.floor(store.opts.sessionTtlMs / 1000);
  if (rawPath === '/api/account/register' || rawPath === '/api/account/login') {
    method(req, ['POST']);
    requireOrigin(ctx, req);
    limit(ctx, req, 'auth');
    const b = await body(req);
    const out = rawPath.endsWith('register') ? store.register(b.username, b.password) : store.login(b.username, b.password);
    return sendJson(res, rawPath.endsWith('register') ? 201 : 200, { account: out.account }, { 'Set-Cookie': cookieHeader(ctx, req, out.token, ttl) });
  }
  if (rawPath === '/api/account/logout') {
    method(req, ['POST']);
    requireOrigin(ctx, req);
    store.logout(readCookie(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(ctx, req, '', 0) });
  }
  if (rawPath === '/api/account/me') {
    method(req, ['GET', 'HEAD']);
    limit(ctx, req, 'read');
    const acc = requireAccount(ctx, req);
    return sendJson(res, 200, { account: store.publicAccount(acc.id) });
  }
  if (rawPath === '/api/account/catalog') {
    method(req, ['GET', 'HEAD']);
    limit(ctx, req, 'read');
    return sendJson(res, 200, store.catalog());
  }
  if (rawPath === '/api/account/characters') {
    method(req, ['POST']);
    requireOrigin(ctx, req);
    limit(ctx, req, 'bank');
    const acc = requireAccount(ctx, req);
    const b = await body(req);
    return sendJson(res, 201, { character: store.createCharacter(acc.id, b) });
  }
  const m = CHAR_PATH.exec(rawPath);
  if (!m) return sendError(res, 404, 'Bulunamadı.');
  const [, id, action] = m;
  if (!action) {
    method(req, ['GET', 'HEAD', 'DELETE']);
    const acc = requireAccount(ctx, req);
    if (req.method === 'DELETE') {
      requireOrigin(ctx, req);
      limit(ctx, req, 'bank');
      const b = await body(req);
      store.deleteCharacter(acc.id, id, b.confirm);
      return sendJson(res, 200, { ok: true });
    }
    limit(ctx, req, 'read');
    return sendJson(res, 200, { character: store.getCharacter(acc.id, id) });
  }
  if (action === 'appearance') {
    method(req, ['GET', 'HEAD', 'POST']);
    const acc = requireAccount(ctx, req);
    if (req.method !== 'POST') {
      limit(ctx, req, 'read');
      return sendJson(res, 200, { appearance: store.getCharacter(acc.id, id).appearance });
    }
    requireOrigin(ctx, req);
    limit(ctx, req, 'bank');
    const b = await body(req);
    return sendJson(res, 200, { character: store.saveAppearance(acc.id, id, b.appearance) });
  }
  if (action === 'garage') {
    method(req, ['POST']);
    requireOrigin(ctx, req);
    limit(ctx, req, 'bank');
    const acc = requireAccount(ctx, req);
    const b = await body(req);
    return sendJson(res, 200, store.garage(acc.id, id, b));
  }
  if (action === 'contacts') {
    method(req, ['GET', 'HEAD']);
    limit(ctx, req, 'read');
    const acc = requireAccount(ctx, req);
    store.getCharacter(acc.id, id);
    return sendJson(res, 200, { contacts: store.directory(ctx.activeProfiles ? ctx.activeProfiles() : ctx.store.activeProfiles(), id) });
  }
  if (action === 'job' || action === 'items' || action === 'vehicles' || action === 'houses') {
    method(req, ['POST']);
    requireOrigin(ctx, req);
    limit(ctx, req, 'bank');
    const acc = requireAccount(ctx, req);
    const b = await body(req);
    let character;
    if (action === 'job') {
      if (!ID(b.jobId)) throw new HttpError(400, 'Meslek bulunamadı.');
      character = store.setJob(acc.id, id, b.jobId);
    } else if (action === 'items') {
      if (!ID(b.itemId)) throw new HttpError(400, 'Ürün bulunamadı.');
      if (b.action === 'buy') character = store.buyItem(acc.id, id, b.itemId, b.qty, b.method);
      else if (b.action === 'drop') character = store.dropItem(acc.id, id, b.itemId, b.qty);
      else if (b.action === 'give') {
        if (typeof b.phone !== 'string' || !/^555-\d{4}$/.test(b.phone)) throw new HttpError(400, 'Telefon numarası 555-xxxx biçiminde olmalı.');
        character = store.giveItem(acc.id, id, b.itemId, b.qty, b.phone);
      } else throw new HttpError(400, 'Geçersiz işlem.');
    } else if (action === 'vehicles') {
      if (b.action === 'buy' && ID(b.model)) character = store.buyVehicle(acc.id, id, b.model);
      else if (b.action === 'sell' && typeof b.plate === 'string' && /^FW[A-Z2-9]{5}$/.test(b.plate)) character = store.sellVehicle(acc.id, id, b.plate);
      else throw new HttpError(400, 'Geçersiz işlem.');
    } else {
      if (!ID(b.houseId)) throw new HttpError(400, 'Ev bulunamadı.');
      if (b.action === 'buy') character = store.buyHouse(acc.id, id, b.houseId);
      else if (b.action === 'sell') character = store.sellHouse(acc.id, id, b.houseId);
      else throw new HttpError(400, 'Geçersiz işlem.');
    }
    return sendJson(res, 200, { character });
  }
  if (action === 'transactions') {
    method(req, ['GET', 'HEAD']);
    limit(ctx, req, 'read');
    const acc = requireAccount(ctx, req);
    return sendJson(res, 200, { transactions: store.history(acc.id, id) });
  }
  // bank
  method(req, ['POST']);
  requireOrigin(ctx, req);
  limit(ctx, req, 'bank');
  const acc = requireAccount(ctx, req);
  const b = await body(req);
  let character;
  if (b.action === 'deposit') character = store.deposit(acc.id, id, b.amount);
  else if (b.action === 'withdraw') character = store.withdraw(acc.id, id, b.amount);
  else if (b.action === 'transfer') {
    if (typeof b.to !== 'string' || !/^FW\d{10}$/.test(b.to)) throw new HttpError(400, 'Alıcı hesap numarası FW ile başlayan 12 karakter olmalı.');
    character = store.transfer(acc.id, id, b.to, b.amount, b.note);
  } else throw new HttpError(400, 'Geçersiz banka işlemi.');
  return sendJson(res, 200, { character });
}
