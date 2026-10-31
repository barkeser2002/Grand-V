/* Grand-V multiplayer runtime for the game page. Loaded by the web host before the game's own
   scripts; it defines GTAMultiplayerGame.attach, which game.html calls when multiplayer=1.
   Mailbox I/O goes only through the documented GTAPoseBridge API: read(memory, block) for the
   local pose and command(descriptor, opcode, position) for replica spawn (1), move (2) and
   remove (3). Read-only status words (ack/status/entity at block+68/72/108, the same offsets the
   pose-proof panel in pose_bridge.js reads) are used only to know when a command finished.
   Limitations, stated in README: rotation is not available from the mailbox, so [0,0,0] is sent;
   the model field is sent as 0 and the replica model is the engine default. */
(function (root) {
  'use strict';

  const t = (key, params) => root.FiveWebI18n ? root.FiveWebI18n.t(key, params) : key.replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);
  const PENDING_KEY = 'gta5.multiplayer.pending.v1';
  const SIGNATURE = 0x424d5053;
  const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const KEY_RE = /^[\x20-\x7e]{4,128}$/;
  const ID_RE = /^[0-9a-f]{16}$/;
  const POSITION_LIMIT = 20000;
  const HEIGHT_LIMIT = 2000;
  const OP = { SPAWN: 1, MOVE: 2, REMOVE: 3 };
  const SLOT = 64, ACK = 68, STATUS = 72, ENTITY = 108;
  const MAX_BUFFERED = 65536;
  const MAX_PEERS = 127;
  const SWITCH_MARGIN = 20; // metres: hysteresis before the replica jumps to a closer peer
  let active = null;

  const isFiniteVec = (v, limits) =>
    Array.isArray(v) && v.length === 3 && v.every((n, i) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < limits[i]);
  const POSITION_LIMITS = [POSITION_LIMIT, POSITION_LIMIT, HEIGHT_LIMIT];

  // Reads and validates the pending launch written by the launcher, then removes it so it can
  // be used once. Returns {url, room, key} or throws with a message that carries no secrets.
  function takePending(storage, loc) {
    const raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
    if (!raw) throw new Error('No multiplayer launch pending');
    let value;
    try {
      value = JSON.parse(raw);
    } catch (_) {
      throw new Error('Multiplayer launch data is unreadable');
    }
    let url;
    try {
      url = new URL(value.url);
    } catch (_) {
      throw new Error('Relay address is invalid');
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Relay address is invalid');
    }
    if (url.host !== loc.host) throw new Error('Relay must be on the game website origin');
    if (loc.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('An HTTPS page requires a WSS relay');
    if (typeof value.room !== 'string' || !ROOM_RE.test(value.room)) throw new Error('Room name is invalid');
    if (typeof value.key !== 'string' || !KEY_RE.test(value.key)) throw new Error('Join key is invalid');
    return { relayUrl: `${url.protocol}//${url.host}/relay`, room: value.room, key: value.key };
  }

  // Validates a relayed pose frame. Returns a copy or null (never throws on peer input).
  function validRemotePose(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (!Number.isSafeInteger(msg.seq) || msg.seq < 0 || msg.seq > 2147483647) return null;
    if (!isFiniteVec(msg.position, POSITION_LIMITS)) return null;
    return { seq: msg.seq, position: msg.position.slice() };
  }

  function mailboxOk(memory, block) {
    if (!memory || !memory.buffer || typeof memory.buffer.byteLength !== 'number') return 'Shared memory missing';
    if (!Number.isSafeInteger(block) || block <= 0 || block % 8 || block + 128 > memory.buffer.byteLength) {
      return 'Invalid command mailbox';
    }
    const view = new DataView(memory.buffer);
    if (view.getUint32(block + 32, true) !== SIGNATURE) return 'Mailbox signature mismatch';
    if (view.getUint32(block + 36, true) !== 2) return 'Replica mailbox version unsupported';
    return null;
  }

  // POST /api/voice/ice. The session credential travels only in the JSON body (never the URL or log).
  // A refused request rejects, and the voice UI then reports the failure; nothing is faked.
  function fetchVoiceIce(launch) {
    return root
      .fetch('/api/voice/ice', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: launch.room, credential: launch.key }),
      })
      .then((r) => {
        if (!r.ok) throw new Error('voice ICE request refused');
        return r.json();
      });
  }

  function attach(descriptor, log, options = {}) {
    const say = (msg) => {
      try {
        if (typeof log === 'function') log('[multiplayer] ' + msg);
      } catch (_) {
        /* logging must never break the runtime */
      }
    };
    const doc = root.document;
    const loc = root.location;
    const bridge = root.GTAPoseBridge;
    const panel = { text: null };

    const status = { line: 'Starting', peers: 0 };
    const render = () => {
      if (!panel.text) return;
      panel.text.textContent = t('Multiplayer: {status}\nPlayers: {count}', { status: t(status.key || status.line, status.params && { ...status.params, ...(status.params.reason ? { reason: t(status.params.reason) } : {}) }), count: status.peers });
    };
    const setStatus = (line, params) => {
      status.key = line;
      status.params = params;
      status.line = line.replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);
      say(status.line);
      render();
    };
    const mountPanel = () => {
      if (!doc || !doc.body || panel.text) return;
      const el = doc.createElement('div');
      el.id = 'grandv-mp-status';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:12px;top:12px;z-index:12;padding:8px 10px;background:#07100ee6;color:#b3d99b;font:12px monospace;white-space:pre;pointer-events:none';
      panel.text = doc.createElement('span');
      el.append(panel.text);
      doc.body.append(el);
      render();
    };

    if (!bridge || typeof bridge.read !== 'function' || typeof bridge.command !== 'function') {
      say('rejected: pose bridge missing');
      return null;
    }
    if (!descriptor || descriptor.runtimeMain !== true) {
      say('rejected: stats hook ran in a pthread instance');
      return null;
    }
    const bad = mailboxOk(descriptor.memory, descriptor.block);
    if (bad) {
      say('rejected: ' + bad);
      return null;
    }
    const search = new URLSearchParams(loc.search);
    if (search.get('mode') !== 'sandbox' || search.get('multiplayer') !== '1') {
      say('rejected: multiplayer is sandbox-only');
      return null;
    }

    let launch;
    try {
      launch = takePending(root.sessionStorage, loc);
    } catch (error) {
      setStatus('Not started: {reason}', { reason: error.message });
      return null;
    }

    const memory = descriptor.memory;
    const block = descriptor.block;
    const view = () => new DataView(memory.buffer);
    const slot = () => new Int32Array(memory.buffer, block + SLOT, 1);
    const busy = () => Atomics.load(slot(), 0) !== 0;
    const map = search.get('map') === 'env_test' ? 'env_test' : 'gta5';
    const createSocket = options.createSocket || ((url) => new root.WebSocket(url));
    const tickMs = options.tickMs || 50;
    const worldPollMs = options.worldPollMs || 250;
    const isWorldReady = () => {
      try {
        return options.isWorldReady ? options.isWorldReady() === true : false;
      } catch (_) {
        return false;
      }
    };

    let ws = null, selfId = null, seq = 0, world = false, closed = false;
    let worldTimer = null, tickTimer = null, build = null, hz = 20, localPose = null;
    // Every remote player in the room (up to MAX_PEERS). The engine mailbox has a single replica
    // slot, so only the nearest peer with a known pose is shown as an in-world ped; all peers are
    // available to the page (map overlay) through getPeers().
    const peers = new Map();
    const remote = { phase: 'none', target: null, lastMoved: -1, moveSeq: null, pos: null, failed: false };
    const latestOf = (id) => (peers.get(id) || {}).latest || null;
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    function bestPeer() {
      let best = null;
      for (const p of peers.values()) {
        if (!p.latest) continue;
        if (!best) { best = p; continue; }
        if (localPose) {
          if (dist(p.latest.position, localPose) < dist(best.latest.position, localPose)) best = p;
        } else if (p.updatedAt > best.updatedAt) best = p;
      }
      return best;
    }
    const cleanName = (n) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f<>]/g, '').slice(0, 40) : '');
    function addPeer(id, name) {
      if (!ID_RE.test(id) || id === selfId || peers.has(id) || peers.size >= MAX_PEERS) return false;
      peers.set(id, { id, name: cleanName(name), latest: null, updatedAt: 0 });
      status.peers = 1 + peers.size;
      return true;
    }

    function send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      if (ws.bufferedAmount > MAX_BUFFERED) return false;
      ws.send(JSON.stringify(obj));
      return true;
    }

    // Voice (public/voice.js, loaded first when present). It shares this authenticated socket;
    // its signals are never read as poses. Created after welcome, stopped with the socket.
    let voice = null;
    function startVoice(peers) {
      if (voice || closed || !root.FiveWebVoice || typeof root.FiveWebVoice.attach !== 'function') return;
      try {
        voice = root.FiveWebVoice.attach({
          send,
          selfId,
          peers,
          fetchIce: () => fetchVoiceIce(launch),
        });
      } catch (error) {
        voice = null;
        say('voice unavailable: ' + error.message);
      }
    }
    function stopVoice() {
      const v = voice;
      voice = null;
      if (!v) return;
      try {
        v.stop();
      } catch (_) {
        /* voice cleanup must not block the pose shutdown */
      }
    }

    function queue(op, position) {
      if (busy()) return false;
      return bridge.command({ memory, block }, op, position);
    }

    function status_() {
      const v = view();
      return { ack: v.getUint32(block + ACK, true), status: v.getInt32(block + STATUS, true), entity: v.getInt32(block + ENTITY, true) };
    }

    function fail(message, params) {
      remote.failed = true;
      remote.phase = 'failed';
      setStatus(message, params);
    }

    // One engine command at a time. Advances the single replica slot, which follows the
    // nearest remote peer with a known pose.
    function stepRemote() {
      if (remote.phase === 'failed') return;
      if (remote.phase === 'none' || remote.phase === 'removed') {
        if (bestPeer()) remote.phase = 'idle';
        else return;
      }
      if (remote.phase === 'leaving') {
        if (busy()) return;
        if (remote.pos && queue(OP.REMOVE, remote.pos)) {
          remote.phase = 'none';
          remote.target = null;
          remote.pos = null;
          setStatus('Other player left');
        }
        return;
      }
      if (remote.phase === 'idle') {
        const best = bestPeer();
        if (!best) { remote.phase = 'none'; return; }
        if (busy()) return;
        if (queue(OP.SPAWN, best.latest.position)) {
          remote.target = best.id;
          remote.pos = best.latest.position;
          remote.lastMoved = best.latest.seq;
          remote.phase = 'spawning';
          setStatus('Other player joined; spawning replica');
        }
        return;
      }
      if (busy()) return;
      if (remote.phase === 'spawning') {
        const s = status_();
        if (s.status < 0) return fail('Replica spawn refused (status {status})', { status: s.status });
        remote.phase = 'live';
        setStatus('Other player replica active');
        return;
      }
      if (remote.phase === 'live') {
        if (remote.moveSeq !== null) {
          const s = status_();
          if (s.status < 0) return fail('Replica move refused (status {status})', { status: s.status });
          remote.moveSeq = null;
        }
        const best = bestPeer();
        if (!best) { remote.phase = 'leaving'; return stepRemote(); }
        const current = latestOf(remote.target);
        const switchTo = !current ||
          (best.id !== remote.target && localPose && dist(best.latest.position, localPose) + SWITCH_MARGIN < dist(current.position, localPose));
        if (switchTo) {
          remote.target = best.id;
          remote.lastMoved = -1;
        }
        const latest = latestOf(remote.target);
        if (latest && latest.seq > remote.lastMoved) {
          if (queue(OP.MOVE, latest.position)) {
            remote.pos = latest.position;
            remote.lastMoved = latest.seq;
            remote.moveSeq = latest.seq;
          }
        }
      }
    }

    function tick() {
      if (closed) return;
      try {
        const pose = bridge.read(memory, block);
        if (pose && pose.guid && isFiniteVec(pose.position, POSITION_LIMITS)) {
          localPose = pose.position.slice();
          seq += 1;
          send({ type: 'pose', seq, model: 0, position: pose.position.slice(), rotation: [0, 0, 0] });
        }
        stepRemote();
      } catch (error) {
        stop('Local pose unavailable: {reason}', 1011, { reason: error.message });
      }
    }

    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'welcome') {
        if (msg.protocol !== 1 || !ID_RE.test(msg.id)) return stop('Relay protocol mismatch', 1002);
        selfId = msg.id;
        hz = msg.hz || hz;
        const list = Array.isArray(msg.peers) ? msg.peers : [];
        const names = msg.names && typeof msg.names === 'object' ? msg.names : {};
        for (const p of list) addPeer(p, Object.hasOwn(names, p) ? names[p] : '');
        status.peers = 1 + peers.size;
        setStatus(peers.size ? 'Joined; other player present' : 'Joined; waiting for the other player');
        startVoice([...peers.keys()]);
        return;
      }
      if (msg.type === 'joined') {
        if (!addPeer(msg.id, msg.name)) return;
        setStatus('Other player joined');
        if (voice) voice.onPeerJoined(msg.id);
        return;
      }
      if (msg.type === 'left') {
        if (!peers.delete(msg.id)) return;
        status.peers = 1 + peers.size;
        if (voice) voice.onPeerLeft(msg.id);
        if (msg.id === remote.target && ['spawning', 'live'].includes(remote.phase) && !bestPeer()) {
          remote.phase = 'leaving';
          setStatus('Other player left; removing replica');
        } else {
          if (remote.phase === 'idle' && !bestPeer()) remote.phase = 'none';
          setStatus('Other player left');
        }
        return;
      }
      if (msg.type === 'voice-signal') {
        if (voice) voice.onSignal(msg);
        return;
      }
      if (msg.type === 'pose') {
        const peer = peers.get(msg.id);
        if (!peer) return;
        const pose = validRemotePose(msg);
        if (!pose) return;
        if (peer.latest && pose.seq <= peer.latest.seq) return;
        peer.latest = pose;
        peer.updatedAt = Date.now();
      }
    }

    function stop(reason, code, params) {
      if (closed) return;
      closed = true;
      stopVoice();
      clearInterval(tickTimer);
      clearInterval(worldTimer);
      if (remote.pos && ['spawning', 'live'].includes(remote.phase) && world) {
        try {
          if (!busy()) bridge.command({ memory, block }, OP.REMOVE, remote.pos);
        } catch (_) {
          /* best effort on shutdown */
        }
      }
      try {
        if (ws && ws.readyState <= 1) ws.close(code || 1000, 'Client closed');
      } catch (_) {
        /* already closing */
      }
      setStatus(reason || 'Closed', params);
    }

    function connect() {
      setStatus('Connecting');
      ws = createSocket(launch.relayUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', protocol: 1, room: launch.room, key: launch.key, build, map }));
        setStatus('Joining room');
      };
      ws.onmessage = onMessage;
      ws.onerror = () => setStatus('Connection error');
      ws.onclose = (event) => {
        stopVoice();
        if (closed) return;
        closed = true;
        clearInterval(tickTimer);
        clearInterval(worldTimer);
        remote.phase = 'none';
        setStatus('Connection closed ({code})', { code: event && event.code ? event.code : 'unknown' });
      };
    }

    // Build id from the host (same value the lobby hands out). Asset build is not guessed.
    const fetchInfo = typeof root.fetch === 'function'
      ? root.fetch('/__hostinfo', { cache: 'no-store' }).then((r) => r.json())
      : Promise.reject(new Error('fetch unavailable'));
    fetchInfo
      .then((info) => {
        if (!info || typeof info.build !== 'string') throw new Error('host info missing');
        build = info.build;
        connect();
      })
      .catch((error) => setStatus('Not started: {reason}', { reason: error.message }));

    const unsubscribeLanguage = root.FiveWebI18n ? root.FiveWebI18n.subscribe(render) : null;
    const onPageHide = () => {
      stop('Left the page', 1000);
      if (unsubscribeLanguage) unsubscribeLanguage();
    };
    if (root.addEventListener) root.addEventListener('pagehide', onPageHide);
    if (doc && doc.readyState === 'loading' && doc.addEventListener) doc.addEventListener('DOMContentLoaded', mountPanel);
    else mountPanel();

    // World gate: nothing is written to memory or the relay before the world is playable.
    worldTimer = setInterval(() => {
      if (closed || world) return;
      mountPanel();
      if (!isWorldReady()) return;
      world = true;
      clearInterval(worldTimer);
      tickTimer = setInterval(tick, tickMs);
      setStatus(peers.size ? 'Playing; other player present' : 'Playing; waiting for the other player');
    }, worldPollMs);

    const instance = {
      stop: (reason) => stop(reason || 'Closed', 1000),
      state: () => ({ line: status.line, peers: status.peers, phase: remote.phase, selfId, remoteId: remote.target, hz }),
      getPeerCount: () => peers.size,
      getPeers: () => [...peers.values()].map((p) => ({ id: p.id, name: p.name, position: p.latest ? p.latest.position.slice() : null, updatedAt: p.updatedAt, replica: p.id === remote.target })),
      getLocalPose: () => (localPose ? localPose.slice() : null),
      getSelfId: () => selfId,
    };
    active = instance;
    return instance;
  }

  root.GTAMultiplayerGame = {
    attach,
    getPeerCount: () => (active ? active.getPeerCount() : 0),
    getPeers: () => (active ? active.getPeers() : []),
    getLocalPose: () => (active ? active.getLocalPose() : null),
    getSelfId: () => (active ? active.getSelfId() : null),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GTAMultiplayerGame;
})(typeof self !== 'undefined' ? self : globalThis);
