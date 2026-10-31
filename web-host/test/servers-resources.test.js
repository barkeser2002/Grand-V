// /api/servers over real HTTP and WebSocket, the resource file route, and resource lifecycle
// against the real shipped example (resources/welcome).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VOICE_PRESENT = existsSync(fileURLToPath(new URL('../public/voice.js', import.meta.url)));
import { startApp, api, rawRequest, connectRelay, sleep, BUILD } from './helpers.js';
import { loadResource, parseManifest, ResourceRuntime, ResourceError, RESOURCES_DIR } from '../src/resources.js';
import { transformGamePage, RESOURCE_CLIENT_SRC, VOICE_SRC } from '../src/game-page.js';

const SERVER = '/api/servers/fiveweb-freeroam';
const hdr = (origin) => ({ Origin: origin });
const join = (origin, nickname, id = 'fiveweb-freeroam') =>
  api(origin, 'POST', `/api/servers/${id}/join`, { json: { nickname }, headers: hdr(origin) });
const find = (list, id) => list.servers.find((s) => s.id === id);

describe('servers API: list and join over HTTP', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('GET /api/servers lists the persistent default server with no room (nothing fake)', async () => {
    const res = await api(h.origin, 'GET', '/api/servers');
    assert.equal(res.status, 200);
    const s = find(res.data, 'fiveweb-freeroam');
    assert.ok(s);
    assert.equal(s.name, 'FiveWeb Freeroam');
    assert.deepEqual(s.tags, ['Freeroam', 'Deneysel']);
    assert.equal(s.connected, 0);
    assert.equal(s.reserved, 0);
    assert.equal(s.status, 'online');
    assert.equal(s.capacity, 128);
    assert.equal(s.voice, true);
    assert.equal(s.compatibility, 'fiveweb-js-v1');
    assert.deepEqual(s.resources, [{ name: 'welcome', version: '0.1.0' }]);
  });

  test('joins share one 128-seat room; the handoff matches the existing lobby shape', async () => {
    const first = await join(h.origin, 'Ali');
    assert.equal(first.status, 200);
    assert.equal(first.data.session.role, 'host');
    assert.match(first.data.launchPath, /^\/launcher\.html\?lobby=[A-Za-z0-9_-]{16}&server=fiveweb-freeroam$/);
    assert.equal(first.data.lobby.name, 'FiveWeb Freeroam');
    assert.ok(first.data.session.credential && first.data.session.expiresAt);
    const second = await join(h.origin, 'Veli');
    assert.equal(second.status, 200);
    assert.equal(second.data.session.role, 'guest');
    assert.equal(second.data.lobby.id, first.data.lobby.id);
    const third = await join(h.origin, 'Ece');
    assert.equal(third.status, 200);
    assert.equal(third.data.lobby.id, first.data.lobby.id);
    const list = await api(h.origin, 'GET', '/api/servers');
    const s = find(list.data, 'fiveweb-freeroam');
    assert.equal(s.status, 'online');
    assert.equal(s.reserved, 3);
    assert.equal(s.capacity, 128);
    assert.ok(!list.text.includes(first.data.session.credential), 'credentials never appear in the list');
  });

  test('unknown server, malformed id, wrong method, bad body and foreign origin are refused', async () => {
    assert.equal((await join(h.origin, 'Ali', 'no-such-server')).status, 404);
    assert.equal((await join(h.origin, 'Ali', 'BAD_ID')).status, 404);
    assert.equal((await api(h.origin, 'GET', `${SERVER}/join`)).status, 405);
    assert.equal((await api(h.origin, 'POST', '/api/servers', { json: {} })).status, 405);
    assert.equal((await join(h.origin, 'x')).status, 400);
    const foreign = await api(h.origin, 'POST', `${SERVER}/join`, { json: { nickname: 'Ali' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const bad = await api(h.origin, 'POST', `${SERVER}/join`, { rawBody: '{}', contentType: 'text/plain', headers: hdr(h.origin) });
    assert.equal(bad.status, 415);
  });

  test('there is no public create-server endpoint', async () => {
    const res = await api(h.origin, 'POST', '/api/servers/new', { json: { id: 'x', name: 'Yeni Sunucu' }, headers: hdr(h.origin) });
    assert.equal(res.status, 404);
  });

  test('the resources manifest is public: client files only, no server module names or code', async () => {
    const res = await api(h.origin, 'GET', `${SERVER}/resources`);
    assert.equal(res.status, 200);
    const [r] = res.data.resources;
    assert.equal(r.name, 'welcome');
    assert.equal(r.apiVersion, 'fiveweb-js-v1');
    assert.deepEqual(r.client, [{ file: 'client.js', url: '/__resources/fiveweb-freeroam/welcome/client.js' }]);
    assert.ok(!('server' in r));
    assert.ok(!res.text.includes('server.mjs'));
    assert.equal((await api(h.origin, 'GET', '/api/servers/nope/resources')).status, 404);
  });
});

describe('servers API: ephemeral rooms are recreated after the last peer leaves', () => {
  let h;
  before(async () => {
    h = await startApp();
  });
  after(() => h.close());

  test('both relay peers disconnect: server stays listed, next join gets a new room', async () => {
    const a = await join(h.origin, 'Ali');
    const b = await join(h.origin, 'Veli');
    const host = await connectRelay(h.wsBase, h.origin);
    host.send({ type: 'join', protocol: 1, key: a.data.session.credential, room: a.data.lobby.id, build: BUILD, map: 'gta5' });
    await host.type('welcome');
    const guest = await connectRelay(h.wsBase, h.origin);
    guest.send({ type: 'join', protocol: 1, key: b.data.session.credential, room: b.data.lobby.id, build: BUILD, map: 'gta5' });
    await guest.type('welcome');
    host.close();
    guest.close();
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(50);
      gone = (await api(h.origin, 'GET', '/api/servers')).data.servers.length === 1 &&
        find((await api(h.origin, 'GET', '/api/servers')).data, 'fiveweb-freeroam').reserved === 0 &&
        find((await api(h.origin, 'GET', '/api/servers')).data, 'fiveweb-freeroam').connected === 0;
    }
    const list = await api(h.origin, 'GET', '/api/servers');
    assert.equal(find(list.data, 'fiveweb-freeroam').status, 'online');
    const c = await join(h.origin, 'Ece');
    assert.equal(c.status, 200);
    assert.equal(c.data.session.role, 'host');
    assert.notEqual(c.data.lobby.id, a.data.lobby.id);
    assert.ok(gone);
  });
});

describe('resource file route: allowlist, scope, no server code', () => {
  let h;
  before(async () => {
    h = await startApp();
    writeFileSync(path.join(h.fixture.root, 'game.html'), [
      '<!doctype html><html><head><title>$GrandV</title></head><body><script>',
      'const q = new URLSearchParams(location.search);',
      'const playerKeys=new Set(["audiodiag","mode", "poseproof"]);for(const key of [...q.keys()])if(!playerKeys.has(key))q.delete(key);if(q.get("poseproof")!=="4")q.delete("poseproof");',
      '</script><script src="/x.js"></script></body></html>',
    ].join('\n'));
  });
  after(() => h.close());

  test('a manifest-listed client file is served as JavaScript', async () => {
    const res = await rawRequest(h.origin, { path: '/__resources/fiveweb-freeroam/welcome/client.js' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/javascript/);
    assert.ok(res.body.toString().includes('export function start'));
  });

  test('server modules, dotfiles, traversal, unbound servers and unknown files are 404 with no source', async () => {
    const paths = [
      '/__resources/fiveweb-freeroam/welcome/server.mjs',
      '/__resources/fiveweb-freeroam/welcome/fiveweb.resource.json',
      '/__resources/fiveweb-freeroam/welcome/..%2Fserver.mjs',
      '/__resources/fiveweb-freeroam/welcome/../welcome/server.mjs',
      '/__resources/fiveweb-freeroam/welcome/%2e%2e/server.mjs',
      '/__resources/fiveweb-freeroam/welcome/.hidden.js',
      '/__resources/other-server/welcome/client.js',
      '/__resources/fiveweb-freeroam/nope/client.js',
    ];
    for (const p of paths) {
      const res = await rawRequest(h.origin, { path: p });
      assert.equal(res.status, 404, p);
      assert.ok(!res.body.toString().includes('ResourceRuntime'), p);
    }
    const post = await rawRequest(h.origin, { method: 'POST', path: '/__resources/fiveweb-freeroam/welcome/client.js' });
    assert.equal(post.status, 404);
  });

  test('the served game page loads the resource client after the runtime; voice tag only when the asset exists', async () => {
    const res = await rawRequest(h.origin, { path: '/game.html' });
    const body = res.body.toString('latin1');
    assert.ok(body.includes(`<script src="${RESOURCE_CLIENT_SRC}"></script>`));
    assert.ok(body.indexOf(RESOURCE_CLIENT_SRC) > body.indexOf('multiplayer-game.js'));
    assert.equal(body.includes(VOICE_SRC), VOICE_PRESENT, 'voice tag exactly when public/voice.js exists');
    const withVoice = transformGamePage(Buffer.from(readFileSync(path.join(h.fixture.root, 'game.html'))), { voice: true });
    assert.equal(withVoice.patched, true);
    const out = withVoice.body.toString('latin1');
    assert.ok(out.indexOf(VOICE_SRC) > 0 && out.indexOf(VOICE_SRC) < out.indexOf('multiplayer-game.js'), 'voice before runtime');
    assert.ok(out.indexOf('multiplayer-game.js') < out.indexOf(RESOURCE_CLIENT_SRC));
  });

  test('the public resource client asset is served same-origin; voice route exists only with its file', async () => {
    const ok = await rawRequest(h.origin, { path: '/__grandv/resource-client.js' });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /javascript/);
    const voice = await rawRequest(h.origin, { path: '/__grandv/voice.js' });
    assert.equal(voice.status, VOICE_PRESENT ? 200 : 404);
  });
});

describe('resources: manifest and load validation', () => {
  const base = { name: 'demo', version: '1.0.0', apiVersion: 'fiveweb-js-v1', client: ['client.js'], server: ['server.mjs'] };

  test('the shipped welcome example loads and its manifest validates', () => {
    const r = loadResource(RESOURCES_DIR, 'welcome');
    assert.equal(r.version, '0.1.0');
    assert.deepEqual(r.client, ['client.js']);
    assert.deepEqual(r.server, ['server.mjs']);
  });

  test('unknown fields, wrong apiVersion, bad version, traversal and non-.mjs server files are rejected', () => {
    assert.throws(() => parseManifest({ ...base, extra: 1 }), /unknown field/);
    assert.throws(() => parseManifest({ ...base, apiVersion: 'fxserver' }), /apiVersion/);
    assert.throws(() => parseManifest({ ...base, version: 'latest' }), /version/);
    assert.throws(() => parseManifest({ ...base, client: ['../server.mjs'] }), /invalid file/);
    assert.throws(() => parseManifest({ ...base, client: ['sub/client.js'] }), /invalid file/);
    assert.throws(() => parseManifest({ ...base, server: ['server.js'] }), /invalid file/);
    assert.throws(() => parseManifest({ ...base, client: ['a.js', 'a.js'] }), /duplicate/);
  });

  test('symlinked client files, missing files and name/folder mismatches are rejected at load', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-res-'));
    const outside = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-out-'));
    writeFileSync(path.join(outside, 'secret.js'), 'export const s = 1;');
    const dir = path.join(root, 'demo');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'fiveweb.resource.json'), JSON.stringify(base));
    writeFileSync(path.join(dir, 'server.mjs'), 'export function start(){}');
    symlinkSync(path.join(outside, 'secret.js'), path.join(dir, 'client.js'));
    assert.throws(() => loadResource(root, 'demo'), ResourceError);
    writeFileSync(path.join(dir, 'fiveweb.resource.json'), JSON.stringify({ ...base, name: 'other' }));
    assert.throws(() => loadResource(root, 'demo'), /does not match folder/);
    assert.throws(() => loadResource(root, 'missing'), /not found/);
  });
});

