import {
  freshExploitCounters,
  exploitHandIncrements,
  decayAndAdd,
} from './HorseOpponentExploit.js';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/horse-plo5-small-flush-45855223.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, variantInfo } from './HorseEval.js';
import { calculateContestablePot, calculatePots } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import type { ActionRecord, Card, HorseStyle, SeatPlayer } from '../types.js';

type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8';
type Captured = Extract<HorsePublicActionNode, { status: 'captured' }>;
const actions = fixture.actions as unknown as Array<ActionRecord & { publicNode?: Captured }>;
const holdings = fixture.heroCards as Record<string, Card[]>;
const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
const variants: Variant[] = ['plo4', 'plo5', 'plo6', 'plo8'];
const bySeat = new Map(actions.map((action) => [action.seat, action.userId]));

/** Accepted public controller nodes and this actor's revealed cards only.
 * The other seats retain empty cards, including WooWoo. Historical read frames
 * and the original RNG are unavailable: this is a scoped decision regression,
 * not a claim to replay the original worker's exact learned state. */
function incident(ordinal: number, variant: Variant = 'plo5') {
  const action = actions[ordinal];
  const n = action.publicNode;
  if (!n || n.status !== 'captured' || n.deductions?.status !== 'captured')
    throw Error('accepted public decision node missing');
  const players: SeatPlayer[] = n.seats.map(
    ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) =>
      ({
        seat,
        user_id: bySeat.get(seat)!,
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
      }) as SeatPlayer
  );
  const ownCards = holdings[action.userId].map((card) => ({ ...card }));
  // The extra card removed/added is unrelated to the flush or public board.
  if (variant === 'plo4' || variant === 'plo8') ownCards.splice(3, 1);
  if (variant === 'plo6') ownCards.push({ rank: '3', suit: 'clubs' });
  const hero: SeatPlayer = {
    ...players.find((player) => player.seat === action.seat)!,
    cards: ownCards,
  };
  const communityCards = fixture.communityCards
    .slice(0, n.street === 'flop' ? 3 : n.street === 'turn' ? 4 : 5)
    .map((card) => ({ rank: card[0], suit: card.slice(1) }) as Card);
  const state: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: players.map((player) => player.seat),
    blindSeats: { smallBlind: 3, bigBlind: 5 },
    chipUnit: n.chipUnit,
    asset: n.asset,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    legalActions: [...n.legalActions],
    toCall: n.toCall,
    minRaiseTo: n.minRaiseTo,
    maxRaiseTo: n.maxRaiseTo,
    bettingStructure: n.structure,
    fixedBetSize: n.fixedBetSize,
    wagersCapped: n.wagersCapped,
    pots: calculatePots(players),
    contestablePot: calculateContestablePot(players, hero.user_id, n.toCall),
    rakeConfig: {
      ...n.deductions.rake,
      playerCountCaps: n.deductions.rake.playerCountCaps.map(([players, cap]) => ({
        players,
        cap,
      })),
    },
    bbjConfig: n.deductions.bbj,
    variantRules: horseVariantRulesFor(variant),
    players,
    communityCards,
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: n.pot,
    currentBet: n.currentBet,
    minRaise: ordinal <= 19 ? n.bigBlind : 160,
    lastRaise: ordinal <= 19 ? n.bigBlind : 160,
    stage: n.street,
    gameVariant: variant,
    bigBlind: n.bigBlind,
    dealerSeat: n.dealerSeat,
    actionHistory: actions.slice(0, ordinal),
    gameMode: n.mode,
    format: 'cash',
    ante: n.ante,
    straddleActive: false,
  };
  return { hero, state };
}

