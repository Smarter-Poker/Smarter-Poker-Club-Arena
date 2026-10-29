/** Owner 2026-10-29 supersedes the historical 25-40% share below: 50% before start, remainder during late entry. */
import { mttPlannedField, mttPrizeShare, mttLevelWindowMs } from './mttHorseArrivalPlan.js';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MTT OVERLAY GUARD — Dan 2026-08-27, binding
 * ═══════════════════════════════════════════════════════════════════════════
 * "If any Midway Union MTT (that both Club JAQK and Shark Club are part of)
 *  is going to have an overlay, new horses start entering it (that aren't
 *  already in it) so no overlay occurs."
 *
 * An overlay is the club paying the difference when entries do not fund the
 * guarantee. Measured live the hour this was written: Union PKO Afternoon
 * needed 33 entries for its 600 guarantee and had 11; Afternoon Bounty needed
 * 22 and had 2. That is real money leaving the club every single cycle.
 *
 * WHAT THIS DOES
 * Every cycle it asks the database which guaranteed events are short
 * (fn_overlay_at_risk), and tops each one up to the entry count the guarantee
 * needs, through the SAME registration path the pre-start ramp uses
 * (TournamentRecurringService.topUpWithHorses). That path already:
 *   - counts who is genuinely registered, so horses ALREADY IN the event are
 *     never double-registered - "that aren't already in it", enforced by
 *     construction rather than by a second list;
 *   - draws only from the events/both game lanes, so cash-only horses are
 *     never pulled into a tournament;
 *   - respects the four-concurrent-table cap per horse;
 *   - refuses to exceed max_players.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It never removes or unregisters anyone.
 *   - It tops up to the guarantee, not to max_players: the goal is to erase
 *     the overlay, not to fill the room.
 *
 * HONESTY
 * Every cycle that acts LOGS what it did and every cycle that cannot act logs
 * why. fn_audit_overlays looks backward at events that already started and
 * raises a finding for any overlay that still happened, so a guard that
 * silently stops working shows up on the daily panel rather than in the
 * accounts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FREEROLLS - Dan 2026-08-27, correcting an earlier decision of mine
 * ═══════════════════════════════════════════════════════════════════════════
 * "All horses, IF THEY ARE PLAYING, should play the freeroll. All real
 *  players would. So if a horse is online and playing they should always
 *  register for the freeroll."
 *
 * The first cut of this file EXCLUDED freerolls, reasoning that their prize
 * is club-funded so entrants cannot remove the shortfall, and that adding
 * horses would dilute a human's equity. Both statements are true and the
 * conclusion was still wrong, because it answered an accounting question
 * when the real one is behavioural: nobody skips free money. A freeroll
 * sitting at 4 of 50 does not read as a quiet game, it reads as a dead room
 * - and that is what a human sees before deciding whether this site has
 * players on it. Measured when Dan raised it: "$100 Freeroll" 24 of 500,
 * "Coffee Break Freeroll" 4 of 50.
 *
 * So freerolls fill toward capacity from EVERY lane - the lane split is a
 * cash-versus-events personality and free money is neither. Eligibility is
 * "is this horse inside its activity window right now", the literal reading
 * of "if they are playing", plus the same four-table cap every path honours.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LATE REGISTRATION DOES NOT END AT THE GUARANTEE - Dan 2026-10-19, binding
 * ═══════════════════════════════════════════════════════════════════════════
 * "just because the 'guarantee was met' doesn't mean horses shouldn't still
 *  late register throughout the tournament..."
 *
 * The overlay pass above was the ONLY thing that ever entered a horse into a
 * RUNNING event, and it stops by design the moment the guarantee is covered
 * (fn_overlay_at_risk lists an event only while ceil(guarantee / buy-in) >
 * current_players, and only for 30 minutes after its start). So once the
 * guarantee was met, late registration went silent for the rest of the
 * window. Measured on production 2026-10-20 03:2x UTC over the previous three
 * days of Midway and Diamond Arena MTTs: every late entry arrived 0-30 minutes
 * after the start (24 / 157 / 351 by ten-minute bucket, then nothing but two
 * satellite qualifiers) although late registration runs 25-90 minutes; the 46
 * paid events with no guarantee took ZERO late entries; and "Monday Mystery"
 * (400 guaranteed, 400 in the pool, late registration open through level 9)
 * had taken its last entry 27 minutes BEFORE its start and none after it.
 *
 * A real room keeps taking late entries until the window shuts, whatever the
 * pool says. So the late-registration pass below runs for every RUNNING MTT
 * whose late registration is open (fn_tournament_late_registration_open, the
 * same answer both registration doors use), and never reads the guarantee.
 * Its cadence is a realistic arrival curve: a per-event share of 25-40% of
 * the starting field arrives across the window, a few per cycle, with a
 * small deterministic wobble so the count does not step like a metronome.
 * Every limit that was ever legitimate still holds, because every entry goes
 * through topUpWithHorses and the horse door: the maintenance freeze, the
 * fleet hold, the events/both lanes, the four-table cap, the horse's own
 * wallet, the field cap, and late registration closing.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { horseHash } from './HorseBehavior.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

