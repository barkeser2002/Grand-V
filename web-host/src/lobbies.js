// In-memory lobby registry. Every mutation is synchronous (no await inside), so the
// Node event loop makes check/join/reserve atomic with respect to each other.
// Seats: host and guest. A seat is 'pending' (reserved, not yet connected; expires),
// 'active' (connected relay peer), or 'offline' (peer dropped; held briefly for
// reconnection while another peer is still active). Credentials are stored only as
// SHA-256 digests and compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CAPACITY, MIN_CAPACITY, MAX_CAPACITY } from './constants.js';

export class LobbyError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'LobbyError';
    this.code = code;
    this.status = status;
  }
}

const digest = (credential) => createHash('sha256').update(String(credential), 'utf8').digest();
const newId = () => randomBytes(12).toString('base64url'); // 16 URL-safe chars
const newCredential = () => randomBytes(24).toString('base64url'); // 32 URL-safe chars
const iso = (ms) => new Date(ms).toISOString();

export class LobbyStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? 1_200_000; // 20 min: covers ~18 GB first load
    this.reconnectTtlMs = options.reconnectTtlMs ?? 45_000;
    this.maxLobbyAgeMs = options.maxLobbyAgeMs ?? 4 * 60 * 60 * 1000;
    this.maxLobbies = options.maxLobbies ?? 500;
    this.lobbies = new Map();
  }

  get size() {
    return this.lobbies.size;
  }

  getLobby(id) {
    return this.lobbies.get(id);
  }

  // Public names of the seats in a lobby: who is in game (active) and who is joining (pending).
  // Character name when the seat has one, otherwise the join nickname. No ids or credentials.
  roster(id) {
    this.#pruneAll();
    const lobby = this.lobbies.get(id);
    if (!lobby || !this.#live(id)) return [];
    const out = [];
    for (const seat of lobby.seats) {
      if (!seat || (seat.state !== 'active' && seat.state !== 'pending')) continue;
      const name = String((seat.profile && seat.profile.name) || seat.nickname || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
      if (name) out.push({ name, state: seat.state === 'active' ? 'playing' : 'joining' });
    }
    return out;
  }

  // Public, credential-free view of every live lobby.
  listOpen() {
    this.#pruneAll();
    return [...this.lobbies.values()].filter((l) => this.#live(l.id)).map((l) => this.#view(l));
  }

  createLobby({ name, hostNickname, map, build, capacity = MIN_CAPACITY, hostProfile = null }) {
    this.#pruneAll();
    if (this.lobbies.size >= this.maxLobbies) {
      throw new LobbyError('LIMIT', 503, 'Aktif lobi limiti doldu. Biraz sonra tekrar deneyin.');
    }
    const cap = Number.isInteger(capacity) && capacity >= MIN_CAPACITY && capacity <= MAX_CAPACITY ? capacity : MIN_CAPACITY;
    let id;
    do {
      id = newId();
    } while (this.lobbies.has(id));
    const credential = newCredential();
    const now = this.now();
    const lobby = {
      id,
      name,
      hostNickname,
      map,
      build,
      capacity: cap,
      createdAt: now,
      maxExpiresAt: now + this.maxLobbyAgeMs,
      seats: [
        {
          role: 'host',
          nickname: hostNickname,
          profile: hostProfile,
          hash: digest(credential),
          state: 'pending',
          expiresAt: now + this.pendingTtlMs,
          peer: null,
        },
      ],
    };
    this.lobbies.set(id, lobby);
    return { lobby: this.#view(lobby), credential, seatExpiresAt: iso(lobby.seats[0].expiresAt) };
  }

  reserve(id, nickname, profile = null) {
    const lobby = this.#live(id);
    if (!lobby) throw new LobbyError('NOT_FOUND', 404, 'Lobi bulunamadı veya süresi doldu.');
    const activeSeats = lobby.seats.filter(Boolean).length;
    if (activeSeats >= lobby.capacity) {
      throw new LobbyError('FULL', 409, `Bu lobi dolu (${lobby.capacity}/${lobby.capacity}).`);
    }
    const credential = newCredential();
    const seat = {
      role: 'guest',
      nickname,
      profile,
      hash: digest(credential),
      state: 'pending',
      expiresAt: this.now() + this.pendingTtlMs,
      peer: null,
    };
    const free = lobby.seats.indexOf(null);
    if (free >= 0) lobby.seats[free] = seat;
    else lobby.seats.push(seat);
    return { lobby: this.#view(lobby), credential, seatExpiresAt: iso(seat.expiresAt) };
  }

  // Looks a credential up inside its own lobby only. `touch` refreshes an unclaimed
  // reservation so a player who passed the check can still finish game loading.
  authenticate(id, credential, { touch = false } = {}) {
    if (typeof credential !== 'string' || credential === '') return null;
    const lobby = this.#live(id);
    if (!lobby) return null;
    const probe = digest(credential);
    for (const seat of lobby.seats) {
      if (seat && timingSafeEqual(seat.hash, probe)) {
        if (touch && seat.state === 'pending') seat.expiresAt = this.now() + this.pendingTtlMs;
        return { lobby, seat };
      }
    }
    return null;
  }

  claim(id, credential, peer) {
    const hit = this.authenticate(id, credential);
    if (!hit) throw new LobbyError('KEY', 403, 'Join key rejected');
    if (hit.seat.state === 'active') throw new LobbyError('ALREADY', 409, 'Session already connected');
    hit.seat.state = 'active';
    hit.seat.peer = peer;
    return hit.seat;
  }

  // A relay peer's socket closed. The seat is held for reconnection while another peer
  // remains; a lobby with no active peer and no pending reservation is removed.
  detach(id, peer) {
    const lobby = this.lobbies.get(id);
    if (!lobby) return { lobbyRemoved: true, remaining: [] };
    const seat = lobby.seats.find((s) => s && s.peer === peer);
    // Already released or expired: nothing to announce, so nobody gets a duplicate "left".
    if (!seat) return { lobbyRemoved: false, remaining: [] };
    seat.peer = null;
    seat.state = 'offline';
    seat.expiresAt = this.now() + this.reconnectTtlMs;
    const removed = this.#prune(lobby) === null;
    return { lobbyRemoved: removed, remaining: this.#activePeers(lobby) };
  }

  // A character may hold one seat at a time. Unclaimed (pending/offline) seats of the same
  // character are dropped so a retried launch works; an active one is reported.
  dropProfile(characterId) {
    let active = false;
    for (const lobby of [...this.lobbies.values()]) {
      for (let i = 0; i < lobby.seats.length; i++) {
        const seat = lobby.seats[i];
        if (!seat || !seat.profile || seat.profile.characterId !== characterId) continue;
        if (seat.state === 'active') { active = true; continue; }
        seat.state = 'released';
        lobby.seats[i] = null;
      }
      this.#prune(lobby);
    }
    return { active };
  }

  // Characters currently connected through the relay (for paychecks).
  activeProfiles() {
    const out = [];
    for (const lobby of this.lobbies.values()) {
      for (const seat of lobby.seats) if (seat && seat.state === 'active' && seat.profile) out.push(seat.profile);
    }
    return out;
  }

  // Explicit release by the credential holder (launcher cancelled, host closed lobby).
  release(id, credential) {
    const hit = this.authenticate(id, credential);
    if (!hit) return { released: false, peer: null, remaining: [], lobbyRemoved: false };
    const { lobby, seat } = hit;
    const peer = seat.state === 'active' ? seat.peer : null;
    lobby.seats[lobby.seats.indexOf(seat)] = null;
    seat.peer = null;
    seat.state = 'released';
    const remaining = this.#activePeers(lobby);
    const removed = this.#prune(lobby) === null;
    return { released: true, peer, remaining, lobbyRemoved: removed };
  }

  // Expires reservations and lobbies. Returns active peers whose lobby reached its
  // absolute maximum age, so the relay can close them.
  sweep() {
    const now = this.now();
    const peers = [];
    const lobbyIds = [];
    for (const lobby of [...this.lobbies.values()]) {
      if (now >= lobby.maxExpiresAt) {
        for (const seat of lobby.seats) {
          if (seat && seat.state === 'active' && seat.peer) peers.push(seat.peer);
          if (seat) seat.state = 'released';
        }
        lobbyIds.push(lobby.id);
        this.lobbies.delete(lobby.id);
      } else {
        this.#prune(lobby);
      }
    }
    return { peers, lobbyIds };
  }

  #live(id) {
    const lobby = this.lobbies.get(id);
    if (!lobby) return null;
    if (this.now() >= lobby.maxExpiresAt) return null;
    return this.#prune(lobby) ? lobby : null;
  }

  // Drops expired non-active seats; deletes the lobby when nothing can still connect.
  // Returns the lobby if it survives, otherwise null (after deleting it).
  #prune(lobby) {
    const now = this.now();
    for (let i = 0; i < lobby.seats.length; i++) {
      const seat = lobby.seats[i];
      if (seat && seat.state !== 'active' && seat.expiresAt <= now) {
        seat.state = 'released';
        lobby.seats[i] = null;
      }
    }
    const alive = lobby.seats.some((s) => s && (s.state === 'active' || s.state === 'pending'));
    if (!alive) {
      this.lobbies.delete(lobby.id);
      return null;
    }
    return lobby;
  }

  #pruneAll() {
    for (const lobby of [...this.lobbies.values()]) {
      if (this.now() >= lobby.maxExpiresAt) this.lobbies.delete(lobby.id);
      else this.#prune(lobby);
    }
  }

  #activePeers(lobby) {
    return lobby.seats.filter((s) => s && s.state === 'active' && s.peer).map((s) => s.peer);
  }

  #view(lobby) {
    const players = lobby.seats.filter(Boolean).length;
    const connected = lobby.seats.filter((s) => s && s.state === 'active').length;
    return {
      id: lobby.id,
      name: lobby.name,
      hostNickname: lobby.hostNickname,
      map: lobby.map,
      build: lobby.build,
      players,
      reserved: players - connected,
      connected,
      capacity: lobby.capacity,
      status: players >= lobby.capacity ? 'full' : 'open',
      createdAt: new Date(lobby.createdAt).toISOString(),
      expiresAt: new Date(lobby.maxExpiresAt).toISOString(),
    };
  }
}
