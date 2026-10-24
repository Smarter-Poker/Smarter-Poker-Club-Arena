import { afterEach, expect, it } from 'vitest';
import fixture from './fixtures/horse-plo5-bomb-set-45902980.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import { scoreOmahaHi, seedFastRandom, variantInfo, saveFastRandom } from './HorseEval.js';
import {
  freshExploitCounters,
  exploitHandIncrements,
  decayAndAdd,
} from './HorseOpponentExploit.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';

type Captured = Extract<HorsePublicActionNode, { status: 'captured' }>;
const actions = fixture.actions as unknown as Array<ActionRecord & { publicNode?: Captured }>;
const card = (s: string) => ({ rank: s[0], suit: s.slice(1) }) as Card;
function incident() {
  const action = actions[23],
    n = action.publicNode!;
  const ids = new Map(actions.map((a) => [a.seat, a.userId]));
  const players = n.seats.map(
    ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) => ({
      seat,
      user_id: ids.get(seat)!,
      username: `Seat ${seat}`,
      stack,
      bet,
      totalInvested,
      deadInvested,
      individualAnteInvested,
      is_folded: !!(flags & 1),
      is_all_in: !!(flags & 2),
      is_sitting_out: !!(flags & 4),
      cards: [],
    })
  ) as SeatPlayer[];
  const hero = {
    ...players.find((p) => p.user_id === fixture.heroId)!,
    cards: fixture.heroCards as Card[],
  };
  const gs = {
    stateSchemaVersion: 1,
    players,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    dealtSeatIds: players.map((p) => p.seat),
    communityCards: fixture.communityCards.map(card),
    communityCards2: fixture.communityCards2.map(card),
    communityCards3: [],
    boardCount: 2,
    bombPot: true,
    gameVariant: 'plo5',
    gameMode: 'cash',
    stage: 'river',
    pot: n.pot,
    currentBet: n.currentBet,
    bigBlind: n.bigBlind,
    minRaise: 144,
    lastRaise: 144,
    actionHistory: actions.slice(0, 23),
    dealerSeat: n.dealerSeat,
  } as HorseGameStateV2;
  return { hero, gs };
}
function maniac() {
  const counters = freshExploitCounters();
  const uid = '00000000-0000-4000-8000-000000000002';
  const increment = exploitHandIncrements([
    { userId: uid, action: 'raise', stage: 'preflop' },
    { userId: 'caller', action: 'call', stage: 'preflop' },
    { userId: uid, action: 'bet', stage: 'flop' },
    { userId: 'caller', action: 'call', stage: 'flop' },
    { userId: uid, action: 'bet', stage: 'turn' },
    { userId: 'caller', action: 'call', stage: 'turn' },
    { userId: uid, action: 'bet', stage: 'river' },
  ]).get(uid)!;
  for (let i = 0; i < 80; i++) decayAndAdd(counters, increment);
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: uid,
      variant: 'plo5',
      mode: 'cash',
      size: 'full',
      observed_hands: 80,
      initialized: true,
      counters,
    },
  ]);
  HorseMind.setDecisionScope(readScopeOf('plo5', 6), 'plo5', 'cash');
}
afterEach(() => HorseMind.reset());
it('retains the actual set on one board and ten-high straight on the other', () => {
  const { hero, gs } = incident();
  expect(scoreOmahaHi(hero.cards, gs.communityCards) >>> 20).toBe(4);
  expect(scoreOmahaHi(hero.cards, gs.communityCards2!) >>> 20).toBe(5);
  expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
});
it('does not reopen a multi-board reference fold using only board one', () => {
  HorseMind.reset();
  maniac();
  seedFastRandom(100);
  const { hero, gs } = incident();
  const before = saveFastRandom();
  const decision = HorseLogic.__testables.maniacCallDown(
    { action: 'fold', thinkTime: 0 },
    hero,
    gs,
    variantInfo('plo5'),
    { telemetry: false }
  );
  expect(decision.action).toBe('fold');
  expect(saveFastRandom()).toBe(before);
});
