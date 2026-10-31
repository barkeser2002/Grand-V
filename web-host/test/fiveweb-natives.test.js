// FiveWeb engine natives (public/fiveweb-natives.js) against a fake Menyoo engine build that
// decodes the real ScriptHook context layout, plus the served loader.js / game.html patches.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformLoader, NATIVES_SRC } from '../src/loader-page.js';
import { transformGamePage } from '../src/game-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(HERE, '..', 'public', 'fiveweb-natives.js'), 'utf8'));
const Natives = globalThis.FiveWebNatives;
const MIRROR = process.env.GRANDV_ASSET_ROOT || '/var/www/grandv/mirror/playgta5.com';
const LOADER = path.join(MIRROR, 'b', '8b0b5899ed', 'loader.js');
const DESCRIPTORS_FILE = path.join(MIRROR, 'b', '8b0b5899ed', 'menyoo-native-descriptors.json');

const SPEC = {
  ADD_BLIP_FOR_COORD: [['float', 'float', 'float'], 'Blip'],
  SET_BLIP_COORDS: [['Blip', 'float', 'float', 'float'], 'void'],
  REMOVE_BLIP: [['Blip*'], 'void'],
  DOES_BLIP_EXIST: [['Blip'], 'BOOL'],
  SET_BLIP_SPRITE: [['Blip', 'int'], 'void'],
  SET_BLIP_COLOUR: [['Blip', 'int'], 'void'],
  SET_BLIP_SCALE: [['Blip', 'float'], 'void'],
  SET_BLIP_ROTATION: [['Blip', 'int'], 'void'],
  SET_BLIP_DISPLAY: [['Blip', 'int'], 'void'],
  SET_BLIP_AS_SHORT_RANGE: [['Blip', 'BOOL'], 'void'],
  STAT_SET_INT: [['Hash', 'int', 'BOOL'], 'BOOL'],
  GET_HASH_KEY: [['const char*'], 'Hash'],
  // Faz 0 command and state natives
  PLAYER_PED_ID: [[], 'Ped'],
  GET_ENTITY_COORDS: [['Entity', 'BOOL'], 'Vector3'],
  GET_ENTITY_HEADING: [['Entity'], 'float'],
  GET_ENTITY_HEALTH: [['Entity'], 'int'],
  GET_ENTITY_MAX_HEALTH: [['Entity'], 'int'],
  GET_PED_ARMOUR: [['Ped'], 'int'],
  IS_PED_IN_ANY_VEHICLE: [['Ped', 'BOOL'], 'BOOL'],
  GET_VEHICLE_PED_IS_IN: [['Ped', 'BOOL'], 'Vehicle'],
  GET_ENTITY_SPEED: [['Entity'], 'float'],
  GET_IS_VEHICLE_ENGINE_RUNNING: [['Vehicle'], 'BOOL'],
  IS_PED_DEAD_OR_DYING: [['Ped', 'BOOL'], 'BOOL'],
  GET_ENTITY_MODEL: [['Entity'], 'Hash'],
  GET_GAME_TIMER: [[], 'int'],
  SET_WEATHER_TYPE_NOW_PERSIST: [['const char*'], 'void'],
  SET_CLOCK_TIME: [['int', 'int', 'int'], 'void'],
  NETWORK_OVERRIDE_CLOCK_TIME: [['int', 'int', 'int'], 'void'],
  SET_ENTITY_COORDS: [['Entity', 'float', 'float', 'float', 'BOOL', 'BOOL', 'BOOL', 'BOOL'], 'void'],
  SET_ENTITY_HEADING: [['Entity', 'float'], 'void'],
  SET_ENTITY_HEALTH: [['Entity', 'int', 'int'], 'void'],
  SET_PED_ARMOUR: [['Ped', 'int'], 'void'],
  IS_MODEL_IN_CDIMAGE: [['Hash'], 'BOOL'],
  REQUEST_MODEL: [['Hash'], 'void'],
  HAS_MODEL_LOADED: [['Hash'], 'BOOL'],
  CREATE_VEHICLE: [['Hash', 'float', 'float', 'float', 'float', 'BOOL', 'BOOL', 'BOOL'], 'Vehicle'],
  SET_MODEL_AS_NO_LONGER_NEEDED: [['Hash'], 'void'],
  SET_VEHICLE_NUMBER_PLATE_TEXT: [['Vehicle', 'const char*'], 'void'],
  SET_VEHICLE_ON_GROUND_PROPERLY: [['Vehicle', 'float'], 'BOOL'],
  SET_PED_INTO_VEHICLE: [['Ped', 'Vehicle', 'int'], 'void'],
  DOES_ENTITY_EXIST: [['Entity'], 'BOOL'],
  SET_ENTITY_AS_MISSION_ENTITY: [['Entity', 'BOOL', 'BOOL'], 'void'],
  DELETE_VEHICLE: [['Vehicle*'], 'void'],
};

