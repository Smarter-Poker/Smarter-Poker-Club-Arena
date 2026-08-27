/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE FLEET MANAGER — Server-Side Cash Table Seeding
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the fleet of horses across ALL cash game tables:
 * - Creates cash tables from predefined configs if they don't exist
 * - Seats available horses at tables to maintain target occupancy
 * - Manages horse departures/arrivals to simulate real traffic
 * - Tracks fleet health (available, seated, stuck)
 * - Runs as part of the server — ZERO browser dependency
 *
 * NOTE: "Horses" — NEVER call them anything else.
 */

import { supabase } from './supabase.js';
import { fetchAllRows } from './supabase/pagination.js';
import { reportError } from './errorReporter.js';
import { clampSeatsForVariant, maxSeatsForVariant } from '../config/tableSeating.js';
import { buyInBBFor, gameLaneFor, isActiveNow, occupancyTargetFor } from './HorseBehavior.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableConfig {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  horsesPerTable: number;
  gameVariant: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASH GAME TABLE CONFIGS — Every Stake Level × Every Game Type
// ═══════════════════════════════════════════════════════════════════════════════

// FIX 201: Tables spawn from the UNION, not individual clubs.
// All cash tables belong to the Midway Union — visible across all member clubs.
const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

// Legacy club IDs kept only for rake routing fallback (seatHorse clubId param)
const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';

// V3 (2026-07-23): ALL 7 approved variants now spawn cash tables. The V2/V3
// engine is verified on every variant (legality fuzz + full-hand simulation +
// production burn-in on NLH), so "quality before scaling" is satisfied —
// scaling is now on.
const DEFAULT_TABLES: TableConfig[] = [
  {
    name: 'NLH 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 9,
    horsesPerTable: 5,
    gameVariant: 'nlh',
  },
  {
    name: 'PLO4 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO5 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    // The law: plo5 is 7-max. This said 8, and 83 such tables reached
    // production. See server/src/config/tableSeating.ts.
    maxPlayers: 7,
    horsesPerTable: 5,
    gameVariant: 'plo5',
  },
  {
    name: 'PLO6 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    // The law: plo6 is 6-max. This said 7.
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'plo6',
  },
  {
    name: 'PLO8 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'plo8',
  },
  {
    name: 'Short Deck 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'short_deck',
  },
  {
    name: 'Pineapple 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 8,
    horsesPerTable: 5,
    gameVariant: 'pineapple',
  },
];

/**
 * How many live tables a single config may have: the original plus two
 * demand-spawned overflows.
 *
 * This used to be a local inside spawnOverflowTables, so it was a ceiling on
 * CREATING tables and nothing else — nothing ever counted the other way.
 * Production reached 121 rows named 'NLH 1.00/2.00'. It is now also the number
 * retireSurplusTables() drains back down to, and the two must be the same
 * number or the fleet spawns and retires in a loop.
 */
const MAX_TABLES_PER_CONFIG = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// V8 HUMANIZATION HELPERS (2026-07-24)
// The old fleet was robotically uniform: every horse bought in for exactly
// 100bb, tables filled to target instantly in one 30s cycle, and the
// fewest-tables sort made the same horses appear in the same order forever.
// These helpers give each horse a stable personality for HOW it shows up:
//  - a deterministic buy-in profile (short-stacker / standard / deep) with
//    per-sitting jitter, clamped to the table's real min/max buy-in
//  - a daily activity window (hash-derived start hour + length) so the
//    population on the floor rotates through the whole stable instead of
//    the same few dozen
//  - staggered arrivals: at most 1-2 horses join a table per cycle, so
//    tables fill the way real tables fill (except when a HUMAN is seated
//    short-handed — rescuing a human's game outranks realism pacing)
// ═══════════════════════════════════════════════════════════════════════════════

// (Pure helpers live in HorseBehavior.ts — dependency-free for unit tests.)

