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
  /** V13: when false, keep the V11 price-in guard's original early-return
   *  shape (ablation only — see decidePreflopV7). Default true. */
  v13?: boolean;
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
  /** V12 ANTI-EXPLOIT: 0..1 — how hard the current raiser is TARGETING this
   *  horse specifically (HorseMind.targetingOf). A hunter's raises get less
   *  credit: the horse defends wider and fights back with more re-raises,
   *  which is exactly what makes the hunt unprofitable. */
  targeted?: number;
  /** V16 DEEP READS: the current raiser's observed fold-to-3-bet frequency
   *  (0..1), or null/undefined without a qualifying sample. A raiser who
   *  folds 70% to 3-bets gets 3-bet-bluffed relentlessly; one who never
   *  folds gets bluffed at all only with real equity. */
  raiserFoldTo3Bet?: number | null;
  /** V20 M-ZONES (2026-08-27): per-player ante in BB units (0 = no ante).
   *  Undefined = layer off — every M computation degrades to legacy
   *  stackBB-only behavior. */
  anteBB?: number;
  /** V20 M-ZONES: players dealt in (for the orbit cost and Harrington's
   *  effective-M table-size scaling). Undefined = layer off. */
  tableSize?: number;
  /** V21 DEEP-STACK DISCIPLINE: scale cash 4-bet/5-bet stack-off thresholds
   *  with depth past 120bb. Undefined/false = legacy behavior. */
  deepDiscipline?: boolean;
  /** V23 BLIND CLOCK: minutes until the next blind level (undefined = unknown). */
  nextBlindInMin?: number;
  /** V23 BLIND CLOCK: next level's bb over the current bb (1/undefined = flat). */
  nextBlindMult?: number;
  /** V18 STRADDLE: the pot is straddled (2xBB posted blind, no
   *  ActionRecord). The unopened test and open sizing key off the straddle
   *  instead of the big blind. */
  straddled?: boolean;
  /** V18 SQUEEZE: hero opened, a caller came along, then the 3-bet - a
   *  squeeze. Squeeze ranges are polarized toward air, so the opener
   *  4-bets and calls wider. */
  squeezed?: boolean;
  /** V16 PLO POLARITY: hero holds a pair of aces (undefined = layer off).
   *  AAxx 3-bets below the generic percentile bar; a speculative rundown
   *  WITHOUT it flats at the margin instead of bloating the pot OOP. */
  omahaAA?: boolean;
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

/**
 * ── V13 (2026-08-23): THE PRICE-IN GUARD WAS EATING EVERY RAISE ────────────
 *
 * V11 added a guard so a horse can NEVER fold when the pot lays a price any
 * two cards beat. Its comment says exactly that — "before any strength
 * threshold can FOLD" — but it was written as `if (pricedIn) return call`,
 * placed above every branch in the function. A guard against folding became a
 * guard against acting.
 *
 * What that cost, at 1/2 with the pot including the live bet (it does):
 *   - BTN behind 3 limpers (pot 9, toCall 2, odds 0.182) -> forced CALL.
 *     The button limps behind with aces.
 *   - BB facing an open to 4 with three callers (pot 19, toCall 2, odds
 *     0.095) -> forced CALL. The single most profitable squeeze node in the
 *     game, hard-coded to a flat.
 *   - SB with one limper (odds 0.167) -> forced CALL.
 * It also pre-empted the push/fold block, so a <=12bb stack that should jam
 * called instead and surrendered all its fold equity, and it pre-empted the
 * whole unopened branch, which is where the V10 limp-isolation layer lives —
 * making that layer unreachable in exactly the multiway limped pots it was
 * built to attack.
 *
 * The fix restores the stated intent: compute the decision normally, then
 * substitute a call for a FOLD when the price forbids folding. Nothing else
 * about the guard changes.
 */
