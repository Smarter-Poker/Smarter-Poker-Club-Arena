/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MOVING DOWN (and back up) A STAKE AS THE BANKROLL SHRINKS AND GROWS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31: "...GOING DOWN OR UP IN STAKES AS THEIR BANK ROLL GROWS OR
 * SHRINKS." Nothing did that. `canMoveUp`, `shouldMoveDown` and
 * `bestAffordableGame` were written and tested this morning and had ZERO
 * callers — the same failure as `sessionVerdict`, which also shipped correct
 * and unwired.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT WAS IMPOSSIBLE, NOT MERELY MISSING
 * ─────────────────────────────────────────────────────────────────────────
 * `stakeBandAllows` is an EXACT MATCH: a horse banded `mid` may sit `mid`
 * tables and nothing else. So a horse whose roll can no longer carry its own
 * band does not move down — it stops playing. Measured on 2026-08-31, before
 * any reset:
 *
 *     micro  127 horses   NO OPEN TABLE IN BAND (every micro table closed)
 *     low    336 horses   all can sit
 *     mid     73 horses   nits cannot sit at a 10,000 roll
 *     high    48 horses   NO OPEN TABLE IN BAND (nothing above 2/5 exists)
 *
 * 175 of 584 horses — 30% of the fleet — were banded into a stake with no
 * table in it, and had no legal way anywhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE: MERIT IS A CEILING, THE BANKROLL PICKS BENEATH IT
 * ─────────────────────────────────────────────────────────────────────────
 * A band is EARNED (Dan 2026-08-29), on bb/100 — it says which game a horse
 * has proven it belongs in. That stays exactly as it is as an upper bound:
 * NOTHING here ever lets a horse play ABOVE its band. What changes is that the
 * band stops being the only game it may play. A horse may sit at or below it,
 * and the bankroll decides which — which is what a real player does, and the
 * only reading of Dan's sentence that has any teeth.
 *
 * This does not reopen the escape hatch `stakeBandAllows` deliberately refuses.
 * That hatch was about seating a nosebleed regular in a micro game FOR
 * CONVENIENCE, while it could perfectly well afford its own stake — "a
 * nosebleed regular in a micro game is the tell". A descent only ever happens
 * when the horse genuinely cannot afford its own band any more, and a broke
 * high-stakes player grinding back up from a small game is not a tell. It is
 * the single most recognisable story in poker.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HYSTERESIS, WHICH IS THE WHOLE REASON THERE ARE THREE THRESHOLDS
 * ─────────────────────────────────────────────────────────────────────────
 * One threshold makes a horse flap: at exactly the sit bar it drops a rung,
 * the smaller game re-qualifies it, and it climbs straight back — every
 * seeding cycle, forever. The policy already carries the three figures that
 * prevent it, and they are used here for the first time:
 *
 *     canSit        (25 buy-ins)  what it takes to ENTER a game
 *     shouldMoveDown(17 buy-ins)  the LOWER bar at which you leave it
 *     canMoveUp     (35 buy-ins)  the HIGHER bar to climb back
 *
 * Between 17 and 25 buy-ins a horse simply stays put, and it must clear 35 to
 * return. The gap is the hysteresis, and without it the ladder is a metronome.
 */

import type { HorseStakeBand } from './HorseBehavior.js';
import { canMoveUp, canSit, shouldMoveDown, type BankrollPolicy } from './HorseBankroll.js';
import { bankrollEvent } from './HorseBankrollTelemetry.js';

/** Cheapest to dearest. Descent walks left, promotion walks right. */
export const BAND_ORDER: readonly HorseStakeBand[] = ['micro', 'low', 'mid', 'high'] as const;

/**
 * Where each horse is playing right now, when that is BELOW its earned band.
 *
 * Process-local and deliberately so: it is a hysteresis latch, not a fact
 * about the horse. A restart re-derives it from the bankroll on the next
 * cycle, which lands in the same place for any roll that is not sitting
 * exactly inside the 17-to-25 band where the latch is the tie-breaker.
 */
