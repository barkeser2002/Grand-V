// Slice 2: lobby HTTP API against the real server on a loopback socket.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, api, createLobby, joinLobby, BUILD, rawRequest } from './helpers.js';

const isoOk = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

describe('lobby API: list, create, join', () => {
  let h;
  const logs = [];
  before(async () => {
    h = await startApp({ log: (line) => logs.push(String(line)) });
  });
  after(() => h.close());

  test('GET /api/lobbies on an empty server returns an empty real list (no fake rows)', async () => {
    const res = await api(h.origin, 'GET', '/api/lobbies');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.data.lobbies, []);
    assert.ok(isoOk(res.data.generatedAt));
  });

  test('POST /api/lobbies creates a lobby: 201, URL-safe id, credential only in the session object', async () => {
    const res = await api(h.origin, 'POST', '/api/lobbies', {
      json: { name: 'Akşam Sürüşü', nickname: 'Ada', map: 'gta5', build: BUILD },
      headers: { Origin: h.origin },
    });
    assert.equal(res.status, 201, res.text);
    const { lobby, session, launchPath } = res.data;
    assert.match(lobby.id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(lobby.name, 'Akşam Sürüşü');
    assert.equal(lobby.capacity, 2);
    assert.equal(lobby.players, 1);
    assert.equal(lobby.status, 'open');
    assert.equal(lobby.build, BUILD);
    assert.equal(lobby.map, 'gta5');
    assert.equal(session.role, 'host');
    assert.ok(session.credential.length >= 32);
    assert.ok(isoOk(session.expiresAt));
    assert.equal(launchPath, `/launcher.html?lobby=${lobby.id}`);
    assert.ok(!launchPath.includes(session.credential), 'credential never appears in a URL');
  });

  test('GET /api/lobbies lists the real lobby, without any credential', async () => {
    const created = await createLobby(h.origin, { name: 'Listeleme', nickname: 'Ali' });
    const res = await api(h.origin, 'GET', '/api/lobbies');
    const row = res.data.lobbies.find((l) => l.id === created.lobby.id);
    assert.ok(row, 'created lobby is listed');
    assert.equal(row.hostNickname, 'Ali');
    assert.equal(row.players, 1);
    assert.equal(row.capacity, 2);
    assert.ok(!res.text.includes(created.session.credential), 'list never carries credentials');
  });

  test('POST /api/lobbies/:id/join returns a guest session; the lobby becomes full (2/2)', async () => {
    const created = await createLobby(h.origin, { name: 'Dolacak' });
    const res = await joinLobby(h.origin, created.lobby.id, 'Bora');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.session.role, 'guest');
    assert.notEqual(res.data.session.credential, created.session.credential);
    assert.equal(res.data.lobby.players, 2);
    assert.equal(res.data.lobby.status, 'full');
    const list = await api(h.origin, 'GET', '/api/lobbies');
    assert.equal(list.data.lobbies.find((l) => l.id === created.lobby.id).status, 'full');
  });

  test('third join on a full lobby is refused with 409', async () => {
    const created = await createLobby(h.origin, { name: 'Üçüncü Yok' });
    assert.equal((await joinLobby(h.origin, created.lobby.id, 'Bora')).status, 200);
    const third = await joinLobby(h.origin, created.lobby.id, 'Cem');
    assert.equal(third.status, 409);
    assert.match(third.data.error, /dolu/);
  });

  test('joining a nonexistent lobby is 404 and does not reveal credentials', async () => {
    const res = await joinLobby(h.origin, 'AAAAAAAAAAAAAAAA', 'Bora');
    assert.equal(res.status, 404);
    assert.equal(res.data.session, undefined);
  });

  test('malformed lobby id in the join path is rejected before any lookup', async () => {
    const res = await joinLobby(h.origin, '..%2F..%2Fsecret', 'Bora');
    assert.ok([400, 404].includes(res.status));
    assert.equal(res.data.session, undefined);
  });

  test('credentials and join keys are never written to the server log', async () => {
    const created = await createLobby(h.origin, { name: 'Log Testi' });
    const joined = await joinLobby(h.origin, created.lobby.id, 'Eda');
    const all = logs.join('\n');
    assert.ok(!all.includes(created.session.credential), 'host credential not logged');
    assert.ok(!all.includes(joined.data.session.credential), 'guest credential not logged');
    assert.ok(logs.length > 0, 'requests are logged');
  });
});

