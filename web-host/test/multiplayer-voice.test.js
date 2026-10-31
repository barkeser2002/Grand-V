// Multiplayer runtime + voice wired together (real public/multiplayer-game.js and public/voice.js
// in one vm sandbox). The engine bridge, the WebSocket and WebRTC are fakes; the relay frames go
// through the real protocol shapes. This proves the voice-signal path never becomes a pose and
// that voice is created after welcome and stopped on socket close or stop().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { BUILD } from './helpers.js';

const RUNTIME = new URL('../public/multiplayer-game.js', import.meta.url);
const VOICE = new URL('../public/voice.js', import.meta.url);
const PENDING = 'gta5.multiplayer.pending.v1';
const BLOCK = 1024;
const SIG = 0x424d5053;
const ID_A = 'aaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbb';
const KEY = 'correct-horse-9';
const ROOM = 'room1';
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

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.style = {};
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.removed = false;
    this.id = '';
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  append(...n) {
    this.children.push(...n);
  }
  remove() {
    this.removed = true;
  }
  click() {
    for (const fn of this.listeners.click || []) fn({});
  }
  play() {
    return Promise.resolve();
  }
}

function makeMemory() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const view = new DataView(memory.buffer);
  view.setUint32(BLOCK + 32, SIG, true);
  view.setUint32(BLOCK + 36, 2, true);
  view.setInt32(BLOCK, 7, true);
  return memory;
}
const slotOf = (memory) => new Int32Array(memory.buffer, BLOCK + 64, 1)[0];

function build({ fetchIce = { iceServers: [], mode: 'direct' }, permission = 'granted' } = {}) {
  const pending = JSON.stringify({ url: 'ws://127.0.0.1:8097/relay', room: ROOM, key: KEY });
  const store = new Map([[PENDING, pending]]);
  const env = { pcs: [], getUserMedia: 0, fetches: [], streams: [], logs: [] };
  class FakePC {
    constructor(cfg) {
      this.config = cfg;
      this.signalingState = 'stable';
      this.senders = [];
      this.closed = false;
      this.localDescription = null;
      env.pcs.push(this);
    }
    getSenders() {
      return this.senders;
    }
    addTrack(track) {
      this.senders.push({ track });
      return this.senders[0];
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\no=o\r\n' };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'v=0\r\no=a\r\n' };
    }
    async setLocalDescription(d) {
      this.localDescription = { type: d.type, sdp: d.sdp };
      this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(d) {
      this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate() {}
    setConfiguration() {}
    close() {
      this.closed = true;
    }
  }
  const body = new FakeElement('body');
  const doc = {
    body,
    readyState: 'complete',
    createElement: (t) => new FakeElement(t),
    addEventListener() {},
  };
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
    queueMicrotask,
    location: { host: '127.0.0.1:8097', protocol: 'http:', search: '?mode=sandbox&multiplayer=1&poseproof=3' },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: doc,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          env.getUserMedia += 1;
          if (permission === 'denied') throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
          const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
          const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
          env.streams.push(track);
          return stream;
        },
      },
    },
    RTCPeerConnection: FakePC,
    fetch: async (url, opts = {}) => {
      env.fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url === '/__hostinfo') return { json: async () => ({ build: BUILD, protocol: 1, hz: 20 }) };
      if (url === '/api/voice/ice') return { ok: true, json: async () => fetchIce };
      throw new Error('unexpected fetch ' + url);
    },
    addEventListener() {},
    removeEventListener() {},
    GTAPoseBridge: {
      read: () => ({ guid: 7, position: [100, 200, 30] }),
      command: () => true,
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(VOICE, 'utf8'), sandbox, { filename: 'voice.js' });
  vm.runInContext(readFileSync(RUNTIME, 'utf8'), sandbox, { filename: 'multiplayer-game.js' });
  return { sandbox, env, doc, store };
}

