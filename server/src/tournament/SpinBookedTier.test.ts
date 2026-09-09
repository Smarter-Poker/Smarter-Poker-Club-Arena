import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { readFundedSpinDraw, spinRuleManifest } from './SpinDrawReceipt.js';

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
class TestTournamentLifecycleAbortedError extends Error {}
const execute = new Function(
  'tournament',
  'supabase',
  'spinRuleManifest',
  'readFundedSpinDraw',
  'launchId',
  'reportError',
  'console',
  'lifecycle',
  'TournamentLifecycleAbortedError',
  compiled
);

describe('the booked Spin tier determines the start patch', () => {
  it.each([
    [2, 10, [80, 20]],
    [10, 2, [100]],
    [2, 25, [80, 12, 8]],
    [25, 10, [80, 20]],
    [10, 10, [80, 20]],
  ])(
    'projection %s and booked %s produce the booked payout',
    async (drawn, booked, percentages) => {
      const rules = spinRuleManifest(1, 1000);
      const tier = rules.tiers.find((t) => t.multiplier === booked)!;
      const rpc = vi.fn(async () => ({
        data: {
          ok: true,
          replay: true,
          tournament_id: 'test-spin',
          launch_id: 'launch',
          buy_in: 1,
          multiplier: booked,
          prize_pool: booked,
          pool_covered: booked,
          operator_shortfall: 0,
          starting_chips: 1000,
          blind_structure: tier.blind_structure,
          payout_structure: tier.payout_structure,
          locked: [],
          entrants: [1, 2, 3].map((i) => ({ user_id: `user-${i}`, registration_id: `entry-${i}` })),
          rule_manifest: rules,
          rule_sha256: 'a'.repeat(64),
          rule_provenance: 'at_draw',
          house_rake: 0.24,
          balance: 100,
        },
        error: null,
      }));
      const patch = await execute.call(
        {
          tournamentId: 'test-spin',
          tournamentLeaseGeneration: 'lease',
          seatFirstTableIds: [],
          spinRevealLagMs: 0,
          spinRevealAt: 0,
          assertLifecycleCurrent: vi.fn(),
        },
        { buy_in_amount: 1, club_id: 'club', starting_chips: 1000, spin_multiplier: drawn },
        { rpc },
        spinRuleManifest,
        readFundedSpinDraw,
        'launch',
        vi.fn(),
        { log: vi.fn() },
        { generation: 1 },
        TestTournamentLifecycleAbortedError
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
    }
  );
});
