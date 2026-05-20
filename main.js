'use strict';


const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { generateModel, getOpenSCADPath, getOpenSCADVersion } = require('./src/utils/openscadRunner');
const { checkForOpenSCADUpdate, downloadOpenSCADUpdate } = require('./src/utils/openscadUpdater');
const { patchBambu3mf } = require('./src/utils/bambu3mf');

const isDev = !app.isPackaged;

// ─── Paths ────────────────────────────────────────────────────────────────────

function getScadFilePath() {
  return isDev
    ? path.join(__dirname, 'resources', 'scad', 'nome_parametrico.scad')
    : path.join(process.resourcesPath, 'scad', 'nome_parametrico.scad');
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,         // LOW-5: prevent <webview> element entirely
      navigateOnDragDrop: false, // LOW-5: prevent drag-drop navigation
    },
    titleBarStyle: 'default',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // LOW-1: DevTools only when explicitly requested — avoids accidental shipping
    if (process.env.NAMEFORGE_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // LOW-5 + MISC-1: block renderer-initiated navigation — pin to exact allowed URL
  const allowedFileUrl = isDev
    ? null
    : require('url').pathToFileURL(path.join(__dirname, 'dist', 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:5173')
      : url === allowedFileUrl;
    if (!allowed) event.preventDefault();
  });

  // SEC-2: deny all new-window requests — allow only trusted domains in system browser.
  // Allowlist prevents a compromised renderer from navigating the user to phishing sites.
  const ALLOWED_EXTERNAL_HOSTS = new Set([
    'github.com', 'openscad.org', 'makerworld.com',
  ]);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(hostname)) {
        shell.openExternal(url);
      }
    } catch { /* malformed URL — deny */ }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// ── IPC input validation helpers ──────────────────────────────────────────────

const ALLOWED_FORMATS = new Set(['stl', '3mf']);

function sanitizeSuffix(raw) {
  // Allow only alphanumeric + underscore, max 32 chars
  return String(raw ?? 'output').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
}

