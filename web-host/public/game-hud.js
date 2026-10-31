/* FiveWeb game-page HUD: key-combinations sheet, hide/show switch, cash badge, the phone
   (bank, jobs, shop, vehicles, houses, inventory, contacts) and the bridge that sends player
   positions to the engine worker, where fiveweb-natives.js puts blips on the game's own map. */
(function (root) {
  'use strict';

  const t = (key, params) => root.FiveWebI18n ? root.FiveWebI18n.t(key, params) : String(key).replace(/\{(\w+)\}/g, (m, k) => params && Object.hasOwn(params, k) ? String(params[k]) : m);

  const HOTKEYS = Object.freeze({ bank: 'F6', keys: 'F8', ui: 'F9' });
  const SESSION_KEY = 'grandv.lobby.session.v1';
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const UI_KEY = 'fiveweb.hud.hidden';

  // Key sheet. Game keys follow the keyboard remapping (GTAKeyboardControls) when present.
  const GAME_KEYS = [
    ['Hareket', [['KeyW', 'İleri / gaz'], ['KeyS', 'Geri / fren'], ['KeyA', 'Sol'], ['KeyD', 'Sağ'], ['ShiftLeft', 'Koş'], ['Space', 'Zıpla / el freni'], ['ControlLeft', 'Eğil / gizlen']]],
    ['Etkileşim', [['KeyF', 'Araca bin / in'], ['KeyE', 'Etkileşim / korna'], ['KeyR', 'Şarjör değiştir'], ['KeyQ', 'Siper'], ['KeyC', 'Arkaya bak'], ['KeyH', 'Farlar'], ['KeyM', 'Etkileşim menüsü'], ['ArrowUp', 'Telefon'], ['Tab', 'Silah çarkı'], ['Escape', 'Duraklat / harita'], ['Enter', 'Onayla']]],
    ['Uçak ve helikopter', [['Numpad8', 'Burun aşağı (I)'], ['Numpad2', 'Burun yukarı (K)'], ['Numpad4', 'Sola yat (J)'], ['Numpad6', 'Sağa yat (L)'], ['Numpad7', 'Hedef sol (U)'], ['Numpad9', 'Hedef sağ (O)']]],
  ];
  const MOUSE_KEYS = [['Sol tık', 'Ateş et'], ['Sağ tık', 'Nişan al'], ['Tekerlek', 'Silah değiştir']];
  const PAGE_KEYS = [
    ['Oyuna tıkla', 'Fareyi yakala'], ['Esc', 'Fareyi bırak'], ['Shift + P', 'Klavye modunu değiştir'], ['=', 'FPS göstergesi'],
    [HOTKEYS.bank, 'Telefon: banka, meslek, market, galeri, emlak'], ['Esc', 'Oyun haritası (oyuncular işaretli)'], [HOTKEYS.keys, 'Tuş kombinasyonları'], [HOTKEYS.ui, 'Arayüzü gizle / göster'], ['F11', 'Tam ekran'],
  ];
  const keyLabel = (code) => code === null ? t('Atanmamış') : String(code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/Left$/, '').replace(/^Arrow/, '↑ ').replace('↑ Up', '↑').replace('Escape', 'Esc').replace('Space', t('Boşluk'));

  function boundKey(code) {
    const kc = root.GTAKeyboardControls;
    if (!kc || typeof kc.load !== 'function') return code;
    try {
      const bindings = kc.load().bindings || {};
      return Object.hasOwn(bindings, code) ? bindings[code] : code;
    } catch (_) {
      return code;
    }
  }

  function install(options = {}) {
    const doc = root.document;
    if (!doc || !doc.body || root.__fiveWebHud) return root.__fiveWebHud || null;
    const getMp = () => root.GTAMultiplayerGame;
    const storage = (() => { try { return root.localStorage; } catch (_) { return null; } })();
    const read = (k) => { try { return storage ? storage.getItem(k) : null; } catch (_) { return null; } };
    const write = (k, v) => { try { if (storage) storage.setItem(k, v); } catch (_) { /* optional */ } };
    const el = (tag, props = {}, ...kids) => { const n = doc.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };

    const style = el('style', { id: 'fiveweb-hud-style' });
    style.textContent = `
      html.fw-ui-hidden #game-page-actions > :not(#fw-ui-toggle),
      html.fw-ui-hidden #grandv-voice, html.fw-ui-hidden #grandv-mp-status, html.fw-ui-hidden [id^="fiveweb-resource"],
      html.fw-ui-hidden #fw-money, html.fw-ui-hidden #hud, html.fw-ui-hidden #fiveweb-language { display: none !important; }
      html.fw-ui-hidden #fw-ui-toggle { opacity: .45; }
      #fw-keys { max-width: min(760px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px; border: 1px solid #ff8a1f; border-radius: 10px; background: #15161af2; color: #f3f3f3; font: 14px/1.4 system-ui, sans-serif; }
      #fw-keys::backdrop { background: #0008; }
      #fw-keys h2 { margin: 0 0 4px; font-size: 18px; color: #ff8a1f; }
      #fw-keys h3 { margin: 14px 0 6px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: #ffb36b; }
      #fw-keys table { width: 100%; border-collapse: collapse; }
      #fw-keys td { padding: 3px 6px; border-bottom: 1px solid #ffffff14; }
      #fw-keys td:first-child { width: 38%; white-space: nowrap; }
      #fw-keys kbd { display: inline-block; min-width: 18px; padding: 1px 6px; border: 1px solid #ffffff55; border-bottom-width: 2px; border-radius: 4px; background: #23252d; font: 600 12px/1.5 ui-monospace, monospace; text-align: center; }
      #fw-keys .fw-note { margin: 10px 0 0; font-size: 12px; opacity: .75; }
      #fw-keys .fw-close { float: right; }
      #fw-money { position: fixed; left: 12px; top: 64px; z-index: 12; padding: 6px 10px; border-radius: 6px; background: #0009; font: 700 15px/1.35 system-ui, sans-serif; text-shadow: 0 1px 2px #000; pointer-events: none; }
      #fw-money .fw-cash { color: #7bd88f; }
      #fw-money .fw-bankline { color: #e9e9e9; font-size: 12px; font-weight: 600; }
      #fw-bank { width: min(560px, 92vw); max-height: 88vh; overflow: auto; padding: 0; border: 1px solid #ff8a1f; border-radius: 10px; background: #15161af5; color: #f3f3f3; font: 14px/1.4 system-ui, sans-serif; }
      #fw-bank::backdrop { background: #0008; }
      #fw-bank header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: linear-gradient(135deg, #ff7a1a, #ffb36b); color: #15161a; }
      #fw-bank header h2 { margin: 0; font-size: 18px; }
      #fw-bank .fw-bank-body { padding: 14px 18px; }
      #fw-bank .fw-balances { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
      #fw-bank .fw-balances div { padding: 10px; border: 1px solid #ffffff22; border-radius: 8px; }
      #fw-bank .fw-balances strong { display: block; font-size: 20px; }
      #fw-bank form { display: flex; flex-wrap: wrap; gap: 6px; align-items: end; margin: 8px 0; }
      #fw-bank label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; flex: 1 1 120px; }
      #fw-bank input { padding: 6px 8px; border: 1px solid #ffffff33; border-radius: 6px; background: #23252d; color: inherit; font: inherit; }
      #fw-bank button { padding: 7px 12px; border: 1px solid #ff8a1f; border-radius: 6px; background: #2a1a0c; color: #fff; font: 600 13px system-ui, sans-serif; cursor: pointer; }
      #fw-bank .fw-bank-status { min-height: 1.2em; margin: 6px 0; }
      #fw-bank .fw-bank-status.error { color: #ff8d80; }
      #fw-bank .fw-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px 0; }
      #fw-bank .fw-tabs button { padding: 5px 9px; background: transparent; border-color: #ffffff33; }
      #fw-bank .fw-tabs button[aria-pressed="true"] { background: #ff8a1f; color: #15161a; border-color: #ff8a1f; }
      #fw-bank .fw-cards { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 6px; }
      #fw-bank .fw-card { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #ffffff1f; border-radius: 8px; }
      #fw-bank .fw-card small { display: block; opacity: .75; }
      #fw-bank .fw-actions { display: flex; gap: 4px; align-items: center; }
      #fw-bank .fw-actions input { width: 86px; }
      #fw-bank button:disabled { opacity: .45; cursor: not-allowed; }
      #fw-bank h3 { margin: 10px 0 4px; font-size: 14px; color: #ffb36b; }
      #fw-bank ol { margin: 6px 0 0; padding-left: 18px; font-size: 12px; max-height: 180px; overflow: auto; }
      .fw-toasts { position: fixed; right: 18px; top: 72px; z-index: 2147483000; display: flex; flex-direction: column; gap: 10px; width: 300px; pointer-events: none; font-family: Roboto, Segoe UI, sans-serif; }
      .fw-toast { position: relative; overflow: hidden; padding: 12px 14px 16px; border-radius: 10px; background: rgba(18, 19, 24, .92); color: #f3efe8; box-shadow: 0 10px 28px rgba(0,0,0,.45); border-left: 4px solid var(--fw-c, #4ea1ff); animation: fw-toast-in .35s cubic-bezier(.2,.9,.3,1.2) both; }
      .fw-toast strong { display: block; font-size: 15px; color: var(--fw-c, #4ea1ff); margin-bottom: 3px; }
      .fw-toast span { font-size: 14px; line-height: 1.35; }
      .fw-toast-bar { position: absolute; left: 6px; right: 6px; bottom: 6px; height: 4px; border-radius: 3px; background: var(--fw-c, #4ea1ff); transform-origin: left; animation: fw-toast-bar var(--fw-ms, 4500ms) linear both; }
      .fw-toast-success { --fw-c: #3fd27a; } .fw-toast-error { --fw-c: #ff5a5a; } .fw-toast-warning { --fw-c: #ffb02e; } .fw-toast-info { --fw-c: #4ea1ff; }
      .fw-toast.fw-out { animation: fw-toast-out .35s ease both; }
      @keyframes fw-toast-in { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: none; } }
      @keyframes fw-toast-out { to { opacity: 0; transform: translateX(60px); } }
      @keyframes fw-toast-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    `;
    doc.head.append(style);

    // ---- key sheet -------------------------------------------------------------------
    const dialog = el('dialog', { id: 'fw-keys' });
    dialog.setAttribute('aria-labelledby', 'fw-keys-title');
    function renderKeys() {
      const close = el('button', { type: 'button', className: 'fw-close', textContent: t('Kapat') });
      close.addEventListener('click', () => closeKeys());
      const parts = [close, el('h2', { id: 'fw-keys-title', textContent: t('Tuş kombinasyonları') })];
      const row = (keys, label) => {
        const k = el('td');
        for (const [i, part] of keys.entries()) { if (i) k.append(' + '); k.append(el('kbd', { textContent: part })); }
        return el('tr', {}, k, el('td', { textContent: t(label) }));
      };
      for (const [title, list] of GAME_KEYS) {
        const body = el('tbody');
        for (const [code, label] of list) {
          const bound = boundKey(code);
          body.append(row([keyLabel(bound)], bound !== code ? t('{label} (varsayılan: {key})', { label: t(label), key: keyLabel(code) }) : label));
        }
        parts.push(el('h3', { textContent: t(title) }), el('table', {}, body));
      }
      const mouse = el('tbody');
      for (const [k, label] of MOUSE_KEYS) mouse.append(row([t(k)], label));
      parts.push(el('h3', { textContent: t('Fare') }), el('table', {}, mouse));
      const page = el('tbody');
      for (const [k, label] of PAGE_KEYS) page.append(row(k.split(' + ').map((x) => t(x)), label));
      parts.push(el('h3', { textContent: t('Sayfa ve FiveWeb') }), el('table', {}, page));
      parts.push(el('p', { className: 'fw-note', id: 'fw-engine-map', textContent: engineMapText() }));
      parts.push(el('p', { className: 'fw-note', textContent: t('Oyun tuşlarını Launcher > Ayarlar > Klavye bölümünden değiştirebilirsiniz; bu liste değişiklikleri gösterir.') }));
      dialog.replaceChildren(...parts);
    }
    function openKeys() {
      renderKeys();
      if (doc.pointerLockElement && doc.exitPointerLock) doc.exitPointerLock();
      if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
    }
    function closeKeys() {
      if (dialog.open) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
    }
    dialog.addEventListener('click', (e) => { if (e.target === dialog) closeKeys(); });
    doc.body.append(dialog);

    // ---- UI hide / show -------------------------------------------------------------
    let hidden = read(UI_KEY) === '1';
    const html = doc.documentElement;
    function applyHidden() {
      html.classList.toggle('fw-ui-hidden', hidden);
      if (buttons.ui) {
        buttons.ui.textContent = hidden ? t('Arayüzü göster') : t('Arayüzü gizle');
        buttons.ui.setAttribute('aria-pressed', String(hidden));
      }
    }
    function toggleUi(force) {
      hidden = typeof force === 'boolean' ? force : !hidden;
      write(UI_KEY, hidden ? '1' : '0');
      applyHidden();
    }

    // ---- engine map bridge -------------------------------------------------------------
    // Player positions go to the engine worker (public/fiveweb-natives.js), which places real
    // blips on the game's own radar and pause-menu map (ESC). Nothing is drawn by the page.
    const channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel(options.channelName || 'fiveweb-natives') : null;
    let engineMap = { state: 'waiting', blips: 0, players: 0, zeroHandles: 0, error: '' };
    if (channel) {
      channel.onmessage = (ev) => {
        const m = ev.data;
        if (m && m.type === 'result') { settle(m); return; }
        if (!m || m.type !== 'status') return;
        engineMap = { state: String(m.state || ''), blips: Number(m.blips) || 0, players: Number(m.players) || 0, zeroHandles: Number(m.zeroHandles) || 0, error: typeof m.error === 'string' ? m.error.slice(0, 200) : '' };
        if (dialog.open) renderKeys();
      };
      channel.postMessage({ type: 'hello' });
    }
    // Shared buffer created by the game page (m.fivewebShared) and read by the engine worker;
    // same seqlock layout as fiveweb-natives.js SHARED. BroadcastChannel is the fallback.
    let sharedCash = null;
    function writeShared(sab, players) {
      const i32 = new Int32Array(sab), f32 = new Float32Array(sab);
      const seq = Atomics.load(i32, 0) | 1;
      Atomics.store(i32, 0, seq);
      const list = players.slice(0, 128);
      list.forEach((p, n) => {
        const at = (64 + n * 32) / 4;
        i32[at] = parseInt(p.id.slice(0, 8), 16) | 0;
        f32[at + 1] = p.x; f32[at + 2] = p.y; f32[at + 3] = p.z;
        f32[at + 4] = Number.isFinite(p.heading) ? p.heading : NaN;
      });
      i32[1] = list.length;
      i32[2] = Number.isSafeInteger(sharedCash) && sharedCash >= 0 ? Math.min(sharedCash, 2147483647) : -1;
      Atomics.store(i32, 0, seq + 1);
    }
    function publishPlayers() {
      const sab = root.__fiveWebShared;
      if (!channel && !sab) return 0;
      const mp = getMp();
      const peers = mp && typeof mp.getPeers === 'function' ? mp.getPeers() : [];
      const players = [];
      for (const p of peers) {
        if (!Array.isArray(p.position) || p.position.length < 3 || typeof p.id !== 'string') continue;
        const [x, y, z] = p.position.map(Number);
        if (![x, y, z].every(Number.isFinite)) continue;
        players.push({ id: p.id, x, y, z, heading: Number.isFinite(Number(p.heading)) ? Number(p.heading) : null });
      }
      if (sab && typeof root.SharedArrayBuffer === 'function' && sab instanceof root.SharedArrayBuffer && sab.byteLength >= 4160) writeShared(sab, players);
      else if (channel) channel.postMessage({ type: 'players', players });
      return players.length;
    }
    function engineMapText() {
      if (engineMap.state === 'running') return t('Oyun haritası (ESC) bağlı: {count} oyuncu işaretli.', { count: engineMap.blips });
      if (engineMap.state === 'ready') return t('Oyun haritası (ESC) hazır; oyun dünyası yükleniyor.');
      if (engineMap.state === 'error') return t('Oyun haritasına bağlanılamadı: {error}', { error: engineMap.error });
      return t('Oyun haritası (ESC) çok oyunculu sunucuda oyuncuları gösterir.');
    }
    const timer = root.setInterval(publishPlayers, options.mapIntervalMs || 250);

    // ---- character money and bank (FiveWeb account API) ------------------------------
    const session = (() => { try { return JSON.parse(root.sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; } })();
    const characterId = session && typeof session.characterId === 'string' && /^[0-9a-f]{16}$/.test(session.characterId) ? session.characterId : null;
    const characterName = characterId && typeof session.characterName === 'string' ? session.characterName.slice(0, 40) : '';
    let character = null;
    const badge = el('div', { id: 'fw-money' });
    badge.setAttribute('aria-live', 'polite');
    const bank = el('dialog', { id: 'fw-bank' });
    bank.setAttribute('aria-labelledby', 'fw-bank-title');
    const bankStatus = el('p', { className: 'fw-bank-status' });
    bankStatus.setAttribute('role', 'status');
    async function bankApi(method, url, body) {
      const res = await root.fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty */ }
      if (!res.ok) throw new Error(data && typeof data.error === 'string' ? t(data.error) : t('İşlem başarısız ({status}).', { status: res.status }));
      return data;
    }
    function renderBadge() {
      if (!character) { badge.hidden = true; return; }
      sharedCash = character.cash;
      if (channel && !root.__fiveWebShared) channel.postMessage({ type: 'cash', cash: character.cash });
      badge.hidden = false;
      badge.replaceChildren(el('div', { className: 'fw-cash', textContent: money(character.cash) }), el('div', { className: 'fw-bankline', textContent: t('Banka {amount}', { amount: money(character.bank) }) }));
    }
    let history = [];
    let catalog = null;
    let contacts = [];
    let tab = 'bank';
    const TABS = [['bank', 'Banka'], ['job', 'Meslek'], ['shop', 'Market'], ['cars', 'Galeri'], ['homes', 'Emlak'], ['bag', 'Envanter'], ['contacts', 'Rehber']];
    const say = (text, error = false) => { bankStatus.className = 'fw-bank-status' + (error ? ' error' : ''); bankStatus.textContent = text; };
    async function act(url, body) {
      try {
        const data = await bankApi('POST', `/api/account/characters/${characterId}/${url}`, body);
        character = data.character;
        say(t('İşlem tamam.'));
        await loadHistory();
        if (url === 'houses') await loadCatalog(true);
        renderBadge();
        renderBank();
      } catch (err) {
        say(err.message, true);
      }
    }
    async function loadCatalog(force = false) {
      if (catalog && !force) return;
      try { catalog = await bankApi('GET', '/api/account/catalog'); } catch (_) { catalog = null; }
    }
    function card(title, sub, ...actions) {
      return el('li', { className: 'fw-card' }, el('div', {}, el('strong', { textContent: title }), el('small', { textContent: sub })), el('div', { className: 'fw-actions' }, ...actions));
    }
    function btn(label, onClick, disabled = false) {
      const b = el('button', { type: 'button', textContent: label, disabled });
      b.addEventListener('click', onClick);
      return b;
    }
    function renderTab() {
      const c = character;
      if (tab === 'job') {
        return [el('p', { textContent: t('Şu anki meslek: {job} · maaş {salary} / 10 dk', { job: t(c.job), salary: money(c.salary) }) }),
          el('ul', { className: 'fw-cards' }, ...(catalog ? catalog.jobs : []).map((j) => card(t(j.name), t('Maaş {salary} / 10 dk', { salary: money(j.salary) }),
            btn(j.id === c.jobId ? t('Mevcut') : t('İşe gir'), () => act('job', { jobId: j.id }), j.id === c.jobId))))];
      }
      if (tab === 'shop') {
        return [el('p', { textContent: t('24/7 Market: nakit veya kartla öde.') }),
          el('ul', { className: 'fw-cards' }, ...(catalog ? catalog.items : []).map((it) => card(t(it.name), `${t(it.category)} · ${money(it.price)}`,
            btn(t('Nakit'), () => act('items', { action: 'buy', itemId: it.id, qty: 1, method: 'cash' }), c.cash < it.price),
            btn(t('Kart'), () => act('items', { action: 'buy', itemId: it.id, qty: 1, method: 'bank' }), c.bank < it.price))))];
      }
      if (tab === 'cars') {
        const owned = c.vehicles.map((v) => card(v.name, t('Plaka {plate}', { plate: v.plate }), btn(t('Sat'), () => {
          if (!root.confirm || root.confirm(t('{name} aracını satmak istiyor musunuz?', { name: v.name }))) act('vehicles', { action: 'sell', plate: v.plate });
        })));
        return [el('h3', { textContent: t('Garajım ({count})', { count: c.vehicles.length }) }), el('ul', { className: 'fw-cards' }, ...owned),
          el('h3', { textContent: t('Premium Deluxe Motorsport') }),
          el('ul', { className: 'fw-cards' }, ...(catalog ? catalog.vehicles : []).map((v) => card(v.name, `${t(v.class)} · ${money(v.price)}`,
            btn(t('Satın al'), () => act('vehicles', { action: 'buy', model: v.id }), c.bank < v.price))))];
      }
      if (tab === 'homes') {
        const mine = new Set(c.houses.map((h) => h.id));
        return [el('ul', { className: 'fw-cards' }, ...(catalog ? catalog.houses : []).map((h) => card(h.name, money(h.price) + (mine.has(h.id) ? ' · ' + t('Senin') : h.owned ? ' · ' + t('Satıldı') : ''),
          mine.has(h.id) ? btn(t('Sat'), () => { if (!root.confirm || root.confirm(t('{name} satılsın mı?', { name: h.name }))) act('houses', { action: 'sell', houseId: h.id }); })
            : btn(t('Satın al'), () => act('houses', { action: 'buy', houseId: h.id }), h.owned || c.bank < h.price))))];
      }
      if (tab === 'bag') {
        if (!c.inventory.length) return [el('p', { textContent: t('Envanter boş. Marketten alışveriş yapabilirsin.') })];
        return [el('ul', { className: 'fw-cards' }, ...c.inventory.map((it) => {
          const phone = el('input', { type: 'text', placeholder: '555-0000', maxLength: 8, size: 8 });
          return card(`${t(it.name)} x${it.qty}`, '', phone,
            btn(t('Ver'), () => act('items', { action: 'give', itemId: it.id, qty: 1, phone: phone.value.trim() })),
            btn(t('At'), () => act('items', { action: 'drop', itemId: it.id, qty: 1 })));
        }))];
      }
      if (tab === 'contacts') {
        const mine = el('p', { textContent: t('Numaram {phone} · Hesap {account}', { phone: c.phone, account: c.accountNumber }) });
        if (!contacts.length) return [mine, el('p', { textContent: t('Şu an oyunda başka oyuncu yok.') })];
        return [mine, el('ul', { className: 'fw-cards' }, ...contacts.map((x) => card(x.name, `${x.phone} · ${x.accountNumber}`)))];
      }
      return null;
    }
    function renderBank() {
      const close = el('button', { type: 'button', textContent: t('Kapat') });
      close.addEventListener('click', () => closeBank());
      const head = el('header', {}, el('h2', { id: 'fw-bank-title', textContent: t('Telefon') }), close);
      if (!character) { bank.replaceChildren(head, el('div', { className: 'fw-bank-body' }, el('p', { textContent: t('Telefon için karakterle giriş yapın.') }))); return; }
      const tabs = el('nav', { className: 'fw-tabs' }, ...TABS.map(([id, label]) => {
        const b = btn(t(label), async () => { tab = id; say(''); if (id === 'contacts') await loadContacts(); else await loadCatalog(); renderBank(); });
        b.setAttribute('aria-pressed', String(tab === id));
        return b;
      }));
      const other = renderTab();
      if (other) { bank.replaceChildren(head, tabs, el('div', { className: 'fw-bank-body' }, ...other, bankStatus)); return; }
      const amountInput = () => { const i = el('input', { type: 'number', min: 1, step: 1, inputMode: 'numeric', required: true }); return i; };
      const action = (labelKey, act, extra = []) => {
        const amount = amountInput();
        const form = el('form', {}, ...extra.map((x) => x.label), el('label', {}, t('Tutar'), amount), el('button', { type: 'submit', textContent: t(labelKey) }));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = { action: act, amount: Number(amount.value) };
          for (const x of extra) body[x.key] = x.input.value.trim();
          try {
            const data = await bankApi('POST', `/api/account/characters/${characterId}/bank`, body);
            character = data.character;
            bankStatus.className = 'fw-bank-status';
            bankStatus.textContent = t('İşlem tamam.');
            await loadHistory();
            renderBadge();
            renderBank();
          } catch (err) {
            bankStatus.className = 'fw-bank-status error';
            bankStatus.textContent = err.message;
          }
        });
        return form;
      };
      const field = (key, labelKey, props) => { const input = el('input', props); return { key, input, label: el('label', {}, t(labelKey), input) }; };
      const to = field('to', 'Alıcı hesap no', { type: 'text', placeholder: 'FW0000000000', maxLength: 12, required: true });
      const note = field('note', 'Açıklama', { type: 'text', maxLength: 60 });
      const items = history.slice(0, 10).map((h) => {
        const sign = ['deposit', 'withdraw'].includes(h.type) ? '' : (h.type === 'transfer-out' ? '−' : '+');
        const who = h.counterparty ? ' · ' + h.counterparty : '';
        return el('li', { textContent: `${h.at.slice(0, 16).replace('T', ' ')} · ${t(h.label)}${who} · ${sign}${money(h.amount)}` });
      });
      bank.replaceChildren(head, tabs, el('div', { className: 'fw-bank-body' },
        el('p', { textContent: `${character.fullName} · ${t('Hesap no')}: ${character.accountNumber}` }),
        el('div', { className: 'fw-balances' },
          el('div', {}, t('Nakit'), el('strong', { textContent: money(character.cash) })),
          el('div', {}, t('Banka'), el('strong', { textContent: money(character.bank) }))),
        action('Yatır', 'deposit'), action('Çek', 'withdraw'), action('Havale yap', 'transfer', [to, note]),
        bankStatus,
        el('h3', { textContent: t('Son işlemler') }),
        el('ol', {}, ...items)));
    }
    async function loadHistory() {
      try { history = (await bankApi('GET', `/api/account/characters/${characterId}/transactions`)).transactions || []; } catch (_) { history = []; }
    }
    async function loadCharacter() {
      if (!characterId) return;
      try { character = (await bankApi('GET', `/api/account/characters/${characterId}`)).character; } catch (_) { character = null; }
      renderBadge();
      if (bank.open) renderBank();
    }
    async function loadContacts() {
      try { contacts = (await bankApi('GET', `/api/account/characters/${characterId}/contacts`)).contacts || []; } catch (_) { contacts = []; }
    }
    async function openBank(which) {
      if (doc.pointerLockElement && doc.exitPointerLock) doc.exitPointerLock();
      bankStatus.textContent = '';
      if (typeof which === 'string' && TABS.some(([id]) => id === which)) tab = which;
      await loadCharacter();
      await loadHistory();
      await loadCatalog();
      if (tab === 'contacts') await loadContacts();
      renderBank();
      if (!bank.open) { if (bank.showModal) bank.showModal(); else bank.setAttribute('open', ''); }
    }
    function closeBank() { if (bank.open) { if (bank.close) bank.close(); else bank.removeAttribute('open'); } }
    bank.addEventListener('click', (e) => { if (e.target === bank) closeBank(); });
    badge.hidden = true;
    doc.body.append(badge, bank);
    const moneyTimer = characterId ? root.setInterval(loadCharacter, options.moneyIntervalMs || 30000) : null;
    if (characterId) loadCharacter();

    // ---- toolbar buttons and hotkeys ------------------------------------------------
    const buttons = {};
    const ui = root.GTAGameUI;
    const addButton = (id, label, onClick) => {
      if (ui && typeof ui.button === 'function') return ui.button({ id, label, title: label, onClick });
      const b = el('button', { type: 'button', id, textContent: label });
      b.addEventListener('click', onClick);
      doc.body.append(b);
      return b;
    };
    if (characterId) buttons.bank = addButton('fw-bank-open', t('Telefon') + ' (' + HOTKEYS.bank + ')', () => openBank());
    buttons.keys = addButton('fw-keys-open', t('Tuşlar') + ' (' + HOTKEYS.keys + ')', () => openKeys());
    buttons.ui = addButton('fw-ui-toggle', '', () => toggleUi());
    applyHidden();

    const isTyping = (e) => !!(e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable="true"]'));
    function onKey(e) {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return;
      const action = e.code === HOTKEYS.keys ? 'keys' : e.code === HOTKEYS.ui ? 'ui' : e.code === HOTKEYS.bank && characterId ? 'bank' : null;
      if (!action) return;
      // Captured before the game's own key handler so the engine never sees these keys.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown' || e.repeat) return;
      if (action === 'keys') { if (dialog.open) closeKeys(); else openKeys(); }
      if (action === 'ui') toggleUi();
      if (action === 'bank') { if (bank.open) closeBank(); else openBank(); }
    }
    root.addEventListener('keydown', onKey, { capture: true });
    root.addEventListener('keyup', onKey, { capture: true });
    // ---- Faz 0: engine command client, engine state, notifications -----------------------
    // Layout must match fiveweb-natives.js LAYOUT.
    const LAYOUT = { stateAt: 4160, cmdAt: 4416, cmdHeader: 16, cmdBytes: 16384, total: 4416 + 16 + 16384 };
    const STATE_KEYS = ['seq', 'ped', 'x', 'y', 'z', 'heading', 'health', 'maxHealth', 'armour', 'inVehicle', 'vehicle', 'speed', 'engineOn', 'dead', 'model', 'timer'];
    const STATE_FLOAT = new Set(['x', 'y', 'z', 'heading', 'speed']);
    const pending = new Map();
    let queue = [], nextId = 1;
    const fullBuffer = () => {
      const sab = root.__fiveWebShared;
      return sab && typeof root.SharedArrayBuffer === 'function' && sab instanceof root.SharedArrayBuffer && sab.byteLength >= LAYOUT.total ? sab : null;
    };
    function settle(m) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      root.clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(String(m.error || 'Command failed')));
    }
    function flushCommands() {
      const sab = fullBuffer();
      if (!sab || !queue.length) return;
      const i32 = new Int32Array(sab, LAYOUT.cmdAt, 4);
      if (Atomics.load(i32, 0) !== Atomics.load(i32, 1)) return;
      const batch = queue.splice(0, 32);
      const bytes = new (root.TextEncoder || TextEncoder)().encode(JSON.stringify(batch));
      if (bytes.length > LAYOUT.cmdBytes) { batch.forEach((c) => settle({ id: c.id, ok: false, error: 'Command batch too large' })); return; }
      new Uint8Array(sab, LAYOUT.cmdAt + LAYOUT.cmdHeader, bytes.length).set(bytes);
      i32[2] = bytes.length;
      Atomics.add(i32, 0, 1);
    }
    function cmd(name, args = {}, timeoutMs = 15000) {
      if (!fullBuffer()) return Promise.reject(new Error('Engine bridge unavailable'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = root.setTimeout(() => { pending.delete(id); reject(new Error('Command timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        queue.push({ id, cmd: String(name), args });
        flushCommands();
      });
    }
    function engineState() {
      const sab = fullBuffer();
      if (!sab) return null;
      const i32 = new Int32Array(sab, LAYOUT.stateAt, 64), f32 = new Float32Array(sab, LAYOUT.stateAt, 64);
      const s1 = Atomics.load(i32, 0);
      if (s1 === 0 || (s1 & 1)) return null;
      const out = {};
      STATE_KEYS.forEach((k, i) => { out[k] = STATE_FLOAT.has(k) ? f32[i] : i32[i]; });
      return Atomics.load(i32, 0) === s1 ? out : null;
    }
    const cmdTimer = root.setInterval(flushCommands, 50);

    // Notifications (brutal-notify look, own code; text only).
    const toasts = el('div', { className: 'fw-toasts', role: 'status', ariaLive: 'polite' });
    doc.body.append(toasts);
    function notify(message, type = 'info', title = '', ms = 4500) {
      const kind = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
      const box = el('div', { className: 'fw-toast fw-toast-' + kind });
      box.append(el('strong', { textContent: String(title || t({ success: 'Başarılı', error: 'Hata', warning: 'Uyarı', info: 'Bilgi' }[kind])) }),
        el('span', { textContent: String(message).slice(0, 300) }), el('i', { className: 'fw-toast-bar' }));
      box.style.setProperty('--fw-ms', Math.max(1000, Math.min(Number(ms) || 4500, 20000)) + 'ms');
      toasts.append(box);
      while (toasts.children.length > 5) toasts.firstChild.remove();
      root.setTimeout(() => { box.classList.add('fw-out'); root.setTimeout(() => box.remove(), 350); }, Math.max(1000, Math.min(Number(ms) || 4500, 20000)));
      return box;
    }

    // The game's own toolbar buttons (game.html, loading_music.js, game_ui.js) are English.
    // Their scripts only write these labels, never read them, so a text swap is safe.
    const GAME_LABELS = [
      [/^Loading sound: on$/, 'Yükleme sesi: açık'], [/^Loading sound: off$/, 'Yükleme sesi: kapalı'],
      [/^Return to launcher$/, 'Başlatıcıya dön'], [/^Touch: On$/i, 'Dokunmatik: Açık'], [/^Touch: Off$/i, 'Dokunmatik: Kapalı'],
      [/^Touch settings$/, 'Dokunmatik ayarları'], [/^Save diagnostics$/, 'Tanılamayı kaydet'],
    ];
    const lang = () => (root.FiveWebI18n ? root.FiveWebI18n.language : 'tr');
    function translateGameButtons() {
      const bar = doc.getElementById('game-page-actions');
      if (!bar) return;
      for (const b of bar.querySelectorAll('button')) {
        if (b.children.length) continue;
        const text = b.textContent.trim();
        const english = GAME_LABELS.some(([re]) => re.test(text));
        const original = english ? text : b.dataset.fwEn;
        const hit = original && GAME_LABELS.find(([re]) => re.test(original));
        if (!hit) continue;
        const want = lang() === 'tr' ? hit[1] : original;
        b.dataset.fwEn = original;
        if (text !== want) b.textContent = want;
      }
    }
    const gameObserver = typeof root.MutationObserver === 'function' ? new root.MutationObserver(() => translateGameButtons()) : null;
    const watchBar = () => {
      const bar = doc.getElementById('game-page-actions');
      if (!bar || !gameObserver || bar.__fwWatched) return;
      bar.__fwWatched = true;
      gameObserver.observe(bar, { subtree: true, childList: true, characterData: true });
    };
    translateGameButtons(); watchBar();
    const barTimer = root.setInterval(() => { watchBar(); translateGameButtons(); }, 1000);

    const unsubscribe = root.FiveWebI18n ? root.FiveWebI18n.subscribe(() => {
      translateGameButtons();
      buttons.keys.textContent = t('Tuşlar') + ' (' + HOTKEYS.keys + ')';
      if (buttons.bank) buttons.bank.textContent = t('Telefon') + ' (' + HOTKEYS.bank + ')';
      applyHidden();
      if (dialog.open) renderKeys();
      if (bank.open) renderBank();
    }) : null;

    const api = {
      openKeys, closeKeys, toggleUi, publishPlayers, openPhone: (tab) => openBank(tab), cmd, engineState, notify,
      state: () => ({ hidden, keysOpen: !!dialog.open, phoneOpen: !!bank.open, engineMap: { ...engineMap }, commands: !!fullBuffer(), pending: pending.size }),
      stop() {
        root.clearInterval(timer);
        root.clearInterval(cmdTimer);
        root.clearInterval(barTimer);
        if (gameObserver) gameObserver.disconnect();
        for (const p of pending.values()) { root.clearTimeout(p.timer); p.reject(new Error('Stopped')); }
        pending.clear();
        toasts.remove();
        if (moneyTimer) root.clearInterval(moneyTimer);
        if (channel) channel.close();
        root.removeEventListener('keydown', onKey, { capture: true });
        root.removeEventListener('keyup', onKey, { capture: true });
        if (unsubscribe) unsubscribe();
      },
    };
    root.__fiveWebHud = api;
    root.FiveWeb = Object.freeze({ cmd, state: engineState, notify });
    return api;
  }

  root.FiveWebHud = { install, HOTKEYS };
  const doc = root.document;
  if (doc && !root.__fiveWebHudNoAuto) {
    // Head injection: the toolbar (GTAGameUI) is mounted by the page's module script.
    const start = () => install();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FiveWebHud;
})(typeof self !== 'undefined' ? self : globalThis);
