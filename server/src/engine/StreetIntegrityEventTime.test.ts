import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { HandContinuationLane } from './HandContinuationLane.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import {
  decodePrivateHandContinuation,
  encodePrivateHandContinuation,
} from './PrivateHandContinuation.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';

vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const seats = (): SeatPlayer[] =>
  [1, 2].map((seat) => ({
    user_id: `u${seat}`,
    username: `u${seat}`,
    seat,
    stack: 13500,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];

afterEach(() => vi.clearAllMocks());

async function delayedStreet(extraStreetChip = 0) {
  const players = seats();
  const engine = new ServerTableEngine(TABLE) as any;
  const controller = new HandController(
    {
      tableId: TABLE,
      handNumber: 51922256,
      gameVariant: 'nlh',
      smallBlind: 223,
      bigBlind: 446,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  engine.handController = controller;
  engine.handCount = 51922256;
  engine.broadcastCurrentState = vi.fn();
  engine.hub = { emitEvent: vi.fn() };
  engine.stateVerifier.recordInitialChipTotal(TABLE, players);
  const measured: any[] = [];
  const measure = engine.stateVerifier.measure.bind(engine.stateVerifier);
  vi.spyOn(engine.stateVerifier, 'measure').mockImplementation((context: any) => {
    measured.push(structuredClone(context));
    return measure(context);
  });
  const persisted: any[] = [];
  let release!: () => void;
  const retention = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = new HandContinuationLane(
    0,
    () => controller.serializeRecoveryState(),
    () => ({}),
    async (batch) => {
      const encoded = encodePrivateHandContinuation({
        version: 1,
        original: { table_id: TABLE } as any,
        seats: players.map((p) => ({
          user_id: p.user_id,
          seat_id: p.user_id,
          seat_joined_at: '2026-10-29T00:00:00Z',
          stack_before: p.stack,
        })),
        batch: structuredClone(batch),
      });
      persisted.push(decodePrivateHandContinuation(encoded.payload, encoded.sha256).batch);
      await retention;
    },
    async (event) => {
      await engine.handleHandEvent(event, []);
    },
    () => true,
    (error) => {
      throw error;
    }
  );
  const communities: HandEvent[] = [];
  let complete = false;
  controller.onEvent((event) => {
    if (event.type === 'COMMUNITY_CARDS') {
      communities.push(event);
      lane.enqueue(engine.captureStreetIntegrityEvent(event, controller));
    }
    if (event.type === 'HAND_COMPLETE') complete = true;
  });
  controller.start();
  // A genuine stack defect during the street must remain visible even when a
  // later mutation happens to cancel it before this event's delayed dispatch.
  if (extraStreetChip) (controller as any).state.players[0].stack += extraStreetChip;
  for (let n = 0; n < 20 && !complete; n++) {
    const state = controller.getState();
    const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const action = player.bet < state.currentBet ? 'call' : 'check';
    expect(controller.performAction(player.seat, action)).toBe(true);
  }
  expect(complete).toBe(true);
  const settled = controller.getState();
  expect(settled.stage).toBe('showdown');
  expect(settled.pot).toBe(892);
  if (extraStreetChip) (controller as any).state.players[0].stack -= extraStreetChip;
  expect(controller.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(27000);
  expect(engine.stateVerifier.getRecoveryState(TABLE)).toBe('healthy');
  expect(raiseFinancialAlert).not.toHaveBeenCalled();
  release();
  await lane.join();
  return { measured, persisted, communities, engine };
}

describe('street integrity measures the event time before settlement', () => {
  it('retains three event-time verdicts and does not remeasure the later paid stacks', async () => {
    const { measured, persisted, communities, engine } = await delayedStreet();
    expect(communities).toHaveLength(3);
    expect(persisted[0].events).toHaveLength(3);
    expect(persisted[0].events.map((e: any) => e.integrityVerification.stage)).toEqual([
      'flop',
      'turn',
      'river',
    ]);
    for (const event of persisted[0].events) {
      expect(event.integrityVerification).not.toHaveProperty('players');
      expect(event.integrityVerification).not.toHaveProperty('communityCards');
      expect(event.integrityVerification).not.toHaveProperty('deck');
      expect(event.integrityVerification.result.violations).toEqual([]);
    }
    expect(measured.map((m) => m.stage)).toEqual(['flop', 'turn', 'river']);
    expect(
      measured.map(
        (m) => m.players.reduce((sum: number, p: SeatPlayer) => sum + p.stack, 0) + m.pot
      )
    ).toEqual([27000, 27000, 27000]);
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
    for (const [, frame] of engine.hub.emitEvent.mock.calls) {
      expect(frame).not.toHaveProperty('integrityVerification');
    }
  });

  it('still reports actual street drift even if the later live stacks look conserved', async () => {
    const { measured, engine, persisted } = await delayedStreet(1);
    expect(engine.stateVerifier.getRecoveryState(TABLE)).toBe('resync_required');
    expect(measured).toHaveLength(3);
    expect(raiseFinancialAlert).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(raiseFinancialAlert).mock.calls) {
      expect(call[0]).toBe('critical');
      expect(call[3]).toMatchObject({
        drift: 1,
        expectedChipTotal: 27000,
        chipTotal: 27001,
        pot: 892,
      });
    }
    const recovered = new ServerTableEngine(TABLE) as any;
    recovered.handController = engine.handController;
    recovered.broadcastCurrentState = vi.fn();
    recovered.hub = { emitEvent: vi.fn() };
    const remeasure = vi.spyOn(recovered.stateVerifier, 'measure');
    await recovered.handleHandEvent(persisted[0].events[0], []);
    expect(remeasure).not.toHaveBeenCalled();
    expect(recovered.stateVerifier.getRecoveryState(TABLE)).toBe('resync_required');
    expect(raiseFinancialAlert).toHaveBeenLastCalledWith(
      'critical',
      'ServerTableEngine.street_integrity_violation',
      expect.any(String),
      expect.objectContaining({ drift: 1, handNumber: 51922256, stage: 'flop' })
    );
  });
});
