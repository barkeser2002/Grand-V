// Fail-closed check of the asset mirror: the server refuses to start unless the tree
// is the exact client build this backend speaks to.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BUILD } from './constants.js';

export function validateAssetRoot(rootInput) {
  const root = path.resolve(rootInput);
  let st;
  try {
    st = statSync(root);
  } catch (_) {
    throw new Error(`ASSET_ROOT does not exist: ${root}`);
  }
  if (!st.isDirectory()) throw new Error(`ASSET_ROOT must be a directory: ${root}`);

  for (const rel of ['launcher.html', 'launcher_player_flow.js', path.join('b', '8b0b5899ed', 'game.wasm')]) {
    if (!existsSync(path.join(root, rel))) {
      throw new Error(`ASSET_ROOT is incomplete: missing ${rel.split(path.sep).join('/')}`);
    }
  }

  const flow = readFileSync(path.join(root, 'launcher_player_flow.js'), 'utf8');
  const marker = /BUILD\s*=\s*['"]([^'"]+)['"]/.exec(flow);
  if (!marker) throw new Error('Asset build marker not found in launcher_player_flow.js');
  if (marker[1] !== BUILD) {
    throw new Error(`Asset build mismatch: expected ${BUILD}, found ${marker[1]}`);
  }
  return { root, build: BUILD };
}
