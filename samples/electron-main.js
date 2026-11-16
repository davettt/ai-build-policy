// Sample from the guidebook (MIT licence). It shows how I structure an Electron main process
// with loopback-only server and navigation guards; read it and adapt it to your project rather
// than copying it as is. See guide 6.3.
// Electron main process: a skeleton. The parts marked MANDATORY are the ones I
// check for in every app; the rest is structure you are expected to edit.

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MANDATORY. Loopback only, everywhere: the server's own
// listen() (server/index.js must call listen(port, '127.0.0.1', ...)), the URL
// the window loads, and the origin the guards compare against. Loopback is not
// enough on its own: the server must also reject a Host header that is not
// 127.0.0.1 or localhost (DNS rebinding), allow only exact origins in CORS, and
// refuse cross-site writes, because any web page the user visits can send
// requests to 127.0.0.1. Require a random per-launch token from the window on
// every API request too, so another process on the machine can't use the API.
const HOST = '127.0.0.1';

// MANDATORY. The server listens on port 0 and reports the port the OS gave it.
// Probing for a free port and binding it later leaves a gap in which another
// local process can take the port, and the window would then load its page.

// MANDATORY. Origin test by parsed origin, never by string prefix:
// url.startsWith(serverOrigin) also accepts http://127.0.0.1:<port>.evil.com,
// which would then load inside an app window.
function isAppUrl(url, serverOrigin) {
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false;
  }
}

// MANDATORY. Only web and mail links leave the app. shell.openExternal hands
// any scheme to the OS (file:, smb:, custom URL handlers). Validate stored URLs
// when they are saved as well: this is the last filter, not the only one.
function openExternalSafely(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      shell.openExternal(url);
    }
  } catch {
    // Unparseable URL: ignore.
  }
}

// External links go to the user's real browser, never to an Electron window.
// MANDATORY. Without these handlers Electron's default takes over and a
// target="_blank" link opens a new BrowserWindow: a Chromium window with no
// address bar, no back button, no bookmarks and no session shared with the
// browser the user actually uses.
//
// setWindowOpenHandler catches target="_blank" and window.open; will-navigate
// catches a plain in-page link that would otherwise replace the app's UI with a
// web page. Same-origin content (e.g. /api/report) opens in its own closable
// window, and that child gets the same guards via did-create-window — a child
// without them is a window that can navigate anywhere. If the app never needs a
// child window, deny them all instead.
function guardNavigation(contents, serverOrigin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url, serverOrigin)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 800,
          height: 700,
          minWidth: 480,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    openExternalSafely(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => {
    guardNavigation(child.webContents, serverOrigin);
  });

  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, serverOrigin)) {
      event.preventDefault();
      openExternalSafely(url);
    }
    // Same-origin navigation proceeds, which is right for the app's own routes
    // and wrong for a link to something like /api/report: give such links
    // target="_blank" so they get a closable window.
  });
}

// Set once at startup; every window uses the same server.
let serverOrigin = null;

// Bundled Express server, started once. startServer(0) must call listen(0, HOST)
// and resolve with server.address().port once it is listening. Adjust the path
// to match the project layout.
async function startAppServer() {
  const { startServer } = await import('./server/index.js');
  const port = await startServer(0);
  process.env.PORT = String(port);
  serverOrigin = `http://${HOST}:${port}`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // MANDATORY: no native module access from the renderer.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Sandboxed preload: require('electron') only; fs/path work goes to
      // main behind IPC.
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Native macOS title bar: do NOT set titleBarStyle.
  });

  // MANDATORY: the navigation guards above. Both handlers test the origin, and
  // they must agree. An unconditional
  // openExternal here looks right and is not: the app's own pages are reached
  // over the local server, so a target="_blank" link to something like
  // /api/report would be handed to the user's browser as
  // http://127.0.0.1:55714/api/report — a random port on localhost, showing
  // raw text, dead the moment the app quits. App content belongs in the app.
  guardNavigation(win.webContents, serverOrigin);

  win.loadURL(serverOrigin);
}

app.whenReady().then(async () => {
  await startAppServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // Reopen a window on the server that is already running; never start a second.
  if (serverOrigin && BrowserWindow.getAllWindows().length === 0) createWindow();
});
