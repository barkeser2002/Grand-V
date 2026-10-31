'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const p = require('../src/policy.js');

const PAGES = '/opt/fiveweb/resources/app/pages';
const ROOT = path.join(__dirname, '..');

test('app URL is pinned to the FiveWeb https origin', () => {
  assert.equal(p.APP_URL, 'https://fiveweb.royalnetwork.xyz/');
  assert.equal(p.isTrustedAppUrl('https://fiveweb.royalnetwork.xyz/servers?x=1'), true);
  assert.equal(p.isTrustedAppUrl('http://fiveweb.royalnetwork.xyz/'), false, 'no plain http');
  assert.equal(p.isTrustedAppUrl('https://fiveweb.royalnetwork.xyz.evil.test/'), false);
  assert.equal(p.isTrustedAppUrl('https://evil.test/?u=https://fiveweb.royalnetwork.xyz/'), false);
  assert.equal(p.isTrustedAppUrl('not a url'), false);
});

test('navigation allows only the app origin and packaged local pages', () => {
  assert.equal(p.isAllowedNavigation('https://fiveweb.royalnetwork.xyz/', PAGES), true);
  assert.equal(p.isAllowedNavigation('file:///opt/fiveweb/resources/app/pages/offline.html', PAGES), true);
  assert.equal(p.isAllowedNavigation('file:///opt/fiveweb/resources/app/pages/error.html', PAGES), true);
  assert.equal(p.isAllowedNavigation('file:///etc/passwd', PAGES), false);
  assert.equal(p.isAllowedNavigation('file:///opt/fiveweb/resources/app/pages/../secret.html', PAGES), false);
  assert.equal(p.isAllowedNavigation('file:///opt/fiveweb/resources/app/pages/evil.html', PAGES), false);
  assert.equal(p.isAllowedNavigation('http://localhost:8097/', PAGES), false, 'no localhost server');
  assert.equal(p.isAllowedNavigation('https://github.com/', PAGES), false, 'external links go to the browser');
});

test('windows file URLs for packaged pages are accepted', () => {
  assert.equal(p.isLocalPageUrl('file:///C:/FiveWeb/resources/app/pages/offline.html', 'C:\\FiveWeb\\resources\\app\\pages'), true);
  assert.equal(p.isLocalPageUrl('file:///C:/FiveWeb/resources/app/pages/x.html', 'C:\\FiveWeb\\resources\\app\\pages'), false);
});

test('external links: https and allowlisted hosts only', () => {
  assert.equal(p.isAllowedExternal('https://github.com/barkeser2002/grand-v'), true);
  assert.equal(p.isAllowedExternal('https://royalnetwork.xyz/docs'), true);
  assert.equal(p.isAllowedExternal('https://www.royalnetwork.xyz/'), true);
  assert.equal(p.isAllowedExternal('http://github.com/'), false);
  assert.equal(p.isAllowedExternal('https://github.com.evil.test/'), false);
  assert.equal(p.isAllowedExternal('https://user:pw@github.com/'), false);
  assert.equal(p.isAllowedExternal('file:///etc/passwd'), false);
  assert.equal(p.isAllowedExternal('javascript:alert(1)'), false);
});

test('audio permission: prompt first, never camera, never other permissions', () => {
  const base = { requestingUrl: 'https://fiveweb.royalnetwork.xyz/', isMainFrame: true, mediaTypes: ['audio'], userGranted: false };
  assert.equal(p.decidePermission({ ...base, permission: 'media' }), 'prompt');
  assert.equal(p.decidePermission({ ...base, permission: 'media', userGranted: true }), 'allow');
  assert.equal(p.decidePermission({ ...base, permission: 'media', mediaTypes: ['audio', 'video'] }), 'deny', 'camera denied');
  assert.equal(p.decidePermission({ ...base, permission: 'media', mediaTypes: ['video'] }), 'deny');
  assert.equal(p.decidePermission({ ...base, permission: 'media', mediaTypes: undefined }), 'deny');
  assert.equal(p.decidePermission({ ...base, permission: 'notifications' }), 'deny');
  assert.equal(p.decidePermission({ ...base, permission: 'geolocation' }), 'deny');
  assert.equal(p.decidePermission({ ...base, permission: 'media', isMainFrame: false }), 'deny', 'iframes denied');
  assert.equal(p.decidePermission({ ...base, permission: 'media', requestingUrl: 'https://evil.test/' }), 'deny');
});

test('permission check: only a user-granted audio grant for the trusted origin', () => {
  const origin = 'https://fiveweb.royalnetwork.xyz';
  assert.equal(p.checkPermission({ permission: 'media', requestingOrigin: origin, mediaType: 'audio', userGranted: true }), true);
  assert.equal(p.checkPermission({ permission: 'media', requestingOrigin: origin, mediaType: 'audio', userGranted: false }), false);
  assert.equal(p.checkPermission({ permission: 'media', requestingOrigin: origin, mediaType: 'video', userGranted: true }), false);
  assert.equal(p.checkPermission({ permission: 'media', requestingOrigin: 'https://evil.test', mediaType: 'audio', userGranted: true }), false);
});

