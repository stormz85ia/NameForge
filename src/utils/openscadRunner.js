'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Binary detection ─────────────────────────────────────────────────────────

function getOpenSCADBinaryName() {
  if (process.platform === 'win32') return 'openscad.exe';
  if (process.platform === 'darwin') return 'OpenSCAD.app/Contents/MacOS/OpenSCAD';
  return 'openscad';
}

function getOpenSCADDir(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'openscad')
    : path.join(__dirname, '..', '..', 'resources', 'openscad');
}

function getOpenSCADPath(app) {
  return path.join(getOpenSCADDir(app), getOpenSCADBinaryName());
}

function getFontsPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(__dirname, '..', '..', 'resources', 'fonts');
}

// ─── Version ──────────────────────────────────────────────────────────────────

async function getOpenSCADVersion(app) {
  const versionFile = path.join(getOpenSCADDir(app), 'VERSION');
  if (fs.existsSync(versionFile)) {
    // Async read — avoid blocking the event loop
    const content = await fs.promises.readFile(versionFile, 'utf8');
    return content.trim();
  }

  // Fallback: ask the binary itself
  return new Promise((resolve, reject) => {
    const bin = getOpenSCADPath(app);
    if (!fs.existsSync(bin)) {
      reject(new Error('OpenSCAD binary not found'));
      return;
    }
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        // OpenSCAD --version writes to stderr
        const match = (stderr || '').match(/OpenSCAD version (\S+)/);
        if (match) resolve(match[1]);
        else reject(new Error('Cannot determine version'));
      } else {
        const match = (stdout || stderr || '').match(/OpenSCAD version (\S+)/);
        resolve(match ? match[1] : 'unknown');
      }
    });
  });
}

// ─── Param serialisation ──────────────────────────────────────────────────────

// Whitelist of all SCAD variable names this app passes via -D.
// Any key not in this set is silently dropped — prevents CLI flag injection.
const ALLOWED_SCAD_KEYS = new Set([
  'nome', 'font_base', 'font_corsivo', 'iniziale_maiuscola',
  'mostra_base', 'mostra_nome',
  'altezza_base', 'profondita_incisione', 'dimensione_lettera', 'dimensione_nome',
  'altezza_nome_solido', 'offset_nome_x', 'offset_nome_y', 'tolleranza',
  'margine_taglio', 'taglio_base', 'colore_base', 'colore_nome',
  'nome_preview_z', 'incidi_preview', 'chanfrein_haut_mm', 'layer_height',
]);

// Keys whose values are already-formatted OpenSCAD vectors ("[r,g,b]")
// and must be passed without extra quoting. Explicit set — not guessed from value shape.
const VECTOR_SCAD_KEYS = new Set(['colore_base', 'colore_nome']);

// Key must match valid OpenSCAD identifier pattern — extra defence-in-depth
const SAFE_KEY_RE = /^[a-z_][a-z0-9_]*$/i;

function paramsToCLIArgs(params) {
  const args = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;

    // ── Security: drop unknown or syntactically invalid keys ─────────────────
    if (!ALLOWED_SCAD_KEYS.has(key) || !SAFE_KEY_RE.test(key)) continue;

    if (typeof value === 'string') {
      // Vector keys (colore_base/nome) carry pre-formatted "[r,g,b]" from hexToVec.
      // Use an explicit allowlist — never guess from value shape to avoid injection.
      if (VECTOR_SCAD_KEYS.has(key)) {
        // MEDIUM-1: Server-side format validation — renderer could send arbitrary string.
        // Must be exactly "[float,float,float]" — no other content allowed.
        if (!/^\[\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?\]$/.test(value)) continue;
        args.push('-D', `${key}=${value}`);
      } else {
        // Escape backslashes then double quotes inside the string
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        args.push('-D', `${key}="${escaped}"`);
      }
    } else if (typeof value === 'boolean') {
      // OpenSCAD 2021 : utiliser 1/0 — plus fiable que true/false via -D
      args.push('-D', `${key}=${value ? 1 : 0}`);
    } else {
      // SEC-3: Drop non-finite numbers (Infinity, NaN) — OpenSCAD rejects them and
      // they could produce unexpected CLI output if stringified as "Infinity"/"NaN".
      if (!Number.isFinite(value)) continue;
      args.push('-D', `${key}=${value}`);
    }
  }
  return args;
}

// ─── Font config ─────────────────────────────────────────────────────────────

// OpenSCAD 2021.01 stable does NOT support --font-path CLI flag (added in later
// dev snapshots). Instead we generate a temporary fontconfig file that:
//   1. Includes the bundled OpenSCAD fonts.conf (Liberation etc.)
//   2. Adds our custom Google Fonts directory
// Passed via FONTCONFIG_FILE env var, which fontconfig reads at startup.
// Cached per-process: fonts don't change at runtime, no need to re-write each call.
// MISC-5: session-unique filename — prevents other processes predicting/overwriting the file.
const _fontconfigSessionId = require('crypto').randomBytes(8).toString('hex');
let _fontconfigCache = null;

