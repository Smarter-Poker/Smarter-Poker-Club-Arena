import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { spinPostRevealMs } from '../config/spinSpec.js';
import { readFundedSpinDraw, spinRuleManifest } from './SpinDrawReceipt.js';

// Execute the real production launch fragment with controlled transport and hub.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const begin = source.indexOf('const buyIn = tournament.buy_in_amount || 0;');
const end = source.indexOf('let spinRowWritten = false;', begin);
if (begin < 0 || end <= begin) throw new Error('Spin launch fragment was not found');
const compiled = ts.transpileModule(
  'async function run() { ' +
    source.slice(begin, end) +
    '\nreturn spinRowPatch; }\nreturn run.call(this);',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
class Aborted extends Error {}
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
  'tableStateHub',
  'spinPostRevealMs',
  compiled
);

function receipt(multiplier = 2) {
  const rule_manifest = spinRuleManifest(1, 1000);
  const tier = rule_manifest.tiers.find((t) => t.multiplier === multiplier)!;
  return {
    ok: true,
    replay: false,
    tournament_id: 'spin',
    launch_id: 'launch',
    buy_in: 1,
    multiplier,
    prize_pool: multiplier,
    pool_covered: multiplier,
    operator_shortfall: 0,
    starting_chips: 1000,
    blind_structure: tier.blind_structure,
    payout_structure: tier.payout_structure,
    locked: [{ multiplier: 100, reason: 'threshold', unlocksAt: 150 }],
    entrants: [1, 2, 3].map((i) => ({ user_id: `user-${i}`, registration_id: `entry-${i}` })),
    rule_manifest,
    rule_sha256: 'a'.repeat(64),
    rule_provenance: 'at_draw',
  };
}

function start(rpc: ReturnType<typeof vi.fn>) {
  const emitEvent = vi.fn();
  const context = {
    tournamentId: 'spin',
    tournamentLeaseGeneration: 'lease',
    running: true,
    seatFirstTableIds: ['table'],
    spinRevealLagMs: 0,
    spinRevealAt: 0,
    assertLifecycleCurrent: vi.fn(),
    resolveSpinReveal: () => ({ revealAt: 1000, holdUntil: 10000 }),
  };
  const outcome = execute.call(
    context,
    {
      buy_in_amount: 1,
      club_id: 'club',
      starting_chips: 1000,
      spin_multiplier: 2,
      spin_locked_tiers: [{ multiplier: 10, reason: 'stale' }],
    },
    { rpc },
    spinRuleManifest,
    readFundedSpinDraw,
    'launch',
    vi.fn(),
    { log: vi.fn() },
    { generation: 1 },
    Aborted,
    { emitEvent },
    spinPostRevealMs
  );
  return { emitEvent, outcome, context };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a Spin reveals its atomic funded rule receipt', () => {
  it('announces nothing until the transaction returns a valid receipt', async () => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const rpc = vi.fn(() => held);
    const run = start(rpc);
    expect(rpc).toHaveBeenCalledOnce();
    expect(run.emitEvent).not.toHaveBeenCalled();
    release({ data: receipt(), error: null });
    await run.outcome;
    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]).toEqual([
      'fn_spin_draw_and_settle_atomic',
      {
        p_tournament_id: 'spin',
        p_launch_id: 'launch',
        p_lease_generation: 'lease',
        p_rule_manifest: spinRuleManifest(1, 1000),
      },
    ]);
  });

  it('adopts the stored 10x result over a stale 2x projection, including locked tiers', async () => {
    const booked = receipt(10);
    const run = start(vi.fn(async () => ({ data: booked, error: null })));
    const patch = await run.outcome;
    expect(run.emitEvent.mock.calls[0][1]).toMatchObject({
      type: 'spin_reveal',
      multiplier: 10,
      prize_pool: 10,
      locked_tiers: booked.locked,
    });
    expect(patch.spin_multiplier).toBe(10);
    expect(patch.payout_structure).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);
  });

  it('retries a lost response with the same launch and rule payload, then emits once', async () => {
    vi.useFakeTimers();
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('Response lost after commit'))
      .mockResolvedValue({ data: { ...receipt(25), replay: true }, error: null });
    const run = start(rpc);
    await vi.runAllTimersAsync();
    const patch = await run.outcome;
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(patch.spin_multiplier).toBe(25);
  });

  it('uses the booked payout and blind rules after a specification change', async () => {
    const booked = receipt(10);
    const tier = booked.rule_manifest.tiers.find((t) => t.multiplier === 10)!;
    tier.blind_structure = tier.blind_structure.map((b) => ({ ...b, duration: 240 }));
    tier.payout_structure = [
      { place: 1, percentage: 70 },
      { place: 2, percentage: 30 },
    ];
    booked.blind_structure = tier.blind_structure;
    booked.payout_structure = tier.payout_structure;
    const run = start(vi.fn(async () => ({ data: booked, error: null })));
    const patch = await run.outcome;
    expect(patch.blind_structure.every((b: { duration: number }) => b.duration === 240)).toBe(true);
    expect(patch.payout_structure).toEqual(tier.payout_structure);
    expect(patch.starting_chips).toBe(1000);
  });

  it.each([
    ['transport unavailable', { data: null, error: { message: 'unavailable' } }],
    [
      'cancelled launch',
      { data: { ok: false, reason: 'launch_receipt_state_mismatch' }, error: null },
    ],
    ['missing multiplier', { data: { ...receipt(), multiplier: null }, error: null }],
    [
      'unfunded prize',
      { data: { ...receipt(10), pool_covered: 8, operator_shortfall: 2 }, error: null },
    ],
    ['missing rule version', { data: { ...receipt(), rule_manifest: null }, error: null }],
    ['wrong launch receipt', { data: { ...receipt(), launch_id: 'other' }, error: null }],
    [
      'mismatched stored payout',
      { data: { ...receipt(10), payout_structure: [{ place: 1, percentage: 100 }] }, error: null },
    ],
  ])('stands down without a wheel for %s', async (_name, response) => {
    vi.useFakeTimers();
    const rpc = vi.fn(async () => response);
    const run = start(rpc);
    await vi.runAllTimersAsync();
    expect(await run.outcome).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(run.emitEvent).not.toHaveBeenCalled();
    expect(run.context.running).toBe(false);
  });
});
