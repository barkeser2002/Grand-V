/* Grand-V lobby adapter: runs after the original launcher scripts on /launcher.html?lobby=<id>.
   Authorized product change: the multiplayer gate is open (Deneysel · 128 oyuncu). Multiplayer is
   only ACTIVATED with a valid lobby session (fresh, id matches ?lobby=, credential well-formed).
   Without one, the launcher stays singleplayer. The native Start button and every GPU/browser/
   secure-context check in launcher_player_flow.js still run unchanged. Credentials stay in the
   password fields and the sessionStorage pending launch; never in localStorage or the URL. */
(() => {
  'use strict';
  const t = (key, params) => window.FiveWebI18n ? window.FiveWebI18n.t(key, params) : key.replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);
  let bannerState = null;
  const SESSION_KEY = 'grandv.lobby.session.v1';
  const LOBBY_ID = /^[A-Za-z0-9_-]{16}$/;
  const CREDENTIAL = /^[\x21-\x7e]{4,128}$/;
  const NOTE = 'Deneysel · 128 oyuncu';
  const STALE = 'Lobi oturumu bulunamadı veya süresi doldu. Lobiler sayfasından tekrar katılın.';
  const $ = (id) => document.getElementById(id);

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }

  // Returns '' when the session is usable for this lobby, otherwise the message to show.
  function sessionProblem(lobby, session) {
    if (!session || typeof session !== 'object' || !LOBBY_ID.test(lobby) || session.id !== lobby) return STALE;
    if (typeof session.credential !== 'string' || !CREDENTIAL.test(session.credential)) return STALE;
    const expires = Date.parse(session.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return 'Lobi oturumunun süresi doldu. Lobiler sayfasından tekrar katılın.';
    return '';
  }

  function banner(text, tone, params) {
    bannerState = { text, tone, params };
    let el = $('grandv-lobby-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'grandv-lobby-banner';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:50;max-width:92vw;padding:8px 14px;border-radius:10px;font:14px system-ui,sans-serif;background:#0d1118ee;color:#e9eef7;border:1px solid #243044';
      document.body.append(el);
    }
    el.textContent = t(text, params);
    el.dataset.tone = tone;
    el.style.color = tone === 'error' ? '#ff7a6b' : '#e9eef7';
  }

  // Lifts the product gate: the radio, its hidden enable checkbox and the settings button become
  // usable. Nothing is checked here; activation is a separate step that needs a valid session.
  function unlockGate() {
    for (const id of ['play-multiplayer', 'mp-enable', 'multiplayer-open']) {
      const el = $(id);
      if (el) el.disabled = false;
    }
    const card = $('play-multiplayer')?.closest('.mode-card');
    if (card) {
      card.classList.remove('mode-unavailable');
      card.removeAttribute('aria-disabled');
    }
    const note = $('multiplayer-release-note');
    if (note) note.textContent = t(NOTE);
    const openNote = $('multiplayer-open')?.querySelector('span');
    if (openNote) openNote.textContent = t(NOTE);
  }

  // Standalone or invalid session: singleplayer stays selected. Only a multiplayer selection that
  // is already on (e.g. a stored preference) is turned off; no room, URL or key field is touched.
  function clearMultiplayerSelection() {
    const enable = $('mp-enable'), play = $('play-multiplayer');
    if (!enable || !play || (!enable.checked && !play.checked)) return;
    enable.checked = false;
    play.checked = false;
    enable.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Activates multiplayer for a validated session. Order matters: sandbox is selected first
  // (applyPreferences refuses to enable outside sandbox), applyPreferences runs the real
  // launcher_multiplayer.js path, and the credential fields are written last so the change and
  // preference events fired above cannot clear them.
  function activate(session) {
    const sandbox = document.querySelector('input[name=mode][value="sandbox"]');
    const launch = window.GTAMultiplayerLaunch;
    if (!sandbox || !launch || !$('mp-key') || !$('mp-access') || !$('play-multiplayer')) return false;
    if (!sandbox.checked) {
      sandbox.checked = true;
      sandbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    launch.applyPreferences({ sameHost: true, room: session.id, enabled: true });
    if (!$('play-multiplayer').checked || !$('mp-enable').checked) return false;
    $('mp-key').value = session.credential;
    $('mp-access').value = session.credential;
    return true;
  }

  function run() {
    unlockGate();
    const lobby = new URLSearchParams(location.search).get('lobby');
    if (lobby === null) return;
    const session = readSession();
    const problem = sessionProblem(lobby, session);
    if (problem) {
      clearMultiplayerSelection();
      banner(problem, 'error');
      return;
    }
    if (!activate(session)) {
      clearMultiplayerSelection();
      banner('Çok oyunculu mod bu tarayıcıda başlatılamadı. Lobiler sayfasından tekrar katılın.', 'error');
      return;
    }
    banner("Lobi: {name} — Başlat'a basarak oyuna girin.", 'ok', { name: session.name || session.id });
  }

  if (window.FiveWebI18n) window.FiveWebI18n.subscribe(() => {
    unlockGate();
    if (bannerState) banner(bannerState.text, bannerState.tone, bannerState.params);
  });
  document.addEventListener('DOMContentLoaded', run);
  window.addEventListener('pageshow', run);
  window.addEventListener('load', run);
})();
