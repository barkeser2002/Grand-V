// Test helpers: build a throwaway asset tree shaped like the real mirror, start the
// real HTTP/WebSocket backend on an ephemeral loopback port, and talk to it over
// real sockets. Nothing here fakes server behaviour.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { BUILD } from '../src/constants.js';

export { BUILD };

export const SECRET_OUTSIDE = 'OUTSIDE-SECRET-DO-NOT-SERVE';

export function makeAssetRoot() {
  const parent = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-fixture-'));
  writeFileSync(path.join(parent, 'secret.txt'), SECRET_OUTSIDE);
  const root = path.join(parent, 'playgta5.com');
  mkdirSync(root);
  const launcher = '<!doctype html><html><head><title>GrandV</title></head><body><p id="launcher-body">launcher</p></body></html>\n';
  writeFileSync(path.join(root, 'launcher.html'), launcher);
  writeFileSync(path.join(root, 'launcher_player_flow.js'), `(()=>{const BUILD='${BUILD}';})();\n`);
  mkdirSync(path.join(root, 'b', '8b0b5899ed'), { recursive: true });
  writeFileSync(path.join(root, 'b', '8b0b5899ed', 'game.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>asset index</title>');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  writeFileSync(path.join(root, 'package.json'), '{"name":"backend"}');
  writeFileSync(path.join(root, 'test.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  mkdirSync(path.join(root, 'data', 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'test.bin'), '0123456789');
  writeFileSync(path.join(root, 'data', 'sub', 'index.html'), 'sub index');
  writeFileSync(path.join(root, 'data', '.hidden'), 'hidden');
  writeFileSync(path.join(root, 'app.js'), 'console.log("app")');
  symlinkSync(path.join(parent, 'secret.txt'), path.join(root, 'escape.txt'));
  symlinkSync(path.join(root, 'data', 'test.bin'), path.join(root, 'inside.bin'));
  return { parent, root, launcher };
}

export async function startApp(overrides = {}) {
  const fixture = makeAssetRoot();
  const app = createApp({
    assetRoot: fixture.root,
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    ...overrides,
  });
  const { port } = await app.listen();
  const origin = `http://127.0.0.1:${port}`;
  return {
    app,
    port,
    origin,
    wsBase: `ws://127.0.0.1:${port}`,
    fixture,
    close: () => app.close(),
  };
}

// Raw HTTP request (no fetch normalisation, so traversal attempts reach the server as sent).
export function rawRequest(origin, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function api(origin, method, apiPath, { json, headers = {}, rawBody, contentType } = {}) {
  const h = { ...headers };
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
  } else if (rawBody !== undefined) {
    body = rawBody;
    h['Content-Type'] = contentType || 'application/json';
  }
  if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
  const res = await rawRequest(origin, { method, path: apiPath, headers: h, body });
  let data = null;
  const text = res.body.toString('utf8');
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  return { status: res.status, headers: res.headers, text, data };
}

export async function createLobby(origin, { name = 'Test Lobi', nickname = 'Host', map = 'gta5', build = BUILD, capacity } = {}) {
  const json = { name, nickname, map, build };
  if (capacity !== undefined) json.capacity = capacity;
  const res = await api(origin, 'POST', '/api/lobbies', { json, headers: { Origin: origin } });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${res.text}`);
  return res.data;
}

export async function joinLobby(origin, id, nickname = 'Guest') {
  return api(origin, 'POST', `/api/lobbies/${id}/join`, { json: { nickname }, headers: { Origin: origin } });
}

// A real ws client with an inbox and explicit waits.
export class RelaySocket {
  constructor(wsBase, origin, { autoPong = true } = {}) {
    this.ws = new WebSocket(`${wsBase}/relay`, { headers: { Origin: origin }, autoPong, perMessageDeflate: false });
    this.inbox = [];
    this.closed = null;
    this.opened = false;
    this.handshakeError = null;
    this.waiters = [];
    this.ws.on('message', (data, isBinary) => {
      const text = isBinary ? '<binary>' : data.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        msg = { __raw: text };
      }
      this.inbox.push(msg);
      this.flush();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.flush();
    });
    this.ws.on('error', () => {});
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        this.opened = true;
        resolve();
      });
      this.ws.once('unexpected-response', (_req, res) => {
        this.handshakeError = res.statusCode;
        resolve();
      });
      this.ws.once('error', (err) => {
        if (!this.opened) reject(err);
      });
    });
  }
  flush() {
    for (const w of [...this.waiters]) {
      const idx = this.inbox.findIndex(w.pred);
      if (idx >= 0) {
        const [msg] = this.inbox.splice(idx, 1);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else if (this.closed && w.closeOk) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.reject(new Error(`socket closed while waiting: ${JSON.stringify(this.closed)}`));
      }
    }
  }
  send(value) {
    this.ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  next(pred, timeoutMs = 3000) {
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, closeOk: true };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout waiting for message; inbox=${JSON.stringify(this.inbox)}`));
      }, timeoutMs);
      this.waiters.push(w);
      this.flush();
    });
  }
  type(t, timeoutMs) {
    return this.next((m) => m.type === t, timeoutMs);
  }
  // Resolves with {code, reason} when the socket closes.
  waitClose(timeoutMs = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
      this.ws.once('close', (code, reason) => {
        clearTimeout(t);
        resolve({ code, reason: reason.toString() });
      });
    });
  }
  async ensureOpen() {
    await this.ready;
    return this;
  }
  terminate() {
    this.ws.terminate();
  }
  close(code = 1000) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code);
  }
}

export async function connectRelay(wsBase, origin, opts) {
  return new RelaySocket(wsBase, origin, opts).ensureOpen();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readFixture(p) {
  return readFileSync(p);
}
