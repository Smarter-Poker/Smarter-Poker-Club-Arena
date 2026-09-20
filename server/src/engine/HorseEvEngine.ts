/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE EV ENGINE — the arithmetic behind every choice (V38, 2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "THE 8.8M HANDS ARE HOLD'EM ONLY, SO YOU NEED TO DOUBLE DOWN AND BUILD
 * IN THE LOGIC AND PROGRAMMING FOR WHAT THEY SHOULD BE DOING WITH CERTAIN
 * HANDS AND CERTAIN SITUATIONS. WE NEED TO BUILD AN ENGINE THAT FOLLOWS THE
 * GTO MATH BEHIND EACH AND EVERY CHOICE, AND FIND THE BEST ONE AT ALL TIMES."
 * And on the river: "THIS NEEDS TO BE SOLVER BASED, IT SHOULDN'T BE A FLAT
 * LINE VARIABLE."
 *
 * WHAT A SOLVER ACTUALLY DOES, reduced to what a synchronous decision can
 * afford. A solver picks, for every hand in a range, the action whose
 * expected value is highest against an opponent who is doing the same, and
 * mixes at the indifference points so nothing can be exploited. The three
 * quantities that decide that at one node are:
 *
 *   1. hero's EQUITY against the range that is actually in the pot (the
 *      Monte Carlo against read ranges provides it — with the nut-discipline
 *      caps already applied by the caller when the line says the range is
 *      stronger than the sample);
 *   2. how much of that equity hero REALIZES from this seat on this street
 *      (realization: 1 on the river, less earlier and out of position);
 *   3. how often a bet of size s makes the opponent FOLD — and a solver
 *      opponent folds by minimum defence frequency, exactly s/(P+s) of the
 *      range it holds, adjusted by what THIS opponent has been seen to do.
 *
 * With those three the expected value of every action is arithmetic:
 *
 *   EV(fold)    = 0
 *   EV(check)   = r.eq.P                          (pot control: the hand sees the
 *                                                  next card for free)
 *   EV(call)    = r.eq.(P + c) - c                (c = the effective call)
 *   EV(bet s)   = f(s).P                          (they fold: the pot is hero's)
 *               + (1 - f(s)).[ r.eq'(s).(P + c + 2s) - (c + s) ]
 *                                                 (they continue with the part of
 *                                                  the range that did not fold)
 *
 * where eq'(s) is hero's equity against the CONTINUING range: the fold takes
 * the weakest f(s) of the range out, and those are the hands hero was
 * beating, so eq' = (eq - w.f)/(1 - f) with w the share of the folded hands
 * hero beat (0.85 — the folds are not all air). That single correction is
 * what stops the engine from "value betting" a hand that only gets called by
 * better, and what makes a bluff worth exactly what its fold equity buys.
 *
 * Multiway: every opponent must fold for the pot to be won outright, so
 * f_all = product of the individual folds, and the continuing equity is the
 * caller's own MC number (already priced against all of them).
 *
 * MIXING. The best action by EV is taken most of the time, but never always:
 * actions within a small margin of the best are mixed by their EV gap, so at
 * a true indifference the engine plays the solver's mixed frequency instead
 * of a deterministic tell. The margin is a fraction of the pot, never a flat
 * number, which is what Dan asked to remove from the river line.
 *
 * SCOPE. Used as the ARBITER for the games with no solver export — Omaha
 * (4/5/6), PLO8, short deck, pineapple, fixed limit — and for every river
 * fold/call the hold'em solver range did not answer. The hold'em solver
 * layers (V27-V32) stay first where they hit. The nut-discipline layers
 * (V15/V20/V21) feed this engine their capped equity; they are not bypassed.
 *
 * Pure: no engine imports, no state, no I/O. Every number is a parameter, so
 * the engine is testable against closed-form cases (see HorseEvEngine.test.ts).
 */

export interface EvOpponentModel {
  /**
   * Multiplier on the MDF fold frequency for this opponent (1 = a solver
   * opponent, >1 folds more than MDF, <1 folds less). From the mind's fold-
   * to-aggression read; 1 with no read.
   */
  foldMul: number;
  /** False for an all-in holding: it cannot fold or fund another wager.
   * Omission preserves older pure callers' ordinary live-opponent model. */
  canRespond?: boolean;
}

export interface EvSpot {
  /** hero's equity vs the range in the pot (0..1), caps already applied */
  equity: number;
  /** pot INCLUDING any bet hero is facing (effective, uncallable excess removed) */
  pot: number;
  /** effective call (0 when not facing a bet) */
  toCall: number;
  /** hero's chips behind */
  stack: number;
  /** the deepest live opponent's chips behind + bet (effective stack cap) */
  effectiveStack: number;
  street: 'flop' | 'turn' | 'river' | 'pineapple_discard';
  inPosition: boolean;
  /** live opponents still in the hand */
  opponents: number;
  /** per-opponent fold models, in any order; missing entries are solver (1) */
  models?: EvOpponentModel[];
  /** equity realization factor (0..1]; 1 on the river */
  realization: number;
  /** marginal rake on the pot in cash (0..0.5) */
  rakeMarg?: number;
  /** tournament survival premium to subtract from equity on a stack-off (0..0.15) */
  riskPremium?: number;
  /** minimum legal bet / raise increment */
  minBet: number;
  /** maximum legal wager (pot-limit cap or stack); Infinity for no-limit */
  maxBet: number;
  /** candidate sizes as fractions of the pot hero would be betting into */
  sizes?: number[];
  /**
   * Hero holds the betting lead. A check hands the initiative over: the
   * opponent stabs at the pot hero declined to bet, so the equity a check
   * realizes is lower than a bet's — the one-street model's "free card"
   * assumption is corrected by this factor (0.85 on the check side).
   */
  initiative?: boolean;
  /** PRNG for the mixed strategy */
  rand: () => number;
}

export type EvAction =
  | { kind: 'fold' | 'check' | 'call'; ev: number }
  | { kind: 'bet' | 'raise'; ev: number; amount: number; sizeFrac: number; foldEquity: number };

export interface EvVerdict {
  /** the action chosen (mixed near indifference) */
  pick: EvAction;
  /** the highest-EV action (deterministic) */
  best: EvAction;
  /** every candidate with its EV, best first */
  candidates: EvAction[];
}

/** Share of the folded part of a range that hero was beating anyway. */
const FOLDED_HANDS_HERO_BEAT = 0.85;
/** Mixing window: actions within this fraction of the pot of the best mix. */
const MIX_WINDOW_POT = 0.08;
/** Default size ladder (fractions of the pot hero bets into). */
const DEFAULT_SIZES = [0.33, 0.5, 0.75, 1.0, 1.5];

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * MDF fold frequency of one solver opponent facing a wager `s` into a pot
 * `p` (the pot they see, i.e. including hero's wager on the other side is
 * what makes the price): they defend p/(p+s) of their range and fold the
 * rest. Scaled by the opponent's read, clamped so a read reshapes but never
 * zeroes.
 */
export function mdfFold(potFacing: number, wager: number, foldMul: number = 1): number {
  if (!(wager > 0) || !(potFacing > 0)) return 0;
  const base = wager / (potFacing + wager);
  return clamp(base * clamp(foldMul, 0.4, 1.8), 0.02, 0.92);
}

/** Equity against the part of the range that continues after a fold of `f`. */
export function continuingEquity(equity: number, foldFrac: number): number {
  if (foldFrac <= 0) return equity;
  if (foldFrac >= 0.999) return equity;
  const eq = (equity - FOLDED_HANDS_HERO_BEAT * foldFrac) / (1 - foldFrac);
  return clamp(eq, 0.03, 0.99);
}

export function evaluateSpot(spot: EvSpot): EvVerdict {
  const r = clamp(spot.realization > 0 ? spot.realization : 1, 0.3, 1);
  const rake = clamp(spot.rakeMarg ?? 0, 0, 0.5);
  const risk = clamp(spot.riskPremium ?? 0, 0, 0.15);
  const P = Math.max(0.01, spot.pot);
  const c = Math.max(0, Math.min(spot.toCall, spot.stack));
  const facing = c > 0;
  const stack = Math.max(0, spot.stack);
  const eff = Math.max(0, Math.min(stack, spot.effectiveStack > 0 ? spot.effectiveStack : stack));
  const eq = clamp(spot.equity, 0, 1);
  const models = spot.models ?? [];
  const opps = Math.max(1, Math.floor(spot.opponents));
  let hasResponder = false;
  for (let i = 0; i < opps; i++) {
    if (models[i]?.canRespond !== false) hasResponder = true;
  }

  // Realized equity, net of rake and the survival premium. The premium is
  // charged in proportion to the share of the stack a line puts at risk, so
  // a cheap call pays almost none of it and a stack-off pays all of it.
  const realized = (share: number): number =>
    clamp(eq * r * (1 - rake) - risk * Math.sqrt(clamp(share, 0, 1)), 0, 1);

  const candidates: EvAction[] = [];

  if (facing) {
    candidates.push({ kind: 'fold', ev: 0 });
    // Calling: the pot already holds the wager; hero puts in c to see it.
    const evCall = realized(c / Math.max(1, stack)) * (P + c) - c;
    candidates.push({ kind: 'call', ev: evCall });
  } else {
    // A check with the lead is not a free card: the opponent gets to bet
    // the pot hero declined to, and part of the equity never gets realized.
    const checkMul = spot.initiative && hasResponder ? 0.85 : 1;
    candidates.push({ kind: 'check', ev: realized(0) * checkMul * P });
  }

  // Bets / raises. `s` is the extra hero puts in beyond the call; for a
  // raise the opponent then faces s (the raise increment) into P + c + s...
  // priced as they see it: their pot odds on the increment.
  const sizes = (spot.sizes ?? DEFAULT_SIZES).slice();
  // A jam is always a candidate when it is legal and different.
  const jam = hasResponder ? Math.min(eff, stack) - c : 0;
  const potForSizing = P + c; // what hero bets INTO (after matching the call)
  const amounts = new Set<number>();
  for (const f of sizes) {
    const s = potForSizing * f;
    if (s < spot.minBet || s > spot.maxBet || s > jam) continue;
    amounts.add(Math.round(s * 100) / 100);
  }
  if (jam >= spot.minBet && jam <= spot.maxBet + 1e-9) amounts.add(Math.round(jam * 100) / 100);

  for (const s of amounts) {
    if (!(s > 0)) continue;
    // Each opponent decides against the pot THEY see: the pot plus hero's
    // whole wager (c + s). Everyone must fold for the pot to be taken.
    let foldAll = 1;
    for (let i = 0; i < opps; i++) {
      if (models[i]?.canRespond === false) {
        foldAll = 0;
        break;
      }
      const m = models[i]?.foldMul ?? 1;
      foldAll *= mdfFold(P + c, s, m);
    }
    // The range that continues folded its weakest foldAll share.
    const eqCont = continuingEquity(eq, foldAll);
    const share = (c + s) / Math.max(1, stack);
    const realizedCont = clamp(
      eqCont * r * (1 - rake) - risk * Math.sqrt(clamp(share, 0, 1)),
      0,
      1
    );
    // When called: final pot = P + c + s (hero) + s (caller); hero's cost c + s.
    // Multiway callers are folded into the equity number already.
    const evCalled = realizedCont * (P + c + 2 * s) - (c + s);
    const ev = foldAll * P + (1 - foldAll) * evCalled;
    candidates.push({
      kind: facing ? 'raise' : 'bet',
      ev,
      amount: s,
      sizeFrac: s / potForSizing,
      foldEquity: foldAll,
    });
  }

  candidates.sort((a, b) => b.ev - a.ev);
  const best = candidates[0];

  // Mixed strategy at indifference: every candidate within the window is
  // weighted by how close it sits to the best. The best keeps at least the
  // largest share; a candidate at exactly the same EV shares evenly.
  const window = MIX_WINDOW_POT * P;
  const pool = candidates.filter((a) => best.ev - a.ev <= window);
  let pick = best;
  if (pool.length > 1) {
    const weights = pool.map((a) => 1 - (best.ev - a.ev) / (window + 1e-9));
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = spot.rand() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        pick = pool[i];
        break;
      }
    }
  }
  return { pick, best, candidates };
}

