// Behavioural tests for the FiveWeb server browser (public/index.html + lobby.js) in JSDOM.
// The backend is replaced by a fixture fetch; everything the user sees goes through the real DOM and script.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HTML = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SCRIPT = readFileSync(path.join(PUBLIC, 'lobby.js'), 'utf8');
const ORIGIN = 'https://fiveweb.royalnetwork.xyz';

const FIXTURE = [
  {
    id: 'srv-alpha', name: 'Akşam Sürüşü', description: 'Sakin harita, yavaş tempo.', connected: 1, reserved: 0,
    capacity: 2, status: 'online', tags: ['rp', 'sakin'], resources: [{ name: 'hud', version: '1.2.0' }],
    voice: true, compatibility: 'fiveweb-js-v1',
  },
  {
    id: 'srv-beta', name: 'Dolu Oda', description: 'İki kişilik tam oda.', connected: 2, reserved: 1,
    capacity: 2, status: 'full', tags: ['pvp'], resources: [], voice: false, compatibility: 'fiveweb-js-v1',
  },
];

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Fixture fetch. `handler(url, init)` returns a Response-like object or a promise of one.
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function boot({ serversHandler, joinHandler, navigate } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML, { url: ORIGIN + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === '/api/servers' && (!init.method || init.method === 'GET')) {
      return serversHandler ? serversHandler(calls.length) : Promise.resolve(jsonResponse(200, { servers: FIXTURE }));
    }
    if (joinHandler && /\/api\/servers\/.+\/join$/.test(String(url))) return joinHandler(String(url), init);
    return Promise.resolve(jsonResponse(404, { error: 'nope' }));
  };
  win.__fiveWebNavigate = navigate || (() => {});
  win.eval(SCRIPT);
  const doc = win.document;
  return { win, doc, calls, close: () => win.close() };
}

// Wait for queued promises and DOM work (no real timers involved).
const flush = () => new Promise((r) => setTimeout(r, 20));
const rows = (doc) => [...doc.querySelectorAll('#server-list .server-row')];
const rowText = (doc) => rows(doc).map((r) => r.textContent.replace(/\s+/g, ' ').trim());

describe('server browser: static markup (no lobby create, no old links)', () => {
  test('the page has no create-lobby form and no Donate/Tweet/Trade links', () => {
    assert.equal(/id="create-form"|Lobi oluştur|Donate|Tweet|Trade/i.test(HTML), false);
    assert.equal(/\/api\/lobbies/.test(SCRIPT), false, 'script must use the server contract only');
  });

  test('navigation is Sunucular / Kaynaklar / Launcher and singleplayer link is kept in the footer', () => {
    assert.match(HTML, />Sunucular</);
    assert.match(HTML, />Kaynaklar</);
    assert.match(HTML, />Launcher</);
    assert.match(HTML, /href="\/launcher\.html"/);
  });

  test('the brand fallback is text FW; no hard-wired img that could break', () => {
    assert.match(HTML, /<span class="brand-mark" id="brand-mark" aria-hidden="true">FW<\/span>/);
    assert.equal(/<img/.test(HTML), false);
  });
});

describe('server browser: list rendering from GET /api/servers', () => {
  test('rows show name, description, tags, connected/reserved/capacity and the honest 2-player label', async () => {
    const h = boot();
    try {
      await flush();
      assert.equal(rows(h.doc).length, 2);
      const alpha = rowText(h.doc)[0];
      assert.match(alpha, /Akşam Sürüşü/);
      assert.match(alpha, /Sakin harita, yavaş tempo\./);
      assert.match(alpha, /rp · sakin/);
      assert.match(alpha, /1 \/ 2 bağlı · rezerve 0/);
      assert.match(h.doc.querySelector('.chip').textContent, /Deneysel · 128 oyuncu/);
      const pageText = h.doc.body.textContent;
      assert.equal(/\b(32|64)\s*oyuncu/i.test(pageText), false, 'never invent 32/64 capacity');
    } finally { h.close(); }
  });

  test('full servers show Dolu and a disabled join button', async () => {
    const h = boot();
    try {
      await flush();
      const full = rows(h.doc)[1];
      assert.match(full.querySelector('.badge').textContent, /Dolu/);
      const join = full.querySelector('.row-side button');
      assert.equal(join.textContent, 'Dolu');
      assert.equal(join.disabled, true);
    } finally { h.close(); }
  });

  test('empty backend list shows the honest empty state, not fake rows', async () => {
    const h = boot({ serversHandler: () => Promise.resolve(jsonResponse(200, { servers: [] })) });
    try {
      await flush();
      assert.equal(rows(h.doc).length, 0);
      assert.match(h.doc.getElementById('server-list').textContent, /Şu an açık sunucu yok/);
      assert.match(h.doc.getElementById('list-meta').textContent, /Sunucu yok/);
    } finally { h.close(); }
  });

  test('malformed rows are dropped and server text is never parsed as HTML', async () => {
    const evil = { ...FIXTURE[0], id: 'srv-evil', name: '<img src=x onerror=alert(1)>' };
    const h = boot({ serversHandler: () => Promise.resolve(jsonResponse(200, { servers: [null, { id: 3 }, evil] })) });
    try {
      await flush();
      assert.equal(rows(h.doc).length, 1);
      assert.equal(h.doc.querySelector('#server-list img'), null);
      assert.match(rowText(h.doc)[0], /<img src=x onerror=alert\(1\)>/);
    } finally { h.close(); }
  });

  test('error state shows a retry button, and retry issues a new request', async () => {
    let n = 0;
    const h = boot({
      serversHandler: () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(jsonResponse(200, { servers: FIXTURE }));
      },
    });
    try {
      await flush();
      assert.match(h.doc.getElementById('server-list').textContent, /Sunucular yüklenemedi/);
      h.doc.querySelector('#server-list .error-box button').click();
      await flush();
      assert.equal(rows(h.doc).length, 2);
    } finally { h.close(); }
  });
});