/** Midway Union — the union Club JAQK and Shark Club belong to. */
export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

/**
 * THE DIAMOND ARENA RUNS THE MIDWAY SCHEDULE, SO IT GETS THE MIDWAY GUARD
 * (Dan 2026-10-06: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY
 * UNION FOR NOW").
 *
 * The arena's guarantees are earmarked on its house, and an arena event that
 * falls short overlays out of that house exactly as a Midway event overlays
 * out of the union bank. No database change is needed: both reads this guard
 * makes - `fn_overlay_at_risk(p_union)` and `fn_freeroll_fill_targets(p_union)`
 * - already match `c.union_id = p_union OR c.id = p_union`, so passing the
 * arena's own club id selects exactly the arena's events.
 *
 * The arena is read from its one settings row and joins the cycle only while
 * its tournaments are switched on. FAILS CLOSED: an unreadable row, a missing
 * club id or a switch that is anything but `true` leaves the cycle as it was -
 * Midway alone. Opening the arena is a person's decision; this never touches
 * the switch.
 */
export function overlayHostsFrom(
  row: { club_id?: unknown; tournaments_enabled?: unknown } | null | undefined,
  error?: unknown
): string[] {
  if (error || !row || row.tournaments_enabled !== true) return [MIDWAY_UNION_ID];
  const arena = typeof row.club_id === 'string' && row.club_id ? row.club_id : null;
  return arena && arena !== MIDWAY_UNION_ID ? [MIDWAY_UNION_ID, arena] : [MIDWAY_UNION_ID];
}

/** The hosts this cycle guards: Midway, and the Diamond Arena while it runs events. */
export async function overlayGuardHosts(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('ca_arena_settings')
      .select('club_id, tournaments_enabled')
      .eq('id', 1)
      .maybeSingle();
    return overlayHostsFrom(data as Record<string, unknown> | null, error);
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.arena_settings_read_failed');
    return [MIDWAY_UNION_ID];
  }
}

const CYCLE_MS = 2 * 60_000;
const BOOT_DELAY_MS = 90_000;
/** Never add more than this many horses to one event in one cycle. */
const MAX_TOPUP_PER_CYCLE = 40;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightCycles = new Set<Promise<void>>();
const seeder = new TournamentRecurringService();

export interface HorseOverlayGuardHandle {
  stop(): Promise<void>;
}

const guardHandle: HorseOverlayGuardHandle = Object.freeze({
  stop: () => stopHorseOverlayGuard(),
});

export interface OverlayRisk {
  tournament_id: string;
  name: string;
  status: string;
  buy_in: number;
  guaranteed_prize: number;
  entries_needed: number;
  current_players: number;
  shortfall: number;
  max_players: number | null;
  minutes_to_start: number;
}

const enabled = (): boolean => process.env.HORSE_OVERLAY_GUARD_ENABLED !== 'false';

/** Pure: what to do about one at-risk event. Exported for tests. */
export function topUpTargetFor(risk: OverlayRisk): number {
  const needed = Math.max(0, Math.floor(risk.entries_needed));
  const cap = risk.max_players !== null && risk.max_players > 0 ? risk.max_players : needed;
  const target = Math.min(needed, cap);
  // Never ask for more than the per-cycle ceiling above the current field:
  // a huge guarantee on an empty board should fill over several cycles so a
  // single call cannot monopolise the free-horse pool.
  return Math.min(target, risk.current_players + MAX_TOPUP_PER_CYCLE);
}

export interface FreerollTarget {
  tournament_id: string;
  name: string;
  status: string;
  current_players: number;
  max_players: number | null;
  minutes_to_start: number;
}

