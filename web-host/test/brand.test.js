// Personal-edition brand transform: served launcher/game titles and logo alt read FiveWeb,
// donation/trade/tweet controls and game names stay as they are, and every file on disk is
// left byte-identical. Also checks the lobby page (public/index.html) brand text.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startApp, rawRequest } from './helpers.js';
import { applyPersonalBrand, PERSONAL_NAME } from '../src/brand.js';
import { injectAdapter } from '../src/launcher-page.js';
import { transformGamePage } from '../src/game-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const REAL_DIR = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const LAUNCHER_SNIPPET = [
  '<!doctype html><html><head><title>$GrandV — Local Launcher</title>',
  '<link rel="icon" href="/branding/grandv-logo.png?v=20261016"></head><body>',
  '<img src="/branding/grandv-logo.png?v=20261016" alt="$GrandV" class="logo">',
  '<h1>Launch GTA V.</h1>',
  '<button id="donate-open">Donate to $GrandV</button>',
  '<a id="grandv-tweet" href="https://x.com/intent/tweet?text=I%20am%20playing%20%24GrandV">Tweet $GrandV</a>',
  '<a id="grandv-trade" href="https://pump.fun/coin/DLsqjNExP7YBoiq39bTaCKygi5Kfo6HsSUtMoo5pump">Trade $GrandV</a>',
  '<img id="donate-qr" src="donations/solana.svg" alt="Solana donation QR code">',
  '</body></html>',
].join('\n');

describe('personal brand: pure source transform', () => {
  test('the personal name is exactly FiveWeb', () => {
    assert.equal(PERSONAL_NAME, 'FiveWeb');
  });

  test('title and logo alt are rewritten', () => {
    const out = applyPersonalBrand(Buffer.from(LAUNCHER_SNIPPET, 'utf8')).toString('utf8');
    assert.ok(out.includes('<title>FiveWeb — Local Launcher</title>'));
    assert.ok(out.includes('alt="FiveWeb" class="logo"'));
    assert.ok(!out.includes('<title>$GrandV'));
    assert.ok(!out.includes('alt="$GrandV"'));
  });

  test('donation, tweet and trade controls and the game name are left unchanged', () => {
    const out = applyPersonalBrand(Buffer.from(LAUNCHER_SNIPPET, 'utf8')).toString('utf8');
    assert.ok(out.includes('Donate to $GrandV'));
    assert.ok(out.includes('Tweet $GrandV'));
    assert.ok(out.includes('Trade $GrandV'));
    assert.ok(out.includes('pump.fun/coin/DLsqjNExP7YBoiq39bTaCKygi5Kfo6HsSUtMoo5pump'));
    assert.ok(!out.includes('Launch GTA V.'), 'visible h1 is replaced');
    assert.ok(out.includes('<h1>FiveWeb Launcher</h1>'));
    assert.ok(out.includes('src="donations/solana.svg"'));
    assert.ok(out.includes('alt="Solana donation QR code"'));
  });

  test('input without the brand patterns is returned byte-identical', () => {
    const plain = Buffer.from('<html><head><title>Other</title></head><body>x</body></html>');
    const out = applyPersonalBrand(plain);
    assert.equal(Buffer.compare(out, plain), 0);
  });

  test('the input buffer is not mutated', () => {
    const input = Buffer.from(LAUNCHER_SNIPPET, 'utf8');
    const before = sha(input);
    applyPersonalBrand(input);
    assert.equal(sha(input), before);
  });

  test('non-ASCII bytes survive the round trip', () => {
    const out = applyPersonalBrand(Buffer.from(LAUNCHER_SNIPPET, 'utf8')).toString('utf8');
    assert.ok(out.includes('—'));
  });

  test('branded launcher still gets the adapter tag byte-injected before </body>', () => {
    const branded = applyPersonalBrand(Buffer.from(LAUNCHER_SNIPPET, 'utf8'));
    const out = injectAdapter(branded).toString('utf8');
    assert.equal(out.split('launcher-adapter.js').length - 1, 1);
    assert.ok(out.indexOf('launcher-adapter.js') < out.indexOf('</body>'));
    assert.ok(out.includes('<title>FiveWeb'));
  });

  test('game page: brand applied, then the multiplayer patch still applies', () => {
    const game = [
      '<!doctype html><html><head><title>$GrandV</title></head><body><script>',
      'const q = new URLSearchParams(location.search);',
      'const playerKeys=new Set(["audiodiag","mode", "poseproof"]);',
      'if(q.get("poseproof")!=="4")q.delete("poseproof");',
      '</script></body></html>',
    ].join('\n');
    const out = transformGamePage(applyPersonalBrand(Buffer.from(game, 'latin1')));
    assert.equal(out.patched, true);
    const text = out.body.toString('latin1');
    assert.ok(text.includes('<title>FiveWeb</title>'));
    assert.ok(text.includes('new Set(["audiodiag","multiplayer","server","mode"'));
  });
});

