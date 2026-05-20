'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nameforge', {
  // Generate STL/3MF via OpenSCAD
  // Basic type guard at preload boundary — second layer of defence before main process
  generateModel: (params, format = 'stl', suffix = 'output') => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return Promise.reject(new Error('[preload] params must be a plain object'));
    }
    return ipcRenderer.invoke('generate-model', params, format, suffix);
  },

  // Read a local file as ArrayBuffer (for Three.js STLLoader)
  readFile: (filePath) =>
    ipcRenderer.invoke('read-file', filePath),

  // Show save dialog and copy generated file
  saveModel: (sourcePath, format, dialogTitle) =>
    ipcRenderer.invoke('save-model', sourcePath, format, dialogTitle),

  // OpenSCAD version management
  getOpenSCADVersion: () =>
    ipcRenderer.invoke('get-openscad-version'),

  checkOpenSCADUpdate: () =>
    ipcRenderer.invoke('check-openscad-update'),

  downloadOpenSCADUpdate: (downloadUrl) => {
    // MAINT-13: Second-layer guards — main process also validates (defence in depth).
    // Check HTTPS + hostname allowlist so a compromised renderer can't reach arbitrary hosts.
    const ALLOWED_DOWNLOAD_HOSTS = new Set([
      'github.com', 'objects.githubusercontent.com',
      'releases.openscad.org', 'openscad.s3.amazonaws.com',
      'github-releases.githubusercontent.com',
    ]);
    if (!downloadUrl || !String(downloadUrl).startsWith('https://')) {
      return Promise.reject(new Error('[preload] download URL must be HTTPS'));
    }
    try {
      const { hostname } = new URL(String(downloadUrl));
      if (!ALLOWED_DOWNLOAD_HOSTS.has(hostname)) {
        return Promise.reject(new Error(`[preload] unauthorized host: ${hostname}`));
      }
    } catch {
      return Promise.reject(new Error('[preload] malformed URL'));
    }
    return ipcRenderer.invoke('download-openscad-update', downloadUrl);
  },

  // App auto-updater
  checkAppUpdate: () =>
    ipcRenderer.invoke('check-app-update'),

  // Open STL files directly in BambuStudio
  openInBambu: (baseStlPath, nomeStlPath) =>
    ipcRenderer.invoke('open-in-bambu', baseStlPath, nomeStlPath),

  // Patch a 3MF with BambuStudio process settings (fuzzy skin, ironing)
  patch3mf: (filePath, settings) =>
    ipcRenderer.invoke('patch-3mf', filePath, settings),

  // ── Progress events — single-subscriber model ─────────────────────────────
  // Replaces any previously registered handler so listeners never accumulate.
  onGenerationProgress: (() => {
    let active = null;
    return (callback) => {
      if (active) ipcRenderer.removeListener('generation-progress', active);
      active = (_, data) => callback(data);
      ipcRenderer.on('generation-progress', active);
      return () => {
        if (active) { ipcRenderer.removeListener('generation-progress', active); active = null; }
      };
    };
  })(),

  onOpenSCADDownloadProgress: (() => {
    let active = null;
    return (callback) => {
      if (active) ipcRenderer.removeListener('openscad-download-progress', active);
      active = (_, data) => callback(data);
      ipcRenderer.on('openscad-download-progress', active);
      return () => {
        if (active) { ipcRenderer.removeListener('openscad-download-progress', active); active = null; }
      };
    };
  })(),
});
