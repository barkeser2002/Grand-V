// Relay close path: repeated close requests on one socket must be idempotent and must not
// register listeners per call (MaxListenersExceededWarning under message floods).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, createLobby, connectRelay, BUILD } from './helpers.js';

const hello = (type, room, key) => ({ type, protocol: 1, room, key, build: BUILD, map: 'gta5' });
const pose = (seq) => ({ type: 'pose', seq, model: 0, position: [1, 2, 3], rotation: [0, 0, 0] });

describe('relay: close is idempotent', () => {
  let h;
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  before(async () => {
    process.on('warning', onWarning);
    h = await startApp();
  });
  after(async () => {
    process.off('warning', onWarning);
    await h.close();
  });

  test('a message flood after the rate limit closes once without listener warnings', async () => {
    const created = await createLobby(h.origin, { name: 'Flood' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send(hello('join', created.lobby.id, created.session.credential));
    await s.type('welcome');
    // 200 frames in one burst: each over-budget frame reaches #close while the socket is closing.
    for (let i = 1; i <= 200; i++) s.send(pose(i));
    const close = await s.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Message rate exceeded');
    await new Promise((r) => setTimeout(r, 50));
    const maxListeners = warnings.filter((w) => w.name === 'MaxListenersExceededWarning');
    assert.deepEqual(
      maxListeners.map((w) => w.message),
      [],
      'no MaxListenersExceededWarning',
    );
  });
});
