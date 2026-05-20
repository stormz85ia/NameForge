import { useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import ParamGroup, {
  Field,
  NumberInput,
  TextInput,
  Toggle,
  ColorInput,
  SelectInput,
} from './ParamGroup.jsx';

// ── Font quality metadata ─────────────────────────────────────────────────────
// rating: 'safe' | 'warn' | 'danger'
// safe   = bold strokes, prints well at any size ≥ 6mm
// warn   = medium strokes, fine above 12mm
// danger = thin strokes / serifs, needs large size (20mm+)

// ── Bundled Google Fonts (resources/fonts/) ───────────────────────────────────
// All fonts verified present as TTF in resources/fonts/.
// Variable fonts ([wght]) use style=Regular — safe across all OpenSCAD versions.
// Montserrat[wght] and Nunito[wght] excluded: base instance is Thin/ExtraLight → too fine for print.
// hintKey maps to sidebar.fontHints.<key> in translation files.
const FONT_BASE_OPTIONS = [
  { value: 'Bebas Neue:style=Regular',    label: 'Bebas Neue',      rating: 'safe',   hintKey: 'bebasNeue' },
  { value: 'Anton:style=Regular',         label: 'Anton',           rating: 'safe',   hintKey: 'anton' },
  { value: 'Black Ops One:style=Regular', label: 'Black Ops One',   rating: 'safe',   hintKey: 'blackOpsOne' },
  { value: 'Archivo Black:style=Regular', label: 'Archivo Black',   rating: 'safe',   hintKey: 'archivoBlack' },
  { value: 'Russo One:style=Regular',     label: 'Russo One',       rating: 'safe',   hintKey: 'russoOne' },
  { value: 'Orbitron:style=Regular',      label: 'Orbitron',        rating: 'safe',   hintKey: 'orbitron' },
  { value: 'Bungee:style=Regular',        label: 'Bungee',          rating: 'safe',   hintKey: 'bungee' },
  { value: 'Oswald:style=Regular',        label: 'Oswald',          rating: 'safe',   hintKey: 'oswald' },
  { value: 'Righteous:style=Regular',     label: 'Righteous',       rating: 'safe',   hintKey: 'righteous' },
  { value: 'STIX Two Math:style=Regular', label: 'STIX Two Math',   rating: 'danger', hintKey: 'stixTwoMath' },
];

const FONT_CORSIVO_OPTIONS = [
  { value: 'Pacifico:style=Regular',         label: 'Pacifico',         rating: 'safe', hintKey: 'pacifico' },
  { value: 'Lobster:style=Regular',          label: 'Lobster',          rating: 'safe', hintKey: 'lobster' },
  { value: 'Kaushan Script:style=Regular',   label: 'Kaushan Script',   rating: 'safe', hintKey: 'kaushanScript' },
  { value: 'Permanent Marker:style=Regular', label: 'Permanent Marker', rating: 'safe', hintKey: 'permanentMarker' },
  { value: 'Comfortaa:style=Regular',        label: 'Comfortaa',        rating: 'safe', hintKey: 'comfortaa' },
  { value: 'Dancing Script:style=Regular',   label: 'Dancing Script',   rating: 'warn', hintKey: 'dancingScript' },
];

// Combined font list — module-level constant, avoids spreading on every render
const ALL_FONT_OPTIONS = [...FONT_BASE_OPTIONS, ...FONT_CORSIVO_OPTIONS];

const RATING_COLORS = {
  safe:   { color: 'text-green-400',  bg: 'bg-green-400/10' },
  warn:   { color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  danger: { color: 'text-red-400',    bg: 'bg-red-400/10' },
};
const RATING_ICONS = { safe: '✅', warn: '⚠️', danger: '❌' };

function FontBadge({ options, value }) {
  const { t } = useTranslation();
  const found = options.find((o) => o.value === value);
  if (!found) return null;
  const { color, bg } = RATING_COLORS[found.rating];
  return (
    <div className={`mt-1 flex items-start gap-1.5 rounded px-2 py-1 ${bg}`}>
      <span className="text-[11px] leading-[1.4]">{RATING_ICONS[found.rating]}</span>
      <span className={`text-[11px] leading-[1.4] ${color}`}>
        {t(`sidebar.ratings.${found.rating}`)}
        {found.hintKey && (
          <span className="text-white/40"> — {t(`sidebar.fontHints.${found.hintKey}`)}</span>
        )}
      </span>
    </div>
  );
}

// ── Text size warning logic ───────────────────────────────────────────────────
function getSizeWarning(dimensione_nome, layer_height, fontValue, t) {
  const font = ALL_FONT_OPTIONS.find((o) => o.value === fontValue);
  const rating = font?.rating ?? 'safe';

  const minSafe   = layer_height * 40; // e.g. 0.2 × 40 = 8mm
  const minDanger = layer_height * 20; // e.g. 0.2 × 20 = 4mm
  // thin-serif fonts need more space
  const minThinFont = layer_height * 60; // e.g. 0.2 × 60 = 12mm

  if (dimensione_nome < minDanger) {
    return {
      level: 'danger',
      msg: t('sidebar.warnings.tooSmall', {
        size: dimensione_nome,
        min: minDanger.toFixed(1),
        layer: layer_height,
      }),
    };
  }
  if (rating === 'danger' && dimensione_nome < minThinFont) {
    return {
      level: 'warn',
      msg: t('sidebar.warnings.thinFont', {
        size: dimensione_nome,
        min: minThinFont.toFixed(0),
        layer: layer_height,
      }),
    };
  }
  if (dimensione_nome < minSafe) {
    return {
      level: 'warn',
      msg: t('sidebar.warnings.smallSize', {
        size: dimensione_nome,
        layer: layer_height,
      }),
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Sidebar({ params, onUpdateParam, onGenerate, onDownload, onOpenInBambu, loading, bambuLoading, downloadingFormat }) {
  const { t } = useTranslation();
  const p = params;
  const u = onUpdateParam;

  const sizeWarn = useMemo(
    () => getSizeWarning(p.dimensione_nome, p.layer_height, p.font_corsivo, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.dimensione_nome, p.layer_height, p.font_corsivo, t]
  );

  return (
    <aside className="w-80 shrink-0 flex flex-col border-r border-app-border bg-app-panel">
      {/* Header sidebar */}
      <div className="px-4 py-3 border-b border-app-border">
        <span className="section-label">{t('sidebar.title')}</span>
      </div>

      {/* Scrollable param area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">

        {/* ── Texte ────────────────────────────────────────── */}
        <ParamGroup title={t('sidebar.groups.text')} defaultOpen={true}>
          <Field label={t('sidebar.fields.name')}>
            <TextInput
              value={p.nome}
              onChange={(v) => u('nome', v)}
              placeholder="Jason"
            />
          </Field>

          <Field label={t('sidebar.fields.fontBase')}>
            <SelectInput
              value={p.font_base}
              onChange={(v) => u('font_base', v)}
              options={FONT_BASE_OPTIONS}
            />
            <FontBadge options={FONT_BASE_OPTIONS} value={p.font_base} />
          </Field>

          <Field label={t('sidebar.fields.fontCursive')}>
            <SelectInput
              value={p.font_corsivo}
              onChange={(v) => u('font_corsivo', v)}
              options={FONT_CORSIVO_OPTIONS}
            />
            <FontBadge options={FONT_CORSIVO_OPTIONS} value={p.font_corsivo} />
          </Field>

          <Toggle
            value={p.iniziale_maiuscola}
            onChange={(v) => u('iniziale_maiuscola', v)}
            label={t('sidebar.fields.uppercase')}
          />
          <Toggle
            value={p.mostra_base}
            onChange={(v) => u('mostra_base', v)}
            label={t('sidebar.fields.showBase')}
          />
          <Toggle
            value={p.mostra_nome}
            onChange={(v) => u('mostra_nome', v)}
            label={t('sidebar.fields.showName')}
          />
        </ParamGroup>

        {/* ── Dimensions ───────────────────────────────────── */}
        <ParamGroup title={t('sidebar.groups.dimensions')}>
          <Field label={t('sidebar.fields.layerHeight')} hint={t('sidebar.fields.layerHeightHint')}>
            <NumberInput
              value={p.layer_height}
              onChange={(v) => u('layer_height', v)}
              min={0.05} max={0.6} step={0.05}
            />
          </Field>

          <Field label={t('sidebar.fields.baseHeight')} hint={t('sidebar.fields.baseHeightHint')}>
            <NumberInput
              value={p.altezza_base}
              onChange={(v) => u('altezza_base', v)}
              min={5} max={100} step={1}
            />
          </Field>

          <Field label={t('sidebar.fields.engravingDepth')}>
            <NumberInput
              value={p.profondita_incisione}
              onChange={(v) => u('profondita_incisione', v)}
              min={0.5} max={20} step={0.5}
            />
          </Field>

          <Field label={t('sidebar.fields.letterSize')}>
            <NumberInput
              value={p.dimensione_lettera}
              onChange={(v) => u('dimensione_lettera', v)}
              min={20} max={500} step={5}
            />
          </Field>

          <Field label={t('sidebar.fields.nameSize')} hint={t('sidebar.fields.nameSizeHint')}>
            <NumberInput
              value={p.dimensione_nome}
              onChange={(v) => u('dimensione_nome', v)}
              min={5} max={200} step={1}
            />
            {/* Text size + layer height warning */}
            {sizeWarn && (
              <div className={`mt-1 rounded px-2 py-1 text-[11px] leading-[1.4] ${
                sizeWarn.level === 'danger'
                  ? 'bg-red-400/10 text-red-300'
                  : 'bg-yellow-400/10 text-yellow-300'
              }`}>
                {sizeWarn.msg}
              </div>
            )}
          </Field>

          <Field label={t('sidebar.fields.nameRelief')} hint={t('sidebar.fields.nameReliefHint')}>
            <NumberInput
              value={p.altezza_nome_solido}
              onChange={(v) => u('altezza_nome_solido', v)}
              min={0.5} max={30} step={0.5}
            />
          </Field>

          <Field label={t('sidebar.fields.offsetX')}>
            <NumberInput
              value={p.offset_nome_x}
              onChange={(v) => u('offset_nome_x', v)}
              min={-200} max={200} step={1}
            />
          </Field>

          <Field label={t('sidebar.fields.offsetY')}>
            <NumberInput
              value={p.offset_nome_y}
              onChange={(v) => u('offset_nome_y', v)}
              min={-200} max={200} step={1}
            />
          </Field>

          <Field label={t('sidebar.fields.tolerance')}>
            <NumberInput
              value={p.tolleranza}
              onChange={(v) => u('tolleranza', v)}
              min={0} max={2} step={0.05}
            />
          </Field>

          <Field label={t('sidebar.fields.cutMargin')}>
            <NumberInput
              value={p.margine_taglio}
              onChange={(v) => u('margine_taglio', v)}
              min={0} max={50} step={1}
            />
          </Field>

          <Field label={t('sidebar.fields.cutBase')} hint={t('sidebar.fields.cutBaseHint')}>
            <NumberInput
              value={p.taglio_base}
              onChange={(v) => u('taglio_base', v)}
              min={0} max={60} step={1}
            />
          </Field>
        </ParamGroup>

        {/* ── Finitions d'impression ───────────────────────── */}
        <ParamGroup title={t('sidebar.groups.finitions')}>

          {/* ── Fuzzy Skin ── */}
          <Toggle
            value={p.fuzzy_skin}
            onChange={(v) => u('fuzzy_skin', v)}
            label={t('sidebar.fields.fuzzySkin')}
          />
          {p.fuzzy_skin && (
            <>
              <Field label={t('sidebar.fields.fuzzyThickness')} hint={t('sidebar.fields.fuzzyThicknessHint')}>
                <NumberInput
                  value={p.fuzzy_skin_thickness}
                  onChange={(v) => u('fuzzy_skin_thickness', v)}
                  min={0.1} max={3} step={0.1}
                />
              </Field>
              <Field label={t('sidebar.fields.fuzzyPointDist')} hint={t('sidebar.fields.fuzzyPointDistHint')}>
                <NumberInput
                  value={p.fuzzy_skin_point_distance}
                  onChange={(v) => u('fuzzy_skin_point_distance', v)}
                  min={0.2} max={5} step={0.1}
                />
              </Field>
            </>
          )}

          {/* ── Ironing ── */}
          <Toggle
            value={p.ironing_top}
            onChange={(v) => u('ironing_top', v)}
            label={t('sidebar.fields.ironing')}
          />

          {/* Info banner — slicer settings embedded in 3MF */}
          {(p.fuzzy_skin || p.ironing_top) && (
            <div className="rounded px-2 py-1.5 text-[11px] leading-[1.4] bg-[#1e3a5f]/60 border border-blue-500/30 text-blue-300">
              <Trans
                i18nKey="sidebar.fields.slicerBanner"
                components={{ 1: <strong /> }}
              />
            </div>
          )}

          {/* ── Chanfrein géométrique ── */}
          <div className="border-t border-app-border pt-3">
            <Toggle
              value={p.chanfrein_haut}
              onChange={(v) => u('chanfrein_haut', v)}
              label={t('sidebar.fields.chamfer')}
            />
            {p.chanfrein_haut && (
              <Field label={t('sidebar.fields.chamferSize')} hint={t('sidebar.fields.chamferSizeHint')}>
                <NumberInput
                  value={p.chanfrein_taille}
                  onChange={(v) => u('chanfrein_taille', v)}
                  min={0.2} max={10} step={0.2}
                />
              </Field>
            )}
          </div>

        </ParamGroup>

        {/* ── Couleurs ─────────────────────────────────────── */}
        <ParamGroup title={t('sidebar.groups.colors')}>
          <Field label={t('sidebar.fields.colorBase')} hint={t('sidebar.fields.colorBaseHint')}>
            <ColorInput
              value={p.colore_base}
              onChange={(v) => u('colore_base', v)}
            />
          </Field>

          <Field label={t('sidebar.fields.colorName')} hint={t('sidebar.fields.colorNameHint')}>
            <ColorInput
              value={p.colore_nome}
              onChange={(v) => u('colore_nome', v)}
            />
          </Field>
        </ParamGroup>
      </div>

      {/* ── Actions ──────────────────────────────────────────── */}
      <div className="p-3 border-t border-app-border space-y-2 shrink-0">
        <button
          className="btn-primary w-full"
          onClick={onGenerate}
          disabled={loading || bambuLoading}
        >
          {loading ? (
            <>
              <Spinner />
              {t('sidebar.actions.generating')}
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="square" d="M12 4v16m8-8H4" />
              </svg>
              {t('sidebar.actions.generate')}
            </>
          )}
        </button>

        <div className="flex gap-2">
          <button
            className="btn-outline flex-1 text-[13px] h-9 px-3 flex items-center justify-center gap-1.5"
            onClick={() => onDownload('stl')}
            disabled={loading || bambuLoading}
          >
            {downloadingFormat === 'stl' ? <><Spinner />STL…</> : 'STL'}
          </button>
          <button
            className="btn-outline flex-1 text-[13px] h-9 px-3 flex items-center justify-center gap-1.5"
            onClick={() => onDownload('3mf')}
            disabled={loading || bambuLoading}
          >
            {downloadingFormat === '3mf' ? <><Spinner />3MF…</> : '3MF'}
          </button>
        </div>

        {/* BambuStudio 1-click export */}
        <button
          className="w-full h-9 px-3 rounded text-[13px] font-medium flex items-center justify-center gap-2
                     bg-[#00ae42]/15 border border-[#00ae42]/40 text-[#00ae42]
                     hover:bg-[#00ae42]/25 hover:border-[#00ae42]/70
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          onClick={onOpenInBambu}
          disabled={loading || bambuLoading}
        >
          {bambuLoading ? (
            <>
              <Spinner />
              {t('sidebar.actions.openingBambu')}
            </>
          ) : (
            <>
              {/* Bambu-ish icon */}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {t('sidebar.actions.openBambu')}
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12" cy="12" r="10"
        stroke="currentColor" strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
