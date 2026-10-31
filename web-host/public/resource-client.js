// FiveWeb resource client. Classic script (no modules) injected into game pages.
// Reads ?server=<id> from the page URL, fetches that server's public resource manifests,
// imports each listed client file from the same origin, calls its start(api), and calls
// stop(api) on pagehide. The api object is narrow: a status line, toast notifications,
// and a log. It exposes no lobby credential, no network send and no game natives.
// Lifecycle: start() runs once, after the DOM is ready. stop() runs once, on pagehide, and
// makes every pending fetch/import result inert, so nothing starts after the page is left.
// The loader is a factory (window.FiveWebResourceClient.createLoader) so it can be unit tested
// with fake fetch/importer. Resource source is only ever loaded with import(), never eval'd.
(() => {
  'use strict';
  const SERVER_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
  const FILE_RE = /^\/__resources\/([a-z0-9][a-z0-9-]{1,39})\/([a-z0-9][a-z0-9-]{0,39})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}\.m?js)$/;
  const TOAST_MS = 6000;

  function serverIdFrom(search) {
    try {
      const id = new URLSearchParams(search).get('server');
      return id && SERVER_RE.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  }

  // Returns null when the page has no valid ?server=<id>: the client then does nothing.
  function createLoader({ location, document, fetch, importer, warn = () => {} }) {
    const serverId = serverIdFrom(location.search);
    if (!serverId) return null;

    let started = false;
    let stopped = false;
    const active = []; // { api, mod }, only for modules whose start() was invoked
    const disposers = new Map(); // api -> cleanup, kept out of the module-facing object
    let statusEl = null;
    let toastBox = null;

    function ensureDom() {
      if (statusEl) return;
      const host = document.body || document.documentElement;
      statusEl = document.createElement('div');
      statusEl.id = 'fiveweb-resource-status';
      statusEl.setAttribute('role', 'status');
      // Bottom-left: the multiplayer HUD owns top-left and the voice box owns top-right.
      statusEl.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;font:14px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:4px;pointer-events:none;';
      toastBox = document.createElement('div');
      toastBox.id = 'fiveweb-resource-toasts';
      toastBox.style.cssText = 'position:fixed;right:12px;top:12px;z-index:2147483000;display:flex;flex-direction:column;gap:6px;pointer-events:none;';
      host.appendChild(statusEl);
      host.appendChild(toastBox);
    }

    function makeApi(manifest) {
      const owned = new Set();
      const api = {
        resource: Object.freeze({ name: manifest.name, version: manifest.version }),
        server: Object.freeze({ id: serverId }),
        setStatus(text) {
          if (stopped) return;
          ensureDom();
          statusEl.textContent = String(text).slice(0, 200);
        },
        notify(text) {
          if (stopped) return;
          ensureDom();
          const node = document.createElement('div');
          node.textContent = String(text).slice(0, 200);
          node.style.cssText = 'font:13px sans-serif;color:#fff;background:rgba(20,20,20,.8);padding:6px 10px;border-radius:4px;';
          toastBox.appendChild(node);
          owned.add(node);
          setTimeout(() => {
            node.remove();
            owned.delete(node);
          }, TOAST_MS);
        },
        log(msg) {
          if (!stopped) warn(`[fiveweb:${manifest.name}] ${String(msg).slice(0, 200)}`, 'info');
        },
      };
      disposers.set(api, () => {
        for (const node of owned) node.remove();
        owned.clear();
      });
      return Object.freeze(api);
    }

    async function start() {
      if (started || stopped) return;
      started = true;
      let manifests;
      try {
        const res = await fetch(`/api/servers/${serverId}/resources`, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok || stopped) return;
        manifests = await res.json();
      } catch (_) {
        return;
      }
      const list = manifests && Array.isArray(manifests.resources) ? manifests.resources : [];
      for (const manifest of list) {
        if (stopped) return;
        if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.client)) continue;
        const api = makeApi(manifest);
        for (const entry of manifest.client) {
          if (stopped) return;
          if (!entry || typeof entry.url !== 'string') continue;
          const u = new URL(entry.url, location.origin);
          const m = FILE_RE.exec(u.pathname);
          if (u.origin !== location.origin || u.search || u.hash || !m) continue;
          if (m[1] !== serverId || m[2] !== manifest.name) continue;
          let mod;
          try {
            mod = await importer(u.pathname);
          } catch (err) {
            warn(`[fiveweb:${manifest.name}] client module failed to load: ${err && err.name}`, 'warn');
            continue;
          }
          if (stopped) return; // page left while importing: never start it
          if (!mod || typeof mod.start !== 'function') continue;
          active.push({ api, mod });
          try {
            await mod.start(api);
          } catch (err) {
            warn(`[fiveweb:${manifest.name}] client start failed: ${err && err.name}`, 'warn');
          }
        }
      }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      for (const { api, mod } of active.reverse()) {
        try {
          if (typeof mod.stop === 'function') mod.stop(api);
        } catch (_) {
          /* a failing resource must not block the others */
        }
      }
      active.length = 0;
      for (const dispose of disposers.values()) dispose();
      disposers.clear();
      if (statusEl) statusEl.textContent = '';
    }

    return Object.freeze({
      start,
      stop,
      get state() {
        return stopped ? 'stopped' : started ? 'started' : 'idle';
      },
    });
  }

  const api = Object.freeze({ createLoader, serverIdFrom });
  if (typeof window !== 'undefined') {
    window.FiveWebResourceClient = api;
    const loader = createLoader({
      location: window.location,
      document: window.document,
      fetch: window.fetch.bind(window),
      importer: (u) => import(u),
      warn: (msg, level) => (level === 'info' ? console.info(msg) : console.warn(msg)),
    });
    if (loader) {
      const run = () => loader.start();
      if (window.document.readyState === 'loading') window.document.addEventListener('DOMContentLoaded', run, { once: true });
      else run();
      window.addEventListener('pagehide', () => loader.stop());
    }
  }
})();
