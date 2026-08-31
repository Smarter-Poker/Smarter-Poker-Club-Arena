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
  /** V20 M-ZONES (2026-08-27): ante cost of ONE ORBIT in BB units, already
   *  resolved for the table's ante style by AnteMath.anteOrbitCostBB (0 = no
   *  ante). NOT per-player: multiplying this by the seat count is the bug of
   *  2026-08-30.
   *  Undefined = layer off — every M computation degrades to legacy
   *  stackBB-only behavior. */
  anteOrbitBB?: number;
  /** ALL-IN-OR-FOLD table: the preflop menu is fold or shove, nothing else.
   *  The brain must KNOW this — see the AoF block for why coercing its answer
   *  downstream is not the same thing. */
  allInOrFold?: boolean;
  /** V20 M-ZONES: players dealt in (for the orbit cost and Harrington's
   *  effective-M table-size scaling). Undefined = layer off. */
  tableSize?: number;
  /** V21 DEEP-STACK DISCIPLINE: scale cash 4-bet/5-bet stack-off thresholds
   *  with depth past 120bb. Undefined/false = legacy behavior. */
  deepDiscipline?: boolean;
  /** V24: enable the Omaha price defense + risk-scaled survival premium.
   *  Undefined/false keeps the exact pre-V24 arithmetic (ablation). */
  ploPriceDefense?: boolean;
  /** V25: enable PLO TOURNAMENT play — the pot-limit commitment zone, the
   *  Omaha reshove, price-driven all-in calls, and the no-raise-fold rule.
   *  Undefined/false keeps the pre-V25 arithmetic (ablation). */
  ploTourney?: boolean;
  /** V24 BOUNTY (PKO / mystery): share of the prize pool sitting in bounties
   *  (0 = not a bounty event). A bounty is equity you collect by ELIMINATING
   *  someone, so it pays to play pots against players you cover. */
  bountyFactor?: number;
  /** V24 BOUNTY: hero covers the current raiser, so busting them collects
   *  their bounty and risks none of hero's own. Undefined = unknown. */
  coversRaiser?: boolean;
  /** V24 BOUNTY: the raiser is short enough that this pot can eliminate them
   *  outright (their stack is inside what is already committed + hero's
   *  call). The bounty is not just possible, it is LIVE this hand. */
  raiserBustable?: boolean;
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
/** No stack deeper than this plays jam-or-fold, however burnt its M is.
 *  Matches the cap the V20 reshove branches already use. */
/** AoF shove bar tightens above the depth where push/fold is already tuned. */
const AOF_TIGHTEN_PER_BB = 0.006;
const AOF_MAX_TIGHTEN = 0.3;

const PUSH_FOLD_MAX_BB = 22;

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
 * The floor for limping BEHIND another limper, set at the single-raise
 * calling threshold on purpose: a hand that cannot call a raise has no
 * business putting a chip in, because the only thing it can do next is fold.
 * See the no-open-limp note in the unopened branch.
 */
