// Reservation lifetime and the public lobby counts. A player who passed the check may spend
// minutes loading an ~18 GB game before the relay join, so the default pending TTL is 20 minutes
// and total lobby lifetime stays bounded. `players` counts occupied seats (reserved or
// connected); `connected` counts only live relay peers; `reserved` counts unclaimed seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyStore, LobbyError } from '../src/lobbies.js';
import { CAPACITY, MIN_CAPACITY, MAX_CAPACITY } from '../src/constants.js';

const newClock = (start = 1_000_000) => {
  const clock = { t: start };
  return { clock, now: () => clock.t };
};

test('default pending reservation TTL is 20 minutes', () => {
  const { clock, now } = newClock();
  const store = new LobbyStore({ now });
  const created = store.createLobby({ name: 'n', hostNickname: 'h', map: 'gta5', build: 'b' });
  assert.equal(Date.parse(created.seatExpiresAt) - clock.t, 20 * 60 * 1000);
  const guest = store.reserve(created.lobby.id, 'g');
  assert.equal(Date.parse(guest.seatExpiresAt) - clock.t, 20 * 60 * 1000);
});

test('default total lobby lifetime is bounded at 4 hours', () => {
  const { clock, now } = newClock();
  const store = new LobbyStore({ now });
  const created = store.createLobby({ name: 'n', hostNickname: 'h', map: 'gta5', build: 'b' });
  assert.equal(Date.parse(created.lobby.expiresAt) - clock.t, 4 * 60 * 60 * 1000);
});

test('reserved seats are not connected; connected counts only claimed peers', () => {
  const { now } = newClock();
  const store = new LobbyStore({ now });
  const created = store.createLobby({ name: 'n', hostNickname: 'h', map: 'gta5', build: 'b' });
  const id = created.lobby.id;
  store.reserve(id, 'g');
  let view = store.listOpen()[0];
  assert.equal(view.players, 2);
  assert.equal(view.reserved, 2);
  assert.equal(view.connected, 0);
  store.claim(id, created.credential, { id: 'p1', send() {}, close() {} });
  view = store.listOpen()[0];
  assert.equal(view.players, 2, 'players still counts occupied seats');
  assert.equal(view.connected, 1);
  assert.equal(view.reserved, 1);
});

test('128-seat reservation succeeds up to capacity and 129th throws 409 FULL; released slot is reused', () => {
  assert.equal(CAPACITY, 128);
  assert.equal(MIN_CAPACITY, 2);
  assert.equal(MAX_CAPACITY, 128);
  const { now } = newClock();
  const store = new LobbyStore({ now });
  const created = store.createLobby({ name: 'Massive', hostNickname: 'Host', map: 'gta5', build: 'b', capacity: 128 });
  const id = created.lobby.id;
  assert.equal(created.lobby.capacity, 128);
  const guests = [];
  for (let i = 1; i < 128; i++) {
    const res = store.reserve(id, `Guest${i}`);
    guests.push(res);
    assert.equal(res.lobby.players, i + 1);
    assert.equal(res.lobby.status, i + 1 === 128 ? 'full' : 'open');
  }
  assert.throws(
    () => store.reserve(id, 'Overflow'),
    (e) => e instanceof LobbyError && e.code === 'FULL' && e.status === 409,
  );
  store.release(id, guests[50].credential);
  assert.equal(store.listOpen()[0].players, 127);
  assert.equal(store.listOpen()[0].status, 'open');
  const reused = store.reserve(id, 'Replacement');
  assert.equal(reused.lobby.players, 128);
  assert.equal(reused.lobby.status, 'full');
});
