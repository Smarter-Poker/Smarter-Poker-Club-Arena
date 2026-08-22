/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE PREFLOP V7 — Position-Pair Preflop Mastery (2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The V7 replacement for the V2 preflop layer. Everything downstream (V3 range
 * reads, V4 street IQ, V5 hand reading) inherits its edge from preflop range
 * quality, so this is the highest-leverage layer in the engine.
 *
 * What V2 did not have, V7 does:
 *  - POSITION-PAIR 3-BETTING: a button open is 3-bet far wider than an
 *    under-the-gun open; the blinds re-steal against late position.
 *  - 3-BET BLUFFS from the blinds and in position with the right mid hands.
 *  - 4-BET BLUFFS: V2's 4-bets were pure value and therefore exploitable.
 *  - BLIND-VS-BLIND play: SB opens wide vs a lone BB; BB defends wide and
 *    re-raises both for value and as a bluff.
 *  - SQUEEZE logic: raiser + caller(s) get squeezed for value AND as a bluff,
 *    with proper multi-caller sizing.
 *  - STACK-DEPTH awareness: deep stacks widen speculative suited/connected
 *    opens and cold calls; shallow stacks tighten them and open-jam more.
 *  - RESHOVE STACKS: 13-20bb jam over late opens instead of flatting.
 *  - TOURNAMENT RISK PREMIUM (ICM-lite): survival pressure raises every
 *    calling threshold and trims bluffs when chips lost hurt more than chips
 *    won help.
 *
 * PURE decision logic: no imports from HorseLogic (the caller computes hand
 * strength, position, and context and passes them in), so there are no
 * circular module dependencies. Returns an INTENT that HorseLogic legalizes
 * against the engine's own validateAction rules.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

export type PreflopPosition = 'early' | 'middle' | 'late' | 'sb' | 'bb';

export interface PreflopIntent {
  a: 'fold' | 'check' | 'call' | 'jam' | 'raiseTo';
  /** raise-TO target for a === 'raiseTo' (pre-legalization) */
  to?: number;
}

export interface PreflopCtx {
  /** percentile hand strength 0..1 (variant-aware, jittered by caller) */
  strength: number;
  position: PreflopPosition;
  /** position of the LAST preflop raiser, if any */
  raiserPosition: PreflopPosition | null;
  /** number of raises so far this street */
  raises: number;
  /** callers before any raise */
  limpers: number;
  /** callers of the current raise */
  callers: number;
  /** live opponents not yet folded */
  oppsLeft: number;
  toCall: number;
  currentBet: number;
  pot: number;
  bigBlind: number;
  stack: number;
  stackBB: number;
  /** style parameters (already modifier-scaled by the caller) */
  tightness: number;
  bluffFreq: number;
  aggression: number;
  slowplayFreq: number;
  sizingMultiplier: number;
  isOmaha: boolean;
  isPotLimit: boolean;
  /** tournament survival premium, 0 for cash (see HorseLogic.icmRisk) */
  riskAdd: number;
  /** V10: widen the isolation-raise range vs limpers in position (percentile
   *  points to loosen the open floor). 0 = off / legacy behavior. */
  isoWiden?: number;
  /** V11 GAME MODE (Dan 2026-08-22): cash and tournaments are DIFFERENT games.
   *  Explicit mode from the table engine (tournament_id / game_type), never
   *  guessed from blind size. Absent = legacy behavior. */
  mode?: 'cash' | 'tournament';
  /** V11: an ante is in play — opens/steals widen (dead money in every pot). */
  anteInPlay?: boolean;
  /** V12: table format. Spins are 3-max winner-take-all hypers — every range
   *  widens hard (chip EV only, shallow, high blind pressure). */
  format?: 'cash' | 'mtt' | 'spin' | 'hu_sng';
  /** PRNG supplied by the caller (fast xorshift) */
  rand: () => number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Open-raise strength floors by position (percentile space). */
const OPEN_THRESH: Record<PreflopPosition, number> = {
  early: 0.62,
  middle: 0.54,
  late: 0.42,
  sb: 0.44, // V7: SB opens wider than V2's 0.50 — folds win the BB outright
  bb: 0.42,
};

/**
 * How wide the 3-bet gets against an open from each position. Late opens are
 * wide, so the re-raise gets wide; early opens are strong, so it stays tight.
 */
const THREEBET_VS: Record<PreflopPosition, number> = {
  early: 0.86,
  middle: 0.8,
  late: 0.74,
  sb: 0.72, // BB re-stealing vs a wide SB open
  bb: 0.8,
};

/** Cold-call floors vs an open from each position. */
const CALL_VS: Record<PreflopPosition, number> = {
  early: 0.58,
  middle: 0.54,
  late: 0.5,
  sb: 0.46,
  bb: 0.54,
};

export function decidePreflopV7(ctx: PreflopCtx): PreflopIntent {
  const {
    strength: raw,
    position,
    raiserPosition,
    raises,
    limpers,
    callers,
    toCall,
    currentBet,
    pot,
    bigBlind: bb,
    stack,
    stackBB,
    rand,
  } = ctx;

  // Tournament survival premium tightens everything a notch.
  const t = (x: number) => clamp01(x * ctx.tightness + ctx.riskAdd);
  const strength = raw;
  const bluffBudget = ctx.bluffFreq * ctx.aggression * Math.max(0.4, 1 - 4 * ctx.riskAdd);

  // ── V11 GAME MODE (Dan 2026-08-22) ──────────────────────────────────────
  const isTourney = ctx.mode === 'tournament';
  // Antes (tournaments, and any ante cash game) put dead money in every pot:
  // every open, steal, and jam range widens. Solver ante adjustments run
  // ~4-6 percentile points of extra width.
  // V12: spins stack a second widen on top — 3-max winner-take-all hypers
  // play far wider than full-ring MTT ranges at every stack depth.
  const anteWiden = (ctx.anteInPlay ? 0.05 : 0) + (ctx.format === 'spin' ? 0.05 : 0);
  // True heads-up: exactly one live opponent and hero is in a blind. HU is a
  // different game — the SB/BTN opens ~75-85% and the BB defends the wide
  // majority of hands against it.
  const headsUp =
    ctx.mode !== undefined && ctx.oppsLeft === 1 && (position === 'sb' || position === 'bb');

  // ── V11 PRICE-IN GUARD (Dan 2026-08-22, binding) ────────────────────────
  // "Folding in tournaments to less than 1 BB" — a horse must NEVER fold when
  // the pot is laying a price that any two cards beat. Any two live cards
  // clear ~25-30% equity, so when the pot odds require materially less than
  // that, folding burns chips no strategy can win back. Applies to every
  // branch below: checked FIRST, before any strength threshold can fold.
  const effCall = Math.min(toCall, stack);
  const guardOdds = effCall > 0 ? effCall / (pot + effCall) : 1;
  const pricedIn =
    ctx.mode !== undefined && // V11 on — ablation (mode absent) keeps legacy
    toCall > 0 &&
    (guardOdds <= 0.15 || // ~5.7:1 or better — never fold any two cards
      (effCall <= bb && guardOdds <= 0.22) || // under 1bb more at 3.5:1+
      // Tournament crumbs: with <=2bb behind, the blinds will eat the stack
      // anyway — take the flip instead of blinding out.
      (isTourney && stackBB <= 2 && guardOdds <= 0.34));
  if (pricedIn) return { a: 'call' };

  // Stack-depth texture: deep stacks reward speculative suited/connected
  // hands (implied odds); shallow stacks punish them.
  const depthLoosen = stackBB > 150 ? 0.02 : 0;
  const depthTighten = stackBB < 50 ? 0.03 : 0;

  const unopened = raises === 0 && currentBet <= bb * 1.05;

  // ── Short stacks: push/fold (<=12bb) and reshove stacks (13-20bb) ──
  if (stackBB <= 12 && !ctx.isOmaha) {
    if (unopened) {
      // V11: tournament jam ranges follow push/fold math — wider from late
      // seats, wider still with antes, and wider as the stack shrinks (a 5bb
      // stack jams far more than a 12bb stack).
      let jamThresh = position === 'late' || position === 'sb' ? 0.5 : 0.6;
      if (isTourney) {
        jamThresh -= anteWiden + (stackBB <= 7 ? 0.08 : 0.03);
      }
      if (strength >= t(jamThresh)) return { a: 'jam' };
      if (toCall === 0) return { a: 'check' };
      // V11: never open-limp/call off a push/fold stack — jam or fold. The
      // price-in guard above already caught every call that math forces.
      if (!isTourney && toCall <= bb && strength >= 0.3) return { a: 'call' };
      return { a: 'fold' };
    }
    // Facing action short-stacked: jam on real strength; the threshold eases
    // as the price improves (calling a shove getting 2:1 is not calling a
    // shove getting even money).
    let jamCallThresh = raises >= 2 ? 0.85 : 0.72;
    if (ctx.mode !== undefined && guardOdds <= 0.35) jamCallThresh -= 0.12;
    if (isTourney) jamCallThresh -= anteWiden * 0.5;
    if (strength >= t(jamCallThresh)) return { a: 'jam' };
    if (toCall === 0) return { a: 'check' };
    if (!isTourney && toCall <= bb && strength >= 0.3) return { a: 'call' };
    return { a: 'fold' };
  }
  if (
    stackBB <= 20 &&
    !ctx.isOmaha &&
    raises === 1 &&
    callers === 0 &&
    raiserPosition === 'late' &&
    strength >= t(0.62 - anteWiden)
  ) {
    // V7 RESHOVE: 13-20bb over a late-position open — jam, don't flat.
    // V11: antes widen the reshove (dead money + first-in fold equity).
    return { a: 'jam' };
  }

  // ── Unopened pot (or limpers only) ──
  if (unopened) {
    let openThresh = t(OPEN_THRESH[position]) + Math.min(limpers, 3) * 0.03;
    openThresh += depthTighten - depthLoosen - anteWiden;
    // V10 LIMP ISOLATION: weak limpers are the softest spot in cash poker.
    // Rather than only tightening (and sizing up) against them, ATTACK in
    // position — widen the raise floor so more hands isolate the limp(s). The
    // per-limper size bump below already punishes them. In position only, so
    // we are not bloating pots out of position.
    const isoW = ctx.isoWiden ?? 0;
    if (isoW > 0 && limpers >= 1 && (position === 'late' || position === 'middle')) {
      openThresh -= isoW + Math.min(limpers - 1, 2) * 0.01;
    }

    // Blind-vs-blind: heads-up SB vs BB plays much wider.
    // V11: TRUE heads-up (a 2-handed game, not just blinds left in a ring
    // hand) plays wider still — the SB/BTN opens the large majority of hands.
    const bvb = position === 'sb' && ctx.oppsLeft === 1;
    if (bvb) openThresh = t(headsUp ? 0.24 : 0.36) + depthTighten - anteWiden;

    if (strength >= openThresh) {
      // Trap mix with true premiums (cheap to see a flop disguised).
      if (strength > 0.93 && rand() < ctx.slowplayFreq * 0.4 && toCall <= bb) {
        if (toCall === 0) return { a: 'check' };
        return { a: 'call' };
      }
      const sizeBB = (2.2 + rand() * 0.8 + limpers * 1.0) * ctx.sizingMultiplier;
      return { a: 'raiseTo', to: sizeBB * bb };
    }
    // BvB limp mix from the SB with playable-but-not-open hands.
    if (bvb && toCall > 0 && toCall <= bb && strength >= 0.22 && rand() < 0.75) {
      return { a: 'call' };
    }
    if (toCall === 0) return { a: 'check' };
    const limpable = strength >= openThresh - 0.12;
    if (toCall <= bb && (limpable || position === 'sb') && rand() < 0.7) {
      return { a: 'call' };
    }
    if (toCall <= bb * 1.5 && strength >= 0.3) return { a: 'call' };
    return { a: 'fold' };
  }

  // ── Facing a single raise ──
  if (raises === 1) {
    const vs = raiserPosition ?? 'middle';
    let threeBetThresh = t(THREEBET_VS[vs] - (ctx.aggression - 1) * 0.08);
    let callThresh = t(CALL_VS[vs]) + callers * 0.025 + depthTighten - depthLoosen;

    // Blinds facing a LATE steal prefer 3-bet-or-fold over cold-calling
    // out of position: shift part of the call band into the 3-bet.
    const blindVsSteal = (position === 'sb' || position === 'bb') && vs === 'late';
    if (blindVsSteal) {
      threeBetThresh = t(0.7 - (ctx.aggression - 1) * 0.08);
      callThresh += position === 'sb' ? 0.05 : 0;
    }
    // V11 HEADS-UP DEFENSE: the SB/BTN opens most hands HU, so the BB defends
    // the wide majority — folding 50%+ of hands to a HU open is pure surrender.
    if (headsUp && position === 'bb') {
      threeBetThresh = t(0.64 - (ctx.aggression - 1) * 0.08);
      callThresh = t(0.3);
    }
    // V11 TOURNAMENT MID-STACK (16-25bb): flatting raises OOP torches stack
    // utility — shift the marginal-call band into 3-bet-or-fold.
    if (isTourney && stackBB > 12 && stackBB <= 25 && !ctx.isOmaha && !headsUp) {
      threeBetThresh = Math.min(threeBetThresh, t(0.72 - anteWiden));
      callThresh += 0.05;
    }
    const bbDiscount = position === 'bb' ? 0.06 : 0;
    const priceOK = toCall <= Math.max(bb * 12, stack * 0.12);

    if (strength >= threeBetThresh) {
      if (strength > 0.95 && rand() < ctx.slowplayFreq * 0.5 && callers === 0) {
        return { a: 'call' }; // trap
      }
      const ip = position === 'late' || (vs === 'sb' && position === 'bb');
      const mult = (ip ? 3.0 : 3.8) + callers * 1.0 + rand() * 0.4;
      return { a: 'raiseTo', to: currentBet * mult * ctx.sizingMultiplier };
    }

    // V7 SQUEEZE BLUFF: raiser + caller(s) — attack the capped caller range.
    if (
      callers >= 1 &&
      strength >= t(0.55) &&
      strength < threeBetThresh &&
      !ctx.isOmaha &&
      rand() < bluffBudget * 0.3
    ) {
      const mult = 4.0 + callers * 1.0 + rand() * 0.5;
      return { a: 'raiseTo', to: currentBet * mult * ctx.sizingMultiplier };
    }

    // V7 3-BET BLUFF: no callers, right position, mid-strength hands.
    // Wider vs late opens and from the blinds (re-steal).
    const bluffFloor = blindVsSteal ? 0.48 : 0.55;
    const bluffFreqHere = (blindVsSteal ? 0.5 : vs === 'late' ? 0.45 : 0.3) * bluffBudget;
    if (
      callers === 0 &&
      strength >= t(bluffFloor) &&
      strength < threeBetThresh &&
      rand() < bluffFreqHere
    ) {
      const ip = position === 'late';
      const mult = (ip ? 3.0 : 3.8) + rand() * 0.4;
      return { a: 'raiseTo', to: currentBet * mult * ctx.sizingMultiplier };
    }

    if (strength >= callThresh - bbDiscount && priceOK) return { a: 'call' };
    if (position === 'bb' && toCall <= bb * 2.5 && strength >= 0.3) return { a: 'call' };
    return { a: 'fold' };
  }

  // ── Facing a 3-bet or bigger ──
  {
    const ip = position === 'late';
    const fourBetThresh = t(0.93 - (ctx.aggression - 1) * 0.04);
    const callThresh = t(ip ? 0.74 : 0.78);

    if (strength >= fourBetThresh) {
      if (raises >= 3 || currentBet * 2.3 >= stack * 0.4) return { a: 'jam' };
      const mult = 2.2 + rand() * 0.4;
      return { a: 'raiseTo', to: currentBet * mult * ctx.sizingMultiplier };
    }

    // V7 4-BET BLUFF: NLHE only, facing exactly a 3-bet, no callers behind,
    // blocker-heavy band just below the value region. Small sizing, folds to
    // a 5-bet. Makes the value 4-bets unexploitable.
    if (
      !ctx.isOmaha &&
      raises === 2 &&
      callers === 0 &&
      strength >= t(0.72) &&
      strength < fourBetThresh &&
      currentBet * 2.3 < stack * 0.35 &&
      rand() < bluffBudget * 0.22
    ) {
      const mult = 2.2 + rand() * 0.2;
      return { a: 'raiseTo', to: currentBet * mult * ctx.sizingMultiplier };
    }

    // 5-bet pots: jam-or-fold on true premiums only.
    if (raises >= 3) {
      if (strength >= t(0.95)) return { a: 'jam' };
      if (strength >= t(0.88) && toCall <= stack * 0.3) return { a: 'call' };
      if (toCall === 0) return { a: 'check' };
      return { a: 'fold' };
    }

    if (strength >= callThresh && toCall <= stack * 0.35) return { a: 'call' };
    if (toCall > 0 && toCall <= pot * 0.15 && strength >= 0.45) return { a: 'call' };
    if (toCall === 0) return { a: 'check' };
    return { a: 'fold' };
  }
}
