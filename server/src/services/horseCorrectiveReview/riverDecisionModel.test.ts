import { describe, it, expect } from 'vitest';
import { buildOriginalRiverDecision, RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { priceRiverCallFoldDecision } from './riverReference.js';
import { cards, bind, riverReferenceFixture } from './riverReference.test-support.js';
import { saveFastRandom } from '../../engine/HorseEval.js';
import { HandController } from '../../engine/HandController.js';
import { calculateContestablePot } from '../../engine/PokerEngine.js';
import type { HandConfig } from '../../types.js';
describe('original-only finite river decision model', () => {
  it.each(['diamonds', 'dead-money', 'individual-ante'] as const)(
    'does not extend qualified cent-chip economics to %s',
    (family) => {
      const original = riverReferenceFixture().original,
        gs = original.snapshot.gameState;
      if (family === 'diamonds') {
        gs.asset = 'diamonds';
        gs.chipUnit = 1;
      } else if (family === 'dead-money') {
        gs.players[0]!.deadInvested = 1;
        original.snapshot.player.deadInvested = 1;
      } else {
        gs.players[0]!.individualAnteInvested = 1;
        original.snapshot.player.individualAnteInvested = 1;
      }
      expect(buildOriginalRiverDecision(original)).toMatchObject({
        status: 'unavailable',
        reason:
          family === 'diamonds'
            ? 'original_model_money_unit_unsupported'
            : 'original_model_pot_domain_unsupported',
      });
    }
  );
  it('reaches a real controller river menu and preserves its accepted call', () => {
    const original = riverReferenceFixture().original;
    const players = original.snapshot.gameState.players.map((p) => ({
      ...p,
      stack: 100,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_all_in: false,
    }));
    const rakeConfig = { percent: 0, cap: 0, noFlopNoDrop: true };
    const hc = new HandController(
      {
        tableId: 'river-model-local',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig,
      } as HandConfig,
      players,
      1
    );
    hc.start();
    for (let n = 0; n < 12 && hc.getState().stage !== 'river'; n++) {
      const s = hc.getState(),
        p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
      const menu = hc.getAuthoritativeActionState(p.user_id)!;
      expect(hc.performAction(p.seat, menu.toCall > 0 ? 'call' : 'check')).toBe(true);
    }
    expect(hc.getState().stage).toBe('river');
    expect(hc.getState().currentPlayerSeat).toBe(2);
    expect(hc.performAction(2, 'all_in')).toBe(true);
    const state = hc.getState(),
      hero = state.players.find((p) => p.seat === 1)!;
    const menu = hc.getAuthoritativeActionState(hero.user_id)!;
    expect(menu.legalActions).toContain('all_in');
    original.snapshot.player = hero;
    original.snapshot.gameState = {
      ...original.snapshot.gameState,
      stage: state.stage,
      communityCards: state.communityCards,
      communityCards2: state.communityCards2,
      communityCards3: state.communityCards3,
      pot: state.pot,
      currentBet: state.currentBet,
      dealerSeat: state.dealerSeat,
      actionHistory: state.actionHistory,
      players: state.players.map((p) => ({ ...p, cards: [] })),
      legalActions: menu.legalActions,
      toCall: menu.toCall,
      minRaiseTo: menu.minRaiseTo,
      maxRaiseTo: menu.maxRaiseTo,
      bigBlind: 2,
      rakeConfig,
      contestablePot: calculateContestablePot(
        state.players,
        hero.user_id,
        Math.min(menu.toCall, hero.stack)
      ),
    };
    const built = buildOriginalRiverDecision(original);
    expect(built.status, JSON.stringify(built)).toBe('built');
    expect(hc.performAction(1, 'call')).toBe(true);
    expect(hc.getState().players.reduce((n, p) => n + p.stack, 0)).toBe(200);
  });
  it('caps its call at the original stack while keeping the controller full price', () => {
    const i = riverReferenceFixture();
    i.stack = 20;
    i.toCall = 20;
    i.contestablePot = 70;
    bind(i);
    i.original.snapshot.gameState.toCall = 50;
    i.original.snapshot.gameState.currentBet = 50;
    i.original.snapshot.gameState.players[1]!.bet = 50;
    const r = buildOriginalRiverDecision(i.original);
    expect(r.status).toBe('built');
    if (r.status === 'built')
      expect(r.prices.alternatives[1]).toMatchObject({
        choice: { action: 'call', amount: 20 },
        mean: 33,
      });
  });
  it.each([
    'nlh',
    'flh',
    'pineapple',
    'short_deck',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
  ] as const)('builds a bounded physically valid %s model without future hand facts', (variant) => {
    const i = riverReferenceFixture();
    i.domain.variant = variant;
    const count =
      variant === 'plo5'
        ? 5
        : variant === 'plo6'
          ? 6
          : ['plo4', 'plo8', 'flo8'].includes(variant)
            ? 4
            : 2;
    i.hero = cards('As Ah 2s 3s 4s 5s'.split(' ').slice(0, count).join(' '));
    bind(i);
    const rng = saveFastRandom(),
      a = buildOriginalRiverDecision(i.original),
      b = buildOriginalRiverDecision(i.original);
    expect(a.status).toBe('built');
    expect(a).toEqual(b);
    expect(saveFastRandom()).toBe(rng);
    if (a.status !== 'built') return;
    expect(a.input.range).toHaveLength(RIVER_DECISION_MODEL.samples);
    expect(
      new Set(
        a.input.range.map((r) =>
          r.cards
            .map((c) => c.rank + c.suit)
            .sort()
            .join('|')
        )
      ).size
    ).toBe(RIVER_DECISION_MODEL.samples);
    expect(priceRiverCallFoldDecision(a.input).status).toBe('priced');
    expect(a).toMatchObject({ qualified: false, activationAllowed: false });
    expect(a.input).not.toHaveProperty('binding');
    expect(a.input).not.toHaveProperty('finalRake');
  });
  it('does not use actor identity or caller-supplied retrospective range rows to choose its range', () => {
    const a = riverReferenceFixture().original,
      b = structuredClone(a);
    b.snapshot.player.user_id = 'renamed-hero';
    b.snapshot.gameState.players[0]!.user_id = 'renamed-hero';
    b.snapshot.gameState.players[1]!.user_id = 'renamed-opponent';
    b.readFrame = { declaredRange: 'different' };
    const one = buildOriginalRiverDecision(a),
      two = buildOriginalRiverDecision(b);
    expect(one.status).toBe('built');
    expect(two.status).toBe('built');
    if (one.status === 'built' && two.status === 'built')
      expect(one.input.range).toEqual(two.input.range);
  });
  it.each(['turn', 'hidden-cards', 'opponent-not-all-in', 'another-board'])(
    'refuses %s source instead of borrowing future information',
    (fault) => {
      const i = riverReferenceFixture().original;
      if (fault === 'turn') i.snapshot.gameState.stage = 'turn';
      if (fault === 'hidden-cards') i.snapshot.gameState.players[1]!.cards = cards('Ks Kh');
      if (fault === 'opponent-not-all-in') i.snapshot.gameState.players[1]!.is_all_in = false;
      if (fault === 'another-board') i.snapshot.gameState.communityCards2 = cards('2s 3s 4s 5s 6s');
      expect(buildOriginalRiverDecision(i).status).toBe('unavailable');
    }
  );
});
