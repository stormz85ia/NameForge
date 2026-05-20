#!/usr/bin/env node
// Dev script: downloads portable OpenSCAD into resources/openscad/
// Usage: node scripts/download-openscad.js [--version 2024.05.12]

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { execSync, execFileSync } = require('child_process');

const pipelineAsync = promisify(pipeline);

const DEST_DIR = path.join(__dirname, '..', 'resources', 'openscad');
const GITHUB_API = 'https://api.github.com/repos/openscad/openscad/releases/latest';
const USER_AGENT = 'NameForge-setup/1.0';

// ─── Platform config ──────────────────────────────────────────────────────────

const PLATFORM_CONFIG = {
  win32: {
    assetMatch: (name) => name.endsWith('.zip') && name.includes('x86-64'),
    binary: 'openscad.exe',
    extractFn: extractZipWindows,
  },
  darwin: {
    assetMatch: (name) => name.endsWith('.dmg'),
    binary: 'OpenSCAD.app/Contents/MacOS/OpenSCAD',
    extractFn: extractDmgMac,
  },
  linux: {
    assetMatch: (name) => name.endsWith('.AppImage'),
    binary: 'openscad',
    extractFn: copyAppImage,
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const platform = process.platform;
  const config = PLATFORM_CONFIG[platform];

  if (!config) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  console.log(`\n🔍 Fetching latest OpenSCAD version…`);
  const release = await fetchJson(GITHUB_API);

  // Null safety — GitHub API may return unexpected shapes
  if (!release || !release.tag_name) {
    console.error('❌ Invalid GitHub API response (missing tag_name)');
    process.exit(1);
  }
  if (!Array.isArray(release.assets)) {
    console.error('❌ Invalid GitHub API response (missing assets)');
    process.exit(1);
  }

  const version = release.tag_name.replace(/^v/, '');
  console.log(`   Version : ${version}`);

  const asset = release.assets.find((a) => config.assetMatch(a.name));
  if (!asset) {
    console.error(`❌ No asset found for ${platform} in the release.`);
    console.error('   Available assets:');
    release.assets.forEach((a) => console.error(`   - ${a.name}`));
    process.exit(1);
  }

  console.log(`📦 Asset : ${asset.name}`);

  const tmpFile = path.join(os.tmpdir(), asset.name);
  console.log(`⬇️  Downloading → ${tmpFile}`);
  await downloadFile(asset.browser_download_url, tmpFile);

  fs.mkdirSync(DEST_DIR, { recursive: true });

  // CHECKSUM-1: Compute and log SHA256 of downloaded file.
  // OpenSCAD releases don't publish signed checksums, so we can't auto-verify,
  // but logging the hash lets users/auditors confirm integrity manually.
  const sha256 = await computeSHA256(tmpFile);
  console.log(`🔑 SHA256 : ${sha256}`);
  console.log(`   (verify manually at https://openscad.org/downloads.html if available)`);

  console.log(`📂 Extraction → ${DEST_DIR}`);
  await config.extractFn(tmpFile, DEST_DIR, config.binary);

  // MAINT-7: Post-extraction sanity check — verify binary exists and is non-zero.
  // Guards against silent extraction failures (corrupt archive, partial download).
  const extractedBin = path.join(DEST_DIR, config.binary);
  if (!fs.existsSync(extractedBin)) {
    console.error(`❌ Binary not found after extraction: ${extractedBin}`);
    process.exit(1);
  }
  const binStat = fs.statSync(extractedBin);
  if (binStat.size === 0) {
    console.error(`❌ Extracted binary is empty (0 bytes): ${extractedBin}`);
    process.exit(1);
  }
  console.log(`   Binary verified: ${binStat.size.toLocaleString()} bytes`);

  // Write version file
  fs.writeFileSync(path.join(DEST_DIR, 'VERSION'), version, 'utf8');

  console.log(`\n✅ OpenSCAD ${version} installed in resources/openscad/`);
  console.log(`   Binaire : ${path.join(DEST_DIR, config.binary)}\n`);
}

// ─── Extract functions ────────────────────────────────────────────────────────

async function extractZipWindows(zipFile, destDir) {
  // Use PowerShell Expand-Archive (available on Win10+)
  const tmpExtract = path.join(os.tmpdir(), 'openscad_extracted');
  fs.mkdirSync(tmpExtract, { recursive: true });

  console.log('   Extraction ZIP via PowerShell…');
  // MISC-3: pass paths via env vars — no quoting/injection risk regardless of path content
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:NF_ZIP -DestinationPath $env:NF_DEST -Force',
  ], {
    stdio: 'inherit',
    env: { ...process.env, NF_ZIP: zipFile, NF_DEST: tmpExtract },
  });

  try {
    // Find the openscad.exe inside extracted dir (may be in a subdirectory)
    const exePath = findFile(tmpExtract, 'openscad.exe');
    if (!exePath) {
      throw new Error('openscad.exe introuvable dans le ZIP');
    }

    const exeDir = path.dirname(exePath);
    console.log(`   Copie depuis ${exeDir}`);

    // Copy all files from the openscad directory
    copyDirContents(exeDir, destDir);
  } finally {
    // Always clean up the temp extraction directory
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function extractDmgMac(dmgFile, destDir) {
  console.log('   Montage DMG…');
  const mountPoint = path.join(os.tmpdir(), 'openscad_dmg');
  // Use execFileSync with args array — no shell string interpolation (avoids injection)
  execFileSync('hdiutil', ['attach', dmgFile, '-mountpoint', mountPoint, '-quiet']);

  try {
    const appPath = path.join(mountPoint, 'OpenSCAD.app');
    const destApp = path.join(destDir, 'OpenSCAD.app');

    console.log(`   Copie OpenSCAD.app → ${destApp}`);
    execFileSync('cp', ['-R', appPath, destApp]);
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet']);
  }
}

async function copyAppImage(appImageFile, destDir) {
  const dest = path.join(destDir, 'openscad');
  fs.copyFileSync(appImageFile, dest);
  fs.chmodSync(dest, 0o755);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// CHECKSUM-1: Stream-based SHA256 — no full file in memory
function computeSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}



const MAX_API_BYTES = 1 * 1024 * 1024; // 1MB — consistent with openscadUpdater.js

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain to free socket
          return reject(new Error(`GitHub API HTTP ${res.statusCode} pour ${url}`));
        }
        const chunks = [];
        let totalBytes = 0;
        res.on('data', (c) => {
          totalBytes += c.length;
          if (totalBytes > MAX_API_BYTES) {
            res.destroy(new Error('GitHub API response too large (> 1MB)'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`GitHub API non-JSON response: ${e.message}`));
          }
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// MEDIUM-2: 500 MB cap on binary downloads (OpenSCAD installer ~70 MB)
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

async function downloadFile(url, dest) {
  const res = await followHttpsRedirects(url);

  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0;
  let lastPct = -1;

  res.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_DOWNLOAD_BYTES) {
      res.destroy(new Error('Download too large (> 500 MB) — aborting'));
      return;
    }
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`\r   Progression : ${pct}%`);
        lastPct = pct;
      }
    }
  });

  // stream.pipeline handles backpressure and closes the WriteStream properly
  await pipelineAsync(res, fs.createWriteStream(dest));
  process.stdout.write('\n');
}

