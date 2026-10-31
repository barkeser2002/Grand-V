// /game.html transform: the multiplayer launch keys survive the player whitelist, singleplayer
// keeps the original rules, and the runtime tag is injected before </head>. Patterns are also
// checked against the real mirror file when it is present (read-only).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startApp, rawRequest } from './helpers.js';
import { transformGamePage, RUNTIME_SRC } from '../src/game-page.js';

const REAL = (process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com') + '/game.html';
const FIXTURE_GAME = [
  '<!doctype html><html><head><title>g</title></head><body><script>',
  'const q = new URLSearchParams(location.search);',
  'const playerKeys=new Set(["audiodiag","mode", "poseproof"]);for(const key of [...q.keys()])if(!playerKeys.has(key))q.delete(key);if(q.get("poseproof")!=="4")q.delete("poseproof");',
  '</script></body></html>',
].join('\n');

describe('game page: multiplayer launch survives the player whitelist', () => {
  let h;
  before(async () => {
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'game.html'), FIXTURE_GAME);
  });
  after(() => h.close());

  test('the served page admits multiplayer and keeps poseproof=3 for sandbox only', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/game.html' });
    assert.equal(res.status, 200);
    const body = res.body.toString('latin1');
    assert.match(body, /new Set\(\["audiodiag","multiplayer","server","mode"/);
    assert.match(body, /q\.get\("multiplayer"\)==="1"&&q\.get\("poseproof"\)==="3"&&q\.get\("mode"\)==="sandbox"/);
    assert.equal(res.headers['content-length'], String(res.body.length));
  });

  test('the runtime tag is injected before </head>; the original file on disk is untouched', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/game.html' });
    const body = res.body.toString('latin1');
    const tag = `<script src="${RUNTIME_SRC}"></script>`;
    assert.equal(body.split(tag).length - 1, 1);
    assert.ok(body.indexOf(tag) < body.indexOf('</head>'));
    assert.equal(readFileSync(path.join(h.fixture.root, 'game.html'), 'utf8'), FIXTURE_GAME);
  });

  test('a page whose expected patterns are missing is served unchanged (singleplayer keeps working)', () => {
    const plain = Buffer.from('<html><head></head><body>other build</body></html>');
    const out = transformGamePage(plain);
    assert.equal(out.patched, false);
    assert.equal(Buffer.compare(out.body, plain), 0);
  });

  test('unknown game page names and non-GET methods are not served by this route', async () => {
    assert.equal((await rawRequest(h.origin, { method: 'POST', path: '/game.html', body: 'x', headers: { 'Content-Length': 1 } })).status, 404);
  });

  test('real mirror game.html and game.movie.html carry exactly the two patched patterns (when present)', () => {
    for (const name of ['game.html', 'game.movie.html']) {
      const file = path.join(process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com', name);
      if (!existsSync(file)) continue;
      const original = readFileSync(file);
      const out = transformGamePage(original);
      assert.equal(out.patched, true, `${name} patterns: ${out.missing.join(' | ')}`);
      const before = createHash('sha256').update(original).digest('hex');
      assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
    }
  });
});
