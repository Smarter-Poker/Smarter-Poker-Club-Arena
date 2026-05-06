/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT RECURRING SERVICE — 24/7 Automated Tournament Schedule
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs server-side to ensure tournaments run continuously:
 * - Checks every 5 minutes for tournament availability
 * - Creates new tournaments when previous ones finish
 * - Runs different tournament types at different times (24/7 coverage)
 * - Registers available horses automatically
 * - Handles SNGs and Spins on continuous loops
 *
 * ZERO browser dependency — this is the SERVER version.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TournamentConfig {
  name: string;
  type: 'mtt' | 'bounty' | 'progressive_bounty' | 'mystery_bounty';
  gameVariant: string;
  buyIn: number;
  rake: number;
  guarantee: number;
  startingStack: number;
  maxPlayers: number;
  minPlayers: number;
  horsesToRegister: number;
  blindStructure: any[];
  payoutStructure: any[];
  bountyPercent?: number;
}

interface SNGConfig {
  name: string;
  type: 'sng';
  gameVariant: string;
  buyIn: number;
  rake: number;
  startingStack: number;
  maxPlayers: number;
  minPlayers: number;
  horsesToRegister: number;
  blindStructure: any[];
  payoutStructure: any[];
}

interface SpinConfig {
  name: string;
  type: 'spin';
  gameVariant: string;
  buyIn: number;
  rake: number;
  startingStack: number;
  maxPlayers: number;
  minPlayers: number;
  horsesToRegister: number;
  blindStructure: any[];
  payoutStructure: any[];
  spinMultipliers: any[];
}

interface XMTTConfig {
  name: string;
  type: 'mtt' | 'bounty' | 'progressive_bounty' | 'mystery_bounty';
  gameVariant: string;
  buyIn: number;
  rake: number;
  guarantee: number;
  startingStack: number;
  maxPlayers: number;
  minPlayers: number;
  horsesToRegister: number;
  blindStructure: any[];
  payoutStructure: any[];
  bountyPercent?: number;
}

interface HourlyTournamentBlock {
  hours: number[];
  tournaments: TournamentConfig[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SHARK_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const JAQK_CLUB_ID = 'a0000000-0000-0000-0000-000000000001';

const BLIND_STRUCTURES = {
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
  HYPER_TURBO: [
    { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 2 },
    { level: 2, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 2 },
    { level: 3, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 2 },
    { level: 4, smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 1 },
    { level: 5, smallBlind: 800, bigBlind: 1600, ante: 200, durationMinutes: 1 },
  ],
  SNG_6MAX: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 3 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 3 },
    { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 3 },
    { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 3 },
    { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 3 },
    { level: 6, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 2 },
    { level: 7, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 2 },
    { level: 8, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 2 },
  ],
  SPIN: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 2 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 2 },
    { level: 3, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 2 },
    { level: 4, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 1 },
    { level: 5, smallBlind: 100, bigBlind: 200, ante: 0, durationMinutes: 1 },
  ],
};

const PAYOUT_STRUCTURES = {
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
};

