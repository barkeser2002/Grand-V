/* FiveWeb account summary on the server browser. Login, sign-up and characters live on
   /character.html (ak4y multicharacter theme). Exposes FiveWebAccount.selected() for lobby.js,
   which joins with {characterId}, or sends the player to the character page first. */
(function (root) {
  'use strict';
  const doc = root.document;
  const t = (key, params) => root.FiveWebI18n ? root.FiveWebI18n.t(key, params) : String(key).replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);
  const SELECTED_KEY = 'fiveweb.character';
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const state = { account: null, selected: null, mode: 'login', busy: false, message: '', tone: '' };

  function el(tag, props = {}, ...kids) { const n = doc.createElement(tag); Object.assign(n, props); n.append(...kids.filter((k) => k !== null && k !== undefined)); return n; }
  function field(labelKey, input) { return el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: t(labelKey) }), input); }

  async function call(method, url, body) {
    const res = await root.fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data && typeof data.error === 'string' ? t(data.error) : t('İşlem başarısız ({status}).', { status: res.status })), { status: res.status });
    return data;
  }

  function remember(id) {
    try { if (id) root.localStorage.setItem(SELECTED_KEY, id); else root.localStorage.removeItem(SELECTED_KEY); } catch (_) { /* optional */ }
  }
  function remembered() { try { return root.localStorage.getItem(SELECTED_KEY); } catch (_) { return null; } }

  function setAccount(account) {
    state.account = account;
    const chars = account ? account.characters : [];
    const keep = chars.find((c) => c.id === (state.selected && state.selected.id)) || chars.find((c) => c.id === remembered()) || chars[0] || null;
    state.selected = keep;
    remember(keep && keep.id);
    render();
  }

  async function load() {
    try {
      const data = await call('GET', '/api/account/me');
      setAccount(data.account);
    } catch (err) {
      if (err.status !== 401) say(err.message, 'error');
      setAccount(null);
    }
  }

  function say(message, tone = '') { state.message = message || ''; state.tone = tone; render(); }

  async function busy(fn) {
    if (state.busy) return;
    state.busy = true;
    render();
    try { await fn(); } catch (err) { state.message = err.message; state.tone = 'error'; } finally { state.busy = false; render(); }
  }

  // ---- views: compact summary; login, sign-up and character work happen on /character.html ----
  const characterPage = () => {
    const sel = doc.querySelector('#server-list [aria-pressed="true"], #server-list .is-selected');
    const id = sel && sel.closest('[data-server-id]') ? sel.closest('[data-server-id]').getAttribute('data-server-id') : 'fiveweb-freeroam';
    return '/character.html?server=' + encodeURIComponent(/^[a-z0-9-]{1,40}$/.test(id) ? id : 'fiveweb-freeroam');
  };
  function link(labelKey, cls = 'btn primary') {
    const a = el('a', { className: cls, href: '/character.html', textContent: t(labelKey) });
    a.addEventListener('click', (e) => { e.preventDefault(); (root.__fiveWebNavigate || ((u) => root.location.assign(u)))(characterPage()); });
    return a;
  }
  function loginView() {
    return el('div', { className: 'acc-summary' },
      el('p', { className: 'field-hint', textContent: t('Çok oyunculu sunuculara karakterinle girersin. Paran, banka hesabın, araçların ve evlerin karakterine bağlıdır.') }),
      link('Giriş yap / Kayıt ol'));
  }
  function accountView() {
    const a = state.account;
    const c = state.selected;
    const logout = el('button', { type: 'button', className: 'btn link', textContent: t('Çıkış') });
    logout.addEventListener('click', () => busy(async () => { await call('POST', '/api/account/logout', {}); remember(null); setAccount(null); }));
    const head = el('p', { className: 'acc-head' }, el('span', { textContent: t('Hesap: {name}', { name: a.username }) }), logout);
    if (!c) return el('div', {}, head, el('p', { className: 'field-hint', textContent: t('Henüz karakterin yok. Çok oyunculu sunuculara girmek için bir karakter oluştur.') }), link('Karakter oluştur'));
    const row = (k, v) => el('div', {}, el('dt', { textContent: t(k) }), el('dd', { textContent: v }));
    return el('div', {}, head,
      el('article', { className: 'char-card selected' },
        el('strong', { className: 'char-name', textContent: c.fullName }),
        el('dl', { className: 'char-stats' }, row('Cüzdan', money(c.cash)), row('Banka', money(c.bank)), row('Meslek', t(c.job)))),
      link(a.characters.length > 1 ? 'Karakter değiştir' : 'Karakter ekranı', 'btn ghost'));
  }

  function syncJoinForm() {
    // With a character selected the join uses it; the free nickname field is not used.
    const nick = doc.getElementById('nickname');
    const label = nick && nick.closest('.field');
    if (label) label.hidden = true;
    const info = doc.getElementById('join-character');
    if (info) info.textContent = state.selected ? t('Karakter: {name}', { name: state.selected.fullName }) : t('Katıl: önce karakter ekranı açılır.');
  }

  let host = null;
  function render() {
    if (!host) return;
    const title = el('h3', { textContent: t('Karakter') });
    const status = el('p', { id: 'acc-status', className: 'status' + (state.tone ? ' ' + state.tone : ''), textContent: state.message });
    status.setAttribute('role', 'status');
    host.replaceChildren(title, state.account ? accountView() : loginView(), status);
    host.setAttribute('aria-busy', String(state.busy));
    syncJoinForm();
  }

  function mount() {
    host = doc.getElementById('account-panel');
    if (!host) return;
    render();
    load();
    if (root.FiveWebI18n) root.FiveWebI18n.subscribe(render);
  }

  root.FiveWebAccount = {
    characterPage,
    selected: () => (state.selected ? { id: state.selected.id, name: state.selected.fullName } : null),
    required: true,
    reload: load,
    state: () => ({ ...state }),
  };
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
})(typeof self !== 'undefined' ? self : globalThis);
