// Pure policy helpers for the FiveWeb desktop shell. No Electron imports here, so they
// run under plain `node --test` in CI and in the Linux smoke job.
'use strict';

const APP_ORIGIN = 'https://fiveweb.royalnetwork.xyz';
const APP_URL = APP_ORIGIN + '/';

// Hostnames that may open in the system browser (https only). Everything else is denied.
const EXTERNAL_HOSTS = Object.freeze(['github.com', 'royalnetwork.xyz']);

// Packaged local pages the window may show (startup, offline, error). Names only, no paths.
const LOCAL_PAGES = Object.freeze(['loading.html', 'offline.html', 'error.html']);

function parseUrl(raw) {
  try {
    return new URL(String(raw));
  } catch (_) {
    return null;
  }
}

function isTrustedAppUrl(raw) {
  const u = parseUrl(raw);
  // Userinfo (user:pass@) is never trusted, even when the origin itself matches.
  if (!u || u.username || u.password) return false;
  return u.protocol === 'https:' && u.origin === APP_ORIGIN;
}

// Percent-decoding that fails closed: malformed sequences (e.g. %E0%A4%A) give null, never throw.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return null;
  }
}

// file:// URLs are allowed only for the packaged pages in LOCAL_PAGES that live in pagesDir.
// Malformed input returns false; this function never throws.
function isLocalPageUrl(raw, pagesDir) {
  try {
    const u = parseUrl(raw);
    if (!u || u.protocol !== 'file:' || typeof pagesDir !== 'string' || !pagesDir) return false;
    if (u.host !== '' || u.username || u.password) return false;
    // Windows file URLs look like /C:/dir/pages/x.html; normalise both sides to a leading slash.
    const lead = (s) => (s.startsWith('/') ? s : '/' + s);
    const base = lead(pagesDir.replace(/\\/g, '/').replace(/\/+$/, ''));
    const target = safeDecode(u.pathname);
    if (target === null) return false;
    return LOCAL_PAGES.some((name) => target === `${base}/${name}`);
  } catch (_) {
    return false;
  }
}

// Navigation inside the main window: the FiveWeb origin or a packaged local page.
function isAllowedNavigation(raw, pagesDir) {
  return isTrustedAppUrl(raw) || isLocalPageUrl(raw, pagesDir);
}

// Links that may leave the app: https on an allowlisted host only.
function isAllowedExternal(raw) {
  const u = parseUrl(raw);
  if (!u || u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return EXTERNAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

// Permission decision. 'media' with audio only, from the trusted origin, main frame only.
// The first request always returns 'prompt' (native dialog). Camera and video are never allowed.
// 'allow' is only returned for a check after the user granted audio in this session.
function decidePermission({ permission, requestingUrl, isMainFrame, mediaTypes, userGranted }) {
  if (permission !== 'media') return 'deny';
  if (!isMainFrame || !isTrustedAppUrl(requestingUrl)) return 'deny';
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  if (types.includes('video') || !types.includes('audio') || types.some((t) => t !== 'audio')) return 'deny';
  return userGranted ? 'allow' : 'prompt';
}

// Check-handler variant: only a previously user-granted audio permission for the trusted origin.
function checkPermission({ permission, requestingOrigin, mediaType, userGranted }) {
  if (permission !== 'media') return false;
  return Boolean(userGranted) && requestingOrigin === APP_ORIGIN && mediaType === 'audio';
}

// Icon file for the native window. Windows uses the .ico; Linux and others use the .png.
// Both live in build/ and are packed into app.asar via electron-builder.json "files".
function iconFileFor(platform) {
  return platform === 'win32' ? 'icon.ico' : 'icon.png';
}

// Only the documented flags are honoured. URL-like arguments are ignored, never loaded.
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return {
    dev: list.includes('--dev'),
    smoke: list.includes('--smoke'),
  };
}

module.exports = {
  APP_ORIGIN,
  APP_URL,
  EXTERNAL_HOSTS,
  LOCAL_PAGES,
  isTrustedAppUrl,
  isLocalPageUrl,
  isAllowedNavigation,
  isAllowedExternal,
  decidePermission,
  checkPermission,
  iconFileFor,
  parseArgs,
};
