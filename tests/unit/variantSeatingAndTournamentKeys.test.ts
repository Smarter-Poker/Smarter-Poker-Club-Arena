/**
 * Two stale lookup tables, found by auditing the fixed-limit work line by line.
 *
 * BOTH are the same mistake: a variant fact decided by guessing at the spelling
 * of the variant string, with a silent fallback underneath. The engine had five
 * copies of it (see server/src/engine/VariantRules.ts); these are the sixth and
 * seventh, on the client.
 *
 *  1. `holeCardsForVariant` tested `startsWith('plo6' | 'plo5' | 'plo')` and
 *     returned 2 underneath. `flo8` — Fixed Limit Omaha Hi-Lo — starts with
 *     none of them, so a FOUR-card game reported two hole cards and
 *     `remainderAfterDeal` overstated the deck by 18 cards at a full table.
 *     Its seat cap was also missing, so a nine-seat FLO8 table was creatable
 *     where a nine-seat PLO8 (the identical four-card deal) was not.
 *
 *  2. `TOURNAMENT_GAME_VARIANTS` was keyed `plo` and `shortdeck`. The
 *     create-table screen has only ever emitted `plo4` and `short_deck`, so
 *     nothing matched and the SNG/MTT tabs were hidden on every game except
 *     Hold'em — while production was already running 3,100 PLO4, 1,548 PLO5,
 *     945 PLO6, 41 PLO8 and a Short Deck tournament through the recurring
 *     service. The platform ran the games; only this screen could not make one.
 */
import { describe, it, expect } from 'vitest';
import {
  holeCardsForVariant,
  maxSeatsForVariant,
  remainderAfterDeal,
  canRunItNTimes,
  maxSeatsTheDeckAllows,
  DEFAULT_MAX_SEATS,
} from '../../src/config/tableSeating';
import { canRunAsTournament, buildTournamentConfig } from '../../src/lib/tournamentFromTableConfig';
// The server's own copy of the deck arithmetic. The two modules cannot share a
// file (server/tsconfig.json sets rootDir './src'), but the root vitest config
// can import both — it already aliases @error-reporting/node so client suites can reach
// server services — so the two copies can at least be pinned against each
// other here instead of being trusted to agree.
import { maxSeatsFor as serverMaxSeatsTheDeckAllows } from '../../server/src/engine/VariantRules';

