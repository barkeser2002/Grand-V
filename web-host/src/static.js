// Game asset server. Mirrors LauncherApp/rust/src/server.rs `route` for GET/HEAD: decoded
// path, `..`/empty segments -> 400, single byte ranges with the same parse rules, 416 with
// bytes */size, directory -> index.html, and streamed bodies. Containment is decided on
// realpaths, so symlinks may not leave the asset root. Dotfiles and backend/project files
// are denied outright.
import fs from 'node:fs';
import path from 'node:path';
import { sendError } from './http-util.js';

const MIME = new Map(
  Object.entries({
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    json: 'application/json',
    map: 'application/json',
    js: 'text/javascript',
    mjs: 'text/javascript',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    txt: 'text/plain',
    xml: 'text/xml',
    pdf: 'application/pdf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
  }),
);

const DENY_DIRS = new Set(['node_modules', 'web-host', 'launcherapp', '.git']);
const DENY_NAMES = new Set(['package.json', 'package-lock.json', 'cargo.toml', 'cargo.lock', 'multiplayer-access-code.txt']);
const DENY_EXT = ['.rs', '.pem', '.key', '.p12', '.pfx', '.crt', '.env', '.log'];

export function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME.get(ext) || 'application/octet-stream';
}

// Returns {segments} for a servable relative path, or {status} to answer with.
export function parseRelative(decoded) {
  const rel = decoded.replace(/^\/+/, '');
  if (rel === '') return { segments: [] };
  if (/[\\\0:]/.test(rel)) return { status: 400 };
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return { status: 400 };
  if (parts.some((p) => p.startsWith('.'))) return { status: 404 };
  if (parts.slice(0, -1).some((p) => DENY_DIRS.has(p.toLowerCase()))) return { status: 404 };
  const last = parts[parts.length - 1].toLowerCase();
  if (DENY_NAMES.has(last) || DENY_EXT.some((e) => last.endsWith(e)) || last.startsWith('server.log')) {
    return { status: 404 };
  }
  if (parts.some((p) => DENY_DIRS.has(p.toLowerCase()))) return { status: 404 };
  return { segments: parts };
}

// Resolves a candidate through symlinks and returns its real path only if it stays inside
// `rootReal`; otherwise null (the caller answers 404 without disclosing why).
export async function realInside(rootReal, candidate) {
  try {
    const real = await fs.promises.realpath(candidate);
    return real === rootReal || real.startsWith(rootReal + path.sep) ? real : null;
  } catch (_) {
    return null;
  }
}

const U64 = /^\d+$/;
const parseU64 = (s) => (U64.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null);

// Single range only, identical to server.rs `parse_range`.
export function parseRange(value, size) {
  if (!value.startsWith('bytes=')) return null;
  const range = value.slice('bytes='.length);
  const dash = range.indexOf('-');
  if (dash < 0) return null;
  const a = range.slice(0, dash);
  const b = range.slice(dash + 1);
  if (size === 0) return null;
  if (a === '') {
    const suffix = parseU64(b);
    if (suffix === null) return null;
    const n = Math.min(suffix, size);
    return n > 0 ? { start: size - n, length: n } : null;
  }
  const start = parseU64(a);
  if (start === null) return null;
  let end;
  if (b === '') {
    end = size - 1;
  } else {
    const e = parseU64(b);
    if (e === null) return null;
    end = Math.min(e, size - 1);
  }
  return start < size && end >= start ? { start, length: end - start + 1 } : null;
}

export function sendFile(req, res, file, size) {
  const rangeHeader = req.headers.range || '';
  let start = 0;
  let length = size;
  let status = 200;
  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) {
      res.writeHead(416, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Range': `bytes */${size}`,
        'Content-Length': 0,
      });
      res.end();
      return;
    }
    ({ start, length } = r);
    status = 206;
  }
  const headers = {
    'Content-Type': mimeFor(file),
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${start + length - 1}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end: start + length - 1 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export async function serveStatic(ctx, req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'Bulunamadı.');
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (_) {
    return sendError(res, 400, 'Geçersiz yol.');
  }
  const parsed = parseRelative(decoded);
  if (parsed.status === 400) return sendError(res, 400, 'Geçersiz yol.');
  if (parsed.status) return sendError(res, 404, 'Bulunamadı.');

  let target = await realInside(ctx.rootReal, path.join(ctx.rootReal, ...parsed.segments));
  if (!target) return sendError(res, 404, 'Bulunamadı.');
  let st = await fs.promises.stat(target);
  if (st.isDirectory()) {
    target = await realInside(ctx.rootReal, path.join(target, 'index.html'));
    if (!target) return sendError(res, 404, 'Bulunamadı.');
    st = await fs.promises.stat(target);
  }
  if (!st.isFile()) return sendError(res, 404, 'Bulunamadı.');
  return sendFile(req, res, target, st.size);
}
