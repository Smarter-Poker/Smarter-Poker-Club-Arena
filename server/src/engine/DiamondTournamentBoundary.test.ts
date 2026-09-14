import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertDiamondCashTable,
  assertDiamondTable,
  assertDiamondTournamentTable,
  DIAMOND_CASH_VARIANTS,
} from '../domain/DiamondCashBoundary.js';
import { loadTable } from '../services/supabase/tables.js';
import { supabase } from '../services/supabase/client.js';
import { HandController } from './HandController.js';

/**
 * A DIAMOND TOURNAMENT TABLE IS A TOURNAMENT TABLE (Phase 8, 2026-09-14).
 *
 * The row the tournament manager writes: a tournament id, game_type
 * 'tournament', the level's blinds and ante, no seat for sale, and the chip
 * schedule's column defaults for rake and the jackpot (which every tournament
 * hand ignores). The cash boundary refuses this row on purpose; the
 * tournament boundary admits it and holds it to the tournament shape.
 */
const diamond = { id: 'arena', asset: 'diamonds', kind: 'diamond_arena' } as const;
const tournamentTable = {
  id: 'table',
  club_id: 'arena',
  union_id: null,
  arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  game_type: 'tournament',
  game_variant: 'nlh',
  tournament_id: 'event',
  cluster_id: null,
  status: 'running',
  small_blind: 50,
  big_blind: 100,
  ante: 0,
  min_buy_in: 0,
  max_buy_in: 0,
  rake_percent: -1,
  rake_cap_bb: -1,
  bbj_percent: 100,
  run_it_twice: true,
  allow_run_it_twice: true,
  insurance_enabled: false,
  all_in_or_fold: false,
};

afterEach(() => vi.restoreAllMocks());

describe('the Diamond tournament table boundary', () => {
  it('admits the row the tournament manager writes, and the cash boundary does not', () => {
    expect(() => assertDiamondTournamentTable(tournamentTable)).not.toThrow();
    expect(() => assertDiamondTable(tournamentTable)).not.toThrow();
    expect(() => assertDiamondCashTable(tournamentTable)).toThrow(
      'Diamond Plain Cash Table Required'
    );
  });

  it('deals every game this arena deals, in tournament form', () => {
    for (const game_variant of DIAMOND_CASH_VARIANTS)
      expect(() =>
        assertDiamondTournamentTable({ ...tournamentTable, game_variant })
      ).not.toThrow();
    for (const game_variant of ['stud', 'razz', 'NLH', '', null])
      expect(() => assertDiamondTournamentTable({ ...tournamentTable, game_variant })).toThrow(
        'Diamond Tournament Table Required'
      );
  });

  it('must say it is a tournament table, both ways', () => {
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, tournament_id: null })).toThrow(
      'Diamond Tournament Table Required'
    );
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, game_type: 'cash' })).toThrow(
      'Diamond Tournament Table Required'
    );
    /* A cash row that happens to carry a tournament id is not a cash table
       either: the one door sends it to the tournament boundary, which refuses
       it for lacking the tournament game type. */
    expect(() => assertDiamondTable({ ...tournamentTable, game_type: 'cash' })).toThrow(
      'Diamond Tournament Table Required'
    );
  });

  it('refuses the chip-schedule features and a union scope exactly as the cash boundary does', () => {
    for (const change of [
      { union_id: 'u' },
      { status: 'closed' },
      { is_template: true },
      { insurance_enabled: true },
      { seven_deuce_enabled: true },
      { nit_game: true },
      { pineapple_holdem: true },
      { cap_enabled: true },
      { bomb_pot_enabled: true },
    ])
      expect(
        () => assertDiamondTournamentTable({ ...tournamentTable, ...change }),
        JSON.stringify(change)
      ).toThrow('Diamond Tournament Table Required');
  });

  it('keeps the blinds and the ante whole, and sells no seat', () => {
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, small_blind: 0.5 })).toThrow(
      'Diamond Tournaments Require Whole Positive Blinds'
    );
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, big_blind: 0 })).toThrow(
      'Diamond Tournaments Require Whole Positive Blinds'
    );
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, ante: 1.5 })).toThrow(
      'Diamond Tournaments Require A Whole Ante'
    );
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, ante: 25 })).not.toThrow();
    expect(() => assertDiamondTournamentTable({ ...tournamentTable, max_buy_in: 200 })).toThrow(
      'A Diamond Tournament Table Sells No Seat'
    );
  });

  it('loads a Diamond tournament table only while the tournament switch is on', async () => {
    let tournamentsEnabled = false;
    let settingsError: unknown = null;
    const from = vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
      const chain: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.maybeSingle.mockImplementation(async () =>
        name === 'tables'
          ? { data: tournamentTable, error: null }
          : {
              /* The cash switch is ON and must not open a tournament table. */
              data: {
                club_id: 'arena',
                cash_games_enabled: true,
                tournaments_enabled: tournamentsEnabled,
              },
              error: settingsError,
            }
      );
      return chain;
    }) as any);
    await expect(loadTable('table')).rejects.toThrow('Diamond Tournaments Are Not Open');
    tournamentsEnabled = true;
    await expect(loadTable('table')).resolves.toMatchObject({
      arena: diamond,
      tournament_id: 'event',
    });
    settingsError = { message: 'unavailable' };
    await expect(loadTable('table')).rejects.toThrow('Diamond Tournaments Are Not Open');
    expect(from.mock.calls.filter(([name]) => name === 'ca_arena_settings')).toHaveLength(3);
  });

  it('deals a Diamond tournament hand under the same no-deduction rule as a cash hand', () => {
    const players = [
      { user_id: 'a', seat_number: 1, stack: 10000, username: 'a' },
      { user_id: 'b', seat_number: 2, stack: 10000, username: 'b' },
    ] as any;
    const config = {
      tableId: 'table',
      asset: 'diamonds',
      isTournament: true,
      gameVariant: 'nlh',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      actionTimeSeconds: 15,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bbjConfig: { enabled: false, feeBB: 0, minPotBB: 0, minPlayersDealt: 0 },
      insuranceEnabled: false,
    } as any;
    expect(() => new HandController(config, players, 1)).not.toThrow();
    /* The deductions a tournament hand never carries are still refused if a
       row ever said otherwise. */
    expect(
      () =>
        new HandController(
          { ...config, rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true } },
          players,
          1
        )
    ).toThrow('Diamond Certification Requires A Supported Game With No Deductions');
    expect(() => new HandController({ ...config, insuranceEnabled: true }, players, 1)).toThrow(
      'Diamond Certification Requires A Supported Game With No Deductions'
    );
    /* And a tournament stack, like every Diamond amount, is whole. */
    expect(
      () => new HandController(config, [{ ...players[0], stack: 100.5 }, players[1]], 1)
    ).toThrow('Diamond Hands Require Nonnegative Whole Units');
  });
});
