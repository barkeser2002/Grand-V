/* FiveWebVoice: opt-in peer-to-peer voice for the 2-player sandbox.
   Media never goes through /relay. The relay only forwards {type:'voice-signal'} frames (offer,
   answer, ice) between the two peers of one room over the shared, authenticated socket.
   Nothing touches the microphone until the user clicks "Sese katıl" (getUserMedia runs
   inside that click). Glare is resolved by peer id: the peer with the smaller id is impolite
   and keeps its own offer; the other one rolls back. No public STUN is used; TURN comes only
   from the host's /api/voice/ice (see fetchIce). */
(function (root) {
  'use strict';

  const t = (key) => root.FiveWebI18n ? root.FiveWebI18n.t(key) : key;
  const ID_RE = /^[0-9a-f]{16}$/;
  const MAX_QUEUED_CANDIDATES = 64;
  const MAX_VOICE_PEERS = 8; // bounded full mesh: each peer uploads one audio stream per link
  const STATE_TEXT = {
    connecting: 'Bağlanıyor…',
    connected: 'Bağlandı',
    disconnected: 'Bağlantı kesildi, yeniden deneniyor',
    failed: 'Bağlantı kurulamadı',
  };
  const DIRECT_NOTE = 'Doğrudan bağlantı: sunucuda TURN yok. Ağınız (NAT) izin vermezse ses kurulamaz.';
  const CONNECTED_STATES = { connecting: 'connecting', connected: 'connected', disconnected: 'disconnected', failed: 'failed' };

  function errorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Mikrofon izni verilmedi. Tarayıcı ayarlarından izin verip tekrar deneyin.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Mikrofon bulunamadı.';
    if (name === 'NotReadableError') return 'Mikrofon başka bir uygulama tarafından kullanılıyor.';
    return 'Mikrofon açılamadı.';
  }

  function attach(options) {
    const opts = options || {};
    const send = typeof opts.send === 'function' ? opts.send : () => false;
    const selfId = typeof opts.selfId === 'string' && ID_RE.test(opts.selfId) ? opts.selfId : null;
    const doc = root.document;
    const nav = root.navigator;
    const PC = root.RTCPeerConnection;
    const supported = typeof PC === 'function' && !!nav && !!nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function';

    const ui = { root: null, join: null, mute: null, status: null, note: null };
    const view = { mode: supported ? 'off' : 'unsupported', conn: 'idle', message: '', muted: false };
    let stopped = false;
    let mic = null;            // MediaStream with one audio track while the user is in voice
    let iceConfig = { iceServers: [] };
    let cancelProbe = null;
    let iceReady = true;
    let joinEpoch = 0;
    // Full mesh, bounded: one RTCPeerConnection per remote peer, at most MAX_VOICE_PEERS.
    // Peers beyond that limit stay in the room without a voice link (no SFU on this host).
    const peers = [];                // remote peer ids in join order
    const links = new Map();         // peerId -> { peerId, pc, polite, makingOffer, ignoreOffer, remoteSet, queue, audio }
    const pendingOffers = new Map(); // peerId -> sdp received before ICE was ready
    const pendingIce = new Map();    // peerId -> candidates for a pending offer
    const voicePeers = () => peers.slice(0, MAX_VOICE_PEERS);
    const isVoicePeer = (id) => voicePeers().includes(id);
    if (Array.isArray(opts.peers)) {
      for (const p of opts.peers) if (ID_RE.test(p) && p !== selfId && !peers.includes(p)) peers.push(p);
    }
    if (opts.iceConfig && Array.isArray(opts.iceConfig.iceServers)) iceConfig = { ...opts.iceConfig };

    // ---- UI -------------------------------------------------------------------------
    function buildUi() {
      if (!doc || !doc.body || !doc.createElement) return;
      const box = doc.createElement('div');
      box.id = 'grandv-voice';
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', t('Sesli sohbet'));
      box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:13;padding:8px 10px;background:#07100ee6;color:#e8f0e0;font:13px sans-serif;max-width:260px;border-radius:6px';
      const join = doc.createElement('button');
      join.type = 'button';
      join.addEventListener('click', onJoinClick);
      const mute = doc.createElement('button');
      mute.type = 'button';
      mute.addEventListener('click', onMuteClick);
      const status = doc.createElement('div');
      status.setAttribute('aria-live', 'polite');
      const note = doc.createElement('div');
      note.style.cssText = 'font-size:11px;opacity:.85;margin-top:4px';
      box.append(join, mute, status, note);
      doc.body.append(box);
      Object.assign(ui, { root: box, join, mute, status, note });
      render();
    }

    function render() {
      if (!ui.root) return;
      const busy = view.mode === 'requesting';
      ui.root.setAttribute('aria-label', t('Sesli sohbet'));
      ui.join.textContent = t(view.mode === 'on' ? 'Sesi kapat' : 'Sese katıl');
      ui.join.setAttribute('aria-pressed', view.mode === 'on' ? 'true' : 'false');
      ui.join.disabled = view.mode === 'unsupported' || busy;
      ui.mute.style.display = view.mode === 'on' ? '' : 'none';
      ui.mute.textContent = t(view.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat');
      ui.mute.setAttribute('aria-pressed', view.muted ? 'true' : 'false');
      ui.status.textContent = t(statusLine());
      ui.note.textContent = t(view.message);
    }

    function statusLine() {
      if (view.mode === 'unsupported') return 'Bu tarayıcı sesli sohbeti desteklemiyor (WebRTC yok).';
      if (view.mode === 'requesting') return 'Mikrofon isteniyor…';
      if (view.mode === 'denied' || view.mode === 'error') return 'Sesli sohbet kapalı.';
      if (view.mode !== 'on') return peers.length ? 'Sesli sohbet kapalı.' : 'Sesli sohbet kapalı. Karşı oyuncu bekleniyor.';
      if (!peers.length) return 'Mikrofon açık. Karşı oyuncu bekleniyor.';
      return STATE_TEXT[view.conn] ? t('Ses: ') + t(STATE_TEXT[view.conn]) : 'Ses: karşı oyuncu bekleniyor';
    }

    function say(message) {
      view.message = message || '';
      render();
    }

    function onPageHide() {
      stop('Left the page');
    }

    // ---- microphone -----------------------------------------------------------------
    function stopTracks(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return;
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch (_) {
          /* already stopped */
        }
      }
    }

    function stopMic() {
      if (mic) stopTracks(mic);
      mic = null;
      view.muted = false;
    }

    async function onJoinClick() {
      if (stopped) return;
      if (view.mode === 'on') return leaveVoice();
      if (!supported || view.mode === 'requesting') return;
      const epoch = ++joinEpoch;
      iceReady = false;
      view.mode = 'requesting';
      say('');
      render();
      let stream;
      try {
        stream = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      } catch (err) {
        if (stopped || epoch !== joinEpoch) return;
        iceReady = true;
        view.mode = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'denied' : 'error';
        say(errorMessage(err));
        return;
      }
      if (stopped || epoch !== joinEpoch) return stopTracks(stream);
      mic = stream;
      view.mode = 'on';
      render();
      const ice = await loadIce();
      if (stopped || epoch !== joinEpoch) return;
      if (ice) iceConfig = ice;
      if (iceConfig.provider === 'public') {
        iceReady = false;
        const available = await probePublic(iceConfig.iceServers);
        if (stopped || epoch !== joinEpoch) return;
        iceReady = true;
        if (!available && iceConfig.fallbackIceServers?.length) {
          iceConfig = { ...iceConfig, iceServers: iceConfig.fallbackIceServers, provider: 'backup' };
        }
      }
      iceReady = true;
      for (const l of links.values()) {
        try { l.pc.setConfiguration({ iceServers: iceConfig.iceServers }); } catch (_) { /* reported by connection state */ }
      }
      for (const id of voicePeers()) {
        ensureLink(id);
        if (pendingOffers.has(id)) {
          const sdp = pendingOffers.get(id);
          pendingOffers.delete(id);
          await onOffer(id, sdp);
          if (stopped || epoch !== joinEpoch) return;
        } else attachMic(links.get(id));
      }
      for (const l of links.values()) playRemote(l);
      say(iceConfig.provider === 'public' ? 'Genel TURN seçildi (birincil).' : iceConfig.provider === 'backup' ? 'Yedek TURN seçildi; genel TURN kullanılamadı.' : iceConfig.iceServers.length ? '' : DIRECT_NOTE);
      render();
    }

    function cancelIceWork() {
      joinEpoch++;
      pendingOffers.clear();
      pendingIce.clear();
      if (cancelProbe) cancelProbe();
      iceReady = true;
    }

    function leaveVoice() {
      cancelIceWork();
      stopMic();
      closeAllLinks();
      view.mode = supported ? 'off' : 'unsupported';
      view.conn = 'idle';
      say('');
      render();
    }

    function onMuteClick() {
      if (view.mode !== 'on' || !mic) return;
      view.muted = !view.muted;
      for (const t of mic.getAudioTracks()) t.enabled = !view.muted;
      render();
    }

    // Isolated relay-only gathering tests allocation, not end-to-end audio reachability.
    function probePublic(servers) {
      return new Promise((resolve) => {
        let pc;
        let timer;
        let done = false;
        function finish(ok) {
          if (done) return;
          done = true;
          root.clearTimeout(timer);
          cancelProbe = null;
          if (pc) {
            pc.onicecandidate = pc.onicecandidateerror = null;
            pc.close();
          }
          resolve(ok);
        }
        cancelProbe = () => finish(false);
        timer = root.setTimeout(() => finish(false), 4000);
        try {
          pc = new PC({ iceServers: servers, iceTransportPolicy: 'relay' });
          pc.onicecandidate = (event) => {
            if (!event.candidate) finish(false);
            else if (/\btyp relay\b/.test(event.candidate.candidate)) finish(true);
          };
          pc.onicecandidateerror = () => finish(false);
          pc.createDataChannel('turn-probe');
          Promise.resolve(pc.createOffer()).then((offer) => {
            if (!done) return pc.setLocalDescription(offer);
          }).catch(() => finish(false));
        } catch (_) { finish(false); }
      });
    }

    // Fetches TURN credentials from the host after the click. Failure is reported, never faked.
    async function loadIce() {
      if (typeof opts.fetchIce !== 'function') return opts.iceConfig && Array.isArray(opts.iceConfig.iceServers) ? { ...opts.iceConfig } : null;
      try {
        const res = await opts.fetchIce();
        if (res && Array.isArray(res.iceServers)) return { ...res };
        return { iceServers: [] };
      } catch (_) {
        say('Bağlantı yapılandırması alınamadı; doğrudan bağlantı denenecek.');
        return { iceServers: [] };
      }
    }

    function attachMic(link) {
      if (!link || !mic) return;
      const track = mic.getAudioTracks()[0];
      if (!track) return;
      if (link.pc.getSenders().some((s) => s.track === track)) return;
      link.pc.addTrack(track, mic);
    }

    // ---- peer connection ------------------------------------------------------------
    function aggregateConn() {
      const states = [...links.values()].map((l) => l.conn || 'connecting');
      if (states.includes('connected')) return 'connected';
      if (states.includes('connecting')) return 'connecting';
      if (states.includes('disconnected')) return 'disconnected';
      if (states.includes('failed')) return 'failed';
      return links.size ? 'connecting' : 'idle';
    }
    function setLinkConn(link, conn) {
      link.conn = conn;
      view.conn = aggregateConn();
      render();
    }
    function ensureLink(peerId) {
      if (!peerId || stopped || !iceReady || !isVoicePeer(peerId)) return links.get(peerId) || null;
      if (links.has(peerId)) return links.get(peerId);
      const pc = new PC({ iceServers: iceConfig.iceServers, bundlePolicy: 'max-bundle' });
      const current = { peerId, pc, polite: selfId > peerId, makingOffer: false, ignoreOffer: false, remoteSet: false, queue: (pendingIce.get(peerId) || []).splice(0), audio: null, conn: 'connecting' };
      pendingIce.delete(peerId);
      links.set(peerId, current);
      const live = () => links.get(peerId) === current && !stopped;
      pc.onicecandidate = (event) => {
        if (!event || !event.candidate || !live()) return;
        send({
          type: 'voice-signal',
          target: peerId,
          signal: {
            type: 'ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      };
      pc.onnegotiationneeded = async () => {
        if (!live()) return;
        try {
          current.makingOffer = true;
          const offer = await pc.createOffer();
          if (!live()) return;
          await pc.setLocalDescription(offer);
          if (live()) send({ type: 'voice-signal', target: peerId, signal: { type: 'offer', sdp: pc.localDescription.sdp } });
        } catch (_) {
          say('Ses anlaşması başarısız oldu.');
        } finally {
          current.makingOffer = false;
        }
      };
      pc.ontrack = (event) => {
        if (!live()) return;
        const stream = event.streams && event.streams[0];
        if (!stream) return;
        if (!current.audio && doc && doc.createElement) {
          current.audio = doc.createElement('audio');
          current.audio.autoplay = true;
          current.audio.setAttribute('playsinline', '');
        }
        if (current.audio) {
          current.audio.srcObject = stream;
          const p = current.audio.play && current.audio.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => say('Karşı tarafın sesini duymak için "Sese katıl" düğmesine basın.'));
          }
        }
      };
      function connectionFailed() {
        if (!live() || current.awaitingRestart) return;
        if (iceConfig.provider === 'public' && iceConfig.fallbackIceServers?.length) {
          // Replace, never concatenate: array order is not TURN priority.
          iceConfig = { ...iceConfig, iceServers: iceConfig.fallbackIceServers, provider: 'backup' };
          current.backupTried = true;
          current.awaitingRestart = true;
          current.restartTimer = root.setTimeout(() => {
            if (!live()) return;
            current.awaitingRestart = false;
            connectionFailed();
          }, 12000);
          setLinkConn(current, 'connecting');
          say('Yedek TURN seçildi; ICE yeniden başlatılıyor.');
          try {
            pc.setConfiguration({ iceServers: iceConfig.iceServers });
            // restartIce remembers the request across rollback/glare and triggers negotiationneeded.
            pc.restartIce();
          } catch (_) {
            root.clearTimeout(current.restartTimer);
            current.awaitingRestart = false;
            setLinkConn(current, 'failed');
            say('Yedek TURN yeniden başlatılamadı; ses bağlantısı başarısız.');
          }
        } else if (iceConfig.provider === 'backup' && current.backupTried !== true && iceConfig.fallbackIceServers?.length) {
          // Another link already switched the shared config to backup: restart this one once on it.
          current.backupTried = true;
          try { pc.setConfiguration({ iceServers: iceConfig.iceServers }); pc.restartIce(); setLinkConn(current, 'connecting'); }
          catch (_) { setLinkConn(current, 'failed'); }
        } else {
          root.clearTimeout(current.restartTimer);
          setLinkConn(current, 'failed');
          if (iceConfig.provider === 'backup') say('Genel ve yedek TURN ile ses bağlantısı başarısız.');
        }
      }
      pc.oniceconnectionstatechange = () => {
        if (!live()) return;
        if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'connected') current.awaitingRestart = false;
        if (pc.iceConnectionState === 'failed') connectionFailed();
      };
      pc.onconnectionstatechange = () => {
        if (!live()) return;
        if (pc.connectionState === 'connecting' || pc.connectionState === 'connected') current.awaitingRestart = false;
        if (pc.connectionState === 'connected') root.clearTimeout(current.restartTimer);
        if (pc.connectionState === 'failed') return connectionFailed();
        const mapped = CONNECTED_STATES[pc.connectionState];
        if (mapped) setLinkConn(current, mapped);
      };
      view.conn = aggregateConn();
      return current;
    }

    function playRemote(link) {
      if (!link || !link.audio || !link.audio.play) return;
      const p = link.audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    async function drainQueue(current) {
      const pending = current.queue.splice(0, current.queue.length);
      for (const c of pending) {
        try {
          await current.pc.addIceCandidate(c);
        } catch (_) {
          /* candidate for a rolled-back offer: ignored */
        }
      }
    }

    function closeLink(peerId) {
      const old = links.get(peerId);
      if (!old) return;
      links.delete(peerId);
      root.clearTimeout(old.restartTimer);
      old.queue.length = 0;
      try {
        old.pc.close();
      } catch (_) {
        /* already closed */
      }
      if (old.audio) {
        old.audio.srcObject = null;
        if (old.audio.pause) old.audio.pause();
      }
    }
    function closeAllLinks() {
      for (const id of [...links.keys()]) closeLink(id);
    }

    async function onOffer(peerId, sdp) {
      if (!iceReady) { pendingOffers.set(peerId, sdp); return; }
      const current = ensureLink(peerId);
      if (!current) return;
      const pc = current.pc;
      const collision = current.makingOffer || pc.signalingState !== 'stable';
      current.ignoreOffer = !current.polite && collision;
      if (current.ignoreOffer) return;
      await pc.setRemoteDescription({ type: 'offer', sdp });
      current.remoteSet = true;
      await drainQueue(current);
      // Without a local track the answer is recvonly: this side hears the peer without a mic prompt.
      attachMic(current);
      await pc.setLocalDescription(await pc.createAnswer());
      if (links.get(peerId) === current) send({ type: 'voice-signal', target: peerId, signal: { type: 'answer', sdp: pc.localDescription.sdp } });
    }

    async function onAnswer(peerId, sdp) {
      const link = links.get(peerId);
      if (!link || link.pc.signalingState !== 'have-local-offer') return;
      await link.pc.setRemoteDescription({ type: 'answer', sdp });
      link.remoteSet = true;
      await drainQueue(link);
    }

    async function onIce(peerId, signal) {
      const candidate = { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex };
      const link = links.get(peerId);
      if (!link) {
        if (pendingOffers.has(peerId)) {
          const q = pendingIce.get(peerId) || [];
          if (q.length < MAX_QUEUED_CANDIDATES) q.push(candidate);
          pendingIce.set(peerId, q);
        }
        return;
      }
      if (!link.remoteSet) {
        if (link.queue.length < MAX_QUEUED_CANDIDATES) link.queue.push(candidate);
        return;
      }
      try {
        await link.pc.addIceCandidate(candidate);
      } catch (_) {
        if (!link.ignoreOffer) say('Bir ağ adayı reddedildi.');
      }
    }

    // ---- public surface -------------------------------------------------------------
    function onSignal(msg) {
      if (stopped || !msg || typeof msg !== 'object' || msg.type !== 'voice-signal') return;
      if (!isVoicePeer(msg.from) || !msg.signal || typeof msg.signal !== 'object') return;
      const s = msg.signal;
      let work = null;
      if (s.type === 'offer' && typeof s.sdp === 'string') work = onOffer(msg.from, s.sdp);
      else if (s.type === 'answer' && typeof s.sdp === 'string') work = onAnswer(msg.from, s.sdp);
      else if (s.type === 'ice' && typeof s.candidate === 'string') work = onIce(msg.from, s);
      if (work) {
        work.catch(() => {
          if (!stopped) say('Ses sinyali işlenemedi.');
        });
      }
    }

    function onPeerJoined(id) {
      if (stopped || !ID_RE.test(id) || id === selfId || peers.includes(id)) return;
      peers.push(id);
      if (view.mode === 'on' && iceReady && isVoicePeer(id)) attachMic(ensureLink(id));
      render();
    }

    function onPeerLeft(id) {
      const index = peers.indexOf(id);
      if (stopped || index < 0) return;
      peers.splice(index, 1);
      if (!peers.length) cancelIceWork();
      pendingOffers.delete(id);
      pendingIce.delete(id);
      closeLink(id);
      // A slot freed in the bounded mesh: the next waiting peer gets a link.
      if (view.mode === 'on' && iceReady) for (const p of voicePeers()) if (!links.has(p)) attachMic(ensureLink(p));
      view.conn = aggregateConn();
      render();
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (unsubscribeLanguage) unsubscribeLanguage();
      cancelIceWork();
      closeAllLinks();
      stopMic();
      if (root.removeEventListener) root.removeEventListener('pagehide', onPageHide);
      if (ui.root && ui.root.remove) ui.root.remove();
      Object.assign(ui, { root: null, join: null, mute: null, status: null, note: null });
      view.mode = 'stopped';
    }

    if (root.addEventListener) root.addEventListener('pagehide', onPageHide);
    const unsubscribeLanguage = root.FiveWebI18n ? root.FiveWebI18n.subscribe(render) : null;
    buildUi();

    return {
      onSignal,
      onPeerJoined,
      onPeerLeft,
      stop,
      state: () => ({ mode: view.mode, conn: view.conn, muted: view.muted, remote: peers[0] || null, peers: peers.slice(), links: links.size, hasMic: !!mic }),
    };
  }

  root.FiveWebVoice = { attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FiveWebVoice;
})(typeof self !== 'undefined' ? self : globalThis);
