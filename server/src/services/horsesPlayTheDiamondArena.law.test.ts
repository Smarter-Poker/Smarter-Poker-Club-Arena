/**
 * HORSES PLAY THE DIAMOND ARENA (Dan, 2026-10-06, BINDING)
 *
 * "CREATE THE SAME FUNCTIONALITY FOR THE HORSES INSIDE THE CLUB ARENA, TO PLAY
 * IN THE DIAMOND ARENA ... ASSIGN ALL THE HORSES THAT WERE INSIDE OF DEEP
 * STACK SOCIETY TO PLAY IN THE DIAMOND ARENA NOW." And the same day: cash
 * games do not start before the engine fix is proven.
 *
 * What this law pins:
 *   1. The arena is seated by the SAME cycle, filter, verdict and door as the
 *      chip floor (10.5) - never by a parallel seeder.
 *   2. It is LATENT while the arena is closed: no arena table enters the cycle
 *      unless `cash_games_enabled` reads exactly true, and nothing here writes
 *      the switch.
 *   3. The arena's tables never reach a chip-floor planner (feeders,
 *      `fn_cash_game_ensure`, host caps, band supply, the seat-call answerer).
 *   4. The wallet is the horse's own Diamonds, in whole Diamonds, through the
 *      arena's idempotent door - never a treasury, never a fraction.
 *   5. A horse that busts at a Diamond table is released exactly as a person
 *      is, instead of holding a zero-stack chair for ever.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DIAMOND_ARENA_HORSE_CLUBS,
  diamondArenaIdFrom,
  isDiamondArenaCashTable,
  isDiamondTableRow,
  wholeDiamondBuyIn,
} from './HorseFleetFundingBoundary.js';
import { DSS_CLUB_ID } from './StableHand.js';
import { classifyBuyInRefusal } from './HorseBuyInRefusal.js';
import { exposureFor } from './HorseSitVerdict.js';

const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const arenaJoin = { id: ARENA, asset: 'diamonds', is_platform: true, union_id: null };
const arenaTable = {
  club_id: ARENA,
  union_id: null,
  arena: arenaJoin,
  cluster_id: null,
  lifecycle: null,
};

const FLEET = readFileSync('src/services/HorseFleetManager.ts', 'utf8');
const SEED = FLEET.slice(
  FLEET.indexOf('private async seedAllTables('),
  FLEET.indexOf('private buildFleetStateRows(')
);
const DEALING = readFileSync('src/engine/ServerTableEngineDealing.ts', 'utf8');
const ROTATOR = readFileSync('src/services/HorseSessionRotator.ts', 'utf8');

describe('who plays the arena', () => {
  it('is Deep Stack Society, as Dan named it', () => {
    expect(DIAMOND_ARENA_HORSE_CLUBS).toEqual([DSS_CLUB_ID]);
  });
});

describe('the arena is latent while it is closed', () => {
  it('only an explicit TRUE switch with a club id opens it; everything else is closed', () => {
    expect(diamondArenaIdFrom({ club_id: ARENA, cash_games_enabled: true })).toBe(ARENA);
    expect(diamondArenaIdFrom({ club_id: ARENA, cash_games_enabled: false })).toBeNull();
    expect(diamondArenaIdFrom({ club_id: ARENA, cash_games_enabled: null })).toBeNull();
    expect(diamondArenaIdFrom({ club_id: ARENA, cash_games_enabled: 'true' })).toBeNull();
    expect(diamondArenaIdFrom({ club_id: null, cash_games_enabled: true })).toBeNull();
    expect(diamondArenaIdFrom(null)).toBeNull();
    expect(diamondArenaIdFrom(undefined)).toBeNull();
    expect(
      diamondArenaIdFrom({ club_id: ARENA, cash_games_enabled: true }, new Error('down'))
    ).toBeNull();
  });

  it('the cycle reads the switch and filters the arena tables from it, and never writes it', () => {
    expect(SEED).toContain(".from('ca_arena_settings')");
    expect(SEED).toContain('diamondArenaId = diamondArenaIdFrom(arenaRow, arenaErr);');
    expect(SEED).toMatch(
      /let diamondTables = diamondArenaId\s*\?\s*tablePage\.rows\.filter\(\(t\) => isDiamondArenaCashTable\(t, diamondArenaId\)\)\s*:\s*\[\];/
    );
    expect(FLEET).not.toMatch(/ca_arena_settings[\s\S]{0,200}\.(update|upsert|insert)\(/);
  });
});

describe('which tables are arena cash tables', () => {
  it('a plain table of the OPEN arena only', () => {
    expect(isDiamondArenaCashTable(arenaTable, ARENA)).toBe(true);
    expect(isDiamondArenaCashTable(arenaTable, null)).toBe(false);
    expect(isDiamondArenaCashTable(arenaTable, 'another-arena')).toBe(false);
    expect(isDiamondArenaCashTable({ ...arenaTable, cluster_id: 'c1' }, ARENA)).toBe(false);
    expect(isDiamondArenaCashTable({ ...arenaTable, lifecycle: 'opening' }, ARENA)).toBe(false);
    const chip = {
      club_id: DSS_CLUB_ID,
      union_id: null,
      arena: { id: DSS_CLUB_ID, asset: 'chips', is_platform: false },
    };
    expect(isDiamondArenaCashTable(chip, ARENA)).toBe(false);
    expect(isDiamondArenaCashTable({ club_id: ARENA }, ARENA)).toBe(false);
  });

  it('isDiamondTableRow reads the asset from the arena join', () => {
    expect(isDiamondTableRow(arenaTable)).toBe(true);
    expect(
      isDiamondTableRow({
        club_id: DSS_CLUB_ID,
        arena: { id: DSS_CLUB_ID, asset: 'chips', is_platform: false },
      })
    ).toBe(false);
    expect(isDiamondTableRow({ club_id: ARENA })).toBe(false);
  });
});

describe('the arena never reaches a chip-floor planner', () => {
  it('the chip table list is unchanged and the arena joins only the seeding walk', () => {
    expect(SEED).toContain('const tables = tablePage.rows.filter(isChipFleetTable);');
    expect(SEED).toContain('const orderedTables = [...tables, ...diamondTables].sort(');
    // every chip-floor planner is handed `tables`, never the arena list
    expect(SEED).toMatch(/this\.claimOfferedSeats\(\s*tables,/);
    expect(SEED).not.toMatch(/claimOfferedSeats\(\s*\[\.\.\.tables, \.\.\.diamondTables\]/);
    expect(FLEET).not.toMatch(/openPlannedTables\([^)]*diamondTables/);
    expect(FLEET).not.toMatch(/fn_cash_game_ensure[\s\S]{0,400}diamondTables/);
  });
});

describe('the arena wallet is the horses own Diamonds', () => {
  it('is derived only for horses of the named clubs, from profiles.diamonds, and fails closed', () => {
    const block = SEED.slice(SEED.indexOf('THE ARENA WALLET'), SEED.indexOf('THE DOOR RULES'));
    expect(block).toContain(".from('profiles')");
    expect(block).toContain(".select('id, diamonds')");
    expect(block).toContain('DIAMOND_ARENA_HORSE_CLUBS.some((c) => clubs.has(c))');
    expect(block).toContain('bankrolls.set(`${arena}:${r.id}`, Math.floor(d));');
    // an unread roll empties the arena for the cycle rather than seating blind
    expect(block).toMatch(/if \(!diamondRollsLoaded\) \{[\s\S]*diamondTables = \[\];/);
    // nothing in the arena path funds a horse
    expect(block).not.toMatch(/treasury|fn_horse_fund|fn_ca_mint/);
  });

  it('a buy-in is whole Diamonds, floored, and none under the minimum', () => {
    expect(wholeDiamondBuyIn(545.07, 400)).toBe(545);
    expect(wholeDiamondBuyIn(400, 400)).toBe(400);
    expect(wholeDiamondBuyIn(399.99, 400)).toBe(0);
    expect(wholeDiamondBuyIn(0, 40)).toBe(0);
    expect(wholeDiamondBuyIn(Number.NaN, 40)).toBe(0);
  });

  it('the sizing floors a Diamond buy-in before the rejoin floor, which still comes last', () => {
    const compute = FLEET.slice(
      FLEET.indexOf('private computeHorseBuyIn('),
      FLEET.indexOf('private async seatHorse(')
    );
    expect(compute).toMatch(
      /if \(isDiamondTableRow\(table\)\) \{\s*const whole = wholeDiamondBuyIn\(buyIn, minB\);/
    );
    expect(compute).toContain('return applyRejoinFloor(buyIn, rejoinFloor, maxB);');
  });

  it('an arena seat sends a fresh idempotency key, and a chip seat sends exactly what it did', () => {
    const seat = FLEET.slice(FLEET.indexOf('private async seatHorse('));
    const keys = seat.match(/p_idempotency_key/g) ?? [];
    expect(keys.length).toBe(2);
    expect(seat).toContain('...(opts?.diamond ? { p_idempotency_key: randomUUID() } : {}),');
    expect(SEED).toContain('{ diamond: arenaTable }');
  });

  it('Diamond exposure is its own map and never summed into the chip one', () => {
    const chips = new Map([['h', 500]]);
    const diamonds = new Map([['h', 2000]]);
    const ctx = { horseExposure: chips, diamondExposure: diamonds, diamondArenaId: ARENA };
    expect(exposureFor(ctx, ARENA).get('h')).toBe(2000);
    expect(exposureFor(ctx, DSS_CLUB_ID).get('h')).toBe(500);
    expect(exposureFor({ horseExposure: chips }, ARENA).get('h')).toBe(500);
    expect(exposureFor({ ...ctx, diamondArenaId: null }, ARENA).get('h')).toBe(500);
  });

  it('the arena door says its ordinary refusals in words the cycle can count', () => {
    expect(classifyBuyInRefusal('diamond_cash_not_open')).toBe('diamond_closed');
    expect(classifyBuyInRefusal('insufficient_settled_diamonds')).toBe('no_diamonds');
    expect(classifyBuyInRefusal('Diamond seat or player is already seated')).toBe('already_seated');
    expect(classifyBuyInRefusal('SEAT_RESERVED: table capacity is taken or held')).toBe(
      'seat_reserved'
    );
    // a defect in this file is not an ordinary refusal and stays reported
    expect(classifyBuyInRefusal('invalid_diamond_cash_purchase')).toBe('refused');
  });
});

describe('a horse that busts at a Diamond table is released like a person', () => {
  it('the stand-up includes horses at a Diamond cash table', () => {
    const fn = DEALING.slice(
      DEALING.indexOf('protected async standUpBustedCashPlayers('),
      DEALING.indexOf('protected async recoverBustedSeatedHorses(')
    );
    expect(fn).toContain("const diamondCash = this.tableInfo?.arena?.asset === 'diamonds';");
    // the behaviour itself is proven by aBustedHorseAtADiamondTableIsReleased.test.ts;
    // this pins only that the filter consults the Diamond flag
    expect(fn).toMatch(/\|\| diamondCash\)/);
  });
});

describe('the rotator never reloads a seat whose roll it could not read', () => {
  it('reads a Diamond seat roll and refuses the reload on an unread roll', () => {
    expect(ROTATOR).toContain("'HorseSessionRotator.diamondRolls'");
    expect(ROTATOR).toMatch(/if \(roll === undefined\) amount = 0;/);
  });
});