function fakeEngine({ mailbox = 4096, failOn = null } = {}) {
  let f;
  const memory = new WebAssembly.Memory({ initial: 4 });
  const calls = [];
  const live = new Set();
  let nextHandle = 100;
  const descriptors = {};
  const exportsObj = {
    __menyoo_memory: memory,
    __menyoo_mailbox: { value: BigInt(mailbox) },
    __menyoo_callback_index: { value: 0n },
    __indirect_function_table: (() => {
      const slots = new Array(16).fill(null);
      return { length: slots.length, get: (i) => slots[Number(i)], set: (i, f) => { slots[Number(i)] = f; }, slots };
    })(),
  };
  let n = 0;
  for (const [name, [params, result]] of Object.entries(SPEC)) {
    const hash = (0x1000 + n++).toString(16).padStart(16, '0');
    const exp = '__menyoo_native_' + hash;
    descriptors[hash] = { name, params, result, export: exp, wrapperName: name };
    exportsObj[exp] = (ctxBig) => {
      const v = new DataView(memory.buffer);
      const ctx = Number(ctxBig);
      const resultAt = Number(v.getBigUint64(ctx, true));
      const argc = v.getInt32(ctx + 8, true);
      const paramsAt = Number(v.getBigUint64(ctx + 16, true));
      assert.equal(argc, params.length, name + ' argc');
      const args = params.map((type, i) => {
        const at = paramsAt + 8 * i;
        if (type === 'float') return Math.round(v.getFloat32(at, true) * 100) / 100;
        if (type === 'const char*') {
          const p = Number(v.getBigUint64(at, true));
          const bytes = new Uint8Array(memory.buffer, p, 64);
          return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
        }
        if (type.endsWith('*')) return { ptr: v.getInt32(Number(v.getBigUint64(at, true)), true) };
        return v.getInt32(at, true);
      });
      calls.push([name, ...args]);
      if (failOn === name) throw Error('engine trap');
      let out = 0;
      if (name === 'ADD_BLIP_FOR_COORD') { out = nextHandle++; live.add(out); }
      if (name === 'DOES_BLIP_EXIST') out = live.has(args[0]) ? 1 : 0;
      if (name === 'REMOVE_BLIP') live.delete(args[0].ptr);
      if (name === 'GET_HASH_KEY') out = args[0].length * 1000 + args[0].charCodeAt(2);
      if (name === 'STAT_SET_INT') out = 1;
      if (name === 'PLAYER_PED_ID') out = 7;
      if (name === 'GET_ENTITY_HEALTH') out = 150;
      if (name === 'GET_ENTITY_MAX_HEALTH') out = 200;
      if (name === 'GET_PED_ARMOUR') out = 25;
      if (name === 'GET_GAME_TIMER') out = 4242;
      if (name === 'IS_MODEL_IN_CDIMAGE') out = args[0] === 404 ? 0 : 1;
      if (name === 'HAS_MODEL_LOADED') out = (f.loadAfter = (f.loadAfter || 0) - 1) <= 0 ? 1 : 0;
      if (name === 'CREATE_VEHICLE') { out = 900; live.add(900); }
      if (name === 'DOES_ENTITY_EXIST') out = live.has(args[0]) ? 1 : 0;
      if (name === 'DELETE_VEHICLE') live.delete(args[0].ptr);
      if (name === 'GET_ENTITY_COORDS') { v.setFloat32(resultAt, 10.5, true); v.setFloat32(resultAt + 8, -20, true); v.setFloat32(resultAt + 16, 30, true); return; }
      if (name === 'GET_ENTITY_HEADING') { v.setFloat32(resultAt, 90, true); return; }
      if (name === 'GET_ENTITY_SPEED') { v.setFloat32(resultAt, 0, true); return; }
      v.setInt32(resultAt, out, true);
    };
  }
  f = { engine: { exports: exportsObj }, calls, live, descriptors };
  return f;
}