function decide(ordinal: number, variant: Variant, style: HorseStyle, seed: number, nuts = false) {
  HorseMind.reset();
  const uid = actions[20].userId,
    counters = freshExploitCounters();
  const increments = exploitHandIncrements([
    { userId: uid, action: 'raise', stage: 'preflop' },
    { userId: 'opponent', action: 'call', stage: 'preflop' },
    { userId: uid, action: 'bet', stage: 'flop' },
    { userId: 'opponent', action: 'call', stage: 'flop' },
    { userId: uid, action: 'bet', stage: 'turn' },
    { userId: 'opponent', action: 'call', stage: 'turn' },
    { userId: uid, action: 'bet', stage: 'river' },
  ]).get(uid)!;
  for (let i = 0; i < 80; i++) decayAndAdd(counters, increments);
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: uid,
      variant,
      mode: 'cash',
      size: 'short',
      observed_hands: 80,
      initialized: true,
      counters,
    },
  ]);
  seedFastRandom(100 + seed);
  const spot = incident(ordinal, variant);
  if (nuts) {
    spot.hero.cards[0] = { rank: 'A', suit: 'diamonds' };
    spot.hero.cards[1] = { rank: '4', suit: 'diamonds' };
  }
  return HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false });
}

afterEach(() => {
  HorseMind.reset();
  drainFires();
});

describe('reported PLO5 small-flush hand 45855223', () => {
  it('preserves the real short raise, main-pot eligibility and cheap final call', () => {
    expect(actions[20].isFullRaise).toBe(false);
    const cole = incident(21);
    expect(cole.state.toCall).toBe(181.75);
    expect(cole.hero.stack).toBe(135.05);
    expect(cole.state.contestablePot).toBe(538.1);
    expect(incident(22).state.toCall).toBe(21.75);
    expect(incident(22).state.contestablePot).toBe(744.8);
    expect(cole.state.players.every((player) => player.cards.length === 0)).toBe(true);
  });

  function features(spot: ReturnType<typeof incident>) {
    HorseMind.reset();
    seedFastRandom(100);
    enableBrainTelemetry();
    drainFires();
    HorseLogic.decide(spot.hero, spot.state, 'balanced', {}, { telemetry: true });
    return drainFires().map((row) => row.feature);
  }

  it('distinguishes street-total short raises from all-in calls after paid-delta calls', () => {
    const key = 'horse_continuation_omaha_cold_flush_pressure';
    expect(features(incident(21))).toContain(key);
    const call = incident(21);
    call.state.actionHistory = call.state.actionHistory!.map((a, i) =>
      i === 20 ? { ...a, amount: 160 } : a
    );
    expect(features(call)).not.toContain(key);
    const priorCall = incident(21);
    const jam = priorCall.state.actionHistory![20];
    priorCall.state.actionHistory = [
      ...priorCall.state.actionHistory!.slice(0, 20),
      { ...jam, action: 'call', amount: 160 },
      { ...jam, amount: 181.75 },
    ];
    expect(features(priorCall)).toContain(key);
  });

  it('excludes unrelated side-pot aggression and earlier streets', () => {
    const key = 'horse_continuation_omaha_cold_flush_pressure';
    const isolated = incident(21);
    isolated.state.pots = [
      { amount: 538.1, eligiblePlayers: [isolated.hero.user_id, actions[19].userId] },
    ];
    expect(features(isolated)).not.toContain(key);
    const earlier = incident(21);
    earlier.state.stage = 'turn';
    earlier.state.communityCards = earlier.state.communityCards.slice(0, 4);
    expect(features(earlier)).not.toContain(key);
  });

  it('does not impose the called-through check when one caller has folded', () => {
    const spot = incident(19);
    spot.state.players.find((p) => p.user_id === actions[21].userId)!.is_folded = true;
    expect(features(spot)).not.toContain('horse_continuation_omaha_called_through_flush_check');
  });

  it('preserves genuine split-low and multi-board paths', () => {
    for (const multi of [false, true]) {
      const spot = incident(21, multi ? 'plo5' : 'plo8');
      if (multi) {
        spot.state.boardCount = 2;
        spot.state.communityCards2 = spot.state.communityCards.map((c) => ({ ...c }));
      } else
        spot.state.communityCards = [
          { rank: '3', suit: 'diamonds' },
          { rank: '4', suit: 'diamonds' },
          { rank: '7', suit: 'diamonds' },
          { rank: '8', suit: 'clubs' },
          { rank: '9', suit: 'spades' },
        ];
      expect(features(spot)).not.toContain('horse_continuation_omaha_cold_flush_pressure');
    }
  });

  for (const variant of variants) {
    it(`${variant}: checks the third-nut flush after both live opponents called two streets`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 8; seed++)
          expect(decide(19, variant, style, seed).action, `${style}/${seed}`).toBe('check');
    });

    it(`${variant}: retains value betting with a second-nut flush`, () => {
      for (const style of styles) {
        HorseMind.reset();
        seedFastRandom(100);
        const spot = incident(19, variant);
        spot.hero.cards[spot.hero.cards.length === 4 ? 3 : 4] = { rank: 'K', suit: 'diamonds' };
        expect(['bet', 'all_in']).toContain(
          HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false }).action
        );
      }
    });
    it(`${variant}: declines the cold stack-off with a dominated low flush after a bet and short jam`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 8; seed++) {
          const decision = decide(21, variant, style, seed);
          expect(decision.action, `${style}/${seed}`).toBe('fold');
          expect(decision.continuationGuard).toBe('omaha_cold_flush_pressure');
        }
    });

    it(`${variant}: preserves nut-flush calls against the same known maniac`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 8; seed++) {
          const d = decide(21, variant, style, seed, true);
          expect(['call', 'all_in']).toContain(d.action);
        }
    });

    it(`${variant}: retains the cheap final call after hero has already bet`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 3; seed++)
          expect(decide(22, variant, style, seed).action, `${style}/${seed}`).toBe('call');
    });

    it(`${variant}: still bets the actual nut flush when checked to`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 3; seed++)
          expect(['bet', 'all_in']).toContain(decide(19, variant, style, seed, true).action);
    });
  }
});

