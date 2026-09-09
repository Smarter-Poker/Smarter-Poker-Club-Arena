/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DRAW REACHES MEMORY WHOLE, OR IT DOES NOT REACH IT AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When a Spin's tier is drawn at start, fn_spin_draw_and_settle commits its
 * multiplier, prize pool and locked tiers in the same transaction as the
 * reserve/journal receipt. TournamentManagerBase then proves its separate
 * presentation patch (blind ladder, payout structure and reveal timing) and
 * merges both proven shapes into `spinMemoryPatch`. The live `tournament`
 * object drives table creation and the level clock, and `this.tournamentCache`
 * is what the elimination and bubble paths read for the rest of the game.
 *
 * That sync was written out field by field, and it copied FOUR of the five
 * fields the patch carried. `payout_structure` was the one left behind, so for
 * the whole life of a started Spin the cache held the pre-draw winner-take-all
 * PLACEHOLDER. `recalculateEliminatedPrizes` and the hand-for-hand bubble check
 * both read that cache, so the top-up of an eliminated player's prize was
 * computed against a different structure than the payment it was topping up —
 * on a 10x (80/20) or a 25x+ (80/12/8) those are not the same money.
 *
 * The sync block's own comment already said the in-memory object "must agree
 * with what was just written". A hand-written list of field names cannot keep
 * that promise: it is correct only until the next field is added to the patch,
 * and nothing fails when somebody forgets. THIS function is the promise made
 * mechanical — the patch is the single list, and every key in it lands on
 * every target. Add a sixth field to `spinRowPatch` and it is synced by
 * construction; there is no second per-field list to remember.
 *
 * `SpinDrawIntegrity.guard.test.ts` pins both halves: that this copies every
 * key of whatever it is handed, and that the draw site hands it the whole
 * patch rather than naming fields again.
 */

/** Anything the draw patch can be applied onto: the row object or the cache. */
export type SpinDrawTarget = Record<string, unknown> | null | undefined;

/**
 * Copy EVERY field of the draw patch onto each in-memory target.
 *
 * Null and undefined targets are skipped rather than thrown on: the cache is
 * legitimately absent on some start paths, and a sync that could throw would
 * be a new way for a drawn spin to fail to start.
 */
export function applySpinDrawPatch(
  patch: Record<string, unknown>,
  ...targets: SpinDrawTarget[]
): void {
  if (!patch || typeof patch !== 'object') return;
  const keys = Object.keys(patch);
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    for (const key of keys) target[key] = patch[key];
  }
}
