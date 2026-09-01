/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO RESULT WITHOUT A HAND (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The stuck-COMPLETING rescue ranks the surviving field BY CHIP COUNT and pays
 * the published structure against that order. That is correct for a tournament
 * that crashed between its finish and its payout, and it is a fabrication for a
 * tournament that never dealt a card - because then every survivor is holding
 * the identical starting stack, and sorting identical numbers does not produce
 * a ranking, it produces whatever order the rows arrived in.
 *
 * MEASURED LIVE. Seven events between 2026-08-15 and 2026-08-30 were ranked
 * end to end without a single hand being dealt in any of them:
 *
 *   event                          entrants  ranked  seconds  chips paid
 *   $100 Freeroll 6:00 PM               313     312       58        0.00
 *   $100 Freeroll 12:00 PM              326     325       89        0.00
 *   Friday Six-Card Nightcap             24      23      216      216.00
 *   Sunday Deep Stack Satellite $5       24      23       84      108.00
 *   Turbo Tuesday PLO Deepstack          24      23       89      216.00
 *   All-In or Fold Frenzy                16      15       91       32.00
 *   Afternoon Bounty (NLH)               18      17      199      203.00
 *
 * Every one has the same shape: one arbitrary survivor stamped `winner` with
 * first prize, the whole rest of the field stamped `eliminated` with a
 * finishing place, positions assigned 1..N in a single sequential loop lasting
 * a few seconds, `hand_history` empty for the tournament, and every alive row
 * holding exactly `starting_chips`. 775.00 chips were disbursed on those
 * fabricated podiums. Every recipient happened to be a horse, which is luck,
 * not a mitigation: under HORSES ARE PLAYERS a horse paid a prize it did not
 * win is the same defect as a human paid one.
 *
 * WHY THE TWO GUARDS ALREADY THERE MISSED IT.
 *
 *   `anyDealtIn` (2026-08-31) asks whether any survivor is `status = 'playing'`
 *   and treats that as "somebody was dealt a card". It is a proxy, and it is
 *   the wrong one: a tournament promotes every entrant to `playing` when it
 *   starts, before a card exists. All seven fields were `playing`, so the
 *   guard passed on all seven.
 *
 *   `fieldIsStillLive` (2026-08-30) asks whether the field is larger than the
 *   number of paid places, and RETURNS FALSE WHEN `paidPlaces` IS 0 by design,
 *   so as not to swallow an unresolved payout structure. Both $100 Freerolls
 *   carried an unfunded guarantee, so their prize pool was 0.00, so their
 *   structure paid 0 places, so the guard abstained on a 313-player field.
 *
 * THE RULE, and it needs neither a clock nor a payout structure: a rescue may
 * rank survivors by chips only if the chips actually distinguish them. Where
 * two or more survivors hold the same stack down to the chip, there is nothing
 * in the data that says who beat whom, and inventing an order moves money.
 */

export interface RankEvidenceRow {
  /** The stack this survivor holds, as read from `tournament_players.chips`. */
  chips: number | null;
}

/**
 * True when the `chips` sort cannot produce a ranking and the rescue must NOT
 * pay a structure against it.
 *
 * - 0 or 1 survivor: nothing to distinguish, and a lone survivor is the
 *   legitimate crash-at-finish case this rescue exists for. Returns false.
 * - 2 or more survivors all holding an identical stack: the order is arbitrary.
 *   Returns true.
 *
 * A null / absent / unparseable stack counts as its own value of 0 rather than
 * being dropped, so a field of unwritten chip columns reads as identical and is
 * refused, which is the safe side.
 */
export function chipsCannotRank(alive: readonly RankEvidenceRow[]): boolean {
  if (!Array.isArray(alive) || alive.length < 2) return false;
  const first = Math.floor(Number(alive[0]?.chips) || 0);
  for (let i = 1; i < alive.length; i++) {
    if (Math.floor(Number(alive[i]?.chips) || 0) !== first) return false;
  }
  return true;
}

/**
 * How long after a tournament starts we can still count on `hand_history` to
 * answer "was a card dealt here". `sp_prune_hand_history` deletes horse-only
 * hands after `hand_history_retention_policy.horse_retention_days` (7 as this
 * was written, and Dan's to change), and 99.95% of hands on this platform are
 * horse-only. Past that window an empty `hand_history` is not evidence of
 * anything, so the hand test below stands down and `chipsCannotRank` - which
 * reads columns nothing prunes - carries the rule on its own.
 */
export const HAND_EVIDENCE_WINDOW_DAYS = 6;

export interface HandEvidenceInput {
  /** When the tournament started, or null if it never did. */
  startedAt: string | null | undefined;
  /** True when at least one `hand_history` row exists for the tournament. */
  anyHandDealt: boolean;
  /** Clock injection for tests. */
  now?: number;
}

/**
 * True when this tournament is recent enough for `hand_history` to be complete
 * AND holds no hand at all, so no result of any kind can have happened in it.
 *
 * A tournament that has not started cannot have dealt either, and is refused
 * for the same reason.
 */
export function noHandWasEverDealt(input: HandEvidenceInput): boolean {
  if (input.anyHandDealt) return false;
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const started = input.startedAt ? new Date(input.startedAt).getTime() : NaN;
  if (!Number.isFinite(started)) return true; // never started, never dealt
  const ageDays = (now - started) / 86_400_000;
  return ageDays <= HAND_EVIDENCE_WINDOW_DAYS;
}
