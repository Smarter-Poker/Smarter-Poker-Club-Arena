import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  spinTier,
  spinRakeRate,
  spinBlindsForLevel,
  SPIN_SEATS,
  spinPostRevealMs,
} from '../config/spinSpec.js';

// Execute the production launch code, including settlement and its early reveal.
// External I/O is controlled; the order and outcome transformation are real.
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
  'spinMultiplier',
  'supabase',
  'spinTier',
  'spinRakeRate',
  'spinBlindsForLevel',
  'SPEC_SPIN_SEATS',
  'reportError',
  'console',
  'redrawnLockedTiers',
  'lifecycle',
  'TournamentLifecycleAbortedError',
  'tableStateHub',
  'spinPostRevealMs',
  compiled
);

function start(rpc: ReturnType<typeof vi.fn>, multiplier = 2) {
  const emitEvent = vi.fn();
  const outcome = execute.call(
    {
      tournamentId: 'spin',
      seatFirstTableIds: ['table'],
      spinRevealLagMs: 0,
      spinRevealAt: 0,
      assertLifecycleCurrent: vi.fn(),
      resolveSpinReveal: () => ({ revealAt: 1000, holdUntil: 10000 }),
    },
    { buy_in_amount: 1, club_id: 'club', starting_chips: 1000 },
    multiplier,
    { rpc },
    spinTier,
    spinRakeRate,
    spinBlindsForLevel,
    SPIN_SEATS,
    vi.fn(),
    { log: vi.fn() },
    null,
    { generation: 1 },
    Aborted,
    { emitEvent },
    spinPostRevealMs
  );
  return { emitEvent, outcome };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a Spin reveals the durable settlement result', () => {
  it('does not announce a multiplier while reserve settlement is unresolved', async () => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const rpc = vi.fn(() => held);
    const run = start(rpc);
    try {
      expect(rpc).toHaveBeenCalledOnce();
      expect(run.emitEvent).not.toHaveBeenCalled();
    } finally {
      release({ data: { ok: true, multiplier: 2 }, error: null });
      await run.outcome;
    }
    expect(run.emitEvent).toHaveBeenCalledOnce();
  });

  it('announces the already-booked multiplier and prize when they differ from the local draw', async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: true, reason: 'already_settled', multiplier: 10 },
      error: null,
    }));
    const run = start(rpc, 2);
    const patch = await run.outcome;
    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(run.emitEvent.mock.calls[0][1]).toMatchObject({
      type: 'spin_reveal',
      multiplier: 10,
      prize_pool: 10,
    });
    expect(patch.spin_multiplier).toBe(10);
    expect(patch.payout_structure).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);
  });

  it('announces no result when all settlement attempts fail', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'settlement unavailable' } }));
    const run = start(rpc);
    await vi.runAllTimersAsync();
    expect(await run.outcome).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(run.emitEvent).not.toHaveBeenCalled();
  });

  it('stands down when an already-settled receipt has no readable booked multiplier', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(async () => ({
      data: { ok: true, reason: 'already_settled', multiplier: null },
      error: null,
    }));
    const run = start(rpc, 2);
    await vi.runAllTimersAsync();
    expect(await run.outcome).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(run.emitEvent).not.toHaveBeenCalled();
  });

  it('reveals one matching funded result before the row patch and table-building work', async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, multiplier: 25 }, error: null }));
    const run = start(rpc, 25);
    const patch = await run.outcome;
    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(run.emitEvent.mock.calls[0][1]).toMatchObject({ multiplier: 25, prize_pool: 25 });
    expect(patch.spin_multiplier).toBe(25);
    expect(patch.starting_chips).toBe(1000);
  });
});
