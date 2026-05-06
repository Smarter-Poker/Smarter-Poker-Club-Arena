/**
 * ♠ V8 BIBLE COMPLIANCE — Chapter 3: State Machines
 * ═══════════════════════════════════════════════════════════════
 * Bible Ref: Chapter 3
 * Tests the hand state machine transitions:
 * IDLE → POSTING_BLINDS → DEALING_HOLE_CARDS → PREFLOP_BETTING →
 * DEALING_FLOP → FLOP_BETTING → DEALING_TURN → TURN_BETTING →
 * DEALING_RIVER → RIVER_BETTING → SHOWDOWN → SETTLEMENT → CLEANUP → IDLE
 *
 * Also covers stage progression (Bible 4.16-4.18) and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { HandController, type HandConfig } from '../../../src/engine/HandController';
import type { Card, SeatPlayer } from '../../../src/types/database.types';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function makeConfig(overrides?: Partial<HandConfig>): HandConfig {
  return {
    tableId: 'bible-fsm-test',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 3, noFlop: true },
    ...overrides,
  };
}

function makePlayers(count: number, stack = 200): SeatPlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    seat: i + 1,
    user_id: `player-${i + 1}`,
    username: `Player${i + 1}`,
    avatar_url: '',
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [] as Card[],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
}

function collectEvents(hc: HandController) {
  const events: any[] = [];
  hc.onEvent((e: any) => events.push(e));
  return events;
}

// ═══════════════════════════════════════════════════════════════
// 3.2 — Hand State Machine: Stage Progression
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — 3.2: Hand State Machine', () => {
  it('starts in preflop stage after hand start', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();
    expect(hc.getState().stage).toBe('preflop');
  });

  it('advances from preflop to flop when all players act', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    // UTG calls, SB calls, BB checks — should advance to flop
    let state = hc.getState();
    hc.performAction(state.currentPlayer!, 'call', 2); // UTG calls BB

    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'call', 2); // SB calls (posts 1 more)

    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0); // BB checks

    state = hc.getState();
    expect(state.stage).toBe('flop');
    expect(state.communityCards.length).toBe(3); // Bible 4.16: deal 3 cards
  });

  it('advances from flop to turn', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    hc.start();

    // Preflop: SB(dealer) calls, BB checks
    let state = hc.getState();
    hc.performAction(state.currentPlayer!, 'call', 2);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // Flop: both check
    state = hc.getState();
    expect(state.stage).toBe('flop');
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    state = hc.getState();
    expect(state.stage).toBe('turn');
    expect(state.communityCards.length).toBe(4); // Bible 4.17: deal 1 more card
  });

  it('advances from turn to river', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    hc.start();

    // Preflop: call + check
    let state = hc.getState();
    hc.performAction(state.currentPlayer!, 'call', 2);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // Flop: check + check
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // Turn: check + check
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    state = hc.getState();
    expect(state.stage).toBe('river');
    expect(state.communityCards.length).toBe(5); // Bible 4.18: deal 1 more card
  });

  it('reaches showdown after river betting completes', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    hc.start();

    // Play through all streets: call, then check-check on each
    let state = hc.getState();
    hc.performAction(state.currentPlayer!, 'call', 2);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // Flop
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // Turn
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    // River
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'check', 0);

    state = hc.getState();
    // Should be in showdown or complete
    expect(['showdown', 'complete']).toContain(state.stage);
  });
});

// ═══════════════════════════════════════════════════════════════
// Everyone folds = hand ends immediately
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Immediate Win (all fold)', () => {
  it('hand ends when all but one player folds', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // UTG folds
    let state = hc.getState();
    hc.performAction(state.currentPlayer!, 'fold', 0);

    // SB folds — BB should win
    state = hc.getState();
    hc.performAction(state.currentPlayer!, 'fold', 0);

    state = hc.getState();
    // Hand should be complete
    expect(['showdown', 'complete']).toContain(state.stage);

    // Should have a WINNER event
    const winnerEvent = events.find((e: any) => e.type === 'WINNER' || e.type === 'HAND_COMPLETE');
    expect(winnerEvent).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Bible 4.5: Card dealing — variant-aware
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — 4.5: Variant Card Dealing', () => {
  it('PLO4 deals 4 cards per player', () => {
    const hc = new HandController(makeConfig({ gameVariant: 'plo4' }), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const dealEvents = events.filter((e: any) => e.type === 'CARDS_DEALT');
    for (const de of dealEvents) {
      expect(de.cards).toHaveLength(4);
    }
  });

  it('PLO5 deals 5 cards per player', () => {
    const hc = new HandController(makeConfig({ gameVariant: 'plo5' }), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const dealEvents = events.filter((e: any) => e.type === 'CARDS_DEALT');
    for (const de of dealEvents) {
      expect(de.cards).toHaveLength(5);
    }
  });

  it('NLH deals exactly 2 cards per player', () => {
    const hc = new HandController(makeConfig(), makePlayers(6), 1);
    const events = collectEvents(hc);
    hc.start();

    const dealEvents = events.filter((e: any) => e.type === 'CARDS_DEALT');
    expect(dealEvents).toHaveLength(6);
    for (const de of dealEvents) {
      expect(de.cards).toHaveLength(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Bible 4.3: Ante handling
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — 4.3: Ante Handling', () => {
  it('traditional ante: all players post ante before cards', () => {
    const config = makeConfig({ ante: 1 });
    const hc = new HandController(config, makePlayers(4), 1);
    hc.start();

    const state = hc.getState();
    // Pot = SB(1) + BB(2) + 4 antes(1 each) = 7
    expect(state.pot).toBe(7);
  });

  it('ante with short stack: player posts what they can', () => {
    const players = makePlayers(3, 100);
    players[2].stack = 0.5; // Less than ante

    const config = makeConfig({ ante: 1 });
    const hc = new HandController(config, players, 1);
    hc.start();

    // Short-stacked player should post partial ante
    const state = hc.getState();
    const shortPlayer = state.players.find((p) => p.seat === 3)!;
    expect(shortPlayer.totalInvested).toBeLessThanOrEqual(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════
// Bible 4.22: Bomb Pot
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — 4.22: Bomb Pot', () => {
  it('skips preflop betting and deals directly to flop', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(4), 1);
    hc.start();

    const state = hc.getState();
    // Bomb pot should skip preflop and go to flop
    expect(state.stage).toBe('flop');
    expect(state.communityCards.length).toBe(3);
  });

  it('bomb pot ante = multiplier * BB per player', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 3 } });
    const hc = new HandController(config, makePlayers(4), 1);
    hc.start();

    const state = hc.getState();
    // Each player antes 3 * 2(BB) = 6, total = 24
    expect(state.pot).toBe(24);
  });
});
