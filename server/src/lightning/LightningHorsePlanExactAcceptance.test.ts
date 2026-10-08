/**
 * PHASE 15 PRESERVED BOUNDARY AT A LIGHTNING TABLE: a horse's plan effects
 * apply only for the exact accepted action.
 *
 * The Lightning host reshapes a horse's wager for its table
 * (shapeLightningHorseAction and the action door) and its controller can
 * refuse one. Until 2026-10-07 the host committed the decision's plan effects
 * for whatever bet or raise it had shaped, so a plan written for one wager was
 * applied after a different one landed. These hands run through the real
 * host, the real HandController and a real execution witness; the lane is a
 * recording stand-in that issues a plan batch for every decision and, like the
 * client, retires an uncommitted batch when its witness is finalized.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HorseExecutionWitness } from '../engine/HorseExecutionWitness.js';
import type { HorsePlanAcceptance } from '../engine/HorsePlanEffectReceipt.js';
import type {
  FastHorseDecisionResult,
  LiveHorseDecisionLane,
  LiveHorseDecisionSnapshot,
} from '../engine/horseDecision/index.js';
import type { HorseDecision } from '../types.js';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning host fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning host fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const kit = await import('../testing/lightningHostTestKit.js');
const { createHorseExecutionWitness, onHorseExecutionFinalized } =
  await import('../engine/HorseExecutionWitness.js');
const { buildHost, formedHand, flush } = kit;

afterEach(() => {
  vi.useRealTimers();
});

type Decide = (snap: LiveHorseDecisionSnapshot) => { action: string; amount?: number };

interface Issued {
  snap: LiveHorseDecisionSnapshot;
  result: FastHorseDecisionResult;
  witness: HorseExecutionWitness;
  /** What the client would have done with this batch: commit or retire. */
  outcome: 'pending' | 'committed' | 'retired';
  acceptance: HorsePlanAcceptance | null;
}

/** call/check by what is owed: the passive answer every other decision gives. */
const gs = (snap: LiveHorseDecisionSnapshot) =>
  snap.gameState as unknown as {
    stage: string;
    toCall: number;
    currentBet: number;
    minRaiseTo: number | null;
    wagersCapped: boolean;
  };
const passive = (snap: LiveHorseDecisionSnapshot) =>
  gs(snap).toCall > 0 ? { action: 'call', amount: gs(snap).toCall } : { action: 'check' };

/**
 * A recording lane. Every decision comes back as an ISSUED plan batch with a
 * real execution witness; the witness finalizer stands in for the client's
 * (LiveHorseDecisionWorkerClient: a finalized witness whose batch was not
 * committed is retired as decision_finalized).
 */
