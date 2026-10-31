// FiveWeb accounts, characters and money (GTA Online style, FiveM-like fields).
// Server-authoritative: balances only change here. Passwords are scrypt hashes, session
// tokens are stored as SHA-256 digests. The whole store is one JSON file written atomically.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanAppearance } from './appearance.js';

export const ECONOMY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'economy.json');
export function loadEconomy(file = ECONOMY_FILE) {
  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['jobs', 'items', 'vehicles', 'houses']) {
    if (!Array.isArray(e[key]) || !e[key].length) throw new Error(`economy.${key} boş olamaz`);
  }
  if (!e.jobs.some((j) => j.id === 'unemployed')) throw new Error('economy.jobs içinde unemployed olmalı');
  return e;
}

export class AccountError extends Error {
  constructor(status, message, code = 'INVALID') {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
  }
}

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const NAME_RE = /^\p{L}[\p{L}' -]{0,18}\p{L}$/u;
const NATION_RE = /^\p{L}[\p{L} ]{1,22}\p{L}$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DEFAULTS = Object.freeze({
  slots: 3,
  starterCash: 5_000,
  starterBank: 25_000,
  paycheck: 250,
  maxAmount: 10_000_000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  historyLimit: 50,
  maxAccounts: 50_000,
});

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hashPassword = (password, salt) => scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join('');
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');

function cleanName(value, re, label) {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!re.test(v)) throw new AccountError(400, `${label} geçersiz.`);
  return v;
}

