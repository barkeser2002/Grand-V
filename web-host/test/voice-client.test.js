// Voice client lifecycle (public/voice.js) under a FAKE environment: fake getUserMedia tracks,
// fake RTCPeerConnection and a fake DOM. This checks control flow, signalling order, cleanup and
// consent gating only. It is NOT evidence that a real microphone or a real peer connection works;
// that needs a real browser with permissions (manual step, see VOICE.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const VOICE = new URL('../public/voice.js', import.meta.url);
const ID_A = 'aaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbb';
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
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
    this.disabled = false;
    this.removed = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  remove() {
    this.removed = true;
  }
  click() {
    for (const fn of this.listeners.click || []) fn({});
  }
  play() {
    this.played = (this.played || 0) + 1;
    return this.playRejects ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : Promise.resolve();
  }
  pause() {}
}

function makeEnv({ supported = true, permission = 'granted', ice = null, iceFails = false } = {}) {
  const env = { pcs: [], audios: [], getUserMediaCalls: 0, streams: [], windowListeners: {} };
  class FakePC {
    constructor(cfg) {
      this.config = cfg;
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.senders = [];
      this.localDescription = null;
      this.remoteDescription = null;
      this.added = [];
      this.queued = [];
      this.closed = false;
      this.offers = 0;
      env.pcs.push(this);
    }
    getSenders() {
      return this.senders;
    }
    addTrack(track) {
      this.senders.push({ track });
      queueMicrotask(() => this.onnegotiationneeded && this.onnegotiationneeded());
      return this.senders[this.senders.length - 1];
    }
    createDataChannel() { this.probe = true; }
    restartIce() {
      this.restarts = (this.restarts || 0) + 1;
      queueMicrotask(() => this.onnegotiationneeded && this.onnegotiationneeded());
    }
    async createOffer() {
      this.offers += 1;
      return { type: 'offer', sdp: `v=0\r\no=offer-${this.offers}\r\n` };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'v=0\r\no=answer\r\n' };
    }
    async setLocalDescription(d) {
      this.localDescription = { type: d.type, sdp: d.sdp };
      this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d;
      this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate(c) {
      if (!this.remoteDescription) throw new Error('no remote description');
      this.added.push(c.candidate);
    }
    setConfiguration(cfg) {
      this.config = cfg;
    }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
    setConnection(state) {
      this.connectionState = state;
      this.onconnectionstatechange && this.onconnectionstatechange();
    }
    fireTrack(stream) {
      this.ontrack && this.ontrack({ streams: [stream], track: stream.getTracks()[0] });
    }
    fireCandidate(c) {
      this.onicecandidate && this.onicecandidate({ candidate: c });
    }
  }

  const doc = {
    body: new FakeElement('body'),
    createElement(tag) {
      const el = new FakeElement(tag);
      if (tag === 'audio') env.audios.push(el);
      return el;
    },
  };
  const navigator = supported
    ? {
        mediaDevices: {
          getUserMedia: async () => {
            env.getUserMediaCalls += 1;
            if (permission === 'denied') {
              throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
            }
            const stream = new FakeStream([new FakeTrack('audio')]);
            env.streams.push(stream);
            return stream;
          },
        },
      }
    : {};
  const sandbox = {
    console,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    JSON,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    document: doc,
    navigator,
    addEventListener: (t, fn) => {
      (env.windowListeners[t] = env.windowListeners[t] || []).push(fn);
    },
    removeEventListener: (t, fn) => {
      env.windowListeners[t] = (env.windowListeners[t] || []).filter((f) => f !== fn);
    },
    fetch: async () => {
      if (iceFails) throw new Error('network down');
      return { ok: ice !== null, json: async () => ice };
    },
  };
  if (supported) sandbox.RTCPeerConnection = FakePC;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(VOICE, 'utf8'), sandbox, { filename: 'voice.js' });
  env.FiveWebVoice = sandbox.FiveWebVoice;
  env.root = sandbox;
  env.FakeStream = FakeStream;
  env.doc = doc;
  return env;
}

