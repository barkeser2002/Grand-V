// Multiplayer runtime (public/multiplayer-game.js) against the REAL GTAPoseBridge read from disk
// and a real shared WebAssembly.Memory. Only the WebSocket transport is faked, and the "engine"
// side is simulated by clearing the command slot. This verifies mailbox I/O and protocol
// handling; it is not gameplay verification.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { BUILD } from './helpers.js';

const BRIDGE = (process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com') + '/pose_bridge.js';
const RUNTIME = new URL('../public/multiplayer-game.js', import.meta.url);
const PENDING = 'gta5.multiplayer.pending.v1';
const BLOCK = 1024;
const SIG = 0x424d5053;
const ID_A = 'aaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbb';
const KEY = 'correct-horse-9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closedWith = null;
    FakeSocket.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen();
  }
  deliver(obj) {
    this.onmessage({ data: JSON.stringify(obj) });
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code, reason) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  drop(code) {
    this.readyState = 3;
    this.onclose({ code });
  }
}

function makeMemory() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const view = new DataView(memory.buffer);
  view.setUint32(BLOCK + 32, SIG, true);
  view.setUint32(BLOCK + 36, 2, true);
  view.setInt32(BLOCK, 7, true); // guid
  setPos(memory, [100, 200, 30]);
  return memory;
}
function setPos(memory, [x, y, z]) {
  const view = new DataView(memory.buffer);
  view.setFloat32(BLOCK + 8, x, true);
  view.setFloat32(BLOCK + 16, y, true);
  view.setFloat32(BLOCK + 24, z, true);
}
const slotOf = (memory) => new Int32Array(memory.buffer, BLOCK + 64, 1)[0];
const cmdPos = (memory) => {
  const v = new DataView(memory.buffer);
  return [0, 1, 2].map((i) => v.getFloat32(BLOCK + 80 + i * 8, true));
};
// Simulated engine completion: clear the slot and report status 0 (success).
function engineDone(memory) {
  const v = new DataView(memory.buffer);
  v.setInt32(BLOCK + 72, 0, true);
  new Int32Array(memory.buffer, BLOCK + 64, 1)[0] = 0;
}

function makeSandbox({ search = '?mode=sandbox&multiplayer=1&poseproof=3', pending, origin = 'http://127.0.0.1:8097' } = {}) {
  const store = new Map();
  if (pending !== undefined) store.set(PENDING, pending);
  const logs = [];
  const sandbox = {
    console,
    JSON,
    Math,
    Number,
    Object,
    Array,
    Promise,
    Error,
    String,
    Int32Array,
    Uint32Array,
    Float32Array,
    DataView,
    Atomics,
    WebAssembly,
    TextEncoder,
    URL,
    URLSearchParams,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    location: { host: new URL(origin).host, protocol: new URL(origin).protocol, search },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      readyState: 'complete',
      body: { append() {} },
      createElement: () => ({ style: {}, setAttribute() {}, append() {}, textContent: '' }),
      addEventListener() {},
    },
    fetch: async () => ({ json: async () => ({ build: BUILD, protocol: 1, hz: 20 }) }),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BRIDGE, 'utf8'), sandbox, { filename: 'pose_bridge.js' });
  vm.runInContext(readFileSync(RUNTIME, 'utf8'), sandbox, { filename: 'multiplayer-game.js' });
  return { sandbox, store, logs, origin };
}

const pendingFor = (origin = 'http://127.0.0.1:8097', extra = {}) =>
  JSON.stringify({ url: origin.replace(/^http/, 'ws') + '/relay', room: 'room1', key: KEY, ...extra });

async function startRuntime(opts = {}) {
  const { sandbox, store, logs } = makeSandbox(opts.box);
  const memory = opts.memory || makeMemory();
  let world = false;
  let sock = null;
  const runtime = sandbox.GTAMultiplayerGame.attach(
    { memory, block: BLOCK, runtimeMain: true },
    (line) => logs.push(String(line)),
    {
      isWorldReady: () => world,
      tickMs: 5,
      worldPollMs: 5,
      createSocket: (url) => {
        sock = new FakeSocket(url);
        return sock;
      },
    },
  );
  const api = {
    sandbox,
    store,
    logs,
    memory,
    runtime,
    setWorld: (v) => (world = v),
    sock: () => sock,
  };
  return api;
}

