// POST /log: client diagnostics. Bounded (16 KiB, rate limited), control characters removed,
// credential-looking key/value pairs redacted, and written to the server log (stdout), never
// to the asset tree.
import { readBody, sendError } from './http-util.js';

const LOG_LIMIT = 16 * 1024;
const MAX_LINES = 40;
const LINE_MAX = 2000;
const SECRET_PAIR = /((?:credential|key|token|secret|password|passcode|access)[^\s:=]{0,20}\s*[:=]\s*)\S+/gi;

export function sanitizeLogText(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(SECRET_PAIR, '$1[redacted]');
}

export async function handleLog(ctx, req, res) {
  const { limit, windowMs } = ctx.rateLimits.log;
  const verdict = ctx.limiter.hit(`log:${ctx.clientIp(req)}`, limit, windowMs);
  if (!verdict.allowed) {
    return sendError(res, 429, 'Çok fazla istek. Biraz bekleyin.', { 'Retry-After': String(verdict.retryAfterSec) });
  }
  const body = await readBody(req, LOG_LIMIT);
  const lines = sanitizeLogText(body.toString('utf8')).split('\n').filter((l) => l.trim() !== '');
  for (const line of lines.slice(0, MAX_LINES)) {
    ctx.log(`game: ${line.slice(0, LINE_MAX)}`);
  }
  res.writeHead(204);
  res.end();
}
