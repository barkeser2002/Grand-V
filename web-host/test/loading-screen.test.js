// Multiplayer loading screen (public/loading-screen.js, adapted from ivy_loadingscreen) in JSDOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { transformGamePage, LOADING_SRC, HUD_SRC } from '../src/game-page.js';
import { loadPublicAssets } from '../src/public.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const SCRIPT = fs.readFileSync(path.join(PUBLIC, 'loading-screen.js'), 'utf8');
const I18N = fs.readFileSync(path.join(PUBLIC, 'i18n.js'), 'utf8');
const MIRROR = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';

const GAME_LOADING = '<div id="loading"><div id="modes">Loading Multiplayer Mode</div><span id="label">Starting...</span><span id="pct">0%</span><div id="bar"><div id="fill"></div></div></div>';

function boot({ search = '?mode=sandbox&multiplayer=1&poseproof=3', session, languages = ['tr-TR'], playOk = true, soundButton = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${GAME_LOADING}</body></html>`, {
    url: 'https://fiveweb.test/game.html' + search,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: languages });
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (s) => { copied.push(s); } } });
  const plays = [];
  w.HTMLMediaElement.prototype.play = function () { plays.push(this.src); return playOk ? Promise.resolve() : Promise.reject(new Error('NotAllowed')); };
  w.HTMLMediaElement.prototype.pause = function () {};
  w.Audio = function () { return w.document.createElement('audio'); };
  if (session) w.sessionStorage.setItem('grandv.lobby.session.v1', JSON.stringify(session));
  if (soundButton) {
    // Stand-in for loading_music.js's toolbar button: one click mutes it.
    const b = w.document.createElement('button');
    b.id = 'loading-sound';
    b.textContent = 'Loading sound: on';
    b.addEventListener('click', () => { b.textContent = 'Loading sound: off'; });
    w.document.body.append(b);
  }
  w.eval(I18N);
  w.eval(SCRIPT);
  const api = w.__fiveWebLoading || (w.FiveWebLoading.wanted(w.location) ? w.FiveWebLoading.mount({ syncMs: 60000, subtitleMs: 60000 }) : null);
  const flush = () => new Promise((r) => setTimeout(r, 10));
  return { w, doc: w.document, api, plays, copied, flush, close: () => { if (api) api.stop(); w.close(); } };
}

describe('loading screen: when it shows', () => {
  test('singleplayer launches keep the original loading screen', () => {
    const h = boot({ search: '?mode=sandbox' });
    try {
      assert.equal(h.api, null);
      assert.equal(h.doc.getElementById('fw-loading'), null);
    } finally { h.close(); }
  });

  test('a multiplayer launch covers the game loading screen with the server name as title', () => {
    const h = boot({ session: { name: 'FiveWeb Freeroam' } });
    try {
      const o = h.doc.getElementById('fw-loading');
      assert.ok(o);
      assert.equal(o.querySelector('h1').textContent, 'FiveWeb Freeroam');
      assert.ok(['128 oyunculu serbest dünya', 'Karakterinle gir, kazan, harca', 'Tarayıcıda GTA V çok oyunculu'].includes(o.querySelector('.fw-sub').textContent));
      assert.ok(o.querySelector('.fw-tip').textContent.length > 5, 'a gameplay tip is shown');
      assert.equal(o.querySelector('video').getAttribute('src'), '/fiveweb-loading/background.mp4');
      assert.equal(o.querySelector('.fw-logo').getAttribute('src'), '/__brand/fiveweb-icon.png');
    } finally { h.close(); }
  });

  test('without a session the title is FiveWeb; markup in a session name is shown as text', () => {
    const h = boot({ session: { name: '<img src=x onerror=alert(1)>' } });
    try {
      assert.equal(h.doc.querySelector('#fw-loading h1').textContent, '<img src=x onerror=alert(1)>');
      assert.equal(h.doc.querySelectorAll('#fw-loading h1 img').length, 0);
    } finally { h.close(); }
    const g = boot();
    try { assert.equal(g.doc.querySelector('#fw-loading h1').textContent, 'FiveWeb'); } finally { g.close(); }
  });
});

describe('loading screen: real engine progress', () => {
  test('follows the game percentage, translates stage labels; errors are marked', () => {
    const h = boot();
    try {
      h.doc.getElementById('label').textContent = 'Finishing world streaming (64 transfers)';
      h.doc.getElementById('pct').textContent = '87%';
      h.api.sync();
      const s = h.api.state();
      assert.equal(s.label, 'Dünya akışı tamamlanıyor');
      assert.equal(s.pct, '87%');
      assert.equal(parseFloat(h.doc.querySelector('#fw-loading .fw-fill').style.width), 87);
      assert.equal(h.doc.querySelector('#fw-loading .fw-progress').getAttribute('aria-valuenow'), '87');
      for (const [en, tr] of [['Starting...', 'Başlatılıyor…'], ['Downloading and compiling the engine (12 MB)', 'Motor indiriliyor ve derleniyor (12 MB)'], ['First frame', 'Dünya yükleniyor'], ['Preparing shaders (3 pending)', 'Gölgelendiriciler hazırlanıyor (3 kaldı)'], ['Something new', 'Something new']]) assert.equal(h.api.translateLabel(en), tr);
      h.doc.getElementById('label').style.color = '#e66';
      h.doc.getElementById('label').textContent = 'STARTUP ERROR';
      h.api.sync();
      assert.ok(h.doc.querySelector('#fw-loading .fw-label').classList.contains('fw-error'));
    } finally { h.close(); }
  });

  test('closes when the game marks its loading screen done', async () => {
    const h = boot();
    try {
      h.doc.getElementById('loading').classList.add('done');
      h.api.sync();
      assert.equal(h.api.state().closed, true);
      assert.ok(h.doc.getElementById('fw-loading').classList.contains('fw-out'));
      await new Promise((r) => setTimeout(r, 1400));
      assert.equal(h.doc.getElementById('fw-loading'), null, 'removed after the fade');
    } finally { h.close(); }
  });

  test('closes when the game removes its loading screen', () => {
    const h = boot();
    try {
      h.doc.getElementById('loading').remove();
      h.api.sync();
      assert.equal(h.api.state().closed, true);
    } finally { h.close(); }
  });
});

describe('loading screen: music and links', () => {
  test('music starts and the game loading music is switched off once', async () => {
    const h = boot();
    try {
      await h.flush();
      assert.ok(h.plays.some((s) => s.endsWith('/fiveweb-loading/music.mp3')));
      const s = h.api.state();
      assert.equal(s.playing, true);
      assert.equal(s.gameMusicMuted, true);
      assert.equal(h.doc.getElementById('loading-sound').textContent, 'Loading sound: off');
      assert.equal(h.doc.getElementById('fw-play').hidden, true);
      h.doc.getElementById('fw-pause').click();
      assert.equal(h.api.state().playing, false);
      assert.equal(h.doc.getElementById('loading-sound').textContent, 'Loading sound: off', 'pausing ours does not touch the game');
    } finally { h.close(); }
  });

  test('refused autoplay leaves the game music alone and shows Play', async () => {
    const h = boot({ playOk: false });
    try {
      await h.flush();
      assert.equal(h.api.state().playing, false);
      assert.equal(h.doc.getElementById('loading-sound').textContent, 'Loading sound: on');
      assert.equal(h.doc.getElementById('fw-play').hidden, false);
    } finally { h.close(); }
  });

  test('no social box or third-party links on the loading screen', () => {
    const h = boot();
    try {
      assert.equal(h.doc.querySelector('#fw-loading .fw-social'), null);
      assert.ok(!SCRIPT.includes('discord.gg'));
    } finally { h.close(); }
  });

  test('inside a silent engine stage the bar keeps moving but never passes the next stage', () => {
    const h = boot();
    try {
      h.doc.getElementById('label').textContent = 'Starting...';
      h.doc.getElementById('pct').textContent = '0%';
      const W = h.doc.defaultView;
      const realNow = W.Date.now;
      let now = realNow();
      W.Date.now = () => now;
      try {
        h.api.sync();
        now += 30000; h.api.sync();
        const a = parseInt(h.api.state().pct, 10);
        assert.ok(a > 5 && a <= 19, 'moves inside stage 0: ' + a);
        now += 600000; h.api.sync();
        const b = parseInt(h.api.state().pct, 10);
        assert.ok(b >= 18 && b <= 19, 'capped below the engine\'s 20 %: ' + b);
        h.doc.getElementById('pct').textContent = '43%';
        h.api.sync();
        assert.equal(h.api.state().pct, '43%', 'engine value wins');
      } finally { W.Date.now = realNow; }
    } finally { h.close(); }
  });

  test('English browser: subtitles and labels in English', () => {
    const h = boot({ languages: ['en-US'] });
    try {
      assert.ok(['128-player open world', 'Join with your character, earn and spend', 'GTA V multiplayer in the browser'].includes(h.doc.querySelector('#fw-loading .fw-sub').textContent));
      assert.equal(h.api.translateLabel('First frame'), 'Loading the world');
      assert.equal(h.api.translateLabel('Preparing shaders (3 pending)'), 'Preparing shaders (3 left)');
    } finally { h.close(); }
  });
});

describe('loading screen: assets and injection', () => {
  test('only same-origin assets; no CDN, font or tracker requests', () => {
    const urls = SCRIPT.match(/['"`](https?:)?\/\/[^'"`]+['"`]/g) || [];
    assert.deepEqual(urls, []);
    assert.ok(!/fonts\.googleapis|jsdelivr|vibrant/i.test(SCRIPT));
  });

  test('every referenced /fiveweb-loading/ file exists in the asset tree', { skip: !fs.existsSync(path.join(MIRROR, 'fiveweb-loading')) && 'asset tree not mounted' }, () => {
    for (const f of ['background.mp4', 'poster.jpg', 'music.mp3', 'album.jpg', 'play.svg', 'pause.svg', 'prev.svg', 'next.svg', 'volume.svg', 'discord.svg']) {
      assert.ok(fs.existsSync(path.join(MIRROR, 'fiveweb-loading', f)), f);
    }
  });

  test('the script is a public asset and is injected after the HUD', () => {
    assert.ok(loadPublicAssets().has('/__grandv/loading-screen.js'));
    const page = Buffer.from('<html><head></head><body><script>const playerKeys=new Set(["audiodiag","mode"]);if(q.get("poseproof")!=="4")q.delete("poseproof");</script></body></html>', 'latin1');
    const out = transformGamePage(page, { hud: true, loading: true }).body.toString('latin1');
    assert.ok(out.indexOf(HUD_SRC) < out.indexOf(LOADING_SRC));
    assert.equal(transformGamePage(page).body.toString('latin1').includes(LOADING_SRC), false);
  });
});
