/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOUND GATE — the single place that decides whether the app makes noise
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION/SOUND AUDIT 2026-08-20.
 *
 * Club Arena has two sound switches a player can reach, and they wrote
 * different keys to different engines. The result was that NEITHER switch
 * actually muted the app:
 *
 *   Settings / HamburgerMenu  writes 'club_arena_sounds'
 *       -> read by PremiumSFX
 *       -> NEVER calls soundService.setEnabled(), so the main engine — which
 *          is every card, chip, fold, all-in and pot sound — kept playing.
 *
 *   In-table Sounds toggle    writes 'ca_sound_enabled' (useTableSound)
 *       -> calls soundService.setEnabled(), muting the main engine
 *       -> PremiumSFX never reads that key, so premium cues kept playing.
 *
 * And because useTableSound re-applies 'ca_sound_enabled' to the service on
 * every mount, opening a table would silently undo a mute set in Settings.
 *
 * A player turning sound off and still hearing the table is about as clear a
 * "the app is ignoring me" signal as exists, so this gate fails CLOSED on the
 * player's intent: EITHER switch being off silences EVERYTHING.
 *
 * There is a third key, 'table_sound_muted', which exactly one line ever read
 * (TableMenu) and which nothing has ever written. It is not part of the
 * contract; that read now comes here instead.
 */

const SETTINGS_KEY = 'club_arena_sounds'; // STORAGE_KEYS.SOUNDS
const IN_TABLE_KEY = 'ca_sound_enabled'; // useTableSound

/** True when the player has not switched sound off in either place. */
export function isSoundAllowed(): boolean {
  try {
    if (localStorage.getItem(IN_TABLE_KEY) === 'false') return false;
    if (localStorage.getItem(SETTINGS_KEY) === 'false') return false;
    return true;
  } catch {
    // localStorage unavailable (private mode, embedded webview): no readable
    // preference, so default to audible.
    return true;
  }
}

/**
 * Write the player's choice to BOTH keys.
 *
 * Whichever switch the player touched, the other must agree — otherwise the
 * next mount reads the stale one and undoes them. Callers should still update
 * their own React state; this only owns the persisted truth.
 */
export function persistSoundPreference(enabled: boolean): void {
  try {
    localStorage.setItem(IN_TABLE_KEY, String(enabled));
    localStorage.setItem(SETTINGS_KEY, String(enabled));
  } catch {
    /* unavailable */
  }
}
