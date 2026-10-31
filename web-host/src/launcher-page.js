// /launcher.html: the original file is read from disk and served byte-for-byte, except that
// one <script> tag for the Grand-V lobby adapter is spliced in before the final </body>.
// The original asset is never written to.
import fs from 'node:fs';
import path from 'node:path';
import { sendError } from './http-util.js';
import { realInside } from './static.js';
import { applyPersonalBrand } from './brand.js';

export const ADAPTER_SRC = '/__grandv/launcher-adapter.js?v=lobby-2';
const ADAPTER_TAG = Buffer.from(`<script src="/__grandv/i18n.js"></script><script src="${ADAPTER_SRC}"></script>`, 'utf8');
const BODY_CLOSE = Buffer.from('</body>', 'utf8');

// Byte-level splice: latin1 maps every byte to one char, so indexes line up with the buffer.
export function injectAdapter(html) {
  const at = html.toString('latin1').toLowerCase().lastIndexOf(BODY_CLOSE.toString('latin1'));
  if (at < 0) return Buffer.concat([html, ADAPTER_TAG]);
  return Buffer.concat([html.subarray(0, at), ADAPTER_TAG, html.subarray(at)]);
}

export async function serveLauncher(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'Bulunamadı.');
  const file = await realInside(ctx.rootReal, path.join(ctx.rootReal, 'launcher.html'));
  if (!file) return sendError(res, 404, 'Bulunamadı.');
  const original = await fs.promises.readFile(file);
  const body = injectAdapter(applyPersonalBrand(original));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