function start(opts = {}) {
  const h = build(opts);
  const memory = makeMemory();
  let world = false;
  let sock = null;
  const runtime = h.sandbox.GTAMultiplayerGame.attach(
    { memory, block: BLOCK, runtimeMain: true },
    (line) => h.env.logs.push(String(line)),
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
  return { ...h, memory, runtime, sock: () => sock, setWorld: (v) => (world = v) };
}

const voiceBox = (doc) => doc.body.children.find((c) => c.id === 'grandv-voice');
const signals = (sock) => sock.sent.filter((m) => m.type === 'voice-signal');

describe('multiplayer + voice: signalling is never a pose', () => {
  test('voice UI appears after welcome, not before; no mic prompt on load', async () => {
    const h = start();
    await sleep(10);
    assert.equal(voiceBox(h.doc), undefined, 'no voice UI before the socket is up');
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    await sleep(5);
    assert.ok(voiceBox(h.doc), 'voice UI after welcome');
    assert.equal(h.env.getUserMedia, 0);
    assert.equal(h.env.fetches.filter((f) => f.url === '/api/voice/ice').length, 0, 'no ICE request on load');
    h.runtime.stop('done');
  });

  test('voice-signal frames reach voice, produce an answer, and never touch the pose mailbox', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    h.sock().deliver({ type: 'voice-signal', from: ID_B, signal: { type: 'offer', sdp: 'v=0\r\no=b\r\n' } });
    await sleep(30);
    const answers = signals(h.sock()).filter((m) => m.signal.type === 'answer');
    assert.equal(answers.length, 1, 'answer sent back to the offering peer');
    assert.equal(answers[0].target, ID_B);
    assert.equal(slotOf(h.memory), 0, 'no engine command was queued by the signal');
    assert.equal(h.env.pcs.length, 1, 'a recvonly connection was created for the listener');
    h.runtime.stop('done');
  });

  test('a signal from a non-remote id is ignored (no connection, no answer)', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    h.sock().deliver({ type: 'voice-signal', from: 'cccccccccccccccc', signal: { type: 'offer', sdp: 'v=0\r\n' } });
    await sleep(30);
    assert.equal(h.env.pcs.length, 0);
    assert.equal(signals(h.sock()).length, 0);
    h.runtime.stop('done');
  });

  test('poses keep flowing at the tick rate while voice signalling is active', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    h.setWorld(true);
    await sleep(20);
    for (let i = 0; i < 5; i++) {
      h.sock().deliver({ type: 'voice-signal', from: ID_B, signal: { type: 'ice', candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' } });
    }
    const before = h.sock().sent.filter((m) => m.type === 'pose').length;
    await sleep(120);
    const after = h.sock().sent.filter((m) => m.type === 'pose');
    assert.ok(after.length - before >= 4, `pose frames continued (${after.length - before})`);
    for (let i = 1; i < after.length; i++) assert.ok(after[i].seq > after[i - 1].seq);
    assert.ok(after.every((p) => p.type === 'pose' && Array.isArray(p.position)), 'poses keep the pose shape');
    h.runtime.stop('done');
  });

  test('the click fetches ICE with the session credential in the JSON body only', async () => {
    const h = start({ fetchIce: { iceServers: [{ urls: ['turn:t.example.test:3478?transport=udp'], username: '1:x', credential: 'c' }], mode: 'turn' } });
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    voiceBox(h.doc).children[0].click();
    await sleep(20);
    const ice = h.env.fetches.find((f) => f.url === '/api/voice/ice');
    assert.ok(ice, 'ICE requested after the click');
    assert.equal(ice.method, 'POST');
    assert.deepEqual(JSON.parse(ice.body), { room: ROOM, credential: KEY });
    assert.ok(!ice.url.includes(KEY), 'credential not in the URL');
    assert.equal(h.env.getUserMedia, 1);
    assert.ok(!h.env.logs.join('\n').includes(KEY), 'credential not logged');
    h.runtime.stop('done');
  });

  test('a denied microphone leaves the game running and the voice UI honest', async () => {
    const h = start({ permission: 'denied' });
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [], hz: 20 });
    voiceBox(h.doc).children[0].click();
    await sleep(20);
    assert.match(voiceBox(h.doc).children[3].textContent, /Mikrofon izni verilmedi/);
    assert.equal(h.env.fetches.filter((f) => f.url === '/api/voice/ice').length, 0, 'no ICE without a mic');
    h.setWorld(true);
    await sleep(20);
    assert.ok(h.sock().sent.some((m) => m.type === 'pose'), 'poses still sent');
    h.runtime.stop('done');
  });

  test('ws close stops voice: UI removed, connection closed, mic released', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    voiceBox(h.doc).children[0].click();
    await sleep(20);
    assert.equal(h.env.getUserMedia, 1);
    const pc = h.env.pcs[0];
    assert.ok(pc, 'peer connection created while opted in');
    h.sock().drop(1006);
    await sleep(10);
    assert.equal(voiceBox(h.doc).removed, true);
    assert.equal(pc.closed, true);
    assert.equal(h.env.streams[0].stopped, true, 'mic track stopped');
    h.runtime.stop('done');
  });

  test('runtime stop stops voice too, and a later left/voice-signal is inert', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [ID_B], hz: 20 });
    voiceBox(h.doc).children[0].click();
    await sleep(20);
    h.runtime.stop('done');
    assert.equal(voiceBox(h.doc).removed, true);
    assert.equal(h.env.streams[0].stopped, true);
    h.sock().deliver({ type: 'voice-signal', from: ID_B, signal: { type: 'offer', sdp: 'v=0\r\n' } });
    h.sock().deliver({ type: 'left', id: ID_B });
    await sleep(20);
    assert.equal(h.env.pcs.length, 1, 'no new connection after stop');
  });

  test('stop before any click never initialises the microphone', async () => {
    const h = start();
    await sleep(10);
    h.sock().open();
    h.sock().deliver({ type: 'welcome', protocol: 1, id: ID_A, peers: [], hz: 20 });
    await sleep(5);
    h.runtime.stop('done');
    assert.equal(h.env.getUserMedia, 0);
    assert.equal(voiceBox(h.doc).removed, true);
  });
});
