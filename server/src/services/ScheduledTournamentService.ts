/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCHEDULED TOURNAMENT SERVICE — data-driven recurring MTT spawner (2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reads `tournament_schedules` (migration 20260822100100) and creates
 * `tournaments` rows from each schedule's `config` (fn_create_tournament
 * p_config key shapes). Complements — does not replace —
 * TournamentRecurringService, whose hardcoded hour blocks stay exactly as they
 * are; this service only acts on rows a human wrote into the database.
 *
 * Three duties, all inside one 60-second poll:
 *
 *   TIMED    days_of_week + start_times_utc: spawn each instance ~30 minutes
 *            ahead of its start so it shows in the lobby, with a 5-minute
 *            catch-up window behind `now` so a reboot straddling a start time
 *            still creates the event. Dedupe through
 *            tournament_schedule_spawns(spawn_key UNIQUE) so a crashed or
 *            double-running spawner can never create the same instance twice.
 *
 *   INTERVAL interval_minutes with no start times: keep at most ONE live
 *            instance per schedule; respawn interval_minutes after the
 *            previous instance ended.
 *
 *   RESTART  manual tournaments (schedule_id IS NULL) that completed with
 *            restart_every_minutes set are cloned column-for-column so the
 *            event repeats without a schedule row.
 *
 * FAIL-CLOSED THROUGHOUT: any read error, unparseable config, or unresolvable
 * satellite target skips THAT spawn and never breaks the loop. A skipped spawn
 * is retried on the next poll (its spawn key is only claimed after the config
 * validates), so a transient error costs one minute, not the event.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { buyInFor, rakeRateFor, wholeChips } from '../config/buyIn.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { buildLadder, type GeneratedBlindLevel } from '../tournament/blindLadder.js';
import { SPIN_SEATS, SPIN_TIERS, spinBlindsForLevel } from '../config/spinSpec.js';
import {
  HEADS_UP_BLIND_STRUCTURE,
  HEADS_UP_PAYOUTS,
  HEADS_UP_SEATS,
} from '../config/headsUpSpec.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentScheduleRow {
  id: string;
  union_id: string | null;
  club_id: string;
  name: string;
  active: boolean;
  days_of_week: number[]; // 0=Sunday .. 6=Saturday, UTC
  start_times_utc: string[]; // 'HH24:MI'
  interval_minutes: number | null;
  config: Record<string, unknown> | string;
}

interface SpawnDue {
  spawnKey: string;
  startTime: Date;
}

const POLL_INTERVAL_MS = 60 * 1000;
/** Live = a player can join it or it is still playing/settling. */
const LIVE_STATUSES = ['REGISTERING', 'RUNNING', 'COMPLETING'];

/** How far behind `now` a scheduled time still spawns (boot catch-up). */
export const TIMED_WINDOW_PAST_MS = 5 * 60 * 1000;
/**
 * How far ahead of `now` an instance is created so it appears in the lobby.
 *
 * WAS 30 MINUTES, AND THAT IS WHY THE BOARD LOOKED EMPTY (Dan, 2026-08-23:
 * "there are currently no mtt's built, scheduled or running"). Thirty-eight
 * schedules were live and firing exactly on time, but each event only existed
 * for the half hour before it started — and since a full field starts on the
 * minute and plays out fast, a player looking at the lobby at any given
 * moment saw two joinable MTTs out of thirty-eight schedules. The schedule
 * was real; the LOBBY was empty, which for a player is the same thing.
 *
 * A day's look-ahead publishes the whole card the way a real room does:
 * tomorrow's events are on the board tonight, with their buy-ins, guarantees
 * and start times, and a player can register whenever they like.
 *
 * (That paragraph used to end "and `spawnAheadMinutes` still OVERRIDES per
 * schedule". It does not, any more, and leaving the sentence here would be an
 * invitation to restore the exact bug documented under spawnAheadMsFor below:
 * every live schedule carries 1440, so an override that wins outright pins the
 * whole platform to a 24-hour board no matter what this constant says. It
 * raises the floor now. The Sunday Major's week still wins because a week is
 * LONGER, which was always the only case that mattered.)
 *
 * NOW 72 HOURS (Dan 2026-08-26: "USE 72H/6 DAY FOR $200 BUY IN
 * OR MORE", revising the 48 hours he first asked for). The lobby cannot list a row that does
 * not exist, so every client-side attempt to widen the board was capped by
 * THIS constant -- with 60 active schedules the board carried one day of card
 * and looked, correctly, like a room with almost nothing on tomorrow.
 *
 * PARITY: `src/utils/tournamentScheduleWindow.ts` holds the same two numbers
 * for the client, and `tests/unit/scheduleWindowParity.test.ts` fails if they
 * drift. They are duplicated rather than imported because `server/` compiles
 * standalone -- the same arrangement RakeConfig has.
 */
export const TIMED_WINDOW_AHEAD_MS = 72 * 60 * 60 * 1000;

/**
 * Total buy-in ABOVE which a schedule publishes on the long window instead.
 *
 * Dan 2026-08-26: "ANY TOURNAMENT WITH A BUY IN OF MORE THEN 200 THAT IS ON
 * THE SCHEDULE CAN BE SHOWN 6 DAYS OUT." Strictly greater than, so a flat 200
 * chip event is a 48-hour event. Measured on the TOTAL a player pays, which
 * for a schedule is `cfg.buyIn` before the prize/fee split -- the two columns
 * the lobby adds back together.
 */
export const FEATURE_BUYIN_THRESHOLD = 200;
/* INCLUSIVE since 2026-08-26 ("$200 BUY IN OR MORE"). The first pass used a
   strict `>`, which put a flat 200 event — the Sunday Deep Stack's exact
   price — on the short window. */
export const FEATURE_WINDOW_AHEAD_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * The look-ahead for one schedule.
 *
 * `spawnAheadMinutes` RAISES THE FLOOR. IT DOES NOT LOWER IT.
 *
 * THIS IS THE WHOLE FIX, AND THE FIRST VERSION OF IT WAS DEAD CODE. The
 * override used to win outright, on the reasoning that a flagship sets it to a
 * week so its satellites can resolve the target all week. That reasoning is
 * sound in ONE direction only, and the data says so plainly: every one of the
 * 60 active schedules on this platform carries `spawnAheadMinutes: 1440`,
 * written when 24 hours WAS the house window. An override that wins outright
 * therefore means all 60 schedules keep publishing 24 hours of card no matter
 * what TIMED_WINDOW_AHEAD_MS says -- the constant would have moved to 48, CI
 * would have gone green, the PR would have merged, and Dan's board would have
 * looked exactly as empty as it did before.
 *
 * The house window is a FLOOR: "it should be displaying all events that are
 * scheduled over the next 48 hours" is not a default to be opted out of. A
 * schedule may ask for MORE (the Sunday Major's 10080 still wins, because it
 * is larger). It may not ask for less.
 *
 * An out-of-range or unreadable override is ignored entirely rather than
 * clamped, which is the same fail-closed choice the rest of this file makes.
 */
