// TURN REST credentials: pure config/HMAC checks and the real HTTP endpoint /api/voice/ice.
// Keys here are fixtures, never the parent's real TURN_SECRET. The env is set per test and restored.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, api, createLobby, joinLobby, BUILD } from './helpers.js';
import { loadIceConfig, issueIceCredentials, parseVoiceIce, ICE_TTL_SEC } from '../src/voice-ice.js';

const FIXTURE_SECRET = 'fixture-turn-secret-0123456789';
const FIXTURE_URLS = 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp';
const ENV_KEYS = ['TURN_URLS', 'TURN_SECRET', 'PUBLIC_TURN_URLS', 'PUBLIC_TURN_SECRET'];

test('public REST-HMAC primary is separate from own backup; neither secret is returned', () => {
  const out = issueIceCredentials(loadIceConfig({
    PUBLIC_TURN_URLS: 'turn:public.example.test:80?transport=tcp', PUBLIC_TURN_SECRET: 'public-fixture-secret',
    TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET,
  }), { nowMs: 1000000, random: () => 'fixture' });
  assert.equal(out.provider, 'public');
  assert.deepEqual(out.iceServers[0].urls, ['turn:public.example.test:80?transport=tcp']);
  assert.deepEqual(out.fallbackIceServers[0].urls, FIXTURE_URLS.split(','));
  for (const [server, secret] of [[out.iceServers[0], 'public-fixture-secret'], [out.fallbackIceServers[0], FIXTURE_SECRET]]) {
    assert.equal(server.credential, createHmac('sha1', secret).update(server.username).digest('base64'));
    assert.ok(!JSON.stringify(out).includes(secret));
  }
});

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

describe('voice ice: config and credentials (pure)', () => {
  test('loadIceConfig keeps only well-formed TURN urls and counts the rest without echoing them', () => {
    const cfg = loadIceConfig({
      TURN_URLS: `${FIXTURE_URLS},stun:stun.l.google.com:19302,turn:bad host:3478,turn:x.test:99999999`,
      TURN_SECRET: FIXTURE_SECRET,
    });
    assert.deepEqual(cfg.urls, FIXTURE_URLS.split(','));
    assert.equal(cfg.secret, FIXTURE_SECRET);
    assert.equal(cfg.dropped, 3);
    assert.ok(!JSON.stringify(cfg.urls).includes('bad host'));
  });

  test('no secret or no urls means direct mode with an empty server list', () => {
    assert.deepEqual(issueIceCredentials(loadIceConfig({ TURN_URLS: FIXTURE_URLS })), { iceServers: [], mode: 'direct' });
    assert.deepEqual(issueIceCredentials(loadIceConfig({ TURN_SECRET: FIXTURE_SECRET })), { iceServers: [], mode: 'direct' });
    assert.deepEqual(issueIceCredentials(loadIceConfig({})), { iceServers: [], mode: 'direct' });
  });

  test('issued credential: username is "<expiry>:<random>", 600 s validity, HMAC-SHA1 base64 over the username', () => {
    const cfg = loadIceConfig({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET });
    const nowMs = Date.UTC(2026, 9, 30, 12, 0, 0);
    const out = issueIceCredentials(cfg, { nowMs, random: () => 'a1b2c3d4e5f60708' });
    const expectedExpiry = nowMs / 1000 + ICE_TTL_SEC;
    const [server] = out.iceServers;
    assert.equal(server.username, `${expectedExpiry}:a1b2c3d4e5f60708`);
    const expected = createHmac('sha1', FIXTURE_SECRET).update(server.username, 'utf8').digest('base64');
    assert.equal(server.credential, expected);
    assert.deepEqual(server.urls, FIXTURE_URLS.split(','));
    assert.equal(out.expiresAt, new Date(expectedExpiry * 1000).toISOString());
    assert.equal(Date.parse(out.expiresAt) - nowMs, ICE_TTL_SEC * 1000);
    // No static password and no secret leak into the payload.
    assert.ok(!JSON.stringify(out).includes(FIXTURE_SECRET));
  });

  test('incomplete or malformed public config preserves own-only; complete public can run without backup', () => {
    for (const publicEnv of [
      { PUBLIC_TURN_URLS: 'turn:public.example.test:80' },
      { PUBLIC_TURN_SECRET: 'fixture-public-secret' },
      { PUBLIC_TURN_SECRET: 'fixture-public-secret', PUBLIC_TURN_URLS: 'stun:bad.example.test:80,turn:bad host:80' },
    ]) {
      const out = issueIceCredentials(loadIceConfig({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET, ...publicEnv }));
      assert.deepEqual(out.iceServers[0].urls, FIXTURE_URLS.split(','));
      assert.equal(out.provider, undefined);
      assert.equal(out.fallbackIceServers, undefined);
    }
    const out = issueIceCredentials(loadIceConfig({ PUBLIC_TURN_URLS: 'turn:public.example.test:80', PUBLIC_TURN_SECRET: 'fixture-public-secret' }));
    assert.equal(out.provider, 'public');
    assert.deepEqual(out.fallbackIceServers, []);
  });

  test('parseVoiceIce accepts exactly {room, credential} and rejects extra or malformed fields', () => {
    assert.deepEqual(parseVoiceIce({ room: 'abc_DEF-123', credential: 'correct-key-9' }), {
      room: 'abc_DEF-123',
      credential: 'correct-key-9',
    });
    assert.ok(parseVoiceIce({ room: 'a', credential: 'k1', extra: 1 }).error);
    assert.ok(parseVoiceIce({ room: 'bad room', credential: 'k1234' }).error);
    assert.ok(parseVoiceIce({ room: 'ok', credential: 'a b' }).error);
    assert.ok(parseVoiceIce(['x']).error);
  });
});