function channelPair() {
  const sent = [];
  return { sent, channel: { postMessage: (m) => sent.push(m) } };
}

describe('FiveWeb natives runtime (engine worker)', () => {
  test('installs a wasm tick into the reserved last table slot and arms the engine callback', async () => {
    const f = fakeEngine();
    const rt = await Natives.install(f.engine, '', { descriptors: f.descriptors, channel: null });
    const table = f.engine.exports.__indirect_function_table;
    assert.equal(f.engine.exports.__menyoo_callback_index.value, 15n);
    assert.equal(typeof table.slots[15], 'function');
    assert.equal(typeof rt.tick, 'function');
    await assert.rejects(Natives.install(f.engine, '', { descriptors: f.descriptors, channel: null }), /slot is in use/);
  });

  test('players become engine blips; moves update coords; leavers are removed', () => {
    const f = fakeEngine();
    let now = 0;
    const { sent, channel } = channelPair();
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel, now: () => now });
    rt.onMessage({ type: 'players', players: [{ id: 'a', x: 100.5, y: -200.25, z: 30, heading: 90 }, { id: 'b', x: 1, y: 2, z: 3 }] });
    now = 1000; rt.tick();
    const adds = f.calls.filter((c) => c[0] === 'ADD_BLIP_FOR_COORD');
    assert.deepEqual(adds, [['ADD_BLIP_FOR_COORD', 100.5, -200.25, 30], ['ADD_BLIP_FOR_COORD', 1, 2, 3]]);
    assert.ok(f.calls.some((c) => c[0] === 'SET_BLIP_SPRITE' && c[1] === 100 && c[2] === 1));
    assert.ok(f.calls.some((c) => c[0] === 'SET_BLIP_DISPLAY' && c[2] === 6));
    assert.ok(f.calls.some((c) => c[0] === 'SET_BLIP_ROTATION' && c[1] === 100 && c[2] === 90));
    assert.equal(sent.at(-1).state, 'running');
    assert.equal(sent.at(-1).blips, 2);

    f.calls.length = 0;
    rt.onMessage({ type: 'players', players: [{ id: 'a', x: 110, y: -190, z: 31 }] });
    now = 1100; rt.tick();
    assert.equal(f.calls.length, 0, 'throttled to 4 Hz');
    now = 1300; rt.tick();
    assert.deepEqual(f.calls.find((c) => c[0] === 'SET_BLIP_COORDS'), ['SET_BLIP_COORDS', 100, 110, -190, 31]);
    assert.deepEqual(f.calls.find((c) => c[0] === 'REMOVE_BLIP'), ['REMOVE_BLIP', { ptr: 101 }]);
    assert.deepEqual([...f.live], [100]);
    assert.equal(rt.state().blips, 1);
  });

  test('cash goes to the three story-character cash stats once per change', () => {
    const f = fakeEngine();
    let now = 0;
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel: null, now: () => now });
    rt.onMessage({ type: 'cash', cash: 4200 });
    now = 1000; rt.tick();
    const stats = f.calls.filter((c) => c[0] === 'GET_HASH_KEY').map((c) => c[1]);
    assert.deepEqual(stats, ['SP0_TOTAL_CASH', 'SP1_TOTAL_CASH', 'SP2_TOTAL_CASH']);
    assert.equal(f.calls.filter((c) => c[0] === 'STAT_SET_INT' && c[2] === 4200 && c[3] === 1).length, 3);
    f.calls.length = 0;
    now = 2000; rt.tick();
    assert.equal(f.calls.filter((c) => c[0] === 'STAT_SET_INT').length, 0);
    rt.onMessage({ type: 'cash', cash: -5 });
    rt.onMessage({ type: 'cash', cash: 1.5 });
    now = 3000; rt.tick();
    assert.equal(f.calls.length, 0, 'invalid amounts ignored');
  });

  test('nothing is called before the engine allocates its mailbox', () => {
    const f = fakeEngine({ mailbox: 0 });
    let now = 0;
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel: null, now: () => now });
    rt.onMessage({ type: 'players', players: [{ id: 'a', x: 1, y: 2, z: 3 }] });
    now = 1000; rt.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(rt.state().failed, false);
  });

  test('a native failure disables the runtime, clears the callback and reports the error', () => {
    const f = fakeEngine({ failOn: 'ADD_BLIP_FOR_COORD' });
    f.engine.exports.__menyoo_callback_index.value = 15n;
    let now = 0;
    const { sent, channel } = channelPair();
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel, now: () => now, log: { error() {} } });
    rt.onMessage({ type: 'players', players: [{ id: 'a', x: 1, y: 2, z: 3 }] });
    now = 1000; rt.tick();
    assert.equal(f.engine.exports.__menyoo_callback_index.value, 0n);
    assert.deepEqual([sent.at(-1).state, sent.at(-1).error], ['error', 'engine trap']);
    f.calls.length = 0;
    now = 2000; rt.tick();
    assert.equal(f.calls.length, 0);
  });

  test('the engine worker reads players and cash from the shared buffer (seqlock)', () => {
    const f = fakeEngine();
    let now = 0;
    const sab = new SharedArrayBuffer(Natives.SHARED.bytes);
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel: null, shared: sab, now: () => now });
    Natives.writeShared(sab, [{ key: 0x1234abcd, x: 10.5, y: -20, z: 3 }], 777);
    now = 1000; rt.tick();
    assert.deepEqual(f.calls.find((c) => c[0] === 'ADD_BLIP_FOR_COORD'), ['ADD_BLIP_FOR_COORD', 10.5, -20, 3]);
    assert.equal(f.calls.filter((c) => c[0] === 'STAT_SET_INT' && c[2] === 777).length, 3);
    // A half-written buffer (odd sequence) is ignored.
    Atomics.store(new Int32Array(sab), 0, 7);
    assert.equal(Natives.readShared(sab), null);
    Atomics.store(new Int32Array(sab), 0, 8);
    Natives.writeShared(sab, [], -1);
    now = 2000; rt.tick();
    assert.ok(f.calls.some((c) => c[0] === 'REMOVE_BLIP'));
    assert.equal(rt.state().blips, 0);
  });

  test('bad player messages are filtered; a build without natives is refused', () => {
    const f = fakeEngine();
    let now = 0;
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel: null, now: () => now });
    rt.onMessage({ type: 'players', players: [{ id: 'a', x: 'x', y: 2, z: 3 }, { id: 5, x: 1, y: 2, z: 3 }, null, { id: 'ok', x: 1, y: 2, z: 3 }] });
    assert.equal(rt.state().players, 1);
    assert.throws(() => Natives.createRuntime({ exports: {} }, f.descriptors, {}), /no FiveWeb native support/);
  });

  test('the real descriptor file has every native the runtime needs', { skip: !fs.existsSync(DESCRIPTORS_FILE) && 'mirror missing' }, () => {
    const d = JSON.parse(fs.readFileSync(DESCRIPTORS_FILE, 'utf8'));
    const names = new Map(Object.values(d).map((x) => [x.name, x]));
    for (const [name, [params, result]] of Object.entries(SPEC)) {
      assert.ok(names.has(name), name);
      assert.deepEqual(names.get(name).params, params, name);
      assert.equal(names.get(name).result, result, name);
    }
  });

  test('the tick module is valid wasm exporting tick () -> ()', async () => {
    let called = 0;
    const { instance } = await WebAssembly.instantiate(Natives.TICK_WASM, { env: { tick: () => { called++; } } });
    instance.exports.tick();
    assert.equal(called, 1);
  });
});

