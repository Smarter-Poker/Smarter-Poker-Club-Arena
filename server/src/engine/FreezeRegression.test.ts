/**
 * FREEZE REGRESSION SUITE — 2026-08-15
 *
 * Every case here encodes a defect that permanently froze a real production
 * table. They are grouped by the invariant they protect rather than by file,
 * because the same defect kept reappearing at new call sites: the
 * `performAction` boolean was ignored in five separate places over two months,
 * each one an independent permanent freeze.
 *
 * The rule these tests exist to enforce:
 *   A seat may never be left with no clock AND no action.
 */

import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { SeatPlayer, HandConfig } from '../types.js';

function mkPlayer(seat: number, stack = 1000): SeatPlayer {
  return {
    seat,
    user_id: `u${seat}`,
    username: `p${seat}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  } as SeatPlayer;
}

function mkConfig(overrides: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    ...overrides,
  } as HandConfig;
}

describe('performAction is the authoritative action gate', () => {
  it('REJECTS rather than throws on an illegal action - the contract five call sites got wrong', () => {
    const hc = new HandController(mkConfig(), [mkPlayer(1), mkPlayer(2), mkPlayer(3)], 1);
    hc.start();
    const seat = hc.getState().currentPlayerSeat;
    expect(seat).toBeGreaterThan(0);

    // Facing the big blind, `check` is illegal. It must come back as `false`,
    // NOT as a throw: every `try { performAction(...) } catch { fallback }`
    // site in the engine was silently doing nothing because of this.
    let threw = false;
    let result: boolean | undefined;
    try {
      result = hc.performAction(seat, 'check' as never);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
  });

  it('refuses to act for a FOLDED seat even when currentPlayerSeat points at it', () => {
    const hc = new HandController(mkConfig(), [mkPlayer(1), mkPlayer(2), mkPlayer(3)], 1);
    hc.start();
    const seat = hc.getState().currentPlayerSeat;
    expect(hc.performAction(seat, 'fold' as never)).toBe(true);

    // Force the pointer back at the folded seat, the way a stale snapshot or a
    // late timer callback would. Nothing may act on their behalf.
    (hc as unknown as { state: { currentPlayerSeat: number } }).state.currentPlayerSeat = seat;
    expect(hc.performAction(seat, 'fold' as never)).toBe(false);
    expect(hc.performAction(seat, 'check' as never)).toBe(false);
  });

  it('refuses to act for an ALL-IN seat - the watchdog used to force check/folds from them', () => {
    const hc = new HandController(mkConfig(), [mkPlayer(1), mkPlayer(2), mkPlayer(3)], 1);
    hc.start();
    const seat = hc.getState().currentPlayerSeat;
    expect(hc.performAction(seat, 'all_in' as never)).toBe(true);

    (hc as unknown as { state: { currentPlayerSeat: number } }).state.currentPlayerSeat = seat;
    expect(hc.performAction(seat, 'fold' as never)).toBe(false);
  });
});

describe('a parked all-in runout must not look like a stalled turn', () => {
  it('clears currentPlayerSeat when it emits ALL_IN_RUNOUT', () => {
    // Two players, both short enough that a shove + call puts everyone all-in.
    const hc = new HandController(mkConfig(), [mkPlayer(1, 100), mkPlayer(2, 100)], 1);
    const events: string[] = [];
    hc.onEvent((e) => events.push(e.type));
    hc.start();

    // Shove and call: nobody can act after this, the engine parks for a runout.
    let guard = 0;
    while (!events.includes('ALL_IN_RUNOUT') && guard++ < 8) {
      const s = hc.getState();
      if (s.currentPlayerSeat < 0) break;
      const toCall = Math.max(
        0,
        s.currentBet - (s.players.find((p) => p.seat === s.currentPlayerSeat)?.bet ?? 0)
      );
      if (!hc.performAction(s.currentPlayerSeat, (toCall > 0 ? 'call' : 'all_in') as never)) {
        hc.performAction(s.currentPlayerSeat, 'all_in' as never);
      }
    }

    if (events.includes('ALL_IN_RUNOUT')) {
      // A parked runout has NO actionable seat. Leaving the last aggressor's
      // seat here sent the table watchdog down its "stalled turn" branch, which
      // armed an action clock on an all-in player and then forced check/folds
      // from them, advancing the runout one street per watchdog cycle and
      // writing phantom actions into the hand history.
      expect(hc.getState().currentPlayerSeat).toBe(-1);
    }
  });
});

describe('settlement fails closed', () => {
  it('always emits HAND_COMPLETE, even when winner evaluation blows up', () => {
    const hc = new HandController(mkConfig(), [mkPlayer(1), mkPlayer(2)], 1);
    const events: string[] = [];
    hc.onEvent((e) => events.push(e.type));
    hc.start();

    // Sabotage the settlement path the way a malformed hand would: a live
    // player holding no cards makes determineWinners throw.
    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    st.players.forEach((p) => {
      p.cards = [];
    });

    let guard = 0;
    while (!events.includes('HAND_COMPLETE') && guard++ < 12) {
      const s = hc.getState();
      if (s.currentPlayerSeat < 0) break;
      const toCall = Math.max(
        0,
        s.currentBet - (s.players.find((p) => p.seat === s.currentPlayerSeat)?.bet ?? 0)
      );
      if (!hc.performAction(s.currentPlayerSeat, (toCall > 0 ? 'call' : 'check') as never)) break;
    }

    // The dealing loop awaits HAND_COMPLETE. Without it the promise hangs for
    // the full 10-minute safety timeout and the table stops dealing entirely.
    expect(events).toContain('HAND_COMPLETE');
  });
});