// SEC-4: Host allowlist — redirect chains must stay on trusted domains.
// Same rationale as openscadUpdater.js ALLOWED_DOWNLOAD_HOSTS.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'releases.openscad.org',
  'openscad.s3.amazonaws.com',
  'github-releases.githubusercontent.com',
]);

function assertAllowedDownloadHost(url) {
  let hostname;
  try { hostname = new URL(url).hostname; }
  catch { throw new Error(`Invalid redirect URL: ${url}`); }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(hostname)) {
    throw new Error(`Unauthorized redirect host: ${hostname}`);
  }
}

// Follow HTTPS-only redirects, return the response stream of the final URL
function followHttpsRedirects(url, redirectCount = 0, MAX_REDIRECTS = 5) {
  if (!url || !String(url).startsWith('https://')) {
    return Promise.reject(new Error(`Non-HTTPS redirect rejected: ${url}`));
  }
  try { assertAllowedDownloadHost(url); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume(); // drain to release socket
          if (redirectCount >= MAX_REDIRECTS) {
            return reject(new Error(`Trop de redirections (max ${MAX_REDIRECTS})`));
          }
          return resolve(followHttpsRedirects(res.headers.location, redirectCount + 1, MAX_REDIRECTS));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

function findFile(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

function copyDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n❌ Erreur :', err.message);
  process.exit(1);
});
