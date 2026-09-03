# HANDCONTROLLER MIGRATION SPEC

## Exact Function-by-Function Differences: Client vs Server

**Purpose:** This document catalogs EVERY difference between the client's `src/engine/HandController.ts` (917+ lines) and the server's `server/src/engine/HandController.ts` (553 lines) so the server version can be upgraded to include all missing features.

---

## 1. HandConfig Interface

### Client (src/engine/HandController.ts:29-43):

```typescript
export interface HandConfig {
  tableId: string;
  handNumber: number;
  gameVariant: GameVariant;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  bigBlindAnte?: boolean; // ← MISSING from server
  rakeConfig: RakeConfig;
  bombPot?: { anteMultiplier: number };
  straddles?: { seat: number; amount: number }[]; // ← MISSING from server
  ritEnabled?: boolean; // ← MISSING from server
}
```

### Server (server/src/types.ts:91-102):

```typescript
export interface HandConfig {
  tableId: string;
  handNumber: number;
  gameVariant: GameVariant;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  rakeConfig: RakeConfig;
  bombPot?: { anteMultiplier: number };
  // MISSING: bigBlindAnte, straddles, ritEnabled
}
```

### ACTION REQUIRED:

Add to server `HandConfig` in `server/src/types.ts`:

- `bigBlindAnte?: boolean`
- `straddles?: { seat: number; amount: number }[]`
- `ritEnabled?: boolean`
- `insuranceEnabled?: boolean` (new — not in client either)

---

## 2. HandEvent Union Type

### Client (src/engine/HandController.ts:70-86):

```typescript
| { type: 'ALL_IN_RUNOUT_PENDING'; remainingDeck: Card[]; existingBoard: Card[]; pot: number; activePlayers: SeatPlayer[] }
| { type: 'HAND_COMPLETE'; handNumber: number; rake: number; pot: number; sawFlop: boolean }
```

### Server (server/src/types.ts:129-138):

```typescript
// MISSING: ALL_IN_RUNOUT_PENDING event entirely
| { type: 'HAND_COMPLETE'; handNumber: number; rake: number }  // MISSING: pot and sawFlop fields
```

### ACTION REQUIRED:

Add to server `HandEvent` in `server/src/types.ts`:

- `ALL_IN_RUNOUT_PENDING` variant (for RIT/insurance decision points)
- Add `pot` and `sawFlop` to `HAND_COMPLETE` variant

---

## 3. postBlinds() — BBA and Straddle Support

### Client (src/engine/HandController.ts:216-293):

```
Lines 252-271: BBA (Big Blind Ante) support
  - if (this.config.bigBlindAnte): BB posts ante × activeCount
  - else: traditional per-player ante

Lines 274-291: Straddle support
  - Iterates this.config.straddles array
  - Posts each straddle amount from the specified seat
  - Updates currentBet and lastRaise if straddle exceeds current bet
```

### Server (server/src/engine/HandController.ts:105-145):

```
Lines 135-142: Traditional ante ONLY
  - Every non-sitting-out player posts ante individually
  - NO BBA support
  - NO straddle support
```

### ACTION REQUIRED:

Add to server `postBlinds()`:

1. BBA branch: if `this.config.bigBlindAnte`, BB posts `ante × activePlayerCount`
2. Straddle injection: iterate `this.config.straddles`, post each straddle, update `currentBet` and `lastRaise`

Exact code to add after line 142:

```typescript
// BBA support
if (this.config.ante) {
  if (this.config.bigBlindAnte) {
    const activeCount = this.state.players.filter((p) => !p.is_sitting_out).length;
    const totalAnte = this.config.ante * activeCount;
    if (bbPlayer) {
      const bbaAmount = Math.min(totalAnte, bbPlayer.stack);
      bbPlayer.totalInvested += bbaAmount;
      bbPlayer.stack -= bbaAmount;
      this.state.pot += bbaAmount;
    }
  } else {
    // existing traditional ante code
  }
}

// Straddle injection
if (this.config.straddles && this.config.straddles.length > 0) {
  for (const straddle of this.config.straddles) {
    const player = this.state.players.find((p) => p.seat === straddle.seat);
    if (player && player.stack > 0) {
      const actualAmount = Math.min(straddle.amount, player.stack);
      player.bet = actualAmount;
      player.totalInvested += actualAmount;
      player.stack -= actualAmount;
      this.state.pot += actualAmount;
      if (actualAmount > this.state.currentBet) {
        this.state.lastRaise = actualAmount - this.state.currentBet;
        this.state.currentBet = actualAmount;
      }
    }
  }
}
```

---

## 4. start() — Bomb Pot Flop Skip

### Client (src/engine/HandController.ts:173-214):

