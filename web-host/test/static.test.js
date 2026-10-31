// Slice 4: game asset HTTP surface (static files, ranges, isolation headers, traversal and
// symlink containment, dotfile and backend denial, launcher adapter injection, lobby page).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startApp, rawRequest, SECRET_OUTSIDE } from './helpers.js';

const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('static: byte ranges, HEAD, MIME and isolation headers', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  const get = (p, headers = {}) => rawRequest(h.origin, { method: 'GET', path: p, headers });

  test('GET a file returns 200 with length, byte-range support and isolation headers', async () => {
    const res = await get('/data/test.bin');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '0123456789');
    assert.equal(res.headers['content-length'], '10');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    for (const [k, v] of Object.entries(ISOLATION)) assert.equal(res.headers[k], v, k);
  });

  test('isolation headers are present on errors too', async () => {
    const res = await get('/data/missing.bin');
    assert.equal(res.status, 404);
    for (const [k, v] of Object.entries(ISOLATION)) assert.equal(res.headers[k], v, k);
  });

  test('explicit range 2-5 is 206 with the exact slice and Content-Range', async () => {
    const res = await get('/data/test.bin', { Range: 'bytes=2-5' });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 2-5/10');
    assert.equal(res.body.toString(), '2345');
    assert.equal(res.headers['content-length'], '4');
  });

  test('suffix range -3 returns the last three bytes', async () => {
    const res = await get('/data/test.bin', { Range: 'bytes=-3' });
    assert.equal(res.status, 206);
    assert.equal(res.body.toString(), '789');
  });

  test('open-ended range 7- returns to the end', async () => {
    const res = await get('/data/test.bin', { Range: 'bytes=7-' });
    assert.equal(res.body.toString(), '789');
    assert.equal(res.headers['content-range'], 'bytes 7-9/10');
  });

  test('an end past EOF is clamped to the last byte', async () => {
    const res = await get('/data/test.bin', { Range: 'bytes=8-100' });
    assert.equal(res.status, 206);
    assert.equal(res.body.toString(), '89');
    assert.equal(res.headers['content-range'], 'bytes 8-9/10');
  });

  test('a start beyond EOF is 416 with bytes */size', async () => {
    const res = await get('/data/test.bin', { Range: 'bytes=10-' });
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */10');
  });

  test('multiple ranges and other units are 416, as in the Rust server', async () => {
    assert.equal((await get('/data/test.bin', { Range: 'bytes=0-1,3-4' })).status, 416);
    assert.equal((await get('/data/test.bin', { Range: 'items=0-1' })).status, 416);
  });

  test('HEAD returns the same headers with an empty body', async () => {
    const res = await rawRequest(h.origin, { method: 'HEAD', path: '/data/test.bin' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], '10');
    assert.equal(res.body.length, 0);
    for (const [k, v] of Object.entries(ISOLATION)) assert.equal(res.headers[k], v, k);
  });

  test('HEAD with a suffix range reports the partial length and no body', async () => {
    const res = await rawRequest(h.origin, { method: 'HEAD', path: '/data/test.bin', headers: { Range: 'bytes=-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '3');
    assert.equal(res.body.length, 0);
  });

  test('WASM is served as application/wasm; JS as text/javascript; HTML as text/html', async () => {
    assert.equal((await get('/test.wasm')).headers['content-type'], 'application/wasm');
    assert.equal((await get('/app.js')).headers['content-type'], 'text/javascript');
    assert.match((await get('/index.html')).headers['content-type'], /^text\/html/);
  });

  test('a directory serves its index.html', async () => {
    const res = await get('/data/sub');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'sub index');
  });

  test('a large file streams intact (6 MiB, sha256 matches)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    writeFileSync(path.join(h.fixture.root, 'big.bin'), big);
    const res = await get('/big.bin');
    assert.equal(res.status, 200);
    assert.equal(sha(res.body), sha(big));
    const part = await get('/big.bin', { Range: `bytes=1000-${1000 + 65535}` });
    assert.equal(sha(part.body), sha(big.subarray(1000, 1000 + 65536)));
  });

  test('non-GET/HEAD methods on asset paths are 404 (game writes are not served)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await rawRequest(h.origin, { method, path: '/data/test.bin', headers: { 'Content-Length': 0 } });
      assert.equal(res.status, 404, method);
    }
  });

  test('a missing file is a 404 with no directory listing', async () => {
    const res = await get('/data/');
    assert.equal(res.status, 400, 'trailing-slash directory paths are rejected like the Rust server');
    const none = await get('/nothing-here.txt');
    assert.equal(none.status, 404);
  });
});

