/**
 * HORSES ARE PLAYERS: the 2026-10-04 ruling "an ALL IN press where only a call
 * is legal counts as a call" is tolerance for a CHOSEN all-in, for a horse
 * exactly as for a human. A sized bet/raise of the whole stack is promoted to
 * `all_in` on the horse commit path just as it is on the human request path,
 * and where the engine offers that seat no shove the sized wager was illegal:
 * it must be refused (the horse takes its refused-action path, check else
 * fold), never silently executed as a call the horse did not choose.
 *
 * And whatever the controller executes is what every ledger records, with or
 * without an execution witness: `all_in` is never written for a call.
 *
 * These cases drive the real scheduleHorseAction commit path against a real
 * HandController; only the decision worker's answer is supplied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandConfig, HorseDecision, SeatPlayer } from '../types.js';
import type { FastHorseDecisionResult } from './horseDecision/protocol.js';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
  commitDecisionEffects: vi.fn(async () => undefined),
  runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { createHorseExecutionWitness } from './HorseExecutionWitness.js';
import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';

const TABLE = 'fa100000-0000-4000-8000-0000000000a1';

// Seats: 1=Dealer, 2=SB (8 chips), 3=BB, 4=UTG. Preflop order: 4, 1, 2, 3.
// UTG raises to 6, Dealer calls, SB shoves 8 total: a 2 increment against a
// last raise of 4, so it is a SHORT all-in that reopens betting to nobody who
// has already acted.
//   'may_reopen'    -> the BB (seat 3) is on the clock; it has not acted, so
//                      it may raise and the engine offers it all_in.
//   'may_not_reopen'-> the BB calls and UTG (seat 4) is on the clock; it has
//                      acted and faces only the short all-in: fold or call.
function harness(spot: 'may_reopen' | 'may_not_reopen') {
  const players = [200, 8, 200, 200].map((stack, i) => ({
    seat: i + 1,
    user_id: `fa200000-0000-4000-8000-0000000000a${i + 1}`,
    username: `Horse ${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.start();
  expect(hc.performAction(4, 'raise', 6)).toBe(true);
  expect(hc.performAction(1, 'call')).toBe(true);
  expect(hc.performAction(2, 'all_in')).toBe(true);
  if (spot === 'may_not_reopen') expect(hc.performAction(3, 'call')).toBe(true);
  const state = hc.getState();
  expect(state.currentBet).toBe(8);
  const seat = state.currentPlayerSeat!;
  expect(seat).toBe(spot === 'may_reopen' ? 3 : 4);
  const enginePlayer = state.players.find((p) => p.seat === seat)!;
  const legalActions = hc.getAuthoritativeActionState(enginePlayer.user_id)!.legalActions;
  expect(legalActions.includes('all_in')).toBe(spot === 'may_reopen');
  expect(legalActions).toContain('call');
  const player = {
    seat_number: seat,
    user_id: enginePlayer.user_id,
    username: enginePlayer.username,
    stack: enginePlayer.stack,
    is_horse: true,
    horse_profile: {},
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 1;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, small_blind: 1, game_variant: 'nlh' };
  engine.seatedPlayers = [player];
  engine.handController = hc;
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
  engine.timeBankEngine = { isArmed: () => false, getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '9' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  const history = hc.getState().actionHistory.length;
  const perform = vi.spyOn(hc, 'performAction');
  const live = () => (hc as unknown as { state: any }).state;
  return {
    engine,
    player,
    enginePlayer,
    hc,
    state,
    seat,
    perform,
    /** Every record the engine accepted after the horse was put on the clock. */
    accepted: () => live().actionHistory.slice(history) as any[],
    hero: () => live().players.find((p: SeatPlayer) => p.seat === seat) as SeatPlayer,
    async run() {
      engine.scheduleHorseAction(player, seat, enginePlayer, state);
      await vi.advanceTimersByTimeAsync(300);
    },
  };
}

/** A minimal Phase 7 utility ledger: what the horse selected, pending execution. */
function utilityLedger(selectedAction: string, selectedAmount: number | null) {
  return {
    selectedAction,
    selectedAmount,
    executedAction: null,
    executedAmount: null,
    executionStatus: 'pending',
  } as unknown as NonNullable<HorseDecision['tournamentUtility']>;
}

