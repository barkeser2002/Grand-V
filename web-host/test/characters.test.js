// Accounts, characters and money: the store (unit) and /api/account + character joins over
// real HTTP and WebSocket.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CharacterStore, AccountError } from '../src/characters.js';
import { startApp, api, connectRelay, BUILD } from './helpers.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const fast = { N: 1 }; // scrypt cost is fixed in the store; tests just use it
const CHAR = { firstName: 'Barış', lastName: 'Keser', gender: 'm', birthDate: '1995-04-12', nationality: 'Türk' };

function store(opts = {}) {
  return new CharacterStore({ now: () => NOW, ...opts });
}
const err = (status, code) => (e) => e instanceof AccountError && e.status === status && (!code || e.code === code);

describe('character store: accounts', () => {
  test('register, duplicate (case-insensitive) refused, login checks the password', () => {
    const s = store();
    const r = s.register('Baris_K', 'gizli-sifre-1');
    assert.equal(r.account.username, 'Baris_K');
    assert.ok(r.token.length >= 40);
    assert.equal(s.accountForToken(r.token).username, 'Baris_K');
    assert.throws(() => s.register('baris_k', 'baska-sifre-2'), err(409, 'TAKEN'));
    assert.throws(() => s.login('baris_k', 'yanlis-sifre'), err(401, 'LOGIN'));
    assert.throws(() => s.login('kimse', 'gizli-sifre-1'), err(401, 'LOGIN'));
    assert.ok(s.login('BARIS_K', 'gizli-sifre-1').token);
  });

  test('bad usernames and passwords are rejected; the password is never stored in clear', () => {
    const s = store();
    assert.throws(() => s.register('ab', 'gizli-sifre-1'), err(400));
    assert.throws(() => s.register('<script>', 'gizli-sifre-1'), err(400));
    assert.throws(() => s.register('baris', 'kisa'), err(400));
    s.register('baris', 'gizli-sifre-1');
    assert.ok(!JSON.stringify(s.data).includes('gizli-sifre-1'));
  });

  test('logout and expiry end the session', () => {
    let t = NOW;
    const s = new CharacterStore({ now: () => t, sessionTtlMs: 1000 });
    const a = s.register('baris', 'gizli-sifre-1');
    const b = s.login('baris', 'gizli-sifre-1');
    s.logout(a.token);
    assert.equal(s.accountForToken(a.token), null);
    assert.ok(s.accountForToken(b.token));
    t += 1001;
    assert.equal(s.accountForToken(b.token), null);
  });
});

