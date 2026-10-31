// Game-page HUD (public/game-hud.js) in JSDOM with the real mirror toolbar (touch_art/game_ui.js)
// and keyboard remapping (keyboard_controls.js) when the mirror is present.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { transformGamePage, HUD_SRC, RESOURCE_CLIENT_SRC } from '../src/game-page.js';
import { loadPublicAssets } from '../src/public.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const MIRROR = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';
const HUD = fs.readFileSync(path.join(PUBLIC, 'game-hud.js'), 'utf8');
const I18N = fs.readFileSync(path.join(PUBLIC, 'i18n.js'), 'utf8');
const mirror = (f) => path.join(MIRROR, f);
const hasMirror = fs.existsSync(mirror('touch_art/game_ui.js')) && fs.existsSync(mirror('keyboard_controls.js'));

function boot({ languages = ['tr-TR'], peers = [], self = null, bindings = null, before = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><canvas id="canvas"></canvas><div id="hud">ipucu</div></body></html>', {
    url: 'https://fiveweb.test/game.html?mode=sandbox&multiplayer=1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages });
  const bus = [];
  let listener = null;
  w.BroadcastChannel = class { constructor(name) { this.name = name; listener = this; } postMessage(m) { bus.push(m); } close() {} };
  const P = w.HTMLDialogElement.prototype;
  if (!P.showModal) {
    P.showModal = function () { this.setAttribute('open', ''); };
    P.close = function () { this.removeAttribute('open'); };
  }
  if (bindings) w.localStorage.setItem('gta5-keyboard-controls-v1', JSON.stringify({ version: 1, bindings }));
  w.eval(I18N);
  if (hasMirror) {
    w.eval(fs.readFileSync(mirror('touch_art/game_ui.js'), 'utf8'));
    w.eval(fs.readFileSync(mirror('keyboard_controls.js'), 'utf8'));
    w.GTAGameUI.mount();
  }
  if (before) before(w);
  w.GTAMultiplayerGame = { getPeers: () => peers, getLocalPose: () => self, getPeerCount: () => peers.length };
  // The game's own key handler (bubble phase on window) records what reaches the engine.
  const engineKeys = [];
  w.addEventListener('keydown', (e) => engineKeys.push(e.code));
  w.eval(HUD);
  const hud = w.__fiveWebHud || w.FiveWebHud.install({ mapIntervalMs: 60000 });
  const key = (code, extra = {}) => w.document.getElementById('canvas').dispatchEvent(new w.KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...extra }));
  const fromWorker = (m) => listener.onmessage && listener.onmessage({ data: m });
  return { w, doc: w.document, hud, key, engineKeys, bus, fromWorker, close: () => { hud.stop(); w.close(); } };
}

describe('game HUD: toolbar buttons', () => {
  test('adds Keys and Hide UI buttons (no page map) to the top toolbar', { skip: !hasMirror && 'mirror toolbar missing' }, () => {
    const h = boot();
    try {
      const bar = h.doc.getElementById('game-page-actions');
      assert.equal(h.doc.getElementById('fw-map-toggle'), null);
      for (const id of ['fw-keys-open', 'fw-ui-toggle']) assert.equal(h.doc.getElementById(id).parentElement, bar, id);
      assert.equal(h.doc.getElementById('fw-keys-open').textContent, 'Tuşlar (F8)');
      assert.equal(h.doc.getElementById('fw-ui-toggle').textContent, 'Arayüzü gizle');
    } finally { h.close(); }
  });
});

describe('game HUD: key combinations sheet', () => {
  test('the button opens a modal dialog listing game, mouse and page keys', () => {
    const h = boot();
    try {
      h.doc.getElementById('fw-keys-open').click();
      const d = h.doc.getElementById('fw-keys');
      assert.equal(d.open, true);
      const text = d.textContent;
      for (const s of ['Tuş kombinasyonları', 'Hareket', 'Araca bin / in', 'Fare', 'Fareyi bırak', 'Oyun haritası (oyuncular işaretli)', 'F9']) assert.ok(text.includes(s), s);
      d.querySelector('.fw-close').click();
      assert.equal(d.open, false);
    } finally { h.close(); }
  });

  test('a remapped game key is shown with its default', { skip: !hasMirror && 'mirror keyboard_controls missing' }, () => {
    const h = boot({ bindings: { KeyF: 'KeyG' } });
    try {
      h.hud.openKeys();
      const rows = [...h.doc.querySelectorAll('#fw-keys tr')].map((r) => r.textContent);
      assert.ok(rows.some((r) => r.startsWith('G') && r.includes('Araca bin / in (varsayılan: F)')), rows.join('|'));
    } finally { h.close(); }
  });

  test('English browser shows the sheet in English', () => {
    const h = boot({ languages: ['en-US'] });
    try {
      h.hud.openKeys();
      const text = h.doc.getElementById('fw-keys').textContent;
      assert.ok(text.includes('Key combinations'));
      assert.ok(text.includes('Enter / exit vehicle'));
    } finally { h.close(); }
  });
});