describe('server browser: filter, search, selection', () => {
  test('filter buttons and search narrow the list and expose aria-pressed', async () => {
    const h = boot();
    try {
      await flush();
      const dolu = h.doc.querySelector('[data-filter="full"]');
      dolu.click();
      assert.equal(dolu.getAttribute('aria-pressed'), 'true');
      assert.deepEqual(rowText(h.doc).map((t) => t.split(' ')[0]), ['Dolu']);
      h.doc.querySelector('[data-filter="all"]').click();
      const search = h.doc.getElementById('search');
      search.value = 'sürüş';
      search.dispatchEvent(new h.win.Event('input'));
      assert.equal(rows(h.doc).length, 1);
      search.value = 'nothing-matches';
      search.dispatchEvent(new h.win.Event('input'));
      assert.match(h.doc.getElementById('server-list').textContent, /Filtreye uyan sunucu yok/);
    } finally { h.close(); }
  });

  test('selecting a server shows its detail: resources, voice note and compatibility', async () => {
    const h = boot();
    try {
      await flush();
      rows(h.doc)[0].querySelector('.row-select').click();
      assert.equal(h.doc.getElementById('detail-body').hidden, false);
      assert.equal(h.doc.getElementById('detail-title').textContent, 'Akşam Sürüşü');
      assert.match(h.doc.getElementById('detail-resources').textContent, /hud · 1\.2\.0/);
      assert.match(h.doc.getElementById('detail-voice').textContent, /isteğe bağlı/);
      assert.match(h.doc.getElementById('detail-voice').textContent, /kamera kullanılmaz/);
      assert.match(h.doc.body.textContent, /fiveweb-js-v1/);
      assert.equal(rows(h.doc)[0].querySelector('.row-select').getAttribute('aria-pressed'), 'true');
    } finally { h.close(); }
  });
});

