/* FiveWeb server browser: list, filter, select, join. Server text is only ever written with textContent.
 * Backend contract: GET /api/servers, POST /api/servers/:id/join {nickname}. Credentials live only in sessionStorage. */
(() => {
  'use strict';
  const SESSION_KEY = 'grandv.lobby.session.v1';
  const NICK_KEY = 'grandv.lobby.nickname';
  const POLL_MS = 15000;
  const PLAYERS_POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 10000;
  const $ = (id) => document.getElementById(id);
  const win = window;
  const t = (key, params) => win.FiveWebI18n ? win.FiveWebI18n.t(key, params) : key.replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);

  const state = {
    servers: [],
    loaded: false,
    failed: false,
    filter: 'all',
    query: '',
    selectedId: null,
    seq: 0,
    controller: null,
    busy: false,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(node, text, tone, params) {
    node._status = { text, tone, params };
    node.textContent = t(text, params);
    node.className = 'status' + (tone ? ' ' + tone : '');
  }

  // Shape-check a server row from the backend. Malformed rows are dropped, never shown.
  function sanitizeServer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) return null;
    const capacity = Number.isInteger(raw.capacity) && raw.capacity > 0 ? raw.capacity : 2;
    const connected = Number.isInteger(raw.connected) ? Math.max(0, Math.min(raw.connected, capacity)) : 0;
    const reserved = Number.isInteger(raw.reserved) ? Math.max(0, raw.reserved) : 0;
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 12) : [];
    const resources = Array.isArray(raw.resources)
      ? raw.resources
        .filter((r) => r && typeof r.name === 'string')
        .map((r) => ({ name: r.name, version: typeof r.version === 'string' ? r.version : '' }))
        .slice(0, 100)
      : [];
    return {
      id: raw.id,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      connected,
      reserved,
      capacity,
      status: raw.status === 'full' ? 'full' : 'online',
      tags,
      resources,
      voice: raw.voice === true,
      compatibility: typeof raw.compatibility === 'string' ? raw.compatibility : 'fiveweb-js-v1',
    };
  }

  function visibleServers() {
    const q = state.query.trim().toLocaleLowerCase(win.FiveWebI18n?.language === 'en' ? 'en-US' : 'tr-TR');
    return state.servers.filter((s) => {
      if (state.filter === 'open' && s.status !== 'online') return false;
      if (state.filter === 'full' && s.status !== 'full') return false;
      if (!q) return true;
      return s.name.toLocaleLowerCase(win.FiveWebI18n?.language === 'en' ? 'en-US' : 'tr-TR').includes(q)
        || s.description.toLocaleLowerCase(win.FiveWebI18n?.language === 'en' ? 'en-US' : 'tr-TR').includes(q)
        || s.tags.some((t) => t.toLocaleLowerCase(win.FiveWebI18n?.language === 'en' ? 'en-US' : 'tr-TR').includes(q));
    });
  }

  function statusLabel(s) {
    if (s.ready === false) return t('Kapalı');
    return s.status === 'full' ? t('Dolu') : t('Açık');
  }

  function slotDots(s) {
    const wrap = el('span', 'slots');
    wrap.setAttribute('aria-hidden', 'true');
    if (s.capacity > 8) {
      // Large servers: a fill bar instead of one dot per seat.
      const bar = el('span', 'slot-bar');
      const fill = el('span', 'slot-fill');
      fill.style.width = Math.round((100 * s.connected) / s.capacity) + '%';
      bar.append(fill);
      wrap.append(bar);
      return wrap;
    }
    for (let i = 0; i < s.capacity; i++) wrap.append(el('span', 'slot' + (i < s.connected ? ' taken' : '')));
    return wrap;
  }

  // Keyed row: created once per server id, then updated in place so focus and text selection survive polls.
  function rowFor(s) {
    const row = el('article', 'server-row');
    row.dataset.id = s.id;
    const select = el('button', 'row-select');
    select.type = 'button';
    const top = el('span', 'row-top');
    const name = el('span', 'row-name');
    const badge = el('span', 'badge');
    top.append(name, badge);
    const desc = el('span', 'row-desc');
    const tagLine = el('span', 'row-tags');
    select.append(top, desc, tagLine);
    const side = el('div', 'row-side');
    const count = el('span', 'row-count');
    const dots = el('span', 'row-dots-slot');
    const join = el('button', 'btn primary small');
    join.type = 'button';
    side.append(count, dots, join);
    row.append(select, side);
    select.addEventListener('click', () => selectServer(row.dataset.id));
    join.addEventListener('click', () => {
      selectServer(row.dataset.id);
      // One click: with a character the join starts; without one the character screen opens.
      const form = $('join-form');
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    row._refs = { select, name, badge, desc, tagLine, count, dots, join };
    return row;
  }

  function updateRow(row, s) {
    const r = row._refs;
    r.name.textContent = s.name;
    r.badge.textContent = statusLabel(s);
    r.badge.className = 'badge ' + (s.status === 'full' ? 'full' : 'open');
    r.desc.textContent = s.description || t('Açıklama yok.');
    r.tagLine.textContent = s.tags.join(' · ');
    r.tagLine.hidden = s.tags.length === 0;
    r.count.textContent = t('{connected} / {capacity} bağlı · rezerve {reserved}', s);
    const full = s.status === 'full';
    r.join.textContent = s.ready === false ? t('Kapalı') : full ? t('Dolu') : t('Katıl');
    r.join.disabled = full;
    r.select.setAttribute('aria-pressed', String(state.selectedId === s.id));
    row.classList.toggle('is-selected', state.selectedId === s.id);
    r.dots.replaceChildren(slotDots(s));
  }

  function renderSkeleton() {
    const list = $('server-list');
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(...[0, 1, 2].map(() => el('div', 'skeleton')));
  }

  function messageBox(kind, title, body, retry) {
    const box = el('div', kind === 'error' ? 'error-box' : 'empty');
    box.append(el('strong', '', title), el('span', '', body));
    if (retry) {
      const btn = el('button', 'btn ghost small', t('Tekrar dene'));
      btn.type = 'button';
      btn.addEventListener('click', () => refresh());
      box.append(btn);
    }
    return box;
  }

  function renderList() {
    const list = $('server-list');
    list.setAttribute('aria-busy', 'false');
    if (!state.loaded && state.failed) {
      list.replaceChildren(messageBox('error', t('Sunucular yüklenemedi.'), t('Bağlantıyı kontrol edip yeniden deneyin.'), true));
      return;
    }
    if (!state.loaded) return renderSkeleton();
    if (state.servers.length === 0) {
      list.replaceChildren(messageBox('empty', t('Şu an açık sunucu yok.'), t('Sunucular açıldığında burada görünür. Liste 15 saniyede bir güncellenir.'), false));
      return;
    }
    const shown = visibleServers();
    if (shown.length === 0) {
      list.replaceChildren(messageBox('empty', t('Filtreye uyan sunucu yok.'), t('Arama metnini ya da filtreyi değiştirin.'), false));
      return;
    }
    const existing = new Map([...list.children].filter((n) => n.dataset && n.dataset.id).map((n) => [n.dataset.id, n]));
    const keep = new Set(shown.map((s) => s.id));
    for (const [id, node] of existing) if (!keep.has(id)) node.remove();
    shown.forEach((s, index) => {
      let row = existing.get(s.id);
      if (!row) row = rowFor(s);
      updateRow(row, s);
      // Move a node only when its position changed, so a focused button is not re-inserted needlessly.
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
    for (const child of [...list.children]) {
      if (!child.dataset || !child.dataset.id) child.remove();
    }
  }

  function renderDetail() {
    const s = state.servers.find((x) => x.id === state.selectedId);
    const empty = $('detail-empty');
    const body = $('detail-body');
    if (!s) {
      empty.hidden = false;
      body.hidden = true;
      return;
    }
    empty.hidden = true;
    body.hidden = false;
    $('detail-title').textContent = s.name;
    $('detail-desc').textContent = s.description || t('Bu sunucu için açıklama girilmemiş.');
    $('detail-connected').textContent = t('{count} oyuncu', { count: s.connected });
    $('detail-reserved').textContent = String(s.reserved);
    $('detail-capacity').textContent = t('Deneysel · {count} oyuncu', { count: s.capacity });
    $('detail-status').textContent = statusLabel(s);

    const tags = $('detail-tags');
    tags.replaceChildren(...(s.tags.length ? s.tags.map((t) => el('li', 'tag', t)) : [el('li', 'muted-p', t('Etiket yok'))]));
    const resources = $('detail-resources');
    resources.replaceChildren(...(s.resources.length
      ? s.resources.map((r) => el('li', 'resource', r.version ? r.name + ' · ' + r.version : r.name))
      : [el('li', 'muted-p', t('Kaynak bilgisi yayımlanmamış.'))]));

    $('detail-voice').textContent = s.voice
      ? t('Bu sunucu sesli iletişimi destekler. Bu isteğe bağlıdır: mikrofon izni yalnızca siz sesli iletişimi açtığınızda sorulur ve kamera kullanılmaz.')
      : t('Bu sunucuda sesli iletişim yok.');

    const full = s.status === 'full';
    $('join-submit').disabled = full || state.busy;
    $('join-submit').textContent = full ? t('Dolu') : t('Katıl');
    if (full) setStatus($('join-status'), t('Bu sunucu dolu. Başka bir sunucu seçin.'), 'error');
  }

  function renderNotice() {
    const notice = $('list-notice');
    if (state.failed && state.loaded) {
      notice.textContent = t('Güncellenemedi; son bilinen liste gösteriliyor.');
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }

  function render() {
    renderList();
    renderDetail();
    renderNotice();
    renderHero();
  }

  // ---- hero counters and the online player list (visible before joining) ----------------
  const players = { serverId: null, list: [], loaded: false, seq: 0 };
  function animateNumber(node, value) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(value);
    if (from === value || !win.requestAnimationFrame || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { node.textContent = String(value); return; }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 600);
      node.textContent = String(Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) win.requestAnimationFrame(step);
    };
    win.requestAnimationFrame(step);
  }
  function renderHero() {
    const online = $('hero-online'), servers = $('hero-servers');
    if (!online || !servers) return;
    animateNumber(online, state.servers.reduce((n, s) => n + s.connected + s.reserved, 0));
    animateNumber(servers, state.servers.length);
  }
  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function hue(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
  function renderPlayers() {
    const list = $('player-list');
    if (!list) return;
    const server = state.servers.find((x) => x.id === players.serverId);
    $('players-server').textContent = server ? server.name : '';
    $('players-count').textContent = String(players.list.length);
    if (!players.loaded) { list.replaceChildren(el('li', 'player-empty', t('Yükleniyor…'))); return; }
    if (!players.list.length) { list.replaceChildren(el('li', 'player-empty', t('Şu an kimse oyunda değil. İlk giren sen ol!'))); return; }
    const old = new Map([...list.children].filter((n) => n.dataset.name).map((n) => [n.dataset.name, n]));
    const items = players.list.map((p, i) => {
      const key = p.name + '|' + i;
      let li = old.get(key);
      if (!li) {
        li = el('li', 'player');
        li.dataset.name = key;
        li.style.setProperty('--i', String(Math.min(i, 12)));
        const av = el('span', 'avatar', initials(p.name));
        av.style.setProperty('--h', String(hue(p.name)));
        av.setAttribute('aria-hidden', 'true');
        li.append(av, el('span', 'player-name', p.name), el('span', 'player-state'));
      }
      const st = li.querySelector('.player-state');
      st.textContent = p.state === 'playing' ? t('Oyunda') : t('Katılıyor');
      st.className = 'player-state ' + (p.state === 'playing' ? 'playing' : 'joining');
      return li;
    });
    list.replaceChildren(...items);
  }
  async function loadPlayers() {
    try { await loadPlayersInner(); } catch (_) { /* page closed or list removed: nothing to show */ }
  }
  async function loadPlayersInner() {
    const id = state.selectedId || (state.servers[0] && state.servers[0].id);
    if (!id || !$('player-list')) return;
    const seq = ++players.seq;
    if (players.serverId !== id) { players.serverId = id; players.loaded = false; players.list = []; renderPlayers(); }
    try {
      const res = await fetch('/api/servers/' + encodeURIComponent(id) + '/players', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      if (seq !== players.seq) return;
      players.list = Array.isArray(data.players) ? data.players.filter((p) => p && typeof p.name === 'string').slice(0, 128).map((p) => ({ name: p.name.slice(0, 40), state: p.state === 'playing' ? 'playing' : 'joining' })) : [];
    } catch (_) {
      if (seq !== players.seq) return;
      players.list = [];
    }
    if (seq !== players.seq || !win.document) return;
    players.loaded = true;
    renderPlayers();
  }

  function selectServer(id) {
    state.selectedId = id;
    render();
    loadPlayers();
    if (!$('detail-body').hidden) $('detail-title').focus({ preventScroll: true });
  }

  function timeLabel() {
    return new Date().toLocaleTimeString(win.FiveWebI18n?.language === 'en' ? 'en-US' : 'tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function fetchServers(signal) {
    const res = await fetch('/api/servers', { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.servers)) throw new Error('bad payload');
    return data.servers.map(sanitizeServer).filter(Boolean);
  }

  // Polls never clear the list: the skeleton only shows before the first successful load.
  // A newer request makes older responses stale, so they are ignored.
  async function refresh() {
    const seq = ++state.seq;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (!state.loaded) renderSkeleton();
    $('refresh').disabled = true;
    try {
      const servers = await fetchServers(controller.signal);
      if (seq !== state.seq) return;
      state.servers = servers;
      state.loaded = true;
      state.failed = false;
      $('list-meta').textContent = t('{count} · güncellendi {time}', { count: servers.length ? t('{count} sunucu', { count: servers.length }) : t('Sunucu yok'), time: timeLabel() });
    } catch (_) {
      if (seq !== state.seq) return;
      state.failed = true;
      $('list-meta').textContent = state.loaded ? t('Bağlantı hatası · son liste') : t('Bağlantı hatası');
    } finally {
      clearTimeout(timer);
      if (seq === state.seq) {
        state.controller = null;
        $('refresh').disabled = false;
        render();
        loadPlayers();
      }
    }
  }

  function nicknameValue() {
    return $('nickname').value.trim().replace(/\s+/g, ' ');
  }

  function joinErrorText(status, data) {
    if (status === 404) return t('Sunucu bulunamadı. Listeyi yenileyin.');
    if (status === 409) return t('Sunucu dolu. Başka bir sunucu seçin.');
    if (status === 429) return t('Çok fazla deneme yapıldı. Biraz bekleyin.');
    if (data && typeof data.error === 'string' && data.error.length < 200) return win.FiveWebI18n ? win.FiveWebI18n.t(data.error, null, t('Katılım başarısız. Tekrar deneyin.')) : data.error;
    return t('Katılım sırasında bir hata oluştu ({status}).', { status });
  }

  // Validate the join response before anything is stored or navigated to.
  function validJoin(data) {
    return Boolean(data && data.lobby && typeof data.lobby.id === 'string' && data.lobby.id
      && typeof data.lobby.name === 'string'
      && data.session && typeof data.session.credential === 'string' && data.session.credential
      && typeof data.session.role === 'string'
      && typeof data.session.expiresAt === 'string'
      && typeof data.launchPath === 'string' && data.launchPath.startsWith('/launcher.html?') && !data.launchPath.includes('//'));
  }

  // Tests replace this hook to observe the redirect without a real navigation.
  function navigate(url) {
    (win.__fiveWebNavigate || ((u) => win.location.assign(u)))(url);
  }

  async function submitJoin(event) {
    event.preventDefault();
    if (state.busy) return;
    const server = state.servers.find((x) => x.id === state.selectedId);
    const status = $('join-status');
    const nickname = nicknameValue();
    const account = win.FiveWebAccount || null;
    const character = account ? account.selected() : null;
    if (!server) return setStatus(status, t('Önce bir sunucu seçin.'), 'error');
    if (server.status === 'full') return setStatus(status, t('Bu sunucu dolu.'), 'error');
    if (account && account.required && !character) return navigate('/character.html?server=' + encodeURIComponent(server.id));
    // Shared world: always with a character, through /api/online/join and its /play/ page.
    if (server.kind === 'online') {
      if (!character) return navigate('/character.html?server=' + encodeURIComponent(server.id));
      state.busy = true;
      $('join-submit').disabled = true;
      setStatus(status, '{name} sunucusuna katılınıyor…', '', { name: server.name });
      try {
        const res = await fetch('/api/online/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ characterId: character.id }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
        let data = null;
        try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
        if (!res.ok) throw new Error(joinErrorText(res.status, data));
        if (!data || typeof data.launchPath !== 'string' || !data.launchPath.startsWith('/play/?')) throw new Error(t('Sunucudan geçersiz yanıt alındı.'));
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ serverId: server.id, characterId: character.id, characterName: String(character.name || '').slice(0, 40) }));
        return navigate(data.launchPath);
      } catch (err) {
        setStatus(status, err.message, 'error');
        state.busy = false;
        $('join-submit').disabled = false;
        return;
      }
    }
    if (!character && (nickname.length < 2 || nickname.length > 20)) {
      $('nickname').setAttribute('aria-invalid', 'true');
      $('nickname').focus();
      return setStatus(status, t('Takma ad 2–20 karakter olmalı.'), 'error');
    }
    $('nickname').removeAttribute('aria-invalid');
    state.busy = true;
    $('join-submit').disabled = true;
    setStatus(status, '{name} sunucusuna katılınıyor…', '', { name: server.name });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (!character) localStorage.setItem(NICK_KEY, nickname);
      const res = await fetch('/api/servers/' + encodeURIComponent(server.id) + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(character ? { characterId: character.id } : { nickname }),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
      if (!res.ok) throw Object.assign(new Error(joinErrorText(res.status, data)), { status: res.status });
      if (!validJoin(data)) throw new Error(t('Sunucudan geçersiz yanıt alındı.'));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        id: data.lobby.id,
        name: data.lobby.name,
        role: data.session.role,
        credential: data.session.credential,
        expiresAt: data.session.expiresAt,
        serverId: server.id,
        ...(data.character && typeof data.character.id === 'string' ? { characterId: data.character.id, characterName: String(data.character.name || '').slice(0, 40) } : {}),
      }));
      setStatus(status, t('Başlatıcı hazırlanıyor…'), 'ok');
      navigate(data.launchPath);
    } catch (err) {
      const message = err && err.name === 'AbortError' ? t('Sunucu yanıt vermedi. Tekrar deneyin.') : err.message;
      setStatus(status, message, 'error');
      if (err && (err.status === 404 || err.status === 409)) refresh();
      state.busy = false;
      $('join-submit').disabled = false;
    } finally {
      clearTimeout(timer);
    }
  }

  function setFilter(next) {
    state.filter = next;
    document.querySelectorAll('.filter').forEach((b) => {
      const on = b.dataset.filter === next;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    render();
  }

  // Use the real logo only once it actually loads; otherwise keep the text 'FW' fallback (no broken img).
  const BRAND_ICON_URL = '/__brand/fiveweb-icon.png';

  function probeBrandImage() {
    const probe = new Image();
    probe.onload = () => {
      const mark = $('brand-mark');
      const img = el('img', 'brand-img');
      img.src = BRAND_ICON_URL;
      img.alt = '';
      img.width = 40;
      img.height = 40;
      mark.replaceChildren(img);
    };
    probe.src = BRAND_ICON_URL;
  }

  function init() {
    $('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
    document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
    $('refresh').addEventListener('click', refresh);
    $('join-form').addEventListener('submit', submitJoin);
    const saved = localStorage.getItem(NICK_KEY);
    if (saved) $('nickname').value = saved.slice(0, 20);
    probeBrandImage();
    if (win.FiveWebI18n) win.FiveWebI18n.subscribe(() => {
      render();
      $('list-meta').textContent = state.failed ? t('Bağlantı hatası') : state.loaded ? t('{count} sunucu', { count: state.servers.length }) : t('Yükleniyor…');
      const status = $('join-status');
      if (status._status) setStatus(status, status._status.text, status._status.tone, status._status.params);
    });
    render();
    refresh();
    setInterval(() => { if (!document.hidden && !state.busy) refresh(); }, POLL_MS);
    setInterval(() => { if (!document.hidden && state.loaded) loadPlayers(); }, PLAYERS_POLL_MS);
  }

  win.FiveWebBrowser = { refresh, selectServer, setFilter, sanitizeServer, loadPlayers };
  init();
})();