describe('voice ice: POST /api/voice/ice over HTTP', () => {
  let h;
  const logs = [];
  let host;
  let guest;
  before(async () => {
    h = await startApp({ log: (l) => logs.push(String(l)), rateLimits: { voice: { limit: 500, windowMs: 60_000 } } });
    host = await createLobby(h.origin, { name: 'Ses Testi', nickname: 'Ada' });
    guest = await joinLobby(h.origin, host.lobby.id, 'Bora');
  });
  after(() => h.close());

  // origin: defaults to the allowed origin; pass null to omit the Origin header entirely.
  const post = (body, origin = h.origin, raw) => {
    const headers = origin === null ? {} : { Origin: origin };
    if (raw !== undefined) return api(h.origin, 'POST', '/api/voice/ice', { rawBody: raw, headers });
    return api(h.origin, 'POST', '/api/voice/ice', { json: body, headers });
  };

  test('live host session gets TURN credentials; HMAC verifies with the fixture secret', async () => {
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const res = await post({ room: host.lobby.id, credential: host.session.credential });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.data.mode, 'turn');
      const [server] = res.data.iceServers;
      assert.deepEqual(server.urls, FIXTURE_URLS.split(','));
      const expiry = Number(server.username.split(':')[0]);
      assert.ok(Math.abs(expiry - (Date.now() / 1000 + ICE_TTL_SEC)) < 30, 'expiry about 10 minutes ahead');
      assert.equal(server.credential, createHmac('sha1', FIXTURE_SECRET).update(server.username).digest('base64'));
      assert.ok(!res.text.includes(FIXTURE_SECRET));
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  test('authenticated HTTP response preserves public primary and separately signed own backup', async () => {
    const publicSecret = 'fixture-public-rest-secret';
    await withEnv({ PUBLIC_TURN_URLS: 'turn:public.example.test:80', PUBLIC_TURN_SECRET: publicSecret, TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const res = await post({ room: host.lobby.id, credential: host.session.credential });
      assert.equal(res.status, 200);
      assert.equal(res.data.provider, 'public');
      assert.deepEqual(res.data.iceServers[0].urls, ['turn:public.example.test:80']);
      assert.deepEqual(res.data.fallbackIceServers[0].urls, FIXTURE_URLS.split(','));
      for (const [server, secret] of [[res.data.iceServers[0], publicSecret], [res.data.fallbackIceServers[0], FIXTURE_SECRET]]) {
        assert.equal(server.credential, createHmac('sha1', secret).update(server.username).digest('base64'));
        assert.ok(!res.text.includes(secret));
        assert.ok(!logs.join('\n').includes(secret));
      }
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });

  test('a guest seat (pending reservation) is also authorised', async () => {
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const res = await post({ room: host.lobby.id, credential: guest.data.session.credential });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.data.mode, 'turn');
    });
  });

  test('without TURN config the answer is direct mode with no servers', async () => {
    await withEnv({}, async () => {
      const res = await post({ room: host.lobby.id, credential: host.session.credential });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { iceServers: [], mode: 'direct' });
    });
  });

  test('wrong credential, unknown room, and a released seat are all 403 with no detail', async () => {
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const wrong = await post({ room: host.lobby.id, credential: 'definitely-wrong-key' });
      assert.equal(wrong.status, 403);
      const unknown = await post({ room: 'nosuchroom', credential: host.session.credential });
      assert.equal(unknown.status, 403);
      const cross = await post({ room: 'nosuchroom_x', credential: host.session.credential });
      assert.equal(cross.status, 403);
    });
  });

  test('a credential from another lobby is not accepted for this room', async () => {
    const other = await createLobby(h.origin, { name: 'Başka Lobi', nickname: 'Cem' });
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const res = await post({ room: host.lobby.id, credential: other.session.credential });
      assert.equal(res.status, 403);
    });
  });

  test('origin is required and must be allowed: foreign or missing Origin is 403', async () => {
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const foreign = await post({ room: host.lobby.id, credential: host.session.credential }, 'https://evil.example');
      assert.equal(foreign.status, 403);
      const none = await post({ room: host.lobby.id, credential: host.session.credential }, null);
      assert.equal(none.status, 403);
    });
  });

  test('body contract: JSON only, 4 KiB cap, no unknown fields, no query-string credential', async () => {
    await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
      const text = await api(h.origin, 'POST', '/api/voice/ice', {
        rawBody: JSON.stringify({ room: host.lobby.id, credential: host.session.credential }),
        contentType: 'text/plain',
        headers: { Origin: h.origin },
      });
      assert.equal(text.status, 415);
      const bad = await post(undefined, h.origin, '{"room": ');
      assert.equal(bad.status, 400);
      const extra = await post({ room: host.lobby.id, credential: host.session.credential, ttl: 1 });
      assert.equal(extra.status, 400);
      const big = await post(undefined, h.origin, JSON.stringify({ room: 'x', pad: 'y'.repeat(5000) }));
      assert.equal(big.status, 413);
      const q = await api(h.origin, 'POST', `/api/voice/ice?credential=${encodeURIComponent(host.session.credential)}`, {
        json: {},
        headers: { Origin: h.origin },
      });
      assert.equal(q.status, 400, 'credential in the URL is not used');
    });
  });

  test('GET is 405 with Allow: POST', async () => {
    const res = await api(h.origin, 'GET', '/api/voice/ice', {});
    assert.equal(res.status, 405);
    assert.match(res.headers.allow, /POST/);
  });

  test('the per-client voice bucket answers 429 after its limit, before any credential check', async () => {
    const tight = await startApp({ log: () => {}, rateLimits: { voice: { limit: 3, windowMs: 60_000 } } });
    try {
      await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
        const send = () =>
          api(tight.origin, 'POST', '/api/voice/ice', {
            json: { room: 'nosuchroom', credential: 'wrong-key-000' },
            headers: { Origin: tight.origin },
          });
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await send()).status);
        assert.deepEqual(codes, [403, 403, 403, 429]);
        const last = await send();
        assert.equal(last.status, 429);
        assert.ok(last.headers['retry-after']);
      });
    } finally {
      await tight.close();
    }
  });

  test('no response text or log line carries the secret', async () => {
    const quiet = [];
    const app = await startApp({ log: (l) => quiet.push(String(l)) });
    try {
      await withEnv({ TURN_URLS: FIXTURE_URLS, TURN_SECRET: FIXTURE_SECRET }, async () => {
        const res = await api(app.origin, 'POST', '/api/voice/ice', {
          json: { room: 'nosuchroom', credential: 'wrong-key-111' },
          headers: { Origin: app.origin },
        });
        assert.ok(!res.text.includes(FIXTURE_SECRET));
      });
      assert.ok(!quiet.join('\n').includes(FIXTURE_SECRET));
    } finally {
      await app.close();
    }
  });
});
