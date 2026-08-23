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
import { buyInFor, wholeChips } from '../config/buyIn.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';

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
/** How far ahead of `now` an instance is created so it appears in the lobby. */
export const TIMED_WINDOW_AHEAD_MS = 30 * 60 * 1000;

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
export const SCHEDULE_BLIND_PRESETS: Record<string, Array<Record<string, number>>> = {
  SLOW: [
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 12 },
    { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 12 },
    { level: 3, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 12 },
    { level: 4, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 12 },
    { level: 5, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 10 },
    { level: 6, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 10 },
    { level: 7, smallBlind: 250, bigBlind: 500, ante: 50, durationMinutes: 10 },
    { level: 8, smallBlind: 300, bigBlind: 600, ante: 60, durationMinutes: 10 },
    { level: 9, smallBlind: 400, bigBlind: 800, ante: 80, durationMinutes: 8 },
    { level: 10, smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 8 },
    { level: 11, smallBlind: 600, bigBlind: 1200, ante: 120, durationMinutes: 8 },
    { level: 12, smallBlind: 800, bigBlind: 1600, ante: 160, durationMinutes: 8 },
  ],
  STANDARD: [
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
    { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
    { level: 3, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 10 },
    { level: 4, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 8 },
    { level: 5, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 8 },
    { level: 6, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 8 },
    { level: 7, smallBlind: 300, bigBlind: 600, ante: 60, durationMinutes: 6 },
    { level: 8, smallBlind: 400, bigBlind: 800, ante: 80, durationMinutes: 6 },
    { level: 9, smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 5 },
    { level: 10, smallBlind: 750, bigBlind: 1500, ante: 150, durationMinutes: 5 },
  ],
  TURBO: [
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 4 },
    { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 4 },
    { level: 3, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 3 },
    { level: 4, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 3 },
    { level: 5, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 3 },
    { level: 6, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 2 },
    { level: 7, smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 2 },
    { level: 8, smallBlind: 750, bigBlind: 1500, ante: 150, durationMinutes: 2 },
  ],
  HYPER_TURBO: [
    { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 2 },
    { level: 2, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 2 },
    { level: 3, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 2 },
    { level: 4, smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 1 },
    { level: 5, smallBlind: 800, bigBlind: 1600, ante: 200, durationMinutes: 1 },
  ],
};
SCHEDULE_BLIND_PRESETS.DEEP = SCHEDULE_BLIND_PRESETS.SLOW;

