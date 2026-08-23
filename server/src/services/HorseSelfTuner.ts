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
import type { HorseProfileMods } from '../engine/HorseLogic.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawAction {
  userId?: string;
  action?: string;
  amount?: number;
  stage?: string;
  seat?: number;
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
      const sbP = seats.length === 2 ? seats.find((s) => s.seat === row.button_seat) ?? after(row.button_seat) : after(row.button_seat);
      const bbP = after(sbP.seat as number);
      if (sbP.userId) contributed.set(sbP.userId, (contributed.get(sbP.userId) || 0) + bb / 2);
      if (bbP.userId && bbP.userId !== sbP.userId)
        contributed.set(bbP.userId, (contributed.get(bbP.userId) || 0) + bb);
    }
  }

  let preflopRaises = 0;
  let curStreet = 'preflop';
  let streetBets = new Map<string, number>();

  for (const a of actions) {
    const id = typeof a.userId === 'string' ? a.userId : null;
    if (!id) continue;
    const stage = a.stage || 'preflop';
    const preflop = stage === 'preflop';
    const isAggr = a.action === 'bet' || a.action === 'raise' || a.action === 'all_in';
    const amount = typeof a.amount === 'number' && isFinite(a.amount) ? a.amount : 0;

    if (stage !== curStreet) {
      curStreet = stage;
      streetBets = new Map();
    }
    // Contribution replay: calls are increments; bet/raise/all_in are street totals.
    if (isAggr || a.action === 'call') {
      const prev = streetBets.get(id) || 0;
      const inc = a.action === 'call' ? amount : Math.max(0, amount - prev);
      contributed.set(id, (contributed.get(id) || 0) + inc);
      streetBets.set(id, prev + inc);
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
    if (preflopRaises >= 1 && !didPfr.has(id)) s.threeBetOpps++; // could have 3-bet
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
export function diagnoseAndNudge(s: PlayStats, current: HorseProfileMods): TuneResult {
  let tightness = current.tightness ?? 1;
  let aggression = current.aggression ?? 1;
  let bluffFreq = current.bluffFreq ?? 1;
  const reasons: string[] = [];

  if (s.hands < MIN_HANDS_TO_TUNE) {
    return { mods: { ...current, tightness, aggression, bluffFreq }, reasons: ['sample too small - no change'] };
  }

  const vpip = s.vpip / s.hands;
  const pfrOfVpip = s.vpip > 0 ? s.pfr / s.vpip : 0;
  const ft3 = s.faced3Bets >= 12 ? s.foldTo3Bets / s.faced3Bets : null;
  const wwsf = s.sawFlop >= 80 ? s.wonWhenSawFlop / s.sawFlop : null;
  const postActs = s.postAggr + s.postPassive;
  const af = postActs >= 60 ? s.postAggr / Math.max(1, s.postPassive) : null;
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
  if (s.hands >= 1000 && bb100 < -15) {
    tightness = 1 + (tightness - 1) * 0.5;
    aggression = 1 + (aggression - 1) * 0.5;
    bluffFreq = 1 + (bluffFreq - 1) * 0.5;
    reasons.push(`net ${bb100.toFixed(1)}bb/100 over ${s.hands} hands - regress dials toward neutral`);
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

const RUN_HOUR_UTC = 8; // fleet's quietest hour
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const STUDY_WINDOW_DAYS = 7;
const MAX_HANDS_TO_STUDY = 16000;
const PAGE_SIZE = 500;

let checkTimer: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;
let running = false;

export function startHorseSelfTuner(): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === RUN_HOUR_UTC && lastRunDate !== today && !running) {
      lastRunDate = today;
      void runSelfTune(today);
    }
  }, CHECK_INTERVAL_MS);
  checkTimer.unref?.();
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
          const p =
            row.horse_profile && typeof row.horse_profile === 'object'
              ? (row.horse_profile as Record<string, unknown>)
              : {};
          const num = (v: unknown): number | undefined =>
            typeof v === 'number' && isFinite(v) ? v : undefined;
          horses.set(row.id, {
            ...(p as object),
            tightness: num(p.tightness),
            aggression: num(p.aggression),
            bluffFreq: num(p.bluffFreq),
          });
        }
        cursor = (data[data.length - 1] as { id: string }).id;
        if (data.length < 1000) break;
      }
    }
    if (horses.size === 0) return { studied: 0, tuned: 0 };
    const tracked = new Set(horses.keys());

    // Stream the study window through the accumulator, newest first.
    const since = new Date(Date.now() - STUDY_WINDOW_DAYS * 86400_000).toISOString();
    const stats = new Map<string, PlayStats>();
    let fetched = 0;
    let before: string | null = null;
    while (fetched < MAX_HANDS_TO_STUDY) {
      let q = supabase
        .from('hand_history')
        .select('actions, players, winners, big_blind, button_seat, created_at')
        .is('tournament_id', null) // cash only: tournament strategy differs by design
        .gt('created_at', since)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (before) q = q.lt('created_at', before);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      accumulatePlayStats(data as unknown as HandRow[], tracked, stats);
      fetched += data.length;
      before = (data[data.length - 1] as { created_at: string }).created_at;
      if (data.length < PAGE_SIZE) break;
    }

    // Diagnose + write.
    let tuned = 0;
    for (const [horseId, s] of stats) {
      if (s.hands < MIN_HANDS_TO_TUNE) continue;
      const prevMods = horses.get(horseId) ?? {};
      const { mods, reasons } = diagnoseAndNudge(s, prevMods);
      const changed =
        mods.tightness !== (prevMods.tightness ?? 1) ||
        mods.aggression !== (prevMods.aggression ?? 1) ||
        mods.bluffFreq !== (prevMods.bluffFreq ?? 1);

      try {
        if (changed) {
          const newProfile = { ...(prevMods as object), ...mods };
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
            stats: statSnapshot(s),
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

    console.log(
      `[HorseSelfTuner] Studied ${fetched} hands, ${stats.size} horses with data, ` +
        `${tuned} tuned, in ${Date.now() - t0}ms`
    );
    return { studied: stats.size, tuned };
  } catch (err) {
    reportError(err, 'HorseSelfTuner.run');
    lastRunDate = null; // allow a retry on the next check
    return { studied: 0, tuned: 0 };
  } finally {
    running = false;
  }
}