async function buildFontconfigFile(app) {
  if (_fontconfigCache) return _fontconfigCache;
  const ourFontsPath   = getFontsPath(app);
  const scadFontsPath  = path.join(getOpenSCADDir(app), 'fonts');
  const bundledConf    = path.join(scadFontsPath, 'fonts.conf');

  if (!fs.existsSync(ourFontsPath)) return null;

  // XML-1: Escape XML entities then validate path stays within expected roots.
  // Defence-in-depth: paths are internal (resourcesPath/tmpdir) but could contain
  // special chars if username/profile path has & < > etc.
  const escapeXml = (s) => s
    .replace(/&/g, '&amp;')   // must be first
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const toFC = (p) => escapeXml(p.replace(/\\/g, '/'));

  // Validate paths are within expected roots — prevents construction XML with
  // unexpected dirs even if internal helpers somehow return a bad path.
  // SEC-7: append path.sep to each root — prevents "/tmp/foo" matching "/tmp/foobar".
  const trustedRoots = [
    path.resolve(getOpenSCADDir(app)) + path.sep,
    path.resolve(getFontsPath(app))   + path.sep,
    path.resolve(os.tmpdir())         + path.sep,
  ];
  const assertTrusted = (p) => {
    const abs = path.resolve(p);
    // Allow exact match (path IS the root) or prefix match with separator
    if (!trustedRoots.some((r) => abs === r.slice(0, -1) || abs.startsWith(r))) {
      throw new Error(`Unauthorized fontconfig path: ${abs}`);
    }
  };
  assertTrusted(ourFontsPath);
  assertTrusted(os.tmpdir());
  if (fs.existsSync(bundledConf)) assertTrusted(bundledConf);

  const includeBlock = fs.existsSync(bundledConf)
    ? `  <include>${toFC(bundledConf)}</include>\n`
    : '';

  const xml = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    includeBlock,
    `  <dir>${toFC(ourFontsPath)}</dir>`,
    `  <cachedir>${toFC(os.tmpdir())}</cachedir>`,
    '</fontconfig>',
  ].join('\n');

  const confPath = path.join(os.tmpdir(), `nameforge_fonts_${_fontconfigSessionId}.conf`);
  await fs.promises.writeFile(confPath, xml, 'utf8');
  _fontconfigCache = confPath;
  return confPath;
}

// ─── Main generator ───────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB cap — prevent OOM on verbose output

async function generateModel(app, scadFile, params, format = 'stl', suffix = 'output') {
  const bin = getOpenSCADPath(app);
  const outputPath = path.join(os.tmpdir(), `nameforge_${suffix}.${format}`);

  const paramArgs = paramsToCLIArgs(params);
  const fontconfigFile = await buildFontconfigFile(app);

  // No --font-path: not supported in OpenSCAD 2021.01 stable.
  // Fonts are injected via FONTCONFIG_FILE instead.
  const args = [
    ...paramArgs,
    '-o', outputPath,
    scadFile,
  ];

  return new Promise((resolve, reject) => {
    let stderr = '';
    // PERF-3: stdout drained without buffering (proc.stdout.resume() below).
    // stderr captures all OpenSCAD diagnostic output; stdout is rarely populated.

    // settled flag — prevents double resolution if both 'error' and 'close' fire
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };
    const safeResolve = settle(resolve);
    const safeReject  = settle(reject);

    // Pass only the env vars OpenSCAD needs — avoids leaking secrets from parent env.
    // PATH is required for shared libs on Linux/macOS; SystemRoot/TEMP on Windows.
    const safeEnv = {
      PATH:        process.env.PATH        ?? '',
      HOME:        process.env.HOME        ?? '',         // macOS/Linux font lookup
      SystemRoot:  process.env.SystemRoot  ?? '',         // Windows shared libs
      TEMP:        process.env.TEMP        ?? '',         // Windows tmpdir
      TMP:         process.env.TMP         ?? '',
      TMPDIR:      process.env.TMPDIR      ?? '',         // macOS/Linux tmpdir
      DISPLAY:     process.env.DISPLAY     ?? '',         // Linux X11 (headless not needed for --export)
      // Custom fontconfig: tells OpenSCAD/fontconfig where our bundled fonts live.
      ...(fontconfigFile ? { FONTCONFIG_FILE: fontconfigFile } : {}),
    };

    const proc = spawn(bin, args, { env: safeEnv });

    // Force-kill after 120 s — SIGKILL on Unix, taskkill /F on Windows
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && proc.pid) {
        execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], () => {});
      } else {
        proc.kill('SIGKILL');
      }
      const timeoutErr = new Error('OpenSCAD timeout (120 s)');
      timeoutErr.errorKey = 'errors.openscadTimeout';
      safeReject(timeoutErr);
    }, 120_000);

    // PERF-3: stdout drained but not stored — OpenSCAD writes nothing useful there for export.
    // Must attach a listener to prevent the stream from pausing and blocking the process.
    proc.stdout.resume();
    proc.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      safeReject(new Error(`OpenSCAD spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        safeResolve({ success: true, outputPath });
      } else {
        // LOG-1: strip ANSI escape sequences and \r before embedding in error message
        const raw = stderr.slice(0, 500);
        const detail = raw
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // strip ANSI codes
          .replace(/\r/g, '');                     // normalize line endings
        safeReject(new Error(`OpenSCAD failed (code ${code}): ${detail}`));
      }
    });
  });
}

module.exports = { generateModel, getOpenSCADPath, getOpenSCADVersion };
