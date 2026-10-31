// FiveWeb integration: brand routes and served pages, the game whitelist's server key, the
// launcher's server param, the resource-client loader (fake-DOM unit tests plus a real headless
// Chrome run over real HTTP), and the bsync-free fixture app. Nothing here touches the mirror.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp, rawRequest, SECRET_OUTSIDE } from './helpers.js';
import { loadPublicAssets } from '../src/public.js';
import { applyPersonalBrand, HIDDEN_IDS } from '../src/brand.js';
import { transformGamePage, RESOURCE_CLIENT_SRC } from '../src/game-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const BRAND = path.join(PUBLIC, 'brand');
const MIRROR = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SERVER = 'fiveweb-freeroam';

const ORIGINAL_LAUNCHER = [
  '<!doctype html><html><head><title>$GrandV — Local Launcher</title>',
  '<link rel="icon" href="/branding/grandv-logo.png?v=20261016"></head><body>',
  '<img src="/branding/grandv-logo.png?v=20261016" alt="$GrandV" class="logo">',
  '<h1>Launch GTA V.</h1>',
  '<button id="donate-open">Donate to $GrandV</button>',
  '<a id="grandv-tweet" href="#">Tweet $GrandV</a><a id="grandv-trade" href="#">Trade $GrandV</a>',
  '<div id="donate-dialog"></div>',
  '</body></html>',
].join('\n');

const FIXTURE_GAME = [
  '<!doctype html><html><head><title>g</title></head><body><script>',
  'const q = new URLSearchParams(location.search);',
  'const playerKeys=new Set(["audiodiag","mode", "poseproof"]);for(const key of [...q.keys()])if(!playerKeys.has(key))q.delete(key);if(q.get("poseproof")!=="4")q.delete("poseproof");',
  '</script></body></html>',
].join('\n');