```
Lines 191-208: After bomb pot antes + deal, SKIPS preflop
  - Sets stage to 'flop'
  - Deals 3 community cards
  - Emits COMMUNITY_CARDS
  - Checks if all-in runout needed
  - Sets first postflop player
  - Returns early (no preflop betting)
```

### Server (server/src/engine/HandController.ts:87-103):

```
Lines 94-98: Calls postBombPotAntes()
  - But does NOT skip preflop
  - Falls through to setNextPlayer() + emitTurnChange()
  - WRONG: bomb pot should skip preflop betting
```

### ACTION REQUIRED:

Server's `start()` must add the bomb pot skip logic after dealing hole cards:

```typescript
if (this.config.bombPot) {
  this.state.stage = 'flop';
  this.state.sawFlop = true;
  const flop = (this.state.deck as unknown as Deck).deal(3);
  this.state.communityCards.push(...flop);
  this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });
  const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
  if (activePlayers.length < 2) {
    this.runOutCommunityCards();
    return;
  }
  this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
  this.emitTurnChange();
  return;
}
```

**BUG CONFIRMED: Server bomb pots currently have a preflop betting round when they shouldn't.**

---

## 5. performAction() — Raise Clamp Safety

### Client (src/engine/HandController.ts:386-406):

```typescript
case 'bet':
case 'raise': {
    actualAmount = amount!;
    const raiseSize = actualAmount - player.bet;
    if (raiseSize > this.state.lastRaise) {
        this.state.lastRaise = raiseSize;
    }
    let chipsAdded = actualAmount - player.bet;
    // ENG-01 FIX: Clamp to stack to prevent negative stack
    if (chipsAdded > player.stack) {
        chipsAdded = player.stack;
        actualAmount = player.bet + chipsAdded;
    }
    // ...
}
```

### Server (server/src/engine/HandController.ts:216-227):

```typescript
case 'bet':
case 'raise':
    actualAmount = amount!;
    const raiseSize = actualAmount - player.bet;
    if (raiseSize > this.state.lastRaise) this.state.lastRaise = raiseSize;
    const chipsAdded = actualAmount - player.bet;
    // NO CLAMP — can go negative if amount exceeds stack
    player.totalInvested += chipsAdded;
    player.stack -= chipsAdded;
    // ...
```

### ACTION REQUIRED:

Server must add the ENG-01 clamp fix:

```typescript
let chipsAdded = actualAmount - player.bet;
if (chipsAdded > player.stack) {
  chipsAdded = player.stack;
  actualAmount = player.bet + chipsAdded;
}
```

Without this, a player could end up with a negative stack if `ServerTableEngine.handlePlayerAction()` doesn't perfectly clamp the amount before calling `performAction()`.

---

## 6. isBettingRoundComplete() — All-In Aggression Tracking

### Client (src/engine/HandController.ts:498-511):

```typescript
// Tracks running current bet to determine if all-in was a raise
let runningCurrentBet = 0;
for (const action of stageActions) {
  if (action.action === 'bet' || action.action === 'raise') {
    lastAggressorSeat = action.seat;
    runningCurrentBet = action.amount;
  } else if (action.action === 'all_in') {
    // Only treat all-in as aggression if it RAISED the current bet
    if (action.amount > runningCurrentBet) {
      lastAggressorSeat = action.seat;
      runningCurrentBet = action.amount;
    }
  }
}
```

### Server (server/src/engine/HandController.ts:285-294):

```typescript
// Less precise — checks player.bet >= currentBet instead of tracking running bet
for (const action of stageActions) {
  if (
    action.action === 'bet' ||
    action.action === 'raise' ||
    (action.action === 'all_in' && action.amount > 0)
  ) {
    const player = this.state.players.find((p) => p.seat === action.seat);
    if (player && (player.bet >= this.state.currentBet || player.is_all_in)) {
      lastAggressorSeat = action.seat;
    }
  }
}
```

### DIFFERENCE:

Server's version incorrectly treats ANY all-in with amount > 0 as potential aggression, then checks if the player's current bet is >= currentBet. This is wrong because:

- An all-in that's less than a full raise should NOT reopen betting (Bible 7.3)
- The server uses the current state of `player.bet` which may have been modified by subsequent actions
- The client correctly tracks a `runningCurrentBet` variable to compare amounts sequentially

### ACTION REQUIRED:

Replace server's aggression tracking with the client's `runningCurrentBet` pattern. This fixes the "short all-in shouldn't reopen betting" edge case (Bible 7.3).

---

## 7. setNextPlayer() — Straddle-Aware First Action

### Client (src/engine/HandController.ts:884-889):

