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
import { reportError } from './errorReporter.js';

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

const DEFAULT_TABLES: TableConfig[] = [
  // ONE TABLE ONLY: NLH 1/2 - quality before scaling
  {
    name: 'NLH 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
];

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

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────
  // ENSURE ALL TABLES EXIST IN DATABASE
  // ─────────────────────────────────────────────────────────────────────────

  private async ensureAllTablesExist(): Promise<void> {
    console.log(`[HorseFleet] Ensuring ${DEFAULT_TABLES.length} cash tables exist...`);

    for (const config of DEFAULT_TABLES) {
      try {
        // FIX 201: Check for table by name in ANY status (not just waiting/running).
        // If a closed table exists, reactivate it instead of creating a duplicate.
        const { data: existing } = await supabase
          .from('tables')
          .select('id, status, union_id')
          .eq('name', config.name)
          .is('tournament_id', null)
          .maybeSingle();

        if (existing) {
          // Table exists — ensure it's active and at Union level
          const updates: Record<string, any> = {};
          if (existing.status === 'closed') updates.status = 'waiting';
          if (existing.union_id !== MIDWAY_UNION_ID) updates.union_id = MIDWAY_UNION_ID;
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
          max_players: config.maxPlayers,
          current_players: 0,
          status: 'waiting',
        });

        if (error) {
          reportError(error, 'HorseFleet.Failed_to_create_table_confign');
        } else {
          console.log(`[HorseFleet] Created table: ${config.name} (club: ${clubId}, union: ${MIDWAY_UNION_ID})`);
        }
      } catch (err: any) {
        reportError(err, 'HorseFleet.Error_creating_table_confignam');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEED ALL TABLES — Fill empty seats with available horses
  // ─────────────────────────────────────────────────────────────────────────

  private async seedAllTables(): Promise<void> {
    if (this.seeding) return; // Prevent concurrent seeding
    this.seeding = true;
    try {
      // Get all active cash tables
      const { data: tables, error: tablesError } = await supabase
        .from('tables')
        .select('id, name, max_players, small_blind, big_blind, game_variant')
        .is('tournament_id', null)
        .in('status', ['waiting', 'running']);

      if (tablesError || !tables) {
        reportError(tablesError, 'HorseFleet.Failed_to_fetch_tables');
        return;
      }

      // Optimization: Fetch all active seats once to build an in-memory map of who is seated where
      const { data: allActiveSeats } = await supabase
        .from('table_seats')
        .select('user_id, table_id, seat_number')
        .is('left_at', null);

      const horseTables = new Map<string, Set<string>>();
      if (allActiveSeats) {
        for (const seat of allActiveSeats) {
          if (!horseTables.has(seat.user_id)) horseTables.set(seat.user_id, new Set());
          horseTables.get(seat.user_id)!.add(seat.table_id);
        }
      }

      // Optimization: Fetch all horses once instead of querying per table
      // We NO LONGER check for 'available' status because horses can multi-table.
      const { data: allHorses } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .eq('is_horse', true)
        .neq('horse_status', 'disabled'); // Assume 'disabled' is the only status that prevents playing

      const validHorses = allHorses || [];

      console.log(
        `[HorseFleet] Seeding cycle: ${tables.length} tables found, ${validHorses.length} total horses.`
      );
      let totalSeated = 0;

      for (const table of tables) {
        try {
          // Get target horse count for this table
          const config = DEFAULT_TABLES.find((t) => t.name === table.name);
          const targetHorses = config?.horsesPerTable || Math.max(3, table.max_players - 1);

          // Determine currently occupied seats for THIS table from our in-memory map
          const tableOccupiedSeats = (allActiveSeats || []).filter((s) => s.table_id === table.id);
          const occupiedNumbers = new Set(tableOccupiedSeats.map((s) => s.seat_number));

          const currentCount = occupiedNumbers.size;
          const seatsNeeded = targetHorses - currentCount;
          if (seatsNeeded <= 0) continue;

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
            const tablesForHorse = horseTables.get(h.id);
            if (!tablesForHorse) return true;
            if (tablesForHorse.size >= MAX_TABLES_PER_HORSE) return false;
            if (tablesForHorse.has(table.id)) return false;
            return true;
          });

          // Sort candidates by fewest tables played to distribute load
          candidateHorses.sort(
            (a, b) => (horseTables.get(a.id)?.size || 0) - (horseTables.get(b.id)?.size || 0)
          );

          // Take exactly the number we need
          const selectedHorses = candidateHorses.slice(0, emptySeats.length);

          if (selectedHorses.length === 0) {
            if (emptySeats.length > 0) {
              console.log(
                `[HorseFleet] No available horses for "${table.name}" (need ${emptySeats.length})`
              );
            }
            continue;
          }

          // Get table's club_id for rake routing
          const { data: tableData } = await supabase
            .from('tables')
            .select('club_id')
            .eq('id', table.id)
            .maybeSingle(); // FIX 168
          const clubId = tableData?.club_id || JAQK_CLUB_ID;

          // Seat each horse at an ACTUAL empty seat
          let seated = 0;
          for (let i = 0; i < selectedHorses.length; i++) {
            const horse = selectedHorses[i];
            const seatNumber = emptySeats[i];
            const buyIn = table.big_blind * 100; // Standard 100 BB buy-in

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
    } catch (err: any) {
      reportError(err, 'HorseFleet.seedAllTables_error');
    } finally {
      this.seeding = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEAT A SINGLE HORSE
  // ─────────────────────────────────────────────────────────────────────────

  private async seatHorse(
    tableId: string,
    horseId: string,
    seatNumber: number,
    buyIn: number,
    tableName: string,
    clubId: string
  ): Promise<boolean> {
    try {
      // FIX 203: Bypass broken atomic_seat_horse RPC (duplicate overload causes
      // "Could not choose the best candidate function" 300 errors).
      // Direct queries replicate the same logic until the duplicate is dropped.

      // 1. Check wallet balance and deduct
      const { data: wallet, error: walletErr } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', horseId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      if (walletErr || !wallet || wallet.balance < buyIn) {
        return false; // Insufficient balance — silent fail
      }

      const { error: deductErr } = await supabase
        .from('wallets')
        .update({ balance: wallet.balance - buyIn, updated_at: new Date().toISOString() })
        .eq('user_id', horseId)
        .eq('wallet_type', 'PLAYER');

      if (deductErr) {
        reportError(deductErr, 'HorseFleet.wallet_deduct_failed_for_horse');
        return false;
      }

      // 2. Log wallet transaction (negative amount = debit, matches convention)
      await supabase.from('wallet_transactions').insert({
        user_id: horseId,
        wallet_type: 'PLAYER',
        amount: buyIn,
        type: 'debit',
        category: 'buyin',
        description: `Buy-in at ${tableName}: ${buyIn} chips`,
      });

      // 3. Insert seat
      const { error: seatErr } = await supabase.from('table_seats').insert({
        table_id: tableId,
        user_id: horseId,
        seat_number: seatNumber,
        stack: buyIn,
        status: 'active',
        joined_at: new Date().toISOString(),
      });

      if (seatErr) {
        // FIX 206: Silence expected duplicate key errors (race condition between seed cycles)
        if (!seatErr.message.includes('duplicate key')) {
          reportError(seatErr, 'HorseFleet.seat_insert_failed_for_horseId');
        }
        // Refund wallet on seat failure
        await supabase
          .from('wallets')
          .update({ balance: wallet.balance, updated_at: new Date().toISOString() })
          .eq('user_id', horseId)
          .eq('wallet_type', 'PLAYER');
        return false;
      }

      // 4. Update table player count
      const { count } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);

      await supabase
        .from('tables')
        .update({ current_players: count ?? 0 })
        .eq('id', tableId);

      return true;
    } catch (err: any) {
      reportError(err, 'HorseFleet.seatHorse_error');
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FLEET HEALTH
  // ─────────────────────────────────────────────────────────────────────────

  async getFleetHealth(): Promise<{
    total: number;
    available: number;
    seated: number;
    stuck: number;
  }> {
    try {
      const { data: horses } = await supabase
        .from('profiles')
        .select('id, horse_status')
        .eq('is_horse', true);

      if (!horses) return { total: 0, available: 0, seated: 0, stuck: 0 };

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
