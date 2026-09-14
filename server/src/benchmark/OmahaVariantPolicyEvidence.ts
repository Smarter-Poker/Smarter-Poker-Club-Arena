import type { Card, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import type { OmahaPolicyVariant } from '../engine/omaha/OmahaVariantPolicyPack.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import { calculatePots, calculateContestablePot } from '../engine/PokerEngine.js';
import type { OmahaVariantPolicyInput } from './OmahaVariantPolicyProgram.js';

export function variantCards(value: string): Card[] {
  return value.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));
}
export function omahaVariantSpot(
  variant: OmahaPolicyVariant,
  street: 'preflop' | 'flop' | 'turn' | 'river' = 'river',
  seats = 2,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const hero: SeatPlayer = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 100,
    bet: street === 'preflop' ? 1 : 0,
    totalInvested: street === 'preflop' ? 1 : 20,
    cards: variantCards(
      variant === 'plo5'
        ? 'As Ad Ks Kd Qs'
        : variant === 'plo6'
          ? 'As Ad Ks Kd Qs Jd'
          : 'As 2s 3d Ac'
    ),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const players = Array.from({ length: seats }, (_, index) =>
    index === 0
      ? { ...hero, cards: [] }
      : {
          ...hero,
          user_id: `v${index + 1}`,
          username: `V${index + 1}`,
          seat: index + 1,
          cards: [],
          bet: index === 1 ? (street === 'preflop' ? 2 : 20) : 0,
          totalInvested: street === 'preflop' ? (index === 1 ? 2 : 0) : index === 1 ? 40 : 20,
        }
  );
  const currentBet = street === 'preflop' ? 2 : 20;
  const pot = players.reduce((n, p) => n + p.totalInvested, 0);
  const state: HorseGameStateV2 = {
    players,
    communityCards:
      street === 'preflop'
        ? []
        : variantCards('4s 5s 8d Kh Qd').slice(0, { flop: 3, turn: 4, river: 5 }[street]),
    pot,
    currentBet,
    contestablePot: calculateContestablePot(players, hero.user_id, currentBet - hero.bet),
    minRaise: currentBet,
    lastRaise: currentBet,
    stage: street,
    gameVariant: variant,
    bigBlind: 2,
    stateSchemaVersion: 1,
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'sng',
    dealerSeat: 1,
    heroSeat: 1,
    currentPlayerSeat: 1,
    bettingStructure: 'pot_limit',
    variantRules: horseVariantRulesFor(variant),
    pots: calculatePots(players),
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    legalActions: ['fold', 'call', 'raise'],
    toCall: currentBet - hero.bet,
    minRaiseTo: currentBet * 2,
    maxRaiseTo: Math.min(hero.stack + hero.bet, currentBet + pot + currentBet - hero.bet),
    rakeConfig: { percent: mode === 'cash' ? 5 : 0, cap: 10, noFlopNoDrop: true },
    actionHistory:
      street === 'preflop'
        ? []
        : [
            {
              userId: 'v2',
              seat: 2,
              action: 'bet',
              amount: 20,
              stage: street,
              timestamp: 1,
              isFullRaise: true,
            },
          ],
  };
  if (mode === 'tournament') {
    state.pots = calculatePots(players);
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
  }
  return {
    hero,
    state,
    baseline: { action: 'call', amount: state.toCall, thinkTime: 0 } as HorseDecision,
  };
}

