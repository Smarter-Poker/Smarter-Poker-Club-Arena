/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN REVEAL — one rule for "may this surface show the multiplier yet?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * In a Spin the draw is the product. The seconds in which the wheel decides
 * whether you are playing for 2x or 100x are the whole reason the format
 * exists, and every surface that prints the number before the wheel lands
 * spends that moment for nothing.
 *
 * Before this file, five separate surfaces printed it independently:
 *
 *   the tournament NAME               "3 Chip Spin NLH (4x)"  (fixed at source)
 *   TournamentPage lobby stat         "Multiplier  4x"
 *   TournamentDetails header          "SPIN & GO — 4x MULTIPLIER"
 *   TournamentDetails info row        "Spin Multiplier:  4x"
 *   DynamicGameCard SpinCard          "Win up to 4"
 *
 * Fixing them one at a time is how the multiplier leaked back in the last four
 * times a surface was added. So the rule lives here, once, and every surface
 * asks rather than deciding for itself.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 *
 * A Spin's multiplier is public only once the tournament has actually started.
 * Before that it is "TBD": the tournament is still sitting in the lobby, the
 * wheel has not run, and no player should be able to read the outcome off a
 * list.
 *
 * The table is deliberately NOT covered by this rule. By the time a Spin table
 * opens the tournament is RUNNING, so `spinMultiplierRevealed` is true there —
 * the table's own gate is the wheel itself (the persistent badge waits for the
 * wheel to finish). Two different questions, two different gates; conflating
 * them is what would put the number back on screen underneath the wheel.
 *
 * ─── RESIDUAL, STATED HONESTLY ──────────────────────────────────────────────
 *
 * `spin_multiplier` is still SELECTed by the lobby queries, so a determined
 * player with devtools can read it before the wheel. Closing that needs the
 * column withheld server-side for un-started Spins (an RLS/view change), which
 * is a larger and separate piece of work. This file closes every surface a
 * player actually looks at; it does not claim to close the API.
 */

/** The minimum shape any surface has on hand. All fields optional on purpose. */
export interface SpinRevealSubject {
  variant?: string | null;
  tournament_type?: string | null;
  status?: string | null;
  started_at?: string | null;
}

/**
 * Statuses that mean "has not started yet". Anything NOT in this set counts as
 * started, which is the safe direction: a status we have never seen before
 * reveals a multiplier that is already decided rather than hiding one forever
 * on a finished tournament.
 */
const PRE_START_STATUSES = new Set([
  'REGISTERING',
  'SCHEDULED',
  'PENDING',
  'ANNOUNCED',
  'UPCOMING',
  'REGISTRATION_OPEN',
]);

/** Is this tournament a Spin? Both columns are checked; either one may be set.
 *
 * KNOWN LATENT DIVERGENCE (ITEM E audit, 2026-08-26): classifyTournament in
 * lobbyEntries additionally falls back to `name.includes('spin')` when the
 * variant column is absent, so a name-only "Spin" is a Spin to the lobby's
 * card classifier and NOT a Spin to this reveal gate — which would then treat
 * it as "always revealed". Not reachable today: `spin_multiplier` is only
 * ever written at start (HorseOrchestrator writes null at creation; the one
 * SQL writer is gated on RUNNING/COMPLETED), and every multiplier label
 * returns null for a falsy multiplier before this gate is consulted. If a
 * pre-start writer of spin_multiplier ever appears, unify these two
 * predicates FIRST. */
export function isSpinTournament(t: SpinRevealSubject | null | undefined): boolean {
  if (!t) return false;
  return (
    String(t.variant ?? '').toLowerCase() === 'spin' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SPIN'
  );
}

/**
 * May a lobby / list / details surface print the multiplier?
 *
 * Non-Spins are always "revealed" — they have no multiplier to protect, and a
 * caller that guards a non-Spin field with this must not be silently blanked.
 */
export function spinMultiplierRevealed(t: SpinRevealSubject | null | undefined): boolean {
  if (!isSpinTournament(t)) return true;
  if (t?.started_at) return true;
  const status = String(t?.status ?? '').toUpperCase();
  if (!status) return false; // unknown state errs toward hiding
  return !PRE_START_STATUSES.has(status);
}

/**
 * What a surface should print. Returns null when the answer is still secret,
 * so callers render their own placeholder ("TBD", "Revealed at game start")
 * in their own voice rather than importing a string from here.
 */
export function spinMultiplierLabel(
  t: (SpinRevealSubject & { spin_multiplier?: number | null }) | null | undefined
): string | null {
  if (!t?.spin_multiplier) return null;
  if (!spinMultiplierRevealed(t)) return null;
  return `${t.spin_multiplier}x`;
}
