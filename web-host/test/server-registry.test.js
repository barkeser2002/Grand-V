// Dedicated named servers: pure config validation and registry rules (no network).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LobbyStore } from '../src/lobbies.js';
import {
  parseServersConfig,
  loadServersConfig,
  ServerRegistry,
  ServerConfigError,
} from '../src/server-registry.js';
import { CAPACITY } from '../src/constants.js';

const GOOD = {
  id: 'fiveweb-freeroam',
  name: 'FiveWeb Freeroam',
  description: 'Deneysel sunucu',
  tags: ['Freeroam', 'Deneysel'],
  resources: ['welcome'],
};
const cfg = (...servers) => ({ servers: servers.length ? servers : [GOOD] });
const reject = (raw, re) => assert.throws(() => parseServersConfig(raw), (e) => e instanceof ServerConfigError && re.test(e.message));
const withEntry = (patch) => cfg({ ...GOOD, ...patch });

function makeRegistry(entries = [GOOD], clock = { t: 1_000_000 }) {
  const store = new LobbyStore({ now: () => clock.t, pendingTtlMs: 60_000, reconnectTtlMs: 10_000 });
  const resources = new Map([['welcome', { name: 'welcome', version: '0.1.0' }]]);
  const events = [];
  const registry = new ServerRegistry({
    servers: parseServersConfig(cfg(...entries)),
    store,
    resources,
    onEvent: (name, payload) => events.push([name, payload]),
  });
  return { store, registry, events, clock };
}

describe('servers config: strict validation', () => {
  test('the shipped default config parses and names the FiveWeb Freeroam server', () => {
    const servers = loadServersConfig(new URL('../config/servers.json', import.meta.url).pathname);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].id, 'fiveweb-freeroam');
    assert.equal(servers[0].name, 'FiveWeb Freeroam');
    assert.equal(servers[0].capacity, 128);
    assert.equal(servers[0].description, '128 kişilik açık dünya serbest dolaşım sunucusu. Oyuncu konumları eşitlenir; araçlar ve görevler henüz eşitlenmez.');
    assert.deepEqual(servers[0].tags, ['Freeroam', 'Deneysel']);
    assert.deepEqual(servers[0].resources, ['welcome']);
  });

  test('an empty servers list is valid (nothing is faked)', () => {
    assert.deepEqual([...parseServersConfig({ servers: [] })], []);
  });

  test('non-object and non-array servers are rejected', () => {
    reject(null, /must be a JSON object/);
    reject([], /must be a JSON object/);
    reject({ servers: {} }, /must be an array/);
    reject({ servers: [], extra: 1 }, /unknown config field/);
  });

  test('bad ids, names, descriptions and tags are rejected', () => {
    reject(withEntry({ id: 'Upper' }), /invalid id/);
    reject(withEntry({ id: 'x' }), /invalid id/);
    reject(withEntry({ name: 'ab' }), /invalid name/);
    reject(withEntry({ description: 'a\u0007b' }), /invalid description/);
    reject(withEntry({ description: 'x'.repeat(301) }), /invalid description/);
    reject(withEntry({ tags: 'Freeroam' }), /tags must be/);
    reject(withEntry({ tags: Array(9).fill('a') }), /tags must be/);
    reject(withEntry({ tags: ['<script>'] }), /invalid tag/);
  });

  test('unknown entry fields and out-of-range capacities are rejected', () => {
    assert.equal(parseServersConfig(withEntry({ capacity: 50 }))[0].capacity, 50);
    reject(withEntry({ capacity: 1 }), /invalid capacity/);
    reject(withEntry({ capacity: 129 }), /invalid capacity/);
    reject(withEntry({ capacity: 2.5 }), /invalid capacity/);
    reject(withEntry({ owner: 'x' }), /unknown field owner/);
  });

  test('duplicate server ids and duplicate resource names are rejected', () => {
    reject(cfg(GOOD, { ...GOOD, name: 'Other Name' }), /duplicate server id/);
    reject(withEntry({ resources: ['welcome', 'welcome'] }), /duplicate resource/);
    reject(withEntry({ resources: ['../etc'] }), /invalid resource name/);
  });

  test('a malformed JSON file is a config error, not a crash', () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-servers-'));
    const file = path.join(dir, 'servers.json');
    writeFileSync(file, '{not json');
    assert.throws(() => loadServersConfig(file), ServerConfigError);
  });
});

