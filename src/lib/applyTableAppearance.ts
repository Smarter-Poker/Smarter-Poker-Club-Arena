/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE WRITER FOR TABLE APPEARANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "if a user changes their avatar, deck color, table,
 * background, button or anything else... it needs to change, save and update
 * in real time on the felt."
 *
 * WHY THIS FILE EXISTS. The felt reads its appearance from exactly one place —
 * `user_theme_settings` via `useUserThemeSettings` (TablePage: `resolveSkin`,
 * `resolveBackgroundLayers`, `activeCardBack`, and the `data-*-theme`
 * attributes). But THREE different surfaces wrote it, each with its own hand
 * -rolled upsert, and a fourth wrote somewhere else entirely:
 *
 *   TablePage.onCardBackChanged   correct: emit, then a minimal upsert.
 *   HamburgerMenu card tiles      SELECT '*' then spread the whole row back
 *                                 into the upsert — re-sending `id`,
 *                                 `created_at`, `updated_at`, `user_id` and
 *                                 `game_type` to PostgREST. One generated or
 *                                 immutable column and the write fails, the
 *                                 tile reverts, and the player is told their
 *                                 card back "could not save" for no reason
 *                                 they can see.
 *   ThemeSettingsModal            correct, per game type.
 *   /settings "Card Back Style"   wrote `useTableSettings.cardBack`, which
 *                                 the felt reads ONLY as
 *                                 `v8Theme.cards_id || userSettings.cardBack`
 *                                 — and `cards_id` is never falsy, because
 *                                 `toSelection()` fills it from DEFAULT_THEME.
 *                                 So that dropdown was UNREACHABLE: it saved,
 *                                 said "Settings saved!", and the felt kept
 *                                 dealing the old design forever. Exactly the
 *                                 complaint above.
 *
 * Four writers, three shapes, one of them structurally broken and one of them
 * pointed at a dead key. This module is the single path all of them now use:
 * emit first so the felt repaints instantly, then write ONLY the columns being
 * changed, then revert the emit if the write failed.
 *
 * It deliberately does NOT own reading. `useUserThemeSettings` remains the one
 * reader; a writer that also reads is how the two drift apart again.
 */

import { supabase } from './supabase';
import { masterBus } from '../core/MasterBus';

/** The five columns of `user_theme_settings` the felt actually paints from. */
export interface AppearancePatch {
  theme_id?: string;
  table_id?: string;
  button_id?: string;
  background_id?: string;
  cards_id?: string;
}

export interface ApplyAppearanceResult {
  ok: boolean;
  /** Present when the write failed; the caller decides how loudly to say so. */
  error?: unknown;
}

/**
 * Apply an appearance change everywhere, at once.
 *
 * @param patch     only the columns being changed — never a whole row.
 * @param opts.userId    signed-in user. Without one the change is applied
 *                       LIVE but not persisted, and `ok` is false so the
 *                       caller can say why rather than showing a false tick.
 * @param opts.gameType  which bucket to write. 'ALL' is the global default and
 *                       is what every non-per-variant surface should use.
 * @param opts.previous  what to put back if the write fails. Supply it and a
 *                       failed save visibly reverts instead of leaving the
 *                       felt showing something the server never accepted.
 */
export async function applyTableAppearance(
  patch: AppearancePatch,
  opts: { userId?: string | null; gameType?: string; previous?: AppearancePatch }
): Promise<ApplyAppearanceResult> {
  const gameType = opts.gameType || 'ALL';

  // 1. LIVE FIRST — the felt must move on the same frame as the click, not
  //    after a network round trip. Every subscriber keys off this event.
  masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: patch });

  /* The card back additionally drives `useTableSettings.cardBack`, which is
     what the /settings page and the card-back store display. Keeping the two
     in step here is what stops that dropdown showing one design while the
     felt deals another. */
  if (patch.cards_id) {
    masterBus.emit('SETTINGS_CHANGED', { setting: 'cardBack', value: patch.cards_id });
  }

  if (!opts.userId) {
    return { ok: false, error: new Error('not signed in') };
  }

  // 2. PERSIST — only the columns being changed, plus the composite key.
  //    Never a spread of a previously SELECTed row (see the note above).
  const { error } = await supabase
    .from('user_theme_settings')
    .upsert(
      { user_id: opts.userId, game_type: gameType, ...patch },
      { onConflict: 'user_id,game_type' }
    );

  if (error) {
    // 3. PUT IT BACK. A felt showing a choice the database rejected is worse
    //    than one that never changed: the player believes it is saved.
    if (opts.previous) {
      masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: opts.previous });
      if (opts.previous.cards_id) {
        masterBus.emit('SETTINGS_CHANGED', {
          setting: 'cardBack',
          value: opts.previous.cards_id,
        });
      }
    }
    return { ok: false, error };
  }

  return { ok: true };
}
