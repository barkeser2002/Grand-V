import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { injectAdapter } from '../src/launcher-page.js';
import { transformGamePage } from '../src/game-page.js';
import { loadPublicAssets } from '../src/public.js';
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const settle = () => new Promise(r => setTimeout(r, 30));
function runtimeBoot(page, languages = ['en']) {
  const d = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://fiveweb.test' + page, runScripts: 'outside-only' });
  Object.defineProperty(d.window.navigator, 'languages', { value: languages });
  d.window.eval(read('public/i18n.js'));
  return d;
}
test('launcher overlays localize on initial load and manual change without translating session names', () => {
  const d = runtimeBoot('/launcher.html?lobby=abcdefghijklmnop');
  const w = d.window;
  try {
    w.eval(read('public/launcher-adapter.js'));
    w.dispatchEvent(new w.Event('pageshow'));
    assert.match(w.document.getElementById('grandv-lobby-banner').textContent, /Lobby session missing or expired/);
    w.FiveWebI18n.setLanguage('tr');
    assert.match(w.document.getElementById('grandv-lobby-banner').textContent, /Lobi oturumu bulunamadı/);
  } finally { w.close(); }
});
test('actual voice runtime translates consent UI, errors and public-primary/own-backup notes without requesting media on language changes', async () => {
  const d = runtimeBoot('/game.html');
  const w = d.window;
  let prompts = 0;
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => { prompts++; return { getTracks: () => [], getAudioTracks: () => [] }; } } });
  w.RTCPeerConnection = class {
    createDataChannel() { w.queueMicrotask(() => this.onicecandidate({ candidate: { candidate: 'candidate:1 typ relay' } })); }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    setLocalDescription() { return Promise.resolve(); }
    close() {}
  };
  try {
    w.eval(read('public/voice.js'));
    const voice = w.FiveWebVoice.attach({ selfId: 'aaaaaaaaaaaaaaaa', iceConfig: { iceServers: [{ urls: 'turn:example.test' }], provider: 'public', fallbackIceServers: [{ urls: 'turn:backup.test' }] } });
    const box = w.document.getElementById('grandv-voice');
    assert.equal(box.getAttribute('aria-label'), 'Voice chat');
    assert.equal(box.querySelector('button').textContent, 'Join voice');
    w.FiveWebI18n.setLanguage('tr');
    assert.equal(box.querySelector('button').textContent, 'Sese katıl');
    assert.equal(prompts, 0);
    w.FiveWebI18n.setLanguage('en');
    box.querySelector('button').click(); await settle();
    assert.match(box.textContent, /Public TURN selected \(primary\)/);
    w.FiveWebI18n.setLanguage('tr');
    assert.match(box.textContent, /Genel TURN seçildi/);
    assert.equal(prompts, 1);
    voice.stop();
    const backup = w.FiveWebVoice.attach({ iceConfig: { iceServers: [{ urls: 'turn:backup.test' }], provider: 'backup' } });
    w.FiveWebI18n.setLanguage('en');
    w.document.querySelector('#grandv-voice button').click(); await settle();
    assert.match(w.document.getElementById('grandv-voice').textContent, /Own backup TURN selected/);
    backup.stop();
    Object.defineProperty(w.navigator.mediaDevices, 'getUserMedia', { value: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
    const denied = w.FiveWebVoice.attach();
    w.document.querySelector('#grandv-voice button').click(); await settle();
    assert.match(w.document.getElementById('grandv-voice').textContent, /Microphone permission denied/);
    denied.stop();
  } finally { w.close(); }
});
test('multiplayer display translates the player count (no fixed two-player cap)', () => {
  const d = runtimeBoot('/game.html?mode=sandbox&multiplayer=1', ['tr']);
  const w = d.window;
  try {
    const memory = { buffer: new w.SharedArrayBuffer(1024) };
    const v = new w.DataView(memory.buffer); v.setUint32(160, 0x424d5053, true); v.setUint32(164, 2, true);
    w.GTAPoseBridge = { read() {}, command() {} };
    w.fetch = () => new Promise(() => {});
    w.sessionStorage.setItem('gta5.multiplayer.pending.v1', JSON.stringify({ url: 'wss://fiveweb.test/relay', room: 'room', key: 'secret-test' }));
    w.eval(read('public/multiplayer-game.js'));
    const runtime = w.GTAMultiplayerGame.attach({ runtimeMain: true, memory, block: 128 });
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    assert.match(w.document.getElementById('grandv-mp-status').textContent, /Çok oyunculu: Başlatılıyor\nOyuncular: 0$/);
    w.FiveWebI18n.setLanguage('en');
    assert.match(w.document.getElementById('grandv-mp-status').textContent, /Multiplayer: Starting\nPlayers: 0$/);
    runtime.stop();
  } finally { w.close(); }
});
function boot(languages, language = 'en-US', saved) {
  const d = new JSDOM(read('public/index.html'), { url: 'https://fiveweb.test', runScripts: 'outside-only' });
  Object.defineProperty(d.window.navigator, 'languages', { value: languages });
  Object.defineProperty(d.window.navigator, 'language', { value: language });
  if (saved) d.window.localStorage.setItem('fiveweb.language', saved);
  const file = new URL('../public/i18n.js', import.meta.url);
  if (fs.existsSync(file)) d.window.eval(fs.readFileSync(file, 'utf8'));
  return d;
}
test('language follows first browser preference, falling back to navigator.language then English without persisting detection', () => {
  for (const [languages, language, expected] of [[['tr-TR'], 'en', 'tr'], [['tr'], 'en', 'tr'], [['en-US','tr'], 'tr', 'en'], [['de','tr'], 'tr', 'en'], [[], 'tr-TR','tr'], [undefined, undefined,'en']]) {
    const d = boot(languages, language);
    try {
      assert.ok(d.window.FiveWebI18n, 'same-origin i18n runtime must exist');
      assert.equal(d.window.FiveWebI18n.language, expected);
      assert.equal(d.window.document.documentElement.lang, expected);
      assert.equal(d.window.localStorage.getItem('fiveweb.language'), null);
    } finally { d.window.close(); }
  }
});

