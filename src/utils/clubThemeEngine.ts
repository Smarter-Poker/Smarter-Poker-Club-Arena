/**
 * Club Arena Theme Engine — Per-club theme switching
 * Ported from Hub's ClubThemeEngine.js → TypeScript
 *
 * Usage:
 *   import { useClubTheme, THEMES } from '../utils/clubThemeEngine';
 *   const { theme, setThemeId, themeId } = useClubTheme(clubId);
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * AUDIT 2026-08-25 — what this engine does, and what it does NOT do yet.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * WORKS: three genuinely distinct token sets (dark / midnight / emerald), one
 * stored id per club, validated on write.
 *
 * FIXED HERE: `setThemeId` wrote localStorage and updated ONLY the hook
 * instance it was called from. Every other mounted consumer kept rendering the
 * previous theme until it happened to remount, so a picker and the shell it
 * was meant to repaint disagreed on screen — the opposite of applying in real
 * time. Consumers now share a subscription: one write repaints all of them in
 * the same tick, and a `storage` event carries the change to other tabs.
 *
 * STILL OPEN, and NOT this file's to close (recorded so it is not lost):
 * `Shell.tsx` is the only consumer, and it writes the theme out as
 * `--club-bg` / `--club-card-bg` / `--club-primary` / `--club-accent` on the
 * document element. Nothing in the codebase reads any of those four custom
 * properties, so all three themes currently paint identically. There is also
 * no UI anywhere that calls `setThemeId`, so the value is permanently 'dark'.
 * Wiring a picker without first giving those variables a consumer would ship
 * three options that change nothing, which is the exact defect this audit was
 * opened for. Consumer first, then picker.
 */

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

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
    icon: '◐',
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
    icon: '●',
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
    icon: '◆',
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

export const CLUB_THEME_IDS: string[] = Object.keys(THEMES);
export const DEFAULT_CLUB_THEME_ID = 'dark';

const THEME_STORAGE_KEY = 'ca_club_theme_';

export function isKnownClubThemeId(id: string | null | undefined): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(THEMES, id);
}

export function getStoredThemeId(clubId: string | null): string {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY + (clubId || ''));
    // An id we no longer ship must not be handed back: `getTheme` would fall
    // through to dark while the caller believed the stored id was in use.
    return isKnownClubThemeId(stored) ? (stored as string) : DEFAULT_CLUB_THEME_ID;
  } catch {
    return DEFAULT_CLUB_THEME_ID;
  }
}

export function getTheme(themeId: string): ClubTheme {
  return THEMES[themeId] || THEMES[DEFAULT_CLUB_THEME_ID];
}

// ─── Live propagation ────────────────────────────────────────────────────────
//
// One registry for the whole tab. A write notifies every mounted consumer,
// which is what makes a selection visible everywhere at once rather than only
// where it was made.

type Listener = () => void;
const listeners = new Set<Listener>();

function notifyClubThemeChanged() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a broken consumer must not stop the rest repainting */
    }
  });
}

function subscribeClubTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Store a club's theme. Returns false, and changes NOTHING, for an id we do
 * not ship — a caller can then say so instead of reporting a save that never
 * happened.
 */
export function setStoredThemeId(clubId: string | null, id: string): boolean {
  if (!isKnownClubThemeId(id)) return false;
  try {
    localStorage.setItem(THEME_STORAGE_KEY + (clubId || ''), id);
  } catch {
    /* localStorage unavailable: the in-memory change below still applies */
  }
  notifyClubThemeChanged();
  return true;
}

export function useClubTheme(clubId: string | null) {
  const [themeId, setThemeIdState] = useState(() => getStoredThemeId(clubId));

  const setThemeId = useCallback(
    (id: string): boolean => {
      if (!setStoredThemeId(clubId, id)) return false;
      setThemeIdState(id);
      return true;
    },
    [clubId]
  );

  useEffect(() => {
    setThemeIdState(getStoredThemeId(clubId));
  }, [clubId]);

  /** Another consumer in this tab changed the theme. */
  useEffect(() => {
    return subscribeClubTheme(() => {
      setThemeIdState((prev) => {
        const next = getStoredThemeId(clubId);
        return prev === next ? prev : next;
      });
    });
  }, [clubId]);

  /** Another TAB changed it. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY + (clubId || '')) return;
      setThemeIdState((prev) => {
        const next = getStoredThemeId(clubId);
        return prev === next ? prev : next;
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [clubId]);

  const theme = THEMES[themeId] || THEMES[DEFAULT_CLUB_THEME_ID];

  return { theme, themeId, setThemeId, allThemes: THEMES };
}

/**
 * Read-only subscription for anything that wants the current id without a
 * setter. Exported alongside the hook so a future picker and a future consumer
 * cannot end up on two different notification paths.
 */
export function useClubThemeId(clubId: string | null): string {
  return useSyncExternalStore(
    subscribeClubTheme,
    () => getStoredThemeId(clubId),
    () => DEFAULT_CLUB_THEME_ID
  );
}

export default useClubTheme;
