import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  spinTier,
  spinRakeRate,
  spinBlindsForLevel,
  SPIN_SEATS,
  SPIN_TIERS,
} from '../config/spinSpec.js';
import { parseSpinSettlementReceipt } from './spinSettlementReceipt.js';

// Execute the real start fragment, including the RPC loop and row patch.
// Only external I/O is stubbed; the payout transformation is production code.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const begin = source.indexOf('const buyIn = tournament.buy_in_amount || 0;');
const end = source.indexOf('let spinRowWritten = false;', begin);
if (begin < 0 || end <= begin) throw new Error('Spin start fragment could not be located');
const compiled = ts.transpileModule(
  'async function run() { ' +
    source.slice(begin, end) +
    '\nreturn spinRowPatch; }\nreturn run.call(this);',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const execute = new Function(
  'tournament',
  'spinMultiplier',
  'supabase',
  'spinTier',
  'spinRakeRate',
  'spinBlindsForLevel',
  'SPEC_SPIN_SEATS',
  'reportError',
  'console',
  'redrawnLockedTiers',
  'SPIN_TIERS',
  'parseSpinSettlementReceipt',
  compiled
);

describe('the booked Spin tier determines the start patch', () => {
  it.each([
    [2, 10, [80, 20]],
    [10, 2, [100]],
    [2, 25, [80, 12, 8]],
    [25, 10, [80, 20]],
    [10, 10, [80, 20]],
  ])('draw %s and booked %s produce the booked payout', async (drawn, booked, percentages) => {
    const tournamentId = '11111111-2222-4333-8444-555555555555';
    const collected = 3;
    const houseRake = Math.round(collected * spinRakeRate(1) * 100) / 100;
    const reserveIn = Math.round((collected - houseRake) * 100) / 100;
    const rpc = vi.fn(async () => ({
      data: {
        ok: true,
        money_path: 'fn_spin_draw_and_settle',
        tournament_id: tournamentId,
        seats: 3,
        paid_users: 3,
        multiplier: booked,
        prize_pool: booked,
        pool_covered: booked,
        draw_amount: booked,
        tournament_prize_pool: booked,
        reserve_in: reserveIn,
        entry_amount: reserveIn,
        escrow_reserve_out: reserveIn,
        escrow_reserve_in: booked,
        escrow_prize_balance: booked,
        house_rake: houseRake,
        operator_shortfall: 0,
        tournament_multiplier: booked,
        reserve_balance: 100,
        owner_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        pool_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
        entry_reserve_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
        entry_journal_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3',
        draw_reserve_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4',
        draw_journal_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5',
        locked: [],
      },
      error: null,
    }));
    const patch = await execute.call(
      { tournamentId, seatFirstTableIds: [], spinRevealLagMs: 0, spinRevealAt: 0 },
      { buy_in_amount: 1, club_id: 'club', starting_chips: 1000 },
      drawn,
      { rpc },
      spinTier,
      spinRakeRate,
      spinBlindsForLevel,
      SPIN_SEATS,
      vi.fn(),
      { log: vi.fn() },
      null,
      SPIN_TIERS,
      parseSpinSettlementReceipt
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(patch.spin_multiplier).toBe(booked);
    expect(patch.prize_pool).toBe(booked);
    expect(patch.starting_chips).toBe(1000);
    expect(patch.payout_structure).toEqual(
      (percentages as number[]).map((percentage, i) => ({ place: i + 1, percentage }))
    );
    expect(patch.blind_structure).toHaveLength(12);
    expect(
      patch.blind_structure.every((level: { duration: number }) => level.duration === 180)
    ).toBe(true);
  });
});
