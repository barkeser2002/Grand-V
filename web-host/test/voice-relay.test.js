// Voice signalling over the real /relay socket: forwarding, source-id stamping, rejects, and
// the guarantee that signalling never consumes the 20 Hz pose budget or closes pose sockets.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, createLobby, joinLobby, connectRelay, sleep, BUILD } from './helpers.js';
import { validateVoiceSignal } from '../src/relay.js';

const hello = (room, key) => ({ type: 'join', protocol: 1, room, key, build: BUILD, map: 'gta5' });
const pose = (seq) => ({ type: 'pose', seq, model: 0, position: [1, 2, 3], rotation: [0, 0, 0] });
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n';
const CAND = 'candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host';
const ID_X = 'ffffffffffffffff';

async function pair(h, name) {
  const created = await createLobby(h.origin, { name, nickname: 'Ada' });
  const joined = await joinLobby(h.origin, created.lobby.id, 'Bora');
  const a = await connectRelay(h.wsBase, h.origin);
  a.send(hello(created.lobby.id, created.session.credential));
  const aw = await a.type('welcome');
  const b = await connectRelay(h.wsBase, h.origin);
  b.send(hello(created.lobby.id, joined.data.session.credential));
  const bw = await b.type('welcome');
  await a.type('joined');
  return { lobbyId: created.lobby.id, a, b, aId: aw.id, bId: bw.id, aKey: created.session.credential, bKey: joined.data.session.credential };
}

// Pure validator: every malformed shape is refused, every legal shape passes unchanged.
describe('voice-signal validator (pure)', () => {
  const ok = (signal) => ({ type: 'voice-signal', target: ID_X, signal });
  test('accepts offer/answer SDP and ice candidates, copying only known fields', () => {
    assert.deepEqual(validateVoiceSignal(ok({ type: 'offer', sdp: SDP })).signal, { type: 'offer', sdp: SDP });
    assert.deepEqual(validateVoiceSignal(ok({ type: 'answer', sdp: SDP })).signal, { type: 'answer', sdp: SDP });
    const ice = validateVoiceSignal(ok({ type: 'ice', candidate: CAND, sdpMid: '0', sdpMLineIndex: 0 }));
    assert.deepEqual(ice.signal, { type: 'ice', candidate: CAND, sdpMid: '0', sdpMLineIndex: 0 });
  });
  test('refuses unknown fields, bad target, unknown signal types and non-SDP bodies', () => {
    const bad = [
      { type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: SDP }, from: ID_X },
      { type: 'voice-signal', target: 'NOT-HEX', signal: { type: 'offer', sdp: SDP } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'bye' } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: 'hello' } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: SDP.replace('v=0', 'v=1') } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: 'v=0\u0000' } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: 'v=0' + 'a'.repeat(16400) } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'ice', candidate: 'junk' } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'ice', candidate: CAND + '\r\nevil' } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'ice', candidate: CAND, sdpMLineIndex: 99 } },
      { type: 'voice-signal', target: ID_X, signal: { type: 'ice', candidate: CAND, extra: 1 } },
      { type: 'voice-signal', target: ID_X, signal: 'str' },
    ];
    for (const frame of bad) assert.throws(() => validateVoiceSignal(frame), /Invalid/, JSON.stringify(frame).slice(0, 80));
  });
});