```typescript
if (this.config.straddles && this.config.straddles.length > 0) {
  // If there are straddles, action starts after the last straddle
  const lastStraddleSeat = this.config.straddles[this.config.straddles.length - 1].seat;
  this.state.currentPlayerSeat = this.getNextActiveSeat(lastStraddleSeat);
  return;
}
```

### Server:

**Completely absent.** Action always starts at UTG (after BB) or dealer (heads-up).

### ACTION REQUIRED:

Add straddle-aware first action to server's `setNextPlayer()`.

---

## 8. runOutCommunityCards() — RIT Pause

### Client (src/engine/HandController.ts:609-647):

```typescript
private runOutCommunityCards(): void {
    // Check if we should pause for Run It Twice
    if (this.config.ritEnabled && activePlayersWithCards.length >= 2
        && this.state.communityCards.length < 5 && !this.isWaitingForRIT) {
        this.isWaitingForRIT = true;
        this.emit({
            type: 'ALL_IN_RUNOUT_PENDING',
            remainingDeck: this.state.deck.getCards(),
            existingBoard: [...this.state.communityCards],
            pot: this.state.pot,
            activePlayers: activePlayersWithCards,
        });
        return; // PAUSES the runout — waits for external call to resume
    }
    // Normal runout continues...
}
```

Also has:

- `resumeRunout()` (line 652) — called when RIT declined
- `resolveRunItTwice(board1, board2, distributions)` (line 661) — called when RIT accepted, handles dual board settlement with rake

### Server:

**No RIT pause at all.** `runOutCommunityCards()` always runs straight through.
**No `ALL_IN_RUNOUT_PENDING` event emitted.**
**No `resumeRunout()` or `resolveRunItTwice()` methods.**

### ACTION REQUIRED:

1. Add `isWaitingForRIT` flag to server HandController
2. Add RIT pause check in `runOutCommunityCards()`
3. Add `ALL_IN_RUNOUT_PENDING` event emission
4. Add `resumeRunout()` public method
5. Add `resolveRunItTwice(board1, board2, distributions)` public method with integer-cents arithmetic
6. ServerTableEngine must handle `ALL_IN_RUNOUT_PENDING` event: offer RIT to players, wait for responses, call `resumeRunout()` or `resolveRunItTwice()`

---

## 9. completeHand() — No-Winners Guard + Richer HAND_COMPLETE Event

### Client (src/engine/HandController.ts:721-825):

```typescript
// Guard: if no winners determined, return pot proportionally
if (winners.length === 0) {
  const remainingPlayers = this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
  // Integer-cents proportional distribution
  // ...
}

// HAND_COMPLETE includes pot and sawFlop
this.emit({
  type: 'HAND_COMPLETE',
  handNumber: this.config.handNumber,
  rake,
  pot: this.state.pot, // ← server doesn't include this
  sawFlop: this.state.sawFlop, // ← server doesn't include this
});
```

### Server (server/src/engine/HandController.ts:387-431):

- **No empty-winners guard** — if `determineWinners` returns empty array, winnings arithmetic divides by 0
- `HAND_COMPLETE` event is `{ handNumber, rake }` only — missing `pot` and `sawFlop`

### ACTION REQUIRED:

1. Add no-winners safety guard with proportional pot return
2. Add `pot` and `sawFlop` to `HAND_COMPLETE` event

---

## 10. getNextActiveSeat() — Empty Table Guard

### Client (line 842): Returns `fromSeat` when no active seats (prevents infinite loop)

### Server (line 446): Returns `-1` when no active seats (could cause infinite loop in callers)

### ACTION REQUIRED:

Change server to return `fromSeat` instead of `-1` for safety.

---

## SUMMARY: Exact Changes Needed in Server HandController

| #   | Function                  | Change                                                 | Lines of Code             |
| --- | ------------------------- | ------------------------------------------------------ | ------------------------- |
| 1   | HandConfig type           | Add bigBlindAnte, straddles, ritEnabled                | 3 lines in types.ts       |
| 2   | HandEvent type            | Add ALL_IN_RUNOUT_PENDING, enrich HAND_COMPLETE        | 5 lines in types.ts       |
| 3   | postBlinds()              | Add BBA branch + straddle injection                    | ~30 lines                 |
| 4   | start()                   | Add bomb pot preflop skip                              | ~15 lines                 |
| 5   | performAction() bet/raise | Add ENG-01 stack clamp                                 | 4 lines                   |
| 6   | isBettingRoundComplete()  | Fix all-in aggression tracking with runningCurrentBet  | ~15 lines (replace block) |
| 7   | setNextPlayer()           | Add straddle-aware first action                        | ~6 lines                  |
| 8   | runOutCommunityCards()    | Add RIT pause + ALL_IN_RUNOUT_PENDING                  | ~20 lines                 |
| 9   | NEW: resumeRunout()       | Public method for RIT decline/timeout                  | ~4 lines                  |
| 10  | NEW: resolveRunItTwice()  | Public method for RIT accepted — dual board settlement | ~35 lines                 |
| 11  | completeHand()            | Add no-winners guard + enrich HAND_COMPLETE event      | ~15 lines                 |
| 12  | getNextActiveSeat()       | Return fromSeat not -1                                 | 1 line                    |

