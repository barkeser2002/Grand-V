// FiveWeb resources: operator-installed folders under resources/<name>/ with a versioned
// fiveweb.resource.json manifest. This is NOT FXServer compatibility and NOT a sandbox.
//  - client files (allowlisted in the manifest) are served same-origin under
//    /__resources/<serverId>/<name>/<file> and imported by public/resource-client.js.
//  - server modules are trusted operator code, imported in-process at startup. Nothing
//    uploaded by a player is ever imported or evaluated, and no request path selects code.
// Only flat filenames listed in the manifest are reachable; dotfiles, symlinks, traversal and
// server files are never served.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sendError } from './http-util.js';

export const API_VERSION = 'fiveweb-js-v1';
export const MANIFEST_FILE = 'fiveweb.resource.json';
export const RESOURCES_DIR = fileURLToPath(new URL('../resources/', import.meta.url));

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const CLIENT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.m?js$/;
const SERVER_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.mjs$/;
const CLIENT_ROUTE_RE = /^\/__resources\/([a-z0-9][a-z0-9-]{1,39})\/([a-z0-9][a-z0-9-]{0,39})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}\.m?js)$/;
const MANIFEST_KEYS = ['name', 'version', 'apiVersion', 'client', 'server'];
const EVENT_NAMES = Object.freeze(['server:join', 'server:roomCreated']);

export class ResourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceError';
  }
}

const fail = (msg) => {
  throw new ResourceError(msg);
};

function fileList(raw, re, field) {
  if (!Array.isArray(raw) || raw.length > 16) fail(`manifest.${field} must be an array of at most 16 files`);
  const seen = new Set();
  for (const f of raw) {
    if (typeof f !== 'string' || !re.test(f)) fail(`manifest.${field}: invalid file name`);
    if (seen.has(f)) fail(`manifest.${field}: duplicate ${f}`);
    seen.add(f);
  }
  return Object.freeze([...raw]);
}

// Pure manifest validation. Returns a frozen description; throws ResourceError otherwise.
export function parseManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('manifest must be a JSON object');
  for (const key of Object.keys(raw)) if (!MANIFEST_KEYS.includes(key)) fail(`manifest: unknown field ${key}`);
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) fail('manifest.name is invalid');
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) fail('manifest.version must be x.y.z');
  if (raw.apiVersion !== API_VERSION) fail(`manifest.apiVersion must be ${API_VERSION}`);
  const client = raw.client === undefined ? [] : fileList(raw.client, CLIENT_FILE_RE, 'client');
  const server = raw.server === undefined ? [] : fileList(raw.server, SERVER_FILE_RE, 'server');
  return Object.freeze({ name: raw.name, version: raw.version, apiVersion: raw.apiVersion, client, server });
}

// Real files only: no symlinks, and the realpath must stay inside the resource directory.
function checkedFile(dirReal, file) {
  const p = path.join(dirReal, file);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (_) {
    fail(`missing file: ${file}`);
  }
  if (!st.isFile()) fail(`not a regular file: ${file}`);
  const real = fs.realpathSync(p);
  if (path.dirname(real) !== dirReal) fail(`file escapes resource directory: ${file}`);
  return real;
}

// Loads and validates resources/<name>/ from disk. Synchronous; runs once at startup.
export function loadResource(resourcesDir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail(`invalid resource name: ${name}`);
  const rootReal = fs.realpathSync(resourcesDir);
  let dirReal;
  try {
    dirReal = fs.realpathSync(path.join(rootReal, name));
  } catch (_) {
    fail(`resource not found: ${name}`);
  }
  if (path.dirname(dirReal) !== rootReal || !fs.statSync(dirReal).isDirectory()) fail(`resource ${name} must be a folder inside the resources root`);
  const manifestPath = checkedFile(dirReal, MANIFEST_FILE);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    fail(`manifest of ${name} is not valid JSON`);
  }
  const m = parseManifest(raw);
  if (m.name !== name) fail(`manifest name ${m.name} does not match folder ${name}`);
  for (const f of [...m.client, ...m.server]) checkedFile(dirReal, f);
  return Object.freeze({ ...m, dir: dirReal });
}

