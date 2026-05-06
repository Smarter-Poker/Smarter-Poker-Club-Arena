/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Table Theme Selector
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import './ThemeSelector.css';

export interface ThemeOption {
  id: string;
  name: string;
  feltColor: string;
  railColor: string;
  preview: string; // CSS gradient for preview circle
}

const THEMES: ThemeOption[] = [
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

import { STORAGE_KEYS } from '../../lib/storage';
import { reportError } from '../../utils/errorReporter';
const STORAGE_KEY = STORAGE_KEYS.TABLE_FELT_THEME;

interface ThemeSelectorProps {
  onThemeChange?: (themeId: string) => void;
}

export function ThemeSelector({ onThemeChange }: ThemeSelectorProps) {
  const [activeTheme, setActiveTheme] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'green';
    } catch (err) {
      reportError(err, 'ThemeSelector.Error');
      return 'green';
    }
  });

  // Apply theme on mount and change
  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  const applyTheme = (themeId: string) => {
    if (themeId === 'green') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themeId);
    }
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch (err) {
      reportError(err, 'ThemeSelector.Error');
      /* localStorage unavailable */
    }
  };

  const handleSelect = (themeId: string) => {
    setActiveTheme(themeId);
    onThemeChange?.(themeId);
  };

  return (
    <div className="theme-selector">
      <div className="theme-selector__label">Table Theme</div>
      <div className="theme-selector__grid">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            className={`theme-selector__option ${activeTheme === theme.id ? 'theme-selector__option--active' : ''}`}
            onClick={() => handleSelect(theme.id)}
            title={theme.name}
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
