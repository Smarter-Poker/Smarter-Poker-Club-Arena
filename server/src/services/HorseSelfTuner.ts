/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE SELF-TUNER — Per-Horse Self-Improvement Mapping (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Dan: "they should be watching and tracking ALL OF THEIR OWN PLAYS ... and
 * constantly improving and optimizing their play, the more they play."
 *
 * Every night this service makes each horse study its own game:
 *
 *  1. MEASURE — replay the last 7 days of real CASH hand_history and compute,
 *     per horse: VPIP, PFR, 3-bet rate, fold-to-3-bet, WWSF (won when saw
 *     flop), postflop aggression factor, and approximate net bb/100.
 *  2. DIAGNOSE — compare against winning-player benchmark bands. Too loose,
 *     too passive, folding to every 3-bet, never winning without showdown —
 *     each recognized leak maps to a small corrective nudge.
 *  3. ADJUST — merge bounded nudges (±0.02/night, hard caps 0.85–1.18) into
 *     profiles.horse_profile, the exact jsonb resolveHorseStyle already reads
 *     on every live decision. The horse plays differently TOMORROW because of
 *     what it did TODAY — individually, permanently, and auditable in
 *     horse_self_tune_log.
 *
 * The nudges deliberately move slowly: a leak must persist across nights to
 * move a dial far, and every dial is clamped so no horse can drift outside
 * the "winning player" envelope no matter how unlucky a week gets. When a
 * horse with a big sample is losing badly overall, its dials regress toward
 * neutral instead of chasing noise.
 *
 * Fail-safe: every DB touch is caught + reported; a failed run retries the
 * next scheduled check. Tournament hands are EXCLUDED from frequency
 * baselines (tournament strategy legitimately differs; see V11 game modes).
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { claimNightlyJob } from '../benchmark/HorseLeague.js';
import type { HorseProfileMods, LeakFamily } from '../engine/HorseLogic.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawAction {
  userId?: string;
  action?: string;
  amount?: number;
  stage?: string;
  seat?: number;
  /** V12.3: persisted as of this version; absent on older rows (see the
   *  fallback in playFromHand). A short all-in is NOT a raise. */
  isFullRaise?: boolean;
}

export interface HandRow {
  actions: RawAction[] | null;
  players: Array<{ userId?: string; seat?: number }> | null;
  winners: Array<{ userId?: string; amount?: number }> | null;
  big_blind: number | string | null;
  button_seat: number | null;
}

export interface PlayStats {
  hands: number;
  vpip: number;
  pfr: number;
  threeBets: number;
  threeBetOpps: number;
  openRaises: number;
  foldTo3Bets: number;
  faced3Bets: number;
  sawFlop: number;
  wonWhenSawFlop: number;
  postAggr: number;
  postPassive: number;
  netBB: number;
}

