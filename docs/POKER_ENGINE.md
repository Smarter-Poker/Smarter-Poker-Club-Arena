# ♠ Club Arena — Poker Engine Documentation

## Overview

The Club Arena Poker Engine is a complete, production-ready poker logic system supporting multiple game variants, proper pot calculations, and full hand evaluation.

---

## Core Components

### 1. Deck (`PokerEngine.ts`)

```typescript
import { Deck } from '@engine';

const deck = new Deck();
deck.shuffle();
const cards = deck.deal(5);

// Short Deck variant (remove 2-5)
deck.removeCardsBelow('6');
```

### 2. Hand Evaluation

```typescript
import { evaluateHand, evaluateOmahaHand, compareHands } from '@engine';

// Hold'em
const result = evaluateHand(holeCards, communityCards);
console.log(result.name);     // "Full House"
console.log(result.ranking);  // 7

// Omaha (must use exactly 2 hole cards + 3 board)
const omahaResult = evaluateOmahaHand(holeCards, communityCards);

// Compare two hands
const winner = compareHands(hand1, hand2); // >0 = hand1 wins
```

### 3. Hand Rankings

| Rank | Name | Example |
|------|------|---------|
| 10 | Royal Flush | A♠ K♠ Q♠ J♠ T♠ |
| 9 | Straight Flush | 9♥ 8♥ 7♥ 6♥ 5♥ |
| 8 | Four of a Kind | K♠ K♥ K♦ K♣ 7♠ |
| 7 | Full House | Q♠ Q♥ Q♦ 5♣ 5♠ |
| 6 | Flush | A♦ J♦ 9♦ 6♦ 3♦ |
| 5 | Straight | T♠ 9♥ 8♦ 7♣ 6♠ |
| 4 | Three of a Kind | 8♠ 8♥ 8♦ K♣ 4♠ |
| 3 | Two Pair | J♠ J♥ 5♦ 5♣ 9♠ |
| 2 | Pair | A♠ A♥ K♦ 8♣ 3♠ |
| 1 | High Card | A♠ Q♥ 9♦ 6♣ 2♠ |

---

## Hand Controller

The `HandController` manages full hand flow with event-driven architecture.

### Basic Usage

```typescript
import { HandController, type HandConfig, type SeatPlayer } from '@engine';

const players: SeatPlayer[] = [
  { seat: 1, user_id: 'p1', username: 'Alice', stack: 1000, ... },
  { seat: 3, user_id: 'p2', username: 'Bob', stack: 1000, ... },
];

const config: HandConfig = {
  tableId: 'table-123',
  handNumber: 1,
  gameVariant: 'nlh',
  smallBlind: 5,
  bigBlind: 10,
  rakeConfig: { percent: 5, cap: 15, noFlop: true },
};

const hand = new HandController(config, players, 1); // dealer at seat 1

// Subscribe to events
hand.onEvent((event) => {
  switch (event.type) {
    case 'HAND_START':
    case 'CARDS_DEALT':
    case 'COMMUNITY_CARDS':
    case 'PLAYER_ACTION':
    case 'POT_UPDATE':
    case 'TURN_CHANGE':
    case 'SHOWDOWN':
    case 'WINNERS':
    case 'HAND_COMPLETE':
  }
});

// Start the hand
hand.start();

// Player actions
hand.performAction(seatNumber, 'call');
hand.performAction(seatNumber, 'raise', 50);
hand.performAction(seatNumber, 'fold');
hand.performAction(seatNumber, 'all_in');
```

### Event Types

```typescript
type HandEvent = 
  | { type: 'HAND_START'; handNumber: number; players: SeatPlayer[] }
  | { type: 'CARDS_DEALT'; seat: number; cards: Card[] }
  | { type: 'COMMUNITY_CARDS'; stage: HandStage; cards: Card[] }
  | { type: 'PLAYER_ACTION'; seat: number; action: ActionType; amount: number }
  | { type: 'POT_UPDATE'; pot: number; pots: Pot[] }
  | { type: 'TURN_CHANGE'; seat: number; availableActions: ActionType[] }
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | { type: 'WINNERS'; winners: Winner[] }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number };
```

---

## Pot Calculation

```typescript
import { calculatePots } from '@engine';

const pots = calculatePots(players);
// Returns: [
//   { amount: 300, eligiblePlayers: ['p1', 'p2', 'p3'] },  // Main pot
//   { amount: 100, eligiblePlayers: ['p1', 'p2'] },        // Side pot
// ]
```

---

## Rake Configuration

```typescript
interface RakeConfig {
  percent: number;  // e.g., 5 for 5%
  cap: number;      // Maximum rake per hand
  noFlop: boolean;  // No rake if hand ends preflop
}

import { calculateRake } from '@engine';

const rake = calculateRake(pot, sawFlop, rakeConfig);
```

---

## Game Variants

| Variant | Hole Cards | Description |
|---------|------------|-------------|
| `nlh` | 2 | No Limit Hold'em |
| `flh` | 2 | Fixed Limit Hold'em |
| `plo4` | 4 | Pot Limit Omaha 4 |
| `plo5` | 5 | Pot Limit Omaha 5 |
| `plo6` | 6 | Pot Limit Omaha 6 |
| `plo_hilo` | 4 | Omaha Hi-Lo |
| `short_deck` | 2 | 6+ Short Deck |
| `ofc` | 5* | Open Face Chinese |

---

## Betting Validation

```typescript
import { validateAction, calculateBettingState } from '@engine';

const bettingState = calculateBettingState(
  pot,
  currentBet,
  playerBet,
  bigBlind,
  lastRaise
);

const validation = validateAction('raise', 50, playerStack, bettingState);
if (!validation.valid) {
  console.error(validation.error);
}
```

### Action Types

- `fold` - Give up hand
- `check` - Pass (when no bet)
- `call` - Match current bet
- `bet` - First wager (when no bet)
- `raise` - Increase current bet
- `all_in` - Bet entire stack

---

## Card Utilities

```typescript
import { cardToString, cardsToString, parseCard } from '@engine';

cardToString({ rank: 'A', suit: 'spades' });  // "A♠"
cardsToString([card1, card2]);                 // "A♠ K♥"
parseCard('Ah');                               // { rank: 'A', suit: 'hearts' }
```

---

## Bomb Pot Support

```typescript
const config: HandConfig = {
  // ...
  bombPot: {
    anteMultiplier: 2,  // Each player antes 2x BB
  },
};
```

With bomb pots:
- All players ante (no blinds)
- Flop is dealt immediately
- Betting starts after flop

---

## Integration Example

See `src/pages/TablePage.tsx` for a complete React integration with:
- Real-time hand updates
- Bot opponent simulation
- Action button handling
- Event log display
