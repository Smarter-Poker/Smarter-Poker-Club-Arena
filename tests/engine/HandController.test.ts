/**
 * ♠ CLUB ARENA — HandController Lifecycle Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests the full hand lifecycle: blinds, dealing, actions, betting rounds,
 * stage advancement, showdown, winner determination, and rake.
 */

import { describe, it, expect, vi } from 'vitest';
import { HandController, type HandConfig } from '../../src/engine/HandController';
import type { Card, SeatPlayer, ActionType } from '../../src/types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function makeConfig(overrides?: Partial<HandConfig>): HandConfig {
  return {
    tableId: 'test-table',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 3, noFlop: true },
    ...overrides,
  };
}

function makePlayers(count: number, stack = 100): SeatPlayer[] {
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

// Collect all events from a hand controller
function collectEvents(hc: HandController) {
  const events: any[] = [];
  hc.onEvent((e) => events.push(e));
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Initialization', () => {
  it('should create a hand controller with correct initial state', () => {
    const config = makeConfig();
    const players = makePlayers(3);
    const hc = new HandController(config, players, 1);

    const state = hc.getState();
    expect(state.stage).toBe('preflop');
    expect(state.players).toHaveLength(3);
    expect(state.communityCards).toHaveLength(0);
    expect(state.pot).toBe(0);
  });

  it('should initialize all players with zero bets and no cards', () => {
    const hc = new HandController(makeConfig(), makePlayers(4), 1);
    const state = hc.getState();

    for (const p of state.players) {
      expect(p.bet).toBe(0);
      expect(p.totalInvested).toBe(0);
      expect(p.is_folded).toBe(false);
      expect(p.is_all_in).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLINDS AND DEALING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Start (Blinds & Deal)', () => {
  it('should post blinds and deal cards on start', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Check events emitted
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('HAND_START');
    expect(eventTypes).toContain('POT_UPDATE');
    expect(eventTypes).toContain('CARDS_DEALT');
    expect(eventTypes).toContain('TURN_CHANGE');

    // Pot should have SB + BB = 3
    const state = hc.getState();
    expect(state.pot).toBe(3); // 1 SB + 2 BB
  });

  it('should deal 2 cards per player for NLH', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const dealEvents = events.filter((e) => e.type === 'CARDS_DEALT');
    expect(dealEvents).toHaveLength(3);
    for (const de of dealEvents) {
      expect(de.cards).toHaveLength(2);
    }
  });

  it('should deal 4 cards per player for PLO4', () => {
    const config = makeConfig({ gameVariant: 'plo4' });
    const hc = new HandController(config, makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const dealEvents = events.filter((e) => e.type === 'CARDS_DEALT');
    for (const de of dealEvents) {
      expect(de.cards).toHaveLength(4);
    }
  });

  it('should handle heads-up blinds correctly (dealer=SB)', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    hc.start();

    const state = hc.getState();
    // Dealer (seat 1) should be SB, seat 2 is BB
    const dealer = state.players.find((p) => p.seat === 1)!;
    const bb = state.players.find((p) => p.seat === 2)!;

    // SB should be 1, BB should be 2
    expect(dealer.totalInvested).toBe(1); // SB
    expect(bb.totalInvested).toBe(2); // BB
    expect(state.pot).toBe(3);
  });

  it('should post antes when configured', () => {
    const config = makeConfig({ ante: 0.5 });
    const hc = new HandController(config, makePlayers(3), 1);
    hc.start();

    const state = hc.getState();
    // SB (1) + BB (2) + 3 antes (0.5 each = 1.5) = 4.5
    expect(state.pot).toBe(4.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOMB POT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Bomb Pot', () => {
  it('should post bomb pot antes instead of blinds', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(4), 1);
    hc.start();

    const state = hc.getState();
    // Each player antes 5 * BB(2) = 10
    expect(state.pot).toBe(40); // 4 * 10
    expect(state.currentBet).toBe(0); // No bet in bomb pot
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER ACTIONS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Player Actions', () => {
  it('should allow fold', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const currentSeat = hc.getState().currentPlayerSeat;
    const result = hc.performAction(currentSeat, 'fold');
    expect(result).toBe(true);

    const playerAfter = hc.getState().players.find((p) => p.seat === currentSeat);
    expect(playerAfter!.is_folded).toBe(true);
  });

  it('should reject action from wrong seat', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    const currentSeat = hc.getState().currentPlayerSeat;
    const wrongSeat = currentSeat === 1 ? 2 : 1;
    const result = hc.performAction(wrongSeat, 'fold');
    expect(result).toBe(false);
  });

  it('should allow valid call', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    const state = hc.getState();
    const currentSeat = state.currentPlayerSeat;
    const result = hc.performAction(currentSeat, 'call');
    expect(result).toBe(true);
  });

  it('should allow valid raise', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    const state = hc.getState();
    const currentSeat = state.currentPlayerSeat;
    // Raise to at least currentBet + lastRaise = 2 + 2 = 4
    const result = hc.performAction(currentSeat, 'raise', 6);
    expect(result).toBe(true);

    const newState = hc.getState();
    expect(newState.currentBet).toBe(6);
  });

  it('should handle all-in action', () => {
    const players = makePlayers(3, 50);
    const hc = new HandController(makeConfig(), players, 1);
    hc.start();

    const currentSeat = hc.getState().currentPlayerSeat;
    const result = hc.performAction(currentSeat, 'all_in');
    expect(result).toBe(true);

    const player = hc.getState().players.find((p) => p.seat === currentSeat);
    expect(player!.is_all_in).toBe(true);
    expect(player!.stack).toBe(0);
  });

  it('ENG-01: should clamp bet to stack to prevent negative stack', () => {
    const players = makePlayers(3, 10); // small stacks
    const hc = new HandController(makeConfig(), players, 1);
    hc.start();

    const currentSeat = hc.getState().currentPlayerSeat;
    // Try to raise way more than stack allows
    const result = hc.performAction(currentSeat, 'raise', 500);
    // This should be clamped
    const player = hc.getState().players.find((p) => p.seat === currentSeat);
    expect(player!.stack).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING ROUND & STAGE ADVANCEMENT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Betting Rounds & Stage Advancement', () => {
  it('should advance to flop after all preflop actions complete', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Get first player to act and call
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'call'); // UTG calls

    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'call'); // SB calls

    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check'); // BB checks

    // Now should be on flop
    state = hc.getState();
    expect(state.stage).toBe('flop');
    expect(state.communityCards).toHaveLength(3);
  });

  it('should advance through all stages: preflop → flop → turn → river → showdown', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    const events = collectEvents(hc);
    hc.start();

    // Preflop: dealer calls (heads-up: dealer is SB, acts first)
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'call');

    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check'); // BB checks

    // Flop
    state = hc.getState();
    expect(state.stage).toBe('flop');
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Turn
    state = hc.getState();
    expect(state.stage).toBe('turn');
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // River
    state = hc.getState();
    expect(state.stage).toBe('river');
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Should have completed
    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);
  });

  it('should complete hand when all but one player folds', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Everyone folds except one
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALL-IN RUN-OUT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - All-In Run-Out', () => {
  it('should run out remaining cards when all players are all-in', () => {
    const players = makePlayers(2, 10);
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // Both go all-in preflop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    // Should emit community cards and complete
    const communityEvents = events.filter((e) => e.type === 'COMMUNITY_CARDS');
    expect(communityEvents.length).toBeGreaterThanOrEqual(1);

    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);

    // 5 community cards should be out
    const finalShowdown = events.find((e) => e.type === 'SHOWDOWN' || e.type === 'HAND_COMPLETE');
    expect(hc.getCommunityCards()).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHOWDOWN & WINNER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Showdown & Winners', () => {
  it('should emit SHOWDOWN and WINNERS events', () => {
    const players = makePlayers(2, 10);
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // Both go all-in
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    expect(events.some((e) => e.type === 'SHOWDOWN')).toBe(true);
    expect(events.some((e) => e.type === 'WINNERS')).toBe(true);
  });

  it('should award winner correct amount (pot minus rake)', () => {
    const players = makePlayers(2, 10);
    const config = makeConfig({ rakeConfig: { percent: 5, cap: 3, noFlop: true } });
    const hc = new HandController(config, players, 1);
    const events = collectEvents(hc);
    hc.start();

    // Both go all-in
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    const winnersEvent = events.find((e) => e.type === 'WINNERS');
    expect(winnersEvent).toBeDefined();

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();

    // Total won + rake should equal pot
    const totalWon = winnersEvent!.winners.reduce((s: number, w: any) => s + w.amount, 0);
    const rake = completeEvent!.rake;
    expect(totalWon + rake).toBe(completeEvent!.pot);
  });

  it('should update winner stack after showdown', () => {
    const players = makePlayers(2, 10);
    const config = makeConfig({ rakeConfig: { percent: 0, cap: 0, noFlop: false } });
    const hc = new HandController(config, players, 1);
    collectEvents(hc);
    hc.start();

    // Both go all-in
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    // One player should have gained chips, other should be at 0
    const finalState = hc.getState();
    const stacks = finalState.players.map((p) => p.stack);
    expect(stacks.some((s) => s > 0)).toBe(true);
    expect(stacks.reduce((a, b) => a + b, 0)).toBe(20); // Total chips conserved (no rake)
  });

  it('HAND_COMPLETE event should include pot value', () => {
    const players = makePlayers(2, 10);
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // Quick hand: fold
    const state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.pot).toBeGreaterThan(0); // Pot should be SB + BB = 3
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Rake', () => {
  it('should not take rake when no flop is seen (no-flop-no-drop)', () => {
    const config = makeConfig({ rakeConfig: { percent: 5, cap: 3, noFlop: true } });
    const hc = new HandController(config, makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Everyone folds preflop (no flop)
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.rake).toBe(0); // No flop no drop
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATE GETTER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Getters', () => {
  it('getState should return a deep copy', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    const state1 = hc.getState();
    const state2 = hc.getState();

    // Should be equal but not the same reference
    expect(state1.players).not.toBe(state2.players);
    expect(state1.communityCards).not.toBe(state2.communityCards);
  });

  it('getCurrentPlayer should return the active player', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    const current = hc.getCurrentPlayer();
    expect(current).toBeDefined();
    expect(current!.seat).toBe(hc.getState().currentPlayerSeat);
  });

  it('getCommunityCards should return copy of board', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    hc.start();

    const cards1 = hc.getCommunityCards();
    const cards2 = hc.getCommunityCards();
    expect(cards1).not.toBe(cards2); // Different references
  });

  it('getPot should return current pot', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    hc.start();

    expect(hc.getPot()).toBe(3); // SB + BB
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT SYSTEM TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Event System', () => {
  it('should allow subscribing and unsubscribing from events', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events: any[] = [];
    const unsub = hc.onEvent((e) => events.push(e));

    hc.start();
    expect(events.length).toBeGreaterThan(0);

    const countBefore = events.length;
    unsub();

    // Actions after unsubscribe should not add events
    const state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');
    expect(events.length).toBe(countBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHORT DECK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Short Deck Variant', () => {
  it('should use a 36-card deck for short_deck variant', () => {
    const config = makeConfig({ gameVariant: 'short_deck' });
    const hc = new HandController(config, makePlayers(3), 1);
    hc.start();

    const state = hc.getState();
    // 36 - 6 (3 players * 2 cards) = 30 cards remaining
    // Check all dealt cards have rank >= 6
    for (const p of state.players) {
      for (const c of p.cards) {
        const rankVal =
          {
            '2': 2,
            '3': 3,
            '4': 4,
            '5': 5,
            '6': 6,
            '7': 7,
            '8': 8,
            '9': 9,
            T: 10,
            J: 11,
            Q: 12,
            K: 13,
            A: 14,
          }[c.rank] || 0;
        expect(rankVal).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — Sweep 3 Bug Fixes
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Aggressor Detection (Sweep 3 Fix)', () => {
  it('all-in CALL should NOT reopen betting to other players', () => {
    // 3 players: P1(100), P2(5 short-stack), P3(100)
    // Dealer=1, SB=2, BB=3
    // P1(UTG) raises to 10. P2(SB, short stack=5) goes all-in for 5 (a CALL, not a raise).
    // P3(BB) should NOT get another chance to act because P2 didn't raise.
    const players = [
      {
        seat: 1,
        user_id: 'p1',
        username: 'P1',
        avatar_url: '',
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [] as Card[],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'p2',
        username: 'P2',
        avatar_url: '',
        stack: 5,
        bet: 0,
        totalInvested: 0,
        cards: [] as Card[],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 3,
        user_id: 'p3',
        username: 'P3',
        avatar_url: '',
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [] as Card[],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // After blinds: SB(seat 2)=1, BB(seat 3)=2, pot=3
    // UTG (seat 1) acts first in 3-way
    let state = hc.getState();
    expect(state.currentPlayerSeat).toBe(1); // UTG

    hc.performAction(1, 'raise', 10); // UTG raises to 10

    state = hc.getState();
    // SB (seat 2, stack was 5, posted SB=1, so 4 remaining) should act next
    hc.performAction(state.currentPlayerSeat, 'all_in'); // SB calls all-in for 4 more (total bet=5, NOT a raise)

    state = hc.getState();
    // BB (seat 3) should act next — they need to respond to the raise from P1
    expect(state.currentPlayerSeat).toBe(3);
    hc.performAction(3, 'call'); // BB calls the 10

    // After BB calls, the round should be COMPLETE — P2's all-in was not a raise
    state = hc.getState();
    // Should have advanced to flop (or be done if only considering betting)
    expect(state.stage).not.toBe('preflop');
  });

  it('all-in RAISE should reopen betting', () => {
    // 2 players: both 100 stack, HU
    const players = makePlayers(2, 100);
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // HU: dealer=SB acts first preflop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'raise', 6); // SB raises to 6

    state = hc.getState();
    // BB should respond
    hc.performAction(state.currentPlayerSeat, 'all_in'); // BB goes all-in (100 total, a RAISE)

    state = hc.getState();
    // SB should get a chance to act again (BB raised to 100)
    // The key is BB's all-in was correctly treated as aggression
    const turnChanges = events.filter((e: any) => e.type === 'TURN_CHANGE');
    // There should be at least 3 turn changes: initial, after SB raise, after BB all-in (back to SB)
    expect(turnChanges.length).toBeGreaterThanOrEqual(3);
  });
});

describe('HandController - setNextPlayer Fallback (Sweep 3 Fix)', () => {
  it('should handle sequential folds without crashing', () => {
    const hc = new HandController(makeConfig(), makePlayers(4), 1);
    const events = collectEvents(hc);
    hc.start();

    // Fold everyone until only one is left
    for (let i = 0; i < 3; i++) {
      const state = hc.getState();
      if (state.currentPlayerSeat > 0) {
        hc.performAction(state.currentPlayerSeat, 'fold');
      }
    }

    // Hand should be complete without errors
    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOMB POT FLOW FIX — BUG-HC-02
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - Bomb Pot Flow (BUG-HC-02 Fix)', () => {
  it('should skip preflop and start betting on flop', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(4), 1);
    const events = collectEvents(hc);
    hc.start();

    const state = hc.getState();
    // Should be on flop, NOT preflop
    expect(state.stage).toBe('flop');
    expect(state.communityCards).toHaveLength(3);
  });

  it('should deal 3 community cards on start for bomb pot', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    const communityEvents = events.filter((e) => e.type === 'COMMUNITY_CARDS');
    expect(communityEvents).toHaveLength(1);
    expect(communityEvents[0].stage).toBe('flop');
    expect(communityEvents[0].cards).toHaveLength(3);
  });

  it('should have sawFlop=true in HAND_COMPLETE for bomb pot', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(2), 1);
    const events = collectEvents(hc);
    hc.start();

    // Check all through to completion
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Should advance to turn
    state = hc.getState();
    expect(state.stage).toBe('turn');
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Should advance to river
    state = hc.getState();
    expect(state.stage).toBe('river');
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.sawFlop).toBe(true);
  });

  it('should complete bomb pot through all stages', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(2), 1);
    const events = collectEvents(hc);
    hc.start();

    // Flop: both check
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Turn: both check
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // River: both check
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);

    // 5 community cards should be dealt
    expect(hc.getCommunityCards()).toHaveLength(5);
  });

  it('should handle bomb pot where someone folds on flop', () => {
    const config = makeConfig({ bombPot: { anteMultiplier: 5 } });
    const hc = new HandController(config, makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Player folds on the flop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    const hasComplete = events.some((e) => e.type === 'HAND_COMPLETE');
    expect(hasComplete).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAND_COMPLETE sawFlop TRACKING — BUG-HC-03/04
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandController - HAND_COMPLETE sawFlop Field', () => {
  it('sawFlop should be false when hand ends preflop (everyone folds)', () => {
    const hc = new HandController(makeConfig(), makePlayers(3), 1);
    const events = collectEvents(hc);
    hc.start();

    // Everyone folds preflop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'fold');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.sawFlop).toBe(false);
  });

  it('sawFlop should be true when hand reaches flop', () => {
    const hc = new HandController(makeConfig(), makePlayers(2), 1);
    const events = collectEvents(hc);
    hc.start();

    // Play to the flop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'call');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'check');

    // Now on flop — one player folds
    state = hc.getState();
    expect(state.stage).toBe('flop');
    hc.performAction(state.currentPlayerSeat, 'fold');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.sawFlop).toBe(true);
  });

  it('HAND_COMPLETE should include pot value and sawFlop for all-in hands', () => {
    const players = makePlayers(2, 10);
    const hc = new HandController(makeConfig(), players, 1);
    const events = collectEvents(hc);
    hc.start();

    // Both go all-in preflop
    let state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');
    state = hc.getState();
    hc.performAction(state.currentPlayerSeat, 'all_in');

    const completeEvent = events.find((e) => e.type === 'HAND_COMPLETE');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.pot).toBeGreaterThan(0);
    // sawFlop should be true (community cards were run out)
    expect(completeEvent!.sawFlop).toBe(true);
    expect(typeof completeEvent!.sawFlop).toBe('boolean');
  });
});
