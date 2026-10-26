import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  necessaryReferenceRouteGates,
  referenceReturnShape,
  type HorsePhase6Attribution,
} from './HorsePhase6Attribution.js';

/*
 * A V53 PRESSURE 4-BET IS A VARIANT_PRICE RETURN (2026-10-26).
 *
 * HorseLogic's variant_price route returns a raise when hero opened, a
 * pressure target re-raised without going all in, hero has chips behind and
 * is clear of the price (v53_pressure_four_bet). The receipt validator knew
 * only fold, call and all-in on that route, so every tournament 4-bet was
 * refused as reference_shape and the horse folded on the fallback.
 *
 * Live witness: hand 00b25b52 (HU SNG, 20/40, 2026-10-26 04:22 UTC). Seat 1
 * opened to 88 with 869, seat 2 re-raised to 198, and seat 1's decision was
 * refused (reference_shape) and replaced by horse_fallback fold.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HERO = 1;
const RAISER = 2;

function snapshot(o: {
  variant?: string;
  heroStack?: number;
  heroBet?: number;
  currentBet?: number;
  minRaiseTo?: number | null;
  maxRaiseTo?: number | null;
  raiserAllIn?: boolean;
  heroOpened?: boolean;
  extraRaise?: boolean;
  legal?: string[];
  opts?: Record<string, unknown>;
}): any {
  const heroStack = o.heroStack ?? 781;
  const heroBet = o.heroBet ?? 88;
  const currentBet = o.currentBet ?? 198;
  const players = [
    {
      seat: HERO,
      user_id: 'hero',
      bet: heroBet,
      stack: heroStack,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: false,
      cards: o.variant?.startsWith('plo') ? ['As', 'Ad', 'Kh', 'Qs'] : ['As', 'Ad'],
    },
    {
      seat: RAISER,
      user_id: 'raiser',
      bet: currentBet,
      stack: o.raiserAllIn ? 0 : 933,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: !!o.raiserAllIn,
    },
  ];
  const history: any[] = [
    { stage: 'preflop', action: 'sb', seat: HERO, userId: 'hero' },
    { stage: 'preflop', action: 'bb', seat: RAISER, userId: 'raiser' },
    o.heroOpened === false
      ? { stage: 'preflop', action: 'raise', seat: 3, userId: 'third', isFullRaise: true }
      : { stage: 'preflop', action: 'raise', seat: HERO, userId: 'hero', isFullRaise: true },
    o.raiserAllIn
      ? { stage: 'preflop', action: 'all_in', seat: RAISER, userId: 'raiser', isFullRaise: true }
      : { stage: 'preflop', action: 'raise', seat: RAISER, userId: 'raiser', isFullRaise: true },
  ];
  if (o.extraRaise)
    history.push({ stage: 'preflop', action: 'raise', seat: RAISER, userId: 'raiser' });
  return {
    gameState: {
      gameVariant: o.variant ?? 'nlh',
      bigBlind: 40,
      currentBet,
      players,
      actionHistory: history,
      legalActions: o.legal ?? ['fold', 'call', 'raise', 'all_in'],
      minRaiseTo: o.minRaiseTo === undefined ? 308 : o.minRaiseTo,
      maxRaiseTo: o.maxRaiseTo === undefined ? 869 : o.maxRaiseTo,
      dealerSeat: HERO,
      straddleActive: false,
      allInOrFold: false,
    },
    player: players[0],
    opts: o.opts ?? {},
  };
}

function receipt(action: string, amount: number | null): HorsePhase6Attribution {
  return {
    route: 'variant_price',
    referenceProposal: { action, amount },
  } as unknown as HorsePhase6Attribution;
}

describe('the V53 pressure 4-bet on the variant_price route', () => {
  it('admits the live witness: a 2.3x 4-bet of the HU re-raise', () => {
    const s = snapshot({});
    expect(necessaryReferenceRouteGates('variant_price', s)).toBe(true);
    expect(referenceReturnShape(receipt('raise', 455.4), s)).toBe(true);
  });

  it('admits the min-raise floor when 2.3x is below it, and the max when above', () => {
    expect(
      referenceReturnShape(receipt('raise', 500), snapshot({ currentBet: 198, minRaiseTo: 500 }))
    ).toBe(true);
    expect(
      referenceReturnShape(receipt('raise', 400), snapshot({ currentBet: 198, maxRaiseTo: 400 }))
    ).toBe(true);
  });

  it('admits a pot-limit Omaha 4-bet at the pot cap', () => {
    expect(referenceReturnShape(receipt('raise', 869), snapshot({ variant: 'plo4' }))).toBe(true);
    expect(referenceReturnShape(receipt('raise', 455.4), snapshot({ variant: 'plo4' }))).toBe(
      false
    );
  });

  it('refuses any raise that is not the deterministic V53 target', () => {
    for (const amount of [455, 455.41, 308, 869, Number.NaN])
      expect(referenceReturnShape(receipt('raise', amount), snapshot({}))).toBe(false);
    expect(referenceReturnShape(receipt('raise', null), snapshot({}))).toBe(false);
  });

  it('refuses the raise outside the V53 public shape', () => {
    const cases = [
      snapshot({ raiserAllIn: true }),
      snapshot({ heroOpened: false }),
      snapshot({ extraRaise: true }),
      snapshot({ heroStack: 100 }),
      snapshot({ legal: ['fold', 'call', 'all_in'] }),
      snapshot({ minRaiseTo: null }),
      snapshot({ minRaiseTo: 900, maxRaiseTo: 869 }),
      snapshot({ opts: { v53Pressure: false } }),
      snapshot({ opts: { mind: false } }),
    ];
    for (const s of cases) expect(referenceReturnShape(receipt('raise', 455.4), s)).toBe(false);
  });

  it('keeps the existing fold, call and HU all-in answers unchanged', () => {
    const s = snapshot({});
    expect(referenceReturnShape(receipt('fold', null), s)).toBe(true);
    expect(referenceReturnShape(receipt('call', 110), s)).toBe(true);
    expect(referenceReturnShape(receipt('call', 100), s)).toBe(false);
    // The producer shoves only with another live responder; HU it never does.
    expect(referenceReturnShape(receipt('all_in', null), s)).toBe(false);
  });

  it('the producer still returns exactly this target on this route', () => {
    const source = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    const start = source.indexOf('v53ThreeBet &&\n            gap38 >= 0.06 &&');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 900);
    expect(block).toContain("gs.legalActions?.includes('raise')");
    expect(block).toContain('gs.maxRaiseTo >= gs.minRaiseTo');
    expect(block).toContain('const target53 = vi.isPotLimit');
    expect(block).toContain('? gs.maxRaiseTo');
    expect(block).toContain(
      'Math.min(gs.maxRaiseTo, Math.max(gs.minRaiseTo, gs.currentBet * 2.3))'
    );
    expect(block).toContain("notePhase6Route('variant_fallback', 'variant_price')");
    expect(block).toContain(
      "return { action: 'raise', amount: Math.round(target53 * 100) / 100, thinkTime: 0 }"
    );
    const gate = source.slice(source.indexOf('let v53ThreeBet = false;'), start);
    for (const condition of [
      '(opts.v53Pressure ?? true) !== false',
      'opts.mind !== false',
      'raises === 2',
      '!raiserAllIn38',
      'effCall38 < player.stack',
      "a.userId === player.user_id &&\n                (a.action === 'raise' || a.action === 'all_in')",
    ])
      expect(gate).toContain(condition);
  });
});
