// Lobby → launcher multiplayer gate, tested in jsdom against the REAL mirror files:
// launcher.html markup, launcher.js, launcher_multiplayer.js, launcher_player_flow.js and
// public/launcher-adapter.js. Only browser/platform stubs are added (GPU, secure context,
// dialog, WebSocket transport for the relay check). Nothing in the mirror is written.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const ASSET_ROOT = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';
const PUBLIC = path.resolve(import.meta.dirname, '../public');
const ORIGIN = 'http://localhost:8097';
const LOBBY = 'abcdefghijklmnop';
const CRED = 'Sup3r-Code';
const PENDING = 'gta5.multiplayer.pending.v1';
const PREF = 'gta5.multiplayer.server.v1';
const SESSION = 'grandv.lobby.session.v1';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

// Real launcher scripts in the order launcher.html loads them (dependencies first).
const LAUNCHER_DEPS = ['graphics_settings.js', 'touch_art/cpu_settings.js', 'launch_url.js', 'launcher.js', 'launcher_multiplayer.js', 'launcher_player_flow.js'];
const readAsset = (f) => fs.readFileSync(path.join(ASSET_ROOT, f), 'utf8');
const validSession = (over = {}) => ({ id: LOBBY, name: 'Test lobi', role: 'guest', credential: CRED, expiresAt: FUTURE(), ...over });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function boot({ query = '', session, pref, adapter = true, gpu = true } = {}) {
  const sent = [];
  const dom = new JSDOM(readAsset('launcher.html'), {
    url: ORIGIN + '/launcher.html' + query,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(win) {
      Object.defineProperty(win, 'isSecureContext', { value: true, configurable: true });
      Object.defineProperty(win, 'crossOriginIsolated', { value: true, configurable: true });
      // jsdom ignores the userAgent constructor option; the browser-identity gate reads navigator.
      Object.defineProperty(win.navigator, 'userAgent', { value: CHROME_UA, configurable: true });
      if (gpu) {
        Object.defineProperty(win.navigator, 'gpu', {
          value: { requestAdapter: async () => ({ features: new Set(['texture-compression-bc']) }) },
          configurable: true,
        });
      }
      win.__urls = [];
      const Base = win.URL;
      win.URL = class extends Base {
        constructor(...args) { super(...args); win.__urls.push(this); }
      };
      // Relay transport stub: the GPU/browser checks are real; only the socket is faked.
      win.WebSocket = class {
        constructor(url) { this.url = url; sent.push({ url }); setTimeout(() => this.onopen && this.onopen(), 0); }
        send(text) { sent[sent.length - 1].frame = JSON.parse(text); setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'checked' }) }), 0); }
        close() {}
      };
      const P = win.HTMLDialogElement?.prototype;
      if (P && !P.showModal) {
        P.showModal = function () { this.setAttribute('open', ''); };
        P.close = function () { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
      }
    },
  });
  const w = dom.window;
  if (session !== undefined) w.sessionStorage.setItem(SESSION, JSON.stringify(session));
  if (pref !== undefined) w.localStorage.setItem(PREF, JSON.stringify(pref));
  for (const f of LAUNCHER_DEPS) w.eval(readAsset(f));
  if (adapter) w.eval(fs.readFileSync(path.join(PUBLIC, 'launcher-adapter.js'), 'utf8'));
  await new Promise((r) => (w.document.readyState === 'complete' ? r() : w.addEventListener('load', r)));
  await settle();
  const $ = (id) => w.document.getElementById(id);
  return { dom, w, $, sent, close: () => dom.window.close() };
}

const banner = (w) => w.document.getElementById('grandv-lobby-banner')?.textContent || '';

describe('real launcher markup ships multiplayer disabled', () => {
  test('original HTML: play-multiplayer, mp-enable and multiplayer-open are disabled', async () => {
    const h = await boot({ adapter: false });
    try {
      assert.equal(h.$('play-multiplayer').disabled, true);
      assert.equal(h.$('mp-enable').disabled, true);
      assert.equal(h.$('multiplayer-open').disabled, true);
      assert.match(readAsset('launcher.html'), /future release/);
    } finally { h.close(); }
  });

  test('original HTML + launcher_multiplayer.js: applyPreferences refuses to enable while disabled', async () => {
    const h = await boot({ adapter: false });
    try {
      h.w.GTALauncherSettings.applySettings({ ...h.w.GTALauncherSettings.currentSettings(), mode: 'sandbox' });
      h.w.GTAMultiplayerLaunch.applyPreferences({ sameHost: true, room: LOBBY, enabled: true });
      assert.equal(h.$('mp-enable').checked, false);
      assert.equal(h.$('play-multiplayer').checked, false);
    } finally { h.close(); }
  });
});

