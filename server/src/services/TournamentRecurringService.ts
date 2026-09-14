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
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { fetchAllRows } from './supabase/pagination.js';
import { IN_LIST_CHUNK, selectInChunks } from './supabase/chunkedIn.js';
import { reportError } from './errorReporter.js';
import {
  emptySeatFirstPrecheckTally,
  recordSeatFirstPrecheck,
  type SeatFirstPrecheckTally,
} from './seatFirstPrecheckMetrics.js';
import nodeCrypto from 'node:crypto';
import {
  BUY_IN_LADDER,
  DEFAULT_RAKE_RATE,
  buyInFor,
  freeBuyColumns,
  rakeRateFor,
  wholeChips,
} from '../config/buyIn.js';
import { gameLaneFor, horseHash, isActiveNow } from './HorseBehavior.js';
import { BOOKING_COUNTS_WITHIN_MS } from './HorseGameLoad.js';
import { bankrollPolicyFor, canEnterTournament } from './HorseBankroll.js';
import { bankrollEvent } from './HorseBankrollTelemetry.js';
import { buildLadder } from '../tournament/blindLadder.js';
import { mttBountyAmount } from '../tournament/mttBountyAllocation.js';
import {
  MTT_BLIND_PRESETS,
  mttSpeedColumns,
  mttPayoutPercent,
} from '../tournament/mttStructurePolicy.js';
import { clampSeatsForVariant } from '../config/tableSeating.js';
import {
  FREE_BUY_HOSTS,
  FREE_BUY_TIERS,
  auditFreeBuyBoard,
  freeBuySlotsDue,
  freeBuyTournamentRow,
  lateRegLevelsForMinutes,
} from './FreeBuy.js';

/**
 * Derive the two buy-in columns from ONE whole-dollar total.
 *
 * Dan 2026-08-20: "buy ins should always be whole dollars. 20 10 50 5 etc not
 * 19.8." Every insert below used to write `buy_in_amount: config.buyIn` and
 * `buy_in_fee: config.rake` — two hand-authored numbers that the player then
 * paid the SUM of, so the advertised price was 1.1x a round number and never
 * round itself: 5.50, 11.00, 19.80, 22.00.
 *
 * `config.buyIn` is now read as the TOTAL. buyInFor snaps it to the price
 * ladder and cuts the fee out of it, so the player pays exactly config.buyIn.
 * `config.rake` is no longer read by anything — it was the second half of a
 * pair that nothing kept in agreement.
 */
/**
 * Dan 2026-08-25: "HEADS UP EVENTS ARE ONLY A 5% RAKE, SO A 1 CHIP BUY IN X 2
 * PLAYERS = 5% OF 2 CHIPS, SO WINNER TAKES ALL = 1.90 PAYOUT."
 *
 * A duel is two entries, so a 5% cut of the table is 5% of each seat: 0.95 in,
 * 0.05 to the house, twice, and the winner takes the 1.90 pool. Exactly the
 * number Dan wrote.
 *
 * ─── NO LONGER THE RULE, ONLY A NAME FOR IT (2026-08-27) ────────────────────
 *
 * This constant was declared here and had exactly ONE consumer, four lines of
 * code away. The other five creation paths — the owner create modal, the legacy
 * tournament-page form, the table-config path, the client horse orchestrator
 * and ScheduledTournamentService — all called splitBuyIn at the 10% default on
 * a two-seat game, because the rule lived in a service they do not import.
 *
 * It is DERIVED from rakeRateFor now rather than written down twice, so it
 * cannot drift from the helper the other five paths were routed through.
 */
export const SNG_RAKE_RATE = rakeRateFor({ tournamentType: 'SNG', maxPlayers: 2 });

function buyInColumns(
  buyIn: number,
  rakeRate: number = DEFAULT_RAKE_RATE
): { buy_in_amount: number; buy_in_fee: number } {
  const { prize, fee } = buyInFor(buyIn, rakeRate);
  return { buy_in_amount: prize, buy_in_fee: fee };
}

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
  payoutPercent?: 10 | 15 | 20;
  bountyPercent?: number;
  bountyAmount?: number;
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
  payoutPercent?: 10 | 15 | 20;
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
  // NOTE deliberately absent: a spinMultipliers field. The ladder is not a
  // per-config choice — it is THE format, defined once in spinSpec.ts and
  // drawn through the reserve gate at start. A config that could carry its
  // own table is how three disagreeing tables happened.
}

