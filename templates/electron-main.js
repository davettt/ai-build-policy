// Electron main process — canonical skeleton.
//
// Scaffolded by `policy scaffold` so a new app does not have to be assembled by
// copying whichever project happens to be nearby. The parts marked MANDATORY
// are checked by `policy check`; the rest is structure you are expected to edit.
//
// Adapted from the reference implementation named in
// project-standards § Stack Preferences → Electron Desktop Apps.

import { app, BrowserWindow } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MANDATORY. Bind to port 0, let the OS assign a free port, release it, then
// hand it to the server. A hardcoded port collides with the PM2 dev instance or
// any other local server, which silently connects the app to the wrong process
// and can corrupt data. `check` FAILs an Electron project with no findFreePort.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
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
      const socket = net.connect(port, '127.0.0.1');
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

  win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