describe('character store: characters and money', () => {
  function withChar() {
    const s = store();
    const { token } = s.register('baris', 'gizli-sifre-1');
    const acc = s.accountForToken(token);
    return { s, acc, c: s.createCharacter(acc.id, CHAR) };
  }

  test('a new character gets starter money, phone, account number and citizen id', () => {
    const { c } = withChar();
    assert.equal(c.fullName, 'Barış Keser');
    assert.equal(c.cash, 5000);
    assert.equal(c.bank, 25000);
    assert.equal(c.job, 'İşsiz');
    assert.equal(c.jobId, 'unemployed');
    assert.deepEqual([c.inventory, c.vehicles, c.houses], [[], [], []]);
    assert.match(c.phone, /^555-\d{4}$/);
    assert.match(c.accountNumber, /^FW\d{10}$/);
    assert.match(c.citizenId, /^FW[A-Z2-9]{6}$/);
  });

  test('validation: names, gender, dates, 18+ and slots', () => {
    const { s, acc } = withChar();
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, firstName: 'B' }), err(400));
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, lastName: '<b>x</b>' }), err(400));
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, gender: 'x' }), err(400));
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, birthDate: '1995-02-30' }), err(400));
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, birthDate: '2015-01-01' }), err(400));
    s.createCharacter(acc.id, { ...CHAR, firstName: 'Ayşe', gender: 'f' });
    s.createCharacter(acc.id, { ...CHAR, firstName: 'Mehmet' });
    assert.throws(() => s.createCharacter(acc.id, { ...CHAR, firstName: 'Fazla' }), err(409, 'SLOTS'));
  });

  test('deposit, withdraw and insufficient funds', () => {
    const { s, acc, c } = withChar();
    let v = s.deposit(acc.id, c.id, 2000);
    assert.deepEqual([v.cash, v.bank], [3000, 27000]);
    v = s.withdraw(acc.id, c.id, 7000);
    assert.deepEqual([v.cash, v.bank], [10000, 20000]);
    assert.throws(() => s.deposit(acc.id, c.id, 10001), err(409, 'FUNDS'));
    assert.throws(() => s.withdraw(acc.id, c.id, 20001), err(409, 'FUNDS'));
    assert.throws(() => s.deposit(acc.id, c.id, 0), err(400));
    assert.throws(() => s.deposit(acc.id, c.id, 1.5), err(400));
    assert.throws(() => s.deposit(acc.id, c.id, -5), err(400));
  });

  test('bank transfer between players by account number, with history on both sides', () => {
    const { s, acc, c } = withChar();
    const other = s.register('ayse', 'gizli-sifre-2');
    const oacc = s.accountForToken(other.token);
    const d = s.createCharacter(oacc.id, { ...CHAR, firstName: 'Ayşe', lastName: 'Yılmaz', gender: 'f' });
    const v = s.transfer(acc.id, c.id, d.accountNumber, 1500, 'Kira');
    assert.equal(v.bank, 23500);
    assert.equal(s.getCharacter(oacc.id, d.id).bank, 26500);
    assert.deepEqual(s.history(acc.id, c.id)[0], { at: new Date(NOW).toISOString(), type: 'transfer-out', amount: 1500, label: 'Kira', cash: 5000, bank: 23500, counterparty: 'Ayşe Yılmaz', account: d.accountNumber });
    assert.equal(s.history(oacc.id, d.id)[0].type, 'transfer-in');
    assert.throws(() => s.transfer(acc.id, c.id, 'FW0000000000', 10), err(404));
    assert.throws(() => s.transfer(acc.id, c.id, c.accountNumber, 10), err(400));
    assert.throws(() => s.transfer(acc.id, c.id, d.accountNumber, 999999), err(409, 'FUNDS'));
  });

  test("another account's character cannot be read, used or deleted", () => {
    const { s, c } = withChar();
    const other = s.accountForToken(s.register('ayse', 'gizli-sifre-2').token);
    assert.throws(() => s.getCharacter(other.id, c.id), err(404));
    assert.throws(() => s.withdraw(other.id, c.id, 10), err(404));
    assert.throws(() => s.deleteCharacter(other.id, c.id, 'Barış Keser'), err(404));
  });

  test('delete needs the full name; paychecks go to the bank', () => {
    const { s, acc, c } = withChar();
    assert.equal(s.pay(c.id, 250), true);
    assert.equal(s.getCharacter(acc.id, c.id).bank, 25250);
    assert.equal(s.history(acc.id, c.id)[0].label, 'Maaş');
    assert.equal(s.pay('0000000000000000', 250), false);
    assert.throws(() => s.deleteCharacter(acc.id, c.id, 'Barış'), err(400));
    s.deleteCharacter(acc.id, c.id, 'Barış Keser');
    assert.deepEqual(s.listCharacters(acc.id), []);
  });

  test('the store survives a restart through its file (mode 600, atomic write)', () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fw-chars-')), 'characters.json');
    const s = store({ file });
    const { token } = s.register('baris', 'gizli-sifre-1');
    const c = s.createCharacter(s.accountForToken(token).id, CHAR);
    s.flush();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const again = store({ file });
    const acc = again.accountForToken(token);
    assert.equal(acc.username, 'baris');
    assert.equal(again.getCharacter(acc.id, c.id).accountNumber, c.accountNumber);
  });
});