/*
 * V53 MEASUREMENT SWITCHES (2026-10-24): the #7866 cold-flush, called-through
 * and maniac-recovery layers each have a default-on switch. On the same
 * retained incident, off removes exactly that layer.
 */
describe('V53 switches remove exactly their own layer on incident 45855223', () => {
  function firesWith(spot: ReturnType<typeof incident>, extra: Record<string, boolean>) {
    HorseMind.reset();
    seedFastRandom(100);
    enableBrainTelemetry();
    drainFires();
    HorseLogic.decide(spot.hero, spot.state, 'balanced', {}, { telemetry: true, ...extra });
    return drainFires().map((row) => row.feature);
  }
  it('v53ColdFlushPressure off: the cold jam is no longer raised-line evidence', () => {
    const key = 'horse_continuation_omaha_cold_flush_pressure';
    expect(firesWith(incident(21), {})).toContain(key);
    expect(firesWith(incident(21), { v53ColdFlushPressure: false })).not.toContain(key);
    for (const variant of ['plo4', 'plo5', 'plo6'] as const) {
      HorseMind.reset();
      seedFastRandom(100);
      const spot = incident(21, variant);
      const d = HorseLogic.decide(
        spot.hero,
        spot.state,
        'balanced',
        {},
        {
          telemetry: false,
          v53ColdFlushPressure: false,
        }
      );
      expect(d.continuationGuard).not.toBe('omaha_cold_flush_pressure');
    }
  });
  it('v53CalledThroughFlush off: the third-nut flush is no longer forced to check', () => {
    const key = 'horse_continuation_omaha_called_through_flush_check';
    expect(firesWith(incident(19), {})).toContain(key);
    expect(firesWith(incident(19), { v53CalledThroughFlush: false })).not.toContain(key);
  });
  it('v53ManiacRecovery off: a guarded fold is reopened by the pre-#7866 recovery', () => {
    for (const variant of ['plo4', 'plo5', 'plo6'] as const) {
      HorseMind.setDecisionScope('omaha:short', variant, 'cash');
      const spot = incident(21, variant);
      const guarded = {
        action: 'fold' as const,
        thinkTime: 0,
        continuationGuard: 'omaha_cold_flush_pressure' as const,
      };
      enableBrainTelemetry();
      drainFires();
      HorseLogic.__testables.maniacCallDown(guarded, spot.hero, spot.state, variantInfo(variant), {
        telemetry: true,
      });
      expect(drainFires().map((r) => r.feature)).toContain(
        'horse_continuation_protected_fold_retained'
      );
      HorseLogic.__testables.maniacCallDown(guarded, spot.hero, spot.state, variantInfo(variant), {
        telemetry: true,
        v53ManiacRecovery: false,
      });
      expect(drainFires().map((r) => r.feature)).not.toContain(
        'horse_continuation_protected_fold_retained'
      );
      HorseMind.setDecisionScope(null);
    }
  });
});
