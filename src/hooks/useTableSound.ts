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
import { setVibrationAllowed } from '../utils/vibrationGate';

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
/** vibrationGate's OTHER key — Settings / HamburgerMenu. Both gate this switch. */
const SETTINGS_VIBRATION = 'vibrationsEnabled';
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  SEED FROM THE GATE, NOT FROM ONE OF THE TWO KEYS IT READS
   * ═════════════════════════════════════════════════════════════════════════
   *
   * 2026-08-29. Fix 2 below made the ENGINE seed from `isSoundAllowed()` and
   * left the REACT STATE seeding from `ca_sound_enabled` alone, so the two
   * disagreed for exactly the player the fix was written for.
   *
   * A player who muted in Settings or the hamburger menu has
   * `club_arena_sounds='false'` and, commonly, no `ca_sound_enabled` at all.
   * `readBool` then returned its default of TRUE:
   *
   *   - the in-table badge read ON while the app was silent;
   *   - worse, effects run in declaration order, so the persist effect below
   *     wrote `ca_sound_enabled='true'` from that stale state BEFORE the mount
   *     effect called `setEnabled(false)` and wrote it back to `'false'`;
   *   - so the first press computed `!true = false` and muted something
   *     already muted. The player had to press TWICE to get sound back, with
   *     the switch lying the whole time.
   *
   * Both halves now read the same gate, which fails closed on either key.
   * Vibration gets the same treatment for the same reason.
   */
  const [isSoundEnabled, setIsSoundEnabledRaw] = useState<boolean>(() => isSoundAllowed());
  const [isVibrationEnabled, setIsVibrationEnabledRaw] = useState<boolean>(
    () =>
      /* `isVibrationAllowed()` also returns false when the DEVICE cannot vibrate,
       which is not a preference — a desktop player must not see their haptics
       switch stuck off. Read the preference only. */
      readBool(STORAGE_VIBRATION, true) && readBool(SETTINGS_VIBRATION, true)
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

  /* Persist through the GATE, which writes both of its keys.
     Writing only `ca_vibration_enabled` here was the haptic twin of the sound
     bug above, and it survived the 2026-08-27 sweep that fixed the sound side:
     a player who muted haptics in Settings ('vibrationsEnabled'='false') and
     then turned them ON at the table stayed silent, because the gate fails
     closed on EITHER key and nothing here ever cleared the other one. The
     switch read ON and the phone never buzzed. */
  useEffect(() => {
    setVibrationAllowed(isVibrationEnabled);
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
