// Dedicated named servers. Entries come from the operator-owned config/servers.json and
// persist across restarts and empty rooms. A server maps to at most ONE ephemeral relay
// room (a LobbyStore lobby) at a time. The room is created by the first join and reused
// by the second; when the last peer leaves, the store removes the lobby and the next join
// creates a fresh one. Capacity is the engine's real limit (CAPACITY = one remote replica).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILD, CAPACITY, MIN_CAPACITY, MAX_CAPACITY } from './constants.js';
import { LobbyError } from './lobbies.js';

export const COMPATIBILITY = 'fiveweb-js-v1';
export const SERVERS_CONFIG_FILE = fileURLToPath(new URL('../config/servers.json', import.meta.url));

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME_RE = /^[\p{L}\p{N} _.\-!?']{3,40}$/u;
const TAG_RE = /^[\p{L}\p{N} _\-]{1,24}$/u;
const RES_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ALLOWED_KEYS = ['id', 'name', 'description', 'tags', 'resources', 'capacity'];
const MAX_SERVERS = 50;
const MAX_TAGS = 8;
const MAX_RESOURCES = 16;
const MAX_DESCRIPTION = 300;

export class ServerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

const fail = (msg) => {
  throw new ServerConfigError(msg);
};

// Strict validation. Malformed or duplicate entries fail the whole config (fail closed).
export function parseServersConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('config must be a JSON object');
  if (!Array.isArray(raw.servers)) fail('config.servers must be an array');
  for (const key of Object.keys(raw)) if (key !== 'servers') fail(`unknown config field: ${key}`);
  if (raw.servers.length > MAX_SERVERS) fail(`too many servers (max ${MAX_SERVERS})`);
  const seen = new Set();
  const out = [];
  raw.servers.forEach((entry, i) => {
    const at = `servers[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`${at} must be an object`);
    for (const key of Object.keys(entry)) if (!ALLOWED_KEYS.includes(key)) fail(`${at}: unknown field ${key}`);
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) fail(`${at}: invalid id`);
    if (seen.has(entry.id)) fail(`duplicate server id: ${entry.id}`);
    seen.add(entry.id);
    const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ') : '';
    if (!NAME_RE.test(name)) fail(`${at}: invalid name`);
    const description = entry.description === undefined ? '' : entry.description;
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION || /[\u0000-\u001f]/.test(description)) {
      fail(`${at}: invalid description`);
    }
    const tags = entry.tags === undefined ? [] : entry.tags;
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) fail(`${at}: tags must be an array of at most ${MAX_TAGS}`);
    for (const tag of tags) if (typeof tag !== 'string' || !TAG_RE.test(tag)) fail(`${at}: invalid tag`);
    const resources = entry.resources === undefined ? [] : entry.resources;
    if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) fail(`${at}: invalid resources list`);
    const resSeen = new Set();
    for (const res of resources) {
      if (typeof res !== 'string' || !RES_RE.test(res)) fail(`${at}: invalid resource name`);
      if (resSeen.has(res)) fail(`${at}: duplicate resource ${res}`);
      resSeen.add(res);
    }
    const capacity = entry.capacity === undefined ? CAPACITY : entry.capacity;
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
      fail(`${at}: invalid capacity`);
    }
    out.push(
      Object.freeze({
        id: entry.id,
        name,
        description: description.trim(),
        capacity,
        tags: Object.freeze([...tags]),
        resources: Object.freeze([...resources]),
      }),
    );
  });
  return Object.freeze(out);
}

export function loadServersConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ServerConfigError(`cannot read servers config: ${err.code || err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new ServerConfigError('servers config is not valid JSON');
  }
  return parseServersConfig(raw);
}

export class ServerRegistry {
  // servers: parsed entries. store: LobbyStore. resources: Map name -> { name, version }.
  constructor({ servers, store, resources = new Map(), onEvent = () => {} }) {
    this.store = store;
    this.onEvent = onEvent;
    this.servers = new Map();
    this.rooms = new Map(); // serverId -> roomId (ephemeral)
    for (const s of servers) {
      for (const r of s.resources) {
        if (!resources.has(r)) fail(`server ${s.id} references unknown resource ${r}`);
      }
      this.servers.set(s.id, s);
    }
    this.resources = resources;
  }

  has(id) {
    return this.servers.has(id);
  }

  // Public list. Every configured server appears, even with no room.
  list() {
    const open = this.#openRooms();
    return [...this.servers.values()].map((s) => {
      const view = this.#viewFor(s.id, open);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        connected: view ? view.connected : 0,
        reserved: view ? view.reserved : 0,
        capacity: s.capacity,
        status: view && view.players >= s.capacity ? 'full' : 'online',
        tags: [...s.tags],
        resources: s.resources.map((r) => ({ name: r, version: this.resources.get(r).version })),
        voice: true,
        compatibility: COMPATIBILITY,
      };
    });
  }

  // Who is on a server right now (public names only).
  players(serverId) {
    const roomId = this.rooms.get(serverId);
    return roomId ? this.store.roster(roomId) : [];
  }

  // Public manifests of the resources bound to a server, or null when unknown.
  resourcesFor(id) {
    const s = this.servers.get(id);
    if (!s) return null;
    return s.resources.map((r) => this.resources.get(r));
  }

  // True when the resource is bound to this server (scope check for file serving).
  binds(serverId, resourceName) {
    const s = this.servers.get(serverId);
    return !!s && s.resources.includes(resourceName);
  }

  // First join creates the room (host seat); later joins reserve the second seat.
  // Both store calls are synchronous, so check-and-claim cannot interleave.
  join(serverId, nickname, profile = null) {
    const server = this.servers.get(serverId);
    if (!server) throw new LobbyError('NOT_FOUND', 404, 'Sunucu bulunamadı.');
    const roomId = this.rooms.get(serverId);
    const live = roomId ? this.store.listOpen().find((l) => l.id === roomId) : null;
    if (live) {
      let reserved;
      try {
        reserved = this.store.reserve(roomId, nickname, profile);
      } catch (err) {
        if (!(err instanceof LobbyError && err.code === 'NOT_FOUND')) throw err;
        return this.#createRoom(server, nickname, profile);
      }
      this.onEvent('server:join', { serverId, roomId, role: 'guest' });
      return this.#handoff(server, reserved.lobby, 'guest', reserved.credential, reserved.seatExpiresAt);
    }
    return this.#createRoom(server, nickname, profile);
  }

  #createRoom(server, nickname, profile) {
    const created = this.store.createLobby({ name: server.name, hostNickname: nickname, map: 'gta5', build: BUILD, capacity: server.capacity, hostProfile: profile });
    this.rooms.set(server.id, created.lobby.id);
    this.onEvent('server:roomCreated', { serverId: server.id, roomId: created.lobby.id });
    this.onEvent('server:join', { serverId: server.id, roomId: created.lobby.id, role: 'host' });
    return this.#handoff(server, created.lobby, 'host', created.credential, created.seatExpiresAt);
  }

  #handoff(server, lobby, role, credential, expiresAt) {
    return {
      lobby,
      session: { role, credential, expiresAt },
      launchPath: `/launcher.html?lobby=${lobby.id}&server=${server.id}`,
    };
  }

  #openRooms() {
    return new Map(this.store.listOpen().map((l) => [l.id, l]));
  }

  #viewFor(serverId, open) {
    const roomId = this.rooms.get(serverId);
    return roomId ? open.get(roomId) || null : null;
  }
}
