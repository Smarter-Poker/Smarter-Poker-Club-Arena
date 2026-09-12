import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertDiamondAcceptedHand,
  assertDiamondCashTable,
} from '../domain/DiamondCashBoundary.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { loadTable } from '../services/supabase/tables.js';
import { supabase } from '../services/supabase/client.js';

const diamond = { id: 'arena', asset: 'diamonds', kind: 'diamond_arena' } as const;
const table = {
  id: 'table',
  club_id: 'arena',
  union_id: null,
  arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
  game_variant: 'nlh',
  tournament_id: null,
  cluster_id: null,
  status: 'waiting',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 20,
  max_buy_in: 200,
  ante: 0,
  /* Every deduction EXPLICITLY zero and every default-on feature EXPLICITLY
     false. This fixture used to omit the last three, which is precisely how
     the admit-then-refuse-every-hand gap survived: unset reads as zero here
     and as "inherit the chip schedule" in the engine. */
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  run_it_twice: false,
  allow_run_it_twice: false,
};
const hand = {
  arena: diamond,
  verifiedLease: true,
  variant: 'nlh',
  rake: 0,
  bbj: 0,
  inflow: 0,
  insuranceCount: 0,
  amounts: [0, 1, 2, 200],
};
afterEach(() => vi.restoreAllMocks());