/** Pure: how full should this freeroll be right now? Exported for tests. */
export function freerollTargetFor(t: FreerollTarget): number {
  // NULL is supplied only by the database projection for activated MTTs.
  if (t.max_players === null) return t.current_players + MAX_TOPUP_PER_CYCLE;
  const cap = Math.max(0, Math.floor(t.max_players));
  if (cap === 0) return 0;
  // Fill toward capacity, but never add more than the per-cycle ceiling at
  // once: a 500-seat freeroll fills over several cycles rather than draining
  // every free horse on the estate in one call and emptying the cash room.
  return Math.min(cap, t.current_players + MAX_TOPUP_PER_CYCLE);
}

/**
 * Register currently-playing horses into open freerolls, up to capacity.
 * Uses the allLanes override: free money is not a lane decision.
 */
export async function fillFreerollsOnce(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let added = 0;
  try {
    if (!shouldContinue()) return added;
    const { data, error } = await supabase.rpc('fn_freeroll_fill_targets', { p_union: unionId });
    if (!shouldContinue()) return added;
    if (error) throw new Error(error.message);
    const targets = (data ?? []) as FreerollTarget[];
    for (const t of targets) {
      if (!shouldContinue()) return added;
      if (t.status === 'RUNNING') continue; // Late arrivals own the running field.
      const target = freerollTargetFor(t);
      if (target <= t.current_players) continue;
      const n = await seeder.topUpWithHorses(t.tournament_id, target, { allLanes: true });
      added += n;
      if (!shouldContinue()) return added;
      if (n > 0) {
        console.log(
          `[HorseOverlayGuard] freeroll ${t.name}: ${t.current_players}/${t.max_players} ` +
            `(starts in ${t.minutes_to_start}m) - registered ${n} horse(s) toward ${target}`
        );
      } else {
        console.warn(
          `[HorseOverlayGuard] freeroll ${t.name} wanted ${target - t.current_players} more and ` +
            `added NONE - every candidate is outside its activity window or at the four-table cap`
        );
      }
    }
    return added;
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.freerolls');
    return added;
  }
}

export async function runOverlayGuardOnce(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  if (running) return 0;
  running = true;
  let acted = 0;
  try {
    if (!shouldContinue()) return acted;
    const { data, error } = await supabase.rpc('fn_overlay_at_risk', { p_union: unionId });
    if (!shouldContinue()) return acted;
    if (error) throw new Error(error.message);
    const risks = (data ?? []) as OverlayRisk[];
    if (risks.length === 0) return 0;

    for (const risk of risks) {
      if (!shouldContinue()) return acted;
      if (risk.status === 'RUNNING') continue; // Spread the remainder across late registration.
      if (risk.shortfall <= 0) continue;
      const target = topUpTargetFor(risk);
      if (target <= risk.current_players) continue;
      const added = await seeder.topUpWithHorses(risk.tournament_id, target);
      acted += added;
      if (!shouldContinue()) return acted;
      const overlay = risk.guaranteed_prize - risk.current_players * risk.buy_in;
      if (added > 0) {
        console.log(
          `[HorseOverlayGuard] ${risk.name}: ${risk.current_players}/${risk.entries_needed} entries ` +
            `(${overlay.toFixed(2)} overlay at risk, starts in ${risk.minutes_to_start}m) - ` +
            `registered ${added} horse(s) toward ${target}`
        );
      } else {
        // A top-up that adds nobody is the failure mode that matters: the
        // event still overlays and nothing else would say so.
        console.warn(
          `[HorseOverlayGuard] ${risk.name}: needed ${risk.shortfall} more entries and added NONE ` +
            `- the events/both lane pool may be exhausted or every candidate is at the ` +
            `four-table cap. Overlay still exposed: ${overlay.toFixed(2)}`
        );
      }
    }
    return acted;
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.run');
    return acted;
  } finally {
    running = false;
  }
}

/* ─── LATE REGISTRATION (Dan 2026-10-19) ─── see the header of this file. ─── */

/** Share of the starting field that late-registers: 25% plus up to 15% more. */
export const LATE_REG_SHARE_MIN = 1;
export const LATE_REG_SHARE_SPREAD = 0;
/** Even a small field sees a couple of late arrivals. */
export const LATE_REG_MIN_ARRIVALS = 2;
/** Most late entrants one event takes in one cycle: arrivals, not a burst. */
export const LATE_REG_MAX_STEP = 4;
/** How far back a RUNNING event is looked for. Longer than any late window. */
const LATE_REG_LOOKBACK_MS = 12 * 60 * 60_000;

