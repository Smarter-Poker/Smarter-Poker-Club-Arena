/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE VARIANT PROFILE — the games are different games (V35, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "ALL THE LOGIC NEEDS TO BE DIFFERENT FOR EACH GAME, NLH, PLO, PLO4,
 * PLO5, PLO6, PLO8o, SHORT DECK, PINEAPPLE."
 *
 * WHAT WAS TRUE BEFORE THIS FILE. Every variant's preflop strength is mapped
 * onto the hold'em ladder by quantile (HorseEval), which is right — a bar
 * then selects the same QUALITY of hand in every game. But it also meant the
 * same FREQUENCY: measured with the strategy probe, PLO4, PLO6, PLO8, short
 * deck and pineapple all opened the button 41-43%, all folded the big blind
 * 46-49% to a button open, all 3-bet 7-9% — identical to hold'em to the
 * point. The V8 overlay even tightened Omaha by 3%. Those games do not play
 * hold'em frequencies:
 *
 *   PLO      Four cards make every hand playable-ish and equities run close
 *            (the worst four cards hold ~30% against the best, where the
 *            worst two hold ~12%). Opens are wider at every seat, cold calls
 *            in position wider still, and the blind defends far more — but
 *            3-bets are NARROWER, anchored on AAxx and premium double-suited
 *            hands, because a 3-bet gets called and then plays a pot-sized
 *            pot out of position with a hand that is a 55/45 at best.
 *   PLO5/6   More cards, closer equities, same direction only more so: open
 *            and defend wider again; 3-bet narrower again; and postflop the
 *            bluff volume drops with every extra card, because everyone
 *            connects with every board (PLO6 is nut-or-nothing).
 *   PLO8     Hi-lo is quality-gated — only two-way hands (A2xx, A3xx with
 *            high pairs, low rundowns with an ace) are worth a raise — so
 *            opens sit near hold'em width, but the blind sees flops cheaply
 *            (a split pot rewards the cheap look) and 3-bets are rare.
 *   6+       Short deck strips the low cards: straights and sets come far
 *            more often, a suited connector is a premium, pairs are weaker,
 *            equities cluster. Opens and blind defence widen a lot, 3-bets
 *            less (nobody is far ahead preflop).
 *   Pineapple Three cards, one thrown away: hands are better in absolute
 *            terms, but so is everyone's, and the quantile map already says
 *            so. A small widen for the extra playability.
 *   Fixed limit (FLH, FLO8) A raise is one bet. Flops are cheap, bluffs
 *            rarely work, value is bet thin and called down: open and defend
 *            much wider, raise for value more, bluff far less.
 *
 * The shifts are in BAR units on the hold'em ladder, so they read against the
 * frequency table in HorsePreflop: -0.04 on the button's 0.27 is ~50% (from
 * 42%); +0.04 on a 3-bet bar of 0.74 is ~5.5% (from 7%).
 *
 * NO SOLVER DATA EXISTS FOR ANY OF THESE GAMES. The warehouse is hold'em
 * only (spin / MTT / cash / HU — verified against solved_spots_gold's
 * game_type statistics on 2026-09-02). The numbers here are the published
 * frequencies for these games, chosen so the fleet plays each game like a
 * competent regular of THAT game rather than a hold'em player holding more
 * cards. When a PLO or 6+ solver export arrives, it belongs in a store like
 * GtoPostflop, not in this file.
 */

import { isFixedLimitVariant } from './BettingStructure.js';

export interface VariantPreflopShift {
  /** added to every open-raise bar (negative = wider) */
  open: number;
  /** added to the 3-bet bar (positive = narrower) */
  threeBet: number;
  /** added to the 4-bet bar */
  fourBet: number;
  /** added to the cold-call bar facing a single raise (negative = wider) */
  coldCall: number;
  /** added to the big blind's price-catch floor (negative = defends wider) */
  bbDefend: number;
}

