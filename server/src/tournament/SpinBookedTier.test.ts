import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { spinPostRevealMs } from '../config/spinSpec.js';
import { readFundedSpinDraw, spinRuleManifest } from './SpinDrawReceipt.js';
import { SpinLaunchParkRegistry, proveSpinDrawWithParking } from './spinLaunchParking.js';

// Execute the real start fragment, including the RPC loop and the presentation
// transformation. Only external I/O is stubbed; the booked receipt remains the
// sole source of multiplier-specific blinds and payouts.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const begin = source.indexOf('const buyIn = Number(tournament.buy_in_amount) || 0;');
const end = source.indexOf('let spinPresentationWritten = playedSpinRecovery !== null;', begin);
if (begin < 0 || end <= begin) throw new Error('Spin start fragment could not be located');
const compiled = ts.transpileModule(
  'async function run() { ' +
    source.slice(begin, end) +
    '\nreturn spinPresentationPatch; }\nreturn run.call(this);',
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
  'playedSpinRecovery',
  'lifecycle',
  'TournamentLifecycleAbortedError',
  'tableStateHub',
  'spinPostRevealMs',
  'proveSpinDrawWithParking',
  'raiseFinancialAlert',
  compiled
);

/* The classified draw loop (2026-09-10), with a registry of its own per run
   so one test's park never leaks into the next. */
const proveWithFreshRegistry: typeof proveSpinDrawWithParking = (deps) =>
  proveSpinDrawWithParking({ ...deps, parks: new SpinLaunchParkRegistry() });

function receipt(booked: number) {
  const ruleManifest = spinRuleManifest(1, 1000);
  const tier = ruleManifest.tiers.find((candidate) => candidate.multiplier === booked)!;
  return {
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
    rule_manifest: ruleManifest,
    rule_sha256: 'a'.repeat(64),
    rule_provenance: 'at_draw',
  };
}

async function run(drawn: number, booked: number) {
  const rpc = vi.fn(async () => ({ data: receipt(booked), error: null }));
  const patch = await execute.call(
    {
      tournamentId: 'test-spin',
      tournamentLeaseGeneration: 'lease',
      seatFirstTableIds: [],
      spinRevealLagMs: 0,
      spinRevealAt: 0,
      assertLifecycleCurrent: vi.fn(),
    },
    { buy_in_amount: 1, starting_chips: 1000, spin_multiplier: drawn },
    { rpc },
    spinRuleManifest,
    readFundedSpinDraw,
    'launch',
    vi.fn(),
    { log: vi.fn(), warn: vi.fn() },
    null,
    { generation: 1 },
    TestTournamentLifecycleAbortedError,
    { emitEvent: vi.fn() },
    spinPostRevealMs,
    proveWithFreshRegistry,
    vi.fn(async () => ({ persisted: true, alertId: 'alert' }))
  );
  return { patch, rpc };
}

describe('the booked Spin tier determines the presentation patch', () => {
  it.each([
    [2, 10, [80, 20]],
    [10, 2, [100]],
    [2, 25, [80, 12, 8]],
    [25, 10, [80, 20]],
    [10, 10, [80, 20]],
  ])(
    'projection %s and booked %s produce the booked payout',
    async (drawn, booked, percentages) => {
      const { patch, rpc } = await run(drawn, booked);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(patch.payout_structure).toEqual(
        (percentages as number[]).map((percentage, i) => ({ place: i + 1, percentage }))
      );
      expect(patch.blind_structure).toHaveLength(12);
      expect(
        patch.blind_structure.every((level: { duration: number }) => level.duration === 180)
      ).toBe(true);
      expect(patch).not.toHaveProperty('spin_multiplier');
      expect(patch).not.toHaveProperty('prize_pool');
      expect(patch).not.toHaveProperty('starting_chips');
    }
  );
});