describe('the first Diamond game stays inside the custody boundary', () => {
  it('admits plain integer NLH and rejects optional money paths', () => {
    expect(() => assertDiamondCashTable(table)).not.toThrow();
    expect(() => assertDiamondCashTable({ ...table, status: 'running' })).not.toThrow();
    for (const change of [
      { game_variant: 'plo4' },
      { tournament_id: 't' },
      { cluster_id: 'c' },
      { status: 'closed' },
      { rake_percent: 1 },
      { bbj_percent: 1 },
      { is_template: true },
      { insurance_enabled: true },
      { bomb_pot_enabled: true },
      { run_it_twice: true },
      { straddle_enabled: true },
      { auto_utg_straddle: true },
      { seven_deuce_enabled: true },
      { nit_game: true },
      { all_in_or_fold: true },
      { pineapple_holdem: true },
      { cap_enabled: true },
      { rake_cap_bb: 1 },
      { allow_run_it_twice: true },
      { small_blind: 0.5 },
      { min_buy_in: 0 },
      { max_buy_in: Infinity },
      { ante: 0.5 },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).toThrow();
  });

  /* UNSET IS NOT OFF. The engine's default for each of these columns is the
     chip club's, and the chip club's default is ON: an unset rake cap inherits
     the published schedule cap, an unset bbj_percent reads as 100, and unset
     run-it columns read as true. A table admitted with any of them missing is
     then refused by HandController on every hand, so it seats players and
     never deals. Each column is named individually because each one has its
     own default in a different file. */
  it('refuses a table that leaves a chip default unset rather than off', () => {
    for (const key of ['rake_cap_bb', 'bbj_percent', 'rake_percent'] as const) {
      const missing: Record<string, unknown> = { ...table };
      delete missing[key];
      expect(() => assertDiamondCashTable(missing), `${key} unset was admitted`).toThrow(
        'Diamond Plain Cash Table Required'
      );
      expect(() => assertDiamondCashTable({ ...table, [key]: null })).toThrow();
    }
    for (const key of ['run_it_twice', 'allow_run_it_twice'] as const) {
      const missing: Record<string, unknown> = { ...table };
      delete missing[key];
      expect(() => assertDiamondCashTable(missing), `${key} unset was admitted`).toThrow(
        'Diamond Plain Cash Table Required'
      );
      expect(() => assertDiamondCashTable({ ...table, [key]: null })).toThrow();
    }
  });

  it('requires protocol 2 and refuses unsupported accepted facts before any writer', () => {
    expect(() => assertDiamondAcceptedHand(hand)).not.toThrow();
    for (const change of [
      { verifiedLease: false },
      { variant: 'plo4' },
      { rake: 1 },
      { bbj: 1 },
      { inflow: 1 },
      { insuranceCount: 1 },
      { amounts: [1.5] },
      { amounts: [-1] },
      { amounts: [NaN] },
    ])
      expect(() => assertDiamondAcceptedHand({ ...hand, ...change })).toThrow(
        /atomic hand commit refused/
      );
    expect(() =>
      assertDiamondAcceptedHand({
        ...hand,
        arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
        verifiedLease: false,
        amounts: [0.25],
        rake: 0.1,
      })
    ).not.toThrow();
  });

  it('checks the authoritative release switch on every Diamond table load', async () => {
    let enabled = false;
    let settingsError: unknown = null;
    const from = vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
      const chain: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.maybeSingle.mockImplementation(async () =>
        name === 'tables'
          ? { data: table, error: null }
          : { data: { club_id: 'arena', cash_games_enabled: enabled }, error: settingsError }
      );
      return chain;
    }) as any);
    await expect(loadTable('table')).rejects.toThrow('Diamond Cash Games Are Not Open');
    enabled = true;
    await expect(loadTable('table')).resolves.toMatchObject({ arena: diamond });
    settingsError = { message: 'unavailable' };
    await expect(loadTable('table')).rejects.toThrow('Diamond Cash Games Are Not Open');
    expect(from.mock.calls.filter(([name]) => name === 'ca_arena_settings')).toHaveLength(3);
  });

  it('keeps chip table loading independent of Diamond settings', async () => {
    const chip = { ...table, arena: { id: 'arena', asset: 'chips', is_platform: false } };
    const from = vi.spyOn(supabase, 'from').mockImplementation((() => {
      const chain: any = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data: chip, error: null }),
      };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      return chain;
    }) as any);
    await expect(loadTable('table')).resolves.toMatchObject({ arena: { asset: 'chips' } });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('sends a Diamond add-on through the custody door, never the chip add-on', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.lifecycleCanMutate = () => true;
    engine.broadcastCurrentState = () => {};
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { success: true, stack: 140 }, error: null } as any);
    await expect(engine.addChips('hero', 100, 'attempt')).resolves.toEqual({
      success: true,
      applied: 100,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe('fn_poker_diamond_top_up');
    expect(args).toMatchObject({
      p_user_id: 'hero',
      p_table_id: '00000000-0000-0000-0000-000000000006',
      p_amount: 100,
      p_expected_stack: 40,
    });
    expect(String(args.p_request_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    /* The seat row and its custody moved together in that transaction, so the
       number the database wrote is the one the engine adopts. */
    expect(engine.seatedPlayers[0].stack).toBe(140);
  });

  it('keeps a Diamond top-up whole and inside the table maximum', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 199, is_horse: false }];
    engine.broadcastCurrentState = () => {};
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { stack: 200 }, error: null } as any);
    await expect(engine.addChips('hero', 100.6, 'attempt')).resolves.toEqual({
      success: true,
      applied: 1,
    });
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_amount).toBe(1);
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 200, is_horse: false }];
    await expect(engine.addChips('hero', 50, 'attempt')).resolves.toEqual({
      success: false,
      error: 'Already at the maximum buy-in for this table',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refuses a Diamond top-up while a hand is live', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(engine.addChips('hero', 100, 'attempt')).resolves.toEqual({
      success: false,
      error: 'Diamond Top Ups Land Between Hands',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('leaves chip continuity, idle recovery and horse reload inert', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 0, is_horse: false }];
    engine.pendingAddOnSweepNeeded = true;
    engine.pendingAddOns.set('hero', 10);
    engine.lifecycleCanMutate = () => true;
    const rpc = vi.spyOn(supabase, 'rpc');
    const from = vi.spyOn(supabase, 'from');
    await engine.processPendingAddOns(engine.seatedPlayers);
    await engine.recoverBustedSeatedHorses();
    await expect(engine.anyBustedPlayerCanAffordARebuy(engine.seatedPlayers)).resolves.toBe(false);
    await engine.chipContinuity.evaluate([{ user_id: 'hero', stack: 100, active: true }]);
    await engine.chipContinuity.sweepPresence(engine.seatedPlayers, () => true);
    expect(engine.chipContinuity.leaveLock('hero', 100)).toEqual({ locked: false, remainingMs: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('retains pending leave after excluding every chip financial settlement stage', () => {
    const source = readFileSync('src/engine/ServerTableEngineSettlement.ts', 'utf8');
    for (const name of [
      'rake_distribution',
      'bbj_contribution',
      'promo_playthrough',
      'insurance_ledger',
      'bbj_mini_payout',
      'bbj_payout',
      'pending_addons',
      'horse_rebuys',
      'chip_continuity',
      'horse_cashouts',
    ]) {
      const start = source.indexOf("runStep('" + name + "'");
      const next = source.indexOf("runStep('", start + 10);
      expect(source.slice(start, next)).toContain('isDiamondCash');
    }
    const leave = source.slice(
      source.indexOf("runStep('leave_pending'"),
      source.indexOf("runStep('table_unlock'")
    );
    expect(leave).toContain('if (!this.isTournamentTable())');
    expect(leave).toContain('processLeavePending');
    expect(leave).not.toContain('isDiamondCash');
    const boundary = source.indexOf('assertDiamondAcceptedHand({');
    expect(boundary).toBeLessThan(source.indexOf('const commitAuthoritativeHand ='));
  });
});