export interface LateRegEvent {
  tournament_id: string;
  /** `tournaments.started_at` in ms. */
  startedAtMs: number;
  nowMs: number;
  /** `tournaments.late_reg_mins`; 0 means no clock window. */
  lateRegMins: number;
  /** `tournaments.late_reg_levels` (or rebuy_levels); 0 means no level window. */
  lateRegLevels: number;
  currentLevel: number;
  /** Entries registered at or before the start. */
  entriesAtStart: number;
  /** Planned complete field; independent of any house-funded prize pool. */
  plannedField?: number;
  /** Duration of the level window, read from the published blind ladder. */
  levelWindowMs?: number;
  /** Entries registered after the start, by anybody, through any path. */
  lateEntries: number;
  /** Authoritative DB door, read immediately before planning this cycle. */
  registrationOpen?: boolean;
}

/** Pure: this event's late-registration share, fixed per event id. */
export function lateRegShareFor(tournamentId: string): number {
  return (
    LATE_REG_SHARE_MIN +
    ((horseHash(`${tournamentId}:late-share`) % 1000) / 1000) * LATE_REG_SHARE_SPREAD
  );
}

/**
 * Pure: how far through its late-registration window the event is, 0..1, or
 * null when no window is configured. Whichever deadline is nearer decides,
 * as fn_tournament_late_registration_open closes on whichever passes first.
 */
export function lateRegProgress(ev: LateRegEvent): number | null {
  const mins = Number(ev.lateRegMins) || 0;
  const levels = Number(ev.lateRegLevels) || 0;
  if (mins <= 0 && levels <= 0) return null;
  let progress = 0;
  if (mins > 0) {
    if (!Number.isFinite(ev.startedAtMs) || !Number.isFinite(ev.nowMs)) return null;
    progress = Math.max(progress, (ev.nowMs - ev.startedAtMs) / (mins * 60_000));
  }
  if (levels > 0) {
    progress = Math.max(progress, (Number(ev.currentLevel) || 0) / levels);
    // A persisted level can lag the manager. The published ladder gives a
    // continuous clock between levels, while the DB door still closes entry.
    if (ev.levelWindowMs && ev.levelWindowMs > 0)
      progress = Math.max(progress, (ev.nowMs - ev.startedAtMs) / ev.levelWindowMs);
  }
  return Math.min(1, Math.max(0, progress));
}

/**
 * Pure: how many horses should late-register into this event THIS cycle.
 *
 * It takes no guarantee, prize pool or overlay input on purpose: whether the
 * guarantee is met has no bearing on whether people keep arriving. The goal
 * is a cumulative arrival curve across the window; entries that already
 * arrived late (a human, the overlay pass, an earlier cycle) count toward it,
 * so nothing is double-counted.
 */
export function lateRegArrivalsFor(ev: LateRegEvent): number {
  const progress = lateRegProgress(ev);
  if (ev.registrationOpen === false || progress === null) return 0;
  // Pauses can extend a level-based window beyond its ladder estimate.
  // Only the authoritative open door may overrule that estimate.
  if (progress >= 1 && ev.registrationOpen !== true) return 0;
  const atStart = Math.max(0, Math.floor(Number(ev.entriesAtStart) || 0));
  const expected = Math.max(
    LATE_REG_MIN_ARRIVALS,
    Math.round(atStart * lateRegShareFor(ev.tournament_id)),
    Math.max(0, (ev.plannedField ?? atStart * 2) - atStart)
  );
  // A few arrive in one cycle, none in the next: a deterministic -1/0/+1
  // around the curve, keyed on the event and the cycle.
  const cycle = Math.max(0, Math.floor((ev.nowMs - ev.startedAtMs) / CYCLE_MS));
  const wobble = (horseHash(`${ev.tournament_id}:late-cycle:${cycle}`) % 3) - 1;
  const late = Math.max(0, Math.floor(Number(ev.lateEntries) || 0));
  const windows = [
    ev.lateRegMins > 0 ? ev.lateRegMins * 60_000 : Infinity,
    ev.levelWindowMs && ev.levelWindowMs > 0 ? ev.levelWindowMs : Infinity,
  ];
  const windowMs = Math.min(...windows);
  // Complete the planned arrivals on the last legal cycle, not after entry
  // has closed. A closed DB door is still checked before any payment.
  const scheduledProgress = Number.isFinite(windowMs)
    ? Math.min(1, progress + CYCLE_MS / windowMs)
    : progress;
  const goal =
    scheduledProgress >= 1
      ? expected
      : Math.min(expected, Math.max(0, Math.ceil(expected * scheduledProgress) + wobble));
  const step = Number.isFinite(windowMs)
    ? Math.max(LATE_REG_MAX_STEP, Math.ceil((expected * CYCLE_MS) / windowMs) + 1)
    : LATE_REG_MAX_STEP;
  return Math.max(0, Math.min(step, goal - late));
}

