/**
 * ENGINE STACK DELTAS — the getState()-returns-copies trap.
 *
 * `HandController.getState()` hands out copies:
 *
 *     players: this.state.players.map((p) => ({ ...p, cards: [...p.cards] }))
 *
 * so `getState().players.find(...).stack += x` mutates a throwaway object and
 * the engine's authoritative state never moves. PR #97 found this destroying
 * run-it-twice pots. The same pattern was still live in two more settlement
 * adjustments, both of which land AFTER the WINNERS event:
 *
 *   - insurance payouts and premiums
 *   - the 7-2 bounty transfer
 *
 * Neither lost money — the retired stack writer persisted `seatedPlayers`, which
 * WAS being mutated correctly — but `broadcastCurrentState()` reads engine state, so
 * every snapshot between settlement and the next hand showed the player a stack
 * that did not include their insurance payout or their bounty. In the 7-2 case
 * the code explicitly re-broadcasts "so clients see the bounty-adjusted stacks
 * immediately" and then sent the pre-bounty numbers.
 *
 * `applyStackDeltas()` is the single supported way to move engine stacks after
 * the hand is decided. These tests pin its semantics and, first, pin the copy
 * semantics that make it necessary — so nobody "simplifies" it back.
 */

import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't-deltas',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function hcOf(stacks: number[]) {
  return new HandController(mkConfig(), mkPlayers(stacks), 1);
}

const stackOf = (hc: HandController, userId: string) =>
  hc.getState().players.find((p) => p.user_id === userId)!.stack;

describe('getState() copy semantics - why applyStackDeltas exists', () => {
  it('writing through getState() does NOT move the engine', () => {
    const hc = hcOf([200, 200, 200]);
    const before = stackOf(hc, 'u3');

    // Exactly what the insurance and 7-2 code used to do.
    const copy = hc.getState().players.find((p) => p.user_id === 'u3')!;
    copy.stack += 500;

    expect(copy.stack).toBe(before + 500); // the throwaway moved...
    expect(stackOf(hc, 'u3')).toBe(before); // ...and the engine did not.
  });

  it('each getState() call returns a fresh object, not a shared one', () => {
    const hc = hcOf([200, 200, 200]);
    const a = hc.getState().players.find((p) => p.user_id === 'u1')!;
    const b = hc.getState().players.find((p) => p.user_id === 'u1')!;
    expect(a).not.toBe(b);
  });
});

describe('applyStackDeltas', () => {
  it('credits and debits the engine state itself', () => {
    const hc = hcOf([200, 200, 200]);
    const u1 = stackOf(hc, 'u1');
    const u3 = stackOf(hc, 'u3');

    // A 7-2 bounty shape: two payers debited, the winner credited.
    hc.applyStackDeltas(
      new Map([
        ['u1', -4],
        ['u2', -4],
        ['u3', +8],
      ])
    );

    expect(stackOf(hc, 'u1')).toBe(u1 - 4);
    expect(stackOf(hc, 'u3')).toBe(u3 + 8);
  });

  it('snaps to cents so repeated transfers cannot drift', () => {
    const hc = hcOf([200, 200, 200]);
    const start = stackOf(hc, 'u2');
    for (let i = 0; i < 3; i++) hc.applyStackDeltas(new Map([['u2', 0.1]]));
    expect(stackOf(hc, 'u2')).toBe(Math.round((start + 0.3) * 100) / 100);
  });

  it('ignores unknown users and zero deltas instead of throwing', () => {
    const hc = hcOf([200, 200, 200]);
    const before = hc.getState().players.map((p) => p.stack);
    expect(() =>
      hc.applyStackDeltas(
        new Map([
          ['nobody-at-this-table', 250],
          ['u1', 0],
        ])
      )
    ).not.toThrow();
    expect(hc.getState().players.map((p) => p.stack)).toEqual(before);
  });

  it('does not touch the pot - these are transfers, not awards from the pot', () => {
    const hc = hcOf([200, 200, 200]);
    const pot = hc.getState().pot;
    hc.applyStackDeltas(new Map([['u1', -5]]));
    expect(hc.getState().pot).toBe(pot);
  });
});

describe('creditRunoutWinnings still behaves exactly as before', () => {
  it('delegating to applyStackDeltas did not change run-it-twice payouts', () => {
    const hc = hcOf([200, 200, 200]);
    const u1 = stackOf(hc, 'u1');
    const u2 = stackOf(hc, 'u2');

    hc.creditRunoutWinnings(
      new Map([
        ['u1', 60],
        ['u2', 40],
      ])
    );

    expect(stackOf(hc, 'u1')).toBe(u1 + 60);
    expect(stackOf(hc, 'u2')).toBe(u2 + 40);
  });
});