function answer(decision: HorseDecision, opts: { witness: boolean }) {
  let witness: ReturnType<typeof createHorseExecutionWitness> | undefined;
  worker.decideFast.mockImplementationOnce(async (snapshot): Promise<FastHorseDecisionResult> => {
    if (opts.witness) {
      witness = createHorseExecutionWitness(snapshot, decision, {
        requestId: 1,
        lane: 'fast',
        computeMs: 1,
        governorScale: 1,
      });
    }
    return {
      type: 'FAST_RESULT',
      planIssueDisposition: 'no_effects',
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
      requestId: 1,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: opts.witness ? { ...decision, executionWitness: witness } : decision,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 1,
      governorScale: 1,
      effects: [],
    };
  });
  return () => witness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([true, false])(
  'a horse raise of its whole stack where the seat may not reopen (witness: %s)',
  (withWitness) => {
    it('is refused like any illegal raise and never becomes a call', async () => {
      const h = harness('may_not_reopen');
      const ledger = utilityLedger('raise', 200);
      // raise-to 200 is this seat's whole stack (194 behind + 6 in): the commit
      // path promotes it to all_in, which the engine does not offer this seat.
      const witness = answer(
        { action: 'raise', amount: 200, thinkTime: 1, tournamentUtility: ledger },
        { witness: withWitness }
      );
      await h.run();

      // The promoted shove is never submitted; the refused path checks, then folds.
      expect(h.perform.mock.calls.map((c) => c[1])).toEqual(['check', 'fold']);
      expect(h.perform.mock.calls.map((c) => c[3])).toEqual(['horse_fallback', 'horse_fallback']);
      expect(h.accepted()).toHaveLength(1);
      expect(h.accepted()[0]).toMatchObject({ seat: h.seat, action: 'fold' });
      // Not one chip followed the bet it never chose to call.
      expect(h.hero()).toMatchObject({ stack: 194, bet: 6, is_folded: true, is_all_in: false });
      expect(ledger).toMatchObject({
        executedAction: 'fold',
        executedAmount: null,
        executionStatus: 'fallback',
      });
      if (withWitness) {
        expect(witness()).toMatchObject({ executionStatus: 'fallback', executedAction: 'fold' });
      }
      expect(worker.commitDecisionEffects).not.toHaveBeenCalled();
    });
  }
);

describe.each([true, false])(
  'a horse shove that IS legal still shoves (witness: %s)',
  (withWitness) => {
    it('a horse-chosen all_in goes all-in and is recorded as all_in', async () => {
      const h = harness('may_reopen');
      const ledger = utilityLedger('all_in', null);
      const witness = answer(
        { action: 'all_in', thinkTime: 1, tournamentUtility: ledger },
        { witness: withWitness }
      );
      await h.run();

      expect(h.perform).toHaveBeenCalledOnce();
      expect(h.perform.mock.calls[0].slice(0, 4)).toEqual([
        h.seat,
        'all_in',
        undefined,
        'horse_policy',
      ]);
      expect(h.accepted()).toHaveLength(1);
      expect(h.accepted()[0]).toMatchObject({ seat: h.seat, action: 'all_in', amount: 200 });
      expect(h.hero()).toMatchObject({ stack: 0, bet: 200, is_all_in: true });
      expect(ledger).toMatchObject({
        executedAction: 'all_in',
        executedAmount: null,
        executionStatus: 'intended',
      });
      if (withWitness) {
        expect(witness()).toMatchObject({ executionStatus: 'intended', executedAction: 'all_in' });
      }
    });

    it('a whole-stack raise the engine DOES offer as a shove is still promoted and accepted', async () => {
      const h = harness('may_reopen');
      answer({ action: 'raise', amount: 200, thinkTime: 1 }, { witness: withWitness });
      await h.run();

      expect(h.perform).toHaveBeenCalledOnce();
      expect(h.perform.mock.calls[0].slice(0, 4)).toEqual([
        h.seat,
        'all_in',
        undefined,
        'horse_policy',
      ]);
      expect(h.accepted()).toHaveLength(1);
      expect(h.accepted()[0]).toMatchObject({ seat: h.seat, action: 'all_in', amount: 200 });
      expect(h.hero()).toMatchObject({ stack: 0, is_all_in: true });
    });
  }
);

describe('the recorded executed action is the engine record, witness or not', () => {
  it.each([true, false])(
    'a horse-chosen all_in that the engine executes as a call is recorded as a call (witness: %s)',
    async (withWitness) => {
      const h = harness('may_not_reopen');
      const ledger = utilityLedger('all_in', null);
      const witness = answer(
        { action: 'all_in', thinkTime: 1, tournamentUtility: ledger },
        { witness: withWitness }
      );
      await h.run();

      // The chosen ALL IN is the button: one submission, executed as the call.
      expect(h.perform).toHaveBeenCalledOnce();
      expect(h.perform.mock.calls[0][1]).toBe('all_in');
      expect(h.accepted()).toHaveLength(1);
      const record = h.accepted()[0];
      expect(record).toMatchObject({ seat: h.seat, action: 'call', amount: 2 });
      expect(h.hero()).toMatchObject({ stack: 192, bet: 8, is_all_in: false, is_folded: false });
      // The ledger says what the engine did, never the `all_in` that was sent.
      expect(ledger.executedAction).toBe(record.action);
      expect(ledger.executedAmount).toBe(record.amount);
      expect(ledger.executionStatus).toBe('coerced');
      if (withWitness) expect(witness()?.executedAction).not.toBe('all_in');
    }
  );
});