interface AtomicSeatFirstCreation {
  tournament: {
    id: string;
    club_id?: string | null;
    name: string;
    [key: string]: unknown;
  };
  tableId: string;
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
  payoutPercent?: 10 | 15 | 20;
  bountyPercent?: number;
  bountyAmount?: number;
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LADDERS ARE GENERATED NOW, AND THEY ARE DEEP (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These were hand-written arrays of 5-10 levels. Measured across 579 completed
 * MTTs, the average event REACHED level 14 and the deepest reached 124 — so
 * 95.7% of tournaments spent their entire late game on blindEscalation's
 * overflow path, which doubled the blinds every level. 38.1% finished with
 * every chip in play worth under three big blinds, and 41 events ended with the
 * big blind pinned at the DECIMAL(10,2) ceiling of 10,000,000.
 *
 * buildLadder emits chip-friendly levels to any depth from a mantissa cycle, so
 * the ladder now covers the tournament that is actually played instead of the
 * first forty minutes of it. LEVEL 1 OF EACH IS UNCHANGED, so every lobby card,
 * advertised structure and starting-stack-in-big-blinds figure still reads
 * exactly as it did.
 */
export const BLIND_STRUCTURES = {
  // A turbo reaches its own conclusion well inside 24 levels; deeper than that
  // and the ladder's own 1.58x cadence walks past MAX_BLIND_VALUE, which is how
  // the first draft of this generated a 25,000,000 big blind at level 30.
  TURBO: MTT_BLIND_PRESETS.TURBO,
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE FREE BUY LADDER, and why it is not TURBO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Dan set the Free Buy at a 3,000 starting stack, a 10,000 add-on, and
   * "ONE HOUR FOR LATE REG, THEN THE ADD ON PERIOD". Those three numbers
   * together decide the structure, and TURBO cannot satisfy them. Measured on
   * the real ladders before this was written:
   *
   *   BLIND_STRUCTURES.TURBO is 24 levels and 57 MINUTES END TO END. At the
   *   one-hour mark the big blind is 1,500,000 against a 13,000 stack - ZERO
   *   big blinds. The event would be a forced all-in lottery long before the
   *   break, and the 10,000-chip add-on Dan specified would be worth nothing
   *   by the time anybody could take it. Lengthening TURBO's levels does not
   *   help: at 1.58x a level the blind is 10,000 by minute 60 either way.
   *
   * This ladder is chosen so the hour Dan asked for is still poker:
   *
   *   3,000 chips at a 25 big blind          120 BB to start
   *   the hour ends inside level 11, bb 400   33 BB with the add-on taken
   *   30 levels over 153 minutes              19 levels left after late reg
   *
   * `blindLadder.ts` exists because 38.1% of completed events ended with every
   * chip in play worth under three big blinds. A Free Buy on TURBO would have
   * joined them by design rather than by accident.
   */
  FREE_BUY: buildLadder({
    startBigBlind: 25,
    speed: 'STANDARD',
    levels: 30,
    openingMinutes: 6,
    floorMinutes: 5,
    anteFromLevel: 1,
  }),
  // 40 levels at ~1.33x — the reference MTT ladder.
  STANDARD: MTT_BLIND_PRESETS.STANDARD,
  HYPER_TURBO: MTT_BLIND_PRESETS.HYPER_TURBO,
  SNG_6MAX: buildLadder({
    startBigBlind: 20,
    speed: 'TURBO',
    levels: 20,
    openingMinutes: 3,
    floorMinutes: 2,
    anteFromLevel: 3,
  }),
  /**
   * HEADS-UP, three minutes a level (Dan 2026-08-25: "IT NEEDS TO DISPLAY THE
   * BLIND LEVELS (3 MINUTES) AND THE STARTING STACK 300 FOR TURBO AND 1000 FOR
   * DEEP STACK").
   *
   * Heads-Up was running BLIND_STRUCTURES.STANDARD — ten-minute opening levels
   * built for a full-field MTT — with a 1,500 stack into 25/50. That is 30 big
   * blinds and a clock that barely moves: a duel that should be over in
   * minutes was structured like a two-hour tournament, and the lobby card said
   * so ("10 Min Levels", "1,500").
   *
   * The ladder is the Spin ladder, because a Spin and a Heads-Up are the same
   * shape of game — bought seats, no clock to wait for, a stack measured in
   * big blinds rather than chips. 300 into 10/20 is 15bb (turbo); 1,000 is
   * 50bb (deep). Identical level lengths across the whole ladder, which is the
   * rule spinSpec already settled on: tier identity lives in stack depth, not
   * in the clock.
   */
  /**
   * THE DUEL'S LADDER IS THE SPEC'S (2026-08-31, Phase 3). This was a second
   * hand-typed copy of the same twelve rows; the name is kept because the
   * board and its pinning test both read it, but the numbers now have exactly
   * one home -- src/config/headsUpSpec.ts, mirrored byte-for-byte here.
   */
  HEADS_UP_3MIN: HEADS_UP_BLIND_STRUCTURE,
  /**
   * BLIND_STRUCTURES.SPIN IS GONE (2026-08-31, Phase 3). It was a five-level,
   * two-minute ladder that contradicted spinSpec from level 3 up (25/50 where
   * the spec says 20/40, then 50/100 and 100/200 against 30/60 and 40/80) and
   * claimed a two-minute clock the spec sets at three. Nothing should ever
   * hand-type a Spin ladder again: createSpin builds its twelve rows from
   * spinBlindsForLevel, and so does the schedule path as of this change.
   */
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
  SPIN_STACKS,
  SPIN_SEATS,
  SPIN_SPEED_LABELS,
  spinBlindsForLevel,
  type SpinSpeed,
} from '../config/spinSpec.js';
import {
  HEADS_UP_BLIND_STRUCTURE,
  HEADS_UP_BUYINS,
  HEADS_UP_GAME_TYPES,
  HEADS_UP_PAYOUTS,
  HEADS_UP_SEATS,
  HEADS_UP_STACKS,
} from '../config/headsUpSpec.js';
import { secureRandomInt } from '../engine/CryptoRandom.js';

/**
 * THE ONE MAP FROM A CONFIG'S VARIANT KEY TO THE `tournaments.game_type` VALUE.
 *
 * 2026-08-31 audit. There were FOUR hand-kept copies of this map in this file
 * and three of them were incomplete. The Spin copy had already been fixed, and
 * its comment stated the rule that the other three then went on to break:
 *
 *   "`plo6` was missing from it — so a PLO6 Spin config would have been
 *    silently created as NLH, giving players a different game from the one on
 *    the tile. Every member of SPIN_GAME_TYPES must have an entry here."
 *
 * The XMTT and MTT copies omitted `plo6`; the SNG copy omitted `plo6` AND
 * `short_deck`; none of the four knew `flh` or `flo8`, which became creatable
 * tournament variants on 2026-08-31. Because the fallback is a silent
 * `|| 'NLH'`, every gap produces the same failure: the tile advertises one
 * game and the players are dealt another.
 *
 * One map, so a variant added to the catalogue cannot be half-adopted. The
 * fallback stays NLH so an unrecognised config still produces a game rather
 * than a gap in the schedule, but it is REPORTED now instead of silent.
 */
const DB_GAME_TYPE: Record<string, string> = {
  nlh: 'NLH',
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  short_deck: 'SHORT_DECK',
  flh: 'FLH',
  flo8: 'FLO8',
};

/**
 * A GUARANTEE REFUSAL IS PERMANENT, AND SOMEBODY HAS TO BE TOLD.
 *
 * trg_tournaments_guarantee_affordable refuses an event whose guaranteed
 * prize the funding bank cannot cover, raising "Club X cannot guarantee N
 * chips ... Add chips to the bank to cover the guarantee." Every hourly config
 * in this file carries a guarantee, so a short bank means the event silently
 * never happens: this service retried three times, five seconds apart, logged
 * to the error reporter and moved on. Nobody who could fix it was told, and
 * the 2026-08-29 migration records what that looks like at scale — "Midway
 * Union ... was refused ~570 spawns/hour".
 *
 * ScheduledTournamentService already does this half correctly. This is the
 * same call from the same signature. fn_notify_guarantee_bank_short dedupes
 * on unread per recipient per bank, so an hourly schedule that keeps failing
 * produces ONE standing bell notification rather than a storm.
 *
 * Retrying is also pointless — the bank does not refill in ten seconds — so
 * the caller breaks out of its retry loop on a true return.
 */
function isGuaranteeRefusal(error: { message?: string } | null | undefined): boolean {
  return /cannot guarantee/i.test(String(error?.message ?? ''));
}

async function notifyGuaranteeShort(clubId: string | null | undefined, where: string) {
  if (!clubId) return;
  const { error } = await supabase.rpc('fn_notify_guarantee_bank_short', { p_club_id: clubId });
  if (error) {
    reportError(
      new Error(
        `[RecurringService] ${where}: guarantee refusal could not notify: ${error.message}`
      ),
      'TournamentRecurringService.guarantee_notify_failed'
    );
  }
}

/** The `game_type` a config's variant becomes, loudly if we do not know it. */
function dbGameTypeFor(gameVariant: string | null | undefined, where: string): string {
  const key = String(gameVariant ?? '').toLowerCase();
  const mapped = DB_GAME_TYPE[key];
  if (mapped) return mapped;
  reportError(
    new Error(
      `[RecurringService] ${where}: unmapped game variant "${gameVariant}" - created as NLH. ` +
        `Add it to DB_GAME_TYPE.`
    ),
    'TournamentRecurringService.unmapped_game_variant'
  );
  return 'NLH';
}

// The local SPIN_MULTIPLIERS table that lived here — one of THREE that
// disagreed (EV 3.00 designed, 2.75 here, 2.24 in the engine fallback), and
// the one that actually ran — is GONE, not merely derived. The draw happens
// exactly once, at start, in TournamentManagerBase, through
// fn_spin_draw_multiplier against src/config/spinSpec.ts. This file no
// longer knows how to pick a multiplier at all, which is the only number of
// multiplier tables a creation service should have.

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
/**
 * Dan 2026-08-21: "the tables just stay open until players sit down, they don't
 * need to be scheduled just always running."
 *
 * FLIPPED BACK TO TRUE. The reason it was false is recorded above: holding a
 * seat produced 557 cancellations in two days, every one of them a game short
 * by exactly one player. That reason no longer exists - the cancel path was
 * removed on 2026-08-19 ("TOURNAMENTS RUN. THEY DO NOT CANCEL", GameServer
 * ~1150), and the only remaining sweep walks a 12-hour-idle RUNNING event
 * through a real finish with payouts. A game that waits can no longer be
 * destroyed for waiting.
 *
 * What stops a held seat from freezing the board instead: GameServer's
 * past-start top-up fills any short game to a full field once its start time
 * passes, so a table nobody takes eventually runs anyway and ensureBoardOpen
 * opens a fresh one behind it. Open first, churn second - which is exactly the
 * mix the reference lobby shows (0/3, 1/3, 2/3 and running side by side).
 */
const HOLD_SEAT_FOR_HUMAN = true;

/**
 * How long a freshly opened spin/SNG waits for a human before the past-start
 * top-up is allowed to fill it.
 *
 * Was 60 seconds, which is not "open" in any sense a player would recognise -
 * a table created and auto-filled inside a minute is a scheduled game with
 * extra steps. Ten minutes is long enough that the board genuinely reads as
 * available, and short enough that an untouched table still cycles rather than
 * sitting dead all night.
 */
const OPEN_TABLE_WAIT_MS = 10 * 60 * 1000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HUMAN WINDOW ON A SEAT-FIRST GAME (Dan, 2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "for all spins, and heads up: 2 horses register (for spins and one for heads
 *  up), and leave registration open for anywhere from 60-180 seconds before
 *  another horse can fill the seat for human players."
 *
 * So a Spin opens at 2/3 and a heads-up at 1/2, and the LAST seat belongs to a
 * human for 90 to 350 seconds before a horse is allowed to take it.
 *
 * Randomised per game, not fixed, for a reason worth stating: a constant delay
 * makes the whole board tick over in lockstep, so every table on the lobby
 * fills at the same instant and the room reads as a machine. Spreading the
 * window means tables mature independently, which is what a real room looks
 * like - some just opened, some about to go.
 *
 * The previous value was a flat ten minutes, and before that sixty seconds.
 * Ten minutes was chosen when nothing filled the seat properly; now that the
 * top-up genuinely seats horses, a shorter window keeps the board moving
 * without ever taking the seat out from under someone who is mid buy-in.
 *
 * Dan 2026-09-03, restating the rule with a new ceiling: "YOU ARE SUPPOSED TO
 * WAIT 60-150 SECONDS TO ALLOW A HUMAN TO PLAY, BEFORE A 3RD HORSE CAN JOIN
 * AND PLAY." The window is the START TIME of the game, and GameServer's
 * past-start top-up is what seats the last horse once it has passed - so the
 * third horse joins some seconds after the board opened, never sooner, and the
 * seat is a human's until then.
 *
 * ── WIDENED TO 90-350 SECONDS (Dan 2026-09-05) ──────────────────────────────
 *
 * Dan: "fleet should hold the seat for 90-350 seconds max before filling the
 * 3rd seat."
 *
 * The measurement that prompted it: in the seven days to 2026-09-05 this
 * platform ran 31,153 Spins and FOUR of them had a human in them. The fleet
 * was playing 4,450 games a day against itself. A 60-150s window is a narrow
 * door, and it was narrower still in practice because a separate defect (the
 * `playHasBegun` stack latch, fixed the same day) meant a board a horse had
 * already sat at showed no SIT button at all - so the door was not merely
 * narrow, it was painted on.
 *
 * 90 at the floor because a human who opens the lobby, reads the stakes and
 * taps a seat needs longer than a minute; 350 at the ceiling because a board
 * that sits open for six minutes stops looking like a room that is about to
 * deal. Still randomised per game, for the reason above: a constant delay
 * makes the whole board tick over in lockstep.
 */
export const SEAT_FIRST_HUMAN_WINDOW_MIN_MS = 90 * 1000;
export const SEAT_FIRST_HUMAN_WINDOW_MAX_MS = 350 * 1000;

function seatFirstHumanWindowMs(): number {
  const span = SEAT_FIRST_HUMAN_WINDOW_MAX_MS - SEAT_FIRST_HUMAN_WINDOW_MIN_MS;
  // secureRandomInt, deliberately. CryptoRandom.test.ts bans the unseeded
  // language-level RNG anywhere in this file, and it is right to: item A8 of
  // its header records rollSpinMultiplier having picked a REAL MONEY
  // multiplier with it. A guard narrow enough to allow "but mine is only a
  // timer" is a guard that gets talked around. This IS only a timer, and it
  // costs nothing to be correct.
  //
  // The comment is worded around the banned token on purpose - the check reads
  // raw file text, so even naming it here would trip it.
  return SEAT_FIRST_HUMAN_WINDOW_MIN_MS + secureRandomInt(span + 1);
}

/**
 * How many horses open a seat-first game: every seat but one.
 *
 * Spin (3 seats) -> 2 horses. Heads-up (2 seats) -> 1 horse. The remaining
 * seat is the human's for the window above.
 */
function openingHorsesForSeatFirst(seats: number): number {
  return Math.max(0, seats - 1);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELD-EMPTY SEAT-FIRST GAMES (Dan 2026-08-26, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 * "LEAVE ... 33% OF ALL SPINS AND 50% OF HEADS UP [EMPTY]."
 *
 * A board where every Spin already has two horses in it never offers a player
 * the experience of STARTING a game. So a deterministic share of seat-first
 * games opens with ZERO horses and stays empty until a human buys a seat. The
 * moment one does, topUpWithHorses fills the remaining seats and the game
 * starts on the normal start-when-full rule.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HOLD ROTATES. IT IS NOT A LIFE SENTENCE. (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This originally hashed the tournament id ALONE, so a board that rolled
 * held-empty was held empty FOREVER. On its own that is only a stalled game;
 * combined with how the board decides what to open, it killed the entire
 * seat-first product in under two hours:
 *
 *   1. ensureBoardOpen treats ANY joinable REGISTERING instance as covering
 *      its price point, so it opens no replacement while one exists.
 *   2. A held-empty instance never fills, so it never starts, so it never
 *      leaves REGISTERING.
 *   3. Its price point is therefore covered by a husk, permanently.
 *   4. A NOT-held instance fills, starts, completes, and is replaced by a
 *      fresh instance that re-rolls the hold.
 *
 * That is an absorbing Markov chain: every price point keeps re-rolling until
 * it draws "held", and then it is stuck there. With ~300 Spins completing an
 * hour, all 48 price points absorbed within about two hours of the rule
 * shipping at 00:56 UTC on 2026-08-27.
 *
 * MEASURED ON PRODUCTION 2026-08-27, ~20 hours later. The 49 surviving
 * REGISTERING boards were 90% under the 33 threshold and 100% under 50 — the
 * board had become a sieve that retains precisely the held-empty rolls. The
 * hash itself is fine (2,000 random uuids gave 33%/50%, and the last 1,000
 * COMPLETED seat-first games gave 30%/47%); it was survivorship, not skew.
 * Spins fell from ~300 starts/hour to 1, Heads-Up from ~150/hour to ZERO, and
 * nothing on the platform reported it because every refusal on this path
 * returns 0 silently.
 *
 * So the hold is now bucketed in time, like its sibling cashTableHeldEmpty.
 * (An earlier version of this comment claimed that sibling "was written
 * correctly and rotates every 2h" — it was not. It folded the bucket into the
 * same weak hash this block warns about, so its holds WALKED rather than
 * re-rolled and a table could stay held ~30 hours. Fixed 2026-08-30 with the
 * same mix32 avalanche used below; the avalanche now lives in HorseBehavior.) A
 * board held empty in one bucket is fillable in the next, so a price point
 * cannot ossify, while at any given INSTANT the requested share of the board
 * is still genuinely empty and waiting for a human. That is what Dan asked
 * for; a permanently dead board is not.
 *
 * The bucket is SHORTER than the cash room's 2h on purpose. A cash table is
 * long-lived, so a 2h hold is a fraction of its life. A Spin instance lives
 * minutes, so a 2h hold outlives many whole games and is what let one roll
 * ossify a price point for a day.
 */
export const SEAT_FIRST_EMPTY_BUCKET_MS = 30 * 60_000;

/**
 * A REAL AVALANCHE, BECAUSE THE ROTATION DEPENDS ON IT.
 *
 * `horseHash` is a weak multiply-add (`h * 31 + c`), and this file and
 * HorseBehavior both already record that a LOW-BIT modulo of it clusters on
 * structured ids. Rotation makes that worse, not better: consecutive bucket
 * numbers are the most structured input there is, so folding the bucket into
 * the same weak hash leaves neighbouring buckets CORRELATED — and a board
 * whose buckets correlate stays held for hours at a time, which is the bug
 * being fixed here wearing a smaller hat. Caught by
 * seatFirstHoldRotates.test.ts, which found a board held for 8 straight
 * buckets (four hours) with the naive `${id}:hold-empty:${bucket}` string.
 *
 * This is the murmur3 finalizer. It is not cryptography; it is the standard
 * cheap way to make every output bit depend on every input bit, which is
 * exactly the property "does this board rotate" needs and the property
 * `horseHash` does not have.
 */
function mix32(x: number): number {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

export function seatFirstHeldEmpty(
  tournamentId: string,
  seats: number,
  nowMs: number = Date.now()
): boolean {
  const frac = seats <= 2 ? 0.5 : 0.33;
  const bucket = Math.floor(nowMs / SEAT_FIRST_EMPTY_BUCKET_MS);
  // Golden-ratio odd constant so the bucket spreads across the whole word
  // before the finalizer mixes it into the id's hash.
  const seed = (horseHash(`${tournamentId}:hold-empty`) ^ Math.imul(bucket, 0x9e3779b1)) >>> 0;
  return mix32(seed) % 100 < frac * 100;
}

/**
 * The pure half of pickFreeHorses: given the FULL fleet id list, drop the
 * busy horses (the 4-game cap, computed by the caller from horseLoadMap) and
 * apply the lane / activity-window filters. Exported so the unit tests can
 * prove two properties without a database: a busy horse is never selected,
 * and selection can reach the whole fleet rather than a stable first page.
 */
/**
 * Where registerHorses starts walking its candidate queue for THIS event in
 * THIS hour: an offset in [0, poolLength). Pure, so the spread is pinned
 * without a database. The event id is in the seed so two events ramped in the
 * same hour start at different horses; the hour is in it so one event's queue
 * still moves along over the day (the old `(hour * 7919) % length` kept only
 * the second property, and one horse collected 34 bookings in an hour).
 */
export function rampQueueRotation(
  tournamentId: string,
  hourUTC: number,
  poolLength: number
): number {
  const n = Math.max(0, Math.floor(Number(poolLength) || 0));
  if (n === 0) return 0;
  const seed = (horseHash(`${tournamentId}:ramp-rotation`) ^ Math.imul(hourUTC, 7919)) >>> 0;
  return mix32(seed) % n;
}

export function selectHorseCandidates(
  fleetIds: string[],
  busy: ReadonlySet<string>,
  allLanes: boolean,
  hourUTC: number
): string[] {
  return fleetIds.filter((id) => {
    if (!id || busy.has(id)) return false;
    // Freeroll override: every horse that is currently PLAYING is eligible,
    // cash lane included. See topUpWithHorses opts.allLanes.
    if (allLanes) return isActiveNow(id, hourUTC);
    // Game lanes (Dan 2026-08-26): cash-only horses never enter events —
    // tournaments, spins and heads-up draw from the events/both lanes.
    return gameLaneFor(id) !== 'cash';
  });
}
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SEAT-FIRST GAMES (Dan, 2026-08-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "SPINS AND HEADS UP ARE FIRST COME FIRST SERVE, A PLAYER 'SITS DOWN' AT A
 *  TABLE AND BUYS INTO THE SPIN OR HEADS UP, LIKE A CASH GAME, NOT LIKE A MTT
 *  TOURNAMENT. THE SPIN STARTS WHEN ALL 3 PLAYERS HAVE BOUGHT INTO THE SPIN,
 *  THE HEADS UP BEGINS WHEN BOTH PLAYERS BUY IN."
 *
 * Spins (3 seats) and Heads-Up (2 seats) are created as a TABLE WITH OPEN
 * SEATS, not as a registration list. Nobody is pre-seated: the seats are
 * genuinely empty and first come, first served. A player takes a seat and pays
 * in one atomic step (fn_take_seat_and_buy_in), and the game starts the moment
 * the last seat is bought — GameServer's start-when-full rule, which for these
 * formats now means "every seat sold" rather than "the registration list is
 * long enough".
 *
 * Larger SNG fields (6-max, 9-max) and MTTs keep the scheduled-registration
 * model: they are events, not tables you walk up to.
 */
/** The columns joinability is decided from. Kept minimal so the read stays cheap. */
export interface TournamentTableJoinability {
  status?: string | null;
  is_deleted?: boolean | null;
}

/**
 * Can a player actually sit at this table row?
 *
 * A deleted row is gone and a closed row cannot be seated into -
 * fn_take_seat_and_buy_in and the engine's own discovery both read
 * status IN ('waiting','running'). Anything else is joinable; an unknown
 * status is treated as joinable on purpose, because the failure direction
 * that matters is calling a live table dead and opening a duplicate board.
 */
export function isJoinableTableRow(row: TournamentTableJoinability | null | undefined): boolean {
  if (!row) return false;
  if (row.is_deleted === true) return false;
  return String(row.status ?? '').toLowerCase() !== 'closed';
}

export function isSeatFirstFormat(variant: string, maxPlayers: number): boolean {
  return String(variant).toLowerCase() === 'spin' || maxPlayers <= 2;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLUB BOARD FILLS FROM ITS OWN MEMBERS, OR IT NEVER FILLS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01 (the Deep Stack Society directive): heads-up / SNG boards
 * must open for activated CLUB owners, not just the house board.
 * Dan, 2026-09-02: DSS horses "PLAY OPENLY INSIDE THE DEEP STACK SOCIETY ONLY."
 * Dan, 2026-09-02 and 2026-09-03: those boards sit at 1/2 seated forever.
 *
 * All three are the same story. checkAndLaunchSNGs was taught to open boards
 * for activated club owners, and topUpWithHorses was never taught to fill
 * them: it refused every top-up outside the house board. So the platform
 * opened boards it had forbidden itself to fill. Measured on production
 * 2026-09-03 08:2x UTC:
 *
 *   Midway Union (the house board)   62 heads-up RUNNING, 60 spins RUNNING
 *   Deep Stack Society                6 heads-up REGISTERING, ZERO EVER RUNNING
 *
 * Every DSS board took a real buy-in from the first player to sit and then
 * held it forever: 32 stuck since 09-01 18:42, another 32 created 09-02
 * 22:26-22:51 and stuck the same way, both batches cancelled and refunded by
 * hand. The engine also retried each one every twelve seconds, which is where
 * 24,490 calls of fn_sync_seat_first_player_count in 76 minutes came from -
 * 2,292 seconds of database time spent on boards that could not move.
 *
 * The gate's own comment already stated the right rule: "a user-owned club
 * fills its tournaments with users who joined that club through Join A Club."
 * The CODE said "the house board only", which is stricter than the rule it
 * documents and is what contradicted the 09-01 directive.
 *
 * The rule is now enforced where it belongs - in the POOL, not in a gate.
 * pickFreeHorses already narrows every candidate to
 * clubMemberIdsForTournament(): a standalone club draws on its own members and
 * nothing else, a union event on every club in that union. DSS boards fill
 * from DSS horses, exactly as Dan asked, and no house horse can wander into a
 * user club's game.
 *
 * 2026-09-03, later the same day: the "still house-only" MTT half of this
 * gate is gone too. The pool it was said to protect (registerHorses) has been
 * club-scoped since 09-01, so the refusal protected nothing and emptied every
 * scheduled Deep Stack Society event. topUpWithHorses no longer consults this
 * predicate for any format. It remains exported as the house-board test, with
 * its pins, for a caller that genuinely needs "is this the house".
 */
export function automatedRegistrationIsPermitted(
  clubId: string | null | undefined,
  houseClubId: string | null | undefined
): boolean {
  const club = String(clubId ?? '');
  const house = String(houseClubId ?? '');
  if (!club || !house) return false;
  return club === house;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MTT PRE-START HORSE RAMP — Dan 2026-08-23, BINDING, STANDARD PRACTICE
 * ───────────────────────────────────────────────────────────────────────────
 * "HORSES NEED TO BE REGISTERING FOR MTT TOURNAMENTS UP TO AN HOUR BEFORE THE
 *  TOURNAMENT STARTS. PLAYERS DON'T JUMP IN AND PLAY TOURNAMENTS THAT HAVE NO
 *  PLAYERS IN THEM."
 *
 * WHAT WAS ACTUALLY HAPPENING
 * Horse seeding ran at exactly two moments: once when the tournament row was
 * created, and again only AFTER the start time had passed. Neither covers the
 * hour a human spends looking at the lobby deciding what to play. Measured on
 * production while writing this: "All-In or Fold Frenzy", a 200-seat event,
 * had been sitting in the lobby for SEVENTEEN AND A HALF HOURS reading 0/200,
 * two minutes from its start. Nobody registers for that, so it stayed empty,
 * and the only thing that ever filled it was the past-start rescue - by which
 * point every human who looked at it had already gone elsewhere.
 *
 * The spawn-time check made this inevitable rather than unlucky: it asked "does
 * this start within 15 minutes?" ONCE, at creation. An event published a day
 * ahead answered no, and was never asked again.
 *
 * THE CURVE, AND WHY IT IS NOT A STEP
 * A field that appears all at once reads as fake, and a field that appears at
 * T-60 and then never moves reads as dead. Real MTT registration is slow early
 * and piles in near the close, so the target is quadratic in elapsed ramp time:
 * gentle for the first half hour, steep in the last ten minutes. A player
 * refreshing the lobby sees a number that keeps going up, which is the actual
 * product goal here - not the final count.
 *
 * THREE SAFETY PROPERTIES, ALL DELIBERATE
 *  1. It never targets more than `maxPlayers - 1`, so the ramp can NEVER trip
 *     the `maxReached` start gate in discoverTournaments and begin an event
 *     ahead of its own clock. There is always a seat for a human.
 *  2. It is capped at MTT_PRESTART_MAX_HORSES regardless of field size,
 *     UNLESS the event carries a guarantee - see the guarantee block in the
 *     function. Every registration is a REAL funded entry through
 *     fn_register_horse_for_tournament (an exact returned ticket first, or a
 *     real wallet debit; both write real rake and prize-pool contribution),
 *     so an uncapped ramp on a 1,000-seat event
 *     would spend the club's chips on a field nobody asked for. A guarantee
 *     is the one case where the club has ALREADY promised that money, so
 *     covering it with entries is strictly better than paying it as overlay.
 *     Filling the rest is the past-start top-up's job, on the clock.
 *  3. Seat-first games (Spin, heads-up) return 0 and are left completely
 *     alone. Their binding rule is that they start when seats are BOUGHT, and
 *     registrations are not seats.
 *
 * Returns the number of registered entrants the field SHOULD have right now.
 * The caller tops up toward it and never removes anybody.
 */
/**
 * How far ahead of the gun the field starts building.
 *
 * WAS ONE HOUR, AND THAT IS WHY THE BOARD WAS DEAD (Dan 2026-08-26: "horses
 * should be registering and playing the tournaments anyways").
 *
 * Measured on production the day this changed: of 37 REGISTERING MTTs, THIRTY
 * SIX had a field of exactly ZERO, and the nearest one to the gun was 86
 * minutes out - just outside the window. So the entire tournament board read
 * "0 entered" at every moment except the final hour of each event. A lobby
 * full of empty games is not a lobby anybody joins; the one thing that makes a
 * player enter a tournament is other players already in it.
 *
 * 72 hours matches the lobby's own publish window exactly
 * (tournamentScheduleWindow). The rule is now simply: IF IT IS ON THE BOARD,
 * IT LOOKS LIKE A REAL EVENT. Nothing is announced that is not also populated.
 *
 * WHY THIS IS AFFORDABLE, measured rather than assumed. The old note below
 * said the pool was finite and "most of them already dealing cash". That was
 * true when a seated horse was invisible to every tournament; it stopped being
 * true when horses learned to multi-table. Live at the time of writing:
 *
 *   584 horses x 4 games each   = 2,336 slots
 *   in use (seats + pre-starts) =   664
 *   FREE                        = 1,672
 *   this change costs           =   296  (17.7% of what is free)
 *
 * and 209 horses are completely idle. The squared curve does the shaping: an
 * event three days out gets the `Math.max(1, ...)` floor of one entrant, and
 * the field builds toward MTT_PRESTART_MAX_HORSES as the gun approaches. Far
 * events look started, near events look busy, which is what a real room looks
 * like.
 *
 * NOTE THIS IS NO LONGER TIED TO HORSE_SEED_WITHIN_MS. Those two were aligned
 * on 2026-08-23 when both meant "about to start". They now mean different
 * things: this is the whole build, that is the head start given at SPAWN, and
 * a spawn-time seed three days early would put chips in a pool for an event
 * nobody can see yet. See the note on HORSE_SEED_WITHIN_MS.
 */
export const MTT_PRESTART_RAMP_MS = 72 * 60 * 60 * 1000;
export const MTT_PRESTART_MAX_HORSES = 24;
/**
 * Most entrants the ramp will add in a single tick.
 *
 * registerHorses buys in ONE HORSE PER RPC, sequentially, and the ramp runs
 * inside discoverTournaments - the same 5-second loop that decides when
 * tournaments START. A cold engine coming up two minutes before a big event
 * would compute a target of 23 and fire 23 round trips in one pass, holding
 * up every other tournament's start check behind it.
 *
 * It is also the more honest shape. Twenty-three entrants appearing between
 * one lobby refresh and the next reads as a script; a few at a time reads as
 * people arriving. If a burst is ever genuinely needed - an engine restart
 * right before the gun - the past-start top-up is the backstop and it aims at
 * a full field anyway.
 */
export const MTT_PRESTART_MAX_STEP = 6;

/**
 * HOW LONG BEFORE ITS OWN START A RECURRING EVENT IS PUBLISHED.
 *
 * THIS IS THE NUMBER THAT WAS PAYING THE OVERLAY. The ramp above is built for
 * a 72-hour window and adds at most MTT_PRESTART_MAX_STEP entrants per tick,
 * no oftener than every 45 seconds (GameServer.lastMttRampAt). The two
 * recurring creators handed it 60 SECONDS (createTournament) and 5 MINUTES
 * (createXMTT), so the build had one tick and seven ticks respectively - a
 * ceiling of 6 and 42 entrants no matter how many horses were free.
 *
 * Measured on 5 days of completed guaranteed events before this change:
 *
 *   published < 10 min ahead   299 events   58.5% overlaid   24,495.40 paid
 *   published > 24 h ahead      38 events   10.5% overlaid      420.00 paid
 *
 * and the >24h group's pools OVERSHOOT their guarantees on average (1,920.77
 * pool against 1,060.53 guaranteed). Same ramp, same fleet, same horses. The
 * only difference is how long it had to run.
 *
 * It was never a capacity problem, which is the wrong diagnosis this replaces:
 * 392 of the union's 584 horses carry a tournament lane and each may play four
 * games, so ~1,568 tournament slots were sitting idle while the club paid
 * overlay out of treasury.
 *
 * 30 MINUTES, not 72 hours. The ramp's window is a CEILING, not a target - the
 * squared curve means an event published three days out sits at one entrant
 * for most of that time, and the recurring board is a rolling one whose
 * duplicate guard keys on "an instance of this name is already REGISTERING".
 * Publishing a whole day ahead would hold the next instance of every recurring
 * event behind the current one and thin the board. 30 minutes is 40 ticks =
 * 240 entrants of headroom, against a largest current recurring requirement of
 * 56 (Union Grand Championship, 2,500 guaranteed at a 45 prize share).
 *
 * It also makes the lobby honest. An event that appears 60 seconds before it
 * starts cannot be joined by a human who is not already staring at the board.
 */
export const MTT_PUBLISH_LEAD_MS = 30 * 60 * 1000;

/** How often the Free Buy board is reconciled. See checkAndCreateFreeBuys. */
export const FREE_BUY_TICK_MS = 5 * 60 * 1000;

/** How often the board is AUDITED against its own spec. See the watch. */
export const FREE_BUY_AUDIT_EVERY_MS = 60 * 60 * 1000;

/**
 * How often one tournament may be ramped. Mirrors the throttle in
 * GameServer.discoverTournaments (`now - lastRamp >= 45_000`), and exists here
 * so mttPrestartHorseTarget can work out how many ticks are left before the
 * gun without a database or a clock. If the GameServer throttle ever changes,
 * change this with it - they are the same number and a test pins that the
 * ramp can cover a guarantee inside the published lead.
 */
export const MTT_PRESTART_TICK_MS = 45 * 1000;

/**
 * Does this format start on SEATS BOUGHT rather than on registrations?
 *
 * Deliberately BROADER than isSeatFirstFormat, and deliberately not merged
 * with it. isSeatFirstFormat answers "does topUpWithHorses need to seat this
 * player rather than register them", which is spin-or-heads-up. The START GATE
 * in discoverTournaments asks a different question and gets a different
 * answer: it treats `variant === 'sng'` as seat-first at ANY size.
 *
 * Those two disagreed for a 6-max SNG, and the ramp used the narrower one. It
 * would have registered horses into a game whose start gate counts seats, so
 * the registrations would never become seats and never start anything - while
 * current_players climbed to 6/6 with zero seats sold. That is precisely the
 * drift this codebase already fought once, with live spins reading 3/3 on two
 * bought seats (which then refuses every further sit-down as 'tournament_full')
 * and 0/3 on three.
 *
 * No such tournament exists today - every live sng is heads-up - but the 6-max
 * shape is generated by the SNG board and is one config flag away. The ramp
 * therefore uses the STRICTER test on purpose: being stricter can only ever
 * mean "we declined to ramp something we could have", never "we ramped
 * something that breaks".
 */
/**
 * Dan 2026-08-23: "each horse can play up to 4 tables".
 *
 * The ceiling on how many live games one horse identity may be committed to
 * at once. Below it a horse is pickable; at it, it is not.
 */
export const HORSE_MAX_CONCURRENT_TABLES = 4;

/**
 * How close to its start an event must be before a horse's REGISTRATION in
 * it counts as one of its concurrent games. Seat-first games (spins,
 * heads-up, SNGs) run three to twenty minutes, so a horse booked for an MTT
 * further out than this can still take one and be back before the field
 * seats. Measured 2026-09-07: without this bound 2,092 far-future bookings
 * held 615 of 1,000 horses out of every open board.
 *
 * THE DATABASE'S WINDOW, NOT A SECOND ONE (2026-09-11). This was a literal 30
 * minutes while `fn_concurrent_game_load` clause (2) counts a booking from 60
 * minutes before its start ("A BOOKING IS A GAME FROM ONE HOUR BEFORE ITS
 * TOURNAMENT STARTS") and HorseGameLoad.ts, the fleet's mirror of the same
 * function, says 60 too. A picker that counts less than the trigger offers
 * horses the trigger then refuses: measured live 2026-09-11 13:5x UTC, 21 of
 * 1,000 horses read as pickable here and at four games in the database, and
 * every one of them cost a locked RPC that ended "FOUR TABLE LIMIT". One
 * constant, imported from the mirror the fleet already trusts, so the three
 * cannot disagree again.
 */
export const REGISTRATION_LOAD_HORIZON_MS = BOOKING_COUNTS_WITHIN_MS;

export function horseAtCapacity(load: number): boolean {
  return (Number(load) || 0) >= HORSE_MAX_CONCURRENT_TABLES;
}

/**
 * How long a HorseTopUpPass may hold an answer (2026-09-11). The pass forgets
 * everything when one of ITS top-ups seats or registers somebody, but the rest
 * of the platform - the fleet's cash seating, the seat-first fast lane, the
 * scheduler, humans buying seats - moves horses without telling it. The old
 * walk re-read at the start of every top-up, so its answers were a few
 * seconds old at the first seat. Ten seconds keeps them close to that: a walk
 * that runs 40 s after a thaw re-reads four times instead of ~150, and a walk
 * that slows down for any reason cannot make its answers any older.
 */
export const HORSE_TOP_UP_PASS_MAX_AGE_MS = 10_000;

/**
 * ONE FLEET READ PER DISCOVERY PASS (2026-09-11).
 *
 * GameServer.discoverTournaments tops up every short REGISTERING tournament,
 * and every topUpWithHorses call re-read the same pass-invariant answers
 * before it could say "nobody": the four-game load map (three 1,000-row joined
 * seat pages plus a registration page), the whole horse fleet (two pages), the
 * cash-room reserve (two reads) and its club's entire membership (two to four
 * reads) - eleven of the ~16 sequential round trips of a seat-first top-up.
 * Measured on production 2026-09-11 04:36-04:44Z: ~146 such calls in one pass
 * at a median 2.6 s each, nearly all ending "0 of N claimable", so a pass took
 * 8-10 minutes and every start, ramp and top-up waited behind it.
 *
 * A pass holds those answers once. It changes WHEN they are read, never what
 * is decided from them:
 *   - an unknown answer (null load map, incomplete page, unreadable reserve or
 *     membership) is never held, so the next caller asks again, as before;
 *   - when one of the pass's top-ups has seated or registered anybody, the pass
 *     forgets it all, so the next claim is decided on fresh reads, as the old
 *     walk did;
 *   - nothing is held longer than HORSE_TOP_UP_PASS_MAX_AGE_MS, so what the
 *     rest of the platform changes reaches the walk within seconds however
 *     long the walk runs;
 *   - the database still decides every claim (the four-table trigger under its
 *     per-player lock, the seat RPC's tournament lane, roster capacity),
 *     exactly as it always did across the read-then-claim gap every caller
 *     already has.
 * A caller that passes no HorseTopUpPass (the fast lane, the boards, the
 * scheduler, the overlay guard) reads everything per call, unchanged.
 */
export class HorseTopUpPass {
  private readonly held = new Map<string, { readAt: number; answer: Promise<unknown> }>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    maxAgeMs: number = HORSE_TOP_UP_PASS_MAX_AGE_MS,
    now: () => number = () => Date.now()
  ) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  /**
   * The answer for `key`, read at most once per pass and per maxAgeMs; `keep`
   * says whether it may be held at all.
   */
  once<T>(key: string, read: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
    const held = this.held.get(key);
    if (held && this.now() - held.readAt < this.maxAgeMs) return held.answer as Promise<T>;
    const pending: Promise<T> = read().then(
      (value) => {
        if (!keep(value) && this.held.get(key)?.answer === pending) this.held.delete(key);
        return value;
      },
      (error: unknown) => {
        if (this.held.get(key)?.answer === pending) this.held.delete(key);
        throw error;
      }
    );
    this.held.set(key, { readAt: this.now(), answer: pending });
    return pending;
  }

  /** Somebody was seated or registered: nothing held may decide the next claim. */
  forget(): void {
    this.held.clear();
  }
}

/** Through the pass when the caller holds one, straight to the database when not. */
function viaTopUpPass<T>(
  pass: HorseTopUpPass | undefined,
  key: string,
  read: () => Promise<T>,
  keep: (value: T) => boolean
): Promise<T> {
  return pass ? pass.once(key, read, keep) : read();
}

/**
 * One entry in a load list: a bare user id, or a user id carried with the
 * tournament the seat/registration belongs to. The richer shape is what makes
 * the seat-first dedupe below possible; the bare one is kept because most
 * callers and every unit test are only exercising the counting.
 */
export type LoadRef =
  | string
  | null
  | undefined
  | { user_id?: string | null; tournament_id?: string | null };

function refUser(ref: LoadRef): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  return ref.user_id || null;
}

function refTournament(ref: LoadRef): string | null {
  if (!ref || typeof ref === 'string') return null;
  return ref.tournament_id || null;
}

/**
 * Games-per-horse, from the two things that constitute a commitment: a live
 * seat, and a registration in a tournament that has not started yet.
 *
 * Pure so the double-counting rule is testable without a database, because
 * that is the part with a real bug in it. A RUNNING tournament's entrants
 * hold SEATS, so they arrive through the seat list; if the caller also passed
 * them as registrations every tournament regular would read as 2 and the
 * effective ceiling would silently halve.
 *
 * ── THE HOLE IN THAT REASONING, MEASURED 2026-08-28 ──
 *
 * "RUNNING entrants hold seats" was true and was not enough, because a
 * SEAT-FIRST game sells the chair BEFORE it starts: a spin sits at
 * REGISTERING with its seats already sold, so the same horse arrives once
 * through the seat list and once through the pending-registration list and is
 * counted twice for one game. Excluding RUNNING cannot catch it — the
 * tournament genuinely has not started.
 *
 * The cost is the opposite of the leak this function is famous for: horses
 * read BUSIER than they are, so the picker declines them and fills starve.
 * Measured against production on 2026-08-28, over the accounts carrying any
 * load at all: 20 read as over the four-game cap, and only 3 actually were.
 * Seventeen horses were being held out of every board by a game they were
 * only playing once.
 *
 * So a registration is dropped when the same horse already holds a live seat
 * at THAT tournament. This mirrors, deliberately line for line, the NOT EXISTS
 * clause in `fn_concurrent_game_load` — the database is the enforcement and
 * this is the picker's copy of the same rule. If one changes, change both.
 */
export function buildHorseLoadMap(
  seatedRefs: LoadRef[],
  pendingRegistrationRefs: LoadRef[]
): Map<string, number> {
  const load = new Map<string, number>();
  const bump = (id: string | null) => {
    if (!id) return;
    load.set(id, (load.get(id) ?? 0) + 1);
  };

  // `user_id|tournament_id` for every seat we can attribute to a tournament.
  const seatedInTournament = new Set<string>();
  for (const ref of seatedRefs) {
    const id = refUser(ref);
    if (!id) continue;
    bump(id);
    const tid = refTournament(ref);
    if (tid) seatedInTournament.add(`${id}|${tid}`);
  }

  for (const ref of pendingRegistrationRefs) {
    const id = refUser(ref);
    if (!id) continue;
    const tid = refTournament(ref);
    // Only a KNOWN pairing can be deduped. An unattributed registration is
    // counted, because under-counting hands out a horse that is already full
    // and the database then refuses the claim — the expensive direction.
    if (tid && seatedInTournament.has(`${id}|${tid}`)) continue;
    bump(id);
  }
  return load;
}

export function startsOnBoughtSeats(variant: string, maxPlayers: number): boolean {
  const v = String(variant ?? '').toLowerCase();
  return v === 'sng' || v === 'spin' || (Number(maxPlayers) || 0) <= 2;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ROSTER-FULL DEADLOCK — fill a seat-first game FROM ITS OWN ROSTER FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A seat-first game holds TWO counts that are allowed to disagree, and exactly
 * one pair of values wedges it shut forever:
 *
 *     tournament_players rows  =  max_players   (the roster is FULL)
 *     live table_seats rows    <  max_players   (the game is NOT)
 *
 * In that state the start gate is waiting on SEATS, and every attempt to add
 * a seat goes through fn_seat_horse_in_seat_first_game -> (new entrant) ->
 * fn_register_horse_for_tournament -> INSERT tournament_players, where the
 * trigger fn_enforce_tournament_capacity RAISES:
 *
 *     23514: tournament_full: 10 Chip Spin PLO4 already has 3 of 3 entrants
 *
 * Neither side can move. Measured on production 2026-08-25 08:0xZ:
 *
 *     33 open seat-first games
 *      7 with a full roster and short seats  <- permanently deadlocked
 *      7 of those 7 past their start time
 *     16 unseated registrants sitting inside those 7 games
 *   1995 minutes stuck, worst case (33 hours)
 *
 * The 16 are the way out. A horse ALREADY on the roster takes the
 * `v_already` branch of fn_seat_horse_in_seat_first_game: it skips
 * registration entirely, so it never touches the trigger that is refusing
 * everybody else. It is also the horse that already PAID for that seat.
 *
 * So a seat-first fill draws from home before it draws from the fleet. The
 * free pool is still used for the remainder — a game whose roster is genuinely
 * short needs new entrants and there the registration path works fine. Order,
 * not exclusion.
 *
 * Pure so the ordering is pinned without a database, which is the half that
 * regressed: the old code called pickFreeHorses and nothing else, so a game's
 * own paid-up registrants were the one group of horses it could never seat.
 */
export function seatFirstFillOrder(
  shortfall: number,
  ownUnseatedRegistrants: Array<string | null | undefined>,
  freePoolCandidates: Array<string | null | undefined>
): string[] {
  const want = Math.max(0, Math.floor(Number(shortfall) || 0));
  if (want === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [ownUnseatedRegistrants, freePoolCandidates]) {
    for (const raw of list ?? []) {
      if (out.length >= want) return out;
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * How long a seat-first game may sit REGISTERING with every seat SOLD before
 * that counts as a stall rather than as the normal gap between the last buy-in
 * and the start.
 *
 * The discovery loop runs every 5s and a healthy game flips within one or two
 * passes, so three minutes is ~36 chances to start normally. It is short
 * enough that a player notices a stuck game roughly when the watchdog does,
 * and long enough that a slow start is never treated as a failure.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE CANDIDATE PER SEAT IS A BET THAT NOBODY ELSE IS PICKING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * seatFirstFillOrder takes `want` candidates for `want` seats, so the seat-first
 * fill used to ask pickFreeHorses for EXACTLY the shortfall. That only works if
 * every candidate can be seated, and one of them routinely cannot: the busy set
 * is read before the claim and never atomically with it (pickFreeHorses says so
 * itself), while topUpPartialSeatFirst, the recurring pass and the scheduler all
 * run the same five-second tick. Two callers pick the same horse; the first claim
 * takes it to four games and fn_enforce_booking_game_cap refuses the second with
 * 23514. With one candidate for one seat, that lost race IS an empty seat.
 *
 * Measured on production 2026-09-03, one hour of engine log:
 *
 *     1,000 horses      413 already at four games   (unpickable)
 *                       247 at three                (one claim from refused)
 *       247 boards logged "seat-first fill added nobody"
 *        89 of 98 refusals were FOUR TABLE LIMIT
 *
 * and every one of those lines read `0 own registrant(s) + 1 free horse(s) -
 * shortfall 1`. One candidate, refused, seat left empty - on a board Dan opened
 * to get horses PLAYING. Two thirds of the fleet is at or near the cap, so the
 * race is not rare; it is the normal case.
 *
 * So ask for more than the seats need and let the refusals be absorbed.
 * registerHorses in this same file already sizes its fetch as `count +
 * busy.size` and calls that the convention this file settled on - the seat-first
 * path had drifted from it. Slack costs nothing: an unused candidate is an
 * unclaimed id, pickFreeHorses still applies the club scope and the cash-room
 * reserve before it slices, and the fill loop stops the moment the seats are
 * full (a spin must never seat a fourth).
 */
export const SEAT_FIRST_CANDIDATES_PER_SEAT = 3;
export const SEAT_FIRST_CANDIDATE_FLOOR = 3;

export function seatFirstCandidateCount(shortfall: number): number {
  const seats = Math.max(0, Math.floor(Number(shortfall) || 0));
  if (seats === 0) return 0;
  return Math.max(SEAT_FIRST_CANDIDATE_FLOOR, seats * SEAT_FIRST_CANDIDATES_PER_SEAT);
}

/**
 * A four-table refusal is an ANSWER, not a fault.
 *
 * HorseFleetManager.seatHorse learned this on 2026-08-31 after 57 error reports
 * in a ten-minute window; the seat-first fill never did, and reported 89 of them
 * in an hour - which is how the three genuine refusals sitting beside them
 * (opening_seat_rpc_failed, seat_first_repair_failed) go unread. The cap is a
 * rule working exactly as written: this horse is busy, take the next one.
 */
export function isExpectedSeatRefusal(message: string | null | undefined): boolean {
  const msg = String(message ?? '');
  return (
    msg.includes('FOUR TABLE LIMIT') ||
    msg.includes('TABLE_CAP_REACHED') ||
    msg.includes('Player already seated') ||
    msg.includes('duplicate key')
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT THE HORSE ALREADY HOLDS IS NOT A CALL WORTH QUEUEING FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_seat_horse_in_seat_first_game begins, before it reads a single row of the
 * game, with fn_ca_lock_tournament_seat_acquisition: an EXCLUSIVE advisory lock
 * on one platform-wide key ('ca:tournament-terminal-settlement:v1') that every
 * hand settlement holds SHARED for the whole of its commit. Heavyweight-lock
 * queueing is FIFO, so each call waits for every in-flight hand commit and
 * every hand commit arriving after it queues behind the call. Measured
 * 2026-09-10 03:05-03:40 UTC on the 2XL box (pg_stat_statements): 1,533 calls,
 * mean 590 ms against a 2.4 ms minimum, max 5,889 ms - the same figure as the
 * hand-commit max, because it is the same convoy - and 572 shared blocks per
 * call, which is under 5 ms of real work. pg_stat_activity sampled at 100 ms
 * during a seeding burst showed the RPC in a Lock wait 100 samples out of 110.
 *
 * And most of those calls seat nobody. The same window produced at most 579
 * seats for 1,533 calls; 02:34-04:04 produced 266 live horse seats at
 * seat-first tables for 4,025 calls. The RPC answers `{ok:true,
 * already_seated:true}` when the horse already holds a live seat at the game's
 * primary table, and `{ok:false, reason:'table_full'}` when no seat number in
 * 1..capacity is free - after it has taken the lock and stalled the hand path.
 *
 * The lock cannot be narrowed on the database side without changing what a
 * concurrent settlement can observe, so the fix is on this side of the wire.
 * topUpWithHorses already reads the game's live seats before it fills, so it
 * now keeps what it read - who is seated, which seat numbers are taken, and
 * the table's capacity - and asks these two functions before each call. A
 * horse the ledger shows seated is skipped; a table the ledger shows full is
 * skipped. Every other horse goes through the SAME RPC with the SAME
 * arguments, and the RPC remains the authority: it re-checks both conditions
 * under its lock, so a stale ledger costs at most one wasted call, never a
 * wrong seat. The one difference a horse can observe is that a seat it
 * vacated between the read and the (now skipped) call is offered again on the
 * next five-second pass instead of this one.
 *
 * The race the read cannot see is the other one: on 2026-09-10 every one of
 * the 199 open seat-first games had a table capacity equal to its tournament
 * capacity, so a `table_full` answer today is always another service filling
 * the last seat on the same five-second tick (GameServer discovery, the
 * scheduler and the overlay guard each own a seeder). The loop carries three
 * candidates per seat to absorb refusals, so one such answer used to be
 * followed by two more calls for the same answer. Once the RPC has said
 * `table_full` under its lock, the ledger believes it for the rest of the pass.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). Nothing here filters on is_horse and
 * nothing here denies a horse a seat it would have received: the only calls
 * removed are the ones whose answer was already `already_seated` or
 * `table_full`. A horse that needs a seat still gets it through the same door.
 *
 * The capacity expression is the RPC's own, copied rather than approximated:
 * COALESCE(NULLIF(tables.max_players, 0), tournaments.max_players, 3). When
 * the table row cannot be read the capacity is UNKNOWN and the table-full skip
 * is disabled - an unknown never skips a call. Pure, so the decision is pinned
 * without a database.
 */
export interface SeatFirstSeatLedger {
  /** Holders of live seats at the game's primary table, as read before the fill. */
  seatedUsers: Set<string>;
  /** Seat numbers with a live occupant at that table. */
  occupiedSeats: Set<number>;
  /** The RPC's capacity expression, or null when the table row was unreadable. */
  capacity: number | null;
  /**
   * Set once the RPC itself has answered `table_full` this pass. The authority
   * has spoken: the spare candidates behind that answer (three per seat, see
   * seatFirstCandidateCount) would each queue for the lock to hear it again.
   * A seat freed in the same five seconds is offered on the next pass.
   */
  rpcSaidFull: boolean;
}

export type SeatFirstPrecheck = 'call' | 'already_seated' | 'table_full';

export function seatFirstSeatLedger(
  seatRows: Array<{ user_id?: string | null; seat_number?: number | null }> | null | undefined,
  /** tables.max_players; null for a NULL column, undefined when the row could not be read. */
  tableMaxPlayers: number | null | undefined,
  tournamentMaxPlayers: number | null | undefined
): SeatFirstSeatLedger {
  const seatedUsers = new Set<string>();
  const occupiedSeats = new Set<number>();
  for (const row of seatRows ?? []) {
    const id = String(row?.user_id ?? '');
    if (id.length > 0) seatedUsers.add(id);
    const n = Number(row?.seat_number);
    if (Number.isInteger(n) && n > 0) occupiedSeats.add(n);
  }
  let capacity: number | null;
  if (tableMaxPlayers === undefined) {
    capacity = null;
  } else if (tableMaxPlayers !== null && Number(tableMaxPlayers) !== 0) {
    capacity = Math.floor(Number(tableMaxPlayers));
  } else if (tournamentMaxPlayers !== null && tournamentMaxPlayers !== undefined) {
    capacity = Math.floor(Number(tournamentMaxPlayers));
  } else {
    capacity = 3;
  }
  if (capacity !== null && !Number.isFinite(capacity)) capacity = null;
  return { seatedUsers, occupiedSeats, capacity, rpcSaidFull: false };
}

export function seatFirstSeatPrecheck(
  ledger: SeatFirstSeatLedger,
  horse: string
): SeatFirstPrecheck {
  // The RPC's order: the seat the horse already holds is checked before the
  // free-seat search, so a seated horse at a full table reads already_seated.
  if (ledger.seatedUsers.has(horse)) return 'already_seated';
  if (ledger.rpcSaidFull) return 'table_full';
  if (ledger.capacity !== null) {
    let free = false;
    for (let s = 1; s <= ledger.capacity; s++) {
      if (!ledger.occupiedSeats.has(s)) {
        free = true;
        break;
      }
    }
    if (!free) return 'table_full';
  }
  return 'call';
}

/** Record a seat the RPC just granted, so the rest of this pass sees it. */
export function seatFirstNoteSeated(
  ledger: SeatFirstSeatLedger,
  horse: string,
  seatNumber: unknown
): void {
  ledger.seatedUsers.add(horse);
  const n = Number(seatNumber);
  if (Number.isInteger(n) && n > 0) ledger.occupiedSeats.add(n);
}

/** Record that the RPC answered `table_full`, so the rest of this pass believes it. */
export function seatFirstNoteTableFull(ledger: SeatFirstSeatLedger): void {
  ledger.rpcSaidFull = true;
}

/**
 * A SKIP IS VERIFIED BEFORE IT IS TAKEN.
 *
 * The rows behind the ledger were read before the candidate pickers ran and
 * before every RPC call ahead of this one in the loop, and each of those calls
 * spends a mean 590 ms in the lock queue. By the third candidate the ledger is
 * a second old. A horse that left its seat in that second, or a seat that
 * opened after the RPC said `table_full`, would read as a skip and stay empty
 * until the next five-second pass - where the RPC would have seated it.
 *
 * So the ledger never skips on the rows it was built from. When the pre-check
 * says skip, the caller re-reads the same rows (a primary-key-indexed read of
 * at most a handful of rows, no advisory lock) and folds them in here; the
 * pre-check is then asked again against rows that are milliseconds old, and
 * only that second answer can skip. A stale row therefore falls through to
 * the RPC. This costs one cheap read per skip in place of one locked call.
 *
 * The RPC's own `table_full` yields to a fresh read that shows a free seat in
 * 1..capacity: the read is newer than the answer. It stands when the capacity
 * is unknown, because then the rows cannot say whether the table is full and
 * the RPC's word under its lock is the better evidence.
 */
export function seatFirstLedgerRefresh(
  ledger: SeatFirstSeatLedger,
  freshRows: Array<{ user_id?: string | null; seat_number?: number | null }> | null | undefined
): void {
  const fresh = seatFirstSeatLedger(freshRows, undefined, undefined);
  ledger.seatedUsers = fresh.seatedUsers;
  ledger.occupiedSeats = fresh.occupiedSeats;
  if (ledger.capacity !== null) ledger.rpcSaidFull = false;
}

/** The grep-able production evidence for the skip. One line per fill pass that had candidates. */
export function seatFirstPrecheckLogLine(
  tournamentId: string,
  tally: SeatFirstPrecheckTally
): string {
  return (
    `[TournamentRecurring] seat-first-precheck ${tournamentId.slice(0, 8)}: ` +
    `rpc_called=${tally.rpcCalled} skipped_already_seated=${tally.skippedAlreadySeated} ` +
    `skipped_table_full=${tally.skippedTableFull} verify_reads=${tally.verifyReads} ` +
    `seated=${tally.seated} ` +
    `rpc_already_seated=${tally.rpcAlreadySeated} rpc_table_full=${tally.rpcTableFull} ` +
    `rpc_refused=${tally.rpcRefused} rpc_other_noop=${tally.rpcOtherNoop}`
  );
}

export const SEAT_FIRST_START_STALL_MS = 3 * 60 * 1000;

/**
 * "Every seat is bought and the game still has not started."
 *
 * The gap the 2026-08-24 audit recorded as P2-7: the played-but-REGISTERING
 * sweep proves a game dealt by finding an eliminated/winner/finished row, and
 * a game that NEVER DEALT cannot produce one. An 85-minute fully-paid heads-up
 * sat invisible to every watchdog on the platform for exactly that reason.
 *
 * Pure, and deliberately conservative:
 *  - short of a full house it is never a stall (that is a game still filling);
 *  - a game we have not seen full yet (fullSinceMs null) is never a stall, so
 *    an engine restart re-arms the clock instead of force-starting a board.
 */
export function seatFirstStartStalled(opts: {
  paidSeats: number;
  maxPlayers: number;
  /** When this game was FIRST observed with every seat sold, or null. */
  fullSinceMs: number | null | undefined;
  now: number;
  stallMs?: number;
}): boolean {
  const seats = Number(opts.maxPlayers) || 0;
  const paid = Number(opts.paidSeats) || 0;
  if (seats <= 0 || paid < seats) return false;

  // Number(null) is 0, which is a finite instant in 1970 and would read as
  // "stalled since forever" on the very first pass. Reject the absent clock
  // before it is ever coerced.
  if (opts.fullSinceMs === null || opts.fullSinceMs === undefined) return false;
  const since = Number(opts.fullSinceMs);
  if (!Number.isFinite(since)) return false;

  const now = Number(opts.now);
  if (!Number.isFinite(now)) return false;

  const raw = Number(opts.stallMs);
  const stallMs = Number.isFinite(raw) && raw >= 0 ? raw : SEAT_FIRST_START_STALL_MS;
  return now - since >= stallMs;
}

/**
 * How many entrants to ask topUpWithHorses for RIGHT NOW, or 0 for nothing to
 * do. The whole decision lives here so it is testable without a database.
 */
export function mttPrestartHorseTarget(opts: {
  /** Milliseconds until the scheduled start. Negative means already past. */
  msUntilStart: number;
  maxPlayers: number;
  variant: string;
  /** Entrants already registered. Bounds how far one tick may jump. */
  currentPlayers?: number;
  /**
   * `tournaments.guaranteed_prize`. When set, the field goal is whatever it
   * takes to COVER it - see the note below.
   */
  guaranteedPrize?: number;
  /** `tournaments.prize_pool` - what the field has actually paid in so far. */
  prizePool?: number;
  /**
   * `tournaments.buy_in_amount` - the PRIZE side of the entry. The fee is rake
   * and never reaches the pool, so using the total here would under-count the
   * entries needed and leave the guarantee short.
   */
  buyInPrizeShare?: number;
}): number {
  const { msUntilStart, maxPlayers, variant } = opts;
  const current = Math.max(0, Number(opts.currentPlayers) || 0);

  // Past start, or not started ramping yet. Past start belongs to the existing
  // top-up, which aims at a full field; this function must not fight it.
  if (!Number.isFinite(msUntilStart)) return 0;
  if (msUntilStart <= 0 || msUntilStart > MTT_PRESTART_RAMP_MS) return 0;

  // Spins, heads-up and any-size SNGs start on bought seats. Not our business.
  if (startsOnBoughtSeats(variant, maxPlayers)) return 0;

  const seats = Number(maxPlayers) || 0;

  /* ── THE GUARANTEE DECIDES THE FIELD (Dan 2026-08-26) ──────────────────────
     "the horses should fill any and all seats to insure that the guarantee is
     always met."

     MTT_PRESTART_MAX_HORSES is 24. That is the right default for an ordinary
     event - enough to make a lobby row look like a game without spending the
     club's chips on a field nobody asked for. It is nowhere near enough for a
     GUARANTEED one: the Sunday $200 Deep Stack promises 20,000 and pays 180 of
     every 200 entry into the pool, so covering it takes 112 entries. Ramping
     to 24 would have left roughly 15,000 of overlay on an event the club had
     already promised to cover.

     A horse entry is a REAL entry. fn_register_horse_for_tournament first
     commits an exact returned tournament ticket directly into escrow; only
     when no ticket exists may it debit the horse's wallet through
     atomic_deduct_wallet_and_log. Both paths write the rake evidence and add
     `v_split.prize` to prize_pool - the same funded split a human makes. So
     horses filling seats does not paper over the shortfall, it genuinely funds
     it, and the guarantee stops being an overlay at all.

     THE CAP IS STILL A CAP. `seats - 1` is untouched (safety property 1: the
     table always leaves a chair for a human), and a guarantee can never ask
     for more than the event's own field. What changes is only the FLOOR: an
     event carrying a guarantee ramps to whatever covers it, an event without
     one keeps the 24 it always had. */
  const guarantee = Math.max(0, Number(opts.guaranteedPrize) || 0);
  const pool = Math.max(0, Number(opts.prizePool) || 0);
  const prizeShare = Math.max(0, Number(opts.buyInPrizeShare) || 0);
  const shortfall = guarantee - pool;
  const entriesToCover =
    guarantee > 0 && shortfall > 0 && prizeShare > 0 ? Math.ceil(shortfall / prizeShare) : 0;

  /* Entries needed ON TOP of the field that is already there. `current`
     already paid into `pool`, so adding it back would double count them and
     over-fill the event. */
  const guaranteeGoal = entriesToCover > 0 ? current + entriesToCover : 0;

  // Always leave a seat: see safety property 1.
  const fieldGoal = Math.min(seats - 1, Math.max(MTT_PRESTART_MAX_HORSES, guaranteeGoal));
  if (fieldGoal < 1) return 0;

  const elapsed = 1 - msUntilStart / MTT_PRESTART_RAMP_MS; // 0 at T-60, 1 at T-0
  const curve = elapsed * elapsed; // slow early, steep near the close

  // At least one entrant the moment the window opens: a lobby row reading 1
  // is a game somebody is in, and 0 is a game nobody will join.
  const onCurve = Math.max(1, Math.min(fieldGoal, Math.ceil(fieldGoal * curve)));

  // Already there (or ahead, if humans turned up). Nothing to do.
  if (onCurve <= current) return 0;

  /* Walk toward the curve rather than jumping to it. Still never past the
     curve, so the leave-a-seat and pool-cap guarantees above still hold.

     THE STEP IS NOT WHERE A GUARANTEE GETS COVERED (2026-09-02). An earlier
     draft of the overlay fix let a guaranteed event step past
     MTT_PRESTART_MAX_STEP once the clock ran short - "cover the promise, the
     pacing matters less". The pinned test one screen up refused it, correctly:
     at T-1s a 20,000 guarantee wants 107 entrants, and registerHorses buys in
     ONE HORSE PER SEQUENTIAL RPC inside the same 5-second loop that decides
     when every other tournament starts. That is the stall the cap was added to
     prevent, and a guarantee is not worth re-introducing it.

     A short clock is not something to out-run here. It is something not to
     create: see MTT_PUBLISH_LEAD_MS. */
  return Math.min(onCurve, current + MTT_PRESTART_MAX_STEP);
}

function horsesForSeatHeldGame(maxPlayers: number): { horses: number; isSim: boolean } {
  if (!HOLD_SEAT_FOR_HUMAN) return { horses: maxPlayers, isSim: true };
  return { horses: Math.max(1, maxPlayers - 1), isSim: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SNG BOARD — Dan 2026-08-21
 * ───────────────────────────────────────────────────────────────────────────
 * Same rule as the spin board above: every price point permanently open,
 * generated rather than hand-written, and one seat left free so the table
 * WAITS rather than starting the moment it is created.
 *
 * Heads-up and 6-max are the two shapes the reference lobby shows, across the
 * whole buy-in ladder. horsesToRegister is seats-1 for the same reason it is
 * on spins - a full fill means the game is never joinable.
 */
/**
 * Dan, 2026-08-21: "WE AREN'T DOING ANY OTHER SIT N GO'S."
 *
 * Heads-Up is the only sit-n-go shape the platform runs. 6-Max and 9-Max are
 * removed — they were the MTT-shaped middle ground nobody asked for: too slow
 * to fill as a walk-up table, too small to be an event. Spins cover the
 * three-handed fast game, Heads-Up covers the duel, MTTs cover the field.
 *
 * Heads-Up is seat-first (isSeatFirstFormat): two seats, first come first
 * served, and the game begins the moment both are bought.
 */
/**
 * Dan 2026-08-25: "THE STARTING STACK 300 FOR TURBO AND 1000 FOR DEEP STACK."
 * The stack is a property of the SHAPE now rather than a ternary on seat count
 * that could only ever say 1500 — the board has one shape today, and the rule
 * has to be written where a second one would read it.
 *
 * ─── THE TURBO SHAPE, 2026-08-27 ────────────────────────────────────────────
 *
 * The comment above described both bands and the array declared ONE. `turbo`
 * was a compile-time `false`, so the ` Turbo` suffix in the name template below
 * was unreachable dead code and the 300-chip half of Dan's sentence had never
 * existed on the platform: 5,283 legacy heads-ups at 1,500 chips, 5,032 at
 * 1,000, and ZERO at 300.
 *
 * Both bands run the SAME blind ladder (HEADS_UP_3MIN) on purpose — Dan
 * 2026-08-23, on Spins and repeated here: "SPEED SHOULDN'T CHANGE, ONLY THE
 * STARTING STACK." At 10/20 the turbo starts at 15bb and the deep stack at
 * 50bb, so the two feel completely different without a second clock to reason
 * about. The turbo is therefore NOT a faster structure, it is a shallower one,
 * and that is the whole difference.
 *
 * The two shapes produce distinct config NAMES ("NLH Heads-Up 10" and "NLH
 * Heads-Up 10 Turbo"), which is what ensureBoardOpen keys the board on, so each
 * band is opened and refilled independently. No uniqueness rule is disturbed:
 * uq_scheduled_tournament_one_live_per_name covers MTT/XMTT only — SNG and SPIN
 * are deliberately outside it because they run many same-named instances at
 * once.
 */
/* Every number below now comes from headsUpSpec -- the seats, both stacks, the
   rungs and the variants. The shapes array is what turns two stacks into two
   independently-refilled boards; the STACKS themselves are the spec's. */
const SNG_BOARD_SHAPES: { seats: number; label: string; turbo: boolean; startingStack: number }[] =
  [
    { seats: HEADS_UP_SEATS, label: 'Heads-Up', turbo: false, startingStack: HEADS_UP_STACKS.deep },
    { seats: HEADS_UP_SEATS, label: 'Heads-Up', turbo: true, startingStack: HEADS_UP_STACKS.turbo },
  ];

const SNG_BOARD_VARIANTS: { key: string; label: string }[] = HEADS_UP_GAME_TYPES.map((key) => ({
  key,
  label: key.toUpperCase(),
}));

const SNG_BOARD_BUYINS = [...HEADS_UP_BUYINS];

const SNG_CONFIGS: SNGConfig[] = SNG_BOARD_SHAPES.flatMap((shape) =>
  SNG_BOARD_VARIANTS.flatMap((v) =>
    SNG_BOARD_BUYINS.map((buyIn) => ({
      name: `${v.label} ${shape.label} ${buyIn}${shape.turbo ? ' Turbo' : ''}`,
      type: 'sng' as const,
      gameVariant: v.key,
      buyIn,
      // Derived, never authored - see src/utils/buyIn.ts. The value is unused
      // by createSNG (which calls buyInColumns) but kept for config parity.
      rake: 0,
      startingStack: shape.startingStack,
      maxPlayers: shape.seats,
      minPlayers: shape.seats,
      horsesToRegister: shape.seats - 1,
      /* Both bands run the same three-minute clock — see HEADS_UP_3MIN. The
         turbo flag now chooses the STACK, not the level length. */
      blindStructure: BLIND_STRUCTURES.HEADS_UP_3MIN,
      payoutStructure:
        shape.seats <= HEADS_UP_SEATS
          ? HEADS_UP_PAYOUTS
          : shape.seats <= 6
            ? [
                { place: 1, percentage: 65 },
                { place: 2, percentage: 35 },
              ]
            : [
                { place: 1, percentage: 50 },
                { place: 2, percentage: 30 },
                { place: 3, percentage: 20 },
              ],
    }))
  )
);

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
/* RE-EXPORTED, NOT REDECLARED (2026-09-02).
   This was `= 3` written out a second time, in a file that already imports
   SPIN_TIERS / SPIN_STACKS / spinBlindsForLevel from the same spec. Two
   sources of truth for the seat count is worse here than almost anywhere
   else: the whole multiplier distribution is built on
   E[multiplier] = seats x (1 - rake_rate), so a divergence would not look
   like a bug, it would look like a slightly wrong house edge. Importers of
   this name keep working. */
export { SPIN_SEATS };

/**
 * Seats the cash room keeps, per live cash table, before the Spin and
 * Heads-Up boards may claim another idle horse. See cashRoomReserve.
 *
 * Two, not more: the point is that a cash table is never a ghost, not that it
 * is full. A table showing 2 players is one a human can sit down at; a table
 * showing 0 is one they scroll past.
 */
export const CASH_FLOOR_PER_TABLE = 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SPIN BOARD — Dan 2026-08-21
 * ───────────────────────────────────────────────────────────────────────────
 * "create and open lots of spins, at once, and the tables just stay open until
 *  players sit down, they don't need to be scheduled just always running."
 *
 * This was FIVE hand-written configs and a global cap of 5 live spins, so the
 * lobby showed whichever five the rotation happened to reach - and, measured
 * just now, exactly ONE spin existed platform-wide and it was already RUNNING,
 * meaning a player arriving at the Spin-It tab had nothing to sit down at.
 *
 * The board is now the cross product of the buy-in ladder and the variants, so
 * every price point is permanently on the board at every variant it is offered
 * at. Generated rather than hand-written for the same reason buy-ins are
 * derived rather than authored: 20 hand-maintained literals drift.
 *
 * Buy-ins come off BUY_IN_LADDER via buyInFor(), so a spin's advertised price
 * is a whole number like everything else. Spins carry NO separate rake - the
 * house edge is engineered into the multiplier distribution (spinSpec.ts) -
 * so `rake` stays 0 here and createSpin writes buy_in_fee: 0.
 */
const SPIN_BOARD_VARIANTS: { key: string; label: string }[] = [
  { key: 'nlh', label: 'NLH' },
  { key: 'plo4', label: 'PLO4' },
  { key: 'plo5', label: 'PLO5' },
  { key: 'plo6', label: 'PLO6' },
];

/** Every price point the spin board is open at. Whole chips, from the ladder. */
const SPIN_BOARD_BUYINS = [1, 2, 3, 5, 10, 20, 50, 100];

/**
 * TWO SPEEDS, ONE LADDER (Dan, 2026-09-01).
 *
 * "once a player sits down and 'buys in' they either get 300 chips for a
 * turbo, or 1000 chips for a deep stack."
 *
 * The depth is a board the player chooses, not a consequence of what the wheel
 * lands on. Blinds and level length are identical on both -- Dan, 2026-08-23:
 * "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK" -- so the only difference
 * between a Turbo and a Deep Stack at the same stake is how many chips are in
 * front of you.
 *
 * The Turbo boards keep the plain name every existing board already has.
 * Renaming those would not rename anything: ensureBoardOpen identifies a board
 * by its config NAME, so a rename opens 32 new boards and leaves 32 orphans
 * sitting in REGISTERING forever.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SATELLITE HEADS-UP (Dan 2026-09-03): "ADD 'SATELLITE SIT N GO'S' TO THE
 *  HEADS UP AREA, WHERE PLAYERS CAN WIN A TICKET INTO BIGGER BUY IN MTT'S."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A satellite heads-up is a two-seat game on the ordinary heads-up board whose
 * winner does not take chips: they take a SEAT in a bigger scheduled event.
 * Everything below it is machinery that already exists and is reused, not
 * copied:
 *
 *   - it is SEAT-FIRST like every heads-up (isSeatFirstFormat: two seats), so
 *     it opens with one horse, holds the second seat for a human for the
 *     60-150 second window, and the past-start top-up seats the second horse
 *     if nobody comes;
 *   - it carries tournament_type 'SATELLITE' (variant stays 'sng' so every
 *     seat-first reader still recognises a two-seat SNG) with
 *     satellite_target_id and satellite_seats = 1, so TournamentManager's
 *     finish path (isSatelliteFinish -> processSatelliteAwards) registers the winner into
 *     the target through the same money-correct path the scheduled satellite
 *     MTTs use, and pays whatever the pool holds beyond the seat to the
 *     single next finisher as the atomic settlement remainder;
 *   - the lobby classifies a two-seat game as heads-up whatever its variant
 *     (classifyTournament: a cap of 2 is an 'sng'), and lobbyEntries puts the
 *     SATELLITE badge on anything whose name says so. So it appears in the
 *     Heads Up tab with no client change.
 *
 * WHAT IS A TARGET. Any scheduled MTT in the owner's own scope (the union for
 * the house board, the club for a standalone club) that is open for
 * registration, starts at least SATELLITE_HU_TARGET_LEAD_MS from now and no
 * more than SATELLITE_HU_TARGET_HORIZON_MS away, costs at least
 * SATELLITE_HU_MIN_TICKET to enter, and whose entry the satellite finish can
 * deliver (satelliteTargetIsDeliverable: never a bounty, PKO, mystery-bounty
 * or Spin event, whose seat the settlement authority refuses). "Bigger buy-in" is that floor: nobody
 * needs a satellite into a 5-chip turbo. The board keeps one satellite per
 * target for the SATELLITE_HU_TARGETS_PER_OWNER dearest targets, so the
 * biggest events of the week always have a feeder running.
 *
 * WHAT IT COSTS. Two entries must fund one seat with no overlay, and buy-ins
 * snap to BUY_IN_LADDER, so the price is the smallest ladder step whose two
 * prize shares (after the heads-up rake) cover the ticket. The remainder is
 * real money the runner-up gets back, which is the honest shape of a two-man
 * satellite on a ladder that has no exact halves.
 */
export const SATELLITE_HU_MIN_TICKET = 20;
export const SATELLITE_HU_TARGETS_PER_OWNER = 3;
export const SATELLITE_HU_TARGET_LEAD_MS = 30 * 60 * 1000;
export const SATELLITE_HU_TARGET_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
export const SATELLITE_HU_NAME_SUFFIX = 'Satellite Heads-Up';

export function satelliteHeadsUpName(targetName: string): string {
  return `${String(targetName).trim()} ${SATELLITE_HU_NAME_SUFFIX}`;
}

/**
 * The smallest BUY_IN_LADDER step whose two prize shares, after the heads-up
 * rake, cover one ticket into the target. 0 when no step on the ladder can
 * (a ticket dearer than twice the top rung), which means "no satellite".
 */
export function satelliteHeadsUpBuyIn(ticketCost: number): number {
  const ticket = Number(ticketCost);
  if (!Number.isFinite(ticket) || ticket <= 0) return 0;
  const rate = rakeRateFor({ tournamentType: 'SNG', maxPlayers: HEADS_UP_SEATS });
  for (const step of BUY_IN_LADDER) {
    const { prize } = buyInFor(step, rate);
    if (prize * HEADS_UP_SEATS >= ticket) return step;
  }
  return 0;
}

export interface SatelliteTargetRow {
  id: string;
  name: string;
  start_time: string | null;
  buy_in_amount: number | null;
  buy_in_fee: number | null;
  variant: string | null;
  max_players: number | null;
  game_type?: string | null;
  tournament_type?: string | null;
  is_bounty?: boolean | null;
  is_pko?: boolean | null;
  is_mystery_bounty?: boolean | null;
  is_premium_spin?: boolean | null;
}

/**
 * A FEEDER ONLY FEEDS AN EVENT ITS FINISH CAN SEAT (2026-09-11).
 *
 * The one satellite settlement authority (fn_settle_satellite_tournament)
 * refuses every target whose entry is not a plain prize + fee split: bounty,
 * PKO, mystery bounty and Spin, and any row whose flags are unknown (NULL is
 * refused there, because the bounty slice of a seat must never be booked as
 * prize). The feeder read none of those columns, so the dearest weekly event
 * - Sunday Funday High Roller PKO, 67.50 + 7.50 with a 35.00 bounty - got a
 * heads-up satellite every half hour from 03:01 UTC on 2026-09-11, and every
 * one of them was played to a winner and then refused at the finish.
 *
 * This is the same predicate, so the feeder and the finish agree. The
 * database refuses the insert as well (the migration that ships with this),
 * so no other creation path can open a satellite the finish will refuse.
 * Unknown is not supported: a row without the flags is not a target.
 */
export function satelliteTargetIsDeliverable(row: SatelliteTargetRow): boolean {
  const flags = [row.is_bounty, row.is_pko, row.is_mystery_bounty, row.is_premium_spin];
  if (flags.some((flag) => flag !== false)) return false;
  const variant = String(row.variant ?? '').toLowerCase();
  if (
    variant === 'spin' ||
    variant === 'bounty' ||
    variant === 'progressive_bounty' ||
    variant === 'mystery_bounty' ||
    variant === 'pko'
  )
    return false;
  if (String(row.tournament_type ?? '').toUpperCase() === 'SPIN') return false;
  return true;
}

/**
 * Which open events deserve a feeder right now. Pure, so the choice is pinned
 * by a test rather than by a database: dearest first, one per name (a weekly
 * event and next week's copy are one target), inside the lead/horizon window,
 * at or above the ticket floor, never a seat-first game and never a satellite
 * feeding a satellite.
 */
export function pickSatelliteTargets(
  rows: SatelliteTargetRow[],
  nowMs: number,
  limit: number = SATELLITE_HU_TARGETS_PER_OWNER
): SatelliteTargetRow[] {
  const seen = new Set<string>();
  const out: SatelliteTargetRow[] = [];
  const eligible = rows
    .filter((r) => {
      const v = String(r.variant ?? '').toLowerCase();
      if (v === 'spin' || v === 'sng' || v === 'satellite') return false;
      if (!satelliteTargetIsDeliverable(r)) return false;
      const seats = Number(r.max_players);
      if (Number.isFinite(seats) && seats > 0 && seats <= 2) return false;
      const start = r.start_time ? Date.parse(r.start_time) : NaN;
      if (!Number.isFinite(start)) return false;
      const until = start - nowMs;
      if (until < SATELLITE_HU_TARGET_LEAD_MS || until > SATELLITE_HU_TARGET_HORIZON_MS)
        return false;
      const ticket = Number(r.buy_in_amount || 0) + Number(r.buy_in_fee || 0);
      return ticket >= SATELLITE_HU_MIN_TICKET && satelliteHeadsUpBuyIn(ticket) > 0;
    })
    .sort((a, b) => {
      const ta = Number(a.buy_in_amount || 0) + Number(a.buy_in_fee || 0);
      const tb = Number(b.buy_in_amount || 0) + Number(b.buy_in_fee || 0);
      if (tb !== ta) return tb - ta;
      return String(a.start_time).localeCompare(String(b.start_time));
    });
  for (const r of eligible) {
    const key = String(r.name).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

interface SatelliteHeadsUpConfig extends Omit<SNGConfig, 'type'> {
  type: 'satellite';
  targetId: string;
  targetName: string;
  ticketCost: number;
}

function satelliteHeadsUpConfigFor(target: SatelliteTargetRow): SatelliteHeadsUpConfig | null {
  const ticket = Number(target.buy_in_amount || 0) + Number(target.buy_in_fee || 0);
  const buyIn = satelliteHeadsUpBuyIn(ticket);
  if (buyIn <= 0) return null;
  const targetVariant = String(target.game_type ?? target.variant ?? '').toLowerCase();
  const gameVariant = (HEADS_UP_GAME_TYPES as readonly string[]).includes(targetVariant)
    ? targetVariant
    : 'nlh';
  return {
    name: satelliteHeadsUpName(target.name),
    type: 'satellite',
    gameVariant,
    buyIn,
    rake: 0,
    startingStack: HEADS_UP_STACKS.turbo,
    maxPlayers: HEADS_UP_SEATS,
    minPlayers: HEADS_UP_SEATS,
    horsesToRegister: HEADS_UP_SEATS - 1,
    blindStructure: BLIND_STRUCTURES.HEADS_UP_3MIN,
    payoutStructure: HEADS_UP_PAYOUTS,
    targetId: target.id,
    targetName: target.name,
    ticketCost: ticket,
  };
}

const SPIN_BOARD_SPEEDS: SpinSpeed[] = ['turbo', 'deep'];

export const SPIN_CONFIGS: SpinConfig[] = SPIN_BOARD_SPEEDS.flatMap((speed) =>
  SPIN_BOARD_VARIANTS.flatMap((v) =>
    SPIN_BOARD_BUYINS.map((buyIn) => ({
      name:
        speed === 'turbo'
          ? `${buyIn} Chip Spin ${v.label}`
          : `${buyIn} Chip ${SPIN_SPEED_LABELS[speed]} Spin ${v.label}`,
      type: 'spin' as const,
      gameVariant: v.key,
      buyIn,
      // Spins are rake-free by product rule; the edge lives in the multipliers.
      rake: 0,
      /* The board's own depth, and the final word on it. This used to be a
       placeholder that start() overwrote from the drawn tier; the stack no
       longer depends on the draw, so what is written here is what the player
       is dealt, and it is known before the wheel turns. */
      startingStack: SPIN_STACKS[speed],
      maxPlayers: SPIN_SEATS,
      minPlayers: SPIN_SEATS,
      /* Seat all but ONE chair with horses.
       Dan: "the tables just stay open until players sit down." A full horse
       fill (the old value was 3 of 3) starts the spin the instant it is
       created, so the table is never actually available - which is why the
       board kept showing RUNNING games and nothing joinable. Leaving the last
       seat empty means the table sits open indefinitely, and the first human
       to take that seat starts the game, which is the whole point of a spin. */
      horsesToRegister: SPIN_SEATS - 1,
      /* Built from the spec, exactly as createSpin does below -- the constant
       this used to name was a five-level ladder that contradicted it. */
      blindStructure: Array.from({ length: 12 }, (_, i) => {
        const b = spinBlindsForLevel(i + 1);
        return {
          level: i + 1,
          smallBlind: b.small,
          bigBlind: b.big,
          ante: 0,
          durationMinutes: SPIN_TIERS[0].levelMinutes,
        };
      }),
      payoutStructure: [{ place: 1, percentage: 100 }],
    }))
  )
);

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

/**
 * How often the seat-first boards (Spin, SNG) are topped back up. See
 * TournamentRecurringService.start for why this is measured in seconds and not
 * minutes: a board must be refilled as fast as it drains, and a Spin now lives
 * about three minutes.
 */
const BOARD_REFILL_INTERVAL_MS = 30 * 1000;

/**
 * How many games one tick may create, ACROSS EVERY BOARD IT TOUCHES.
 *
 * This used to be a per-board cap. Once a tick can service the house board
 * plus every club and union that has activated Spins, a per-board cap is not a
 * cap at all -- twenty activated owners would mean twenty times the work, and
 * the tick that fills a cold board also has to share a connection with live
 * hands being dealt. The budget is threaded through every ensureBoardOpen call
 * in the pass, so the ceiling holds no matter how many owners exist.
 */
const BURST = 12;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BUDGET IS SHARED, SO IT IS SPLIT - NOT SPENT FIRST-COME (2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One BURST for the whole pass was the right ceiling and the wrong queue. The
 * house board went first, and the house board is never full: fifty spin
 * price points that each churn every few minutes, on a tick that runs longer
 * than its own 30-second interval, means the house is thirty to forty games
 * short every time it is asked. It took all twelve, `budget.left` hit zero,
 * and the owner loop `break`-ed before Deep Stack Society was ever offered a
 * game.
 *
 * Measured 2026-09-03 17:02 UTC, straight from the engine log:
 *
 *     Opened 12 spin(s) for house fade0000; 38 still to fill
 *     Opened  3 sng(s)  for club 2a1132b9; 29 still to fill
 *
 * and no "Opened N spin(s) for club 2a1132b9" line anywhere. The club's spin
 * board had been empty since 11:32 - not because anything failed, but because
 * the house always had thirty-eight reasons to spend the budget first. Dan
 * read the symptom as "DSS spins stopped", and that is exactly what it was.
 *
 * So the pass hands each owner a SHARE before anyone spends: BURST divided by
 * the number of boards being served, floored at two so a share is always a
 * game and its overflow. Unspent shares are not redistributed - the tick is
 * already long, and an owner whose board is full leaving its share unspent is
 * the tick finishing sooner. The house is one owner among the others here:
 * with one activated club it opens six games a tick instead of twelve, which
 * is still more than the six a minute its board actually turns over.
 */
export const BOARD_BUDGET_FLOOR = 2;
export function boardBudgetShares(ownerCount: number, burst: number = BURST): number {
  const owners = Math.max(1, Math.floor(Number(ownerCount) || 0));
  return Math.max(BOARD_BUDGET_FLOOR, Math.floor(burst / owners));
}

/**
 * Whose board is being filled. A Spin is visible to players ENTIRELY through
 * the club_id / union_id on its row -- ClubHomePage scopes its lobby query by
 * one or the other and never consults membership -- so these two fields decide
 * who can see the game, and getting them wrong makes a board invisible to the
 * very club that paid for it.
 */
interface BoardOwner {
  /** The tournaments.club_id to stamp. */
  clubId: string;
  /**
   * The tournaments.union_id to stamp, or null.
   *
   * NOT cosmetic. A club inside a union has its lobby scoped by
   * `.eq('club_id', id).eq('is_private', true)`, so a PUBLIC club-owned Spin
   * would be dropped by its own club's page. A standalone club's lobby scopes
   * by club_id alone and shows it. A union's games are found by union_id
   * across every club in that union -- which is exactly how the house board
   * has always reached players.
   */
  unionId: string | null;
  /** The largest buy-in this owner's wallet is seeded to cover. */
  maxStake: number;
  /** For logs only. */
  kind: 'house' | 'club' | 'union';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT RECURRING SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TournamentRecurringService {
  private tournamentInterval: ReturnType<typeof setInterval> | null = null;
  private sngInterval: ReturnType<typeof setInterval> | null = null;
  private spinInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  A BOARD THAT IS NOT FILLING MUST SAY SO (2026-08-27)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The held-empty ratchet ran for twenty hours with 49 dead boards, Spins
   * down from ~300 starts an hour to 1 and Heads-Up to zero, and NOTHING on
   * the platform said a word. Every refusal on the seat-first fill path
   * returns 0: the held-empty gate returned 0 silently, and pickFreeHorses
   * returns [] silently whenever the candidate list is empty. `Filled "..."`
   * only logs when something was actually added, so a board that adds nobody
   * forever is exactly as quiet as a board with nothing to do.
   *
   * A count of distinct boards skipped, reported once a cycle rather than per
   * board per pass, turns that silence into one line. It is deliberately a
   * SET of ids and not a counter: the number that matters is how much of the
   * board is held at once, and the same board skipped 720 times an hour must
   * not read as 720 boards.
   */
  private seatFirstHeldIds = new Set<string>();
  private lastHeldReportAt = 0;
  /**
   * Tournaments whose top-up was refused because their prize pool is already
   * finalized - reported once each, not on every backoff. Bounded by the
   * number of such rows a process ever meets (40 measured, see topUpWithHorses).
   */
  private finalizedPoolTopUpsRefused = new Set<string>();
  private static readonly HELD_REPORT_EVERY_MS = 10 * 60_000;

  private noteSeatFirstHeld(tournamentId: string): void {
    this.seatFirstHeldIds.add(tournamentId);
    const now = Date.now();
    if (now - this.lastHeldReportAt < TournamentRecurringService.HELD_REPORT_EVERY_MS) return;
    this.lastHeldReportAt = now;
    const n = this.seatFirstHeldIds.size;
    this.seatFirstHeldIds.clear();
    console.log(
      `[TournamentRecurring] held-empty: ${n} seat-first board(s) skipped in the last ` +
        `${TournamentRecurringService.HELD_REPORT_EVERY_MS / 60000}m - they open for a human and ` +
        `rotate out on the next ${SEAT_FIRST_EMPTY_BUCKET_MS / 60000}m bucket`
    );
  }
  /**
   * One board tick at a time, per board. setInterval does NOT wait for the
   * previous callback to finish, and a tick that has to fill a drained board
   * makes up to BURST creations one after another -- comfortably longer than
   * the 30-second period. Two overlapping runs then read the SAME "what is
   * missing" snapshot and both create it.
   *
   * That is not theoretical. Within two minutes of the 30-second cadence
   * reaching production the Spin board held 56 open games against a
   * 40-config board: sixteen names with exactly TWO copies each. (Only ever
   * two -- once the duplicate is REGISTERING the name is no longer missing,
   * so the board self-heals as the extra copies play out. It is still wrong.)
   */
  private boardTickInFlight: Record<'spin' | 'sng', boolean> = { spin: false, sng: false };
  private xmttInterval: ReturnType<typeof setInterval> | null = null;
  private freeBuyInterval: ReturnType<typeof setInterval> | null = null;
  /** One Free Buy pass at a time. setInterval does not wait for the previous
   *  callback, and two overlapping passes read the same "which slots exist"
   *  snapshot - the exact shape that put two copies of sixteen Spin names on
   *  the board within two minutes of the 30-second cadence going live. */
  private freeBuyTickInFlight = false;
  /** When the Free Buy board was last audited, and what it last said. */
  private lastFreeBuyAuditAt = 0;
  private lastFreeBuyAuditProblems = -1;
  private isRunning = false;
  /**
   * Timer callbacks are promises even though setInterval cannot await them.
   * They create tournaments and register paid seats, so clearing the clocks is
   * not a shutdown boundary: the old leader must also join every callback that
   * already started. Public top-ups share this set so a caller awaiting one and
   * service shutdown have the same ownership proof.
   */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;

  // RETIRED 2026-08-19. Scheduled tournaments are created BY the union, not
  // alternated between its member clubs. SHARK_CLUB_ID / JAQK_CLUB_ID remain
  // referenced elsewhere for rake-routing fallbacks only.
  private readonly ownerClubId = MIDWAY_UNION_ID;
  private readonly ownerUnionId = MIDWAY_UNION_ID;

  /**
   * The board the platform runs itself. It stays exactly as it was: club_id
   * and union_id both the Midway union id, which is how every club in that
   * union has always found these games. Activated owners get their own boards
   * IN ADDITION to this one, so a player who belongs to no activated club
   * still has somewhere to sit.
   */
  private readonly houseOwner: BoardOwner = {
    clubId: MIDWAY_UNION_ID,
    unionId: MIDWAY_UNION_ID,
    maxStake: Number.POSITIVE_INFINITY,
    kind: 'house',
  };

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private launchLifecycleJob(generation: number, work: () => Promise<void>, context: string): void {
    if (!this.lifecycleIsCurrent(generation)) return;
    void this.trackLifecycleJob(work()).catch((error) => reportError(error, context));
  }

  private async drainLifecycleJobs(): Promise<void> {
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  private openLifecycleScope(): () => void {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    void this.trackLifecycleJob(completion);
    return release;
  }

  start(): void {
    if (this.stopOperation) {
      console.warn('[TournamentRecurring] Start refused while the prior generation is stopping');
      return;
    }
    if (this.isRunning) {
      console.log('[TournamentRecurring] Already running');
      return;
    }

    this.isRunning = true;
    const generation = ++this.lifecycleGeneration;
    console.log(
      '[TournamentRecurring] Service started - MTTs every 5 min, SNG + Spin boards every 30 s, XMTTs every 5 min'
    );

    // Tournament check: every 5 minutes
    // THE FREEZE (Dan 2026-09-01) gates every launcher below: launching a
    // game registers and seats horses, which is buy-ins - chip movement. A
    // board slot that stays empty for five extra minutes refills on the first
    // tick after the thaw.
    this.tournamentInterval = setInterval(
      () => {
        if (isMaintenanceFrozen()) return;
        this.launchLifecycleJob(
          generation,
          () => this.checkAndLaunchTournaments(),
          'TournamentRecurring.tournament_tick_failed'
        );
      },
      5 * 60 * 1000
    );

    /**
     * A BOARD IS REFILLED AS FAST AS IT DRAINS.
     *
     * These were 15 and 10 minutes, chosen back when a seat-first game took
     * about ten minutes to fill: the refill tick and the drain rate happened
     * to match, so nobody noticed the cadence was a guess rather than a
     * measurement.
     *
     * They no longer match. A Spin now opens with a 60-180 second human
     * window, starts about 13 seconds after it closes, and plays out
     * hyper-turbo three-handed -- alive for roughly THREE MINUTES end to end.
     * Measured in production 2026-08-23: 125 Spins created and completed in
     * ninety minutes, and at the moment of measuring ZERO were open and the
     * last had been created eight minutes earlier. For most of every
     * ten-minute cycle a player opening the Spin lobby saw an EMPTY BOARD with
     * nothing to sit down at.
     *
     * Thirty seconds is well inside the shortest possible life of a game, so a
     * seat that empties is offered again almost immediately. The tick is cheap
     * by construction: ensureBoardOpen does ONE indexed read and returns
     * without writing when the board is already full, which is the
     * overwhelmingly common case, and its BURST cap still bounds a cold start
     * to 12 creations per tick.
     */
    this.sngInterval = setInterval(() => {
      if (isMaintenanceFrozen()) return;
      this.launchLifecycleJob(
        generation,
        () => this.checkAndLaunchSNGs(),
        'TournamentRecurring.sng_tick_failed'
      );
    }, BOARD_REFILL_INTERVAL_MS);
    this.spinInterval = setInterval(() => {
      if (isMaintenanceFrozen()) return;
      this.launchLifecycleJob(
        generation,
        () => this.checkAndLaunchSpins(),
        'TournamentRecurring.spin_tick_failed'
      );
    }, BOARD_REFILL_INTERVAL_MS);

    // XMTT check: every 5 minutes
    this.xmttInterval = setInterval(
      () => {
        if (isMaintenanceFrozen()) return;
        this.launchLifecycleJob(
          generation,
          () => this.checkAndLaunchXMTTs(),
          'TournamentRecurring.xmtt_tick_failed'
        );
      },
      5 * 60 * 1000
    );

    /* THE FREE BUY BOARD (Dan 2026-09-04). Every five minutes, which is 36
       ticks inside the three-hour publication lead - a restart, a maintenance
       break and a failed insert can all happen and the slot is still
       published with hours to spare. */
    this.freeBuyInterval = setInterval(() => {
      if (isMaintenanceFrozen()) return;
      this.launchLifecycleJob(
        generation,
        () => this.checkAndCreateFreeBuys(),
        'TournamentRecurring.free_buy_tick_failed'
      );
    }, FREE_BUY_TICK_MS);

    // Run checks immediately on start
    this.launchLifecycleJob(
      generation,
      () => this.checkAndLaunchTournaments(),
      'TournamentRecurring.initial_tournament_tick_failed'
    );
    this.launchLifecycleJob(
      generation,
      () => this.checkAndLaunchSNGs(),
      'TournamentRecurring.initial_sng_tick_failed'
    );
    this.launchLifecycleJob(
      generation,
      () => this.checkAndLaunchSpins(),
      'TournamentRecurring.initial_spin_tick_failed'
    );
    this.launchLifecycleJob(
      generation,
      () => this.checkAndLaunchXMTTs(),
      'TournamentRecurring.initial_xmtt_tick_failed'
    );
    this.launchLifecycleJob(
      generation,
      () => this.checkAndCreateFreeBuys(),
      'TournamentRecurring.initial_free_buy_tick_failed'
    );
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    // Fence scheduling synchronously; the drain below owns what already ran.
    this.isRunning = false;
    this.lifecycleGeneration++;
    if (this.tournamentInterval) clearInterval(this.tournamentInterval);
    if (this.sngInterval) clearInterval(this.sngInterval);
    if (this.spinInterval) clearInterval(this.spinInterval);
    if (this.xmttInterval) clearInterval(this.xmttInterval);
    if (this.freeBuyInterval) clearInterval(this.freeBuyInterval);

    this.tournamentInterval = null;
    this.sngInterval = null;
    this.spinInterval = null;
    this.xmttInterval = null;
    this.freeBuyInterval = null;

    const drain = (async () => {
      await this.drainLifecycleJobs();
      console.log('[TournamentRecurring] Stopped');
    })();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THE FREE BUY BOARD
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  FIVE FREE BUYS A DAY, PER HOST (Dan 2026-09-04)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dan, verbatim: "EVERY 4 HOURS STARTING AT 8 AM, 12PM, 4PM 8PM, 12AM. SO 5
   * FREE ROLLS A DAY $250'S EACH. 8PM IS $500." First entry free, 3,000
   * starting stack, paid rebuys and a 10,000-chip add-on that opens at
   * sit-down and closes after the break.
   *
   * WHY THIS IS NOT A ROW IN HOURLY_SCHEDULE. That board matches on
   * `now.getUTCHours()` and creates its events at `now + MTT_PUBLISH_LEAD_MS`,
   * so an event lands whenever the tick happens to fire inside a three-hour
   * UTC block. A Free Buy has to start at 20:00 CHICAGO to the minute, on a
   * clock that moves twice a year, and the whole point of the board is that a
   * player can rely on the hour. So the slot decides the start time and the
   * publication lead is measured BACKWARDS from it - the inverse of every
   * other creator in this file. See freeBuySlotsDue.
   *
   * IDEMPOTENCY IS THE DATABASE'S, NOT THIS LOOP'S. The pre-read below is a
   * courtesy that saves an insert; the guarantee is
   * uq_scheduled_tournament_one_live_per_occurrence, unique on (club_id,
   * tournament_type, name, start_time) while the event is pre-start. Two
   * engines, two overlapping ticks or a retry all converge on one event per
   * (host, slot, Chicago date), and the loser sees 23505 - which is the guard
   * working, not a failure.
   *
   * NO HORSES ARE REGISTERED HERE, deliberately. Every other creator seeds a
   * field at creation because it publishes 30 minutes out; this one publishes
   * three hours out, and registering then would hold horses off the cash floor
   * for three hours for nothing. The pre-start ramp in GameServer's discovery
   * loop fills every REGISTERING tournament on a squared curve "however it was
   * created", which puts one entrant on the row immediately and the rest in
   * the last hour. That is the tuned path; this pass does not second-guess it.
   */
  private async checkAndCreateFreeBuys(): Promise<void> {
    // THE FREEZE IS TOTAL (Dan 2026-09-03). Creating a tournament is not
    // itself a chip movement, but the ramp seats horses into it within
    // seconds, and start() runs this once immediately - a boot inside the
    // break must not open a board.
    if (isMaintenanceFrozen()) return;
    if (this.freeBuyTickInFlight) return;
    this.freeBuyTickInFlight = true;
    try {
      const due = freeBuySlotsDue(Date.now());
      if (due.length === 0) return;

      for (const host of FREE_BUY_HOSTS) {
        for (const d of due) {
          if (isMaintenanceFrozen()) return;
          const cfg = FREE_BUY_TIERS[d.slot.tier];
          const row = freeBuyTournamentRow({
            host,
            due: d,
            blindStructure: BLIND_STRUCTURES.FREE_BUY,
            payoutStructure: PAYOUT_STRUCTURES.NINE,
            // NLH full ring. Written through the same clamp the engine applies
            // at deal time, so the row states what will actually be dealt.
            tableSize: clampSeatsForVariant('nlh', 9),
            // late_reg_levels is what the engine enforces; late_reg_mins is the
            // legacy fallback. Derived from the ladder rather than guessed, so
            // the hour Dan asked for is the hour the engine gives.
            lateRegLevels: lateRegLevelsForMinutes(BLIND_STRUCTURES.FREE_BUY, cfg.lateRegMinutes),
          });
          const name = String(row.name);
          const startTime = String(row.start_time);

          const { count, error: readErr } = await supabase
            .from('tournaments')
            .select('id', { count: 'exact', head: true })
            .eq('club_id', host.clubId)
            .eq('tournament_type', 'MTT')
            .eq('name', name)
            .eq('start_time', startTime);
          // Fail CLOSED, exactly like getActiveCount: an unreadable board is
          // not an empty board, and creating on a failed read is how a
          // duplicate storm starts. The slot has 36 more ticks to land.
          if (readErr) continue;
          if ((count ?? 0) > 0) continue;

          const { data, error } = await supabase
            .from('tournaments')
            .insert(row)
            .select('id')
            .maybeSingle();

          if (error) {
            const msg = String(error.message ?? '');
            if (error.code === '23505' || /duplicate key|unique constraint/i.test(msg)) continue;
            if (isGuaranteeRefusal(error)) {
              await notifyGuaranteeShort(host.clubId, 'checkAndCreateFreeBuys');
              continue;
            }
            reportError(
              new Error(
                `[TournamentRecurring] Free Buy "${name}" for ${host.label} failed: ${msg || JSON.stringify(error)}`
              ),
              'TournamentRecurring.free_buy_create_failed'
            );
            continue;
          }
          if (data) {
            console.log(
              `[TournamentRecurring] Free Buy published: "${name}" for ${host.label}, ` +
                `${cfg.guarantee} guaranteed, starts ${startTime}`
            );
          }
        }
      }
      await this.auditFreeBuyBoardOnce();
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] Free Buy check error: ${err?.message ?? err}`),
        'TournamentRecurring.free_buy_check_error'
      );
    } finally {
      this.freeBuyTickInFlight = false;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE FREE BUY WATCH - the board checks itself, hourly, forever
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Creating the events is not the same as their being RIGHT. Five triggers
   * rewrite a tournament row on the way in and one of them exists to force
   * every 0-buy-in MTT's rebuy and add-on to 1.00; the tier-aware migration
   * says it must not touch a scheduled Free Buy, and only a live row can show
   * whether that is still true after somebody edits a trigger next month.
   *
   * WHY IT LIVES IN THE ENGINE. A Claude scheduled task belongs to one account
   * and dies silently when Dan is on another - `smarter-poker-cron-health` read
   * `enabled: true` for two and a half months after it last fired. A GitHub
   * `schedule:` is barred for application logic. The engine already runs this
   * cycle every five minutes, already has the database, and already has the
   * alert path, so the watch costs one indexed read an hour and survives
   * every session that is not this one.
   *
   * It shares its rules with `npm run freebuy:verify` through
   * `auditFreeBuyBoard`, so a one-shot check and the standing watch cannot
   * drift into two opinions about what a correct Free Buy looks like.
   *
   * Alerts ON CHANGE, like every other watch here: a row re-filed hourly is a
   * row somebody mutes, and it stays open until it is resolved anyway.
   */
  private async auditFreeBuyBoardOnce(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFreeBuyAuditAt < FREE_BUY_AUDIT_EVERY_MS) return;
    this.lastFreeBuyAuditAt = now;
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .select(
          'name, club_id, union_id, start_time, guaranteed_prize, buy_in_amount, buy_in_fee, ' +
            'starting_chips, rebuy_cost, addon_cost, addon_chips, addon_from_start, ' +
            'add_on_available, is_rebuy, max_rebuys, late_reg_mins, late_reg_levels, rebuy_levels'
        )
        .eq('free_buy', true)
        .gte('start_time', new Date(now - 24 * 60 * 60_000).toISOString());
      // An unreadable board is not a wrong board.
      if (error) return;

      const { problems, checked } = auditFreeBuyBoard((data ?? []) as any[], now);
      if (problems.length === 0) {
        if (this.lastFreeBuyAuditProblems > 0) {
          console.log(`[TournamentRecurring] Free Buy audit: ${checked} event(s), all correct now`);
        }
        this.lastFreeBuyAuditProblems = 0;
        return;
      }
      console.warn(
        `[TournamentRecurring] Free Buy audit: ${problems.length} problem(s) across ` +
          `${checked} event(s)\n  ${problems.slice(0, 10).join('\n  ')}`
      );
      if (problems.length === this.lastFreeBuyAuditProblems) return;
      this.lastFreeBuyAuditProblems = problems.length;
      await supabase.rpc('fn_raise_server_financial_alert', {
        p_severity: 'warning',
        p_source: 'TournamentRecurring.freeBuyAudit',
        p_message:
          `The Free Buy board is not what it was specified to be: ${problems.length} problem(s) ` +
          `across ${checked} event(s). First: ${problems[0]}`,
        p_context: { kind: 'free_buy_board_wrong', checked, problems: problems.slice(0, 25) },
        p_entity_id: 'free_buy_board',
      });
    } catch (err) {
      reportError(err, 'TournamentRecurring.freeBuyAudit');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchTournaments(): Promise<void> {
    try {
      // THE FREEZE IS TOTAL (Dan 2026-09-03): launching registers and seats
      // horses - buy-ins. Gated here, not only at the interval, because
      // start() runs each check once immediately and a boot inside the
      // break used to launch straight through it.
      if (isMaintenanceFrozen()) return;
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
              `[TournamentRecurring] "${config.name}" was created concurrently - skipping (this is the duplicate guard working)`
            );
            continue;
          }
          throw createErr;
        }
      }

      /**
       * ═════════════════════════════════════════════════════════════════════
       * MTT FLOOR (Dan 2026-08-26, binding): "at least 2 tournaments at once."
       * ═════════════════════════════════════════════════════════════════════
       * The hourly blocks carry 1-2 named events and create at most one
       * instance per name, so a quiet block could leave the board with a
       * single live MTT (or none, right after one finishes). Count what is
       * actually live and, while it is short of two, launch the next unlaunched
       * config from the schedule — same createTournament path, same duplicate
       * guard, so a race can only ever fail benignly.
       */
      const { count: liveMtts, error: mttCountErr } = await supabase
        .from('tournaments')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_type', 'MTT')
        .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING', 'LATE_REG']);
      if (!mttCountErr && (liveMtts ?? 0) < 2) {
        let need = 2 - (liveMtts ?? 0);
        const allConfigs = HOURLY_SCHEDULE.flatMap((b) => b.tournaments);
        for (const config of allConfigs) {
          if (need <= 0) break;
          const existing = await this.getActiveCount(config.type, config.name);
          if (existing > 0) continue;
          try {
            const result = await this.createTournament(config);
            if (result.tournamentId) {
              need--;
              console.log(
                `[TournamentRecurring] MTT floor: launched "${config.name}" to keep at least 2 tournaments live`
              );
            }
          } catch (createErr: any) {
            const msg = String(createErr?.message ?? createErr ?? '');
            if (createErr?.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
              continue; // created concurrently — still counts toward the floor
            }
            throw createErr;
          }
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

  /**
   * One pass over a board family at a time.
   *
   * The guard used to live inside ensureBoardOpen. It cannot stay there now
   * that a single Spin pass calls ensureBoardOpen once per OWNER: the second
   * owner in the same tick would find the flag set by the first and be skipped
   * forever. It belongs around the whole pass, which is also what it always
   * meant.
   */
  private async withBoardTick(variant: 'spin' | 'sng', run: () => Promise<void>): Promise<void> {
    if (this.boardTickInFlight[variant]) {
      console.log(`[TournamentRecurring] ${variant} board tick still running - skipping this one`);
      return;
    }
    this.boardTickInFlight[variant] = true;
    try {
      await run();
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] ${variant} board error: ${err?.message}`),
        'TournamentRecurring.board_error'
      );
    } finally {
      // finally, not the end of try: every path inside returns early on a read
      // error, and leaving the flag set would freeze the board permanently.
      this.boardTickInFlight[variant] = false;
    }
  }

  private async checkAndLaunchSNGs(): Promise<void> {
    await this.withBoardTick('sng', async () => {
      // THE FREEZE IS TOTAL (Dan 2026-09-03) - see checkAndLaunchTournaments.
      if (isMaintenanceFrozen()) return;

      /* Dan 2026-09-01 (Deep Stack Society directive): heads-up and SNG
       * boards for activated club owners, exactly the way the Spin pass
       * does it -- the house board and one owner board per activated
       * owner. activatedSpinOwners() is the platform's one "this owner has
       * switched club games on and funded them" signal; a standalone club
       * like Deep Stack (11192) activates via fn_spin_activate and gets its
       * own SNG/heads-up board on the same tick, same repair pass.
       *
       * Every board gets its own share of BURST up front (see
       * boardBudgetShares): the house used to go first on a single shared
       * budget and, being perpetually short, spent all of it every tick.
       *
       * maxStake clamps the buy-ins an owner's board offers, mirroring
       * the Spin rule: never list a price point the owner did not sign
       * up for. */
      const owners = await this.activatedSpinOwners();
      const share = boardBudgetShares(owners.length + 1);
      await this.ensureBoardOpen(
        'sng',
        SNG_CONFIGS,
        (c, o) => this.createSNG(c as any, o),
        this.houseOwner,
        { left: share }
      );
      for (const owner of owners) {
        const affordable = SNG_CONFIGS.filter((c) => c.buyIn <= owner.maxStake);
        if (affordable.length === 0) continue;
        await this.ensureBoardOpen(
          'sng',
          affordable,
          (c, o) => this.createSNG(c as any, o),
          owner,
          { left: share }
        );
      }

      /* Satellite heads-ups ride the same tick as the heads-up board they
         sit on. A handful per owner at most (one per dear target), so the
         share is capped well under a board share: this is a feeder, not a
         ladder. */
      const satelliteShare = Math.min(share, SATELLITE_HU_TARGETS_PER_OWNER);
      await this.ensureSatelliteHeadsUps(this.houseOwner, satelliteShare);
      for (const owner of owners) {
        await this.ensureSatelliteHeadsUps(owner, satelliteShare);
      }
    });
  }

  /**
   * One satellite heads-up per dear target in this owner's scope. See the
   * SATELLITE HEADS-UP block above SPIN_BOARD_SPEEDS for the rule; this is the
   * read and the board call.
   */
  private async ensureSatelliteHeadsUps(owner: BoardOwner, budgetLeft: number): Promise<void> {
    if (budgetLeft <= 0) return;
    try {
      let q = supabase
        .from('tournaments')
        .select(
          'id, name, start_time, buy_in_amount, buy_in_fee, variant, max_players, game_type, tournament_type, is_bounty, is_pko, is_mystery_bounty, is_premium_spin'
        )
        .eq('status', 'REGISTERING')
        .gt('start_time', new Date(Date.now() + SATELLITE_HU_TARGET_LEAD_MS).toISOString())
        .lt('start_time', new Date(Date.now() + SATELLITE_HU_TARGET_HORIZON_MS).toISOString())
        .gte('buy_in_amount', 1)
        .order('buy_in_amount', { ascending: false })
        .limit(200);
      q = owner.unionId
        ? q.eq('union_id', owner.unionId)
        : q.eq('club_id', owner.clubId).is('union_id', null);
      const { data, error } = await q;
      if (error) {
        // Fail closed, as the boards do: no targets read means no feeders
        // opened this tick, never a feeder into a game that may not exist.
        reportError(
          new Error(`[TournamentRecurring] satellite target read failed: ${error.message}`),
          'TournamentRecurring.satellite_target_read_failed'
        );
        return;
      }
      const targets = pickSatelliteTargets((data ?? []) as SatelliteTargetRow[], Date.now());
      const configs = targets
        .map(satelliteHeadsUpConfigFor)
        .filter((c): c is SatelliteHeadsUpConfig => c !== null)
        .filter((c) => c.buyIn <= owner.maxStake);
      if (configs.length === 0) return;
      // The 'sng' board: a satellite heads-up IS a heads-up (variant 'sng'),
      // matched to its own config names, so the board read is the same one.
      await this.ensureBoardOpen(
        'sng',
        configs,
        (c, o) => this.createSatelliteHeadsUp(c, o),
        owner,
        { left: budgetLeft }
      );
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] satellite heads-up board error: ${err?.message}`),
        'TournamentRecurring.satellite_board_error'
      );
    }
  }

  /**
   * A satellite heads-up is created exactly as a heads-up SNG is, with three
   * differences on the row: tournament_type 'SATELLITE' (so the finish awards
   * a seat, never cash), the target it feeds, and the one seat it guarantees.
   */
  private async createSatelliteHeadsUp(
    config: SatelliteHeadsUpConfig,
    owner: BoardOwner = this.houseOwner
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      const startTime = new Date(Date.now() + seatFirstHumanWindowMs());
      const dbGameType = dbGameTypeFor(config.gameVariant, 'createSatelliteHeadsUp');

      const satelliteRow = {
        club_id: owner.clubId,
        union_id: owner.unionId,
        name: config.name,
        game_type: dbGameType,
        /* variant 'sng' + tournament_type 'SATELLITE', deliberately. Every
             seat-first reader (GameServer's fast start, fn_take_seat_and_buy_in,
             the stuck-finish sweep, the table sizing in TournamentManager) knows
             a heads-up as `variant === 'sng' && max_players <= 2`, and the
             finish path knows a satellite as `variant === 'satellite' ||
             tournament_type === 'SATELLITE'` (TournamentManagerEliminations,
             fn_tournament_payout_reconcile). This row satisfies both without
             teaching either side a new spelling. */
        variant: 'sng',
        tournament_type: 'SATELLITE',
        ...buyInColumns(
          config.buyIn,
          rakeRateFor({ tournamentType: 'SNG', maxPlayers: config.maxPlayers })
        ),
        guaranteed_prize: 0,
        starting_chips: config.startingStack,
        max_players: config.maxPlayers,
        min_players: config.minPlayers,
        table_size: config.maxPlayers,
        current_players: 0,
        status: 'REGISTERING',
        blind_structure: config.blindStructure,
        payout_structure: config.payoutStructure,
        // Satellite qualification uses its seat contract, not MTT paid depth.
        // The atomic seat-first creator deliberately rejects unknown fields.
        start_time: startTime.toISOString(),
        late_reg_levels: 0,
        late_reg_mins: 0,
        satellite_target_id: config.targetId,
        satellite_seats: 1,
        short_description: `Win A Seat In ${config.targetName}. 1 Seat Guaranteed.`,
      };
      const created = await this.createSeatFirstGameAtomic(satelliteRow, 'satellite');
      if (!created) {
        return { tournamentId: null, registered: 0 };
      }
      const sat = created.tournament;
      await this.seedOpenSeatTable(sat, config.maxPlayers, created.tableId);
      console.log(
        `[TournamentRecurring] satellite heads-up "${config.name}" opened for ${owner.kind} ${owner.clubId.slice(0, 8)}: ${config.buyIn} chips a seat, ticket ${config.ticketCost}`
      );
      return { tournamentId: sat.id, registered: 0 };
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] createSatelliteHeadsUp error: ${err.message}`),
        'TournamentRecurring.createSatelliteHeadsUp_error'
      );
      return { tournamentId: null, registered: 0 };
    }
  }

  /**
   * Every owner who has switched Spins on and funded the wallet behind them.
   *
   * spin_bonus_pools.club_id is the OWNER id, not necessarily a club: for a
   * union-owned pool it is the union's id, and owner_kind says which. That
   * distinction is the whole reason BoardOwner carries unionId separately --
   * see the comment on it for what happens when it is wrong.
   *
   * balance > 0 is deliberate belt-and-braces alongside is_active: a pool that
   * has been drained cannot pay a multiplier, and opening games it cannot
   * settle would hand players a prize the wallet has to clamp.
   */
  private async activatedSpinOwners(): Promise<BoardOwner[]> {
    try {
      const { data, error } = await supabase
        .from('spin_bonus_pools')
        .select('club_id, owner_kind, offered_max_stake, balance')
        .eq('is_active', true)
        .not('activated_at', 'is', null)
        .gt('balance', 0)
        .limit(200);

      if (error) {
        reportError(
          new Error(`[TournamentRecurring] activated spin owners read failed: ${error.message}`),
          'TournamentRecurring.spin_owners_read_failed'
        );
        return [];
      }

      return (
        (data ?? [])
          .map((r: any) => ({
            clubId: String(r.club_id),
            unionId: r.owner_kind === 'union' ? String(r.club_id) : null,
            maxStake: Number(r.offered_max_stake) || 0,
            kind: (r.owner_kind === 'union' ? 'union' : 'club') as 'union' | 'club',
          }))
          // The house runs from houseOwner above; listing it twice would have one
          // pass fill the board and the next see it already full, alternating.
          .filter((o) => o.clubId !== this.houseOwner.clubId)
          // An owner who never chose a stake has nothing we can price a board at.
          .filter((o) => o.maxStake > 0)
      );
    } catch {
      return [];
    }
  }

  /**
   * Create the listing and its joinable table inside one database transaction.
   * The UUID is generated before the request, so an ambiguous response can be
   * retried against the same identity without opening a second game.
   */
  private async createSeatFirstGameAtomic(
    row: Record<string, unknown>,
    context: string
  ): Promise<AtomicSeatFirstCreation | null> {
    const tournamentId = nodeCrypto.randomUUID();
    const { data, error } = await supabase.rpc('fn_create_seat_first_game_atomic', {
      p_tournament_id: tournamentId,
      p_config: row,
    });
    const result = data as {
      ok?: boolean;
      reason?: string;
      tournament?: AtomicSeatFirstCreation['tournament'];
      table_id?: string;
    } | null;
    if (error || result?.ok !== true || !result.tournament || !result.table_id) {
      reportError(
        new Error(
          `[TournamentRecurring] ${context} atomic creation failed: ${error?.message ?? result?.reason ?? 'invalid response'}`
        ),
        `TournamentRecurring.${context}_atomic_creation_failed`
      );
      return null;
    }
    if (result.tournament.id !== tournamentId) {
      reportError(
        new Error(`[TournamentRecurring] ${context} atomic creation returned another game`),
        `TournamentRecurring.${context}_atomic_identity_mismatch`
      );
      return null;
    }
    return { tournament: result.tournament, tableId: result.table_id };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchSpins(): Promise<void> {
    await this.withBoardTick('spin', async () => {
      // THE FREEZE IS TOTAL (Dan 2026-09-03) - see checkAndLaunchTournaments.
      if (isMaintenanceFrozen()) return;

      // ONE ceiling for the whole pass (BURST), split into a share per board
      // before anyone spends. The house board used to go first on a single
      // shared budget "so it is never starved by owner boards" - and being
      // thirty-odd games short every tick, it starved every owner board
      // instead. See boardBudgetShares for the measurement.
      const owners = await this.activatedSpinOwners();
      const share = boardBudgetShares(owners.length + 1);

      await this.ensureBoardOpen(
        'spin',
        SPIN_CONFIGS,
        (c, o) => this.createSpin(c as any, o),
        this.houseOwner,
        { left: share }
      );

      for (const owner of owners) {
        // Only the price points this owner's seed can actually cover. The
        // required seed is two top-tier jackpots at their largest stake, so
        // offering a bigger buy-in than they seeded for would advertise a
        // multiplier the wallet cannot pay.
        const affordable = SPIN_CONFIGS.filter((c) => c.buyIn <= owner.maxStake);
        if (affordable.length === 0) continue;
        await this.ensureBoardOpen(
          'spin',
          affordable,
          (c, o) => this.createSpin(c as any, o),
          owner,
          { left: share }
        );
      }
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ALWAYS-ON BOARD (Dan 2026-08-21)
   * ───────────────────────────────────────────────────────────────────────
   * "the tables just stay open until players sit down, they don't need to be
   *  scheduled just always running."
   *
   * The old rule was a GLOBAL cap - at most 5 live spins and 3 live SNGs,
   * whichever configs the rotation happened to reach. Two things fell out of
   * that, both measured in production before this change:
   *
   *   - Exactly ONE spin and ONE SNG existed platform-wide, and BOTH were
   *     already RUNNING. A player opening the Spin-It tab had nothing at all
   *     to sit down at.
   *   - Because the cap counted RUNNING games too, a full board of in-progress
   *     games satisfied the threshold and suppressed every new opening. The
   *     busier the platform got, the fewer joinable games it offered.
   *
   * The guarantee is now PER CONFIG and counts only what a player can actually
   * JOIN: for every entry on the board, if there is no REGISTERING instance,
   * open one. A game that fills and starts is replaced on the next pass, so
   * every price point is permanently available.
   *
   * One query for the whole board, not one per config: at 32 spins and 48 SNGs
   * a per-config count would be 80 round trips every tick.
   */
  private async ensureBoardOpen<T extends { name: string }>(
    variant: 'spin' | 'sng',
    configs: T[],
    create: (config: T, owner: BoardOwner) => Promise<{ tournamentId: string | null }>,
    owner: BoardOwner,
    budget: { left: number }
  ): Promise<void> {
    if (budget.left <= 0) return;
    try {
      /**
       * SCOPED TO THIS OWNER. Without the scope, one owner's board would be
       * read as satisfying another's: the set is keyed on the config NAME, and
       * "10 Chip Spin PLO4" is the same string on every board. The house would
       * fill first and every activated club would then look already-full and
       * never open a single game.
       *
       * Scoped the same way the lobby reads it, so what this counts is what a
       * player of that owner can actually see: by union_id when a union owns
       * the board, by club_id when a club owns it alone.
       */
      const openQuery = supabase
        .from('tournaments')
        // id and max_players as well as the name: a seat-first game only
        // COVERS its price point if it can actually be joined, and that means
        // owning a table. See the joinability filter below.
        .select('id, name, max_players')
        .eq('variant', variant)
        // REGISTERING only. ANNOUNCED is not joinable and RUNNING is too late;
        // counting either is what let a board of live games starve the lobby.
        .eq('status', 'REGISTERING');

      if (owner.unionId) openQuery.eq('union_id', owner.unionId);
      else openQuery.eq('club_id', owner.clubId).is('union_id', null);

      const { data: openRows, error } = await openQuery;

      if (error) {
        // Fail CLOSED, exactly as getActiveCount does: on a transient read
        // error assume the board is fine and skip a cycle, rather than
        // recreating all 80 games because the count came back empty.
        reportError(
          new Error(`[TournamentRecurring] ${variant} board read failed: ${error.message}`),
          'TournamentRecurring.board_read_failed'
        );
        return;
      }

      /**
       * A LISTING ONLY COUNTS IF A PLAYER COULD SIT AT IT.
       *
       * This set used to be every REGISTERING name, which is why thirty of
       * thirty-two Spin price points were dead for fifteen hours: a
       * seat-first game with no table is REGISTERING forever, so its name
       * permanently satisfied the board and the config was never reopened.
       * The atomic creator means a new listing cannot exist without its table.
       * This filter remains defense in depth for rows created by a pre-atomic
       * binary during a rolling deployment.
       *
       * OWNING A TABLE IS NOT THE SAME AS BEING JOINABLE (2026-08-31). The
       * test used to be "does a table row exist", and that is how the entire
       * Sit-and-Go board died for ten hours: thirty-two heads-up SNGs sat
       * REGISTERING, each owning exactly ONE table whose status was 'closed'.
       * A closed table cannot be sat in, so the past-start top-up could never
       * fill them, they could never start, and every one of the thirty-two
       * configs read as covered. missing.length was 0 on every tick and not a
       * single new SNG was opened. The tables had been closed by the retired
       * World Hub legacy engine (GameController._cleanupStaleTables, disarmed
       * the same evening) - but the board must not be able to absorb husks
       * whatever creates them, so the test is now joinability, not existence.
       */
      const rows = (openRows ?? []) as { id: string; name: string; max_players: number }[];
      const seatFirstIds = rows
        .filter((r) => isSeatFirstFormat(variant, Number(r.max_players) || 0))
        .map((r) => r.id);

      let withJoinableTable = new Set<string>();
      if (seatFirstIds.length > 0) {
        const { data: tableRows, error: tableErr } = await supabase
          .from('tables')
          // status and is_deleted as well as the id: OWNING a table is not the
          // same as being joinable. See isJoinableTableRow.
          .select('tournament_id, status, is_deleted')
          .in('tournament_id', seatFirstIds);
        if (tableErr) {
          // Fail CLOSED, as the read above does: assume the board is fine
          // rather than opening a duplicate of every seat-first config.
          reportError(
            new Error(
              `[TournamentRecurring] ${variant} joinability read failed: ${tableErr.message}`
            ),
            'TournamentRecurring.board_joinability_read_failed'
          );
          return;
        }
        withJoinableTable = new Set(
          (tableRows ?? [])
            .filter((r) => isJoinableTableRow(r as TournamentTableJoinability))
            .map((r) => String((r as { tournament_id: string }).tournament_id))
        );
      }

      const open = new Set(
        rows
          .filter(
            (r) =>
              !isSeatFirstFormat(variant, Number(r.max_players) || 0) || withJoinableTable.has(r.id)
          )
          .map((r) => String(r.name))
      );
      const missing = configs.filter((c) => !open.has(c.name));
      if (missing.length === 0) return;

      /* Cap the per-tick burst. A cold start has every config missing, and
         creating them all in one tick means one insert plus one
         horse-registration batch each against the same connection - enough to
         stall the engine loop that also has live hands to deal. The budget
         handed in is this board's SHARE of BURST for the pass (see
         boardBudgetShares), so the ceiling holds however many owners have
         activated and no board can spend another board's share. Boards fill
         over a few ticks instead. */
      let launched = 0;
      for (const config of missing.slice(0, budget.left)) {
        const result = await create(config, owner);
        if (result.tournamentId) {
          launched++;
          budget.left--;
        }
        if (budget.left <= 0) break;
      }

      if (launched > 0) {
        console.log(
          `[TournamentRecurring] Opened ${launched} ${variant}(s) for ${owner.kind} ${owner.clubId.slice(0, 8)}; ${missing.length - launched} still to fill`
        );
      }
    } catch (err: any) {
      reportError(
        new Error(`[TournamentRecurring] ${variant} board error: ${err.message}`),
        'TournamentRecurring.board_error'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // XMTT (UNION TOURNAMENT) CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndLaunchXMTTs(): Promise<void> {
    try {
      // THE FREEZE IS TOTAL (Dan 2026-09-03): launching registers and seats
      // horses - buy-ins. Gated here, not only at the interval, because
      // start() runs each check once immediately and a boot inside the
      // break used to launch straight through it.
      if (isMaintenanceFrozen()) return;
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
      // Published MTT_PUBLISH_LEAD_MS ahead so the pre-start ramp has a window
      // to build the field in. At the old 5 minutes it had 7 ticks (42
      // entrants) and this event needs 56 to cover its guarantee.
      const startTime = new Date(Date.now() + MTT_PUBLISH_LEAD_MS);
      const dbGameType = dbGameTypeFor(config.gameVariant, 'createXMTT');

      const isBountyType =
        config.type === 'bounty' ||
        config.type === 'progressive_bounty' ||
        config.type === 'mystery_bounty';
      // Whole-chip entry prices can fund fractional bounties. Use the same
      // cent allocation as scheduled MTTs without changing a booked head.
      const split = buyInFor(config.buyIn);
      const bountyAmount = isBountyType ? mttBountyAmount(split, config) : 0;
      // MYSTERY RANGE 2026-08-21 (Dan: "make sure that this is fully added to
      // the mystery bounty tournaments"). These columns were advertising a
      // range the draw could not produce.
      //
      // The prize is drawn in fn_register_for_tournament /
      // fn_register_horse_for_tournament from a fixed multiplier table applied
      // to the player's funded bounty:
      //
      //     60%  x0.5      25%  x1      10%  x2      4%  x3      1%  x13
      //
      // Expected value is exactly 1.0, which is what keeps the funded bounty
      // pool balanced. So the true payout range is 0.5x to 13x the head — but
      // these columns were being written as `bounty` and `bounty * 10`, and
      // the lobby renders them as MULTIPLIERS ("6x - 60x"). A $6 head was
      // therefore advertised as paying up to 60x when 13x is the ceiling, and
      // as starting at 6x when 60% of draws are BELOW the head at 0.5x.
      //
      // Write what the table actually pays, in currency, so the lobby, the
      // detail page and the chest all agree with the money.
      const MYSTERY_MIN_MULT = 0.5;
      const MYSTERY_MAX_MULT = 13;
      const mysteryMin =
        config.type === 'mystery_bounty'
          ? Math.round(bountyAmount * MYSTERY_MIN_MULT * 100) / 100
          : 0;
      const mysteryMax =
        config.type === 'mystery_bounty'
          ? Math.round(bountyAmount * MYSTERY_MAX_MULT * 100) / 100
          : 0;

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
            ...buyInColumns(config.buyIn),
            guaranteed_prize: wholeChips(config.guarantee),
            starting_chips: config.startingStack,
            max_players: config.maxPlayers,
            /**
             * SEATS AT THE TABLE (2026-08-31 audit). Neither the MTT nor the
             * XMTT insert wrote this column, and it is `NOT NULL DEFAULT 9` —
             * the same omission already found and fixed for SNG (10,315 rows)
             * and Spin (28,731 rows), still open on these two.
             *
             * Measured live before the fix: 5,000 PLO6 tournaments sitting at
             * table_size 9 against a deck that can serve 7. The row was not
             * merely cosmetic-wrong, it disagreed with what the engine would
             * actually do — TournamentManagerBase clamps the seat count through
             * clampSeatsForVariant at deal time and logs "deck cannot serve
             * more". So the database said 9, the felt said 6, and nothing
             * reconciled them.
             *
             * Written through the SAME function the engine applies, so the row
             * now states what will actually be dealt. Nine is full ring; the
             * clamp takes it down per variant (plo6 6, plo5 7, plo4/plo8 8).
             */
            table_size: clampSeatsForVariant(config.gameVariant, 9),
            min_players: config.minPlayers || 3,
            current_players: 0,
            status: 'REGISTERING',
            blind_structure: config.blindStructure,
            ...mttSpeedColumns(config.blindStructure),
            payout_structure: config.payoutStructure || [],
            payout_percent: mttPayoutPercent(config.payoutPercent),
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
            rebuy_cost: (config as { rebuy?: boolean }).rebuy ? split.total : null,
            rebuy_chips: (config as { rebuy?: boolean }).rebuy ? config.startingStack : null,
            rebuy_levels: (config as { rebuy?: boolean }).rebuy ? 6 : null,
            max_rebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            max_reentries: (config as { rebuy?: boolean }).rebuy ? 1 : null,
            add_on_available: (config as { addOn?: boolean }).addOn === true,
            addon_cost: (config as { addOn?: boolean }).addOn ? split.total : null,
            addon_chips: (config as { addOn?: boolean }).addOn ? config.startingStack : null,
            addon_levels: (config as { addOn?: boolean }).addOn ? 1 : null,
            // FREEROLLS ARE FREE BUY (Dan 2026-09-02): 0 to enter, rebuys and
            // add-ons on at 1 chip each. Spread LAST so it wins over the
            // template's opt-in keys above. Empty for any paid event.
            ...freeBuyColumns({
              buyIn: split.total,
              tournamentType: 'MTT',
              variant: config.type === 'mtt' ? 'freezeout' : config.type,
              startingStack: config.startingStack,
              maxRebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            }),
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
        // A short funding bank will not refill in five seconds.
        if (isGuaranteeRefusal(error)) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] XMTT creation FAILED after 3 retries: ${lastError?.message || JSON.stringify(lastError) || 'Unknown error'}`
          ),
          'RecurringService.XMTT_creation_FAILED_after_3_r'
        );
        if (isGuaranteeRefusal(lastError)) await notifyGuaranteeShort(hostClubId, 'createXMTT');
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
      // POOL TRUTH 2026-08-27: prize_pool is ACCUMULATED by the register RPCs
      // (each entry adds its exact prize share - fee and bounty excluded), so
      // recomputing it here from config.buyIn x registered both overstated it
      // by the FEE on every entry (config.buyIn is the fee-inclusive total)
      // and pre-applied the guarantee, which must now be FUNDED at
      // finalization (fn_apply_prize_guarantee, host club treasury), never
      // written for free at creation. The lobby already displays
      // max(prize_pool, guaranteed_prize) client-side.
      const { error: updateErr } = await supabase
        .from('tournaments')
        .update({ current_players: registered, status: 'REGISTERING' })
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
      // An MTT is a scheduled event by nature, so it gets a real publication
      // lead rather than the seat-held wait spins and SNGs use
      // (OPEN_TABLE_WAIT_MS). This was 60 seconds, which gave the pre-start
      // ramp exactly ONE tick - a hard ceiling of MTT_PRESTART_MAX_STEP
      // entrants - and is why guaranteed recurring events were finishing their
      // registration under-funded and paying overlay. See MTT_PUBLISH_LEAD_MS.
      const startTime = new Date(Date.now() + MTT_PUBLISH_LEAD_MS);
      const dbGameType = dbGameTypeFor(config.gameVariant, 'createMTT');

      const isBountyType =
        config.type === 'bounty' ||
        config.type === 'progressive_bounty' ||
        config.type === 'mystery_bounty';

      // Share scheduled/XMTT bounty arithmetic; entry pricing remains unchanged.
      const split = buyInFor(config.buyIn);
      const bountyAmount = isBountyType ? mttBountyAmount(split, config) : 0;
      // Mystery bounty range: min = base bounty, max = 10x base
      // MYSTERY RANGE 2026-08-21 (Dan: "make sure that this is fully added to
      // the mystery bounty tournaments"). These columns were advertising a
      // range the draw could not produce.
      //
      // The prize is drawn in fn_register_for_tournament /
      // fn_register_horse_for_tournament from a fixed multiplier table applied
      // to the player's funded bounty:
      //
      //     60%  x0.5      25%  x1      10%  x2      4%  x3      1%  x13
      //
      // Expected value is exactly 1.0, which is what keeps the funded bounty
      // pool balanced. So the true payout range is 0.5x to 13x the head — but
      // these columns were being written as `bounty` and `bounty * 10`, and
      // the lobby renders them as MULTIPLIERS ("6x - 60x"). A $6 head was
      // therefore advertised as paying up to 60x when 13x is the ceiling, and
      // as starting at 6x when 60% of draws are BELOW the head at 0.5x.
      //
      // Write what the table actually pays, in currency, so the lobby, the
      // detail page and the chest all agree with the money.
      const MYSTERY_MIN_MULT = 0.5;
      const MYSTERY_MAX_MULT = 13;
      const mysteryMin =
        config.type === 'mystery_bounty'
          ? Math.round(bountyAmount * MYSTERY_MIN_MULT * 100) / 100
          : 0;
      const mysteryMax =
        config.type === 'mystery_bounty'
          ? Math.round(bountyAmount * MYSTERY_MAX_MULT * 100) / 100
          : 0;

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
            ...buyInColumns(config.buyIn),
            guaranteed_prize: wholeChips(config.guarantee),
            starting_chips: config.startingStack,
            max_players: config.maxPlayers,
            /**
             * SEATS AT THE TABLE (2026-08-31 audit). Neither the MTT nor the
             * XMTT insert wrote this column, and it is `NOT NULL DEFAULT 9` —
             * the same omission already found and fixed for SNG (10,315 rows)
             * and Spin (28,731 rows), still open on these two.
             *
             * Measured live before the fix: 5,000 PLO6 tournaments sitting at
             * table_size 9 against a deck that can serve 7. The row was not
             * merely cosmetic-wrong, it disagreed with what the engine would
             * actually do — TournamentManagerBase clamps the seat count through
             * clampSeatsForVariant at deal time and logs "deck cannot serve
             * more". So the database said 9, the felt said 6, and nothing
             * reconciled them.
             *
             * Written through the SAME function the engine applies, so the row
             * now states what will actually be dealt. Nine is full ring; the
             * clamp takes it down per variant (plo6 6, plo5 7, plo4/plo8 8).
             */
            table_size: clampSeatsForVariant(config.gameVariant, 9),
            min_players: config.minPlayers || 3,
            current_players: 0,
            status: 'REGISTERING',
            blind_structure: config.blindStructure,
            ...mttSpeedColumns(config.blindStructure),
            payout_structure: config.payoutStructure || [],
            payout_percent: mttPayoutPercent(config.payoutPercent),
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
            rebuy_cost: (config as { rebuy?: boolean }).rebuy ? split.total : null,
            rebuy_chips: (config as { rebuy?: boolean }).rebuy ? config.startingStack : null,
            rebuy_levels: (config as { rebuy?: boolean }).rebuy ? 6 : null,
            max_rebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            max_reentries: (config as { rebuy?: boolean }).rebuy ? 1 : null,
            add_on_available: (config as { addOn?: boolean }).addOn === true,
            addon_cost: (config as { addOn?: boolean }).addOn ? split.total : null,
            addon_chips: (config as { addOn?: boolean }).addOn ? config.startingStack : null,
            addon_levels: (config as { addOn?: boolean }).addOn ? 1 : null,
            // FREEROLLS ARE FREE BUY (Dan 2026-09-02): 0 to enter, rebuys and
            // add-ons on at 1 chip each. Spread LAST so it wins over the
            // template's opt-in keys above. Empty for any paid event.
            ...freeBuyColumns({
              buyIn: split.total,
              tournamentType: 'MTT',
              variant: config.type === 'mtt' ? 'freezeout' : config.type,
              startingStack: config.startingStack,
              maxRebuys: (config as { rebuy?: boolean }).rebuy ? 2 : null,
            }),
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
        // A short funding bank will not refill in five seconds.
        if (isGuaranteeRefusal(error)) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!tournament) {
        reportError(
          new Error(
            `[RecurringService] Tournament creation FAILED after 3 retries: ${lastError?.message || JSON.stringify(lastError) || 'Unknown error'}`
          ),
          'RecurringService.Tournament_creation_FAILED_aft'
        );
        if (isGuaranteeRefusal(lastError)) {
          await notifyGuaranteeShort(this.ownerClubId, 'createTournament');
        }
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
      // POOL TRUTH 2026-08-27: prize_pool is ACCUMULATED by the register RPCs
      // (each entry adds its exact prize share - fee and bounty excluded), so
      // recomputing it here from config.buyIn x registered both overstated it
      // by the FEE on every entry (config.buyIn is the fee-inclusive total)
      // and pre-applied the guarantee, which must now be FUNDED at
      // finalization (fn_apply_prize_guarantee, host club treasury), never
      // written for free at creation. The lobby already displays
      // max(prize_pool, guaranteed_prize) client-side.
      const { error: updateErr } = await supabase
        .from('tournaments')
        .update({ current_players: registered, status: 'REGISTERING' })
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
    config: SNGConfig,
    owner: BoardOwner = this.houseOwner
  ): Promise<{ tournamentId: string | null; registered: number }> {
    try {
      // A heads-up game is seat-first: one horse opens it and the second seat
      // is a human's for 60-180s. A 6-max or 9-max SNG is a field, not a table
      // you walk up to, and keeps the longer scheduled lead-in.
      const startTime = new Date(
        Date.now() +
          (isSeatFirstFormat('sng', config.maxPlayers)
            ? seatFirstHumanWindowMs()
            : OPEN_TABLE_WAIT_MS)
      );
      const dbGameType = dbGameTypeFor(config.gameVariant, 'createSNG');
      const seatFirstSng = isSeatFirstFormat('sng', config.maxPlayers);

      const sngRow = {
        // Whose board this is. See BoardOwner: these two fields are the
        // ONLY thing that decides which lobby the game appears in.
        club_id: owner.clubId,
        union_id: owner.unionId,
        name: config.name,
        game_type: dbGameType,
        variant: 'sng',
        tournament_type: 'SNG',
        // ONE source of truth for the rate - see rakeRateFor in
        // server/src/config/buyIn.ts. Keyed on the SEATS this config actually
        // has rather than on the word "SNG", so a future field SNG prices
        // itself correctly without anyone remembering to come back here.
        ...buyInColumns(
          config.buyIn,
          rakeRateFor({ tournamentType: 'SNG', maxPlayers: config.maxPlayers })
        ),
        guaranteed_prize: 0,
        starting_chips: config.startingStack,
        max_players: config.maxPlayers,
        min_players: config.minPlayers || 3,
        /**
         * SEATS AT THE TABLE (2026-08-27). This column was never written and
         * is `NOT NULL DEFAULT 9`, so every Heads-Up game ever created by this
         * service claimed a nine-handed table - 10,315 rows sitting at 9.
         *
         * That is not cosmetic. TournamentBrainContext resolves the format
         * from `table_size ?? max_players ?? 9`, and `??` only falls through
         * on NULL, so a defaulted 9 meant `max_players = 2` could never be
         * reached and EVERY duel resolved to 'mtt'. The horses then played
         * two-handed, one-spot-pays poker with ICM and bubble ranges.
         *
         * Clamped 2..10 to match every reader of this column
         * (TournamentManagerBase, TournamentManager, the deal gate).
         */
        table_size: Math.min(10, Math.max(2, Number(config.maxPlayers) || 2)),
        current_players: 0,
        status: 'REGISTERING',
        blind_structure: config.blindStructure,
        payout_structure: config.payoutStructure || [],
        // Heads-up has a fixed payout contract; paid depth belongs to fields.
        ...(!seatFirstSng ? { payout_percent: mttPayoutPercent(config.payoutPercent) } : {}),
        start_time: startTime.toISOString(),
        late_reg_levels: 0,
        late_reg_mins: 0,
      };

      let sng: AtomicSeatFirstCreation['tournament'] | null = null;
      let seatFirstTableId: string | null = null;
      let creationError: { message?: string } | null = null;
      if (seatFirstSng) {
        const created = await this.createSeatFirstGameAtomic(sngRow, 'sng');
        sng = created?.tournament ?? null;
        seatFirstTableId = created?.tableId ?? null;
      } else {
        const { data, error } = await supabase
          .from('tournaments')
          .insert(sngRow)
          .select()
          .maybeSingle(); // FIX 168
        sng = data as AtomicSeatFirstCreation['tournament'] | null;
        creationError = error;
      }

      if (creationError || !sng) {
        reportError(
          new Error(
            `[TournamentRecurring] SNG creation failed: ${creationError?.message || JSON.stringify(creationError) || 'Unknown error'}`
          ),
          'TournamentRecurring.SNG_creation_failed'
        );
        return { tournamentId: null, registered: 0 };
      }

      // SEAT-FIRST (Dan 2026-08-21): "THE HEADS UP BEGINS WHEN BOTH PLAYERS
      // BUY IN." A 2-seat game is a table you sit down at, not an event you
      // register for — it opens with both seats EMPTY and nobody pre-seated.
      // 6-max and 9-max SNGs are fields, not tables, and keep the
      // seat-held registration model.
      let registered = 0;
      if (seatFirstSng) {
        if (!seatFirstTableId) {
          reportError(
            new Error(`[TournamentRecurring] SNG ${sng.id} has no atomic table identity`),
            'TournamentRecurring.SNG_atomic_table_missing'
          );
          return { tournamentId: null, registered: 0 };
        }
        await this.seedOpenSeatTable(sng, config.maxPlayers, seatFirstTableId);
      } else {
        // TOURNEY-AUDIT 2026-07-24 (sweep 6): hold one seat for a human (full
        // fill only on periodic verification games).
        const seatPlan = horsesForSeatHeldGame(config.maxPlayers);
        registered = await this.registerHorses(sng.id, seatPlan.horses);
      }

      /**
       * Dan 2026-08-23: same trap as createSpin, one branch narrower.
       *
       * A seat-first SNG goes down the atomic creator path above, which
       * seats its horse without registering anybody, so `registered` is still
       * 0 here - and writing that zero erased the seat-derived count the
       * trigger had just set. A field SNG (6-max, 9-max) really does keep the
       * registration model, and for those the count is correct and must still
       * be written.
       */
      // POOL TRUTH 2026-08-27: prize_pool was written here as
      // config.buyIn x registered — 0 for a seat-first game, OVERWRITING the
      // prize share the opening horse's registration had just accumulated.
      // The 2026-08-23 fix below caught this exact trap for current_players
      // and left prize_pool in it, so every Heads-Up duel paid its winner ONE
      // prize share instead of two (95 on a 100 duel priced at 1.90x) —
      // ~230,561 chips retained over 30 days, repaid by
      // fn_backpay_hu_winner_shortfalls. The register RPCs are the only
      // writer of pool contributions now.
      const sngStateUpdate: Record<string, unknown> = {
        status: 'REGISTERING',
      };
      if (!seatFirstSng) sngStateUpdate.current_players = registered;

      const { error: sngUpdateErr } = await supabase
        .from('tournaments')
        .update(sngStateUpdate)
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

  /**
   * Seed the already-created table for a seat-first game. The database creates
   * the listing and this table in one transaction before this method runs, so
   * no application interruption can leave a tableless REGISTERING game.
   *
   * status 'waiting' (not 'running') — the engine has nothing to deal yet.
   * TournamentManagerBase.createTablesAndSeatPlayers already ADOPTS tables in
   * ['running','waiting'] and skips players who are already seated, so when
   * the game starts it inherits this table and the people sitting at it
   * instead of building a second one.
   *
   * Cash-table discovery cannot touch it: `cash_tables_with_players` filters
   * on `tournament_id IS NULL`.
   */
  private async seedOpenSeatTable(
    tournament: { id: string; club_id?: string | null; name: string },
    seats: number,
    tableId: string
  ): Promise<string | null> {
    try {
      /**
       * Open the table at seats-1: two horses on a Spin, one heads-up.
       *
       * They take REAL SEATS via fn_seat_horse_in_seat_first_game, not
       * registration rows. Registration alone is what broke this format: a
       * seat-first game starts when every SEAT is sold, so horses that were
       * only ever on the list left the game showing empty seats it could never
       * start with - 12 of 24 open Spins were stuck that way, some for a day,
       * and the next human to sit at one became its FOURTH entrant.
       */
      // Dan 2026-08-26: a held-empty game opens with NO horses — its seats
      // are the invitation. topUpWithHorses fills it the moment a human sits.
      //
      // A CLUB BOARD OPENS WITH ITS OWN MEMBERS (2026-09-11). This carried a
      // house-board-only condition, written when the pool was the whole platform
      // fleet and a house horse could wander into a user club's game. The pool
      // has been club-scoped since 2026-09-01 (clubMemberIdsForTournament, via
      // the tournamentId passed below), so the guard protected nothing and
      // did exactly what its own changelog (2026-09-03, "a club board fills
      // from its own members") said must stop: every Deep Stack Society Spin
      // and heads-up opened 0/3 and 0/2, and only the past-start top-up could
      // ever put a horse in one. Measured live 2026-09-11 13:5x UTC: 82 of 83
      // open DSS seat-first boards had no seat sold, against Dan's 09-01
      // directive that club boards open "exactly the way the house does". A
      // club with no horse members still opens empty - the pool is empty, not
      // the rule.
      const opening = !seatFirstHeldEmpty(tournament.id, seats)
        ? openingHorsesForSeatFirst(seats)
        : 0;
      const candidates = await this.pickFreeHorses(opening, false, tournament.id);
      let seated = 0;
      for (const horse of candidates) {
        // THE FREEZE IS TOTAL (Dan 2026-09-03): a ramp that began before :53
        // seats nobody after it. `continue`, not `break`: the "one refusal
        // must not halt the fill" pin forbids a break in this loop, and a
        // continue costs nothing - no RPC is made for the rest of the list.
        if (isMaintenanceFrozen()) continue;
        const { data: res, error: seatRpcErr } = await supabase.rpc(
          'fn_seat_horse_in_seat_first_game',
          { p_tournament_id: tournament.id, p_user_id: horse }
        );
        // The capacity and four-table triggers RAISE rather than returning
        // {ok:false}, so a discarded `error` here is a silent refusal.
        if (seatRpcErr) {
          reportError(
            new Error(
              `[TournamentRecurring] opening seat refused for ${tournament.name}: ${seatRpcErr.message}`
            ),
            'TournamentRecurring.opening_seat_rpc_failed'
          );
          continue;
        }
        if ((res as { ok?: boolean } | null)?.ok === true) seated++;
      }
      if (seated < opening) {
        console.warn(
          `[TournamentRecurring] ${tournament.name}: seated ${seated}/${opening} opening horse(s) - the pool is thin`
        );
      }

      // Every successful horse-seat transaction fires the strict AFTER-seat
      // count/Spin-booking invariant before its receipt returns. A separate
      // service-role sync here used to be a best-effort reconciler and could
      // acquire the terminal lock only after the seat row was already locked.

      return tableId;
    } catch (err: any) {
      reportError(err, 'TournamentRecurring.seedOpenSeatTable_threw');
      return null;
    }
  }

  /**
   * Horses that are genuinely free: not in a live tournament, not sitting at
   * any table. Same exclusions registerHorses uses, for the same reason -
   * taking a horse out of a hand it is already playing is worse than opening a
   * table one seat short.
   *
   * BATCHED, and that is the whole point of this signature.
   *
   * The first version of this took no argument and answered with ONE horse, so
   * seating a Spin called it twice and a top-up called it once per empty seat.
   * Each call reads up to 2,000 tournament_players, 2,000 table_seats and 400
   * profiles. GameServer's discovery pass runs every FIVE SECONDS across every
   * past-start short tournament, so that shape multiplies into thousands of
   * rows scanned per second against a database that had already been saturated
   * once today ("no tables load, nothing is playing", 2026-08-22).
   *
   * One busy-set read per call, however many horses are wanted. It is also the
   * pattern registerHorses right below already used - the per-horse version was
   * a regression against a convention this very file had settled on.
   */
  /**
   * How many idle horses the cash room still needs before the tournament
   * boards may claim any more.
   *
   * CASH_FLOOR_PER_TABLE is per LIVE cash table, counted from the seats rather
   * than from tables.current_players -- that column is maintained by a
   * different path and was measured disagreeing with the seats (69 vs 72) on
   * the same afternoon a denormalised count was found stale in three other
   * places. Count the thing itself.
   *
   * Fails OPEN, returning 0: if this read errors the boards behave exactly as
   * they did before the reserve existed. A reserve that turns a database blip
   * into a frozen lobby would be worse than no reserve.
   */
  private async cashRoomReserve(pass?: HorseTopUpPass): Promise<number> {
    // A pass holds a reserve it READ, never the fail-open 0 of one it could not.
    const reserve = await viaTopUpPass(
      pass,
      'cash-room-reserve',
      () => this.readCashRoomReserve(),
      (value) => value !== null
    );
    return reserve ?? 0;
  }

  /** The reserve, or null when it could not be read. cashRoomReserve fails that OPEN, as 0. */
  private async readCashRoomReserve(): Promise<number | null> {
    try {
      const { data: cashTables, error: tErr } = await supabase
        .from('tables')
        .select('id')
        .is('tournament_id', null)
        .eq('is_deleted', false)
        .in('status', ['waiting', 'running'])
        .limit(2000);
      if (tErr || !cashTables) return null;
      if (cashTables.length === 0) return 0;

      const ids = cashTables.map((t) => (t as { id: string }).id);
      /* CHUNKED, AND A FAILED READ IS REPORTED (2026-09-03). `ids` is up to
         2,000 live cash tables by the limit above, and the floor measured
         1,131 the day this was written - one `.in()` that long is past the
         ~675-id ceiling PostgREST accepts in a URL, so this answered HTTP 400
         and returned 0. Zero here means "reserve nobody for the cash room",
         which lets tournaments claim every free horse: exactly the drain the
         surrounding comments blame for emptying the cash floor on 2026-08-31.
         It still fails OPEN by design, but it no longer fails SILENTLY. */
      let seated = 0;
      let sErr: { message: string } | null = null;
      for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
        const { count: c, error: e } = await supabase
          .from('table_seats')
          .select('user_id', { count: 'exact', head: true })
          .is('left_at', null)
          .in('table_id', ids.slice(i, i + IN_LIST_CHUNK));
        if (e || typeof c !== 'number') {
          sErr = e ?? { message: 'no count returned' };
          break;
        }
        seated += c;
      }
      if (sErr) {
        reportError(
          new Error(
            `[TournamentRecurring] cash-floor reserve could not count seats across ${ids.length} table(s): ${sErr.message} - reserving nobody this pass`
          ),
          'TournamentRecurring.cash_floor_reserve_read_failed'
        );
        return null;
      }

      const wanted = ids.length * CASH_FLOOR_PER_TABLE;
      return Math.max(0, wanted - seated);
    } catch {
      return null;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * HORSE CONCURRENCY — Dan 2026-08-23: "each horse can play up to 4 tables"
   * ═══════════════════════════════════════════════════════════════════════
   *
   * How many live games each horse is currently committed to. Anything at or
   * above HORSE_MAX_CONCURRENT_TABLES is unavailable; everything below it is
   * fair game.
   *
   * WHAT THIS REPLACES, AND WHY THE OLD RULE WAS TOO BLUNT.
   * Both callers used to treat a horse as unavailable the moment it held ONE
   * seat or ONE registration. That is a concurrency limit of 1 on a fleet the
   * engine has always been able to multi-table. Measured live while writing
   * this: 584 horses exist and only 37 were pickable, because 554 were seated
   * at cash tables and every one of them was invisible to every tournament.
   * Tournament fields and cash tables were competing for the same horse rather
   * than sharing it.
   *
   * WHAT IT DELIBERATELY KEEPS. The prohibition that mattered was never "a
   * horse plays two games" - it was a horse being booked into the SAME game
   * twice, and a horse being yanked out of a hand it is mid-way through.
   * Neither changes here: registerHorses still skips anybody already in the
   * target tournament, fn_register_horse_for_tournament is still the only way
   * in, and a seat a horse already holds is never taken away from it. A horse
   * gains a table; it never loses one.
   *
   * COUNTING, WITHOUT DOUBLE COUNTING. A live seat is one game. A registration
   * is one game only while the tournament has not started - once it is RUNNING
   * the horse has a seat at its table and the seat side already counts it.
   * Counting both would put every tournament regular at an instant 2.
   */
  /**
   * Returns null when the load CANNOT BE READ, never an empty map.
   *
   * An unreadable read used to fall through `?? []` into a map with nothing in
   * it, and an empty load map says "every horse in the fleet is idle". Both
   * callers then hand out horses that are already at four tables, the
   * four-table trigger refuses each one with 23514, and the pass fills nobody
   * - while the logs stay silent because the refusal is discarded too. Unknown
   * is UNKNOWN: the caller declines this pass and tries again in five seconds.
   */
  private async horseLoadMap(): Promise<Map<string, number> | null> {
    // One live seat = one game. Cash and tournament tables alike.
    /* NO CEILING (Dan 2026-08-27: "there should never be a cap ... anywhere
       else"). This read carried `.limit(20000)` with a comment explaining
       that a truncated set understates load and hands out a horse already at
       four tables - the ceiling was picked to make that implausible, and
       nothing checked whether it had been hit, so saturation would have
       passed as a complete answer. It pages instead: no number to outgrow,
       and an incomplete read is reported as UNKNOWN, which is this
       function's documented contract. */
    const PAGE = 1000;
    const seatRows: LoadRef[] = [];
    for (let page = 0; ; page++) {
      if (page > 10_000) {
        reportError(
          new Error('[TournamentRecurring] horse seat-load paging did not terminate'),
          'TournamentRecurring.horse_load_seats_runaway'
        );
        return null;
      }
      /* The table is joined for two reasons, both of which were over-counting
         load and therefore holding pickable horses out of every board:

         (a) a seat at a CLOSED table is history, not a game. The hard limit in
             the database has said so since 2026-08-24 and this read had never
             agreed with it;
         (b) the tournament id is what lets buildHorseLoadMap tell a
             seat-first chair from a separate booking for the same game. */
      const { data: chunk, error: seatErr } = await supabase
        .from('table_seats')
        .select('user_id, table_id, tables!table_seats_table_id_fkey!inner(status, tournament_id)')
        .is('left_at', null)
        .neq('tables.status', 'closed')
        /*
         * THE SORT KEY MUST BE UNIQUE (2026-09-01).
         *
         * This paged 1,000 rows at a time ordered by `user_id` alone, and
         * user_id is the LEAST unique column here: the whole point of this
         * read is that a horse holds up to four seats. Postgres does not
         * promise a stable order within ties, so LIMIT/OFFSET over it can
         * repeat a row on one page and drop another.
         *
         * Both directions land on a documented failure of this very
         * function. A dropped row UNDERSTATES load, so a horse already at
         * four tables is handed out, the four-table trigger refuses it with
         * 23514 and the pass fills nobody - which is the "added NONE" line
         * the overlay guard keeps logging. A repeated row OVERSTATES load, so
         * a horse with two tables looks maxed out and is held out of every
         * board.
         *
         * NOT currently firing: measured 2026-09-01 there were 244 live seat
         * rows and 540 registration rows, both inside a single page, so no
         * boundary is crossed today. It is fixed now because it is invisible
         * until the fleet grows past a page and then presents as
         * intermittent, unexplainable starvation - and because this function
         * already documents that an incomplete read must be reported as
         * UNKNOWN rather than passed off as an answer.
         */
        .order('user_id', { ascending: true })
        .order('table_id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (seatErr) {
        reportError(
          new Error(`[TournamentRecurring] horse seat-load read failed: ${seatErr.message}`),
          'TournamentRecurring.horse_load_seats_failed'
        );
        return null;
      }
      if (!chunk) return null;
      seatRows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    // A registration is a game only until the tournament STARTS. Once it is
    // RUNNING the horse holds a seat at its table and the seat query above
    // has already counted it; counting both would put every tournament
    // regular at an instant 2. That is why RUNNING is absent from this list
    // and must stay absent.
    const regRows: LoadRef[] = [];
    for (let page = 0; ; page++) {
      if (page > 10_000) {
        reportError(
          new Error('[TournamentRecurring] horse registration-load paging did not terminate'),
          'TournamentRecurring.horse_load_registrations_runaway'
        );
        return null;
      }
      /* A REGISTRATION DAYS AWAY IS NOT A GAME TODAY (2026-09-07).

         Measured on the live fleet at 22:30 UTC: 615 of 1,000 horses read as
         "at capacity" (load >= 4) and 2,092 of their load units were
         REGISTRATIONS in events that had not started - 108 horses booked for
         "Sunday $200 Deep Stack" six days out, 110 for "Wednesday Feature"
         three days out, 290 for a freeroll an hour away. Every one of those
         bookings was holding a chair a horse could have been sitting in NOW,
         and the seat-first boards showed it: 160 spin / heads-up boards open,
         36 of 367 seats paid, pickFreeHorses answering "0 of 3 claimable" and
         "top-up added 0 of 1 needed" two hundred times per half hour, boards
         taking >10 minutes to start when they started at all - and a human
         at one of those boards waiting for opponents that existed but were
         "busy" with next Sunday.

         A registration occupies a chair when its event is about to seat its
         field, not before. Count it inside REGISTRATION_LOAD_HORIZON_MS of
         start (or when start_time is unknown - a seat-first game starts when
         full and is deduped against its own seat below anyway). The pure
         counting in buildHorseLoadMap is unchanged; this bounds what it is
         fed. */
      const horizonIso = new Date(Date.now() + REGISTRATION_LOAD_HORIZON_MS).toISOString();
      const { data: chunk, error: regErr } = await supabase
        .from('tournament_players')
        .select('user_id, tournament_id, tournaments!inner(status, start_time)')
        .in('status', ['registered', 'playing'])
        .in('tournaments.status', ['ANNOUNCED', 'REGISTERING'])
        .or(`start_time.is.null,start_time.lte.${horizonIso}`, { referencedTable: 'tournaments' })
        // Same unstable-pagination hazard as the seat read above: a horse is
        // registered for several events at once, so user_id alone does not
        // order these rows deterministically.
        .order('user_id', { ascending: true })
        .order('tournament_id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (regErr) {
        reportError(
          new Error(`[TournamentRecurring] horse registration-load read failed: ${regErr.message}`),
          'TournamentRecurring.horse_load_registrations_failed'
        );
        return null;
      }
      if (!chunk) return null;
      regRows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    return buildHorseLoadMap(
      (seatRows ?? []).map((r) => {
        // PostgREST returns a to-one embed as an object, but the generated
        // types have been known to widen it to an array; read both shapes
        // rather than silently losing the id and every dedupe with it.
        const row = r as {
          user_id?: string;
          tables?:
            | { tournament_id?: string | null }
            | Array<{ tournament_id?: string | null }>
            | null;
        };
        const embedded = Array.isArray(row.tables) ? row.tables[0] : row.tables;
        return { user_id: row.user_id, tournament_id: embedded?.tournament_id ?? null };
      }),
      (regRows ?? []).map((r) => {
        const row = r as { user_id?: string; tournament_id?: string };
        return { user_id: row.user_id, tournament_id: row.tournament_id ?? null };
      })
    );
  }

  /** Horses already at the concurrency ceiling. */
  private static atCapacity(load: Map<string, number>, id: string): boolean {
    return horseAtCapacity(load.get(id) ?? 0);
  }

  /**
   * The ids that may play in this tournament's club, or null when the answer
   * is not knowable right now.
   *
   * Hoisted out of registerHorses (#2430) because it was only ever applied
   * THERE. Every seat-first format -- Spins, Heads-Up, SNGs, the past-start
   * top-up -- fills through pickFreeHorses instead, which read the whole
   * platform fleet and never looked at the club. #2430 closed the front door
   * and left that one open.
   *
   * NULL IS NOT AN EMPTY CLUB. A failed or partial membership read returns
   * null and the caller declines to filter, exactly as registerHorses does:
   * refusing to seat on an unreadable page would starve every board on the
   * platform, which is a worse failure than the one being fixed.
   */
  /**
   * Who may be registered into this tournament's field.
   *
   * A CLUB'S EVENT DRAWS FROM ITS CLUB. A UNION'S EVENT DRAWS FROM ITS UNION
   * (2026-09-02). The membership rule added on 2026-09-01 - correctly, to stop
   * Deep Stack Society's standalone population wandering into the union's
   * schedule - resolved every tournament to the single `club_id` row it hangs
   * off. That is right for a standalone club and WRONG for a union event,
   * because a union event hangs off the union's OWN club row while the horses
   * live in the union's MEMBER clubs.
   *
   * Measured on Midway Union the day this was written:
   *
   *   Midway Union club row          323 horses
   *   Club JAQK + SHARK CLUB         584 horses  (392 tournament-lane)
   *
   *   candidates for a union event, host-club rule ......  28
   *   candidates for a union event, union-wide rule ..... 203
   *
   * Twenty-eight. That is the pool the entire union schedule was drawing from,
   * and it is why `registerHorses found no candidates` was the engine's most
   * frequent tournament log line while 392 tournament-lane horses sat idle -
   * and, alongside the publication-lead bug, why guaranteed events were closing
   * registration under-funded and paying overlay out of treasury.
   *
   * The isolation the 2026-09-01 rule exists to enforce is UNCHANGED: a
   * standalone club (`union_id IS NULL`, which is what Deep Stack Society is
   * and is meant to be) still resolves to exactly its own membership, because
   * the union branch below is only taken when the tournament carries a union.
   *
   * FAILS OPEN on an unreadable page, like every other gate in this file: a
   * partial read is not an empty club, and refusing to register on a failed
   * read starves every event on the platform.
   */
  private async clubMemberIdsForTournament(
    tournamentId: string,
    pass?: HorseTopUpPass
  ): Promise<Set<string> | null> {
    const hostClub = await supabase
      .from('tournaments')
      .select('club_id, union_id')
      .eq('id', tournamentId)
      .maybeSingle();
    const hostClubId = (hostClub.data as { club_id?: string } | null)?.club_id;
    const unionId = (hostClub.data as { union_id?: string } | null)?.union_id;
    if (!hostClubId) return null;
    // Membership depends on the club and the union alone: a pass reads each
    // scope once, not once per tournament in it. An unknown (null) is not held.
    return viaTopUpPass(
      pass,
      `club-members:${hostClubId}:${unionId ?? ''}`,
      () => this.clubMemberIdsForScope(hostClubId, unionId),
      (members) => members !== null
    );
  }

  /** Who may enter an event this club hosts, or null when that is unknowable right now. */
  private async clubMemberIdsForScope(
    hostClubId: string,
    unionId: string | undefined
  ): Promise<Set<string> | null> {
    /* The clubs whose members may enter. For a standalone club that is the one
       host club and nothing else. For a union event it is every club in the
       union, plus the union's own club row (which holds members of its own and
       is the row the event itself hangs off). */
    let clubIds: string[] = [hostClubId];
    if (unionId) {
      const [owned, joined] = await Promise.all([
        supabase.from('clubs').select('id').eq('union_id', unionId),
        supabase.from('union_clubs').select('club_id').eq('union_id', unionId),
      ]);
      // An unreadable union map must not silently narrow the pool back to the
      // host club - that is the bug being fixed. Decline the pass instead and
      // let the caller fail open.
      if (owned.error || joined.error) return null;
      const ids = new Set<string>([hostClubId]);
      for (const r of owned.data ?? []) {
        const id = (r as { id?: string }).id;
        if (id) ids.add(id);
      }
      for (const r of joined.data ?? []) {
        const id = (r as { club_id?: string }).club_id;
        if (id) ids.add(id);
      }
      clubIds = [...ids];
    }

    const memberPage = await fetchAllRows<{ user_id: string }>(
      (cursor, want) => {
        let q = supabase
          .from('club_members')
          .select('user_id')
          .in('club_id', clubIds)
          .order('user_id', { ascending: true })
          .limit(want);
        if (cursor) q = q.gt('user_id', cursor);
        return q;
      },
      { label: 'TournamentRecurring.clubMembers', maxRows: 100_000, idKey: 'user_id' }
    );
    if (!memberPage.complete) return null;
    return new Set(memberPage.rows.map((r) => r.user_id));
  }

  /**
   * The club wallets an entry into this event can be charged to, or null when
   * that is unknowable right now.
   *
   * Mirrors `fn_tournament_club_for_user`, which `atomic_deduct_wallet_and_log`
   * consults for every tournament buy-in: a standalone event charges the host
   * club's wallet; a union event charges one of the player's wallets at the
   * union's MEMBER clubs (`union_clubs`), never the union's own house row.
   */
  private async walletClubsForScope(
    hostClubId: string,
    unionId: string | undefined
  ): Promise<string[] | null> {
    if (!unionId) return [hostClubId];
    const joined = await supabase.from('union_clubs').select('club_id').eq('union_id', unionId);
    if (joined.error) return null;
    const ids = new Set<string>();
    for (const r of joined.data ?? []) {
      const id = (r as { club_id?: string }).club_id;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  private async pickFreeHorses(
    count: number,
    allLanes = false,
    tournamentId?: string,
    pass?: HorseTopUpPass
  ): Promise<string[]> {
    if (count <= 0) return [];
    try {
      // Dan 2026-08-23: a horse is unavailable at FOUR concurrent games, not
      // at one. See horseLoadMap for what that replaced and what it keeps.
      // One read per discovery pass when the caller holds one (HorseTopUpPass).
      const load = await viaTopUpPass(
        pass,
        'horse-load',
        () => this.horseLoadMap(),
        (map) => map !== null
      );
      // Unknown load, not zero load. horseLoadMap has already reported why.
      // Picking against an empty map means picking horses that are at four
      // tables, which the trigger refuses one by one.
      if (!load) return [];
      const busy = new Set(
        [...load.entries()]
          .filter(([id]) => TournamentRecurringService.atCapacity(load, id))
          .map(([id]) => id)
      );

      /**
       * TWO BUGS FIXED HERE (2026-08-23).
       *
       * 1. `.limit(400)` against a pool that is 584 horses and growing. The
       *    last 184 could never be picked by this path at all, so the fleet
       *    read as exhausted while nearly a third of it sat idle. Measured
       *    live: 24 spins and 12 heads-up games waiting 2-8 hours past their
       *    start for a seat. registerHorses right below already sizes its
       *    fetch as `count + busy.size`, which the comment above calls the
       *    convention this file settled on - this one had drifted from it.
       *
       * 2. Every caller drew from the SAME first rows in the SAME order, and
       *    the busy set is read before the claim rather than atomically with
       *    it, so two concurrent callers (the recurring service, the
       *    scheduler, and GameServer's past-start top-up all run this) pick
       *    the same horses and double-book them. Live count: 41 horses in a
       *    tournament AND at a cash table, plus 24 seated at two cash tables
       *    - one AI identity being asked to act in two places at once.
       *    Shuffling the candidates does not make the claim atomic, but it
       *    turns a near-certain collision into an unlikely one, which is the
       *    difference between systematic and occasional.
       */
      // V23 (2026-08-30): THE WHOLE FLEET, PAGED — no limit at all. The V22
      // `count*4 + busy.size + 50` sizing carried headroom for the lane
      // filter, but the query had no ORDER BY and no busy exclusion, so
      // Postgres served the SAME stable first page to every caller all day.
      // Once that page's free horses were drained (busy against a 584-horse
      // fleet), the filtered candidates shrank to zero and every seat-first
      // fill starved — the SNG board sat dead for hours while two-thirds of
      // the fleet idled beyond the page. The fleet is ~600 rows of ids; just
      // read all of it keyset-paged (fetchAllRows, the same pattern
      // HorseFleetManager.seedAllTables uses) and filter/shuffle in memory.
      const fleetPage = await viaTopUpPass(
        pass,
        'horse-fleet',
        () =>
          fetchAllRows<{ id: string }>(
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
            { label: 'TournamentRecurring.pickFreeHorses', maxRows: 50_000 }
          ),
        (page) => page.complete
      );
      if (!fleetPage.complete) {
        // The fleet read failing used to read as "the fleet is empty", which
        // is indistinguishable in the logs from a genuinely exhausted pool.
        reportError(
          new Error('[TournamentRecurring] horse fleet read came back incomplete'),
          'TournamentRecurring.horse_fleet_read_failed'
        );
        return [];
      }

      // Busy (4-game cap) exclusion and the lane/activity filters, unchanged
      // in meaning — now applied to the FULL fleet. See selectHorseCandidates.
      /**
       * A CLUB'S GAMES ARE FILLED BY THAT CLUB'S MEMBERS (Dan 2026-09-01:
       * "IT CAN NOT, WANDER... THEY ARE LIMITED TO ONLY THE CLUB THEY ARE
       * APART OF!").
       *
       * The fleet read above is every is_horse profile on the platform. A
       * standalone club's population was seated into another club's Spins and
       * heads-up games through this path while #2430 held the registration
       * path shut.
       */
      const fleetIds = fleetPage.rows.map((h) => h.id);
      const clubIds = tournamentId
        ? await this.clubMemberIdsForTournament(tournamentId, pass)
        : null;
      const inClub = clubIds ? fleetIds.filter((id) => clubIds.has(id)) : fleetIds;

      const candidates = selectHorseCandidates(inClub, busy, allLanes, new Date().getUTCHours());

      /**
       * ═══════════════════════════════════════════════════════════════════
       *  THE CASH ROOM GETS A FLOOR BEFORE THE BOARD GETS ITS NEXT SPIN
       * ═══════════════════════════════════════════════════════════════════
       *
       * Measured 2026-08-23, an hour after the seat-first board was unwedged
       * and started opening every price point again:
       *
       *     MTT   190 horses      CASH  43 horses across 44 tables
       *     SPIN  128 horses      -> 72 seats occupied in the whole cash room
       *     SNG   107 horses
       *
       * The board did exactly what it was told and drank the fleet. Nothing
       * here TAKES a horse off a cash table -- the busy set above forbids that
       * -- but by claiming every idle horse the instant one stands up, it
       * starves whatever puts horses back into cash seats, and the room
       * hollows out one rotation at a time. 44 tables showing 1 or 2 players
       * is a worse lobby than 30 spins showing 2/3.
       *
       * So the tournament side may not draw the pool below what the cash room
       * still needs. This does not move anybody; it declines to claim the last
       * horses, which leaves them for the cash seater to find. When the fleet
       * is comfortable the reserve is zero and this costs one indexed count.
       *
       * The floor is deliberately LOW. It is not "fill the cash room", it is
       * "never let it go empty while a board of spins fills": two horses is a
       * table that is visibly alive and can take a human as a third.
       */
      // nodeCrypto, not Math.random: CryptoRandom.test.ts forbids Math.random
      // anywhere in the engine services, and it is right to - a weak source
      // that starts life shuffling a horse list is one refactor away from
      // deciding a payout.
      //
      // V23: shuffle BEFORE the cash-room reserve trim. The trim used to cut
      // the tail of the (stable, id-ordered) unshuffled list, so the same
      // physical horses were held back for the cash room every single call.
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = nodeCrypto.randomInt(i + 1);
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const reserved = await this.cashRoomReserve(pass);
      const claimable = Math.max(0, candidates.length - reserved);
      if (claimable < count) {
        console.log(
          `[TournamentRecurring] holding ${reserved} horse(s) back for the cash room; ${claimable} of ${count} claimable`
        );
      }
      candidates.length = Math.min(candidates.length, claimable);
      return candidates.slice(0, count);
    } catch {
      return [];
    }
  }

  /**
   * The horses this game already has on its roster who are NOT holding a seat
   * on its table — the only entrants a roster-full seat-first game can still
   * admit. See seatFirstFillOrder for the deadlock and the production numbers.
   *
   * Every read here fails CLOSED, returning an empty list rather than a
   * guessed one: the caller then falls back to the free pool exactly as it did
   * before, which is the old behaviour and never worse than it.
   *
   * Horses only. A human on the roster who has not taken their seat is a human
   * who has not decided yet, and seating them from the engine would spend
   * their money for them.
   */
  private async unseatedRegistrantHorses(
    tournamentId: string,
    primaryTableId: string | null
  ): Promise<string[]> {
    // No table means there is no seat to give anybody. New seat-first games
    // cannot reach this state because their listing and table commit together.
    if (!primaryTableId) return [];
    try {
      const { data: roster, error: rosterErr } = await supabase
        .from('tournament_players')
        .select('user_id')
        .eq('tournament_id', tournamentId)
        .in('status', ['registered', 'playing'])
        .limit(1000);
      if (rosterErr) {
        reportError(
          new Error(
            `[TournamentRecurring] roster read failed for ${tournamentId.slice(0, 8)}: ${rosterErr.message}`
          ),
          'TournamentRecurring.seat_first_roster_read_failed'
        );
        return [];
      }
      const rosterIds = [
        ...new Set(
          (roster ?? [])
            .map((r) => String((r as { user_id?: string }).user_id ?? ''))
            .filter((id) => id.length > 0)
        ),
      ];
      if (rosterIds.length === 0) return [];

      const { data: seatRows, error: seatErr } = await supabase
        .from('table_seats')
        .select('user_id')
        .eq('table_id', primaryTableId)
        .is('left_at', null)
        .limit(1000);
      if (seatErr) {
        // Unreadable seats is UNKNOWN, never "nobody is seated" — that reading
        // would re-seat a player who is already sitting there.
        reportError(
          new Error(
            `[TournamentRecurring] seat read failed for table ${primaryTableId.slice(0, 8)}: ${seatErr.message}`
          ),
          'TournamentRecurring.seat_first_table_seat_read_failed'
        );
        return [];
      }
      const seated = new Set(
        (seatRows ?? [])
          .map((s) => String((s as { user_id?: string }).user_id ?? ''))
          .filter((id) => id.length > 0)
      );

      const unseated = rosterIds.filter((id) => !seated.has(id));
      if (unseated.length === 0) return [];

      const { data: horseRows, error: horseErr } = await supabase
        .from('profiles')
        .select('id')
        .eq('is_horse', true)
        .in('id', unseated);
      if (horseErr) {
        reportError(
          new Error(
            `[TournamentRecurring] roster horse lookup failed for ${tournamentId.slice(0, 8)}: ${horseErr.message}`
          ),
          'TournamentRecurring.seat_first_roster_horse_lookup_failed'
        );
        return [];
      }
      return (horseRows ?? [])
        .map((h) => String((h as { id?: string }).id ?? ''))
        .filter((id) => id.length > 0);
    } catch (err) {
      reportError(err, 'TournamentRecurring.unseatedRegistrantHorses_threw');
      return [];
    }
  }

  private async createSpin(
    config: SpinConfig,
    owner: BoardOwner = this.houseOwner
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
      // The last seat is a human's for 60-180s; after that the past-start
      // top-up is allowed to fill it. See seatFirstHumanWindowMs.
      const startTime = new Date(Date.now() + seatFirstHumanWindowMs());

      // THE DRAW DOES NOT HAPPEN HERE ANY MORE (2026-08-20, second pass).
      //
      // Creation used to call fn_spin_draw_multiplier and stamp the result
      // onto the row a full minute before the tournament started. Hiding the
      // NUMBER from the lobby (spinReveal.ts) turned out to be theatre of its
      // own, because the row still carried the answer arithmetically:
      // prize_pool was set to buyIn x multiplier at creation, so a $5 Spin
      // showing a $15 pool had told everyone "3x" before the wheel existed.
      // Any column derived from the multiplier is a spoiler; the only draw a
      // client cannot read early is one that has not happened yet.
      //
      // So the draw now happens at START, in TournamentManagerBase — which
      // has ALWAYS had a gated draw path for a row with no multiplier, and
      // which already settles the pool at the same moment. One draw, one
      // settlement, zero seconds between them: the value never exists
      // un-acted-upon, and there is nothing for a lobby to leak.
      //
      // Until then the row is honest about not knowing: spin_multiplier NULL,
      // prize_pool 0, and a placeholder structure from the SMALLEST tier —
      // the one floor every draw shares. Start rewrites stack, blinds,
      // payouts and pool from the real tier before any card is dealt.
      const placeholderTier = SPIN_TIERS[0];
      /* THE BOARD DECIDES THE STACK, NOT THE DRAW (Dan, 2026-09-01). This read
         SPIN_TIERS[0].startingStack, a placeholder that start() then rewrote
         from whichever tier the wheel landed on. The tier no longer carries a
         stack: a Turbo board is 300 and a Deep Stack board is 1000, the config
         says which, and the number is therefore true from the moment the row
         exists - which is what lets a paid seat hold its chips. */
      const spinStack = config.startingStack;
      const spinBlinds = Array.from({ length: 12 }, (_, i) => {
        const b = spinBlindsForLevel(i + 1);
        return {
          level: i + 1,
          smallBlind: b.small,
          bigBlind: b.big,
          ante: 0,
          duration: placeholderTier.levelMinutes * 60,
        };
      });
      const spinPayouts = [{ place: 1, percentage: 100 }];

      const dbGameType = dbGameTypeFor(config.gameVariant, 'createSpin');

      const spinRow = {
        // Whose board this is. See BoardOwner: these two fields are the
        // ONLY thing that decides which lobby the game appears in.
        club_id: owner.clubId,
        union_id: owner.unionId,
        // THE NAME MUST NOT CARRY THE MULTIPLIER. It used to read
        // "3 Chip Spin NLH (4x)", and that one string reached the lobby
        // tile, the tournament list, the table masthead and the browser tab
        // - so by the time the wheel span up to "reveal" the draw, the
        // player had already read the answer in four places. The draw is the
        // product; a reveal of a number you were shown on the way in is
        // theatre. `spin_multiplier` carries the value for everything that
        // legitimately needs it, and nothing anywhere parses the name for it
        // (verified by grep across both projects).
        name: config.name,
        game_type: dbGameType,
        variant: 'spin',
        tournament_type: 'SPIN',
        // Whole chips only (Dan 2026-08-20): "Sit and Go and any tournament
        // buy-ins must never be decimal buy-ins, whole numbers only." A Spin
        // carries no fee, so the buy-in IS the whole charge and is snapped to
        // an integer here rather than trusting the config.
        buy_in_amount: wholeChips(config.buyIn),
        // A SPIN IS NOT PRICED LIKE AN MTT. Dan, 2026-08-20: "THEY ARE
        // STRAIGHT JUST 10 BUY IN... NO ADDITIONAL RAKE IS ADDED." The rake
        // is engineered into the multiplier distribution instead - the
        // frequency table expects 2.7638, and (3 - 2.7638) / 3 = 7.87%,
        // which IS the advertised 8%. Charging a fee on top as well would
        // make the true edge 14.7%. See src/config/spinSpec.ts.
        buy_in_fee: 0,
        guaranteed_prize: 0,
        // NULL until start. The draw happens in TournamentManagerBase at
        // the moment the game begins - see the block comment above. A NULL
        // here is what start's draw path keys on, and it is also the only
        // value a lobby snoop can read before the wheel spins.
        spin_multiplier: null,
        // Likewise recorded at start, by the same draw. See migration
        // 20260820n_spin_locked_tiers_column.sql.
        spin_locked_tiers: null,
        starting_chips: spinStack,
        // Forced, not read from the config - a Spin is 3-handed by
        // definition. See SPIN_SEATS.
        max_players: SPIN_SEATS,
        min_players: SPIN_SEATS,
        // Same omission as createSNG carried until 2026-08-27: the column is
        // NOT NULL DEFAULT 9, so every Spin claimed a nine-handed table
        // (28,731 rows). The Spin format is resolved from tournament_type
        // before table_size is ever consulted, so nothing misbehaved here -
        // but a row that says 9 seats for a three-handed game is a lie
        // waiting for the next reader.
        table_size: SPIN_SEATS,
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
      };
      const created = await this.createSeatFirstGameAtomic(spinRow, 'spin');
      if (!created) {
        return { tournamentId: null, registered: 0 };
      }
      const spin = created.tournament;

      // SEAT-FIRST (Dan 2026-08-21): a Spin opens as a TABLE WITH THREE EMPTY
      // SEATS. No horse is pre-registered — that is what made it an MTT with
      // extra steps, and it is why a player could never simply walk up and sit
      // down. Players take seats first come, first served via
      // fn_take_seat_and_buy_in; the game starts the instant the third seat is
      // bought. If nobody takes the seats before the open-table window
      // expires, GameServer's past-start top-up fills the field with horses so
      // the board still churns — open first, churn second.
      await this.seedOpenSeatTable(spin, SPIN_SEATS, created.tableId);
      const registered = 0;
      // prize_pool stays 0 until start. It used to be set to
      // buyIn x multiplier here, which was the arithmetic spoiler described
      // above — the pool amount IS the multiplier, just divided by the
      // buy-in. Start computes and writes the real pool in the same breath
      // as the draw and the reserve settlement.
      /**
       * Dan 2026-08-23: DO NOT WRITE current_players HERE.
       *
       * This update used to carry `current_players: registered`, and
       * `registered` is the hardcoded 0 above - a leftover from when a Spin
       * pre-registered nobody. seedOpenSeatTable has just seated two horses
       * in REAL SEATS one line earlier, so this wrote a zero straight over the
       * truth, every single time a Spin was created.
       *
       * That is the whole reason 16 open Spins were advertising "0/3" while
       * holding 32 paid seats between them. It also defeated both attempted
       * fixes: the sync added inside seedOpenSeatTable and the trigger on
       * table_seats each set the number correctly, and this statement
       * overwrote it microseconds later.
       *
       * A seat-first game's count is derived from its seat rows, by
       * fn_sync_seat_first_player_count and now by the trigger that calls it.
       * The application's job here is the status and nothing else.
       */
      const { error: spinUpdateErr } = await supabase
        .from('tournaments')
        .update({
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
  /**
   * @param opts.allLanes  FREEROLLS ONLY (Dan 2026-08-27): "all horses, if
   *   they are playing, should play the freeroll - all real players would."
   *   The lane split exists so the fleet does not look like one homogeneous
   *   crowd across cash and events. A freeroll is the one event where that
   *   distinction is FALSE TO LIFE: nobody skips free money because they
   *   consider themselves a cash specialist. With this set, cash-lane horses
   *   are eligible too, and the pool is filtered by whether the horse is
   *   INSIDE ITS ACTIVITY WINDOW instead - "if they are playing".
   * @param opts.pass  GameServer's discovery pass (HorseTopUpPass): the fleet,
   *   its load, the cash-room reserve and club membership are read once per
   *   pass instead of once per call. Every other caller omits it.
   */
  async topUpWithHorses(
    tournamentId: string,
    targetPlayers: number,
    opts: { allLanes?: boolean; pass?: HorseTopUpPass } = {}
  ): Promise<number> {
    const pass = opts.pass;
    // This entry point is also used by GameServer discovery and by the
    // scheduled/overlay services. Register its whole continuation so stop()
    // cannot release leadership while a paid registration is still in flight.
    const releaseLifecycleScope = this.openLifecycleScope();
    try {
      // THE FREEZE IS TOTAL (Dan 2026-09-03): every horse this seats is a buy-in.
      if (isMaintenanceFrozen()) return 0;
      try {
        /**
         * A seat-first game needs BODIES IN SEATS, not names on a list.
         *
         * registerHorses writes tournament_players and nothing else, which is
         * correct for an MTT and useless for a Spin: the start rule counts sold
         * seats, so a topped-up Spin sat at "3 registered / 0 seated" and could
         * never begin. It also kept advertising three open seats, so the next
         * human to sit became a fourth entrant in a three-handed game.
         */
        /**
         * A MISSING ROW MUST NOT DECIDE THE FORMAT.
         *
         * This read discarded its error and then fell through `?? 0` into
         * isSeatFirstFormat('', 0) - and 0 <= 2, so an unreadable tournament
         * read as SEAT-FIRST. A 500-seat MTT would then be sent down the
         * seat-seating path instead of registerHorses, seat nobody (its table
         * is not a seat-first table), and never be topped up at all. The one
         * value we cannot guess is the one that chooses between the two halves
         * of this function.
         */
        const { data: tRow, error: tErr } = await supabase
          .from('tournaments')
          .select('variant, max_players, club_id, start_time, prize_pool_finalized')
          .eq('id', tournamentId)
          .maybeSingle();
        if (tErr || !tRow) {
          reportError(
            new Error(
              `[TournamentRecurring] top-up cannot read tournament ${tournamentId.slice(0, 8)}: ${tErr?.message ?? 'no row'}`
            ),
            'TournamentRecurring.topup_tournament_read_failed'
          );
          return 0;
        }
        const seatFirst = isSeatFirstFormat(
          String((tRow as { variant?: string } | null)?.variant ?? ''),
          Number((tRow as { max_players?: number } | null)?.max_players ?? 0)
        );

        /* A FINALIZED POOL TAKES NO ENTRANT (2026-09-11). Both doors refuse it -
           the human core reads prize_pool_finalized and answers
           registration_closed, the horse core meets the trigger that raises
           "registration is closed because tournament ... prize pool is
           finalized" - and both refusals arrive AFTER the seat-acquisition
           lock every hand settlement queues on. Measured 2026-09-11 12:27-13:27
           UTC: 39 seat-first games and one MTT that dealt on 2026-09-08 and were
           left REGISTERING with started_at NULL when that engine stopped at :53
           (every healthy REGISTERING row on the board reads finalized=false;
           these 40 read true), asked here every backoff: 1,796 locked
           fn_seat_horse_in_seat_first_game calls (330 fill passes ending
           rpc_other_noop=3) and 1,169 locked fn_register_horse_for_tournament
           calls in that hour that could only ever say no, and 298 "CANNOT
           FILL" alarms naming the wrong cause.
           A row whose pool is finalized has left registration whatever its
           status column says; it needs the finish path, never a fill. Said
           once per row per process, with the state that recovery needs. */
        if ((tRow as { prize_pool_finalized?: boolean | null }).prize_pool_finalized === true) {
          if (!this.finalizedPoolTopUpsRefused.has(tournamentId)) {
            this.finalizedPoolTopUpsRefused.add(tournamentId);
            reportError(
              new Error(
                `[TournamentRecurring] top-up refused for ${tournamentId.slice(0, 8)}: its prize pool is finalized, so it has left registration whatever its status says - it needs the finish path, not a fill`
              ),
              'TournamentRecurring.top_up_refused_pool_finalized'
            );
          }
          return 0;
        }

        /* MEMBERSHIP IS EXPLICIT, AND IT IS ENFORCED IN THE POOL - FOR EVERY FORMAT.
         See automatedRegistrationIsPermitted above for the measurement and the
         history. A SEAT-FIRST board fills wherever it was opened, because every
         candidate is drawn from clubMemberIdsForTournament() - the host club's
         own members for a standalone club, the whole union for a union event.

         THE MTT HALF OF THAT GATE IS GONE (Dan 2026-09-03, "CREATE A MTT
         TOURNEY SCHEDULE THAT MIRRORS THE MIDWAY UNION"). Until today this
         function still refused every non-house top-up that was NOT seat-first,
         on the written belief that registerHorses drew from an un-scoped pool
         and would put house horses on a user club's entry list. That belief
         was stale when it was written down: registerHorses has narrowed its
         pool through clubMemberIdsForTournament() since 2026-09-01, the same
         gate the seat-first path relies on, so a standalone club's MTT can only
         ever be filled by that club's own members. What the refusal actually
         did was leave every scheduled Deep Stack Society event empty. Measured
         2026-09-03: 59 of its MTTs on the board averaging 0.3 entrants, the
         twelve spawned that day at zero, while the pre-start ramp asked this
         function for a field every 45 seconds and was told no.

         So the ramp, the overlay guard and the past-start top-up now fill a
         club's MTT from the club's own members, exactly as they fill the house
         board from the union's. automatedRegistrationIsPermitted stays
         exported for the house-only callers that still want it; nothing in
         the top-up path consults it any more. */

        /**
         * MEASURE THE SHORTFALL IN THE UNIT THE START GATE READS.
         *
         * This counted rows in tournament_players for every format. For a
         * seat-first game that is the wrong unit, and it deadlocks the game
         * permanently rather than delaying it:
         *
         *   registrations 3 of 3  ->  shortfall 0, no horse is ever seated
         *   live seats    1 of 3  ->  the start gate never opens
         *
         * Neither side can move, and nothing else in the system tops a game up.
         * Five Spins were sitting in exactly that state on 2026-08-24, the
         * oldest 486 minutes past its start time, each holding three
         * registrations against one or two live seats.
         *
         * Seats for a seat-first game, registrations for an MTT - the same
         * split the counter itself uses.
         */
        let liveCount = 0;
        let primaryTableId: string | null = null;
        /* THE SEATS AS READ, kept for the fill loop. See seatFirstSeatPrecheck:
           the loop skips the RPC for a horse this shows seated and for a table
           this shows full, so the read below returns the rows rather than a
           bare count. Same rows, same index, same liveCount. */
        let liveSeatRows: Array<{ user_id?: string | null; seat_number?: number | null }> = [];
        if (seatFirst) {
          const { data: primaryId, error: primErr } = await supabase.rpc(
            'fn_tournament_primary_table',
            { p_tournament_id: tournamentId }
          );
          /* SILENT ZEROES ARE HOW AN OUTAGE LASTS TWENTY HOURS (2026-08-28).
           Both of these returned 0 with no telemetry, and a 0 from here
           stops every seat-first fill on the platform. That is the exact
           shape this file's own post-mortem names as the reason an earlier
           outage went unnoticed — "nothing on the platform reported it
           because every refusal on this path returns 0 silently". Every
           other RPC in this function reports; these did not. */
          if (primErr) {
            reportError(
              new Error(`[TournamentRecurring] primary-table read failed: ${primErr.message}`),
              'TournamentRecurring.seat_first_primary_table_read_failed'
            );
            return 0;
          }
          if (primaryId) {
            primaryTableId = String(primaryId);
            const { data: seatRows, error: seatErr } = await supabase
              .from('table_seats')
              .select('user_id, seat_number')
              .eq('table_id', primaryTableId)
              .is('left_at', null)
              .limit(1000);
            if (seatErr) {
              reportError(
                new Error(`[TournamentRecurring] seat count read failed: ${seatErr.message}`),
                'TournamentRecurring.seat_first_seat_count_read_failed'
              );
              return 0;
            }
            liveSeatRows = (seatRows ?? []) as typeof liveSeatRows;
            liveCount = liveSeatRows.length;
          }
        } else {
          const { count: regCount, error: countErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', tournamentId)
            .in('status', ['registered', 'playing']);
          if (countErr) return 0;
          liveCount = regCount || 0;
        }

        /**
         * HELD-EMPTY GATE (Dan 2026-08-26): a seat-first game flagged held-empty
         * gets NO horses while no human has bought a seat - 33% of Spins and
         * 50% of Heads-Up boards stay genuinely open for a human to start.
         * The instant a human sits, the hold releases and this same function
         * fills the remaining seats so the game can start.
         *
         * EMPTY MEANS EMPTY (2026-08-27). The gate now only applies to a board
         * that actually HAS no players. It used to apply at any occupancy, which
         * created a second class of permanently stuck game: a board that opened
         * NOT held (two horses seated, one seat left) and then had the hold roll
         * on later was refused its final horse forever, sitting at 2/3 - visibly
         * alive, impossible to start, and counting as coverage for its price
         * point the whole time.
         *
         * The rule is "leave some boards EMPTY for a human to start", not "strand
         * boards half-full". Once a seat is sold the board is committed and the
         * only right move is to finish filling it so it can deal.
         *
         * THE HOLD IS THE HUMAN WINDOW, NOT THE BUCKET (2026-09-11). The hold
         * rotated on a 30-minute bucket so no price point could be held for
         * ever, and that fixed the dead board of 2026-08-27. It left the other
         * half: a board that opened at 2/3 lives about four minutes (window,
         * fill, deal, replacement), a board that opened at 0/3 lived until its
         * bucket rolled and the backed-off past-start ask came round - up to
         * forty minutes. Two lifetimes ten to one, so the board a human sees is
         * almost all held ones. Measured 2026-09-11 13:5x UTC: 149 of 158 open
         * seat-first boards had no seat sold, every one past its human window,
         * and 138 of those 149 read as held in the current bucket (the
         * survivorship the 2026-08-27 note describes, one bucket at a time).
         * Dan's rule is a share of the board AT ANY INSTANT - "LEAVE ... 33% OF
         * ALL SPINS AND 50% OF HEADS UP [EMPTY]" - and his later, more specific
         * ruling on how long a seat is kept for a person is the window itself:
         * "fleet should hold the seat for 90-350 seconds max before filling"
         * (2026-09-05). So a held board is held for its human window - the
         * same 90-350 seconds a horse-opened board keeps its last seat - and
         * once start_time passes it fills like any other board. Both kinds of
         * board now live about as long, so the instantaneous share is the
         * rolled share. The roll itself (seatFirstHeldEmpty, id and bucket) and
         * seedOpenSeatTable's use of it are unchanged: a held board still opens
         * with nobody in it. A row with no readable start_time keeps the hold,
         * because it never reaches the past-start ask either.
         */
        const heldStartMs = Date.parse(
          String((tRow as { start_time?: string | null }).start_time ?? '')
        );
        const humanWindowOpen = !Number.isFinite(heldStartMs) || heldStartMs > Date.now();
        if (
          seatFirst &&
          liveCount === 0 &&
          humanWindowOpen &&
          seatFirstHeldEmpty(
            tournamentId,
            Number((tRow as { max_players?: number } | null)?.max_players ?? 0)
          )
        ) {
          // With no seat mutation there is nothing to reconcile. The stored
          // count is maintained in the same transaction as every canonical
          // create/revive/exit, so this held board simply remains available.
          this.noteSeatFirstHeld(tournamentId);
          return 0;
        }

        const shortfall = targetPlayers - liveCount;
        if (shortfall <= 0) {
          // No seat changed. Canonical seat transactions already commit the
          // exact count, so an idle sweep has no write authority here.
          return 0;
        }

        let added = 0;
        if (seatFirst) {
          /**
           * HOME FIRST, THEN THE FLEET. See seatFirstFillOrder for the measured
           * deadlock this breaks: a full roster against short seats cannot admit
           * a single new entrant, because fn_enforce_tournament_capacity RAISES
           * 23514 on the INSERT, and the game's own paid-up registrants were the
           * one group the old code could never pick.
           */
          const own = await this.unseatedRegistrantHorses(tournamentId, primaryTableId);
          // MORE CANDIDATES THAN SEATS. See seatFirstCandidateCount for the hour
          // of production log that says why one-per-seat leaves boards short.
          const wantCandidates = seatFirstCandidateCount(shortfall);
          const poolWanted = Math.max(0, wantCandidates - own.length);
          const pool =
            poolWanted > 0 ? await this.pickFreeHorses(poolWanted, false, tournamentId, pass) : [];
          const candidates = seatFirstFillOrder(wantCandidates, own, pool);

          /* THE LEDGER (see seatFirstSeatPrecheck). The table's capacity is the
             one value the seat read above does not carry; it is a lock-free
             primary-key read, paid only when there are candidates to seat. An
             unreadable row leaves the capacity UNKNOWN, which disables the
             table-full skip and nothing else - an unknown never skips a call. */
          let tableMaxPlayers: number | null | undefined = undefined;
          if (candidates.length > 0 && primaryTableId) {
            const { data: tblRow, error: tblErr } = await supabase
              .from('tables')
              .select('max_players')
              .eq('id', primaryTableId)
              .maybeSingle();
            if (tblErr || !tblRow) {
              console.warn(
                `[TournamentRecurring] seat-first-precheck ${tournamentId.slice(0, 8)}: table capacity unreadable (${tblErr?.message ?? 'no row'}) - every candidate goes to the RPC this pass`
              );
            } else {
              const raw = (tblRow as { max_players?: number | null }).max_players;
              tableMaxPlayers = raw === null || raw === undefined ? null : Number(raw);
            }
          }
          const ledger = seatFirstSeatLedger(
            liveSeatRows,
            tableMaxPlayers,
            (tRow as { max_players?: number | null } | null)?.max_players ?? null
          );
          const tally = emptySeatFirstPrecheckTally();
          /* WHY THE RPC SAID NO (2026-09-11). `rpc_other_noop` counted every
             `ok:false` that was not table_full and never said which: the 60
             minutes to 13:27 UTC logged 298 boards at `rpc_other_noop=3` and
             nothing on the platform could say what the three answers were
             (they were `tournament_full` on 2026-09-08 rows whose pool was
             finalized - see the finalized refusal above). A refusal with no
             reason is the "answers when it does not know" shape of 10.86. */
          const otherReasons = new Map<string, number>();

          for (const horse of candidates) {
            // The slack above is there to absorb REFUSALS, not to seat extras: a
            // 3-handed spin takes three. Stop as soon as the seats are covered.
            if (added >= shortfall) break;
            // THE FREEZE IS TOTAL (Dan 2026-09-03). continue, not break - see the
            // opening-seat loop above and the one-refusal pin in
            // seatFirstFillOrder.test.ts.
            if (isMaintenanceFrozen()) continue;
            /* SKIP THE CALL WHOSE ANSWER IS ALREADY KNOWN. The RPC would return
               already_seated / table_full for exactly these rows - after taking
               the global exclusive lock every hand settlement waits on. The RPC
               still decides for everybody else. A skipped already_seated is not
               a covered seat (it never was, see the note under the RPC result
               below), so the loop moves on to the next candidate. */
            let precheck = seatFirstSeatPrecheck(ledger, horse);
            if (precheck !== 'call') {
              /* VERIFY BEFORE SKIPPING (see seatFirstLedgerRefresh). The rows
                 behind that answer are as old as every call made ahead of this
                 one. Re-read them - same index, same predicate, no lock - and
                 ask again. A seat that opened in the meantime goes to the RPC
                 on THIS pass, as it always did; only a skip the fresh rows
                 still support is taken. A failed re-read cannot verify
                 anything, so it does not skip: the RPC decides. */
              precheck = 'call';
              if (primaryTableId) {
                tally.verifyReads++;
                const { data: freshRows, error: freshErr } = await supabase
                  .from('table_seats')
                  .select('user_id, seat_number')
                  .eq('table_id', primaryTableId)
                  .is('left_at', null)
                  .limit(1000);
                if (!freshErr) {
                  seatFirstLedgerRefresh(ledger, freshRows as typeof liveSeatRows);
                  precheck = seatFirstSeatPrecheck(ledger, horse);
                }
              }
            }
            if (precheck === 'already_seated') {
              tally.skippedAlreadySeated++;
              continue;
            }
            if (precheck === 'table_full') {
              tally.skippedTableFull++;
              continue;
            }
            tally.rpcCalled++;
            const { data: res, error: seatRpcErr } = await supabase.rpc(
              'fn_seat_horse_in_seat_first_game',
              { p_tournament_id: tournamentId, p_user_id: horse }
            );
            // 2026-08-24 audit: do NOT break on one refusal. A single horse
            // rejected - the four-table hard limit (23514), a race on the seat,
            // an already_registered anomaly - used to halt the whole fill even
            // when free horses remained in the candidate list.
            //
            // 2026-08-25: and do not DISCARD the refusal either. The capacity
            // trigger does not return {ok:false}, it RAISES, so the one signal
            // that would have named this deadlock arrived in `error` and was
            // thrown away for a day and a half.
            //
            // 2026-09-03: and do not report the ORDINARY refusal as a fault. The
            // four-table cap firing means the horse is busy - the rule working,
            // not the fill failing - and at 89 reports an hour it was burying the
            // refusals that do need reading. isExpectedSeatRefusal names them;
            // everything else is still reported, unchanged.
            if (seatRpcErr) {
              tally.rpcRefused++;
              if (!isExpectedSeatRefusal(seatRpcErr.message)) {
                reportError(
                  new Error(
                    `[TournamentRecurring] seat-first fill refused for ${tournamentId.slice(0, 8)}: ${seatRpcErr.message}`
                  ),
                  'TournamentRecurring.seat_first_seat_rpc_failed'
                );
              }
              continue;
            }
            const outcome = res as {
              ok?: boolean;
              already_seated?: boolean;
              reason?: string;
              seat_number?: number;
            } | null;
            if (outcome?.ok === true && outcome.already_seated === true) {
              /* The ledger was stale: the horse took its seat between the read
                 and this call. `ok:true` here covered NO seat - it used to be
                 counted as one, which stopped a pass one seat short whenever a
                 seated horse was drawn first, and a small club fleet draws the
                 same seated horse pass after pass. Note it, seat nobody, and let
                 the next candidate have the seat. */
              tally.rpcAlreadySeated++;
              seatFirstNoteSeated(ledger, horse, undefined);
              continue;
            }
            if (outcome?.ok === true) {
              added++;
              tally.seated++;
              seatFirstNoteSeated(ledger, horse, outcome.seat_number);
              continue;
            }
            if (outcome?.reason === 'table_full') {
              /* The race the ledger cannot see: another service filled the last
                 seat on this same tick. The RPC has now said so under its lock;
                 the spare candidates behind this one skip the queue. */
              tally.rpcTableFull++;
              seatFirstNoteTableFull(ledger);
              continue;
            }
            tally.rpcOtherNoop++;
            const why = String(outcome?.reason ?? 'no_reason');
            otherReasons.set(why, (otherReasons.get(why) ?? 0) + 1);
          }

          if (candidates.length > 0) {
            console.log(seatFirstPrecheckLogLine(tournamentId, tally));
            // The same numbers on /metrics, so the saving is visible without log access.
            recordSeatFirstPrecheck(tally);
            if (otherReasons.size > 0) {
              const summary = [...otherReasons.entries()].map(([r, n]) => `${r} x${n}`).join(', ');
              console.warn(
                `[TournamentRecurring] seat-first fill ${tournamentId.slice(0, 8)}: the seat RPC answered ok:false - ${summary}`
              );
            }
          }

          if (added === 0 && candidates.length > 0) {
            console.warn(
              `[TournamentRecurring] seat-first fill added nobody to ${tournamentId.slice(0, 8)} ` +
                `from ${own.length} own registrant(s) + ${pool.length} free horse(s) - shortfall ${shortfall}`
            );
          }
        } else {
          added = await this.registerHorses(tournamentId, shortfall, opts.allLanes === true, pass);
        }

        // Somebody was seated or registered: what this pass read is stale now.
        if (added > 0) pass?.forget();

        /**
         * Dan 2026-08-23: "spins can never ever start until 3 players have sat
         * down, and paid for there seat."
         *
         * A seat-first game counts SEATS, not rows in tournament_players. Those
         * two disagree constantly - a registration is never removed when a
         * player leaves or busts, so writing the registration count back into
         * current_players re-introduced the drift that had live spins reading
         * 3/3 with two seats sold (which then refuses every further sit-down
         * with 'tournament_full') and 0/3 with three sold (which never starts).
         * Derive it from the seat rows for seat-first, and keep the registration
         * count for MTTs, where a registration IS the entry.
         *
         * ── RESTORED 2026-08-23. This branch was written, reviewed and lost. ──
         *
         * The paragraph above still described it exactly, but the code under it
         * had been flattened to the MTT half alone, so every seat-first game had
         * its REGISTRATION count written into current_players. Horses seated by
         * fn_seat_horse_in_seat_first_game hold seats, not registrations, so that
         * number is zero: 16 open Spins were advertising "0/3" while holding 32
         * paid seats between them, two of three sold and one seat from dealing.
         *
         * The original lives on five branches under five different SHAs and on
         * none of them is it an ancestor of main - it merged as prose and not as
         * code, which is the "merge resolved by taking a stale side" failure
         * .agent/protected-commits.json exists to catch. It is pinned there now.
         *
         * 2026-08-23, THIS MERGE: main (#582) and the spins branch had both
         * arrived at this same fix independently, so git conflicted on the two
         * write-ups while auto-merging identical code underneath. Both are kept.
         * The quote is the requirement; the restoration note is why it went
         * missing twice. Six duplicate PRs (#566, #570, #572, #575, #581, #583)
         * were opened against a stale base and every one sat DIRTY on this one
         * comment - nothing else across 27 files conflicted at all.
         */
        if (!seatFirst) {
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
        }

        return added;
      } catch {
        // A throw can land after a seat was taken: trust nothing the pass holds.
        pass?.forget();
        return 0;
      }
    } finally {
      releaseLifecycleScope();
    }
  }

  private async registerHorses(
    tournamentId: string,
    count: number,
    allLanes = false,
    pass?: HorseTopUpPass
  ): Promise<number> {
    try {
      // TOURNEY-AUDIT 2026-07-24: exclude horses already registered/playing in
      // another active tournament. The old query only checked horse_status
      // (never flipped by tournament play), so the overlapping MTT/SNG/Spin
      // scheduler intervals double-booked the same horses into several
      // simultaneous events.
      // Dan 2026-08-23: FOUR concurrent games per horse, not one. The old
      // rule excluded any horse holding a single seat or registration, which
      // made 554 of 584 horses invisible to every tournament while they dealt
      // cash. See horseLoadMap.
      const load = await viaTopUpPass(
        pass,
        'horse-load',
        () => this.horseLoadMap(),
        (map) => map !== null
      );
      // Unknown load, not zero load — see horseLoadMap. Registering against an
      // empty map double-books horses that are already at four tables.
      if (!load) return 0;
      const busyIds = new Set(
        [...load.keys()].filter((id) => TournamentRecurringService.atCapacity(load, id))
      );

      // Still never twice into the SAME tournament. This is the booking bug
      // the concurrency limit was standing in for, and it is the one that
      // actually matters - it survives the change intact.
      /* NO CEILING (Dan 2026-08-27). This carried `.limit(20000)`, and a
         truncated read here is the one failure this block exists to prevent:
         a missing id is a horse that does not look registered, so it gets
         registered into the SAME tournament twice - the bug the comment above
         calls "the one that actually matters". Pages instead, so the guard
         cannot be defeated by a big enough field. */
      const ENTRANT_PAGE = 1000;
      for (let page = 0; ; page++) {
        if (page > 10_000) {
          reportError(
            new Error('[TournamentRecurring] entrant paging did not terminate'),
            'TournamentRecurring.entrant_paging_runaway'
          );
          return 0;
        }
        const { data: alreadyIn, error: entrantErr } = await supabase
          .from('tournament_players')
          .select('user_id, id')
          .eq('tournament_id', tournamentId)
          .in('status', ['registered', 'playing'])
          // The primary key as the tiebreaker (2026-09-01). Ordering by
          // user_id alone assumes one row per player per tournament, which
          // re-entry formats break - and an unstable order under LIMIT/OFFSET
          // drops rows. The comment directly below says an incomplete entrant
          // list lets a double-registration through, which is precisely what a
          // dropped row causes.
          .order('user_id', { ascending: true })
          .order('id', { ascending: true })
          .range(page * ENTRANT_PAGE, page * ENTRANT_PAGE + ENTRANT_PAGE - 1);
        // An incomplete entrant list would let a double-registration through,
        // so a failed page declines the pass rather than guessing.
        if (entrantErr || !alreadyIn) return 0;
        for (const r of alreadyIn) {
          const id = (r as { user_id?: string }).user_id;
          if (id) busyIds.add(id);
        }
        if (alreadyIn.length < ENTRANT_PAGE) break;
      }

      /**
       * Dan 2026-08-19's cash-seat exclusion lived here and is now folded into
       * horseLoadMap, which counts a live seat as one of the four games rather
       * than as a disqualification.
       *
       * The reasoning it was written on still holds and is still honoured:
       * `horse_status` is never flipped when a horse takes a cash seat, so the
       * seat rows are the only truth about where a horse actually is, and
       * registering a horse must never YANK IT OUT of a hand it is playing.
       * It does not: registration adds a future game, it does not vacate a
       * seat. What has changed is only the ceiling - a horse dealing one cash
       * table can now also enter a tournament, where before it could not enter
       * anything at all. At four it is excluded exactly as before.
       */

      /**
       * V22 (2026-08-27, Phase 2) — THE PAGE THAT STARVED THE OVERLAY GUARD.
       *
       * This read `.limit(count + busyIds.size)` with no ORDER BY, then
       * filtered by lane and load AFTERWARD. Postgres returns the same
       * arbitrary rows for the same query, so every 2-minute guard cycle
       * re-examined the same small page — and when that page happened to be
       * cash-lane or at-capacity horses, the guard added NONE, forever, while
       * hundreds of eligible horses sat beyond the limit. Measured cost on
       * 2026-08-27 alone: $8,832 of overlay across 10 events, plus freerolls
       * starting 1/100. The fetch still sizes itself from the busy set (the
       * pickFreeHorsesLimits convention — a constant is a time bomb on a
       * growing fleet), but now carries 4x headroom for the LANE and activity
       * filters the old sizing ignored: the lane hash alone excludes a third
       * of any page, the freeroll activity window up to 60%. Then rotate the
       * pick window by hour so the same horses are not always first in line.
       *
       * V23 (2026-08-30) — the headroom was still a PAGE, and a page with no
       * ORDER BY is a stable arbitrary page: the same physical rows all day,
       * drained by every caller, exactly the starvation pickFreeHorses had.
       * The fleet is ~600 rows; read ALL of it keyset-paged (fetchAllRows,
       * the HorseFleetManager.seedAllTables pattern) and filter in memory.
       * The hourly rotation below still spreads who is first in line.
       */
      const poolPage = await viaTopUpPass(
        pass,
        'horse-pool-available',
        () =>
          fetchAllRows<{
            id: string;
            display_name: string | null;
            username: string | null;
            use_real_name: boolean | null;
          }>(
            (cursor, want) => {
              let q = supabase
                .from('profiles')
                .select('id, display_name, username, use_real_name')
                .eq('is_horse', true)
                .eq('horse_status', 'available')
                .order('id', { ascending: true })
                .limit(want);
              if (cursor) q = q.gt('id', cursor);
              return q;
            },
            { label: 'TournamentRecurring.registerHorses', maxRows: 50_000 }
          ),
        (page) => page.complete
      );
      // Fail closed: an incomplete fleet read is not an empty fleet, and
      // registering from half a pool is how the same page gets drained.
      if (!poolPage.complete) {
        console.warn('[TournamentRecurring] registerHorses skipped: fleet read incomplete');
        return 0;
      }
      const poolAll = poolPage.rows;
      let busyDropped = 0;
      let laneDropped = 0;
      let clubDropped = 0;

      /**
       * A returned satellite ticket is already-paid tournament value. Read one
       * database-owned hint before any lane, bankroll or count filter so the
       * server cannot strand an underrolled/cash-lane ticket horse beyond the
       * candidate window. The hint intentionally includes corrupt candidates:
       * those horses reach the atomic door with wallet authority disabled, and
       * the database refuses them instead of silently charging chips.
       */
      const { data: ticketHintResult, error: ticketHintError } = await supabase.rpc(
        'fn_horse_tournament_entry_ticket_hints',
        { p_tournament_id: tournamentId }
      );
      const ticketHintPayload = ticketHintResult as {
        ok?: boolean;
        holder_ids?: unknown;
        reason?: string;
      } | null;
      if (ticketHintError || ticketHintPayload?.ok !== true) {
        reportError(
          ticketHintError ??
            new Error(
              `[TournamentRecurring] ticket hint refused: ${ticketHintPayload?.reason ?? 'unknown'}`
            ),
          'TournamentRecurring.horse_ticket_hint_failed'
        );
        return 0;
      }
      const ticketHintIds = new Set(
        Array.isArray(ticketHintPayload.holder_ids)
          ? ticketHintPayload.holder_ids.filter(
              (id): id is string => typeof id === 'string' && id.length > 0
            )
          : []
      );

      /**
       * A CLUB'S TOURNAMENTS DRAW FROM THAT CLUB'S MEMBERS (Dan 2026-09-01:
       * "THIS CLUB IS NOT SUPPOSED TO BE ATTACHED TO THE UNION, ITS SUPPOSED
       * TO BE ITS OWN STAND ALONE CLUB").
       *
       * This read selected every is_horse profile on the platform and never
       * looked at the club the tournament belongs to, so ANY horse could be
       * registered into ANY club's event. Measured when a 416-horse population
       * was built for a standalone club: within seven hours it had taken 729
       * seats in another club's tournaments - freerolls and paid events both -
       * without ever being a member there. A standalone club's population
       * wandering into a union's schedule is precisely the isolation this
       * breaks.
       *
       * Membership is the rule a human is already held to: you cannot enter a
       * club's tournament without joining the club. The fleet is now held to
       * the same one.
       *
       * FAILS OPEN on an unreadable membership page, like every other gate in
       * this file: a partial read is not an empty club, and refusing to
       * register on a failed read would silently starve every event on the
       * platform. Verified before shipping that no board is starved by this -
       * Shark holds 584 horse members, JAQK 580, Midway 323, Deep Stack 416.
       */
      const clubMemberIds = await this.clubMemberIdsForTournament(tournamentId, pass);

      const eligible = poolAll.filter((h) => {
        if (busyIds.has(h.id)) {
          busyDropped++;
          return false;
        }
        // Not a member of the club hosting this event: not a candidate.
        if (clubMemberIds && !clubMemberIds.has(h.id)) {
          clubDropped++;
          return false;
        }
        // The ticket is the lane: its value is already committed to this
        // tournament contract and must reach the atomic ticket-first door.
        if (ticketHintIds.has(h.id)) return true;
        // Freeroll override (Dan 2026-08-27): free money is not a lane
        // decision - every horse currently playing enters. Otherwise the
        // 2026-08-26 rule stands: cash-only horses never register for
        // events.
        const ok = allLanes
          ? isActiveNow(h.id, new Date().getUTCHours())
          : gameLaneFor(h.id) !== 'cash';
        if (!ok) laneDropped++;
        return ok;
      });
      /**
       * BANKROLL (Dan 2026-08-31), and the freeroll is the other half of it.
       *
       * `fn_register_horse_for_tournament` refuses on `insufficient_balance`
       * and nothing else, so a horse with 1,000 chips to its name could enter
       * a 950 event and be broke on one hand of it. Solvency is not
       * discipline.
       *
       * The bar is much higher than the cash bar and that is deliberate: an
       * MTT pays nothing to most of the field most of the time, so a roll that
       * comfortably survives 25 cash buy-ins is busted by an ordinary run of
       * 25 tournaments. See `tournamentBuyInsToEnter`.
       *
       * A FREEROLL IS NEVER GATED, and better than that, a broke horse goes
       * to the FRONT of the queue for one. That is the whole recovery loop Dan
       * described - "if they run out of chips, they must play freerolls to
       * earn their chips back, and wait for their weekly rakeback" - and until
       * now nothing anywhere preferred a broke horse for free money; the
       * hourly rotation picked by id, so the horses that most needed a
       * freeroll were no likelier to get one than anybody else.
       *
       * FAILS OPEN, like every other bankroll gate: an unreadable roll, a
       * missing club or an incomplete page leaves the pool exactly as it was.
       * Refusing to register on a failed read would silently starve every
       * event on the platform, which is a far worse failure than one
       * underrolled entry - and is the shape of the bug that emptied the cash
       * floor on 2026-08-31.
       */
      let pool = eligible;
      try {
        const { data: t } = await supabase
          .from('tournaments')
          .select('club_id, union_id, buy_in_amount, buy_in_fee')
          .eq('id', tournamentId)
          .maybeSingle();
        const cost =
          (Number((t as any)?.buy_in_amount) || 0) + (Number((t as any)?.buy_in_fee) || 0);
        const clubId = (t as any)?.club_id as string | undefined;
        const unionId = ((t as any)?.union_id as string | null | undefined) ?? undefined;

        if (clubId && eligible.length > 0) {
          const ids = eligible.map((h) => h.id);
          const rolls = new Map<string, number>();
          /* THE WALLET THE DATABASE DEBITS, NOT THE ROW THE EVENT HANGS OFF
             (2026-09-11). This read `club_members` at `tournaments.club_id`. For
             a union event that is the union's own house row (fade0000...),
             which `atomic_deduct_wallet_and_log` -> `fn_tournament_club_for_user`
             never charges: it resolves one of the horse's MEMBER-club wallets
             (JAQK or SHARK for Midway). So for the 323 horses holding a wallet
             on the house row the gate judged a wallet that is never debited,
             and for the other 261 it read nothing and let them through - the
             same wrong-wallet shape lane A found in the fleet's sit verdict and
             lane B in the rebuy path. Read every wallet the resolver could pick
             (walletClubsForScope mirrors it) and judge the smallest, so the
             verdict holds whichever one the hash lands on; a standalone club
             still reads exactly its own wallet. Chunked, because `ids` is the
             whole eligible fleet and one `.in()` past ~675 ids is an HTTP 400
             that used to read as "no rolls". Fail-open shape unchanged: an
             incomplete read or an unread horse leaves the pool as it was. */
          const walletClubs = await this.walletClubsForScope(clubId, unionId);
          const rollPage =
            walletClubs === null || walletClubs.length === 0
              ? {
                  rows: [] as Array<{ user_id: string; chip_balance: number | null }>,
                  complete: false,
                }
              : await selectInChunks<{ user_id: string; chip_balance: number | null }>(
                  ids,
                  (batch) =>
                    supabase
                      .from('club_members')
                      .select('user_id, club_id, chip_balance')
                      .in('club_id', walletClubs)
                      .in('user_id', batch)
                      .in('status', ['active', 'approved']),
                  'TournamentRecurring.bankrolls'
                );
          if (rollPage.complete) {
            for (const r of rollPage.rows) {
              const v = Number(r.chip_balance);
              if (!Number.isFinite(v)) continue;
              const prev = rolls.get(r.user_id);
              rolls.set(r.user_id, prev === undefined ? v : Math.min(prev, v));
            }

            if (cost > 0) {
              const before = pool.length;
              pool = pool.filter((h) => {
                if (ticketHintIds.has(h.id)) return true;
                const roll = rolls.get(h.id);
                if (roll === undefined) return true; // unread -> fail open
                return canEnterTournament(roll, cost, bankrollPolicyFor(h.id));
              });
              if (pool.length < before) {
                bankrollEvent('tournament_refused_underrolled', before - pool.length);
              }
            } else {
              /* A FREEROLL. Broke horses first - stable within each group, so
                 the hourly rotation below still spreads who leads the queue.

                 "Broke" is measured against the cheapest PAID event actually
                 on the board, not a constant: a hard-coded floor goes stale
                 the day the schedule changes, and the question being asked is
                 exactly "is there a paid game this horse could be playing
                 instead?" If that read fails, nobody is marked broke and the
                 order is simply left alone. */
              const { data: cheapest } = await supabase
                .from('tournaments')
                .select('buy_in_amount, buy_in_fee')
                .eq('club_id', clubId)
                .in('status', ['REGISTERING', 'SCHEDULED'])
                .order('buy_in_amount', { ascending: true })
                .limit(50);
              const paid = (cheapest ?? [])
                .map((r: any) => (Number(r.buy_in_amount) || 0) + (Number(r.buy_in_fee) || 0))
                .filter((c: number) => c > 0);
              const floor = paid.length > 0 ? Math.min(...paid) : 0;
              const broke = (id: string) => {
                if (!(floor > 0)) return false;
                const roll = rolls.get(id);
                return (
                  roll !== undefined && !canEnterTournament(roll, floor, bankrollPolicyFor(id))
                );
              };
              const needy = pool.filter((h) => broke(h.id));
              if (needy.length > 0) {
                bankrollEvent('freeroll_entered_broke', Math.min(needy.length, count));
                pool = needy.concat(pool.filter((h) => !broke(h.id)));
              }
            }
          }
        }
      } catch (err) {
        reportError(err, 'TournamentRecurring.bankroll_gate');
      }

      // Ticket holders first. Slicing the ordinary rotated pool before this
      // partition was the count-truncation half of the stranding bug.
      const ticketPool = pool.filter((horse) => ticketHintIds.has(horse.id));
      const walletPool = pool.filter((horse) => !ticketHintIds.has(horse.id));
      /* THE QUEUE ROTATES PER EVENT, NOT ONLY PER HOUR (2026-09-11). This was
         the hour times 7919, modulo the pool, so every tournament ramped in the same
         hour started its queue at the SAME horse, and a weekly programme
         publishing thirty events at once put the first few horses in the pool
         into all thirty. Measured live: one DSS horse carried 41 open bookings,
         34 of them registered between 00:00 and 01:00 UTC into 28 different
         events; 27 horses carried nine or more. Every booking is a real buy-in
         out of one wallet. The event id folds into the rotation so two events
         ramped in the same tick start their queues in different places; the
         hour still moves everybody along, and the hourly spread the old note
         describes is kept. */
      const hour = new Date().getUTCHours();
      const ticketRot = rampQueueRotation(tournamentId, hour, ticketPool.length);
      const walletRot = rampQueueRotation(tournamentId, hour, walletPool.length);
      const orderedTickets = ticketPool.slice(ticketRot).concat(ticketPool.slice(0, ticketRot));
      const orderedWallets = walletPool.slice(walletRot).concat(walletPool.slice(0, walletRot));
      const horses = orderedTickets.concat(orderedWallets).slice(0, count);

      if (!horses || horses.length === 0) {
        // Say WHY the pool came up empty — "added NONE" with no numbers is
        // how this starved silently for a day.
        /* clubDropped was counted here and never printed, so the single
           largest exclusion was invisible: the line read "fleet 1000,
           at-capacity 215, lane 108" and left the reader to conclude the other
           677 simply did not exist. Print every bucket - the numbers only help
           if they add up. */
        console.warn(
          `[TournamentRecurring] registerHorses found no candidates: fleet ${poolAll.length}, ` +
            `at-capacity/entered ${busyDropped}, not-a-club-member ${clubDropped}, ` +
            `lane/window-excluded ${laneDropped}`
        );
        return 0;
      }

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
       * fn_register_horse_for_tournament is the single service-role horse entry
       * authority. It spends an exact returned ticket first; only an
       * authoritative no-ticket result may reach the wallet core. Both paths
       * use the same entry split, rake evidence and pool updates, so rake is
       * real and the prize pool is funded by actual entries.
       */
      let registered = 0;
      const failures = new Map<string, number>();
      for (const horse of horses) {
        // THE FREEZE IS TOTAL (Dan 2026-09-03): a registration is a buy-in. A ramp
        // that crosses :53 stops here and the next tick finishes it.
        if (isMaintenanceFrozen()) break;
        const { data: res, error: regError } = await supabase.rpc(
          'fn_register_horse_for_tournament',
          {
            p_tournament_id: tournamentId,
            p_user_id: horse.id,
            // A hinted ticket that disappears between the read and this RPC
            // must not become a wallet charge. A newly-issued ticket is still
            // consumed first by the database even when this is true.
            p_allow_wallet_charge: !ticketHintIds.has(horse.id),
          }
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
          `[TournamentRecurring] Horse registration: ${registered} seated, skipped - ${summary}`
        );
      }

      return registered;
    } catch {
      return 0;
    }
  }

  // rollSpinMultiplier — the local CSPRNG weighted draw (engine audit A8) —
  // is deleted. It was the RPC-unreachable fallback for a draw this service
  // no longer performs: the draw now happens once, at start, inside
  // TournamentManagerBase, and ITS fallback resolves DOWN to the smallest
  // tier rather than rolling locally. A creation-time local roll was the
  // last code path that could pick a multiplier without asking the reserve.
}
