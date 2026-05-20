import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import fr from './fr.json';
import en from './en.json';

const STORAGE_KEY = 'nameforge_lang';
const savedLang = localStorage.getItem(STORAGE_KEY);
const SUPPORTED = ['fr', 'en'];
const lng = SUPPORTED.includes(savedLang) ? savedLang : 'fr';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
    },
    lng,
    fallbackLng: 'fr',
    // React already escapes JSX text nodes — no need for i18next HTML escaping.
    // WARNING: never use t() output in dangerouslySetInnerHTML; use <Trans> instead.
    interpolation: { escapeValue: false },
  });

i18n.on('languageChanged', (lang) => {
  if (SUPPORTED.includes(lang)) localStorage.setItem(STORAGE_KEY, lang);
});

export default i18n;