/** Named payout presets, resolvable as `payoutPreset`. */
export const SCHEDULE_PAYOUT_PRESETS: Record<string, Array<{ place: number; percentage: number }>> = {
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

  start(): void {
    if (this.isRunning) {
      console.log('[ScheduledTournaments] Already running');
      return;
    }
    this.isRunning = true;
    console.log('[ScheduledTournaments] Service started — polling every 60s');
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
    // Optional per-schedule look-ahead (minutes, 30 min .. 7 days). Flagship
    // events set this to several days so they exist in the lobby early and
    // satellite schedules can resolve them by name all week.
    const aheadRaw = Number(cfg.spawnAheadMinutes);
    const aheadMs =
      Number.isFinite(aheadRaw) && aheadRaw >= 30 && aheadRaw <= 10_080
        ? Math.round(aheadRaw) * 60_000
        : TIMED_WINDOW_AHEAD_MS;
    const due = timedSpawnsDue(schedule, new Date(), aheadMs);
    for (const spawn of due) {
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
        // uq_scheduled_tournament_one_live_per_name: a same-named pre-start MTT
        // already exists. Benign — the event the schedule wanted is on the
        // board. The claimed spawn key stands, which is the dedupe working.
        console.log(
          `[ScheduledTournaments] "${row.name}" already live pre-start — spawn ${spawnKey} skipped`
        );
        return;
      }
      reportError(
        new Error(`[ScheduledTournaments] insert failed for ${spawnKey}: ${msg}`),
        'ScheduledTournaments.insert_failed'
      );
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

    // Horse seeding — same money-correct path the recurring service uses.
    const minPlayers = Number(row.min_players) || 3;
    const horsesRaw = Number((cfg as Record<string, unknown>).horsesToRegister);
    const horses =
      Number.isFinite(horsesRaw) && horsesRaw >= 0 ? Math.floor(horsesRaw) : minPlayers;
    let seeded = 0;
    if (horses > 0) {
      seeded = await this.horseSeeder.topUpWithHorses(created.id, horses);
    }

    console.log(
      `[ScheduledTournaments] Spawned "${row.name}" (${spawnKey}) start ${startTime.toISOString()} — ${seeded} horse(s) seeded`
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
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} config is not an object — skipping`
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
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} has unknown type "${rawType}" — skipping`
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

    const gameVariant = String(cfg.gameVariant ?? 'nlh').toLowerCase();
    const dbGameType = GAME_TYPE_MAP[gameVariant] || 'NLH';

    // Explicit arrays win; otherwise a named preset resolves them. This keeps
    // schedule rows (and the seed migration) readable instead of embedding
    // full structure arrays in every config blob.
    const blindPreset = SCHEDULE_BLIND_PRESETS[String(cfg.blindPreset ?? '').toUpperCase()];
    const payoutPreset = SCHEDULE_PAYOUT_PRESETS[String(cfg.payoutPreset ?? '').toUpperCase()];
    const blinds = Array.isArray(cfg.blindStructure) && cfg.blindStructure.length > 0
      ? cfg.blindStructure
      : blindPreset ?? [];
    const payouts = Array.isArray(cfg.payoutStructure) && cfg.payoutStructure.length > 0
      ? cfg.payoutStructure
      : payoutPreset ?? [];
    if (blinds.length === 0 || payouts.length === 0) {
      reportError(
        new Error(
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} missing blind/payout structure — skipping`
        ),
        'ScheduledTournaments.structure_missing'
      );
      return null;
    }

    // Whole-chip pricing. buyIn is the TOTAL the player pays; 0 stays a
    // freeroll with 0/0 columns, and a spin's fee lives in its multiplier
    // distribution rather than the fee column.
    const buyIn = wholeChips(cfg.buyIn);
    const split = buyIn > 0 ? buyInFor(buyIn) : { total: 0, prize: 0, fee: 0 };
    const buyInAmount = isSpin ? buyIn : split.prize;
    const buyInFee = isSpin ? 0 : split.fee;

    const maxPlayers =
      clampInt(cfg.maxPlayers, 2, 10000, 0) || (isSpin ? 3 : isSng ? 6 : 100);
    const minPlayers = Math.min(
      Math.max(clampInt(cfg.minPlayers, 2, 10000, 3), 2),
      maxPlayers
    );

    // Bounty head: absolute bountyAmount wins; else the recurring service's
    // percent-of-total convention (default 30), never exceeding the prize half.
    let bountyAmount = 0;
    if (isBountyType) {
      const absolute = wholeChips(cfg.bountyAmount);
      if (absolute > 0) {
        bountyAmount = Math.min(split.prize, absolute);
      } else {
        const pct = Number(cfg.bountyPercent) || 30;
        bountyAmount = Math.min(
          split.prize,
          Math.max(0, Math.round((split.total * pct) / 100))
        );
      }
      if (bountyAmount <= 0) {
        reportError(
          new Error(
            `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)} bounty type with no bounty head — skipping`
          ),
          'ScheduledTournaments.bounty_missing'
        );
        return null;
      }
    }
    // Mystery range: config carries MULTIPLIERS, the columns store MONEY
    // (multiplier x head) — the 2026-08-21 advertised-range convention.
    const mbMinMult = Number(cfg.mysteryBountyMin) > 0 ? Number(cfg.mysteryBountyMin) : MYSTERY_MIN_MULT;
    const mbMaxMult = Number(cfg.mysteryBountyMax) > 0 ? Number(cfg.mysteryBountyMax) : MYSTERY_MAX_MULT;
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
          `[ScheduledTournaments] schedule ${schedule.id.slice(0, 8)}: no pre-start satellite target matching "${targetName}" — skipping this spawn`
        );
        return null;
      }
      satelliteTargetId = target;
      const seats = clampInt(cfg.satelliteSeats, 1, 10000, 0);
      satelliteSeats = seats > 0 ? seats : null;
    }

    const isRebuy = asBool(cfg.isRebuy) || asBool(cfg.rebuy);
    const addOn = asBool(cfg.addOnAvailable) || asBool(cfg.addOn);
    const lateRegLevels =
      isSng || isSpin ? 0 : clampInt(cfg.lateRegistrationLevels, 0, 100, 8);

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
      table_size: clampInt(cfg.tableSize, 2, 10, 9),
      accelerated_mtt: asBool(cfg.acceleratedMtt),
      addon_break_minutes: clampInt(cfg.addonBreakMinutes, 1, 10, 1),
      big_blind_ante: asBool(cfg.bigBlindAnte),
      authorized_to_register: asBool(cfg.authorizedToRegister),
      early_bird_enabled: asBool(cfg.earlyBirdEnabled),
      early_bird_chips: Math.max(0, clampInt(cfg.earlyBirdChips, 0, 100_000_000, 0)),
      bubble_protection: asBool(cfg.bubbleProtection),
      final_table_deal_enabled: asBool(cfg.finalTableDealEnabled),
      restart_every_minutes: restartEvery,
      synchronized_breaks: cfg.synchronizedBreaks === undefined ? true : asBool(cfg.synchronizedBreaks),
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
    {
      const amt = Number(row.buy_in_amount) || 0;
      const fee = Number(row.buy_in_fee) || 0;
      const cap = Math.floor((amt + fee) * 0.1 + 1e-9);
      if (fee > cap) {
        row.buy_in_amount = amt + fee - cap;
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
      return;
    }

    // No horse seeding here: restart clones are manual club events, and
    // GameServer's past-start top-up fills any short field once the clock hits.
    console.log(
      `[ScheduledTournaments] Restarted "${old.name}" as ${String(created.id).slice(0, 8)} — start ${startTime.toISOString()} (restart:${String(old.id).slice(0, 8)})`
    );
  }
}
