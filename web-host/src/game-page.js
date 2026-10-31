// /game.html and /game.movie.html: the original file is read from disk and served with two
// in-memory, byte-level changes. Nothing is written back to the asset tree.
//  1. The player build strips every query key that is not in its playerKeys whitelist, and
//     drops poseproof unless it is 4. Without a change, ?multiplayer=1&poseproof=3 (the
//     launcher's multiplayer URL) is removed before the engine loads, so the replica-capable
//     build is never selected. The patch admits `multiplayer` and keeps poseproof=3 only for
//     multiplayer sandbox launches. Singleplayer and every other key keep the original rules.
//  2. The Grand-V multiplayer runtime (public/multiplayer-game.js) is injected before </head>,
//     so GTAMultiplayerGame exists before the game's own bridge handler calls attach().
// If an expected source pattern is missing or not unique, the original bytes are served
// unchanged (singleplayer keeps working) and the failure is logged.
import fs from 'node:fs';
import path from 'node:path';
import { sendError } from './http-util.js';
import { realInside } from './static.js';
import { applyPersonalBrand } from './brand.js';

export const RUNTIME_SRC = '/__grandv/multiplayer-game.js?v=mp-1';
const I18N_TAG = '<script src="/__grandv/i18n.js"></script>';
const RUNTIME_TAG = `<script src="${RUNTIME_SRC}"></script>`;
export const VOICE_SRC = '/__grandv/voice.js?v=voice-1';
const VOICE_TAG = `<script src="${VOICE_SRC}"></script>`;
export const RESOURCE_CLIENT_SRC = '/__grandv/resource-client.js?v=fw-1';
const RESOURCE_CLIENT_TAG = `<script src="${RESOURCE_CLIENT_SRC}"></script>`;
export const HUD_SRC = '/__grandv/game-hud.js?v=hud-3';
const HUD_TAG = `<script src="${HUD_SRC}"></script>`;
export const LOADING_SRC = '/__grandv/loading-screen.js?v=load-3';
const LOADING_TAG = `<script src="${LOADING_SRC}"></script>`;
const GAMEPLAY_TAG = '<link rel="stylesheet" href="/__grandv/gameplay-menu.css?v=1"><script defer src="/__grandv/gameplay-menu.js?v=1"></script>';

const PATCHES = [
  {
    from: 'const playerKeys=new Set(["audiodiag",',
    to: 'const playerKeys=new Set(["audiodiag","multiplayer","server",',
  },
  {
    from: 'if(q.get("poseproof")!=="4")q.delete("poseproof");',
    to: 'if(q.get("poseproof")!=="4"&&!(q.get("multiplayer")==="1"&&q.get("poseproof")==="3"&&q.get("mode")==="sandbox"))q.delete("poseproof");',
  },
];

// Applied when present (the page still works without them).
const OPTIONAL_PATCHES = [
  {
    // FiveWeb natives (engine-map blips, cash) for multiplayer sandbox launches; read by the
    // served loader.js (src/loader-page.js).
    from: "\t\treplicaProof: q.get('poseproof')==='3'&&q.get('mode')==='sandbox',",
    to: "\t\treplicaProof: q.get('poseproof')==='3'&&q.get('mode')==='sandbox',\n\t\tfivewebNatives: q.get('multiplayer')==='1'&&q.get('poseproof')==='3'&&q.get('mode')==='sandbox',\n\t\tfivewebShared: (q.get('multiplayer')==='1'&&q.get('poseproof')==='3'&&q.get('mode')==='sandbox'&&typeof SharedArrayBuffer==='function')?(window.__fiveWebShared=new SharedArrayBuffer(20816)):null,",
  },
];

// Pure transform over the latin1 view of the bytes (every pattern is ASCII, so byte offsets
// are preserved). Returns { body, patched, missing }. Injected order before </head>: voice
// (only when the voice asset exists), the multiplayer runtime, then the resource client.
export function transformGamePage(original, { voice = false, i18n = false, hud = false, loading = false, gameplay = false } = {}) {
  let text = original.toString('latin1');
  const missing = [];
  for (const { from, to } of PATCHES) {
    const count = text.split(from).length - 1;
    if (count !== 1) {
      missing.push(from);
      continue;
    }
    text = text.replace(from, () => to);
  }
  if (missing.length) return { body: original, patched: false, missing };
  for (const { from, to } of OPTIONAL_PATCHES) {
    if (text.split(from).length - 1 === 1) text = text.replace(from, () => to);
  }
  const headClose = text.search(/<\/head\s*>/i);
  const tags = (i18n ? I18N_TAG : '') + (voice ? VOICE_TAG : '') + RUNTIME_TAG + RESOURCE_CLIENT_TAG + (hud ? HUD_TAG : '') + (loading ? LOADING_TAG : '') + (gameplay ? GAMEPLAY_TAG : '');
  text = headClose >= 0 ? text.slice(0, headClose) + tags + text.slice(headClose) : tags + text;
  return { body: Buffer.from(text, 'latin1'), patched: true, missing: [] };
}

export const GAME_PAGES = new Map([
  ['/game.html', 'game.html'],
  ['/game.movie.html', 'game.movie.html'],
]);

export async function serveGamePage(ctx, req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'Bulunamadı.');
  const name = GAME_PAGES.get(rawPath);
  const file = await realInside(ctx.rootReal, path.join(ctx.rootReal, name));
  if (!file) return sendError(res, 404, 'Bulunamadı.');
  const original = await fs.promises.readFile(file);
  const voice = ctx.publicAssets ? ctx.publicAssets.has('/__grandv/voice.js') : false;
  const { body, patched, missing } = transformGamePage(applyPersonalBrand(original), { voice, i18n: ctx.publicAssets?.has('/__grandv/i18n.js') === true, hud: ctx.publicAssets?.has('/__grandv/game-hud.js') === true, loading: ctx.publicAssets?.has('/__grandv/loading-screen.js') === true, gameplay: ctx.publicAssets?.has('/__grandv/gameplay-menu.js') === true && ctx.publicAssets?.has('/__grandv/gameplay-menu.css') === true });
  if (!patched) ctx.log(`game page ${name} served unpatched; missing pattern: ${missing.length}`);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