const currentBand = new Map<string, HorseStakeBand>();

/** Test/ops hook. */
export function resetStakeDescent(): void {
  currentBand.clear();
}

/** Test/ops hook: how many horses are currently playing below their band. */
export function descendedCount(): number {
  return currentBand.size;
}

export interface DescentInput {
  horseId: string;
  homeBand: HorseStakeBand;
  bankroll: number;
  /** Cheapest reference buy-in of an OPEN table in each band. */
  bandRef: ReadonlyMap<HorseStakeBand, number>;
  policy: BankrollPolicy;
}

export interface DescentResult {
  /** The band this horse may sit in this cycle. */
  band: HorseStakeBand;
  movedDown: boolean;
  movedUp: boolean;
  /** True when no band at or below the home band is affordable. */
  stranded: boolean;
}

const idx = (b: HorseStakeBand) => BAND_ORDER.indexOf(b);

/**
 * Resolve which band this horse plays now.
 *
 * FAILS OPEN in the only way that matters: with no bankroll figure, or no open
 * table anywhere to price a band against, the horse keeps its home band and
 * behaves exactly as it did before this module existed.
 */
export function resolveStakeBand(input: DescentInput): DescentResult {
  const { horseId, homeBand, bankroll, bandRef, policy } = input;
  const home = idx(homeBand);
  if (home < 0 || !(bankroll > 0)) {
    return { band: homeBand, movedDown: false, movedUp: false, stranded: false };
  }

  /**
   * NOTHING PRICEABLE MEANS NOTHING TO DECIDE.
   *
   * Caught by its own test: with an empty ladder the descent loop falls
   * through every band in turn and lands on the cheapest one, so a cycle where
   * the table read came back empty would have re-banded the ENTIRE FLEET to
   * `micro` — and the latch below would then have persisted that until each
   * horse individually clawed back up. An empty ladder is an unknown, not a
   * verdict: leave the horse exactly where it was and report it stranded.
   */
  let anyPriced = false;
  for (let i = 0; i <= home; i++) {
    const r = bandRef.get(BAND_ORDER[i]);
    if (r !== undefined && r > 0) {
      anyPriced = true;
      break;
    }
  }
  if (!anyPriced) {
    return { band: homeBand, movedDown: false, movedUp: false, stranded: true };
  }

  let here = idx(currentBand.get(horseId) ?? homeBand);
  if (here > home) here = home; // a re-band downward is authoritative immediately
  const before = here;

  // PROMOTION FIRST, at the stricter bar. A horse only climbs back toward the
  // band it earned; it can never pass it.
  while (here < home) {
    const up = bandRef.get(BAND_ORDER[here + 1]);
    if (!(up !== undefined && up > 0 && canMoveUp(bankroll, up, policy))) break;
    here++;
  }

  // DESCENT at the LOOSER bar, so the two cannot chase each other.
  while (here > 0) {
    const ref = bandRef.get(BAND_ORDER[here]);
    // A band with no open table is not a game: fall through it rather than
    // treating "unpriceable" as "affordable". This is the 127 micro-banded
    // and 48 high-banded horses in the header — a band can be empty.
    if (ref === undefined || !(ref > 0)) {
      here--;
      continue;
    }
    if (!shouldMoveDown(bankroll, ref, policy)) break;
    here--;
  }

  // The floor is still a real game it can enter, not merely one it has not
  // been thrown out of: entering takes `canSit`, which is the stricter bar.
  const floorRef = bandRef.get(BAND_ORDER[here]);
  const stranded = floorRef === undefined || !(floorRef > 0) || !canSit(bankroll, floorRef, policy);

  const band = BAND_ORDER[here];
  if (here === home) currentBand.delete(horseId);
  else currentBand.set(horseId, band);

  const movedDown = here < before;
  const movedUp = here > before;
  if (movedDown) bankrollEvent('moved_down_a_stake');
  if (movedUp) bankrollEvent('moved_up_a_stake');

  return { band, movedDown, movedUp, stranded };
}
