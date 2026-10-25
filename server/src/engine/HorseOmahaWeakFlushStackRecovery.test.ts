import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, HandConfig, SeatPlayer, HorseDecision } from '../types.js';
import { HorseMind } from './HorseMind.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { seedFastRandom, variantInfo, omahaNutStatus } from './HorseEval.js';
import {
  freshExploitCounters,
  exploitHandIncrements,
  decayAndAdd,
} from './HorseOpponentExploit.js';
import { HandController } from './HandController.js';
import { Deck, calculateContestablePot } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import assert from 'node:assert/strict';
type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8';
const suitNames: Record<string, Card['suit']> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};
const cards = (text: string): Card[] =>
  text.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suitNames[c[1]] }));
const uid = '10000000-0000-4000-8000-000000000001';
function memory(v: Variant) {
  const c = freshExploitCounters(),
    inc = exploitHandIncrements([
      { userId: uid, action: 'raise', stage: 'preflop' },
      { userId: 'other', action: 'call', stage: 'preflop' },
      { userId: uid, action: 'bet', stage: 'flop' },
      { userId: 'other', action: 'call', stage: 'flop' },
      { userId: uid, action: 'bet', stage: 'turn' },
      { userId: 'other', action: 'call', stage: 'turn' },
      { userId: uid, action: 'bet', stage: 'river' },
    ]).get(uid)!;
  for (let i = 0; i < 80; i++) decayAndAdd(c, inc);
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: uid,
      variant: v,
      mode: 'cash',
      size: 'hu',
      observed_hands: 80,
      initialized: true,
      counters: c,
    },
  ]);
}
function spot(
  v: Variant,
  phase: 'flop' | 'turn' | 'river' = 'river',
  strength: 'weak' | 'second' | 'nut' = 'weak',
  cheap = false,
  unraised = false
) {
  const count = v === 'plo4' || v === 'plo8' ? 4 : v === 'plo5' ? 5 : 6;
  const prefix = [
    ...cards('As Ac Ks Kc Ts 3h').slice(0, count),
    ...cards(
      strength === 'nut'
        ? 'Qh 4d Ad Jh 5h 3c'
        : strength === 'second'
          ? 'Qh 2d Kd Jh 5h 3c'
          : 'Qh 2d 9d Jh 5h 3c'
    ).slice(0, count),
    ...cards('6d Jd Qd 8c 9s'),
  ];
  const original = Deck.prototype.shuffle;
  Deck.prototype.shuffle = function (this: Deck) {
    const deck = (this as unknown as { cards: Card[] }).cards;
    const rest = deck.filter((c) => !prefix.some((p) => p.rank === c.rank && p.suit === c.suit));
    deck.splice(0, deck.length, ...prefix, ...rest);
  };
  const config: HandConfig = {
    tableId: '20000000-0000-4000-8000-000000000001',
    handNumber: 1,
    gameVariant: v,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players: SeatPlayer[] = [1, 2].map((seat) => ({
    seat,
    user_id: seat === 1 ? uid : '20000000-0000-4000-8000-000000000002',
    username: `Seat${seat}`,
    stack:
      seat === 1
        ? 300
        : unraised
          ? 162
          : cheap
            ? 400
            : phase === 'flop'
              ? 36
              : phase === 'turn'
                ? 108
                : 270,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(config, players, 1);
  try {
    controller.start();
  } finally {
    Deck.prototype.shuffle = original;
  }
  assert(controller.performAction(1, 'raise', 6));
  assert(controller.performAction(2, 'call'));
  if (phase !== 'flop') {
    assert(controller.performAction(2, 'check'));
    assert(controller.performAction(1, 'bet', 12));
    assert(controller.performAction(2, 'call'));
  }
  if (phase === 'river') {
    assert(controller.performAction(2, 'check'));
    assert(controller.performAction(1, 'bet', 36));
    assert(controller.performAction(2, 'call'));
  }
  if (unraised) {
    assert(controller.performAction(2, 'check'));
    assert(controller.performAction(1, 'bet', 108));
  } else {
    const lead = phase === 'flop' ? 6 : phase === 'turn' ? 18 : 36;
    assert(controller.performAction(2, 'bet', lead));
    assert(
      controller.performAction(1, 'raise', phase === 'flop' ? 30 : phase === 'turn' ? 90 : 216)
    );
  }

  const live = controller.getState(),
    actor = controller.getCurrentPlayer()!,
    menu = controller.getAuthoritativeActionState(actor.user_id)!;
  const hero = { ...actor, cards: actor.cards.map((c) => ({ ...c })), knownDeadCards: [] };
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: live.players.map((p) => p.seat),
    blindSeats: controller.getBlindSeatsSnapshot(),
    ...controller.getChipRulesSnapshot(),
    heroSeat: actor.seat,
    currentPlayerSeat: actor.seat,
    legalActions: [...menu.legalActions],
    toCall: menu.toCall,
    minRaiseTo: menu.minRaiseTo,
    maxRaiseTo: menu.maxRaiseTo,
    bettingStructure: menu.structure,
    fixedBetSize: menu.fixedBetSize,
    fixedLimitSmallBet: controller.getFixedLimitSmallBet(),
    wagersCapped: menu.wagersCapped,
    pots: controller.computeLivePots(),
    contestablePot: calculateContestablePot(live.players, actor.user_id, menu.toCall),
    rakeConfig: controller.getRakeConfigSnapshot(),
    variantRules: horseVariantRulesFor(v),
    players: live.players.map((p) => {
      const { knownDeadCards, ...pub } = p;
      return { ...pub, cards: [] };
    }),
    communityCards: [...live.communityCards],
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: live.pot,
    currentBet: live.currentBet,
    minRaise: live.minRaise,
    lastRaise: live.lastRaise,
    stage: live.stage,
    gameVariant: v,
    bigBlind: 2,
    dealerSeat: live.dealerSeat,
    actionHistory: live.actionHistory.map((a) => ({ ...a })),
    gameMode: 'cash',
    format: 'cash',
    ante: 0,
    straddleActive: false,
  };
  return { hero, gs };
}

function decide(
  s: ReturnType<typeof spot>,
  style: 'tag' | 'lag' | 'balanced' | 'tricky' | 'grinder' = 'balanced'
) {
  HorseMind.reset();
  memory(s.gs.gameVariant as Variant);
  seedFastRandom(100);
  const native = vi.spyOn(
    HorseLogic as unknown as { decidePostflop: (...args: unknown[]) => HorseDecision },
    'decidePostflop'
  );
  const final = HorseLogic.decide(s.hero, s.gs, style, {}, { telemetry: false });
  const reference = native.mock.results.at(-1)!.value as HorseDecision;
  native.mockRestore();
  return { reference, final };
}
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('whole-stack weak-flush reference folds survive maniac recovery', () => {
  for (const v of ['plo4', 'plo5', 'plo6'] as const)
    it(`${v}: actual raised river keeps the priced fold for every style`, () => {
      const s = spot(v);
      expect(s.gs.toCall).toBe(180);
      expect(s.hero.stack).toBe(180);
      expect(s.gs.contestablePot).toBe(360);
      expect(omahaNutStatus(s.hero.cards, s.gs.communityCards).higherFlushRanks).toBe(3);
      for (const style of ['tag', 'lag', 'balanced', 'tricky', 'grinder'] as const) {
        const d = decide(s, style);
        expect(d.reference.action).toBe('fold');
        expect(d.final.action).toBe('fold');
      }
    });
  for (const phase of ['flop', 'turn'] as const)
    it(`preserves real ${phase} calls while retaining an existing weak-flush fold`, () => {
      const s = spot('plo5', phase);
      expect(s.gs.toCall).toBe(s.hero.stack);
      const d = decide(s);
      expect(d.reference.action).toBe('call');
      expect(d.final.action).toBe('all_in');
      HorseMind.setDecisionScope('omaha:hu', 'plo5', 'cash');
      expect(
        HorseLogic.__testables.maniacCallDown(
          { action: 'fold', thinkTime: 0 },
          s.hero,
          s.gs,
          variantInfo('plo5'),
          { telemetry: false }
        ).action
      ).toBe('fold');
    });
  for (const strength of ['nut', 'second'] as const)
    it(`preserves ${strength}-nut behavior`, () => {
      const s = spot('plo5', 'river', strength);
      expect(omahaNutStatus(s.hero.cards, s.gs.communityCards).higherFlushRanks).toBe(
        strength === 'nut' ? 0 : 1
      );
      expect(decide(s).final.action).toBe('all_in');
    });
  it('preserves a cheaper known-maniac recovery call', () => {
    const s = spot('plo5', 'river', 'weak', true);
    expect(s.gs.toCall).toBeLessThan(s.hero.stack);
    const d = decide(s);
    expect(d.reference.action).toBe('fold');
    expect(d.final.action).toBe('call');
    expect(d.final.amount).toBe(180);
  });
  it('preserves an already-modeled reference call', () => {
    const d = decide(spot('plo5', 'river', 'weak', false, true));
    expect(d.reference.action).toBe('call');
    expect(d.final.action).toBe('all_in');
  });
  it('preserves the PLO8 split-pot recovery path', () => {
    expect(decide(spot('plo8')).final.action).toBe('all_in');
  });
});

describe('V53 switch: v53ManiacRecovery', () => {
  it('off: the pre-#7876 recovery reopens the whole-stack weak-flush fold', () => {
    for (const v of ['plo4', 'plo5', 'plo6'] as const) {
      const s = spot(v);
      HorseMind.reset();
      memory(v);
      HorseMind.setDecisionScope('omaha:hu', v, 'cash');
      enableBrainTelemetry();
      drainFires();
      const fold = { action: 'fold' as const, thinkTime: 0 };
      HorseLogic.__testables.maniacCallDown(fold, s.hero, s.gs, variantInfo(v), {
        telemetry: true,
      });
      expect(
        drainFires().map((r) => r.feature),
        v
      ).toContain('horse_continuation_omaha_flush_stack_fold_retained');
      HorseLogic.__testables.maniacCallDown(fold, s.hero, s.gs, variantInfo(v), {
        telemetry: true,
        v53ManiacRecovery: false,
      });
      const off = drainFires().map((r) => r.feature);
      expect(off, v).not.toContain('horse_continuation_omaha_flush_stack_fold_retained');
      expect(off, v).toContain('maniac_call_down_checked');
      HorseMind.setDecisionScope(null);
    }
  });
});
