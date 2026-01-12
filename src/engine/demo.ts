/**
 * ♠ CLUB ARENA — Poker Engine Demo
 * ═══════════════════════════════════════════════════════════════════════════════
 * Quick test to verify engine functionality
 */

import { HandController, Deck, evaluateHand, cardsToString, type HandConfig } from './index';
import type { SeatPlayer, Card } from '../types/database.types';

// Demo function to test the engine
export function runEngineDemo(): void {
    console.log('♠ POKER ENGINE DEMO');
    console.log('═'.repeat(60));

    // Test 1: Deck
    console.log('\n1️⃣ Testing Deck...');
    const deck = new Deck();
    console.log(`   Deck has ${deck.remaining()} cards`);
    const dealt = deck.deal(5);
    console.log(`   Dealt: ${cardsToString(dealt)}`);
    console.log(`   Remaining: ${deck.remaining()} cards`);

    // Test 2: Hand Evaluation
    console.log('\n2️⃣ Testing Hand Evaluation...');

    const testHands: { hole: string[], community: string[], expected: string }[] = [
        {
            hole: ['As', 'Ks'],
            community: ['Qs', 'Js', 'Ts', '2h', '3c'],
            expected: 'Royal Flush'
        },
        {
            hole: ['Ah', 'Kh'],
            community: ['Qh', 'Jh', '9h', '2c', '3d'],
            expected: 'Flush'
        },
        {
            hole: ['Ac', 'Ad'],
            community: ['As', 'Kh', 'Kc', '2h', '3c'],
            expected: 'Full House'
        },
        {
            hole: ['7c', '7d'],
            community: ['7s', '7h', 'Kc', '2h', '3c'],
            expected: 'Four of a Kind'
        },
    ];

    for (const test of testHands) {
        const holeCards = test.hole.map(parseCardString);
        const communityCards = test.community.map(parseCardString);
        const result = evaluateHand(holeCards, communityCards);
        const pass = result.name === test.expected;
        console.log(`   ${pass ? '✅' : '❌'} ${cardsToString(holeCards)} | ${cardsToString(communityCards)}`);
        console.log(`      Expected: ${test.expected}, Got: ${result.name}`);
    }

    // Test 3: Hand Controller
    console.log('\n3️⃣ Testing Hand Controller...');

    const players: SeatPlayer[] = [
        { seat: 1, user_id: 'player-1', username: 'Alice', stack: 1000, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
        { seat: 2, user_id: 'player-2', username: 'Bob', stack: 1000, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
        { seat: 3, user_id: 'player-3', username: 'Charlie', stack: 1000, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
    ];

    const config: HandConfig = {
        tableId: 'demo-table',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 5,
        bigBlind: 10,
        rakeConfig: { percent: 5, cap: 15, noFlop: true },
    };

    const hand = new HandController(config, players, 1);

    // Subscribe to events
    hand.onEvent((event) => {
        switch (event.type) {
            case 'HAND_START':
                console.log(`   🎰 Hand #${event.handNumber} starting with ${event.players.length} players`);
                break;
            case 'CARDS_DEALT':
                console.log(`   🃏 Seat ${event.seat} dealt cards`);
                break;
            case 'PLAYER_ACTION':
                console.log(`   ▶️ Seat ${event.seat}: ${event.action}${event.amount ? ` $${event.amount}` : ''}`);
                break;
            case 'COMMUNITY_CARDS':
                console.log(`   📋 ${event.stage.toUpperCase()}: ${cardsToString(event.cards)}`);
                break;
            case 'WINNERS':
                for (const w of event.winners) {
                    console.log(`   🏆 ${w.userId} wins $${w.amount}${w.hand ? ` (${w.hand.name})` : ''}`);
                }
                break;
            case 'HAND_COMPLETE':
                console.log(`   ✅ Hand complete, rake: $${event.rake}`);
                break;
        }
    });

    // Start and play a hand
    hand.start();

    // Simulate some actions
    const state = hand.getState();
    const currentSeat = state.currentPlayerSeat;

    // UTG folds
    hand.performAction(currentSeat, 'fold');

    // SB calls
    const state2 = hand.getState();
    hand.performAction(state2.currentPlayerSeat, 'call');

    // BB checks
    const state3 = hand.getState();
    hand.performAction(state3.currentPlayerSeat, 'check');

    console.log('\n' + '═'.repeat(60));
    console.log('♠ POKER ENGINE DEMO COMPLETE');
}

// Helper to parse card strings like "As", "Kh", etc.
function parseCardString(str: string): Card {
    const rankMap: Record<string, Card['rank']> = {
        'A': 'A', 'K': 'K', 'Q': 'Q', 'J': 'J', 'T': 'T',
        '9': '9', '8': '8', '7': '7', '6': '6', '5': '5',
        '4': '4', '3': '3', '2': '2',
    };
    const suitMap: Record<string, Card['suit']> = {
        's': 'spades', 'h': 'hearts', 'd': 'diamonds', 'c': 'clubs',
    };
    return {
        rank: rankMap[str[0]],
        suit: suitMap[str[1].toLowerCase()],
    };
}

// Run if executed directly
if (typeof window === 'undefined') {
    runEngineDemo();
}