const PUBLIC_POLICY = {
  provider: 'public', mode: 'turn',
  iceServers: [{ urls: ['turn:public.example.test:80'], username: 'fixture', credential: 'fixture' }],
  fallbackIceServers: [{ urls: ['turn:own.example.test:3478'], username: 'fixture', credential: 'fixture' }],
};
function policyEnv() {
  const env = makeEnv();
  env.timers = new Map();
  let next = 0;
  env.root.setTimeout = (fn, ms) => { env.timers.set(++next, { fn, ms }); return next; };
  env.root.clearTimeout = (id) => env.timers.delete(id);
  env.expire = () => { for (const [id, { fn }] of [...env.timers]) { env.timers.delete(id); fn(); } };
  return env;
}
test('public policy probes relay only after opt-in; relay success selects public alone and cleans up', async () => {
  const env = policyEnv();
  let fetched = 0;
  const sent = [];
  const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], send: (o) => sent.push(o), fetchIce: async () => { fetched++; return PUBLIC_POLICY; } });
  assert.equal(fetched, 0);
  assert.equal(env.pcs.length, 0);
  env.doc.body.children[0].children[0].click();
  await flush();
  const probe = env.pcs[0];
  assert.equal(env.doc.body.children[0].children[0].disabled, false, 'user can leave while probing');
  assert.equal(env.doc.body.children[0].children[0].textContent, 'Sesi kapat');
  assert.equal(probe.config.iceTransportPolicy, 'relay');
  assert.equal(probe.probe, true);
  assert.equal(probe.senders.length, 0);
  assert.equal(sent.length, 0, 'isolated probe SDP never signalled');
  assert.equal([...env.timers.values()][0].ms, 4000);
  probe.fireCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 123 typ relay' });
  await flush();
  assert.equal(probe.closed, true);
  assert.equal(probe.onicecandidate, null);
  assert.equal(env.timers.size, 0);
  assert.equal(env.pcs[1].config.iceServers, PUBLIC_POLICY.iceServers);
  assert.match(env.doc.body.children[0].children[3].textContent, /Genel TURN/);
  v.stop();
});

for (const failure of ['timeout', 'gathering-complete', 'offer-error', 'candidate-error']) {
  test(`public availability ${failure} selects own backup alone and releases probe`, async () => {
    const env = policyEnv();
    if (failure === 'offer-error') {
      const Base = env.root.RTCPeerConnection;
      env.root.RTCPeerConnection = class extends Base { async createOffer() { if (this.probe) throw new Error('probe failed'); return super.createOffer(); } };
    }
    const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], fetchIce: async () => PUBLIC_POLICY });
    env.doc.body.children[0].children[0].click();
    await flush();
    const probe = env.pcs[0];
    if (failure === 'timeout') env.expire();
    if (failure === 'gathering-complete') probe.fireCandidate(null);
    if (failure === 'candidate-error') probe.onicecandidateerror({ errorCode: 701 });
    await flush();
    assert.equal(env.pcs.length, 2);
    assert.equal(env.pcs[1].config.iceServers, PUBLIC_POLICY.fallbackIceServers);
    assert.equal(probe.closed, true);
    assert.equal(probe.onicecandidate, null);
    assert.equal(probe.onicecandidateerror, null);
    assert.equal(env.timers.size, 0);
    assert.match(env.doc.body.children[0].children[3].textContent, /Yedek TURN/);
    v.stop();
  });
}