describe('game HUD: hotkeys never reach the engine', () => {
  test('F8 toggles the sheet, F9 hides/shows the overlays; F7 and other keys pass through', () => {
    const h = boot();
    try {
      h.key('F8');
      assert.equal(h.hud.state().keysOpen, true);
      h.key('F8');
      assert.equal(h.hud.state().keysOpen, false);
      h.key('F9');
      assert.equal(h.doc.documentElement.classList.contains('fw-ui-hidden'), true);
      assert.equal(h.w.localStorage.getItem('fiveweb.hud.hidden'), '1');
      h.key('F9');
      assert.equal(h.doc.documentElement.classList.contains('fw-ui-hidden'), false);
      h.key('F7');
      h.key('KeyW');
      assert.deepEqual(h.engineKeys, ['F7', 'KeyW']);
    } finally { h.close(); }
  });

  test('hidden state hides voice, status, map and toolbar buttons but keeps the toggle', () => {
    const h = boot();
    try {
      h.hud.toggleUi(true);
      const css = h.doc.getElementById('fiveweb-hud-style').textContent;
      for (const sel of ['#game-page-actions > :not(#fw-ui-toggle)', '#grandv-voice', '#grandv-mp-status', '#fw-money']) assert.ok(css.includes(sel), sel);
      assert.equal(h.doc.getElementById('fw-ui-toggle').textContent, 'Arayüzü göster');
      assert.equal(h.doc.getElementById('fw-ui-toggle').getAttribute('aria-pressed'), 'true');
    } finally { h.close(); }
  });
});

describe('game HUD: engine map bridge', () => {
  test('peer positions are sent to the engine worker; the page draws no map', () => {
    const peers = [
      { id: 'bbbbbbbbbbbbbbbb', name: 'Ali Keser', position: [100, 200, 30], heading: 45 },
      { id: 'cccccccccccccccc', position: null },
      { id: 'dddddddddddddddd', position: [1, 'x', 3] },
    ];
    const h = boot({ peers });
    try {
      const plain = (x) => JSON.parse(JSON.stringify(x));
      assert.deepEqual(plain(h.bus[0]), { type: 'hello' });
      assert.equal(h.hud.publishPlayers(), 1);
      assert.deepEqual(plain(h.bus.at(-1)), { type: 'players', players: [{ id: 'bbbbbbbbbbbbbbbb', x: 100, y: 200, z: 30, heading: 45 }] });
      assert.equal(h.doc.getElementById('fiveweb-map'), null);
      assert.equal(h.doc.querySelector('canvas:not(#canvas)'), null);
    } finally { h.close(); }
  });

  test('with the page shared buffer, positions and cash go to the engine worker layout', async () => {
    const vm = await import('node:vm');
    vm.runInThisContext(fs.readFileSync(path.join(PUBLIC, 'fiveweb-natives.js'), 'utf8'));
    const peers = [{ id: 'bbbbbbbbbbbbbbbb', position: [100, 200, 30], heading: 45 }];
    const h = boot({ peers, before: (w) => { w.SharedArrayBuffer = SharedArrayBuffer; w.__fiveWebShared = new SharedArrayBuffer(4160); } });
    try {
      h.hud.publishPlayers();
      const snap = globalThis.FiveWebNatives.readShared(h.w.__fiveWebShared);
      assert.equal(snap.players.length, 1);
      assert.deepEqual([snap.players[0].x, snap.players[0].y, snap.players[0].z, snap.players[0].heading], [100, 200, 30, 45]);
      assert.equal(snap.players[0].id, 'k' + (0xbbbbbbbb | 0));
      assert.equal(snap.cash, null);
      assert.equal(h.bus.filter((m) => m.type === 'players').length, 0, 'no channel copy when the buffer exists');
    } finally { h.close(); }
  });

  test('the key sheet shows the engine map status reported by the worker', () => {
    const h = boot();
    try {
      h.hud.openKeys();
      assert.match(h.doc.getElementById('fw-engine-map').textContent, /çok oyunculu sunucuda/);
      h.fromWorker({ type: 'status', state: 'running', blips: 3 });
      assert.match(h.doc.getElementById('fw-engine-map').textContent, /bağlı: 3 oyuncu işaretli/);
      h.fromWorker({ type: 'status', state: 'error', blips: 0, error: '<b>x</b>' });
      assert.equal(h.doc.querySelector('#fw-engine-map b'), null);
      assert.deepEqual(JSON.parse(JSON.stringify(h.hud.state().engineMap)), { state: 'error', blips: 0, players: 0, zeroHandles: 0, error: '<b>x</b>' });
    } finally { h.close(); }
  });
});

