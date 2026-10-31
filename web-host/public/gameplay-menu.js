/* Standalone FiveWeb gameplay menu. Loaded after the HUD; no engine or UI dependencies. */
(() => {
  'use strict';
  if (window.FiveWebGameplayMenu) return;
  if (new URLSearchParams(location.search).get('multiplayer') !== '1') return;
  const tr = (a, b) => {
    let language = window.FiveWebI18n?.language;
    if (!language) { try { language = localStorage.getItem('fiveweb.lang'); } catch (_) {} }
    return language === 'en' ? b : a;
  };
  const el = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = String(text);
    if (className) n.className = className;
    return n;
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let character = null, characterId = null, draft = null, saved = null;
  let busy = false, loading = null, tab = 'appearance', autoApplied = false, autoApplying = false;
  let lease = null, heartbeatBusy = false, previousFocus = null, disposed = false;
  const options = new Map();
  const state = () => window.FiveWeb?.state?.();
  const notify = (text, type = 'error') => {
    status.textContent = String(text);
    window.FiveWeb?.notify?.(String(text), type);
  };
  async function command(name, args = {}) {
    if (!state()?.ped) throw Error(tr('Oyun motoru henüz hazır değil.', 'The game engine is not ready.'));
    const result = await window.FiveWeb.cmd(name, args);
    if (result === false) throw Error(tr('Motor işlemi reddetti.', 'The engine rejected the action.'));
    return result;
  }
  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `HTTP ${response.status}`), { status: response.status });
    return data;
  }
  function endpoint(suffix) {
    if (!characterId) throw Error(tr('Önce karakterle giriş yapın.', 'Join with a character first.'));
    return `/api/account/characters/${encodeURIComponent(characterId)}/${suffix}`;
  }
  const model = () => character?.gender === 'f' ? 'mp_f_freemode_01' : 'mp_m_freemode_01';
  function prepareDraft() {
    draft = saved ? clone(saved) : { model: model(), components: [], props: [], overlays: [] };
    draft.model = model();
    draft.components ||= [];
    draft.props ||= [];
    draft.overlays ||= [];
  }
  async function loadCharacter(force = false) {
    if (loading) return loading;
    if (character && !force) return;
    loading = (async () => {
      let session;
      try { session = JSON.parse(sessionStorage.getItem('grandv.lobby.session.v1') || 'null'); } catch (_) {}
      characterId = session?.characterId || null;
      if (typeof characterId !== 'string' || !/^[0-9a-f]{16}$/.test(characterId)) throw Error(tr('Önce karakterle giriş yapın.', 'Join with a character first.'));
      const data = await api('/api/account/me');
      character = data.account?.characters?.find((c) => String(c.id) === String(characterId));
      if (!character) throw Error(tr('Seçili karakter bulunamadı.', 'Selected character not found.'));
      const appearance = await api(endpoint('appearance'));
      saved = appearance.appearance || null;
      if (!draft || force) prepareDraft();
    })().finally(() => { loading = null; });
    return loading;
  }
  async function run(fn) {
    if (busy || autoApplying) return;
    busy = true;
    updateDisabled();
    try { await fn(); } catch (error) { notify(error.message || String(error)); }
    finally { busy = false; render(); }
  }
  function updateDisabled() {
    dialog.setAttribute('aria-busy', String(busy || autoApplying));
    for (const control of dialog.querySelectorAll('button,input,select')) {
      if (!control.hasAttribute('data-close')) control.disabled = busy || autoApplying || control.dataset.unavailable === 'true';
    }
  }
  function button(parent, text, action, className = '') {
    const b = el('button', text, className);
    b.type = 'button'; b.addEventListener('click', () => run(action)); parent.append(b); return b;
  }
  function number(parent, text, value, min, max, onChange, step = 1) {
    const label = el('label', undefined, 'fwgm-field');
    label.append(el('span', text));
    const input = el('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!input.checkValidity() || !Number.isFinite(v)) { input.reportValidity(); input.value = String(value); return; }
      value = v; onChange(v);
    });
    label.append(input); parent.append(label); return input;
  }
  function section(title, description) {
    content.append(el('h3', title));
    if (description) content.append(el('p', description, 'fwgm-muted'));
    const body = el('div', undefined, 'fwgm-grid'); content.append(body); return body;
  }
  async function appearanceApply(save) {
    await loadCharacter();
    const payload = clone(draft); payload.model = model();
    await command('appearance', { appearance: payload });
    autoApplied = true;
    options.clear();
    if (save) {
      try {
        const result = await api(endpoint('appearance'), { appearance: payload });
        character = result.character || character;
        saved = clone(character.appearance || payload);
        draft = clone(saved);
      } catch (error) {
        throw Error(tr('Görünüm oyuna uygulandı ama kaydedilemedi: ', 'Appearance applied in game but was NOT saved: ') + error.message);
      }
    }
    notify(save ? tr('Görünüm uygulandı ve kaydedildi.', 'Appearance applied and saved.') : tr('Önizleme uygulandı; henüz kaydedilmedi.', 'Preview applied; not saved yet.'), 'success');
  }
  function renderAppearance() {
    if (!draft) { section(tr('Görünüm', 'Appearance'), tr('Karakter yüklenemedi. Yeniden deneyin.', 'Character not loaded. Try again.')); button(content, tr('Yeniden yükle', 'Reload'), () => loadCharacter(true)); return; }
    const body = section(tr('Kıyafet ve görünüm', 'Clothes and appearance'), tr('Model karakter cinsiyetine kilitli. Boş slotlar değiştirilmez. Önce uygula, sonra kaydet.', 'Model is locked to character gender. Untouched slots are preserved. Apply before saving.'));
    content.append(el('p', model(), 'fwgm-muted'));
    const names = [tr('Yüz', 'Face'), tr('Maske', 'Mask'), tr('Saç', 'Hair'), tr('Gövde', 'Torso'), tr('Pantolon', 'Legs'), tr('Çanta', 'Bags'), tr('Ayakkabı', 'Shoes'), tr('Aksesuar', 'Accessories'), tr('İç üst', 'Undershirt'), tr('Zırh', 'Body armour'), tr('Çıkartma', 'Decals'), tr('Üst', 'Tops')];
    for (let slot = 0; slot < 12; slot++) {
      const card = el('div', undefined, 'fwgm-card'); card.append(el('h4', `${slot} · ${names[slot]}`)); body.append(card);
      const row = draft.components.find((c) => c.slot === slot) || { slot, drawable: 0, texture: 0, palette: 0 };
      const persist = () => { if (!draft.components.includes(row)) draft.components.push(row); };
      const limits = options.get(slot);
      number(card, tr('Model no', 'Drawable'), row.drawable, 0, limits ? Math.max(0, limits.drawables - 1) : 1023, (v) => { persist(); row.drawable = v; row.texture = 0; options.delete(slot); render(); });
      number(card, tr('Doku', 'Texture'), row.texture, 0, limits ? Math.max(0, limits.textures - 1) : 255, (v) => { persist(); row.texture = v; });
      button(card, tr('Motor seçeneklerini al', 'Get engine options'), async () => {
        const result = await command('appearanceOptions', { slot, drawable: row.drawable });
        if (!Number.isInteger(result?.drawables) || !Number.isInteger(result?.textures)) throw Error(tr('Geçersiz motor seçenekleri.', 'Invalid engine options.'));
        options.set(slot, result);
      });
      if (limits) card.append(el('small', `${limits.drawables} ${tr('model', 'drawables')} · ${limits.textures} ${tr('doku', 'textures')}`));
    }
    const hair = el('div', undefined, 'fwgm-card'); body.append(hair); hair.append(el('h4', tr('Saç rengi', 'Hair colour')));
    for (const [key, label] of [['color', tr('Renk', 'Colour')], ['highlight', tr('Işıltı', 'Highlight')]]) number(hair, label, draft.hair?.[key] ?? 0, 0, 63, (v) => { draft.hair ||= { color: 0, highlight: 0 }; draft.hair[key] = v; });
    const face = el('div', undefined, 'fwgm-card'); body.append(face); face.append(el('h4', tr('Yüz kökeni', 'Face heritage')));
    for (const [key, label, max, fallback, step] of [['mother', tr('Anne', 'Mother'), 45, 0, 1], ['father', tr('Baba', 'Father'), 45, 0, 1], ['shapeMix', tr('Yüz karışımı', 'Shape mix'), 1, 0.5, 0.05], ['skinMix', tr('Ten karışımı', 'Skin mix'), 1, 0.5, 0.05]]) number(face, label, draft.headBlend?.[key] ?? fallback, 0, max, (v) => { draft.headBlend ||= { mother: 0, father: 0, shapeMix: 0.5, skinMix: 0.5 }; draft.headBlend[key] = v; }, step);
    const actions = el('div', undefined, 'fwgm-actions'); content.append(actions);
    button(actions, tr('Önizle / uygula', 'Preview / apply'), () => appearanceApply(false));
    button(actions, tr('Uygula ve kaydet', 'Apply and save'), () => appearanceApply(true), 'fwgm-primary');
    button(actions, tr('Kaydedilene dön', 'Restore saved'), async () => {
      if (!saved) throw Error(tr('Kayıtlı görünüm yok; karakter değiştirilmedi.', 'No saved appearance; character unchanged.'));
      await command('appearance', { appearance: saved }); autoApplied = true; prepareDraft(); options.clear();
    });
  }
  const emotes = [['wave', 'El salla', 'Wave'], ['dance', 'Dans et', 'Dance'], ['sit', 'Otur', 'Sit'], ['smoke', 'Sigara', 'Smoke'], ['clipboard', 'Not tut', 'Clipboard'], ['stop', 'Animasyonu durdur', 'Stop animation']];
  function renderEmotes() {
    const body = section(tr('Emote', 'Emotes'));
    for (const [id, a, b] of emotes) button(body, tr(a, b), () => command('emote', { id }));
  }
  async function garage(action, item, extra = {}) {
    const result = await api(endpoint('garage'), { action, plate: item.plate, operationId: item.operationId, ...(item.token ? { token: item.token } : {}), ...extra });
    if (result.character) character = result.character;
    return result;
  }
  async function spawnOwned(vehicle) {
    if (lease) throw Error(tr('Önce bu oturumdaki aracınızı park edin.', 'Park this session’s vehicle first.'));
    const reservation = { plate: vehicle.plate, operationId: crypto.randomUUID() };
    const result = await garage('reserve', reservation);
    const reserved = result.garage;
    if (!reserved?.token || reserved.plate !== reservation.plate || !reserved.model) throw Error(tr('Geçersiz garaj rezervasyonu.', 'Invalid garage reservation.'));
    reservation.token = reserved.token;
    let handle;
    try {
      handle = await command('spawnVehicle', { model: reserved.model, plate: reserved.plate });
      if (!Number.isSafeInteger(handle) || handle <= 0) throw Error(tr('Geçersiz araç kimliği.', 'Invalid vehicle handle.'));
      const confirmed = await garage('confirm', reservation);
      lease = { ...reservation, handle, deleted: false, expiresAt: confirmed.garage.expiresAt };
      notify(tr('Araç garajdan çıkarıldı.', 'Vehicle retrieved.'), 'success');
    } catch (error) {
      let cleanupError = null;
      if (Number.isSafeInteger(handle) && handle > 0) {
        try { await command('deleteVehicle', { vehicle: handle, plate: reserved.plate }); }
        catch (e) { cleanupError = e; lease = { ...reservation, handle, deleted: false }; }
      }
      // Do not release ownership if engine cleanup failed: prevent duplicate spawns.
      if (!cleanupError) {
        try { await garage('cancel', reservation); } catch (e) { cleanupError = e; }
      }
      throw Error(error.message + (cleanupError ? tr(' Temizleme başarısız: ', ' Cleanup failed: ') + cleanupError.message : ''));
    }
  }
  async function parkOwned() {
    if (!lease) throw Error(tr('Bu oturumda çıkarılmış araç yok.', 'No vehicle retrieved in this session.'));
    const active = lease;
    if (!active.deleted) {
      const s = state();
      if (!s?.inVehicle || s.vehicle !== active.handle) throw Error(tr('Yalnız bu oturumda çıkardığınız aracın içindeyken park edebilirsiniz.', 'You must be inside the exact vehicle retrieved in this session.'));
      await command('deleteVehicle', { vehicle: active.handle, plate: active.plate });
      active.deleted = true;
    }
    try { await garage('park', active); }
    catch (error) { throw Error(tr('Araç kaldırıldı; garaj kaydı başarısız. Parkı yeniden deneyin: ', 'Vehicle removed; garage update failed. Retry parking: ') + error.message); }
    lease = null;
    notify(tr('Araç park edildi.', 'Vehicle parked.'), 'success');
  }
  function renderGarage() {
    const body = section(tr('Garajım', 'My garage'), tr('Sadece hesabınıza ait araçlar. Aynı anda bir aktif araç.', 'Owned vehicles only. One active vehicle at a time.'));
    button(content, tr('Garajı yenile', 'Refresh garage'), () => loadCharacter(true));
    if (lease) {
      const card = el('div', undefined, 'fwgm-card'); card.append(el('h4', lease.plate));
      card.append(el('p', lease.deleted ? tr('Garaj kaydı bekliyor.', 'Garage update pending.') : tr('Bu oturumda aktif.', 'Active in this session.')));
      button(card, lease.deleted ? tr('Park kaydını yeniden dene', 'Retry parking update') : tr('Mevcut aracımı park et', 'Park my current vehicle'), parkOwned, 'fwgm-primary'); body.append(card);
    }
    const vehicles = character?.vehicles || [];
    if (!vehicles.length) body.append(el('p', tr('Garajınız boş.', 'Your garage is empty.')));
    for (const vehicle of vehicles) {
      const card = el('div', undefined, 'fwgm-card'); card.append(el('h4', vehicle.name || vehicle.model), el('p', vehicle.plate));
      const b = button(card, tr('Garajdan çıkar', 'Retrieve vehicle'), () => spawnOwned(vehicle));
      b.dataset.unavailable = String(!!lease || (vehicle.garageState && vehicle.garageState !== 'stored')); body.append(card);
      if (vehicle.garageState && vehicle.garageState !== 'stored') card.append(el('small', tr('Araç dışarıda veya çıkarılıyor.', 'Vehicle is outside or being retrieved.')));
    }
  }
  function requireVehicle() {
    if (!state()?.inVehicle || !state()?.vehicle) throw Error(tr('Önce bir araca binin.', 'Enter a vehicle first.'));
  }
  async function vehicleControl(action, extra = {}) { requireVehicle(); await command('vehicleControl', { action, ...extra }); }
  function renderVehicle() {
    const body = section(tr('Araç kontrolleri', 'Vehicle controls'), tr('Kontroller bindiğiniz araca uygulanır.', 'Controls apply to the vehicle you are in.'));
    button(body, tr('Motoru aç / kapat', 'Toggle engine'), () => vehicleControl('engine', { value: !state()?.engineOn }));
    button(body, tr('Aracı onar', 'Repair vehicle'), () => vehicleControl('repair'));
    for (const [index, a, b] of [[0, 'Sol ön', 'Front left'], [1, 'Sağ ön', 'Front right'], [2, 'Sol arka', 'Rear left'], [3, 'Sağ arka', 'Rear right'], [4, 'Kaput', 'Bonnet'], [5, 'Bagaj', 'Boot']]) {
      const card = el('div', undefined, 'fwgm-card'); card.append(el('h4', tr(a, b)));
      button(card, tr('Kapıyı aç', 'Open door'), () => vehicleControl('door', { index, value: true }));
      button(card, tr('Kapıyı kapat', 'Close door'), () => vehicleControl('door', { index, value: false }));
      if (index < 4) {
        button(card, tr('Camı indir', 'Lower window'), () => vehicleControl('window', { index, value: true }));
        button(card, tr('Camı kaldır', 'Raise window'), () => vehicleControl('window', { index, value: false }));
      }
      body.append(card);
    }
    const style = el('div', undefined, 'fwgm-card'); body.append(style); style.append(el('h4', tr('Araç stili', 'Vehicle style')));
    const values = { primary: 0, secondary: 0, tint: 0, mods: [] };
    number(style, tr('Ana renk', 'Primary colour'), 0, 0, 159, (v) => { values.primary = v; });
    number(style, tr('İkinci renk', 'Secondary colour'), 0, 0, 159, (v) => { values.secondary = v; });
    number(style, tr('Cam tonu', 'Window tint'), 0, 0, 6, (v) => { values.tint = v; });
    let modSlot = 0, modIndex = -1;
    number(style, tr('Mod slotu', 'Mod slot'), 0, 0, 49, (v) => { modSlot = v; });
    number(style, tr('Mod no (-1 stok)', 'Mod index (-1 stock)'), -1, -1, 99, (v) => { modIndex = v; });
    button(style, tr('Renk ve tonu uygula', 'Apply colours and tint'), async () => { requireVehicle(); await command('vehicleStyle', values); });
    button(style, tr('Modu uygula', 'Apply mod'), async () => { requireVehicle(); await command('vehicleStyle', { ...values, mods: [{ slot: modSlot, index: modIndex }] }); });
  }
  function renderRadial() {
    const body = section(tr('Hızlı eylemler', 'Quick actions'));
    body.classList.add('fwgm-radial');
    button(body, tr('Telefon', 'Phone'), () => { close(); window.__fiveWebHud?.openPhone(); });
    button(body, tr('Banka', 'Bank'), () => { close(); window.__fiveWebHud?.openPhone('bank'); });
    button(body, tr('El salla', 'Wave'), () => command('emote', { id: 'wave' }));
    button(body, tr('Durdur', 'Stop'), () => command('emote', { id: 'stop' }));
    button(body, tr('Motor', 'Engine'), () => vehicleControl('engine', { value: !state()?.engineOn }));
    button(body, tr('Park et', 'Park'), parkOwned);
  }
  const dialog = el('dialog', undefined, 'fwgm'); dialog.id = 'fiveweb-gameplay-menu'; dialog.setAttribute('aria-labelledby', 'fwgm-title');
  const header = el('header', undefined, 'fwgm-header');
  const title = el('h2', 'FiveWeb · F1'); title.id = 'fwgm-title'; header.append(title);
  const closeButton = el('button', '×'); closeButton.type = 'button'; closeButton.dataset.close = ''; closeButton.setAttribute('aria-label', tr('Kapat', 'Close')); closeButton.addEventListener('click', close); header.append(closeButton);
  const nav = el('nav', undefined, 'fwgm-tabs'); nav.setAttribute('aria-label', tr('Oyun menüsü', 'Gameplay menu'));
  const content = el('section', undefined, 'fwgm-content'); content.id = 'fwgm-content';
  const status = el('p', '', 'fwgm-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  dialog.append(header, nav, content, status);
  const tabs = [['appearance', 'Görünüm', 'Appearance'], ['emotes', 'Emote', 'Emotes'], ['garage', 'Garaj', 'Garage'], ['vehicle', 'Araç', 'Vehicle'], ['radial', 'Radial', 'Quick actions']];
  function render() {
    nav.replaceChildren(); content.replaceChildren();
    for (const [key, a, b] of tabs) {
      const btt = el('button', tr(a, b)); btt.type = 'button'; btt.setAttribute('aria-pressed', String(tab === key)); btt.setAttribute('aria-controls', content.id);
      btt.addEventListener('click', () => { tab = key; render(); }); nav.append(btt);
    }
    ({ appearance: renderAppearance, emotes: renderEmotes, garage: renderGarage, vehicle: renderVehicle, radial: renderRadial })[tab]();
    updateDisabled();
  }
  function close() { if (dialog.open) dialog.close(); }
  async function open() {
    if (disposed || dialog.open) return;
    previousFocus = document.activeElement;
    if (document.pointerLockElement) document.exitPointerLock?.();
    render(); dialog.showModal(); closeButton.focus();
    await run(async () => { await loadCharacter(); });
  }
  dialog.addEventListener('close', () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  function key(e) {
    if (e.key === 'F1' || e.code === 'F1') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) { if (dialog.open) close(); else void open(); }
    } else if (e.key === 'Escape' && dialog.open) {
      e.preventDefault(); e.stopImmediatePropagation(); if (e.type === 'keydown') close();
    }
  }
  async function autoApply() {
    if (disposed || autoApplied || autoApplying || busy || !saved || !state()?.ped) return;
    autoApplying = true; autoApplied = true; updateDisabled();
    try { await command('appearance', { appearance: saved }); }
    catch (error) { notify(tr('Kayıtlı görünüm uygulanamadı: ', 'Saved appearance could not be applied: ') + error.message); }
    finally { autoApplying = false; clearInterval(pollTimer); if (dialog.open) render(); }
  }
  async function heartbeat() {
    if (!lease || lease.deleted || heartbeatBusy || busy || disposed) return;
    heartbeatBusy = true;
    const active = lease;
    try {
      const result = await garage('heartbeat', active);
      if (lease === active) active.expiresAt = result.garage.expiresAt;
    } catch (error) {
      if (error.status === 409 || (active.expiresAt && Date.now() >= active.expiresAt)) {
        try {
          await command('deleteVehicle', { vehicle: active.handle, plate: active.plate });
          if (lease === active) lease = null;
        } catch (cleanup) { notify(cleanup.message); }
      }
      notify(tr('Garaj bağlantısı: ', 'Garage connection: ') + error.message);
    }
    finally { heartbeatBusy = false; }
  }
  let pollTimer, heartbeatTimer;
  function start() {
    document.body.append(dialog);
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    loadCharacter().then(() => { if (!saved) clearInterval(pollTimer); return autoApply(); }).catch((error) => { clearInterval(pollTimer); if (characterId) notify(error.message || String(error)); });
    pollTimer = window.setInterval(autoApply, 1000);
    heartbeatTimer = window.setInterval(heartbeat, 30000);
  }
  function stop() {
    disposed = true; clearInterval(pollTimer); clearInterval(heartbeatTimer);
    window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); close(); dialog.remove();
  }
  window.FiveWebGameplayMenu = Object.freeze({ open, close, stop });
  window.addEventListener('pagehide', () => { clearInterval(pollTimer); clearInterval(heartbeatTimer); });
  window.addEventListener('pageshow', (e) => { if (e.persisted && !disposed) { pollTimer = window.setInterval(autoApply, 1000); heartbeatTimer = window.setInterval(heartbeat, 30000); void heartbeat(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
