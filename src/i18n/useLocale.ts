/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useLocale — React hook for i18n (Bible V8 Chapter 8 NFR)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides reactive locale state for React components.
 * Components using this hook re-render automatically when locale changes.
 *
 * @example
 *   const { t, locale, setLocale } = useLocale();
 *   return <button onClick={() => setLocale('es')}>{t('fold')}</button>;
 */

import { useState, useEffect, useCallback } from 'react';
import {
  t as translate,
  getLocale,
  setLocale as setGlobalLocale,
  onLocaleChange,
  type Locale,
  type TranslationValues,
} from './index';

interface UseLocaleReturn {
  /** Translate a key with optional interpolation. */
  t: (key: string, values?: TranslationValues) => string;
  /** Current active locale. */
  locale: Locale;
  /** Change the active locale (persisted to localStorage). */
  setLocale: (locale: Locale) => void;
}

export function useLocale(): UseLocaleReturn {
  const [locale, setLocaleState] = useState<Locale>(getLocale);

  useEffect(() => {
    const unsub = onLocaleChange((newLocale) => {
      setLocaleState(newLocale);
    });
    return unsub;
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setGlobalLocale(newLocale);
  }, []);

  // Wrap translate to ensure re-render triggers re-translation
  const t = useCallback(
    (key: string, values?: TranslationValues) => translate(key, values),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale]
  );

  return { t, locale, setLocale };
}