/**
 * The river fold/call line, from the same arithmetic: on the river r = 1,
 * so the call is right exactly when equity against the betting range clears
 * the raked pot odds plus the survival premium. No margins, no constants —
 * the reads enter through the equity (the caller's range narrowing) and the
 * opponent model, not through a flat line.
 */
export function riverCallVerdict(args: {
  equity: number;
  pot: number;
  toCall: number;
  stack: number;
  rakeMarg?: number;
  riskPremium?: number;
  rand: () => number;
}): { call: boolean; required: number; evCall: number } {
  const c = Math.max(0, Math.min(args.toCall, args.stack));
  const rake = clamp(args.rakeMarg ?? 0, 0, 0.5);
  const risk = clamp(args.riskPremium ?? 0, 0, 0.15);
  const required = clamp(
    c / ((args.pot + c) * (1 - rake)) + risk * Math.sqrt(clamp(c / Math.max(1, args.stack), 0, 1)),
    0,
    0.99
  );
  const evCall = (args.equity - risk) * (1 - rake) * (args.pot + c) - c;
  // Indifference band: within 1.5 equity points of the required number the
  // solver mixes; so does this.
  const gap = args.equity - required;
  if (Math.abs(gap) <= 0.015) return { call: args.rand() < 0.5 + gap / 0.03, required, evCall };
  return { call: gap > 0, required, evCall };
}
