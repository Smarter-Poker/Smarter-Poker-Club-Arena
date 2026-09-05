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

import { accumulatePlayStats, freshPlay, type HandRow, type PlayStats } from './HorsePlayStats.js';

// Re-exported so existing readers (tests, the panel scripts) keep their import path.
export { accumulatePlayStats, type HandRow, type PlayStats } from './HorsePlayStats.js';
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

/**
 * THE REGRESSION RULE NEEDS TO KNOW WHAT THE RAKE IS (2026-09-05, measured).
 *
 * On 2026-09-04 the fleet's cash net was -32.0 bb/100 over 2.67M seat-hands.
 * hand_history rake for the day (198,206bb) plus BBJ drop (23,954bb) equalled
 * the horse loss (220,971bb) to within one percent, and 40 of the 263,033
 * hands had a human in them. The horses play each other; the fleet's loss IS
 * the rake. `realBB100 < -15` therefore fired on 221 of the 383 horses tuned
 * that night and halved every dial toward neutral - the +/-0.01 the leak tags
 * had nudged, erased by a rule reading the house edge as a personality defect.
 *
 * Two numbers fix it, and either one alone is enough to stop the bleeding:
 *
 *   rakeBB100   this horse's own weighted-contributed rake over the same hands
 *               (horse_daily_nets.rake_bb). The RAKE-ADJUSTED result
 *               (realBB100 + rakeBB100) is what a human means by "am I beating
 *               the game". A horse that is -32 raw and -3 adjusted is not
 *               broken; it is paying rake at a rake-heavy table.
 *   fleetP25    the same-window rake-adjusted bb/100 below which the worst
 *               quarter of the 1,500-hand fleet sits. A horse the rule touches
 *               must be losing AFTER rake AND be in that quarter. On a night
 *               when everyone loses the same rake, nobody regresses.
 *
 * Before rake_bb has accumulated (rakeBB100 absent) the fleet gate alone
 * carries the rule; before either exists (tests, first night) the old raw
 * threshold applies unchanged, so nothing that passed yesterday changes today.
 */
export interface RegressionContext {
  /** rake paid, bb/100, over the same hands as realBB100 (positive number) */
  rakeBB100?: number | null;
  /** fleet p25 of rake-adjusted bb/100 among 1,500-hand horses; null = unknown */
  fleetP25?: number | null;
  /** reviewed hands behind `leaks` (the V40 denominator); 0 = unknown */
  leaksHands?: number;
}

/** Rake-adjusted regression threshold, bb/100. */
export const REGRESS_BB100 = -15;
/** Minimum reviewed hands before a leak RATE means anything. */
export const MIN_LEAK_HANDS_FOR_RATE = 40;
/**
 * Leak gates as RATES per reviewed hand (2026-09-05). The counts they replace
 * (6 stackoffs, 10 big-bet folds, 8 preflop stackoffs) were set against a
 * ~200-reviewed-hand window; a horse that plays three times the hands got
 * three times the tags and three times the nudges for the same discipline.
 * Rates at the same window are 0.03 / 0.05 / 0.04.
 */
