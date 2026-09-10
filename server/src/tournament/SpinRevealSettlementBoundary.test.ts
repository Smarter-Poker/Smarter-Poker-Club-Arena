import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spinPostRevealMs, spinRevealTotalMs } from '../config/spinSpec.js';
import { TableStateHub, type HubSubscriber } from '../transport/TableStateHub.js';
import { readFundedSpinDraw, spinRuleManifest } from './SpinDrawReceipt.js';
import {
  SPIN_LAUNCH_PARKED_ALERT_SOURCE,
  SpinLaunchParkRegistry,
  proveSpinDrawWithParking,
} from './spinLaunchParking.js';

// Execute the real production launch fragment with controlled transport and
// hub. The presentation patch remains deliberately separate from the money
// fields that the atomic database authority has already committed.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const begin = source.indexOf('const buyIn = Number(tournament.buy_in_amount) || 0;');
const end = source.indexOf('let spinPresentationWritten = playedSpinRecovery !== null;', begin);
if (begin < 0 || end <= begin) throw new Error('Spin launch fragment was not found');
const compiled = ts.transpileModule(
  'async function run() { ' +
    source.slice(begin, end) +
    '\nreturn spinPresentationPatch; }\nreturn run.call(this);',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

const admissionBegin = source.indexOf('let spinFirstDealHoldUntil = 0;');
const admissionEnd = source.indexOf('const launchSetupProven =', admissionBegin);
if (admissionBegin < 0 || admissionEnd <= admissionBegin) {
  throw new Error('Spin admission reveal fragment was not found');
}
const executeAdmission = new Function(
  'tournament',
  'launchStartMs',
  'playedSpinRecovery',
  'tableStateHub',
  'spinPostRevealMs',
  'spinRevealTotalMs',
  'reportError',
  'console',
  ts.transpileModule(source.slice(admissionBegin, admissionEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
);

class Aborted extends Error {}

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

function receipt(multiplier = 2) {
  const rule_manifest = spinRuleManifest(1, 1000);
  const tier = rule_manifest.tiers.find((candidate) => candidate.multiplier === multiplier)!;
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

function start(
  rpc: ReturnType<typeof vi.fn>,
  options: {
    playedSpinRecovery?: Record<string, unknown> | null;
    tournament?: Record<string, unknown>;
    hub?: Pick<TableStateHub, 'emitEvent'>;
  } = {}
) {
  const emitEvent = options.hub ? vi.fn(options.hub.emitEvent.bind(options.hub)) : vi.fn();
  const reportError = vi.fn();
  const raiseFinancialAlert = vi.fn(async () => ({ persisted: true, alertId: 'alert' }));
  const context = {
    tournamentId: 'spin',
    tournamentLeaseGeneration: 'lease',
    running: true,
    seatFirstTableIds: ['table'],
    spinRevealLagMs: 0,
    spinRevealAt: 0,
    spinRevealEmitted: false,
    spinRevealEmittedTableIds: new Set<string>(),
    tableEngines: new Map([['table', { holdDealingUntil: vi.fn() }]]),
    scheduleSpinPostReveal: vi.fn(),
    assertLifecycleCurrent: vi.fn(),
    resolveSpinReveal() {
      this.spinRevealAt = 1000;
      return { revealAt: 1000, holdUntil: 10000 };
    },
  };
  const outcome = execute.call(
    context,
    {
      variant: 'spin',
      tournament_type: 'SPIN',
      buy_in_amount: 1,
      starting_chips: 1000,
      spin_multiplier: 2,
      spin_locked_tiers: [{ multiplier: 10, reason: 'stale' }],
      ...options.tournament,
    },
    { rpc },
    spinRuleManifest,
    readFundedSpinDraw,
    'launch',
    reportError,
    { log: vi.fn(), warn: vi.fn() },
    options.playedSpinRecovery ?? null,
    { generation: 1 },
    Aborted,
    { emitEvent },
    spinPostRevealMs,
    proveWithFreshRegistry,
    raiseFinancialAlert
  );
  return { emitEvent, outcome, context, reportError, raiseFinancialAlert };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a Spin reveals its immutable funded rule receipt', () => {
  it('announces nothing until the atomic transaction returns a valid receipt', async () => {
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
    expect(patch.payout_structure).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);
    expect(patch).not.toHaveProperty('spin_multiplier');
    expect(patch).not.toHaveProperty('prize_pool');
    expect(patch).not.toHaveProperty('starting_chips');
  });

  it('retries a lost response with the same launch and rule payload, then emits once', async () => {
    vi.useFakeTimers();
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValue({ data: { ...receipt(25), replay: true }, error: null });
    const run = start(rpc);

    await vi.runAllTimersAsync();
    const patch = await run.outcome;

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(run.emitEvent).toHaveBeenCalledOnce();
    expect(patch.payout_structure).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 12 },
      { place: 3, percentage: 8 },
    ]);
  });

  it('uses the booked payout and blind rules after a specification change', async () => {
    const booked = receipt(10);
    const tier = booked.rule_manifest.tiers.find((candidate) => candidate.multiplier === 10)!;
    tier.blind_structure = tier.blind_structure.map((blind) => ({ ...blind, duration: 240 }));
    tier.payout_structure = [
      { place: 1, percentage: 70 },
      { place: 2, percentage: 30 },
    ];
    booked.blind_structure = tier.blind_structure;
    booked.payout_structure = tier.payout_structure;
    const run = start(vi.fn(async () => ({ data: booked, error: null })));

    const patch = await run.outcome;

    expect(
      patch.blind_structure.every((blind: { duration: number }) => blind.duration === 240)
    ).toBe(true);
    expect(patch.payout_structure).toEqual(tier.payout_structure);
    expect(patch).not.toHaveProperty('starting_chips');
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
    expect(run.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.spin_draw_unavailable',
      expect.objectContaining({ tournamentId: 'spin' })
    );
    // A transient refusal is not a money alarm.
    expect(run.raiseFinancialAlert).not.toHaveBeenCalled();
  });

  /**
   * 2026-09-10: a refusal the database has said is deterministic for this
   * launch state is asked ONCE, not three times, and it is the operator who
   * hears about it, through one financial alert (spinLaunchParking.ts).
   */
  it.each([
    'projected_spin_draw_has_no_funding_proof',
    'spin_rule_manifest_invalid',
    'invalid_spin_contract',
    'spin_field_unproven',
  ])(
    'stands down after ONE call for the terminal refusal %s and raises one alert',
    async (reason) => {
      vi.useFakeTimers();
      const rpc = vi.fn(async () => ({ data: { ok: false, reason }, error: null }));
      const run = start(rpc);

      await vi.runAllTimersAsync();

      expect(await run.outcome).toBeUndefined();
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(run.emitEvent).not.toHaveBeenCalled();
      expect(run.context.running).toBe(false);
      expect(run.raiseFinancialAlert).toHaveBeenCalledTimes(1);
      expect(run.raiseFinancialAlert).toHaveBeenCalledWith(
        'critical',
        SPIN_LAUNCH_PARKED_ALERT_SOURCE,
        expect.stringContaining(reason),
        expect.objectContaining({ tournament_id: 'spin', launch_id: 'launch', reason })
      );
      expect(run.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'Tournament.spin_draw_refused_terminal',
        expect.objectContaining({ reason })
      );
    }
  );

  it('does not replay a wheel and preserves historical reveal timing for played recovery', async () => {
    const booked = receipt(10);
    const historicalRevealAt = '2026-09-09T11:22:33.444Z';
    const run = start(
      vi.fn(async () => ({ data: booked, error: null })),
      {
        playedSpinRecovery: { recovery: true },
        tournament: { spin_reveal_lag_ms: 915, spin_reveal_at: historicalRevealAt },
      }
    );

    const patch = await run.outcome;

    expect(run.emitEvent).not.toHaveBeenCalled();
    expect(patch.spin_reveal_lag_ms).toBe(915);
    expect(patch.spin_reveal_at).toBe(historicalRevealAt);
    expect(patch.blind_structure).toEqual(booked.blind_structure);
    expect(patch.payout_structure).toEqual(booked.payout_structure);
  });
});

