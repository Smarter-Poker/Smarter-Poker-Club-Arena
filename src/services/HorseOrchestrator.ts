/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE ORCHESTRATOR — Fleet-Wide Coordination Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages 100 horses across ALL concurrent cash game tables, tournaments,
 * SNGs, and Spins. Produces real-time hand history data, validates
 * rake calculations, and verifies Supabase persistence.
 *
 * NOW POWERED BY: MIDWAY UNION (not Shark Club / JAQK Club)
 *
 * ARCHITECTURE:
 * - Each table runs its own HandController instance
 * - Horses are distributed across tables based on stake level
 * - Auto-rebuy keeps horses at 100 BB between hands
 * - Hand events persist to Supabase in real-time
 * - MasterBus broadcasts updates across all pages
 *
 * FULL COVERAGE:
 * - Cash Games: NLH, PLO4, PLO5, PLO8, OFC Pineapple — ALL stake levels
 * - Tournaments: Freezeout, Bounty, PKO, Mystery Bounty, Turbo, Freeroll
 * - SNGs: 6-Max Turbo, 9-Max — all game types
 * - Spins: 3-Max — all game types
 * - Weekly Schedule: Different tournaments each day with guarantees
 */

import { supabase } from '../lib/supabase';
import { HydraService } from './HydraService';
import { tournamentService } from './TournamentService';
import { RakeService } from './RakeService';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface OrchestratorTable {
  tableId: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  horseCount: number;
  handsPlayed: number;
  totalRake: number;
  totalBBJ: number;
  status: 'seeding' | 'running' | 'stopping' | 'stopped';
  errors: string[];
}

interface OrchestratorStats {
  totalHorses: number;
  totalTables: number;
  totalHandsPlayed: number;
  totalRakeCollected: number;
  totalBBJCollected: number;
  handsPerMinute: number;
  errors: string[];
  uptime: number;
  startedAt: string;
}