export interface VariantPostflopProfile {
  /** multiplies bluff / semi-bluff frequency */
  bluffMul: number;
  /** multiplies slowplay frequency */
  slowplayMul: number;
  /** multiplies the check-raise frequency */
  checkRaiseMul: number;
  /** multiplies preflop tightness (1 = as tuned on hold'em) */
  tightnessMul: number;
  /** added to `respect` in the call-down (negative = calls lighter) */
  callRespect: number;
}

const NLH_PRE: VariantPreflopShift = { open: 0, threeBet: 0, fourBet: 0, coldCall: 0, bbDefend: 0 };
const NLH_POST: VariantPostflopProfile = {
  bluffMul: 1,
  slowplayMul: 1,
  checkRaiseMul: 1,
  tightnessMul: 1,
  callRespect: 0,
};

const PRE: Record<string, VariantPreflopShift> = {
  nlh: NLH_PRE,
  pineapple: { open: -0.02, threeBet: 0, fourBet: 0, coldCall: -0.01, bbDefend: -0.02 },
  short_deck: { open: -0.06, threeBet: 0.04, fourBet: 0.02, coldCall: -0.04, bbDefend: -0.06 },
  plo4: { open: -0.04, threeBet: 0.03, fourBet: 0.02, coldCall: -0.03, bbDefend: -0.03 },
  plo5: { open: -0.05, threeBet: 0.04, fourBet: 0.02, coldCall: -0.03, bbDefend: -0.04 },
  plo6: { open: -0.06, threeBet: 0.05, fourBet: 0.03, coldCall: -0.04, bbDefend: -0.05 },
  plo8: { open: -0.02, threeBet: 0.04, fourBet: 0.02, coldCall: -0.02, bbDefend: -0.03 },
  // fixed limit: cheap flops, value raises, wide defence
  flh: { open: -0.05, threeBet: -0.02, fourBet: 0, coldCall: -0.05, bbDefend: -0.08 },
  flo8: { open: -0.03, threeBet: 0.02, fourBet: 0.02, coldCall: -0.04, bbDefend: -0.08 },
};

const POST: Record<string, VariantPostflopProfile> = {
  nlh: NLH_POST,
  pineapple: { ...NLH_POST },
  // 36-card equities cluster; bluffs run into equity, value is thinner
  short_deck: { ...NLH_POST, bluffMul: 0.9 },
  // Omaha punishes slowplay (equities swing street to street); every extra
  // hole card means every opponent connects more, so bluffs shrink with it
  plo4: { ...NLH_POST, bluffMul: 0.8, slowplayMul: 0.8 },
  plo5: { ...NLH_POST, bluffMul: 0.7, slowplayMul: 0.75 },
  plo6: { ...NLH_POST, bluffMul: 0.6, slowplayMul: 0.7 },
  plo8: { ...NLH_POST, bluffMul: 0.75, slowplayMul: 0.8 },
  // fixed limit: a bluff is one bet into a pot laying 6:1 — it does not
  // work; the check-raise is the value play; calls are cheap and correct
  flh: { ...NLH_POST, bluffMul: 0.55, slowplayMul: 0.7, checkRaiseMul: 1.3, callRespect: -0.15 },
  flo8: { ...NLH_POST, bluffMul: 0.5, slowplayMul: 0.7, checkRaiseMul: 1.3, callRespect: -0.15 },
};

const norm = (v?: string | null): string => (v || 'nlh').toLowerCase();

export function variantPreflopShift(variant?: string | null): VariantPreflopShift {
  const v = norm(variant);
  if (PRE[v]) return PRE[v];
  if (isFixedLimitVariant(v)) return PRE.flh;
  return NLH_PRE;
}

export function variantPostflopProfile(variant?: string | null): VariantPostflopProfile {
  const v = norm(variant);
  if (POST[v]) return POST[v];
  if (isFixedLimitVariant(v)) return POST.flh;
  return NLH_POST;
}

/** Every variant this file knows, for the tests that pin them all. */
export const KNOWN_VARIANTS = Object.keys(PRE);