describe('brand routes: fixed files only, correct type and bytes', () => {
  let h;
  const files = [
    ['fiveweb-logo.png', 'image/png'],
    ['fiveweb-icon.png', 'image/png'],
    ['fiveweb-icon.ico', 'image/x-icon'],
  ];
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('every prefix serves the exact bytes with the right MIME type', async () => {
    for (const prefix of ['/__brand/', '/__lobby/brand/', '/brand/']) {
      for (const [name, type] of files) {
        const res = await rawRequest(h.origin, { method: 'GET', path: prefix + name });
        assert.equal(res.status, 200, `${prefix}${name}`);
        assert.equal(res.headers['content-type'], type);
        assert.equal(Buffer.compare(res.body, readFileSync(path.join(BRAND, name))), 0, `${prefix}${name} bytes`);
        assert.equal(res.headers['content-length'], String(res.body.length));
      }
    }
  });

  test('HEAD returns headers without a body', async () => {
    const res = await rawRequest(h.origin, { method: 'HEAD', path: '/__brand/fiveweb-icon.png' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
  });

  test('traversal, encoded traversal and unlisted names never serve the secret or other files', async () => {
    const attempts = [
      '/__brand/../secret.txt',
      '/__brand/..%2fsecret.txt',
      '/__brand/%2e%2e%2fsecret.txt',
      '/brand/../../secret.txt',
      '/__brand/fiveweb-logo.svg',
      '/__brand/',
      '/brand/../lobby.js',
    ];
    for (const p of attempts) {
      const res = await rawRequest(h.origin, { method: 'GET', path: p });
      assert.ok(!res.body.toString('utf8').includes(SECRET_OUTSIDE), `${p} leaked the secret`);
      assert.notEqual(res.status, 200, `${p} should not serve a file`);
    }
  });

  test('POST to a brand route is refused', async () => {
    const res = await rawRequest(h.origin, { method: 'POST', path: '/__brand/fiveweb-icon.png', body: 'x', headers: { 'Content-Length': 1 } });
    assert.notEqual(res.status, 200);
  });
});

describe('brand routes: startup load with fixture and real public dirs', () => {
  test('a fixture public dir without brand/ still loads, and has no brand routes', () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fw-pub-'));
    for (const f of readdirSync(PUBLIC)) {
      if (statSync(path.join(PUBLIC, f)).isFile()) copyFileSync(path.join(PUBLIC, f), path.join(dir, f));
    }
    const assets = loadPublicAssets(dir);
    assert.equal(assets.has('/__brand/fiveweb-icon.png'), false);
    assert.equal(assets.has('/__grandv/resource-client.js?v=fw-1') || assets.has('/__grandv/resource-client.js'), true);
  });

  test('the real public dir loads all nine brand routes with the file bytes', () => {
    const assets = loadPublicAssets();
    for (const prefix of ['/__brand/', '/__lobby/brand/', '/brand/']) {
      for (const name of ['fiveweb-logo.png', 'fiveweb-icon.png', 'fiveweb-icon.ico']) {
        const asset = assets.get(prefix + name);
        assert.ok(asset, `${prefix}${name} missing`);
        assert.equal(Buffer.compare(asset.body, readFileSync(path.join(BRAND, name))), 0);
      }
    }
  });
});

describe('served launcher: FiveWeb icon, heading, hidden donate DOM, original on disk', () => {
  let h;
  before(async () => {
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'launcher.html'), ORIGINAL_LAUNCHER);
  });
  after(() => h.close());

  test('icon URLs point at the FiveWeb icon; wallets and donate text are unchanged', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/launcher.html' });
    const body = res.body.toString('utf8');
    assert.equal(body.split('href="/__brand/fiveweb-icon.png"').length - 1, 1, 'favicon');
    assert.equal(body.split('src="/__brand/fiveweb-icon.png"').length - 1, 1, 'logo');
    assert.ok(!body.includes('/branding/grandv-logo.png'));
    assert.ok(body.includes('<h1>FiveWeb Launcher</h1>'));
    assert.ok(!body.includes('Launch GTA V.'));
    assert.ok(body.includes('Donate to $GrandV'));
    assert.ok(body.includes('Tweet $GrandV'));
  });

  test('donate, tweet, trade and dialog elements stay in the DOM and are hidden by a fixed style', async () => {
    const body = (await rawRequest(h.origin, { method: 'GET', path: '/launcher.html' })).body.toString('utf8');
    for (const id of HIDDEN_IDS) assert.ok(body.includes(`id="${id}"`), `${id} removed`);
    const style = body.match(/<style id="fiveweb-brand-hide">([^<]*)<\/style>/);
    assert.ok(style, 'hide style block missing');
    for (const id of HIDDEN_IDS) assert.ok(style[1].includes(`#${id}`), `${id} not hidden`);
    assert.ok(style[1].includes('display:none !important'));
    assert.ok(body.indexOf('<style id="fiveweb-brand-hide">') < body.indexOf('</head>'));
  });

  test('the disk file is byte-identical after serving', () => {
    assert.equal(readFileSync(path.join(h.fixture.root, 'launcher.html'), 'utf8'), ORIGINAL_LAUNCHER);
  });

  test('pages without donate controls get no hide block (pure transform keeps plain input identical)', () => {
    const plain = Buffer.from('<html><head><title>Other</title></head><body>x</body></html>');
    assert.equal(Buffer.compare(applyPersonalBrand(plain), plain), 0);
  });
});

describe('game page: server key survives the whitelist, validated by the loader', () => {
  let h;
  before(async () => {
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'game.html'), FIXTURE_GAME);
  });
  after(() => h.close());

  test('served game keeps server and multiplayer, and still drops other unknown keys', async () => {
    const body = (await rawRequest(h.origin, { method: 'GET', path: '/game.html' })).body.toString('latin1');
    assert.match(body, /new Set\(\["audiodiag","multiplayer","server","mode"/);
    assert.ok(body.includes(RESOURCE_CLIENT_SRC));
  });

  test('the transform is pure: the resource client tag is injected once before </head>', () => {
    const out = transformGamePage(Buffer.from(FIXTURE_GAME, 'latin1')).body.toString('latin1');
    const tag = `<script src="${RESOURCE_CLIENT_SRC}"></script>`;
    assert.equal(out.split(tag).length - 1, 1);
  });
});

