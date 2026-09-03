# Poker Gameplay Specification - Agent Skill

## PURPOSE

This is the AUTHORITATIVE reference for how online poker gameplay works in Club Arena.
When unsure how any gameplay feature should work, ALWAYS consult this document first.
Compare all game engine code against these specifications.

---

## CASH GAME LIFECYCLE - COMPLETE FLOW

### 1. TABLE CREATION (Admin/Host Side)

- Tables configured with: blinds (SB/BB), stakes, min/max buy-in, max players (6-max, 9-max), game variant (NLH, PLO4, PLO5, PLO6, PLO8, Short Deck)
- Table states: waiting (not enough players), active (hand in progress), paused, closed
- Tables visible in club lobby, filterable by game type, stakes, player count

### 2. PLAYER JOINING FLOW

**Step-by-step:**

1. Player browses lobby, finds table
2. Player clicks empty seat OR "Sit Down" button
3. Buy-in modal appears with slider (min to max buy-in range)
4. Chips deducted from player wallet (chip_ledger entry)
5. Player receives stack equal to buy-in amount
6. If table full: player added to waiting list
7. If mid-hand: player sits out until current hand completes
8. Player enters play at start of next hand

**Key rules:**

- Cannot join mid-hand (must wait for next hand)
- Buy-in range enforced (typically 20-100 BB min, 100-200 BB max)
- Wallet must have sufficient chips
- Seat selection: click on empty seat position

### 3. HAND LIFECYCLE - EVERY STEP IN ORDER

#### Pre-Deal Setup

1. **Dealer Button** positioned (rotates clockwise after each hand)
2. **Small Blind** posted by player immediately LEFT of button
3. **Big Blind** posted by player immediately LEFT of small blind
4. **Antes** collected from all players (if applicable)
5. **Straddle** (optional, cash games only) - voluntary blind by UTG, 2x BB

#### Card Dealing

6. **2 hole cards** dealt to each player, clockwise starting left of dealer
7. Cards visible ONLY to the player who owns them
8. UI: Hero sees face-up cards, opponents see card backs

#### Preflop Betting Round

9. Action starts with **UTG** (player left of big blind)
10. Proceeds clockwise: UTG, MP, CO, BTN, SB, BB
11. BB acts last (has "option" to raise even if no one raised)
12. Available actions: Fold, Call (match BB), Raise (min 2x BB)
13. Round ends when all active players have equal bets or folded

#### The Flop

14. Burn 1 card (not shown)
15. Deal 3 community cards face-up
16. All players can see community cards

#### Flop Betting Round

17. Action starts with first active player LEFT of dealer button
18. Available: Check (if no bet), Bet (min 1 BB), Fold, Call, Raise
19. Round ends when all active players have equal bets or checked

#### The Turn

20. Burn 1 card
21. Deal 1 community card face-up (4 total on board)

#### Turn Betting Round

22. Same order and rules as flop round

#### The River

23. Burn 1 card
24. Deal 1 community card face-up (5 total on board - FINAL)

#### River Betting Round

25. Same order and rules as flop/turn rounds

#### Showdown

26. If 2+ players remain, all show hole cards
27. Best 5-card hand wins (from 2 hole + 5 community)
28. Hand rankings (high to low):
    - Royal Flush, Straight Flush, Four of a Kind, Full House
    - Flush, Straight, Three of a Kind, Two Pair, One Pair, High Card
29. Tied hands: pot splits equally (odd chip to player closest to button)

### 4. ACTION SYSTEM

#### Available Actions

| Action | When Available                 | Effect                              |
| ------ | ------------------------------ | ----------------------------------- |
| Fold   | Always                         | Forfeit hand, exit                  |
| Check  | No bet active in current round | Pass without betting                |
| Call   | Bet/raise exists               | Match highest bet                   |
| Bet    | First action, no existing bet  | Initiate bet (min = BB)             |
| Raise  | Bet/raise exists               | Increase bet (min = previous raise) |
| All-In | Always                         | Commit entire remaining stack       |

#### Minimum Raise Rules

- Minimum raise = size of the PREVIOUS raise (not the previous bet)
- Example: Player A bets $10, Player B raises to $30 (raise of $20)
  Player C must raise by at least $20 more (minimum raise to $50)
- If a player doesn't have enough for minimum raise, they can only call or go all-in

#### All-In & Side Pots

