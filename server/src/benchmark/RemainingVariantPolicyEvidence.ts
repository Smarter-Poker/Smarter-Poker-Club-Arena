import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import { calculatePots, calculateContestablePot } from '../engine/PokerEngine.js';

export function remainingCards(value: string): Card[] {
  return value.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));
}
export function remainingVariantSpot(
  variant: RemainingPolicyVariant,
  street: 'preflop' | 'flop' | 'turn' | 'river' = 'river',
  seats = 2,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const limit = variant === 'flh' || variant === 'flo8',
    pre = street === 'preflop';
  const bet = limit ? (street === 'turn' || street === 'river' ? 4 : 2) : pre ? 2 : 20;
  const hero: SeatPlayer = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 100,
    bet: pre ? 1 : 0,
    totalInvested: pre ? 1 : 20,
    cards: remainingCards(
      variant === 'flo8' ? 'As 2s 3d Ac' : variant === 'pineapple' && pre ? 'As Ad Qc' : 'As Ad'
    ),
    ...(variant === 'pineapple' && !pre ? { knownDeadCards: remainingCards('Qc') } : {}),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const players = Array.from({ length: seats }, (_, index) => ({
    ...hero,
    user_id: index === 0 ? 'hero' : `v${index + 2}`,
    seat: index + 1,
    cards: [],
    knownDeadCards: undefined,
    bet: index === 0 ? hero.bet : index === 1 ? bet : 0,
    totalInvested:
      index === 0
        ? hero.totalInvested
        : pre
          ? index === 1
            ? bet
            : 0
          : 20 + (index === 1 ? bet : 0),
  }));
  const pot = players.reduce((n, p) => n + p.totalInvested, 0);
  const state: HorseGameStateV2 = {
    players,
    communityCards: pre
      ? []
      : remainingCards(variant === 'short_deck' ? 'Ks Qs 9d 8h 7c' : '4s 5s 8d Kh Jd').slice(
          0,
          { preflop: 0, flop: 3, turn: 4, river: 5 }[street]
        ),
    pot,
    currentBet: bet,
    contestablePot: calculateContestablePot(players, 'hero', bet - hero.bet),
    minRaise: bet,
    lastRaise: bet,
    stage: street,
    gameVariant: variant,
    bigBlind: 2,
    stateSchemaVersion: 1,
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'sng',
    dealerSeat: 1,
    heroSeat: 1,
    currentPlayerSeat: 1,
    bettingStructure: limit ? 'fixed_limit' : 'no_limit',
    variantRules: horseVariantRulesFor(variant),
    pots: calculatePots(players),
    fixedBetSize: limit ? bet : null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    legalActions: ['fold', 'call', 'raise'],
    toCall: bet - hero.bet,
    minRaiseTo: bet * 2,
    maxRaiseTo: limit ? bet * 2 : hero.stack + hero.bet,
    rakeConfig: { percent: mode === 'cash' ? 5 : 0, cap: 10, noFlopNoDrop: true },
    actionHistory: pre
      ? []
      : [
          ...(variant === 'pineapple'
            ? [
                {
                  userId: 'hero',
                  seat: 1,
                  action: 'discard' as const,
                  amount: 0,
                  stage: 'pineapple_discard' as const,
                  timestamp: 0,
                },
              ]
            : []),
          {
            userId: 'v3',
            seat: 2,
            action: 'bet',
            amount: bet,
            stage: street,
            timestamp: 1,
            isFullRaise: true,
          },
        ],
  };
  if (mode === 'tournament')
    state.tournament = {
      schemaVersion: 1,
      contextStatus: 'complete',
      contextIssues: [],
      playersLeft: seats,
      spotsPaid: 1,
      payoutPct: [100],
      stacks: players.map((p) => p.stack + p.totalInvested),
      stackByUser: Object.fromEntries(players.map((p) => [p.user_id, p.stack + p.totalInvested])),
      currentSmallBlind: 1,
      currentBigBlind: 2,
      currentAnte: 0,
      anteType: 'none',
      prizePoolCents: 10000,
      bountyPoolCents: 0,
      isPko: false,
      isBounty: false,
      isMysteryBounty: false,
      mysteryBountyStage: 'none',
      reentryOpen: false,
      rebuyOpen: false,
      addOnPeriodOpen: false,
      maxReentries: 0,
      maxRebuys: 0,
      reloadsUsed: 0,
      addOnTaken: false,
      rebuyAffordable: false,
      addOnAffordable: false,
    };
  return {
    hero,
    state,
    baseline: { action: 'call', amount: state.toCall, thinkTime: 0 } as HorseDecision,
  };
}