describe('multiplayer runtime: mailbox and launch validation', () => {
  test('rejects a descriptor that is not runtimeMain (pthread instance)', async () => {
    const { sandbox } = makeSandbox({ pending: pendingFor() });
    const out = sandbox.GTAMultiplayerGame.attach({ memory: makeMemory(), block: BLOCK, runtimeMain: false }, () => {});
    assert.equal(out, null);
  });

  test('rejects a bad signature, wrong version, and out-of-bounds block', () => {
    const memory = makeMemory();
    const { sandbox } = makeSandbox({ pending: pendingFor() });
    new DataView(memory.buffer).setUint32(BLOCK + 32, 0x12345678, true);
    assert.equal(sandbox.GTAMultiplayerGame.attach({ memory, block: BLOCK, runtimeMain: true }, () => {}), null);
    const m2 = makeMemory();
    new DataView(m2.buffer).setUint32(BLOCK + 36, 1, true);
    assert.equal(sandbox.GTAMultiplayerGame.attach({ memory: m2, block: BLOCK, runtimeMain: true }, () => {}), null);
    assert.equal(sandbox.GTAMultiplayerGame.attach({ memory: makeMemory(), block: 1 << 20, runtimeMain: true }, () => {}), null);
  });

  test('rejects non-sandbox and singleplayer launches', () => {
    const { sandbox } = makeSandbox({ pending: pendingFor(), search: '?mode=story&multiplayer=1&poseproof=3' });
    assert.equal(sandbox.GTAMultiplayerGame.attach({ memory: makeMemory(), block: BLOCK, runtimeMain: true }, () => {}), null);
  });

  test('a pending launch on another origin is refused and removed', async () => {
    const h = await makeAndStart({ pending: pendingFor('http://evil.example:80') });
    assert.equal(h.store.has(PENDING), false);
    assert.ok(h.logs.some((l) => /Not started: Relay must be on the game website origin/.test(l)));
    assert.equal(h.sock(), null);
  });

  test('a pending launch is consumed once; a reload finds nothing', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    assert.equal(h.store.has(PENDING), false);
    assert.ok(h.sock(), 'socket created');
    h.runtime.stop('done');
  });
});

async function makeAndStart(opts) {
  const h = await startRuntime({ box: opts });
  await sleep(10);
  return h;
}

