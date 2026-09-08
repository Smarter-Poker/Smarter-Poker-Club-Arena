import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { spinTier, spinRakeRate, spinBlindsForLevel, SPIN_SEATS } from '../config/spinSpec.js';

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
    const rpc = vi.fn(async () => ({
      data: {
        ok: true,
        reason: 'already_settled',
        multiplier: booked,
        house_rake: 0.24,
        balance: 100,
      },
      error: null,
    }));
    const patch = await execute.call(
      { tournamentId: 'test-spin', seatFirstTableIds: [], spinRevealLagMs: 0, spinRevealAt: 0 },
      { buy_in_amount: 1, club_id: 'club', starting_chips: 1000 },
      drawn,
      { rpc },
      spinTier,
      spinRakeRate,
      spinBlindsForLevel,
      SPIN_SEATS,
      vi.fn(),
      { log: vi.fn() },
      null
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
