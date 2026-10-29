import { afterEach, expect, it, vi } from 'vitest';
const published = vi.hoisted(() =>
  vi.fn(async (_tableId: string, _payload: Record<string, unknown>) => {})
);
vi.mock('../services/timeBankBroadcast.js', () => ({ broadcastTimeBankActivation: published }));
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandContinuationLane, type HandContinuationBatch } from './HandContinuationLane.js';
const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) {
    e.handContinuation?.close();
    e.preciseTimer.dispose();
    e.engineTelemetry.dispose();
  }
  published.mockClear();
  vi.useRealTimers();
});
function fixture() {
  const e: any = new ServerTableEngine('original-paid-clock');
  engines.push(e);
  e.handController = {
    getState: () => ({
      currentPlayerSeat: 3,
      currentBet: 0,
      players: [{ user_id: 'u1', seat: 3, bet: 0 }],
    }),
  };
  e.lifecycleCanMutate = () => true;
  e.seatedPlayers = [{ user_id: 'u1', seat_number: 3, is_horse: false }];
  e.timeBankEngine.configure(e.tableId, { secondsPerUse: 20 });
  e.timeBankEngine.initializePlayer(e.tableId, 'u1', { remainingSeconds: 40, usesRemaining: 2 });
  e.hub = { emitEvent: vi.fn() };
  const retained: HandContinuationBatch[] = [];
  let acknowledge!: () => void;
  const dispatch = (event: any) => e.dispatchContinuationTimeBank(event.event);
  e.handContinuation = new HandContinuationLane(
    0,
    () => JSON.stringify({ privateDeck: ['Ac', 'Kh'] }),
    () => e.captureContinuationEngine(),
    async (batch) => {
      retained.push(structuredClone(batch));
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    },
    dispatch,
    () => true,
    (error) => {
      throw error;
    }
  );
  return { e, retained, release: () => acknowledge(), dispatch };
}
for (const cause of ['manual', 'automatic', 'armed'] as const) {
  it(`retains ${cause} activation before existing public consumers and can replay without spending again`, async () => {
    const { e, retained, release, dispatch } = fixture();
    if (cause === 'manual')
      e.timeBankEngine.tryActivate(e.tableId, 'u1', () => {}, 0, 'manual', true);
    else {
      if (cause === 'armed') e.timeBankEngine.arm(e.tableId, 'u1');
      e.timeBankEngine.onPrimaryTimerExpired(e.tableId, 'u1', () => {}, true);
    }
    await vi.waitFor(() => expect(retained).toHaveLength(1));
    expect(published).not.toHaveBeenCalled();
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    const event: any = retained[0].events[0];
    expect(event.event).toMatchObject({
      type: 'TIME_BANK_ACTIVATED',
      seat: 3,
      secondsGranted: 20,
      usesRemaining: 1,
      activationCause: cause === 'automatic' ? 'automatic' : 'manual',
    });
    const bankBefore = { ...e.timeBankEngine.getPlayerBank(e.tableId, 'u1') };
    release();
    await e.handContinuation.join();
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.calls[0][1]).toMatchObject({
      additional_seconds: 20,
      uses_remaining: 1,
      auto_activated: cause === 'automatic',
    });
    expect(
      e.hub.emitEvent.mock.calls.filter((c: any) => c[1].type === 'time_bank_low')
    ).toHaveLength(1);
    expect(
      e.hub.emitEvent.mock.calls.filter((c: any) => c[1].type === 'time_bank_activated')
    ).toHaveLength(cause === 'automatic' ? 0 : 1);
    // The retained event is the post-restart consumer's input; replay never activates a bank.
    published.mockClear();
    e.hub.emitEvent.mockClear();
    dispatch({
      ...event,
      event: { ...event.event, privateDeck: ['Ac'], futureState: { deck: ['Kh'] } },
    });
    expect(published).toHaveBeenCalledTimes(1);
    expect(e.timeBankEngine.getPlayerBank(e.tableId, 'u1')).toMatchObject({
      remainingSeconds: bankBefore.remainingSeconds,
      usesRemaining: bankBefore.usesRemaining,
      currentUseSeconds: bankBefore.currentUseSeconds,
      streetActivations: bankBefore.streetActivations,
    });
    const publicFrames = JSON.stringify([published.mock.calls, e.hub.emitEvent.mock.calls]);
    expect(publicFrames).not.toContain('privateDeck');
    expect(publicFrames).not.toContain('futureState');
    expect(publicFrames).not.toContain('"Ac"');
  });
}
it('keeps cash activation publication and clocks with its existing callers', async () => {
  const { e, retained } = fixture();
  e.handContinuation.close();
  e.handContinuation = null;
  e.tableInfo = {};
  e.noteOwnClientClaim = () => {};
  e.playerTurnStartTime = Date.now() - 15000;
  e.playerTurnDuration = 15;
  expect(await e.activateTimeBank('u1')).toEqual({ success: true });
  expect(retained).toHaveLength(0);
  expect(published).toHaveBeenCalledTimes(1);
  expect(
    e.hub.emitEvent.mock.calls.filter((c: any) => c[1].type === 'time_bank_activated')
  ).toHaveLength(1);
  expect(e.playerTurnDuration).toBe(20);
  expect(e.timeBankEngine.getPlayerBank(e.tableId, 'u1').pendingPublication).toBe(false);
});
it('replays a privately retained activation after publication was interrupted without charging another use', async () => {
  const { e, retained, dispatch } = fixture();
  let saved: HandContinuationBatch | undefined;
  e.handContinuation.close();
  const failure = vi.fn();
  e.handContinuation = new HandContinuationLane(
    0,
    () => '{}',
    () => e.captureContinuationEngine(),
    async (batch) => {
      saved = structuredClone(batch);
      throw new Error('Lost acknowledgement after durable retain');
    },
    dispatch,
    () => true,
    failure
  );
  e.timeBankEngine.tryActivate(e.tableId, 'u1', () => {}, 0, 'manual', true);
  await expect(e.handContinuation.join()).rejects.toThrow('Lost acknowledgement');
  expect(saved).toBeTruthy();
  expect(published).not.toHaveBeenCalled();
  expect(e.hub.emitEvent).not.toHaveBeenCalled();
  expect(e.timeBankEngine.getUsesRemaining(e.tableId, 'u1')).toBe(1);
  e.handContinuation.close();
  // A successor installs its lane before replaying the exact saved batch.
  e.handContinuation = new HandContinuationLane(
    1,
    () => '{}',
    () => ({}),
    async () => {},
    dispatch,
    () => true,
    failure
  );
  for (const event of saved!.events) dispatch(event);
  expect(published).toHaveBeenCalledTimes(1);
  expect(e.timeBankEngine.getUsesRemaining(e.tableId, 'u1')).toBe(1);
  expect(e.hub.emitEvent.mock.calls.map((c: any) => c[1].type)).toEqual([
    'time_bank_low',
    'time_bank_activated',
  ]);
});
it('starts the full paid clock after an eight-second retain delay and restores an unpublished allocation without charging again', async () => {
  vi.useFakeTimers();
  const { e, retained, release, dispatch } = fixture();
  e.tableInfo = {};
  e.noteOwnClientClaim = () => {};
  e.playerTurnStartTime = Date.now() - 15000;
  e.playerTurnDuration = 15;
  const activation = e.activateTimeBank('u1');
  await Promise.resolve();
  await Promise.resolve();
  expect(retained).toHaveLength(1);
  expect(e.preciseTimer.getDeadline(e.tableId, 'timebank:u1')).toBe(0);
  expect(e.preciseTimer.getDeadline(e.tableId, 'u1')).toBe(0);
  await vi.advanceTimersByTimeAsync(8000);
  expect(published).not.toHaveBeenCalled();
  const saved = retained[0];
  release();
  await e.handContinuation.join();
  expect(await activation).toEqual({ success: true });
  expect(published).toHaveBeenCalledTimes(1);
  expect(
    e.hub.emitEvent.mock.calls.filter((c: any) => c[1].type === 'time_bank_activated')
  ).toHaveLength(1);
  expect(e.playerTurnDuration).toBe(20);
  expect(e.preciseTimer.getDeadline(e.tableId, 'timebank:u1') - Date.now()).toBe(20000);
  expect(e.timeBankEngine.getUsesRemaining(e.tableId, 'u1')).toBe(1);
  const bankCapture: any = (saved.engine.timeBanks as any[])[0];
  expect(bankCapture.bank.pendingPublication).toBe(true);
  const next = fixture();
  next.e.timeBankEngine.restorePlayerForRecovery(
    next.e.tableId,
    'u1',
    bankCapture.bank,
    Number(saved.engine.capturedAt)
  );
  await vi.advanceTimersByTimeAsync(8000);
  // Replay owns the allocation's full remaining grant; outage time was not play time.
  next.dispatch(saved.events[0]);
  expect(next.e.playerTurnDuration).toBe(20);
  expect(next.e.preciseTimer.getDeadline(next.e.tableId, 'timebank:u1') - Date.now()).toBe(20000);
  expect(next.e.timeBankEngine.getUsesRemaining(next.e.tableId, 'u1')).toBe(1);
  expect(next.e.ownsContinuationTimeBankClock()).toBe(true);
  const deadline = next.e.preciseTimer.getDeadline(next.e.tableId, 'timebank:u1');
  next.dispatch(saved.events[0]);
  expect(next.e.preciseTimer.getDeadline(next.e.tableId, 'timebank:u1')).toBe(deadline);
  expect(next.e.timeBankEngine.getUsesRemaining(next.e.tableId, 'u1')).toBe(1);
});
it('resumes an allocated bank from a later empty-event checkpoint and holds it while retention is unknown', async () => {
  const { e, retained, release } = fixture();
  e.timeBankEngine.tryActivate(e.tableId, 'u1', () => {}, 0, 'manual', true);
  await Promise.resolve();
  await Promise.resolve();
  const capture: any = retained[0].engine;
  const bank = capture.timeBanks[0].bank;
  const next = fixture();
  next.e.timeBankEngine.restorePlayerForRecovery(
    next.e.tableId,
    'u1',
    bank,
    Number(capture.capturedAt)
  );
  await next.e.handleTurnChange(
    { type: 'TURN_CHANGE', seat: 3, availableActions: [] },
    next.e.seatedPlayers
  );
  expect(next.e.playerTurnDuration).toBe(20);
  expect(next.e.timeBankEngine.getUsesRemaining(next.e.tableId, 'u1')).toBe(1);
  expect(published).toHaveBeenCalledTimes(1);
  // The original still awaiting its private ACK cannot publish or arm via a reconnect.
  await e.handleTurnChange({ type: 'TURN_CHANGE', seat: 3, availableActions: [] }, e.seatedPlayers);
  expect(e.preciseTimer.getDeadline(e.tableId, 'u1')).toBe(0);
  expect(published).toHaveBeenCalledTimes(1);
  release();
  await e.handContinuation.join();
});