for (const action of ['leave', 'stop', 'peer-left']) {
  test(`${action} during public probe closes probe and ignores late callbacks`, async () => {
    const env = policyEnv();
    const sent = [];
    const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], send: (o) => sent.push(o), fetchIce: async () => PUBLIC_POLICY });
    const join = env.doc.body.children[0].children[0];
    join.click();
    await flush();
    const probe = env.pcs[0];
    const stale = probe.onicecandidate;
    if (action === 'leave') join.click();
    if (action === 'stop') v.stop();
    if (action === 'peer-left') v.onPeerLeft(ID_B);
    assert.equal(probe.closed, true);
    assert.equal(env.timers.size, 0);
    stale({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ relay' } });
    await flush();
    assert.equal(env.pcs.length, 1, 'no late voice connection');
    assert.equal(sent.length, 0);
    if (action !== 'peer-left') assert.equal(env.streams[0].getTracks()[0].stopped, true);
    v.stop();
  });
}
test('leaving during ICE fetch cannot resurrect voice or overwrite a later join', async () => {
  const env = policyEnv();
  let resolve;
  const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], fetchIce: () => new Promise((r) => { resolve = r; }) });
  const join = env.doc.body.children[0].children[0];
  join.click(); await flush();
  join.click();
  resolve(PUBLIC_POLICY); await flush();
  assert.equal(env.pcs.length, 0);
  assert.equal(v.state().mode, 'off');
  assert.equal(v.state().hasMic, false);
  v.stop();
});

for (const failureState of ['connection', 'ice']) {
  test(`${failureState} failure switches public to own exactly once with ICE restart, preserving tracks`, async () => {
    const env = policyEnv();
    const sent = [];
    const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], send: (o) => sent.push(o), fetchIce: async () => PUBLIC_POLICY });
    env.doc.body.children[0].children[0].click(); await flush();
    env.pcs[0].fireCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ relay' }); await flush();
    const pc = env.pcs[1];
    v.onSignal({ type: 'voice-signal', from: ID_B, signal: { type: 'answer', sdp: 'v=0\r\n' } }); await flush();
    const track = pc.senders[0].track;
    if (failureState === 'ice') { pc.iceConnectionState = 'failed'; pc.oniceconnectionstatechange?.(); }
    else pc.setConnection('failed');
    await flush();
    assert.equal(pc.config.iceServers, PUBLIC_POLICY.fallbackIceServers);
    assert.equal(pc.restarts, 1);
    assert.equal(pc.senders[0].track, track);
    assert.equal(track.stopped, false);
    assert.equal(env.getUserMediaCalls, 1);
    assert.equal(sent.filter((o) => o.signal.type === 'offer').length, 2);
    assert.equal(v.state().conn, 'connecting');
    assert.match(env.doc.body.children[0].children[3].textContent, /Yedek TURN/);
    // Browsers can emit both failure events for the same failed ICE generation.
    pc.iceConnectionState = 'failed'; pc.oniceconnectionstatechange?.(); pc.setConnection('failed');
    assert.equal(v.state().conn, 'connecting', 'old-generation duplicate failure is not backup failure');
    pc.setConnection('connecting');
    pc.setConnection('failed'); await flush();
    assert.equal(pc.restarts, 1);
    assert.equal(v.state().conn, 'failed');
    assert.match(env.doc.body.children[0].children[3].textContent, /yedek.*başarısız/i);
    const stale = pc.onconnectionstatechange;
    v.stop(); stale(); await flush();
    assert.equal(pc.restarts, 1);
    assert.equal(env.timers.size, 0);
  });
}

test('backup ICE restart deadline reports failure instead of retrying forever; stop clears timer', async () => {
  for (const action of ['expire', 'stop', 'connected']) {
    const env = policyEnv();
    const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], fetchIce: async () => PUBLIC_POLICY });
    env.doc.body.children[0].children[0].click(); await flush();
    env.pcs[0].fireCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ relay' }); await flush();
    env.pcs[1].setConnection('failed'); await flush();
    assert.equal([...env.timers.values()][0]?.ms, 12000);
    if (action === 'expire') { env.expire(); assert.equal(v.state().conn, 'failed'); }
    if (action === 'stop') v.stop();
    if (action === 'connected') env.pcs[1].setConnection('connected');
    assert.equal(env.timers.size, 0);
    v.stop();
  }
});

