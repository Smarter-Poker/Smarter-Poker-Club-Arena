/**
 * INSURANCE IS OFFERED ONLY ON A ONE-POT HAND (launch audit 2026-10-05).
 *
 * The offer is settled on "is the insured player among the hand's winners".
 * With a side pot that is not the question the contract asked, and the fee or
 * the payout went to the wrong party. The offer is made only on a one-pot
 * hand, where the two are the same.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HandController } from './HandController.js';
import { insuranceContractIsExact } from './ServerTableEngineRunout.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function allInHand(stacks: number[]): HandController {
  const players = stacks.map(
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
  const hc = new HandController(
    {
      tableId: 't1',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.start();
  for (let i = 0; i < 10; i++) {
    const seat = (hc as unknown as { state: { currentPlayerSeat: number | null } }).state
      .currentPlayerSeat;
    if (!seat) break;
    if (!hc.performAction(seat, 'all_in', 0) && !hc.performAction(seat, 'call', 0)) break;
  }
  return hc;
}

describe('insurance is offered only on a one-pot hand', () => {
  it('a heads-up all-in with unequal stacks is one pot: offered', () => {
    const hc = allInHand([100, 60]);
    expect(hc.computeLivePots()).toHaveLength(1);
    expect(insuranceContractIsExact(hc)).toBe(true);
  });

  it('a three-way all-in with unequal stacks has a side pot: not offered', () => {
    const hc = allInHand([200, 60, 200]);
    expect(hc.computeLivePots().length).toBeGreaterThan(1);
    expect(insuranceContractIsExact(hc)).toBe(false);
  });

  it('a three-way all-in with equal stacks is one pot: offered', () => {
    expect(insuranceContractIsExact(allInHand([100, 100, 100]))).toBe(true);
  });

  it('a pot read that throws offers nothing', () => {
    expect(
      insuranceContractIsExact({
        computeLivePots: () => {
          throw new Error('unreadable');
        },
      })
    ).toBe(false);
  });

  it('the runout asks before it enables the offer', () => {
    const src = readFileSync(resolve(__dirname, 'ServerTableEngineRunout.ts'), 'utf8');
    expect(src).toContain('insuranceContractIsExact(this.handController);');
  });
});
