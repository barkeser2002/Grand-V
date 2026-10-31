'use strict';
// FiveWeb desktop shell. Loads ONLY https://fiveweb.royalnetwork.xyz (plus packaged local pages).
// No local server, no remote module, no node integration in any renderer, no preload bridge.
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const policy = require('./policy.js');

const args = policy.parseArgs(process.argv);
const DEV = args.dev && !app.isPackaged;
const SMOKE = args.smoke;
const PAGES_DIR = path.join(__dirname, '..', 'pages');
const SMOKE_OUT = process.env.FIVEWEB_SMOKE_SCREENSHOT || '';
const SMOKE_TIMEOUT_MS = 45000;

let win = null;
let audioGranted = false;
let smokeTimer = null;
let smokeFailedLoad = false;

function pageUrl(name) {
  return require('node:url').pathToFileURL(path.join(PAGES_DIR, name)).toString();
}

function menuTemplate() {
  return [
    {
      label: 'FiveWeb',
      submenu: [
        { label: 'Yenile', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { type: 'separator' },
        { label: 'Tam ekran', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Hakkında', click: showAbout },
        { type: 'separator' },
        { label: 'Çıkış', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Yakınlaştır', role: 'zoomIn' },
        { label: 'Uzaklaştır', role: 'zoomOut' },
        { label: 'Varsayılan boyut', role: 'resetZoom' },
      ],
    },
  ];
}

function showAbout() {
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'FiveWeb hakkında',
    message: 'FiveWeb ' + app.getVersion(),
    detail: 'Sunucu tarayıcısı: ' + policy.APP_URL + '\nSürüm ' + app.getVersion() + ' · Electron ' + process.versions.electron,
    buttons: ['Tamam'],
  });
}

// Native prompt for audio capture. Resolves true only when the user clicks Allow.
async function askAudioPermission() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Mikrofon izni',
    message: 'FiveWeb sunucusu mikrofonunuza erişmek istiyor.',
    detail: 'Yalnızca sesli iletişim için kullanılır. Kamera erişimi verilmez. Oyun sunucusu ' +
      'bu erişimi yalnızca siz oyun içinde sesli iletişimi açtığınızda ister.',
    buttons: ['İzin ver', 'Reddet'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const decision = policy.decidePermission({
      permission,
      requestingUrl: details.requestingUrl || webContents.getURL(),
      isMainFrame: details.isMainFrame !== false,
      mediaTypes: details.mediaTypes,
      userGranted: audioGranted,
    });
    if (decision === 'allow') return callback(true);
    if (decision === 'prompt') {
      askAudioPermission().then((ok) => {
        audioGranted = ok;
        callback(ok);
      }, () => callback(false));
      return;
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return policy.checkPermission({
      permission,
      requestingOrigin,
      mediaType: details && details.mediaType,
      userGranted: audioGranted,
    });
  });
}

function guardContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (policy.isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const onNav = (event, url) => {
    if (policy.isAllowedNavigation(url, PAGES_DIR)) return;
    event.preventDefault();
    if (policy.isAllowedExternal(url)) shell.openExternal(url);
  };
  contents.on('will-navigate', onNav);
  contents.on('will-redirect', onNav);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('render-process-gone', () => loadLocal('error.html'));
}

function loadLocal(name) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(pageUrl(name)).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 390,
    minHeight: 640,
    title: 'FiveWeb',
    icon: path.join(__dirname, '..', 'build', policy.iconFileFor(process.platform)),
    backgroundColor: '#15161a',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: DEV,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  guardContents(win.webContents);
  hardenSession(win.webContents.session);

  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (user navigated away)
    if (url && url.startsWith('file:')) return;
    smokeFailedLoad = true;
    loadLocal('offline.html');
  });

  win.webContents.on('did-finish-load', () => {
    // Smoke passes on a packaged page (offline/error) or a clean FiveWeb load, never on
    // Chromium's own error interstitial, which keeps the https URL.
    const current = win && !win.isDestroyed() ? win.webContents.getURL() : '';
    if (!SMOKE || current.endsWith('loading.html')) return;
    if (current.startsWith('file:') || (policy.isTrustedAppUrl(current) && !smokeFailedLoad)) smokeCapture();
  });

  loadLocal('loading.html');
  win.loadURL(policy.APP_URL).catch(() => loadLocal('offline.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// --smoke: prove the window booted and rendered a packaged page, then exit. The screenshot is
// best effort (headless GPU stacks can refuse capturePage); the title and URL are always logged.
async function smokeCapture() {
  if (!win || win.isDestroyed() || smokeDone) return;
  smokeDone = true;
  clearTimeout(smokeTimer);
  const url = win.webContents.getURL();
  const title = win.webContents.getTitle();
  let bytes = 0;
  let captureNote = 'screenshot=none';
  for (let attempt = 1; attempt <= 3 && SMOKE_OUT; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      fs.writeFileSync(SMOKE_OUT, png);
      bytes = png.length;
      captureNote = 'screenshot=' + SMOKE_OUT;
      break;
    } catch (err) {
      captureNote = 'screenshot=failed(' + (err && err.message) + ')';
    }
  }
  console.log('FIVEWEB_SMOKE_OK url=' + url + ' title=' + JSON.stringify(title) + ' png_bytes=' + bytes + ' ' + captureNote);
  app.exit(0);
}
let smokeDone = false;

app.setName('FiveWeb');

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
    if (SMOKE) {
      smokeTimer = setTimeout(() => {
        console.error('FIVEWEB_SMOKE_FAIL timeout waiting for a page');
        app.exit(1);
      }, SMOKE_TIMEOUT_MS);
    }
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });
}

app.on('web-contents-created', (_event, contents) => {
  // Deny all renderer-initiated window creation globally as a second line of defence.
  contents.setWindowOpenHandler(({ url }) => {
    if (policy.isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Closing the window stops the app. No background process or local server is left behind.
app.on('window-all-closed', () => app.quit());

// Refuse any flag that would weaken Chromium security, even if passed by an outside caller.
app.on('certificate-error', (event, _webContents, _url, _err, _cert, callback) => {
  event.preventDefault();
  callback(false);
});

module.exports = { menuTemplate, hardenSession, guardContents };
