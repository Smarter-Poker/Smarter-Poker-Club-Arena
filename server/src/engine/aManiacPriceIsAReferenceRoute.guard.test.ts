import { describe, expect, it } from 'vitest';
import { necessaryReferenceRouteGates } from './HorsePhase6Attribution.js';

/*
 * A MANIAC PRICE IS A REFERENCE ROUTE IN HOLD'EM (2026-10-22).
 *
 * #7683 taught hold'em to price a maniac's shove, re-raise or quarter-stack
 * raise on the variant_price route (HorseLogic maniacPrice38). The receipt
 * validator still admitted that route only for solverless variants, so every
 * hold'em maniac price was refused as route_gate - and a refused receipt is
 * fatal: release 0bbe3ebd restarted the engine 8 times in two hours.
 */

const HERO = 3;
const MANIAC = 1;

function snapshot(opts: {
  variant?: string;
  heroStack: number;
  raiserBet: number;
  raiserAllIn?: boolean;
  history?: Array<{ stage: string; action: string; seat: number; isFullRaise?: boolean }>;
}): any {
  const bb = 2;
  const players = [
    {
      seat: MANIAC,
      user_id: 'm',
      bet: opts.raiserBet,
      stack: opts.raiserAllIn ? 0 : 200,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: !!opts.raiserAllIn,
    },
    {
      seat: 2,
      user_id: 'x',
      bet: 0,
      stack: 200,
      is_folded: true,
      is_sitting_out: false,
      is_all_in: false,
    },
    {
      seat: HERO,
      user_id: 'h',
      bet: 0,
      stack: opts.heroStack,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: false,
      cards: ['As', 'Kd'],
    },
  ];
  return {
    gameState: {
      gameVariant: opts.variant ?? 'nlh',
      bigBlind: bb,
      currentBet: opts.raiserBet,
      players,
      actionHistory: opts.history ?? [
        {
          stage: 'preflop',
          action: opts.raiserAllIn ? 'all_in' : 'raise',
          seat: MANIAC,
          // A shove that raises carries isFullRaise in real histories.
          ...(opts.raiserAllIn ? { isFullRaise: true } : {}),
        },
      ],
      straddleActive: false,
      allInOrFold: false,
    },
    player: players[2],
    opts: {},
  };
}

describe("the variant_price reference route in hold'em", () => {
  it("admits a maniac's shove", () => {
    expect(
      necessaryReferenceRouteGates(
        'variant_price',
        snapshot({ heroStack: 200, raiserBet: 150, raiserAllIn: true })
      )
    ).toBe(true);
  });

  it('admits a maniac raise that costs a quarter of the stack', () => {
    expect(
      necessaryReferenceRouteGates('variant_price', snapshot({ heroStack: 200, raiserBet: 60 }))
    ).toBe(true);
  });

  it("admits a maniac's re-raise", () => {
    expect(
      necessaryReferenceRouteGates(
        'variant_price',
        snapshot({
          heroStack: 200,
          raiserBet: 24,
          history: [
            { stage: 'preflop', action: 'raise', seat: HERO },
            { stage: 'preflop', action: 'raise', seat: MANIAC },
          ],
        })
      )
    ).toBe(true);
  });

  it('still refuses a small single open, which no route prices by equity', () => {
    expect(
      necessaryReferenceRouteGates('variant_price', snapshot({ heroStack: 200, raiserBet: 6 }))
    ).toBe(false);
  });

  it('still refuses the route when the equity price is switched off', () => {
    const s = snapshot({ heroStack: 200, raiserBet: 150, raiserAllIn: true });
    s.opts = { v38Ev: false };
    expect(necessaryReferenceRouteGates('variant_price', s)).toBe(false);
  });

  it("keeps Omaha's 40%-of-stack price", () => {
    expect(
      necessaryReferenceRouteGates(
        'variant_price',
        snapshot({ variant: 'plo4', heroStack: 200, raiserBet: 90 })
      )
    ).toBe(true);
  });
});
