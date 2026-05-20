import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// MAINT-6: 60-second cooldown — prevents spam-clicking from hammering GitHub API.
const UPDATE_COOLDOWN_MS = 60_000;

export default function Header() {
  const { t, i18n } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const statusTimerRef = useRef(null);
  const lastCheckRef = useRef(0);

  // Clear pending timer on unmount to avoid state update on unmounted component
  useEffect(() => {
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current); };
  }, []);

  const handleCheckUpdate = async () => {
    if (!window.nameforge || checking) return;
    const now = Date.now();
    if (now - lastCheckRef.current < UPDATE_COOLDOWN_MS) return;
    lastCheckRef.current = now;
    setChecking(true);
    setUpdateStatus(null);

    const result = await window.nameforge.checkAppUpdate();
    setChecking(false);

    if (result.success && result.updateInfo) {
      setUpdateStatus({ type: 'available', version: result.updateInfo.version });
    } else if (!result.success) {
      // publish not configured or network error — show distinct message
      setUpdateStatus({ type: 'error' });
    } else {
      setUpdateStatus({ type: 'latest' });
    }

    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setUpdateStatus(null), 4000);
  };

  const lang = i18n.language;

  return (
    <header className="flex items-center justify-between px-6 h-12 bg-surface-dark border-b border-app-border shrink-0">
      {/* Logo + nom */}
      <div className="flex items-center gap-3">
        {/* Corner-square décoration — signature NVIDIA design */}
        <div className="w-3 h-3 bg-primary shrink-0" />
        <span className="text-on-dark font-bold text-[18px] tracking-tight">
          Name<span className="text-primary">Forge</span>
        </span>
        <span className="text-stone text-[11px] font-bold uppercase tracking-wider ml-1">
          {t('header.tagline')}
        </span>
      </div>

      {/* Droite */}
      <div className="flex items-center gap-3">
        {updateStatus && (
          <span
            className={`text-[12px] font-bold ${
              updateStatus.type === 'available' ? 'text-primary' :
              updateStatus.type === 'error'     ? 'text-red-400' : 'text-stone'
            }`}
          >
            {updateStatus.type === 'available'
              ? t('header.updateAvailable', { version: updateStatus.version })
              : updateStatus.type === 'error'
              ? t('header.updateError')
              : t('header.upToDate')}
          </span>
        )}

        {/* Language switcher */}
        <div className="flex items-center gap-0.5 text-[12px]">
          <button
            onClick={() => i18n.changeLanguage('fr')}
            className={`px-1.5 py-0.5 rounded-sm font-bold transition-colors ${
              lang === 'fr' ? 'text-primary' : 'text-stone hover:text-on-dark'
            }`}
          >
            FR
          </button>
          <span className="text-stone/30">|</span>
          <button
            onClick={() => i18n.changeLanguage('en')}
            className={`px-1.5 py-0.5 rounded-sm font-bold transition-colors ${
              lang === 'en' ? 'text-primary' : 'text-stone hover:text-on-dark'
            }`}
          >
            EN
          </button>
        </div>

        <button
          className="btn-outline text-[13px] h-8 px-3 text-stone border-app-border hover:border-primary hover:text-on-dark"
          onClick={handleCheckUpdate}
          disabled={checking}
        >
          {checking ? t('header.checking') : t('header.updates')}
        </button>
      </div>
    </header>
  );
}
