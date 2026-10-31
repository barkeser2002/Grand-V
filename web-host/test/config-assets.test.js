// Slice 0: configuration and fail-closed asset validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateAssetRoot } from '../src/assets.js';
import { loadConfig, DEFAULT_ASSET_ROOT } from '../src/config.js';
import { makeAssetRoot, BUILD } from './helpers.js';

test('assets: the fixture mirror validates and reports the exact build', () => {
  const { root } = makeAssetRoot();
  const info = validateAssetRoot(root);
  assert.equal(info.build, BUILD);
  assert.equal(info.root, root);
});

test('assets: a root without launcher.html is refused', () => {
  const { root } = makeAssetRoot();
  rmSync(path.join(root, 'launcher.html'));
  assert.throws(() => validateAssetRoot(root), /launcher\.html/);
});

test('assets: a different build marker is refused (wrong client build)', () => {
  const { root } = makeAssetRoot();
  writeFileSync(path.join(root, 'launcher_player_flow.js'), "const BUILD='8b0b5899ed-replica-19990101-v9';");
  assert.throws(() => validateAssetRoot(root), /build/i);
});

test('assets: missing engine build directory is refused', () => {
  const { root } = makeAssetRoot();
  rmSync(path.join(root, 'b', '8b0b5899ed', 'game.wasm'));
  assert.throws(() => validateAssetRoot(root), /game\.wasm/);
});

test('assets: a path that is not a directory is refused', () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'gv-notdir-'));
  const file = path.join(dir, 'f.txt');
  writeFileSync(file, 'x');
  assert.throws(() => validateAssetRoot(file), /directory/i);
});

test('config: defaults are loopback 127.0.0.1:8097', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 8097);
  assert.equal(cfg.assetRoot, DEFAULT_ASSET_ROOT);
  assert.equal(cfg.publicOrigin, '');
});

test('config: PORT/ASSET_ROOT/PUBLIC_ORIGIN are read from the environment', () => {
  const cfg = loadConfig({
    PORT: '9123',
    ASSET_ROOT: '/srv/assets/mirror/playgta5.com',
    PUBLIC_ORIGIN: 'https://grandvmulti.royalnetwork.xyz',
  });
  assert.equal(cfg.port, 9123);
  assert.equal(cfg.assetRoot, '/srv/assets/mirror/playgta5.com');
  assert.equal(cfg.publicOrigin, 'https://grandvmulti.royalnetwork.xyz');
});

test('config: non-loopback HOST is refused (listener is loopback-only)', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /loopback/i);
  assert.throws(() => loadConfig({ HOST: '10.0.0.5' }), /loopback/i);
  assert.equal(loadConfig({ HOST: 'localhost' }).host, '127.0.0.1');
});

test('config: PUBLIC_ORIGIN must be a bare https origin', () => {
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://x.test/path' }), /origin/i);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'http://x.test' }), /https/i);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://u:p@x.test' }), /origin/i);
});

test('config: invalid PORT is refused', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
});
