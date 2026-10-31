/* FiveWeb engine natives (runs inside the game's engine worker, loader.js).
 *
 * The Menyoo engine build (game.menyoo-mainline.wasm) has the same imports as game.wasm and
 * additionally exports ScriptHook-style natives (__menyoo_native_<hash>) plus a script
 * callback slot (__menyoo_callback_index) that the engine calls once per script tick on the
 * game thread. Menyoo installs its own compiled menu there; in multiplayer FiveWeb installs
 * this small runtime instead, so natives run at the same safe point Menyoo uses.
 *
 * The engine worker runs the game loop and does not service its message queue, so page -> worker
 * data goes through a SharedArrayBuffer handed over in the worker's start message
 * (m.fivewebShared, created by the game page). Layout (SHARED, seqlock):
 *   int32[0] seq (odd while the page writes), int32[1] player count, int32[2] cash (-1 = none)
 *   from byte 64: per player 8 x 4 bytes: int32 key, float32 x, y, z, heading
 * The page (game-hud.js) writes; tick() reads. Status goes back over
 * BroadcastChannel('fiveweb-natives') {type:'status', state, blips, players, error}.
 * Any native failure turns the runtime off (callback cleared) and is reported; the game keeps
 * running exactly as without it.
 */
(function (root) {
  'use strict';

  // Minimal wasm module: imports env.tick () -> () and re-exports it, so a JS function can sit
  // in the engine's funcref table (a plain JS function cannot be stored there).
  const TICK_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x74, 0x69, 0x63, 0x6b, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x74, 0x69, 0x63, 0x6b, 0x00, 0x01,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
  ]);

  const NEEDED = ['ADD_BLIP_FOR_COORD', 'SET_BLIP_COORDS', 'REMOVE_BLIP', 'DOES_BLIP_EXIST', 'SET_BLIP_SPRITE', 'SET_BLIP_COLOUR', 'SET_BLIP_SCALE', 'SET_BLIP_ROTATION', 'SET_BLIP_DISPLAY', 'SET_BLIP_AS_SHORT_RANGE'];
  const OPTIONAL = ['STAT_SET_INT', 'GET_HASH_KEY'];
  const SCALAR = /^(?:int|BOOL|Any|Hash|Ped|Vehicle|Entity|Player|Cam|Blip|Interior|Object|ScrHandle)$/;
  const BLIP_SPRITE = 1; // round player dot
  const BLIP_DISPLAY_MAP_AND_RADAR = 6;
  const COLOURS = [3, 2, 5, 8, 17, 27, 38, 47, 50, 57, 69, 83];
  const RECONCILE_MS = 250;
  const MAX_BLIPS = 128;
  const CASH_STATS = ['SP0_TOTAL_CASH', 'SP1_TOTAL_CASH', 'SP2_TOTAL_CASH'];
  const SHARED = Object.freeze({ bytes: 64 + 32 * 128, header: 64, entry: 32, max: 128 });
  // Faz 0 extension of the same buffer: engine state (worker writes) and a command mailbox
  // (page writes one JSON batch, worker consumes it and acknowledges with readSeq = writeSeq).
  const LAYOUT = Object.freeze({ stateAt: 4160, stateBytes: 256, cmdAt: 4416, cmdHeader: 16, cmdBytes: 16384, total: 4416 + 16 + 16384 });
  const WEATHERS = ['CLEAR', 'EXTRASUNNY', 'CLOUDS', 'OVERCAST', 'RAIN', 'CLEARING', 'THUNDER', 'SMOG', 'FOGGY', 'XMAS', 'SNOW', 'SNOWLIGHT', 'BLIZZARD', 'HALLOWEEN', 'NEUTRAL'];

  // Page side: queue one batch of commands when the mailbox is free. Returns false when busy.
  function writeCommands(sab, batch) {
    const i32 = new Int32Array(sab, LAYOUT.cmdAt, 4);
    if (Atomics.load(i32, 0) !== Atomics.load(i32, 1)) return false;
    const bytes = new TextEncoder().encode(JSON.stringify(batch));
    if (bytes.length > LAYOUT.cmdBytes) throw Error('Command batch too large');
    new Uint8Array(sab, LAYOUT.cmdAt + LAYOUT.cmdHeader, bytes.length).set(bytes);
    i32[2] = bytes.length;
    Atomics.add(i32, 0, 1);
    return true;
  }
  // Worker side: take the pending batch (or null) and free the mailbox.
  function takeCommands(sab) {
    const i32 = new Int32Array(sab, LAYOUT.cmdAt, 4);
    const w = Atomics.load(i32, 0);
    if (w === Atomics.load(i32, 1)) return null;
    const len = Math.min(Math.max(i32[2], 0), LAYOUT.cmdBytes);
    const copy = new Uint8Array(len);
    copy.set(new Uint8Array(sab, LAYOUT.cmdAt + LAYOUT.cmdHeader, len));
    Atomics.store(i32, 1, w);
    try { const v = JSON.parse(new TextDecoder().decode(copy)); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  // Engine state block: int32/float32 slots.
  const STATE_KEYS = ['seq', 'ped', 'x', 'y', 'z', 'heading', 'health', 'maxHealth', 'armour', 'inVehicle', 'vehicle', 'speed', 'engineOn', 'dead', 'model', 'timer'];
  const STATE_FLOAT = new Set(['x', 'y', 'z', 'heading', 'speed']);
  function writeState(sab, st) {
    const i32 = new Int32Array(sab, LAYOUT.stateAt, 64), f32 = new Float32Array(sab, LAYOUT.stateAt, 64);
    const seq = (Atomics.load(i32, 0) | 1);
    Atomics.store(i32, 0, seq);
    STATE_KEYS.forEach((k, i) => { if (i === 0) return; if (STATE_FLOAT.has(k)) f32[i] = Number(st[k]) || 0; else i32[i] = Number(st[k]) | 0; });
    Atomics.store(i32, 0, seq + 1);
  }
  function readState(sab) {
    const i32 = new Int32Array(sab, LAYOUT.stateAt, 64), f32 = new Float32Array(sab, LAYOUT.stateAt, 64);
    const s1 = Atomics.load(i32, 0);
    if (s1 === 0 || (s1 & 1)) return null;
    const out = {};
    STATE_KEYS.forEach((k, i) => { out[k] = STATE_FLOAT.has(k) ? f32[i] : i32[i]; });
    if (Atomics.load(i32, 0) !== s1) return null;
    return out;
  }

  // Page side: write players + cash into the shared buffer (seqlock).
  function writeShared(sab, players, cash) {
    const i32 = new Int32Array(sab), f32 = new Float32Array(sab);
    const seq = Atomics.load(i32, 0);
    Atomics.store(i32, 0, (seq | 1) + 0); // odd: writing
    const list = players.slice(0, SHARED.max);
    list.forEach((p, n) => {
      const at = (SHARED.header + n * SHARED.entry) / 4;
      i32[at] = p.key | 0;
      f32[at + 1] = p.x; f32[at + 2] = p.y; f32[at + 3] = p.z;
      f32[at + 4] = Number.isFinite(p.heading) ? p.heading : NaN;
    });
    i32[1] = list.length;
    i32[2] = Number.isSafeInteger(cash) && cash >= 0 ? Math.min(cash, 2147483647) : -1;
    Atomics.store(i32, 0, (seq | 1) + 1); // even: stable
  }

  // Worker side: consistent snapshot or null while the page is writing.
  function readShared(sab) {
    const i32 = new Int32Array(sab), f32 = new Float32Array(sab);
    const s1 = Atomics.load(i32, 0);
    if (s1 & 1) return null;
    const count = Math.min(Math.max(i32[1], 0), SHARED.max);
    const players = [];
    for (let n = 0; n < count; n++) {
      const at = (SHARED.header + n * SHARED.entry) / 4;
      players.push({ id: 'k' + i32[at], x: f32[at + 1], y: f32[at + 2], z: f32[at + 3], heading: f32[at + 4] });
    }
    const cash = i32[2];
    if (Atomics.load(i32, 0) !== s1) return null;
    return { seq: s1, players, cash: cash >= 0 ? cash : null };
  }

  function createCaller(engine, descriptors) {
    const e = engine.exports;
    const byName = new Map();
    for (const d of Object.values(descriptors)) if (d && typeof d.name === 'string') byName.set(d.name, d);
    const has = (name) => byName.has(name) && typeof e[byName.get(name).export] === 'function';

    function call(name, ...values) {
      const d = byName.get(name);
      if (!d) throw Error('Unavailable native: ' + name);
      if (values.length !== d.params.length) throw Error('Native argument count mismatch: ' + name);
      const block = Number(e.__menyoo_mailbox.value);
      if (!block) return undefined; // engine has not allocated the script mailbox yet
      const mem = e.__menyoo_memory;
      const ctx = block + 512, result = block + 640, params = block + 704, limit = block + 126976;
      let scratch = block + 1280;
      const alloc = (n) => { scratch = Math.ceil(scratch / 8) * 8; const at = scratch; scratch += n; if (scratch > limit || scratch > mem.buffer.byteLength) throw Error('Native scratch exhausted'); return at; };
      let view = new DataView(mem.buffer);
      new Uint8Array(mem.buffer, ctx, 768).fill(0);
      const pointers = [];
      d.params.forEach((type, i) => {
        const v = values[i];
        let bits;
        if (type === 'float') {
          view.setFloat32(params + 8 * i, Number(v), true);
          view.setUint32(params + 8 * i + 4, 0, true);
          return;
        } else if (SCALAR.test(type)) {
          bits = BigInt.asUintN(32, BigInt(Math.trunc(Number(v) || 0)));
        } else if (type === 'const char*') {
          const bytes = new TextEncoder().encode(String(v));
          const at = alloc(bytes.length + 1);
          new Uint8Array(mem.buffer, at, bytes.length + 1).set([...bytes, 0]);
          bits = BigInt(at);
        } else if (/^(?:int|Blip|Ped|Vehicle|Entity|Object|Hash|BOOL)\*$/.test(type)) {
          const at = alloc(8);
          view.setBigInt64(at, 0n, true);
          view.setInt32(at, Number(v) | 0, true);
          pointers.push(at);
          bits = BigInt(at);
        } else {
          throw Error('Unsupported native parameter ' + type + ' in ' + name);
        }
        view.setBigUint64(params + 8 * i, bits, true);
      });
      view.setBigUint64(ctx, BigInt(result), true);
      view.setInt32(ctx + 8, d.params.length, true);
      view.setBigUint64(ctx + 16, BigInt(params), true);
      new Uint8Array(mem.buffer, result, 32).fill(0);
      e[d.export](BigInt(ctx));
      view = new DataView(mem.buffer); // natives can grow memory
      switch (d.result) {
        case 'void': case 'Void': return undefined;
        case 'float': return view.getFloat32(result, true);
        case 'Vector3': return [view.getFloat32(result, true), view.getFloat32(result + 8, true), view.getFloat32(result + 16, true)];
        case 'Hash': return view.getUint32(result, true);
        case 'const char*': {
          const ptr = Number(view.getBigUint64(result, true));
          if (!Number.isSafeInteger(ptr) || ptr <= 0 || ptr >= mem.buffer.byteLength) return '';
          const bytes = new Uint8Array(mem.buffer, ptr, Math.min(256, mem.buffer.byteLength - ptr));
          const end = bytes.indexOf(0);
          return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
        }
        default: return view.getInt32(result, true);
      }
    }
    return { call, has };
  }

  function createRuntime(engine, descriptors, { channel, shared = null, now = () => Date.now(), log = console } = {}) {
    const e = engine.exports;
    for (const k of ['__menyoo_mailbox', '__menyoo_memory', '__indirect_function_table', '__menyoo_callback_index']) {
      if (!(k in e)) throw Error('Engine build has no FiveWeb native support (' + k + ')');
    }
    const natives = createCaller(engine, descriptors);
    const missing = NEEDED.filter((n) => !natives.has(n));
    if (missing.length) throw Error('Missing natives: ' + missing.join(', '));
    const canCash = OPTIONAL.every((n) => natives.has(n));

    const blips = new Map(); // player id -> { handle, colour }
    let players = [];
    let cash = null, cashApplied = null;
    let lastSeq = -1;
    let failed = false, lastRun = 0, ticks = 0, colourNext = 0, reported = '', zeroHandles = 0;
    const post = (msg) => { try { channel && channel.postMessage(msg); } catch (_) { /* page gone */ } };

    function status(state, extra = {}) {
      const msg = { type: 'status', state, blips: blips.size, players: players.length, zeroHandles, ticks, ...extra };
      const key = state + ':' + msg.blips + ':' + msg.players + ':' + zeroHandles + ':' + (extra.error || '');
      if (key !== reported) { reported = key; post(msg); }
    }

    function removeBlip(id) {
      const b = blips.get(id);
      if (!b) return;
      if (natives.call('DOES_BLIP_EXIST', b.handle)) natives.call('REMOVE_BLIP', b.handle);
      blips.delete(id);
    }

    function reconcile() {
      const seen = new Set();
      for (const p of players) {
        if (blips.size >= MAX_BLIPS && !blips.has(p.id)) break;
        seen.add(p.id);
        let b = blips.get(p.id);
        if (b && !natives.call('DOES_BLIP_EXIST', b.handle)) { blips.delete(p.id); b = null; }
        if (!b) {
          const handle = natives.call('ADD_BLIP_FOR_COORD', p.x, p.y, p.z);
          if (handle === undefined) return false; // mailbox not ready
          if (!handle) { zeroHandles++; continue; }
          const colour = COLOURS[colourNext++ % COLOURS.length];
          natives.call('SET_BLIP_SPRITE', handle, BLIP_SPRITE);
          natives.call('SET_BLIP_COLOUR', handle, colour);
          natives.call('SET_BLIP_SCALE', handle, 0.85);
          natives.call('SET_BLIP_DISPLAY', handle, BLIP_DISPLAY_MAP_AND_RADAR);
          natives.call('SET_BLIP_AS_SHORT_RANGE', handle, 0);
          b = { handle, colour };
          blips.set(p.id, b);
        } else {
          natives.call('SET_BLIP_COORDS', b.handle, p.x, p.y, p.z);
        }
        if (Number.isFinite(p.heading)) natives.call('SET_BLIP_ROTATION', b.handle, Math.round(p.heading));
      }
      for (const id of [...blips.keys()]) if (!seen.has(id)) removeBlip(id);
      if (canCash && cash !== null && cash !== cashApplied) {
        for (const stat of CASH_STATS) natives.call('STAT_SET_INT', natives.call('GET_HASH_KEY', stat), cash, 1);
        cashApplied = cash;
      }
      return true;
    }

    // ---- Faz 0: commands (page -> engine) and engine state (engine -> page) ----------------
    const full = !!(shared && shared.byteLength >= LAYOUT.total);
    const tasks = [];
    let lastState = 0;
    const has = (n) => natives.has(n);
    const reply = (id, ok, value, error) => post({ type: 'result', id, ok, ...(ok ? { value } : { error: String(error && error.message || error).slice(0, 200) }) });
    const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw Error('Invalid number'); return n; };
    const ped = () => natives.call('PLAYER_PED_ID');
    const integer = (v, lo, hi) => {
      if (!Number.isInteger(v) || v < lo || v > hi) throw Error('Invalid integer');
      return v;
    };
    const object = (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid object');
      return v;
    };
    const unit = (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw Error('Invalid fraction');
      return v;
    };
    const entries = (v, max) => {
      if (!Array.isArray(v) || v.length > max) throw Error('Invalid list');
      return v.map(object);
    };
    const requireNatives = (...names) => {
      for (const name of names) if (!has(name)) throw Error('Unavailable native: ' + name);
    };
    const driverVehicle = () => {
      const p = ped();
      if (!p || !natives.call('IS_PED_IN_ANY_VEHICLE', p, 0)) throw Error('Not in a vehicle');
      const v = natives.call('GET_VEHICLE_PED_IS_IN', p, 0);
      if (!v || natives.call('GET_PED_IN_VEHICLE_SEAT', v, -1, 0) !== p) throw Error('Driver required');
      return v;
    };
    const EMOTES = Object.freeze({
      wave: { dict: 'anim@mp_player_intcelebrationmale@wave', anim: 'wave', flags: 48 },
      dance: { dict: 'anim@amb@nightclub@dancers@podium_dancers@', anim: 'hi_dance_facedj_17_v2_male^5', flags: 1 },
      sit: { scenario: 'WORLD_HUMAN_PICNIC' },
      smoke: { scenario: 'WORLD_HUMAN_SMOKING' },
      clipboard: { scenario: 'WORLD_HUMAN_CLIPBOARD' },
    });
    let changingAppearance = false, emoteVersion = 0;
    const COMMANDS = {
      *appearance(a) {
        const ap = object(a.appearance);
        if (!['mp_m_freemode_01', 'mp_f_freemode_01'].includes(ap.model)) throw Error('Invalid appearance model');
        const components = entries(ap.components, 12).map((c) => ({
          slot: integer(c.slot, 0, 11), drawable: integer(c.drawable, 0, 65535),
          texture: integer(c.texture, 0, 65535), palette: integer(c.palette, 0, 3),
        }));
        const props = entries(ap.props, 8).map((c) => ({
          slot: integer(c.slot, 0, 7), drawable: integer(c.drawable, -1, 65535), texture: integer(c.texture, 0, 65535),
        }));
        const hair = ap.hair === undefined ? null : object(ap.hair);
        if (hair) { integer(hair.color, 0, 63); integer(hair.highlight, 0, 63); }
        const blend = ap.headBlend === undefined ? null : object(ap.headBlend);
        if (blend) { integer(blend.mother, 0, 45); integer(blend.father, 0, 45); unit(blend.shapeMix); unit(blend.skinMix); }
        const overlays = entries(ap.overlays ?? [], 13).map((o) => ({
          slot: integer(o.slot, 0, 12), index: integer(o.index, 0, 255), opacity: unit(o.opacity),
        }));
        requireNatives('GET_HASH_KEY', 'GET_ENTITY_MODEL', 'GET_PLAYER_PED', 'SET_PLAYER_MODEL', 'IS_MODEL_IN_CDIMAGE',
          'REQUEST_MODEL', 'HAS_MODEL_LOADED', 'SET_MODEL_AS_NO_LONGER_NEEDED', 'SET_PED_DEFAULT_COMPONENT_VARIATION',
          'GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS', 'GET_NUMBER_OF_PED_TEXTURE_VARIATIONS', 'SET_PED_COMPONENT_VARIATION',
          'GET_NUMBER_OF_PED_PROP_DRAWABLE_VARIATIONS', 'GET_NUMBER_OF_PED_PROP_TEXTURE_VARIATIONS', 'SET_PED_PROP_INDEX', 'CLEAR_PED_PROP');
        if (hair) requireNatives('GET_NUM_PED_HAIR_TINTS', 'SET_PED_HAIR_TINT');
        if (blend) requireNatives('SET_PED_HEAD_BLEND_DATA');
        if (overlays.length) requireNatives('GET_PED_HEAD_OVERLAY_NUM', 'SET_PED_HEAD_OVERLAY');
        if (hair && Math.max(hair.color, hair.highlight) >= natives.call('GET_NUM_PED_HAIR_TINTS')) throw Error('Unavailable hair tint');
        for (const o of overlays) {
          if (o.index !== 255 && o.index >= natives.call('GET_PED_HEAD_OVERLAY_NUM', o.slot)) throw Error('Unavailable overlay');
        }
        if (changingAppearance) throw Error('Appearance busy');
        changingAppearance = true;
        const until = now() + 8000;
        let requested = false, hash;
        try {
          hash = natives.call('GET_HASH_KEY', ap.model);
          let p = ped();
          if (!p) throw Error('Player not ready');
          if (natives.call('GET_ENTITY_MODEL', p) !== hash) {
            // PLAYER_ID is not exported by this build; resolve the local player from its ped.
            let player = -1;
            for (let i = 0; i < 32; i++) if (natives.call('GET_PLAYER_PED', i) === p) { player = i; break; }
            if (player < 0) throw Error('Local player unavailable');
            if (!natives.call('IS_MODEL_IN_CDIMAGE', hash)) throw Error('Model not in game files');
            natives.call('REQUEST_MODEL', hash);
            requested = true;
            while (!natives.call('HAS_MODEL_LOADED', hash)) {
              if (now() >= until) throw Error('Model load timeout');
              yield;
            }
            if (now() >= until) throw Error('Model load timeout');
            natives.call('SET_PLAYER_MODEL', player, hash);
            p = ped(); // SET_PLAYER_MODEL replaces the ped handle, once only.
            if (!p || natives.call('GET_ENTITY_MODEL', p) !== hash) throw Error('Model change failed');
            natives.call('SET_PED_DEFAULT_COMPONENT_VARIATION', p);
          }
          for (const c of components) {
            if (c.drawable >= natives.call('GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS', p, c.slot) ||
                c.texture >= natives.call('GET_NUMBER_OF_PED_TEXTURE_VARIATIONS', p, c.slot, c.drawable)) throw Error('Unavailable component');
          }
          for (const c of props) {
            if (c.drawable !== -1 && (c.drawable >= natives.call('GET_NUMBER_OF_PED_PROP_DRAWABLE_VARIATIONS', p, c.slot) ||
                c.texture >= natives.call('GET_NUMBER_OF_PED_PROP_TEXTURE_VARIATIONS', p, c.slot, c.drawable))) throw Error('Unavailable prop');
          }
          if (blend) natives.call('SET_PED_HEAD_BLEND_DATA', p, blend.mother, blend.father, 0, blend.mother, blend.father, 0, blend.shapeMix, blend.skinMix, 0, 0);
          for (const c of components) natives.call('SET_PED_COMPONENT_VARIATION', p, c.slot, c.drawable, c.texture, c.palette);
          for (const c of props) {
            if (c.drawable === -1) natives.call('CLEAR_PED_PROP', p, c.slot, 0);
            else natives.call('SET_PED_PROP_INDEX', p, c.slot, c.drawable, c.texture, 1, 0);
          }
          if (hair) natives.call('SET_PED_HAIR_TINT', p, hair.color, hair.highlight);
          for (const o of overlays) natives.call('SET_PED_HEAD_OVERLAY', p, o.slot, o.index, o.opacity);
          return true;
        } finally {
          changingAppearance = false;
          if (requested) natives.call('SET_MODEL_AS_NO_LONGER_NEEDED', hash);
        }
      },
      *appearanceOptions(a) {
        if (changingAppearance) throw Error('Appearance busy');
        const slot = integer(a.slot, 0, 11), drawable = integer(a.drawable, 0, 65535), p = ped();
        if (!p) throw Error('Player not ready');
        const drawables = natives.call('GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS', p, slot);
        if (drawable >= drawables) throw Error('Unavailable drawable');
        return { drawables, textures: natives.call('GET_NUMBER_OF_PED_TEXTURE_VARIATIONS', p, slot, drawable) };
      },
      *emote(a) {
        if (a.id === 'stop') { emoteVersion++; natives.call('CLEAR_PED_TASKS', ped()); return true; }
        if (typeof a.id !== 'string' || !Object.hasOwn(EMOTES, a.id)) throw Error('Unknown emote');
        const version = ++emoteVersion;
        const emote = EMOTES[a.id], until = now() + 8000;
        if (emote.scenario) {
          requireNatives('CLEAR_PED_TASKS', 'TASK_START_SCENARIO_IN_PLACE');
          natives.call('CLEAR_PED_TASKS', ped());
          natives.call('TASK_START_SCENARIO_IN_PLACE', ped(), emote.scenario, 0, 1);
        } else {
          requireNatives('REQUEST_ANIM_DICT', 'HAS_ANIM_DICT_LOADED', 'TASK_PLAY_ANIM', 'REMOVE_ANIM_DICT', 'CLEAR_PED_TASKS');
          natives.call('REQUEST_ANIM_DICT', emote.dict);
          try {
            while (!natives.call('HAS_ANIM_DICT_LOADED', emote.dict)) {
              if (version !== emoteVersion) throw Error('Emote superseded');
              if (now() >= until) throw Error('Animation load timeout');
              yield;
            }
            if (version !== emoteVersion) throw Error('Emote superseded');
            if (now() >= until) throw Error('Animation load timeout');
            natives.call('CLEAR_PED_TASKS', ped());
            natives.call('TASK_PLAY_ANIM', ped(), emote.dict, emote.anim, 8, -8, -1, emote.flags, 0, 0, 0, 0);
          } finally { natives.call('REMOVE_ANIM_DICT', emote.dict); }
        }
        return true;
      },
      *vehicleControl(a) {
        if (!['engine', 'door', 'window', 'repair'].includes(a.action)) throw Error('Unknown vehicle action');
        if (a.value !== undefined && typeof a.value !== 'boolean') throw Error('Boolean value required');
        if (a.index !== undefined) integer(a.index, 0, 5);
        // Omitted value means on/open/down; omitted index selects the first door/window.
        const value = a.value ?? true, index = a.index ?? 0;
        const v = driverVehicle();
        switch (a.action) {
          case 'engine': natives.call('SET_VEHICLE_ENGINE_ON', v, value ? 1 : 0, 1, 0); break;
          case 'door':
            if (value) natives.call('SET_VEHICLE_DOOR_OPEN', v, index, 0, 0);
            else natives.call('SET_VEHICLE_DOOR_SHUT', v, index, 0);
            break;
          case 'window':
            if (value) natives.call('ROLL_DOWN_WINDOW', v, index);
            else natives.call('ROLL_UP_WINDOW', v, index);
            break;
          case 'repair': natives.call('SET_VEHICLE_FIXED', v); break;
        }
        return true;
      },
      *vehicleStyle(a) {
        const primary = integer(a.primary, 0, 159), secondary = integer(a.secondary, 0, 159), tint = integer(a.tint, -1, 6);
        const mods = entries(a.mods ?? [], 50).map((m) => ({ slot: integer(m.slot, 0, 49), index: integer(m.index, -1, 99) }));
        requireNatives('SET_VEHICLE_MOD_KIT', 'GET_NUM_VEHICLE_MODS', 'SET_VEHICLE_MOD', 'SET_VEHICLE_COLOURS', 'SET_VEHICLE_WINDOW_TINT');
        const v = driverVehicle();
        natives.call('SET_VEHICLE_MOD_KIT', v, 0);
        for (const m of mods) if (m.index !== -1 && m.index >= natives.call('GET_NUM_VEHICLE_MODS', v, m.slot)) throw Error('Unavailable vehicle mod');
        natives.call('SET_VEHICLE_COLOURS', v, primary, secondary);
        natives.call('SET_VEHICLE_WINDOW_TINT', v, tint);
        for (const m of mods) natives.call('SET_VEHICLE_MOD', v, m.slot, m.index, 0);
        return true;
      },
      *weather(a) {
        const type = String(a.type || '').toUpperCase();
        if (!WEATHERS.includes(type)) throw Error('Unknown weather');
        natives.call('SET_WEATHER_TYPE_NOW_PERSIST', type);
        return type;
      },
      *time(a) {
        const h = num(a.hour, 0, 23) | 0, m = num(a.minute ?? 0, 0, 59) | 0;
        if (has('NETWORK_OVERRIDE_CLOCK_TIME')) natives.call('NETWORK_OVERRIDE_CLOCK_TIME', h, m, 0);
        natives.call('SET_CLOCK_TIME', h, m, 0);
        return [h, m];
      },
      *teleport(a) {
        const x = num(a.x, -20000, 20000), y = num(a.y, -20000, 20000), z = num(a.z, -500, 3000);
        const p = ped();
        const target = natives.call('IS_PED_IN_ANY_VEHICLE', p, 0) ? natives.call('GET_VEHICLE_PED_IS_IN', p, 0) : p;
        natives.call('SET_ENTITY_COORDS', target, x, y, z, 0, 0, 0, 0);
        if (a.heading !== undefined) natives.call('SET_ENTITY_HEADING', target, num(a.heading, 0, 360));
        return true;
      },
      *heal() {
        const p = ped();
        natives.call('SET_ENTITY_HEALTH', p, natives.call('GET_ENTITY_MAX_HEALTH', p), 0);
        return true;
      },
      *armour(a) { natives.call('SET_PED_ARMOUR', ped(), num(a.value, 0, 100) | 0); return true; },
      *spawnVehicle(a) {
        const model = String(a.model || '');
        if (!/^[a-z0-9_]{1,32}$/.test(model)) throw Error('Invalid model');
        const plate = a.plate === undefined ? '' : String(a.plate).toUpperCase();
        if (plate && !/^[A-Z0-9 ]{1,8}$/.test(plate)) throw Error('Invalid plate');
        const hash = natives.call('GET_HASH_KEY', model);
        if (!natives.call('IS_MODEL_IN_CDIMAGE', hash)) throw Error('Model not in game files');
        natives.call('REQUEST_MODEL', hash);
        const until = now() + 10000;
        while (!natives.call('HAS_MODEL_LOADED', hash)) {
          if (now() > until) throw Error('Model load timeout');
          yield;
          natives.call('REQUEST_MODEL', hash);
        }
        const p = ped();
        const [x, y, z] = natives.call('GET_ENTITY_COORDS', p, 1);
        const h = natives.call('GET_ENTITY_HEADING', p);
        const veh = natives.call('CREATE_VEHICLE', hash, x, y, z + 0.5, h, 0, 0, 0);
        natives.call('SET_MODEL_AS_NO_LONGER_NEEDED', hash);
        if (!veh) throw Error('Vehicle not created');
        if (plate) natives.call('SET_VEHICLE_NUMBER_PLATE_TEXT', veh, plate);
        if (has('SET_VEHICLE_ON_GROUND_PROPERLY')) natives.call('SET_VEHICLE_ON_GROUND_PROPERLY', veh, 5);
        if (a.enter !== false) natives.call('SET_PED_INTO_VEHICLE', p, veh, -1);
        return veh;
      },
      *deleteVehicle(a) {
        const veh = num(a.vehicle, 1, 2147483647) | 0;
        if (!natives.call('DOES_ENTITY_EXIST', veh)) return true;
        if (!has('IS_ENTITY_A_VEHICLE') || !natives.call('IS_ENTITY_A_VEHICLE', veh)) throw Error('Not a vehicle');
        if (a.plate !== undefined) {
          if (typeof a.plate !== 'string' || !/^[A-Z0-9 ]{1,8}$/.test(a.plate)) throw Error('Invalid plate');
          if (!has('GET_VEHICLE_NUMBER_PLATE_TEXT') || natives.call('GET_VEHICLE_NUMBER_PLATE_TEXT', veh).trim() !== a.plate.trim()) throw Error('Vehicle plate mismatch');
        }
        natives.call('SET_ENTITY_AS_MISSION_ENTITY', veh, 1, 1);
        natives.call('DELETE_VEHICLE', veh);
        return true;
      },
    };
    function enqueue(batch) {
      for (const c of batch.slice(0, 32)) {
        const id = c && Number.isSafeInteger(c.id) ? c.id : 0;
        const fn = c && typeof c.cmd === 'string' && Object.hasOwn(COMMANDS, c.cmd) ? COMMANDS[c.cmd] : null;
        if (!fn) { reply(id, false, null, 'Unknown command'); continue; }
        if (tasks.length >= 64) { reply(id, false, null, 'Busy'); continue; }
        tasks.push({ id, gen: fn(c.args && typeof c.args === 'object' ? c.args : {}) });
      }
    }
    function runTasks() {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        let done = false;
        try {
          const r = task.gen.next();
          if (r.done) { reply(task.id, true, r.value); done = true; }
        } catch (error) { reply(task.id, false, null, error); done = true; }
        if (done) { tasks.splice(i, 1); i--; }
      }
    }
    function readEngineState() {
      const p = ped();
      if (!p) return;
      const inVehicle = natives.call('IS_PED_IN_ANY_VEHICLE', p, 0) ? 1 : 0;
      const veh = inVehicle ? natives.call('GET_VEHICLE_PED_IS_IN', p, 0) : 0;
      const [x, y, z] = natives.call('GET_ENTITY_COORDS', p, 1);
      writeState(shared, {
        ped: p, x, y, z, heading: natives.call('GET_ENTITY_HEADING', p),
        health: natives.call('GET_ENTITY_HEALTH', p), maxHealth: natives.call('GET_ENTITY_MAX_HEALTH', p),
        armour: natives.call('GET_PED_ARMOUR', p), inVehicle, vehicle: veh,
        speed: natives.call('GET_ENTITY_SPEED', veh || p), engineOn: veh && natives.call('GET_IS_VEHICLE_ENGINE_RUNNING', veh) ? 1 : 0,
        dead: natives.call('IS_PED_DEAD_OR_DYING', p, 1) ? 1 : 0, model: natives.call('GET_ENTITY_MODEL', p), timer: has('GET_GAME_TIMER') ? natives.call('GET_GAME_TIMER') : 0,
      });
    }

    function tick() {
      if (failed) return;
      ticks++;
      const t = now();
      if (full && Number(e.__menyoo_mailbox.value)) {
        try {
          const batch = takeCommands(shared);
          if (batch) enqueue(batch);
          if (tasks.length) runTasks();
          if (t - lastState >= 100) { lastState = t; readEngineState(); }
        } catch (error) {
          log.error('[FiveWeb natives] command/state', error);
        }
      }
      if (t - lastRun < RECONCILE_MS) return;
      lastRun = t;
      try {
        if (shared) {
          const snap = readShared(shared);
          if (snap && snap.seq !== lastSeq) {
            lastSeq = snap.seq;
            onMessage({ type: 'players', players: snap.players });
            if (snap.cash !== null) onMessage({ type: 'cash', cash: snap.cash });
          }
        }
        if (reconcile()) status('running');
      } catch (error) {
        failed = true;
        e.__menyoo_callback_index.value = 0n;
        status('error', { error: String(error && error.message || error).slice(0, 200) });
        log.error('[FiveWeb natives]', error);
      }
    }

    function onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'players' && Array.isArray(msg.players)) {
        players = msg.players.slice(0, MAX_BLIPS).filter((p) => p && typeof p.id === 'string' && [p.x, p.y, p.z].every(Number.isFinite))
          .map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, heading: Number(p.heading) }));
      } else if (msg.type === 'cash' && Number.isSafeInteger(msg.cash) && msg.cash >= 0) {
        cash = Math.min(msg.cash, 2147483647);
      } else if (msg.type === 'hello') {
        reported = '';
        status(failed ? 'error' : ticks ? 'running' : 'ready');
      }
    }

    return { tick, onMessage, natives, enqueue, state: () => ({ failed, ticks, blips: blips.size, players: players.length, zeroHandles, canCash, tasks: tasks.length, full }) };
  }

  async function install(engine, base = '', { descriptors = null, channelName = 'fiveweb-natives', channel: given, shared = null } = {}) {
    const e = engine.exports;
    if (!e || !e.__menyoo_callback_index) throw Error('Engine build has no FiveWeb native support');
    if (!descriptors) descriptors = await (await fetch(base + '/menyoo-native-descriptors.json', { cache: 'no-store' })).json();
    const channel = given !== undefined ? given : typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    const runtime = createRuntime(engine, descriptors, { channel, shared: typeof SharedArrayBuffer === 'function' && shared instanceof SharedArrayBuffer && shared.byteLength >= SHARED.bytes ? shared : null });
    if (channel) channel.postMessage({ type: 'status', state: 'ready', blips: 0, ticks: 0, commands: runtime.state().full });
    const table = e.__indirect_function_table;
    // Same reserved slot Menyoo uses: the last entry of the engine's table64.
    const slot = BigInt(table.length) - 1n;
    if (table.get(slot) !== null) throw Error('Engine callback slot is in use');
    const { instance } = await WebAssembly.instantiate(TICK_WASM, { env: { tick: runtime.tick } });
    table.set(slot, instance.exports.tick);
    e.__menyoo_callback_index.value = slot;
    if (channel && 'onmessage' in channel) channel.onmessage = (ev) => runtime.onMessage(ev.data);
    console.log('[FiveWeb natives] installed in engine script callback');
    root.__fiveWebNativeRuntime = runtime;
    return runtime;
  }

  const api = { install, createRuntime, createCaller, writeShared, readShared, writeCommands, takeCommands, writeState, readState, SHARED, LAYOUT, WEATHERS, TICK_WASM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FiveWebNatives = api;
})(typeof self !== 'undefined' ? self : globalThis);
