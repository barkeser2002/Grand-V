// Slice 3: /relay WebSocket protocol, driven by real ws clients against the real server.
// Message shapes and close reasons mirror LauncherApp/rust/src/relay.rs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, api, createLobby, joinLobby, connectRelay, sleep, BUILD, RelaySocket } from './helpers.js';

const hello = (type, room, key, extra = {}) => ({
  type,
  protocol: 1,
  key,
  room,
  build: BUILD,
  map: 'gta5',
  ...extra,
});

const pose = (seq, position = [1, 2, 3], model = 3_000_000_001, rotation = [0, 0, 90]) => ({
  type: 'pose',
  seq,
  model,
  position,
  rotation,
});

async function pairLobby(h, name = 'Relay Testi') {
  const created = await createLobby(h.origin, { name, nickname: 'Ada' });
  const id = created.lobby.id;
  const hostKey = created.session.credential;
  const joined = await joinLobby(h.origin, id, 'Bora');
  const guestKey = joined.data.session.credential;
  const host = await connectRelay(h.wsBase, h.origin);
  host.send(hello('join', id, hostKey));
  const hostWelcome = await host.type('welcome');
  const guest = await connectRelay(h.wsBase, h.origin);
  guest.send(hello('join', id, guestKey));
  const guestWelcome = await guest.type('welcome');
  const hostJoined = await host.type('joined');
  return { id, hostKey, guestKey, host, guest, hostWelcome, guestWelcome, hostJoined, created };
}

