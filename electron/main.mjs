// Electron shell for the desktop app. Loads the bundled web build from disk (Base Edition or
// Demo, decided at package time), keeps the app offline and routes the PNG capture and CSV
// log downloads through a native save dialog. The simulator itself is unchanged.
import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const devDemo = !app.isPackaged && process.argv.includes('--demo');
const devPro = !app.isPackaged && process.argv.includes('--pro');

// Packaged builds carry their edition's web build in resources/web (see package.mjs). It sits
// outside app.asar so the system browser can also open it (Help > Open in Web Browser).
const webRoot = app.isPackaged ? join(process.resourcesPath, 'web') : join(here, '..', devDemo ? 'dist-demo' : devPro ? 'dist-pro' : 'dist');
const indexHtml = join(webRoot, 'index.html');

// Keep settings and controller mappings of the two editions apart when running unpackaged.
if (devDemo) app.setPath('userData', join(app.getPath('appData'), 'dronosim-demo'));
if (devPro) app.setPath('userData', join(app.getPath('appData'), 'dronosim-pro'));

const SAVE_FILTERS = {
  png: { name: 'PNG image', extensions: ['png'] },
  csv: { name: 'CSV flight log', extensions: ['csv'] },
};

let win = null;
let saveDir = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.on('closed', () => (win = null));

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault();
  });
  win.loadFile(indexHtml);
}

// Offline only: the page needs nothing beyond its own files and the blob: URLs it creates.
function blockNetwork(ses) {
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|blob|data|devtools):/i.test(details.url) }));
}

// Captures and logs are <a download> clicks on blob: URLs. Electron then shows its save dialog;
// this sets a sensible title, folder and file type, and remembers the last folder used.
function saveDownloadsWithDialog(ses) {
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename();
    const ext = extname(name).slice(1).toLowerCase();
    item.setSaveDialogOptions({
      title: ext === 'csv' ? 'Save flight log' : 'Save capture',
      defaultPath: join(saveDir || app.getPath('documents'), name),
      filters: SAVE_FILTERS[ext] ? [SAVE_FILTERS[ext]] : [],
    });
    item.once('done', (_e2, state) => {
      if (state === 'completed') saveDir = dirname(item.getSavePath());
    });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            // Official Electron builds have no OpenXR runtime, so VR headsets need Chrome or Edge.
            label: 'Open in Web Browser (for VR Headsets)',
            click: () => shell.openPath(indexHtml),
          },
        ],
      },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    if (!existsSync(indexHtml)) {
      dialog.showErrorBox('DronoSim', `Web build not found at ${webRoot}. Run "npm run build" first.`);
      app.quit();
      return;
    }
    blockNetwork(session.defaultSession);
    saveDownloadsWithDialog(session.defaultSession);
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
