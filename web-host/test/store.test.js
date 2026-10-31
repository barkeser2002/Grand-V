// Slice 1: in-memory lobby store. Time is injected so TTL behaviour is exact and fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyStore, LobbyError } from '../src/lobbies.js';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function newStore(overrides = {}) {
  const c = clock();
  const store = new LobbyStore({
    now: c.now,
    pendingTtlMs: 200,
    reconnectTtlMs: 100,
    maxLobbyAgeMs: 60_000,
    maxLobbies: 3,
    ...overrides,
  });
  return { store, clock: c };
}

const BUILD = '8b0b5899ed-replica-20261009-v1';
const meta = { name: 'Dene', hostNickname: 'Ada', map: 'gta5', build: BUILD };

test('create: host seat is pending, lobby is listed with 1/2 and never exposes the credential', () => {
  const { store } = newStore();
  const { lobby, credential } = store.createLobby(meta);
  assert.match(lobby.id, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(credential.length >= 32, 'credential is long');
  assert.match(credential, /^[A-Za-z0-9_-]+$/, 'credential is URL-safe');
  const listed = store.listOpen();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, lobby.id);
  assert.equal(listed[0].players, 1);
  assert.equal(listed[0].capacity, 2);
  assert.equal(listed[0].status, 'open');
  assert.equal(listed[0].hostNickname, 'Ada');
  assert.ok(!JSON.stringify(listed).includes(credential), 'list must not contain the credential');
});

test('create: ids and credentials are unique across lobbies', () => {
  const { store } = newStore({ maxLobbies: 50 });
  const ids = new Set();
  const creds = new Set();
  for (let i = 0; i < 20; i++) {
    const r = store.createLobby(meta);
    ids.add(r.lobby.id);
    creds.add(r.credential);
  }
  assert.equal(ids.size, 20);
  assert.equal(creds.size, 20);
});

test('reserve: second seat fills the lobby; third reservation is FULL', () => {
  const { store } = newStore();
  const { lobby } = store.createLobby(meta);
  const second = store.reserve(lobby.id, 'Bob');
  assert.ok(second.credential);
  assert.notEqual(second.credential, undefined);
  assert.equal(store.listOpen()[0].players, 2);
  assert.equal(store.listOpen()[0].status, 'full');
  assert.throws(
    () => store.reserve(lobby.id, 'Eve'),
    (e) => e instanceof LobbyError && e.code === 'FULL' && e.status === 409,
  );
});

test('reserve: unknown lobby is NOT_FOUND', () => {
  const { store } = newStore();
  assert.throws(
    () => store.reserve('doesnotexist0000', 'Bob'),
    (e) => e instanceof LobbyError && e.code === 'NOT_FOUND' && e.status === 404,
  );
});

test('lobby limit: creation beyond maxLobbies is refused with 503', () => {
  const { store } = newStore({ maxLobbies: 2 });
  store.createLobby(meta);
  store.createLobby(meta);
  assert.throws(
    () => store.createLobby(meta),
    (e) => e instanceof LobbyError && e.code === 'LIMIT' && e.status === 503,
  );
});

test('pending reservation expires; an empty pending lobby is removed', () => {
  const { store, clock } = newStore();
  const { lobby, credential } = store.createLobby(meta);
  clock.advance(201);
  assert.equal(store.authenticate(lobby.id, credential), null);
  assert.equal(store.listOpen().length, 0, 'expired lobby is not listed');
  assert.equal(store.size, 0);
});

test('check-style authenticate with touch extends a pending reservation', () => {
  const { store, clock } = newStore();
  const { lobby, credential } = store.createLobby(meta);
  clock.advance(150);
  assert.ok(store.authenticate(lobby.id, credential, { touch: true }));
  clock.advance(150);
  assert.ok(store.authenticate(lobby.id, credential), 'touch moved expiry forward');
  clock.advance(201);
  assert.equal(store.authenticate(lobby.id, credential), null);
});

test('authenticate does not consume: repeated checks keep the seat pending', () => {
  const { store } = newStore();
  const { lobby, credential } = store.createLobby(meta);
  for (let i = 0; i < 3; i++) {
    const hit = store.authenticate(lobby.id, credential, { touch: true });
    assert.equal(hit.seat.state, 'pending');
  }
  assert.equal(store.listOpen()[0].players, 1);
});

test('authenticate: a credential is bound to its own lobby only (isolation)', () => {
  const { store } = newStore();
  const a = store.createLobby(meta);
  const b = store.createLobby({ ...meta, name: 'Other' });
  assert.equal(store.authenticate(b.lobby.id, a.credential), null);
  assert.equal(store.authenticate(a.lobby.id, 'wrong-credential-value'), null);
});

test('claim: pending seat becomes active once; a second claim is refused', () => {
  const { store } = newStore();
  const { lobby, credential } = store.createLobby(meta);
  const peer = { id: 'p1' };
  const seat = store.claim(lobby.id, credential, peer);
  assert.equal(seat.state, 'active');
  assert.equal(seat.peer, peer);
  assert.throws(
    () => store.claim(lobby.id, credential, { id: 'p2' }),
    (e) => e instanceof LobbyError && e.code === 'ALREADY',
  );
});

