/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CUSTOMIZATION — Table Theme Picker (VIP-tiered)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * AUDIT 2026-08-25 — this component offered EIGHT themes, and not one of them
 * existed:
 *
 *     classic · midnight · crimson · ocean · royal · sunset · neon · gold
 *
 * Nothing in the codebase consumed any of those ids. There is no
 * `[data-theme='crimson']`, no `[data-theme='sunset']`, no felt, no token, no
 * stylesheet — the component painted three coloured squares as a "preview",
 * called `onChange`, and that was the entire feature. Picking any of the eight
 * changed nothing on screen, and nothing was written anywhere. It is the same
 * defect Dan hit on the card-back picker (eight ids, six matching nothing, all
 * eight painting identically) and it was sitting here waiting to ship.
 *
 * Rebuilt on `TABLE_THEMES`, the one real list — every id there has a token
 * block in `src/styles/design-tokens.css`, pinned by a test. Selecting now:
 *
 *   • applies immediately, by setting `data-theme` on the document element,
 *     with no reload and no remount;
 *   • persists, through the same localStorage key the table picker uses, so
 *     the two surfaces can never disagree;
 *   • confirms, with a success toast.
 *
 * A locked tile answers too. Silently ignoring the tap was indistinguishable
 * from the app being broken, which is how the dead version read for months.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  TABLE_THEMES,
  DEFAULT_THEME_ID,
  applyThemeToDocument,
  isKnownThemeId,
} from '../table/ThemeSelector';
import { useToast } from '../common/Toast';
import { STORAGE_KEYS } from '../../lib/storage';
import { reportError } from '../../utils/errorReporter';
import './ThemeSelector.css';

type VipTier = 'bronze' | 'silver' | 'gold' | null;

interface ThemeSelectorProps {
  /** Currently applied theme id. Anything unrecognised falls back to default. */
  currentTheme?: string;
  userVipTier?: VipTier;
  onChange?: (themeId: string) => void;
}

/**
 * Which real themes cost something. Ids only — the artwork and the names come
 * from TABLE_THEMES, so this table cannot invent a theme that does not exist.
 */
const VIP_THEME_IDS = new Set(['purple', 'light']);
const PREMIUM_THEME_IDS = new Set(['gold']);

function readStoredTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.TABLE_FELT_THEME);
    return isKnownThemeId(stored) ? (stored as string) : DEFAULT_THEME_ID;
  } catch (err) {
    reportError(err, 'CustomizationThemeSelector.Read');
    return DEFAULT_THEME_ID;
  }
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({
  currentTheme,
  userVipTier,
  onChange,
}) => {
  const toast = useToast();
  const [selectedTheme, setSelectedTheme] = useState<string>(() =>
    isKnownThemeId(currentTheme) ? (currentTheme as string) : readStoredTheme()
  );

  /** A theme changed anywhere else (the table picker, another tab) shows here. */
  useEffect(() => {
    const syncFromDocument = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      const next = isKnownThemeId(attr) ? (attr as string) : DEFAULT_THEME_ID;
      setSelectedTheme((prev) => (prev === next ? prev : next));
    };
    const observer = new MutationObserver(syncFromDocument);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const tierOf = (themeId: string): 'free' | 'vip' | 'premium' => {
    if (PREMIUM_THEME_IDS.has(themeId)) return 'premium';
    if (VIP_THEME_IDS.has(themeId)) return 'vip';
    return 'free';
  };

  const canUseTheme = useCallback(
    (themeId: string): boolean => {
      const tier = tierOf(themeId);
      if (tier === 'free') return true;
      if (tier === 'premium') return userVipTier === 'gold';
      return !!userVipTier;
    },
    [userVipTier]
  );

  const handleSelect = useCallback(
    (themeId: string) => {
      const theme = TABLE_THEMES.find((t) => t.id === themeId);
      if (!theme) return;

      if (!canUseTheme(themeId)) {
        // Say why. A tap that does nothing reads as a broken app.
        toast.info(
          tierOf(themeId) === 'premium'
            ? `${theme.name} Is A Gold Theme. Upgrade To Unlock It.`
            : `${theme.name} Is A VIP Theme. Join VIP To Unlock It.`
        );
        return;
      }

      if (themeId === selectedTheme) return;

      setSelectedTheme(themeId);
      applyThemeToDocument(themeId); // real time, no reload
      onChange?.(themeId);
      toast.success(`Table Theme Saved. ${theme.name}`);
    },
    [canUseTheme, onChange, selectedTheme, toast]
  );

  return (
    <div className="theme-selector">
      <h3>Table Theme</h3>
      <div className="themes-grid">
        {TABLE_THEMES.map((theme) => {
          const tier = tierOf(theme.id);
          const isLocked = !canUseTheme(theme.id);
          const isSelected = selectedTheme === theme.id;

          return (
            <button
              key={theme.id}
              type="button"
              className={`theme-card ${isSelected ? 'selected' : ''} ${isLocked ? 'locked' : ''}`}
              onClick={() => handleSelect(theme.id)}
              aria-pressed={isSelected}
              title={theme.name}
            >
              {/* The real preview the table picker uses, not three flat
                  swatches that resembled nothing that would be applied. */}
              <div className="theme-preview" style={{ background: theme.preview }}>
                <div className="theme-preview__rail" style={{ borderColor: theme.railColor }} />
              </div>
              <div className="theme-info">
                <span className="theme-name">{theme.name}</span>
                {tier === 'premium' && <span className="theme-badge premium">Gold</span>}
                {tier === 'vip' && <span className="theme-badge vip">VIP</span>}
              </div>
              {isLocked && <div className="lock-overlay" aria-hidden="true"></div>}
              {isSelected && <div className="selected-check" aria-hidden="true"></div>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ThemeSelector;
