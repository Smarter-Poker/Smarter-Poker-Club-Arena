import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPIN_SEATS,
  SPIN_TIERS,
  spinBlindsForLevel,
  spinPostRevealMs,
  spinRakeRate,
  spinTier,
} from '../config/spinSpec.js';
import { parseSpinSettlementReceipt } from './spinSettlementReceipt.js';

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const tournamentId = id('1');
const revealAt = Date.parse('2026-09-09T12:34:56.789Z');

// Execute the production combined draw-and-settlement block through creation
// of its presentation patch. External I/O is controlled, but receipt parsing,
// reveal ordering and the patch transformation are the production code.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const anchor = source.indexOf('// SPIN & GO — settle the money through the Reserve Pool');
const begin = source.indexOf(
  "if (tournament.variant === 'spin' || tournament.tournament_type === 'SPIN') {",
  anchor
);
const end = source.indexOf('let spinPresentationWritten = false;', begin);
if (anchor < 0 || begin < 0 || end <= begin) {
  throw new Error('Combined Spin draw-and-settlement launch fragment was not found');
}
const compiled = ts.transpileModule(
  `async function run() {
${source.slice(begin, end)}
return spinPresentationPatch;
}
return undefined;
}
return run.call(this);`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

class Aborted extends Error {}

const execute = new Function(
  'tournament',
  'supabase',
  'spinTier',
  'spinRakeRate',
  'spinBlindsForLevel',
  'SPEC_SPIN_SEATS',
  'SPIN_TIERS',
  'parseSpinSettlementReceipt',
  'reportError',
  'console',
  'playedSpinRecovery',
  'lifecycle',
  'TournamentLifecycleAbortedError',
  'tableStateHub',
  'spinPostRevealMs',
  compiled
);

const exactReceipt = (multiplier = 10, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  money_path: 'fn_spin_draw_and_settle',
  tournament_id: tournamentId,
  seats: 3,
  paid_users: 3,
  multiplier,
  prize_pool: multiplier,
  pool_covered: multiplier,
  draw_amount: multiplier,
  tournament_prize_pool: multiplier,
  tournament_multiplier: multiplier,
  reserve_in: 2.76,
  entry_amount: 2.76,
  house_rake: 0.24,
  operator_shortfall: 0,
  escrow_reserve_out: 2.76,
  escrow_reserve_in: multiplier,
  escrow_prize_balance: multiplier,
  reserve_balance: 500,
  owner_id: id('2'),
  pool_id: id('3'),
  entry_reserve_id: id('4'),
  entry_journal_id: id('5'),
  draw_reserve_id: id('6'),
  draw_journal_id: id('7'),
  locked: [{ multiplier: 100, reason: 'threshold', unlocksAt: 20_000 }],
  ...overrides,
});

function start(rpc: ReturnType<typeof vi.fn>) {
  const emitEvent = vi.fn();
  const reportError = vi.fn();
  const manager = {
    tournamentId,
    seatFirstTableIds: ['table'],
    spinRevealLagMs: 741,
    spinRevealAt: 0,
    spinRevealEmitted: false,
    running: true,
    assertLifecycleCurrent: vi.fn(),
    resolveSpinReveal() {
      this.spinRevealAt = revealAt;
      return { revealAt, holdUntil: revealAt + 10_000 };
    },
  };
  const outcome = execute.call(
    manager,
    {
      variant: 'spin',
      tournament_type: 'SPIN',
      buy_in_amount: 1,
      club_id: 'club',
      starting_chips: 1000,
    },
    { rpc },
    spinTier,
    spinRakeRate,
    spinBlindsForLevel,
    SPIN_SEATS,
    SPIN_TIERS,
    parseSpinSettlementReceipt,
    reportError,
    { log: vi.fn() },
    null,
    { generation: 1 },
    Aborted,
    { emitEvent },
    spinPostRevealMs
  );
  return { emitEvent, manager, outcome, reportError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a Spin reveals only its authoritative combined settlement', () => {
  it('does not reveal while the combined draw-and-settlement receipt is unresolved', async () => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const rpc = vi.fn(() => held);
    const run = start(rpc);

    expect(rpc).toHaveBeenCalledWith('fn_spin_draw_and_settle', {
      p_tournament_id: tournamentId,
      p_tiers: SPIN_TIERS.map((tier) => ({
        multiplier: tier.multiplier,
        freq: tier.freq,
        reserveThresholdX: tier.reserveThresholdX,
      })),
    });
    expect(run.emitEvent).not.toHaveBeenCalled();

    release({ data: exactReceipt(10), error: null });
    await run.outcome;

    expect(run.emitEvent).toHaveBeenCalledOnce();
  });

  it('reveals the exact multiplier, prize and locked tiers proven by the receipt', async () => {
    const rpc = vi.fn(async () => ({ data: exactReceipt(25), error: null }));
    const run = start(rpc);

    await run.outcome;

    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(run.emitEvent.mock.calls[0][1]).toMatchObject({
      type: 'spin_reveal',
      tournament_id: tournamentId,
      multiplier: 25,
      buy_in: 1,
      prize_pool: 25,
      locked_tiers: [{ multiplier: 100, reason: 'threshold', unlocksAt: 20_000 }],
      reveal_at: revealAt,
    });
  });

  it.each([
    ['failed', () => ({ data: null, error: { message: 'atomic settlement unavailable' } })],
    ['malformed', () => ({ data: exactReceipt(10, { draw_journal_id: null }), error: null })],
  ])('emits no reveal when the combined receipt is %s', async (_kind, result) => {
    vi.useFakeTimers();
    const rpc = vi.fn(async () => result());
    const run = start(rpc);

    await vi.runAllTimersAsync();

    expect(await run.outcome).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(run.emitEvent).not.toHaveBeenCalled();
    expect(run.manager.running).toBe(false);
    expect(run.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.spin_settle_failed'
    );
  });

  it('derives the presentation patch from the same booked multiplier', async () => {
    const rpc = vi.fn(async () => ({ data: exactReceipt(25), error: null }));
    const run = start(rpc);

    const patch = await run.outcome;

    expect(patch).toEqual({
      is_premium_spin: false,
      blind_structure: Array.from({ length: 12 }, (_, index) => {
        const blinds = spinBlindsForLevel(index + 1);
        return {
          level: index + 1,
          smallBlind: blinds.small,
          bigBlind: blinds.big,
          ante: 0,
          duration: 180,
        };
      }),
      payout_structure: [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 12 },
        { place: 3, percentage: 8 },
      ],
      spin_reveal_lag_ms: 741,
      spin_reveal_at: new Date(revealAt).toISOString(),
    });
    expect(patch).not.toHaveProperty('spin_multiplier');
    expect(patch).not.toHaveProperty('prize_pool');
  });
});