interface LateRegRow {
  id: string;
  name: string;
  status: string;
  format_contract: string | null;
  started_at: string | null;
  current_level: number | null;
  late_reg_levels: number | null;
  rebuy_levels: number | null;
  late_reg_mins: number | null;
  buy_in_amount: number | string | null;
  bounty_amount?: number | string | null;
  guaranteed_prize?: number | string | null;
  blind_structure?: unknown;
  prize_pool_finalized: boolean | null;
}

/** One roster count: every entry, the live field, or entries after `afterIso`. */
async function rosterCount(
  tournamentId: string,
  which: 'all' | 'live' | { afterIso: string }
): Promise<number | null> {
  const base = supabase
    .from('tournament_players')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', tournamentId);
  const query =
    which === 'all'
      ? base
      : which === 'live'
        ? base.in('status', ['registered', 'playing'])
        : base.gt('registered_at', which.afterIso);
  const { count, error } = await query;
  if (error || typeof count !== 'number') return null;
  return count;
}

/**
 * Keep horses late-registering into every RUNNING MTT of this host whose late
 * registration is open, until it closes. Never reads the guarantee.
 */
export async function lateRegisterHorsesOnce(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true,
  nowMs: number = Date.now()
): Promise<number> {
  let added = 0;
  try {
    if (!shouldContinue() || isMaintenanceFrozen()) return added;
    const { data: clubs, error: clubErr } = await supabase
      .from('clubs')
      .select('id')
      .or(`id.eq.${unionId},union_id.eq.${unionId}`);
    if (clubErr) throw new Error(clubErr.message);
    const clubIds = ((clubs ?? []) as Array<{ id?: string }>)
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (clubIds.length === 0 || !shouldContinue()) return added;

    const { data: rows, error } = await supabase
      .from('tournaments')
      .select(
        'id, name, status, format_contract, started_at, current_level, late_reg_levels, rebuy_levels, late_reg_mins, buy_in_amount, bounty_amount, guaranteed_prize, blind_structure, prize_pool_finalized'
      )
      .eq('status', 'RUNNING')
      .eq('prize_pool_finalized', false)
      .in('format_contract', ['mtt-v1', 'mtt-v2'])
      .in('club_id', clubIds)
      .gt('started_at', new Date(nowMs - LATE_REG_LOOKBACK_MS).toISOString())
      .order('started_at', { ascending: true });
    if (error) throw new Error(error.message);

    for (const t of (rows ?? []) as LateRegRow[]) {
      if (!shouldContinue() || isMaintenanceFrozen()) return added;
      const startedAtMs = Date.parse(String(t.started_at ?? ''));
      if (!Number.isFinite(startedAtMs)) continue;

      // The doors' own answer: level window, clock window, field cap, pool.
      const { data: open, error: openErr } = await supabase.rpc(
        'fn_tournament_late_registration_open',
        { p_tournament_id: t.id }
      );
      if (openErr || typeof open !== 'boolean') {
        reportError(
          new Error(
            `[HorseOverlayGuard] late registration state unreadable for ${t.id.slice(0, 8)}`
          ),
          'HorseOverlayGuard.late_reg_open_unreadable'
        );
        continue;
      }
      if (!open) continue;

      const startedIso = new Date(startedAtMs).toISOString();
      const [late, live, total] = await Promise.all([
        rosterCount(t.id, { afterIso: startedIso }),
        rosterCount(t.id, 'live'),
        rosterCount(t.id, 'all'),
      ]);
      // An unreadable roster is not an empty one: skip, never guess.
      if (late === null || live === null || total === null) continue;

      const want = lateRegArrivalsFor({
        registrationOpen: true,
        tournament_id: t.id,
        startedAtMs,
        nowMs,
        lateRegMins: Number(t.late_reg_mins) || 0,
        // Same precedence as fn_tournament_late_registration_open.
        lateRegLevels: Number(t.late_reg_levels ?? t.rebuy_levels ?? 0) || 0,
        currentLevel: Number(t.current_level) || 0,
        entriesAtStart: total - late,
        plannedField: mttPlannedField(Number(t.guaranteed_prize) || 0, mttPrizeShare(t)),
        levelWindowMs: mttLevelWindowMs(
          t.blind_structure,
          Number(t.late_reg_levels ?? t.rebuy_levels ?? 0)
        ),
        lateEntries: late,
      });
      if (want <= 0) continue;

      // topUpWithHorses counts the live field (registered + playing), so the
      // target is that field plus this cycle's arrivals.
      const isFree = (Number(t.buy_in_amount) || 0) <= 0;
      const n = await seeder.topUpWithHorses(t.id, live + want, { allLanes: isFree });
      added += n;
      if (!shouldContinue()) return added;
      if (n > 0) {
        console.log(
          `[HorseOverlayGuard] late registration ${t.name}: +${n} horse(s) ` +
            `(${late} late entries so far, level ${t.current_level ?? 0})`
        );
      }
    }
    return added;
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.late_registration');
    return added;
  }
}

