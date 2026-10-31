# FiveWeb Desktop

Dedicated Electron launcher for FiveWeb. The window loads only `https://fiveweb.royalnetwork.xyz`. The server browser is part of the web UI (`web-host/public`). The desktop app is a locked-down shell around it. Game assets stream from the server; the installer contains no game files.

## User install and launch

- Windows: download `FiveWeb-<version>-win-x64-portable.exe` (no install) or `FiveWeb-<version>-win-x64-setup.exe` (installer).
- Linux: run the AppImage or the `dist/linux-unpacked/fiveweb-desktop` binary.
- The app opens the FiveWeb server browser. There is no local server and no URL field. Closing the window stops the app.
- If the server cannot be reached, the app shows a packaged offline page with a "Tekrar dene" link. It never shows a blank page.

### Unsigned builds: Windows warnings

The builds are not code-signed. Windows SmartScreen may show "Windows bir uygulamayı korudu". Choose "Ek bilgi" and then "Yine de çalıştır" only if you trust the file source. Verify the SHA-256 of the file against the build log before running it.

## Requirements

- Windows 10 or 11, x64.
- Linux x64 (Ubuntu 22.04 or newer recommended). Unprivileged user namespaces must be allowed, or `chrome-sandbox` must be setuid root (standard Electron requirement). Do not start the app with `--no-sandbox`.
- A network connection to `fiveweb.royalnetwork.xyz` with a valid TLS certificate.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. No preload bridge, no remote module, no webview, no `ignore-certificate-errors`.
- Navigation is limited to the FiveWeb https origin and three packaged pages (`loading.html`, `offline.html`, `error.html`). Other URLs are denied.
- External links open in the system browser only for https hosts on the allowlist in `src/policy.js` (`github.com`, `royalnetwork.xyz`).
- No URL parameter, command-line URL, or deep link is accepted. Only `--dev` and `--smoke` are read.
- Permissions: everything is denied by default. Microphone (`audio` only) is granted only when all of these hold: trusted FiveWeb origin, main frame, and a native dialog answered "İzin ver". Camera and video are always denied. Notifications, geolocation, and other permissions are denied.
- DevTools are off. `--dev` (unpackaged runs only) opens them for local debugging.
- Chromium command-line flags: none are added. WebGPU is not toggled by this app. If a future build needs a WebGPU feature flag, document it here with the exact flag.

Voice chat is optional. The browser asks for the microphone only when a player turns on voice in a game session. The desktop app answers that request only through the dialog above.

## Build (developers)

    cd desktop-launcher
    npm ci                  # pinned: electron 45.1.0, electron-builder 26.18.0
    npm test                # pure policy tests (no Electron window)
    npm run build:dir       # Linux unpacked directory, output in dist/
    npm run smoke           # Electron launch, exits by itself (needs a display: xvfb-run -a npm run smoke)
    npm run build:win       # Windows portable + NSIS (run on Windows or in CI)

Smoke writes its screenshot to the path in `FIVEWEB_SMOKE_SCREENSHOT` when set. The smoke passes on a packaged page or a clean FiveWeb load. It fails if no page renders within 45 seconds.

Icons: `build/icon.png` (window and Linux) and `build/icon.ico` (Windows exe, installer, window) are copied from the FiveWeb brand files and packed into `app.asar`. Windows executable icon editing is enabled. No signing certificate is configured; CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. Windows execution and icon appearance still require a real Windows check.

Artifacts (`dist/`, `*.exe`, `*.AppImage`) are excluded from Git by the root `.gitignore`.

## CI

Workflow: `.github/workflows/fiveweb-build.yml`. Triggers: `workflow_dispatch` and push to `feat/fiveweb-platform` when `web-host/**`, `desktop-launcher/**`, or the workflow changes. Permissions: `contents: read`. No secrets, no signing, no release publish.

Jobs: web-host tests, desktop tests, Windows portable + NSIS build (artifact upload), Linux directory build + Xvfb smoke (screenshot artifact).

## Real build results (local, Linux x64, 2026-10-30)

- `web-host` `npm test`: 327 tests passed; `desktop-launcher` `npm test`: 15 passed.
- `npm run build:dir`: completed with exit code 0, including the FiveWeb icons.
- Packaged smoke (`dist/linux-unpacked/fiveweb-desktop --smoke` under Xvfb as an unprivileged user): exit 0. It loaded the live `https://fiveweb.royalnetwork.xyz/` page, title `FiveWeb · Sunucular`, and captured a 151,052-byte PNG.
- The new domain serves its valid TLS certificate. HTTP redirects to HTTPS; the old site root redirects to the new domain.
- A true 390px CDP viewport measured `innerWidth=390`, `scrollWidth=390`; no horizontal overflow. The icon crop and primary-button contrast were corrected and the packaged desktop screenshot inspected.
- Live HTTPS/WSS checks passed for server joins, capacity rejection, pose messages, voice signaling, authenticated TURN credentials and resource delivery. Browser-generated audio tones travelled bidirectionally over forced TURN relay; this is not a real microphone or full-game test.

Still unverified locally:
- Windows installer execution and Windows icon appearance; Windows builds run in CI.
- Linux AppImage packaging (the unpacked Linux application was built and run).
- Full GPU gameplay, two players seeing each other inside the engine, and real-user microphone conversations.

## Local setup notes (this machine only)

- Electron's `chrome-sandbox` was set to root-owned 4755 in `node_modules/electron/dist` and `dist/linux-unpacked` so the app could start as a non-root user. This is a host setting, not part of the repo.