describe('launcher: server param survives launch (real mirror launch_url.js and launcher.js)', () => {
  const real = path.join(MIRROR, 'launcher.js');
  const skip = existsSync(real) ? false : 'mirror launcher.js not present';
  test('launchUrl keeps server and lobby params and never bypasses the GPU gate', { skip }, () => {
    const require = createRequire(real);
    const launcher = require(real);
    const settings = launcher.normalise({ mode: 'sandbox' });
    const url = launcher.launchUrl(`?lobby=abcdefghijklmnop&server=${SERVER}`, settings, 8);
    assert.ok(url.startsWith('game.html?'));
    const q = new URL(url, 'http://x/').searchParams;
    assert.equal(q.get('server'), SERVER);
    assert.equal(q.get('lobby'), 'abcdefghijklmnop');
    assert.equal(q.get('mode'), 'sandbox');
  });
});

// Loads the classic script in a sandbox and returns the factory it publishes on window.
function loadClient() {
  const window = { location: { search: '', origin: '' }, document: { readyState: 'loading', addEventListener() {} }, fetch() {}, addEventListener() {} };
  vm.runInNewContext(readFileSync(path.join(PUBLIC, 'resource-client.js'), 'utf8'), { window, console, URL, URLSearchParams, setTimeout, Object, Array });
  return window.FiveWebResourceClient;
}