/** One full cycle: guaranteed events, then freerolls, then late registration. */
export async function runEventFillCycle(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  const guaranteed = await runOverlayGuardOnce(unionId, shouldContinue);
  if (!shouldContinue()) return guaranteed;
  const freerolls = await fillFreerollsOnce(unionId, shouldContinue);
  if (!shouldContinue()) return guaranteed + freerolls;
  const late = await lateRegisterHorsesOnce(unionId, shouldContinue);
  return guaranteed + freerolls + late;
}

function lifecycleIsCurrent(generation: number): boolean {
  return lifecycleActive && lifecycleGeneration === generation;
}

function launchOwnedCycle(context: string): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightCycles.size > 0) return;

  let tracked!: Promise<void>;
  tracked = (async () => {
    if (!lifecycleIsCurrent(generation)) return;
    const hosts = await overlayGuardHosts();
    for (const host of hosts) {
      if (!lifecycleIsCurrent(generation)) return;
      await runOverlayGuardOnce(host, () => lifecycleIsCurrent(generation));
    }
    // Shutdown revokes this scheduler between its two independent mutation
    // passes. The already-started pass is joined by stop(); the second one is
    // never launched by a stale generation.
    for (const host of hosts) {
      if (!lifecycleIsCurrent(generation)) return;
      await fillFreerollsOnce(host, () => lifecycleIsCurrent(generation));
    }
    // Late registration keeps arriving whether or not the guarantee is met.
    for (const host of hosts) {
      if (!lifecycleIsCurrent(generation)) return;
      await lateRegisterHorsesOnce(host, () => lifecycleIsCurrent(generation));
    }
  })()
    .catch((err: unknown) => reportError(err, context))
    .finally(() => inFlightCycles.delete(tracked));
  inFlightCycles.add(tracked);
}

async function drainOwnedCycles(): Promise<void> {
  // Fixed point rather than one snapshot: a promise can settle and enqueue a
  // final continuation in the same turn. stop() does not resolve until the
  // owned set is observably empty.
  while (inFlightCycles.size > 0) {
    await Promise.allSettled([...inFlightCycles]);
  }
}

export function startHorseOverlayGuard(): HorseOverlayGuardHandle | null {
  if (timer || bootTimer || lifecycleActive || !enabled()) return null;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  timer = setInterval(() => {
    launchOwnedCycle('HorseOverlayGuard.tick');
  }, CYCLE_MS);
  timer.unref?.();
  bootTimer = setTimeout(() => {
    bootTimer = null;
    launchOwnedCycle('HorseOverlayGuard.boot');
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
  console.log(
    '[HorseOverlayGuard] started - guaranteed events topped to their guarantee, freerolls filled from every lane, and late registration kept arriving until it closes, every 2 minutes'
  );
  return guardHandle;
}

export function stopHorseOverlayGuard(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  stopOperation = drainOwnedCycles();
  return stopOperation;
}
