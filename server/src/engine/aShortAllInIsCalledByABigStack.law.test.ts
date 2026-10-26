/**
 * LAW: A SHORT ALL IN IS CALLED BY A BIG STACK (Dan 2026-10-26, BINDING).
 *
 * Dan, verbatim: "WHEN A PLAYER SHOVES ALL IN WITH LESS THEN 3 BB A STACK OF
 * 20 OR MORE BB SHOULD BE CALLING WITH ALMOST ANYTHING IN A TOURNAMENT."
 *
 * In a tournament, a horse with 20 or more big blinds facing an all in under 3
 * big blinds (the shover's total, or what the horse must add) never folds
 * preflop, in any variant, whatever its style or profile; postflop it folds
 * only a hand measured as drawing dead. Cash games, a 19BB horse and a 3BB+
 * shove are untouched. See HorseShortAllInCallFloor.ts.
 *
 * Every live horse decision is HorseLogic.decide inside the decision worker,
 * then the commit door in ServerTableEngineTurns. The floor is the last
 * action rule in both, and this law pins both.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import { shortAllInSpot } from './HorseShortAllInCallFloor.js';
import type { Card, SeatPlayer } from '../types.js';

const suits: Record<string, Card['suit']> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = (s: string): Card[] =>
  s ? s.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1]] })) : [];

const BB = 200;
const SEEDS = [1, 7, 42, 99, 2026];
const STYLES = ['tag', 'lag', 'balanced', 'tricky', 'grinder'] as const;

/** The worst starting hands we could think of, per variant. */
const TRASH: Record<string, string[]> = {
  nlh: ['7c 2d', '8s 3h', '9d 2c', '6h 2s', 'Jc 3d'],
  short_deck: ['6c 7d', '8s 6h', '9d 6c'],
  plo4: ['2c 7d 9h Ks', '3s 8h 2d Qc', '2h 2d 7c 7s'],
  plo5: ['2c 7d 9h Ks 3d', '3s 8h 2d Qc 4c'],
  plo6: ['2c 7d 9h Ks 3d 4h', '3s 8h 2d Qc 4c 9s'],
  plo8: ['Kc Kd 9h 9s', 'Qs 8h 7d 2c'],
};

function seat(n: number, stack: number, bet: number, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: `p${n}`,
    username: `p${n}`,
    stack,
    bet,
    totalInvested: bet,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: [],
    ...over,
  } as SeatPlayer;
}

