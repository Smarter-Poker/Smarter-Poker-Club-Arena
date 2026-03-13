/**
 * Club Arena Theme Engine — Per-club theme switching
 * Ported from Hub's ClubThemeEngine.js → TypeScript
 *
 * Usage:
 *   import { useClubTheme, THEMES } from '../utils/clubThemeEngine';
 *   const { theme, setThemeId, themeId } = useClubTheme(clubId);
 */

import { useState, useEffect, useCallback } from 'react';

export interface ClubTheme {
  id: string;
  label: string;
  icon: string;
  pageBg: string;
  cardBg: string;
  cardBgHover: string;
  primary: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  inputBg: string;
  success: string;
  error: string;
  warning: string;
  glassBg: string;
  glassBlur: string;
}

export const THEMES: Record<string, ClubTheme> = {
  dark: {
    id: 'dark',
    label: 'Dark Mode',
    icon: '🌙',
    pageBg: '#18191A',
    cardBg: '#242526',
    cardBgHover: '#2D2E2F',
    primary: '#2374E1',
    accent: '#F5A623',
    textPrimary: '#E4E6EB',
    textSecondary: '#B0B3B8',
    border: '#3E4042',
    inputBg: '#3A3B3C',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#f59e0b',
    glassBg: 'rgba(36,37,38,0.85)',
    glassBlur: 'blur(16px)',
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight Blue',
    icon: '🔵',
    pageBg: '#0a1628',
    cardBg: '#111d33',
    cardBgHover: '#162847',
    primary: '#00D4FF',
    accent: '#00D4FF',
    textPrimary: '#E4E8F0',
    textSecondary: '#8899AA',
    border: '#1e3a5f',
    inputBg: '#0e2240',
    success: '#00E676',
    error: '#FF5252',
    warning: '#FFD740',
    glassBg: 'rgba(10,22,40,0.9)',
    glassBlur: 'blur(20px)',
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald Casino',
    icon: '💚',
    pageBg: '#0a1a14',
    cardBg: '#112a1e',
    cardBgHover: '#163a28',
    primary: '#22c55e',
    accent: '#FFD700',
    textPrimary: '#E4F0E8',
    textSecondary: '#88AA99',
    border: '#1e5f3a',
    inputBg: '#0e4028',
    success: '#22c55e',
    error: '#FF5252',
    warning: '#FFD740',
    glassBg: 'rgba(10,26,20,0.9)',
    glassBlur: 'blur(20px)',
  },
};

const THEME_STORAGE_KEY = 'ca_club_theme_';

export function getStoredThemeId(clubId: string | null): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY + (clubId || '')) || 'dark';
  } catch {
    return 'dark';
  }
}

export function getTheme(themeId: string): ClubTheme {
  return THEMES[themeId] || THEMES.dark;
}

export function useClubTheme(clubId: string | null) {
  const [themeId, setThemeIdState] = useState(() => getStoredThemeId(clubId));
  const theme = THEMES[themeId] || THEMES.dark;

  const setThemeId = useCallback(
    (id: string) => {
      if (!THEMES[id]) return;
      setThemeIdState(id);
      try {
        localStorage.setItem(THEME_STORAGE_KEY + (clubId || ''), id);
      } catch {
        /* localStorage unavailable */
      }
    },
    [clubId]
  );

  useEffect(() => {
    setThemeIdState(getStoredThemeId(clubId));
  }, [clubId]);

  return { theme, themeId, setThemeId, allThemes: THEMES };
}

export default useClubTheme;
