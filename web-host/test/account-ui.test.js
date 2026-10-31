// Account/character UI (public/account.js + lobby.js) and the in-game bank (game-hud.js) in
// JSDOM, against an in-memory fake of /api/account and /api/servers with the real store rules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { CharacterStore } from '../src/characters.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const ORIGIN = 'https://fiveweb.test';
const SERVERS = [{ id: 'fiveweb-freeroam', name: 'FiveWeb Freeroam', description: 'x', connected: 0, reserved: 0, capacity: 128, status: 'online', tags: [], resources: [], voice: true, compatibility: 'fiveweb-js-v1' }];
const flush = () => new Promise((r) => setTimeout(r, 30));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Fake backend: real CharacterStore, cookie kept in a closure (HttpOnly from the page's view).
function backend() {
  const store = new CharacterStore();
  let token = null;
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), method, body });
    const acc = store.accountForToken(token);
    try {
      if (url === '/api/servers') return json(200, { servers: SERVERS });
      if (url === '/api/account/register' || url === '/api/account/login') {
        const out = url.endsWith('register') ? store.register(body.username, body.password) : store.login(body.username, body.password);
        token = out.token;
        return json(200, { account: out.account });
      }
      if (url === '/api/account/logout') { token = null; return json(200, { ok: true }); }
      if (!acc) return json(401, { error: 'Giriş yapın.' });
      if (url === '/api/account/me') return json(200, { account: store.publicAccount(acc.id) });
      if (url === '/api/account/characters') return json(201, { character: store.createCharacter(acc.id, body) });
      let m = /^\/api\/account\/characters\/([0-9a-f]{16})\/bank$/.exec(url);
      if (m) {
        const c = body.action === 'deposit' ? store.deposit(acc.id, m[1], body.amount) : body.action === 'withdraw' ? store.withdraw(acc.id, m[1], body.amount) : store.transfer(acc.id, m[1], body.to, body.amount, body.note);
        return json(200, { character: c });
      }
      m = /^\/api\/account\/characters\/([0-9a-f]{16})\/transactions$/.exec(url);
      if (m) return json(200, { transactions: store.history(acc.id, m[1]) });
      m = /^\/api\/account\/characters\/([0-9a-f]{16})$/.exec(url);
      if (m && method === 'DELETE') { store.deleteCharacter(acc.id, m[1], body.confirm); return json(200, { ok: true }); }
      if (m) return json(200, { character: store.getCharacter(acc.id, m[1]) });
      m = /^\/api\/servers\/([a-z0-9-]+)\/join$/.exec(url);
      if (m) {
        const c = store.getCharacter(acc.id, body.characterId);
        return json(200, { lobby: { id: 'room-1', name: 'FiveWeb Freeroam' }, session: { role: 'host', credential: 'cred-123456', expiresAt: '2026-10-31T00:00:00.000Z' }, launchPath: '/launcher.html?lobby=room-1&server=fiveweb-freeroam', character: { id: c.id, name: c.fullName } });
      }
    } catch (err) {
      return json(err.status || 500, { error: err.message });
    }
    return json(404, { error: 'Bulunamadı.' });
  };
  return { store, fetch, calls, login: (u, p) => { token = store.login(u, p).token; } };
}

function browserPage(be) {
  const dom = new JSDOM(read('index.html'), { url: ORIGIN + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: ['tr-TR'] });
  w.fetch = be.fetch;
  const navigated = [];
  w.__fiveWebNavigate = (u) => navigated.push(u);
  w.eval(read('i18n.js'));
  w.eval(read('account.js'));
  w.eval(read('lobby.js'));
  return { w, doc: w.document, navigated, close: () => w.close() };
}
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', { cancelable: true }));
const CHAR = { first: 'Barış', last: 'Keser' };