describe('lobby session activates multiplayer through the real launcher', () => {
  let h;
  before(async () => {
    h = await boot({ query: `?lobby=${LOBBY}`, session: validSession() });
  });
  after(() => h.close());

  test('visible radio and hidden enable are checked; gates lifted', () => {
    assert.equal(h.$('play-multiplayer').disabled, false);
    assert.equal(h.$('play-multiplayer').checked, true);
    assert.equal(h.$('mp-enable').disabled, false);
    assert.equal(h.$('mp-enable').checked, true);
    assert.equal(h.$('multiplayer-open').disabled, false);
    assert.equal(h.$('play-single').checked, false);
  });

  test('sandbox mode and relay room are set, both key fields hold the credential', () => {
    assert.equal(h.w.document.querySelector('input[name=mode]:checked').value, 'sandbox');
    assert.equal(h.$('mp-samehost').checked, true);
    assert.equal(h.$('mp-room').value, LOBBY);
    assert.equal(h.$('mp-key').value, CRED);
    assert.equal(h.$('mp-access').value, CRED);
  });

  test('success banner is shown, no error tone', () => {
    assert.match(banner(h.w), /Lobi: Test lobi/);
    assert.equal(h.w.document.getElementById('grandv-lobby-banner').dataset.tone, 'ok');
  });

  test('credential is not written to localStorage or the URL', () => {
    assert.equal(h.w.localStorage.getItem(PREF).includes(CRED), false);
    for (let i = 0; i < h.w.localStorage.length; i++) assert.equal(h.w.localStorage.getItem(h.w.localStorage.key(i)).includes(CRED), false);
    assert.equal(h.w.location.href.includes(CRED), false);
  });

  test('prepare("sandbox") writes exactly {url,room,key} to the pending launch', () => {
    assert.equal(h.w.GTAMultiplayerLaunch.prepare('sandbox').enabled, true);
    assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(PENDING)), { url: 'ws://localhost:8097/relay', room: LOBBY, key: CRED });
  });

  test('pageshow restores the enabled state and key after the form was reset', () => {
    h.$('play-multiplayer').checked = false;
    h.$('mp-enable').checked = false;
    h.$('mp-key').value = '';
    h.$('mp-access').value = '';
    h.w.dispatchEvent(new h.w.Event('pageshow'));
    assert.equal(h.$('play-multiplayer').checked, true);
    assert.equal(h.$('mp-enable').checked, true);
    assert.equal(h.$('mp-key').value, CRED);
    assert.equal(h.$('mp-room').value, LOBBY);
  });
});

describe('original Start handler builds the multiplayer launch', () => {
  test('Start with a valid lobby navigates to a URL with multiplayer=1 and poseproof=3', async () => {
    const h = await boot({ query: `?lobby=${LOBBY}`, session: validSession() });
    try {
      h.$('start').click();
      for (let i = 0; i < 100 && !h.w.__urls.some((u) => u.searchParams.get('multiplayer') === '1'); i++) await settle(50);
      const target = h.w.__urls.filter((u) => u.searchParams.get('multiplayer') === '1').pop();
      assert.ok(target, 'Start handler produced a multiplayer URL');
      assert.equal(target.searchParams.get('poseproof'), '3');
      assert.equal(target.searchParams.get('mode'), 'sandbox');
      assert.equal(target.href.includes(CRED), false);
      assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem(PENDING)), { url: 'ws://localhost:8097/relay', room: LOBBY, key: CRED });
      assert.equal(h.sent[0].frame.key, CRED);
      assert.equal(h.sent[0].url.includes(CRED), false);
    } finally { h.close(); }
  });
});

describe('invalid or missing session never enables multiplayer', () => {
  const cases = [
    ['expired', { session: validSession({ expiresAt: new Date(Date.now() - 1000).toISOString() }) }],
    ['unparseable expiry', { session: validSession({ expiresAt: 'soon' }) }],
    ['id differs from lobby', { session: validSession({ id: 'ponmlkjihgfedcba' }) }],
    ['short credential', { session: validSession({ credential: 'ab' }) }],
    ['credential with spaces', { session: validSession({ credential: 'has space' }) }],
    ['no session stored', {}],
  ];
  for (const [name, opts] of cases) {
    test(`${name}: error banner, nothing enabled or filled`, async () => {
      const h = await boot({ query: `?lobby=${LOBBY}`, ...opts });
      try {
        assert.match(banner(h.w), /Lobi oturumu bulunamadı|süresi doldu/);
        assert.equal(h.w.document.getElementById('grandv-lobby-banner').dataset.tone, 'error');
        assert.equal(h.$('play-multiplayer').checked, false);
        assert.equal(h.$('mp-enable').checked, false);
        assert.equal(h.$('mp-room').value, 'friends'); // original default, untouched
        assert.equal(h.$('mp-key').value, '');
        assert.equal(h.$('mp-access').value, '');
      } finally { h.close(); }
    });
  }
});

describe('standalone launcher stays singleplayer', () => {
  test('no lobby, no session: no banner, no mutation of multiplayer fields', async () => {
    const h = await boot();
    try {
      assert.equal(banner(h.w), '');
      assert.equal(h.$('play-single').checked, true);
      assert.equal(h.$('play-multiplayer').checked, false);
      assert.equal(h.$('mp-enable').checked, false);
      assert.equal(h.$('mp-room').value, 'friends'); // original default, untouched
      assert.equal(h.$('mp-key').value, '');
    } finally { h.close(); }
  });

  test('stored enabled preference without a session is not re-enabled', async () => {
    const h = await boot({ pref: { sameHost: true, room: 'friends', enabled: true } });
    try {
      assert.equal(h.$('mp-enable').checked, false);
      assert.equal(h.$('play-multiplayer').checked, false);
      assert.equal(h.$('play-single').checked, true);
    } finally { h.close(); }
  });

  test('Start without a lobby: singleplayer URL, no multiplayer params, no pending launch', async () => {
    const h = await boot();
    try {
      const before = h.w.__urls.length;
      h.$('start').click();
      for (let i = 0; i < 100 && h.w.__urls.length === before; i++) await settle(50);
      const target = h.w.__urls.slice(before).pop();
      assert.ok(target, 'Start handler built a launch URL');
      assert.equal(target.searchParams.has('multiplayer'), false);
      assert.equal(target.searchParams.has('poseproof'), false);
      assert.equal(h.w.sessionStorage.getItem(PENDING), null);
    } finally { h.close(); }
  });
});