test('detach: one peer leaves while the other is active; seat is held for reconnection', () => {
  const { store, clock } = newStore({ maxLobbies: 5 });
  const host = store.createLobby(meta);
  const guest = store.reserve(host.lobby.id, 'Bob');
  const hostPeer = { id: 'h' };
  const guestPeer = { id: 'g' };
  store.claim(host.lobby.id, host.credential, hostPeer);
  store.claim(host.lobby.id, guest.credential, guestPeer);
  const info = store.detach(host.lobby.id, guestPeer);
  assert.equal(info.lobbyRemoved, false);
  assert.deepEqual(info.remaining.map((p) => p.id), ['h']);
  assert.equal(store.listOpen()[0].players, 2, 'held seat still counts toward capacity');
  clock.advance(50);
  const back = store.claim(host.lobby.id, guest.credential, { id: 'g2' });
  assert.equal(back.state, 'active', 'same credential reconnects');
  clock.advance(101);
  assert.equal(store.authenticate(host.lobby.id, host.credential) !== null, true);
});

test('detach: a held seat expires and frees capacity', () => {
  const { store, clock } = newStore({ maxLobbies: 5 });
  const host = store.createLobby(meta);
  const guest = store.reserve(host.lobby.id, 'Bob');
  store.claim(host.lobby.id, host.credential, { id: 'h' });
  store.claim(host.lobby.id, guest.credential, { id: 'g' });
  store.detach(host.lobby.id, { id: 'g' }); // not the stored peer: no effect
  assert.equal(store.listOpen()[0].players, 2);
  const gpeer = store.getLobby(host.lobby.id).seats[1].peer;
  store.detach(host.lobby.id, gpeer);
  clock.advance(101);
  store.sweep();
  assert.equal(store.listOpen()[0].players, 1);
  assert.equal(store.authenticate(host.lobby.id, guest.credential), null);
});

test('detach: last active peer leaving with nobody pending removes the room', () => {
  const { store } = newStore();
  const host = store.createLobby(meta);
  const peer = { id: 'h' };
  store.claim(host.lobby.id, host.credential, peer);
  const info = store.detach(host.lobby.id, peer);
  assert.equal(info.lobbyRemoved, true);
  assert.equal(store.size, 0);
  assert.equal(store.listOpen().length, 0);
});

test('detach: last active peer leaving while a guest is still pending keeps the lobby open', () => {
  const { store } = newStore();
  const host = store.createLobby(meta);
  store.reserve(host.lobby.id, 'Bob');
  const peer = { id: 'h' };
  store.claim(host.lobby.id, host.credential, peer);
  const info = store.detach(host.lobby.id, peer);
  assert.equal(info.lobbyRemoved, false);
  assert.equal(store.size, 1);
});

test('release: pending reservation is freed; wrong credential is ignored', () => {
  const { store } = newStore({ maxLobbies: 5 });
  const host = store.createLobby(meta);
  const guest = store.reserve(host.lobby.id, 'Bob');
  assert.equal(store.release(host.lobby.id, 'not-the-credential').released, false);
  const out = store.release(host.lobby.id, guest.credential);
  assert.equal(out.released, true);
  assert.equal(out.peer, null);
  assert.equal(store.listOpen()[0].players, 1);
  assert.equal(store.authenticate(host.lobby.id, guest.credential), null);
});

test('release: active seat returns the peer to close and the other peers to notify', () => {
  const { store } = newStore({ maxLobbies: 5 });
  const host = store.createLobby(meta);
  const guest = store.reserve(host.lobby.id, 'Bob');
  const hp = { id: 'h' };
  const gp = { id: 'g' };
  store.claim(host.lobby.id, host.credential, hp);
  store.claim(host.lobby.id, guest.credential, gp);
  const out = store.release(host.lobby.id, guest.credential);
  assert.equal(out.released, true);
  assert.equal(out.peer, gp);
  assert.deepEqual(out.remaining.map((p) => p.id), ['h']);
  assert.equal(out.lobbyRemoved, false);
});

test('sweep: lobbies older than maxLobbyAgeMs close their active peers and disappear', () => {
  const { store, clock } = newStore({ maxLobbyAgeMs: 1000, pendingTtlMs: 100000 });
  const host = store.createLobby(meta);
  const hp = { id: 'h' };
  store.claim(host.lobby.id, host.credential, hp);
  clock.advance(1001);
  const expired = store.sweep();
  assert.deepEqual(expired.peers, [hp]);
  assert.deepEqual(expired.lobbyIds, [host.lobby.id]);
  assert.equal(store.size, 0);
});

test('view objects carry only public fields', () => {
  const { store } = newStore();
  store.createLobby(meta);
  const [view] = store.listOpen();
  assert.deepEqual(Object.keys(view).sort(), [
    'build',
    'capacity',
    'connected',
    'createdAt',
    'expiresAt',
    'hostNickname',
    'id',
    'map',
    'name',
    'players',
    'reserved',
    'status',
  ]);
});
