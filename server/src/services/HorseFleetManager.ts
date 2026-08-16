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

const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';

const DEFAULT_TABLES: TableConfig[] = [
  // ─── NO LIMIT HOLD'EM (NLH) — Full Stake Ladder ─────────────────────────
  {
    name: 'NLH Micro 0.10/0.20',
    smallBlind: 0.1,
    bigBlind: 0.2,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 2.00/4.00',
    smallBlind: 2.0,
    bigBlind: 4.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 3.00/6.00',
    smallBlind: 3.0,
    bigBlind: 6.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 5.00/10.00',
    smallBlind: 5.0,
    bigBlind: 10.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 10.00/25.00',
    smallBlind: 10.0,
    bigBlind: 25.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  // 6-Max tables
  {
    name: 'NLH 6-Max 0.10/0.20',
    smallBlind: 0.1,
    bigBlind: 0.2,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 6-Max 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 6-Max 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },
  {
    name: 'NLH 6-Max 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'nlh',
  },

  // ─── POT LIMIT OMAHA 4-CARD (PLO4) ──────────────────────────────────────
  {
    name: 'PLO4 0.10/0.20',
    smallBlind: 0.1,
    bigBlind: 0.2,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO4 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO4 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO4 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO4 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo4',
  },
  {
    name: 'PLO4 5.00/10.00',
    smallBlind: 5.0,
    bigBlind: 10.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo4',
  },

  // ─── POT LIMIT OMAHA 5-CARD (PLO5) ──────────────────────────────────────
  {
    name: 'PLO5 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo5',
  },
  {
    name: 'PLO5 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo5',
  },
  {
    name: 'PLO5 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo5',
  },
  {
    name: 'PLO5 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo5',
  },

  // ─── POT LIMIT OMAHA 8 OR BETTER (PLO8 / Hi-Lo) ─────────────────────────
  {
    name: 'PLO8 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo8',
  },
  {
    name: 'PLO8 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo8',
  },
  {
    name: 'PLO8 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo8',
  },
  {
    name: 'PLO8 2.00/5.00',
    smallBlind: 2.0,
    bigBlind: 5.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'plo8',
  },

  // ─── OFC PINEAPPLE ──────────────────────────────────────────────────────
  {
    name: 'Pineapple 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'ofc_pineapple',
  },
  {
    name: 'Pineapple 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'ofc_pineapple',
  },
  {
    name: 'Pineapple 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'ofc_pineapple',
  },

  // ─── SHORT DECK ─────────────────────────────────────────────────────────
  {
    name: 'Short Deck 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'short_deck',
  },
  {
    name: 'Short Deck 1.00/2.00',
    smallBlind: 1.0,
    bigBlind: 2.0,
    maxPlayers: 6,
    horsesPerTable: 6,
    gameVariant: 'short_deck',
  },

  // ─── BOMB POT TABLES ────────────────────────────────────────────────────
  {
    name: 'Bomb Pot NLH 0.25/0.50',
    smallBlind: 0.25,
    bigBlind: 0.5,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'nlh',
  },
  {
    name: 'Bomb Pot PLO4 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 9,
    horsesPerTable: 8,
    gameVariant: 'plo4',
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
        console.error('[HorseFleet] Initial seeding error:', err);
      });

    // Recurring check: every 30 seconds, ensure horses are seated
    this.seedInterval = setInterval(() => {
      this.seedAllTables().catch((err) => console.error('[HorseFleet] Seed cycle error:', err));
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
        // Check if table already exists by name
        const { data: existing } = await supabase
          .from('tables')
          .select('id')
          .eq('name', config.name)
          .is('tournament_id', null)
          .in('status', ['waiting', 'running'])
          .maybeSingle();

        if (existing) continue; // Table exists

        // Create the table
        const clubId = this.getNextClubId();
        const { error } = await supabase.from('tables').insert({
          club_id: clubId,
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
          console.error(`[HorseFleet] Failed to create table "${config.name}":`, error.message);
        } else {
          console.log(`[HorseFleet] Created table: ${config.name}`);
        }
      } catch (err: any) {
        console.error(`[HorseFleet] Error creating table "${config.name}":`, err.message);
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
        console.error('[HorseFleet] Failed to fetch tables:', tablesError?.message);
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

          // Get table's club_id
          const { data: tableData } = await supabase
            .from('tables')
            .select('club_id')
            .eq('id', table.id)
            .maybeSingle(); // FIX 168
          const clubId = tableData?.club_id || SHARK_CLUB_ID;

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
          console.error(`[HorseFleet] Error seeding table "${table.name}":`, err.message);
        }
      }

      if (totalSeated > 0) {
        console.log(`[HorseFleet] Seated ${totalSeated} horses across tables`);
      }
    } catch (err: any) {
      console.error('[HorseFleet] seedAllTables error:', err.message);
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
      // 100% ACID-Compliant Seating via Postgres RPC
      // Prevents "phantom deductions" if the Node server dies mid-seat.
      const { data: success, error } = await supabase.rpc('atomic_seat_horse', {
        p_table_id: tableId,
        p_horse_id: horseId,
        p_seat_number: seatNumber,
        p_buy_in: buyIn,
        p_table_name: tableName,
      });

      if (error || !success) {
        if (error && !error.message.includes('Insufficient balance')) {
          console.error(
            `[HorseFleet] atomic_seat_horse database failure for ${horseId} at ${tableName}:`,
            error.message
          );
        }
        return false;
      }

      return true;
    } catch (err: any) {
      console.error(`[HorseFleet] seatHorse error:`, err.message);
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