interface TableConfig {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  horsesPerTable: number;
  gameVariant?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIDWAY UNION — All cash games run through the union, NOT individual clubs
// ═══════════════════════════════════════════════════════════════════════════════

const MIDWAY_UNION = {
  name: 'Midway Union',
  description: 'The premier poker union — all stakes, all games, all action.',
  ownerId: '47965354-0e56-43ef-931c-ddaab82af765', // Dan's user ID
  isPublic: true,
  settings: {
    revenueSharePercent: 10,
    sharedPlayerPool: true,
    crossClubTournaments: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CASH GAME TABLE CONFIGURATIONS — EVERY STAKE LEVEL × EVERY GAME TYPE
// ═══════════════════════════════════════════════════════════════════════════════

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

  // ─── PLO6 TABLES ──────────────────────────────────────────────────────────
  {
    name: 'PLO6 0.50/1.00',
    smallBlind: 0.5,
    bigBlind: 1.0,
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'plo6',
  },
  {
    name: 'PLO6 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'plo6',
  },

  // ─── PLO HI-LO TABLES ────────────────────────────────────────────────────
  {
    name: 'PLO Hi-Lo 5/10',
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'plo_hilo',
  },

  // ─── FIXED LIMIT HOLD'EM ─────────────────────────────────────────────────
  {
    name: 'FLH 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 9,
    horsesPerTable: 7,
    gameVariant: 'flh',
  },
  {
    name: 'FLH 2/4',
    smallBlind: 2,
    bigBlind: 4,
    maxPlayers: 9,
    horsesPerTable: 7,
    gameVariant: 'flh',
  },

  // ─── PINEAPPLE & CRAZY PINEAPPLE ─────────────────────────────────────────
  {
    name: 'Pineapple 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 9,
    horsesPerTable: 7,
    gameVariant: 'pineapple',
  },
  {
    name: 'Crazy Pineapple 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 9,
    horsesPerTable: 7,
    gameVariant: 'crazy_pineapple',
  },

  // ─── DOUBLE BOARD ─────────────────────────────────────────────────────────
  {
    name: 'Double Board NLH 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 6,
    horsesPerTable: 5,
    gameVariant: 'double_board',
  },

  // ─── MIXED GAMES (HORSE) ─────────────────────────────────────────────────
  {
    name: 'HORSE Mixed 1/2',
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 9,
    horsesPerTable: 7,
    gameVariant: 'mixed',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// FULL WEEKLY TOURNAMENT SCHEDULE — Runs all week, horses populate everything
// ═══════════════════════════════════════════════════════════════════════════════

const STANDARD_BLIND_STRUCTURE_10_LVL = [
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
];

const TURBO_BLIND_STRUCTURE = [
  { level: 1, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 4 },
  { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 4 },
  { level: 3, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 3 },
  { level: 4, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 3 },
  { level: 5, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 3 },
  { level: 6, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 2 },
  { level: 7, smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 2 },
  { level: 8, smallBlind: 750, bigBlind: 1500, ante: 150, durationMinutes: 2 },
];

const HYPER_TURBO_STRUCTURE = [
  { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 2 },
  { level: 2, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 2 },
  { level: 3, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 2 },
  { level: 4, smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 1 },
  { level: 5, smallBlind: 800, bigBlind: 1600, ante: 200, durationMinutes: 1 },
];

const PAYOUT_9_PLACES = [
  { place: 1, percentage: 30 },
  { place: 2, percentage: 20 },
  { place: 3, percentage: 15 },
  { place: 4, percentage: 10 },
  { place: 5, percentage: 8 },
  { place: 6, percentage: 6 },
  { place: 7, percentage: 5 },
  { place: 8, percentage: 3.5 },
  { place: 9, percentage: 2.5 },
];

const PAYOUT_5_PLACES = [
  { place: 1, percentage: 40 },
  { place: 2, percentage: 25 },
  { place: 3, percentage: 18 },
  { place: 4, percentage: 10 },
  { place: 5, percentage: 7 },
];

const PAYOUT_3_PLACES = [
  { place: 1, percentage: 50 },
  { place: 2, percentage: 30 },
  { place: 3, percentage: 20 },
];

const TOURNAMENT_CONFIGS = [
  // ─── MONDAY: FREEROLL FIESTA ─────────────────────────────────────────────
  {
    name: 'FREEROLL — Monday Kickoff (NLH)',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 0,
    rake: 0,
    guarantee: 100,
    startingStack: 3000,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 30,
    blindStructure: TURBO_BLIND_STRUCTURE,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 1, // Monday
    startHour: 19,
  },
  {
    name: 'FREEROLL — PLO4 Welcome',
    type: 'mtt' as const,
    gameVariant: 'plo4',
    buyIn: 0,
    rake: 0,
    guarantee: 50,
    startingStack: 3000,
    maxPlayers: 50,
    minPlayers: 6,
    horsesToRegister: 20,
    blindStructure: TURBO_BLIND_STRUCTURE,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 1,
    startHour: 21,
  },

  // ─── TUESDAY: FREEZEOUT FEST ─────────────────────────────────────────────
  {
    name: '5 Chip Freezeout — NLH Deep Stack',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 5,
    rake: 0.5,
    guarantee: 200,
    startingStack: 5000,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 25,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 2,
    startHour: 19,
  },
  {
    name: '10 Chip Freezeout — PLO5 Action',
    type: 'mtt' as const,
    gameVariant: 'plo5',
    buyIn: 10,
    rake: 1,
    guarantee: 300,
    startingStack: 5000,
    maxPlayers: 50,
    minPlayers: 8,
    horsesToRegister: 20,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 2,
    startHour: 21,
  },

  // ─── WEDNESDAY: BOUNTY BONANZA ───────────────────────────────────────────
  {
    name: '10 Chip Bounty Hunter — NLH (5 Chip Bounty)',
    type: 'bounty' as const,
    gameVariant: 'nlh',
    buyIn: 10,
    rake: 1,
    guarantee: 500,
    startingStack: 5000,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 30,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 3,
    startHour: 19,
  },
  {
    name: '25 Chip Bounty Hunter — PLO4 (12 Chip Bounty)',
    type: 'bounty' as const,
    gameVariant: 'plo4',
    buyIn: 25,
    rake: 2.5,
    guarantee: 1000,
    startingStack: 10000,
    maxPlayers: 50,
    minPlayers: 10,
    horsesToRegister: 20,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 3,
    startHour: 21,
  },

  // ─── THURSDAY: PKO (PROGRESSIVE KNOCKOUT) ────────────────────────────────
  {
    name: '15 Chip PKO — NLH Progressive Bounty',
    type: 'progressive_bounty' as const,
    gameVariant: 'nlh',
    buyIn: 15,
    rake: 1.5,
    guarantee: 750,
    startingStack: 7500,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 25,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 4,
    startHour: 19,
  },
  {
    name: '20 Chip PKO — PLO8 Hi-Lo Bounty',
    type: 'progressive_bounty' as const,
    gameVariant: 'plo8',
    buyIn: 20,
    rake: 2,
    guarantee: 500,
    startingStack: 7500,
    maxPlayers: 50,
    minPlayers: 8,
    horsesToRegister: 20,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 4,
    startHour: 21,
  },

  // ─── FRIDAY: MYSTERY BOUNTY MADNESS ──────────────────────────────────────
  {
    name: '25 Chip Mystery Bounty — NLH (Random 5-500 Chip Bounties!)',
    type: 'mystery_bounty' as const,
    gameVariant: 'nlh',
    buyIn: 25,
    rake: 2.5,
    guarantee: 1500,
    startingStack: 10000,
    maxPlayers: 100,
    minPlayers: 15,
    horsesToRegister: 30,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 5,
    startHour: 20,
  },
  {
    name: '10 Chip Mystery Bounty — Pineapple OFC',
    type: 'mystery_bounty' as const,
    gameVariant: 'ofc_pineapple',
    buyIn: 10,
    rake: 1,
    guarantee: 250,
    startingStack: 5000,
    maxPlayers: 30,
    minPlayers: 6,
    horsesToRegister: 15,
    blindStructure: TURBO_BLIND_STRUCTURE,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 5,
    startHour: 22,
  },

  // ─── SATURDAY: TURBO MARATHON + BIG GUARANTEE ────────────────────────────
  {
    name: '50 Chip Saturday Major — NLH 5K GTD',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 50,
    rake: 5,
    guarantee: 5000,
    startingStack: 15000,
    maxPlayers: 200,
    minPlayers: 20,
    horsesToRegister: 40,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 6,
    startHour: 18,
  },
  {
    name: '5 Chip Turbo Bounty — NLH Fast Action',
    type: 'bounty' as const,
    gameVariant: 'nlh',
    buyIn: 5,
    rake: 0.5,
    guarantee: 150,
    startingStack: 3000,
    maxPlayers: 50,
    minPlayers: 10,
    horsesToRegister: 25,
    blindStructure: TURBO_BLIND_STRUCTURE,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 6,
    startHour: 20,
  },
  {
    name: '10 Chip Turbo PLO4 — Saturday Night Action',
    type: 'mtt' as const,
    gameVariant: 'plo4',
    buyIn: 10,
    rake: 1,
    guarantee: 300,
    startingStack: 5000,
    maxPlayers: 50,
    minPlayers: 8,
    horsesToRegister: 20,
    blindStructure: TURBO_BLIND_STRUCTURE,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: 6,
    startHour: 22,
  },

  // ─── SUNDAY: CHAMPIONSHIP SUNDAY ─────────────────────────────────────────
  {
    name: '100 Chip Sunday Championship — NLH 10K GTD',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 100,
    rake: 10,
    guarantee: 10000,
    startingStack: 20000,
    maxPlayers: 200,
    minPlayers: 25,
    horsesToRegister: 50,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 0, // Sunday
    startHour: 17,
  },
  {
    name: '50 Chip Sunday PLO4 Championship — 3K GTD',
    type: 'mtt' as const,
    gameVariant: 'plo4',
    buyIn: 50,
    rake: 5,
    guarantee: 3000,
    startingStack: 15000,
    maxPlayers: 100,
    minPlayers: 15,
    horsesToRegister: 30,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 0,
    startHour: 19,
  },
  {
    name: '25 Chip PKO — Sunday Night Showdown',
    type: 'progressive_bounty' as const,
    gameVariant: 'nlh',
    buyIn: 25,
    rake: 2.5,
    guarantee: 1500,
    startingStack: 10000,
    maxPlayers: 100,
    minPlayers: 15,
    horsesToRegister: 30,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 0,
    startHour: 21,
  },
  {
    name: 'FREEROLL — Sunday Night Freebie (NLH)',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 0,
    rake: 0,
    guarantee: 200,
    startingStack: 3000,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 30,
    blindStructure: HYPER_TURBO_STRUCTURE,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: 0,
    startHour: 23,
  },

  // ─── DAILY RECURRING (EVERY DAY) ─────────────────────────────────────────
  {
    name: 'Daily Freeroll — NLH (Every Day)',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 0,
    rake: 0,
    guarantee: 50,
    startingStack: 2000,
    maxPlayers: 100,
    minPlayers: 6,
    horsesToRegister: 20,
    blindStructure: HYPER_TURBO_STRUCTURE,
    payoutStructure: PAYOUT_5_PLACES,
    dayOfWeek: -1, // -1 = every day
    startHour: 12,
  },
  {
    name: '10 Chip Daily Grinder — NLH 250 GTD',
    type: 'mtt' as const,
    gameVariant: 'nlh',
    buyIn: 10,
    rake: 1,
    guarantee: 250,
    startingStack: 5000,
    maxPlayers: 100,
    minPlayers: 10,
    horsesToRegister: 25,
    blindStructure: STANDARD_BLIND_STRUCTURE_10_LVL,
    payoutStructure: PAYOUT_9_PLACES,
    dayOfWeek: -1,
    startHour: 20,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SNG CONFIGS — ALL GAME TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const SNG_BLIND_6MAX = [
  { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 3 },
  { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 3 },
  { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 3 },
  { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 3 },
  { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 3 },
  { level: 6, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 2 },
  { level: 7, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 2 },
  { level: 8, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 2 },
];

const SNG_BLIND_9MAX = [
  { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 5 },
  { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 5 },
  { level: 3, smallBlind: 30, bigBlind: 60, ante: 5, durationMinutes: 5 },
  { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 4 },
  { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 4 },
  { level: 6, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 3 },
  { level: 7, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 3 },
  { level: 8, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 3 },
];

const SNG_CONFIGS = [
  // NLH SNGs
  {
    name: '5 Chip Turbo SNG 6-Max NLH',
    type: 'sng' as const,
    gameVariant: 'nlh',
    buyIn: 5,
    rake: 0.5,
    startingStack: 1500,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  {
    name: '10 Chip SNG 9-Max NLH',
    type: 'sng' as const,
    gameVariant: 'nlh',
    buyIn: 10,
    rake: 1.0,
    startingStack: 2000,
    maxPlayers: 9,
    minPlayers: 9,
    horsesToRegister: 9,
    blindStructure: SNG_BLIND_9MAX,
    payoutStructure: PAYOUT_3_PLACES,
  },
  {
    name: '25 Chip SNG 6-Max NLH',
    type: 'sng' as const,
    gameVariant: 'nlh',
    buyIn: 25,
    rake: 2.5,
    startingStack: 2000,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  // PLO4 SNGs
  {
    name: '5 Chip Turbo SNG 6-Max PLO4',
    type: 'sng' as const,
    gameVariant: 'plo4',
    buyIn: 5,
    rake: 0.5,
    startingStack: 1500,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  {
    name: '10 Chip SNG 6-Max PLO4',
    type: 'sng' as const,
    gameVariant: 'plo4',
    buyIn: 10,
    rake: 1.0,
    startingStack: 2000,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  // PLO5 SNGs
  {
    name: '10 Chip SNG 6-Max PLO5',
    type: 'sng' as const,
    gameVariant: 'plo5',
    buyIn: 10,
    rake: 1.0,
    startingStack: 2000,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  // PLO8 SNGs
  {
    name: '5 Chip SNG 9-Max PLO8',
    type: 'sng' as const,
    gameVariant: 'plo8',
    buyIn: 5,
    rake: 0.5,
    startingStack: 2000,
    maxPlayers: 9,
    minPlayers: 9,
    horsesToRegister: 9,
    blindStructure: SNG_BLIND_9MAX,
    payoutStructure: PAYOUT_3_PLACES,
  },
  // Pineapple SNGs
  {
    name: '5 Chip SNG 6-Max Pineapple',
    type: 'sng' as const,
    gameVariant: 'ofc_pineapple',
    buyIn: 5,
    rake: 0.5,
    startingStack: 1500,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: SNG_BLIND_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SPIN CONFIGS — ALL GAME TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const SPIN_BLIND_STRUCTURE = [
  { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 2 },
  { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 2 },
  { level: 3, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 2 },
  { level: 4, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 1 },
  { level: 5, smallBlind: 100, bigBlind: 200, ante: 0, durationMinutes: 1 },
];

const SPIN_MULTIPLIERS = [
  { multiplier: 2, weight: 75 },
  { multiplier: 3, weight: 15 },
  { multiplier: 5, weight: 7 },
  { multiplier: 10, weight: 2.5 },
  { multiplier: 25, weight: 0.4 },
  { multiplier: 100, weight: 0.1 },
];

const SPIN_CONFIGS = [
  // NLH Spins
  {
    name: '1 Chip Spin NLH',
    type: 'spin' as const,
    gameVariant: 'nlh',
    buyIn: 1,
    rake: 0.1,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '3 Chip Spin NLH',
    type: 'spin' as const,
    gameVariant: 'nlh',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '5 Chip Spin NLH',
    type: 'spin' as const,
    gameVariant: 'nlh',
    buyIn: 5,
    rake: 0.5,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '10 Chip Spin NLH',
    type: 'spin' as const,
    gameVariant: 'nlh',
    buyIn: 10,
    rake: 1.0,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  // PLO4 Spins
  {
    name: '3 Chip Spin PLO4',
    type: 'spin' as const,
    gameVariant: 'plo4',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '5 Chip Spin PLO4',
    type: 'spin' as const,
    gameVariant: 'plo4',
    buyIn: 5,
    rake: 0.5,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  // PLO5 Spins
  {
    name: '3 Chip Spin PLO5',
    type: 'spin' as const,
    gameVariant: 'plo5',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  // PLO8 Spins
  {
    name: '3 Chip Spin PLO8',
    type: 'spin' as const,
    gameVariant: 'plo8',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  // Pineapple Spins
  {
    name: '3 Chip Spin Pineapple',
    type: 'spin' as const,
    gameVariant: 'ofc_pineapple',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: SPIN_BLIND_STRUCTURE,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TABLE ENFORCEMENT CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_TABLES_PER_HORSE = 4;
// Soft allocation targets for testing: 2 cash + 2 tournament for max game variety.
// These are NOT hard limits — a horse CAN play 4 cash or 4 tournaments if needed.
const TARGET_CASH_TABLES = 2;
const TARGET_TOURNAMENT_TABLES = 2;

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

class HorseOrchestrator {
  private tables: Map<string, OrchestratorTable> = new Map();
  private startedAt: string | null = null;
  private isRunning = false;
  private handCount = 0;
  private totalRake = 0;
  private totalBBJ = 0;
  private errors: string[] = [];
  private horseTableAssignments: Map<string, Set<string>> = new Map(); // horseId -> tableIds

  // ─── MIDWAY UNION — both clubs are members ───────────────────────────────
  private unionId = 'fade0000-0000-0000-0000-000000000001'; // Midway Union
  private sharkClubId = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'; // Shark Club
  private jaqkClubId = 'a0000000-0000-0000-0000-000000000001'; // Club JAQK
  // Tables alternate between clubs for cross-club union settlement testing
  private clubIds: string[] = [];
  private clubIndex = 0;

  /** Round-robin club assignment for tables/tournaments */
  private getNextClubId(): string {
    const id = this.clubIds[this.clubIndex % this.clubIds.length] || this.sharkClubId;
    this.clubIndex++;
    return id;
  }

  /**
   * Ensure the Midway Union exists in Supabase and both clubs are attached.
   * This is idempotent — safe to call on every launch.
   */
  async ensureUnionSetup(): Promise<void> {
    console.debug('[Orchestrator] Ensuring Midway Union setup...');

    // 1. Upsert the union record (create if missing, no-op if exists)
    const { data: existingUnion, error: fetchErr } = await supabase
      .from('unions')
      .select('id')
      .eq('id', this.unionId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[Orchestrator] Failed to check union existence:', fetchErr);
    }

    if (!existingUnion) {
      console.debug('[Orchestrator] Midway Union not found — creating...');
      const { error: insertErr } = await supabase.from('unions').insert({
        id: this.unionId,
        name: MIDWAY_UNION.name,
        description: MIDWAY_UNION.description,
        owner_id: MIDWAY_UNION.ownerId,
        is_public: MIDWAY_UNION.isPublic,
        club_count: 2,
        member_count: 0,
        settings: {
          revenue_share_percent: MIDWAY_UNION.settings.revenueSharePercent,
          shared_player_pool: MIDWAY_UNION.settings.sharedPlayerPool,
          cross_club_tournaments: MIDWAY_UNION.settings.crossClubTournaments,
        },
      });

      if (insertErr) {
        console.error('[Orchestrator] Failed to create Midway Union:', insertErr);
        // Non-fatal: tables can still be created per-club
      } else {
        console.debug('[Orchestrator] Midway Union created successfully');

        // Add Dan as union_lead
        await supabase
          .from('union_admins')
          .upsert(
            {
              union_id: this.unionId,
              user_id: MIDWAY_UNION.ownerId,
              role: 'union_lead',
              permissions: { manageClubs: true, manageSettlements: true },
            },
            { onConflict: 'union_id,user_id' }
          )
          .then(({ error }) => {
            if (error) console.warn('[Orchestrator] union_admins upsert:', error.message);
          });
      }
    } else {
      console.debug('[Orchestrator] Midway Union already exists');
    }

    // 2. Ensure both clubs are attached to the union
    for (const clubId of [this.sharkClubId, this.jaqkClubId]) {
      const clubLabel = clubId === this.sharkClubId ? 'Shark Club' : 'Club JAQK';

      // Check if already in union_clubs
      const { data: existing } = await supabase
        .from('union_clubs')
        .select('club_id')
        .eq('union_id', this.unionId)
        .eq('club_id', clubId)
        .maybeSingle();

      if (!existing) {
        console.debug(`[Orchestrator] Attaching ${clubLabel} to Midway Union...`);
        const { error: attachErr } = await supabase.from('union_clubs').insert({
          union_id: this.unionId,
          club_id: clubId,
        });

        if (attachErr) {
          console.error(`[Orchestrator] Failed to attach ${clubLabel}:`, attachErr);
        } else {
          // Also set clubs.union_id for fast lookup
          await supabase.from('clubs').update({ union_id: this.unionId }).eq('id', clubId);
          console.debug(`[Orchestrator] ${clubLabel} attached to Midway Union`);
        }
      } else {
        // Ensure clubs.union_id is also set (belt-and-suspenders)
        await supabase.from('clubs').update({ union_id: this.unionId }).eq('id', clubId);
      }
    }

    // 3. Update union club_count from actual count
    const { count } = await supabase
      .from('union_clubs')
      .select('*', { count: 'exact', head: true })
      .eq('union_id', this.unionId);

    if (count !== null) {
      await supabase.from('unions').update({ club_count: count }).eq('id', this.unionId);
    }

    console.debug('[Orchestrator] Midway Union setup complete');
  }

  /** Launch the full orchestrator — ALL horses across ALL tables */
  async launch(
    configs: TableConfig[] = DEFAULT_TABLES
  ): Promise<{ success: boolean; tablesCreated: number; horsesSeated: number }> {
    if (this.isRunning) {
      console.error('[Orchestrator] Already running');
      return { success: false, tablesCreated: 0, horsesSeated: 0 };
    }

    this.isRunning = true;
    this.startedAt = new Date().toISOString();

    // Initialize dual-club round-robin for cross-club settlement testing
    this.clubIds = [this.sharkClubId, this.jaqkClubId];
    this.clubIndex = 0;

    console.debug(
      `[Orchestrator] Launching with ${configs.length} table configs across Shark Club + Club JAQK via Midway Union (${this.unionId})`
    );

    // Ensure the Midway Union exists and both clubs are attached
    await this.ensureUnionSetup();

    // Ensure horses are members of BOTH clubs
    await this.ensureHorsesInBothClubs();

    let tablesCreated = 0;
    let horsesSeated = 0;

    for (const config of configs) {
      try {
        // Alternate tables between clubs for cross-club union testing
        const clubId = this.getNextClubId();

        // Create table in Supabase under alternating clubs
        const { data: table, error } = await supabase
          .from('tables')
          .insert({
            club_id: clubId,
            name: config.name,
            game_type: 'cash',
            game_variant: config.gameVariant || 'nlh',
            stakes: `${config.smallBlind}/${config.bigBlind}`,
            small_blind: config.smallBlind,
            big_blind: config.bigBlind,
            min_buy_in: config.bigBlind * 40,
            max_buy_in: config.bigBlind * 200,
            max_players: config.maxPlayers,
            current_players: 0,
            status: 'active',
            settings: {
              straddle_enabled: true,
              straddle_type: 'utg',
              run_it_twice: false,
              bomb_pot_enabled: config.name.includes('Bomb'),
              bomb_pot_frequency: config.name.includes('Bomb') ? 10 : 0,
              bomb_pot_ante_bb: config.name.includes('Bomb') ? 2 : 0,
              time_bank_seconds: 30,
              auto_muck: true,
            },
          })
          .select()
          .maybeSingle();

        if (error) {
          this.logError(`Failed to create table "${config.name}": ${error.message}`);
          continue;
        }

        const tableId = table.id;
        this.tables.set(tableId, {
          tableId,
          name: config.name,
          smallBlind: config.smallBlind,
          bigBlind: config.bigBlind,
          maxPlayers: config.maxPlayers,
          horseCount: 0,
          handsPlayed: 0,
          totalRake: 0,
          totalBBJ: 0,
          status: 'seeding',
          errors: [],
        });

        tablesCreated++;

        // Seed horses onto table
        const seatedCount = await this.seedTableWithHorses(tableId, config);
        horsesSeated += seatedCount;

        // Mark table as running
        const tbl = this.tables.get(tableId);
        if (tbl) {
          tbl.status = 'running';
          tbl.horseCount = seatedCount;
        }

        console.debug(
          `[Orchestrator] Table "${config.name}" created: ${tableId} with ${seatedCount} horses`
        );
      } catch (err: any) {
        this.logError(`Table "${config.name}" creation error: ${err.message}`);
      }
    }

    // Launch today's tournaments (created with near-future start_time so DealerPage picks them up)
    try {
      const tournResult = await this.launchTodaysTournaments();
      console.debug(
        `[Orchestrator] Tournaments launched: ${tournResult.launched} tournaments, ${tournResult.totalRegistered} horses registered`
      );
    } catch (err: any) {
      this.logError(`Tournament launch failed: ${err.message}`);
    }

    // Start proactive 4-table allocation loop
    this.startAllocationLoop();

    // Broadcast launch event
    masterBus.emit('BALANCE_UPDATED', { source: 'orchestrator', tablesCreated, horsesSeated });

    console.debug(
      `[Orchestrator] Launch complete: ${tablesCreated} tables, ${horsesSeated} horses`
    );
    return { success: true, tablesCreated, horsesSeated };
  }

  /** Seed a table with horses from the fleet */
  private async seedTableWithHorses(tableId: string, config: TableConfig): Promise<number> {
    let seated = 0;
    const horses = await HydraService.getAvailableHorses(config.horsesPerTable);

    // Determine table type for multi-table enforcement
    const { data: tableData } = await supabase
      .from('tables')
      .select('type')
      .eq('id', tableId)
      .maybeSingle();
    const tableType = (tableData?.type === 'tournament' ? 'tournament' : 'cash') as
      | 'cash'
      | 'tournament';

    for (const horse of horses) {
      try {
        // Multi-table enforcement: check if horse can sit at another table
        const canSit = await this.canHorseSitAtTable(horse.id, tableType);
        if (!canSit) {
          console.error(
            `[Orchestrator] Horse ${horse.name} cannot sit at another ${tableType} table (limit reached)`
          );
          continue;
        }

        const buyIn = config.bigBlind * 100; // 100 BB

        // Insert seat
        const { error: seatError } = await supabase.from('table_seats').insert({
          table_id: tableId,
          user_id: horse.id,
          seat_number: seated + 1,
          stack: buyIn,
          is_sitting_out: false,
        });

        if (seatError) {
          console.error(`[Orchestrator] Failed to seat horse ${horse.name}: ${seatError.message}`);
          continue;
        }

        // Mark horse as seated
        await supabase.from('profiles').update({ horse_status: 'seated' }).eq('id', horse.id);

        await this.updateHorseTableAssignment(horse.id, tableId, true);

        seated++;
      } catch (err: any) {
        console.error(`[Orchestrator] Horse seating error: ${err.message}`);
      }
    }

    // Update table player count
    await supabase.from('tables').update({ current_players: seated }).eq('id', tableId);

    return seated;
  }

  /** Get today's scheduled tournaments based on day of week */
  getTodaysTournaments(): typeof TOURNAMENT_CONFIGS {
    const today = new Date().getDay(); // 0=Sunday, 1=Monday, etc.
    return TOURNAMENT_CONFIGS.filter(
      (t) => t.dayOfWeek === today || t.dayOfWeek === -1 // -1 = daily recurring
    );
  }

  /** Get this week's full tournament schedule */
  getWeeklySchedule(): { day: string; tournaments: typeof TOURNAMENT_CONFIGS }[] {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const schedule = days.map((day, i) => ({
      day,
      tournaments: TOURNAMENT_CONFIGS.filter((t) => t.dayOfWeek === i || t.dayOfWeek === -1),
    }));
    return schedule;
  }

  /** Create and register horses for a tournament */
  async launchTournament(
    configIndex: number = 0
  ): Promise<{ tournamentId: string | null; registered: number }> {
    const config = TOURNAMENT_CONFIGS[configIndex];
    if (!config) return { tournamentId: null, registered: 0 };

    try {
      // Set start_time to 10 seconds from now so DealerPage can discover and start it
      // (DealerPage discovers tournaments where start_time <= now AND current_players >= 2)
      const startTime = new Date(Date.now() + 10_000);

      // Map game variant to DB format (uppercase)
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo6: 'PLO6',
        plo8: 'PLO8',
        plo_hilo: 'PLO_HILO',
        ofc_pineapple: 'OFC_PINEAPPLE',
        short_deck: 'SHORT_DECK',
        flh: 'FLH',
        pineapple: 'PINEAPPLE',
        crazy_pineapple: 'CRAZY_PINEAPPLE',
        double_board: 'DOUBLE_BOARD',
        mixed: 'MIXED',
      };
      const dbGameType = gameTypeMap[config.gameVariant || 'nlh'] || 'NLH';

      // Create tournament in DB (using actual column names)
      const { data: tournament, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.getNextClubId(),
          name: config.name,
          game_type: dbGameType,
          variant: config.type === 'mtt' ? 'freezeout' : config.type, // freezeout/bounty/progressive_bounty/mystery_bounty
          buy_in_amount: config.buyIn,
          buy_in_fee: config.rake,
          guaranteed_prize: config.guarantee || 0,
          starting_chips: config.startingStack,
          max_players: config.maxPlayers,
          current_players: 0,
          status: 'ANNOUNCED',
          blind_structure: config.blindStructure,
          payout_structure: config.payoutStructure || [],
          start_time: startTime.toISOString(),
          late_reg_levels: 8,
          late_reg_mins: 8,
        })
        .select()
        .maybeSingle();

      if (error) {
        this.logError(`Tournament creation failed: ${error.message}`);
        return { tournamentId: null, registered: 0 };
      }

      // Register horses via tournament_players
      const horses = await HydraService.getAvailableHorses(config.horsesToRegister);
      let registered = 0;

      for (const horse of horses) {
        const { error: regError } = await supabase.from('tournament_players').insert({
          tournament_id: tournament.id,
          user_id: horse.id,
          username: horse.name,
          status: 'registered',
          chips: 0,
        });

        if (!regError) registered++;
      }

      // Update tournament player count
      const prizePool = Math.max(config.guarantee || 0, registered * config.buyIn);
      await supabase
        .from('tournaments')
        .update({
          current_players: registered,
          guaranteed_prize: prizePool,
          status: 'REGISTERING',
        })
        .eq('id', tournament.id);

      console.debug(
        `[Orchestrator] Tournament "${config.name}" created: ${tournament.id} — ${registered} horses, ${prizePool} prize pool (GTD: ${config.guarantee || 0})`
      );
      return { tournamentId: tournament.id, registered };
    } catch (err: any) {
      this.logError(`Tournament launch error: ${err.message}`);
      return { tournamentId: null, registered: 0 };
    }
  }

  /** Launch all of today's scheduled tournaments */
  async launchTodaysTournaments(): Promise<{ launched: number; totalRegistered: number }> {
    const todaysTournaments = this.getTodaysTournaments();
    let launched = 0;
    let totalRegistered = 0;

    console.debug(`[Orchestrator] Launching ${todaysTournaments.length} tournaments for today`);

    for (let i = 0; i < TOURNAMENT_CONFIGS.length; i++) {
      const config = TOURNAMENT_CONFIGS[i];
      const today = new Date().getDay();
      if (config.dayOfWeek !== today && config.dayOfWeek !== -1) continue;

      const result = await this.launchTournament(i);
      if (result.tournamentId) {
        launched++;
        totalRegistered += result.registered;
      }
    }

    console.debug(
      `[Orchestrator] Launched ${launched} tournaments, ${totalRegistered} horses registered`
    );
    return { launched, totalRegistered };
  }

  /** Create and fill a SNG table */
  async launchSNG(
    configIndex: number = 0
  ): Promise<{ tournamentId: string | null; registered: number }> {
    const config = SNG_CONFIGS[configIndex];
    if (!config) return { tournamentId: null, registered: 0 };

    try {
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo8: 'PLO8',
        ofc_pineapple: 'OFC_PINEAPPLE',
        short_deck: 'SHORT_DECK',
      };
      const dbGameType = gameTypeMap[config.gameVariant || 'nlh'] || 'NLH';

      const { data: sng, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.getNextClubId(),
          name: config.name,
          game_type: dbGameType,
          variant: 'SNG',
          buy_in_amount: config.buyIn,
          buy_in_fee: config.rake,
          guaranteed_prize: null,
          starting_chips: config.startingStack,
          max_players: config.maxPlayers,
          current_players: 0,
          status: 'REGISTERING',
          blind_structure: config.blindStructure,
          payout_structure: config.payoutStructure || [],
          late_reg_levels: 0,
          late_reg_mins: 0,
          start_time: new Date(Date.now() + 10_000).toISOString(), // Start 10s from now
        })
        .select()
        .maybeSingle();

      if (error) {
        this.logError(`SNG creation failed: ${error.message}`);
        return { tournamentId: null, registered: 0 };
      }

      const horses = await HydraService.getAvailableHorses(config.horsesToRegister);
      let registered = 0;

      for (const horse of horses) {
        const { error: regError } = await supabase.from('tournament_players').insert({
          tournament_id: sng.id,
          user_id: horse.id,
          username: horse.name,
          status: 'registered',
          chips: 0,
        });
        if (!regError) registered++;
      }

      const prizePool = registered * config.buyIn;
      await supabase
        .from('tournaments')
        .update({
          current_players: registered,
          guaranteed_prize: prizePool,
          status: 'REGISTERING', // DealerPage discovers REGISTERING tournaments and starts them via TournamentEngine
        })
        .eq('id', sng.id);

      console.debug(
        `[Orchestrator] SNG "${config.name}" created: ${sng.id} with ${registered} horses`
      );
      return { tournamentId: sng.id, registered };
    } catch (err: any) {
      this.logError(`SNG launch error: ${err.message}`);
      return { tournamentId: null, registered: 0 };
    }
  }

  /** Launch ALL SNG configs */
  async launchAllSNGs(): Promise<{ launched: number; totalRegistered: number }> {
    let launched = 0;
    let totalRegistered = 0;

    for (let i = 0; i < SNG_CONFIGS.length; i++) {
      const result = await this.launchSNG(i);
      if (result.tournamentId) {
        launched++;
        totalRegistered += result.registered;
      }
    }

    console.debug(`[Orchestrator] Launched ${launched} SNGs, ${totalRegistered} horses registered`);
    return { launched, totalRegistered };
  }

  /** Create a Spin & Go with random multiplier */
  async launchSpin(
    configIndex: number = 0
  ): Promise<{ tournamentId: string | null; registered: number; multiplier: number }> {
    const config = SPIN_CONFIGS[configIndex];
    if (!config) return { tournamentId: null, registered: 0, multiplier: 0 };

    // Roll multiplier
    const multiplier = this.rollSpinMultiplier(config.spinMultipliers);
    const prizePool = config.buyIn * config.horsesToRegister * multiplier;

    try {
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo8: 'PLO8',
        ofc_pineapple: 'OFC_PINEAPPLE',
        short_deck: 'SHORT_DECK',
      };
      const dbGameType = gameTypeMap[config.gameVariant || 'nlh'] || 'NLH';

      const { data: spin, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.getNextClubId(),
          name: `${config.name} (${multiplier}x)`,
          game_type: dbGameType,
          variant: 'SPIN',
          buy_in_amount: config.buyIn,
          buy_in_fee: config.rake,
          guaranteed_prize: prizePool,
          starting_chips: config.startingStack,
          max_players: config.maxPlayers,
          current_players: 0,
          status: 'REGISTERING',
          blind_structure: config.blindStructure,
          payout_structure: [{ place: 1, percentage: 100 }],
          late_reg_levels: 0,
          late_reg_mins: 0,
          start_time: new Date(Date.now() + 10_000).toISOString(),
        })
        .select()
        .maybeSingle();

      if (error) {
        this.logError(`Spin creation failed: ${error.message}`);
        return { tournamentId: null, registered: 0, multiplier };
      }

      const horses = await HydraService.getAvailableHorses(config.horsesToRegister);
      let registered = 0;

      for (const horse of horses) {
        const { error: regError } = await supabase.from('tournament_players').insert({
          tournament_id: spin.id,
          user_id: horse.id,
          username: horse.name,
          status: 'registered',
          chips: 0,
        });
        if (!regError) registered++;
      }

      await supabase
        .from('tournaments')
        .update({
          current_players: registered,
          status: 'REGISTERING',
        })
        .eq('id', spin.id);

      console.debug(
        `[Orchestrator] Spin "${config.name}" (${multiplier}x = ${prizePool}) created with ${registered} horses`
      );
      return { tournamentId: spin.id, registered, multiplier };
    } catch (err: any) {
      this.logError(`Spin launch error: ${err.message}`);
      return { tournamentId: null, registered: 0, multiplier: 0 };
    }
  }

  /** Launch ALL Spin configs */
  async launchAllSpins(): Promise<{ launched: number; totalRegistered: number }> {
    let launched = 0;
    let totalRegistered = 0;

    for (let i = 0; i < SPIN_CONFIGS.length; i++) {
      const result = await this.launchSpin(i);
      if (result.tournamentId) {
        launched++;
        totalRegistered += result.registered;
      }
    }

    console.debug(
      `[Orchestrator] Launched ${launched} Spins, ${totalRegistered} horses registered`
    );
    return { launched, totalRegistered };
  }

  /** FULL LAUNCH — Cash games + Today's tournaments + All SNGs + All Spins */
  async launchEverything(): Promise<{
    cashTables: number;
    cashHorses: number;
    tournaments: number;
    tournamentHorses: number;
    sngs: number;
    sngHorses: number;
    spins: number;
    spinHorses: number;
  }> {
    console.debug('═══════════════════════════════════════════════════════════════');
    console.debug('[Orchestrator] 🐎 LAUNCHING EVERYTHING — FULL FLEET DEPLOYMENT');
    console.debug('═══════════════════════════════════════════════════════════════');

    // 1. Cash games + today's tournaments (launch() now includes launchTodaysTournaments())
    const cashResult = await this.launch();

    // 2. All SNGs
    const sngResult = await this.launchAllSNGs();

    // 3. All Spins
    const spinResult = await this.launchAllSpins();

    // Count today's tournaments (already launched inside launch())
    const todaysCount = this.getTodaysTournaments().length;

    const summary = {
      cashTables: cashResult.tablesCreated,
      cashHorses: cashResult.horsesSeated,
      tournaments: todaysCount,
      tournamentHorses: 0, // Already counted in launch()
      sngs: sngResult.launched,
      sngHorses: sngResult.totalRegistered,
      spins: spinResult.launched,
      spinHorses: spinResult.totalRegistered,
    };

    const totalHorses =
      summary.cashHorses + summary.tournamentHorses + summary.sngHorses + summary.spinHorses;

    console.debug('═══════════════════════════════════════════════════════════════');
    console.debug(`[Orchestrator] LAUNCH COMPLETE:`);
    console.debug(`  Cash Tables: ${summary.cashTables} (${summary.cashHorses} horses)`);
    console.debug(`  Tournaments: ${summary.tournaments} (${summary.tournamentHorses} horses)`);
    console.debug(`  SNGs:        ${summary.sngs} (${summary.sngHorses} horses)`);
    console.debug(`  Spins:       ${summary.spins} (${summary.spinHorses} horses)`);
    console.debug(
      `  TOTAL:       ${totalHorses} horse seats across ${summary.cashTables + summary.tournaments + summary.sngs + summary.spins} games`
    );
    console.debug('═══════════════════════════════════════════════════════════════');

    return summary;
  }

  /** Roll weighted random multiplier for Spin */
  private rollSpinMultiplier(multipliers: { multiplier: number; weight: number }[]): number {
    if (!multipliers || multipliers.length === 0) return 1;
    const totalWeight = multipliers.reduce((sum, m) => sum + m.weight, 0);
    if (totalWeight <= 0) return multipliers[0].multiplier;
    let roll = Math.random() * totalWeight;
    for (const m of multipliers) {
      roll -= m.weight;
      if (roll <= 0) return m.multiplier;
    }
    return multipliers[0].multiplier;
  }

  /** Record a completed hand's rake data */
  recordHandComplete(tableId: string, rakeAmount: number, bbjAmount: number): void {
    this.handCount++;
    this.totalRake += rakeAmount;
    this.totalBBJ += bbjAmount;

    const table = this.tables.get(tableId);
    if (table) {
      table.handsPlayed++;
      table.totalRake += rakeAmount;
      table.totalBBJ += bbjAmount;
    }
  }

  /** Get orchestrator statistics */
  getStats(): OrchestratorStats {
    const uptimeMs = this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0;
    const uptimeMin = uptimeMs / 60000;

    return {
      totalHorses: Array.from(this.tables.values()).reduce((sum, t) => sum + t.horseCount, 0),
      totalTables: this.tables.size,
      totalHandsPlayed: this.handCount,
      totalRakeCollected: Math.trunc(this.totalRake * 100) / 100,
      totalBBJCollected: Math.trunc(this.totalBBJ * 100) / 100,
      handsPerMinute: uptimeMin > 0 ? Math.round((this.handCount / uptimeMin) * 10) / 10 : 0,
      errors: this.errors.slice(-20), // Last 20 errors
      uptime: Math.round(uptimeMs / 1000),
      startedAt: this.startedAt || '',
    };
  }

  /** Get all table statuses */
  getTableStatuses(): OrchestratorTable[] {
    return Array.from(this.tables.values());
  }

  /** Stop all tables and release horses */
  async shutdown(): Promise<void> {
    console.debug('[Orchestrator] Shutting down...');
    this.isRunning = false;
    this.stopAllocationLoop();

    for (const [tableId, table] of this.tables) {
      table.status = 'stopping';

      // Soft-delete all seats (mark as left)
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .is('left_at', null);

      // Close table
      await supabase
        .from('tables')
        .update({ status: 'closed', current_players: 0 })
        .eq('id', tableId);

      // Reset ALL horse statuses to available on shutdown (not just 'seated')
      await supabase
        .from('profiles')
        .update({ horse_status: 'available' })
        .eq('is_horse', true)
        .neq('horse_status', 'available');

      table.status = 'stopped';
    }

    console.debug(
      `[Orchestrator] Shutdown complete. ${this.handCount} hands played, ${this.totalRake.toFixed(2)} rake collected`
    );
  }

  /**
   * Check if a horse can sit at a table based on multi-table limits
   * MAX_TABLES_PER_HORSE = 4 total (2 cash + 2 tournament max)
   */
  async canHorseSitAtTable(horseId: string, _tableType: 'cash' | 'tournament'): Promise<boolean> {
    try {
      const activeTables = await this.getActiveTablesForHorse(horseId);

      // Only enforce the 4-total limit. Horses can play any mix of cash/tournament.
      if (activeTables.length >= MAX_TABLES_PER_HORSE) {
        console.error(
          `[Orchestrator] Horse ${horseId} already at ${activeTables.length} tables (max: ${MAX_TABLES_PER_HORSE})`
        );
        return false;
      }

      return true;
    } catch (err: any) {
      this.logError(`canHorseSitAtTable error for ${horseId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Track horse table assignment in memory for fast lookups
   */
  private updateHorseTableAssignment(horseId: string, tableId: string, add: boolean): void {
    if (add) {
      if (!this.horseTableAssignments.has(horseId)) {
        this.horseTableAssignments.set(horseId, new Set());
      }
      this.horseTableAssignments.get(horseId)!.add(tableId);
    } else {
      this.horseTableAssignments.get(horseId)?.delete(tableId);
    }
  }

  /**
   * Get all active tables where a horse is currently seated
   */
  private async getActiveTablesForHorse(
    horseId: string
  ): Promise<Array<{ tableId: string; type: 'cash' | 'tournament' }>> {
    try {
      // Get table_seats where horse is active (not left)
      const { data: seats, error: seatsError } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', horseId)
        .is('left_at', null);

      if (seatsError || !seats) {
        return [];
      }

      const tableIds = seats.map((s) => s.table_id);
      if (tableIds.length === 0) return [];

      // Get table info to determine type
      const { data: tables, error: tableError } = await supabase
        .from('tables')
        .select('id, type')
        .in('id', tableIds);

      if (tableError || !tables) {
        return [];
      }

      return tables.map((t) => ({
        tableId: t.id,
        type: (t.type === 'tournament' ? 'tournament' : 'cash') as 'cash' | 'tournament',
      }));
    } catch (err: any) {
      this.logError(`getActiveTablesForHorse error for ${horseId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Activate all horses for a given club
   */
  async activateAllHorses(clubId: string): Promise<{ activated: number; errors: string[] }> {
    try {
      const { data: horses, error: horsesError } = await supabase
        .from('profiles')
        .select('id, display_name')
        .eq('is_horse', true)
        .limit(300);

      if (horsesError || !horses?.length) {
        const error = `Failed to fetch horses: ${horsesError?.message || 'No horses found'}`;
        this.logError(error);
        return { activated: 0, errors: [error] };
      }

      console.debug(`[Orchestrator] Activating ${horses.length} horses for club ${clubId}...`);

      const errors: string[] = [];
      let activated = 0;

      // Batch update in groups of 50
      for (let i = 0; i < horses.length; i += 50) {
        const batch = horses.slice(i, i + 50);
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ horse_status: 'active' })
          .in(
            'id',
            batch.map((h) => h.id)
          );

        if (updateError) {
          const msg = `Failed to activate batch: ${updateError.message}`;
          errors.push(msg);
          this.logError(msg);
        } else {
          activated += batch.length;
        }
      }

      console.debug(
        `[Orchestrator] Activated ${activated}/${horses.length} horses for club ${clubId}`
      );
      return { activated, errors };
    } catch (err: any) {
      const error = `activateAllHorses error: ${err.message}`;
      this.logError(error);
      return { activated: 0, errors: [error] };
    }
  }

  /**
   * Ensure ALL 100 horses are members of BOTH Shark Club AND Club JAQK.
   * This enables cross-club union settlement testing — each horse plays in
   * both clubs and their stats/ledgers are tracked independently per club.
   */
  private async ensureHorsesInBothClubs(): Promise<void> {
    try {
      // Get all horse profile IDs
      const { data: horses, error: horsesError } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('is_horse', true)
        .limit(200);

      if (horsesError || !horses?.length) {
        this.logError(`Failed to fetch horses: ${horsesError?.message || 'No horses found'}`);
        return;
      }

      console.debug(`[Orchestrator] Ensuring ${horses.length} horses are members of both clubs...`);

      const clubIds = [this.sharkClubId, this.jaqkClubId];
      let membershipsCreated = 0;

      for (const clubId of clubIds) {
        // Get existing members for this club
        const { data: existing } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', await resolveClubUUID(clubId));

        const existingIds = new Set((existing || []).map((m: any) => m.user_id));

        // Find horses not yet in this club
        const missing = horses.filter((h) => !existingIds.has(h.id));

        if (missing.length === 0) {
          console.debug(`[Orchestrator] All horses already in club ${clubId}`);
          continue;
        }

        // Batch insert missing memberships
        const rows = missing.map((h) => ({
          club_id: clubId,
          user_id: h.id,
          role: 'player',
          status: 'active',
        }));

        // Insert in batches of 50 to avoid payload limits
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error: insertError } = await supabase
            .from('club_members')
            .upsert(batch, { onConflict: 'club_id,user_id', ignoreDuplicates: true });

          if (insertError) {
            // If upsert fails (e.g. no unique constraint), try individual inserts
            for (const row of batch) {
              const { error: singleError } = await supabase.from('club_members').insert(row);
              if (!singleError) membershipsCreated++;
              // Ignore duplicate key errors silently
            }
          } else {
            membershipsCreated += batch.length;
          }
        }

        console.debug(`[Orchestrator] Added ${missing.length} horses to club ${clubId}`);
      }

      // Update member counts on both clubs (exclude horses from visible count)
      for (const clubId of clubIds) {
        // NOTE: No FK between club_members and profiles — count all members directly.
        // Horse filtering requires a separate profiles query (future enhancement).
        const { count } = await supabase
          .from('club_members')
          .select('user_id', { count: 'exact', head: true })
          .eq('club_id', await resolveClubUUID(clubId));

        if (count !== null) {
          await supabase.from('clubs').update({ member_count: count }).eq('id', clubId);
        }
      }

      console.debug(
        `[Orchestrator] Cross-club membership complete: ${membershipsCreated} new memberships created`
      );
    } catch (err: any) {
      this.logError(`ensureHorsesInBothClubs error: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROACTIVE 4-TABLE ALLOCATION — ensures horses always play 2 cash + 2 tourney
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Proactively ensure all active horses are seated at their target of 4 tables:
   *   - 2 cash games
   *   - 2 tournaments
   * Runs on a 60-second interval. For each under-allocated horse, finds
   * available seats at cash tables and registers for upcoming tournaments.
   */
  async ensureHorsesAt4Tables(): Promise<{
    horsesAdjusted: number;
    cashSeats: number;
    tournamentRegs: number;
  }> {
    let horsesAdjusted = 0;
    let cashSeats = 0;
    let tournamentRegs = 0;

    try {
      // 1. Get all active horses
      const { data: horses, error: horsesError } = await supabase
        .from('profiles')
        .select('id, display_name')
        .eq('is_horse', true)
        .in('horse_status', ['active', 'seated'])
        .limit(350);

      if (horsesError || !horses?.length) return { horsesAdjusted, cashSeats, tournamentRegs };

      // 2. Get all active cash tables with available seats
      const { data: cashTables } = await supabase
        .from('tables')
        .select('id, max_players, current_players, small_blind, big_blind')
        .eq('status', 'active')
        .neq('game_type', 'tournament')
        .order('current_players', { ascending: true });

      // 3. Get registering tournaments with available spots
      const { data: regTournaments } = await supabase
        .from('tournaments')
        .select('id, name, max_players, current_players, club_id')
        .in('status', ['REGISTERING', 'LATE_REG'])
        .order('start_time', { ascending: true })
        .limit(20);

      // 4. For each horse, check allocation and fill gaps
      for (const horse of horses) {
        try {
          const activeTables = await this.getActiveTablesForHorse(horse.id);
          const cashCount = activeTables.filter((t) => t.type === 'cash').length;
          const tourneyCount = activeTables.filter((t) => t.type === 'tournament').length;

          // Skip if already at 4 tables total
          if (activeTables.length >= MAX_TABLES_PER_HORSE) continue;

          let adjusted = false;

          // Fill cash game seats (target: 2 for variety)
          if (cashCount < TARGET_CASH_TABLES && cashTables?.length) {
            const needed = TARGET_CASH_TABLES - cashCount;
            for (let i = 0; i < needed; i++) {
              // Find a table with an empty seat where horse isn't already sitting
              const currentTableIds = new Set(activeTables.map((t) => t.tableId));
              const availableTable = cashTables.find(
                (t) => !currentTableIds.has(t.id) && (t.current_players || 0) < t.max_players
              );
              if (!availableTable) break;

              // Get next open seat number
              const { data: existingSeats } = await supabase
                .from('table_seats')
                .select('seat_number')
                .eq('table_id', availableTable.id)
                .is('left_at', null);
              const takenSeats = new Set((existingSeats || []).map((s) => s.seat_number));
              let seatNumber = 1;
              while (takenSeats.has(seatNumber) && seatNumber <= availableTable.max_players)
                seatNumber++;
              if (seatNumber > availableTable.max_players) continue;

              const buyIn = (availableTable.big_blind || 1) * 100;
              const { error: seatError } = await supabase.from('table_seats').insert({
                table_id: availableTable.id,
                user_id: horse.id,
                seat_number: seatNumber,
                stack: buyIn,
                is_sitting_out: false,
              });
              if (!seatError) {
                // Authoritative recount (prevents race if multiple horses seat concurrently)
                const { count: cashCount, error: cashCountErr } = await supabase
                  .from('table_seats')
                  .select('*', { count: 'exact', head: true })
                  .eq('table_id', availableTable.id)
                  .is('left_at', null);
                if (!cashCountErr) {
                  const freshCashCount = cashCount ?? 0;
                  await supabase
                    .from('tables')
                    .update({ current_players: freshCashCount })
                    .eq('id', availableTable.id);
                  availableTable.current_players = freshCashCount;
                } else {
                  // Fallback: increment locally to keep loop consistent
                  availableTable.current_players = (availableTable.current_players || 0) + 1;
                }
                this.updateHorseTableAssignment(horse.id, availableTable.id, true);
                cashSeats++;
                adjusted = true;
              }
            }
          }

          // Fill tournament seats (target: 2 for variety)
          if (tourneyCount < TARGET_TOURNAMENT_TABLES && regTournaments?.length) {
            const needed = TARGET_TOURNAMENT_TABLES - tourneyCount;
            for (let i = 0; i < needed; i++) {
              // Check which tournaments horse is already registered for
              const { data: existingRegs } = await supabase
                .from('tournament_players')
                .select('tournament_id')
                .eq('user_id', horse.id)
                .in('status', ['registered', 'playing']);
              const registeredIds = new Set((existingRegs || []).map((r) => r.tournament_id));

              const availableTourney = regTournaments.find(
                (t) => !registeredIds.has(t.id) && (t.current_players || 0) < (t.max_players || 999)
              );
              if (!availableTourney) break;

              // Register horse for the tournament
              const { error: regError } = await supabase.from('tournament_players').insert({
                tournament_id: availableTourney.id,
                user_id: horse.id,
                status: 'registered',
                chips: 0,
                buy_in_amount: 0, // Horses play free
              });
              if (!regError) {
                // Authoritative recount (prevents race with concurrent registrations)
                const { count: regCount, error: regCountErr } = await supabase
                  .from('tournament_players')
                  .select('*', { count: 'exact', head: true })
                  .eq('tournament_id', availableTourney.id)
                  .in('status', ['registered', 'playing']);
                if (!regCountErr) {
                  const freshRegCount = regCount ?? 0;
                  await supabase
                    .from('tournaments')
                    .update({ current_players: freshRegCount })
                    .eq('id', availableTourney.id);
                  availableTourney.current_players = freshRegCount;
                } else {
                  // Fallback: increment locally to keep loop consistent
                  availableTourney.current_players = (availableTourney.current_players || 0) + 1;
                }
                tournamentRegs++;
                adjusted = true;
              }
            }
          }

          if (adjusted) {
            horsesAdjusted++;
            // Update horse status to seated if they were just 'active'
            await supabase.from('profiles').update({ horse_status: 'seated' }).eq('id', horse.id);
          }
        } catch (err: any) {
          // Continue to next horse on error
          console.error(
            `[Orchestrator] ensureHorsesAt4Tables error for ${horse.display_name}: ${err.message}`
          );
        }
      }

      if (horsesAdjusted > 0) {
        console.debug(
          `[Orchestrator] 4-table allocation: adjusted ${horsesAdjusted} horses (+${cashSeats} cash seats, +${tournamentRegs} tourney regs)`
        );
      }
    } catch (err: any) {
      this.logError(`ensureHorsesAt4Tables error: ${err.message}`);
    }

    return { horsesAdjusted, cashSeats, tournamentRegs };
  }

  /**
   * Start the proactive allocation loop (60-second interval)
   */
  private allocationInterval: ReturnType<typeof setInterval> | null = null;

  startAllocationLoop(): void {
    if (this.allocationInterval) return;
    console.debug('[Orchestrator] Starting proactive allocation loop (60s interval)');
    // Run immediately, then every 60 seconds
    const runAllocationCycle = async () => {
      await this.ensureHorsesAt4Tables();
      await this.enforceMinimumPlayers();
      await this.dynamicPersonaRotation();
      // Enhancement #10: Track horse fleet performance
      await this.trackHorsePerformance();
    };
    runAllocationCycle();
    this.allocationInterval = setInterval(() => {
      runAllocationCycle();
    }, 60_000);
  }

  stopAllocationLoop(): void {
    if (this.allocationInterval) {
      clearInterval(this.allocationInterval);
      this.allocationInterval = null;
      console.debug('[Orchestrator] Stopped proactive 4-table allocation loop');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PHASE 3: 3-PLAYER MINIMUM ENFORCEMENT (Hydra Law)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Enforce the Hydra 3-Player Minimum Law:
   * ANY table with < 3 players triggers at least 3 horses as action seeds.
   */
  async enforceMinimumPlayers(): Promise<{ tablesSeeded: number; horsesAdded: number }> {
    let tablesSeeded = 0;
    let horsesAdded = 0;
    const MIN_PLAYERS = 3;

    try {
      // Find all active tables
      const { data: tables, error } = await supabase
        .from('tables')
        .select('id, big_blind, max_players')
        .is('is_deleted', false)
        .neq('status', 'closed')
        .is('tournament_id', null);

      if (error || !tables) return { tablesSeeded, horsesAdded };

      for (const table of tables) {
        // Count current players (real + horses)
        const { count } = await supabase
          .from('table_seats')
          .select('id', { count: 'exact', head: true })
          .eq('table_id', table.id)
          .eq('status', 'active')
          .is('left_at', null);

        const currentPlayers = count || 0;
        if (currentPlayers < MIN_PLAYERS) {
          const needed = MIN_PLAYERS - currentPlayers;
          try {
            // Enhancement #8: Use smart seat selection for each horse
            const optimalSeat = await this.smartSeatSelection(table.id, table.max_players || 9);
            console.debug(
              `[Orchestrator] SmartSeat: optimal seat ${optimalSeat} at table ${table.id}`
            );
            // seedTable manages the horse count internally; call once per table
            for (let n = 0; n < needed; n++) {
              await HydraService.seedTable(table.id, table.big_blind);
            }
            tablesSeeded++;
            horsesAdded += needed;
            console.debug(
              `[Orchestrator] 3-Player Minimum: seeded ${needed} horses at table ${table.id} (had ${currentPlayers})`
            );

            // Emit bus event for each horse seated
            try {
              masterBus.emit('HORSE_SEATED', {
                tableId: table.id,
                horseId: 'batch',
                horseName: `${needed} horses seeded`,
              });
            } catch (err) {
              console.error('[HorseOrchestrator] Error:', err);
              /* best effort */
            }
          } catch (err: any) {
            this.logError(`enforceMinimumPlayers seed failed for ${table.id}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      this.logError(`enforceMinimumPlayers error: ${err.message}`);
    }

    return { tablesSeeded, horsesAdded };
  }

  /**
   * Smart Seat Selection: Horses prefer empty seats adjacent to real players.
   * This creates a more natural table feel instead of clumping horses together.
   * Returns the optimal seat number for a new horse at the given table.
   */
  async smartSeatSelection(tableId: string, maxPlayers: number): Promise<number> {
    try {
      const { data: players } = await supabase
        .from('table_seats')
        .select('seat_number, horse_id')
        .eq('table_id', tableId)
        .eq('status', 'active')
        .is('left_at', null);

      if (!players || players.length === 0) return 1; // Empty table, seat 1

      const occupied = new Set(players.map((p) => p.seat_number));
      const realPlayerSeats = players.filter((p) => !p.horse_id).map((p) => p.seat_number);

      // Score each empty seat based on adjacency to real players
      let bestSeat = 1;
      let bestScore = -1;

      for (let seat = 1; seat <= maxPlayers; seat++) {
        if (occupied.has(seat)) continue;

        let score = 0;
        for (const realSeat of realPlayerSeats) {
          // Higher score for seats closer to real players (circular distance)
          const dist = Math.min(Math.abs(seat - realSeat), maxPlayers - Math.abs(seat - realSeat));
          if (dist === 1)
            score += 3; // Adjacent = highest priority
          else if (dist === 2) score += 1; // 2 away = some bonus
        }

        if (score > bestScore) {
          bestScore = score;
          bestSeat = seat;
        }
      }

      return bestSeat;
    } catch (err) {
      console.error('[HorseOrchestrator] Error:', err);
      // Fallback: return first available seat
      return 1;
    }
  }

  /**
   * Dynamic Persona Rotation: Every 30 minutes, rotate the display_name and
   * avatar of horses that have been seated for > 30 min. This prevents
   * pattern recognition by observant players.
   */
  async dynamicPersonaRotation(): Promise<number> {
    let rotated = 0;
    const ROTATION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    try {
      // Find horses that have been seated for > 30 minutes
      const cutoff = new Date(Date.now() - ROTATION_THRESHOLD_MS).toISOString();
      const { data: staleHorses } = await supabase
        .from('table_seats')
        .select('id, user_id, table_id')
        .not('horse_id', 'is', null)
        .eq('status', 'active')
        .lt('joined_at', cutoff);

      if (!staleHorses || staleHorses.length === 0) return 0;

      // Load available player profiles
      const { data: availableHorses } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .eq('is_horse', true)
        .eq('horse_status', 'available')
        .limit(staleHorses.length);

      if (!availableHorses || availableHorses.length === 0) return 0;

      // Swap personas: each stale horse gets a fresh persona
      for (let i = 0; i < Math.min(staleHorses.length, availableHorses.length); i++) {
        const stale = staleHorses[i];
        const fresh = availableHorses[i];

        // Mark old horse as available
        await supabase
          .from('profiles')
          .update({ horse_status: 'available' })
          .eq('id', stale.user_id);

        // Seat new horse in same position
        await supabase
          .from('table_seats')
          .update({ user_id: fresh.id, joined_at: new Date().toISOString() })
          .eq('id', stale.id);

        // Mark new horse as seated
        await supabase.from('profiles').update({ horse_status: 'seated' }).eq('id', fresh.id);

        rotated++;

        try {
          masterBus.emit('HORSE_REMOVED', {
            tableId: stale.table_id,
            horseId: stale.user_id,
            reason: 'persona_rotation',
          });
          masterBus.emit('HORSE_SEATED', {
            tableId: stale.table_id,
            horseId: fresh.id,
            horseName: fresh.display_name || 'Horse',
          });
        } catch (err) {
          console.error('[HorseOrchestrator] Error:', err);
          /* best effort */
        }
      }

      if (rotated > 0) {
        console.debug(`[Orchestrator] Persona rotation: swapped ${rotated} player profiles`);
      }
    } catch (err: any) {
      this.logError(`dynamicPersonaRotation error: ${err.message}`);
    }

    return rotated;
  }

  private logError(msg: string): void {
    console.error(`[Orchestrator] ${msg}`);
    this.errors.push(`${new Date().toISOString()} - ${msg}`);
  }

  /**
   * Enhancement #10: Track horse fleet performance.
   * Queries total wins/losses for horse accounts and logs periodic stats.
   * Emits data via console for admin observability.
   */
  private async trackHorsePerformance(): Promise<void> {
    try {
      // Count total active horse seats
      const { count: seatedCount } = await supabase
        .from('table_seats')
        .select('id', { count: 'exact', head: true })
        .not('horse_id', 'is', null)
        .eq('status', 'active')
        .is('left_at', null);

      // Count horse wins in recent hands (last 100 hands across all tables)
      const { data: recentHands } = await supabase
        .from('hand_results')
        .select('winner_id, pot_size')
        .order('created_at', { ascending: false })
        .limit(100);

      if (recentHands && recentHands.length > 0) {
        // Look up which winners are horses
        const winnerIds = [...new Set(recentHands.map((h) => h.winner_id).filter(Boolean))];
        const { data: horseProfiles } = await supabase
          .from('profiles')
          .select('id')
          .eq('is_horse', true)
          .in('id', winnerIds);

        const horseIdSet = new Set((horseProfiles || []).map((p) => p.id));
        const horseWins = recentHands.filter((h) => horseIdSet.has(h.winner_id));
        const totalPotWon = horseWins.reduce((acc, h) => acc + (h.pot_size || 0), 0);
        const winRate =
          recentHands.length > 0 ? Math.round((horseWins.length / recentHands.length) * 100) : 0;

        console.debug(
          `[Orchestrator] Horse Fleet: ${seatedCount || 0} seated, ` +
            `${horseWins.length}/${recentHands.length} recent wins (${winRate}%), ` +
            `$${totalPotWon.toLocaleString()} total pots won`
        );
      }
    } catch (err: any) {
      // Non-critical; silently fail
      console.debug(`[Orchestrator] Performance tracking skipped: ${err.message}`);
    }
  }
}

// Singleton
export const horseOrchestrator = new HorseOrchestrator();
export { DEFAULT_TABLES, TOURNAMENT_CONFIGS, SNG_CONFIGS, SPIN_CONFIGS };
export type { OrchestratorTable, OrchestratorStats, TableConfig };

/**
 * Standalone helper — ensure the Midway Union exists and both clubs are attached.
 * Can be called independently (from admin panel, browser console, etc.)
 * without launching the full orchestrator.
 */
export async function ensureMidwayUnionSetup(): Promise<boolean> {
  try {
    await horseOrchestrator.ensureUnionSetup();
    console.log('[MidwayUnion] Setup verified — union exists, both clubs attached');
    return true;
  } catch (err) {
    console.error('[MidwayUnion] Setup failed:', err);
    return false;
  }
}

// Expose on window for admin/debug access
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ensureMidwayUnionSetup = ensureMidwayUnionSetup;
}