export function omahaVariantReferenceSpots(): {
  name: string;
  input: OmahaVariantPolicyInput;
  expectedShare: number;
}[] {
  const result: ReturnType<typeof omahaVariantReferenceSpots> = [];
  for (const variant of ['plo5', 'plo6'] as const) {
    const s = omahaVariantSpot(variant);
    s.hero.cards = variantCards('Qs Js 9c 8d 6h' + (variant === 'plo6' ? ' 5h' : ''));
    s.state.communityCards = variantCards('As Ks Ts 2d 3h');
    result.push({
      name: `${variant}-royal-value`,
      expectedShare: 1,
      input: {
        ...s,
        mode: 'candidate',
        seed: 11109901,
        opponentRanges: {
          v2: {
            combos: [
              {
                cards: variantCards('Qh Qd 7c 6d 4c' + (variant === 'plo6' ? ' 5c' : '')),
                weight: 1,
              },
            ],
          },
        },
      },
    });
    const weak = omahaVariantSpot(variant);
    weak.hero.cards = variantCards('9s 8s Kc Qd 6h' + (variant === 'plo6' ? ' 5h' : ''));
    weak.state.communityCards = variantCards('As 7s 3s 2d Jh');
    result.push({
      name: `${variant}-dominated-flush`,
      expectedShare: 0,
      input: {
        ...weak,
        mode: 'candidate',
        seed: 11109901,
        opponentRanges: {
          v2: {
            combos: [
              {
                cards: variantCards('Ks Qs 6c 5d 4c' + (variant === 'plo6' ? ' Td' : '')),
                weight: 1,
              },
            ],
          },
        },
      },
    });
  }
  const quarter = omahaVariantSpot('plo8');
  quarter.hero.cards = variantCards('As 2s Jh Td');
  quarter.state.communityCards = variantCards('3c 4d 8h Kc Qh');
  result.push({
    name: 'plo8-expensive-quartered-low',
    expectedShare: 0.25,
    input: {
      ...quarter,
      mode: 'candidate',
      seed: 11109901,
      opponentRanges: { v2: { combos: [{ cards: variantCards('Ah 2h Kh Kd'), weight: 1 }] } },
    },
  });
  const sixth = omahaVariantSpot('plo8', 'river', 3);
  sixth.hero.cards = variantCards('As 2s Jh Td');
  sixth.state.players[2].totalInvested = 40;
  sixth.state.pot = 100;
  sixth.state.communityCards = variantCards('3c 4d 8h Kc Qh');
  result.push({
    name: 'plo8-sixthed-low',
    expectedShare: 1 / 6,
    input: {
      ...sixth,
      mode: 'candidate',
      seed: 11109901,
      opponentRanges: {
        v2: { combos: [{ cards: variantCards('Ah 2h Kh Kd'), weight: 1 }] },
        v3: { combos: [{ cards: variantCards('Ad 2d Qc Qd'), weight: 1 }] },
      },
    },
  });
  const noLow = omahaVariantSpot('plo8');
  noLow.hero.cards = variantCards('Qs Js 9c 8d');
  noLow.state.communityCards = variantCards('As Ks Ts 2d Jh');
  result.push({
    name: 'plo8-no-low-whole-high',
    expectedShare: 1,
    input: {
      ...noLow,
      mode: 'candidate',
      seed: 11109901,
      opponentRanges: { v2: { combos: [{ cards: variantCards('Qh Qd 7c 6h'), weight: 1 }] } },
    },
  });
  const side = omahaVariantSpot('plo8', 'river', 3);
  side.hero.cards = variantCards('5c 6c Kh Ks');
  side.hero.totalInvested = 200;
  side.state.players[0] = { ...side.hero, cards: [] };
  side.state.players[1].totalInvested = 50;
  side.state.players[1].stack = 0;
  side.state.players[1].is_all_in = true;
  side.state.players[2].totalInvested = 200;
  side.state.players.forEach((p) => (p.bet = 0));
  Object.assign(side.state, {
    communityCards: variantCards('3c 4c 8c Kd Qh'),
    currentBet: 0,
    toCall: 0,
    pot: 450,
    legalActions: ['check', 'bet'],
    minRaiseTo: 2,
    maxRaiseTo: 100,
    actionHistory: [],
  });
  side.baseline = { action: 'check', thinkTime: 0 };
  result.push({
    name: 'plo8-short-stack-wins-main-hero-scoops-side',
    expectedShare: 2 / 3,
    input: {
      ...side,
      mode: 'candidate',
      seed: 11109901,
      opponentRanges: {
        v2: { combos: [{ cards: variantCards('Ac 2c Jd Th'), weight: 1 }] },
        v3: { combos: [{ cards: variantCards('Qd Qs Jh Td'), weight: 1 }] },
      },
    },
  });
  return result;
}
