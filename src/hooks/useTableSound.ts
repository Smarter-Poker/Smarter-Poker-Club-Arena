/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableSound — Sound & vibration preference state for the poker table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx. Manages the three localStorage-persisted
 * player preferences (sound, vibration, auto-rebuy) and the playTurnAlert
 * helper that guards against stale closure bugs.
 *
 * NOTE: playWinSound() is intentionally LEFT in TablePage because it requires
 *       tableStateRef.current.blinds + safeBB — two deeply-nested closures
 *       that would make the hook contract very wide for little benefit.
 */

import { useState, useEffect, useRef } from 'react';
import { soundService } from '../services/SoundService';
import { isSoundAllowed } from '../utils/soundGate';

export interface UseTableSoundReturn {
  /** Whether sound effects are active. Read this for UI toggle state. */
  isSoundEnabled: boolean;
  setIsSoundEnabled: (v: boolean) => void;

  /** Whether haptic/vibration feedback is active. */
  isVibrationEnabled: boolean;
  setIsVibrationEnabled: (v: boolean) => void;

  /** Whether the player has enabled auto-rebuy between hands. */
  isAutoRebuyEnabled: boolean;
  // Accepts an updater so bus callbacks (which are registered once and would
  // otherwise close over a stale value) can toggle correctly.
  setIsAutoRebuyEnabled: React.Dispatch<React.SetStateAction<boolean>>;

  /**
   * Play the "your turn" audio alert.
   * Uses soundService.isEnabled() (not the stale `isSoundEnabled` closure)
   * per NEW-BUG-1 fix.
   */
  playTurnAlert: () => void;
}

const STORAGE_SOUND = 'ca_sound_enabled';
const STORAGE_VIBRATION = 'ca_vibration_enabled';
const STORAGE_AUTO_REBUY = 'ca_auto_rebuy';

function readBool(key: string, defaultVal: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultVal;
    return raw !== 'false';
  } catch {
    return defaultVal;
  }
}

export function useTableSound(): UseTableSoundReturn {
  const [isSoundEnabled, setIsSoundEnabledRaw] = useState<boolean>(() =>
    readBool(STORAGE_SOUND, true)
  );
  const [isVibrationEnabled, setIsVibrationEnabledRaw] = useState<boolean>(() =>
    readBool(STORAGE_VIBRATION, true)
  );
  const [isAutoRebuyEnabled, setIsAutoRebuyEnabledRaw] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_AUTO_REBUY) === 'true';
    } catch {
      return false;
    }
  });

  // Persist to localStorage whenever values change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SOUND, String(isSoundEnabled));
    } catch {
      /* unavailable */
    }
  }, [isSoundEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_VIBRATION, String(isVibrationEnabled));
    } catch {
      /* unavailable */
    }
  }, [isVibrationEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_AUTO_REBUY, String(isAutoRebuyEnabled));
    } catch {
      /* unavailable */
    }
  }, [isAutoRebuyEnabled]);

  // Mount-only sync: align soundService singleton with the stored preference.
  // SOUND AUDIT 2026-08-27: two fixes here.
  // 1. This ran in the RENDER BODY — setEnabled() writes localStorage via
  //    persistSoundPreference, and under StrictMode/concurrent rendering a
  //    discarded render could still fire that side effect. Now an effect.
  // 2. It seeded from STORAGE_SOUND alone, but setEnabled persists to BOTH
  //    gate keys — so a mute recorded only in 'club_arena_sounds' (Settings /
  //    HamburgerMenu) was clobbered back to audible on every table mount.
  //    Seed from the shared gate, which fails closed on either key.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    soundService.setEnabled(isSoundAllowed());
  }, []);

  const setIsSoundEnabled = (v: boolean) => {
    setIsSoundEnabledRaw(v);
    soundService.setEnabled(v);
  };

  const setIsVibrationEnabled = (v: boolean) => {
    setIsVibrationEnabledRaw(v);
  };

  const setIsAutoRebuyEnabled = setIsAutoRebuyEnabledRaw;

  // NEW-BUG-1 FIX: use dynamic isEnabled() not stale closure
  const playTurnAlert = () => {
    if (soundService.isEnabled()) {
      soundService.playTurnAlert();
    }
  };

  return {
    isSoundEnabled,
    setIsSoundEnabled,
    isVibrationEnabled,
    setIsVibrationEnabled,
    isAutoRebuyEnabled,
    setIsAutoRebuyEnabled,
    playTurnAlert,
  };
}