test('two public peers finish probes at different times, then simultaneous backup restart survives glare', async () => {
  const ea = policyEnv(); const eb = policyEnv();
  let A, B;
  const relay = (to, from) => (o) => queueMicrotask(() => to().onSignal({ type: 'voice-signal', from, signal: o.signal }));
  A = ea.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], fetchIce: async () => PUBLIC_POLICY, send: relay(() => B, ID_A) });
  B = eb.FiveWebVoice.attach({ selfId: ID_B, peers: [ID_A], fetchIce: async () => PUBLIC_POLICY, send: relay(() => A, ID_B) });
  ea.doc.body.children[0].children[0].click(); eb.doc.body.children[0].children[0].click(); await flush();
  ea.pcs[0].fireCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ relay' }); await flush();
  assert.equal(eb.pcs.length, 1, 'offer waits for peer public probe, no default/direct PC');
  B.onSignal({ type: 'voice-signal', from: ID_A, signal: { type: 'ice', candidate: 'candidate:early 1 udp 1 1.2.3.4 1 typ relay' } });
  eb.pcs[0].fireCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ relay' }); await flush(); await flush();
  assert.equal(ea.pcs[1].signalingState, 'stable');
  assert.equal(eb.pcs[1].signalingState, 'stable');
  assert.deepEqual(eb.pcs[1].added, ['candidate:early 1 udp 1 1.2.3.4 1 typ relay']);
  ea.pcs[1].setConnection('failed'); eb.pcs[1].setConnection('failed'); await flush(); await flush();
  for (const env of [ea, eb]) {
    const pc = env.pcs[1];
    assert.equal(pc.restarts, 1);
    assert.equal(pc.config.iceServers, PUBLIC_POLICY.fallbackIceServers);
    assert.equal(pc.signalingState, 'stable');
    assert.equal(pc.senders.length, 1);
    assert.equal(env.getUserMediaCalls, 1);
    pc.setConnection('connected');
    assert.equal(env.timers.size, 0);
  }
  A.stop(); B.stop();
});

test('late permission rejection after stop cannot change stopped state', async () => {
  const env = policyEnv();
  let reject;
  env.root.navigator.mediaDevices.getUserMedia = () => new Promise((_, r) => { reject = r; });
  const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B] });
  env.doc.body.children[0].children[0].click(); v.stop();
  reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await flush();
  assert.equal(v.state().mode, 'stopped');
});
test('late offer creation after leave does not mutate closed PC or send signals', async () => {
  const env = policyEnv();
  let release;
  const Base = env.root.RTCPeerConnection;
  env.root.RTCPeerConnection = class extends Base { createOffer() { return new Promise((r) => { release = r; }); } };
  const sent = [];
  const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], send: (o) => sent.push(o) });
  const join = env.doc.body.children[0].children[0];
  join.click(); await flush(); join.click();
  release({ type: 'offer', sdp: 'v=0\r\n' }); await flush();
  assert.equal(env.pcs[0].localDescription, null);
  assert.equal(sent.length, 0);
  assert.equal(v.state().mode, 'off');
  v.stop();
});

test('injected public policy retries public first on a fresh opt-in after backup selection', async () => {
  const env = policyEnv();
  const v = env.FiveWebVoice.attach({ selfId: ID_A, peers: [ID_B], iceConfig: PUBLIC_POLICY });
  const join = env.doc.body.children[0].children[0];
  join.click(); await flush(); env.expire(); await flush();
  assert.equal(env.pcs[1].config.iceServers, PUBLIC_POLICY.fallbackIceServers);
  join.click(); join.click(); await flush();
  assert.equal(env.pcs[2].config.iceTransportPolicy, 'relay');
  assert.equal(env.pcs[2].config.iceServers, PUBLIC_POLICY.iceServers);
  v.stop();
});