describe('server browser: compact account summary', () => {
  test('logged out: no forms on the server page; Join opens the character screen', async () => {
    const be = backend();
    const h = browserPage(be);
    try {
      await flush();
      assert.equal(h.doc.querySelector('#account-panel form, #account-panel input'), null);
      assert.match(h.doc.getElementById('account-panel').textContent, /Giriş yap \/ Kayıt ol/);
      assert.equal(h.doc.getElementById('nickname').closest('.field').hidden, true);
      h.doc.querySelector('#server-list .row-select').click();
      submit(h.w, h.doc.getElementById('join-form'));
      await flush();
      assert.deepEqual(h.navigated, ['/character.html?server=fiveweb-freeroam']);
      assert.equal(be.calls.filter((c) => c.url.endsWith('/join')).length, 0);
    } finally { h.close(); }
  });

  test('logged in with a character: summary card, and Join sends only the characterId', async () => {
    const be = backend();
    const { token } = be.store.register('barisk', 'gizli-sifre-1');
    be.store.createCharacter(be.store.accountForToken(token).id, { firstName: 'Barış', lastName: 'Keser', gender: 'm', birthDate: '1995-04-12', nationality: 'Türk' });
    be.login('barisk', 'gizli-sifre-1');
    const h = browserPage(be);
    try {
      await flush();
      const panel = h.doc.getElementById('account-panel').textContent;
      assert.match(panel, /Hesap: barisk/);
      assert.match(panel, /Barış Keser/);
      assert.match(panel, /\$5,000/);
      assert.match(h.doc.getElementById('join-character').textContent, /Karakter: Barış Keser/);
      h.doc.querySelector('#server-list .row-select').click();
      submit(h.w, h.doc.getElementById('join-form'));
      await flush();
      const join = be.calls.find((c) => c.url.endsWith('/join'));
      assert.deepEqual(Object.keys(join.body), ['characterId']);
      const session = JSON.parse(h.w.sessionStorage.getItem('grandv.lobby.session.v1'));
      assert.equal(session.characterName, 'Barış Keser');
      assert.deepEqual(h.navigated, ['/launcher.html?lobby=room-1&server=fiveweb-freeroam']);
    } finally { h.close(); }
  });
});

