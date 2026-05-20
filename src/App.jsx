import { useState, useCallback, useEffect, Component } from 'react';
import { useTranslation, withTranslation } from 'react-i18next';
import i18n from './i18n/index.js';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import Preview3D from './components/Preview3D.jsx';

const DEFAULT_PARAMS = {
  nome: 'Jason',
  font_base: 'Bebas Neue:style=Regular',
  font_corsivo: 'Pacifico:style=Regular',
  iniziale_maiuscola: true,
  mostra_base: true,
  mostra_nome: true,
  altezza_base: 20,
  profondita_incisione: 4,
  dimensione_lettera: 150,
  dimensione_nome: 18,
  altezza_nome_solido: 7,
  offset_nome_x: 0,
  offset_nome_y: 0,
  tolleranza: 0.1,
  margine_taglio: 10,
  taglio_base: 10,
  colore_base: '#E994F6',
  colore_nome: '#FFFFFF',
  layer_height: 0.2,
  // ── Finitions d'impression ───────────────────────────────────────────────
  fuzzy_skin: false,
  fuzzy_skin_thickness: 0.3,
  fuzzy_skin_point_distance: 0.8,
  ironing_top: false,
  chanfrein_haut: false,
  chanfrein_taille: 1.5,
};

export default function App() {
  const { t } = useTranslation();
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  // null = "ready" sentinel — translates reactively when language switches
  const [statusMsg, setStatusMsg] = useState(null);
  const [bambuLoading, setBambuLoading] = useState(false);
  // null | 'stl' | '3mf' — which download button shows spinner
  const [downloadingFormat, setDownloadingFormat] = useState(null);

  const updateParam = useCallback((key, value) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ── Écoute des événements de progression OpenSCAD (main process → renderer) ──
  useEffect(() => {
    if (!window.nameforge) return;
    const unsub = window.nameforge.onGenerationProgress((data) => {
      if (data.status === 'running' && ALLOWED_PROGRESS_KEYS.has(data.messageKey)) {
        setStatusMsg(t(data.messageKey));
      }
    });
    return unsub;
  }, [t]);

  // ── Génération preview (2 STL séparés) ──────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!window.nameforge) return;
    // VALID-1: Guard empty nome — OpenSCAD text() with "" throws a SCAD error
    if (!params.nome || !params.nome.trim()) {
      setStatusMsg(t('status.empty'));
      return;
    }
    setLoading(true);
    setStatusMsg(t('status.generating'));

    const scadBase = buildScadParams(params);
    const genId = genSuffix();
    try {
      // nome_preview_z = altezza_base - profondita_incisione
      // → nom affleure le dessus du J (visuellement incrusté)
      const { baseResult, nomeResult } = await generateBothStl(scadBase, {
        genId,
        baseOverrides: { incidi_preview: 1 },
        nomeOverrides: { nome_preview_z: scadBase.altezza_base - scadBase.profondita_incisione },
      });
      setPreviewData({
        baseStlPath: baseResult?.outputPath ?? null,
        nomeStlPath: nomeResult?.outputPath ?? null,
        baseColor: params.colore_base,
        nomeColor: params.colore_nome,
      });
      setStatusMsg(t('status.generated'));
    } catch (err) {
      setStatusMsg(errMsg(err, t));
    }

    setLoading(false);
  }, [params, t]);

  // ── Téléchargement (export impression) ──────────────────────────────────────
  const handleDownload = useCallback(async (format) => {
    if (!window.nameforge) return;
    // VALID-1: same guard as handleGenerate — download also calls OpenSCAD
    if (!params.nome || !params.nome.trim()) {
      setStatusMsg(t('status.empty'));
      return;
    }
    setLoading(true);
    setDownloadingFormat(format);
    setStatusMsg(t('status.generatingFormat', { format: format.toUpperCase() }));

    // nome_preview_z = 0 → géométrie correcte pour impression
    const exportParams = { ...buildScadParams(params), nome_preview_z: 0 };
    const genId = genSuffix();

    const result = await window.nameforge.generateModel(exportParams, format, `export_${genId}`);

    if (!result.success) {
      setLoading(false);
      setDownloadingFormat(null);
      setStatusMsg(ipcErrMsg(result, t));
      return;
    }

    // ── Inject BambuStudio settings into 3MF (optional, best-effort) ─────────
    if (format === '3mf' && (params.fuzzy_skin || params.ironing_top)) {
      try {
        await window.nameforge.patch3mf(result.outputPath, {
          fuzzy_skin: params.fuzzy_skin,
          fuzzy_skin_thickness: params.fuzzy_skin_thickness,
          fuzzy_skin_point_distance: params.fuzzy_skin_point_distance,
          ironing_top: params.ironing_top,
        });
        setStatusMsg(t('status.3mfReady'));
      } catch {
        // Non-fatal — géométrie valide, réglages non intégrés
        setStatusMsg(t('status.3mfNoPatch'));
      }
    }

    try {
      const saveResult = await window.nameforge.saveModel(result.outputPath, format, t('status.saveDialogTitle', { format: format.toUpperCase() }));
      if (saveResult.success) {
        // Show only filename — avoid leaking full filesystem path in UI
        const fileName = saveResult.filePath.split(/[\\/]/).pop();
        setStatusMsg(t('status.saved', { fileName }));
      } else if (!saveResult.canceled) {
        setStatusMsg(t('status.saveError', { msg: saveResult.error }));
      } else {
        setStatusMsg(null);
      }
    } catch (err) {
      setStatusMsg(t('status.saveError', { msg: err.message }));
    } finally {
      setLoading(false);
      setDownloadingFormat(null);
    }
  }, [params, t]);

  // ── Ouvrir dans BambuStudio ─────────────────────────────────────────────────
  const handleOpenInBambu = useCallback(async () => {
    if (!window.nameforge) return;
    // VALID-1: same guard as handleGenerate — Bambu also calls OpenSCAD
    if (!params.nome || !params.nome.trim()) {
      setStatusMsg(t('status.empty'));
      return;
    }
    setBambuLoading(true);
    setStatusMsg(t('status.bambuGenerating'));

    // nome_preview_z = 0 → géométrie correcte pour impression
    const exportParams = { ...buildScadParams(params), nome_preview_z: 0 };
    const genId = genSuffix();

    try {
      const { baseResult, nomeResult } = await generateBothStl(exportParams, {
        genId,
        baseOverrides: { incidi_preview: 1 },
      });
      const openResult = await window.nameforge.openInBambu(
        baseResult?.outputPath ?? null,
        nomeResult?.outputPath ?? null
      );
      if (openResult.success) {
        setStatusMsg(t('status.bambuOpened'));
      } else {
        setStatusMsg(ipcErrMsg(openResult, t));
      }
    } catch (err) {
      setStatusMsg(errMsg(err, t));
    }

    setBambuLoading(false);
  }, [params, t]);

  return (
    <div className="flex flex-col h-full bg-app-bg text-on-dark select-none">
      <Header />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          params={params}
          onUpdateParam={updateParam}
          onGenerate={handleGenerate}
          onDownload={handleDownload}
          onOpenInBambu={handleOpenInBambu}
          loading={loading}
          bambuLoading={bambuLoading}
          downloadingFormat={downloadingFormat}
        />

        <main className="flex-1 relative overflow-hidden">
          <Preview3DErrorBoundary onError={setStatusMsg} previewData={previewData}>
            <Preview3D
              previewData={previewData}
              loading={loading}
              onError={setStatusMsg}
            />
          </Preview3DErrorBoundary>

          <div className="absolute bottom-0 left-0 right-0 px-4 py-1.5 bg-black/60 border-t border-app-border">
            <span className="section-label">{statusMsg ?? t('status.ready')}</span>
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Resolve a thrown Error to a translated status string.
// Prefers err.errorKey (tagged by main process) over raw err.message.
function errMsg(err, t) {
  return err?.errorKey ? t(err.errorKey) : t('status.error', { msg: err?.message ?? String(err) });
}

// Resolve an IPC result failure to a translated status string.
function ipcErrMsg(result, t) {
  return result?.errorKey ? t(result.errorKey) : t('status.error', { msg: result?.error });
}

// PERF-2: module-scope — single allocation, not re-created on each render
// RACE-1: crypto-random suffix — unguessable, eliminates temp file prediction/race attacks
const genSuffix = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

// SEC: whitelist of allowed messageKey values from generation-progress IPC events.
// Prevents arbitrary translation key injection from a compromised main→renderer message.
const ALLOWED_PROGRESS_KEYS = new Set(['status.generating', 'status.generated']);

/**
 * Generate base + nome STL in parallel.
 * genId makes output file names unique — prevents concurrent calls from
 * corrupting each other's temp files.
 * baseOverrides / nomeOverrides are merged onto scadParams for each part.
 * Throws on any failure with the error message from OpenSCAD.
 */
async function generateBothStl(scadParams, { genId = 'x', baseOverrides = {}, nomeOverrides = {} } = {}) {
  // COR-2: Guard — both parts invisible → nothing to generate, caller likely has a bug
  if (!scadParams.mostra_base && !scadParams.mostra_nome) {
    throw new Error(i18n.t('status.nothingToGenerate'));
  }

  const jobs = [];

  if (scadParams.mostra_base) {
    jobs.push(
      window.nameforge
        .generateModel({ ...scadParams, mostra_base: true, mostra_nome: false, ...baseOverrides }, 'stl', `base_${genId}`)
        .then((r) => ({ type: 'base', ...r }))
    );
  }
  if (scadParams.mostra_nome) {
    jobs.push(
      window.nameforge
        .generateModel({ ...scadParams, mostra_base: false, mostra_nome: true, ...nomeOverrides }, 'stl', `nome_${genId}`)
        .then((r) => ({ type: 'nome', ...r }))
    );
  }

  // allSettled — both promises run to completion regardless of failure
  // so no orphaned OpenSCAD process is left running
  const settled = await Promise.allSettled(jobs);
  const failed = settled.find((s) => s.status === 'rejected' || !s.value?.success);
  if (failed) {
    const reason = failed.status === 'rejected' ? failed.reason : null;
    const ipcResult = failed.status !== 'rejected' ? failed.value : null;
    const msg = reason?.message ?? ipcResult?.error;
    const e = new Error(msg ?? i18n.t('status.openScadError'));
    const key = reason?.errorKey ?? ipcResult?.errorKey;
    if (key) e.errorKey = key;
    throw e;
  }

  const results = settled.map((s) => s.value);
  return {
    baseResult: results.find((r) => r.type === 'base') ?? null,
    nomeResult: results.find((r) => r.type === 'nome') ?? null,
  };
}

// ─── Error Boundary for Preview3D ─────────────────────────────────────────────

class Preview3DErrorBoundaryBase extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) {
    if (this.props.onError) this.props.onError(this.props.t('status.preview3dError', { msg: err.message }));
  }
  // Auto-reset when a new model is generated — user gets a fresh render attempt
  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.previewData !== this.props.previewData) {
      this.setState({ hasError: false });
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-app-bg">
          <p className="text-stone text-[13px]">{this.props.t('status.preview3dUnavailable')}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const Preview3DErrorBoundary = withTranslation()(Preview3DErrorBoundaryBase);

function buildScadParams(params) {
  const out = { ...params };

  if (out.iniziale_maiuscola && out.nome) {
    out.nome = out.nome.charAt(0).toUpperCase() + out.nome.slice(1);
  }

  // Couleurs hex → vecteur OpenSCAD [r,g,b]
  out.colore_base = hexToVec(params.colore_base);
  out.colore_nome = hexToVec(params.colore_nome);

  // Booléens → 1/0 pour OpenSCAD 2021
  out.mostra_base = params.mostra_base ? 1 : 0;
  out.mostra_nome = params.mostra_nome ? 1 : 0;
  out.iniziale_maiuscola = params.iniziale_maiuscola ? 1 : 0;

  // Chanfrein : convertir bool + taille → mm pour OpenSCAD
  out.chanfrein_haut_mm = params.chanfrein_haut ? params.chanfrein_taille : 0;

  // Supprimer les params UI-only (slicer / non-OpenSCAD)
  delete out.chanfrein_haut;
  delete out.chanfrein_taille;
  delete out.fuzzy_skin;
  delete out.fuzzy_skin_thickness;
  delete out.fuzzy_skin_point_distance;
  delete out.ironing_top;

  return out;
}

function hexToVec(hex) {
  // Pad to 6 chars in case of partial hex during mid-edit (avoids NaN in OpenSCAD args)
  const h = (hex || '#000000').replace('#', '').padEnd(6, '0');
  const parse = (s) => {
    const v = parseInt(s, 16);
    return (Number.isNaN(v) ? 0 : v / 255).toFixed(3);
  };
  return `[${parse(h.slice(0, 2))},${parse(h.slice(2, 4))},${parse(h.slice(4, 6))}]`;
}
