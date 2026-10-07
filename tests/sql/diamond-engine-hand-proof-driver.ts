// Invoked only by run-diamond-engine-hand-proof.py, with an isolated database's
// seats and published Diamond economics. Plays REAL hands on the engine's own
// HandController and writes the settlement payload exactly as the engine's
// settlement step builds it, for the runner to hand to the real settler.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.mock('../../server/src/services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../../server/src/services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
import { HandController } from '../../server/src/engine/HandController.js';
import { diamondCashRakeFactsFor } from '../../server/src/engine/diamondCashRakeFacts.js';
import {
  captureHandSeatGenerations,
  handStackBefore,
  requireHandSeatGeneration,
} from '../../server/src/engine/handSeatGeneration.js';
import {
  priceDiamondCashRake,
  resolveDiamondCashRakeSchedule,
  type EconomicsRow,
} from '../../server/src/domain/diamondCashRakeSchedule.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../../server/src/types.js';

interface InputSeat {
  user_id: string;
  seat_id: string;
  seat_joined_at: string;
  seat_number: number;
  stack: number;
  is_horse: boolean;
}

type Scenario = 'showdown' | 'fold_preflop' | 'raise_and_fold' | 'all_in';

/** The settlement step's own rounding (ServerTableEngineSettlement `cents`). */
const cents = (n: number): number => Math.round(n * 100) / 100;

it('plays real Diamond cash hands and records the payload the engine would send', () => {
  const input = process.env.DIAMOND_ENGINE_PROOF_INPUT;
  const output = process.env.DIAMOND_ENGINE_PROOF_OUTPUT;
  if (!input || !output) throw new Error('Use The Isolated Engine Hand Proof Runner');
  const spec = JSON.parse(readFileSync(input, 'utf8')) as {
    table_id: string;
    small_blind: number;
    big_blind: number;
    first_hand_number: number;
    economics: EconomicsRow[];
    seats: InputSeat[];
    scenarios: Scenario[];
  };

  /* THE SCHEDULE IS READ THE WAY THE ENGINE READS IT AT THE DEAL:
     services/supabase/diamondCashRakeSettings.ts selects these rows from
     ca_diamond_economics and hands them to this same resolver. The rows here
     ARE the isolated database's rows, which are production's published ones. */
  const schedule = resolveDiamondCashRakeSchedule(spec.economics, spec.big_blind);

  const stacks = new Map(spec.seats.map((s) => [s.user_id, Number(s.stack)]));
  const hands: unknown[] = [];
  let handNumber = spec.first_hand_number;

  for (const scenario of spec.scenarios) {
    const live = spec.seats.filter((s) => (stacks.get(s.user_id) ?? 0) > 0);
    if (live.length < 2) break;
    const players: SeatPlayer[] = live.map(
      (s) =>
        ({
          seat: s.seat_number,
          user_id: s.user_id,
          username: s.is_horse ? 'Isolated Horse' : 'Isolated Player',
          stack: stacks.get(s.user_id)!,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          is_horse: s.is_horse,
        }) as unknown as SeatPlayer
    );
    /* What the engine captures at the deal (ServerTableEngineDealing): the
       seat generations and the dealt stacks, keyed by user. */
    const generations = captureHandSeatGenerations(
      live.map((s) => ({
        user_id: s.user_id,
        seat_id: s.seat_id,
        seat_joined_at: s.seat_joined_at,
      }))
    );
    const dealtStacks = new Map(players.map((p) => [p.user_id, Number(p.stack) || 0]));
    const config = {
      asset: 'diamonds',
      tableId: spec.table_id,
      handNumber,
      gameVariant: 'nlh',
      smallBlind: spec.small_blind,
      bigBlind: spec.big_blind,
      // A Diamond table's chip columns are explicitly zero (DiamondCashBoundary).
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      diamondRakeSchedule: schedule,
    } as unknown as HandConfig;
    const hc = new HandController(config, players, 1);

    /* What the engine captures at WINNERS (ServerTableEngineHandEvents) and at
       HAND_COMPLETE: each player's totalInvested, the money-facing flop fact,
       and the rake. */
    const contributions = new Map<string, number>();
    let sawFlopForMoney = false;
    let completed: { rake: number; bbjFee: number } | null = null;
    hc.onEvent((event: HandEvent) => {
      if (event.type === 'WINNERS') {
        sawFlopForMoney = hc.handSawFlopForMoney();
        for (const p of hc.getState().players) contributions.set(p.user_id, p.totalInvested ?? 0);
      }
      if (event.type === 'HAND_COMPLETE') {
        completed = {
          rake: (event as never as { rake: number }).rake,
          bbjFee: (event as never as { bbjFee: number }).bbjFee,
        };
      }
    });
    hc.start();
    let raised = false;
    for (let step = 0; step < 400 && completed === null; step++) {
      const state = hc.getState();
      const p = state.players.find((x) => x.seat === state.currentPlayerSeat);
      if (!p || p.is_all_in || p.is_folded) {
        hc.continueRunout();
        continue;
      }
      if (scenario === 'all_in' && hc.performAction(p.seat, 'all_in')) continue;
      if (scenario === 'fold_preflop' && state.stage === 'preflop' && p.bet < state.currentBet) {
        if (hc.performAction(p.seat, 'fold')) continue;
      }
      if (scenario === 'raise_and_fold' && state.stage === 'preflop') {
        if (!raised) {
          const to = Math.min(p.stack + p.bet, state.currentBet * 3);
          if (hc.performAction(p.seat, 'raise', to)) {
            raised = true;
            continue;
          }
        } else if (p.bet < state.currentBet && hc.performAction(p.seat, 'fold')) {
          continue;
        }
      }
      if (hc.performAction(p.seat, p.bet < state.currentBet ? 'call' : 'check')) continue;
      hc.continueRunout();
    }
    expect(completed, `hand ${handNumber} (${scenario}) never completed`).not.toBeNull();
    const done = completed as unknown as { rake: number; bbjFee: number };
    const end = hc.getState();

    /* THE PAYLOAD, COMPOSED EXACTLY AS ServerTableEngineSettlement COMPOSES
       `atomicCommit.stacks` for a Diamond cash hand. The runner also pins the
       settlement source so this composition cannot drift from it unseen. */
    const elements = end.players.map((p) => ({
      ...requireHandSeatGeneration(generations, p.user_id),
      user_id: p.user_id,
      stack: cents(p.stack),
      stack_before: cents(handStackBefore(generations, dealtStacks, p.user_id, p.stack)),
      ...diamondCashRakeFactsFor({
        userId: p.user_id,
        contributions,
        dealtStacks,
        handSawFlop: sawFlopForMoney,
      }),
    }));

    // The engine's own invariants, before the database is asked anything.
    const pot = [...contributions.values()].reduce((n, v) => n + v, 0);
    expect(done.rake).toBe(
      priceDiamondCashRake(schedule, { pot, dealtIn: end.players.length, sawFlop: sawFlopForMoney })
    );
    expect(done.bbjFee).toBe(0);
    const before = elements.reduce((n, e) => n + e.stack_before, 0);
    const after = elements.reduce((n, e) => n + e.stack, 0);
    expect(before - after).toBe(done.rake);

    hands.push({
      hand_number: handNumber,
      scenario,
      rake: done.rake,
      pot,
      saw_flop: sawFlopForMoney,
      dealt_in: end.players.length,
      elements,
    });
    for (const p of end.players) stacks.set(p.user_id, p.stack);
    handNumber++;
  }
  expect(hands.length).toBeGreaterThanOrEqual(3);
  writeFileSync(output, JSON.stringify({ hands }));
});