describe('personal brand: served pages', () => {
  let h;
  const fixtureLauncher = LAUNCHER_SNIPPET;
  const fixtureGame = '<!doctype html><html><head><title>$GrandV</title></head><body>game</body></html>';
  before(async () => {
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'launcher.html'), fixtureLauncher);
    writeFileSync(path.join(h.fixture.root, 'game.html'), fixtureGame);
  });
  after(() => h.close());

  test('GET /launcher.html serves FiveWeb title and adapter; disk file unchanged', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/launcher.html' });
    assert.equal(res.status, 200);
    const body = res.body.toString('utf8');
    assert.ok(body.includes('<title>FiveWeb — Local Launcher</title>'));
    assert.ok(body.includes('alt="FiveWeb"'));
    assert.ok(body.includes('launcher-adapter.js'));
    assert.equal(res.headers['content-length'], String(res.body.length));
    assert.equal(readFileSync(path.join(h.fixture.root, 'launcher.html'), 'utf8'), fixtureLauncher);
  });

  test('GET /game.html serves FiveWeb title; disk file unchanged', async () => {
    const res = await rawRequest(h.origin, { method: 'GET', path: '/game.html' });
    assert.equal(res.status, 200);
    assert.ok(res.body.toString('latin1').includes('<title>FiveWeb</title>'));
    assert.equal(readFileSync(path.join(h.fixture.root, 'game.html'), 'utf8'), fixtureGame);
  });

  test('real mirror launcher/game files (when present): brand applies, disk bytes unchanged', () => {
    for (const name of ['launcher.html', 'game.html', 'game.movie.html']) {
      const file = path.join(REAL_DIR, name);
      if (!existsSync(file)) continue;
      const original = readFileSync(file);
      const before = sha(original);
      const out = applyPersonalBrand(original).toString('latin1');
      assert.ok(out.includes('FiveWeb'), `${name} has no FiveWeb`);
      assert.ok(!/<title>\$GrandV/.test(out), `${name} title still $GrandV`);
      const src = original.toString('latin1');
      const replaced = src.split('<title>$GrandV').length - 1 + src.split('alt="$GrandV"').length - 1;
      assert.equal(
        out.split('$GrandV').length - 1,
        src.split('$GrandV').length - 1 - replaced,
        `${name}: a $GrandV outside title/logo alt changed`,
      );
      assert.equal(sha(readFileSync(file)), before, `${name} changed on disk`);
    }
  });
});

describe('brand: lobby page public/index.html (UI worker owns the text)', () => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  test('the page title and visible brand read FiveWeb', () => {
    assert.match(html, /<title>[^<]*FiveWeb[^<]*<\/title>/);
    assert.ok(html.includes('FiveWeb'));
  });

  test('no personal BarisGrandV or Grand-V brand text remains in the lobby page', () => {
    assert.equal(html.split('BarisGrandV').length - 1, 0);
    assert.equal(html.split('Grand-V').length - 1, 0);
  });

  test('the served lobby page is the edited file', async () => {
    const h = await startApp();
    try {
      const res = await rawRequest(h.origin, { method: 'GET', path: '/' });
      assert.equal(res.status, 200);
      assert.match(res.body.toString('utf8'), /<title>[^<]*FiveWeb[^<]*<\/title>/);
    } finally {
      await h.close();
    }
  });
});
