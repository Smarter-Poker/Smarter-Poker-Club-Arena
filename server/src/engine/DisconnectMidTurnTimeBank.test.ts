/**
 * A MID-TURN DISCONNECT MUST NOT SPEND A TIME BANK, AND MUST NOT MOVE THE
 * DEADLINE (2026-08-26).
 *
 * Two separate regressions live here.
 *
 * THE BUG BEING FIXED. TimeBankEngine is use-it-or-lose-it: playerActed
 * deducts the FULL currentUseSeconds however little was consumed, and
 * onPrimaryTimerExpired auto-activates a bank whenever the table is configured
 * to or the player armed one. A player whose socket dies at second 9 therefore
 * silently spends a paid-for bank on a decision they cannot make - every hand,
 * until the pool is empty.
 *
 * THE BUG BEING PREVENTED. The first cut of this fix (PR #1009) cancelled the
 * turn clock and re-stamped playerTurnStartTime = Date.now() with
 * playerTurnDuration = disconnectTimeoutSeconds (30). Those two fields ARE
 * turn_deadline_ms. That hands a player 14 seconds into a 15-second clock a
 * fresh 30 seconds, so killing your own network becomes a repeatable way to
 * buy roughly 39s of stall on every decision. ReconnectTimeBank.test.ts
 * already closed that exact re-stamp on the reconnect path; these cases pin it
 * shut on the disconnect path too.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEAT = 3;

afterEach(() => {
  vi.restoreAllMocks();
});

function harness(overrides: Record<string, unknown> = {}) {
  const engine = new ServerTableEngine(TABLE) as any;
  // This focused harness bypasses start(); explicitly preserve the production
  // precondition that only the process-owned live generation may mutate turns.
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = {} as any;
  engine.handController = {
    getState: () => ({
      currentPlayerSeat: SEAT,
      currentBet: 0,
      players: [
        {
          user_id: 'u1',
          seat: SEAT,
          bet: 0,
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          ...overrides,
        },
      ],
    }),
  };
  engine.seatedPlayers = [{ seat_number: SEAT, user_id: 'u1' }];
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
    remainingSeconds: 40,
    usesRemaining: 2,
  });
  engine.playerTurnDuration = 15;
  engine.playerTurnStartTime = Date.now() - 14_000; // 1s left on the clock
  return engine;
}

describe('a player who drops out of reconnect grace mid-turn', () => {
  it('does not extend the deadline it is shown, or the one that is enforced', () => {
    const engine = harness();
    engine.startTurnTimer('u1', SEAT, 15);

    const stampBefore = engine.playerTurnStartTime;
    const durationBefore = engine.playerTurnDuration;
    const turnBefore = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    engine.handlePlayerDisconnectedMidTurn('u1');

    // The broadcast deadline is exactly where it was. Pre-fix this became
    // Date.now() + 30s, i.e. strictly MORE time for going offline.
    expect(engine.playerTurnStartTime).toBe(stampBefore);
    expect(engine.playerTurnDuration).toBe(durationBefore);

    // And the enforcement deadline did not move either.
    const turnAfter = engine.preciseTimer.getRemainingMs(TABLE, 'u1');
    expect(Math.abs(turnAfter - turnBefore)).toBeLessThanOrEqual(150);

    // Specifically: no 30-second disconnect countdown was opened alongside it.
    expect(engine.preciseTimer.getRemainingMs(TABLE, 'disconnect:u1')).toBeLessThanOrEqual(0);
    expect(turnAfter).toBeLessThanOrEqual(15_000 + 2_100);

    engine.preciseTimer.dispose();
  });

  it('suppresses the time bank so an offline player cannot be charged for one', () => {
    const engine = harness();
    engine.startTurnTimer('u1', SEAT, 15);
    expect(engine.timeBankSuppressedThisTurn).toBe(false);

    engine.handlePlayerDisconnectedMidTurn('u1');

    expect(engine.timeBankSuppressedThisTurn).toBe(true);
    engine.preciseTimer.dispose();
  });

  it('drops an armed-but-unredeemed bank instead of carrying it to the next turn', () => {
    const engine = harness();
    engine.startTurnTimer('u1', SEAT, 15);
    expect(engine.timeBankEngine.arm(TABLE, 'u1')).toBe(true);
    expect(engine.timeBankEngine.isArmed(TABLE, 'u1')).toBe(true);

    engine.handlePlayerDisconnectedMidTurn('u1');

    expect(engine.timeBankEngine.isArmed(TABLE, 'u1')).toBe(false);
    engine.preciseTimer.dispose();
  });

  it('spends nothing from the pool', () => {
    const engine = harness();
    engine.startTurnTimer('u1', SEAT, 15);
    const before = engine.timeBankEngine.getPlayerBank(TABLE, 'u1');
    const secondsBefore = before.remainingSeconds;
    const usesBefore = before.usesRemaining;

    engine.handlePlayerDisconnectedMidTurn('u1');

    const after = engine.timeBankEngine.getPlayerBank(TABLE, 'u1');
    expect(after.remainingSeconds).toBe(secondsBefore);
    expect(after.usesRemaining).toBe(usesBefore);
    engine.preciseTimer.dispose();
  });

  it('leaves an ALREADY RUNNING bank strictly alone - that deadline is in force', async () => {
    const engine = harness();
    engine.playerTurnStartTime = Date.now() - 15_000; // clock spent, bank may start
    expect((await engine.activateTimeBank('u1')).success).toBe(true);
    const bankBefore = engine.preciseTimer.getRemainingMs(TABLE, 'timebank:u1');

    engine.handlePlayerDisconnectedMidTurn('u1');

    const bankAfter = engine.preciseTimer.getRemainingMs(TABLE, 'timebank:u1');
    expect(Math.abs(bankAfter - bankBefore)).toBeLessThanOrEqual(150);
    // Cancelling the raw timer key while bank.isActive stayed true would strand
    // the accounting, so the method returns before suppressing anything.
    expect(engine.timeBankEngine.getPlayerBank(TABLE, 'u1').isActive).toBe(true);
    expect(engine.timeBankSuppressedThisTurn).toBe(false);

    engine.preciseTimer.dispose();
  });

  it('is a no-op when the disconnected player is not the one to act', () => {
    const engine = harness({ seat: SEAT + 1 });
    engine.handlePlayerDisconnectedMidTurn('u1');
    expect(engine.timeBankSuppressedThisTurn).toBe(false);
    engine.preciseTimer.dispose();
  });

  it('is a no-op for a folded, all-in or sitting-out seat', () => {
    for (const flag of ['is_folded', 'is_all_in', 'is_sitting_out']) {
      const engine = harness({ [flag]: true });
      engine.handlePlayerDisconnectedMidTurn('u1');
      expect(engine.timeBankSuppressedThisTurn).toBe(false);
      engine.preciseTimer.dispose();
    }
  });

  it('lifts the suppression when the player reconnects inside the same turn', () => {
    const engine = harness();
    engine.startTurnTimer('u1', SEAT, 15);
    engine.handlePlayerDisconnectedMidTurn('u1');
    expect(engine.timeBankSuppressedThisTurn).toBe(true);

    // rearmTurnTimerIfCurrent routes through handleTurnChange, which clears it.
    engine.preciseTimer.cancelTimer(TABLE, 'u1');
    engine.rearmTurnTimerIfCurrent('u1');

    expect(engine.timeBankSuppressedThisTurn).toBe(false);
    engine.preciseTimer.dispose();
  });
});

describe('unified outage allowance on a live turn', () => {
  it('preserves the outage deadline when the clock advances during timer handoff', () => {
    const engine = harness();
    engine.disconnectEngine.registerPlayer(TABLE, 'u1');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    engine.startTurnTimer('u1', SEAT, 15);
    engine.disconnectEngine.markDisconnected(TABLE, 'u1');
    const expected = engine.disconnectEngine.getFsmState(TABLE, 'u1').graceDeadlineMs;
    try {
      expect(engine.disconnectEngine.armedAutoActionDeadlineMs(TABLE, 'u1')).toBe(expected);
      expect(engine.playerTurnStartTime + engine.playerTurnDuration * 1000).toBe(expected);
    } finally {
      engine.preciseTimer.dispose();
    }
  });

  it.each([false, true])(
    'transfers the primary clock to the original protection deadline, VIP=%s',
    (vip) => {
      const engine = harness();
      engine.disconnectEngine.registerPlayer(TABLE, 'u1', {
        is_vip: vip,
        vip_tier: vip ? 'lifetime' : null,
        vip_expires_at: null,
      });
      engine.startTurnTimer('u1', SEAT, 15);
      engine.disconnectEngine.markDisconnected(TABLE, 'u1');
      const expected = engine.disconnectEngine.getFsmState(TABLE, 'u1').graceDeadlineMs;
      expect(engine.preciseTimer.getRemainingMs(TABLE, 'u1')).toBe(0);
      expect(engine.disconnectEngine.armedAutoActionDeadlineMs(TABLE, 'u1')).toBe(expected);
      expect(engine.playerTurnStartTime + engine.playerTurnDuration * 1000).toBe(expected);
      expect(expected - Date.now()).toBeGreaterThan((vip ? 45 : 30) * 1000 - 100);
      expect(engine.timeBankEngine.getRemainingSeconds(TABLE, 'u1')).toBe(40);
      engine.preciseTimer.dispose();
    }
  );
});

it('a paid bank finishes its accounting before handing the turn to remaining VIP protection', async () => {
  const engine = harness();
  engine.running = true;
  engine.disconnectEngine.registerPlayer(TABLE, 'u1', {
    is_vip: true,
    vip_tier: 'lifetime',
    vip_expires_at: null,
  });
  engine.playerTurnStartTime = Date.now() - 15001;
  expect((await engine.activateTimeBank('u1')).success).toBe(true);
  engine.disconnectEngine.markDisconnected(TABLE, 'u1');
  const deadline = engine.disconnectEngine.getFsmState(TABLE, 'u1').graceDeadlineMs;
  expect(engine.timeBankEngine.getPlayerBank(TABLE, 'u1').isActive).toBe(true);
  const resolve = vi.spyOn(engine, 'forceResolveSeat');
  engine.timeBankEngine.onTimeBankExpired(TABLE, 'u1');
  expect(engine.timeBankEngine.getPlayerBank(TABLE, 'u1').isActive).toBe(false);
  expect(engine.timeBankEngine.getRemainingSeconds(TABLE, 'u1')).toBe(20);
  expect(engine.disconnectEngine.armedAutoActionDeadlineMs(TABLE, 'u1')).toBe(deadline);
  expect(resolve).not.toHaveBeenCalled();
  engine.preciseTimer.dispose();
});

it('an expired allowance cannot turn another heartbeat into a fresh action clock', () => {
  const engine = harness();
  engine.disconnectEngine.registerPlayer(TABLE, 'u1');
  engine.disconnectEngine.markDisconnected(TABLE, 'u1');
  engine.disconnectEngine.getState(TABLE, 'u1').reconnectDeadlineMs = Date.now() - 100;
  const resolve = vi.spyOn(engine, 'forceResolveSeat').mockReturnValue(true);
  vi.spyOn(engine, 'markProgress').mockImplementation(() => {});
  const start = vi.spyOn(engine, 'startTurnTimer');
  engine.disconnectEngine.heartbeat(TABLE, 'u1');
  expect(resolve).toHaveBeenCalledWith(SEAT, true);
  expect(start).not.toHaveBeenCalled();
  engine.preciseTimer.dispose();
});
