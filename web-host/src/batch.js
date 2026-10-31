// POST /data/batch: reproduces server.rs. Body is a JSON array of [name, start, end] where
// end is inclusive and clamped to the file size. Response is the concatenated bytes;
// X-Run-Lengths lists each run's emitted length; gz=1 gzip-compresses the body
// (Content-Encoding: gzip). Uncompressed batches stream from disk; gzip output is collected
// because Content-Length must describe the compressed body.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { readBody, sendError, HttpError } from './http-util.js';
import { parseRelative, realInside } from './static.js';

const MAX_RUNS = 1000;
const MAX_BODY = 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

export function parseRuns(text) {
  let runs;
  try {
    runs = JSON.parse(text);
  } catch (_) {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
  if (!Array.isArray(runs) || runs.length > MAX_RUNS) throw new HttpError(400, 'Geçersiz aralık listesi.');
  return runs.map((r) => {
    if (
      !Array.isArray(r) ||
      r.length !== 3 ||
      typeof r[0] !== 'string' ||
      !Number.isSafeInteger(r[1]) ||
      !Number.isSafeInteger(r[2]) ||
      r[1] < 0 ||
      r[2] < 0
    ) {
      throw new HttpError(400, 'Geçersiz aralık.');
    }
    if (r[2] < r[1]) throw new HttpError(400, 'Invalid range');
    return { name: r[0], start: r[1], end: r[2] };
  });
}

export async function handleBatch(ctx, req, res) {
  const query = new URLSearchParams((req.url || '').split('?')[1] || '');
  const gzip = query.getAll('gz').includes('1');
  const runs = parseRuns((await readBody(req, MAX_BODY)).toString('utf8'));

  const dataRoot = await fs.promises.realpath(path.join(ctx.rootReal, 'data')).catch(() => null);
  if (!dataRoot) return sendError(res, 404, 'Bulunamadı.');

  const selected = [];
  let total = 0;
  for (const run of runs) {
    if (run.name.startsWith('/')) throw new HttpError(400, 'Geçersiz yol.');
    const parsed = parseRelative(run.name);
    if (!parsed.segments || parsed.segments.length === 0) throw new HttpError(400, 'Geçersiz yol.');
    const file = await realInside(dataRoot, path.join(dataRoot, ...parsed.segments));
    if (!file) throw new HttpError(400, 'Geçersiz yol.');
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(400, 'Dosya bulunamadı.');
    const length = Math.max(0, Math.min(run.end + 1, st.size) - run.start);
    total += length;
    if (total > MAX_TOTAL) throw new HttpError(400, 'Batch exceeds 64 MiB');
    selected.push({ file, start: run.start, length });
  }
  const lengths = selected.map((s) => String(s.length)).join(',');

  async function* chunks() {
    for (const s of selected) {
      if (s.length === 0) continue;
      const stream = fs.createReadStream(s.file, { start: s.start, end: s.start + s.length - 1 });
      for await (const chunk of stream) yield chunk;
    }
  }

  if (!gzip) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': total,
      'X-Run-Lengths': lengths,
    });
    if (total === 0) return res.end();
    return pipeline(chunks(), res);
  }

  const parts = [];
  await pipeline(chunks(), zlib.createGzip({ level: 1 }), async function (source) {
    for await (const chunk of source) parts.push(chunk);
  });
  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Content-Encoding': 'gzip',
    'X-Run-Lengths': lengths,
  });
  res.end(body);
}
