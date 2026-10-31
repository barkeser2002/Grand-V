/* FiveWeb multiplayer loading screen, adapted from the ivy_loadingscreen FiveM resource:
   background video, logo + server title with rotating subtitles, music player and social links.
   It covers the game's own loading screen only for multiplayer launches, mirrors the engine's
   real progress (#pct, #label, #fill inside #loading) and fades out when the game removes or
   finishes #loading. Same-origin assets only (/fiveweb-loading/, /__brand/); no CDN or fonts. */
(function (root) {
  'use strict';

  const t = (key, params) => root.FiveWebI18n ? root.FiveWebI18n.t(key, params) : String(key).replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);
  const A = '/fiveweb-loading/';
  const CONFIG = Object.freeze({
    logo: '/__brand/fiveweb-icon.png',
    video: A + 'background.mp4',
    poster: A + 'poster.jpg',
    musicVolume: 0.15,
    subtitles: ['128 oyunculu serbest dünya', 'Karakterinle gir, kazan, harca', 'Tarayıcıda GTA V çok oyunculu'],
    tips: ['F6 ile telefonu aç: banka, galeri, emlak.', 'F8 tüm tuşları gösterir.', 'F9 arayüzü gizler, ekran görüntüsü için ideal.', 'Maaşın oyundayken her 10 dakikada bir bankaya yatar.', 'Diğer oyuncular radarda ve ESC haritasında görünür.'],
    songs: [{ title: 'KTS | DGOD REMİX', artist: 'Manifest', src: A + 'music.mp3', img: A + 'album.jpg' }],
  });
  const SESSION_KEY = 'grandv.lobby.session.v1';

  function serverName(storage) {
    try {
      const s = JSON.parse(storage.getItem(SESSION_KEY) || 'null');
      if (s && typeof s.name === 'string' && s.name.trim()) return s.name.trim().slice(0, 40);
    } catch (_) { /* no session: generic title */ }
    return 'FiveWeb';
  }
  // Engine stage labels (game.html / loader.js, English) -> interface language.
  const LABELS = [
    [/^Starting\.\.\.$/, 'Başlatılıyor…'],
    [/^Downloading and compiling the engine \((\d+) MB\)$/, 'Motor indiriliyor ve derleniyor ({0} MB)'],
    [/^Downloading the engine \((\d+) MB\)$/, 'Motor indiriliyor ({0} MB)'],
    [/^Compiling the engine$/, 'Motor derleniyor'],
    [/^Starting the engine$/, 'Motor başlatılıyor'],
    [/^Starting graphics$/, 'Grafikler başlatılıyor'],
    [/^First frame$/, 'Dünya yükleniyor'],
    [/^Preparing shaders \((\d+) pending\)$/, 'Gölgelendiriciler hazırlanıyor ({0} kaldı)'],
    [/^Finishing world streaming(?: \((\d+) transfers\))?$/, 'Dünya akışı tamamlanıyor'],
    [/^Ready$/, 'Hazır'],
    [/^The server is busy, retrying \((\d+)\)$/, 'Sunucu meşgul, yeniden deneniyor ({0})'],
    [/^No loading updates for (\d+) s/, '{0} sn güncelleme yok; ilk açılış uzun sürebilir, sekmeyi açık tut.'],
  ];
  function translateLabel(text) {
    const s = String(text).trim();
    for (const [re, key] of LABELS) {
      const m = re.exec(s);
      if (m) return t(key).replace('{0}', m[1] || '');
    }
    return s;
  }
  const fmt = (s) => (Number.isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00');

  function mount(options = {}) {
    const doc = root.document;
    if (!doc || !doc.body || root.__fiveWebLoading) return root.__fiveWebLoading || null;
    const el = (tag, props = {}, ...kids) => { const n = doc.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
    const img = (src, className, alt = '') => { const i = el('img', { src, alt }); if (className) i.className = className; return i; };

    const style = el('style', { id: 'fw-loading-style' });
    style.textContent = `
      #fw-loading { position: fixed; inset: 0; z-index: 20; overflow: hidden; background: #000; color: #f6f6f6; font-family: Montserrat, system-ui, sans-serif; transition: opacity 1.2s ease; }
      #fw-loading.fw-out { opacity: 0; pointer-events: none; }
      #fw-loading video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #fw-loading .fw-shade { position: absolute; inset: 0; background: linear-gradient(180deg, #0008 0%, #0000 30%, #0000 60%, #000c 100%); }
      #fw-loading .fw-header { position: relative; display: flex; align-items: center; gap: 18px; padding: calc(1.6% + 60px) 3% 0; animation: fw-l-in .8s ease both; }
      #fw-loading .fw-logo { width: 4.6rem; height: 4.6rem; object-fit: contain; border-radius: 16px; box-shadow: 0 10px 30px #ff8a1f40; }
      #fw-loading h1 { margin: 0; font-size: 2.1rem; font-weight: 800; letter-spacing: -.01em; text-shadow: 0 2px 18px #000a; }
      #fw-loading h1::after { content: ""; display: block; width: 64px; height: 4px; margin-top: 8px; border-radius: 2px; background: linear-gradient(90deg, #ff8a1f, #ffc46b); }
      #fw-loading .fw-sub { margin: 8px 0 0; font-size: 1rem; font-weight: 400; color: #e8e2d8; min-height: 1.3em; text-shadow: 0 1px 6px #000; transition: opacity .4s; }
      #fw-loading .fw-sub.fw-fade { opacity: 0; }
      #fw-loading .fw-progress { position: absolute; left: 50%; transform: translateX(-50%); width: min(1100px, 96vw); bottom: calc(max(4.3%, 60px) + 6.4rem); padding: 14px 18px; border-radius: 12px; background: #0000005c; backdrop-filter: blur(6px); }
      #fw-loading .fw-progress-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: .92rem; text-shadow: 0 1px 2px #000; }
      #fw-loading .fw-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
      #fw-loading .fw-label.fw-error { color: #ff7a6b; white-space: normal; }
      #fw-loading .fw-pct { font-weight: 800; font-variant-numeric: tabular-nums; color: #ffb35c; }
      #fw-loading .fw-bar { position: relative; height: 8px; margin-top: 10px; border-radius: 4px; background: #ffffff1f; overflow: hidden; }
      #fw-loading .fw-fill { position: relative; height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, #ff6a00, #ffb35c); box-shadow: 0 0 12px #ff8a1f99; transition: width .6s cubic-bezier(.2,.8,.2,1); overflow: hidden; }
      #fw-loading .fw-fill::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, #ffffff70, transparent); transform: translateX(-100%); animation: fw-l-shine 1.6s linear infinite; }
      #fw-loading .fw-detail { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; font-size: .78rem; color: #cfc8bd; }
      #fw-loading .fw-tip { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; transition: opacity .4s; }
      #fw-loading .fw-tip.fw-fade { opacity: 0; }
      @keyframes fw-l-shine { to { transform: translateX(100%); } }
      @keyframes fw-l-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { #fw-loading .fw-fill::after, #fw-loading .fw-header { animation: none; } }
      #fw-loading .fw-bottom { position: absolute; left: 50%; bottom: max(4.3%, 60px); transform: translateX(-50%); display: flex; width: min(1100px, 96vw); }
      #fw-loading .fw-glass { background: linear-gradient(122.72deg, #2020201a 1.74%, #1313131a 1.75%, #ffffff1a 29.41%, #0000001a 97.16%); backdrop-filter: blur(5px); border-radius: 10px; }
      #fw-loading .fw-player { flex: 1; display: flex; align-items: center; gap: 14px; padding: 12px 18px; min-width: 0; }
      #fw-loading .fw-album { width: 3rem; height: 3rem; border-radius: .4rem; filter: drop-shadow(0 0 6px #ff8a1f99); }
      #fw-loading .fw-song { min-width: 0; width: 10rem; }
      #fw-loading .fw-song h2 { margin: 0; font-size: .8rem; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      #fw-loading .fw-song p { margin: 4px 0 0; font-size: .75rem; font-weight: 400; }
      #fw-loading .fw-player { background-color: #0000005c; text-shadow: 0 1px 2px #000; }
      #fw-loading .fw-center { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
      #fw-loading .fw-controls { display: flex; align-items: center; gap: 10px; }
      #fw-loading .fw-controls button { padding: 0; border: 0; background: none; cursor: pointer; line-height: 0; }
      #fw-loading .fw-controls img { width: 1.6rem; height: 1.6rem; }
      #fw-loading .fw-controls button:focus-visible { outline: 2px solid #ff8a1f; outline-offset: 2px; border-radius: 6px; }
      #fw-loading .fw-time { display: flex; align-items: center; gap: 8px; width: 100%; font-size: .65rem; }
      #fw-loading input[type=range] { flex: 1; accent-color: #ff8a1f; height: 4px; }
      #fw-loading .fw-volume { display: flex; align-items: center; gap: 6px; width: 8rem; }
      #fw-loading .fw-volume img { width: 1.2rem; }
      #fw-loading .fw-volume { padding-left: 14px; border-left: 1px solid #ffffff22; }
      @media (max-width: 760px) {
        #fw-loading .fw-bottom { flex-direction: column; gap: 8px; }
        #fw-loading .fw-volume, #fw-loading .fw-song { display: none; }
        #fw-loading .fw-progress { bottom: calc(max(4.3%, 60px) + 7rem); }
        #fw-loading h1 { font-size: 1.5rem; }
        #fw-loading .fw-logo { width: 3.4rem; height: 3.4rem; }
        #fw-loading .fw-detail .fw-elapsed { display: none; }
      }
    `;
    doc.head.append(style);

    const overlay = el('section', { id: 'fw-loading' });
    overlay.setAttribute('aria-label', t('Yükleniyor…'));
    const video = el('video', { muted: true, loop: true, autoplay: true, playsInline: true, poster: CONFIG.poster, preload: 'auto' });
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.src = CONFIG.video;

    const title = el('h1', { textContent: serverName(root.sessionStorage) });
    const sub = el('p', { className: 'fw-sub' });
    const header = el('header', { className: 'fw-header' }, img(CONFIG.logo, 'fw-logo', 'FiveWeb'), el('div', {}, title, sub));

    const label = el('span', { className: 'fw-label', textContent: t('Yükleniyor…') });
    const pct = el('span', { className: 'fw-pct', textContent: '0%' });
    const fill = el('div', { className: 'fw-fill' });
    const tip = el('span', { className: 'fw-tip' });
    const elapsed = el('span', { className: 'fw-elapsed', textContent: '0:00' });
    const progress = el('div', { className: 'fw-progress' }, el('div', { className: 'fw-progress-top' }, label, pct), el('div', { className: 'fw-bar' }, fill), el('div', { className: 'fw-detail' }, tip, elapsed));
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');

    // ---- music player (same controls as ivy_loadingscreen) -----------------------------
    const songs = CONFIG.songs;
    let index = 0;
    const audio = typeof root.Audio === 'function' ? new root.Audio() : el('audio');
    audio.preload = 'auto';
    audio.loop = songs.length === 1;
    audio.volume = CONFIG.musicVolume;
    const album = img(songs[0].img, 'fw-album');
    const songTitle = el('h2');
    const songArtist = el('p');
    const btn = (icon, labelKey, id) => { const b = el('button', { type: 'button', id }, img(A + icon + '.svg')); b.setAttribute('aria-label', t(labelKey)); return b; };
    const prev = btn('prev', 'Önceki şarkı', 'fw-prev');
    const play = btn('play', 'Müziği çal', 'fw-play');
    const pause = btn('pause', 'Müziği duraklat', 'fw-pause');
    const next = btn('next', 'Sonraki şarkı', 'fw-next');
    const seek = el('input', { type: 'range', min: 0, max: 100, value: 0 });
    seek.setAttribute('aria-label', t('Şarkı konumu'));
    const cur = el('span', { textContent: '0:00' });
    const dur = el('span', { textContent: '0:00' });
    const volume = el('input', { type: 'range', min: 0, max: 100, value: Math.round(CONFIG.musicVolume * 100) });
    volume.setAttribute('aria-label', t('Ses düzeyi'));
    const player = el('div', { className: 'fw-player fw-glass' },
      album, el('div', { className: 'fw-song' }, songTitle, songArtist),
      el('div', { className: 'fw-center' }, el('div', { className: 'fw-controls' }, prev, play, pause, next), el('div', { className: 'fw-time' }, cur, seek, dur)),
      el('div', { className: 'fw-volume' }, img(A + 'volume.svg'), volume));

    let playing = false, gameMusicMuted = false, closed = false;
    function showState() {
      play.hidden = playing;
      pause.hidden = !playing;
    }
    function loadSong() {
      const s = songs[index];
      audio.src = s.src;
      album.src = s.img;
      songTitle.textContent = s.title;
      songArtist.textContent = s.artist;
    }
    // The game's own loading music (loading_music.js) would play over ours: switch it off once.
    function muteGameMusic() {
      if (gameMusicMuted) return;
      const b = doc.getElementById('loading-sound');
      if (!b || b.disabled) return;
      if (/(on|açık)$/i.test(b.textContent.trim())) b.click();
      gameMusicMuted = /(off|kapalı)$/i.test(b.textContent.trim());
    }
    function start() {
      if (closed) return Promise.resolve(false);
      const p = audio.play && audio.play();
      return Promise.resolve(p).then(() => { playing = true; showState(); muteGameMusic(); return true; }, () => { playing = false; showState(); return false; });
    }
    function stopMusic() { if (audio.pause) audio.pause(); playing = false; showState(); }
    play.addEventListener('click', () => { start(); });
    pause.addEventListener('click', () => stopMusic());
    prev.addEventListener('click', () => { index = (index - 1 + songs.length) % songs.length; loadSong(); start(); });
    next.addEventListener('click', () => { index = (index + 1) % songs.length; loadSong(); start(); });
    seek.addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = (seek.value / 100) * audio.duration; });
    volume.addEventListener('input', () => { audio.volume = volume.value / 100; });
    audio.addEventListener('timeupdate', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) seek.value = String((audio.currentTime / audio.duration) * 100);
      cur.textContent = fmt(audio.currentTime);
      dur.textContent = fmt(audio.duration);
    });
    audio.addEventListener('ended', () => { if (songs.length > 1) { index = (index + 1) % songs.length; loadSong(); start(); } });

    overlay.append(video, el('div', { className: 'fw-shade' }), header, progress, el('div', { className: 'fw-bottom' }, player));
    doc.body.append(overlay);
    loadSong();
    showState();

    // Autoplay may be refused until the first gesture on this page; retry once then.
    const onGesture = () => { if (!playing && !closed && !userPaused()) start(); };
    let paused = false;
    const userPaused = () => paused;
    pause.addEventListener('click', () => { paused = true; });
    play.addEventListener('click', () => { paused = false; });
    if (options.autoplay !== false) start();
    root.addEventListener('pointerdown', onGesture, { capture: true, once: true });
    root.addEventListener('keydown', onGesture, { capture: true, once: true });

    // ---- subtitles --------------------------------------------------------------------
    let subIndex = Math.floor(Math.random() * CONFIG.subtitles.length);
    const showSub = () => { sub.textContent = t(CONFIG.subtitles[subIndex % CONFIG.subtitles.length]); };
    let tipIndex = Math.floor(Math.random() * CONFIG.tips.length);
    const showTip = () => { tip.textContent = t(CONFIG.tips[tipIndex % CONFIG.tips.length]); };
    const swap = (node, fn) => { node.classList.add('fw-fade'); root.setTimeout(() => { fn(); node.classList.remove('fw-fade'); }, 400); };
    showSub(); showTip();
    const subTimer = root.setInterval(() => { subIndex += 1; tipIndex += 1; swap(sub, showSub); swap(tip, showTip); }, options.subtitleMs || 5000);

    // ---- real engine progress ---------------------------------------------------------
    const isRed = (c) => /^(#e66|#f66|rgb\(238, ?102, ?102\)|rgb\(255, ?102, ?102\))$/i.test(String(c || '').trim());
    // The engine reports few stages (0 -> 20 download, 43 graphics, 76 world, 98 shaders) and is
    // silent in between, so the bar would sit still for a minute. Inside the current stage the bar
    // eases toward (never past) the next stage boundary; the engine's own value always wins.
    const STAGES = [20, 43, 76, 98, 100];
    const started = Date.now();
    let engineValue = 0, shownValue = 0, stageAt = Date.now(), lastStage = -1;
    const stageCap = (v) => { for (const s of STAGES) if (v < s) return s - 1; return 100; };
    function sync() {
      if (closed) return;
      const loading = doc.getElementById('loading');
      if (!loading || loading.classList.contains('done')) return close();
      const gl = doc.getElementById('label');
      const gp = doc.getElementById('pct');
      if (gl && gl.textContent) {
        label.textContent = translateLabel(gl.textContent);
        label.classList.toggle('fw-error', isRed(gl.style.color));
      }
      const v = gp ? parseInt(gp.textContent, 10) || 0 : 0;
      if (v > engineValue) engineValue = v;
      const cap = stageCap(engineValue);
      if (cap !== lastStage) { lastStage = cap; stageAt = Date.now(); }
      const since = (Date.now() - stageAt) / 1000;
      const creep = engineValue + (cap - engineValue) * (1 - Math.exp(-since / 40));
      shownValue = Math.max(shownValue, Math.min(cap, Math.max(engineValue, creep)));
      const n = Math.floor(shownValue);
      pct.textContent = n + '%';
      fill.style.width = shownValue.toFixed(1) + '%';
      progress.setAttribute('aria-valuenow', String(n));
      elapsed.textContent = fmt((Date.now() - started) / 1000);
    }
    const syncTimer = root.setInterval(sync, options.syncMs || 250);

    function close() {
      if (closed) return;
      closed = true;
      root.clearInterval(syncTimer);
      root.clearInterval(subTimer);
      root.removeEventListener('pointerdown', onGesture, { capture: true });
      root.removeEventListener('keydown', onGesture, { capture: true });
      overlay.classList.add('fw-out');
      // Fade the music out with the overlay, then release media.
      const v0 = audio.volume;
      let step = 0;
      const fade = root.setInterval(() => {
        step += 1;
        try { audio.volume = Math.max(0, v0 * (1 - step / 12)); } catch (_) { /* jsdom */ }
        if (step >= 12) {
          root.clearInterval(fade);
          if (audio.pause) audio.pause();
          audio.removeAttribute('src');
          video.pause && video.pause();
          video.removeAttribute('src');
          overlay.remove();
          style.remove();
        }
      }, 100);
    }
    const unsubscribe = root.FiveWebI18n ? root.FiveWebI18n.subscribe(() => {
      showSub();
      socialText.textContent = t(CONFIG.socialText);
      overlay.setAttribute('aria-label', t('Yükleniyor…'));
    }) : null;

    const api = {
      close,
      sync,
      translateLabel, state: () => ({ closed, playing, gameMusicMuted, title: title.textContent, label: label.textContent, pct: pct.textContent }),
      stop() { close(); if (unsubscribe) unsubscribe(); },
    };
    root.__fiveWebLoading = api;
    sync();
    return api;
  }

  function wanted(loc) {
    const q = new URLSearchParams(loc.search);
    return q.get('multiplayer') === '1' || q.get('fwloading') === '1';
  }

  root.FiveWebLoading = { mount, wanted, CONFIG };
  const doc = root.document;
  if (doc && root.location && wanted(root.location) && !root.__fiveWebLoadingNoAuto) {
    const go = () => mount();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FiveWebLoading;
})(typeof self !== 'undefined' ? self : globalThis);