function planLane(decide: Decide, opts: { issue?: boolean } = {}) {
  const issued: Issued[] = [];
  const lane = {
    decideFast: vi.fn(async (snap: LiveHorseDecisionSnapshot) => {
      const answer = decide(snap);
      const decision = {
        action: answer.action,
        amount: answer.amount,
        thinkTime: 300,
      } as unknown as HorseDecision;
      const witness = createHorseExecutionWitness(snap, decision, {
        requestId: issued.length + 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
      decision.executionWitness = witness;
      const issue = opts.issue !== false;
      const result = {
        type: 'FAST_RESULT',
        requestId: issued.length + 1,
        generation: snap.generation,
        fence: snap.fence,
        decision,
        planBinding: issue ? { version: 'horse-plan-batch-v1', fence: snap.fence } : null,
        planIssueDisposition: issue ? 'issued' : 'no_effects',
        effects: issue ? [{ type: 'plan', userId: snap.player.user_id }] : [],
        rngBefore: 0,
        rngAfter: 0,
        computeMs: 1,
        governorScale: 1,
      } as unknown as FastHorseDecisionResult;
      const entry: Issued = { snap, result, witness, outcome: 'pending', acceptance: null };
      issued.push(entry);
      onHorseExecutionFinalized(witness, () => {
        if (issue && entry.outcome === 'pending') entry.outcome = 'retired';
      });
      return result;
    }),
    commitDecisionEffects: vi.fn(
      async (result: FastHorseDecisionResult, acceptance: HorsePlanAcceptance) => {
        const entry = issued.find((e) => e.result === result)!;
        entry.outcome = 'committed';
        entry.acceptance = acceptance;
        return { type: 'ACK', operation: 'COMMIT_DECISION_EFFECTS' } as never;
      }
    ),
    runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
  };
  return { lane: lane as unknown as LiveHorseDecisionLane, raw: lane, issued };
}

async function playHand(
  decide: Decide,
  opts: {
    issue?: boolean;
    rules?: Record<string, unknown>;
    stacks?: number[];
    base?: number;
    refuseFirstWager?: boolean;
  } = {}
) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const formed = formedHand(2, opts.base ?? 3100);
  const stacks = opts.stacks ?? [100, 100];
  const plan = planLane(decide, { issue: opts.issue });
  const t = buildHost(formed, stacks, {
    horses: new Set(formed.players),
    rules: opts.rules,
    deps: { horseLane: () => plan.lane },
  });
  await t.host.start();
  if (opts.refuseFirstWager) {
    // The controller refuses the first sized wager it is offered, once.
    const hc = (t.host as any).hc;
    const real = hc.performAction.bind(hc);
    let refused = false;
    hc.performAction = (...args: any[]) => {
      if (!refused && (args[1] === 'bet' || args[1] === 'raise')) {
        refused = true;
        return false;
      }
      return real(...args);
    };
  }
  for (let i = 0; i < 1_800 && t.host.lifecycle === 'dealing'; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(4);
  }
  expect(t.host.lifecycle).toBe('complete');
  const actions = ((t.host as any).actions as Array<Record<string, unknown>>).map((a) => ({
    seat: a.seat,
    action: a.action,
    amount: a.amount,
    stage: a.stage,
    origin: a.origin,
  }));
  const settle = t.calls.settle[0] as any;
  const contributed = Object.fromEntries(
    (settle.results as any[]).map((r) => [r.playerId, r.contributed])
  );
  return { t, plan, actions, contributed };
}

/** The first flop decision gets `scenario`; every other answer is passive. */
function onFirstFlopDecision(scenario: Decide): Decide {
  let done = false;
  return (snap) => {
    if (!done && gs(snap).stage === 'flop') {
      done = true;
      return scenario(snap);
    }
    return passive(snap);
  };
}

function scenarioEntry(plan: ReturnType<typeof planLane>): Issued {
  const flop = plan.issued.filter((e) => gs(e.snap).stage === 'flop');
  expect(flop.length).toBeGreaterThan(0);
  return flop[0]!;
}

describe('Lightning commits a horse plan only for the exact accepted wager', () => {
  it('an exact accepted bet commits, and its acceptance is the issued wager', async () => {
    const { plan } = await playHand(onFirstFlopDecision(() => ({ action: 'bet', amount: 4 })));
    const entry = scenarioEntry(plan);
    expect(entry.outcome).toBe('committed');
    expect(entry.acceptance).toMatchObject({
      version: 'horse-plan-acceptance-v1',
      action: 'bet',
      amount: 4,
      witness: { requestId: entry.witness.identity.requestId },
    });
    // Issued and accepted are the same wager.
    expect(entry.witness.selected).toEqual({ action: 'bet', amount: 4 });
    expect(entry.witness.executionStatus).toBe('intended');
    expect([entry.witness.executedAction, entry.witness.executedAmount]).toEqual(['bet', 4]);
    expect(plan.raw.commitDecisionEffects).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'a bet under the minimum, lifted to it',
      decide: () => ({ action: 'bet', amount: 1 }),
      selected: { action: 'bet', amount: 1 },
      executed: ['bet', 2],
    },
    {
      name: 'a raise into an unopened pot, aliased to a bet',
      decide: () => ({ action: 'raise', amount: 4 }),
      selected: { action: 'raise', amount: 4 },
      executed: ['bet', 4],
    },
    {
      name: 'a sized bet of the whole stack, promoted to all-in',
      decide: (snap: LiveHorseDecisionSnapshot) => ({
        action: 'bet',
        amount: snap.player.stack,
      }),
      selected: { action: 'bet', amount: 98 },
      executed: ['all_in', 98],
    },
  ])('$name retires the batch unapplied', async ({ decide, selected, executed }) => {
    const { plan } = await playHand(onFirstFlopDecision(decide));
    const entry = scenarioEntry(plan);
    expect(entry.outcome).toBe('retired');
    expect(entry.acceptance).toBeNull();
    // The receipt keeps issued versus accepted: the wager the decision chose
    // and the different one the controller accepted.
    expect(entry.witness.selected).toEqual(selected);
    expect(entry.witness.executionStatus).toBe('coerced');
    expect([entry.witness.executedAction, entry.witness.executedAmount]).toEqual(executed);
    expect(plan.raw.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('a fixed-limit bet of the wrong size, snapped to the street size, retires', async () => {
    const { plan } = await playHand(
      onFirstFlopDecision(() => ({ action: 'bet', amount: 3 })),
      {
        rules: { game_variant: 'flh' },
      }
    );
    const entry = scenarioEntry(plan);
    expect(entry.outcome).toBe('retired');
    expect(entry.witness.selected).toEqual({ action: 'bet', amount: 3 });
    expect(entry.witness.executionStatus).toBe('coerced');
    expect([entry.witness.executedAction, entry.witness.executedAmount]).toEqual(['bet', 2]);
    expect(plan.raw.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('on a capped fixed-limit street the substituted call retires; exact wagers before it commit', async () => {
    const { plan } = await playHand(
      (snap) => {
        if (gs(snap).stage !== 'flop') return passive(snap);
        return {
          action: gs(snap).currentBet > 0 ? 'raise' : 'bet',
          amount: gs(snap).minRaiseTo ?? undefined,
        };
      },
      { rules: { game_variant: 'flh' } }
    );
    const flop = plan.issued.filter((e) => gs(e.snap).stage === 'flop');
    const capped = flop.filter((e) => gs(e.snap).wagersCapped);
    const open = flop.filter((e) => !gs(e.snap).wagersCapped);
    expect(open.length).toBeGreaterThanOrEqual(4);
    expect(capped.length).toBeGreaterThanOrEqual(1);
    for (const e of open) {
      expect(e.outcome).toBe('committed');
      expect(e.acceptance).toMatchObject({
        action: e.witness.selected.action,
        amount: e.witness.selected.amount,
      });
    }
    for (const e of capped) {
      expect(e.outcome).toBe('retired');
      expect(e.witness.selected.action).toBe('raise');
      expect(e.witness.executedAction).toBe('call');
    }
  });

  it('a refused wager degraded to check retires the batch as a fallback', async () => {
    const { plan } = await playHand(
      onFirstFlopDecision(() => ({ action: 'bet', amount: 4 })),
      {
        refuseFirstWager: true,
      }
    );
    const entry = scenarioEntry(plan);
    expect(entry.outcome).toBe('retired');
    expect(entry.witness.selected).toEqual({ action: 'bet', amount: 4 });
    expect(entry.witness.executionStatus).toBe('fallback');
    expect(entry.witness.executedAction).toBe('check');
    expect(plan.raw.commitDecisionEffects).not.toHaveBeenCalled();
  });

  it('every issued batch reaches a terminal outcome: none is left owned', async () => {
    const { plan } = await playHand(onFirstFlopDecision(() => ({ action: 'bet', amount: 1 })));
    expect(plan.issued.length).toBeGreaterThan(1);
    for (const e of plan.issued) {
      expect(e.witness.executionStatus).not.toBe('pending');
      expect(e.outcome).not.toBe('pending');
    }
  });

  it.each([
    ['an exact bet', () => ({ action: 'bet', amount: 4 })],
    ['a lifted bet', () => ({ action: 'bet', amount: 1 })],
    ['an aliased raise', () => ({ action: 'raise', amount: 4 })],
  ] as Array<[string, Decide]>)(
    'the gate changes no chip, pot or action: %s plays the same with and without a plan',
    async (_name, scenario) => {
      const withPlan = await playHand(onFirstFlopDecision(scenario), { base: 3300 });
      const withoutPlan = await playHand(onFirstFlopDecision(scenario), {
        base: 3300,
        issue: false,
      });
      expect(withoutPlan.plan.raw.commitDecisionEffects).not.toHaveBeenCalled();
      expect(withPlan.actions).toEqual(withoutPlan.actions);
      expect(withPlan.contributed).toEqual(withoutPlan.contributed);
    }
  );
});