// ---- HTTP -----------------------------------------------------------------------------
const cookieOf = (res) => (res.headers['set-cookie'] || [])[0] || '';
const sessionCookie = (res) => cookieOf(res).split(';')[0];

describe('account API over HTTP', () => {
  let h;
  before(async () => { h = await startApp({ paycheckIntervalMs: 0 }); });
  after(() => h.close());
  const post = (p, json, cookie, origin = h.origin) => api(h.origin, 'POST', p, { json, headers: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const get = (p, cookie) => api(h.origin, 'GET', p, { headers: cookie ? { Cookie: cookie } : {} });

  test('register sets an HttpOnly SameSite=Strict cookie; the token is not in the body', async () => {
    const res = await post('/api/account/register', { username: 'barisk', password: 'gizli-sifre-1' });
    assert.equal(res.status, 201);
    const c = cookieOf(res);
    assert.match(c, /^fw_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    assert.ok(!res.text.includes(sessionCookie(res).split('=')[1]));
    assert.equal(res.data.account.username, 'barisk');
    const me = await get('/api/account/me', sessionCookie(res));
    assert.equal(me.status, 200);
    assert.deepEqual(me.data.account.characters, []);
  });

  test('state changes need an allowed Origin (CSRF) and a session', async () => {
    assert.equal((await post('/api/account/register', { username: 'x1y2z3', password: 'gizli-sifre-1' }, null, null)).status, 403);
    assert.equal((await post('/api/account/register', { username: 'x1y2z3', password: 'gizli-sifre-1' }, null, 'https://evil.example')).status, 403);
    assert.equal((await get('/api/account/me')).status, 401);
    assert.equal((await post('/api/account/characters', CHAR)).status, 401);
  });

  test('character create, bank actions and transactions; foreign characters are 404', async () => {
    const a = sessionCookie(await post('/api/account/login', { username: 'barisk', password: 'gizli-sifre-1' }));
    const created = await post('/api/account/characters', CHAR, a);
    assert.equal(created.status, 201);
    const id = created.data.character.id;
    const dep = await post(`/api/account/characters/${id}/bank`, { action: 'deposit', amount: 1000 }, a);
    assert.equal(dep.status, 200);
    assert.equal(dep.data.character.cash, 4000);
    assert.equal((await post(`/api/account/characters/${id}/bank`, { action: 'withdraw', amount: 99999999 }, a)).status, 400);
    assert.equal((await post(`/api/account/characters/${id}/bank`, { action: 'withdraw', amount: 999999 }, a)).status, 409);
    assert.equal((await post(`/api/account/characters/${id}/bank`, { action: 'steal', amount: 1 }, a)).status, 400);
    const tx = await get(`/api/account/characters/${id}/transactions`, a);
    assert.deepEqual(tx.data.transactions.map((x) => x.type), ['deposit', 'starter']);
    const b = sessionCookie(await post('/api/account/register', { username: 'ayse99', password: 'gizli-sifre-2' }));
    assert.equal((await get(`/api/account/characters/${id}`, b)).status, 404);
    assert.equal((await post(`/api/account/characters/${id}/bank`, { action: 'withdraw', amount: 1 }, b)).status, 404);
  });

  test('wrong password is 401 with one message for unknown users too; logout clears the cookie', async () => {
    const bad = await post('/api/account/login', { username: 'barisk', password: 'yanlis-sifre' });
    const none = await post('/api/account/login', { username: 'kimseyok', password: 'yanlis-sifre' });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, none.data.error);
    const a = sessionCookie(await post('/api/account/login', { username: 'barisk', password: 'gizli-sifre-1' }));
    const out = await post('/api/account/logout', {}, a);
    assert.match(cookieOf(out), /Max-Age=0/);
    assert.equal((await get('/api/account/me', a)).status, 401);
  });
});

describe('joining a server with a character', () => {
  let h;
  before(async () => { h = await startApp({ paycheckIntervalMs: 0 }); });
  after(() => h.close());
  const post = (p, json, cookie) => api(h.origin, 'POST', p, { json, headers: { Origin: h.origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const hello = (room, key) => ({ type: 'join', protocol: 1, room, key, build: BUILD, map: 'gta5' });

  async function player(username, firstName) {
    const cookie = sessionCookie(await post('/api/account/register', { username, password: 'gizli-sifre-1' }));
    const ch = (await post('/api/account/characters', { ...CHAR, firstName }, cookie)).data.character;
    return { cookie, ch };
  }

  test('the character name is the in-game name; other players see it; paychecks pay connected characters', async () => {
    const a = await player('oyuncu1', 'Ali');
    const b = await player('oyuncu2', 'Veli');
    assert.equal((await post('/api/servers/fiveweb-freeroam/join', { characterId: a.ch.id })).status, 401, 'needs the session');
    assert.equal((await post('/api/servers/fiveweb-freeroam/join', { characterId: a.ch.id }, b.cookie)).status, 404, 'not your character');
    const ja = await post('/api/servers/fiveweb-freeroam/join', { characterId: a.ch.id }, a.cookie);
    assert.equal(ja.status, 200);
    assert.deepEqual(ja.data.character, { id: a.ch.id, name: 'Ali Keser' });
    const jb = await post('/api/servers/fiveweb-freeroam/join', { characterId: b.ch.id }, b.cookie);
    const sa = await connectRelay(h.wsBase, h.origin);
    sa.send(hello(ja.data.lobby.id, ja.data.session.credential));
    await sa.type('welcome');
    const sb = await connectRelay(h.wsBase, h.origin);
    sb.send(hello(jb.data.lobby.id, jb.data.session.credential));
    const wb = await sb.type('welcome');
    assert.deepEqual(Object.values(wb.names), ['Ali Keser']);
    const joined = await sa.next((m) => m.type === 'joined');
    assert.equal(joined.name, 'Veli Keser');
    assert.equal((await post('/api/servers/fiveweb-freeroam/join', { characterId: a.ch.id }, a.cookie)).status, 409, 'already in game');
    assert.equal(h.app.paychecks(), 2);
    const me = await api(h.origin, 'GET', `/api/account/characters/${a.ch.id}`, { headers: { Cookie: a.cookie } });
    assert.equal(me.data.character.bank, 25150, 'unemployed salary');
    sa.close();
    sb.close();
  });

  test('a retried launch drops the old pending seat of the same character', async () => {
    const c = await player('oyuncu3', 'Cem');
    const first = await post('/api/servers/fiveweb-freeroam/join', { characterId: c.ch.id }, c.cookie);
    const second = await post('/api/servers/fiveweb-freeroam/join', { characterId: c.ch.id }, c.cookie);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello(first.data.lobby.id, first.data.session.credential));
    assert.equal((await s.waitClose()).reason, 'Join key rejected');
  });
});

describe('character store: economy (jobs, shop, vehicles, houses)', () => {
  function setup(t0 = NOW) {
    let t = t0;
    const s = new CharacterStore({ now: () => t });
    const acc = s.accountForToken(s.register('baris', 'gizli-sifre-1').token);
    const c = s.createCharacter(acc.id, CHAR);
    return { s, acc, c, tick: (ms) => { t += ms; } };
  }

  test('jobs: change, salary paid by job, cooldown', () => {
    const { s, acc, c, tick } = setup();
    const v = s.setJob(acc.id, c.id, 'police');
    assert.deepEqual([v.jobId, v.job, v.salary], ['police', 'Polis', 600]);
    assert.equal(s.salaryOf(c.id), 600);
    assert.throws(() => s.setJob(acc.id, c.id, 'taxi'), err(429, 'COOLDOWN'));
    assert.throws(() => s.setJob(acc.id, c.id, 'astronaut'), err(400));
    tick(600001);
    assert.equal(s.setJob(acc.id, c.id, 'taxi').job, 'Taksi şoförü');
  });

  test('shop: buy with cash or bank, stack limit, drop, give by phone number', () => {
    const { s, acc, c } = setup();
    let v = s.buyItem(acc.id, c.id, 'water', 3, 'cash');
    assert.equal(v.cash, 5000 - 15);
    v = s.buyItem(acc.id, c.id, 'phone', 1, 'bank');
    assert.equal(v.bank, 25000 - 450);
    assert.deepEqual(v.inventory, [{ id: 'water', name: 'Su', qty: 3 }, { id: 'phone', name: 'Telefon', qty: 1 }]);
    assert.throws(() => s.buyItem(acc.id, c.id, 'water', 48, 'cash'), err(409, 'FULL'));
    assert.throws(() => s.buyItem(acc.id, c.id, 'gold', 1, 'cash'), err(400));
    assert.throws(() => s.buyItem(acc.id, c.id, 'water', 1, 'credit'), err(400));
    assert.throws(() => s.buyItem(acc.id, c.id, 'lockpick', 30, 'cash'), err(409, 'FUNDS'));
    v = s.dropItem(acc.id, c.id, 'water', 1);
    assert.equal(v.inventory[0].qty, 2);
    const other = s.accountForToken(s.register('ayse', 'gizli-sifre-2').token);
    const d = s.createCharacter(other.id, { ...CHAR, firstName: 'Ayşe' });
    v = s.giveItem(acc.id, c.id, 'water', 2, d.phone);
    assert.deepEqual(v.inventory.map((x) => x.id), ['phone']);
    assert.deepEqual(s.getCharacter(other.id, d.id).inventory, [{ id: 'water', name: 'Su', qty: 2 }]);
    assert.throws(() => s.giveItem(acc.id, c.id, 'phone', 1, '555-0000'), err(404));
    assert.throws(() => s.giveItem(acc.id, c.id, 'phone', 2, d.phone), err(409));
  });

  test('vehicles: buy from bank with a unique plate, garage limit, resale at 50%', () => {
    const { s, acc, c } = setup();
    let v = s.buyVehicle(acc.id, c.id, 'blista');
    assert.equal(v.bank, 10000);
    assert.match(v.vehicles[0].plate, /^FW[A-Z2-9]{5}$/);
    assert.equal(v.vehicles[0].name, 'Dinka Blista');
    assert.throws(() => s.buyVehicle(acc.id, c.id, 'adder'), err(409, 'FUNDS'));
    v = s.sellVehicle(acc.id, c.id, v.vehicles[0].plate);
    assert.equal(v.bank, 17500);
    assert.deepEqual(v.vehicles, []);
    assert.throws(() => s.sellVehicle(acc.id, c.id, 'FWAAAAA'), err(404));
  });

  test('houses: one owner per house, catalog shows owned, resale', () => {
    const { s, acc, c } = setup();
    s.pay(c.id, 100000, 'test');
    let v = s.buyHouse(acc.id, c.id, 'grove-st');
    assert.equal(v.bank, 125000 - 80000);
    assert.deepEqual(v.houses, [{ id: 'grove-st', name: 'Grove Street ev' }]);
    assert.equal(s.catalog().houses.find((h) => h.id === 'grove-st').owned, true);
    const other = s.accountForToken(s.register('ayse', 'gizli-sifre-2').token);
    const d = s.createCharacter(other.id, { ...CHAR, firstName: 'Ayşe' });
    s.pay(d.id, 100000, 'test');
    assert.throws(() => s.buyHouse(other.id, d.id, 'grove-st'), err(409, 'TAKEN'));
    v = s.sellHouse(acc.id, c.id, 'grove-st');
    assert.equal(v.bank, 45000 + 40000);
    assert.equal(s.buyHouse(other.id, d.id, 'grove-st').houses.length, 1);
  });

  test('old saved characters (job text, no inventory) are migrated on read', () => {
    const { s, acc, c } = setup();
    const raw = s.data.characters[c.id];
    delete raw.jobId; delete raw.inventory; delete raw.vehicles; delete raw.houses; raw.job = 'İşsiz';
    const v = s.getCharacter(acc.id, c.id);
    assert.equal(v.jobId, 'unemployed');
    assert.deepEqual(v.inventory, []);
  });
});

describe('economy API over HTTP', () => {
  let h;
  before(async () => { h = await startApp({ paycheckIntervalMs: 0 }); });
  after(() => h.close());
  const post = (p, json, cookie) => api(h.origin, 'POST', p, { json, headers: { Origin: h.origin, ...(cookie ? { Cookie: cookie } : {}) } });

  test('catalog is public; job/items/vehicles/houses need the owner session and validate input', async () => {
    const cat = await api(h.origin, 'GET', '/api/account/catalog');
    assert.equal(cat.status, 200);
    assert.ok(cat.data.jobs.length >= 5 && cat.data.vehicles.length >= 5);
    const a = sessionCookie(await post('/api/account/register', { username: 'ekonomi1', password: 'gizli-sifre-1' }));
    const id = (await post('/api/account/characters', CHAR, a)).data.character.id;
    assert.equal((await post(`/api/account/characters/${id}/job`, { jobId: 'mechanic' }, a)).data.character.job, 'Tamirci');
    assert.equal((await post(`/api/account/characters/${id}/items`, { action: 'buy', itemId: 'bandage', qty: 2, method: 'cash' }, a)).data.character.cash, 4880);
    assert.equal((await post(`/api/account/characters/${id}/items`, { action: 'give', itemId: 'bandage', qty: 1, phone: 'abc' }, a)).status, 400);
    const car = await post(`/api/account/characters/${id}/vehicles`, { action: 'buy', model: 'bati' }, a);
    assert.equal(car.data.character.bank, 1000);
    assert.equal((await post(`/api/account/characters/${id}/houses`, { action: 'buy', houseId: 'sandy-trailer' }, a)).status, 409);
    assert.equal((await post(`/api/account/characters/${id}/vehicles`, { action: 'buy', model: '<x>' }, a)).status, 400);
    const b = sessionCookie(await post('/api/account/register', { username: 'ekonomi2', password: 'gizli-sifre-2' }));
    assert.equal((await post(`/api/account/characters/${id}/job`, { jobId: 'police' }, b)).status, 404);
    const contacts = await api(h.origin, 'GET', `/api/account/characters/${id}/contacts`, { headers: { Cookie: a } });
    assert.deepEqual(contacts.data, { contacts: [] });
  });
});

describe('public player list (before joining)', () => {
  let h;
  before(async () => { h = await startApp({ paycheckIntervalMs: 0 }); });
  after(() => h.close());
  test('names of joining and in-game players, no ids or credentials', async () => {
    const empty = await api(h.origin, 'GET', '/api/servers/fiveweb-freeroam/players');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.players, []);
    const j = await api(h.origin, 'POST', '/api/servers/fiveweb-freeroam/join', { json: { nickname: 'Ada' }, headers: { Origin: h.origin } });
    assert.equal(j.status, 200);
    let list = await api(h.origin, 'GET', '/api/servers/fiveweb-freeroam/players');
    assert.deepEqual(list.data.players, [{ name: 'Ada', state: 'joining' }]);
    const s = await connectRelay(h.wsBase, h.origin);
    s.send({ type: 'join', protocol: 1, room: j.data.lobby.id, key: j.data.session.credential, build: BUILD, map: 'gta5' });
    await s.type('welcome');
    list = await api(h.origin, 'GET', '/api/servers/fiveweb-freeroam/players');
    assert.deepEqual(list.data.players, [{ name: 'Ada', state: 'playing' }]);
    assert.ok(!list.text.includes(j.data.session.credential));
    assert.equal((await api(h.origin, 'GET', '/api/servers/nope-server/players')).status, 404);
    s.close();
  });
});