describe('server browser: joining', () => {
  const LAUNCH = '/launcher.html?lobby=room-123&server=srv-alpha';
  const JOIN_OK = {
    lobby: { id: 'room-123', name: 'Akşam Sürüşü' },
    session: { role: 'player', credential: 'cred-SECRET-VALUE', expiresAt: '2026-10-31T00:00:00.000Z' },
    launchPath: LAUNCH,
  };

  test('nickname is required before join and nothing is posted', async () => {
    const h = boot({ joinHandler: () => { throw new Error('must not post'); } });
    try {
      await flush();
      rows(h.doc)[0].querySelector('.row-select').click();
      h.doc.getElementById('nickname').value = ' a ';
      h.doc.getElementById('join-form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
      assert.match(h.doc.getElementById('join-status').textContent, /2–20 karakter/);
      assert.equal(h.calls.filter((c) => c.init.method === 'POST').length, 0);
    } finally { h.close(); }
  });

  test('a successful join posts the nickname, stores only the session in sessionStorage and redirects', async () => {
    let posted = null;
    const navigated = [];
    const h = boot({
      joinHandler: (url, init) => { posted = { url, body: JSON.parse(init.body) }; return Promise.resolve(jsonResponse(201, JOIN_OK)); },
      navigate: (u) => navigated.push(u),
    });
    try {
      await flush();
      rows(h.doc)[0].querySelector('.row-select').click();
      h.doc.getElementById('nickname').value = 'Ada  Lovelace';
      h.doc.getElementById('join-form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
      await flush();
      assert.equal(posted.url, '/api/servers/srv-alpha/join');
      assert.deepEqual(posted.body, { nickname: 'Ada Lovelace' });
      assert.deepEqual(navigated, [LAUNCH]);
      const stored = JSON.parse(h.win.sessionStorage.getItem('grandv.lobby.session.v1'));
      assert.deepEqual(stored, {
        id: 'room-123', name: 'Akşam Sürüşü', role: 'player', credential: 'cred-SECRET-VALUE',
        expiresAt: '2026-10-31T00:00:00.000Z', serverId: 'srv-alpha',
      });
      assert.equal(h.win.localStorage.getItem('grandv.lobby.session.v1'), null, 'no credential in localStorage');
      assert.equal(h.win.localStorage.getItem('grandv.lobby.nickname'), 'Ada Lovelace');
      assert.equal(h.win.location.href.includes('cred-SECRET'), false, 'no credential in the URL');
      assert.equal(JSON.stringify([...Object.entries(h.win.localStorage)]).includes('cred-SECRET'), false);
    } finally { h.close(); }
  });

  test('an invalid launchPath is refused: no session stored, no redirect', async () => {
    const navigated = [];
    const h = boot({
      joinHandler: () => Promise.resolve(jsonResponse(201, { ...JOIN_OK, launchPath: 'https://evil.test/x' })),
      navigate: (u) => navigated.push(u),
    });
    try {
      await flush();
      rows(h.doc)[0].querySelector('.row-select').click();
      h.doc.getElementById('nickname').value = 'Ada';
      h.doc.getElementById('join-form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
      await flush();
      assert.deepEqual(navigated, []);
      assert.equal(h.win.sessionStorage.getItem('grandv.lobby.session.v1'), null);
      assert.match(h.doc.getElementById('join-status').textContent, /geçersiz yanıt/);
    } finally { h.close(); }
  });

  test('a 409 from the join endpoint shows the full message and refreshes the list', async () => {
    const h = boot({ joinHandler: () => Promise.resolve(jsonResponse(409, { error: 'x' })) });
    try {
      await flush();
      rows(h.doc)[0].querySelector('.row-select').click();
      h.doc.getElementById('nickname').value = 'Ada';
      h.doc.getElementById('join-form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
      await flush();
      assert.match(h.doc.getElementById('join-status').textContent, /Sunucu dolu/);
      assert.equal(h.doc.getElementById('join-submit').disabled, false);
      assert.ok(h.calls.filter((c) => c.url === '/api/servers').length >= 2, 'list refreshed after conflict');
    } finally { h.close(); }
  });

  test('a join without a selected server is refused', async () => {
    const h = boot();
    try {
      await flush();
      h.doc.getElementById('nickname').value = 'Ada';
      h.doc.getElementById('join-form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
      assert.match(h.doc.getElementById('join-status').textContent, /Önce bir sunucu seçin/);
    } finally { h.close(); }
  });
});

describe('server browser: polling keeps the page stable', () => {
  test('a poll keeps row nodes and focus, and does not bring back the skeleton', async () => {
    const h = boot();
    try {
      await flush();
      const before = rows(h.doc)[0];
      const join = before.querySelector('.row-side button');
      join.focus();
      assert.equal(h.doc.activeElement, join);
      await h.win.FiveWebBrowser.refresh();
      await flush();
      assert.equal(rows(h.doc)[0], before, 'same DOM node after poll');
      assert.equal(h.doc.activeElement, join, 'focus preserved');
      assert.equal(h.doc.querySelectorAll('.skeleton').length, 0, 'no skeleton flash');
    } finally { h.close(); }
  });

  test('a failed poll keeps the last list and shows a notice', async () => {
    let n = 0;
    const h = boot({
      serversHandler: () => {
        n += 1;
        return n === 1 ? Promise.resolve(jsonResponse(200, { servers: FIXTURE })) : Promise.reject(new Error('down'));
      },
    });
    try {
      await flush();
      await h.win.FiveWebBrowser.refresh();
      await flush();
      assert.equal(rows(h.doc).length, 2);
      assert.equal(h.doc.getElementById('list-notice').hidden, false);
      assert.match(h.doc.getElementById('list-notice').textContent, /son bilinen liste/);
    } finally { h.close(); }
  });

  test('a stale response that resolves after a newer one is ignored', async () => {
    const slow = deferred();
    const fast = deferred();
    let n = 0;
    const h = boot({
      serversHandler: () => {
        n += 1;
        if (n === 1) return Promise.resolve(jsonResponse(200, { servers: [] }));
        return n === 2 ? slow.promise : fast.promise;
      },
    });
    try {
      await flush();
      const older = h.win.FiveWebBrowser.refresh();
      const newer = h.win.FiveWebBrowser.refresh();
      fast.resolve(jsonResponse(200, { servers: [FIXTURE[0]] }));
      await newer;
      slow.resolve(jsonResponse(200, { servers: FIXTURE }));
      await older;
      await flush();
      assert.equal(rows(h.doc).length, 1, 'older response must not overwrite newer data');
    } finally { h.close(); }
  });
});

describe('server browser: brand icon and contrast polish (source checks)', () => {
  const CSS = readFileSync(path.join(PUBLIC, 'lobby.css'), 'utf8');

  test('favicon is the FiveWeb icon, not an empty data: URL', () => {
    assert.match(HTML, /<link rel="icon" href="\/__brand\/fiveweb-icon\.png">/);
    assert.equal(/rel="icon"\s+href="data:,"/.test(HTML), false);
  });

  test('brand image loads the square icon, never the wide wordmark', () => {
    assert.match(SCRIPT, /const BRAND_ICON_URL = '\/__brand\/fiveweb-icon\.png';/);
    assert.equal(/fiveweb-logo\.png/.test(SCRIPT), false, 'lobby.js must not reference the wordmark');
    assert.equal(/fiveweb-logo\.png/.test(HTML), false, 'index.html must not reference the wordmark');
    assert.match(SCRIPT, /probe\.src = BRAND_ICON_URL;/);
    assert.match(SCRIPT, /img\.src = BRAND_ICON_URL;/);
  });

  test('the text FW fallback stays when the icon does not load', () => {
    assert.match(SCRIPT, /probe\.onload = \(\) => \{/);
    assert.equal(/probe\.onerror/.test(SCRIPT), false, 'fallback is simply to keep the FW text');
    assert.match(HTML, /aria-hidden="true">FW<\/span>/);
  });

  test('the 40px brand image fits the whole icon with padding (object-fit: contain)', () => {
    const rule = CSS.match(/\.brand-img \{[^}]*\}/);
    assert.ok(rule, '.brand-img rule exists');
    assert.match(rule[0], /object-fit: contain/);
    assert.equal(/object-fit: cover/.test(rule[0]), false);
    assert.match(rule[0], /padding: 4px/);
    assert.match(rule[0], /width: 40px/);
    assert.match(rule[0], /height: 40px/);
  });

  test('primary button label is very dark (#15161a) on the orange gradient', () => {
    assert.match(CSS, /\.btn\.primary \{ color: #15161a;/);
    assert.equal(/\.btn\.primary \{ color: #1a0c02/.test(CSS), false);
  });

  test('primary button keeps the dark label on hover and focus-visible', () => {
    assert.match(CSS, /\.btn\.primary:hover:not\(:disabled\) \{[^}]*filter: brightness\(1\.07\)/);
    assert.match(CSS, /\.btn\.primary:focus-visible \{[^}]*color: #15161a/);
    assert.match(CSS, /\.btn\.primary:focus-visible \{[^}]*box-shadow: var\(--focus\)/);
  });

  test('primary label contrast against the orange start/end colours meets WCAG AA (4.5:1)', () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    assert.ok(ratio('#15161a', '#ff7a1a') >= 4.5, 'accent');
    assert.ok(ratio('#15161a', '#ffb36b') >= 4.5, 'accent-2');
  });
});

describe('server browser: online players before joining', () => {
  test('the player list and hero counters fill from the API; names are text', async () => {
    const h = boot();
    const base = h.win.fetch;
    h.win.fetch = (url, init) => String(url).endsWith('/players')
      ? Promise.resolve(jsonResponse(200, { players: [{ name: 'Ali Keser', state: 'playing' }, { name: '<img src=x>', state: 'joining' }] }))
      : base(url, init);
    try {
      await flush();
      await h.win.FiveWebBrowser.loadPlayers();
      await flush();
      const items = [...h.doc.querySelectorAll('#player-list .player')];
      assert.equal(items.length, 2);
      assert.match(items[0].textContent, /Ali Keser/);
      assert.match(items[0].textContent, /Oyunda/);
      assert.equal(items[0].querySelector('.avatar').textContent, 'AK');
      assert.equal(h.doc.querySelector('#player-list img'), null);
      assert.equal(h.doc.getElementById('players-count').textContent, '2');
      assert.ok(Number(h.doc.getElementById('hero-servers').dataset.value) >= 1);
    } finally { h.close(); }
  });
});
