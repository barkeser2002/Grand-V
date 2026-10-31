# Grand-V web-host

Headless Node 22 backend for the Grand-V web build: lobby API, `/relay` pose relay, game asset
server (byte ranges, `/data/batch`, `/log`, COOP/COEP), and the launcher/game page adapters.

## Run

    cd /opt/grand-v/web-host
    npm ci
    ASSET_ROOT=/var/www/grandv/mirror/playgta5.com PORT=8097 PUBLIC_ORIGIN=https://grandvmulti.royalnetwork.xyz npm start

Environment:
- `ASSET_ROOT`: directory with launcher.html, game.html and b/8b0b5899ed/game.wasm (read only).
- `PORT` (default 8097), `HOST` (127.0.0.1 or localhost only).
- `PUBLIC_ORIGIN`: https origin without path. `ALLOWED_ORIGINS`: extra comma-separated origins.
- `TRUST_PROXY=1`: use the last `X-Forwarded-For` entry as the client IP for per-IP limits.
  Set only behind the reverse proxy.

The listener is loopback-only; the reverse proxy terminates TLS in front of it.

## Lobbies

- `POST /api/lobbies` creates a lobby (host seat). `POST /api/lobbies/:id/join` reserves a guest seat.
- A reservation (unclaimed seat) lives 20 minutes (`pendingTtlMs`), so a player can finish the
  large first game load. A `check` over the relay refreshes an unclaimed reservation.
- A lobby lives at most 4 hours from creation (`maxLobbyAgeMs`); active peers are closed at that point.
- Lobby view fields: `players` = occupied seats (reserved + connected, capacity 2),
  `reserved` = unclaimed seats, `connected` = live relay peers, `capacity`, `status`.

## Multiplayer client

- `GET /game.html` and `GET /game.movie.html` are served from disk with two in-memory changes
  (files are never written):
  1. The player whitelist keeps `multiplayer`, and keeps `poseproof=3` only for
     `mode=sandbox&multiplayer=1`. Without this the launcher's multiplayer URL lost both keys and
     the replica-capable build was never selected.
  2. `/__grandv/multiplayer-game.js` is injected before `</head>`.
  If a source pattern is missing, the original bytes are served and the event is logged.
- `public/multiplayer-game.js` defines `GTAMultiplayerGame.attach`. It consumes the
  `gta5.multiplayer.pending.v1` sessionStorage entry once (removed on read), accepts only a
  same-origin `ws`/`wss` relay, and joins with protocol 1, the build from `/__hostinfo`, room and key
  (the key travels only in the join frame).
- Local pose: `GTAPoseBridge.read` at 20 Hz, sent only after the world is ready.
  Remote replica: `GTAPoseBridge.command` opcode 1 (spawn) after the first valid remote pose,
  opcode 2 (move) when the previous command has finished, opcode 3 (remove) on peer leave, close or page exit.
- Status panel (`#grandv-mp-status`) shows connection and peer state only.

## Launcher multiplayer gate (authorized)

- Authorization: the owner explicitly asked to enable multiplayer. The original launcher's
  "future release" label and `disabled` flags on `#play-multiplayer`, `#mp-enable` and
  `#multiplayer-open` are removed by `public/launcher-adapter.js` (`/__grandv/launcher-adapter.js?v=lobby-2`).
  The note now reads "Deneysel · 2 oyuncu" (Experimental · 2 players). The source
  `launcher.html` on disk is not modified; the adapter is spliced in at serve time.
- Activation needs a valid lobby session: `?lobby=<id>` must match the stored session id, the
  credential must be well-formed, and `expiresAt` must be in the future. Then the adapter selects
  GTA V Sandbox and calls `GTAMultiplayerLaunch.applyPreferences({sameHost:true,room:session.id,enabled:true})`,
  and writes the credential into `#mp-key` and `#mp-access` last.
- Without a valid session the launcher stays singleplayer. Invalid or expired sessions show an
  error banner and do not enable anything. Only a multiplayer selection that was already on is cleared.
- The credential stays out of localStorage and the URL. Start writes `{url,room,key}` to
  sessionStorage (the existing pending-launch design) for the game page.
- Start still runs the original browser, secure-context, GPU and LAN-certificate checks in
  `launcher_player_flow.js`; they are not bypassed.
- Tests: `test/launcher-adapter.test.js` runs the real mirror `launcher.html`, `launcher.js`,
  `launcher_multiplayer.js`, `launcher_player_flow.js` and the adapter in jsdom. Platform stubs:
  `navigator.gpu`, `isSecureContext`, `crossOriginIsolated`, the user agent, `<dialog>` methods and
  the relay WebSocket (the check handshake only). These are DOM and gate tests, not gameplay tests.

## Limitations

- Rotation is not in the mailbox: `[0,0,0]` is sent and remote rotation is ignored. Rotation is not synchronized.
- The model field is sent as `0`. The replica command carries no model, so the replica uses the
  engine default. Remote `model` values are ignored.
- Only the pose of one other player is replicated (capacity 2). No vehicles, weapons, or game state.
- The pending launch has no timestamp; it is valid until the game page reads it. A reload after
  the read needs a new launch from the launcher.
- The runtime depends on the `/__hostinfo` build matching the lobby build.

## Tests

    npm test

Runtime tests use a real shared `WebAssembly.Memory` and the real `pose_bridge.js` from the mirror.
Only the WebSocket transport is faked and the engine's command completion is simulated. These are
mailbox and protocol tests, not gameplay verification.