function assertInTmpdir(filePath) {
  const tmp = fs.realpathSync(os.tmpdir());
  const norm = (p) => process.platform === 'win32' ? p.toLowerCase() : p;

  // LOW-2: Resolve parent dir (always exists) + validate basename separately.
  // Avoids path.resolve fallback on non-existent files which skips symlink resolution.
  const parent = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!base || base === '.' || base === '..' || /[/\\]/.test(base)) {
    throw new Error(`Invalid filename: ${base}`);
  }

  let resolved;
  try {
    // File exists — full realpathSync (resolves all symlinks including file itself)
    resolved = fs.realpathSync(filePath);
  } catch {
    // File not yet created — resolve parent (must exist) and reconstruct
    let resolvedParent;
    try { resolvedParent = fs.realpathSync(parent); }
    catch { resolvedParent = path.resolve(parent); }
    resolved = path.join(resolvedParent, base);
  }

  if (!norm(resolved).startsWith(norm(tmp) + path.sep) && norm(resolved) !== norm(tmp)) {
    throw new Error(`Access denied: path outside temp directory (${resolved})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Generate STL or 3MF
ipcMain.handle('generate-model', async (event, params, format = 'stl', suffix = 'output') => {
  try {
    // ── Input validation ───────────────────────────────────────────────────────
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('Invalid params: plain object expected');
    }
    // PP-1: strip prototype chain — prevents prototype-polluted props from leaking into generation
    const safeParams = Object.assign(Object.create(null), params);
    const safeFormat = String(format).toLowerCase();
    if (!ALLOWED_FORMATS.has(safeFormat)) {
      throw new Error(`Unsupported format: ${safeFormat}`);
    }
    const safeSuffix = sanitizeSuffix(suffix);

    const scadFile = getScadFilePath();

    if (!fs.existsSync(scadFile)) {
      const e = new Error(`SCAD file not found: ${scadFile}`);
      e.errorKey = 'errors.scadNotFound';
      throw e;
    }

    const openscadBin = getOpenSCADPath(app);
    if (!fs.existsSync(openscadBin)) {
      const e = new Error('OpenSCAD not found in resources. Run "npm run download-openscad".');
      e.errorKey = 'errors.openscadNotFound';
      throw e;
    }

    const safeSend = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };
    safeSend('generation-progress', { status: 'running', messageKey: 'status.generating' });

    const result = await generateModel(app, scadFile, safeParams, safeFormat, safeSuffix);

    safeSend('generation-progress', { status: 'done', messageKey: 'status.generated' });
    return { success: true, outputPath: result.outputPath };
  } catch (err) {
    if (!event.sender.isDestroyed()) event.sender.send('generation-progress', { status: 'error', message: err.message });
    return { success: false, error: err.message, errorKey: err.errorKey };
  }
});

// Read file as ArrayBuffer for Three.js — restricted to tmpdir
ipcMain.handle('read-file', async (event, filePath) => {
  assertInTmpdir(filePath);
  const buf = await fs.promises.readFile(filePath);
  // Return as plain ArrayBuffer (structured clone handles it)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// Save generated model to user-chosen location
ipcMain.handle('save-model', async (event, sourcePath, format, dialogTitle) => {
  // sourcePath must be within tmpdir (generated files only)
  assertInTmpdir(sourcePath);

  const safeFormat = String(format).toLowerCase();
  const ext = ALLOWED_FORMATS.has(safeFormat) ? safeFormat : 'stl';
  // Sanitize renderer-supplied title — strip control chars, clamp length
  const safeTitle = typeof dialogTitle === 'string'
    ? dialogTitle.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)
    : `Save ${ext.toUpperCase()} model`;

  if (!mainWindow) return { success: false, errorKey: 'errors.windowClosed' };

  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: safeTitle,
      defaultPath: `nameforge_model.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    await fs.promises.copyFile(sourcePath, filePath);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// OpenSCAD version info
ipcMain.handle('get-openscad-version', async () => {
  try {
    const version = await getOpenSCADVersion(app);
    return { success: true, version };
  } catch {
    return { success: false, version: null };
  }
});

// Check for newer OpenSCAD release
ipcMain.handle('check-openscad-update', async () => {
  try {
    const result = await checkForOpenSCADUpdate(app);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Hosts allowed as download sources at the IPC boundary
const ALLOWED_DOWNLOAD_HOSTS_IPC = new Set([
  'github.com', 'objects.githubusercontent.com',
  'releases.openscad.org', 'openscad.s3.amazonaws.com',
  'github-releases.githubusercontent.com',
]);

// Download updated OpenSCAD binary
ipcMain.handle('download-openscad-update', async (event, downloadUrl) => {
  // SEC-5: Validate URL at IPC boundary — reject non-HTTPS and untrusted hosts
  // before passing to internal functions. Defence-in-depth against renderer compromise.
  if (!downloadUrl || !String(downloadUrl).startsWith('https://')) {
    return { success: false, error: `Invalid or non-HTTPS URL: ${downloadUrl}` };
  }
  try {
    const { hostname } = new URL(String(downloadUrl));
    if (!ALLOWED_DOWNLOAD_HOSTS_IPC.has(hostname)) {
      return { success: false, error: `Unauthorized host: ${hostname}` };
    }
  } catch {
    return { success: false, error: `Malformed URL: ${downloadUrl}` };
  }
  try {
    const onProgress = (percent) => {
      if (!event.sender.isDestroyed()) event.sender.send('openscad-download-progress', { percent });
    };
    const result = await downloadOpenSCADUpdate(app, downloadUrl, onProgress);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open generated STL files directly in BambuStudio
ipcMain.handle('open-in-bambu', async (event, baseStlPath, nomeStlPath) => {
  // Common BambuStudio installation paths on Windows
  const candidates = [
    path.join('C:\\Program Files\\Bambu Studio', 'bambu-studio.exe'),
    path.join('C:\\Program Files\\BambuStudio', 'bambu-studio.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bambu Studio', 'bambu-studio.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'BambuStudio', 'bambu-studio.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'BambuStudio', 'bambu-studio.exe'),
  ];

  const bambuExeRaw = candidates.find((p) => fs.existsSync(p));
  if (!bambuExeRaw) {
    return { success: false, errorKey: 'errors.bambuNotFound' };
  }

  // LOW-3: Validate resolved exe path stays within trusted roots.
  // Prevents LOCALAPPDATA env-var poisoning from redirecting to an arbitrary binary.
  let bambuExe;
  try { bambuExe = fs.realpathSync(bambuExeRaw); }
  catch { bambuExe = path.resolve(bambuExeRaw); }
  // SEC-8: guard empty LOCALAPPDATA — empty string + path.sep = '\' alone,
  // which would match any UNC path (\\server\share\...) via startsWith.
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const trustedRoots = [
    'C:\\Program Files\\', 'C:\\Program Files (x86)\\',
    ...(localAppData ? [localAppData.replace(/[/\\]$/, '') + path.sep] : []),
  ];
  const normBambu = bambuExe.toLowerCase();
  if (!trustedRoots.some((r) => normBambu.startsWith(r.toLowerCase()))) {
    return { success: false, errorKey: 'errors.bambuPathSuspect' };
  }

  const args = [];
  let skipped = 0;
  for (const stlPath of [baseStlPath, nomeStlPath]) {
    if (!stlPath) continue;
    try { assertInTmpdir(stlPath); } catch { skipped++; continue; } // skip paths outside tmpdir
    if (fs.existsSync(stlPath)) args.push(stlPath);
    else skipped++;
  }

  if (args.length === 0) {
    return { success: false, errorKey: 'errors.bambuNoStl' };
  }

  try {
    const child = spawn(bambuExe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return {
      success: true,
      warning: skipped > 0 ? `${skipped} file(s) skipped — invalid path or not found` : undefined,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Patch 3MF with BambuStudio process settings (fuzzy skin, ironing)
ipcMain.handle('patch-3mf', async (event, filePath, settings) => {
  try {
    assertInTmpdir(filePath);
    // INFO-1: Type-clamp all settings at IPC boundary — renderer is untrusted.
    const safeSettings = {
      fuzzy_skin:               Boolean(settings?.fuzzy_skin),
      fuzzy_skin_thickness:     Math.min(10, Math.max(0, Number(settings?.fuzzy_skin_thickness)     || 0.3)),
      fuzzy_skin_point_distance: Math.min(10, Math.max(0, Number(settings?.fuzzy_skin_point_distance) || 0.8)),
      ironing_top:              Boolean(settings?.ironing_top),
    };
    // Yield to event loop before sync AdmZip I/O — avoids blocking main process
    await new Promise((resolve, reject) =>
      setImmediate(() => {
        try { patchBambu3mf(filePath, safeSettings); resolve(); }
        catch (e) { reject(e); }
      })
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// App auto-updater (electron-updater via GitHub Releases)
ipcMain.handle('check-app-update', async () => {
  if (isDev) return { success: false, message: 'Disabled in development' };
  try {
    const { autoUpdater } = require('electron-updater');
    // Register a silent error handler to prevent unhandled EventEmitter errors
    // from auto-update background events (download-error, update-error, etc.)
    if (autoUpdater.listenerCount('error') === 0) {
      autoUpdater.on('error', () => {}); // errors surfaced via checkForUpdates() rejection
    }
    const result = await autoUpdater.checkForUpdates();
    return { success: true, updateInfo: result?.updateInfo ?? null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // ── CSP (production only — dev uses Vite HMR which needs unsafe-inline) ──────
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self'",
              "font-src 'self'",
              "img-src 'self' data: blob:",
              "connect-src 'self' https://api.github.com https://github.com https://objects.githubusercontent.com https://releases.openscad.org",
              "frame-src 'none'",
              "worker-src 'none'",
              "object-src 'none'",
            ].join('; '),
          ],
        },
      });
    });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