test('English browser gets translated static and dynamic UI, safe operator text, and an accessible persistent manual selector', async () => {
  const d = boot(['en-US']);
  const w = d.window, doc = w.document;
  try {
    w.fetch = async () => ({ ok: true, json: async () => ({ servers: [{ id: 'test', name: '<img src=x onerror=alert(1)>', description: 'Sunucular', connected: 1, capacity: 2, voice: true }] }) });
    w.eval(read('public/lobby.js'));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(doc.title, 'FiveWeb · Servers');
    assert.equal(doc.getElementById('servers-title').textContent, 'Servers');
    assert.equal(doc.getElementById('search').placeholder, 'Search servers, descriptions or tags');
    assert.equal(doc.querySelector('.row-select img'), null);
    assert.equal(doc.querySelector('.row-name').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(doc.querySelector('.row-desc').textContent, 'Sunucular');
    assert.equal(doc.querySelector('.badge').textContent, 'Open');
    const select = doc.getElementById('fiveweb-language');
    assert.ok(select && select.getAttribute('aria-label'));
    select.value = 'tr'; select.dispatchEvent(new w.Event('change'));
    assert.equal(doc.documentElement.lang, 'tr');
    assert.equal(doc.title, 'FiveWeb · Sunucular');
    doc.title = 'Mutated externally';
    select.value = 'en'; select.dispatchEvent(new w.Event('change'));
    assert.equal(doc.title, 'FiveWeb · Servers');
    select.value = 'tr'; select.dispatchEvent(new w.Event('change'));
    assert.equal(doc.title, 'FiveWeb · Sunucular');
    assert.equal(doc.querySelector('.badge').textContent, 'Açık');
    assert.equal(doc.querySelector('.row-desc').textContent, 'Sunucular');
    assert.equal(w.localStorage.getItem('fiveweb.language'), 'tr');
    assert.equal(w.FiveWebI18n.t('unknown', 'English fallback'), 'English fallback');
    assert.equal(w.FiveWebI18n.t('Unknown English key'), 'Unknown English key');
  } finally { w.close(); }
  const persisted = boot(['en'], 'en', 'tr');
  try { assert.equal(persisted.window.FiveWebI18n.language, 'tr'); } finally { persisted.window.close(); }
});
test('English browser localizes loading, empty, filtered, detail and error states including retry controls', async () => {
  const d = boot(['en']); const w = d.window, doc = w.document;
  let reply;
  try {
    w.fetch = () => new Promise(resolve => { reply = resolve; });
    w.eval(read('public/lobby.js'));
    assert.equal(doc.getElementById('list-meta').textContent, 'Loading…');
    reply({ ok: true, json: async () => ({ servers: [] }) }); await settle();
    assert.match(doc.getElementById('server-list').textContent, /No servers are open/);
    const refresh = w.FiveWebBrowser.refresh();
    reply({ ok: false }); await refresh;
    assert.match(doc.getElementById('list-notice').textContent, /Could not refresh/);
    const refresh2 = w.FiveWebBrowser.refresh();
    reply({ ok: true, json: async () => ({ servers: [{ id: 'open', name: 'Operator name', capacity: 2 }] }) }); await refresh2;
    w.FiveWebBrowser.selectServer('open');
    assert.equal(doc.getElementById('detail-tags').textContent, 'No tags');
    w.FiveWebBrowser.setFilter('full');
    assert.match(doc.getElementById('server-list').textContent, /No servers match your filters/);
  } finally { w.close(); }
  const e = boot(['en']);
  try {
    e.window.fetch = async () => { throw new Error('offline'); };
    e.window.eval(read('public/lobby.js')); await settle();
    assert.equal(e.window.document.querySelector('.error-box button').textContent, 'Try again');
  } finally { e.window.close(); }
});
test('multiplayer dynamic errors localize with codes preserved and language changes do not touch the socket', async () => {
  const d = runtimeBoot('/game.html?mode=sandbox&multiplayer=1', ['tr']); const w = d.window;
  let socketCount = 0, ws;
  try {
    const memory = { buffer: new w.SharedArrayBuffer(1024) };
    const v = new w.DataView(memory.buffer); v.setUint32(160, 0x424d5053, true); v.setUint32(164, 2, true);
    w.GTAPoseBridge = { read() {}, command() {} };
    w.fetch = async () => ({ json: async () => ({ build: 'build-test' }) });
    w.sessionStorage.setItem('gta5.multiplayer.pending.v1', JSON.stringify({ url: 'wss://fiveweb.test/relay', room: 'room', key: 'secret-test' }));
    w.eval(read('public/multiplayer-game.js'));
    w.GTAMultiplayerGame.attach({ runtimeMain: true, memory, block: 128 }, null, { createSocket() { socketCount++; ws = { readyState: 1, send() {}, close() {} }; return ws; } });
    w.document.dispatchEvent(new w.Event('DOMContentLoaded')); await settle();
    ws.onclose({ code: 1006 });
    assert.match(w.document.getElementById('grandv-mp-status').textContent, /Bağlantı kapandı \(1006\)/);
    w.FiveWebI18n.setLanguage('en');
    assert.match(w.document.getElementById('grandv-mp-status').textContent, /Connection closed \(1006\)/);
    assert.equal(socketCount, 1);
  } finally { w.close(); }
});
test('manual automatic mode removes only the explicit language preference and returns to browser language', () => {
  const d = boot(['en-US'], 'en-US', 'tr');
  try {
    const w = d.window;
    w.localStorage.setItem('unrelated', 'keep');
    const select = w.document.getElementById('fiveweb-language');
    select.value = 'auto'; select.dispatchEvent(new w.Event('change'));
    assert.equal(w.FiveWebI18n.language, 'en');
    assert.equal(w.localStorage.getItem('fiveweb.language'), null);
    assert.equal(w.localStorage.getItem('unrelated'), 'keep');
  } finally { d.window.close(); }
});
test('join errors and in-flight messages translate live without a second request or translating operator text', async () => {
  const d = boot(['en']); const w = d.window, doc = w.document;
  let finishJoin, joins = 0;
  try {
    w.fetch = async (url) => {
      if (url === '/api/servers') return { ok: true, json: async () => ({ servers: [{ id: 'open', name: '<b>Sunucular</b>', capacity: 2 }] }) };
      if (String(url).endsWith('/players')) return { ok: true, json: async () => ({ players: [] }) };
      joins++;
      return new Promise(resolve => { finishJoin = resolve; });
    };
    w.eval(read('public/lobby.js')); await settle();
    w.FiveWebBrowser.selectServer('open');
    doc.getElementById('nickname').value = 'Baris';
    doc.getElementById('join-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
    assert.equal(doc.getElementById('join-status').textContent, 'Joining <b>Sunucular</b>…');
    w.FiveWebI18n.setLanguage('tr');
    assert.equal(doc.getElementById('join-status').textContent, '<b>Sunucular</b> sunucusuna katılınıyor…');
    assert.equal(doc.getElementById('join-status').querySelector('b'), null);
    assert.equal(joins, 1);
    finishJoin({ ok: false, status: 403, json: async () => ({ error: 'Bu kaynaktan istek kabul edilmiyor.' }) }); await settle();
    w.FiveWebI18n.setLanguage('en');
    assert.equal(doc.getElementById('join-status').textContent, 'Requests from this origin are not allowed.');
  } finally { w.close(); }
});
test('same-origin runtime is routed and injected before lobby, adapter, voice and multiplayer; legacy optional fixtures remain loadable', () => {
  const assets = loadPublicAssets();
  assert.ok(assets.has('/__grandv/i18n.js'));
  const html = read('public/index.html');
  assert.ok(html.indexOf('/__grandv/i18n.js') < html.indexOf('/__lobby/lobby.js'));
  assert.ok(html.includes('/__grandv/i18n.js'));
  const launcher = injectAdapter(Buffer.from('<html><body></body></html>')).toString();
  assert.ok(launcher.includes('/__grandv/i18n.js'));
  assert.ok(launcher.indexOf('/__grandv/i18n.js') < launcher.indexOf('/__grandv/launcher-adapter.js'));
  const source = Buffer.from('<head></head><script>const playerKeys=new Set(["audiodiag",]);if(q.get("poseproof")!=="4")q.delete("poseproof");</script>');
  const game = transformGamePage(source, { voice: true, i18n: true }).body.toString();
  assert.ok(game.includes('/__grandv/i18n.js'));
  assert.ok(game.indexOf('/__grandv/i18n.js') < game.indexOf('/__grandv/voice.js'));
  assert.ok(game.indexOf('/__grandv/voice.js') < game.indexOf('/__grandv/multiplayer-game.js'));
});
