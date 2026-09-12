import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertDiamondAcceptedHand,
  assertDiamondCashTable,
  DIAMOND_CASH_VARIANTS,
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
  it('admits every supported game and rejects optional money paths', () => {
    expect(() => assertDiamondCashTable(table)).not.toThrow();
    expect(() => assertDiamondCashTable({ ...table, status: 'running' })).not.toThrow();
    /* THE NINE GAMES THE CHIP CASH SCREEN OFFERS (2026-09-12). `plo4` was in
       the refusal list below until the arithmetic that would have made it
       unsafe was proved absent: every place a pot is divided already reads the
       table's unit, the hi-lo split included. See DIAMOND_CASH_VARIANTS. */
    for (const game_variant of DIAMOND_CASH_VARIANTS)
      expect(
        () => assertDiamondCashTable({ ...table, game_variant }),
        `${game_variant} is offered for chips and must be offered here`
      ).not.toThrow();
    /* And a game nobody deals is still refused, so the list is a list rather
       than an absent check. */
    for (const game_variant of ['stud', 'razz', 'badugi', 'NLH', '', null])
      expect(
        () => assertDiamondCashTable({ ...table, game_variant }),
        `${game_variant} is not a game this estate deals`
      ).toThrow('Diamond Plain Cash Table Required');
    for (const change of [
      { tournament_id: 't' },
      { cluster_id: 'c' },
      { status: 'closed' },
      { rake_percent: 1 },
      { bbj_percent: 1 },
      { is_template: true },
      { insurance_enabled: true },
      { seven_deuce_enabled: true },
      { nit_game: true },
      { all_in_or_fold: true },
      { pineapple_holdem: true },
      { cap_enabled: true },
      { rake_cap_bb: 1 },
      { small_blind: 0.5 },
      { min_buy_in: 0 },
      { max_buy_in: Infinity },
      { ante: 0.5 },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).toThrow();
  });

  /* STRADDLES ARE ADMITTED (2026-09-12). A straddle is priced at exactly two
     times the current blind and this guard already refuses a table whose blinds
     are not whole positive integers, so it is whole by construction with no
     counterparty and no ledger. The three columns are also safe to read as
     absent-means-off, unlike the run-it columns below: every engine read of
     them is truthy, so an unset column disables the feature in the engine
     exactly as it did here. */
  it('admits a straddling table and still refuses the side bet next to it', () => {
    for (const change of [
      { straddle_enabled: true },
      { straddle_enabled: true, auto_utg_straddle: true },
      { straddle_enabled: true, voluntary_straddle: true },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).not.toThrow();
    for (const key of ['straddle_enabled', 'auto_utg_straddle', 'voluntary_straddle'] as const) {
      const missing: Record<string, unknown> = { ...table };
      delete missing[key];
      expect(() => assertDiamondCashTable(missing), `${key} unset was refused`).not.toThrow();
      expect(() => assertDiamondCashTable({ ...table, [key]: null })).not.toThrow();
    }
    /* seven-deuce is not a straddle. It is a side bet at a table-configured
       amount, and this phase has not certified that money fact. */
    expect(() =>
      assertDiamondCashTable({ ...table, straddle_enabled: true, seven_deuce_enabled: true })
    ).toThrow('Diamond Plain Cash Table Required');
  });

  /* BOMB POTS ARE ADMITTED (2026-09-12). The ante is a forced bet out of a
     stack and the multi-board settlement has cut its shares in the table's own
     unit since the tournament fix, so neither half needs the chip economy. What
     the ROW still has to satisfy is that the ante could be whole and that the
     bomb plays the table's own game. */
  it('admits a bomb pot whose ante is whole and whose bombs are the table game', () => {
    for (const change of [
      { bomb_pot_enabled: true },
      { bomb_pot_enabled: true, bomb_pot_ante_multiplier: 1 },
      { bomb_pot_enabled: true, bomb_pot_ante_multiplier: 3 },
      { bomb_pot_enabled: true, bomb_pot_ante_fixed: 5 },
      { bomb_pot_enabled: true, bomb_pot_double_board: true },
      { bomb_pot_enabled: true, bomb_pot_board_count: 3 },
      { bomb_pot_enabled: true, bomb_pot_variant: 'nlh' },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).not.toThrow();
  });

  it('refuses a bomb pot that could not ante a whole Diamond', () => {
    /* The multiplier slider steps by 0.5, so half a blind is a real setting and
       half a Diamond is not a real bet. big_blind is 2 in this fixture. */
    expect(() =>
      assertDiamondCashTable({ ...table, bomb_pot_enabled: true, bomb_pot_ante_multiplier: 1.5 })
    ).not.toThrow();
    expect(() =>
      assertDiamondCashTable({
        ...table,
        big_blind: 1,
        bomb_pot_enabled: true,
        bomb_pot_ante_multiplier: 1.5,
      })
    ).toThrow('Diamond Bomb Pots Require A Whole Ante');
    expect(() =>
      assertDiamondCashTable({ ...table, bomb_pot_enabled: true, bomb_pot_ante_fixed: 2.5 })
    ).toThrow('Diamond Bomb Pots Require A Whole Ante');
    expect(() =>
      assertDiamondCashTable({ ...table, bomb_pot_enabled: true, bomb_pot_ante_multiplier: 0 })
    ).toThrow('Diamond Bomb Pots Require A Whole Ante');
  });

  it('refuses a bomb pot that would deal a game the table is not certified for', () => {
    /* THE RULE IS "THE TABLE'S OWN GAME", NOT "NLH" (2026-09-12). This read the
       literal `nlh`, which was indistinguishable from the real rule while nlh
       was the only game and became wrong the moment it was not: it would have
       refused a Diamond PLO4 table whose bomb variant said plo4, and admitted
       one whose bomb variant said nlh. Both backwards. The fixture table is
       nlh, so the same list is still refused here - and the case that proves
       the rule actually moved is the one below it. */
    for (const variant of ['plo4', 'plo5', 'short_deck', 'flo8', 'PLO4'])
      expect(() =>
        assertDiamondCashTable({ ...table, bomb_pot_enabled: true, bomb_pot_variant: variant })
      ).toThrow('Diamond Bomb Pots Require The Table Game');
    /* A PLO4 table may bomb in PLO4, and may not bomb in hold'em. */
    expect(() =>
      assertDiamondCashTable({
        ...table,
        game_variant: 'plo4',
        bomb_pot_enabled: true,
        bomb_pot_variant: 'plo4',
      })
    ).not.toThrow();
    expect(() =>
      assertDiamondCashTable({
        ...table,
        game_variant: 'plo4',
        bomb_pot_enabled: true,
        bomb_pot_variant: 'nlh',
      })
    ).toThrow('Diamond Bomb Pots Require The Table Game');
    /* And the ante rule is not waived by the variant rule passing. */
    expect(() =>
      assertDiamondCashTable({
        ...table,
        bomb_pot_enabled: true,
        bomb_pot_variant: 'nlh',
        bomb_pot_ante_fixed: 2.5,
      })
    ).toThrow('Diamond Bomb Pots Require A Whole Ante');
  });

  it('says nothing about the bomb columns while bomb pots are off', () => {
    /* A row can carry a stale multiplier from a template it was copied from.
       The columns only bind when the feature is on. */
    expect(() =>
      assertDiamondCashTable({
        ...table,
        bomb_pot_enabled: false,
        bomb_pot_ante_multiplier: 1.5,
        bomb_pot_variant: 'plo4',
      })
    ).not.toThrow();
  });

  /* RUN IT TWICE IS ADMITTED (2026-09-12), and the two columns still have to be
     STATED. The engine reads an absent one as true, which would make the chip
     schedule's default this arena's answer. `run_it_twice_enabled` reads as
     false when absent and only ever turns the feature on, so it is free. */
  it('admits a table that runs it twice, and still refuses one that never said', () => {
    for (const change of [
      { run_it_twice: true, allow_run_it_twice: true },
      { run_it_twice: true, allow_run_it_twice: false },
      { run_it_twice_enabled: true },
      { run_it_twice_enabled: false },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).not.toThrow();
    for (const key of ['run_it_twice', 'allow_run_it_twice'] as const) {
      expect(() => assertDiamondCashTable({ ...table, [key]: null })).toThrow(
        'Diamond Plain Cash Table Required'
      );
    }
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
    /* The DEALT variant, which is not always the table's column: a bomb-pot
       override and the pineapple upgrade both reach this guard. Each supported
       game must pass it, or a hand this arena dealt could not be committed. */
    for (const variant of DIAMOND_CASH_VARIANTS)
      expect(() => assertDiamondAcceptedHand({ ...hand, variant })).not.toThrow();
    for (const variant of ['stud', 'razz', 'NLH', ''])
      expect(() => assertDiamondAcceptedHand({ ...hand, variant })).toThrow(
        'diamond_plain_cash_required'
      );
    for (const change of [
      { verifiedLease: false },
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

  /* ─── A MID-HAND TOP-UP IS AN INTENT (2026-09-12) ───────────────────────
     This used to assert a flat refusal, and the refusal was right for as long
     as there was nothing else a Diamond seat could safely do. There is now:
     the chip lane takes the money at request time and lands the chips at the
     end of the hand, and this arena cannot do that - the deferred
     seat-keeps-custody trigger requires a Diamond seat's stack to EQUAL its
     custody balance at every COMMIT, so a reservation made now and applied
     later is a committed state the database refuses - but it CAN record an
     intent and do the whole thing in one transaction when the hand ends.

     What is asserted here is the part that makes that safe: no money moves
     now. `rpc` is still never called during the hand. */
  it('records a mid-hand Diamond top-up as an intent, and moves nothing yet', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(engine.addChips('hero', 100, 'attempt')).resolves.toEqual({
      success: true,
      queued: true,
      applied: 100,
    });
    expect(rpc, 'a mid-hand Diamond top-up moved money').not.toHaveBeenCalled();
    expect(engine.diamondTopUpIntents.size).toBe(1);
    expect([...engine.diamondTopUpIntents.values()]).toEqual([{ userId: 'hero', amount: 100 }]);
  });

  it('sizes the intent against the stack AND everything already intended', async () => {
    /* Three taps in one hand must not promise more than the table can hold.
       max_buy_in is 200 in this fixture and the seat holds 40. */
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    vi.spyOn(supabase, 'rpc');
    await expect(engine.addChips('hero', 100, 'one')).resolves.toMatchObject({ applied: 100 });
    await expect(engine.addChips('hero', 100, 'two')).resolves.toMatchObject({ applied: 60 });
    await expect(engine.addChips('hero', 100, 'three')).resolves.toEqual({
      success: false,
      error: 'Already at the maximum buy-in for this table',
    });
    const total = [...engine.diamondTopUpIntents.values()].reduce(
      (sum: number, i: { amount: number }) => sum + i.amount,
      0
    );
    expect(total + 40, 'the intents promise more than the table holds').toBe(200);
  });

  it('the same tap retried is one intent, and a second tap is two', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 0, is_horse: false }];
    engine.handController = {};
    vi.spyOn(supabase, 'rpc');
    await engine.addChips('hero', 10, 'same-tap');
    await engine.addChips('hero', 10, 'same-tap');
    expect(engine.diamondTopUpIntents.size, 'a retried tap was counted twice').toBe(1);
    await engine.addChips('hero', 10, 'another-tap');
    expect(engine.diamondTopUpIntents.size).toBe(2);
  });

  it('a whole Diamond or nothing, even as an intent', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 0, is_horse: false }];
    engine.handController = {};
    vi.spyOn(supabase, 'rpc');
    await expect(engine.addChips('hero', 0.5, 'fraction')).resolves.toEqual({
      success: false,
      error: 'Diamond Top Ups Are Whole Diamonds',
    });
    expect(engine.diamondTopUpIntents.size).toBe(0);
  });

  it('lands the intent when the hand ends, on the stack as it is by then', async () => {
    /* The pot moved the stack while the intent waited, which is the whole
       reason the amount could not be fixed at request time. The door is told
       the stack it is actually raising, and the amount is re-measured against
       the headroom that is left. */
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    await engine.addChips('hero', 100, 'attempt');
    engine.handController = null;
    // The hand ended with the hero up: 40 became 150, so only 50 will fit.
    engine.seatedPlayers[0].stack = 150;
    engine.broadcastCurrentState = () => {};
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { stack: 200 },
      error: null,
      count: null,
      status: 200,
      statusText: 'OK',
    });
    await engine.processPendingAddOns(engine.seatedPlayers);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('fn_poker_diamond_top_up');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_user_id: 'hero',
      p_amount: 50,
      p_expected_stack: 150,
    });
    expect(engine.diamondTopUpIntents.size, 'the intent outlived its landing').toBe(0);
    expect(engine.seatedPlayers[0].stack).toBe(200);
  });

  it('drops an intent it can no longer honour rather than retrying it forever', async () => {
    /* Nothing was taken, so dropping costs nobody anything - and a queue that
       never empties is how a table stops dealing. This is the opposite of the
       chip rule, where an unresolved row is money already taken. */
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    await engine.addChips('hero', 100, 'attempt');
    engine.handController = null;
    // The player left while the hand finished.
    engine.seatedPlayers = [];
    const rpc = vi.spyOn(supabase, 'rpc');
    await engine.processPendingAddOns(engine.seatedPlayers);
    expect(rpc).not.toHaveBeenCalled();
    expect(engine.diamondTopUpIntents.size).toBe(0);
  });

  it('never lands an intent while a hand is running', async () => {
    const engine = new ServerTableEngine('00000000-0000-0000-0000-000000000006') as any;
    engine.tableInfo = { ...table, arena: diamond };
    engine.seatedPlayers = [{ user_id: 'hero', seat_number: 1, stack: 40, is_horse: false }];
    engine.handController = {};
    await engine.addChips('hero', 100, 'attempt');
    const rpc = vi.spyOn(supabase, 'rpc');
    await engine.processPendingAddOns(engine.seatedPlayers);
    expect(rpc, 'a top-up landed mid-hand').not.toHaveBeenCalled();
    expect(engine.diamondTopUpIntents.size, 'the intent was dropped mid-hand').toBe(1);
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