describe('server registry: rooms are ephemeral, server entries are not', () => {
  test('a configured server with no room is listed as online with zero players', () => {
    const { registry } = makeRegistry();
    const [s] = registry.list();
    assert.equal(s.id, 'fiveweb-freeroam');
    assert.equal(s.connected, 0);
    assert.equal(s.reserved, 0);
    assert.equal(s.capacity, CAPACITY);
    assert.equal(s.status, 'online');
    assert.deepEqual(s.resources, [{ name: 'welcome', version: '0.1.0' }]);
    assert.equal(s.compatibility, 'fiveweb-js-v1');
    assert.equal(s.voice, true);
  });

  test('first join creates the room (host); second reserves the seat; a third join is refused (capacity 2)', () => {
    const { registry, events } = makeRegistry([{ ...GOOD, capacity: 2 }]);
    const a = registry.join('fiveweb-freeroam', 'Ali');
    assert.equal(a.session.role, 'host');
    const b = registry.join('fiveweb-freeroam', 'Veli');
    assert.equal(b.session.role, 'guest');
    assert.equal(b.lobby.id, a.lobby.id);
    assert.equal(b.lobby.status, 'full');
    assert.throws(() => registry.join('fiveweb-freeroam', 'Ece'), (e) => e.status === 409);
    assert.equal(registry.list()[0].status, 'full');
    assert.equal(registry.list()[0].reserved, 2);
    assert.deepEqual(
      events.map(([n]) => n),
      ['server:roomCreated', 'server:join', 'server:join'],
    );
  });

  test('a 128-capacity server accepts 128 joins in one room and refuses the 129th', () => {
    const { registry } = makeRegistry();
    const first = registry.join('fiveweb-freeroam', 'P0');
    for (let i = 1; i < 128; i++) assert.equal(registry.join('fiveweb-freeroam', `P${i}`).lobby.id, first.lobby.id);
    assert.equal(registry.list()[0].status, 'full');
    assert.equal(registry.list()[0].reserved, 128);
    assert.throws(() => registry.join('fiveweb-freeroam', 'Fazla'), (e) => e.status === 409);
  });

  test('the handoff points at the relay room and the public server id, never at a credential in the URL', () => {
    const { registry } = makeRegistry();
    const h = registry.join('fiveweb-freeroam', 'Ali');
    assert.equal(h.launchPath, `/launcher.html?lobby=${h.lobby.id}&server=fiveweb-freeroam`);
    assert.ok(!h.launchPath.includes(h.session.credential));
  });

  test('two servers never share a room', () => {
    const second = { ...GOOD, id: 'fiveweb-arena', name: 'FiveWeb Arena' };
    const { registry } = makeRegistry([GOOD, second]);
    const a = registry.join('fiveweb-freeroam', 'Ali');
    const b = registry.join('fiveweb-arena', 'Veli');
    assert.notEqual(a.lobby.id, b.lobby.id);
    assert.equal(b.session.role, 'host');
    const list = registry.list();
    assert.deepEqual(list.map((s) => [s.id, s.reserved]), [
      ['fiveweb-freeroam', 1],
      ['fiveweb-arena', 1],
    ]);
  });

  test('a room whose lobby expired is replaced by a fresh one on the next join', () => {
    const { registry, clock } = makeRegistry();
    const first = registry.join('fiveweb-freeroam', 'Ali');
    clock.t += 61_000; // pending seat expires with nobody connected
    assert.equal(registry.list()[0].reserved, 0);
    const again = registry.join('fiveweb-freeroam', 'Veli');
    assert.equal(again.session.role, 'host');
    assert.notEqual(again.lobby.id, first.lobby.id);
  });

  test('unknown server id is 404 and does not create anything', () => {
    const { registry, store } = makeRegistry();
    assert.throws(() => registry.join('nope', 'Ali'), (e) => e.status === 404);
    assert.equal(store.size, 0);
  });

  test('a server referencing an unknown resource is rejected at construction', () => {
    const store = new LobbyStore();
    assert.throws(
      () => new ServerRegistry({ servers: parseServersConfig(cfg()), store, resources: new Map() }),
      /unknown resource welcome/,
    );
  });
});
