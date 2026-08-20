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

import { secureRandomInt } from '../engine/CryptoRandom.js';
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
  /**
   * ROLLOUT 2026-08-15 (Dan: "enable on a few recurring formats first").
   * Rebuys / re-entries / add-ons had NEVER been offered: 0 of 8,210
   * tournaments ever created carried these flags, so the whole feature was
   * unreachable regardless of the server path being fixed. Opt-in per
   * template so the first live exposure is a handful of formats, not the
   * fleet.
   */
  rebuy?: boolean;
  addOn?: boolean;
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
  /**
   * ROLLOUT 2026-08-15 (Dan: "enable on a few recurring formats first").
   * Rebuys / re-entries / add-ons had NEVER been offered: 0 of 8,210
   * tournaments ever created carried these flags, so the whole feature was
   * unreachable regardless of the server path being fixed. Opt-in per
   * template so the first live exposure is a handful of formats, not the
   * fleet.
   */
  rebuy?: boolean;
  addOn?: boolean;
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

// Dan 2026-08-19: "MAKE SURE THAT THE GAMES ARE CREATED BY MIDWAY UNION FOR ALL
// CASH GAMES, MTT, SIT N GO'S AND SPINS."
//
// Cash tables already spawn from the union (HorseFleetManager FIX 201), but the
// recurring MTT / SNG / Spin schedulers below were still round-robining
// ownership between SHARK and JAQK and never setting union_id at all. A DB
// trigger back-filled union_id afterwards, so they LOOKED union-owned while
// their club_id said otherwise — which is why one MTT was still sitting under
// Club JAQK. Every scheduled game now names the union explicitly, at creation.
const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

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

import {
  SPIN_TIERS,
  SPIN_SEATS as SPEC_SPIN_SEATS,
  spinTier,
  spinRakeRate,
  spinBlindsForLevel,
} from '../config/spinSpec';

// ═══════════════════════════════════════════════════════════════════════════
// SPIN MULTIPLIERS — Dan's spec, 2026-08-20.
//
// This local table used to be one of THREE that disagreed (EV 3.00 designed,
// 2.75 here, 2.24 in the engine fallback) and this one is what actually ran.
// The single source of truth is now src/config/spinSpec.ts, mirrored to
// server/src/config/. Kept as a derived view so nothing downstream breaks.
// ═══════════════════════════════════════════════════════════════════════════
const SPIN_MULTIPLIERS = SPIN_TIERS.map((t) => ({
  multiplier: t.multiplier,
  weight: t.freq,
}));


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
        rebuy: true,
        addOn: true,
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
        rebuy: true,
        addOn: true,
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
        rebuy: true,
        addOn: true,
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
        rebuy: true,
        addOn: true,
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

/**
 * Dan 2026-08-19: HORSES FILL EVERY SEAT — SNG, Spin and MTT alike.
 *
 * "FOR NOW, TOURNAMENTS CAN ALWAYS BE SEATED BY ALL HORSES, RIGHT NOW WE HAVE
 *  ZERO REAL USERS... SO ALLOW HORSES TO FILL ALL SEATS FOR SIT N GO'S AND MTT
 *  AND SPINS"
 *
 * The previous rule held ONE seat open for a human on 9 of every 10 SNG/Spins
 * (only every 10th was a full-horse verification game). With no real users
 * that seat was never taken, so nine in ten games sat at maxPlayers-1 until a
 * timer cancelled them. That single line produced 557 of the 562 cancellations
 * measured over two days: 363 stuck at 2/3, 138 at 5/6, 56 at 8/9 — every one
 * of them exactly one player short.
 *
 * Every game now seeds to a full field and runs immediately. When real players
 * arrive, flip HOLD_SEAT_FOR_HUMAN back to true and the reserved seat returns
 * with no other change — the fill-on-start path in GameServer keeps games
 * running either way, so this is purely about how fast they fill.
 */
const HOLD_SEAT_FOR_HUMAN = false;
function horsesForSeatHeldGame(maxPlayers: number): { horses: number; isSim: boolean } {
  if (!HOLD_SEAT_FOR_HUMAN) return { horses: maxPlayers, isSim: true };
  return { horses: Math.max(1, maxPlayers - 1), isSim: false };
}

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