describe('static: containment (traversal, symlinks, dotfiles, backend files)', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  const get = (p) => rawRequest(h.origin, { method: 'GET', path: p });
  const noSecret = (res) => assert.ok(!res.body.toString().includes(SECRET_OUTSIDE), 'secret not disclosed');

  test('encoded parent-directory traversal is refused with 400', async () => {
    for (const p of ['/data/%2e%2e/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/data/..%5c..%5csecret.txt', '/../secret.txt']) {
      const res = await get(p);
      assert.equal(res.status, 400, p);
      noSecret(res);
    }
  });

  test('empty segments, NUL bytes and invalid percent-encoding are refused with 400', async () => {
    assert.equal((await get('/data//test.bin')).status, 400);
    assert.equal((await get('/data/%00')).status, 400);
    assert.equal((await get('/%E0%A4%A')).status, 400);
  });

  test('a symlink that escapes the asset root is not served (404, no disclosure)', async () => {
    const res = await get('/escape.txt');
    assert.equal(res.status, 404);
    noSecret(res);
  });

  test('a symlink that stays inside the root is served', async () => {
    const res = await get('/inside.bin');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '0123456789');
  });

  test('dotfiles and dot-directories are never served', async () => {
    for (const p of ['/.env', '/data/.hidden', '/.git/config']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  test('backend and project files are never served even inside the asset root', async () => {
    const res = await get('/package.json');
    assert.equal(res.status, 404);
    assert.ok(!res.body.toString().includes('backend'));
  });

  test('userdata is not an HTTP API: every /userdata path is 404 for every method', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'POST']) {
      const res = await rawRequest(h.origin, { method, path: '/userdata/abc/profile.json', headers: { 'Content-Length': 0 } });
      assert.equal(res.status, 404, method);
    }
  });
});

describe('launcher and lobby surfaces', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('GET /launcher.html serves the original markup with the adapter injected before </body>', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/launcher.html' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    const text = res.body.toString('utf8');
    const tag = '<script src="/__grandv/launcher-adapter.js';
    const at = text.indexOf(tag);
    assert.ok(at > 0, 'adapter tag present');
    assert.ok(text.indexOf('</body>', at) > at, 'adapter precedes </body>');
    const i18nTag = '<script src="/__grandv/i18n.js"></script>';
    assert.ok(text.indexOf(i18nTag) >= 0 && text.indexOf(i18nTag) < at, 'i18n precedes adapter');
    assert.equal(text.replace(i18nTag, '').replace(/<script src="\/__grandv\/launcher-adapter\.js[^"]*"><\/script>/, ''), h.fixture.launcher, 'original markup preserved byte-for-byte apart from the two owned UI tags');
    assert.equal(Number(res.headers['content-length']), res.body.length);
  });

  test('the original launcher.html on disk is never modified', async () => {
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(path.join(h.fixture.root, 'launcher.html'), 'utf8'), h.fixture.launcher);
  });

  test('HEAD /launcher.html reports the injected length and no body', async () => {
    const get = await rawRequest(h.origin, { method: 'GET', path: '/launcher.html' });
    const head = await rawRequest(h.origin, { method: 'HEAD', path: '/launcher.html' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(get.body.length));
    assert.equal(head.body.length, 0);
  });

  test('the adapter script is served as JavaScript, compiles, and never writes credentials to localStorage', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/__grandv/launcher-adapter.js' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    const src = res.body.toString('utf8');
    assert.doesNotThrow(() => new vm.Script(src));
    assert.ok(src.includes('grandv.lobby.session.v1'));
    assert.ok(!/localStorage\s*\.\s*setItem/.test(src), 'adapter must not persist credentials in localStorage');
  });

  test('the lobby page is served at / as HTML and its assets under /__lobby/', async () => {
    const page = await rawRequest(h.origin, { method: 'GET', path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    const html = page.body.toString('utf8');
    assert.match(html, /<html[^>]*lang="tr"/);
    assert.match(html, /\/__lobby\/lobby\.js/);
    assert.match(html, /\/__lobby\/lobby\.css/);
    assert.match(html, /href="\/launcher\.html"/, 'link to singleplayer');
    assert.equal((await rawRequest(h.origin, { method: 'GET', path: '/__lobby/lobby.js' })).status, 200);
    assert.match((await rawRequest(h.origin, { method: 'GET', path: '/__lobby/lobby.css' })).headers['content-type'], /text\/css/);
  });

  test('/__hostinfo describes the relay without secrets', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/__hostinfo' });
    assert.equal(res.status, 200);
    const info = JSON.parse(res.body.toString('utf8'));
    assert.equal(info.build, '8b0b5899ed-replica-20261009-v1');
    assert.equal(info.protocol, 1);
    assert.equal(info.relay, '/relay');
    assert.equal(info.capacity, 128);
    assert.ok(!res.body.toString().toLowerCase().includes('key'));
  });
});
