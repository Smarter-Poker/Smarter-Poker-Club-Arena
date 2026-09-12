import type { Card, SeatPlayer } from '../types.js';
import { evaluatePlo4Policy, type Plo4PolicyInput } from './Plo4PolicyProgram.js';

export function plo4Cards(text: string): Card[] {
  return text.split(' ').map((s) => ({
    rank: s[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[
      s[1] as 'c' | 'd' | 'h' | 's'
    ],
  }));
}
export function plo4ReferenceSpot(
  kind: 'non_nut_flush' | 'royal_flush' | 'dominated_flop_draw' | 'premium_open'
): Plo4PolicyInput {
  const hero: SeatPlayer = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 100,
    bet: 0,
    totalInvested: 20,
    cards: plo4Cards(kind === 'royal_flush' ? 'Qs Js 9c 8d' : '9s 8s Kc Qd'),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const opponent: SeatPlayer = {
    ...hero,
    user_id: 'opponent',
    username: 'Opponent',
    seat: 2,
    cards: [],
    bet: 20,
    totalInvested: 40,
  };
  const input: Plo4PolicyInput = {
    hero,
    baseline: { action: kind === 'royal_flush' ? 'fold' : 'call', thinkTime: 0 },
    mode: 'candidate',
    seed: 10101101,
    samples: 32,
    opponentRanges: {
      opponent: {
        combos: [
          { cards: plo4Cards(kind === 'royal_flush' ? 'Qh Qd 7c 6h' : 'Ks Qs 6c 5h'), weight: 1 },
        ],
      },
    },
    state: {
      players: [{ ...hero, cards: [] }, opponent],
      communityCards: plo4Cards(kind === 'royal_flush' ? 'As Ks Ts 2d Jh' : 'As 7s 3s 2d Jh'),
      pot: 60,
      currentBet: 20,
      minRaise: 20,
      lastRaise: 20,
      stage: 'river',
      gameVariant: 'plo4',
      bigBlind: 2,
      stateSchemaVersion: 1,
      gameMode: 'cash',
      format: 'cash',
      dealerSeat: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      bettingStructure: 'pot_limit',
      legalActions: ['fold', 'call', 'raise'],
      toCall: 20,
      minRaiseTo: 40,
      maxRaiseTo: 100,
      rakeConfig: { percent: 10, cap: 10, noFlopNoDrop: true },
      actionHistory: [
        {
          userId: 'opponent',
          seat: 2,
          action: 'bet',
          amount: 20,
          stage: 'river',
          timestamp: 1,
          isFullRaise: true,
        },
      ],
    },
  };
  if (kind === 'dominated_flop_draw') {
    input.state.communityCards = plo4Cards('As 7s 2d');
    input.state.stage = 'flop';
    input.state.actionHistory![0].stage = 'flop';
  }
  if (kind === 'premium_open') {
    hero.cards = plo4Cards('As Ad Ks Kd');
    hero.bet = hero.totalInvested = 1;
    input.state.players[0] = { ...hero, cards: [] };
    opponent.bet = opponent.totalInvested = 2;
    Object.assign(input.state, {
      pot: 3,
      currentBet: 2,
      minRaise: 2,
      lastRaise: 2,
      stage: 'preflop',
      communityCards: [],
      toCall: 1,
      minRaiseTo: 4,
      maxRaiseTo: 6,
      actionHistory: [],
    });
    delete input.opponentRanges;
  }
  return input;
}
export async function runPlo4ReferenceSpots(samples = 32) {
  const kinds = ['non_nut_flush', 'royal_flush', 'dominated_flop_draw', 'premium_open'] as const;
  const results = [];
  for (const name of kinds) {
    const request = plo4ReferenceSpot(name);
    request.samples = samples;
    results.push({ name, request, receipt: await evaluatePlo4Policy(request) });
  }
  if (
    results[0].receipt.selected.action !== 'fold' ||
    results[0].receipt.equity?.equity !== 0 ||
    results[1].receipt.selected.action !== 'raise' ||
    results[1].receipt.equity?.equity !== 1 ||
    results[2].receipt.draws?.dominatedFlushDraw !== true ||
    !results[2].request.state.legalActions!.includes(results[2].receipt.selected.action) ||
    !results[2].receipt.livePolicy?.fired ||
    results[3].receipt.selected.action !== 'raise'
  )
    throw new Error('PLO4 reference spot mismatch');
  return results;
}