function subscriber(id: string) {
  const outbox: string[] = [];
  const value: HubSubscriber = {
    id,
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string) => {
      outbox.push(data);
    },
  };
  return {
    value,
    reveals: () =>
      outbox
        .map((data) => JSON.parse(data))
        .filter((frame) => frame.type === 'EVENT' && frame.payload?.type === 'spin_reveal'),
  };
}

function admit(
  context: ReturnType<typeof start>['context'],
  hub: Pick<TableStateHub, 'emitEvent'>
) {
  executeAdmission.call(
    context,
    {
      variant: 'spin',
      tournament_type: 'SPIN',
      spin_multiplier: 10,
      buy_in_amount: 1,
      prize_pool: 10,
      spin_locked_tiers: receipt(10).locked,
    },
    0,
    null,
    hub,
    spinPostRevealMs,
    spinRevealTotalMs,
    vi.fn(),
    { log: vi.fn() }
  );
}

describe('the admitted Spin hold stays reachable through the real replay hub', () => {
  it('keeps the identical funded draw available throughout an extended first-deal hold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const hub = new TableStateHub();
    const participants = ['first', 'second', 'third'].map(subscriber);
    for (const participant of participants) hub.subscribe('table', participant.value);
    const run = start(
      vi.fn(async () => ({ data: receipt(10), error: null })),
      { hub }
    );
    await run.outcome;
    const original = participants[0].reveals()[0].payload;
    for (const participant of participants) {
      expect(participant.reveals()).toHaveLength(1);
      expect(participant.reveals()[0].payload).toEqual(original);
    }
    expect(original.hold_until).toBe(10000);

    vi.setSystemTime(9500);
    admit(run.context, hub);
    const extendedHold = 9500 + spinPostRevealMs();
    expect(extendedHold).toBeGreaterThan(original.hold_until);
    expect(run.context.tableEngines.get('table')!.holdDealingUntil).toHaveBeenLastCalledWith(
      extendedHold
    );

    vi.setSystemTime(10001);
    const reconnected = subscriber('reconnected');
    hub.subscribe('table', reconnected.value);
    expect(reconnected.reveals()).toHaveLength(1);
    expect(reconnected.reveals()[0].payload).toMatchObject({
      tournament_id: original.tournament_id,
      multiplier: original.multiplier,
      prize_pool: original.prize_pool,
      locked_tiers: original.locked_tiers,
      reveal_at: original.reveal_at,
      hold_until: extendedHold,
      replay_until: extendedHold,
      replayed: true,
    });
    hub.resync('table', reconnected.value);
    expect(reconnected.reveals()).toHaveLength(1);

    vi.setSystemTime(extendedHold);
    const afterDeal = subscriber('after-deal');
    hub.subscribe('table', afterDeal.value);
    expect(afterDeal.reveals()).toHaveLength(0);
  });

  it('does not send an unchanged reveal twice on an ordinary quick admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const hub = new TableStateHub();
    const first = subscriber('first');
    hub.subscribe('table', first.value);
    const run = start(
      vi.fn(async () => ({ data: receipt(10), error: null })),
      { hub }
    );
    await run.outcome;
    vi.setSystemTime(2000);
    admit(run.context, hub);
    expect(first.reveals()).toHaveLength(1);
    expect(run.context.tableEngines.get('table')!.holdDealingUntil).toHaveBeenLastCalledWith(10000);
  });

  it('the admission pass sends a reveal that the early emitter failed to retain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const hub = new TableStateHub();
    const first = subscriber('first');
    hub.subscribe('table', first.value);
    const run = start(
      vi.fn(async () => ({ data: receipt(10), error: null })),
      {
        hub: {
          emitEvent: vi.fn(() => {
            throw new Error('early emit failed');
          }),
        },
      }
    );
    await run.outcome;
    expect(first.reveals()).toHaveLength(0);
    vi.setSystemTime(2000);
    admit(run.context, hub);
    expect(first.reveals()).toHaveLength(1);
    expect(first.reveals()[0].payload).toMatchObject({
      multiplier: 10,
      prize_pool: 10,
      reveal_at: 1000,
    });
  });
});
