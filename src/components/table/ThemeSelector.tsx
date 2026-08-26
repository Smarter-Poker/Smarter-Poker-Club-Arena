/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Table Theme Selector
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Seven themes, applied by putting `data-theme` on the document element. Every
 * id below has a real token block behind it in `src/styles/design-tokens.css`
 * ('blue' | 'red' | 'purple' | 'black' | 'gold' | 'light'), and 'green' is the
 * default the attribute is REMOVED for. `THEME_IDS_WITH_TOKENS` is exported so
 * a test can hold that list against the stylesheet: an id offered here with no
 * tokens behind it is a tile that changes nothing when a player taps it, which
 * is the defect this estate keeps shipping.
 *
 * AUDIT 2026-08-25 — three fixes:
 *   • picking a theme gave NO confirmation. Dan, binding: every change needs a
 *     success toast or a save feature. It toasts now.
 *   • a stale or hand-edited localStorage value was applied verbatim, so
 *     `data-theme` could be set to an id with no stylesheet behind it — no tile
 *     highlighted and no styling applied. Unknown ids now fall back to 'green'.
 *   • two mounted copies, or a change made in another tab, drifted apart. The
 *     component now follows `data-theme` wherever it is changed.
 */

import { useState, useEffect, useCallback } from 'react';
import './ThemeSelector.css';

export interface ThemeOption {
  id: string;
  name: string;
  feltColor: string;
  railColor: string;
  preview: string; // CSS gradient for preview circle
}

/**
 * The ONE list of table themes in the app. `components/customization/
 * ThemeSelector` renders this same array (it used to carry eight ids of its
 * own — classic, midnight, crimson, ocean, royal, sunset, neon, gold — of
 * which not one had any styling behind it anywhere in the codebase). One
 * source means a new theme cannot exist in one picker and not the other, and
 * an id can never be offered without tokens.
 */
export const TABLE_THEMES: ThemeOption[] = [
  {
    id: 'green',
    name: 'Classic Green',
    feltColor: '#0f5132',
    railColor: '#2c1d12',
    preview: 'radial-gradient(circle, #1a7a4a 0%, #0f5132 100%)',
  },
  {
    id: 'blue',
    name: 'Ocean Blue',
    feltColor: '#1e3a5f',
    railColor: '#1f2937',
    preview: 'radial-gradient(circle, #2563eb40 0%, #1e3a5f 100%)',
  },
  {
    id: 'red',
    name: 'Casino Red',
    feltColor: '#7f1d1d',
    railColor: '#2c0d00',
    preview: 'radial-gradient(circle, #991b1b40 0%, #7f1d1d 100%)',
  },
  {
    id: 'purple',
    name: 'Royal Purple',
    feltColor: '#4c1d95',
    railColor: '#1f2937',
    preview: 'radial-gradient(circle, #6d28d940 0%, #4c1d95 100%)',
  },
  {
    id: 'black',
    name: 'Stealth Black',
    feltColor: '#18181b',
    railColor: '#18181b',
    preview: 'radial-gradient(circle, #27272a 0%, #09090b 100%)',
  },
  {
    id: 'gold',
    name: 'VIP Gold',
    feltColor: '#1c1a0e',
    railColor: '#5c4512',
    preview: 'radial-gradient(circle, #f59e0b20 0%, #1c1a0e 100%)',
  },
  {
    id: 'light',
    name: 'Light Mode',
    feltColor: '#1a7a4a',
    railColor: '#5c4512',
    preview: 'radial-gradient(circle, #f8fafc 0%, #e2e8f0 60%, #1a7a4a 100%)',
  },
];

/** The default: `data-theme` is REMOVED for this one, not set to it. */
export const DEFAULT_THEME_ID = 'green';

/**
 * Every id that must have a `[data-theme='<id>']` block in design-tokens.css.
 * 'green' is excluded on purpose — it is the bare `:root` default.
 */
export const THEME_IDS_WITH_TOKENS: string[] = TABLE_THEMES.filter(
  (t) => t.id !== DEFAULT_THEME_ID
).map((t) => t.id);

export const THEME_IDS: string[] = TABLE_THEMES.map((t) => t.id);

export function isKnownThemeId(id: string | null | undefined): boolean {
  return !!id && THEME_IDS.includes(id);
}

import { STORAGE_KEYS } from '../../lib/storage';
import { reportError } from '../../utils/errorReporter';
import { useToast } from '../common/Toast';
const STORAGE_KEY = STORAGE_KEYS.TABLE_FELT_THEME;

function readStoredTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // An id we do not ship would be written to `data-theme` and match no
    // stylesheet: the app would look default while the picker highlighted
    // nothing. Treat anything unrecognised as the default.
    return isKnownThemeId(stored) ? (stored as string) : DEFAULT_THEME_ID;
  } catch (err) {
    reportError(err, 'ThemeSelector.Error');
    return DEFAULT_THEME_ID;
  }
}

export function applyThemeToDocument(themeId: string) {
  const id = isKnownThemeId(themeId) ? themeId : DEFAULT_THEME_ID;
  if (id === DEFAULT_THEME_ID) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch (err) {
    reportError(err, 'ThemeSelector.Error');
    /* localStorage unavailable */
  }
}

interface ThemeSelectorProps {
  onThemeChange?: (themeId: string) => void;
}

export function ThemeSelector({ onThemeChange }: ThemeSelectorProps) {
  const toast = useToast();
  const [activeTheme, setActiveTheme] = useState<string>(readStoredTheme);

  // Apply on mount and on every change. This is what makes the tap show up on
  // screen immediately, with no reload and no remount.
  useEffect(() => {
    applyThemeToDocument(activeTheme);
  }, [activeTheme]);

  /**
   * Follow `data-theme` wherever it is changed — another mounted copy of this
   * picker, or another tab. Without this, two open surfaces disagree about
   * which tile is selected while the page itself shows only one of them.
   */
  useEffect(() => {
    const syncFromDocument = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      const next = isKnownThemeId(attr) ? (attr as string) : DEFAULT_THEME_ID;
      setActiveTheme((prev) => (prev === next ? prev : next));
    };

    const observer = new MutationObserver(syncFromDocument);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = isKnownThemeId(e.newValue) ? (e.newValue as string) : DEFAULT_THEME_ID;
      setActiveTheme((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('storage', onStorage);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const handleSelect = useCallback(
    (themeId: string) => {
      const theme = TABLE_THEMES.find((t) => t.id === themeId);
      if (!theme) return;
      // Re-tapping the tile already in use is not a change; toasting it again
      // would be noise, and identical popups dedupe anyway.
      if (themeId === activeTheme) return;
      setActiveTheme(themeId);
      onThemeChange?.(themeId);
      toast.success(`Table Theme Saved. ${theme.name}`);
    },
    [activeTheme, onThemeChange, toast]
  );

  return (
    <div className="theme-selector">
      <div className="theme-selector__label">Table Theme</div>
      <div className="theme-selector__grid">
        {TABLE_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`theme-selector__option ${activeTheme === theme.id ? 'theme-selector__option--active' : ''}`}
            onClick={() => handleSelect(theme.id)}
            title={theme.name}
            aria-pressed={activeTheme === theme.id}
          >
            <div className="theme-selector__preview" style={{ background: theme.preview }}>
              <div className="theme-selector__rail-ring" style={{ borderColor: theme.railColor }} />
              {activeTheme === theme.id && (
                <div className="theme-selector__check">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 7l3 3 5-6"
                      stroke="#fff"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}
            </div>
            <span className="theme-selector__name">{theme.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default ThemeSelector;
