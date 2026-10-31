// /b/<build>/loader.js: the engine worker script, served with two in-memory changes for
// FiveWeb multiplayer (nothing is written back to the asset tree):
//  1. When the page asks for FiveWeb natives (m.fivewebNatives, set by the game page only for
//     multiplayer sandbox launches) and the plain engine would be used, the Menyoo engine build
//     is selected instead. It has identical imports and additionally exports the natives.
//  2. Right after instantiation, public/fiveweb-natives.js is installed in the engine's script
//     callback (the slot Menyoo would use). Failures are logged and the game starts normally.
// If a pattern is missing or not unique the original bytes are served unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { sendError } from './http-util.js';
import { realInside } from './static.js';

export const NATIVES_SRC = '/__grandv/fiveweb-natives.js?v=nat-3';
export const LOADER_PATH = /^\/b\/[0-9a-f]{10}\/loader\.js$/;

const PATCHES = [
  {
    from: "engineWasm += (engineWasm.includes('?')?'&':'?')+'customaudio=selective-v1&r5=20261020';",
    to: "if(m.fivewebNatives===true&&engineWasm==='/game.wasm')engineWasm='/game.menyoo-mainline.wasm';\n\tengineWasm += (engineWasm.includes('?')?'&':'?')+'customaudio=selective-v1&r5=20261020';",
  },
  {
    from: "bc.postMessage({ pct: 22, label: 'Starting the engine' });",
    to: `bc.postMessage({ pct: 22, label: 'Starting the engine' });\n\t\t\t\t\tif(m.fivewebNatives===true&&!trainer){try{importScripts('${NATIVES_SRC}');await FiveWebNatives.install(r.instance,B,{shared:m.fivewebShared});}catch(e){console.error('[FiveWeb natives] disabled:',e);}}`,
  },
];

export function transformLoader(original) {
  let text = original.toString('latin1');
  const missing = [];
  for (const { from, to } of PATCHES) {
    if (text.split(from).length - 1 !== 1) { missing.push(from); continue; }
    text = text.replace(from, () => to);
  }
  if (missing.length) return { body: original, patched: false, missing };
  return { body: Buffer.from(text, 'latin1'), patched: true, missing: [] };
}

export async function serveLoader(ctx, req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'Bulunamadı.');
  const file = await realInside(ctx.rootReal, path.join(ctx.rootReal, rawPath));
  if (!file) return sendError(res, 404, 'Bulunamadı.');
  const original = await fs.promises.readFile(file);
  const enabled = ctx.publicAssets?.has('/__grandv/fiveweb-natives.js') === true;
  const { body, patched, missing } = enabled ? transformLoader(original) : { body: original, patched: false, missing: [] };
  if (enabled && !patched) ctx.log(`loader ${rawPath} served unpatched; missing pattern: ${missing.length}`);
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