describe('multiplayer runtime: protocol, world gate, mailbox commands', () => {
  test('join frame carries room, key and build; the key never reaches the URL or log', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    assert.equal(h.sock().url, 'ws://127.0.0.1:8097/relay');
    h.sock().open();
    const join = h.sock().sent[0];
    assert.deepEqual({ type: join.type, protocol: join.protocol, room: join.room, key: join.key, build: join.build, map: join.map }, {
      type: 'join', protocol: 1, room: 'room1', key: KEY, build: BUILD, map: 'gta5',
    });
    assert.ok(!h.sock().url.includes(KEY));
    assert.ok(!h.logs.join('\n').includes(KEY));
    h.runtime.stop('done');
  });

  test('nothing is written or sent before the world is ready', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 1, model: 0, position: [1, 2, 3], rotation: [0, 0, 0] });
    await sleep(60);
    assert.equal(h.sock().sent.filter((m) => m.type === 'pose').length, 0);
    assert.equal(slotOf(h.memory), 0, 'no spawn queued before world ready');
    h.runtime.stop('done');
  });

  test('after world ready: local pose at real mailbox position; rotation zeros, model zero', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [], hz: 20 });
    h.setWorld(true);
    await sleep(60);
    const poses = h.sock().sent.filter((m) => m.type === 'pose');
    assert.ok(poses.length >= 3, `poses sent: ${poses.length}`);
    assert.deepEqual(poses[0].position, [100, 200, 30]);
    assert.deepEqual(poses[0].rotation, [0, 0, 0]);
    assert.equal(poses[0].model, 0);
    for (let i = 1; i < poses.length; i++) assert.ok(poses[i].seq > poses[i - 1].seq);
    h.runtime.stop('done');
  });

  test('remote pose spawns a replica, then moves it; "left" removes it after the engine is idle', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 1, model: 99, position: [5, 6, 7], rotation: [1, 2, 3] });
    await sleep(30);
    assert.equal(slotOf(h.memory), 1, 'spawn opcode queued');
    assert.deepEqual(cmdPos(h.memory), [5, 6, 7]);
    engineDone(h.memory);
    await sleep(30);
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 2, model: 0, position: [8, 9, 10], rotation: [0, 0, 0] });
    await sleep(30);
    assert.equal(slotOf(h.memory), 2, 'move opcode queued');
    assert.deepEqual(cmdPos(h.memory), [8, 9, 10]);
    engineDone(h.memory);
    await sleep(20);
    h.sock().deliver({ type: 'left', id: ID_B });
    await sleep(30);
    assert.equal(slotOf(h.memory), 3, 'remove opcode queued');
    engineDone(h.memory);
    await sleep(20);
    assert.equal(slotOf(h.memory), 0);
    h.runtime.stop('done');
  });

  test('a refused spawn (negative status) stops the replica and says so', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 1, model: 0, position: [1, 1, 1], rotation: [0, 0, 0] });
    await sleep(30);
    new DataView(h.memory.buffer).setInt32(BLOCK + 72, -3, true);
    new Int32Array(h.memory.buffer, BLOCK + 64, 1)[0] = 0;
    await sleep(30);
    assert.ok(h.logs.some((l) => /Replica spawn refused \(status -3\)/.test(l)));
    h.runtime.stop('done');
  });

  test('malformed and foreign poses never reach the mailbox', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 1, model: 0, position: [NaN, 0, 0], rotation: [0, 0, 0] });
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 2, model: 0, position: [1, 2, 5000], rotation: [0, 0, 0] });
    h.sock().deliver({ type: 'pose', id: ID_B, seq: -4, model: 0, position: [1, 2, 3], rotation: [0, 0, 0] });
    h.sock().deliver({ type: 'pose', id: 'cccccccccccccccc', seq: 3, model: 0, position: [1, 2, 3], rotation: [0, 0, 0] });
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 4, model: 0, position: [1, 2], rotation: [0, 0, 0] });
    await sleep(40);
    assert.equal(slotOf(h.memory), 0);
    h.runtime.stop('done');
  });

  test('cleanup: stop closes the relay, stops local sends, and reports the state', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    h.runtime.stop('Closed by test');
    const count = h.sock().sent.length;
    await sleep(30);
    assert.equal(h.sock().sent.length, count, 'no sends after stop');
    assert.equal(h.sock().closedWith.code, 1000);
    assert.ok(h.logs.some((l) => /Closed by test/.test(l)));
  });

  test('a dropped relay connection is reported without a secret and clears the timers', async () => {
    const h = await makeAndStart({ pending: pendingFor() });
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [], hz: 20 });
    h.setWorld(true);
    await sleep(15);
    h.sock().drop(1008);
    await sleep(30);
    assert.ok(h.logs.some((l) => /Connection closed \(1008\)/.test(l)));
    assert.ok(!h.logs.join('\n').includes(KEY));
  });

  test('multi-peer tracking: 3+ peers, closest-peer replica selection, seamless switch on leave without OP_REMOVE, and getPeers/getPeerCount/getLocalPose API', async () => {
    const ID_C = 'cccccccccccccccc';
    const ID_D = 'dddddddddddddddd';
    const h = await makeAndStart({ pending: pendingFor() });
    assert.equal(h.runtime.getLocalPose(), null);
    assert.equal(h.sandbox.GTAMultiplayerGame.getLocalPose(), null);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B, ID_C], hz: 20 });
    assert.equal(h.runtime.getPeerCount(), 2);
    assert.equal(h.sandbox.GTAMultiplayerGame.getPeerCount(), 2);
    h.sock().deliver({ type: 'joined', id: ID_D });
    assert.equal(h.runtime.getPeerCount(), 3);
    assert.equal(h.runtime.getPeers().length, 3);

    // World ready -> local pose is [100, 200, 30]
    h.setWorld(true);
    await sleep(25);
    assert.deepEqual([...h.runtime.getLocalPose()], [100, 200, 30]);
    assert.deepEqual([...h.sandbox.GTAMultiplayerGame.getLocalPose()], [100, 200, 30]);

    // Peer B is far ([500, 500, 30]), Peer C is closer ([110, 205, 30])
    h.sock().deliver({ type: 'pose', id: ID_B, seq: 1, model: 0, position: [500, 500, 30], rotation: [0, 0, 0] });
    h.sock().deliver({ type: 'pose', id: ID_C, seq: 1, model: 0, position: [110, 205, 30], rotation: [0, 0, 0] });
    await sleep(30);
    assert.equal(slotOf(h.memory), 1, 'spawn queued for closest peer C');
    assert.deepEqual(cmdPos(h.memory), [110, 205, 30]);
    engineDone(h.memory);
    await sleep(25);

    // Active closest peer C leaves while B still has a known pose -> switch replica to B via MOVE (not REMOVE)
    h.sock().deliver({ type: 'left', id: ID_C });
    assert.equal(h.runtime.getPeerCount(), 2);
    await sleep(30);
    assert.equal(slotOf(h.memory), 2, 'moves replica to remaining peer B instead of removing');
    assert.deepEqual(cmdPos(h.memory), [500, 500, 30]);
    engineDone(h.memory);
    await sleep(25);

    // Now B leaves and D has no pose -> no peers with poses remain, so OP_REMOVE is sent
    h.sock().deliver({ type: 'left', id: ID_B });
    await sleep(30);
    assert.equal(slotOf(h.memory), 3, 'removes replica when no peer with pose remains');
    engineDone(h.memory);
    h.runtime.stop('done');
  });
});

describe('multiplayer runtime: real pose bridge on disk', () => {
  test('pose_bridge.js exists at the mirror path (the runtime depends on it)', () => {
    if (!existsSync(BRIDGE)) return; // mirror not mounted on this machine
    assert.match(readFileSync(BRIDGE, 'utf8'), /root\.GTAPoseBridge=\{read,context,command,install,hashModel\}/);
  });
});