- When player goes all-in with fewer chips than others:
  - Main pot capped at all-in player's contribution x number of callers
  - Remaining bets go into side pot(s)
  - All-in player can only win main pot
- Multiple all-ins create multiple side pots
- Each pot awarded to best hand among ELIGIBLE players for that pot

#### Action Timer

- Standard: 15-30 seconds per action
- When timer expires: auto-fold (if bet to call) or auto-check (if check available)
- Time Bank: extra 15-60 second reserve, activates automatically when main timer expires
- Time bank is limited per session (not per hand)

#### Pre-Action Buttons (shown when NOT your turn)

- Check/Fold: auto-fold if bet comes, auto-check if no bet
- Call Any: auto-call any bet
- These queue actions for when it's your turn

### 5. UI/UX ELEMENTS - WHAT MUST RENDER

#### Card Display

- **Hero hole cards**: Large, face-up, prominent position at bottom of table
- **Opponent hole cards**: Face-down (card back design), NEVER visible until showdown
- **Community cards**: 5 positions in center, revealed progressively (3 flop, +1 turn, +1 river)
- **Winning hand**: Cards highlighted at showdown, hand name displayed

#### Player Seat Display (per player)

- Player name/username
- Chip stack amount (formatted with commas, K/M for large amounts)
- Avatar/profile image
- Current bet amount (shown near player's position)
- Status: Active, Folded (grayed out), All-In (highlighted), Sitting Out
- Position badge: D (dealer), SB, BB

#### Table Center Display

- **Pot amount**: Always visible, updates with each action
- **Side pots**: Labeled separately when applicable
- **Community cards**: Center row of 5 card positions
- **Dealer button**: Visual chip at dealer's seat

#### Action Panel (shown only when it's hero's turn)

- **Fold** button (red)
- **Check/Call** button (green) - shows amount to call
- **Raise** button with slider (amber) - min/max range, preset buttons (1/3 pot, 1/2 pot, 3/4 pot, pot)
- **All-In** button
- **Timer countdown** visible at hero's seat

#### Turn Indicator

- Active player's seat highlighted/glowing
- Timer countdown at active player's seat
- Action label shows last action taken (FOLD, CHECK, CALL $X, RAISE $X)

#### Win Animation

- Pot chips animate flowing to winner
- Winning hand name displayed ("Full House, Aces over Kings")
- Cards highlighted
- Brief pause (2-3 seconds) before next hand

### 6. POT CALCULATION

#### Simple (No All-Ins)

- All bets from all streets accumulate into single pot
- Winner takes pot minus rake

#### Side Pots (With All-Ins)

Example: Player A has 50, Player B has 100, Player C has 200

- All contribute to main pot up to smallest stack: 50 x 3 = 150 (A, B, C eligible)
- B and C continue: (100-50) x 2 = 100 in Side Pot 1 (B, C eligible)
- C alone: remaining goes to Side Pot 2 (returned to C if uncalled)
- Best hand among eligible players wins each pot separately

### 7. RAKE SYSTEM

- **Rate**: 2.5-5% of pot (Club Arena uses configurable rates per blind level)
- **Cap**: Maximum rake per hand (e.g., $3 for 1/2, $12.50 for 5/10)
- **No-Flop-No-Drop**: If hand ends before flop, ZERO rake collected
- **Timing**: Rake deducted at hand completion, before pot distribution
- **Display**: Show rake amount to players after hand

### 8. BAD BEAT JACKPOT (BBJ)

- **Contribution**: Taken from each raked pot (typically 1 BB from pots >= 30 BB)
- **Pool**: Accumulates until qualifying bad beat occurs
- **Qualification**: Very strong losing hand (e.g., quad 8s+ losing to better hand)
- **Payout**: Typically 50% loser, 25% winner, 25% table
- **Both hole cards** must play in qualifying hands

### 9. BETWEEN HANDS

1. Pot awarded to winner(s) with animation
2. Rake amount displayed
3. Brief pause (2-3 seconds)
4. Dealer button rotates clockwise
5. New hand auto-starts (no player action needed)
6. All active players automatically in next hand
7. Players can "Sit Out" between hands
8. Auto-rebuy available if configured

### 10. PLAYER LEAVING (Cash Out)

- Can leave between hands only (not mid-hand)
- Chip stack converted back to wallet balance
- Transaction logged in chip_ledger
- Seat becomes available immediately
- Waiting list player offered the seat

---

## TOURNAMENT DIFFERENCES

### Structure

- Fixed buy-in gives tournament chips (non-redeemable)
- All players start with equal stacks
- Blinds increase on timed schedule (e.g., every 15 min online)
- Late registration window (first N levels)
- Table balancing as players bust (move players to equalize tables)
- Payout structure: top X% of field

### Formats

- **Freezeout**: No rebuys, bust = eliminated
- **Rebuy**: Can rebuy during rebuy period
- **Re-Entry**: Pay full buy-in again, seated at new table
- **Bounty/KO**: Prize for each player eliminated

### Key Differences from Cash

- Cannot leave with chips (must play until bust or win)
- No auto-rebuy (unless rebuy period active)
- Blind levels increase over time
- Players eliminated as they lose all chips

---

## TECHNICAL ARCHITECTURE

### Client-Server Model

- **Server is AUTHORITATIVE** for all game state
- Server maintains: deck, player stacks, cards, pot, action order
- Clients are rendering terminals that display server state
- All actions validated server-side before execution

### Card Security

- Server NEVER sends opponent hole cards to any client
- Each client only receives its own hole cards
- Opponent cards sent ONLY at showdown
- Shuffling uses cryptographically secure RNG on server

### Communication

- Supabase Realtime broadcast channels for state updates
- Channel: `hand-state:{tableId}` for game state broadcasts
- Client sends actions via HTTP POST to game server
- Server validates, processes, broadcasts new state

### State Updates

- Server broadcasts after: HAND_START, CARDS_DEALT, PLAYER_ACTION, COMMUNITY_CARDS, WINNERS, HAND_COMPLETE
- Client receives broadcast, updates UI accordingly
- Turn timer managed server-side, synced to client

---

## CLUB ARENA CODE MAP

### Key Files

| File                                      | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `src/pages/TablePage.tsx`                 | Main game page, hand loop orchestration (5000+ lines) |
| `src/engine/HandController.ts`            | Hand state machine: deal, action, showdown            |
| `src/engine/PokerEngine.ts`               | Hand evaluation, pot calc, rake, winner determination |
| `src/components/table/SeatSlot.tsx`       | Per-player seat rendering                             |
| `src/components/table/ActionPanel.tsx`    | Fold/Check/Call/Raise/All-In buttons                  |
| `src/components/table/CommunityCards.tsx` | Flop/Turn/River display                               |
| `src/components/table/PotDisplay.tsx`     | Pot visualization                                     |
| `src/engine/HorseLogic.ts`                | Bot decision engine                                   |
| `src/services/HandPersistenceService.ts`  | Hand history persistence                              |
| `src/lib/supabase.ts`                     | Realtime broadcast/subscribe                          |
| `server/src/engine/ServerTableEngine.ts`  | Server-side engine (Hetzner VPS)                      |
| `server/src/engine/HandController.ts`     | Server-side hand controller                           |

### Verified Working (from audit)

- Hand dealing (correct card counts per variant)
- Betting logic (check/call/bet/raise/fold/all-in)
- Action order (UTG first preflop, SB first postflop, heads-up rules)
- Pot calculation including side pots
- Hand evaluation (all rankings, Omaha support)
- Winner determination (multi-way, split pots, hi-lo)
- Rake calculation (percentage, caps, no-flop-no-drop)
- Next hand auto-start (3 sec delay, dealer rotation)
- Horse bot decisions (5 styles, position-aware)
- Hand history recording and persistence

### Known Issues (from audit)

1. **No seat selection UI** - Players can't visually choose a seat
2. **Client-side dealing only** - Server engine runs independently, not coordinated
3. **Timer shows on horse turns** - Should be hidden for bot actions
4. **Pot display briefly stale after showdown** - Minor visual glitch

---

## CHECKLIST: USE THIS FOR EVERY GAMEPLAY CHANGE

Before making any change to gameplay code, verify against this spec:

- [ ] Does the action flow match the correct order? (UTG first preflop, SB first postflop)
- [ ] Are cards dealt to correct count per variant?
- [ ] Is the pot calculated correctly including side pots?
- [ ] Is rake applied with no-flop-no-drop rule?
- [ ] Is the dealer button rotating correctly?
- [ ] Are blinds posted in correct amounts and positions?
- [ ] Does the timer work (15-30 sec, auto-fold/check on expire)?
- [ ] Are opponent cards hidden until showdown?
- [ ] Is the winning hand correctly identified?
- [ ] Does the pot award animation play?
- [ ] Does the next hand auto-start after brief delay?