describe('1. hole cards are looked up, not guessed from the spelling', () => {
  it('gives flo8 four cards like every other Omaha', () => {
    expect(holeCardsForVariant('flo8')).toBe(4);
    expect(holeCardsForVariant('flo8')).toBe(holeCardsForVariant('plo8'));
  });

  it('still gives each pot-limit Omaha its own count', () => {
    expect(holeCardsForVariant('plo4')).toBe(4);
    expect(holeCardsForVariant('plo5')).toBe(5);
    expect(holeCardsForVariant('plo6')).toBe(6);
    expect(holeCardsForVariant('plo8')).toBe(4);
  });

  it("gives both Hold'ems two — limit changes the betting, not the deal", () => {
    expect(holeCardsForVariant('nlh')).toBe(2);
    expect(holeCardsForVariant('flh')).toBe(2);
    expect(holeCardsForVariant('short_deck')).toBe(2);
  });

  it('gives Pineapple three', () => {
    expect(holeCardsForVariant('pineapple')).toBe(3);
  });

  it('is case-insensitive and safe on the unknown', () => {
    expect(holeCardsForVariant('FLO8')).toBe(4);
    expect(holeCardsForVariant('a_variant_from_next_year')).toBe(2);
    expect(holeCardsForVariant(null)).toBe(2);
    expect(holeCardsForVariant(undefined)).toBe(2);
  });

  it('no longer overstates the deck for flo8', () => {
    // The bug: 52 - 2*9 = 34 cards "left" at a nine-handed table.
    expect(remainderAfterDeal('flo8', 9)).toBe(52 - 4 * 9);
    expect(remainderAfterDeal('flo8', 9)).toBe(remainderAfterDeal('plo8', 9));
  });

  it('never claims a deal that does not fit the deck', () => {
    for (const v of [
      'nlh',
      'flh',
      'short_deck',
      'pineapple',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flo8',
    ]) {
      expect(remainderAfterDeal(v, maxSeatsForVariant(v))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('1b. the seat cap treats flo8 as the four-card game it is', () => {
  it('caps flo8 exactly where plo8 is capped', () => {
    expect(maxSeatsForVariant('flo8')).toBe(8);
    expect(maxSeatsForVariant('flo8')).toBe(maxSeatsForVariant('plo8'));
  });

  it("leaves the Hold'ems at the full ring", () => {
    expect(maxSeatsForVariant('flh')).toBe(DEFAULT_MAX_SEATS);
    expect(maxSeatsForVariant('nlh')).toBe(DEFAULT_MAX_SEATS);
  });

  it('leaves room to run it three times at the cap', () => {
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'nlh', 'flh']) {
      expect(canRunItNTimes(v, maxSeatsForVariant(v), 3)).toBe(true);
    }
  });
});

describe('2. the tournament map is keyed on what the screen actually emits', () => {
  it('offers SNG/MTT for every variant the engine already runs in production', () => {
    for (const id of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck']) {
      expect(canRunAsTournament(id)).toBe(true);
    }
  });

  it('offers SNG/MTT for the limit games too', () => {
    /* 2026-08-31: these two were pinned FALSE here, on the reasoning that limit
       "raises on a bet-size ladder and every blind structure here is a no-limit
       blind ladder". The engine disagrees — `fixedLimitBetSize` derives the bet
       ladder from the big blind and the tournament engine rewrites the table's
       blinds every level, so the ladder escalates the limits exactly. Reversed
       deliberately, in the commit that made limit tournaments creatable. */
    for (const id of ['flh', 'flo8']) {
      expect(canRunAsTournament(id)).toBe(true);
    }
  });

  it('still refuses the one the tournament engine has no path for', () => {
    // Pineapple has no discard timing path and no PINEAPPLE tournament has ever
    // been played.
    expect(canRunAsTournament('pineapple')).toBe(false);
  });

  it('does not answer true for the dead keys it used to be written with', () => {
    // If someone re-adds `plo:` or `shortdeck:` the real ids stop being the
    // only spelling and the bug can come back quietly.
    expect(canRunAsTournament('plo')).toBe(false);
    expect(canRunAsTournament('shortdeck')).toBe(false);
  });
});

describe('2b. a tournament is bound by the DECK, never by the cash seat cap', () => {
  const form = (over: Record<string, unknown> = {}) =>
    ({
      name: 'T',
      gameMode: 'mtt',
      buyIn: 10,
      startingChips: 5000,
      blindStructure: 'turbo',
      blindsUpMinutes: 5,
      payoutStructure: 'standard',
      sngPlayerCount: 9,
      isSpins: false,
      minPlayers: 2,
      maxPlayersRange: 100,
      numberOfRebuysReentries: 0,
      tableSize: 10,
      actionTimeSeconds: 15,
      ...over,
    }) as never;

  it('clamps a ten-handed PLO6 request to what six cards a seat physically allow', () => {
    const cfg = buildTournamentConfig(form(), 'plo6');
    expect(cfg.tableSize).toBe(maxSeatsTheDeckAllows('plo6'));
    expect(cfg.tableSize).toBe(7);
  });

  it('does NOT apply the cash seat cap — tournaments are exempt from it', () => {
    // tableSeating's header: applying the cash law here "would shrink 9-handed
    // MTT tables and turn 3-max Spin & Gos into 8-max". plo4 is 8-max for cash
    // and may still seat 10 in a tournament; Hold'em keeps its full 10.
    expect(maxSeatsForVariant('plo4')).toBe(8);
    expect(buildTournamentConfig(form(), 'plo4').tableSize).toBe(10);
    expect(buildTournamentConfig(form(), 'nlh').tableSize).toBe(10);
  });

  it('leaves a 3-max Spin at 3 rather than inflating it', () => {
    expect(buildTournamentConfig(form({ tableSize: 3 }), 'nlh').tableSize).toBe(3);
  });

  it('never returns a table size the deck cannot deal', () => {
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck']) {
      const cfg = buildTournamentConfig(form(), v);
      expect(remainderAfterDeal(v, cfg.tableSize as number)).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('2c. the client and the server agree on what the deck allows', () => {
  /**
   * 2026-08-31. `maxSeatsTheDeckAllows` (client) and `maxSeatsFor` (server) are
   * the same formula, floor((deck - 5) / holeCards), written twice because the
   * browser bundle cannot import from server/. Until today the SERVER path did
   * not use its copy at all: both tournament managers reached for
   * `clampSeatsForVariant`, the CASH seat law, whose own header says it may
   * never be applied to a table with a tournament_id. That is exactly the shape
   * of bug a parity test catches, and there was no parity test.
   *
   * `scripts/ci/check-seat-law-parity.mjs` pins the CASH law across the two
   * config modules. This pins the DECK ceiling across the two engines.
   */
  it('returns the same seat ceiling for every variant either side knows', () => {
    for (const v of [
      'nlh',
      'flh',
      'short_deck',
      'pineapple',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flo8',
    ]) {
      expect(serverMaxSeatsTheDeckAllows(v), v).toBe(maxSeatsTheDeckAllows(v));
    }
  });

  it('agrees on the numbers a tournament is actually sized by', () => {
    expect(maxSeatsTheDeckAllows('plo6')).toBe(7);
    expect(maxSeatsTheDeckAllows('plo5')).toBe(9);
    expect(maxSeatsTheDeckAllows('plo4')).toBe(11);
    expect(maxSeatsTheDeckAllows('nlh')).toBe(23);
    expect(maxSeatsTheDeckAllows('short_deck')).toBe(15);
  });

  it('is looser than the cash cap everywhere, which is why tournaments use it', () => {
    for (const v of ['nlh', 'flh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'short_deck']) {
      expect(maxSeatsTheDeckAllows(v), v).toBeGreaterThanOrEqual(maxSeatsForVariant(v));
    }
  });
});