describe('game HUD: serving and injection', () => {
  test('the HUD and the worker natives script are public assets; the page map image is gone', () => {
    const assets = loadPublicAssets();
    assert.equal(assets.get('/__grandv/game-hud.js').type, 'text/javascript; charset=utf-8');
    assert.equal(assets.get('/__grandv/fiveweb-natives.js').type, 'text/javascript; charset=utf-8');
    assert.equal(assets.has('/__grandv/fiveweb-map.png'), false);
  });

  test('the game page loads the HUD after the resource client', () => {
    const page = Buffer.from('<html><head></head><body><script>const playerKeys=new Set(["audiodiag","mode"]);if(q.get("poseproof")!=="4")q.delete("poseproof");</script></body></html>', 'latin1');
    const out = transformGamePage(page, { hud: true }).body.toString('latin1');
    assert.ok(out.indexOf(RESOURCE_CLIENT_SRC) < out.indexOf(HUD_SRC));
    assert.equal(transformGamePage(page).body.toString('latin1').includes(HUD_SRC), false);
  });
});

describe('FiveWeb page API (Faz 0): commands, engine state, notifications', () => {
  test('FiveWeb.cmd writes to the mailbox and resolves from the engine result', async () => {
    const h = boot({ before: (w) => { w.SharedArrayBuffer = SharedArrayBuffer; w.TextEncoder = TextEncoder; w.__fiveWebShared = new SharedArrayBuffer(20816); } });
    try {
      const api = h.w.FiveWeb;
      assert.equal(typeof api.cmd, 'function');
      const p = api.cmd('weather', { type: 'RAIN' });
      const i32 = new Int32Array(h.w.__fiveWebShared, 4416, 4);
      assert.equal(Atomics.load(i32, 0), 1);
      const batch = JSON.parse(new TextDecoder().decode(new Uint8Array(h.w.__fiveWebShared, 4432, i32[2]).slice()));
      assert.equal(batch[0].cmd, 'weather');
      assert.equal(h.w.__fiveWebHud.state().pending, 1);
      h.fromWorker({ type: 'result', id: batch[0].id, ok: true, value: 'RAIN' });
      assert.equal(await p, 'RAIN');
      assert.equal(h.w.__fiveWebHud.state().pending, 0);
    } finally { h.close(); }
  });

  test('without the large buffer FiveWeb.cmd rejects; notify shows text only', async () => {
    const h = boot();
    try {
      await assert.rejects(h.w.FiveWeb.cmd('heal'), /unavailable/);
      const box = h.w.FiveWeb.notify('<img src=x> Araç garajda', 'success');
      assert.match(box.textContent, /Araç garajda/);
      assert.equal(h.doc.querySelector('.fw-toasts img'), null);
      assert.ok(box.classList.contains('fw-toast-success'));
    } finally { h.close(); }
  });
});

describe('game toolbar labels follow the interface language', () => {
  test('English game buttons are shown in Turkish; a script rewrite is translated again; EN restores', async () => {
    const h = boot({ before: (w) => {
      let bar = w.document.getElementById('game-page-actions');
      if (!bar) { bar = w.document.createElement('div'); bar.id = 'game-page-actions'; w.document.body.append(bar); }
      for (const [id, text] of [['return-launcher', 'Return to launcher'], ['loading-sound', 'Loading sound: on']]) {
        const b = w.document.createElement('button'); b.id = id; b.textContent = text; bar.append(b);
      }
    } });
    try {
      const ret = h.doc.getElementById('return-launcher'), snd = h.doc.getElementById('loading-sound');
      assert.equal(ret.textContent, 'Başlatıcıya dön');
      assert.equal(snd.textContent, 'Yükleme sesi: açık');
      snd.textContent = 'Loading sound: off';
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(snd.textContent, 'Yükleme sesi: kapalı');
      h.w.FiveWebI18n.setLanguage('en');
      assert.equal(ret.textContent, 'Return to launcher');
      assert.equal(snd.textContent, 'Loading sound: off');
    } finally { h.close(); }
  });
});