describe('served loader.js and game.html patches', () => {
  test('the real loader selects the Menyoo engine and installs FiveWeb natives for multiplayer only', { skip: !fs.existsSync(LOADER) && 'mirror missing' }, () => {
    const { body, patched } = transformLoader(fs.readFileSync(LOADER));
    assert.equal(patched, true);
    const text = body.toString('latin1');
    assert.ok(text.includes("if(m.fivewebNatives===true&&engineWasm==='/game.wasm')engineWasm='/game.menyoo-mainline.wasm';"));
    assert.ok(text.includes(`importScripts('${NATIVES_SRC}');await FiveWebNatives.install(r.instance,B,{shared:m.fivewebShared});`));
    assert.ok(text.includes('m.fivewebNatives===true&&!trainer'), 'Menyoo trainer keeps its own callback');
  });

  test('an unknown loader is served unchanged', () => {
    const original = Buffer.from('console.log(1)');
    const r = transformLoader(original);
    assert.equal(r.patched, false);
    assert.equal(r.body, original);
  });

  test('game.html sets fivewebNatives only for multiplayer sandbox launches', { skip: !fs.existsSync(path.join(MIRROR, 'game.html')) && 'mirror missing' }, () => {
    const { body, patched } = transformGamePage(fs.readFileSync(path.join(MIRROR, 'game.html')));
    assert.equal(patched, true);
    const text = body.toString('latin1');
    assert.ok(text.includes("fivewebNatives: q.get('multiplayer')==='1'&&q.get('poseproof')==='3'&&q.get('mode')==='sandbox',"));
    assert.ok(text.includes('(window.__fiveWebShared=new SharedArrayBuffer(20816))'));
  });
});