export class CharacterStore {
  constructor({ file = null, now = Date.now, economy = null, ...opts } = {}) {
    this.file = file;
    this.now = now;
    this.economy = economy || loadEconomy();
    this.byId = {};
    for (const key of ['jobs', 'items', 'vehicles', 'houses']) this.byId[key] = new Map(this.economy[key].map((x) => [x.id, x]));
    this.limits = { maxItemQty: 50, maxVehicles: 5, maxHouses: 2, jobCooldownMs: 600000, resaleRate: 0.5, ...(this.economy.limits || {}) };
    this.opts = { ...DEFAULTS, ...opts };
    this.data = { version: 1, accounts: {}, sessions: {}, characters: {} };
    this.saveTimer = null;
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.version === 1) this.data = { sessions: {}, ...parsed };
    }
  }

  // ---- persistence ----------------------------------------------------------------
  #changed() {
    if (!this.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 200);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (!this.file) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- accounts and sessions ------------------------------------------------------
  #accountByName(username) {
    const key = String(username || '').toLowerCase();
    return Object.values(this.data.accounts).find((a) => a.key === key) || null;
  }

  register(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new AccountError(400, 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ . -).');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      throw new AccountError(400, 'Şifre 8-72 karakter olmalı.');
    }
    if (this.#accountByName(username)) throw new AccountError(409, 'Bu kullanıcı adı alınmış.', 'TAKEN');
    if (Object.keys(this.data.accounts).length >= this.opts.maxAccounts) throw new AccountError(503, 'Kayıt şu an kapalı.');
    const salt = randomBytes(16).toString('hex');
    const id = randomBytes(8).toString('hex');
    this.data.accounts[id] = { id, username, key: username.toLowerCase(), salt, hash: hashPassword(password, salt), createdAt: this.now() };
    this.#changed();
    return { account: this.publicAccount(id), token: this.#openSession(id) };
  }

  login(username, password) {
    const acc = typeof username === 'string' ? this.#accountByName(username) : null;
    // Hash even for unknown users so timing does not reveal which names exist.
    const probe = hashPassword(typeof password === 'string' ? password : '', acc ? acc.salt : 'fiveweb-dummy-salt');
    if (!acc || !timingSafeEqual(Buffer.from(probe, 'hex'), Buffer.from(acc.hash, 'hex'))) {
      throw new AccountError(401, 'Kullanıcı adı veya şifre hatalı.', 'LOGIN');
    }
    return { account: this.publicAccount(acc.id), token: this.#openSession(acc.id) };
  }

  #openSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    this.data.sessions[sha(token)] = { accountId, expiresAt: this.now() + this.opts.sessionTtlMs };
    this.#changed();
    return token;
  }

  logout(token) {
    if (typeof token === 'string' && this.data.sessions[sha(token)]) {
      delete this.data.sessions[sha(token)];
      this.#changed();
    }
  }

  accountForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const s = this.data.sessions[sha(token)];
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      delete this.data.sessions[sha(token)];
      this.#changed();
      return null;
    }
    return this.data.accounts[s.accountId] || null;
  }

  publicAccount(accountId) {
    const a = this.data.accounts[accountId];
    return { username: a.username, slots: this.opts.slots, characters: this.listCharacters(accountId) };
  }

  // ---- characters -----------------------------------------------------------------
  listCharacters(accountId) {
    return Object.values(this.data.characters)
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => this.view(c));
  }

  #migrate(c) {
    if (!c.jobId) c.jobId = 'unemployed';
    if (!c.inventory) c.inventory = {};
    if (!c.vehicles) c.vehicles = [];
    if (!c.houses) c.houses = [];
    return c;
  }

  view(c) {
    this.#migrate(c);
    const job = this.byId.jobs.get(c.jobId) || this.byId.jobs.get('unemployed');
    const inventory = Object.entries(c.inventory).filter(([id, n]) => n > 0 && this.byId.items.has(id))
      .map(([id, qty]) => ({ id, name: this.byId.items.get(id).name, qty }));
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: `${c.firstName} ${c.lastName}`,
      gender: c.gender,
      birthDate: c.birthDate,
      nationality: c.nationality,
      job: job.name,
      jobId: job.id,
      salary: job.salary,
      inventory,
      appearance: c.appearance ? structuredClone(c.appearance) : null,
      vehicles: c.vehicles.map((v) => ({ plate: v.plate, model: v.model, name: (this.byId.vehicles.get(v.model) || { name: v.model }).name, boughtAt: v.boughtAt,
        garageState: v.garage && v.garage.expiresAt > this.now() ? v.garage.state : 'stored',
        garageExpiresAt: v.garage && v.garage.expiresAt > this.now() ? v.garage.expiresAt : null })),
      houses: c.houses.map((id) => ({ id, name: (this.byId.houses.get(id) || { name: id }).name })),
      cash: c.cash,
      bank: c.bank,
      phone: c.phone,
      accountNumber: c.accountNumber,
      citizenId: c.citizenId,
      createdAt: new Date(c.createdAt).toISOString(),
    };
  }

  #own(accountId, id) {
    const c = typeof id === 'string' ? this.data.characters[id] : null;
    if (!c || c.accountId !== accountId) throw new AccountError(404, 'Karakter bulunamadı.', 'NOT_FOUND');
    return c;
  }

  getCharacter(accountId, id) {
    return this.view(this.#own(accountId, id));
  }

  saveAppearance(accountId, id, appearance) {
    const c = this.#own(accountId, id);
    c.appearance = cleanAppearance(appearance, c.gender);
    this.#changed();
    return this.view(c);
  }

  // A two-stage lease prevents repeated clicks from creating duplicate vehicles.
  // This records ownership/lifecycle intent; the browser still executes the native spawn.
  garage(accountId, id, { action, plate, operationId, token } = {}) {
    const c = this.#migrate(this.#own(accountId, id));
    if (!['reserve', 'confirm', 'heartbeat', 'cancel', 'park'].includes(action)) throw new AccountError(400, 'Garaj işlemi geçersiz.');
    const v = c.vehicles.find((x) => x.plate === plate);
    if (!v) throw new AccountError(404, 'Araç size ait değil.', 'NOT_FOUND');
    const now = this.now();
    const alive = (x) => x.garage && x.garage.expiresAt > now;
    if (action === 'reserve') {
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(operationId)) throw new AccountError(400, 'Garaj işlem kimliği geçersiz.');
      if (alive(v) && v.garage.operationId === operationId) return { character: this.view(c), garage: { plate: v.plate, model: v.model, ...v.garage } };
      if (c.vehicles.some(alive)) throw new AccountError(409, 'Önce dışarıdaki aracınızı park edin.', 'GARAGE_BUSY');
      v.garage = { state: 'reserved', operationId, token: randomBytes(24).toString('base64url'), expiresAt: now + 30_000 };
    } else {
      if (typeof token !== 'string' || token.length > 64) throw new AccountError(400, 'Garaj anahtarı geçersiz.');
      if (!alive(v)) {
        if (['park', 'cancel'].includes(action) && token === v.lastGarageToken) return { character: this.view(c), garage: null };
        throw new AccountError(409, 'Garaj oturumu sona erdi.', 'GARAGE_EXPIRED');
      }
      if (v.garage.token !== token) throw new AccountError(409, 'Bu araç başka bir oyun oturumunda.', 'GARAGE_SESSION');
      if (action === 'confirm') {
        v.garage.state = 'active';
        v.garage.expiresAt = now + 120_000;
      } else if (action === 'heartbeat') {
        if (v.garage.state !== 'active') throw new AccountError(409, 'Araç henüz çıkarılmadı.');
        v.garage.expiresAt = now + 120_000;
      } else {
        v.lastGarageToken = v.garage.token;
        delete v.garage;
      }
    }
    this.#changed();
    return { character: this.view(c), garage: v.garage ? { plate: v.plate, model: v.model, ...v.garage } : null };
  }

  #unique(fn, field, taken = (v) => Object.values(this.data.characters).some((c) => c[field] === v)) {
    for (let i = 0; i < 50; i++) {
      const v = fn();
      if (!taken(v)) return v;
    }
    throw new AccountError(503, 'Numara üretilemedi, tekrar deneyin.');
  }

  createCharacter(accountId, input = {}) {
    if (!this.data.accounts[accountId]) throw new AccountError(401, 'Oturum geçersiz.', 'AUTH');
    if (this.listCharacters(accountId).length >= this.opts.slots) throw new AccountError(409, 'Karakter slotlarınız dolu.', 'SLOTS');
    const firstName = cleanName(input.firstName, NAME_RE, 'Ad');
    const lastName = cleanName(input.lastName, NAME_RE, 'Soyad');
    const nationality = cleanName(input.nationality, NATION_RE, 'Uyruk');
    if (input.gender !== 'm' && input.gender !== 'f') throw new AccountError(400, 'Cinsiyet geçersiz.');
    const m = DATE_RE.exec(typeof input.birthDate === 'string' ? input.birthDate : '');
    const born = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!born || born.getUTCMonth() !== +m[2] - 1 || born.getUTCDate() !== +m[3]) throw new AccountError(400, 'Doğum tarihi geçersiz.');
    const age = (this.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18 || age > 90) throw new AccountError(400, 'Karakter 18-90 yaş arasında olmalı.');
    const id = randomBytes(8).toString('hex');
    const c = {
      id,
      accountId,
      firstName,
      lastName,
      gender: input.gender,
      birthDate: input.birthDate,
      nationality,
      jobId: 'unemployed',
      jobSince: 0,
      inventory: {},
      vehicles: [],
      houses: [],
      cash: this.opts.starterCash,
      bank: this.opts.starterBank,
      phone: this.#unique(() => `555-${digits(4)}`, 'phone'),
      accountNumber: this.#unique(() => `FW${digits(10)}`, 'accountNumber'),
      citizenId: this.#unique(() => `FW${code(6)}`, 'citizenId'),
      createdAt: this.now(),
      history: [],
    };
    this.data.characters[id] = c;
    this.#record(c, 'starter', this.opts.starterCash + this.opts.starterBank, 'Başlangıç parası');
    this.#changed();
    return this.view(c);
  }

  deleteCharacter(accountId, id, confirmName) {
    const c = this.#own(accountId, id);
    if (confirmName !== `${c.firstName} ${c.lastName}`) throw new AccountError(400, 'Silmek için karakterin tam adını yazın.');
    delete this.data.characters[id];
    this.#changed();
  }

  // ---- money ------------------------------------------------------------------------
  #amount(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > this.opts.maxAmount) {
      throw new AccountError(400, `Tutar 1-${this.opts.maxAmount} arasında tam sayı olmalı.`);
    }
    return value;
  }

  #record(c, type, amount, label, extra = {}) {
    c.history.unshift({ at: new Date(this.now()).toISOString(), type, amount, label, cash: c.cash, bank: c.bank, ...extra });
    if (c.history.length > this.opts.historyLimit) c.history.length = this.opts.historyLimit;
  }

  deposit(accountId, id, amount) {
    const c = this.#own(accountId, id);
    this.#amount(amount);
    if (c.cash < amount) throw new AccountError(409, 'Cüzdanda yeterli nakit yok.', 'FUNDS');
    c.cash -= amount;
    c.bank += amount;
    this.#record(c, 'deposit', amount, 'Bankaya yatırıldı');
    this.#changed();
    return this.view(c);
  }

  withdraw(accountId, id, amount) {
    const c = this.#own(accountId, id);
    this.#amount(amount);
    if (c.bank < amount) throw new AccountError(409, 'Banka bakiyesi yetersiz.', 'FUNDS');
    c.bank -= amount;
    c.cash += amount;
    this.#record(c, 'withdraw', amount, 'Bankadan çekildi');
    this.#changed();
    return this.view(c);
  }

  transfer(accountId, id, toAccountNumber, amount, note = '') {
    const c = this.#own(accountId, id);
    this.#amount(amount);
    const target = Object.values(this.data.characters).find((x) => x.accountNumber === toAccountNumber);
    if (!target) throw new AccountError(404, 'Alıcı hesap bulunamadı.', 'NOT_FOUND');
    if (target.id === c.id) throw new AccountError(400, 'Kendi hesabınıza havale yapamazsınız.');
    const memo = typeof note === 'string' ? note.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 60) : '';
    if (c.bank < amount) throw new AccountError(409, 'Banka bakiyesi yetersiz.', 'FUNDS');
    c.bank -= amount;
    target.bank += amount;
    const toName = `${target.firstName} ${target.lastName}`;
    const fromName = `${c.firstName} ${c.lastName}`;
    this.#record(c, 'transfer-out', amount, memo || 'Havale', { counterparty: toName, account: target.accountNumber });
    this.#record(target, 'transfer-in', amount, memo || 'Havale', { counterparty: fromName, account: c.accountNumber });
    this.#changed();
    return this.view(c);
  }

  // ---- economy: jobs, shop, vehicles, houses ----------------------------------------------
  catalog() {
    const e = this.economy;
    return {
      jobs: e.jobs.map(({ id, name, salary }) => ({ id, name, salary })),
      items: e.items.map(({ id, name, price, category }) => ({ id, name, price, category })),
      vehicles: e.vehicles.map(({ id, name, price, class: cls }) => ({ id, name, price, class: cls })),
      houses: e.houses.map(({ id, name, price, x, y }) => ({ id, name, price, x, y, owned: this.#houseOwner(id) !== null })),
      limits: { maxItemQty: this.limits.maxItemQty, maxVehicles: this.limits.maxVehicles, maxHouses: this.limits.maxHouses, resaleRate: this.limits.resaleRate },
    };
  }

  #houseOwner(id) {
    const owner = Object.values(this.data.characters).find((c) => Array.isArray(c.houses) && c.houses.includes(id));
    return owner || null;
  }

  #spend(c, price, method) {
    if (method !== 'cash' && method !== 'bank') throw new AccountError(400, 'Ödeme yöntemi nakit veya banka olmalı.');
    if (c[method] < price) throw new AccountError(409, method === 'cash' ? 'Cüzdanda yeterli nakit yok.' : 'Banka bakiyesi yetersiz.', 'FUNDS');
    c[method] -= price;
  }

  setJob(accountId, id, jobId) {
    const c = this.#migrate(this.#own(accountId, id));
    const job = this.byId.jobs.get(jobId);
    if (!job) throw new AccountError(400, 'Meslek bulunamadı.');
    if (c.jobId === job.id) throw new AccountError(409, 'Zaten bu meslektesiniz.');
    if (c.jobSince && this.now() - c.jobSince < this.limits.jobCooldownMs) throw new AccountError(429, 'Meslek değiştirmek için biraz bekleyin.', 'COOLDOWN');
    c.jobId = job.id;
    c.jobSince = this.now();
    this.#record(c, 'job', 0, `Yeni meslek: ${job.name}`);
    this.#changed();
    return this.view(c);
  }

  buyItem(accountId, id, itemId, qty, method = 'cash') {
    const c = this.#migrate(this.#own(accountId, id));
    const item = this.byId.items.get(itemId);
    if (!item) throw new AccountError(400, 'Ürün bulunamadı.');
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > this.limits.maxItemQty) throw new AccountError(400, `Adet 1-${this.limits.maxItemQty} arasında olmalı.`);
    if ((c.inventory[itemId] || 0) + qty > this.limits.maxItemQty) throw new AccountError(409, 'Envanterde yer yok.', 'FULL');
    const price = item.price * qty;
    this.#spend(c, price, method);
    c.inventory[itemId] = (c.inventory[itemId] || 0) + qty;
    this.#record(c, 'purchase', price, `${item.name} x${qty}`);
    this.#changed();
    return this.view(c);
  }

  dropItem(accountId, id, itemId, qty) {
    const c = this.#migrate(this.#own(accountId, id));
    if (!Number.isSafeInteger(qty) || qty < 1 || (c.inventory[itemId] || 0) < qty) throw new AccountError(409, 'Envanterde o kadar yok.', 'FUNDS');
    c.inventory[itemId] -= qty;
    if (!c.inventory[itemId]) delete c.inventory[itemId];
    this.#changed();
    return this.view(c);
  }

  giveItem(accountId, id, itemId, qty, toPhone) {
    const c = this.#migrate(this.#own(accountId, id));
    const item = this.byId.items.get(itemId);
    if (!item || !Number.isSafeInteger(qty) || qty < 1 || (c.inventory[itemId] || 0) < qty) throw new AccountError(409, 'Envanterde o kadar yok.', 'FUNDS');
    const target = Object.values(this.data.characters).find((x) => x.phone === toPhone);
    if (!target) throw new AccountError(404, 'Bu numarada kimse yok.', 'NOT_FOUND');
    if (target.id === c.id) throw new AccountError(400, 'Kendinize veremezsiniz.');
    this.#migrate(target);
    if ((target.inventory[itemId] || 0) + qty > this.limits.maxItemQty) throw new AccountError(409, 'Alıcının envanterinde yer yok.', 'FULL');
    c.inventory[itemId] -= qty;
    if (!c.inventory[itemId]) delete c.inventory[itemId];
    target.inventory[itemId] = (target.inventory[itemId] || 0) + qty;
    this.#record(c, 'give', 0, `${item.name} x${qty} verildi`, { counterparty: `${target.firstName} ${target.lastName}` });
    this.#record(target, 'receive', 0, `${item.name} x${qty} alındı`, { counterparty: `${c.firstName} ${c.lastName}` });
    this.#changed();
    return this.view(c);
  }

  buyVehicle(accountId, id, model) {
    const c = this.#migrate(this.#own(accountId, id));
    const v = this.byId.vehicles.get(model);
    if (!v) throw new AccountError(400, 'Araç bulunamadı.');
    if (c.vehicles.length >= this.limits.maxVehicles) throw new AccountError(409, 'Garajınız dolu.', 'FULL');
    this.#spend(c, v.price, 'bank');
    const plate = this.#unique(() => `FW${code(5)}`, null, (p) => Object.values(this.data.characters).some((x) => (x.vehicles || []).some((y) => y.plate === p)));
    c.vehicles.push({ plate, model: v.id, boughtAt: new Date(this.now()).toISOString() });
    this.#record(c, 'purchase', v.price, `Araç: ${v.name} (${plate})`);
    this.#changed();
    return this.view(c);
  }

  sellVehicle(accountId, id, plate) {
    const c = this.#migrate(this.#own(accountId, id));
    const i = c.vehicles.findIndex((x) => x.plate === plate);
    if (i < 0) throw new AccountError(404, 'Araç bulunamadı.', 'NOT_FOUND');
    if (c.vehicles[i].garage && c.vehicles[i].garage.expiresAt > this.now()) throw new AccountError(409, 'Satmadan önce aracı park edin.', 'GARAGE_BUSY');
    const [veh] = c.vehicles.splice(i, 1);
    const price = Math.floor(((this.byId.vehicles.get(veh.model) || { price: 0 }).price) * this.limits.resaleRate);
    c.bank += price;
    this.#record(c, 'sale', price, `Araç satıldı (${veh.plate})`);
    this.#changed();
    return this.view(c);
  }

  buyHouse(accountId, id, houseId) {
    const c = this.#migrate(this.#own(accountId, id));
    const h = this.byId.houses.get(houseId);
    if (!h) throw new AccountError(400, 'Ev bulunamadı.');
    if (this.#houseOwner(houseId)) throw new AccountError(409, 'Bu evin sahibi var.', 'TAKEN');
    if (c.houses.length >= this.limits.maxHouses) throw new AccountError(409, 'Daha fazla ev alamazsınız.', 'FULL');
    this.#spend(c, h.price, 'bank');
    c.houses.push(h.id);
    this.#record(c, 'purchase', h.price, `Ev: ${h.name}`);
    this.#changed();
    return this.view(c);
  }

  sellHouse(accountId, id, houseId) {
    const c = this.#migrate(this.#own(accountId, id));
    const i = c.houses.indexOf(houseId);
    if (i < 0) throw new AccountError(404, 'Ev bulunamadı.', 'NOT_FOUND');
    c.houses.splice(i, 1);
    const price = Math.floor(((this.byId.houses.get(houseId) || { price: 0 }).price) * this.limits.resaleRate);
    c.bank += price;
    this.#record(c, 'sale', price, `Ev satıldı: ${(this.byId.houses.get(houseId) || { name: houseId }).name}`);
    this.#changed();
    return this.view(c);
  }

  // Phone contacts: other characters currently in game (name + phone only).
  directory(profiles, selfId) {
    const out = [];
    const seen = new Set();
    for (const p of profiles) {
      const c = this.data.characters[p.characterId];
      if (!c || c.id === selfId || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ name: `${c.firstName} ${c.lastName}`, phone: c.phone, accountNumber: c.accountNumber });
    }
    return out;
  }

  salaryOf(characterId) {
    const c = this.data.characters[characterId];
    if (!c) return 0;
    return (this.byId.jobs.get(c.jobId || 'unemployed') || { salary: 0 }).salary;
  }

  // Server-only income (paychecks). Unknown or deleted characters are ignored.
  pay(characterId, amount, label = 'Maaş') {
    const c = this.data.characters[characterId];
    if (!c || !Number.isSafeInteger(amount) || amount < 1) return false;
    c.bank += amount;
    this.#record(c, 'income', amount, label);
    this.#changed();
    return true;
  }

  history(accountId, id) {
    return this.#own(accountId, id).history.slice();
  }
}