describe('character screen (/character.html, ak4y theme)', () => {
  function mcPage(be, search = '?server=fiveweb-freeroam') {
    const dom = new JSDOM(read('mc/index.html'), { url: ORIGIN + '/character.html' + search, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    Object.defineProperty(w.navigator, 'languages', { value: ['tr-TR'] });
    w.fetch = be.fetch;
    const navigated = [];
    w.__fiveWebNavigate = (u) => navigated.push(u);
    w.eval(read('i18n.js'));
    w.eval(read('mc/fiveweb-mc.js'));
    return { w, doc: w.document, navigated, $: (id) => w.document.getElementById(id), close: () => w.close() };
  }

  test('sign up → create character → slot card and info panel → Play joins and launches', async () => {
    const be = backend();
    const h = mcPage(be);
    try {
      await flush();
      assert.equal(h.$('fw-auth').hidden, false);
      assert.ok(h.$('fw-general').classList.contains('fw-hidden'));
      h.$('fw-auth-switch').click();
      assert.equal(h.$('fw-auth-submit').textContent, 'KAYIT OL');
      h.$('fw-user').value = 'barisk';
      h.$('fw-pass').value = 'gizli-sifre-1';
      submit(h.w, h.$('fw-auth-form'));
      await flush();
      assert.equal(h.$('fw-auth').hidden, true);
      assert.ok(h.$('fw-create').classList.contains('fw-open'), 'no characters: create form opens');
      assert.equal(h.doc.querySelectorAll('#fw-slots .charItem').length, 3);
      h.$('fw-first').value = 'Barış';
      h.$('fw-last').value = 'Keser';
      h.doc.querySelector('.sexButton[data-sex="f"]').click();
      submit(h.w, h.$('fw-create'));
      await flush();
      const card = h.doc.querySelector('#fw-slots .charItem.active');
      assert.match(card.textContent, /Barış/);
      assert.match(card.textContent, /KADIN/);
      assert.equal(h.$('fw-info-name').textContent, 'Barış Keser');
      const info = h.$('fw-info-rows').textContent;
      assert.match(info, /\$5,000/);
      assert.match(info, /\$25,000/);
      assert.match(info, /FW\d{10}/);
      h.$('fw-play').click();
      await flush();
      assert.deepEqual(Object.keys(be.calls.find((c) => c.url.endsWith('/join')).body), ['characterId']);
      assert.deepEqual(h.navigated, ['/launcher.html?lobby=room-1&server=fiveweb-freeroam']);
      assert.equal(JSON.parse(h.w.sessionStorage.getItem('grandv.lobby.session.v1')).characterName, 'Barış Keser');
    } finally { h.close(); }
  });

  test('wrong password shows the server message; delete needs confirmation', async () => {
    const be = backend();
    const { token } = be.store.register('barisk', 'gizli-sifre-1');
    be.store.createCharacter(be.store.accountForToken(token).id, { firstName: 'Ali', lastName: 'Veli', gender: 'm', birthDate: '1990-01-01', nationality: 'Türk' });
    const h = mcPage(be);
    try {
      await flush();
      h.$('fw-user').value = 'barisk';
      h.$('fw-pass').value = 'yanlis-sifre';
      submit(h.w, h.$('fw-auth-form'));
      await flush();
      assert.match(h.$('fw-auth-error').textContent, /Kullanıcı adı veya şifre hatalı/);
      h.$('fw-pass').value = 'gizli-sifre-1';
      submit(h.w, h.$('fw-auth-form'));
      await flush();
      assert.equal(h.$('fw-info-name').textContent, 'Ali Veli');
      h.$('fw-delete-open').click();
      assert.equal(h.$('fw-delete').hidden, false);
      assert.equal(h.$('fw-delete-name').textContent, 'Ali Veli');
      h.$('fw-delete-cancel').click();
      assert.equal(be.calls.filter((c) => c.method === 'DELETE').length, 0);
      h.$('fw-delete-open').click();
      h.$('fw-delete-ok').click();
      await flush();
      assert.deepEqual(be.calls.find((c) => c.method === 'DELETE').body, { confirm: 'Ali Veli' });
      assert.ok(h.$('fw-create').classList.contains('fw-open'));
    } finally { h.close(); }
  });
});

describe('in-game bank (F6) and money badge', () => {
  function gamePage(be, characterId, name) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><canvas id="canvas"></canvas></body></html>', { url: ORIGIN + '/game.html?mode=sandbox&multiplayer=1', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    Object.defineProperty(w.navigator, 'languages', { value: ['tr-TR'] });
    const P = w.HTMLDialogElement.prototype;
    if (!P.showModal) { P.showModal = function () { this.setAttribute('open', ''); }; P.close = function () { this.removeAttribute('open'); }; }
    w.fetch = be.fetch;
    w.sessionStorage.setItem('grandv.lobby.session.v1', JSON.stringify({ id: 'room-1', characterId, characterName: name }));
    w.eval(read('i18n.js'));
    w.eval(read('game-hud.js'));
    const hud = w.__fiveWebHud || w.FiveWebHud.install({ mapIntervalMs: 60000 });
    return { w, doc: w.document, hud, close: () => { hud.stop(); w.close(); } };
  }

  test('badge shows cash and bank; deposit and transfer update balances and history', async () => {
    const be = backend();
    const a = be.store.register('barisk', 'gizli-sifre-1');
    const acc = be.store.accountForToken(a.token);
    const c = be.store.createCharacter(acc.id, { firstName: 'Barış', lastName: 'Keser', gender: 'm', birthDate: '1995-04-12', nationality: 'Türk' });
    const o = be.store.register('ayse99', 'gizli-sifre-2');
    const d = be.store.createCharacter(be.store.accountForToken(o.token).id, { firstName: 'Ayşe', lastName: 'Yılmaz', gender: 'f', birthDate: '1996-01-01', nationality: 'Türk' });
    be.login('barisk', 'gizli-sifre-1');
    const h = gamePage(be, c.id, 'Barış Keser');
    try {
      await flush();
      assert.match(h.doc.getElementById('fw-money').textContent, /\$5,000.*Banka \$25,000/);
      h.doc.getElementById('canvas').dispatchEvent(new h.w.KeyboardEvent('keydown', { code: 'F6', bubbles: true, cancelable: true }));
      await flush();
      const bank = h.doc.getElementById('fw-bank');
      assert.equal(bank.open, true);
      const forms = bank.querySelectorAll('form');
      forms[0].querySelector('input').value = '1000';
      submit(h.w, forms[0]);
      await flush();
      assert.match(h.doc.getElementById('fw-money').textContent, /\$4,000.*Banka \$26,000/);
      const tf = h.doc.getElementById('fw-bank').querySelectorAll('form')[2];
      const [to, note, amount] = tf.querySelectorAll('input');
      to.value = d.accountNumber; note.value = 'Kira'; amount.value = '500';
      submit(h.w, tf);
      await flush();
      assert.equal(be.store.getCharacter(acc.id, c.id).bank, 25500);
      assert.match(h.doc.getElementById('fw-bank').textContent, /Kira · Ayşe Yılmaz · −\$500/);
      const over = h.doc.getElementById('fw-bank').querySelectorAll('form')[1];
      over.querySelector('input').value = '999999';
      submit(h.w, over);
      await flush();
      assert.match(h.doc.querySelector('#fw-bank .fw-bank-status').textContent, /Banka bakiyesi yetersiz/);
    } finally { h.close(); }
  });

  test('without a character there is no bank button, badge or F6 action', async () => {
    const be = backend();
    const h = gamePage(be, null, '');
    try {
      await flush();
      assert.equal(h.doc.getElementById('fw-bank-open'), null);
      assert.equal(h.doc.getElementById('fw-money').hidden, true);
      assert.equal(be.calls.length, 0);
    } finally { h.close(); }
  });
});
