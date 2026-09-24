// Electron main process — canonical skeleton.
//
// Scaffolded by `policy scaffold` so a new app does not have to be assembled by
// copying whichever project happens to be nearby. The parts marked MANDATORY
// are checked by `policy check`; the rest is structure you are expected to edit.
//
// Adapted from the reference implementation named in
// project-standards § Stack Preferences → Electron Desktop Apps.

import { app, BrowserWindow, shell } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MANDATORY. Loopback only, everywhere: the probe below, the server's own
// listen() (server/index.js must call listen(port, '127.0.0.1', ...)), the URL
// the window loads, and the origin the guards compare against. The local API has
// no authentication, so a server listening on every interface is readable and
// writable by anyone on the same Wi-Fi. `check` FAILs a listen() without a
// loopback host (project-standards § Network Exposure).
const HOST = '127.0.0.1';

// MANDATORY. Bind to port 0, let the OS assign a free port, release it, then
// hand it to the server. A hardcoded port collides with the PM2 dev instance or
// any other local server, which silently connects the app to the wrong process
// and can corrupt data. `check` FAILs an Electron project with no findFreePort.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, HOST, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForServer(port, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      const socket = net.connect(port, HOST);
      socket.on('connect', () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (++attempts >= maxAttempts) reject(new Error('server did not start'));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

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
// any scheme to the OS (file:, smb:, custom URL handlers), and many of these
// apps store URLs the user typed in, so this is the only filter they pass.
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
// web page. Same-origin content (e.g. /api/licenses) opens in its own closable
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
          webPreferences: { nodeIntegration: false, contextIsolation: true },
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
    // and wrong for a link to something like /api/licenses: give such links
    // target="_blank" so they get a closable window.
  });
}

async function createWindow() {
  const port = await findFreePort();
  process.env.PORT = String(port);

  // Bundled Express server. Adjust the path to match the project layout.
  const { startServer } = await import('../server/index.js');
  await startServer(port);
  await waitForServer(port);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // MANDATORY: no native module access from the renderer.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Native macOS title bar: do NOT set titleBarStyle.
  });

  // External links go to the user's real browser, never to an Electron window.
  // MANDATORY. Without these two handlers Electron's default takes over and a
  // target="_blank" link opens a new BrowserWindow: a Chromium window with no
  // address bar, no back button, no bookmarks and no session shared with the
  // browser the user actually uses. They cannot see where they are, and a
  // shipped app has no business rendering the open web inside itself.
  //
  // Two handlers because they cover different events. setWindowOpenHandler
  // catches target="_blank" and window.open; will-navigate catches a plain
  // in-page link that would otherwise replace the app's own UI with a web page
  // and strand the user with no way back.
  // Both handlers test the origin, and they must agree. An unconditional
  // openExternal here looks right and is not: the app's own pages are reached
  // over the local server, so a target="_blank" link to something like
  // /api/licenses would be handed to the user's browser as
  // http://127.0.0.1:55714/api/licenses — a random port on localhost, showing
  // raw text, dead the moment the app quits. App content belongs in the app.
  const serverOrigin = `http://${HOST}:${port}`;
  guardNavigation(win.webContents, serverOrigin);

  win.loadURL(serverOrigin);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
