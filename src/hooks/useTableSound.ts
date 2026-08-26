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
  // We use a ref guard so this only executes once (not on every toggle).
  // Subsequent changes are handled synchronously inside setIsSoundEnabled().
  const mountedRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    soundService.setEnabled(readBool(STORAGE_SOUND, true));
  }

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