function spot(
  variant: string,
  hole: string,
  over: { shove?: number; heroStack?: number; mode?: 'tournament' | 'cash' } = {}
) {
  const shove = over.shove ?? 500;
  const heroStack = over.heroStack ?? 6000;
  const potLimit = variant.startsWith('plo');
  const hero = seat(4, heroStack, 0, { cards: cards(hole) });
  const pot = shove + 300 + 150;
  const gs = {
    stateSchemaVersion: 1,
    players: [
      seat(1, 0, shove, { is_all_in: true }),
      seat(2, 9000, 0, { is_folded: true }),
      seat(3, 8000, 0, { is_folded: true }),
      hero,
      seat(5, 7000, 100),
      seat(6, 12000, 200),
    ],
    dealtSeatIds: [1, 2, 3, 4, 5, 6],
    communityCards: [],
    pot,
    contestablePot: pot,
    currentBet: shove,
    minRaise: Math.max(BB, shove - BB),
    lastRaise: Math.max(BB, shove - BB),
    stage: 'preflop',
    gameVariant: variant,
    variantRules: horseVariantRulesFor(variant),
    gameMode: over.mode ?? 'tournament',
    bigBlind: BB,
    ante: 25,
    dealerSeat: 4,
    heroSeat: 4,
    currentPlayerSeat: 4,
    toCall: shove,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: shove + Math.max(BB, shove - BB),
    maxRaiseTo: potLimit ? Math.min(heroStack, shove * 3 + 450) : heroStack,
    bettingStructure: potLimit ? 'pot_limit' : 'no_limit',
    actionHistory: [
      { stage: 'preflop', seat: 5, userId: 'p5', action: 'sb', amount: 100, timestamp: 1 },
      { stage: 'preflop', seat: 6, userId: 'p6', action: 'bb', amount: 200, timestamp: 2 },
      {
        stage: 'preflop',
        seat: 1,
        userId: 'p1',
        action: 'all_in',
        amount: shove,
        isFullRaise: shove - BB >= BB,
        timestamp: 3,
      },
      { stage: 'preflop', seat: 2, userId: 'p2', action: 'fold', amount: 0, timestamp: 4 },
      { stage: 'preflop', seat: 3, userId: 'p3', action: 'fold', amount: 0, timestamp: 5 },
    ],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

function decide(s: ReturnType<typeof spot>, seed: number, style: (typeof STYLES)[number]) {
  seedFastRandom(seed);
  return HorseLogic.decide(s.hero, s.gs, style, {}, { mind: false, decisionTimeMs: 0 });
}

afterEach(() => HorseMind.reset());

describe('a short all in is called by a big stack in a tournament (Dan 2026-10-26)', () => {
  for (const [variant, hands] of Object.entries(TRASH)) {
    it(`${variant}: trash never folds to a 2.5BB shove with 30BB, any style, any seed`, () => {
      for (const hole of hands) {
        for (const seed of SEEDS) {
          for (const style of STYLES) {
            const d = decide(spot(variant, hole), seed, style);
            expect(d.action, `${variant} ${hole} ${style} seed ${seed}`).not.toBe('fold');
            // The receipt the worker returns is the one the client admits.
            expect(horseDecisionReceiptIsValid(d, variant), `${variant} ${hole}`).toBe(true);
          }
        }
      }
    });
  }

  it('the price is the rule: under 3BB yes, 3BB and over no, 20BB yes, 19BB no, cash no', () => {
    // These pins compare a covered spot with the identical spot just outside
    // the rule; outside it, the brain is free to fold 7-2 offsuit.
    const covered = [
      spot('nlh', '7c 2d', { shove: 3 * BB - 1 }),
      spot('nlh', '7c 2d', { heroStack: 20 * BB }),
    ];
    for (const s of covered)
      for (const seed of SEEDS) expect(decide(s, seed, 'tag').action).not.toBe('fold');
    // Just outside the rule nothing forces the call: the floor does not see
    // the spot, and the brain's own fold of 7-2 offsuit to a real shove stands.
    for (const s of [
      spot('nlh', '7c 2d', { shove: 3 * BB }),
      spot('nlh', '7c 2d', { heroStack: 19 * BB, shove: 2 * BB }),
      spot('nlh', '7c 2d', { mode: 'cash' }),
    ])
      expect(shortAllInSpot(s.hero, s.gs)).toBeNull();
    expect(decide(spot('nlh', '7c 2d', { shove: 10 * BB }), 1, 'tag').action).toBe('fold');
  });

  it('is the last action rule in the brain and at the commit door', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const brain = readFileSync(here + 'HorseLogic.ts', 'utf8');
    const node = brain.slice(brain.indexOf("graph.run('wager_rules'"));
    const nodeBody = node.slice(0, node.indexOf("graph.run('timing'"));
    expect(nodeBody).toContain('shortAllInCallFloor(');
    expect(nodeBody.indexOf('shortAllInCallFloor(')).toBeGreaterThan(
      nodeBody.indexOf('holdemPremiumAggression(')
    );
    expect(nodeBody.indexOf('shortAllInCallFloor(')).toBeGreaterThan(
      nodeBody.indexOf('pairedBoardFold(')
    );
    const turns = readFileSync(here + 'ServerTableEngineTurns.ts', 'utf8');
    const door = turns.slice(turns.indexOf('const wagerGuarded = fullPotNearPotWager('));
    expect(door.indexOf('shortAllInCallFloor(')).toBeGreaterThan(0);
    expect(door.indexOf('shortAllInCallFloor(')).toBeLessThan(door.indexOf('let action = '));
  });
});
