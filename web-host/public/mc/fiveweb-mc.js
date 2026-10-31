/* FiveWeb character selection (ak4y multicharacter theme). Talks to /api/account/* and joins
   the chosen server with {characterId}; all user text goes through textContent. */
(function (root) {
  'use strict';
  const doc = root.document;
  const $ = (id) => doc.getElementById(id);
  const t = (k, p) => (root.FiveWebI18n ? root.FiveWebI18n.t(k, p) : String(k).replace(/\{(\w+)\}/g, (m, x) => (p && x in p ? String(p[x]) : m)));
  const SESSION_KEY = 'grandv.lobby.session.v1';
  const SELECTED_KEY = 'fiveweb.character';
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const params = new URLSearchParams(root.location.search);
  const serverId = /^[a-z0-9-]{1,40}$/.test(params.get('server') || '') ? params.get('server') : 'fiveweb-freeroam';
  const state = { account: null, selected: null, mode: 'login', busy: false, server: null };

  function el(tag, props = {}, ...kids) { const n = doc.createElement(tag); Object.assign(n, props); n.append(...kids.filter((k) => k != null)); return n; }

  async function api(method, url, body) {
    const res = await root.fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data && typeof data.error === 'string' ? t(data.error) : t('İşlem başarısız ({status}).', { status: res.status })), { status: res.status });
    return data;
  }

  function translateStatic() {
    for (const n of doc.querySelectorAll('[data-t]')) n.textContent = t(n.getAttribute('data-t'));
    $('fw-desc').textContent = t('Oynamak istediğin karakteri seç ya da boş bir slota yeni karakter oluştur. Paran, banka hesabın, araçların ve evlerin karaktere bağlıdır.');
    $('fw-create-desc').textContent = t('Karakter adı oyunda diğer oyunculara görünür. Başlangıç: $5,000 nakit ve $25,000 banka.');
  }

  function loading(on) { $('fw-loading').classList.toggle('fw-done', !on); }

  // ---- auth --------------------------------------------------------------------------
  function renderAuth() {
    const reg = state.mode === 'register';
    $('fw-auth').hidden = !!state.account;
    $('fw-auth-title2').textContent = t(reg ? 'KAYIT OL' : 'GİRİŞ');
    $('fw-auth-submit').textContent = t(reg ? 'KAYIT OL' : 'GİRİŞ');
    $('fw-auth-switch').textContent = t(reg ? 'GİRİŞ YAP' : 'KAYIT OL');
    $('fw-pass').autocomplete = reg ? 'new-password' : 'current-password';
    $('fw-auth-hint').textContent = t(reg ? 'Kullanıcı adı 3-20 karakter; şifre en az 8 karakter.' : 'Karakterlerin ve paran hesabına bağlıdır.');
    $('fw-general').classList.toggle('fw-hidden', !state.account);
    $('fw-logout').hidden = !state.account;
    $('fw-top-user').textContent = state.account ? state.account.username : '';
    if (!state.account) setTimeout(() => $('fw-user').focus(), 0);
  }

  $('fw-auth-switch').addEventListener('click', () => { state.mode = state.mode === 'register' ? 'login' : 'register'; $('fw-auth-error').textContent = ''; renderAuth(); });
  $('fw-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    state.busy = true;
    $('fw-auth-error').textContent = '';
    try {
      const data = await api('POST', '/api/account/' + (state.mode === 'register' ? 'register' : 'login'), { username: $('fw-user').value.trim(), password: $('fw-pass').value });
      $('fw-pass').value = '';
      setAccount(data.account);
    } catch (err) {
      $('fw-auth-error').textContent = err.message;
    } finally { state.busy = false; }
  });
  $('fw-logout').addEventListener('click', async () => {
    try { await api('POST', '/api/account/logout', {}); } catch (_) { /* cookie cleared anyway */ }
    try { root.localStorage.removeItem(SELECTED_KEY); } catch (_) { /* optional */ }
    setAccount(null);
  });

  // ---- slots and info ------------------------------------------------------------------
  function ageOf(birth) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth || '');
    if (!m) return '';
    const now = new Date();
    let age = now.getFullYear() - +m[1];
    if (now.getMonth() + 1 < +m[2] || (now.getMonth() + 1 === +m[2] && now.getDate() < +m[3])) age--;
    return String(age);
  }

  function renderSlots() {
    const a = state.account;
    const rects = $('fw-rects'), slots = $('fw-slots');
    rects.replaceChildren(); slots.replaceChildren();
    const total = a.slots;
    for (let i = 0; i < total; i++) {
      const c = a.characters[i];
      rects.append(el('div', { className: 'rectangleItem' }, el('div', { className: 'leftText' + (c ? '' : ' empty'), textContent: String(i + 1) }), el('div', { className: 'rightRectangle' }), i + 1 < total ? el('div', { className: 'bottomRectangle' }) : null));
      let item;
      if (c) {
        const active = state.selected && state.selected.id === c.id;
        item = el('button', { type: 'button', className: 'charItem' + (active ? ' active' : '') },
          el('div', { className: 'charItemSexArea ' + (c.gender === 'f' ? 'female' : 'male'), textContent: t(c.gender === 'f' ? 'KADIN' : 'ERKEK') }),
          el('div', { className: 'charItemAgeText' + (active ? ' active' : '') }, el('span', { className: 'age', textContent: ageOf(c.birthDate) }), el('span', { textContent: t('YAŞ') })),
          el('div', { className: 'charItemNameArea' + (active ? ' active' : '') }, el('span', { className: 'firstName', textContent: c.firstName }), el('span', { className: 'lastName', textContent: c.lastName })),
          el('div', { className: 'charItemArrowArea' }, el('img', { src: '/__mc/images/arrow.png', alt: '' })));
        item.setAttribute('aria-pressed', String(!!active));
        item.addEventListener('click', () => select(c));
      } else {
        item = el('button', { type: 'button', className: 'charItem create', id: i === a.characters.length ? 'createButton' : '' },
          el('div', { className: 'charCreateImgArea' }, el('img', { src: '/__mc/images/create.png', alt: '' })),
          el('div', { className: 'createCharText', textContent: t('KARAKTER OLUŞTUR') }));
        item.addEventListener('click', openCreate);
      }
      slots.append(item);
    }
    $('fw-buttons').style.display = state.selected ? 'flex' : 'none';
  }

  function renderInfo() {
    const c = state.selected;
    $('fw-info').classList.toggle('fw-open', !!c && !$('fw-create').classList.contains('fw-open'));
    if (!c) return;
    const sex = $('fw-info-sex');
    sex.className = 'rightSexText ' + (c.gender === 'f' ? 'female' : 'male');
    sex.textContent = t(c.gender === 'f' ? 'KADIN' : 'ERKEK');
    $('fw-info-name').textContent = c.fullName;
    const row = (label, value) => el('div', { className: 'rightInfoItem' }, el('div', { className: 'rightInfoText', textContent: t(label) }), el('div', { className: 'rightInfo', textContent: value }));
    $('fw-info-rows').replaceChildren(
      row('DOĞUM TARİHİ', c.birthDate.split('-').reverse().join(' - ')),
      row('UYRUK', c.nationality),
      row('MESLEK', t(c.job)),
      row('CÜZDAN', money(c.cash)),
      row('BANKA', money(c.bank)),
      row('TELEFON NUMARASI', c.phone),
      row('HESAP NUMARASI', c.accountNumber),
    );
  }

  function select(c) {
    state.selected = c;
    try { root.localStorage.setItem(SELECTED_KEY, c.id); } catch (_) { /* optional */ }
    $('fw-create').classList.remove('fw-open');
    $('fw-play-error').textContent = '';
    renderSlots();
    renderInfo();
  }

  function setAccount(account) {
    state.account = account;
    if (account) {
      let keep = null;
      try { keep = root.localStorage.getItem(SELECTED_KEY); } catch (_) { /* optional */ }
      state.selected = account.characters.find((c) => c.id === (state.selected && state.selected.id)) || account.characters.find((c) => c.id === keep) || account.characters[0] || null;
      renderSlots();
      if (!account.characters.length) openCreate(); else renderInfo();
    } else {
      state.selected = null;
    }
    renderAuth();
  }

  // ---- create ------------------------------------------------------------------------------
  let gender = 'm';
  for (const b of doc.querySelectorAll('.sexButton')) {
    b.addEventListener('click', () => {
      gender = b.getAttribute('data-sex');
      for (const x of doc.querySelectorAll('.sexButton')) { const on = x === b; x.classList.toggle('active', on); x.querySelector('.sexText').classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); }
    });
  }
  function openCreate() {
    if (!state.account || state.account.characters.length >= state.account.slots) return;
    $('fw-create-error').textContent = '';
    $('fw-info').classList.remove('fw-open');
    $('fw-create').classList.add('fw-open');
    $('fw-create-cancel').hidden = !state.account.characters.length;
    setTimeout(() => $('fw-first').focus(), 0);
  }
  $('fw-create-cancel').addEventListener('click', () => { $('fw-create').classList.remove('fw-open'); renderInfo(); });
  $('fw-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    state.busy = true;
    $('fw-create-error').textContent = '';
    try {
      const data = await api('POST', '/api/account/characters', { firstName: $('fw-first').value, lastName: $('fw-last').value, gender, birthDate: $('datepicker').value, nationality: $('fw-nation').value });
      $('fw-first').value = ''; $('fw-last').value = '';
      $('fw-create').classList.remove('fw-open');
      state.selected = data.character;
      try { root.localStorage.setItem(SELECTED_KEY, data.character.id); } catch (_) { /* optional */ }
      const me = await api('GET', '/api/account/me');
      setAccount(me.account);
    } catch (err) {
      $('fw-create-error').textContent = err.message;
    } finally { state.busy = false; }
  });

  // ---- delete ------------------------------------------------------------------------------
  $('fw-delete-open').addEventListener('click', () => { if (!state.selected) return; $('fw-delete-name').textContent = state.selected.fullName; $('fw-delete').hidden = false; });
  $('fw-delete-cancel').addEventListener('click', () => { $('fw-delete').hidden = true; });
  $('fw-delete-ok').addEventListener('click', async () => {
    const c = state.selected;
    $('fw-delete').hidden = true;
    if (!c) return;
    try {
      await api('DELETE', '/api/account/characters/' + c.id, { confirm: c.fullName });
      state.selected = null;
      const me = await api('GET', '/api/account/me');
      setAccount(me.account);
    } catch (err) { $('fw-play-error').textContent = err.message; }
  });

  // ---- play ---------------------------------------------------------------------------------
  $('fw-play').addEventListener('click', async () => {
    const c = state.selected;
    if (!c || state.busy) return;
    state.busy = true;
    $('fw-play-error').textContent = '';
    loading(true);
    try {
      // Shared world (AliYa server): its own join endpoint and /play/ page.
      if (serverId === 'fiveweb-world') {
        const online = await api('POST', '/api/online/join', { characterId: c.id });
        if (!online || typeof online.launchPath !== 'string' || !online.launchPath.startsWith('/play/?')) throw new Error(t('Sunucudan geçersiz yanıt alındı.'));
        root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ serverId, characterId: c.id, characterName: c.fullName.slice(0, 40) }));
        (root.__fiveWebNavigate || ((u) => root.location.assign(u)))(online.launchPath);
        return;
      }
      const data = await api('POST', `/api/servers/${encodeURIComponent(serverId)}/join`, { characterId: c.id });
      if (!data || !data.lobby || !data.session || typeof data.launchPath !== 'string' || !data.launchPath.startsWith('/')) throw new Error(t('Sunucudan geçersiz yanıt alındı.'));
      root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        id: data.lobby.id, name: data.lobby.name, role: data.session.role, credential: data.session.credential, expiresAt: data.session.expiresAt,
        serverId, characterId: c.id, characterName: c.fullName.slice(0, 40),
      }));
      (root.__fiveWebNavigate || ((u) => root.location.assign(u)))(data.launchPath);
    } catch (err) {
      loading(false);
      $('fw-play-error').textContent = err.message;
      state.busy = false;
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('fw-delete').hidden = true; }
  });

  async function start() {
    translateStatic();
    try {
      const list = await api('GET', '/api/servers');
      state.server = (list.servers || []).find((s) => s.id === serverId) || null;
      if (state.server) $('fw-server').textContent = state.server.name.toUpperCase();
    } catch (_) { /* name stays FIVEWEB */ }
    try {
      const me = await api('GET', '/api/account/me');
      setAccount(me.account);
    } catch (_) {
      setAccount(null);
    }
    loading(false);
  }
  if (root.FiveWebI18n) root.FiveWebI18n.subscribe(() => { translateStatic(); renderAuth(); if (state.account) { renderSlots(); renderInfo(); } });
  root.__fiveWebMc = { state: () => ({ ...state }), select, openCreate };
  start();
})(window);
