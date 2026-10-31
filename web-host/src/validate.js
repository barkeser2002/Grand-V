// Strict input validation for the lobby API. Unknown fields are rejected.
import { BUILD, MIN_CAPACITY, MAX_CAPACITY, SUPPORTED_MAPS } from './constants.js';
import { HttpError } from './http-util.js';

const NAME_RE = /^[\p{L}\p{N} _.\-!?']{3,40}$/u;
const NICK_RE = /^[\p{L}\p{N} _.\-]{2,20}$/u;
export const LOBBY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const CREDENTIAL_RE = /^[\x21-\x7e]{4,128}$/;

export function cleanText(value, re) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return re.test(text) ? text : null;
}

function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Gövde bir JSON nesnesi olmalı.');
  }
  return body;
}

function rejectUnknown(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Bilinmeyen alan: ${key}`);
  }
}

export function parseCreate(raw) {
  const body = requireObject(raw);
  rejectUnknown(body, ['name', 'nickname', 'map', 'build', 'capacity']);
  const name = cleanText(body.name, NAME_RE);
  if (!name) throw new HttpError(400, 'Lobi adı 3-40 karakter olmalı (harf, rakam, boşluk, - _ . ! ? \').');
  const hostNickname = cleanText(body.nickname, NICK_RE);
  if (!hostNickname) throw new HttpError(400, 'Takma ad 2-20 karakter olmalı (harf, rakam, boşluk, - _ .).');
  const map = body.map === undefined ? 'gta5' : body.map;
  if (!SUPPORTED_MAPS.includes(map)) throw new HttpError(400, 'Desteklenmeyen harita.');
  if (body.build !== undefined && body.build !== BUILD) {
    throw new HttpError(400, 'Desteklenmeyen oyun sürümü.');
  }
  const capacity = body.capacity === undefined ? MIN_CAPACITY : body.capacity;
  if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
    throw new HttpError(400, `Kapasite ${MIN_CAPACITY}-${MAX_CAPACITY} arasında bir tam sayı olmalı.`);
  }
  return { name, hostNickname, map, build: BUILD, capacity };
}

export function parseJoin(raw) {
  const body = requireObject(raw);
  rejectUnknown(body, ['nickname', 'characterId']);
  if (body.characterId !== undefined) {
    if (typeof body.characterId !== 'string' || !/^[0-9a-f]{16}$/.test(body.characterId)) throw new HttpError(400, 'Geçersiz karakter.');
    return { characterId: body.characterId };
  }
  const nickname = cleanText(body.nickname, NICK_RE);
  if (!nickname) throw new HttpError(400, 'Takma ad 2-20 karakter olmalı (harf, rakam, boşluk, - _ .).');
  return { nickname };
}

export function parseRelease(raw) {
  const body = requireObject(raw);
  rejectUnknown(body, ['credential']);
  if (typeof body.credential !== 'string' || !CREDENTIAL_RE.test(body.credential)) {
    throw new HttpError(400, 'Geçersiz oturum anahtarı.');
  }
  return { credential: body.credential };
}

export function parseLobbyId(id) {
  if (!LOBBY_ID_RE.test(id)) throw new HttpError(400, 'Geçersiz lobi kimliği.');
  return id;
}