const SPIN_MULTIPLIERS = [
  { multiplier: 2, weight: 75 },
  { multiplier: 3, weight: 15 },
  { multiplier: 5, weight: 7 },
  { multiplier: 10, weight: 2.5 },
  { multiplier: 25, weight: 0.4 },
  { multiplier: 100, weight: 0.1 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HOURLY TOURNAMENT SCHEDULE (24/7 COVERAGE)
// ═══════════════════════════════════════════════════════════════════════════════

const HOURLY_SCHEDULE: HourlyTournamentBlock[] = [
  {
    hours: [0, 1, 2],
    tournaments: [
      {
        name: 'Midnight Bounty (NLH)',
        type: 'bounty',
        gameVariant: 'nlh',
        buyIn: 5,
        rake: 0.5,
        guarantee: 100,
        startingStack: 3000,
        maxPlayers: 50,
        minPlayers: 8,
        horsesToRegister: 12,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 30,
      },
      {
        name: 'Late Night Grind (PLO4)',
        type: 'mtt',
        gameVariant: 'plo4',
        buyIn: 3,
        rake: 0.3,
        guarantee: 50,
        startingStack: 2000,
        maxPlayers: 30,
        minPlayers: 6,
        horsesToRegister: 10,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
    ],
  },
  {
    hours: [3, 4, 5],
    tournaments: [
      {
        name: 'Early Bird Freeroll (NLH)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 0,
        rake: 0,
        guarantee: 75,
        startingStack: 2500,
        maxPlayers: 100,
        minPlayers: 10,
        horsesToRegister: 20,
        blindStructure: BLIND_STRUCTURES.HYPER_TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
      {
        name: 'Pre-Dawn Mystery Bounty (PLO5)',
        type: 'mystery_bounty',
        gameVariant: 'plo5',
        buyIn: 7,
        rake: 0.7,
        guarantee: 80,
        startingStack: 3500,
        maxPlayers: 50,
        minPlayers: 10,
        horsesToRegister: 15,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 40,
      },
    ],
  },
  {
    hours: [6, 7, 8],
    tournaments: [
      {
        name: 'Morning Grinder (PLO)',
        type: 'mtt',
        gameVariant: 'plo4',
        buyIn: 4,
        rake: 0.4,
        guarantee: 120,
        startingStack: 3000,
        maxPlayers: 50,
        minPlayers: 8,
        horsesToRegister: 14,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
      {
        name: 'Sunrise Bounty (NLH)',
        type: 'bounty',
        gameVariant: 'nlh',
        buyIn: 6,
        rake: 0.6,
        guarantee: 90,
        startingStack: 3500,
        maxPlayers: 60,
        minPlayers: 10,
        horsesToRegister: 16,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 30,
      },
    ],
  },
  {
    hours: [9, 10, 11],
    tournaments: [
      {
        name: 'Mid-Morning Turbo (6-Max NLH)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 8,
        rake: 0.8,
        guarantee: 150,
        startingStack: 4000,
        maxPlayers: 36,
        minPlayers: 6,
        horsesToRegister: 12,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
      {
        name: 'Brunch Special PKO (PLO8)',
        type: 'progressive_bounty',
        gameVariant: 'plo8',
        buyIn: 10,
        rake: 1.0,
        guarantee: 180,
        startingStack: 4500,
        maxPlayers: 50,
        minPlayers: 10,
        horsesToRegister: 15,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 50,
      },
    ],
  },
  {
    hours: [12, 13, 14],
    tournaments: [
      {
        name: 'Lunch Rush (NLH Deep)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 12,
        rake: 1.2,
        guarantee: 300,
        startingStack: 6000,
        maxPlayers: 100,
        minPlayers: 12,
        horsesToRegister: 20,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
      },
    ],
  },
  {
    hours: [15, 16, 17],
    tournaments: [
      {
        name: 'Afternoon Bounty (NLH)',
        type: 'bounty',
        gameVariant: 'nlh',
        buyIn: 10,
        rake: 1.0,
        guarantee: 200,
        startingStack: 4500,
        maxPlayers: 75,
        minPlayers: 10,
        horsesToRegister: 18,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 30,
      },
      {
        name: 'Coffee Break Freeroll (PLO4)',
        type: 'mtt',
        gameVariant: 'plo4',
        buyIn: 0,
        rake: 0,
        guarantee: 80,
        startingStack: 3000,
        maxPlayers: 50,
        minPlayers: 8,
        horsesToRegister: 14,
        blindStructure: BLIND_STRUCTURES.HYPER_TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
    ],
  },
  {
    hours: [18, 19, 20],
    tournaments: [
      {
        name: 'Prime Time Main Event (NLH)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 25,
        rake: 2.5,
        guarantee: 1000,
        startingStack: 10000,
        maxPlayers: 150,
        minPlayers: 20,
        horsesToRegister: 30,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
      },
      {
        name: 'Evening Mystery Bounty (PLO5)',
        type: 'mystery_bounty',
        gameVariant: 'plo5',
        buyIn: 15,
        rake: 1.5,
        guarantee: 400,
        startingStack: 5000,
        maxPlayers: 60,
        minPlayers: 12,
        horsesToRegister: 18,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 40,
      },
    ],
  },
  {
    hours: [21, 22, 23],
    tournaments: [
      {
        name: 'Night Owl Special (NLH)',
        type: 'bounty',
        gameVariant: 'nlh',
        buyIn: 20,
        rake: 2.0,
        guarantee: 600,
        startingStack: 8000,
        maxPlayers: 100,
        minPlayers: 15,
        horsesToRegister: 25,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
        bountyPercent: 30,
      },
      {
        name: 'Late Night PKO (PLO4)',
        type: 'progressive_bounty',
        gameVariant: 'plo4',
        buyIn: 18,
        rake: 1.8,
        guarantee: 450,
        startingStack: 7500,
        maxPlayers: 70,
        minPlayers: 12,
        horsesToRegister: 20,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
        bountyPercent: 50,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SNG / SPIN CONFIGS
// ═══════════════════════════════════════════════════════════════════════════════

const SNG_CONFIGS: SNGConfig[] = [
  {
    name: '5 Chip Turbo SNG 6-Max NLH',
    type: 'sng',
    gameVariant: 'nlh',
    buyIn: 5,
    rake: 0.5,
    startingStack: 1500,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: BLIND_STRUCTURES.SNG_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
  {
    name: '10 Chip SNG 9-Max NLH',
    type: 'sng',
    gameVariant: 'nlh',
    buyIn: 10,
    rake: 1.0,
    startingStack: 2000,
    maxPlayers: 9,
    minPlayers: 9,
    horsesToRegister: 9,
    blindStructure: BLIND_STRUCTURES.SNG_6MAX,
    payoutStructure: PAYOUT_STRUCTURES.THREE,
  },
  {
    name: '5 Chip Turbo SNG 6-Max PLO4',
    type: 'sng',
    gameVariant: 'plo4',
    buyIn: 5,
    rake: 0.5,
    startingStack: 1500,
    maxPlayers: 6,
    minPlayers: 6,
    horsesToRegister: 6,
    blindStructure: BLIND_STRUCTURES.SNG_6MAX,
    payoutStructure: [
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ],
  },
];

const SPIN_CONFIGS: SpinConfig[] = [
  {
    name: '1 Chip Spin NLH',
    type: 'spin',
    gameVariant: 'nlh',
    buyIn: 1,
    rake: 0.1,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: BLIND_STRUCTURES.SPIN,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '3 Chip Spin NLH',
    type: 'spin',
    gameVariant: 'nlh',
    buyIn: 3,
    rake: 0.3,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: BLIND_STRUCTURES.SPIN,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
  {
    name: '5 Chip Spin PLO4',
    type: 'spin',
    gameVariant: 'plo4',
    buyIn: 5,
    rake: 0.5,
    startingStack: 500,
    maxPlayers: 3,
    minPlayers: 3,
    horsesToRegister: 3,
    blindStructure: BLIND_STRUCTURES.SPIN,
    payoutStructure: [{ place: 1, percentage: 100 }],
    spinMultipliers: SPIN_MULTIPLIERS,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// XMTT (UNION) TOURNAMENT CONFIGS — Cross-Club Events
// ═══════════════════════════════════════════════════════════════════════════════

const XMTT_SCHEDULE: { hours: number[]; tournaments: XMTTConfig[] }[] = [
  {
    hours: [10, 11],
    tournaments: [
      {
        name: 'Union Morning Classic (NLH)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 15,
        rake: 1.5,
        guarantee: 500,
        startingStack: 5000,
        maxPlayers: 100,
        minPlayers: 10,
        horsesToRegister: 20,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
      },
    ],
  },
  {
    hours: [14, 15],
    tournaments: [
      {
        name: 'Union PKO Afternoon (PLO4)',
        type: 'progressive_bounty',
        gameVariant: 'plo4',
        buyIn: 20,
        rake: 2.0,
        guarantee: 600,
        startingStack: 6000,
        maxPlayers: 80,
        minPlayers: 12,
        horsesToRegister: 18,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
        bountyPercent: 50,
      },
    ],
  },
  {
    hours: [19, 20],
    tournaments: [
      {
        name: 'Union Grand Championship (NLH)',
        type: 'bounty',
        gameVariant: 'nlh',
        buyIn: 50,
        rake: 5.0,
        guarantee: 2500,
        startingStack: 15000,
        maxPlayers: 200,
        minPlayers: 20,
        horsesToRegister: 30,
        blindStructure: BLIND_STRUCTURES.STANDARD,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
        bountyPercent: 30,
      },
      {
        name: 'Union Mystery Bounty (PLO5)',
        type: 'mystery_bounty',
        gameVariant: 'plo5',
        buyIn: 25,
        rake: 2.5,
        guarantee: 800,
        startingStack: 8000,
        maxPlayers: 100,
        minPlayers: 15,
        horsesToRegister: 22,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.NINE,
        bountyPercent: 40,
      },
    ],
  },
  {
    hours: [22, 23],
    tournaments: [
      {
        name: 'Union Late Night Turbo (NLH)',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 10,
        rake: 1.0,
        guarantee: 300,
        startingStack: 4000,
        maxPlayers: 75,
        minPlayers: 8,
        horsesToRegister: 16,
        blindStructure: BLIND_STRUCTURES.TURBO,
        payoutStructure: PAYOUT_STRUCTURES.FIVE,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT RECURRING SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TournamentRecurringService {
  private tournamentInterval: ReturnType<typeof setInterval> | null = null;
  private sngInterval: ReturnType<typeof setInterval> | null = null;
  private spinInterval: ReturnType<typeof setInterval> | null = null;
  private xmttInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private clubIds = [SHARK_CLUB_ID, JAQK_CLUB_ID];
  private clubIndex = 0;

  private getNextClubId(): string {
    const id = this.clubIds[this.clubIndex % this.clubIds.length];
    this.clubIndex++;
    return id;
  }

  start(): void {
    if (this.isRunning) {
      console.log('[TournamentRecurring] Already running');
      return;
    }

    this.isRunning = true;
    console.log(
      '[TournamentRecurring] Service started — MTTs every 5 min, SNGs every 15 min, Spins every 10 min, XMTTs every 5 min'
    );

    // Tournament check: every 5 minutes
    this.tournamentInterval = setInterval(() => this.checkAndLaunchTournaments(), 5 * 60 * 1000);

    // SNG check: every 15 minutes
    this.sngInterval = setInterval(() => this.checkAndLaunchSNGs(), 15 * 60 * 1000);

    // Spin check: every 10 minutes
    this.spinInterval = setInterval(() => this.checkAndLaunchSpins(), 10 * 60 * 1000);

    // XMTT check: every 5 minutes
    this.xmttInterval = setInterval(() => this.checkAndLaunchXMTTs(), 5 * 60 * 1000);

    // Run checks immediately on start
    this.checkAndLaunchTournaments();
    this.checkAndLaunchSNGs();
    this.checkAndLaunchSpins();
    this.checkAndLaunchXMTTs();
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.tournamentInterval) clearInterval(this.tournamentInterval);
    if (this.sngInterval) clearInterval(this.sngInterval);
    if (this.spinInterval) clearInterval(this.spinInterval);
    if (this.xmttInterval) clearInterval(this.xmttInterval);

    this.tournamentInterval = null;
    this.sngInterval = null;
    this.spinInterval = null;
    this.xmttInterval = null;
    this.isRunning = false;

    console.log('[TournamentRecurring] Stopped');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchTournaments(): Promise<void> {
    try {
      const now = new Date();
      const hour = now.getHours();

      const block = HOURLY_SCHEDULE.find((b) => b.hours.includes(hour));
      if (!block) return;

      for (const config of block.tournaments) {
        // Use config.type to filter by the correct tournament variant
        const existing = await this.getActiveCount(config.type, config.name);
        if (existing > 0) continue;

        const result = await this.createTournament(config);
        if (result.tournamentId) {
          console.log(
            `[TournamentRecurring] Launched: "${config.name}" (${result.registered} horses)`
          );
        }
      }
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] Tournament check error: ${err.message}`),
        'TournamentRecurring.Tournament_check_error'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SNG CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchSNGs(): Promise<void> {
    try {
      const activeCount = await this.getActiveCount('sng');
      const threshold = 3;

      if (activeCount >= threshold) return;

      const toLaunch = threshold - activeCount;
      let launched = 0;

      for (let i = 0; i < toLaunch; i++) {
        const config = SNG_CONFIGS[i % SNG_CONFIGS.length];
        const result = await this.createSNG(config);
        if (result.tournamentId) launched++;
      }

      if (launched > 0) {
        console.log(`[TournamentRecurring] Launched ${launched} SNGs`);
      }
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] SNG check error: ${err.message}`),
        'TournamentRecurring.SNG_check_error'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchSpins(): Promise<void> {
    try {
      const activeCount = await this.getActiveCount('spin');
      const threshold = 5;

      if (activeCount >= threshold) return;

      const toLaunch = threshold - activeCount;
      let launched = 0;

      for (let i = 0; i < toLaunch; i++) {
        const config = SPIN_CONFIGS[i % SPIN_CONFIGS.length];
        const result = await this.createSpin(config);
        if (result.tournamentId) launched++;
      }

      if (launched > 0) {
        console.log(`[TournamentRecurring] Launched ${launched} Spins`);
      }
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] Spin check error: ${err.message}`),
        'TournamentRecurring.Spin_check_error'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // XMTT (UNION TOURNAMENT) CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchXMTTs(): Promise<void> {
    try {
      // Query all unions that have cross-club tournaments enabled
      const { data: unions } = await supabase.from('unions').select('id, name, settings');

      if (!unions || unions.length === 0) return;

      const now = new Date();
      const hour = now.getHours();

      const block = XMTT_SCHEDULE.find((b) => b.hours.includes(hour));
      if (!block) return;

      for (const union of unions) {
        // Check if union has cross-club tournaments enabled
        const settings = union.settings as any;
        if (!settings?.crossClubTournaments) continue;

        // Get clubs in this union
        const { data: unionClubs } = await supabase
          .from('union_clubs')
          .select('club_id')
          .eq('union_id', union.id);

        if (!unionClubs || unionClubs.length < 2) continue; // Need at least 2 clubs for XMTT

        const hostClubId = unionClubs[0].club_id;

        for (const config of block.tournaments) {
          // Check if this XMTT already exists for this union
          const { count } = await supabase
            .from('tournaments')
            .select('id', { count: 'exact', head: true })
            .eq('union_id', union.id)
            .eq('is_xmtt', true)
            .ilike('name', config.name)
            .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING']);

          if ((count || 0) > 0) continue;

          const result = await this.createXMTT(config, union.id, hostClubId);
          if (result.tournamentId) {
            console.log(
              `[TournamentRecurring] XMTT Launched: "${config.name}" for union ${union.name} (${result.registered} horses)`
            );
          }
        }
      }
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] XMTT check error: ${err.message}`),
        'TournamentRecurring.XMTT_check_error'
      );
    }
  }

  private async createXMTT(
    config: XMTTConfig,
    unionId: string,
    hostClubId: string
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      const startTime = new Date(Date.now() + 5 * 60 * 1000); // 5 min delay for XMTTs (more registration time)
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo8: 'PLO8',
        short_deck: 'SHORT_DECK',
      };
      const dbGameType = gameTypeMap[config.gameVariant] || 'NLH';

      const isBountyType =
        config.type === 'bounty' ||
        config.type === 'progressive_bounty' ||
        config.type === 'mystery_bounty';
      const bountyPercent = config.bountyPercent || 30;
      // Round 40 RE-RUN: Math.round (not Math.trunc) for IEEE 754 drift safety
      // on bounty / mystery-max calculation — same family as the other Round 40
      // fixes (calculateRake, completeHand, prizePool, totalRake, mysteryValue).
      const bountyAmount = isBountyType ? Math.round(config.buyIn * bountyPercent) / 100 : 0;
      const mysteryMin = config.type === 'mystery_bounty' ? bountyAmount : 0;
      const mysteryMax =
        config.type === 'mystery_bounty' ? Math.round(bountyAmount * 10 * 100) / 100 : 0;

      let tournament = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { data, error } = await supabase
          .from('tournaments')
          .insert({
            club_id: hostClubId,
            union_id: unionId,
            is_xmtt: true,
            name: config.name,
            game_type: dbGameType,
            variant: config.type === 'mtt' ? 'freezeout' : config.type,
            tournament_type: 'MTT',
            buy_in_amount: config.buyIn,
            buy_in_fee: config.rake,
            guaranteed_prize: config.guarantee || 0,
            starting_chips: config.startingStack,
            max_players: config.maxPlayers,
            min_players: config.minPlayers || 3,
            current_players: 0,
            status: 'REGISTERING',
            blind_structure: config.blindStructure,
            payout_structure: config.payoutStructure || [],
            start_time: startTime.toISOString(),
            late_reg_levels: 10, // Level-based late reg for XMTT
            late_reg_mins: 10, // Legacy fallback
            is_bounty: isBountyType,
            is_pko: config.type === 'progressive_bounty',
            is_mystery_bounty: config.type === 'mystery_bounty',
            bounty_amount: bountyAmount,
            mystery_bounty_min: mysteryMin,
            mystery_bounty_max: mysteryMax,
          })
          .select()
          .maybeSingle(); // FIX 168
        if (!error && data) {
          tournament = data;
          break;
        }
        lastError = error;
        reportError(
          new Error(
            `[RecurringService] XMTT creation attempt ${attempt}/3 failed: ${error?.message}`
          ),
          'RecurringService.XMTT_creation_attempt_attempt3'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] XMTT creation FAILED after 3 retries: ${lastError?.message}`
          ),
          'RecurringService.XMTT_creation_FAILED_after_3_r'
        );
        return { tournamentId: null, registered: 0 };
      }

      const registered = await this.registerHorses(tournament.id, config.horsesToRegister);
      const entriesPool = config.buyIn * registered;
      const prizePool = config.guarantee ? Math.max(entriesPool, config.guarantee) : entriesPool;

      const { error: updateErr } = await supabase
        .from('tournaments')
        .update({ current_players: registered, prize_pool: prizePool, status: 'REGISTERING' })
        .eq('id', tournament.id);
      if (updateErr)
        reportError(
          new Error(
            `[TournamentRecurring] XMTT state update failed for ${tournament.id.slice(0, 8)}: ${updateErr.message}`
          ),
          'TournamentRecurring.XMTT_state_update_failed_for_t'
        );

      return { tournamentId: tournament.id, registered };
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] createXMTT error: ${err.message}`),
        'TournamentRecurring.createXMTT_error'
      );
      return { tournamentId: null, registered: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private async getActiveCount(type: string, name?: string): Promise<number> {
    try {
      let query = supabase
        .from('tournaments')
        .select('id', { count: 'exact', head: true })
        .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING']);

      // Filter by variant type — type parameter should match the tournament variant
      if (type === 'mtt') {
        query = query.eq('variant', 'freezeout');
      } else if (type === 'bounty') {
        query = query.eq('variant', 'bounty');
      } else if (type === 'progressive_bounty') {
        query = query.eq('variant', 'progressive_bounty');
      } else if (type === 'mystery_bounty') {
        query = query.eq('variant', 'mystery_bounty');
      } else if (type === 'sng') {
        query = query.eq('variant', 'sng');
      } else if (type === 'spin') {
        query = query.eq('variant', 'spin');
      }

      if (name) {
        query = query.ilike('name', name);
      }

      const { count } = await query;
      return count || 0;
    } catch {
      return 0;
    }
  }

  private async createTournament(
    config: TournamentConfig
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      const startTime = new Date(Date.now() + 60 * 1000);
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo8: 'PLO8',
        short_deck: 'SHORT_DECK',
      };
      const dbGameType = gameTypeMap[config.gameVariant] || 'NLH';

      const isBountyType =
        config.type === 'bounty' ||
        config.type === 'progressive_bounty' ||
        config.type === 'mystery_bounty';

      // Calculate bounty amount using configurable bountyPercent
      // Round 40 RE-RUN: Math.round (not Math.trunc) for IEEE 754 drift safety —
      // mirrors the same fix applied to the other bounty-config branch in this file.
      const bountyPercent = config.bountyPercent || 30;
      const bountyAmount = isBountyType ? Math.round(config.buyIn * bountyPercent) / 100 : 0;
      // Mystery bounty range: min = base bounty, max = 10x base
      const mysteryMin = config.type === 'mystery_bounty' ? bountyAmount : 0;
      const mysteryMax =
        config.type === 'mystery_bounty' ? Math.round(bountyAmount * 10 * 100) / 100 : 0;

      let tournament = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { data, error } = await supabase
          .from('tournaments')
          .insert({
            club_id: this.getNextClubId(),
            name: config.name,
            game_type: dbGameType,
            variant: config.type === 'mtt' ? 'freezeout' : config.type,
            tournament_type: 'MTT',
            buy_in_amount: config.buyIn,
            buy_in_fee: config.rake,
            guaranteed_prize: config.guarantee || 0,
            starting_chips: config.startingStack,
            max_players: config.maxPlayers,
            min_players: config.minPlayers || 3,
            current_players: 0,
            status: 'REGISTERING',
            blind_structure: config.blindStructure,
            payout_structure: config.payoutStructure || [],
            start_time: startTime.toISOString(),
            late_reg_levels: 8, // Level-based late reg
            late_reg_mins: 8, // Legacy fallback
            is_bounty: isBountyType,
            is_pko: config.type === 'progressive_bounty',
            is_mystery_bounty: config.type === 'mystery_bounty',
            bounty_amount: bountyAmount,
            mystery_bounty_min: mysteryMin,
            mystery_bounty_max: mysteryMax,
          })
          .select()
          .maybeSingle(); // FIX 168
        if (!error && data) {
          tournament = data;
          break;
        }
        lastError = error;
        reportError(
          new Error(
            `[RecurringService] Tournament creation attempt ${attempt}/3 failed: ${error?.message}`
          ),
          'RecurringService.Tournament_creation_attempt_at'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] Tournament creation FAILED after 3 retries: ${lastError?.message}`
          ),
          'RecurringService.Tournament_creation_FAILED_aft'
        );
        return { tournamentId: null, registered: 0 };
      }

      const registered = await this.registerHorses(tournament.id, config.horsesToRegister);
      const entriesPool = config.buyIn * registered;
      // Honor guaranteed prize: prize pool = max(entries * buy-in, guarantee)
      const prizePool = config.guarantee ? Math.max(entriesPool, config.guarantee) : entriesPool;

      const { error: updateErr } = await supabase
        .from('tournaments')
        .update({ current_players: registered, prize_pool: prizePool, status: 'REGISTERING' })
        .eq('id', tournament.id);
      if (updateErr)
        reportError(
          new Error(
            `[TournamentRecurring] Tournament state update failed for ${tournament.id.slice(0, 8)}: ${updateErr.message}`
          ),
          'TournamentRecurring.Tournament_state_update_failed'
        );

      return { tournamentId: tournament.id, registered };
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] createTournament error: ${err.message}`),
        'TournamentRecurring.createTournament_error'
      );
      return { tournamentId: null, registered: 0 };
    }
  }

  private async createSNG(
    config: SNGConfig
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      const startTime = new Date(Date.now() + 60 * 1000);
      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
        plo8: 'PLO8',
      };
      const dbGameType = gameTypeMap[config.gameVariant] || 'NLH';

      const { data: sng, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.getNextClubId(),
          name: config.name,
          game_type: dbGameType,
          variant: 'sng',
          tournament_type: 'SNG',
          buy_in_amount: config.buyIn,
          buy_in_fee: config.rake,
          guaranteed_prize: 0,
          starting_chips: config.startingStack,
          max_players: config.maxPlayers,
          min_players: config.minPlayers || 3,
          current_players: 0,
          status: 'REGISTERING',
          blind_structure: config.blindStructure,
          payout_structure: config.payoutStructure || [],
          start_time: startTime.toISOString(),
          late_reg_levels: 0,
          late_reg_mins: 0,
        })
        .select()
        .maybeSingle(); // FIX 168

      if (error || !sng) {
        reportError(
          new Error(`[TournamentRecurring] SNG creation failed: ${error?.message}`),
          'TournamentRecurring.SNG_creation_failed'
        );
        return { tournamentId: null, registered: 0 };
      }

      const registered = await this.registerHorses(sng.id, config.horsesToRegister);
      const prizePool = config.buyIn * registered;

      const { error: sngUpdateErr } = await supabase
        .from('tournaments')
        .update({ current_players: registered, prize_pool: prizePool, status: 'REGISTERING' })
        .eq('id', sng.id);
      if (sngUpdateErr)
        reportError(
          new Error(
            `[TournamentRecurring] SNG state update failed for ${sng.id.slice(0, 8)}: ${sngUpdateErr.message}`
          ),
          'TournamentRecurring.SNG_state_update_failed_for_sn'
        );

      return { tournamentId: sng.id, registered };
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] createSNG error: ${err.message}`),
        'TournamentRecurring.createSNG_error'
      );
      return { tournamentId: null, registered: 0 };
    }
  }

  private async createSpin(
    config: SpinConfig
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      const startTime = new Date(Date.now() + 60 * 1000);
      const multiplier = this.rollSpinMultiplier(config.spinMultipliers);

      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
      };
      const dbGameType = gameTypeMap[config.gameVariant] || 'NLH';

      const { data: spin, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.getNextClubId(),
          name: `${config.name} (${multiplier}x)`,
          game_type: dbGameType,
          variant: 'spin',
          tournament_type: 'SPIN',
          buy_in_amount: config.buyIn,
          buy_in_fee: config.rake,
          guaranteed_prize: 0, // Will be calculated after registrations
          spin_multiplier: multiplier,
          starting_chips: config.startingStack,
          max_players: config.maxPlayers,
          min_players: config.minPlayers || 3,
          current_players: 0,
          status: 'REGISTERING',
          blind_structure: config.blindStructure,
          payout_structure: config.payoutStructure || [],
          start_time: startTime.toISOString(),
          late_reg_levels: 0,
          late_reg_mins: 0,
        })
        .select()
        .maybeSingle(); // FIX 168

      if (error || !spin) {
        reportError(
          new Error(`[TournamentRecurring] Spin creation failed: ${error?.message}`),
          'TournamentRecurring.Spin_creation_failed'
        );
        return { tournamentId: null, registered: 0 };
      }

      const registered = await this.registerHorses(spin.id, config.horsesToRegister);
      // Calculate actual prize pool based on actual registrations (not target count)
      const prizePool = config.buyIn * registered * multiplier;

      const { error: spinUpdateErr } = await supabase
        .from('tournaments')
        .update({
          current_players: registered,
          prize_pool: prizePool,
          guaranteed_prize: prizePool,
          status: 'REGISTERING',
        })
        .eq('id', spin.id);
      if (spinUpdateErr)
        reportError(
          new Error(
            `[TournamentRecurring] Spin state update failed for ${spin.id.slice(0, 8)}: ${spinUpdateErr.message}`
          ),
          'TournamentRecurring.Spin_state_update_failed_for_s'
        );

      return { tournamentId: spin.id, registered };
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] createSpin error: ${err.message}`),
        'TournamentRecurring.createSpin_error'
      );
      return { tournamentId: null, registered: 0 };
    }
  }

  private async registerHorses(tournamentId: string, count: number): Promise<number> {
    try {
      const { data: horses } = await supabase
        .from('profiles')
        .select('id, display_name, username, use_real_name')
        .eq('is_horse', true)
        .eq('horse_status', 'available')
        .limit(count);

      if (!horses || horses.length === 0) return 0;

      let registered = 0;
      for (const horse of horses) {
        const { error: regError } = await supabase.from('tournament_players').insert({
          tournament_id: tournamentId,
          user_id: horse.id,
          username: horse.use_real_name
            ? horse.display_name || horse.username || 'Horse'
            : horse.username || horse.display_name || 'Horse',
          status: 'registered',
          chips: 0,
        });

        if (!regError) registered++;
      }

      return registered;
    } catch {
      return 0;
    }
  }

  private rollSpinMultiplier(multipliers: Array<{ multiplier: number; weight: number }>): number {
    const totalWeight = multipliers.reduce((sum, m) => sum + m.weight, 0);
    let random = Math.random() * totalWeight;

    for (const { multiplier, weight } of multipliers) {
      random -= weight;
      if (random <= 0) return multiplier;
    }

    return multipliers[multipliers.length - 1].multiplier;
  }
}
