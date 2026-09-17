import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'aaaaaaaa-1234-4321-9876-aaaaaaaaaaaa';
const PLAYER = 'reconnecting-player';
const engines: any[] = [];

function harness() {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = { action_time_seconds: 15 };
  const state = {
    currentPlayerSeat: 2,
    currentBet: 5,
    stage: 'flop',
    players: [{ user_id: PLAYER, seat: 2, bet: 0, stack: 100 }],
  };
  engine.handController = { getState: () => state };
  engine.seatedPlayers = [{ user_id: PLAYER, seat_number: 2 }];
  engine.hub = { emitEvent: vi.fn() };
  engine.forceResolveSeat = vi.fn(() => true);
  engine.markProgress = vi.fn();
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20, autoActivate: true });
  engine.timeBankEngine.initializePlayer(TABLE, PLAYER, { remainingSeconds: 40, usesRemaining: 2 });
  vi.spyOn(engine.disconnectEngine, 'isConnected').mockReturnValue(true);
  const strikes = vi.spyOn(engine.disconnectEngine, 'recordConnectedTimeout');
  const clocks = vi.spyOn(engine.preciseTimer, 'startTimer');
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const expire = (key = PLAYER) => {
    const call = clocks.mock.calls.filter((args) => args[1] === key).at(-1);
    expect(call, 'the actual clock must have been armed').toBeDefined();
    // PreciseActionTimer drops the expired key before calling its owner.
    engine.preciseTimer.cancelTimer(TABLE, key);
    (call![3] as () => void)();
  };
  return { engine, state, now, clocks, expire, strikes, warnings };
}

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.timeBankEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.restoreAllMocks();
});

describe('a recovered turn clock carries its actual turn state', () => {
  it('reconnects from the disconnected waiting state without adding time or spending a bank', () => {
    const h = harness();
    const deadline = Date.now() + 7_000;
    vi.spyOn(h.engine.disconnectEngine, 'getFsmState').mockReturnValue({
      reconnectDeadlineMs: deadline,
    });
    h.engine.rearmTurnTimerIfCurrent(PLAYER);
    expect(h.engine.turnFSM.state).toBe('timer_running');
    expect(h.engine.playerTurnStartTime + h.engine.playerTurnDuration * 1000).toBe(deadline);
    expect(h.engine.timeBankSuppressedThisTurn).toBe(true);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
    h.now.mockReturnValue(deadline + 2_000);
    h.expire();
    expect(h.engine.forceResolveSeat).toHaveBeenCalledWith(2, false);
    expect(h.engine.turnFSM.state).toBe('complete');
    expect(h.warnings.mock.calls.flat().join('\n')).not.toContain('Invalid transition');
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });

  it('lets the ordinary bank policy run after a fallback primary clock expires', () => {
    const h = harness();
    h.engine.forceArmTurnTimer(2, 15);
    expect(h.engine.turnFSM.state).toBe('timer_running');
    h.now.mockReturnValue(Date.now() + 17_000);
    h.expire();
    expect(h.engine.turnFSM.state).toBe('time_bank_active');
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
    expect(h.engine.forceResolveSeat).not.toHaveBeenCalled();
  });

  it('records a manually activated bank as the active clock', async () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.now.mockReturnValue(Date.now() + 15_000);
    expect(await h.engine.activateTimeBank(PLAYER)).toMatchObject({ success: true });
    expect(h.engine.turnFSM.state).toBe('time_bank_active');
    const before = h.engine.playerTurnStartTime;
    h.engine.rearmTurnTimerIfCurrent(PLAYER);
    expect(h.engine.playerTurnStartTime).toBe(before);
    expect(h.engine.turnFSM.state).toBe('time_bank_active');
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
  });

  it('keeps a refused primary expiry running without reporting an action or counting a strike', () => {
    const h = harness();
    h.engine.forceResolveSeat.mockReturnValue(false);
    h.engine.timeBankSuppressedThisTurn = true;
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.engine.hub.emitEvent.mockClear();
    h.expire();
    expect(h.engine.preciseTimer.hasTimer(TABLE, PLAYER)).toBe(true);
    expect(h.engine.turnFSM.state).toBe('timer_running');
    expect(h.engine.markProgress).not.toHaveBeenCalled();
    expect(h.strikes).not.toHaveBeenCalled();
    expect(
      h.engine.hub.emitEvent.mock.calls.some((args: any[]) => args[1]?.type === 'time_bank_timeout')
    ).toBe(false);
  });

  it('keeps a refused automatic-bank expiry running without completing the replacement clock', () => {
    const h = harness();
    h.engine.forceResolveSeat.mockReturnValue(false);
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.expire();
    expect(h.engine.turnFSM.state).toBe('time_bank_active');
    h.engine.hub.emitEvent.mockClear();
    h.expire(`timebank:${PLAYER}`);
    expect(h.engine.preciseTimer.hasTimer(TABLE, PLAYER)).toBe(true);
    expect(h.engine.turnFSM.state).toBe('timer_running');
    expect(h.strikes).not.toHaveBeenCalled();
    expect(
      h.engine.hub.emitEvent.mock.calls.some((args: any[]) => args[1]?.type === 'time_bank_timeout')
    ).toBe(false);
  });

  it.each([true, false])(
    'a manual bank expiry records its actual accepted=%s outcome',
    async (accepted) => {
      const h = harness();
      h.engine.forceResolveSeat.mockReturnValue(accepted);
      h.engine.startTurnTimer(PLAYER, 2, 15);
      h.now.mockReturnValue(Date.now() + 15_000);
      expect(await h.engine.activateTimeBank(PLAYER)).toMatchObject({ success: true });
      h.engine.hub.emitEvent.mockClear();
      h.expire(`timebank:${PLAYER}`);
      expect(h.engine.turnFSM.state).toBe(accepted ? 'complete' : 'timer_running');
      expect(h.engine.markProgress).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(
        h.engine.hub.emitEvent.mock.calls.some(
          (args: any[]) => args[1]?.type === 'time_bank_timeout'
        )
      ).toBe(accepted);
      expect(h.warnings.mock.calls.flat().join('\n')).not.toContain('Invalid transition');
    }
  );

  it('does not force an already running primary clock through a recovery state', () => {
    const h = harness();
    h.engine.turnFSM.transition('timer_running');
    h.engine.startTurnTimer(PLAYER, 2, 15);
    expect(h.engine.turnFSM.state).toBe('timer_running');
    expect(h.warnings).not.toHaveBeenCalled();
  });

  it('does not act from an expired clock after the seat has changed', () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.state.currentPlayerSeat = 3;
    h.expire();
    expect(h.engine.forceResolveSeat).not.toHaveBeenCalled();
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });

  it('does not act from an expired clock after the engine has retired', () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.engine.running = false;
    h.expire();
    expect(h.engine.forceResolveSeat).not.toHaveBeenCalled();
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });
});