const freshPlay = (): PlayStats => ({
  hands: 0,
  vpip: 0,
  pfr: 0,
  threeBets: 0,
  threeBetOpps: 0,
  openRaises: 0,
  foldTo3Bets: 0,
  faced3Bets: 0,
  sawFlop: 0,
  wonWhenSawFlop: 0,
  postAggr: 0,
  postPassive: 0,
  netBB: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. MEASURE — pure, unit-tested
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate play statistics for the tracked ids across a batch of hands.
 * Mutates and returns `into` so pages can stream through without holding
 * every hand in memory.
 */
export function accumulatePlayStats(
  rows: HandRow[],
  tracked: Set<string>,
  into: Map<string, PlayStats>
): Map<string, PlayStats> {
  for (const row of rows) {
    try {
      accumulateOne(row, tracked, into);
    } catch {
      /* one malformed hand must never stop the study */
    }
  }
  return into;
}

function accumulateOne(row: HandRow, tracked: Set<string>, into: Map<string, PlayStats>): void {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  if (actions.length === 0) return;
  const bb = Number(row.big_blind) > 0 ? Number(row.big_blind) : 2;

  const get = (id: string): PlayStats => {
    let s = into.get(id);
    if (!s) {
      s = freshPlay();
      into.set(id, s);
    }
    return s;
  };

  const inHand = new Set<string>();
  for (const p of row.players ?? []) {
    if (p && typeof p.userId === 'string') inHand.add(p.userId);
  }
  for (const a of actions) if (typeof a.userId === 'string') inHand.add(a.userId);

  // Per-hand per-player flags
  const didVpip = new Set<string>();
  const didPfr = new Set<string>();
  const did3Bet = new Set<string>();
  const openedBy = { id: null as string | null };
  const foldedPreflop = new Set<string>();
  const sawPostflop = new Set<string>();
  const contributed = new Map<string, number>();
  /** V12.3: blinds are already counted in `contributed`, and bet/raise amounts
   *  are STREET TOTALS — so a blind that later raises must have its blind
   *  seeded as its opening street bet, or the increment (amount - 0) charges
   *  the blind a second time. BB posts 2 and 3-bets to 20 was billed 22. */
  const blindPosted = new Map<string, number>();

  // Blind posts are not ActionRecords — reconstruct from the button.
  if (typeof row.button_seat === 'number' && row.players && row.players.length >= 2) {
    const seats = row.players
      .filter((p) => p && typeof p.seat === 'number' && typeof p.userId === 'string')
      .sort((a, b) => (a.seat as number) - (b.seat as number));
    if (seats.length >= 2) {
      const after = (seat: number) => {
        const higher = seats.filter((s) => (s.seat as number) > seat);
        return (higher.length > 0 ? higher : seats)[0];
      };
      const sbP =
        seats.length === 2
          ? (seats.find((s) => s.seat === row.button_seat) ?? after(row.button_seat))
          : after(row.button_seat);
      const bbP = after(sbP.seat as number);
      if (sbP.userId) {
        contributed.set(sbP.userId, (contributed.get(sbP.userId) || 0) + bb / 2);
        blindPosted.set(sbP.userId, bb / 2);
      }
      if (bbP.userId && bbP.userId !== sbP.userId) {
        contributed.set(bbP.userId, (contributed.get(bbP.userId) || 0) + bb);
        blindPosted.set(bbP.userId, bb);
      }
    }
  }

  let preflopRaises = 0;
  let curStreet = 'preflop';
  let streetBets = new Map<string, number>(blindPosted);
  /** highest street total posted so far — the bar an all-in must clear */
  let streetLevel = bb;

  for (const a of actions) {
    const id = typeof a.userId === 'string' ? a.userId : null;
    if (!id) continue;
    const stage = a.stage || 'preflop';
    const preflop = stage === 'preflop';
    // V12.3: a SHORT all-in is not aggression — it is a call for less. Every
    // other consumer in this codebase requires isFullRaise === true, and
    // treating a forced shove as an open made the next real opener look like a
    // 3-bettor, corrupting PFR, 3-bet, fold-to-3-bet and the opener attribution
    // all at once. `isFullRaise` is persisted as of V12.3; when it is absent
    // (rows written before that), fall back to the street-total test rather
    // than assuming aggression.
    const isAggr =
      a.action === 'bet' ||
      a.action === 'raise' ||
      (a.action === 'all_in' &&
        (a.isFullRaise === true ||
          (a.isFullRaise === undefined &&
            typeof a.amount === 'number' &&
            a.amount > streetLevel + 1e-9)));
    const amount = typeof a.amount === 'number' && isFinite(a.amount) ? a.amount : 0;

    if (stage !== curStreet) {
      curStreet = stage;
      streetBets = new Map();
      streetLevel = 0;
    }
    // Contribution replay: calls are increments; bet/raise/all_in are street totals.
    if (isAggr || a.action === 'call') {
      const prev = streetBets.get(id) || 0;
      const inc = a.action === 'call' ? amount : Math.max(0, amount - prev);
      contributed.set(id, (contributed.get(id) || 0) + inc);
      streetBets.set(id, prev + inc);
      if (prev + inc > streetLevel) streetLevel = prev + inc;
    }

    if (preflop) {
      const voluntary = isAggr || a.action === 'call';
      if (voluntary) didVpip.add(id);
      if (isAggr) {
        if (preflopRaises === 0) {
          didPfr.add(id);
          openedBy.id = id;
        } else {
          didPfr.add(id);
          if (preflopRaises === 1) did3Bet.add(id);
        }
        preflopRaises++;
      }
      if (a.action === 'fold') foldedPreflop.add(id);
    } else {
      sawPostflop.add(id);
      if (tracked.has(id)) {
        if (isAggr) get(id).postAggr++;
        else if (a.action === 'call') get(id).postPassive++;
      }
    }
  }

  // Fold-to-3-bet: the opener faced a 3-bet; did their NEXT preflop action fold?
  let opener3BetFaced = false;
  let opener3BetFolded = false;
  if (openedBy.id) {
    let seen3Bet = false;
    for (const a of actions) {
      if ((a.stage || 'preflop') !== 'preflop') break;
      const isAggr = a.action === 'bet' || a.action === 'raise' || a.action === 'all_in';
      if (isAggr && a.userId !== openedBy.id && didPfr.has(openedBy.id) && !seen3Bet) {
        // first re-raise after the open
        if (did3Bet.has(a.userId as string)) seen3Bet = true;
        continue;
      }
      if (seen3Bet && a.userId === openedBy.id) {
        opener3BetFaced = true;
        opener3BetFolded = a.action === 'fold';
        break;
      }
    }
  }

  // ── V12.3: RETURN THE UNCALLED BET ───────────────────────────────────────
  // HandController.completeHandInner() calls returnUncalledBet() BEFORE pots
  // and rake, so `winners[].amount` is the post-refund award — but the actions
  // array still carries the full posted amount. Charging the full bet while
  // crediting the reduced award scored EVERY uncontested pot as a loss, which
  // is the most common way a hand is won. Left unfixed, essentially every
  // horse lands under the `bb100 < -15` regression trigger and has all three
  // of its dials halved toward neutral, every night, erasing the fleet's
  // per-horse differentiation while writing an audit trail claiming it fixed
  // leaks. The refund is the excess of the top street contribution over the
  // second-highest on the FINAL betting street.
  {
    const finalStreetBets = new Map<string, number>();
    let street = 'preflop';
    let levelSeed = new Map<string, number>(blindPosted);
    let cur = new Map<string, number>(levelSeed);
    for (const a of actions) {
      const id = typeof a.userId === 'string' ? a.userId : null;
      if (!id) continue;
      const stg = a.stage || 'preflop';
      if (stg !== street) {
        street = stg;
        levelSeed = new Map();
        cur = new Map();
      }
      const amt = typeof a.amount === 'number' && isFinite(a.amount) ? a.amount : 0;
      if (a.action === 'call') cur.set(id, (cur.get(id) || 0) + amt);
      else if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
        cur.set(id, Math.max(cur.get(id) || 0, amt));
      finalStreetBets.clear();
      for (const [k, v] of cur) finalStreetBets.set(k, v);
    }
    const sorted = [...finalStreetBets.entries()].sort((x, y) => y[1] - x[1]);
    if (sorted.length >= 2 && sorted[0][1] > sorted[1][1]) {
      const refund = sorted[0][1] - sorted[1][1];
      const id = sorted[0][0];
      contributed.set(id, Math.max(0, (contributed.get(id) || 0) - refund));
    } else if (sorted.length === 1 && sorted[0][1] > 0) {
      // Everyone else folded without matching a single chip of it.
      contributed.set(
        sorted[0][0],
        Math.max(0, (contributed.get(sorted[0][0]) || 0) - sorted[0][1])
      );
    }
  }

  const wonBy = new Map<string, number>();
  for (const w of row.winners ?? []) {
    if (w && typeof w.userId === 'string' && typeof w.amount === 'number') {
      wonBy.set(w.userId, (wonBy.get(w.userId) || 0) + w.amount);
    }
  }

  for (const id of inHand) {
    if (!tracked.has(id)) continue;
    const s = get(id);
    s.hands++;
    if (didVpip.has(id)) s.vpip++;
    if (didPfr.has(id)) s.pfr++;
    if (did3Bet.has(id)) s.threeBets++;
    // V12.3: the denominator used to exclude everyone in didPfr — which
    // includes the 3-bettor — so the numerator's own hands were never counted
    // and a horse that 3-bet every chance showed threeBetOpps = 0.
    if (preflopRaises >= 1 && (did3Bet.has(id) || !didPfr.has(id))) s.threeBetOpps++;
    if (openedBy.id === id) {
      s.openRaises++;
      if (opener3BetFaced) {
        s.faced3Bets++;
        if (opener3BetFolded) s.foldTo3Bets++;
      }
    }
    const saw = sawPostflop.has(id) || (!foldedPreflop.has(id) && sawPostflop.size > 0);
    if (saw) {
      s.sawFlop++;
      if (wonBy.has(id)) s.wonWhenSawFlop++;
    }
    s.netBB += ((wonBy.get(id) || 0) - (contributed.get(id) || 0)) / bb;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DIAGNOSE + 3. ADJUST — pure, unit-tested
// ─────────────────────────────────────────────────────────────────────────────

/** Winning-player benchmark bands (6-max cash). Outside the band = leak. */
const BENCH = {
  vpip: { lo: 0.19, hi: 0.32 },
  pfrOfVpip: { lo: 0.55, hi: 1.0 },
  foldTo3Bet: { lo: 0.35, hi: 0.62 },
  wwsf: { lo: 0.4, hi: 0.52 },
  af: { lo: 1.2, hi: 3.5 },
} as const;

const STEP = 0.02;
const MOD_MIN = 0.85;
const MOD_MAX = 1.18;
/** Minimum hands before a horse's stats are trusted enough to tune on. */
export const MIN_HANDS_TO_TUNE = 300;

export interface TuneResult {
  mods: Required<Pick<HorseProfileMods, 'tightness' | 'aggression' | 'bluffFreq'>> &
    HorseProfileMods;
  reasons: string[];
}

const clampMod = (n: number): number => Math.max(MOD_MIN, Math.min(MOD_MAX, n));

/**
 * Diagnose one horse's measured play and produce the next night's modifiers.
 * `current` are the mods already in horse_profile (missing = 1.0).
 */
/** Real-nets sample bar: below this, a bb100 figure is variance, not signal. */
export const MIN_REAL_HANDS_FOR_BB100 = 1500;

export function diagnoseAndNudge(
  s: PlayStats,
  current: HorseProfileMods,
  /** V16: EXACT bb100 from horse_daily_nets (null = no real sample). This is
   *  settlement truth, never the action-log reconstruction the 2026-08-23
   *  audit disqualified. */
  realBB100: number | null = null,
  realHands: number = 0,
  /** V18: this horse's leak-tag counts from horse_review_rollup over the
   *  window - the 20bb review system's verdicts, driving the dials. */
  leaks: Record<string, number> | null = null
): TuneResult {
  let tightness = current.tightness ?? 1;
  let aggression = current.aggression ?? 1;
  let bluffFreq = current.bluffFreq ?? 1;
  const reasons: string[] = [];

  if (s.hands < MIN_HANDS_TO_TUNE) {
    return {
      mods: { ...current, tightness, aggression, bluffFreq },
      reasons: ['sample too small - no change'],
    };
  }

  const vpip = s.vpip / s.hands;
  const pfrOfVpip = s.vpip > 0 ? s.pfr / s.vpip : 0;
  const ft3 = s.faced3Bets >= 12 ? s.foldTo3Bets / s.faced3Bets : null;
  const wwsf = s.sawFlop >= 80 ? s.wonWhenSawFlop / s.sawFlop : null;
  const postActs = s.postAggr + s.postPassive;
  // V12.3: Math.max(1, ...) kept the division safe but let AF equal postAggr
  // for a horse that never calls postflop — 59 aggressive actions and one call
  // scored AF 59, sailing past the 3.5 "spewy" band and pulling the aggression
  // dial down on a horse whose real leak may be the opposite. Require a real
  // passive sample before the ratio means anything.
  const af = postActs >= 60 && s.postPassive >= 15 ? s.postAggr / s.postPassive : null;
  const bb100 = (s.netBB / s.hands) * 100;

  if (vpip > BENCH.vpip.hi) {
    tightness += STEP;
    reasons.push(`vpip ${(vpip * 100).toFixed(1)} too loose - tighten`);
  } else if (vpip < BENCH.vpip.lo) {
    tightness -= STEP;
    reasons.push(`vpip ${(vpip * 100).toFixed(1)} too tight - loosen`);
  }

  if (pfrOfVpip < BENCH.pfrOfVpip.lo && s.vpip >= 40) {
    aggression += STEP;
    reasons.push(`pfr/vpip ${(pfrOfVpip * 100).toFixed(0)} too passive preflop - raise more`);
  }

  if (ft3 !== null && ft3 > BENCH.foldTo3Bet.hi) {
    aggression += STEP / 2;
    tightness -= STEP / 2;
    reasons.push(`fold-to-3bet ${(ft3 * 100).toFixed(0)} exploitable - defend and 4-bet more`);
  } else if (ft3 !== null && ft3 < BENCH.foldTo3Bet.lo) {
    tightness += STEP / 2;
    reasons.push(`fold-to-3bet ${(ft3 * 100).toFixed(0)} too sticky - fold more vs 3-bets`);
  }

  if (wwsf !== null && wwsf < BENCH.wwsf.lo) {
    bluffFreq += STEP;
    reasons.push(`wwsf ${(wwsf * 100).toFixed(0)} surrendering pots - fight for more flops`);
  } else if (wwsf !== null && wwsf > BENCH.wwsf.hi) {
    bluffFreq -= STEP;
    reasons.push(`wwsf ${(wwsf * 100).toFixed(0)} over-fighting - pick better spots`);
  }

  if (af !== null && af < BENCH.af.lo) {
    aggression += STEP;
    reasons.push(`postflop AF ${af.toFixed(2)} too passive - bet and raise more`);
  } else if (af !== null && af > BENCH.af.hi) {
    aggression -= STEP;
    reasons.push(`postflop AF ${af.toFixed(2)} spewy - dial the aggression back`);
  }

  // A big losing sample means the current dial settings are not working:
  // regress halfway to neutral rather than pile more adjustments on top.
  // ── V12.3: bb100 NO LONGER DRIVES A DIAL CHANGE ─────────────────────────
  // This branch used to halve all three dials toward neutral whenever the
  // measured net was below -15bb/100. Measured against 1000 real production
  // hands, that net cannot be trusted:
  //   - reconstructing contributions from `actions` reproduces the recorded
  //     pot_size in only 24% of hands;
  //   - chip conservation (sum of every player's net == -rake) fails in 38%,
  //     rising to 87% on hands containing an all-in, 75% on split/side pots
  //     and 100% on run-it-twice hands;
  //   - 23% of rows do not even balance internally (winners + rake != pot_size).
  // The uncalled-bet refund added above cut the failure rate from 86.6% to
  // 37.8% and removed a systematic -8.9bb/hand bias — which is exactly why
  // this branch was so dangerous: on the old numbers essentially EVERY horse
  // read as a big loser and had its personality halved toward neutral, every
  // night, while the audit log recorded a confident-sounding reason.
  // The remaining error is not fixable from this source: `ca_hand_facts` holds
  // the engine's exact per-player net (invested/returned/net_bb) but is
  // written for humans only, by design, because per-hand rows for 584 horses
  // would be millions of rows a day.
  // Every other signal here counts ACTIONS, not chips, so none of them depend
  // on this. bb100 is still recorded on the audit row as an estimate for a
  // human to read; it simply no longer moves a dial on its own.
  void bb100;

  // ── V18 (2026-08-26): LEAK TAGS DRIVE THE DIALS ─────────────────────────
  // The 20bb review system tags every big loss with WHAT went wrong. A horse
  // that keeps producing the same tag has a personality problem the
  // frequency benchmarks cannot see: the tags are hand-level verdicts on
  // exact settlement data. Small steps, same clamps, honest reasons.
  if (leaks) {
    const n = (k: string): number => leaks[k] ?? 0;
    const stackoffs =
      n('nonnut_flush_stackoff') +
      n('second_nut_flush_stackoff') +
      n('dominated_straight_stackoff');
    if (stackoffs >= 6) {
      tightness += STEP / 2;
      aggression -= STEP / 2;
      reasons.push(
        `leak: ${stackoffs} dominated-hand stackoffs in 20bb pots - tighten and calm down`
      );
    }
    if (n('big_bet_fold') >= 10) {
      bluffFreq -= STEP / 2;
      reasons.push(
        `leak: ${n('big_bet_fold')} big bluffs surrendered - fewer, better-picked bluffs`
      );
    }
    if (n('preflop_stackoff') >= 8) {
      tightness += STEP / 2;
      reasons.push(
        `leak: ${n('preflop_stackoff')} preflop stackoffs of 40bb+ - stop shipping marginal`
      );
    }
  }

  // ── V16 (2026-08-26): THE REGRESSION RULE IS BACK, ON REAL NUMBERS ──────
  // horse_daily_nets aggregates the engine's EXACT settlement nets (the same
  // inputs ca_hand_facts trusts), flushed every minute — chip conservation
  // holds by construction. A horse measurably losing 15bb/100 over a real
  // 1500-hand sample has dial settings that are not working: regress all
  // three halfway to neutral rather than pile more nudges on top. This is
  // the original V8 rule, disabled only because its input was garbage.
  if (realBB100 !== null && realHands >= MIN_REAL_HANDS_FOR_BB100 && realBB100 < -15) {
    tightness = 1 + (tightness - 1) / 2;
    aggression = 1 + (aggression - 1) / 2;
    bluffFreq = 1 + (bluffFreq - 1) / 2;
    reasons.push(
      `real bb100 ${realBB100.toFixed(1)} over ${realHands} exact-net hands - regress dials halfway to neutral`
    );
  }

  return {
    mods: {
      ...current,
      tightness: clampMod(tightness),
      aggression: clampMod(aggression),
      bluffFreq: clampMod(bluffFreq),
    },
    reasons: reasons.length > 0 ? reasons : ['within winning benchmarks - no change'],
  };
}

/** V41: which family a review-rollup variant belongs to. Exported for tests. */
export function leakFamilyOf(variant: string | null | undefined): LeakFamily {
  const v = (variant || 'nlh').toLowerCase();
  return v.startsWith('plo') || v === 'flo8' || v.includes('omaha') ? 'omaha' : 'holdem';
}

/** Public stat snapshot stored in the log (rates, not raw counters). */
export function statSnapshot(s: PlayStats): Record<string, number> {
  return {
    hands: s.hands,
    vpip: round4(s.vpip / Math.max(1, s.hands)),
    pfr: round4(s.pfr / Math.max(1, s.hands)),
    three_bet: round4(s.threeBets / Math.max(1, s.threeBetOpps || s.hands)),
    fold_to_3bet: round4(s.faced3Bets > 0 ? s.foldTo3Bets / s.faced3Bets : -1),
    wwsf: round4(s.sawFlop > 0 ? s.wonWhenSawFlop / s.sawFlop : -1),
    af: round4(s.postAggr / Math.max(1, s.postPassive)),
    bb100: round4((s.netBB / Math.max(1, s.hands)) * 100),
  };
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

// ─────────────────────────────────────────────────────────────────────────────
// Nightly runner
// ─────────────────────────────────────────────────────────────────────────────

const RUN_HOUR_UTC = 8;
// V12.3: was 30 minutes, which can put only ONE tick inside the one-hour run
// window depending on boot offset — and a throw inside that single tick lost
// the whole night with no retry. Ten minutes guarantees several attempts.
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Hours after RUN_HOUR_UTC during which a missed run is still picked up. */
const TUNER_CATCHUP_HOURS = 3;
/** Settle time before the boot check. */
const TUNER_BOOT_DELAY_MS = 120 * 1000;
// V12.3: the window is now HONEST. It was declared as 7 days while
// MAX_HANDS_TO_STUDY capped the read at 16000 rows — and production writes
// ~5000 hands an HOUR, so the "7-day study" was really the newest ~3 hours,
// taken at a fixed time of day. Every log line and audit row claimed
// otherwise. Reading 120k rows keeps the real coverage close to the declared
// window; the cap stays as a hard memory bound, and what was actually covered
// is now recorded on every audit row (see hands_window_hours).
const STUDY_WINDOW_DAYS = 7;
const MAX_HANDS_TO_STUDY = 120_000;
const PAGE_SIZE = 1000;

let checkTimer: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;
/*
 * ── 2026-09-02: why `lastRunDate = null` in the catch never bought a retry ──
 * runSelfTune's catch clears lastRunDate so the next tick can try again. The
 * next tick then reached the stand-down branch below, which set
 * `lastRunDate = today` - and the day was shut for good, 30 minutes before the
 * stale claim it was waiting on became takeable. Measured: self_tuner claimed
 * 2026-09-01 and 2026-09-02, hit `canceling statement due to statement
 * timeout` both times, and wrote zero rows on both days. The stand-down keeps
 * its own memo now and only suppresses the repeated log line.
 */
let lastStandDownDate: string | null = null;
let running = false;

/**
 * V13.1 — the same boot-check the league needed, for the same reason: an
 * interval is reset by every restart, so on a night of frequent deploys the
 * tick never arrives. The DB is the authority on whether tonight already ran,
 * because `lastRunDate` is empty again after every restart.
 */
async function alreadyTunedToday(date: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('horse_self_tune_log')
      .select('horse_id')
      .eq('run_date', date)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  } catch (err) {
    // A failed lookup must not silently skip the night. The audit rows upsert
    // on (horse_id, run_date), so a duplicate run is harmless.
    reportError(err, 'HorseSelfTuner.alreadyTunedToday');
    return false;
  }
}

async function maybeRunSelfTune(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const inWindow = hour >= RUN_HOUR_UTC && hour < RUN_HOUR_UTC + TUNER_CATCHUP_HOURS;
  if (!inWindow || running || lastRunDate === today) return;
  if (await alreadyTunedToday(today)) {
    lastRunDate = today;
    return;
  }
  // V13.1: one claim, one runner — otherwise both instances stream 120,000
  // hand_history rows at the same time.
  if (!(await claimNightlyJob('self_tuner', today))) {
    if (lastStandDownDate !== today) {
      lastStandDownDate = today;
      console.log(`[HorseSelfTuner] run ${today} claimed by another instance - standing down`);
    }
    return;
  }
  lastRunDate = today;
  await runSelfTune(today);
}

export function startHorseSelfTuner(): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => void maybeRunSelfTune(), CHECK_INTERVAL_MS);
  checkTimer.unref?.();
  const boot = setTimeout(() => void maybeRunSelfTune(), TUNER_BOOT_DELAY_MS);
  boot.unref?.();
}

export function stopHorseSelfTuner(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** One full nightly study. Exported for tests and for manual runs. */
export async function runSelfTune(runDate?: string): Promise<{ studied: number; tuned: number }> {
  if (running) return { studied: 0, tuned: 0 };
  running = true;
  const date = runDate ?? new Date().toISOString().slice(0, 10);
  try {
    const t0 = Date.now();

    // Horses + their current profiles.
    const horses = new Map<string, HorseProfileMods & { style?: unknown }>();
    {
      let cursor: string | null = null;
      for (;;) {
        let q = supabase
          .from('profiles')
          .select('id, horse_profile')
          .eq('is_horse', true)
          .order('id', { ascending: true })
          .limit(1000);
        if (cursor) q = q.gt('id', cursor);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data as Array<{ id: string; horse_profile: unknown }>) {
          // V12.3: horse_profile is jsonb holding EITHER an object OR a bare
          // style string ('fish' | 'reg' | 'nit' | 'lag' | 'maniac' — see the
          // seed scripts, and resolveHorseStyle which handles both). Collapsing
          // the string form to {} and writing back only the three dials would
          // drop the style, and resolveHorseStyle would then assign a style by
          // hashing the user id — silently erasing an authored personality,
          // permanently. No string rows exist in production today; this keeps
          // it that way if any are ever re-seeded.
          const raw = row.horse_profile;
          const p: Record<string, unknown> =
            typeof raw === 'string'
              ? { style: raw }
              : raw && typeof raw === 'object'
                ? (raw as Record<string, unknown>)
                : {};
          const num = (v: unknown): number | undefined =>
            typeof v === 'number' && isFinite(v) ? v : undefined;
          horses.set(row.id, {
            ...(p as object),
            tightness: num(p.tightness),
            aggression: num(p.aggression),
            bluffFreq: num(p.bluffFreq ?? p.bluff_freq),
          });
        }
        cursor = (data[data.length - 1] as { id: string }).id;
        if (data.length < 1000) break;
      }
    }
    if (horses.size === 0) {
      // V12.3: this used to return silently, with lastRunDate already consumed
      // and the return value discarded by the caller. If `is_horse` were ever
      // renamed the tuner would do nothing, forever, and say nothing.
      reportError(
        new Error('no horses found (is_horse=true returned 0 rows) - self-tune did nothing'),
        'HorseSelfTuner.noHorses'
      );
      return { studied: 0, tuned: 0 };
    }
    const tracked = new Set(horses.keys());

    // ── V16: real per-horse nets for the window (cash + hu_cash only — the
    // tuner is cash-only by design and tournament chips are not bb-comparable).
    const realNets = new Map<string, { hands: number; netBB: number }>();
    try {
      const sinceDay = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000)
        .toISOString()
        .slice(0, 10);
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .from('horse_daily_nets')
          .select('horse_user_id, hands, net_bb, format')
          .gte('day', sinceDay)
          .in('format', ['cash', 'hu_cash'])
          /*
           * ═══ THE SORT KEY MUST BE UNIQUE (2026-09-01, measured) ═══
           *
           * This paged 1,000 rows at a time ordered by (horse_user_id, day) -
           * which is NOT unique here. horse_daily_nets is keyed
           * (horse_user_id, day, game_variant, format), and in the seven-day
           * window there were 19,883 matching rows across 20 pages with 2,589
           * groups sharing a (horse_user_id, day) pair.
           *
           * Postgres does not promise a stable order within ties, and
           * LIMIT/OFFSET pagination over an unstable order silently DROPS
           * rows and repeats others. The horse whose rows are dropped simply
           * has a smaller sample than it really played.
           *
           * MEASURED consequence on 2026-08-31: two horses with 2,141 and
           * 2,332 cash hands in the window - both comfortably past the
           * 1,500-hand bar - came out under it and were logged with the
           * -9999 "no real sample" sentinel. Their dials were then tuned from
           * frequency estimates instead of settlement truth, which is the
           * exact substitution MIN_REAL_HANDS_FOR_BB100 exists to prevent.
           *
           * Ordering by the full unique key makes the page boundaries
           * deterministic. The same fix is applied to the leak-tag loop
           * below, which had 3,413 tied groups.
           */
          .order('horse_user_id', { ascending: true })
          .order('day', { ascending: true })
          .order('game_variant', { ascending: true })
          .order('format', { ascending: true })
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data as Array<{
          horse_user_id: string;
          hands: number;
          net_bb: number;
        }>) {
          const acc = realNets.get(row.horse_user_id) ?? { hands: 0, netBB: 0 };
          acc.hands += row.hands ?? 0;
          acc.netBB += Number(row.net_bb ?? 0);
          realNets.set(row.horse_user_id, acc);
        }
        if (data.length < 1000) break;
      }
    } catch (err) {
      // Real nets are an UPGRADE, not a dependency: a read failure reports
      // and the night tunes on frequencies exactly as before.
      reportError(err, 'HorseSelfTuner.realNets');
      realNets.clear();
    }

    // ── V18: leak-tag counts per horse over the window ──
    const leaksByHorse = new Map<string, Record<string, number>>();
    // V40: reviewed hands per horse over the same window (the denominator
    // the brain divides the counts by).
    const leakHandsByHorse = new Map<string, number>();
    // V41 (2026-09-05): the same, split by variant family. The pooled map
    // let an NLH non-nut-flush tag inflate a horse's OMAHA stack-off load
    // (PLO_STACKOFF_TAGS reads nonnut_flush_stackoff) and vice versa; the
    // brain reads its own family first (HorseLogic.leakLoad).
    const leaksByFamily = new Map<string, Record<LeakFamily, Record<string, number>>>();
    const leakHandsByFamily = new Map<string, Record<LeakFamily, number>>();
    try {
      const sinceDay = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000)
        .toISOString()
        .slice(0, 10);
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .from('horse_review_rollup')
          .select('horse_user_id, game_variant, leak_counts, big_wins, big_losses')
          .gte('day', sinceDay)
          // Same unstable-pagination bug as the real-nets loop above, same
          // fix: horse_review_rollup is keyed (horse_user_id, day,
          // game_variant) and 3,413 groups shared a (horse_user_id, day)
          // pair, so leak counts - which drive the tightness, aggression and
          // bluff dials directly - were being assembled from a sample with
          // rows silently missing.
          .order('horse_user_id', { ascending: true })
          .order('day', { ascending: true })
          .order('game_variant', { ascending: true })
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data as Array<{
          horse_user_id: string;
          game_variant: string | null;
          leak_counts: Record<string, number> | null;
          big_wins: number | null;
          big_losses: number | null;
        }>) {
          // The rollup counts REVIEWED hands (20bb+ pots), which is the
          // population the tags are drawn from.
          const reviewed = (Number(row.big_wins) || 0) + (Number(row.big_losses) || 0);
          leakHandsByHorse.set(
            row.horse_user_id,
            (leakHandsByHorse.get(row.horse_user_id) ?? 0) + reviewed
          );
          const fam = leakFamilyOf(row.game_variant);
          const fh = leakHandsByFamily.get(row.horse_user_id) ?? { omaha: 0, holdem: 0 };
          fh[fam] += reviewed;
          leakHandsByFamily.set(row.horse_user_id, fh);
          if (!row.leak_counts) continue;
          const acc = leaksByHorse.get(row.horse_user_id) ?? {};
          const fams = leaksByFamily.get(row.horse_user_id) ?? { omaha: {}, holdem: {} };
          for (const [k, v] of Object.entries(row.leak_counts)) {
            const n = Number(v) || 0;
            acc[k] = (acc[k] ?? 0) + n;
            fams[fam][k] = (fams[fam][k] ?? 0) + n;
          }
          leaksByHorse.set(row.horse_user_id, acc);
          leaksByFamily.set(row.horse_user_id, fams);
        }
        if (data.length < 1000) break;
      }
    } catch (err) {
      reportError(err, 'HorseSelfTuner.leakTags');
      leaksByHorse.clear();
      leaksByFamily.clear();
      leakHandsByFamily.clear();
    }

    // Stream the study window through the accumulator, newest first.
    const since = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000).toISOString();
    const stats = new Map<string, PlayStats>();
    let fetched = 0;
    let oldestSeen: string | null = null;
    // V12.3: this used to page with `.lt('created_at', before)`. created_at is
    // NOT unique — the fleet writes several hands per second and inserts are
    // batched — so every row sharing the page-boundary timestamp that did not
    // fit was skipped and never read. A stable secondary sort plus range()
    // paging cannot drop or repeat a row.
    for (let offset = 0; offset < MAX_HANDS_TO_STUDY; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('hand_history')
        .select('actions, players, winners, big_blind, button_seat, created_at')
        .is('tournament_id', null) // cash only: tournament strategy differs by design
        .gt('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      accumulatePlayStats(data as unknown as HandRow[], tracked, stats);
      fetched += data.length;
      oldestSeen = (data[data.length - 1] as { created_at: string }).created_at;
      if (data.length < PAGE_SIZE) break;
    }
    // What the sample ACTUALLY covered, for the log line and the audit rows.
    const coveredHours = oldestSeen
      ? Math.round(((Date.now() - Date.parse(oldestSeen)) / 3600_000) * 10) / 10
      : 0;

    // Diagnose + write.
    let tuned = 0;
    for (const [horseId, s] of stats) {
      if (s.hands < MIN_HANDS_TO_TUNE) continue;
      const prevMods = horses.get(horseId) ?? {};
      const rn = realNets.get(horseId);
      const realBB100 =
        rn && rn.hands >= MIN_REAL_HANDS_FOR_BB100 ? (rn.netBB / rn.hands) * 100 : null;
      const { mods, reasons } = diagnoseAndNudge(
        s,
        prevMods,
        realBB100,
        rn?.hands ?? 0,
        leaksByHorse.get(horseId) ?? null
      );
      // V40 (Dan 2026-09-04): the leak profile travels WITH the dials, so
      // the brain can read its own review verdicts at decision time
      // (HorseLogic ploStackoffLoad). Counts over the study window plus the
      // reviewed-hand denominator; rewritten whenever it moves.
      const leakCounts = leaksByHorse.get(horseId) ?? null;
      const leakProfile: Record<string, number> = {};
      if (leakCounts) {
        for (const [k, v] of Object.entries(leakCounts)) {
          const n = Number(v) || 0;
          if (n > 0) leakProfile[k] = n;
        }
      }
      const leaksHands = leakHandsByHorse.get(horseId) ?? 0;
      // V41: the family split travels with it.
      const fams = leaksByFamily.get(horseId) ?? { omaha: {}, holdem: {} };
      const famHands = leakHandsByFamily.get(horseId) ?? { omaha: 0, holdem: 0 };
      const positive = (m: Record<string, number>): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(m)) if ((Number(v) || 0) > 0) out[k] = Number(v);
        return out;
      };
      const familyProfile = {
        leaksOmaha: positive(fams.omaha),
        leaksHandsOmaha: famHands.omaha,
        leaksHoldem: positive(fams.holdem),
        leaksHandsHoldem: famHands.holdem,
      };
      const prev = prevMods as Record<string, unknown>;
      const prevLeaks = (prevMods as { leaks?: Record<string, number> }).leaks ?? {};
      const leaksChanged =
        JSON.stringify(prevLeaks) !== JSON.stringify(leakProfile) ||
        ((prevMods as { leaksHands?: number }).leaksHands ?? 0) !== leaksHands ||
        JSON.stringify(prev.leaksOmaha ?? {}) !== JSON.stringify(familyProfile.leaksOmaha) ||
        JSON.stringify(prev.leaksHoldem ?? {}) !== JSON.stringify(familyProfile.leaksHoldem) ||
        (prev.leaksHandsOmaha ?? 0) !== familyProfile.leaksHandsOmaha ||
        (prev.leaksHandsHoldem ?? 0) !== familyProfile.leaksHandsHoldem;
      const changed =
        mods.tightness !== (prevMods.tightness ?? 1) ||
        mods.aggression !== (prevMods.aggression ?? 1) ||
        mods.bluffFreq !== (prevMods.bluffFreq ?? 1) ||
        leaksChanged;

      try {
        if (changed) {
          const newProfile = {
            ...(prevMods as object),
            ...mods,
            leaks: leakProfile,
            leaksHands,
            leaksOmaha: familyProfile.leaksOmaha,
            leaksHandsOmaha: familyProfile.leaksHandsOmaha,
            leaksHoldem: familyProfile.leaksHoldem,
            leaksHandsHoldem: familyProfile.leaksHandsHoldem,
          };
          const { error: upErr } = await supabase
            .from('profiles')
            .update({ horse_profile: newProfile })
            .eq('id', horseId)
            .eq('is_horse', true);
          if (upErr) throw new Error(upErr.message);
          tuned++;
        }
        const { error: logErr } = await supabase.from('horse_self_tune_log').upsert(
          {
            horse_id: horseId,
            run_date: date,
            hands: s.hands,
            stats: {
              ...statSnapshot(s),
              // V16: the EXACT figure alongside the legacy estimate; -9999
              // = no qualifying real sample this window.
              real_bb100: realBB100 !== null ? round4(realBB100) : -9999,
              real_hands: rn?.hands ?? 0,
            },
            mods_before: {
              tightness: prevMods.tightness ?? 1,
              aggression: prevMods.aggression ?? 1,
              bluffFreq: prevMods.bluffFreq ?? 1,
            },
            mods_after: {
              tightness: mods.tightness,
              aggression: mods.aggression,
              bluffFreq: mods.bluffFreq,
            },
            reasons,
          },
          { onConflict: 'horse_id,run_date' }
        );
        if (logErr) throw new Error(logErr.message);
      } catch (err) {
        reportError(err, 'HorseSelfTuner.write');
      }
    }

    const eligible = [...stats.values()].filter((s) => s.hands >= MIN_HANDS_TO_TUNE).length;
    console.log(
      `[HorseSelfTuner] Studied ${fetched} hands covering the newest ${coveredHours}h ` +
        `(declared window ${STUDY_WINDOW_DAYS}d), ${stats.size} horses with data, ` +
        `${eligible} over the ${MIN_HANDS_TO_TUNE}-hand bar, ${tuned} tuned, ` +
        `in ${Date.now() - t0}ms`
    );
    if (eligible === 0 && stats.size > 0) {
      // Not an error, but the single most likely reason a night produces no
      // audit rows at all — say it out loud rather than leaving an empty table.
      console.warn(
        `[HorseSelfTuner] No horse reached ${MIN_HANDS_TO_TUNE} hands in this sample; ` +
          `nothing was tuned. Widen MAX_HANDS_TO_STUDY or lower the bar.`
      );
    }
    return { studied: stats.size, tuned };
  } catch (err) {
    reportError(err, 'HorseSelfTuner.run');
    lastRunDate = null; // allow a retry on the next check
    return { studied: 0, tuned: 0 };
  } finally {
    running = false;
  }
}