export function spawnAheadMsFor(cfg: Record<string, unknown>): number {
  const byRule =
    wholeChips(cfg.buyIn) >= FEATURE_BUYIN_THRESHOLD
      ? FEATURE_WINDOW_AHEAD_MS
      : TIMED_WINDOW_AHEAD_MS;

  const explicit = Number(cfg.spawnAheadMinutes);
  if (Number.isFinite(explicit) && explicit >= 30 && explicit <= 10_080) {
    return Math.max(byRule, Math.round(explicit) * 60_000);
  }
  return byRule;
}
/**
 * Horses are seeded at SPAWN only when the start is this close.
 *
 * Seeding at spawn was harmless at a 30-minute look-ahead and is actively
 * harmful at 24 hours: a horse registered into tomorrow's event is a horse
 * that cannot deal a cash table or fill a spin today, and the pool is finite.
 *
 * Dan 2026-08-23: aligned to the one-hour MTT ramp (MTT_PRESTART_RAMP_MS), so
 * an event that spawns already inside the hour gets its opening field
 * immediately instead of waiting up to a ramp tick for it.
 *
 * WHAT THIS CONSTANT NO LONGER MEANS. It used to be the whole policy, and the
 * note here used to say events "open EMPTY and stay genuinely open", with the
 * past-start top-up as the only filler. That was checked ONCE, at creation, so
 * a day-ahead event answered "no" and was never asked again - which is how a
 * 200-seat MTT sat in the lobby for seventeen hours reading 0/200. The field
 * is now built by the pre-start ramp in GameServer.discoverTournaments, which
 * re-evaluates every REGISTERING tournament on a timer. This is just the
 * head start; the ramp is the rule.
 */
export const HORSE_SEED_WITHIN_MS = 60 * 60 * 1000;
/* DELIBERATELY NO LONGER EQUAL TO MTT_PRESTART_RAMP_MS (2026-08-26).
   They were aligned on 2026-08-23 when both meant "about to start". The ramp
   now runs for the full 72-hour publish window so the board is never a wall of
   empty games; this constant is a different thing - the head start given at
   SPAWN, before the ramp has ticked once. Seeding three days early would put
   chips into a pool for an event that has only just appeared, and the ramp
   reaches it within one tick anyway. One hour is still exactly right for a
   head start. */

// ═══════════════════════════════════════════════════════════════════════════════
// PURE SCHEDULING LOGIC — exported so the matching rules are testable with no DB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every (day, time) instance of a timed schedule whose scheduled datetime falls
 * inside [now - TIMED_WINDOW_PAST_MS, now + TIMED_WINDOW_AHEAD_MS].
 *
 * Candidate dates cover yesterday/today/tomorrow (UTC) because the look-ahead
 * window can cross midnight in either direction — a 23:50 check must still see
 * tomorrow's 00:15 event when tomorrow is a scheduled day, and vice versa.
 *
 * The spawn key is `${schedule.id}:${yyyy-mm-dd}:${HH:MM}` in UTC, so the same
 * instance computes the same key on every process that ever looks at it.
 */
export function timedSpawnsDue(
  schedule: Pick<TournamentScheduleRow, 'id' | 'days_of_week' | 'start_times_utc'>,
  now: Date,
  aheadMs: number = TIMED_WINDOW_AHEAD_MS
): SpawnDue[] {
  const due: SpawnDue[] = [];
  const times = schedule.start_times_utc ?? [];
  const days = new Set(schedule.days_of_week ?? []);
  if (times.length === 0 || days.size === 0) return due;

  // The candidate-day span must cover the whole look-ahead window: a schedule
  // with a multi-day spawnAheadMinutes (flagships that open registration days
  // early so satellites can resolve them) needs future days, not just
  // yesterday/today/tomorrow.
  const aheadDays = Math.max(1, Math.ceil(aheadMs / 86_400_000));
  const dayOffsets: number[] = [-1];
  for (let d = 0; d <= aheadDays; d++) dayOffsets.push(d);

  for (const dayOffset of dayOffsets) {
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset)
    );
    if (!days.has(day.getUTCDay())) continue;
    for (const tm of times) {
      const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(tm));
      if (!m) continue; // malformed time — fail closed on this entry
      const at = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          Number(m[1]),
          Number(m[2])
        )
      );
      const delta = at.getTime() - now.getTime();
      if (delta < -TIMED_WINDOW_PAST_MS || delta > aheadMs) continue;
      due.push({
        spawnKey: `${schedule.id}:${at.toISOString().slice(0, 10)}:${m[1]}:${m[2]}`,
        startTime: at,
      });
    }
  }
  return due;
}

/**
 * INTERVAL mode decision. One live instance at a time; a new one is due only
 * when the previous instance has been over for interval_minutes — or
 * immediately, if the schedule has never spawned at all. An instance that
 * exists but has no known end time is AMBIGUOUS, and ambiguity fails closed.
 */
export function intervalRespawnDue(args: {
  hasLive: boolean;
  everSpawned: boolean;
  lastEndedAt: Date | null;
  intervalMinutes: number;
  now: Date;
}): boolean {
  if (args.hasLive) return false;
  if (!args.everSpawned) return true;
  if (!args.lastEndedAt) return false;
  return args.now.getTime() >= args.lastEndedAt.getTime() + args.intervalMinutes * 60_000;
}