describe('lobby API: strict input validation', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  const cases = [
    ['empty name', { name: '', nickname: 'Ada' }],
    ['name with markup', { name: '<img src=x>', nickname: 'Ada' }],
    ['name too long', { name: 'x'.repeat(41), nickname: 'Ada' }],
    ['nickname missing', { name: 'Olur' }],
    ['nickname with quotes', { name: 'Olur', nickname: 'a"b' }],
    ['unsupported map', { name: 'Olur', nickname: 'Ada', map: 'mars' }],
    ['unknown field', { name: 'Olur', nickname: 'Ada', credential: 'x' }],
    ['wrong build', { name: 'Olur', nickname: 'Ada', build: '1.0.0' }],
  ];
  for (const [label, body] of cases) {
    test(`create rejected: ${label}`, async () => {
      const res = await api(h.origin, 'POST', '/api/lobbies', { json: body, headers: { Origin: h.origin } });
      assert.equal(res.status, 400, res.text);
      assert.equal(typeof res.data.error, 'string');
    });
  }

  test('non-JSON content type is 415', async () => {
    const res = await api(h.origin, 'POST', '/api/lobbies', {
      rawBody: 'name=Olur&nickname=Ada',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(res.status, 415);
  });

  test('invalid JSON body is 400 with a JSON error', async () => {
    const res = await api(h.origin, 'POST', '/api/lobbies', { rawBody: '{"name": ', headers: { Origin: h.origin } });
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(typeof res.data.error, 'string');
  });

  test('oversized body (over 4 KiB) is 413', async () => {
    const big = JSON.stringify({ name: 'Olur', nickname: 'Ada', pad: 'x'.repeat(8000) });
    const res = await api(h.origin, 'POST', '/api/lobbies', { rawBody: big, headers: { Origin: h.origin } });
    assert.equal(res.status, 413);
  });

  test('a body that is a JSON array instead of an object is 400', async () => {
    const res = await api(h.origin, 'POST', '/api/lobbies', { json: ['Olur', 'Ada'], headers: { Origin: h.origin } });
    assert.equal(res.status, 400);
  });

  test('join with a bad nickname is 400', async () => {
    const created = await createLobby(h.origin, { name: 'Join Valid' });
    const res = await joinLobby(h.origin, created.lobby.id, '');
    assert.equal(res.status, 400);
  });

  test('wrong method on /api/lobbies is 405 with Allow, as JSON', async () => {
    const res = await api(h.origin, 'PUT', '/api/lobbies', { json: {} });
    assert.equal(res.status, 405);
    assert.match(res.headers.allow, /GET/);
    assert.equal(typeof res.data.error, 'string');
  });

  test('unknown /api path is a JSON 404', async () => {
    const res = await api(h.origin, 'GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
  });
});

describe('lobby API: cross-origin and abuse limits', () => {
  test('state-changing requests from a foreign origin are refused with 403', async () => {
    const h = await startApp();
    try {
      const res = await api(h.origin, 'POST', '/api/lobbies', {
        json: { name: 'Olur', nickname: 'Ada' },
        headers: { Origin: 'https://evil.example' },
      });
      assert.equal(res.status, 403);
      const none = await api(h.origin, 'GET', '/api/lobbies', { headers: { Origin: 'https://evil.example' } });
      assert.equal(none.status, 200, 'public read is allowed cross-origin without credentials');
    } finally {
      await h.close();
    }
  });

  test('creation rate limit answers 429 with Retry-After', async () => {
    const h = await startApp({ rateLimits: { create: { limit: 2, windowMs: 60_000 } } });
    try {
      for (let i = 0; i < 2; i++) {
        const ok = await createLobby(h.origin, { name: `Hız ${i}` });
        assert.ok(ok.lobby.id);
      }
      const limited = await api(h.origin, 'POST', '/api/lobbies', {
        json: { name: 'Fazla', nickname: 'Ada' },
        headers: { Origin: h.origin },
      });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers['retry-after']) >= 1);
    } finally {
      await h.close();
    }
  });

  test('lobby capacity limit returns 503 when the store is full', async () => {
    const h = await startApp({ maxLobbies: 1 });
    try {
      await createLobby(h.origin, { name: 'Birinci' });
      const res = await api(h.origin, 'POST', '/api/lobbies', {
        json: { name: 'İkinci', nickname: 'Ada' },
        headers: { Origin: h.origin },
      });
      assert.equal(res.status, 503);
    } finally {
      await h.close();
    }
  });

  test('release endpoint frees a pending guest seat and needs the credential in the body', async () => {
    const h = await startApp();
    try {
      const created = await createLobby(h.origin, { name: 'Bırakma' });
      const guest = await joinLobby(h.origin, created.lobby.id, 'Bora');
      const denied = await api(h.origin, 'POST', `/api/lobbies/${created.lobby.id}/release`, {
        json: { credential: 'nope-nope-nope-nope' },
        headers: { Origin: h.origin },
      });
      assert.equal(denied.status, 404);
      const ok = await api(h.origin, 'POST', `/api/lobbies/${created.lobby.id}/release`, {
        json: { credential: guest.data.session.credential },
        headers: { Origin: h.origin },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.released, true);
      const list = await api(h.origin, 'GET', '/api/lobbies');
      assert.equal(list.data.lobbies.find((l) => l.id === created.lobby.id).players, 1);
    } finally {
      await h.close();
    }
  });

  test('raw request with a body on a GET API route is handled without hanging', async () => {
    const h = await startApp();
    try {
      const res = await rawRequest(h.origin, { method: 'GET', path: '/api/lobbies?x=1' });
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });
});