export function decidePreflopV7(ctx: PreflopCtx): PreflopIntent {
  const out = decidePreflopV7Core(ctx);
  if (ctx.v13 === false) return out;
  if (out.a !== 'fold') return out;
  const stack = ctx.stack;
  const bb = ctx.bigBlind > 0 ? ctx.bigBlind : 1;
  const toCall = ctx.toCall;
  const effCall = Math.min(toCall, stack);
  if (effCall <= 0) return out;
  const guardOdds = effCall / (ctx.pot + effCall);
  const isTourney = ctx.mode === 'tournament';
  const stackBB = stack / bb;
  const pricedIn =
    ctx.mode !== undefined &&
    (guardOdds <= 0.15 ||
      (effCall <= bb && guardOdds <= 0.22) ||
      (isTourney && stackBB <= 2 && guardOdds <= 0.34));
  return pricedIn ? { a: 'call' } : out;
}

function decidePreflopV7Core(ctx: PreflopCtx): PreflopIntent {
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
  // V13: the wrapper above applies this AFTER the decision, as a
  // fold-replacement. Keeping the old early return only for the ablation.
  if (pricedIn && ctx.v13 === false) return { a: 'call' };

  // Stack-depth texture: deep stacks reward speculative suited/connected
  // hands (implied odds); shallow stacks punish them.
  const depthLoosen = stackBB > 150 ? 0.02 : 0;
  const depthTighten = stackBB < 50 ? 0.03 : 0;

  // V18 STRADDLE: a straddled pot's current bet is the straddle (2xBB) with
  // zero raises - that is blind money, not an open. The whole unopened
  // branch (opens, limps, isolation) must own it, and open sizing keys off
  // the straddle so a raise "to 3x" means 3x the straddle.
  const straddled = ctx.straddled === true && raises === 0 && currentBet <= bb * 2.2;
  const openUnit = straddled ? Math.max(currentBet, bb) : bb;
  const unopened = (raises === 0 && currentBet <= bb * 1.05) || straddled;

  // ═══ V20 M-ZONES (2026-08-27) ═══
  // stackBB is blind-blind arithmetic; the number that decides tournament
  // life is M — orbits of survival left: stack / (blinds + antes per orbit).
  // With a full ante a "12bb" stack is an M of ~5, already deep in Harrington
  // orange, and the old stackBB-only gate treated it like a cash short stack.
  // Effective M scales by table size over 10 (short tables burn orbits
  // faster). Layer off (anteBB undefined) = legacy behavior everywhere.
  const players20 = ctx.tableSize ?? Math.max(2, ctx.oppsLeft + 1);
  const orbitBB20 = 1.5 + Math.max(0, ctx.anteBB ?? 0) * players20;
  const mzOn = isTourney && ctx.anteBB !== undefined;
  let effM = mzOn ? (stackBB / orbitBB20) * Math.min(1, players20 / 10) : Infinity;
  // ═══ V23 BLIND CLOCK (2026-08-28) ═══ the M that matters is the one the
  // NEXT level gives you. Within three minutes of a level that raises the
  // blinds, play the shrunken M now — the fold that "waits for a better
  // spot" is choosing to jam a 40% shorter stack two hands later.
  if (
    mzOn &&
    effM !== Infinity &&
    typeof ctx.nextBlindInMin === 'number' &&
    ctx.nextBlindInMin <= 3 &&
    (ctx.nextBlindMult ?? 1) > 1.15
  ) {
    effM = effM / (ctx.nextBlindMult ?? 1);
  }
  const v20Wired = ctx.anteBB !== undefined; // layer on (cash or tournament)

  // ── Short stacks: push/fold and reshove stacks ──
  // V20: the gate is M-based in tournaments (red zone M<5 and most of
  // orange enter jam-or-fold even when stackBB reads above 12), and Omaha
  // short stacks finally HAVE a jam-or-fold posture instead of falling
  // through to deep-stack pot-limit logic.
  const pushFoldNlh = !ctx.isOmaha && (stackBB <= 12 || (mzOn && effM < 6));
  const pushFoldOmaha = ctx.isOmaha && mzOn && (stackBB <= 8 || effM < 4);
  if (pushFoldNlh || pushFoldOmaha) {
    if (unopened) {
      // V11: tournament jam ranges follow push/fold math — wider from late
      // seats, wider still with antes, and wider as the stack shrinks (a 5bb
      // stack jams far more than a 12bb stack).
      // V20: Omaha jam-or-fold runs tighter (equities cluster, domination
      // decides) and the red zone widens NLH jams by how burnt the M is.
      let jamThresh = position === 'late' || position === 'sb' ? 0.5 : 0.6;
      if (ctx.isOmaha) jamThresh += 0.08;
      if (isTourney) {
        jamThresh -= anteWiden + (stackBB <= 7 ? 0.08 : 0.03);
        if (mzOn && effM < 5) jamThresh -= effM < 3 ? 0.1 : 0.05;
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
    // V20: every caller already in is another range hero must beat, and a
    // tournament life is worth more than the chip price — the flat t()
    // premium underprices a full call-off, so it is paid AGAIN here — but
    // only while there is a life left to protect: a red-zone stack (M<5) is
    // already dead money walking and takes its flips.
    if (v20Wired && callers >= 1) jamCallThresh += Math.min(0.1, callers * 0.05);
    if (mzOn && effM >= 5) jamCallThresh += ctx.riskAdd;
    if (ctx.isOmaha) jamCallThresh += 0.03;
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
  // V20 YELLOW ZONE RESHOVE: at M<12 the reshove is the whole playbook —
  // flatting an open leaves a stack that can only check-fold. Extend it to
  // middle-position opens on a stronger band (their range is tighter, so the
  // reshove needs more hand), capped at 22bb so a big-ante deep stack does
  // not jam 30 blinds.
  if (
    mzOn &&
    effM < 12 &&
    stackBB <= 22 &&
    !ctx.isOmaha &&
    raises === 1 &&
    callers === 0 &&
    raiserPosition === 'middle' &&
    strength >= t(0.7 - anteWiden)
  ) {
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
      // V20 ORANGE ZONE (M 6-10): there is no raise-fold — a standard open
      // is a third of the stack, and folding it to a reshove afterward is
      // the worst line short-stack poker offers. The opening range OPEN-JAMS
      // instead. NLH only, capped at 22bb so a big-ante 30bb stack does not
      // start jamming its whole opening range.
      if (mzOn && effM < 10 && stackBB <= 22 && !ctx.isOmaha) return { a: 'jam' };
      // Trap mix with true premiums (cheap to see a flop disguised).
      if (strength > 0.93 && rand() < ctx.slowplayFreq * 0.4 && toCall <= bb) {
        if (toCall === 0) return { a: 'check' };
        return { a: 'call' };
      }
      const sizeBB = (2.2 + rand() * 0.8 + limpers * 1.0) * ctx.sizingMultiplier;
      // V18: in a straddled pot the open is sized off the straddle.
      return { a: 'raiseTo', to: sizeBB * openUnit };
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
    // V12 ANTI-EXPLOIT: this raiser is hunting the horse — their opens carry
    // less real strength than the position suggests, so re-raise more and
    // defend wider until the hunt stops paying.
    const hunted = Math.max(0, Math.min(1, ctx.targeted ?? 0));
    if (hunted > 0) {
      threeBetThresh -= 0.05 * hunted;
      callThresh -= 0.04 * hunted;
    }
    const bbDiscount = position === 'bb' ? 0.06 : 0;
    const priceOK = toCall <= Math.max(bb * 12, stack * 0.12);

    // V16 PLO POLARITY: percentile strength double-counts pretty side cards;
    // real PLO 3-bet ranges are anchored on AAxx. With the layer on, AA
    // 3-bets from 0.04 under the generic bar, and a non-AA hand at the exact
    // margin (within 0.05 over the bar) FLATS instead — rundowns want
    // multiway flops in position, not bloated pots against the one range
    // that dominates them.
    let effThreeBetThresh = threeBetThresh;
    if (ctx.isOmaha && ctx.omahaAA === true) effThreeBetThresh = threeBetThresh - 0.04;
    if (strength >= effThreeBetThresh) {
      if (
        ctx.isOmaha &&
        ctx.omahaAA === false &&
        strength < threeBetThresh + 0.05 &&
        toCall <= ctx.stack * 0.08
      ) {
        return { a: 'call' }; // speculative rundown: take the flop instead
      }
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
    // V16: scale the bluff 3-bet by what THIS raiser actually does against
    // 3-bets. 0.6 + f3b maps a 70% folder to x1.3 and a 20% folder to x0.8,
    // clamped so a read can reshape but never zero out the mix.
    const f3bRead = ctx.raiserFoldTo3Bet;
    const f3bScale = typeof f3bRead === 'number' ? Math.max(0.7, Math.min(1.45, 0.6 + f3bRead)) : 1;
    const bluffFreqHere =
      (blindVsSteal ? 0.5 : vs === 'late' ? 0.45 : 0.3) * bluffBudget * f3bScale;
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
    // V12 ANTI-EXPLOIT: a hunter's 3-bets get 4-bet and called wider.
    const hunted3 = Math.max(0, Math.min(1, ctx.targeted ?? 0));
    // V18: a squeeze is bluff-heavier than a cold 3-bet - the squeezer is
    // attacking the CALLER'S capped range, not the opener's. The opener
    // defends wider on both branches.
    const sq = ctx.squeezed === true ? 1 : 0;
    // ═══ V21 DEEP-STACK DISCIPLINE (Dan 2026-08-27, Phase 2) ═══
    // The review table's preflop stack-offs average -82bb: 150bb+ cash pots
    // where 4-bet/5-bet thresholds tuned at 100bb put the whole stack in.
    // Depth scales the bar: at 250bb a 4-bet war demands closer to the top
    // of the deck, because the hand that stacks off is playing for 2.5x
    // more than the number the thresholds were calibrated against.
    // Tournaments are untouched (shallow, and the M-zones own short play).
    const deepT =
      ctx.deepDiscipline === true && ctx.mode === 'cash' && stackBB > 120
        ? Math.min(0.05, (stackBB - 120) / 2600)
        : 0;
    const fourBetThresh =
      t(0.93 - (ctx.aggression - 1) * 0.04) - 0.04 * hunted3 - 0.03 * sq + deepT;
    const callThresh = t(ip ? 0.74 : 0.78) - 0.03 * hunted3 - 0.02 * sq + deepT * 0.5;

    if (strength >= fourBetThresh) {
      // V21: deep, a 4-bet is no longer automatically a stack-off — jam only
      // when the money is already committed on normal sizing, and demand a
      // premium above the 4-bet floor before jamming 150bb+.
      if (raises >= 3 || currentBet * 2.3 >= stack * 0.4) {
        if (deepT > 0 && strength < fourBetThresh + deepT && toCall < stack * 0.5) {
          return { a: 'call' };
        }
        return { a: 'jam' };
      }
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
    // V21: deeper stacks push the premium bar higher still — a 5-bet pot at
    // 250bb is QQ+/AK at best, and QQ is already a coin flip against the
    // range that builds it.
    if (raises >= 3) {
      if (strength >= t(Math.min(0.98, 0.95 + deepT))) return { a: 'jam' };
      if (strength >= t(0.88 + deepT) && toCall <= stack * 0.3) return { a: 'call' };
      if (toCall === 0) return { a: 'check' };
      return { a: 'fold' };
    }

    if (strength >= callThresh && toCall <= stack * 0.35) return { a: 'call' };
    if (toCall > 0 && toCall <= pot * 0.15 && strength >= 0.45) return { a: 'call' };
    if (toCall === 0) return { a: 'check' };
    return { a: 'fold' };
  }
}