const LIMP_BEHIND_MIN = 0.5;

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
  if (!pricedIn) return out;

  // ── THE PRICE IS ONLY REAL WHEN THE CALL CLOSES THE ACTION ──────────────
  //
  // (Dan 2026-08-30.) V13 stopped this guard from eating raises. It went on
  // eating FOLDS in unopened pots, and with a big blind ante that is every
  // fold, because the ante alone makes the price look irresistible:
  //
  //     hand #3761806, blinds 75/150, big blind ante 1,200
  //     pot before the action 1,425, toCall 150
  //     guardOdds = 150 / (1425 + 150) = 0.095  ->  <= 0.15, priced in
  //
  // So every hand the range wanted to fold called instead. Six seats limped,
  // the big blind raised to 1,125, and five of the six folded. Measured over
  // 596 tournament hands: 852 open-limps against 214 open-raises (35% of all
  // unraised first actions), and of the 458 limps that later faced a raise,
  // 419 FOLDED - 91.5%.
  //
  // The arithmetic is not wrong, the premise is. Pot odds justify a call
  // when calling CLOSES the action. In an unopened pot it never does: the
  // big blind still has the option and everyone behind can raise, so the
  // horse is not being laid 9.5% on a showdown, it is paying to enter a pot
  // it will be blown out of. That is why the same guard is harmless in cash
  // (no ante: pot 1.5bb, toCall 1bb, odds 0.4 - never triggers) and ruinous
  // in an ante tournament.
  //
  // The one survivor is the call that ends the decision anyway: if calling
  // puts the stack in, there is no later fold to regret and no limp to
  // punish. That keeps the desperate <=2bb case the guard was widened for.
  const unopenedForGuard = ctx.raises === 0 && ctx.currentBet <= bb * 1.05;
  const callIsAllIn = effCall >= stack * 0.99;
  if (unopenedForGuard && !callIsAllIn) return out;
  return { a: 'call' };
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

  // ═══ V24 ICM IS ABOUT RISKING A LIFE, NOT A BLIND (Dan 2026-08-28) ═══════
  // "I full potted 8 hands in a row and never got called once."
  //
  // riskAdd is the survival premium, and it was added to EVERY threshold at
  // full strength no matter how little the decision risked. Near the money it
  // reaches 0.12, which pushed the PLO call bar to t(0.54)+0.12 ~= 0.70: a
  // horse folded 70% of hands rather than call 3.5bb of a 100bb stack getting
  // better than 3:1. That is not ICM, it is a bug wearing ICM's name.
  //
  // ICM prices the chance of BUSTING. A call worth 3% of a stack cannot bust
  // anybody, so it earns almost none of the premium; a call that puts the
  // stack in earns all of it. Scaling by the fraction at risk is the whole
  // fix, and it leaves every jam/stack-off threshold exactly where it was
  // (those risk everything, so the multiplier is 1).
  const atRisk = stack > 0 ? Math.min(1, Math.max(0, toCall) / stack) : 1;
  // Square-root so meaningful-but-not-fatal prices still carry real weight:
  // 4% of stack -> 20% of the premium, 25% -> 50%, all-in -> 100%.
  // V28 AUDIT FIX: gate the sqrt price-scaling on the variant actually being
  // Omaha. The flag is named ploPriceDefense and was wired from v24PloDefense
  // with no isOmaha guard, so ablating "PLO price defense" silently moved
  // every NLH cold-call threshold too — no A/B of V24 measured what its name
  // says.
  const riskScaled =
    ctx.ploPriceDefense === true && ctx.isOmaha ? ctx.riskAdd * Math.sqrt(atRisk) : ctx.riskAdd;
  // Thresholds that decide whether to COMMIT keep the full premium; the
  // price-scaled one is for calls that merely continue.
  //
  // V28 AUDIT FIX: cap the bar at 0.965. clamp01 alone let a tight style push
  // a bar to exactly 1.0 — holdemPreflopScore tops out at 1.0 for AA, so a
  // grinder (tightness 1.12) could NEVER value-4-bet KK (0.98) or AKs (0.96),
  // and 4-bet AA only when the ±0.03 jitter landed high. A bar above the best
  // achievable hand is not "tight", it is a dead branch.
  const BAR_CAP = 0.965;
  const t = (x: number) => Math.min(BAR_CAP, clamp01(x * ctx.tightness + ctx.riskAdd));
  const tCall = (x: number) => Math.min(BAR_CAP, clamp01(x * ctx.tightness + riskScaled));
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
  // V28 AUDIT FIX (2026-08-29): `oppsLeft === 1` is NOT heads-up. In a full
  // ring where UTG opens and everyone folds to the BB, oppsLeft is 1 — and
  // this flag then defended the BB on a 70% range against an UNDER-THE-GUN
  // open, overriding CALL_VS.early (0.58) with t(0.30). True heads-up needs
  // the TABLE to be two-handed (tableSize carries dealt-in count when the
  // caller provides it), or the lone remaining opponent to be the SB — which
  // is genuine blind-vs-blind and deserves the wide defense.
  const headsUp =
    ctx.mode !== undefined &&
    ctx.oppsLeft === 1 &&
    (position === 'sb' || position === 'bb') &&
    ((ctx.tableSize ?? 2) <= 2 || raiserPosition === 'sb' || raiserPosition == null);

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
  // `anteOrbitBB` is the ante cost of a WHOLE ORBIT, already resolved by
  // AnteMath for the table's ante style. It used to be a per-player figure
  // multiplied by the seat count right here, which read a big-blind-ante
  // structure as seat-count times too expensive and made a 39bb stack look
  // like an M of 3 — every tournament became jam-or-fold.
  const orbitBB20 = 1.5 + Math.max(0, ctx.anteOrbitBB ?? 0);
  const mzOn = isTourney && ctx.anteOrbitBB !== undefined;
  let effM = mzOn ? (stackBB / orbitBB20) * Math.min(1, players20 / 10) : Infinity;
  /** stackBB as the NEXT level will see it — see the blind clock below. */
  let effStackBB = stackBB;
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
    // ...and the DEPTH moves with it. A 30bb stack two minutes from a level
    // that doubles the blinds is a 15bb stack, and the push/fold depth cap
    // has to be read in the same currency as the M it guards, or the cap
    // silently repeals the blind clock.
    effStackBB = stackBB / (ctx.nextBlindMult ?? 1);
  }
  const v20Wired = ctx.anteOrbitBB !== undefined; // layer on (cash or tournament)

  // ═══ V25 PLO TOURNAMENTS ARE NOT PUSH/FOLD (Dan 2026-08-28) ═════════════
  // THE STRUCTURAL FACT the brain did not model: POT LIMIT MEANS YOU CANNOT
  // SHOVE. A preflop pot-sized raise is ~3.5bb, so an "all-in" is legal only
  // at roughly 3.5bb or less. Every M-zone jam gate above is holdem thinking:
  // a 12bb PLO stack that "jams" actually raises 3.5bb and sits there with
  // 8.5bb behind, facing a 3-bet it never planned for. legalize() quietly
  // clamps the intent, so the horse acted on a plan the game does not allow.
  //
  // What short-stack PLO really is: a COMMITMENT decision. Raising pot with
  // a stack this shallow means the rest is going in, so the only question is
  // whether the hand is one you will stack off with - and having decided
  // that, you must never fold to the re-raise you invited. That is the
  // difference between a PLO tournament regular and a holdem player using
  // holdem rules in the wrong game.
  //
  // commitRatio = what one pot-sized raise costs as a share of the stack.
  // At >= 0.25 the raise IS the commitment, whatever the bb count says: a
  // 3.5bb pot raise is a quarter of a 14bb stack, and raising a quarter of
  // your tournament life and then folding is the worst line in poker. (The
  // first cut used 0.35, which put a 12bb stack OUTSIDE the zone - and the
  // test caught the 12bb stack limp-calling junk through the deep-stack
  // fallback instead, which is precisely the hole this layer exists to fill.)
  const ploT = ctx.isOmaha && isTourney && ctx.ploTourney === true;
  // A pot raise from an unopened pot is ~3.5bb; facing a raise it is
  // roughly 3*currentBet + pot (the pot-limit formula), which is what the
  // engine's own legalize() will clamp to.
  const potRaiseCost = unopened
    ? bb * 3.5
    : Math.min(stack, 3 * currentBet + Math.max(0, pot - currentBet));
  const commitRatio = stack > 0 ? potRaiseCost / stack : 1;
  const ploCommitZone = ploT && commitRatio >= 0.25;
  // Already-invested commitment: chips in the middle this hand as a share of
  // everything hero started with. Past ~30% a fold surrenders a stake big
  // enough that folding is worse than the worst call.
  const investedShare = stack + toCall > 0 ? (currentBet - toCall) / (stack + currentBet) : 0;

  // ═══ ALL-IN-OR-FOLD (2026-08-30) ══════════════════════════════════════
  // At an AoF table the preflop menu is fold or shove. The engine enforced
  // that by COERCING the horse's answer — "any non-fold intent becomes the
  // all-in" — while the brain went on choosing from a normal menu. So every
  // hand it would have opened for 2.5bb, and every hand it would have called
  // a raise with, was silently converted into a shove of the entire stack.
  // Its OPENING range became its SHOVING range.
  //
  // Same shape as the big blind ante bug fixed earlier today: the brain does
  // not know a rule, and a downstream layer rewrites its answer into
  // something strategically wrong. A coercion cannot fix a range.
  //
  // The thresholds are the push/fold block's own, deliberately, so AoF does
  // not invent a second set of numbers — plus one depth term, because a shove
  // risks the whole stack to win the blinds and that price rises with depth.
  // It is anchored at 12bb, where the push/fold numbers are already tuned, so
  // a short AoF table behaves exactly as push/fold does today.
  //
  // The downstream coercion stays as the legality guarantee. This makes it a
  // no-op instead of a strategy.
  if (ctx.allInOrFold === true) {
    const aofDepth = Math.min(AOF_MAX_TIGHTEN, Math.max(0, stackBB - 12) * AOF_TIGHTEN_PER_BB);
    if (unopened) {
      let bar = position === 'late' || position === 'sb' ? 0.5 : 0.6;
      if (ctx.isOmaha) bar += 0.08;
      if (isTourney) {
        bar -= anteWiden + (stackBB <= 7 ? 0.08 : 0.03);
        if (mzOn && effM < 5) bar -= effM < 3 ? 0.1 : 0.05;
      }
      bar += aofDepth;
      if (strength >= t(bar)) return { a: 'jam' };
      if (toCall === 0) return { a: 'check' };
      return { a: 'fold' };
    }
    // Calling a shove buys no fold equity, so it needs the hand outright.
    let callBar = raises >= 2 ? 0.85 : 0.72;
    if (ctx.mode !== undefined && guardOdds <= 0.35) callBar -= 0.12;
    if (isTourney) callBar -= anteWiden * 0.5;
    if (v20Wired && callers >= 1) callBar += Math.min(0.1, callers * 0.05);
    if (mzOn && effM >= 5) callBar += ctx.riskAdd;
    if (ctx.isOmaha) callBar += 0.03;
    callBar += aofDepth;
    if (strength >= t(callBar)) return { a: 'jam' };
    if (toCall === 0) return { a: 'check' };
    return { a: 'fold' };
  }

  // ── Short stacks: push/fold and reshove stacks ──
  // V20: the gate is M-based in tournaments (red zone M<5 and most of
  // orange enter jam-or-fold even when stackBB reads above 12), and Omaha
  // short stacks finally HAVE a jam-or-fold posture instead of falling
  // through to deep-stack pot-limit logic.
  // ═══ V25 PLO COMMITMENT ZONE ═══ raise-or-fold, and having raised, commit.
  if (ploCommitZone) {
    if (unopened) {
      // The raise IS the stack, so the bar is a STACK-OFF bar, not an open.
      // Late position and a burnt M widen it exactly as the NLH gate does;
      // Omaha starts tighter because four cards make everyone's range wide,
      // so the fold equity a holdem shove buys is simply not there.
      let commitBar = position === 'late' || position === 'sb' ? 0.56 : 0.64;
      commitBar -= anteWiden;
      if (mzOn && effM < 5) commitBar -= effM < 3 ? 0.1 : 0.05;
      // The shallower the stack relative to one pot raise, the closer this is
      // to a true shove and the wider it should be.
      if (commitRatio >= 0.75) commitBar -= 0.06;
      if (strength >= t(commitBar)) {
        // Sized as a pot raise; the engine clamps it, and at this depth that
        // clamp IS the all-in.
        return { a: 'raiseTo', to: unopened ? bb * 3.5 : potRaiseCost };
      }
      if (toCall === 0) return { a: 'check' };
      return { a: 'fold' };
    }
    // Facing action. In PLO the all-in call is far more price-driven than in
    // holdem: equities compress (the worst four cards still hold ~30% against
    // the best, where the worst two hold ~12%), so being "crushed" is rare
    // and the pot odds carry most of the decision.
    let callOff = raises >= 2 ? 0.8 : 0.66;
    if (guardOdds <= 0.4) callOff -= (0.4 - guardOdds) * 1.2; // 3:1 -> -0.18
    if (callers >= 1) callOff += Math.min(0.08, callers * 0.04);
    if (mzOn && effM >= 5) callOff += ctx.riskAdd * 0.5;
    // CHIPS ALREADY IN ARE NOT A FRESH DECISION. When hero raised and got
    // re-raised, this branch was pricing the call as if the money in the
    // middle belonged to somebody else - and folded a third of a stack it
    // had voluntarily committed a moment earlier. That is the raise-fold
    // this layer is named after, and it hid inside the layer itself until a
    // test drove the sequence end to end.
    if (investedShare >= 0.28) callOff -= 0.18;
    if (strength >= t(Math.max(0.34, callOff))) {
      return { a: 'raiseTo', to: potRaiseCost };
    }
    if (toCall === 0) return { a: 'check' };
    return { a: 'fold' };
  }

  // PUSH/FOLD IS A SHORT-STACK STRATEGY, AT ANY M (2026-08-30). The M-zone
  // disjunct below used to carry no depth cap at all, so a table with a large
  // ante could put a stack of ANY size into jam-or-fold. Both later jam
  // branches were written with `stackBB <= 22` and comments saying exactly
  // why ("so a big-ante deep stack does not jam 30 blinds") — this, the gate
  // that decides whether the WHOLE strategy is jam-or-fold, was the one
  // without it.
  //
  // Measured in production before the fix, over 40 minutes of tournaments:
  //     open jams              416,   182 of them deeper than 25bb (max 72bb)
  //     3-bets                 254,   85.4% of them all-in (max 184bb)
  // Cash, where the ante bug could not reach, ran 3.7% and 0.0%.
  //
  // 22bb is not a new number: it is the one the sibling branches already
  // chose for this exact failure, and inventing a second convention here
  // would be worse than reusing theirs.
  const pushFoldNlh =
    !ctx.isOmaha && (stackBB <= 12 || (mzOn && effM < 6 && effStackBB <= PUSH_FOLD_MAX_BB));
  // V25: the old Omaha gate (<=8bb / M<4) is superseded by the commitment
  // zone above, which triggers on the pot-limit arithmetic rather than a bb
  // count. It stays for the ablation path (ploTourney off).
  const pushFoldOmaha = ctx.isOmaha && !ploT && mzOn && (stackBB <= 8 || effM < 4);
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
      // V11: never open-limp/call off a push/fold stack — jam or fold.
      //
      // The line that used to sit here did the opposite of what that sentence
      // says: `!isTourney && toCall <= bb && strength >= 0.3` OPEN-LIMPED a
      // cash push/fold stack with any hand of strength 0.3. It is unreachable
      // in practice today - measured across 7 hands x 6 seats x 2 depths, a
      // <=12bb cash stack jams or folds every time, because the jam bar
      // catches everything at 0.3 or better first - but a rule that reads
      // "never" must not carry its own exception, and the surrounding
      // thresholds move.
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
  // ═══ V25 OMAHA RESHOVE ═══ what this actually adds, stated honestly after
  // a test proved the first claim wrong: the generic 3-bet below ALREADY
  // fires on a late open at 0.74, so this is not "a stack with no move".
  // Two real contributions:
  //   1. SIZING. The generic 3-bet multiplies currentBet by 2.2-2.6, which
  //      pot limit then clamps - so the horse asks for a number the game
  //      refuses and takes whatever it is given. A pot-sized re-raise is the
  //      largest legal raise, which at this depth is also the committing one.
  //   2. A slightly wider band, and a MIDDLE-position open included at 0.78
  //      where the generic bar is 0.80.
  // Deliberately tight either way: a PLO 3-bet gets called far more often
  // than a holdem one, so this needs real equity rather than fold equity.
  if (
    ploT &&
    stackBB <= 25 &&
    raises === 1 &&
    callers === 0 &&
    (raiserPosition === 'late' || raiserPosition === 'middle') &&
    strength >= t((raiserPosition === 'late' ? 0.72 : 0.78) - anteWiden)
  ) {
    return { a: 'raiseTo', to: potRaiseCost };
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
      //
      // `limpers >= 1` added 2026-08-30: an open-limp with aces is still an
      // open-limp. It surrenders the dead money the same way, and on screen
      // it teaches every watching player that limping is normal here. Over-
      // limping a monster BEHIND other limpers is a real trap and survives;
      // opening the pot by calling does not.
      if (limpers >= 1 && strength > 0.93 && rand() < ctx.slowplayFreq * 0.4 && toCall <= bb) {
        if (toCall === 0) return { a: 'check' };
        return { a: 'call' };
      }
      // V28 OPEN-SIZE LADDER: the open used to be a flat 2.2-3.0x at every
      // depth and ante state — a 200bb cash open and a 25bb ante open were
      // the same size, which no player pool does. Depth and antes now move
      // it: antes pull toward ~2.2x (the dead money already pays the raise),
      // short stacks open smaller (min-raise territory), deep cash opens a
      // shade bigger. Late position opens the smaller end of its band.
      let baseOpen = 2.2 + rand() * 0.8;
      if (ctx.anteInPlay) baseOpen = 2.05 + rand() * 0.35;
      else if (stackBB <= 25) baseOpen = 2.0 + rand() * 0.4;
      else if (ctx.mode === 'cash' && stackBB > 150) baseOpen = 2.5 + rand() * 0.8;
      if (position === 'late') baseOpen -= 0.15;
      const sizeBB = (baseOpen + limpers * 1.0) * ctx.sizingMultiplier;
      // V18: in a straddled pot the open is sized off the straddle.
      return { a: 'raiseTo', to: sizeBB * openUnit };
    }
    // BvB limp mix from the SB with playable-but-not-open hands.
    if (bvb && toCall > 0 && toCall <= bb && strength >= 0.22 && rand() < 0.75) {
      return { a: 'call' };
    }
    if (toCall === 0) return { a: 'check' };

    // ── NO OPEN-LIMP: first in, it is raise or fold (Dan 2026-08-30) ───────
    //
    // Two branches used to call here. One limped anything within 0.12 of the
    // opening bar 70% of the time; the other limped ANY hand of strength
    // >= 0.3 for up to 1.5bb, from any position, unconditionally. Neither
    // asked whether a single player had actually limped first, so both
    // OPENED pots by calling - the play that fed the 91.5% limp-fold rate
    // measured above the price-in guard.
    //
    // Limping BEHIND survives, because real players do it, under two rules
    // that make it honest:
    //   - somebody must have limped first, so this can never open a pot; and
    //   - the hand must be able to CONTINUE against a raise. Anything weaker
    //     is limping in order to fold, which is the whole disease.
    // Because a hand at or above the opening bar RAISES, the surviving band
    // is [LIMP_BEHIND_MIN, openThresh) - empty in late position until several
    // limpers widen it. Late position isolating limpers instead of joining
    // them is correct, and the V10 isolation layer above already does it.
    const canLimpBehind = limpers >= 1 && strength >= LIMP_BEHIND_MIN;
    const limpable = strength >= openThresh - 0.12;
    // V28 AUDIT FIX: `|| position === 'sb'` short-circuited the strength test
    // entirely — the SB completed with ANY two cards 70% of the time and was
    // play-visible as "the small blind never folds". The SB still completes
    // wider than other seats, but from a real range. It is now also subject
    // to the limpers-first rule: with the pot unopened, the small blind has
    // the big blind still to act behind it, so completing is an open-limp
    // like any other.
    const sbCompletable = position === 'sb' && strength >= openThresh - 0.22;
    if (canLimpBehind && toCall <= bb && (limpable || sbCompletable) && rand() < 0.7) {
      return { a: 'call' };
    }
    return { a: 'fold' };
  }

  // ── Facing a single raise ──
  if (raises === 1) {
    const vs = raiserPosition ?? 'middle';
    let threeBetThresh = t(THREEBET_VS[vs] - (ctx.aggression - 1) * 0.08);
    // V24: a CALL of a single raise continues the hand, it does not commit
    // the stack - so it carries the price-scaled survival premium (tCall),
    // not the full one. See the note on riskScaled above.
    let callThresh = tCall(CALL_VS[vs]) + callers * 0.025 + depthTighten - depthLoosen;

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
      // V28 AUDIT FIX: the bluff squeeze was sized 4.0-5.5x with no IP/OOP
      // split while the VALUE squeeze was 3.0-4.2x — the bluff was strictly
      // BIGGER than the value raise at every caller count, a directly
      // observable sizing tell (fold to the big one, call the small one).
      // Bluffs now mirror the value sizing shape, a shade under it.
      const ipSq = position === 'late';
      const mult = (ipSq ? 2.9 : 3.7) + callers * 1.0 + rand() * 0.4;
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

    // ═══ V24 OMAHA PRICE DEFENSE (Dan 2026-08-28) ═══════════════════════
    // PLO equities are COMPRESSED: the worst four cards hold roughly 30%
    // against the best, where the worst two hold about 12% in holdem. A bar
    // tuned in NLH percentile space therefore folds hands that are getting a
    // fine price.
    //
    // THE ARITHMETIC, STATED HONESTLY (the first cut of this comment got it
    // wrong and the test caught it). A pot-sized PLO open to 3.5bb builds a
    // 5bb pot, so:
    //   - a COLD CALLER puts in 3.5 to win 8.5  -> 0.41, needs 41% equity.
    //     Folding a lot there is CORRECT; pot-raise pots are not cheap.
    //   - the BIG BLIND already has 1bb in, so it puts in 2.5 to win 7.5
    //     -> 0.33, and folding 70% of hands to that price is a real leak.
    // The relief below therefore scales with how far the price sits below
    // even money: the blind gets a lot of it, a cold caller gets a little.
    // Nothing in NLH changes - there the equity spread is real, and a fixed
    // percentile means what it says.
    let callBar = callThresh - bbDiscount;
    if (ctx.isOmaha && ctx.ploPriceDefense === true) {
      const odds = toCall / Math.max(1e-9, pot + toCall);
      const priceRelief = Math.max(0, 0.5 - odds); // BB ~0.17, cold call ~0.09
      callBar -= priceRelief;
    }

    // ═══ V24 BOUNTY PULL (PKO / mystery) ════════════════════════════════
    // A bounty is prize money attached to a PLAYER, and it is collected by
    // busting them. That makes pots against a covered opponent worth more
    // than their chips - the exact reason PKO play is looser than a
    // freezeout - and the brain had NO preflop bounty adjustment at all.
    const bf = Math.max(0, Math.min(1, ctx.bountyFactor ?? 0));
    if (bf > 0 && ctx.coversRaiser === true) {
      // Covering means hero's own bounty is never at risk in this pot.
      callBar -= Math.min(0.06, bf * 0.14);
      // If the raiser can actually be eliminated here, the bounty is live
      // this hand rather than theoretical.
      if (ctx.raiserBustable === true) callBar -= Math.min(0.05, bf * 0.12);
    }

    // A floor, applied after every discount: hands that flop nothing are a
    // fold at any price, and a bounty is not a licence to play four napkins.
    if (ctx.isOmaha && ctx.ploPriceDefense === true) callBar = Math.max(0.28, callBar);

    if (strength >= callBar && priceOK) return { a: 'call' };
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

    // ═══ V25 NEVER RAISE-FOLD A COMMITTED PLO STACK ═══════════════════
    // Having raised a short PLO stack, the chips in the middle are already a
    // large share of it, and the pot is laying a price no reasonable hand
    // can refuse. Folding here is the worst of both worlds: it buys the
    // fold equity of a raise and then declines the equity it paid for. This
    // fires only when hero PUT the money in (raises >= 2 means hero's raise
    // got re-raised) and the price is genuinely committing.
    // 2026-08-31: the `ploT` gate is REMOVED. The argument this guard rests
    // on — PLO equities are compressed, so a committed stack facing a price
    // cannot fold — is about the VARIANT, not the format. Gating it on
    // tournaments left every PLO CASH table with no protection at all, which
    // is where Dan watched it happen.
    if (ctx.isOmaha && investedShare >= 0.28 && guardOdds <= 0.45 && strength >= t(0.42)) {
      return { a: 'call' };
    }

    if (strength >= fourBetThresh) {
      // V21: deep, a 4-bet is no longer automatically a stack-off — jam only
      // when the money is already committed on normal sizing, and demand a
      // premium above the 4-bet floor before jamming 150bb+.
      if (raises >= 3 || currentBet * 2.3 >= stack * 0.4) {
        // The call-instead-of-jam relief window is deepT wide, starting at
        // the (already deepT-raised) 4-bet bar. Reviewed in the V28 audit
        // and kept: the window position is intentional — the first deepT of
        // hands above the deep bar flat rather than jam.
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

    // ═══ THE PRICE IS PART OF THE DECISION (Dan 2026-08-31) ═══════════
    // This branch demanded a FIXED top-20% hand whatever the pot laid, and
    // capped the call at 35% of stack — a cap that bites hardest exactly
    // when hero is most committed and the odds are best. Three hands Dan
    // watched live, all folded 40/40 by the probe that reproduced them:
    //
    //   PLO6, raised to 12 with 35 behind, faced 48 -> all-in for 35 to win
    //     95 (1.7:1). Strength 0.753, a TOP-25% hand. The bar was 0.803, and
    //     the cap refused the call before strength was even consulted.
    //   Heads-up, raised to 6, faced a MIN-CLICK to 12 -> 6 to call into 18,
    //     THREE TO ONE, in position. Bar 0.803. Fold.
    //   Min-raised to 4, faced 16 -> 12 into 20. Bar 0.803. Fold.
    //
    // In PLO6 essentially any six cards hold more than 25% against a
    // 3-betting range, so a 3:1 price is a call with the whole range. The
    // single-raise branch already knows this (V24 price defense); the 3-bet
    // branch never learned it.
    //
    // TWO CORRECTIONS, both anchored on the price rather than invented:
    //  1. The bar drops as the price improves, more steeply in Omaha where
    //     the equities compress. Floors stop it becoming a calling station.
    //  2. The stack cap protects DEEP stacks from light stack-offs. It must
    //     not veto a committed short stack taking a price it already paid
    //     for — the chips hero raised are not somebody else's money.
    const relief3 = Math.max(0, 0.5 - guardOdds) * (ctx.isOmaha ? 1.6 : 0.9);
    const commit3 = investedShare >= 0.12 ? Math.min(0.1, investedShare * 0.5) : 0;
    const floor3 = ctx.isOmaha ? 0.3 : 0.42;
    const pricedCallThresh = Math.max(floor3, callThresh - relief3 - commit3);
    const capOK3 = toCall <= stack * 0.35 || (investedShare >= 0.1 && guardOdds <= 0.45);
    if (strength >= pricedCallThresh && capOK3) return { a: 'call' };
    if (toCall > 0 && toCall <= pot * 0.15 && strength >= 0.45) return { a: 'call' };
    if (toCall === 0) return { a: 'check' };
    return { a: 'fold' };
  }
}
