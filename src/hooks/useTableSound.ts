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
import { setTableSetting, useTableSettings } from './useTableSettings';

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

/* `STORAGE_SOUND` and `STORAGE_VIBRATION` are both gone with the last
   hand-rolled read or write of them. The haptic switch reads and writes through
   `utils/vibrationGate`, which owns those keys; the sound switch reads the
   shared settings store and writes through `soundService.setEnabled`, which
   persists both gate keys itself. */
const STORAGE_AUTO_REBUY = 'ca_auto_rebuy';

/* `readBool` and `SETTINGS_VIBRATION` lived here until 2026-08-29. Both were
   this file's own copy of what `utils/soundGate` and `utils/vibrationGate`
   already decide, and the copy is what let the haptic switch fall behind the
   sound one. Both switches read their gate now.

   `readBool` was also fail-OPEN — `raw !== 'false'` treats '0', 'off' and ''
   as ON — against the fail-CLOSED convention both gate files establish. */

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
   *
   * ═════════════════════════════════════════════════════════════════════════
   *  ...AND THEN THEY READ IT ONCE AND NEVER AGAIN (fixed 2026-09-09)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Both were private `useState`s SEEDED at mount with no subscription to
   * anything. PersistentTableLayer keeps every TablePage mounted for the life
   * of the session, so "at mount" means "the first time this table was ever
   * opened". Mute from the global hamburger menu or the Settings panel and
   * these two never heard about it:
   *
   *   - the in-table badge read ON while the app was silent - the very symptom
   *     the note above says it fixed, arriving by the other door;
   *   - all three toggle call sites compute `!isSoundEnabled` from the stale
   *     value, so the first press re-sent the state the app was already in and
   *     the player had to press TWICE;
   *   - the ambient layer keys off this flag and stayed audible after a mute.
   *
   * `useTableSettings()` is a `useSyncExternalStore` over the shared settings
   * store - the same store `setTableSetting` writes below, the same one the
   * SETTINGS_CHANGED bus and the cross-device row feed, and it is already
   * reconciled against both gates when it loads. Reading it means there is one
   * value, and every writer moves it.
   */
  const { settings } = useTableSettings();
  const isSoundEnabled = settings.isSoundEnabled;
  /* The store's `isHapticEnabled` is a PREFERENCE, like `isVibrationPreferred()`
     was - never `isVibrationAllowed()`, which also returns false when the
     DEVICE cannot vibrate. A desktop player must not see their haptics switch
     stuck off. */
  const isVibrationEnabled = settings.isHapticEnabled;
  const [isAutoRebuyEnabled, setIsAutoRebuyEnabledRaw] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_AUTO_REBUY) === 'true';
    } catch {
      return false;
    }
  });

  /* The two persist effects that lived here are gone with the local state they
     mirrored (2026-09-09). Both keys are still written on every change, by the
     writers the store already owns: `soundService.setEnabled` persists both
     sound-gate keys, `setVibrationAllowed` persists both vibration-gate keys,
     and the settings store calls each of them itself whenever its value moves
     (applySideEffects) - including a change that arrived from another tab or
     from the account's row. Mirroring them here as well is what let this file's
     copy drift from the store's in the first place. */

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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  ONE SETTER, SO NO CALL SITE CAN GET IT HALF-RIGHT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * These reach the ENGINE (via the gate) and the STORE (which owns the
   * cross-device copy). Until 2026-08-29 they reached only the engine, and
   * TablePage had FOUR sound call sites that called this and stopped — the bus
   * `TOGGLE_SOUNDS` branch, the quick-actions bar, the table menu and the side
   * menu. Muting from any of them left the settings panel showing Sound ON and
   * `user_table_settings.sound_enabled` unwritten, so the mute never followed
   * the account to another device.
   *
   * The alternative was to fix four call sites and hope the fifth remembers.
   * `setTableSetting` is `useTableSettings`' own writer, hoisted out of the hook
   * so it can be called from here; it commits to the shared store, broadcasts
   * for other tabs, and pushes the column.
   */
  const setIsSoundEnabled = (v: boolean) => {
    soundService.setEnabled(v); // both gate keys + the live engine flag
    // The store is the state: every reader of this hook re-renders from it.
    setTableSetting('isSoundEnabled', v);
  };

  const setIsVibrationEnabled = (v: boolean) => {
    setVibrationAllowed(v); // both gate keys
    setTableSetting('isHapticEnabled', v);
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