export const LEAK_RATE_GATES = {
  stackoff: 0.03,
  bigBetFold: 0.05,
  preflopStackoff: 0.04,
} as const;

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
  leaks: Record<string, number> | null = null,
  /** 2026-09-05: what the regression rule needs to tell a leak from the rake. */
  ctx: RegressionContext = {}
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
    // RATES, NOT COUNTS (2026-09-05). With a denominator the gate is a rate
    // per reviewed hand; without one (older callers) the count gates stand,
    // which at the ~200-hand window they were set against is the same bar.
    const lh = ctx.leaksHands ?? 0;
    const rated = lh >= MIN_LEAK_HANDS_FOR_RATE;
    const over = (count: number, countGate: number, rateGate: number): boolean =>
      rated ? count / lh >= rateGate : count >= countGate;
    const per100 = (count: number): string =>
      rated ? `${((count / lh) * 100).toFixed(1)}/100 reviewed` : `${count}`;
    if (over(stackoffs, 6, LEAK_RATE_GATES.stackoff)) {
      tightness += STEP / 2;
      aggression -= STEP / 2;
      reasons.push(
        `leak: ${per100(stackoffs)} dominated-hand stackoffs in 20bb pots - tighten and calm down`
      );
    }
    if (over(n('big_bet_fold'), 10, LEAK_RATE_GATES.bigBetFold)) {
      bluffFreq -= STEP / 2;
      reasons.push(
        `leak: ${per100(n('big_bet_fold'))} big bluffs surrendered - fewer, better-picked bluffs`
      );
    }
    if (over(n('preflop_stackoff'), 8, LEAK_RATE_GATES.preflopStackoff)) {
      tightness += STEP / 2;
      reasons.push(
        `leak: ${per100(n('preflop_stackoff'))} preflop stackoffs of 40bb+ - stop shipping marginal`
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
  // ── 2026-09-05: ...AND THE RULE NO LONGER FIGHTS THE RAKE (see
  // RegressionContext). Adjusted = after the rake this horse actually paid;
  // fleet gate = it must also sit in the fleet's worst quarter.
  if (realBB100 !== null && realHands >= MIN_REAL_HANDS_FOR_BB100) {
    const rake =
      typeof ctx.rakeBB100 === 'number' && isFinite(ctx.rakeBB100) ? ctx.rakeBB100 : null;
    const adjusted = rake !== null ? realBB100 + rake : realBB100;
    const p25 = typeof ctx.fleetP25 === 'number' && isFinite(ctx.fleetP25) ? ctx.fleetP25 : null;
    const losing = adjusted < REGRESS_BB100;
    const worstQuarter = p25 === null || adjusted < p25;
    if (losing && worstQuarter) {
      tightness = 1 + (tightness - 1) / 2;
      aggression = 1 + (aggression - 1) / 2;
      bluffFreq = 1 + (bluffFreq - 1) / 2;
      reasons.push(
        `real bb100 ${realBB100.toFixed(1)}` +
          (rake !== null ? ` (${adjusted.toFixed(1)} after ${rake.toFixed(1)} rake)` : '') +
          (p25 !== null ? ` under fleet p25 ${p25.toFixed(1)}` : '') +
          ` over ${realHands} exact-net hands - regress dials halfway to neutral`
      );
    } else if (realBB100 < REGRESS_BB100) {
      reasons.push(
        `real bb100 ${realBB100.toFixed(1)} is ` +
          (rake !== null && !losing
            ? `${adjusted.toFixed(1)} after ${rake.toFixed(1)} rake - the game's edge, not a leak`
            : `not under fleet p25 ${(p25 ?? 0).toFixed(1)} - the table's rake, not a leak`) +
          ' - dials left alone'
      );
    }
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

/**
 * First quartile of rake-adjusted bb/100 across horses with a qualifying real
 * sample. Null when fewer than 20 horses qualify - a quartile of a handful is
 * noise, and the rule then falls back to the absolute threshold. Exported for
 * tests. Pure.
 */
export function fleetQuartile(
  nets: Map<string, { hands: number; netBB: number; rakeBB: number }>,
  minHands: number = MIN_REAL_HANDS_FOR_BB100
): number | null {
  const xs: number[] = [];
  for (const rn of nets.values()) {
    if (rn.hands < minHands) continue;
    xs.push(((rn.netBB + rn.rakeBB) / rn.hands) * 100);
  }
  if (xs.length < 20) return null;
  xs.sort((a, b) => a - b);
  const pos = (xs.length - 1) * 0.25;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/**
 * Load the window's horse_daily_play rows into PlayStats (cash + hu_cash;
 * the tuner is cash-only by design). Returns the set of horses that had rows.
 * A read failure reports and returns an empty set: the hand_history stream
 * then carries the night exactly as it did before this table existed.
 */
async function loadPlayRows(
  into: Map<string, PlayStats>,
  tracked: Set<string>
): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const sinceDay = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000)
      .toISOString()
      .slice(0, 10);
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from('horse_daily_play')
        .select(
          'horse_user_id, format, hands, vpip, pfr, three_bets, three_bet_opps, open_raises, faced_3bets, fold_to_3bets, saw_flop, won_when_saw_flop, post_aggr, post_passive'
        )
        .gte('day', sinceDay)
        .in('format', ['cash', 'hu_cash'])
        // Full unique key: (horse_user_id, day, format). See the note on the
        // real-nets loop - an unstable page order drops rows.
        .order('horse_user_id', { ascending: true })
        .order('day', { ascending: true })
        .order('format', { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, number | string>>) {
        const id = String(r.horse_user_id);
        if (!tracked.has(id)) continue;
        const s = into.get(id) ?? freshPlay();
        s.hands += Number(r.hands) || 0;
        s.vpip += Number(r.vpip) || 0;
        s.pfr += Number(r.pfr) || 0;
        s.threeBets += Number(r.three_bets) || 0;
        s.threeBetOpps += Number(r.three_bet_opps) || 0;
        s.openRaises += Number(r.open_raises) || 0;
        s.faced3Bets += Number(r.faced_3bets) || 0;
        s.foldTo3Bets += Number(r.fold_to_3bets) || 0;
        s.sawFlop += Number(r.saw_flop) || 0;
        s.wonWhenSawFlop += Number(r.won_when_saw_flop) || 0;
        s.postAggr += Number(r.post_aggr) || 0;
        s.postPassive += Number(r.post_passive) || 0;
        into.set(id, s);
        seen.add(id);
      }
      if (data.length < 1000) break;
    }
  } catch (err) {
    reportError(err, 'HorseSelfTuner.playRows');
    for (const id of seen) into.delete(id);
    seen.clear();
  }
  return seen;
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
    const realNets = new Map<string, { hands: number; netBB: number; rakeBB: number }>();
    try {
      const sinceDay = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000)
        .toISOString()
        .slice(0, 10);
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .from('horse_daily_nets')
          .select('horse_user_id, hands, net_bb, rake_bb, format')
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
          rake_bb: number | null;
        }>) {
          const acc = realNets.get(row.horse_user_id) ?? { hands: 0, netBB: 0, rakeBB: 0 };
          acc.hands += row.hands ?? 0;
          acc.netBB += Number(row.net_bb ?? 0);
          acc.rakeBB += Number(row.rake_bb ?? 0);
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
    // 2026-09-05: the fleet's own distribution is the yardstick. Rake-adjusted
    // bb/100 across every horse with a qualifying sample; the regression rule
    // only touches a horse under the first quartile (see RegressionContext).
    const fleetP25 = fleetQuartile(realNets);

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

    // ── 2026-09-05: EVERY HORSE, FROM ITS OWN ROWS ───────────────────────
    // horse_daily_play holds the same counts this accumulator derives,
    // compiled at settlement by the same code (HorsePlayStats), for every
    // horse, for the whole window. The hand_history stream below is now the
    // fallback for a horse with no play rows (the table is young, or the
    // flush was off), so a night can never study fewer horses than before.
    const stats = new Map<string, PlayStats>();
    const fromPlayRows = await loadPlayRows(stats, tracked);

    // Stream the study window through the accumulator, newest first.
    const since = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000).toISOString();
    const streamed = new Map<string, PlayStats>();
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
      accumulatePlayStats(data as unknown as HandRow[], tracked, streamed);
      fetched += data.length;
      oldestSeen = (data[data.length - 1] as { created_at: string }).created_at;
      if (data.length < PAGE_SIZE) break;
    }
    // What the sample ACTUALLY covered, for the log line and the audit rows.
    const coveredHours = oldestSeen
      ? Math.round(((Date.now() - Date.parse(oldestSeen)) / 3600_000) * 10) / 10
      : 0;
    // A horse with play rows is studied from them; the stream fills the gaps.
    let fromStream = 0;
    for (const [id, st] of streamed) {
      if (stats.has(id)) continue;
      stats.set(id, st);
      fromStream++;
    }

    // Diagnose + write.
    let tuned = 0;
    for (const [horseId, s] of stats) {
      if (s.hands < MIN_HANDS_TO_TUNE) continue;
      const prevMods = horses.get(horseId) ?? {};
      const rn = realNets.get(horseId);
      const realBB100 =
        rn && rn.hands >= MIN_REAL_HANDS_FOR_BB100 ? (rn.netBB / rn.hands) * 100 : null;
      const rakeBB100 =
        rn && rn.hands >= MIN_REAL_HANDS_FOR_BB100 && rn.rakeBB > 0
          ? (rn.rakeBB / rn.hands) * 100
          : null;
      const { mods, reasons } = diagnoseAndNudge(
        s,
        prevMods,
        realBB100,
        rn?.hands ?? 0,
        leaksByHorse.get(horseId) ?? null,
        {
          rakeBB100,
          fleetP25,
          leaksHands: leakHandsByHorse.get(horseId) ?? 0,
        }
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
              // 2026-09-05: the rake this horse paid, and what it did after it.
              rake_bb100: rakeBB100 !== null ? round4(rakeBB100) : -9999,
              adjusted_bb100:
                realBB100 !== null && rakeBB100 !== null ? round4(realBB100 + rakeBB100) : -9999,
              fleet_p25_bb100: fleetP25 !== null ? round4(fleetP25) : -9999,
              // where this horse's frequencies came from: play rows or the stream
              study_source: fromPlayRows.has(horseId) ? 1 : 0,
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
      `[HorseSelfTuner] Studied ${fromPlayRows.size} horses from horse_daily_play (full ${STUDY_WINDOW_DAYS}d) ` +
        `and ${fromStream} from a ${fetched}-hand hand_history stream covering the newest ${coveredHours}h, ` +
        `${stats.size} horses with data, fleet p25 ${fleetP25 === null ? 'n/a' : fleetP25.toFixed(1)} bb/100, ` +
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