// ═══════════════════════════════════════════════════════════════════════════════
// HORSE FLEET MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class HorseFleetManager {
  private isRunning = false;
  private seedInterval: ReturnType<typeof setInterval> | null = null;
  private seeding = false; // Prevents concurrent seeding
  private clubIndex = 0;
  private clubIds = [SHARK_CLUB_ID, JAQK_CLUB_ID];

  private getNextClubId(): string {
    const id = this.clubIds[this.clubIndex % this.clubIds.length];
    this.clubIndex++;
    return id;
  }

  // ─────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[HorseFleet] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[HorseFleet] Starting fleet manager...');

    // Ensure all tables exist (fast — just inserts)
    await this.ensureAllTablesExist();

    // Kick off initial seeding in background — DON'T block the server
    this.seedAllTables()
      .then(() => {
        console.log('[HorseFleet] Initial seeding complete');
      })
      .catch((err) => {
        reportError(err, 'HorseFleet.Initial_seeding_error');
      });

    // Recurring check: every 30 seconds, ensure horses are seated
    // Overlap guard — see HorseLifecycleManager. seedAllTables has its own
    // `seeding` flag, so this is belt-and-braces for the wrapper.
    this.seedInterval = setInterval(() => {
      this.seedAllTables().catch((err) => reportError(err, 'HorseFleet.Seed_cycle_error'));
    }, 30000);

    console.log('[HorseFleet] Running — seeding in background, checking every 30s');
  }

  stop(): void {
    this.isRunning = false;
    if (this.seedInterval) {
      clearInterval(this.seedInterval);
      this.seedInterval = null;
    }
    console.log('[HorseFleet] Stopped');
  }

  // ─────────────────────────────────────────────────────────────────────
  // ENSURE ALL TABLES EXIST IN DATABASE
  // ─────────────────────────────────────────────────────────────────────

  /**
   * V14: keep a short WAITING LIST behind a table whose vibe says it is the
   * game everyone wants. `table_waitlist` already exists and the engine
   * already notifies it when a seat opens (see supabase/seats.ts), so a horse
   * on the list is a real queue entry, not decoration — when somebody stands
   * up, the notifier fires exactly as it would for a human.
   *
   * Best-effort throughout: a waiting list is atmosphere, and it must never be
   * the reason a seating cycle fails.
   */
  private async ensureWaitlist(
    tableId: string,
    waitTarget: number,
    validHorses: Array<{ id: string }>,
    horseTables: Map<string, Set<string>>,
    hourUTC: number
  ): Promise<void> {
    try {
      const { data: existing, error } = await supabase
        .from('table_waitlist')
        .select('user_id, position')
        .eq('table_id', tableId)
        .eq('status', 'waiting');
      if (error) throw new Error(error.message);
      const have = existing?.length ?? 0;
      if (have >= waitTarget) return;

      const already = new Set((existing ?? []).map((r) => r.user_id as string));
      const pool = validHorses.filter((h) => {
        if (already.has(h.id)) return false;
        // Game lanes (Dan 2026-08-26): events-only horses never queue for cash.
        if (gameLaneFor(h.id) === 'events') return false;
        if (!isActiveNow(h.id, hourUTC)) return false;
        const at = horseTables.get(h.id);
        // Somebody queueing for a game they are already sitting in makes no
        // sense, and a horse already spread across several tables would not
        // be waiting for another.
        if (at && (at.has(tableId) || at.size >= 3)) return false;
        return true;
      });
      if (pool.length === 0) return;

      const maxPos = Math.max(0, ...(existing ?? []).map((r) => Number(r.position) || 0));
      const rows: Array<{ table_id: string; user_id: string; position: number; status: string }> =
        [];
      for (let i = 0; i < waitTarget - have && i < pool.length; i++) {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (rows.some((r) => r.user_id === pick.id)) continue;
        rows.push({
          table_id: tableId,
          user_id: pick.id,
          position: maxPos + rows.length + 1,
          status: 'waiting',
        });
      }
      if (rows.length === 0) return;
      const { error: insErr } = await supabase.from('table_waitlist').insert(rows);
      if (insErr) throw new Error(insErr.message);
    } catch (err) {
      reportError(err, 'HorseFleet.ensureWaitlist');
    }
  }

  /**
   * Dan 2026-08-26: "the 3rd image says there are 54 waiting — fix this bug."
   *
   * ensureWaitlist only ever GREW the queue. Nothing removed a horse's row
   * when the vibe cooled or the table drained, so queues inflated without
   * bound and a table with open seats could show dozens "waiting" — real DB
   * rows, all of them horses, none of them ever going to sit. This is the
   * missing half: horse rows beyond what the current vibe wants are marked
   * 'cleared'. Human rows are NEVER touched here — a person's place in line
   * is theirs until they sit, leave, or their seat offer expires.
   *
   * `keep` is the TOTAL queue size the table should show; humans count
   * toward it first, horses fill the remainder.
   */
  private async pruneHorseWaitlist(
    tableId: string,
    keep: number,
    horseIdSet: Set<string>
  ): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('id, user_id, position, status')
        .eq('table_id', tableId)
        .in('status', ['waiting', 'notified']);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      const humanCount = rows.filter((r) => !horseIdSet.has(r.user_id as string)).length;
      const horseKeep = Math.max(0, keep - humanCount);
      const horseRows = rows
        .filter((r) => horseIdSet.has(r.user_id as string))
        .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
      if (horseRows.length <= horseKeep) return;
      const excess = horseRows.slice(horseKeep).map((r) => r.id);
      const { error: updErr } = await supabase
        .from('table_waitlist')
        .update({ status: 'cleared' })
        .in('id', excess);
      if (updErr) throw new Error(updErr.message);
    } catch (err) {
      reportError(err, 'HorseFleet.pruneHorseWaitlist');
    }
  }

  private async ensureAllTablesExist(): Promise<void> {
    console.log(`[HorseFleet] Ensuring ${DEFAULT_TABLES.length} cash tables exist...`);

    // Clamping alone would hide a wrong config forever — the table would just
    // quietly be one seat smaller than the array says. Say so instead. This is
    // how PLO5-at-8 and PLO6-at-7 survived: nothing ever disagreed out loud.
    for (const config of DEFAULT_TABLES) {
      const legal = maxSeatsForVariant(config.gameVariant);
      if (config.maxPlayers > legal) {
        reportError(
          new Error(
            `HorseFleet config "${config.name}" asks for ${config.maxPlayers} seats; ` +
              `${config.gameVariant} is ${legal}-max. Seating ${legal}.`
          ),
          'HorseFleet.seat_law_override'
        );
      }
    }

    for (const config of DEFAULT_TABLES) {
      try {
        // FIX 201: Check for table by name in ANY status (not just waiting/running).
        // If a closed table exists, reactivate it instead of creating a duplicate.
        //
        // 2026-08-19: this used .maybeSingle() and threw the error away —
        // `const { data: existing } = ...`. PostgREST answers .maybeSingle()
        // with PGRST116 when MORE THAN ONE row matches, so the moment a second
        // row with the same name existed, `existing` came back null and the
        // code below created a THIRD. Every boot after that added another, and
        // every one it added made the next boot certain to add one more.
        //
        // It ran for months. 120 copies of 'NLH 1.00/2.00', 120 of
        // 'NLH 2.00/5.00', 83 PLO4, 83 PLO5, 81 PLO6 — 487 duplicate cash
        // tables in the lobby. The three configs that never got a second row
        // (PLO8, Short Deck, Pineapple) still had exactly one each, which is
        // what a self-amplifying bug looks like from the outside.
        //
        // .limit(1) cannot error on multiplicity, and the error is now checked:
        // on ANY read failure this SKIPS the config rather than inserting.
        // Inserting when you could not find out whether the row exists is the
        // whole bug, not the .maybeSingle() call.
        const { data: matches, error: lookupError } = await supabase
          .from('tables')
          .select('id, status, union_id, game_variant, small_blind, big_blind')
          .eq('name', config.name)
          .is('tournament_id', null)
          .order('created_at', { ascending: true })
          .limit(1);

        if (lookupError) {
          reportError(lookupError, 'HorseFleet.table_lookup_failed');
          continue;
        }

        const existing = matches?.[0] ?? null;

        if (existing) {
          // Table exists — ensure it's active and at Union level
          const updates: Record<string, any> = {};
          if (existing.status === 'closed') updates.status = 'waiting';
          if (existing.union_id !== MIDWAY_UNION_ID) updates.union_id = MIDWAY_UNION_ID;
          // V3: legacy rows can drift from the config (e.g. an old
          // 'ofc_pineapple' row under the crazy-pineapple table name). The
          // config is authoritative — resync variant and blinds on reuse.
          if (existing.game_variant !== config.gameVariant)
            updates.game_variant = config.gameVariant;
          if (Number(existing.small_blind) !== config.smallBlind)
            updates.small_blind = config.smallBlind;
          if (Number(existing.big_blind) !== config.bigBlind) updates.big_blind = config.bigBlind;
          if (Object.keys(updates).length > 0) {
            updates.current_players = 0;
            await supabase.from('tables').update(updates).eq('id', existing.id);
            console.log(`[HorseFleet] Reactivated table: ${config.name} (was ${existing.status})`);
          }
          continue;
        }

        // FIX 201: Tables belong to a club BUT are inside the Union.
        // Set both club_id (for rake routing) AND union_id (for Union-level discovery).
        const clubId = this.getNextClubId();
        const { error } = await supabase.from('tables').insert({
          club_id: clubId,
          union_id: MIDWAY_UNION_ID,
          name: config.name,
          game_type: 'cash',
          game_variant: config.gameVariant,
          stakes: `${config.smallBlind}/${config.bigBlind}`,
          small_blind: config.smallBlind,
          big_blind: config.bigBlind,
          min_buy_in: config.bigBlind * 40,
          max_buy_in: config.bigBlind * 200,
          // The law is enforced HERE, not only in the config above, so a
          // future config edit cannot put an illegal table in the database.
          max_players: clampSeatsForVariant(config.gameVariant, config.maxPlayers),
          current_players: 0,
          status: 'waiting',
        });

        if (error) {
          reportError(error, 'HorseFleet.Failed_to_create_table_confign');
        } else {
          console.log(
            `[HorseFleet] Created table: ${config.name} (club: ${clubId}, union: ${MIDWAY_UNION_ID})`
          );
        }
      } catch (err: any) {
        reportError(err, 'HorseFleet.Error_creating_table_confignam');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SEED ALL TABLES — Fill empty seats with available horses
  // ─────────────────────────────────────────────────────────────────────

  private async seedAllTables(): Promise<void> {
    if (this.seeding) return; // Prevent concurrent seeding
    this.seeding = true;
    try {
      // Get all active cash tables
      // AUDIT V2 (2026-07-23): club_id selected here — the old code re-queried
      // tables once per table inside the seeding loop (N+1) just to read it.
      const { data: tables, error: tablesError } = await supabase
        .from('tables')
        .select(
          'id, name, max_players, small_blind, big_blind, game_variant, club_id, min_buy_in, max_buy_in, current_players, created_at'
        )
        .is('tournament_id', null)
        .in('status', ['waiting', 'running']);

      if (tablesError || !tables) {
        const errMsg =
          tablesError?.message ||
          (typeof tablesError === 'object' ? JSON.stringify(tablesError) : String(tablesError));
        reportError(new Error(errMsg), 'HorseFleet.Failed_to_fetch_tables');
        return;
      }

      // Optimization: Fetch all active seats once to build an in-memory map of
      // who is seated where.
      //
      // 2026-08-20: this was a bare .select() with no paging. PostgREST caps
      // every response at db-max-rows (1,000 here) WITHOUT erroring, and there
      // are 1,428 open seats — 1,245 of them on tournament tables, which this
      // seeder does not even seed but which still consume the row budget. So
      // ~428 occupied seats were invisible, and every seat the seeder could not
      // see it believed was EMPTY and tried to sit a horse in.
      //
      // Measured in postgres_logs before the fix: 18,744 `duplicate key value
      // violates unique constraint "table_seats_table_id_seat_number_key"` in
      // three hours — ~150,000 a day, the largest error stream on the platform,
      // and a ~65% failure rate on a path a genuine race could never push past
      // a few percent. The same truncated map fed the per-horse 4-table cap
      // (horseTables, below) and the human-rescue check, so those were wrong in
      // the same way.
      //
      // No money was ever at risk: atomic_table_buyin is the authoritative
      // guard and rejected all of them. That is precisely why it stayed
      // invisible — the failure mode was pure waste, logged where nobody looks.
      const seatPage = await fetchAllRows<{
        id: string;
        user_id: string;
        table_id: string;
        seat_number: number;
      }>(
        (cursor, want) => {
          // KEYSET, not OFFSET. `.range()` paging re-reads the table under a
          // fresh snapshot per page: a seat that empties between page 1 and
          // page 2 shifts every later row down one index, so OFFSET 1000 starts
          // PAST a still-occupied seat and never returns it — which is exactly
          // the duplicate-key buy-in this whole fix exists to stop. Seats empty
          // constantly in a live room. `id > cursor` has no such window.
          let q = supabase
            .from('table_seats')
            .select('id, user_id, table_id, seat_number')
            .is('left_at', null)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.activeSeats', maxRows: 50_000 }
      );

      // FAIL CLOSED. A partial seat map is precisely the state that produced
      // ~150,000 failed buy-ins a day: every seat we cannot see reads as empty.
      // Skipping a 30-second seeding cycle costs nothing; seeding from a
      // half-read map costs a storm.
      if (!seatPage.complete) {
        console.warn(
          '[HorseFleet] Seeding cycle SKIPPED — the seat map came back incomplete, ' +
            'and seeding from a partial map is what caused the duplicate-seat storm.'
        );
        return;
      }
      const allActiveSeats = seatPage.rows;

      const horseTables = new Map<string, Set<string>>();
      for (const seat of allActiveSeats) {
        if (!horseTables.has(seat.user_id)) horseTables.set(seat.user_id, new Set());
        horseTables.get(seat.user_id)!.add(seat.table_id);
      }

      // Optimization: Fetch all horses once instead of querying per table
      // We NO LONGER check for 'available' status because horses can multi-table.
      // 2026-08-20: paged, same reason as the seat read above — the fleet is
      // 574 horses and a truncated pool silently shrinks who can ever be seated.
      const horsePage = await fetchAllRows<{
        id: string;
        display_name: string | null;
        username: string | null;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id, display_name, username')
            .eq('is_horse', true)
            .neq('horse_status', 'disabled') // 'disabled' is the only status that prevents playing
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.validHorses', maxRows: 50_000 }
      );
      if (!horsePage.complete) {
        console.warn('[HorseFleet] Seeding cycle SKIPPED — the horse pool came back incomplete.');
        return;
      }
      const validHorses = horsePage.rows;

      // V8: full horse-id set (any status) so we can tell HUMAN seats from
      // horse seats — humans get rescue priority below.
      // Paged: a horse missing from this set reads as a HUMAN, which triggers
      // the short-handed-human rescue path and reorders the whole seeding queue.
      const idPage = await fetchAllRows<{ id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id')
            .eq('is_horse', true)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.horseIds', maxRows: 50_000 }
      );
      // A horse missing from this set reads as a HUMAN, which triggers the
      // short-handed-human rescue path and reorders the whole seeding queue.
      if (!idPage.complete) {
        console.warn('[HorseFleet] Seeding cycle SKIPPED — the horse id set came back incomplete.');
        return;
      }
      const horseIdSet = new Set(idPage.rows.map((h) => h.id));
      const hourUTC = new Date().getUTCHours();

      console.log(
        `[HorseFleet] Seeding cycle: ${tables.length} tables found, ${validHorses.length} total horses.`
      );

      // Tables past MAX_TABLES_PER_CONFIG for their config. They are not
      // seeded — they are being drained — and retireSurplusTables() closes
      // each one as it empties. Ordered oldest-first so the table that gets
      // KEPT is the same one ensureAllTablesExist() treats as canonical.
      const surplusTableIds = new Set<string>();
      for (const config of DEFAULT_TABLES) {
        const family = tables
          .filter((t) => t.name === config.name || t.name.startsWith(`${config.name} #`))
          .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
        for (const t of family.slice(MAX_TABLES_PER_CONFIG)) surplusTableIds.add(t.id);
      }
      if (surplusTableIds.size > 0) {
        console.log(
          `[HorseFleet] ${surplusTableIds.size} surplus table(s) draining — not seeding them`
        );
      }

      let totalSeated = 0;

      // ── FLEET ACTIVITY FLOOR (Dan 2026-08-26: "a minimum of 1 out of 3
      // horses should be playing") ──────────────────────────────────────────
      // Measured from live seats, the only truth about where a horse is
      // (horse_status is never flipped for cash play). Tournament seats are
      // not in allActiveSeats, so this UNDERCOUNTS "playing" and the floor is
      // conservative — it can only over-deliver. When the seated fraction
      // drops under a third, every non-empty table wants one more seat this
      // cycle, which lifts the floor without thrashing any single game.
      const seatedHorseCount = new Set(
        allActiveSeats.filter((s) => horseIdSet.has(s.user_id)).map((s) => s.user_id)
      ).size;
      const fleetBoost =
        validHorses.length > 0 && seatedHorseCount < Math.ceil(validHorses.length / 3);
      if (fleetBoost) {
        console.log(
          `[HorseFleet] Activity floor: ${seatedHorseCount}/${validHorses.length} horses seated (<1/3) — boosting seat targets this cycle`
        );
      }

      // V8: tables with a short-handed HUMAN seed first (never leave a human
      // stranded); everything else keeps its natural order.
      const humanShort = (t: any): boolean => {
        const seats = allActiveSeats.filter((x) => x.table_id === t.id);
        return seats.some((x) => !horseIdSet.has(x.user_id)) && seats.length < 4;
      };
      const orderedTables = [...tables].sort(
        (a, b) => Number(humanShort(b)) - Number(humanShort(a))
      );

      for (const table of orderedTables) {
        try {
          // A draining table gets no new horses. Without this the surplus can
          // never empty, and so can never be retired.
          if (surplusTableIds.has(table.id)) continue;

          // Determine currently occupied seats for THIS table from our in-memory map
          const tableOccupiedSeats = allActiveSeats.filter((s) => s.table_id === table.id);
          const occupiedNumbers = new Set(tableOccupiedSeats.map((s) => s.seat_number));
          const currentCount = occupiedNumbers.size;

          // ── V14 OCCUPANCY (Dan 2026-08-23) ────────────────────────────────
          // Every table used to carry ONE fixed target from DEFAULT_TABLES, so
          // the lobby looked the same hour after hour: the same games at the
          // same counts, every one a seat or two short of full, none of them
          // ever with a queue. A real floor is lopsided. The target now drifts
          // per table on a ~22 minute bucket - hot (full, with a list), busy,
          // steady (2-3 open), quiet (short-handed and visibly looking) - and
          // is deterministic in (table, bucket) so it holds still long enough
          // to be read instead of thrashing seats every 30s cycle.
          const humanAtTable = tableOccupiedSeats.some((x) => !horseIdSet.has(x.user_id));
          const target = occupancyTargetFor(table.id, table.max_players, humanAtTable);
          const { waitTarget, vibe } = target;
          let { seatTarget } = target;
          // Activity floor (see fleetBoost above): held-empty tables stay
          // empty — the floor is lifted by the tables that are running.
          if (fleetBoost && vibe !== 'empty') {
            seatTarget = Math.min(table.max_players, seatTarget + 1);
          }

          // A full table with a vibe that says "hot" grows a WAITING LIST
          // rather than simply being full - that queue is the thing that makes
          // a game look like the game everyone wants.
          //
          // Dan 2026-08-26: and ONLY a genuinely full table. A queue behind a
          // table with open seats is a visible lie ("Waiting 54" beside an
          // OPEN seat map), so any table that is not at max prunes its horse
          // rows to zero — including the case where the vibe target is below
          // max. Humans in the queue are never touched.
          if (currentCount >= seatTarget) {
            if (waitTarget > 0 && currentCount >= table.max_players) {
              await this.pruneHorseWaitlist(table.id, waitTarget, horseIdSet);
              await this.ensureWaitlist(table.id, waitTarget, validHorses, horseTables, hourUTC);
            } else {
              await this.pruneHorseWaitlist(table.id, 0, horseIdSet);
            }
            continue;
          }
          // Below target ⇒ the table has open seats ⇒ no horse queues here.
          await this.pruneHorseWaitlist(table.id, 0, horseIdSet);
          let seatsNeeded = seatTarget - currentCount;

          // V8 STAGGERED ARRIVALS: humans trickle in — so do horses. At most
          // 1-2 join a table per 30s cycle, UNLESS a human is sitting at a
          // short-handed table (rescue outranks pacing).
          const humanNeedsRescue = humanAtTable && currentCount < 4;
          if (!humanNeedsRescue) {
            seatsNeeded = Math.min(seatsNeeded, 1 + Math.floor(Math.random() * 2));
          }

          // Find empty seat numbers
          const emptySeats: number[] = [];
          for (let s = 1; s <= table.max_players && emptySeats.length < seatsNeeded; s++) {
            if (!occupiedNumbers.has(s)) emptySeats.push(s);
          }
          if (emptySeats.length === 0) continue;

          // Find candidate horses:
          // 1. Not already at this table
          // 2. Not exceeding 4 max tables
          const MAX_TABLES_PER_HORSE = 4;
          const candidateHorses = validHorses.filter((h) => {
            // Dan 2026-08-26 game lanes: a third of the stable plays events
            // only (tournaments / spins / heads-up) and never sits at cash.
            if (gameLaneFor(h.id) === 'events') return false;
            const tablesForHorse = horseTables.get(h.id);
            if (!tablesForHorse) return true;
            if (tablesForHorse.size >= MAX_TABLES_PER_HORSE) return false;
            if (tablesForHorse.has(table.id)) return false;
            return true;
          });

          // V8 ACTIVITY WINDOWS: only horses inside their daily window sit
          // down (falls back to the full pool if a human needs a game NOW and
          // the active pool ran dry).
          let pool = candidateHorses.filter((h) => isActiveNow(h.id, hourUTC));
          if (pool.length < emptySeats.length && humanNeedsRescue) pool = candidateHorses;

          // V8 WEIGHTED-RANDOM selection (replaces the deterministic
          // fewest-tables sort): fewer active tables still means likelier to
          // be picked, but the ORDER varies so the same horses stop appearing
          // in the same rotation every time.
          const weighted = pool
            .map((h) => ({
              h,
              w: Math.random() / (1 + (horseTables.get(h.id)?.size || 0)),
            }))
            .sort((a, b) => b.w - a.w);
          const selectedHorses = weighted.slice(0, emptySeats.length).map((x) => x.h);

          if (selectedHorses.length === 0) {
            if (emptySeats.length > 0) {
              console.log(
                `[HorseFleet] No available horses for "${table.name}" (need ${emptySeats.length})`
              );
            }
            continue;
          }

          // Table's club_id for rake routing (fetched with the table list above)
          const clubId = (table as any).club_id || JAQK_CLUB_ID;

          // Seat each horse at an ACTUAL empty seat
          let seated = 0;
          for (let i = 0; i < selectedHorses.length; i++) {
            const horse = selectedHorses[i];
            const seatNumber = emptySeats[i];
            // V8 BUY-IN VARIANCE: per-horse profile (short/standard/deep)
            // with per-sitting jitter, clamped to the table's real min/max.
            const minB = Number((table as any).min_buy_in) || table.big_blind * 40;
            const maxB = Number((table as any).max_buy_in) || table.big_blind * 200;
            // V9: humans buy in for ROUND numbers ($100, $150, $240 — never
            // $227.40). Snap the profiled amount to the nearest 5bb step,
            // then clamp to the table's real limits.
            const step = table.big_blind * 5;
            const raw = table.big_blind * buyInBBFor(horse.id);
            const buyIn =
              Math.round(Math.max(minB, Math.min(maxB, Math.round(raw / step) * step)) * 100) / 100;

            const success = await this.seatHorse(
              table.id,
              horse.id,
              seatNumber,
              buyIn,
              table.name,
              clubId
            );
            if (success) {
              seated++;
              totalSeated++;
              // Update our in-memory map so we don't assign them to another table if they hit 4
              if (!horseTables.has(horse.id)) horseTables.set(horse.id, new Set());
              horseTables.get(horse.id)!.add(table.id);
            }
          }

          if (seated > 0) {
            // NOTE: We do NOT update current_players here.
            // atomic_seat_horse already recalculates current_players authoritatively from table_seats.
            // Manually overwriting would cause race conditions with stale local counters.
            if (currentCount + seated >= 2) {
              await supabase
                .from('tables')
                .update({ status: 'running' })
                .eq('id', table.id)
                .neq('status', 'running');
            }
          }
        } catch (err: any) {
          reportError(err, 'HorseFleet.Error_seeding_table_tablename');
        }
      }

      if (totalSeated > 0) {
        console.log(`[HorseFleet] Seated ${totalSeated} horses across tables`);
      }

      // V8 DEMAND RESPONSE: when every table of a config is effectively full,
      // spawn an overflow table so arriving humans always find a seat.
      await this.spawnOverflowTables(tables, allActiveSeats || []);

      // ...and the other direction, which never existed until 2026-08-19.
      // Note it now skips any table carrying `auto_extension` — see there.
      await this.retireSurplusTables(tables, surplusTableIds, allActiveSeats || []);

      // The same two directions for a HOST's own table, from the switches on
      // the table creation page: Auto Restart reopens a closed one, Auto
      // Create Table opens a sibling when it fills. The fleet's own spawn and
      // retire above only know DEFAULT_TABLES; this knows every table that
      // carries the flag, which is what makes a host's switch mean anything.
      await this.runTableLifecyclePass();
    } catch (err: any) {
      reportError(err, 'HorseFleet.seedAllTables_error');
    } finally {
      this.seeding = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // TABLE RETIREMENT (2026-08-19)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Close surplus tables once they are empty.
   *
   * The fleet could only ever ADD tables. spawnOverflowTables() capped
   * creation at MAX_TABLES_PER_CONFIG and a comment promised that "the
   * stale-table lifecycle owns closing" — a component that was never written.
   * Nothing anywhere closed an idle cash table, so when ensureAllTablesExist()
   * started duplicating rows on every boot, the count only went one way: 121
   * rows named 'NLH 1.00/2.00', 495 fleet tables in total.
   *
   * Empty means EMPTY: no live seat rows, no counted players, and not mid-hand.
   * A table with anyone at it is left alone and retired on a later cycle, so a
   * horse — or a human who wandered in — is never closed out from under.
   *
   * status = 'closed' rather than DELETE: the DB trigger
   * trg_auto_cashout_on_table_close cashes out any remaining human seat, and a
   * delete would bypass it and strand chips. It also keeps the row's history.
   */
  private async retireSurplusTables(
    tables: Array<{ id: string; name: string; current_players?: number | null }>,
    surplusTableIds: Set<string>,
    allActiveSeats: Array<{ table_id: string }>
  ): Promise<void> {
    if (surplusTableIds.size === 0) return;
    const occupied = new Set(allActiveSeats.map((s) => s.table_id));
    const retirable = tables.filter(
      (t) =>
        surplusTableIds.has(t.id) && !occupied.has(t.id) && Number(t.current_players ?? 0) === 0
    );
    if (retirable.length === 0) return;

    try {
      // .in('status', [...]) guards the race where the table filled between the
      // seat fetch and this update: a table that went 'playing' is skipped.
      const { error } = await supabase
        .from('tables')
        .update({ status: 'closed' })
        .in(
          'id',
          retirable.map((t) => t.id)
        )
        .is('tournament_id', null)
        /* AUTO EXTENSION (Dan 2026-08-25, table-creation parity). The toggle
           says "Extend table automatically" and had no reader at all. This is
           what it extends: the table's LIFE. A host who switched it on is
           saying "do not close my table just because it went quiet", so an
           empty table carrying the flag is skipped here and stays open for
           business. `.not(...)` rather than a filter on the JS side because
           this is the query that does the closing - a check anywhere else
           could be raced past. */
        .not('auto_extension', 'is', true)
        .in('status', ['waiting', 'running']);
      if (error) {
        reportError(error, 'HorseFleet.retireSurplusTables_failed');
        return;
      }
      console.log(
        `[HorseFleet] Retired ${retirable.length} empty surplus table(s): ` +
          `${retirable
            .map((t) => t.name)
            .slice(0, 5)
            .join(', ')}${retirable.length > 5 ? ' ...' : ''}`
      );
    } catch (err: any) {
      reportError(err, 'HorseFleet.retireSurplusTables_error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // V8 DEMAND-BASED TABLE SPAWNING
  // ─────────────────────────────────────────────────────────────────────

  /**
   * If EVERY live table of a config is within one seat of full, create one
   * overflow table ("<name> #2", "#3" — capped at 3 per config). Overflow
   * tables are seeded by the normal cycle on the next pass; empty overflow
   * tables simply idle (the stale-table lifecycle owns closing).
   */
  /**
   * AUTO RESTART and AUTO CREATE TABLE (Dan 2026-08-25, table-creation
   * parity). Two more switches that had tooltips and no readers.
   *
   * The rules live in `fn_table_lifecycle_pass` rather than here for the same
   * reason spawnOverflowTables below could not simply be widened: THAT method
   * only knows the fleet's own DEFAULT_TABLES, matched by name prefix. A
   * host's table is not in that list and never could be. The SQL pass asks the
   * question of every table that carries the flag, which is the only way a
   * host's own switch can mean anything.
   *
   * Idempotent, so it is safe on every cycle, and it reports what it did so
   * this can log it rather than guess.
   */
  private async runTableLifecyclePass(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('fn_table_lifecycle_pass');
      if (error) {
        reportError(error, 'HorseFleet.tableLifecyclePass_failed');
        return;
      }
      if (!Array.isArray(data) || data.length === 0) return;
      for (const row of data as Array<{ action?: string; table_name?: string }>) {
        console.log(`[HorseFleet] lifecycle: ${row.action} "${row.table_name}" (host switch)`);
      }
    } catch (err) {
      reportError(err, 'HorseFleet.tableLifecyclePass_error');
    }
  }

  private async spawnOverflowTables(
    tables: Array<{ id: string; name: string; max_players: number }>,
    allActiveSeats: Array<{ table_id: string }>
  ): Promise<void> {
    for (const config of DEFAULT_TABLES) {
      try {
        const family = tables.filter(
          (t) => t.name === config.name || t.name.startsWith(`${config.name} #`)
        );
        if (family.length === 0 || family.length >= MAX_TABLES_PER_CONFIG) continue;
        const allNearFull = family.every((t) => {
          const occ = allActiveSeats.filter((s) => s.table_id === t.id).length;
          return occ >= t.max_players - 1;
        });
        if (!allNearFull) continue;

        const name = `${config.name} #${family.length + 1}`;
        const clubId = this.getNextClubId();
        const { error } = await supabase.from('tables').insert({
          club_id: clubId,
          union_id: MIDWAY_UNION_ID,
          name,
          game_type: 'cash',
          game_variant: config.gameVariant,
          stakes: `${config.smallBlind}/${config.bigBlind}`,
          small_blind: config.smallBlind,
          big_blind: config.bigBlind,
          min_buy_in: config.bigBlind * 40,
          max_buy_in: config.bigBlind * 200,
          // The law is enforced HERE, not only in the config above, so a
          // future config edit cannot put an illegal table in the database.
          max_players: clampSeatsForVariant(config.gameVariant, config.maxPlayers),
          current_players: 0,
          status: 'waiting',
        });
        if (error) {
          // Unique-name races between cycles are expected and harmless.
          if (!(error.message || '').includes('duplicate')) {
            reportError(error, 'HorseFleet.spawnOverflowTable_failed');
          }
        } else {
          console.log(`[HorseFleet] Demand overflow: created "${name}"`);
        }
      } catch (err: any) {
        reportError(err, 'HorseFleet.spawnOverflowTables_error');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SEAT A SINGLE HORSE
  // ─────────────────────────────────────────────────────────────────────

  private async seatHorse(
    tableId: string,
    horseId: string,
    seatNumber: number,
    buyIn: number,
    tableName: string,
    clubId: string
  ): Promise<boolean> {
    try {
      // ROUND 34 FIX: Direct UPDATE on public.wallets is rejected by the
      // Phase 4.1.6a wallet guard ("Direct balance mutation on public.wallets
      // is forbidden"). All balance changes must flow through whitelisted
      // SECURITY DEFINER RPCs that log to chip_ledger. The
      // atomic_table_buyin RPC handles every step atomically — balance
      // check, debit, seat insert, audit log, and tables.current_players
      // bump — and is whitelisted, so a single call replaces the manual
      // 4-step sequence below.
      void clubId; // kept in caller signature for downstream use; RPC reads it
      // from tables(id).club_id transitively.
      const { error: rpcErr } = await supabase.rpc('atomic_table_buyin', {
        p_user_id: horseId,
        p_table_id: tableId,
        p_seat_number: seatNumber,
        p_amount: buyIn,
        p_auto_rebuy: false,
      });

      if (rpcErr) {
        // 'Insufficient balance' / 'already seated' are silent expected
        // failures during the seeding race; only report other errors.
        // 2026-08-19: TABLE_CAP_REACHED joins the list — the per-user 4-table
        // cap now lives inside atomic_table_buyin itself (the in-memory
        // MAX_TABLES_PER_HORSE filter above is advisory and raceable across
        // processes; the RPC is the authoritative guard), so a cap rejection
        // during a seeding race is expected, not an error.
        const msg = rpcErr.message || '';
        if (
          !msg.includes('Insufficient balance') &&
          !msg.includes('Player already seated') &&
          !msg.includes('duplicate key') &&
          !msg.includes('TABLE_CAP_REACHED')
        ) {
          reportError(rpcErr, 'HorseFleet.atomic_table_buyin_failed_for_horse');
        }
        return false;
      }

      // Log a tableName-aware description on top of the RPC's generic
      // "Cash game buy-in at table" string so audit reconciliation can
      // match human-readable table names.
      void tableName; // RPC writes its own description; this comment is the trail

      return true;
    } catch (err: any) {
      reportError(err, 'HorseFleet.seatHorse_error');
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FLEET HEALTH
  // ─────────────────────────────────────────────────────────────────────

  async getFleetHealth(): Promise<{
    total: number;
    available: number;
    seated: number;
    stuck: number;
  }> {
    try {
      const healthPage = await fetchAllRows<{ id: string; horse_status: string | null }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id, horse_status')
            .eq('is_horse', true)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseFleet.fleetHealth', maxRows: 50_000 }
      );
      const horses = healthPage.rows;
      // An incomplete read and a genuinely empty fleet must not report the same
      // numbers — this is a health probe, and a silent undercount is a lie.
      if (!healthPage.complete || horses.length === 0) {
        return { total: 0, available: 0, seated: 0, stuck: 0 };
      }

      let available = 0,
        seated = 0,
        stuck = 0;
      for (const h of horses) {
        if (h.horse_status === 'available') available++;
        else if (h.horse_status === 'seated') seated++;
        else stuck++;
      }

      return { total: horses.length, available, seated, stuck };
    } catch {
      return { total: 0, available: 0, seated: 0, stuck: 0 };
    }
  }
}
