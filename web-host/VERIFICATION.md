# VERIFICATION (web-host)

Date: 2026-10-30. Run in /opt/grand-v/web-host.

## npm test

    npm test  ->  tests 158, pass 158, fail 0, no warnings (MaxListenersExceededWarning fixed)

Files: store, config-assets, api, relay, relay-close (new: flood, idempotent close), batch
(test framing fixed with Buffer.byteLength; production readBody unchanged), static, lobby-capacity
(new: 20 min TTL, 4 h cap, reserved/connected counts), game-page (new: patch and injection; the real
mirror game.html and game.movie.html patterns are checked read-only), multiplayer-runtime (new:
mailbox and protocol tests with real WebAssembly.Memory and real pose_bridge.js; fake WebSocket only).

## Startup (actual process)

    ASSET_ROOT=/var/www/grandv/mirror/playgta5.com PORT=18097 node src/server.js

Responses observed:
- /__hostinfo 200 (build 8b0b5899ed-replica-20261009-v1)
- /game.html 200, runtime tag injected, multiplayer key admitted
- /game.movie.html 200 (63607 bytes)
- /__grandv/multiplayer-game.js 200
- /b/8b0b5899ed/game.wasm Range bytes=0-7: 206
- /.env 404
Server stopped with SIGINT; port 18097 closed afterwards.

Note: a different web-host process (PID 3568899, port 8097, started before this run) is still
listening. It was not started or stopped by this work.

## Not verified

- Browser run of the launcher adapter. No jsdom test was written; the original launcher keeps the
  multiplayer radio disabled (see README).
- Real relay with two browsers; WSS through Apache.
- Replica behaviour in the engine (runtime tests simulate engine completion).
- GPU/browser gates for the multiplayer build.