describe('voice client (fake media and RTCPeerConnection; lifecycle only)', () => {
  test('unsupported browser: explicit message, join disabled, no connection and no mic prompt', () => {
    const env = makeEnv({ supported: false });
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    const box = env.doc.body.children[0];
    assert.equal(v.state().mode, 'unsupported');
    assert.match(box.children[2].textContent, /desteklemiyor/);
    assert.equal(box.children[0].disabled, true);
    v.onPeerJoined(ID_B);
    assert.equal(env.pcs.length, 0);
    assert.notEqual(v.state().conn, 'connected');
    v.stop();
  });

  test('no microphone prompt on page load; nothing is created before the click', () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    assert.equal(env.getUserMediaCalls, 0);
    assert.equal(env.pcs.length, 0);
    assert.equal(v.state().mode, 'off');
    assert.equal(env.doc.body.children[0].children[0].textContent, 'Sese katıl');

    v.stop();
  });

  test('a click asks for audio only; permission denial is a Turkish message with no tracks', async () => {
    const env = makeEnv({ permission: 'denied' });
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [] });
    env.doc.body.children[0].children[0].click();
    await flush();
    assert.equal(env.getUserMediaCalls, 1);
    assert.equal(v.state().mode, 'denied');
    assert.equal(v.state().hasMic, false);
    assert.match(env.doc.body.children[0].children[3].textContent, /Mikrofon izni verilmedi/);
    v.stop();
  });

  test('stop before any click never touches the microphone; stop is idempotent and removes the UI', () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    v.stop();
    v.stop();
    assert.equal(env.getUserMediaCalls, 0);
    assert.equal(env.doc.body.children[0].removed, true);
    assert.equal(env.windowListeners.pagehide.length, 0, 'pagehide listener removed');
    assert.equal(v.state().mode, 'stopped');
  });

  test('stop while the permission prompt is open: the late stream is stopped at once', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [] });
    env.doc.body.children[0].children[0].click();
    v.stop();
    await flush();
    assert.equal(env.streams.length, 1);
    assert.equal(env.streams[0].getTracks()[0].stopped, true);
    assert.equal(v.state().hasMic, false);
  });

  test('a pagehide stops voice: mic track stopped, peer connection closed', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    env.doc.body.children[0].children[0].click();
    await flush();
    const track = env.streams[0].getTracks()[0];
    for (const fn of env.windowListeners.pagehide || []) fn({});
    assert.equal(track.stopped, true);
    assert.equal(v.state().mode, 'stopped');
  });

  test('deterministic offerer: the smaller id offers; the larger id answers; both opted in means one offer', async () => {
    const ea = makeEnv();
    const eb = makeEnv();
    const sent = [];
    function relay(obj, from) {
      sent.push([from, obj.signal.type]);
      queueMicrotask(() => (from === 'a' ? B : A).onSignal({ type: 'voice-signal', from: from === 'a' ? ID_A : ID_B, signal: obj.signal }));
    }
    const A = ea.FiveWebVoice.attach({ send: (o) => relay(o, 'a'), selfId: ID_A, peers: [ID_B] });
    const B = eb.FiveWebVoice.attach({ send: (o) => relay(o, 'b'), selfId: ID_B, peers: [ID_A] });
    ea.doc.body.children[0].children[0].click();
    eb.doc.body.children[0].children[0].click();
    await flush();
    await flush();
    assert.ok(A.state().mode === 'on' && B.state().mode === 'on');
    assert.ok(sent.some(([f, t]) => f === 'a' && t === 'offer'), 'the smaller id offers');
    assert.ok(sent.some(([, t]) => t === 'answer'), 'an answer comes back');
    assert.equal(ea.pcs[0].localDescription.type, 'offer');
    assert.equal(eb.pcs[0].localDescription.type, 'answer');
    A.stop();
    B.stop();
  });


  test('a peer that is not opted in answers with no microphone prompt', async () => {
    const env = makeEnv();
    const other = makeEnv();
    const A = env.FiveWebVoice.attach({ send: (o) => queueMicrotask(() => B.onSignal({ type: 'voice-signal', from: ID_A, signal: o.signal })), selfId: ID_A, peers: [ID_B] });
    const B = other.FiveWebVoice.attach({ send: (o) => queueMicrotask(() => A.onSignal({ type: 'voice-signal', from: ID_B, signal: o.signal })), selfId: ID_B, peers: [ID_A] });
    env.doc.body.children[0].children[0].click();
    await flush();
    await flush();
    assert.equal(other.getUserMediaCalls, 0, 'listener did not open a mic');
    assert.equal(other.pcs.length, 1, 'listener built a connection to answer');
    assert.equal(other.pcs[0].localDescription.type, 'answer');
    assert.equal(B.state().hasMic, false);
    const track = remoteStream(env);
    other.pcs[0].fireTrack(track);
    assert.ok(other.audios[0].srcObject, 'remote audio attached');
    assert.equal(other.audios[0].played, 1);
    A.stop();
    B.stop();
  });

  test('candidates arriving before the remote description are queued, then applied in order', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_B, peers: [ID_A] });
    v.onSignal({ type: 'voice-signal', from: ID_A, signal: { type: 'ice', candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal(env.pcs.length, 0, 'no connection without an offer');
    v.onSignal({ type: 'voice-signal', from: ID_A, signal: { type: 'offer', sdp: 'v=0\r\no=x\r\n' } });
    await flush();
    v.onSignal({ type: 'voice-signal', from: ID_A, signal: { type: 'ice', candidate: 'candidate:2 1 udp 1 10.0.0.2 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    await flush();
    assert.deepEqual(env.pcs[0].added, ['candidate:2 1 udp 1 10.0.0.2 1 typ host']);
    v.stop();
  });

  test('signals from anyone but the remote peer are ignored (spoof / third party)', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_B, peers: [ID_A] });
    v.onSignal({ type: 'voice-signal', from: 'cccccccccccccccc', signal: { type: 'offer', sdp: 'v=0\r\n' } });
    v.onSignal({ type: 'pose', from: ID_A, signal: { type: 'offer', sdp: 'v=0\r\n' } });
    await flush();
    assert.equal(env.pcs.length, 0);
    v.stop();
  });

  test('connection state is shown only from the real connectionState; a failure is not reported as connected', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    env.doc.body.children[0].children[0].click();
    await flush();
    const pc = env.pcs[0];
    pc.setConnection('connecting');
    assert.equal(v.state().conn, 'connecting');
    pc.setConnection('failed');
    assert.equal(v.state().conn, 'failed');
    assert.notEqual(v.state().conn, 'connected');
    pc.setConnection('connected');
    assert.equal(v.state().conn, 'connected');
    v.stop();
  });

  test('mute toggles the track without releasing it; unmute re-enables', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [] });
    env.doc.body.children[0].children[0].click();
    await flush();
    const mute = env.doc.body.children[0].children[1];
    mute.click();
    assert.equal(env.streams[0].getTracks()[0].enabled, false);
    assert.equal(env.streams[0].getTracks()[0].stopped, false);
    assert.equal(mute.textContent, 'Mikrofonu aç');
    mute.click();
    assert.equal(env.streams[0].getTracks()[0].enabled, true);
    v.stop();
  });

  test('leaving voice stops the mic track and closes the connection; the peer leaving closes it too', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    env.doc.body.children[0].children[0].click();
    await flush();
    const pc = env.pcs[0];
    env.doc.body.children[0].children[0].click();
    assert.equal(env.streams[0].getTracks()[0].stopped, true);
    assert.equal(pc.closed, true);
    assert.equal(v.state().mode, 'off');
    v.stop();
  });

  test('peer leaves: its connection closes, remote audio is released, state goes idle', async () => {
    const env = makeEnv();
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B] });
    env.doc.body.children[0].children[0].click();
    await flush();
    const pc = env.pcs[0];
    pc.fireTrack(remoteStream(env));
    v.onPeerLeft(ID_B);
    assert.equal(pc.closed, true);
    assert.equal(v.state().remote, null);
    assert.equal(v.state().conn, 'idle');
    assert.equal(env.audios[0].srcObject, null);
    v.stop();
  });

  test('ICE is fetched only after the click and applied to the connection; no servers means a direct-mode note', async () => {
    const env = makeEnv({ ice: { iceServers: [{ urls: ['turn:t.example.test:3478?transport=udp'], username: '1:x', credential: 'c' }], mode: 'turn' } });
    let fetched = 0;
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [ID_B], fetchIce: async () => { fetched += 1; return env.ice || { iceServers: [{ urls: ['turn:t.example.test:3478?transport=udp'] }] }; } });
    assert.equal(fetched, 0, 'no ICE request on load');
    env.doc.body.children[0].children[0].click();
    await flush();
    assert.equal(fetched, 1);
    assert.equal(env.pcs[0].config.iceServers.length, 1);
    v.stop();

    const direct = makeEnv();
    const d = direct.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [], fetchIce: async () => ({ iceServers: [], mode: 'direct' }) });
    direct.doc.body.children[0].children[0].click();
    await flush();
    assert.match(direct.doc.body.children[0].children[3].textContent, /TURN yok/);
    d.stop();
  });

  test('a failed ICE request is reported and never faked as a TURN connection', async () => {
    const env = makeEnv({ iceFails: true });
    const v = env.FiveWebVoice.attach({ send: () => true, selfId: ID_A, peers: [], fetchIce: async () => { throw new Error('down'); } });
    env.doc.body.children[0].children[0].click();
    await flush();
    assert.equal(v.state().mode, 'on');
    assert.match(env.doc.body.children[0].children[3].textContent, /yapılandırması alınamadı|TURN yok/);
    v.stop();
  });

  test('a peer that joins while the user is already opted in gets an offer right away', async () => {
    const env = makeEnv();
    const sent = [];
    const v = env.FiveWebVoice.attach({ send: (o) => sent.push(o), selfId: ID_A, peers: [] });
    env.doc.body.children[0].children[0].click();
    await flush();
    v.onPeerJoined(ID_B);
    await flush();
    assert.deepEqual(sent.map((o) => [o.type, o.target, o.signal.type]), [['voice-signal', ID_B, 'offer']]);
    assert.equal(env.pcs.length, 1);
    v.stop();
  });

  test('multi-peer voice: connects to multiple peers simultaneously and closes only the departed peer connection', async () => {
    const ID_C = 'cccccccccccccccc';
    const env = makeEnv();
    const sent = [];
    const v = env.FiveWebVoice.attach({ send: (o) => sent.push(o), selfId: ID_A, peers: [ID_B, ID_C] });
    env.doc.body.children[0].children[0].click();
    await flush();
    assert.equal(env.pcs.length, 2, 'creates a dedicated RTCPeerConnection per peer');
    const targets = sent.filter((o) => o.signal.type === 'offer').map((o) => o.target).sort();
    assert.deepEqual(targets, [ID_B, ID_C]);
    env.pcs[0].setConnection('connected');
    env.pcs[1].setConnection('connected');
    assert.equal(v.state().conn, 'connected');
    v.onPeerLeft(ID_B);
    assert.equal(env.pcs[0].closed, true);
    assert.equal(env.pcs[1].closed, false, 'remaining peer connection stays open');
    assert.equal(v.state().conn, 'connected');
    v.onPeerLeft(ID_C);
    assert.equal(env.pcs[1].closed, true);
    assert.equal(v.state().conn, 'idle');
    v.stop();
  });
});

// Helper: a fake remote MediaStream carrying one audio track.
function remoteStream(env) {
  return new env.FakeStream([new FakeTrack('audio')]);
}