/** Dedupe key for an interval spawn: stable within the epoch minute. */
export function intervalSpawnKey(scheduleId: string, now: Date): string {
  return `${scheduleId}:interval:${Math.floor(now.getTime() / 60_000)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG → tournaments ROW MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/** Same normalization fn_create_tournament and TournamentRecurringService use. */
const GAME_TYPE_MAP: Record<string, string> = {
  nlh: 'NLH',
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  shortdeck: 'SHORT_DECK',
  short_deck: 'SHORT_DECK',
};

const KNOWN_TYPES = new Set([
  'freezeout',
  'mtt',
  'bounty',
  'progressive_bounty',
  'mystery_bounty',
  'satellite',
  'sng',
  'spin',
]);

/** Mystery bounty multiplier bounds — identical to TournamentRecurringService. */
const MYSTERY_MIN_MULT = 0.5;
const MYSTERY_MAX_MULT = 13;

/**
 * Named blind presets, resolvable from a schedule config as `blindPreset`, so
 * seed rows and the schedule UI can say "STANDARD" instead of embedding a
 * structure array. TURBO/STANDARD/HYPER_TURBO mirror the arrays
 * TournamentRecurringService has always used; SLOW/DEEP are the slow-structure
 * additions (12-minute early levels, extra depth). An explicit
 * `blindStructure` array in the config always wins over the preset.
 */
export const SCHEDULE_BLIND_PRESETS: Record<string, GeneratedBlindLevel[]> = {
  /**
   * GENERATED AND DEEP (2026-08-31). These were hand-written 5-12 level arrays.
   * Measured over 579 completed MTTs the average event reached level 14 and the
   * deepest reached 124, so 95.7% of tournaments played their late game on the
   * overflow path — which doubled the blinds every level. 38.1% ended with all
   * chips in play worth under three big blinds.
   *
   * Level 1 of every preset is unchanged, so advertised structures still read
   * exactly as they did. See tournament/blindLadder.ts.
   */
  SLOW: buildLadder({
    startBigBlind: 50,
    speed: 'SLOW',
    levels: 40,
    openingMinutes: 12,
    floorMinutes: 6,
    anteFromLevel: 3,
  }),
  STANDARD: buildLadder({
    startBigBlind: 50,
    speed: 'STANDARD',
    levels: 40,
    openingMinutes: 10,
    floorMinutes: 5,
    anteFromLevel: 2,
  }),
  TURBO: buildLadder({
    startBigBlind: 50,
    speed: 'TURBO',
    levels: 24,
    openingMinutes: 4,
    floorMinutes: 2,
    anteFromLevel: 1,
  }),
  HYPER_TURBO: buildLadder({
    startBigBlind: 100,
    speed: 'HYPER_TURBO',
    levels: 16,
    openingMinutes: 2,
    floorMinutes: 1,
    anteFromLevel: 1,
  }),
};
SCHEDULE_BLIND_PRESETS.DEEP = SCHEDULE_BLIND_PRESETS.SLOW;
// DEEPSTACK is what the schedule seeds actually wrote (19 active schedules on
// production carry `blindPreset: "DEEPSTACK"`, all created 2026-08-25) and it
// resolved to NOTHING — every one of those events was silently skipped with
// `structure_missing` on each spawn attempt: Morning Grind Deepstack,
// Five-Card Big Stack, Midweek Morning Stack, Wednesday PLO Stack, Sunday
// Funday Six-Card Closer, and fourteen more never ran once. Same structure as
// DEEP/SLOW — a deep stack IS the slow structure.
SCHEDULE_BLIND_PRESETS.DEEPSTACK = SCHEDULE_BLIND_PRESETS.SLOW;

/** Named payout presets, resolvable as `payoutPreset`. */
export const SCHEDULE_PAYOUT_PRESETS: Record<
  string,
  Array<{ place: number; percentage: number }>
> = {
  THREE: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  FIVE: [
    { place: 1, percentage: 40 },
    { place: 2, percentage: 25 },
    { place: 3, percentage: 18 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 7 },
  ],
  NINE: [
    { place: 1, percentage: 30 },
    { place: 2, percentage: 20 },
    { place: 3, percentage: 15 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 8 },
    { place: 6, percentage: 6 },
    { place: 7, percentage: 5 },
    { place: 8, percentage: 3.5 },
    { place: 9, percentage: 2.5 },
  ],
  WINNER_TAKE_ALL: [{ place: 1, percentage: 100 }],
  HEADS_UP: [{ place: 1, percentage: 100 }],
};

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export class ScheduledTournamentService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  /** Re-entrancy guard: a slow poll must never overlap the next tick. */
  private polling = false;
  /**
   * Horse seeding + count repair, reused rather than re-implemented:
   * topUpWithHorses registers through fn_register_horse_for_tournament (real
   * buy-in, rake row, prize-pool contribution) and rewrites current_players
   * from the authoritative tournament_players count. The instance is never
   * start()ed — only its public top-up entry point is used.
   */
  private readonly horseSeeder = new TournamentRecurringService();

  /**
   * Schedules already refused for naming a seat-first format, so the refusal
   * is reported once rather than on every poll of a schedule that will never
   * be spawnable.
   */
  private readonly refusedSeatFirstSchedules = new Set<string>();

  start(): void {
    if (this.isRunning) {
      console.log('[ScheduledTournaments] Already running');
      return;
    }
    this.isRunning = true;
    console.log('[ScheduledTournaments] Service started - polling every 60s');
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.poll();
  }

  stop(): void {
    if (!this.isRunning) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isRunning = false;
    console.log('[ScheduledTournaments] Stopped');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POLL
  // ─────────────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { data: schedules, error } = await supabase
        .from('tournament_schedules')
        .select('*')
        .eq('active', true);
      if (error) {
        reportError(
          new Error(`[ScheduledTournaments] schedule read failed: ${error.message}`),
          'ScheduledTournaments.schedule_read_failed'
        );
      } else {
        for (const schedule of (schedules ?? []) as TournamentScheduleRow[]) {
          // A failed schedule NEVER breaks the loop for its neighbours.
          try {
            await this.processSchedule(schedule);
          } catch (err: unknown) {
            reportError(
              new Error(
                `[ScheduledTournaments] schedule ${String(schedule?.id).slice(0, 8)} failed: ${(err as Error)?.message ?? err}`
              ),
              'ScheduledTournaments.schedule_failed'
            );
          }
        }
      }

      try {
        await this.processRestartEvery();
      } catch (err: unknown) {
        reportError(
          new Error(
            `[ScheduledTournaments] restart-every sweep failed: ${(err as Error)?.message ?? err}`
          ),
          'ScheduledTournaments.restart_sweep_failed'
        );
      }
    } catch (err: unknown) {
      reportError(
        new Error(`[ScheduledTournaments] poll failed: ${(err as Error)?.message ?? err}`),
        'ScheduledTournaments.poll_failed'
      );
    } finally {
      this.polling = false;
    }
  }

  private async processSchedule(schedule: TournamentScheduleRow): Promise<void> {
    const cfg = this.parseConfig(schedule);
    if (!cfg) return; // unparseable config — reported inside, fail closed

    const hasTimes = (schedule.start_times_utc ?? []).length > 0;
    if (hasTimes) {
      await this.processTimedSchedule(schedule, cfg);
    } else if (schedule.interval_minutes && schedule.interval_minutes > 0) {
      await this.processIntervalSchedule(schedule, cfg);
    }
    // Neither times nor interval: nothing to do (fn_upsert refuses this shape,
    // but a hand-written row must not crash the loop).
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TIMED MODE
  // ─────────────────────────────────────────────────────────────────────────

  private async processTimedSchedule(
    schedule: TournamentScheduleRow,
    cfg: Record<string, unknown>
  ): Promise<void> {
    // Optional per-schedule look-ahead (minutes, 30 min .. 7 days), else the
    // buy-in decides: 48 hours, or 6 days above 200. See spawnAheadMsFor.
    const cadence = String(cfg.recurrenceCadence ?? 'weekly').toLowerCase();
    const monthlyDay = Math.min(31, Math.max(1, Number(cfg.recurrenceDayOfMonth) || 1));
    const due = timedSpawnsDue(schedule, new Date(), spawnAheadMsFor(cfg)).filter((spawn) =>
      cadence === 'monthly' ? spawn.startTime.getUTCDate() === monthlyDay : true
    );
    if (due.length === 0) return;

    // 2026-08-31: pre-filter instances whose spawn key is already claimed.
    // The INSERT + UNIQUE(spawn_key) in claimSpawn remains the atomic claim —
    // this read is purely a courtesy check. Without it, every poll (60s)
    // re-INSERTed every already-claimed instance inside the multi-day
    // look-ahead and ate a 23505 for each: a permanent ~2/sec duplicate-key
    // error storm in the Postgres logs that buried real unique violations and
    // wasted a doomed write per schedule instance per minute. A claim that
    // lands between this read and the INSERT still gets its 23505 and stands
    // down exactly as before; if the read itself fails, fall back to
    // attempting everything (the old behaviour), never to skipping spawns.
    let claimedSet: Set<string> | null = null;
    const { data: claimedRows, error: claimedErr } = await supabase
      .from('tournament_schedule_spawns')
      .select('spawn_key')
      .in(
        'spawn_key',
        due.map((d) => d.spawnKey)
      );
    if (!claimedErr && Array.isArray(claimedRows)) {
      claimedSet = new Set(claimedRows.map((r: { spawn_key: string }) => r.spawn_key));
    }

    for (const spawn of due) {
      if (claimedSet?.has(spawn.spawnKey)) continue; // already spawned
      await this.spawnInstance(schedule, cfg, spawn.spawnKey, spawn.startTime);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERVAL MODE
  // ─────────────────────────────────────────────────────────────────────────

  private async processIntervalSchedule(
    schedule: TournamentScheduleRow,
    cfg: Record<string, unknown>
  ): Promise<void> {
    const { count: liveCount, error: liveErr } = await supabase
      .from('tournaments')
      .select('id', { count: 'exact', head: true })
      .eq('schedule_id', schedule.id)
      .in('status', LIVE_STATUSES);
    if (liveErr || liveCount === null || liveCount === undefined) return; // fail closed

    const { data: prev, error: prevErr } = await supabase
      .from('tournaments')
      .select('id, status, ended_at, created_at')
      .eq('schedule_id', schedule.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevErr) return; // fail closed

    // A terminal instance with no ended_at stamp is treated as ended at its
    // creation time — better a late respawn than a schedule stuck forever.
    const terminal = prev && !LIVE_STATUSES.includes(String(prev.status)) ? prev : null;
    const lastEndedAt = prev?.ended_at
      ? new Date(prev.ended_at)
      : terminal?.created_at
        ? new Date(terminal.created_at)
        : null;

    const now = new Date();
    const dueNow = intervalRespawnDue({
      hasLive: liveCount > 0,
      everSpawned: !!prev,
      lastEndedAt,
      intervalMinutes: schedule.interval_minutes as number,
      now,
    });
    if (!dueNow) return;

    const startTime = new Date(now.getTime() + 5 * 60 * 1000);
    await this.spawnInstance(schedule, cfg, intervalSpawnKey(schedule.id, now), startTime);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SPAWN — claim key, insert tournament, record id, seed horses
  // ─────────────────────────────────────────────────────────────────────────

  private async spawnInstance(
    schedule: TournamentScheduleRow,
    cfg: Record<string, unknown>,
    spawnKey: string,
    startTime: Date
  ): Promise<void> {
    // Resolve everything that can fail BEFORE claiming the spawn key, so a
    // skipped spawn (e.g. satellite target not found yet) is retried next poll
    // instead of being burned forever.
    const row = await this.buildInsertRow(schedule, cfg, startTime);
    if (!row) return;

    if (!(await this.claimSpawn(schedule.id, spawnKey))) return; // already spawned

    const { data: created, error: insertErr } = await supabase
      .from('tournaments')
      .insert(row)
      .select('id')
      .maybeSingle();

    if (insertErr || !created) {
      const msg = insertErr?.message ?? 'unknown';
      if (insertErr?.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
        // uq_scheduled_tournament_one_live_per_name: a same-named pre-start
        // event already exists. Benign — the event the schedule wanted is on
        // the board.
        //
        // RELEASE THE CLAIM ANYWAY (2026-08-23). Holding it was right at a
        // 30-minute look-ahead, where a collision meant "this same instance
        // is already there". At a 24-hour look-ahead it means something
        // different: a schedule with two start times (Hot Turbo runs 15:00
        // AND 21:00) has both instances due in the same poll, and the later
        // one collides with the earlier one that is still pre-start. Holding
        // the key would burn the 21:00 game for the day. Releasing lets it be
        // retried each poll and spawn the moment the earlier instance starts.
        console.log(
          `[ScheduledTournaments] "${row.name}" already live pre-start - spawn ${spawnKey} deferred`
        );
        await supabase
          .from('tournament_schedule_spawns')
          .delete()
          .eq('spawn_key', spawnKey)
          .is('tournament_id', null);
        return;
      }
      // RELEASE THE CLAIM (2026-08-23). The key is claimed before the
      // insert so two spawners cannot race — but on a FAILED insert it was
      // left claimed, which permanently burns that instance: the next poll
      // sees the key, stands down, and the event simply never happens. Two
      // orphan rows (tournament_id NULL) were sitting in prod from exactly
      // this, one of them the Saturday Speedway 21:30. Deleting the claim
      // hands the slot back to the next poll; if the delete itself fails the
      // old burn-forever behaviour is what remains, which is no worse.
      const { error: releaseErr } = await supabase
        .from('tournament_schedule_spawns')
        .delete()
        .eq('spawn_key', spawnKey)
        .is('tournament_id', null);
      if (releaseErr) {
        reportError(
          new Error(
            `[ScheduledTournaments] could not release burnt spawn key ${spawnKey}: ${releaseErr.message}`
          ),
          'ScheduledTournaments.spawn_release_failed'
        );
      }
      reportError(
        new Error(`[ScheduledTournaments] insert failed for ${spawnKey}: ${msg}`),
        'ScheduledTournaments.insert_failed'
      );
      // THE POP-UP (Dan 2026-08-29): "IF THE BANK DOESN'T HOLD ENOUGH CHIPS A
      // POP UP MUST APPEAR LETTING THE CLUB OR UNION KNOW THEY NEED MORE CHIPS
      // IN THE BANK TO COVER THE GUARANTEE."
      //
      // The guard is a BEFORE INSERT trigger, and a trigger that raises rolls
      // back everything it wrote itself — so the refusal CANNOT write its own
      // notification. This is the other half: on the guard's signature
      // ('cannot guarantee', errcode 55000), write the durable owner-facing
      // notification from a fresh transaction. fn_notify_guarantee_bank_short
      // dedupes on unread per recipient per bank, so a schedule that re-fails
      // every 30s poll produces ONE standing bell notification, not a storm.
      if (/cannot guarantee/i.test(msg) && row.club_id) {
        const { error: notifyErr } = await supabase.rpc('fn_notify_guarantee_bank_short', {
          p_club_id: row.club_id,
        });
        if (notifyErr) {
          reportError(
            new Error(
              `[ScheduledTournaments] guarantee refusal could not notify the owners: ${notifyErr.message}`
            ),
            'ScheduledTournaments.guarantee_notify_failed'
          );
        }
      }
      return;
    }

    const { error: linkErr } = await supabase
      .from('tournament_schedule_spawns')
      .update({ tournament_id: created.id })
      .eq('spawn_key', spawnKey);
    if (linkErr) {
      // The tournament exists and the key is claimed; a missing back-link is
      // an audit gap, not a correctness problem. Report and continue.
      reportError(
        new Error(`[ScheduledTournaments] spawn link failed for ${spawnKey}: ${linkErr.message}`),
        'ScheduledTournaments.spawn_link_failed'
      );
    }

    // Horse seeding — same money-correct path the recurring service uses,
    // but ONLY for an event that is about to start. An event published a day
    // ahead opens empty and stays open: seeding it now would lock horses out
    // of today's games for a tournament that does not begin until tomorrow,
    // and would also present a "full" board to the humans it is meant for.
    // GameServer's past-start top-up fills any short field on the clock.
    const minPlayers = Number(row.min_players) || 3;
    const horsesRaw = Number((cfg as Record<string, unknown>).horsesToRegister);
    const horses =
      Number.isFinite(horsesRaw) && horsesRaw >= 0 ? Math.floor(horsesRaw) : minPlayers;
    const startsWithinMs = startTime.getTime() - Date.now();
    const seedNow = horses > 0 && startsWithinMs <= HORSE_SEED_WITHIN_MS;
    let seeded = 0;
    if (seedNow) {
      seeded = await this.horseSeeder.topUpWithHorses(created.id, horses);
    }

    console.log(
      `[ScheduledTournaments] Spawned "${row.name}" (${spawnKey}) start ${startTime.toISOString()} - ${
        seedNow ? `${seeded} horse(s) seeded` : 'open for registration, horses join at start'
      }`
    );
  }

  /**
   * INSERT the spawn key. UNIQUE(spawn_key) makes this the atomic claim: the
   * loser of any race gets 23505 and stands down. Any OTHER error also stands
   * down (fail closed) — a spawn we cannot prove unclaimed is not ours.
   */
  private async claimSpawn(scheduleId: string, spawnKey: string): Promise<boolean> {
    const { error } = await supabase
      .from('tournament_schedule_spawns')
      .insert({ schedule_id: scheduleId, spawn_key: spawnKey });
    if (!error) return true;
    const msg = error.message ?? '';
    if (error.code === '23505' || /duplicate key|unique constraint/i.test(msg)) return false;
    reportError(
      new Error(`[ScheduledTournaments] spawn claim failed for ${spawnKey}: ${msg}`),
      'ScheduledTournaments.spawn_claim_failed'
    );
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG → ROW
  // ─────────────────────────────────────────────────────────────────────────

  private parseConfig(schedule: TournamentScheduleRow): Record<string, unknown> | null {
    let cfg = schedule.config;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null as unknown as Record<string, unknown>;
      }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      reportError(
        new Error(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} config is not an object - skipping`
        ),
        'ScheduledTournaments.config_invalid'
      );
      return null;
    }
    return cfg as Record<string, unknown>;
  }

  /**
   * Map a schedule config (fn_create_tournament p_config key shapes) onto a
   * tournaments INSERT row, mirroring the column conventions of
   * TournamentRecurringService.createTournament / createSNG / createSpin and
   * fn_create_tournament exactly: variant per type ('mtt'/'freezeout' →
   * 'freezeout'), tournament_type MTT/SNG/SPIN, game_type via GAME_TYPE_MAP,
   * whole-chip buy-in split via buyInFor (spins fee-free, freerolls 0/0).
   *
   * Returns null (and logs) when the config cannot produce a sound tournament.
   */
  private async buildInsertRow(
    schedule: TournamentScheduleRow,
    cfg: Record<string, unknown>,
    startTime: Date
  ): Promise<Record<string, unknown> | null> {
    const rawType = String(cfg.type ?? 'mtt').toLowerCase();
    if (!KNOWN_TYPES.has(rawType)) {
      reportError(
        new Error(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} has unknown type "${rawType}" - skipping`
        ),
        'ScheduledTournaments.unknown_type'
      );
      return null;
    }
    const type = rawType === 'mtt' ? 'freezeout' : rawType;
    const isSpin = type === 'spin';
    const isSng = type === 'sng';
    const isSatellite = type === 'satellite';
    const isBountyType = ['bounty', 'progressive_bounty', 'mystery_bounty'].includes(type);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A SPIN AND A HEADS-UP HAVE NO SCHEDULED TIME (Dan, 2026-09-01, BINDING)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Dan, verbatim: "SPINS AND HEADS UP DO NOT HAVE SCHEDULED TIMES THEY
     * START WHEN 3 PLAYERS HAVE BOUGHT IN AND PAID FOR SPINS, AND WHEN TWO
     * PLAYERS FOR HEADS UP."
     *
     * This is not a preference, it is what the format IS, and this path could
     * not honour it even by accident. Everything it writes is clock-shaped: a
     * TIMED schedule spawns at an `HH:MM` from start_times_utc, an INTERVAL
     * schedule at now + 5 minutes, and the restart clone at ended_at +
     * restart_every_minutes.
     *
     * Worse than wrong, it produced games that could not run. A seat-first
     * game is started by GameServer on paid seats alone -- `shouldStart =
     * isSngOrSpin ? seatFirstReady : maxReached || timeReached` -- and
     * seatFirstReady counts seats on an OPEN SEAT TABLE. Only
     * TournamentRecurringService.createSpin / createSNG create that table.
     * This path never has, so a row it spawned was invisible to the seat-first
     * gate and deliberately excluded from the clock gate: unstartable by both.
     * The live example was "Spin Royale", every 30 minutes, at a 25-chip stake
     * the Spin board does not even offer.
     *
     * The board is the creator for both formats and it runs continuously.
     * There is nothing for a schedule to add.
     */
    const isHeadsUpShape = isSng && clampInt(cfg.maxPlayers, 2, 10000, 0) <= HEADS_UP_SEATS;
    if (isSpin || isHeadsUpShape) {
      if (!this.refusedSeatFirstSchedules.has(schedule.id)) {
        this.refusedSeatFirstSchedules.add(schedule.id);
        reportError(
          new Error(
            `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} asks for a ` +
              `${isSpin ? 'Spin' : 'heads-up'}, which has no scheduled time - it starts when ` +
              `${isSpin ? 'three players have' : 'two players have'} bought in. The board creates ` +
              `these continuously (TournamentRecurringService). Deactivate the schedule row.`
          ),
          'ScheduledTournaments.seat_first_format_refused'
        );
      }
      return null;
    }

    const gameVariant = String(cfg.gameVariant ?? 'nlh').toLowerCase();
    const dbGameType = GAME_TYPE_MAP[gameVariant] || 'NLH';

    // Explicit arrays win; otherwise a named preset resolves them. This keeps
    // schedule rows (and the seed migration) readable instead of embedding
    // full structure arrays in every config blob.
    const blindPreset = SCHEDULE_BLIND_PRESETS[String(cfg.blindPreset ?? '').toUpperCase()];
    const payoutPreset = SCHEDULE_PAYOUT_PRESETS[String(cfg.payoutPreset ?? '').toUpperCase()];
    let blinds =
      Array.isArray(cfg.blindStructure) && cfg.blindStructure.length > 0
        ? cfg.blindStructure
        : (blindPreset ?? []);
    let payouts =
      Array.isArray(cfg.payoutStructure) && cfg.payoutStructure.length > 0
        ? cfg.payoutStructure
        : (payoutPreset ?? []);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A ROW TYPED SPIN IS A SPIN (2026-08-31, Phase 3)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This path let a schedule pick ANY named blind preset for a row it then
     * stamped `tournament_type = 'SPIN'`. One schedule does exactly that --
     * "Spin Royale", active, every 30 minutes -- with `blindPreset:
     * "HYPER_TURBO"`, an MTT ladder that opens at 50/100 with a 15 ante and
     * doubles from there. A Spin's stack is written at DRAW time from
     * SPIN_TIERS, so the draw handed those games a 300-chip stack against a
     * 100 big blind.
     *
     * Measured on production, every completed Spin Royale over three days:
     *
     *     96 of 96 games opened at big blind 100
     *     average starting depth  3.7 big blinds   (a spec spin starts at 15)
     *     average length          12.7 hands       (a spec spin plays 49.8)
     *
     * That is not a fast tournament, it is a coin flip wearing a Spin's name,
     * and it is charged as a Spin, booked against the Spin reserve pool, and
     * paid out on the Spin multiplier table. TournamentManagerBase rewrites a
     * Spin's blinds from spinSpec at start, but only on the draw path -- a row
     * that already carries a multiplier skips it -- so creation writing the
     * wrong ladder is not something a later stage reliably corrects.
     *
     * The format owns its structure. Same ladder, same shape, same 12 rows the
     * one true creation path (TournamentRecurringService.createSpin) writes,
     * so the two creators cannot disagree. A heads-up SNG gets the same
     * treatment from headsUpSpec, for the same reason.
     */
    if (isSpin) {
      const placeholderTier = SPIN_TIERS[0];
      blinds = Array.from({ length: 12 }, (_, i) => {
        const b = spinBlindsForLevel(i + 1);
        return {
          level: i + 1,
          smallBlind: b.small,
          bigBlind: b.big,
          ante: 0,
          duration: placeholderTier.levelMinutes * 60,
        };
      }) as typeof blinds;
      payouts = [{ place: 1, percentage: 100 }] as typeof payouts;
    } else if (isSng && clampInt(cfg.maxPlayers, 2, 10000, 0) <= HEADS_UP_SEATS) {
      blinds = HEADS_UP_BLIND_STRUCTURE as unknown as typeof blinds;
      payouts = HEADS_UP_PAYOUTS as typeof payouts;
    }

    if (blinds.length === 0 || payouts.length === 0) {
      reportError(
        new Error(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} missing blind/payout structure - skipping`
        ),
        'ScheduledTournaments.structure_missing'
      );
      return null;
    }

    /**
     * THE FIELD SIZE IS RESOLVED FIRST, because the price depends on it.
     * It used to be computed four lines BELOW the split that needs it, which
     * is why the rate could only ever be keyed on the format label.
     */
    /* SPIN_SEATS, not a config value: "SPINS ARE ALWAYS 3 HANDED" (Dan
       2026-08-19) and the multiplier maths, the reserve booking and the payout
       shape are all built around exactly three. A duel is two by the same
       argument -- see headsUpSpec. Everything else keeps its configured field. */
    const maxPlayers = isSpin
      ? SPIN_SEATS
      : clampInt(cfg.maxPlayers, 2, 10000, 0) || (isSng ? HEADS_UP_SEATS : 100);
    /**
     * MORE PAID PLACES THAN SEATS (2026-08-31 audit).
     *
     * Non-empty was the only test on this array. This service writes the row
     * DIRECTLY rather than through fn_create_tournament, so it never met that
     * function's `more_paid_places_than_players` guard — the one the modal
     * surfaces as "There are more paid places than players allowed to enter".
     * A schedule row carrying `"maxPlayers": 2` with a five-place preset would
     * have created a two-handed game paying five.
     *
     * Not live today: the only 2-seat seeded schedule uses HEADS_UP. It was a
     * gap in the writer, not an incident.
     *
     * As of the same day `tournaments_creation_guard` refuses this at the
     * DATABASE, so it can no longer reach a row from any of the four writers.
     * This check stays anyway, one layer earlier, because a refusal that
     * arrives as a Postgres error in a background poll names the constraint
     * and not the schedule — and the operator needs to know WHICH schedule is
     * misconfigured. Paying every seat is legal (a Spin pays 3 of 3); paying
     * more places than can enter is not.
     */
    if (payouts.length > maxPlayers) {
      reportError(
        new Error(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} pays ${payouts.length} places on ${maxPlayers} seats - skipping`
        ),
        'ScheduledTournaments.more_paid_places_than_players'
      );
      return null;
    }
    const minPlayers = Math.min(Math.max(clampInt(cfg.minPlayers, 2, 10000, 3), 2), maxPlayers);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  THIS IS THE PATH THAT ACTUALLY CHARGED THE WRONG RAKE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Whole-chip pricing. buyIn is the TOTAL the player pays; 0 stays a freeroll
     * with 0/0 columns, and a spin's fee lives in its multiplier distribution
     * rather than the fee column.
     *
     * Until 2026-08-27 this called `buyInFor(buyIn)` — the 10% default — for
     * every format including a two-seat SNG. Six creation paths computed a
     * heads-up fee, five of them at 10%, and for four of those it was only a
     * misquote: `fn_create_tournament` is authoritative, knows the rule, and
     * rewrote the split before it reached a column.
     *
     * THIS ONE DOES NOT GO THROUGH THE RPC. It builds the row and writes
     * `buy_in_amount` / `buy_in_fee` directly, so any schedule row carrying
     * `type: 'sng'` with two seats produced a REAL 10% heads-up game — twice the
     * rake Dan set, charged to real players, on a recurring schedule. Measured
     * 2026-08-27: 18 heads-up scheduled rows written at 6.67% instead of 5%.
     *
     * rakeRateFor is now the single source of truth for which rate a format
     * pays, and it is keyed on seats rather than on the word "SNG".
     */
    const buyIn = wholeChips(cfg.buyIn);
    const rakeRate = rakeRateFor({
      tournamentType: isSng ? 'SNG' : isSpin ? 'SPIN' : 'MTT',
      variant: type,
      maxPlayers,
    });
    const split = buyIn > 0 ? buyInFor(buyIn, rakeRate) : { total: 0, prize: 0, fee: 0 };
    // rakeRateFor already returns 0 for a Spin, so these two ternaries are now
    // belt and braces rather than the rule. Kept because the whole buy-in
    // reaching buy_in_amount (rather than a snapped `split.prize`) is a Spin
    // invariant the tournaments_spin_no_extra_rake constraint enforces, and it
    // should not depend on a helper somewhere else staying correct.
    const buyInAmount = isSpin ? buyIn : split.prize;
    const buyInFee = isSpin ? 0 : split.fee;

    // Bounty head: absolute bountyAmount wins; else the recurring service's
    // percent-of-total convention (default 30), never exceeding the prize half.
    let bountyAmount = 0;
    if (isBountyType) {
      const absolute = wholeChips(cfg.bountyAmount);
      if (absolute > 0) {
        bountyAmount = Math.min(split.prize, absolute);
      } else {
        const pct = Number(cfg.bountyPercent) || 30;
        bountyAmount = Math.min(split.prize, Math.max(0, Math.round((split.total * pct) / 100)));
      }
      if (bountyAmount <= 0) {
        reportError(
          new Error(
            `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} bounty type with no bounty head - skipping`
          ),
          'ScheduledTournaments.bounty_missing'
        );
        return null;
      }
    }
    // Mystery range: config carries MULTIPLIERS, the columns store MONEY
    // (multiplier x head) — the 2026-08-21 advertised-range convention.
    const mbMinMult =
      Number(cfg.mysteryBountyMin) > 0 ? Number(cfg.mysteryBountyMin) : MYSTERY_MIN_MULT;
    const mbMaxMult =
      Number(cfg.mysteryBountyMax) > 0 ? Number(cfg.mysteryBountyMax) : MYSTERY_MAX_MULT;
    const mysteryMin =
      type === 'mystery_bounty' ? Math.round(bountyAmount * mbMinMult * 100) / 100 : 0;
    const mysteryMax =
      type === 'mystery_bounty' ? Math.round(bountyAmount * mbMaxMult * 100) / 100 : 0;

    // Satellite: resolve the target by name prefix at spawn time. No target =
    // no spawn — never create a broken satellite.
    let satelliteTargetId: string | null = null;
    let satelliteSeats: number | null = null;
    if (isSatellite) {
      const targetName = String(cfg.satelliteTargetName ?? '').trim();
      const target = targetName ? await this.resolveSatelliteTarget(schedule, targetName) : null;
      if (!target) {
        console.log(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)}: no pre-start satellite target matching "${targetName}" - skipping this spawn`
        );
        return null;
      }
      satelliteTargetId = target;
      const seats = clampInt(cfg.satelliteSeats, 1, 10000, 0);
      satelliteSeats = seats > 0 ? seats : null;
    }

    const isRebuy = asBool(cfg.isRebuy) || asBool(cfg.rebuy);
    const addOn = asBool(cfg.addOnAvailable) || asBool(cfg.addOn);
    const lateRegLevels = isSng || isSpin ? 0 : clampInt(cfg.lateRegistrationLevels, 0, 100, 8);

    const restartEveryRaw = Number(cfg.restartEveryMinutes);
    const restartEvery =
      Number.isFinite(restartEveryRaw) && restartEveryRaw >= 5 && restartEveryRaw <= 1440
        ? Math.round(restartEveryRaw)
        : null;

    const maxRebuysRaw = Number(cfg.maxRebuys);
    const maxReentriesRaw = Number(cfg.maxReentries);

    const row: Record<string, unknown> = {
      club_id: schedule.club_id,
      // Union events name the union explicitly at creation, exactly as the
      // recurring service learned to on 2026-08-19.
      union_id: schedule.union_id ?? null,
      is_xmtt: !!schedule.union_id,
      schedule_id: schedule.id,
      name: String(cfg.name ?? schedule.name),
      game_type: dbGameType,
      variant: type,
      tournament_type: isSng ? 'SNG' : isSpin ? 'SPIN' : 'MTT',
      buy_in_amount: buyInAmount,
      buy_in_fee: buyInFee,
      guaranteed_prize: wholeChips(cfg.guaranteedPrize ?? cfg.guarantee),
      starting_chips: clampInt(cfg.startingStack, 1, 100_000_000, 10000),
      max_players: maxPlayers,
      min_players: minPlayers,
      current_players: 0,
      status: 'REGISTERING',
      blind_structure: blinds,
      payout_structure: payouts,
      start_time: startTime.toISOString(),
      late_reg_levels: lateRegLevels,
      late_reg_mins: lateRegLevels,
      is_bounty: isBountyType,
      is_pko: type === 'progressive_bounty',
      is_mystery_bounty: type === 'mystery_bounty',
      bounty_amount: bountyAmount,
      mystery_bounty_min: mysteryMin,
      mystery_bounty_max: mysteryMax,
      // Rebuy / add-on: cost and chips default to the snapped total and the
      // starting stack, matching what process_tournament_rebuy computes.
      is_rebuy: isRebuy,
      is_reentry: isRebuy || asBool(cfg.isReentry),
      rebuy_cost: isRebuy ? wholeChips(cfg.rebuyCost) || split.total : null,
      rebuy_chips: isRebuy
        ? clampInt(cfg.rebuyChips, 1, 100_000_000, 0) ||
          clampInt(cfg.startingStack, 1, 100_000_000, 10000)
        : null,
      rebuy_levels: isRebuy ? clampInt(cfg.rebuyLevels, 1, 100, 6) : null,
      add_on_available: addOn,
      addon_cost: addOn ? wholeChips(cfg.addOnCost) || split.total : null,
      addon_chips: addOn
        ? clampInt(cfg.addOnChips, 1, 100_000_000, 0) ||
          clampInt(cfg.startingStack, 1, 100_000_000, 10000)
        : null,
      addon_levels: addOn ? clampInt(cfg.addOnLevels, 1, 100, 1) : null,
      satellite_target_id: satelliteTargetId,
      satellite_seats: satelliteSeats,
      // ── Parity columns (2026-08-22), clamped like fn_create_tournament ──
      short_description: String(cfg.shortDescription ?? '').trim() || null,
      is_vip_only: asBool(cfg.isVipOnly),
      ban_chat: asBool(cfg.banChat),
      all_in_or_fold: asBool(cfg.allInOrFold),
      label_as_new: asBool(cfg.labelAsNew),
      hide_club_name: asBool(cfg.hideClubName),
      action_time_seconds: clampInt(cfg.actionTimeSeconds, 5, 60, 15),
      /**
       * 2026-08-27: the default was a flat 9, which is right for an MTT and
       * wrong for every game that fits at ONE table. A two-seat SNG scheduled
       * here was written claiming nine seats, and TournamentBrainContext then
       * resolved it to 'mtt' — the horses played a duel with ICM and bubble
       * ranges. A single-table format defaults to its own field size; an MTT is
       * unchanged.
       */
      table_size: clampInt(
        cfg.tableSize,
        2,
        10,
        isSng || isSpin ? Math.min(10, Math.max(2, maxPlayers)) : 9
      ),
      accelerated_mtt: asBool(cfg.acceleratedMtt),
      addon_break_minutes: clampInt(cfg.addonBreakMinutes, 1, 10, 1),
      big_blind_ante: asBool(cfg.bigBlindAnte),
      authorized_to_register: asBool(cfg.authorizedToRegister),
      early_bird_enabled: asBool(cfg.earlyBirdEnabled),
      early_bird_chips: Math.max(0, clampInt(cfg.earlyBirdChips, 0, 100_000_000, 0)),
      bubble_protection: asBool(cfg.bubbleProtection),
      final_table_deal_enabled: asBool(cfg.finalTableDealEnabled),
      restart_every_minutes: restartEvery,
      /**
       * A SHORT FORMAT NEVER TAKES THE :55 BREAK (2026-08-31, Phase 3).
       *
       * Three places had an opinion and only one was consulted: the seed rows
       * said `true`, the docs said heads-up takes the break, and the ENGINE
       * refuses it on format (`breakEligibility.ts` -- a Spin or a duel is
       * never eligible, whatever the column says). The engine is right; the row
       * was drift. Written honestly now so a reader of the row and a reader of
       * the code reach the same conclusion. See headsUpSpec
       * HEADS_UP_SYNCHRONIZED_BREAKS.
       */
      synchronized_breaks:
        isSpin || isSng
          ? false
          : cfg.synchronizedBreaks === undefined
            ? true
            : asBool(cfg.synchronizedBreaks),
      max_rebuys: Number.isFinite(maxRebuysRaw) ? Math.max(0, Math.round(maxRebuysRaw)) : null,
      max_reentries: Number.isFinite(maxReentriesRaw)
        ? Math.max(0, Math.round(maxReentriesRaw))
        : null,
      is_pinned: asBool(cfg.isFeatured),
    };

    if (isSpin) {
      // Spin rows mirror createSpin: the draw happens at start in
      // TournamentManagerBase, so the row is honest about not knowing yet.
      row.spin_multiplier = null;
      row.spin_locked_tiers = null;
      row.max_players = 3;
      row.min_players = 3;
      // Forced with the seat count it forces: a Spin is 3-handed by definition,
      // so a table_size carried in from cfg cannot be allowed to disagree.
      row.table_size = 3;
    }

    return row;
  }

  /**
   * The nearest pre-start tournament in the schedule's club/union whose name
   * starts with the configured prefix. Union schedules search the union's
   * events; club schedules search the club's.
   */
  private async resolveSatelliteTarget(
    schedule: TournamentScheduleRow,
    namePrefix: string
  ): Promise<string | null> {
    let query = supabase
      .from('tournaments')
      .select('id, name, start_time')
      .in('status', ['ANNOUNCED', 'REGISTERING'])
      .gt('start_time', new Date().toISOString())
      .ilike('name', `${namePrefix.replace(/[%_]/g, '')}%`)
      .order('start_time', { ascending: true })
      .limit(1);
    query = schedule.union_id
      ? query.eq('union_id', schedule.union_id)
      : query.eq('club_id', schedule.club_id);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    return data.id as string;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESTART-EVERY — clone completed manual tournaments that asked to repeat
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Columns copied verbatim from the completed instance onto its clone. This
   * is the full config surface of a tournaments row — everything except
   * lifecycle state (status, players, prize pool, timestamps, break flags).
   */
  private static readonly RESTART_COPY_COLUMNS = [
    'club_id',
    'union_id',
    'is_xmtt',
    'name',
    'game_type',
    'variant',
    'tournament_type',
    'buy_in_amount',
    'buy_in_fee',
    'starting_chips',
    'max_players',
    'min_players',
    'blind_structure',
    'payout_structure',
    'guaranteed_prize',
    'late_reg_levels',
    'late_reg_mins',
    'rebuy_levels',
    'is_rebuy',
    'is_reentry',
    'rebuy_cost',
    'rebuy_chips',
    'add_on_available',
    'addon_cost',
    'addon_chips',
    'addon_levels',
    'is_bounty',
    'bounty_amount',
    'is_pko',
    'is_mystery_bounty',
    'mystery_bounty_min',
    'mystery_bounty_max',
    'spin_type',
    'satellite_target_id',
    'satellite_seats',
    'is_private',
    'short_description',
    'is_vip_only',
    'ban_chat',
    'all_in_or_fold',
    'label_as_new',
    'hide_club_name',
    'action_time_seconds',
    'table_size',
    'accelerated_mtt',
    'addon_break_minutes',
    'big_blind_ante',
    'authorized_to_register',
    'early_bird_enabled',
    'early_bird_chips',
    'bubble_protection',
    'final_table_deal_enabled',
    'restart_every_minutes',
    'synchronized_breaks',
    'max_rebuys',
    'max_reentries',
    'is_multi_day',
    'total_days',
    'is_pinned',
  ] as const;

  private async processRestartEvery(): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: candidates, error } = await supabase
      .from('tournaments')
      .select('*')
      .not('restart_every_minutes', 'is', null)
      .eq('status', 'COMPLETED')
      .is('schedule_id', null)
      .gte('ended_at', since);
    if (error || !candidates) return; // fail closed

    for (const old of candidates as Array<Record<string, unknown>>) {
      try {
        await this.maybeRestartTournament(old);
      } catch (err: unknown) {
        reportError(
          new Error(
            `[ScheduledTournaments] restart of ${String(old.id).slice(0, 8)} failed: ${(err as Error)?.message ?? err}`
          ),
          'ScheduledTournaments.restart_failed'
        );
      }
    }
  }

  private async maybeRestartTournament(old: Record<string, unknown>): Promise<void> {
    if (!old.ended_at || !old.club_id || !old.name) return;

    /**
     * A SEAT-FIRST FORMAT IS NEVER RESTARTED ON A CLOCK (Dan, 2026-09-01).
     *
     * This clone writes `start_time = max(now + 2min, ended_at +
     * restart_every_minutes)`, which is a scheduled time by construction, and
     * it copies the row's columns without ever creating the open-seat table
     * the seat-first start gate counts. A cloned Spin or heads-up is therefore
     * a game that cannot start: invisible to the seat gate, excluded from the
     * clock gate. The board already replaces both continuously the moment one
     * finishes, which is what "restart" was reaching for.
     */
    const clonedVariant = String(old.variant ?? '').toLowerCase();
    const clonedSeats = Number(old.max_players ?? 0);
    if (clonedVariant === 'spin' || (clonedSeats > 0 && clonedSeats <= HEADS_UP_SEATS)) return;

    const endedAt = new Date(String(old.ended_at));

    // Never while a same-named event is live in the same club.
    const { count: liveCount, error: liveErr } = await supabase
      .from('tournaments')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', old.club_id)
      .eq('name', old.name)
      .in('status', ['ANNOUNCED', ...LIVE_STATUSES]);
    if (liveErr || liveCount === null || liveCount === undefined || liveCount > 0) return;

    // DEDUPE `restart:${old.id}` — tournament_schedule_spawns.schedule_id is
    // NOT NULL and these are schedule-less manual events, so the claim cannot
    // live there. The equivalent invariant, enforced against the tournaments
    // table itself: this instance has been restarted iff a same-club,
    // same-name tournament was created AFTER it ended. The clone always
    // satisfies that, so each completed instance is cloned at most once.
    const { count: cloneCount, error: cloneErr } = await supabase
      .from('tournaments')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', old.club_id)
      .eq('name', old.name)
      .gt('created_at', String(old.ended_at));
    if (cloneErr || cloneCount === null || cloneCount === undefined || cloneCount > 0) return;

    const restartMinutes = Number(old.restart_every_minutes) || 0;
    const startTime = new Date(
      Math.max(Date.now() + 2 * 60 * 1000, endedAt.getTime() + restartMinutes * 60 * 1000)
    );

    const row: Record<string, unknown> = {
      current_players: 0,
      status: 'REGISTERING',
      start_time: startTime.toISOString(),
      schedule_id: null,
    };
    for (const col of ScheduledTournamentService.RESTART_COPY_COLUMNS) {
      if (old[col] !== undefined) row[col] = old[col];
    }

    // A legacy instance can carry a pre-floor fee split (e.g. 22+3 = 12%)
    // that tournaments_rake_within_10_pct now rejects on INSERT — the clone
    // would fail on every poll for 24 hours. Re-cut the fee from the same
    // player-paid total (floor 10%, splitBuyIn's arithmetic without the
    // ladder snap — a manual event keeps its price). Compliant splits,
    // including every spin's fee-free 0, pass through untouched.
    //
    // CENTS FIX 2026-08-26: this block used to floor the cap to WHOLE chips
    // (Math.floor((amt+fee)*0.1)), so a restarted 1-chip game saw its 0.10
    // fee "exceed" a cap of 0 and had the fee silently folded into the prize
    // — undoing Dan's 2026-08-25 fractional-fee rule on every restart of the
    // micro rungs. The cap now floors to CENTS, same as feeToCents, and the
    // player-paid total is preserved to the cent (a legacy 19.80 stays 19.80
    // — clampRakeToCap is NOT used here because it whole-rounds the total).
    {
      /**
       * THE CAP IS THE FORMAT'S OWN RATE (2026-08-31, Phase 3).
       *
       * This floored at a flat 0.1 -- the DB constraint's number, which covers
       * every shape at once. A two-seat game pays 5% (headsUpSpec), so a
       * legacy heads-up row carrying a 10% split was re-cut to... 10%, and the
       * clone was written at twice the rake Dan set. The row's own seats decide
       * the rate here exactly as they do at creation, through the one helper
       * that knows the rule.
       */
      const amt = Number(row.buy_in_amount) || 0;
      const fee = Number(row.buy_in_fee) || 0;
      const total = Math.round((amt + fee) * 100) / 100;
      const cloneRate = rakeRateFor({
        tournamentType: String(row.tournament_type ?? ''),
        variant: String(row.variant ?? ''),
        maxPlayers: Number(row.max_players) || 0,
      });
      const cap = Math.floor(total * cloneRate * 100 + 1e-9) / 100;
      if (fee > cap) {
        row.buy_in_amount = Math.round((total - cap) * 100) / 100;
        row.buy_in_fee = cap;
      }
    }

    const { data: created, error: insertErr } = await supabase
      .from('tournaments')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (insertErr || !created) {
      const msg = insertErr?.message ?? 'unknown';
      if (insertErr?.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
        return; // concurrent restart won the race — the clone exists
      }
      reportError(
        new Error(
          `[ScheduledTournaments] restart insert failed for ${String(old.id).slice(0, 8)}: ${msg}`
        ),
        'ScheduledTournaments.restart_insert_failed'
      );
      // Same pop-up rule as the scheduled spawn path: a guarantee refusal must
      // reach the owners, and the raising trigger cannot write it itself.
      if (/cannot guarantee/i.test(msg) && (row as { club_id?: string }).club_id) {
        const { error: notifyErr } = await supabase.rpc('fn_notify_guarantee_bank_short', {
          p_club_id: (row as { club_id?: string }).club_id,
        });
        if (notifyErr) {
          reportError(
            new Error(`restart guarantee refusal could not notify: ${notifyErr.message}`),
            'ScheduledTournaments.guarantee_notify_failed'
          );
        }
      }
      return;
    }

    // No horse seeding here: restart clones are manual club events, and
    // GameServer's past-start top-up fills any short field once the clock hits.
    console.log(
      `[ScheduledTournaments] Restarted "${old.name}" as ${String(created.id).slice(0, 8)} - start ${startTime.toISOString()} (restart:${String(old.id).slice(0, 8)})`
    );
  }
}