describe('FiveWeb engine commands and state (Faz 0)', () => {
  const L = Natives.LAYOUT;
  function setup() {
    const f = fakeEngine();
    const sab = new SharedArrayBuffer(L.total);
    let now = 0;
    const { sent, channel } = channelPair();
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel, shared: sab, now: () => now });
    return { f, sab, sent, rt, step: (ms = 50) => { now += ms; rt.tick(); } };
  }
  const results = (sent) => sent.filter((m) => m.type === 'result');

  test('the mailbox carries one batch at a time and refuses a second until consumed', () => {
    const sab = new SharedArrayBuffer(L.total);
    assert.equal(Natives.writeCommands(sab, [{ id: 1, cmd: 'heal' }]), true);
    assert.equal(Natives.writeCommands(sab, [{ id: 2, cmd: 'heal' }]), false);
    assert.deepEqual(Natives.takeCommands(sab), [{ id: 1, cmd: 'heal' }]);
    assert.equal(Natives.takeCommands(sab), null);
    assert.equal(Natives.writeCommands(sab, [{ id: 2, cmd: 'heal' }]), true);
    assert.throws(() => Natives.writeCommands(new SharedArrayBuffer(L.total), [{ s: 'x'.repeat(L.cmdBytes) }]), /too large/);
  });

  test('weather, time, heal, armour and teleport run with validated arguments', () => {
    const h = setup();
    Natives.writeCommands(h.sab, [
      { id: 1, cmd: 'weather', args: { type: 'rain' } },
      { id: 2, cmd: 'time', args: { hour: 21, minute: 30 } },
      { id: 3, cmd: 'heal' },
      { id: 4, cmd: 'armour', args: { value: 100 } },
      { id: 5, cmd: 'teleport', args: { x: -1336, y: -3044, z: 14, heading: 180 } },
      { id: 6, cmd: 'weather', args: { type: 'NUKE' } },
      { id: 7, cmd: 'time', args: { hour: 25 } },
      { id: 8, cmd: 'eval', args: {} },
    ]);
    h.step();
    const r = Object.fromEntries(results(h.sent).map((m) => [m.id, m]));
    assert.equal(r[1].value, 'RAIN');
    assert.deepEqual(r[2].value, [21, 30]);
    assert.ok(r[3].ok && r[4].ok && r[5].ok);
    assert.equal(r[6].ok, false); assert.match(r[6].error, /Unknown weather/);
    assert.equal(r[7].ok, false); assert.match(r[7].error, /Invalid number/);
    assert.equal(r[8].ok, false); assert.match(r[8].error, /Unknown command/);
    const c = h.f.calls;
    assert.ok(c.some((x) => x[0] === 'SET_WEATHER_TYPE_NOW_PERSIST' && x[1] === 'RAIN'));
    assert.ok(c.some((x) => x[0] === 'SET_CLOCK_TIME' && x[1] === 21 && x[2] === 30));
    assert.ok(c.some((x) => x[0] === 'SET_ENTITY_HEALTH' && x[1] === 7 && x[2] === 200));
    assert.ok(c.some((x) => x[0] === 'SET_PED_ARMOUR' && x[2] === 100));
    assert.ok(c.some((x) => x[0] === 'SET_ENTITY_COORDS' && x[1] === 7 && x[2] === -1336 && x[3] === -3044));
    assert.ok(c.some((x) => x[0] === 'SET_ENTITY_HEADING' && x[2] === 180));
  });

  test('spawnVehicle waits for the model over several ticks, sets the plate and seats the player', () => {
    const h = setup();
    h.f.loadAfter = 3;
    Natives.writeCommands(h.sab, [{ id: 9, cmd: 'spawnVehicle', args: { model: 'blista', plate: 'fw12ab' } }]);
    h.step();
    assert.equal(results(h.sent).length, 0, 'still loading');
    h.step(); h.step(); h.step();
    const r = results(h.sent).find((m) => m.id === 9);
    assert.equal(r.ok, true); assert.equal(r.value, 900);
    const c = h.f.calls;
    const create = c.find((x) => x[0] === 'CREATE_VEHICLE');
    assert.deepEqual(create.slice(2, 6), [10.5, -20, 30.5, 90]);
    assert.ok(c.some((x) => x[0] === 'SET_VEHICLE_NUMBER_PLATE_TEXT' && x[1] === 900 && x[2] === 'FW12AB'));
    assert.ok(c.some((x) => x[0] === 'SET_PED_INTO_VEHICLE' && x[1] === 7 && x[2] === 900 && x[3] === -1));
    Natives.writeCommands(h.sab, [{ id: 10, cmd: 'deleteVehicle', args: { vehicle: 900 } }, { id: 11, cmd: 'spawnVehicle', args: { model: '../x' } }, { id: 12, cmd: 'spawnVehicle', args: { model: 'ok', plate: '<b>' } }]);
    h.step();
    const r2 = Object.fromEntries(results(h.sent).map((m) => [m.id, m]));
    assert.equal(r2[10].value, true);
    assert.ok(!h.f.live.has(900));
    assert.match(r2[11].error, /Invalid model/);
    assert.match(r2[12].error, /Invalid plate/);
  });

  test('engine state is published to the shared buffer about every 100 ms', () => {
    const h = setup();
    assert.equal(Natives.readState(h.sab), null);
    h.step(150);
    const st = Natives.readState(h.sab);
    assert.equal(st.ped, 7);
    assert.equal(st.x, 10.5); assert.equal(st.y, -20); assert.equal(st.z, 30);
    assert.equal(st.heading, 90);
    assert.equal(st.health, 150); assert.equal(st.maxHealth, 200); assert.equal(st.armour, 25);
    assert.equal(st.inVehicle, 0); assert.equal(st.timer, 4242);
    assert.equal(h.rt.state().full, true);
  });

  test('a small (old) shared buffer keeps blips working and disables commands', () => {
    const f = fakeEngine();
    const rt = Natives.createRuntime(f.engine, f.descriptors, { channel: null, shared: new SharedArrayBuffer(Natives.SHARED.bytes), now: () => 1000 });
    rt.tick();
    assert.equal(rt.state().full, false);
    assert.ok(!f.calls.some((x) => x[0] === 'PLAYER_PED_ID'));
  });
});