describe('resource-client loader: fake DOM and importer (unit)', () => {
  const { createLoader, serverIdFrom } = loadClient();
  const ORIGIN = 'http://127.0.0.1:8097';
  const url = (file) => `/__resources/${SERVER}/welcome/${file}`;

  function fakeDocument() {
    const listeners = {};
    const mk = () => ({
      style: {}, textContent: '', id: '', children: [],
      setAttribute() {}, remove() {}, appendChild(c) { this.children.push(c); return c; },
    });
    const body = mk();
    return {
      readyState: 'complete',
      body,
      documentElement: body,
      createElement: () => mk(),
      addEventListener(t, f) { (listeners[t] ||= []).push(f); },
      dispatch(t) { for (const f of listeners[t] || []) f(); },
      listeners,
    };
  }

  function setup({ manifests, imports = {}, fetchOk = true, fetchDelay = null } = {}) {
    const doc = fakeDocument();
    const calls = { fetch: [], imports: [] };
    let release = null;
    const fetch = async (u) => {
      calls.fetch.push(u);
      if (fetchDelay) await new Promise((r) => { release = r; });
      return { ok: fetchOk, json: async () => manifests };
    };
    const importer = async (u) => {
      calls.imports.push(u);
      const v = imports[u];
      if (v instanceof Error) throw v;
      return v;
    };
    const warns = [];
    const loader = createLoader({
      location: { search: `?server=${SERVER}`, origin: ORIGIN },
      document: doc,
      fetch,
      importer,
      warn: (m, level) => warns.push([m, level]),
    });
    return { loader, doc, calls, warns, go: () => release && release() };
  }

  const manifest = (name, files) => ({
    resources: [{ name, version: '0.1.0', client: files.map((f) => ({ url: url(f) })) }],
  });

  test('no server or invalid server id: no loader, nothing runs', () => {
    assert.equal(serverIdFrom('?server=BAD_ID'), null);
    assert.equal(serverIdFrom('?server=x'), null);
    assert.equal(serverIdFrom(''), null);
    assert.equal(serverIdFrom(`?server=${SERVER}`), SERVER);
    assert.equal(createLoader({ location: { search: '', origin: ORIGIN }, document: fakeDocument(), fetch: null, importer: null }), null);
  });

  test('start -> status and notify -> stop: start and stop called once each, DOM cleared', async () => {
    const seen = [];
    const mod = {
      start(api) { seen.push('start'); api.setStatus('on'); api.notify('hi'); },
      stop(api) { seen.push('stop'); api.setStatus(''); },
    };
    const t = setup({ manifests: manifest('welcome', ['client.js']), imports: { [url('client.js')]: mod } });
    await t.loader.start();
    assert.equal(t.loader.state, 'started');
    assert.deepEqual(seen, ['start']);
    assert.equal(t.doc.body.children.length, 2, 'status and toast host appended');
    const status = t.doc.body.children[0];
    assert.equal(status.textContent, 'on');
    assert.ok(status.style.cssText.includes('left:12px;bottom:12px'), 'status is bottom-left');
    t.loader.stop();
    t.loader.stop();
    assert.deepEqual(seen, ['start', 'stop']);
    assert.equal(t.loader.state, 'stopped');
  });

  test('start is once-only: a second start does not refetch', async () => {
    const t = setup({ manifests: { resources: [] } });
    await t.loader.start();
    await t.loader.start();
    assert.equal(t.calls.fetch.length, 1);
  });

  test('a failing import does not block the next resource', async () => {
    const good = { start() {}, stop() {} };
    const t = setup({
      manifests: { resources: [{ name: 'a', version: '1.0.0', client: [{ url: `/__resources/${SERVER}/a/client.js` }] }, { name: 'welcome', version: '0.1.0', client: [{ url: url('client.js') }] }] },
      imports: { [`/__resources/${SERVER}/a/client.js`]: new Error('boom'), [url('client.js')]: good },
    });
    await t.loader.start();
    assert.deepEqual(t.calls.imports, [`/__resources/${SERVER}/a/client.js`, url('client.js')]);
    assert.ok(t.warns.some(([m]) => m.includes('a')), 'failure logged');
  });

  test('a throwing start does not block the rest, and stop still runs for it', async () => {
    const stops = [];
    const bad = { start() { throw new TypeError('x'); }, stop() { stops.push('bad'); } };
    const good = { start() {}, stop() { stops.push('good'); } };
    const t = setup({
      manifests: { resources: [{ name: 'welcome', version: '0.1.0', client: [{ url: url('bad.js') }, { url: url('good.js') }] }] },
      imports: { [url('bad.js')]: bad, [url('good.js')]: good },
    });
    await t.loader.start();
    t.loader.stop();
    assert.deepEqual(stops.sort(), ['bad', 'good']);
  });

  test('pagehide before the manifest fetch resolves: nothing is imported or started', async () => {
    let started = false;
    const t = setup({
      manifests: manifest('welcome', ['client.js']),
      imports: { [url('client.js')]: { start() { started = true; } } },
      fetchDelay: true,
    });
    const pending = t.loader.start();
    t.loader.stop();
    t.go();
    await pending;
    assert.equal(t.calls.imports.length, 0);
    assert.equal(started, false);
  });

  test('pagehide while an import is pending: the module never starts', async () => {
    let started = false;
    let resolveImport;
    const doc = fakeDocument();
    const loader = createLoader({
      location: { search: `?server=${SERVER}`, origin: ORIGIN },
      document: doc,
      fetch: async () => ({ ok: true, json: async () => manifest('welcome', ['client.js']) }),
      importer: () => new Promise((r) => { resolveImport = r; }),
    });
    const pending = loader.start();
    await new Promise((r) => setTimeout(r, 5));
    loader.stop();
    resolveImport({ start() { started = true; } });
    await pending;
    assert.equal(started, false);
  });

  test('cross-origin, wrong server, wrong resource, query and bad names are never imported', async () => {
    const t = setup({
      manifests: {
        resources: [{
          name: 'welcome',
          version: '0.1.0',
          client: [
            { url: 'https://evil.example/__resources/' + SERVER + '/welcome/client.js' },
            { url: `/__resources/other-server/welcome/client.js` },
            { url: `/__resources/${SERVER}/other/client.js` },
            { url: url('client.js') + '?x=1' },
            { url: `/__resources/${SERVER}/welcome/Bad%20Name.js` },
            { url: `/__resources/${SERVER}/welcome/../secret.js` },
            null,
          ],
        }],
      },
    });
    await t.loader.start();
    assert.deepEqual(t.calls.imports, []);
  });

  test('a manifest entry that is not an object or misses fields is skipped', async () => {
    const t = setup({ manifests: { resources: [null, { name: 1 }, { name: 'welcome', client: 'nope' }] } });
    await t.loader.start();
    assert.deepEqual(t.calls.imports, []);
  });

  test('the api object is frozen and calls after stop are no-ops', async () => {
    let api = null;
    const t = setup({ manifests: manifest('welcome', ['client.js']), imports: { [url('client.js')]: { start(a) { api = a; a.setStatus('live'); } } } });
    await t.loader.start();
    assert.ok(Object.isFrozen(api));
    assert.throws(() => { api.server = {}; }, TypeError);
    t.loader.stop();
    api.setStatus('late');
    api.notify('late');
    assert.equal(t.doc.body.children.length, 2);
    assert.equal(t.doc.body.children[0].textContent, '');
  });
});