describe('voice-signal over the real relay socket', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('offer, answer and ice are forwarded to the other peer with the server-stamped source id', async () => {
    const p = await pair(h, 'Sinyal Yönü');
    p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'offer', sdp: SDP } });
    const offer = await p.b.next((m) => m.type === 'voice-signal');
    assert.deepEqual(offer, { type: 'voice-signal', from: p.aId, signal: { type: 'offer', sdp: SDP } });
    p.b.send({ type: 'voice-signal', target: p.aId, signal: { type: 'answer', sdp: SDP } });
    const answer = await p.a.next((m) => m.type === 'voice-signal');
    assert.equal(answer.from, p.bId);
    assert.equal(answer.signal.type, 'answer');
    p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'ice', candidate: CAND, sdpMid: '0', sdpMLineIndex: 0 } });
    const ice = await p.b.next((m) => m.type === 'voice-signal');
    assert.equal(ice.signal.candidate, CAND);
    assert.equal(ice.from, p.aId);
    p.a.close();
    p.b.close();
  });

  test('a client-claimed sender (from) is a spoof attempt: the socket is closed', async () => {
    const p = await pair(h, 'Sahte Kaynak');
    p.a.send({ type: 'voice-signal', from: p.bId, target: p.bId, signal: { type: 'offer', sdp: SDP } });
    const close = await p.a.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Invalid voice signal');
    p.b.close();
  });

  test('a signal to self, to an unknown peer, or to a peer outside the room is dropped, not delivered', async () => {
    const p = await pair(h, 'Yanlış Hedef');
    const other = await pair(h, 'Başka Oda');
    p.a.send({ type: 'voice-signal', target: p.aId, signal: { type: 'offer', sdp: SDP } });
    p.a.send({ type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: SDP } });
    p.a.send({ type: 'voice-signal', target: other.bId, signal: { type: 'offer', sdp: SDP } });
    await sleep(120);
    assert.equal(p.a.inbox.filter((m) => m.type === 'voice-signal').length, 0);
    assert.equal(p.b.inbox.filter((m) => m.type === 'voice-signal').length, 0);
    assert.equal(other.b.inbox.filter((m) => m.type === 'voice-signal').length, 0);
    assert.equal(p.a.closed, null, 'sender stays connected');
    for (const s of [p.a, p.b, other.a, other.b]) s.close();
  });

  test('a peer that left is not a valid target any more', async () => {
    const p = await pair(h, 'Ayrılan');
    p.b.close();
    await p.a.next((m) => m.type === 'left');
    p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'offer', sdp: SDP } });
    await sleep(80);
    assert.equal(p.a.closed, null);
    p.a.close();
  });

  test('a voice-signal before the join is refused (no pre-welcome signalling)', async () => {
    const created = await createLobby(h.origin, { name: 'Erken Sinyal' });
    const s = await connectRelay(h.wsBase, h.origin);
    s.send({ type: 'voice-signal', target: ID_X, signal: { type: 'offer', sdp: SDP } });
    const close = await s.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Protocol mismatch');
    assert.ok(created.lobby.id);
  });

  test('a malformed SDP closes the sender with a reason; the peer receives nothing', async () => {
    const p = await pair(h, 'Bozuk SDP');
    p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'offer', sdp: 'not sdp' } });
    const close = await p.a.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Invalid SDP');
    await sleep(40);
    assert.equal(p.b.inbox.filter((m) => m.type === 'voice-signal').length, 0);
    p.b.close();
  });

  test('a burst of signals is rate bounded and drops the excess without closing the socket', async () => {
    const p = await pair(h, 'Sinyal Seli');
    for (let i = 0; i < 200; i++) {
      p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'ice', candidate: CAND } });
    }
    await sleep(150);
    const delivered = p.b.inbox.filter((m) => m.type === 'voice-signal').length;
    assert.ok(delivered >= 30 && delivered <= 45, `delivered ${delivered}`);
    assert.equal(p.a.closed, null, 'voice flood does not close the socket');
    p.a.close();
    p.b.close();
  });

  test('pose budget is separate: a voice burst does not spend pose tokens or disconnect poses', async () => {
    const p = await pair(h, 'Ayrı Kova');
    for (let i = 0; i < 100; i++) {
      p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'ice', candidate: CAND } });
    }
    for (let i = 1; i <= 20; i++) p.a.send(pose(i));
    const poses = await collectPoses(p.b, 20);
    assert.equal(poses.length, 20, 'all 20 poses delivered');
    assert.equal(p.a.closed, null, 'pose socket still open after voice flood');
    p.a.close();
    p.b.close();
  });

  test('pose frames are still capped at 2048 bytes even though voice frames may be larger', async () => {
    const p = await pair(h, 'Büyük Poz');
    const big = { type: 'pose', seq: 1, model: 0, position: [1, 2, 3], rotation: [0, 0, 0], pad: 'x'.repeat(2100) };
    p.a.send(big);
    const close = await p.a.waitClose();
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'Message too large');
    p.b.close();
  });

  test('a voice frame of up to 32 KiB is accepted by the transport', async () => {
    const p = await pair(h, 'Büyük Sinyal');
    const sdp = SDP + 'a=x:' + 'y'.repeat(14000) + '\r\n';
    p.a.send({ type: 'voice-signal', target: p.bId, signal: { type: 'offer', sdp } });
    const offer = await p.b.next((m) => m.type === 'voice-signal', 2000);
    assert.equal(offer.signal.sdp.length, sdp.length);
    p.a.close();
    p.b.close();
  });

  test('signalling never sends the SDP to the log', async () => {
    const logs = [];
    const h2 = await startApp({ log: (l) => logs.push(String(l)) });
    try {
      const created = await createLobby(h2.origin, { name: 'Log Sızıntısı' });
      const joined = await joinLobby(h2.origin, created.lobby.id, 'Bora');
      const a = await connectRelay(h2.wsBase, h2.origin);
      a.send(hello(created.lobby.id, created.session.credential));
      await a.type('welcome');
      const b = await connectRelay(h2.wsBase, h2.origin);
      b.send(hello(created.lobby.id, joined.data.session.credential));
      const bw = await b.type('welcome');
      a.send({ type: 'voice-signal', target: bw.id, signal: { type: 'offer', sdp: SDP } });
      await b.next((m) => m.type === 'voice-signal');
      assert.ok(!logs.join('\n').includes('o=- 1 2'), 'SDP body not logged');
      a.close();
      b.close();
    } finally {
      await h2.close();
    }
  });
});

async function collectPoses(sock, n) {
  const out = [];
  for (let i = 0; i < 400 && out.length < n; i++) {
    const idx = sock.inbox.findIndex((m) => m.type === 'pose');
    if (idx >= 0) out.push(sock.inbox.splice(idx, 1)[0]);
    else await sleep(5);
  }
  return out;
}