/**
 * Dan 2026-08-19: "SPINS ARE ALWAYS 3 HANDED."
 *
 * Not a per-config choice. A Spin & Go is a three-handed hyper by definition —
 * its multipliers, blind structure and prize maths are all built around exactly
 * three players — so the seat count belongs to the FORMAT, not to any one
 * tournament's config. Every SPIN_CONFIG already says 3; this is what stops one
 * that does not from slipping through.
 *
 * SNGs are NOT this. They carry their own max_players (6 in production) and
 * must keep reading it from their config.
 */
export const SPIN_SEATS = 3;

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

  // RETIRED 2026-08-19. Scheduled tournaments are created BY the union, not
  // alternated between its member clubs. SHARK_CLUB_ID / JAQK_CLUB_ID remain
  // referenced elsewhere for rake-routing fallbacks only.
  private readonly ownerClubId = MIDWAY_UNION_ID;
  private readonly ownerUnionId = MIDWAY_UNION_ID;

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
      // TOURNEY-AUDIT 2026-07-24: schedule hours are UTC (was server-local time,
      // which shifts every named event when the host timezone differs).
      const hour = now.getUTCHours();

      const block = HOURLY_SCHEDULE.find((b) => b.hours.includes(hour));
      if (!block) return;

      for (const config of block.tournaments) {
        // Use config.type to filter by the correct tournament variant
        const existing = await this.getActiveCount(config.type, config.name);
        if (existing > 0) continue;

        /**
         * A9 FIX (2026-08-20): the check above is a TOCTOU and always was.
         *
         * Two overlapping ticks — or two engine containers — both read zero and
         * both create. Nothing in the database said "only one of these at a
         * time", so this guard was advisory. It fires in production: over one
         * week "Coffee Break Freeroll (PLO4)" was created twice 2.6 SECONDS
         * apart.
         *
         * A partial unique index now backs it —
         * uq_scheduled_tournament_one_live_per_name on
         * (tournament_type, name) where the status is pre-start and the type is
         * MTT/XMTT — so the loser of a race gets a rejected insert instead of a
         * duplicate scheduled event. That is a benign, EXPECTED outcome here,
         * not an error: the other racer created the tournament we wanted. Log it
         * quietly and move on rather than reporting it as a failure.
         *
         * SNG and SPIN are deliberately outside the index: they are on-demand
         * formats that legitimately run many same-named instances at once.
         */
        try {
          const result = await this.createTournament(config);
          if (result.tournamentId) {
            console.log(
              `[TournamentRecurring] Launched: "${config.name}" (${result.registered} horses)`
            );
          }
        } catch (createErr: any) {
          const msg = String(createErr?.message ?? createErr ?? '');
          if (createErr?.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
            console.log(
              `[TournamentRecurring] "${config.name}" was created concurrently — skipping (this is the duplicate guard working)`
            );
            continue;
          }
          throw createErr;
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
      // TOURNEY-AUDIT 2026-07-24: schedule hours are UTC (was server-local time,
      // which shifts every named event when the host timezone differs).
      const hour = now.getUTCHours();

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
            // Rebuy / add-on rollout — opt-in per template (see config docs).
            // Cost and chips default to the buy-in and the starting stack,
            // matching what process_tournament_rebuy computes server-side.
            is_rebuy: (config as { rebuy?: boolean }).rebuy === true,
            is_reentry: (config as { rebuy?: boolean }).rebuy === true,
            rebuy_cost: (config as { rebuy?: boolean }).rebuy ? config.buyIn : null,
            rebuy_chips: (config as { rebuy?: boolean }).rebuy ? config.startingStack : null,
            rebuy_levels: (config as { rebuy?: boolean }).rebuy ? 6 : null,
            max_rebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            max_reentries: (config as { rebuy?: boolean }).rebuy ? 1 : null,
            add_on_available: (config as { addOn?: boolean }).addOn === true,
            addon_cost: (config as { addOn?: boolean }).addOn ? config.buyIn : null,
            addon_chips: (config as { addOn?: boolean }).addOn ? config.startingStack : null,
            addon_levels: (config as { addOn?: boolean }).addOn ? 1 : null,
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
            `[RecurringService] XMTT creation attempt ${attempt}/3 failed: ${error?.message || JSON.stringify(error) || 'Unknown error'}`
          ),
          'RecurringService.XMTT_creation_attempt_attempt3'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] XMTT creation FAILED after 3 retries: ${lastError?.message || JSON.stringify(lastError) || 'Unknown error'}`
          ),
          'RecurringService.XMTT_creation_FAILED_after_3_r'
        );
        return { tournamentId: null, registered: 0 };
      }

      // Dan 2026-08-19: MTTs seed a FULL field too, not just horsesToRegister.
      // registerHorses only ever returns horses that are genuinely free (not in
      // another tournament and not sitting at an open table), so asking for
      // maxPlayers fills the event as far as the pool allows and no further —
      // it cannot starve cash games or other tournaments.
      const horseTarget = HOLD_SEAT_FOR_HUMAN
        ? config.horsesToRegister
        : Math.max(config.horsesToRegister, config.maxPlayers);
      const registered = await this.registerHorses(tournament.id, horseTarget);
      // TOURNEY-AUDIT 2026-07-24 [money]: exclude the bounty portion from the
      // prize pool for bounty formats (same fix as the club-level MTT path).
      const xmttPerEntry = Math.max(0, config.buyIn - (bountyAmount || 0));
      const entriesPool = Math.round(xmttPerEntry * registered * 100) / 100;
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
      // TOURNEY-AUDIT 2026-07-24: fail CLOSED. Returning 0 on a transient DB
      // error made the scheduler believe no tournaments existed and recreate
      // every scheduled event on the next tick (duplicate storm). Treating an
      // error as "already exists" skips one creation cycle instead.
      return Number.MAX_SAFE_INTEGER;
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
            club_id: this.ownerClubId,
            union_id: this.ownerUnionId,
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
            // Rebuy / add-on rollout — opt-in per template (see config docs).
            // Cost and chips default to the buy-in and the starting stack,
            // matching what process_tournament_rebuy computes server-side.
            is_rebuy: (config as { rebuy?: boolean }).rebuy === true,
            is_reentry: (config as { rebuy?: boolean }).rebuy === true,
            rebuy_cost: (config as { rebuy?: boolean }).rebuy ? config.buyIn : null,
            rebuy_chips: (config as { rebuy?: boolean }).rebuy ? config.startingStack : null,
            rebuy_levels: (config as { rebuy?: boolean }).rebuy ? 6 : null,
            max_rebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            max_reentries: (config as { rebuy?: boolean }).rebuy ? 1 : null,
            add_on_available: (config as { addOn?: boolean }).addOn === true,
            addon_cost: (config as { addOn?: boolean }).addOn ? config.buyIn : null,
            addon_chips: (config as { addOn?: boolean }).addOn ? config.startingStack : null,
            addon_levels: (config as { addOn?: boolean }).addOn ? 1 : null,
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
            `[RecurringService] Tournament creation attempt ${attempt}/3 failed: ${error?.message || JSON.stringify(error) || 'Unknown error'}`
          ),
          'RecurringService.Tournament_creation_attempt_at'
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] Tournament creation FAILED after 3 retries: ${lastError?.message || JSON.stringify(lastError) || 'Unknown error'}`
          ),
          'RecurringService.Tournament_creation_FAILED_aft'
        );
        return { tournamentId: null, registered: 0 };
      }

      // Dan 2026-08-19: MTTs seed a FULL field too, not just horsesToRegister.
      // registerHorses only ever returns horses that are genuinely free (not in
      // another tournament and not sitting at an open table), so asking for
      // maxPlayers fills the event as far as the pool allows and no further —
      // it cannot starve cash games or other tournaments.
      const horseTarget = HOLD_SEAT_FOR_HUMAN
        ? config.horsesToRegister
        : Math.max(config.horsesToRegister, config.maxPlayers);
      const registered = await this.registerHorses(tournament.id, horseTarget);
      // TOURNEY-AUDIT 2026-07-24 [money]: for bounty formats the bounty
      // portion of each entry funds the bounty pool, NOT the prize pool —
      // the old math left the full buy-in in the pool AND paid bounties on
      // top (double-counting the bounty component).
      const perEntryToPool = Math.max(0, config.buyIn - (bountyAmount || 0));
      const entriesPool = Math.round(perEntryToPool * registered * 100) / 100;
      // Honor guaranteed prize: prize pool = max(entries contribution, guarantee)
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
          club_id: this.ownerClubId,
          union_id: this.ownerUnionId,
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
          new Error(
            `[TournamentRecurring] SNG creation failed: ${error?.message || JSON.stringify(error) || 'Unknown error'}`
          ),
          'TournamentRecurring.SNG_creation_failed'
        );
        return { tournamentId: null, registered: 0 };
      }

      // TOURNEY-AUDIT 2026-07-24 (sweep 6): hold one seat for a human (full
      // fill only on periodic verification games).
      const seatPlan = horsesForSeatHeldGame(config.maxPlayers);
      const registered = await this.registerHorses(sng.id, seatPlan.horses);
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
      // A Spin is three-handed by definition. The seat count is forced below
      // regardless, but a config that disagrees is a bug in that config and
      // must not pass unnoticed.
      if (config.maxPlayers !== SPIN_SEATS || (config.minPlayers ?? SPIN_SEATS) !== SPIN_SEATS) {
        reportError(
          new Error(
            `[TournamentRecurring] Spin config "${config.name}" declares ` +
              `${config.maxPlayers}/${config.minPlayers} players; Spins are always ` +
              `${SPIN_SEATS}-handed. Forcing ${SPIN_SEATS}.`
          ),
          'TournamentRecurring.spin_seat_count_override'
        );
      }
      const startTime = new Date(Date.now() + 60 * 1000);

      // THE DRAW. Routed through fn_spin_draw_multiplier so that a high
      // multiplier is only ever SELECTED when the Reserve Pool can actually
      // pay it. Excluding an unfundable tier from the draw — rather than
      // drawing it and refusing afterwards — is what makes an unpayable
      // jackpot structurally impossible.
      //
      // Falls back to the local weighted draw if the RPC is unreachable, so a
      // database hiccup cannot stop Spins from running. The fallback can only
      // pick from ALWAYS-AVAILABLE tiers (reserveThresholdX === 0), so it can
      // never hand out a jackpot the pool cannot cover.
      let multiplier: number;
      try {
        const { data: draw, error: drawErr } = await supabase.rpc('fn_spin_draw_multiplier', {
          p_club_id: this.ownerClubId,
          p_buy_in: config.buyIn,
          p_tiers: SPIN_TIERS.map((t) => ({
            multiplier: t.multiplier,
            freq: t.freq,
            reserveThresholdX: t.reserveThresholdX,
          })),
        });
        if (drawErr || !draw?.ok) throw new Error(drawErr?.message || draw?.reason || 'draw_failed');
        multiplier = Number(draw.multiplier);
        if (!(multiplier > 0)) throw new Error('draw returned no multiplier');
      } catch (drawErr: any) {
        const safeTiers = SPIN_TIERS.filter((t) => t.reserveThresholdX <= 0).map((t) => ({
          multiplier: t.multiplier,
          weight: t.freq,
        }));
        multiplier = this.rollSpinMultiplier(safeTiers);
        reportError(
          new Error(
            `[TournamentRecurring] Spin draw RPC unavailable (${drawErr?.message}) — fell back to ungated tiers, capped at ${safeTiers[safeTiers.length - 1].multiplier}x`
          ),
          'TournamentRecurring.spin_draw_fallback'
        );
      }

      // Structure scales with the multiplier: 300 chips and 1-minute levels at
      // 2x, 500 chips and 5-minute levels at 500x. A 2x is over in minutes; a
      // 500x deserves a real tournament.
      const tier = spinTier(multiplier);
      const spinStack = tier?.startingStack ?? config.startingStack;
      const spinLevelMins = tier?.levelMinutes ?? 3;
      const spinBlinds = Array.from({ length: 12 }, (_, i) => {
        const b = spinBlindsForLevel(i + 1);
        return { level: i + 1, smallBlind: b.small, bigBlind: b.big, ante: 0, duration: spinLevelMins * 60 };
      });
      const spinPayouts = (tier?.payouts ?? [1]).map((pct, i) => ({
        place: i + 1,
        percentage: Math.round(pct * 10000) / 100,
      }));

      const gameTypeMap: Record<string, string> = {
        nlh: 'NLH',
        plo4: 'PLO4',
        plo5: 'PLO5',
      };
      const dbGameType = gameTypeMap[config.gameVariant] || 'NLH';

      const { data: spin, error } = await supabase
        .from('tournaments')
        .insert({
          club_id: this.ownerClubId,
          union_id: this.ownerUnionId,
          name: `${config.name} (${multiplier}x)`,
          game_type: dbGameType,
          variant: 'spin',
          tournament_type: 'SPIN',
          buy_in_amount: config.buyIn,
          // A SPIN IS NOT PRICED LIKE AN MTT. Dan, 2026-08-20: "THEY ARE
          // STRAIGHT JUST 10 BUY IN... NO ADDITIONAL RAKE IS ADDED." The rake
          // is engineered into the multiplier distribution instead — the
          // frequency table expects 2.7638, and (3 - 2.7638) / 3 = 7.87%,
          // which IS the advertised 8%. Charging a fee on top as well would
          // make the true edge 14.7%. See src/config/spinSpec.ts.
          buy_in_fee: 0,
          guaranteed_prize: 0, // Will be calculated after registrations
          spin_multiplier: multiplier,
          starting_chips: spinStack,
          // Forced, not read from the config — a Spin is 3-handed by
          // definition. See SPIN_SEATS.
          max_players: SPIN_SEATS,
          min_players: SPIN_SEATS,
          current_players: 0,
          status: 'REGISTERING',
          blind_structure: spinBlinds,
          // Paid places scale with the multiplier: winner-take-all below 10x,
          // 80/20 at 10x, 80/12/8 at 25x and up. A 100x where second place
          // gets nothing is a worse story than one where all three cash.
          payout_structure: spinPayouts,
          start_time: startTime.toISOString(),
          late_reg_levels: 0,
          late_reg_mins: 0,
        })
        .select()
        .maybeSingle(); // FIX 168

      if (error || !spin) {
        reportError(
          new Error(
            `[TournamentRecurring] Spin creation failed: ${error?.message || JSON.stringify(error) || 'Unknown error'}`
          ),
          'TournamentRecurring.Spin_creation_failed'
        );
        return { tournamentId: null, registered: 0 };
      }

      // TOURNEY-AUDIT 2026-07-24 (sweep 6): hold one seat for a human (full
      // fill only on periodic verification games).
      const spinSeatPlan = horsesForSeatHeldGame(config.maxPlayers);
      const registered = await this.registerHorses(spin.id, spinSeatPlan.horses);
      // TOURNEY-AUDIT 2026-07-24 [money]: standard Spin&Go economics — the
      // prize is buyIn x multiplier (ONE unit), not buyIn x players x
      // multiplier. The old formula set a 3-seat 2x spin's pool to 6 units
      // (a ~2.75x average payout on every dollar collected — guaranteed
      // house loss). The GameServer re-rolls the multiplier at start and
      // overwrites this, but the creation-time value must not be inflated.
      const prizePool = Math.round(config.buyIn * multiplier * 100) / 100;

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

  /**
   * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
   *
   * Horses are seeded once at creation, deliberately leaving a seat or two for
   * real players. When nobody took that seat the tournament sat at (max-1)
   * until a 30-minute timer cancelled it. Measured over two days: 557 of 562
   * cancellations were tournaments short by exactly ONE player — 363 at 2/3,
   * 138 at 5/6, 56 at 8/9. A real poker room fills the seat and deals; it does
   * not delete the game.
   *
   * Tops a short tournament up to `targetPlayers` and rewrites current_players
   * from the authoritative tournament_players count — never from an
   * incremented guess, which drifts if a real player registers in the same
   * window. Returns how many horses were actually added.
   */
  async topUpWithHorses(tournamentId: string, targetPlayers: number): Promise<number> {
    try {
      const { count: liveCount, error: countErr } = await supabase
        .from('tournament_players')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .in('status', ['registered', 'playing']);
      if (countErr) return 0;

      const shortfall = targetPlayers - (liveCount || 0);
      if (shortfall <= 0) return 0;

      const added = await this.registerHorses(tournamentId, shortfall);

      // Re-read rather than trusting `liveCount + added`: a human may have
      // registered while we were seating horses.
      const { count: finalCount } = await supabase
        .from('tournament_players')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .in('status', ['registered', 'playing']);

      if (typeof finalCount === 'number') {
        await supabase
          .from('tournaments')
          .update({ current_players: finalCount })
          .eq('id', tournamentId);
      }

      return added;
    } catch {
      return 0;
    }
  }

  private async registerHorses(tournamentId: string, count: number): Promise<number> {
    try {
      // TOURNEY-AUDIT 2026-07-24: exclude horses already registered/playing in
      // another active tournament. The old query only checked horse_status
      // (never flipped by tournament play), so the overlapping MTT/SNG/Spin
      // scheduler intervals double-booked the same horses into several
      // simultaneous events.
      const { data: busyRows } = await supabase
        .from('tournament_players')
        .select('user_id, tournaments!inner(status)')
        .in('status', ['registered', 'playing'])
        .in('tournaments.status', ['ANNOUNCED', 'REGISTERING', 'RUNNING'])
        .limit(2000);
      const busyIds = new Set((busyRows ?? []).map((r: any) => r.user_id));

      /**
       * Dan 2026-08-19: ALSO exclude horses currently sitting at an open table.
       *
       * The tournament-busy check above was the only guard, and `horse_status`
       * is never flipped when a horse takes a CASH seat — live proof: 574
       * horses exist, 329 of them are seated at open tables, and all 574 still
       * read horse_status='available'. Registering those would yank a horse out
       * of a hand it is already playing. That was survivable while tournaments
       * only seeded a dozen horses; now that they fill every seat it would
       * strip live cash tables, so the seat check is mandatory.
       */
      const { data: seatedRows } = await supabase
        .from('table_seats')
        .select('user_id, tables!inner(status)')
        .is('left_at', null)
        .in('tables.status', ['waiting', 'running'])
        .limit(5000);
      for (const r of seatedRows ?? []) {
        if ((r as any).user_id) busyIds.add((r as any).user_id);
      }

      const { data: horsePool } = await supabase
        .from('profiles')
        .select('id, display_name, username, use_real_name')
        .eq('is_horse', true)
        .eq('horse_status', 'available')
        .limit(count + busyIds.size);
      const horses = (horsePool ?? []).filter((h) => !busyIds.has(h.id)).slice(0, count);

      if (!horses || horses.length === 0) return 0;

      /**
       * Dan 2026-08-19: horses BUY IN like everyone else — this used to be a
       * raw INSERT into tournament_players.
       *
       * That INSERT skipped every money step the human path performs: no
       * wallet debit, no rake_records row, no prize_pool contribution. Measured
       * before the fix: in 90 minutes, cash games booked 12,506.44 of rake
       * across 5,657 records while tournaments booked ONE record. Prize pools
       * were still paid in full, so tournaments minted roughly 27,000-30,000
       * chips a day out of nothing.
       *
       * fn_register_horse_for_tournament is fn_register_for_tournament with the
       * caller passed in rather than read from auth.uid() (which the engine has
       * no way to satisfy), and is locked to horses and service_role. Same
       * entry split, same debit, same rake row, same pool updates — so rake is
       * real and the prize pool is funded by actual buy-ins.
       */
      let registered = 0;
      const failures = new Map<string, number>();
      for (const horse of horses) {
        const { data: res, error: regError } = await supabase.rpc(
          'fn_register_horse_for_tournament',
          { p_tournament_id: tournamentId, p_user_id: horse.id }
        );

        if (regError) {
          failures.set(regError.message, (failures.get(regError.message) || 0) + 1);
          continue;
        }
        const ok = (res as { ok?: boolean } | null)?.ok === true;
        if (ok) {
          registered++;
        } else {
          const reason = (res as { reason?: string } | null)?.reason || 'unknown';
          // 'tournament_full' / 'already_registered' are benign races.
          failures.set(reason, (failures.get(reason) || 0) + 1);
        }
      }

      if (failures.size > 0) {
        const summary = [...failures.entries()].map(([r, n]) => `${r} x${n}`).join(', ');
        console.warn(
          `[TournamentRecurring] Horse registration: ${registered} seated, skipped — ${summary}`
        );
      }

      return registered;
    } catch {
      return 0;
    }
  }

  /**
   * Dan 2026-07-28 (engine audit A8): this decided a REAL prize multiplier — the
   * 240x tier is a 0.01% jackpot paid in actual money — with Math.random(), a
   * predictable PRNG, while the engine already ships a CSPRNG. V8's xorshift128+
   * state is recoverable from a modest run of observed outputs, so a player who
   * could watch enough spins could in principle know which lobby was about to
   * deal a jackpot before entering it.
   *
   * Two changes:
   *   - the draw is now `secureRandomInt`, which is rejection-sampled and so
   *     exactly uniform over the integer weight space (the weights are integers
   *     summing to 1,000,000, so no float arithmetic is involved at all);
   *   - the comparison is `r < weight` on a descending remainder rather than
   *     `random -= weight; if (random <= 0)`. The old form let a ZERO-weight tier
   *     win: once the remainder landed exactly on a boundary, `0 <= 0` returned
   *     the next tier in the list even if its weight was 0.
   */
  private rollSpinMultiplier(multipliers: Array<{ multiplier: number; weight: number }>): number {
    const totalWeight = multipliers.reduce((sum, m) => sum + m.weight, 0);
    if (!(totalWeight > 0)) return multipliers[0]?.multiplier ?? 2;

    let r = secureRandomInt(totalWeight);
    for (const { multiplier, weight } of multipliers) {
      if (r < weight) return multiplier;
      r -= weight;
    }

    return multipliers[multipliers.length - 1].multiplier;
  }
}