describe('resource-client bootstrap: DOM readiness and pagehide in a sandbox', () => {
  function run({ readyState, manifests }) {
    const listeners = {};
    const document = {
      readyState,
      body: { children: [], appendChild(c) { this.children.push(c); return c; } },
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
      addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    };
    const windowListeners = {};
    const fetches = [];
    const window = {
      location: { search: `?server=${SERVER}`, origin: 'http://127.0.0.1:8097' },
      document,
      fetch: async (u) => { fetches.push(u); return { ok: true, json: async () => manifests }; },
      addEventListener(t, f) { (windowListeners[t] ||= []).push(f); },
    };
    const sandbox = { window, console, URL, URLSearchParams, setTimeout, Object, Array };
    vm.runInNewContext(readFileSync(path.join(PUBLIC, 'resource-client.js'), 'utf8'), sandbox);
    return { window, document, fetches, listeners, windowListeners };
  }

  test('publishes the factory and waits for DOMContentLoaded while the document is loading', async () => {
    const t = run({ readyState: 'loading', manifests: { resources: [] } });
    assert.equal(typeof t.window.FiveWebResourceClient.createLoader, 'function');
    assert.equal(t.fetches.length, 0, 'no fetch before the DOM is ready');
    for (const f of t.listeners.DOMContentLoaded || []) f();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(t.fetches, [`/api/servers/${SERVER}/resources`]);
  });

  test('starts immediately when the DOM is already ready and stops on pagehide', async () => {
    const t = run({ readyState: 'complete', manifests: { resources: [] } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.fetches.length, 1);
    assert.ok(t.windowListeners.pagehide && t.windowListeners.pagehide.length === 1);
  });

  test('without ?server= the page only publishes the factory', async () => {
    const listeners = {};
    const document = { readyState: 'complete', body: {}, addEventListener() {} };
    const fetches = [];
    const window = {
      location: { search: '', origin: 'http://127.0.0.1:8097' },
      document,
      fetch: async (u) => { fetches.push(u); return { ok: true, json: async () => ({ resources: [] }) }; },
      addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    };
    vm.runInNewContext(readFileSync(path.join(PUBLIC, 'resource-client.js'), 'utf8'), { window, console, URL, URLSearchParams, setTimeout, Object, Array });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(fetches.length, 0);
    assert.equal(listeners.pagehide, undefined);
  });
});

describe('resource-client in real headless Chrome over real HTTP', () => {
  const skip = existsSync(CHROME) ? false : `no Chrome at ${CHROME}`;
  let h;
  before(async () => {
    if (skip) return;
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'game.html'), FIXTURE_GAME);
  });
  after(async () => {
    if (h) await h.close();
  });

  // The query string the real launcher builds for a multiplayer launch (lobby + server).
  function launchQuery() {
    const real = path.join(MIRROR, 'launcher.js');
    const launcher = createRequire(real)(real);
    const url = launcher.launchUrl(`?lobby=abcdefghijklmnop&server=${SERVER}`, launcher.normalise({ mode: 'sandbox' }), 8);
    return new URL(url, 'http://x/').search;
  }

  function dump(url) {
    const profile = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fw-chrome-'));
    return new Promise((resolve, reject) => {
      execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', url], { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString('utf8'));
      });
    });
  }

  test('server param from the real launcher URL reaches the page: the welcome client shows its status', { skip }, async () => {
    const html = await dump(`${h.origin}/game.html${launchQuery()}`);
    assert.match(html, /id="fiveweb-resource-status"[^>]*>FiveWeb: fiveweb-freeroam sunucusuna hoş geldin\./);
    assert.match(html, /left:\s*12px;\s*bottom:\s*12px/, 'status is bottom-left');
  }, { timeout: 120_000 });

  test('no server param: the client does nothing', { skip }, async () => {
    const html = await dump(`${h.origin}/game.html?mode=sandbox`);
    assert.ok(!html.includes('fiveweb-resource-status'));
  }, { timeout: 120_000 });

  test('an invalid server id: nothing is fetched and no resource starts', { skip }, async () => {
    const html = await dump(`${h.origin}/game.html?server=../../etc`);
    assert.ok(!html.includes('fiveweb-resource-status'));
  }, { timeout: 120_000 });
});