// The only shape exposed over HTTP. Server module names are deliberately omitted.
export function publicManifest(serverId, resource) {
  return {
    name: resource.name,
    version: resource.version,
    apiVersion: resource.apiVersion,
    client: resource.client.map((file) => ({
      file,
      url: `/__resources/${serverId}/${resource.name}/${file}`,
    })),
  };
}

// GET /__resources/:serverId/:resourceName/:file. Only manifest-listed client files of a
// resource bound to that server are served. Everything else is a plain 404.
export async function serveResourceFile(ctx, req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 404, 'Bulunamadı.');
  const m = CLIENT_ROUTE_RE.exec(rawPath);
  if (!m) return sendError(res, 404, 'Bulunamadı.');
  const [, serverId, resName, file] = m;
  if (!ctx.registry || !ctx.registry.binds(serverId, resName)) return sendError(res, 404, 'Bulunamadı.');
  const resource = ctx.resources.get(resName);
  if (!resource || !resource.client.includes(file)) return sendError(res, 404, 'Bulunamadı.');
  let real;
  try {
    real = checkedFile(resource.dir, file);
  } catch (_) {
    return sendError(res, 404, 'Bulunamadı.');
  }
  const body = await fs.promises.readFile(real);
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Trusted server-side plugin host. start() imports each server module of each resource
// and calls its exported start(api). stop() calls stop(api) in reverse order and removes
// every subscription the resource registered. Failures during start() stop what started
// and reject, so the process does not come up half-configured.
export class ResourceRuntime {
  constructor({ resources = [], log = () => {} } = {}) {
    this.resources = resources;
    this.log = log;
    this.loaded = [];
    this.subs = [];
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      for (const r of this.resources) {
        for (const file of r.server) {
          const url = pathToFileURL(path.join(r.dir, file)).href;
          const mod = await import(url);
          const api = this.#apiFor(r);
          this.loaded.push({ resource: r.name, mod, api, file });
          if (typeof mod.start === 'function') await mod.start(api);
        }
      }
    } catch (err) {
      await this.stop();
      throw new ResourceError(`resource start failed: ${err && err.message}`);
    }
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.loaded].reverse()) {
      try {
        if (typeof entry.mod.stop === 'function') await entry.mod.stop(entry.api);
      } catch (err) {
        this.log(`resource ${entry.resource} stop error: ${err && err.name}`);
      }
    }
    this.loaded = [];
    this.subs = [];
  }

  // Dispatches a host event to subscribers. Each callback runs isolated: a throwing or
  // rejecting callback is logged and does not stop the others or the host.
  emit(event, payload) {
    for (const sub of [...this.subs]) {
      if (sub.event !== event || !sub.active) continue;
      try {
        const out = sub.fn(payload);
        if (out && typeof out.catch === 'function') out.catch(() => this.log(`resource ${sub.resource} handler failed: ${event}`));
      } catch (_) {
        this.log(`resource ${sub.resource} handler failed: ${event}`);
      }
    }
  }

  #apiFor(resource) {
    const runtime = this;
    const scoped = {
      resource: Object.freeze({ name: resource.name, version: resource.version }),
      log(msg) {
        runtime.log(`[resource:${resource.name}] ${String(msg).slice(0, 200)}`);
      },
      on(event, fn) {
        if (runtime.closed) fail('resource runtime is stopped');
        if (!EVENT_NAMES.includes(event)) fail(`unknown event: ${event}`);
        if (typeof fn !== 'function') fail('handler must be a function');
        const sub = { event, fn, resource: resource.name, active: true };
        runtime.subs.push(sub);
        return () => {
          sub.active = false;
          runtime.subs = runtime.subs.filter((s) => s !== sub);
        };
      },
    };
    return Object.freeze(scoped);
  }
}