test('CLI flags: only --dev and --smoke; URL-like arguments are ignored', () => {
  assert.deepEqual(p.parseArgs(['electron', '.']), { dev: false, smoke: false });
  assert.deepEqual(p.parseArgs(['electron', '.', '--dev']), { dev: true, smoke: false });
  assert.deepEqual(p.parseArgs(['electron', '.', '--smoke']), { dev: false, smoke: true });
  const withUrl = p.parseArgs(['electron', '.', 'https://evil.test/', '--url=https://evil.test']);
  assert.deepEqual(withUrl, { dev: false, smoke: false });
});

test('hostile malformed file URLs are rejected without throwing (fail closed)', () => {
  const hostile = [
    'file:///opt/fiveweb/resources/app/pages/%E0%A4%A.html',
    'file:///opt/fiveweb/resources/app/pages/%.html',
    'file:///opt/fiveweb/resources/app/pages/%zz/offline.html',
    'file:///opt/fiveweb/resources/app/pages/offline%.html',
    'file:///opt/fiveweb/resources/app/pages/%C0%AE%C0%AE/secret.html',
    'file:///opt/fiveweb/resources/app/pages/%2e%2e/secret.html',
    'file://evil.test/opt/fiveweb/resources/app/pages/offline.html',
    'file://user:pw@/opt/fiveweb/resources/app/pages/offline.html',
  ];
  for (const url of hostile) {
    assert.doesNotThrow(() => p.isLocalPageUrl(url, PAGES), url);
    assert.equal(p.isLocalPageUrl(url, PAGES), false, url);
    assert.equal(p.isAllowedNavigation(url, PAGES), false, url);
  }
});

test('malformed percent-encoding in a navigation request does not throw', () => {
  assert.doesNotThrow(() => p.isAllowedNavigation('file:///%E0%A4%A', PAGES));
  assert.equal(p.isAllowedNavigation('file:///%E0%A4%A', PAGES), false);
  assert.equal(p.isLocalPageUrl('file:///x', undefined), false, 'missing pages dir');
  assert.equal(p.isLocalPageUrl('file:///x', 42), false, 'non-string pages dir');
});

test('a legitimate page path with an encoded space in the pages dir still matches', () => {
  const dir = '/opt/Fi ve/resources/app/pages';
  assert.equal(p.isLocalPageUrl('file:///opt/Fi%20ve/resources/app/pages/offline.html', dir), true);
});

test('isTrustedAppUrl rejects URL credentials even on the right origin', () => {
  assert.equal(p.isTrustedAppUrl('https://user:pw@fiveweb.royalnetwork.xyz/'), false);
  assert.equal(p.isTrustedAppUrl('https://user@fiveweb.royalnetwork.xyz/'), false);
  assert.equal(p.isTrustedAppUrl('https://:pw@fiveweb.royalnetwork.xyz/'), false);
  assert.equal(p.isAllowedNavigation('https://user@fiveweb.royalnetwork.xyz/', PAGES), false);
  assert.equal(
    p.decidePermission({
      permission: 'media',
      requestingUrl: 'https://user@fiveweb.royalnetwork.xyz/',
      isMainFrame: true,
      mediaTypes: ['audio'],
      userGranted: true,
    }),
    'deny',
  );
});

test('window icon: platform picks the .ico on Windows and the .png elsewhere', () => {
  assert.equal(p.iconFileFor('win32'), 'icon.ico');
  assert.equal(p.iconFileFor('linux'), 'icon.png');
  assert.equal(p.iconFileFor('darwin'), 'icon.png');
});

test('icon files ship: build/icon.png and build/icon.ico exist with real image headers', () => {
  const png = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 512, 'png width');
  assert.equal(png.readUInt32BE(20), 512, 'png height');
  const ico = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], 'ICO header');
  assert.ok(ico.readUInt16LE(4) >= 1, 'ICO has at least one image');
});

test('electron-builder config packs the window icon and keeps exe icon editing on', () => {
  const eb = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
  assert.ok(eb.files.includes('build/icon.png'), 'build/icon.png is inside app.asar');
  assert.ok(eb.files.includes('build/icon.ico'), 'build/icon.ico is inside app.asar');
  assert.ok(eb.files.includes('src/**/*') && eb.files.includes('pages/**/*'));
  assert.equal(eb.win.signAndEditExecutable, true, 'exe icon/metadata editing must not be disabled');
  assert.equal(eb.win.icon, 'build/icon.ico', 'Windows exe icon is the FiveWeb .ico, not the Electron default');
  assert.equal(eb.linux.icon, 'build/icon.png', 'Linux icon is the FiveWeb .png');
  assert.equal(eb.directories.buildResources, 'build');
  assert.equal(eb.publish, null);
});

test('main window uses the packaged icon path and keeps security flags', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /policy\.iconFileFor\(process\.platform\)/, 'icon chosen per platform');
  assert.match(main, /'build', policy\.iconFileFor/, 'icon resolved from the packaged build/ folder');
  for (const bad of ['no-sandbox', 'ignore-certificate-errors', 'disable-web-security', 'allowRunningInsecureContent: true', 'sandbox: false', 'webSecurity: false']) {
    assert.equal(main.includes(bad), false, 'must not contain ' + bad);
  }
  assert.match(main, /sandbox: true/);
});
