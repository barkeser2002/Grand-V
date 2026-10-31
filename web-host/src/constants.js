// Shared constants. BUILD must match the client build baked into the asset mirror
// (launcher_player_flow.js sends the same string in its check/join message).
export const BUILD = '8b0b5899ed-replica-20261009-v1';
export const PROTOCOL = 1;
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 128;
export const CAPACITY = 128;
export const HZ = 20;
export const SUPPORTED_MAPS = Object.freeze(['gta5', 'env_test']);
