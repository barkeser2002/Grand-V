// Lobby UI and adapter assets. Read once at startup; served only from explicit routes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };

const ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/__grandv/i18n.js', { file: 'i18n.js', type: 'text/javascript; charset=utf-8', optional: true }],
  ['/__lobby/lobby.js', { file: 'lobby.js', type: 'text/javascript; charset=utf-8' }],
  ['/__lobby/lobby.css', { file: 'lobby.css', type: 'text/css; charset=utf-8' }],
  ['/__lobby/account.js', { file: 'account.js', type: 'text/javascript; charset=utf-8', optional: true }],
  ['/__grandv/launcher-adapter.js', { file: 'launcher-adapter.js', type: 'text/javascript; charset=utf-8' }],
  ['/__grandv/multiplayer-game.js', { file: 'multiplayer-game.js', type: 'text/javascript; charset=utf-8' }],
  ['/__grandv/resource-client.js', { file: 'resource-client.js', type: 'text/javascript; charset=utf-8' }],
  // Owned by the voice worker. Optional: absent file means no route, and game pages skip the tag.
  ['/__grandv/voice.js', { file: 'voice.js', type: 'text/javascript; charset=utf-8', optional: true }],
  // Game-page HUD (key sheet, overlay switch, player map) and its map image (from the game's heightmap).
  ['/__grandv/game-hud.js', { file: 'game-hud.js', type: 'text/javascript; charset=utf-8', optional: true }],
  ['/__grandv/fiveweb-natives.js', { file: 'fiveweb-natives.js', type: 'text/javascript; charset=utf-8', optional: true }],
  ['/__grandv/gameplay-menu.js', { file: 'gameplay-menu.js', type: 'text/javascript; charset=utf-8', optional: true }],
  ['/__grandv/gameplay-menu.css', { file: 'gameplay-menu.css', type: 'text/css; charset=utf-8', optional: true }],
  // Multiplayer loading screen (adapted ivy_loadingscreen); its media lives in the asset tree under /fiveweb-loading/.
  ['/__grandv/loading-screen.js', { file: 'loading-screen.js', type: 'text/javascript; charset=utf-8', optional: true }],
  // FiveWeb brand files: fixed names only. Optional so fixture public dirs without brand/ still load.
  ...MC_ROUTES(),
  ...BRAND_ROUTES('/__brand/'),
  ...BRAND_ROUTES('/__lobby/brand/'),
  ...BRAND_ROUTES('/brand/'),
]);

// Character selection (ak4y multicharacter theme + FiveWeb glue): every file under public/mc
// is served at /__mc/<path>; the page itself also at /character.html.
function MC_ROUTES() {
  const base = fileURLToPath(new URL('../public/mc/', import.meta.url));
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      const type = MC_TYPES[path.extname(ent.name).toLowerCase()];
      if (!type) continue;
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (!/^[A-Za-z0-9._/-]+$/.test(rel)) continue;
      out.push(['/__mc/' + rel, { file: 'mc/' + rel, type, optional: true }]);
    }
  };
  walk(base);
  out.push(['/character.html', { file: 'mc/index.html', type: 'text/html; charset=utf-8', optional: true }]);
  return out;
}

function BRAND_ROUTES(prefix) {
  return [
    ['fiveweb-logo.png', 'image/png'],
    ['fiveweb-icon.png', 'image/png'],
    ['fiveweb-icon.ico', 'image/x-icon'],
  ].map(([name, type]) => [prefix + name, { file: 'brand/' + name, type, optional: true }]);
}

export function loadPublicAssets(dir = PUBLIC_DIR) {
  const assets = new Map();
  for (const [route, { file, type, optional }] of ROUTES) {
    const full = path.join(dir, file);
    if (optional && !fs.existsSync(full)) continue;
    assets.set(route, { body: fs.readFileSync(full), type });
  }
  return assets;
}
