import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from '../testHelpers/sourceWindow.js';
import {
  necessaryReferenceRouteGates,
  referenceReturnShape,
  type HorsePhase6Attribution,
} from './HorsePhase6Attribution.js';
import { SHORT_STACK_NO_FLAT_BB } from './HorseLogic.js';

/*
 * A V58 SHORT-STACK JAM IS A VARIANT_PRICE RETURN (2026-10-26).
 *
 * HorseLogic's variant_price route jams a two-card no-limit tournament stack
 * of at most SHORT_STACK_NO_FLAT_BB facing a non-all-in raise it prices
 * (v58_short_stack_no_flat). The receipt validator admitted an all-in on that
 * route only with chips well behind the call AND another live responder, so a
 * V58 jam heads-up against the raiser, or with the call near the whole stack,
 * was refused as reference_shape and the horse folded on the fallback.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HERO = 1;
const RAISER = 2;
const THIRD = 3;

function snapshot(o: {
  heroStack?: number;
  heroBet?: number;
  raiseTo?: number;
  raiserAllIn?: boolean;
  third?: boolean;
  variant?: string;
  gameMode?: 'tournament' | 'cash';
  bigBlind?: number;
}): any {
  const bb = o.bigBlind ?? 40;
  const raiseTo = o.raiseTo ?? 120;
  const players: any[] = [
    {
      seat: HERO,
      user_id: 'hero',
      bet: o.heroBet ?? 20,
      stack: o.heroStack ?? 260,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: false,
      cards: o.variant?.startsWith('plo') ? ['As', 'Ad', 'Kh', 'Qs'] : ['As', 'Kd'],
    },
    {
      seat: RAISER,
      user_id: 'raiser',
      bet: raiseTo,
      stack: o.raiserAllIn ? 0 : 900,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: !!o.raiserAllIn,
    },
  ];
  if (o.third)
    players.push({
      seat: THIRD,
      user_id: 'third',
      bet: 0,
      stack: 900,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: false,
    });
  return {
    gameState: {
      stage: 'preflop',
      gameVariant: o.variant ?? 'nlh',
      gameMode: o.gameMode ?? 'tournament',
      bigBlind: bb,
      currentBet: raiseTo,
      players,
      actionHistory: [
        { stage: 'preflop', action: 'sb', seat: HERO, userId: 'hero' },
        { stage: 'preflop', action: 'bb', seat: RAISER, userId: 'raiser' },
        { stage: 'preflop', action: 'call', seat: HERO, userId: 'hero' },
        o.raiserAllIn
          ? {
              stage: 'preflop',
              action: 'all_in',
              seat: RAISER,
              userId: 'raiser',
              isFullRaise: true,
            }
          : {
              stage: 'preflop',
              action: 'raise',
              seat: RAISER,
              userId: 'raiser',
              isFullRaise: true,
            },
      ],
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      dealerSeat: HERO,
      straddleActive: false,
      allInOrFold: false,
    },
    player: players[0],
    opts: {},
  };
}

const jam = {
  route: 'variant_price',
  referenceProposal: { action: 'all_in', amount: null },
} as unknown as HorsePhase6Attribution;

describe('the V58 short-stack jam on the variant_price route', () => {
  it('admits a heads-up jam against the raiser (7bb facing a raise)', () => {
    const s = snapshot({});
    expect(necessaryReferenceRouteGates('variant_price', s)).toBe(true);
    expect(referenceReturnShape(jam, s)).toBe(true);
  });

  it('admits a three-handed jam when the call is most of the stack', () => {
    const s = snapshot({ third: true, heroStack: 140, heroBet: 20 });
    expect(referenceReturnShape(jam, s)).toBe(true);
  });

  it('admits exactly up to the short-stack ceiling', () => {
    const at = SHORT_STACK_NO_FLAT_BB * 40;
    expect(referenceReturnShape(jam, snapshot({ heroStack: at - 20, heroBet: 20 }))).toBe(true);
    expect(referenceReturnShape(jam, snapshot({ heroStack: at - 19, heroBet: 20 }))).toBe(false);
  });

  it('refuses outside the V58 public shape', () => {
    for (const s of [
      snapshot({ gameMode: 'cash' }),
      snapshot({ variant: 'plo4' }),
      snapshot({ variant: 'short_deck' }),
    ])
      expect(referenceReturnShape(jam, s)).toBe(false);
    const sized = {
      route: 'variant_price',
      referenceProposal: { action: 'all_in', amount: 280 },
    } as unknown as HorsePhase6Attribution;
    expect(referenceReturnShape(sized, snapshot({}))).toBe(false);
  });

  it('admits the maniac call-down all-in call-off on this route, in cash and deep', () => {
    // 90 behind facing a 100 call: the call is the whole stack.
    expect(referenceReturnShape(jam, snapshot({ heroStack: 90 }))).toBe(true);
    expect(referenceReturnShape(jam, snapshot({ heroStack: 90, gameMode: 'cash' }))).toBe(true);
    expect(
      referenceReturnShape(jam, snapshot({ heroStack: 1000, raiseTo: 1040, gameMode: 'cash' }))
    ).toBe(true);
    // Chips behind the call, cash, heads-up: still not a call-off, still refused.
    expect(referenceReturnShape(jam, snapshot({ heroStack: 1000, gameMode: 'cash' }))).toBe(false);
  });

  it('refuses a free or nonpositive-stack call-off', () => {
    for (const heroStack of [0, -1])
      expect(
        referenceReturnShape(jam, snapshot({ heroStack, raiseTo: 20, gameMode: 'cash' }))
      ).toBe(false);
  });

  it('the maniac call-down still answers a whole-stack call with the all-in', () => {
    const source = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    const block = sliceBetween(source, "noteFire('maniac_call_down');", '} catch {');
    expect(block).toContain('return allInCall');
    expect(block).toContain("? { ...decision, action: 'all_in', amount: undefined }");
    expect(source).toContain('const allInCall = call >= player.stack;');
  });

  it('the producer still jams on exactly this public shape', () => {
    const source = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    const block = sliceBetween(
      source,
      '// V58 A SHORT TOURNAMENT STACK DOES NOT FLAT (see maniacCallDown):',
      'const callIt = Math.abs(gap38)'
    );
    for (const condition of [
      'maniacPrice38 &&',
      'isTournamentMode(gs) &&',
      'vi.holeCount === 2 &&',
      '!vi.isOmaha &&',
      '!vi.isFixedLimit &&',
      '!vi.isPotLimit &&',
      '!vi.isShortDeck &&',
      '!raiserAllIn38 &&',
      'effCall38 < player.stack &&',
      '(player.stack + (player.bet || 0)) / bb <= SHORT_STACK_NO_FLAT_BB',
      "notePhase6Route('variant_fallback', 'variant_price');",
      "return { action: 'all_in', thinkTime: 0 };",
    ])
      expect(block).toContain(condition);
  });
});