**Total estimated: ~150 lines of additions/changes to server HandController.**
**Server HC goes from ~553 lines to ~700 lines — still manageable.**

---

## BROADCAST SECURITY FIX (ServerTableEngine.ts)

### Current broadcast (line 786-797):

```typescript
players: (state.players ?? []).map((p) => ({
    seat: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    bet: p.bet ?? 0,
    cards: p.cards ?? [],       // ← SENDS ALL CARDS
    is_folded: p.is_folded ?? false,
    is_all_in: p.is_all_in ?? false,
    is_sitting_out: p.is_sitting_out ?? false,
})),
```

### Required broadcast:

```typescript
players: (state.players ?? []).map((p) => ({
    seat: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    bet: p.bet ?? 0,
    cards: (state.stage === 'showdown' && !p.is_folded) ? p.cards : [],
    is_folded: p.is_folded ?? false,
    is_all_in: p.is_all_in ?? false,
    is_sitting_out: p.is_sitting_out ?? false,
})),
```

Plus NEW per-player secure card delivery after dealing:

```typescript
// In handleHandEvent for CARDS_DEALT:
private deliverSecureHoleCards(seat: number, cards: Card[]): void {
    const player = this.seatedPlayers.find(p => p.seat_number === seat);
    if (!player || player.is_horse) return; // Horses don't need client delivery

    supabase.channel(`cards-secure:${this.tableId}:${player.user_id}`)
        .send({
            type: 'broadcast',
            event: 'hole_cards',
            payload: { seat, cards, table_id: this.tableId }
        })
        .catch(() => {});
}
```

---

## AUTO-FOLD-ON-ERROR FIX (ServerTableEngine.ts:340-357)

### Current (BROKEN):

```typescript
try {
  this.handController.performAction(seat, normalizedAction as any, amount);
  return { success: true };
} catch (err) {
  // Auto-fold on invalid action
  try {
    this.handController.performAction(seat, 'fold');
    return { success: true, error: `Original action failed, auto-folded: ${errMsg}` };
  } catch {
    return { success: false, error: errMsg };
  }
}
```

### Required (CORRECT):

```typescript
try {
  this.clearTurnTimer();
  const result = this.handController.performAction(seat, normalizedAction as any, amount);
  if (!result) {
    // performAction returned false = validation failure
    // DO NOT AUTO-FOLD — return error to player so they can try again
    // Restart their turn timer with remaining time
    const elapsed = (Date.now() - this.playerTurnStartTime) / 1000;
    const remaining = Math.max(1, this.playerTurnDuration - elapsed);
    this.startTurnTimer(userId, seat, remaining);
    return { success: false, error: 'Action rejected by engine — please try again' };
  }
  return { success: true };
} catch (err) {
  const errMsg = err instanceof Error ? err.message : 'Action failed';
  // Still DO NOT auto-fold — restart timer and return error
  const elapsed = (Date.now() - this.playerTurnStartTime) / 1000;
  const remaining = Math.max(1, this.playerTurnDuration - elapsed);
  this.startTurnTimer(userId, seat, remaining);
  return { success: false, error: errMsg };
}
```

---

## TIMER AUTO-CHECK FIX (ServerTableEngine.ts:192-207)

### Current (BROKEN):

```typescript
// Always auto-folds on timeout
this.playerTurnTimer = setTimeout(() => {
  if (state.currentPlayerSeat === seat) {
    console.warn(`Player ${userId} timed out. Auto-folding.`);
    this.handController.performAction(seat, 'fold');
  }
}, safeDurationSeconds * 1000);
```

### Required (CORRECT per Bible 6.1):

```typescript
this.playerTurnTimer = setTimeout(() => {
  if (!this.running || !this.handController) return;
  const state = this.handController.getState();
  if (state.currentPlayerSeat !== seat) return;

  const toCall = Math.max(
    0,
    state.currentBet - (state.players.find((p) => p.seat === seat)?.bet ?? 0)
  );

  if (toCall === 0) {
    // Can check — auto-check instead of auto-fold (Bible: preferCheckOverFold)
    try {
      this.handController.performAction(seat, 'check');
    } catch {}
  } else {
    // Must call/fold — auto-fold
    try {
      this.handController.performAction(seat, 'fold');
    } catch {}
  }
}, safeDurationSeconds * 1000);
```