describe('relay: check (does not consume the reservation)', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('check answers checked with players and capacity, then closes 1000', async () => {
    const created = await createLobby(h.origin, { name: 'Kontrol' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('check', created.lobby.id, created.session.credential));
    const msg = await s.type('checked');
    assert.deepEqual(msg, { type: 'checked', players: 0, capacity: 2 });
    const close = await s.waitClose();
    assert.equal(close.code, 1000);
    assert.equal(close.reason, 'Check complete');
  });

  test('repeated checks leave the seat free for the real join', async () => {
    const created = await createLobby(h.origin, { name: 'Kontrol İki' });
    for (let i = 0; i < 2; i++) {
      const s = await connectRelay(h.wsBase, h.origin);
      s.send(hello('check', created.lobby.id, created.session.credential));
      await s.type('checked');
      await s.waitClose();
    }
    const real = await connectRelay(h.wsBase, h.origin);
    real.send(hello('join', created.lobby.id, created.session.credential));
    const welcome = await real.type('welcome');
    assert.equal(welcome.protocol, 1);
    assert.deepEqual(welcome.peers, []);
    real.close();
  });

  test('check with a wrong credential is rejected', async () => {
    const created = await createLobby(h.origin, { name: 'Yanlış Anahtar' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('check', created.lobby.id, 'definitely-wrong-key'));
    const close = await s.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Join key rejected');
  });
});

describe('relay: join, welcome, joined, pose, left', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('join answers welcome with a server-assigned hex id, protocol 1, hz 20', async () => {
    const created = await createLobby(h.origin, { name: 'Karşılama' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('join', created.lobby.id, created.session.credential));
    const w = await s.type('welcome');
    assert.equal(w.type, 'welcome');
    assert.equal(w.protocol, 1);
    assert.match(w.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(w.peers, []);
    assert.equal(w.hz, 20);
    s.close();
  });

  test('second peer gets welcome listing the first; first peer gets joined for the second', async () => {
    const p = await pairLobby(h, 'İki Oyuncu');
    assert.deepEqual(p.guestWelcome.peers, [p.hostWelcome.id]);
    assert.equal(p.hostJoined.id, p.guestWelcome.id);
    p.host.close();
    p.guest.close();
  });

  test('pose travels both ways with the sender id attached and values unchanged', async () => {
    const p = await pairLobby(h, 'Poz Testi');
    p.host.send(pose(1, [10.5, -2, 300], 3_000_000_001, [0, 45, 359.5]));
    const atGuest = await p.guest.next((m) => m.type === 'pose' && m.seq === 1);
    assert.deepEqual(atGuest, {
      type: 'pose',
      seq: 1,
      model: 3_000_000_001,
      position: [10.5, -2, 300],
      rotation: [0, 45, 359.5],
      id: p.hostWelcome.id,
    });
    p.guest.send(pose(7, [-1, 0, 2]));
    const atHost = await p.host.next((m) => m.type === 'pose' && m.seq === 7);
    assert.equal(atHost.id, p.guestWelcome.id);
    assert.deepEqual(atHost.position, [-1, 0, 2]);
    p.host.close();
    p.guest.close();
  });

  test('duplicate or older sequence numbers are dropped; only strictly newer ones pass', async () => {
    const p = await pairLobby(h, 'Sıra Testi');
    for (const seq of [5, 5, 4, 6]) p.host.send(pose(seq));
    await p.guest.next((m) => m.type === 'pose' && m.seq === 5);
    await p.guest.next((m) => m.type === 'pose' && m.seq === 6);
    await sleep(100);
    assert.equal(p.guest.inbox.filter((m) => m.type === 'pose').length, 0, 'no duplicate or stale pose was delivered');
    p.host.close();
    p.guest.close();
  });

  test('invalid poses close the socket with the Rust reason strings', async () => {
    const cases = [
      [{ type: 'chat', text: 'hi' }, 'Unsupported message'],
      [{ ...pose(1), seq: -1 }, 'Invalid sequence'],
      [{ ...pose(1), seq: 1.5 }, 'Invalid sequence'],
      [{ ...pose(1), model: 4294967296 }, 'Invalid model'],
      [{ ...pose(1), position: [1, 2] }, 'Invalid position'],
      [{ ...pose(1), position: [1, 2, 20001] }, 'Invalid position'],
      [{ ...pose(1), rotation: [0, 0, 361] }, 'Invalid rotation'],
    ];
    for (const [body, reason] of cases) {
      const p = await pairLobby(h, 'Geçersiz Poz');
      p.host.send(body);
      const close = await p.host.waitClose();
      assert.equal(close.code, 1008, `code for ${reason}`);
      assert.equal(close.reason, reason);
      p.guest.close();
    }
  });

  test('invalid JSON after join closes with 1008', async () => {
    const p = await pairLobby(h, 'Bozuk JSON');
    p.host.send('{not json');
    const close = await p.host.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Invalid JSON');
    p.guest.close();
  });

  test('a message larger than 2048 bytes is refused by the transport', async () => {
    const p = await pairLobby(h, 'Büyük Mesaj');
    p.host.send('x'.repeat(3000));
    const close = await p.host.waitClose();
    assert.ok(close.code !== 1000, `closed with ${close.code}`);
    p.guest.close();
  });

  test('sending faster than the rate budget closes with "Message rate exceeded"', async () => {
    const p = await pairLobby(h, 'Hız Sınırı');
    for (let i = 1; i <= 80; i++) p.host.send(pose(i));
    const close = await p.host.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Message rate exceeded');
    p.guest.close();
  });

  test('when one peer leaves the other gets left with the leaver id', async () => {
    const p = await pairLobby(h, 'Ayrılma');
    p.host.close();
    const left = await p.guest.next((m) => m.type === 'left');
    assert.equal(left.id, p.hostWelcome.id);
    p.guest.close();
  });

  test('when the last peer leaves the room is removed: listing and checks no longer see it', async () => {
    const p = await pairLobby(h, 'Oda Temizliği');
    p.host.close();
    await p.guest.next((m) => m.type === 'left');
    p.guest.close();
    await sleep(100);
    const list = await api(h.origin, 'GET', '/api/lobbies');
    assert.ok(!list.data.lobbies.some((l) => l.id === p.id), 'room is gone from the list');
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('check', p.id, p.hostKey));
    const close = await s.waitClose();
    assert.equal(close.reason, 'Join key rejected');
  });

  test('a dropped guest can reconnect with the same credential while the host stays', async () => {
    const p = await pairLobby(h, 'Yeniden Bağlan');
    p.guest.close();
    await p.host.next((m) => m.type === 'left');
    const again = await connectRelay(h.wsBase, h.origin);
    again.send(hello('join', p.id, p.guestKey));
    const w = await again.type('welcome');
    assert.deepEqual(w.peers, [p.hostWelcome.id]);
    const joined = await p.host.next((m) => m.type === 'joined' && m.id === w.id);
    assert.equal(joined.id, w.id);
    p.host.close();
    again.close();
  });
});

describe('relay: access control', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('a third peer with an unrelated key is rejected', async () => {
    const p = await pairLobby(h, 'Üçüncü Yok');
    const intruder = await connectRelay(h.wsBase, h.origin);
    intruder.send(hello('join', p.id, 'not-a-real-credential-1234'));
    const close = await intruder.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Join key rejected');
    p.host.close();
    p.guest.close();
  });

  test('re-using a connected seat credential is refused as already connected', async () => {
    const p = await pairLobby(h, 'Çift Bağlantı');
    const dup = await connectRelay(h.wsBase, h.origin);
    dup.send(hello('join', p.id, p.hostKey));
    const close = await dup.waitClose();
    assert.equal(close.reason, 'Session already connected');
    p.host.close();
    p.guest.close();
  });

  test('a fourth attempt to join through the HTTP API is 409 while two peers are seated', async () => {
    const p = await pairLobby(h, 'HTTP Dolu');
    const res = await joinLobby(h.origin, p.id, 'Cem');
    assert.equal(res.status, 409);
    p.host.close();
    p.guest.close();
  });

  test('wrong join key is rejected with 1008 "Join key rejected"', async () => {
    const created = await createLobby(h.origin, { name: 'Anahtar Hatası' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('join', created.lobby.id, 'wrong-wrong-wrong'));
    const close = await s.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Join key rejected');
  });

  test('wrong build is refused with a room build/map mismatch', async () => {
    const created = await createLobby(h.origin, { name: 'Sürüm Hatası' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('join', created.lobby.id, created.session.credential, { build: '8b0b5899ed-replica-19990101-v9' }));
    const close = await s.waitClose();
    assert.equal(close.reason, 'Room build/map mismatch');
  });

  test('wrong map is refused with a room build/map mismatch', async () => {
    const created = await createLobby(h.origin, { name: 'Harita Hatası' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('join', created.lobby.id, created.session.credential, { map: 'env_test' }));
    const close = await s.waitClose();
    assert.equal(close.reason, 'Room build/map mismatch');
  });

  test('malformed build or unsupported map is "Invalid build/map"', async () => {
    const created = await createLobby(h.origin, { name: 'Biçim Hatası' });
    const a = await connectRelay(h.wsBase, h.origin);
    a.send(hello('join', created.lobby.id, created.session.credential, { build: 'bad build' }));
    assert.equal((await a.waitClose()).reason, 'Invalid build/map');
    const b = await connectRelay(h.wsBase, h.origin);
    b.send(hello('join', created.lobby.id, created.session.credential, { map: 'mars' }));
    assert.equal((await b.waitClose()).reason, 'Invalid build/map');
  });

  test('protocol other than 1 and unknown message types are "Protocol mismatch"', async () => {
    const created = await createLobby(h.origin, { name: 'Protokol' });
    const a = await connectRelay(h.wsBase, h.origin);
    a.send(hello('join', created.lobby.id, created.session.credential, { protocol: 2 }));
    assert.equal((await a.waitClose()).reason, 'Protocol mismatch');
    const b = await connectRelay(h.wsBase, h.origin);
    b.send(hello('hello', created.lobby.id, created.session.credential));
    assert.equal((await b.waitClose()).reason, 'Protocol mismatch');
  });

  test('room ids with dots or over 32 characters are "Invalid room"', async () => {
    const created = await createLobby(h.origin, { name: 'Oda Adı' });
    const a = await connectRelay(h.wsBase, h.origin);
    a.send(hello('join', 'a.b', created.session.credential));
    assert.equal((await a.waitClose()).reason, 'Invalid room');
    const b = await connectRelay(h.wsBase, h.origin);
    b.send(hello('join', 'x'.repeat(33), created.session.credential));
    assert.equal((await b.waitClose()).reason, 'Invalid room');
  });

  test('a first message that is not JSON is "Invalid or incomplete request"', async () => {
    const s = await connectRelay(h.wsBase, h.origin);
    s.send('<<not json>>');
    assert.equal((await s.waitClose()).reason, 'Invalid or incomplete request');
  });

  test('a connection origin outside the allowlist fails the handshake with 403', async () => {
    const s = new RelaySocket(h.wsBase, 'https://evil.example');
    await s.ready;
    assert.equal(s.handshakeError, 403);
  });

  test('a connection with no Origin header fails the handshake with 403', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`${h.wsBase}/relay`);
    const status = await new Promise((resolve) => {
      ws.once('unexpected-response', (_r, res) => resolve(res.statusCode));
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    assert.equal(status, 403);
  });

  test('a relay path with a query string is rejected', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`${h.wsBase}/relay?x=1`, { headers: { Origin: h.origin } });
    const status = await new Promise((resolve) => {
      ws.once('unexpected-response', (_r, res) => resolve(res.statusCode));
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    assert.ok(status === 400 || status === 404, `got ${status}`);
  });
});

describe('relay: isolation, timing, limits', () => {
  test('poses never cross between lobbies', async () => {
    const h = await startApp();
    try {
      const a = await pairLobby(h, 'Oda Bir');
      const c = await pairLobby(h, 'Oda İki');
      a.host.send(pose(1, [1, 1, 1]));
      c.host.send(pose(1, [9, 9, 9]));
      await a.guest.next((m) => m.type === 'pose' && m.position[0] === 1);
      await c.guest.next((m) => m.type === 'pose' && m.position[0] === 9);
      await sleep(150);
      assert.equal(a.guest.inbox.filter((m) => m.type === 'pose').length, 0);
      assert.equal(c.guest.inbox.filter((m) => m.type === 'pose').length, 0);
      for (const s of [a.host, a.guest, c.host, c.guest]) s.close();
    } finally {
      await h.close();
    }
  });

  test('a credential that expires while pending cannot join; the lobby disappears', async () => {
    const h = await startApp({ pendingTtlMs: 250, sweepIntervalMs: 50 });
    try {
      const created = await createLobby(h.origin, { name: 'Bayat Oturum' });
      await sleep(400);
      const s = await connectRelay(h.wsBase, h.origin);
      s.send(hello('join', created.lobby.id, created.session.credential));
      assert.equal((await s.waitClose()).reason, 'Join key rejected');
      const list = await api(h.origin, 'GET', '/api/lobbies');
      assert.equal(list.data.lobbies.length, 0);
    } finally {
      await h.close();
    }
  });

  test('a check refreshes a pending reservation so the player can finish game loading', async () => {
    const h = await startApp({ pendingTtlMs: 400, sweepIntervalMs: 50 });
    try {
      const created = await createLobby(h.origin, { name: 'Yükleme' });
      await sleep(250);
      const c = await connectRelay(h.wsBase, h.origin);
      c.send(hello('check', created.lobby.id, created.session.credential));
      await c.type('checked');
      await sleep(250); // 500ms after creation: alive only because the check refreshed it
      const s = await connectRelay(h.wsBase, h.origin);
      s.send(hello('join', created.lobby.id, created.session.credential));
      const w = await s.type('welcome');
      assert.equal(w.protocol, 1);
      s.close();
    } finally {
      await h.close();
    }
  });

  test('heartbeat: a peer that stops answering pings is closed with "Heartbeat timeout"', async () => {
    const h = await startApp({ heartbeatIntervalMs: 100 });
    try {
      const created = await createLobby(h.origin, { name: 'Kalp Atışı' });
      const quiet = await connectRelay(h.wsBase, h.origin, { autoPong: false });
      quiet.send(hello('join', created.lobby.id, created.session.credential));
      await quiet.type('welcome');
      const close = await quiet.waitClose(2000);
      assert.equal(close.code, 1008);
      assert.equal(close.reason, 'Heartbeat timeout');
    } finally {
      await h.close();
    }
  });

  test('heartbeat: a responsive peer stays connected', async () => {
    const h = await startApp({ heartbeatIntervalMs: 100 });
    try {
      const created = await createLobby(h.origin, { name: 'Canlı' });
      const alive = await connectRelay(h.wsBase, h.origin);
      alive.send(hello('join', created.lobby.id, created.session.credential));
      await alive.type('welcome');
      await sleep(450);
      assert.equal(alive.closed, null);
      alive.close();
    } finally {
      await h.close();
    }
  });

  test('a hello that never arrives is closed after the hello timeout', async () => {
    const h = await startApp({ helloTimeoutMs: 150 });
    try {
      const silent = await connectRelay(h.wsBase, h.origin);
      const close = await silent.waitClose(2000);
      assert.equal(close.code, 1008);
      assert.equal(close.reason, 'Invalid or incomplete request');
    } finally {
      await h.close();
    }
  });

  test('the socket ceiling refuses new connections with 503', async () => {
    const h = await startApp({ maxSockets: 1 });
    try {
      const first = await connectRelay(h.wsBase, h.origin);
      const second = new RelaySocket(h.wsBase, h.origin);
      await second.ready;
      assert.equal(second.handshakeError, 503);
      first.close();
    } finally {
      await h.close();
    }
  });

  test('releasing an active seat over HTTP closes that peer and notifies the other', async () => {
    const h = await startApp();
    try {
      const p = await pairLobby(h, 'Serbest Bırak');
      const res = await api(h.origin, 'POST', `/api/lobbies/${p.id}/release`, {
        json: { credential: p.guestKey },
        headers: { Origin: h.origin },
      });
      assert.equal(res.status, 200);
      const closed = await p.guest.waitClose();
      assert.equal(closed.code, 1000);
      assert.equal(closed.reason, 'Released');
      const left = await p.host.next((m) => m.type === 'left');
      assert.equal(left.id, p.guestWelcome.id);
      p.host.close();
    } finally {
      await h.close();
    }
  });

  test('lobby maximum age closes active peers with "Lobby expired"', async () => {
    const h = await startApp({ maxLobbyAgeMs: 300, sweepIntervalMs: 50 });
    try {
      const created = await createLobby(h.origin, { name: 'Ömür' });
      const s = await connectRelay(h.wsBase, h.origin);
      s.send(hello('join', created.lobby.id, created.session.credential));
      await s.type('welcome');
      const close = await s.waitClose(2000);
      assert.equal(close.reason, 'Lobby expired');
    } finally {
      await h.close();
    }
  });

  test('128 concurrent WebSocket clients join one room, broadcast poses, send cached lastPose to late joiners, and notify on leave', async () => {
    const h = await startApp();
    const sockets = [];
    try {
      const created = await createLobby(h.origin, { name: 'Massive128', capacity: 128 });
      const room = created.lobby.id;
      const keys = [created.session.credential];
      for (let i = 1; i < 128; i++) {
        const res = await joinLobby(h.origin, room, `P${i}`);
        assert.equal(res.status, 200, `join ${i} status: ${res.status}`);
        keys.push(res.data.session.credential);
      }
      // First 127 clients connect and join
      const ids = [];
      for (let i = 0; i < 127; i++) {
        const ws = await connectRelay(h.wsBase, h.origin);
        sockets.push(ws);
        ws.send(hello('join', room, keys[i]));
        const w = await ws.type('welcome');
        assert.equal(w.peers.length, i);
        ids.push(w.id);
      }
      // Client 0 and Client 1 send poses before Client 127 (the 128th player) joins
      sockets[0].send({ type: 'pose', seq: 1, model: 0, position: [10, 20, 30], rotation: [0, 0, 0] });
      sockets[1].send({ type: 'pose', seq: 2, model: 0, position: [40, 50, 60], rotation: [0, 0, 90] });
      const p0At2 = await sockets[2].next((m) => m.type === 'pose' && m.id === ids[0]);
      assert.deepEqual(p0At2.position, [10, 20, 30]);
      const p1At2 = await sockets[2].next((m) => m.type === 'pose' && m.id === ids[1]);
      assert.deepEqual(p1At2.position, [40, 50, 60]);

      // 128th client joins and receives welcome with 127 peers + cached lastPose snapshots for Client 0 and Client 1 only
      const lastWs = await connectRelay(h.wsBase, h.origin);
      sockets.push(lastWs);
      lastWs.send(hello('join', room, keys[127]));
      const wLast = await lastWs.type('welcome');
      assert.equal(wLast.peers.length, 127);
      const snap0 = await lastWs.next((m) => m.type === 'pose' && m.id === ids[0]);
      const snap1 = await lastWs.next((m) => m.type === 'pose' && m.id === ids[1]);
      assert.deepEqual(snap0.position, [10, 20, 30]);
      assert.equal(snap0.seq, 1);
      assert.deepEqual(snap1.position, [40, 50, 60]);
      assert.equal(snap1.seq, 2);
      // Client 0 receives joined for the 128th player
      const jLast = await sockets[0].next((m) => m.type === 'joined' && m.id === wLast.id);
      assert.equal(jLast.id, wLast.id);

      // 128th client leaves; remaining peers get left notification
      lastWs.close();
      const leftMsg = await sockets[0].next((m) => m.type === 'left' && m.id === wLast.id);
      assert.equal(leftMsg.id, wLast.id);
    } finally {
      for (const s of sockets) s.close();
      await h.close();
    }
  });
});