describe('resources: trusted server runtime lifecycle (real example)', () => {
  test('start imports the example, events reach it, stop removes its callbacks', async () => {
    const logs = [];
    const rt = new ResourceRuntime({ resources: [loadResource(RESOURCES_DIR, 'welcome')], log: (m) => logs.push(m) });
    await rt.start();
    rt.emit('server:join', { serverId: 'fiveweb-freeroam', role: 'host' });
    assert.ok(logs.some((l) => l.includes('welcome server started')));
    assert.ok(logs.some((l) => l.includes('join fiveweb-freeroam role=host')));
    await rt.stop();
    assert.ok(logs.some((l) => l.includes('welcome server stopped')));
    const before = logs.length;
    rt.emit('server:join', { serverId: 'fiveweb-freeroam', role: 'guest' });
    assert.equal(logs.length, before, 'no callback runs after stop');
  });

  test('a failing start stops the resources that already started and rejects', async () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-bad-'));
    const ok = path.join(root, 'okres');
    const bad = path.join(root, 'badres');
    mkdirSync(ok);
    mkdirSync(bad);
    writeFileSync(path.join(ok, 'fiveweb.resource.json'), JSON.stringify({ name: 'okres', version: '1.0.0', apiVersion: 'fiveweb-js-v1', server: ['s.mjs'] }));
    writeFileSync(path.join(ok, 's.mjs'), 'export function stop(){ globalThis.__gvStopped = true; }');
    writeFileSync(path.join(bad, 'fiveweb.resource.json'), JSON.stringify({ name: 'badres', version: '1.0.0', apiVersion: 'fiveweb-js-v1', server: ['s.mjs'] }));
    writeFileSync(path.join(bad, 's.mjs'), 'export function start(){ throw new Error("boom"); }');
    const rt = new ResourceRuntime({ resources: [loadResource(root, 'okres'), loadResource(root, 'badres')] });
    await assert.rejects(rt.start(), ResourceError);
    assert.equal(globalThis.__gvStopped, true);
    delete globalThis.__gvStopped;
  });

  test('scoped api: unknown event names and non-function handlers are refused', async () => {
    let captured;
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-api-'));
    mkdirSync(path.join(root, 'apires'));
    writeFileSync(path.join(root, 'apires', 'fiveweb.resource.json'), JSON.stringify({ name: 'apires', version: '1.0.0', apiVersion: 'fiveweb-js-v1', server: ['s.mjs'] }));
    writeFileSync(path.join(root, 'apires', 's.mjs'), 'export function start(api){ globalThis.__gvApi = api; }');
    const rt = new ResourceRuntime({ resources: [loadResource(root, 'apires')] });
    await rt.start();
    captured = globalThis.__gvApi;
    assert.throws(() => captured.on('server:nuke', () => {}), /unknown event/);
    assert.throws(() => captured.on('server:join', 'nope'), /must be a function/);
    assert.equal(captured.resource.name, 'apires');
    assert.equal(Object.isFrozen(captured), true);
    await rt.stop();
    delete globalThis.__gvApi;
  });
});
