# ULTRA-MASTER SYSTEM BIBLE v8 — Complete Reference

## CHAPTER 1: MASTER LAWS

### Law 1.1 — SINGLE PENDING ACTION

At any moment during a hand, exactly ONE player has the right to act. No other player may submit actions until the current player's action is processed and the turn advances.

**Requirements:**

- 1.1.1: Server maintains `currentPlayerSeat` — only this seat's actions are accepted
- 1.1.2: All other action submissions are rejected with clear error
- 1.1.3: Pre-actions are queued but NOT executed until it becomes that player's turn
- 1.1.4: No parallel action processing — actions are serialized

### Law 1.2 — HARD BLOCK LAW

The game MUST NOT advance to the next step until the current step is fully complete. No action, no deal, no broadcast may occur out of order.

**Requirements:**

- 1.2.1: Action must be validated before execution
- 1.2.2: Execution must complete before state broadcast
- 1.2.3: Broadcast must confirm before next turn begins
- 1.2.4: Timer starts only AFTER broadcast confirms turn change
- 1.2.5: No fire-and-forget — every step awaits completion

### Law 1.3 — ORDER OF OPERATIONS

Every player action follows this EXACT sequence (20 steps):

1. Player clicks UI button
2. Client sends action to server
3. Server validates identity (auth check)
4. Server validates turn (is it this player's turn?)
5. Server validates action legality (can they check/bet/raise?)
6. Server validates amount (min raise, max raise, stack limits)
7. Server validates timing (within timer + grace period)
8. Server checks for duplicate submission
9. Server executes action on HandController
10. Server updates game state (pot, bets, stacks, player status)
11. Server calculates new available actions for next player
12. Server determines next player to act
13. Server starts next player's timer
14. Server broadcasts authoritative state to all clients
15. Client receives broadcast
16. Client updates UI state from server data
17. Client shows popup/overlay for the action
18. Client plays animation (chips moving, cards dealing)
19. Client plays sound effect
20. Client triggers haptic feedback

### Law 1.4 — TRUTH LAW

There is ONE source of truth: the server. Client state is a REFLECTION of server state, never authoritative.

**Requirements:**

- 1.4.1: Server state is the canonical game state
- 1.4.2: Client derives ALL display state from server broadcasts
- 1.4.3: If client and server disagree, server wins — always
- 1.4.4: StateVerifier runs between hands to ensure chip conservation
- 1.4.5: No client-side game logic that modifies canonical state

### Law 1.5 — FAIRNESS LAW

Every player receives equal treatment: correct turn order, legal action sets, timer rights, side-pot eligibility, and card security.

**Requirements:**

- 1.5.1: Turn order follows standard poker position rules
- 1.5.2: Available actions are calculated identically for all players
- 1.5.3: Timer duration is the same for all players (unless time bank differs)
- 1.5.4: Side pot eligibility is calculated correctly for all-in players
- 1.5.5: No player can see another player's hole cards (anti-god-mode)
- 1.5.6: Validation errors return error messages, NEVER auto-fold

### Law 1.6 — NO-AMBIGUITY LAW

Every state in the system has explicit entry conditions, exit conditions, and failure conditions. No implicit state transitions.

### Law 1.7 — DISCONNECT LAW

When a player disconnects, their action timer continues running. The game does NOT pause for disconnected players.

**Requirements:**

- 1.7.1: Disconnect detected via heartbeat (server-side)
- 1.7.2: Action timer keeps counting during disconnect
- 1.7.3: If timer expires during disconnect: auto-fold (or auto-check if possible)
- 1.7.4: preferCheckOverFold: if player can check, auto-check instead of auto-fold
- 1.7.5: Reconnect grace period: 5 seconds after reconnect before next auto-action
- 1.7.6: maxConsecutiveTimeouts: after N consecutive timeouts (default 3), auto-sit-out

### Law 1.8 — FOLD FINALITY LAW

Once a player folds, their `is_folded` flag is TRUE for the remainder of the hand. No undo. No take-backs.

### Law 1.9 — SETTLEMENT LAW

Hand settlement follows this EXACT sequence:

1. Lock table (no new actions accepted)
2. Calculate side pots from contributions
3. Evaluate all active players' hands (variant-aware)
4. Determine winners per pot (including hi-lo split)
5. Calculate rake (percentage with cap, no-flop-no-drop)
6. Distribute winnings (integer-cents arithmetic)
7. Update player stacks
8. Persist results to database (atomic transaction)
9. Update leaderboards
10. Trigger achievements/daily challenges
11. Calculate VIP points earned
12. Calculate rakeback
13. Log complete hand history
14. Broadcast final state (with showdown cards)
15. Unlock table

### Law 1.10 — VISUAL TRUTH LAW

Every visual element (popup, overlay, badge, animation) must correspond to an actual game event. No visual without an event, no event without a visual.

### Law 1.11 — AUDIO TRUTH LAW

Every sound effect corresponds to exactly one game event. No sound for non-events, no missing sound for events.

### Law 1.12 — HAPTIC TRUTH LAW

Haptic feedback intensity matches event significance: light for check/fold, medium for bet/raise, heavy for all-in/win.

### Law 1.13 — PRIORITY STACK

Server > Database > Client. In any conflict, higher priority wins.

### Law 1.14 — SCOPE

This Bible covers: Cash games, Sit-and-Go, Multi-Table Tournaments, Spin & Go, all Hold'em variants, all Omaha variants, Short Deck, and OFC.

### Law 1.15 — CASH/TOURNAMENT/VARIANT BRANCHING

Rules that differ between cash and tournament (rebuys, blind increases, elimination) are explicitly branched. Rules that differ between variants (cards dealt, hand evaluation, hi-lo) are explicitly branched.

### Law 1.16 — REAL-TIME DELIVERY LAW (Dan decree, 2026-04-14)

EVERY visible aspect, feature, sound, animation, badge, countdown, and
detail in Club Arena MUST be delivered to the client through a discrete,
named, real-time WebSocket event the millisecond it occurs on the
server. NO snapshot diffing. NO polling. NO setInterval clock-watch. NO
"wait for the next state broadcast and figure out what changed".

#### Mechanism

- The engine WebSocket (`wss://engine.smarter.poker/ws/table/:id`) is
  the SOLE real-time channel. Persistent per-table connection. The
  server PUSHES events as they occur.
- Every event has a NAMED type (`player_action`, `pot_win`,
  `community_cards_dealt`, `blinds_posted`, `hand_started`, `showdown_reveal`,
  `time_bank_low`, `rit_offer`, `insurance_offers`, `rabbit_hunt_available`,
  `straddle_posted`, `pot_distributed`, `seat_taken`, `seat_left`,
  `chat_message`, `stage_change`, `hole_cards_dealt`, etc.) and a flat
  top-level payload — never nested under `.data`, never inside a giant
  snapshot blob.
- `broadcastCurrentState()` snapshots exist ONLY as a SAFETY NET for:
  1. New WS clients connecting mid-hand (need a starting state)
  2. Reconnect resync after network drop
  3. Idempotent reconciliation if a discrete event was lost in transit

  Snapshots MUST NOT be the trigger for any animation, sound, label,
  countdown, or other UX cue.

#### Forbidden patterns

- Diffing previous-vs-current snapshot fields to decide whether to play
  an animation or sound — react to the discrete event instead.
- Subscribing to `broadcastCurrentState` to detect a stage change —
  emit `community_cards_dealt` (flop/turn/river) and react to that.
- `setInterval` to refresh chat / chip stack / timer / online count —
  every change comes as an event.
- Polling Supabase tables for "what's new" — the engine emits the
  authoritative event the same instant it changes its own state.

#### Required pattern

For every visible aspect / feature / detail in the UI:

1. The engine emits a named discrete event the moment that aspect
   changes, with a flat payload containing only the fields the client
   needs to render the change.
2. The client receives the event over the WS hub and updates the UI
   directly from the event payload.
3. The next snapshot is sent for reconciliation only — the UI MUST
   already be up-to-date from the discrete event before the snapshot
   arrives.

#### Audit obligation

Any agent shipping work that touches a visible UX aspect MUST:

- Verify the trigger is a discrete event, not a snapshot diff or
  polling interval.
- If a snapshot-driven UX path exists, list it in `MIGRATION-CHANGELOG.md`
  as a known violation with a remediation plan and convert it.

#### Verification clause for commit messages

Every PR adding or touching visible UX MUST include in its commit
message a one-line confirmation:

> Real-time law: triggered by `<event_name>` discrete WS event, no
> snapshot diff.

This law overrides any prior latency targets, snapshot intervals, or
polling fallbacks. There is no negotiation. See also
`MIGRATION-LAW.md` LAW 11.

---

## CHAPTER 2: OBJECT SCHEMAS

### 2.1 — Table Object

Required fields: id, club_id, tournament_id, name, game_type ('cash'|'tournament'), game_variant, stakes, small_blind, big_blind, ante, big_blind_ante, max_players, min_players, status, settings, created_at, updated_at

### 2.2 — Table Settings Object

Required fields: straddle_enabled, straddle_type ('utg'|'mississippi'), max_straddles, run_it_twice_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, time_bank_enabled, time_bank_seconds, time_bank_max_uses, action_time_seconds, insurance_enabled, ante_enabled, ante_amount, big_blind_ante_enabled, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, auto_muck_enabled, show_hand_enabled

### 2.3 — Seat/Player Object

Required fields: seat, user_id, username, stack, bet, totalInvested, cards, is_folded, is_all_in, is_sitting_out, is_disconnected, time_bank_remaining, time_bank_uses_remaining, position ('BTN'|'SB'|'BB'|'UTG'|'MP'|'CO'|etc.), avatar_url, is_horse

### 2.4 — Hand State Object (broadcast payload)

Required fields: table_id, hand_number, pot, community_cards, current_bet, current_player (user_id), dealer_seat, stage, min_raise, last_raise, turn_start_time_ms, turn_duration_ms, players[], pots[], action_history[]

### 2.5 — Action Record

Required fields: seat, userId, action, amount, timestamp, stage

### 2.6 — Pot Object

Required fields: amount, eligible (user_id[])

### 2.7 — Winner Object

Required fields: userId, amount, potIndex, hand (evaluated hand description)

### 2.8 — Hand Config

Required fields: tableId, handNumber, gameVariant, smallBlind, bigBlind, ante, bigBlindAnte, rakeConfig, bombPot, straddles, ritEnabled, insuranceEnabled

### 2.9 — Rake Config

Required fields: percent, cap, noFlopNoDrop, playerCountCaps[], timedRake (alternative)

### 2.10-2.18 — Additional schemas for tournaments, achievements, hand history layers (4-tier: raw, structured, display, export)

---

## CHAPTER 3: STATE MACHINES

### 3.1 — Table State Machine

```
States: EMPTY → WAITING → SEATING → RUNNING → PAUSED → CLOSING → CLOSED
Transitions:
  EMPTY → WAITING: first player sits
  WAITING → SEATING: second player sits (buy-in phase)
  SEATING → RUNNING: both bought in, hand starts
  RUNNING → RUNNING: hand completes, next hand starts
  RUNNING → PAUSED: admin pause, break, or hand-for-hand
  PAUSED → RUNNING: resume
  RUNNING → WAITING: player count drops below 2
  RUNNING → CLOSING: admin close or all leave
  CLOSING → CLOSED: cleanup complete
```

### 3.2 — Hand State Machine

```
States: IDLE → POSTING_BLINDS → DEALING_HOLE_CARDS → PREFLOP_BETTING →
        DEALING_FLOP → FLOP_BETTING → DEALING_TURN → TURN_BETTING →
        DEALING_RIVER → RIVER_BETTING → SHOWDOWN → SETTLEMENT → CLEANUP → IDLE

Each state has:
  - Entry conditions (what must be true to enter)
  - Actions (what happens in this state)
  - Exit conditions (what must be true to leave)
  - Failure conditions (what causes error/abort)
```

### 3.3 — Turn State Machine

```
States: WAITING → TIMER_RUNNING → TIME_BANK_ACTIVE → EXPIRED → ACTION_RECEIVED → PROCESSING → COMPLETE

Transitions:
  WAITING → TIMER_RUNNING: broadcast received, this player's turn
  TIMER_RUNNING → TIME_BANK_ACTIVE: primary timer expires, time bank available
  TIMER_RUNNING → EXPIRED: primary timer expires, no time bank
  TIME_BANK_ACTIVE → EXPIRED: time bank expires
  TIMER_RUNNING → ACTION_RECEIVED: player submits action within time
  TIME_BANK_ACTIVE → ACTION_RECEIVED: player submits during time bank
  ACTION_RECEIVED → PROCESSING: server validates + executes
  PROCESSING → COMPLETE: action applied, next turn begins
  EXPIRED → COMPLETE: auto-fold/check applied
```

### 3.4 — Disconnect State Machine

```
States: CONNECTED → HEARTBEAT_MISSED → DISCONNECTED → RECONNECTING → RECONNECTED

Transitions:
  CONNECTED → HEARTBEAT_MISSED: no heartbeat for N seconds
  HEARTBEAT_MISSED → DISCONNECTED: no heartbeat for disconnect_timeout_seconds
  DISCONNECTED → RECONNECTING: heartbeat received again
  RECONNECTING → RECONNECTED: grace period complete
  RECONNECTED → CONNECTED: full state sync complete
```

---

## CHAPTER 4: OPERATIONAL PROCEDURES

### 4.1 — Hand Start Procedure

1. Select dealer (rotate from previous hand)
2. Determine positions (BTN, SB, BB, UTG, etc.)
3. Post blinds (handle heads-up: dealer=SB)
4. Post antes (if enabled — traditional or BBA)
5. Post straddles (if enabled — UTG or Mississippi)
6. Shuffle deck (crypto-random)
7. Deal hole cards (2 for Hold'em, 4-6 for Omaha variants)
8. Deliver hole cards securely (per-player, not broadcast)
9. Set first player to act (UTG preflop, or SB postflop in heads-up)
10. Start action timer
11. Broadcast hand state

### 4.2 — Blind Posting

- Heads-up: Dealer posts SB, other player posts BB
- 3+: Player left of dealer posts SB, next left posts BB
- Short blind (player can't cover): post what they can, mark all-in
- Dead blind: player returning from sit-out posts both SB+BB, SB is dead

### 4.3 — Ante Handling

- Traditional ante: every player posts ante before cards
- Big Blind Ante (BBA): BB posts ante for entire table (amount = ante × player_count or just the ante amount, configurable)
- Ante goes into pot before blinds
- If player can't cover ante: post what they can

### 4.4 — Straddle Handling

- UTG straddle: UTG posts 2× BB before cards, action starts left of straddler
- Mississippi straddle: any position can straddle, last straddler acts last preflop
- Re-straddle: next player can straddle 2× previous straddle (up to max_straddles)
- Straddle is live — straddler can raise when action comes back

### 4.5 — Card Dealing

- Shuffle: crypto-random (use crypto.getRandomValues or equivalent)
- Hold'em: 2 cards per player
- PLO/PLO4: 4 cards per player
- PLO5: 5 cards per player
- PLO6: 6 cards per player
- Short Deck: remove 2s through 5s before shuffle
- Deal one card at a time, clockwise from SB

### 4.6 — Hole Card Security (Anti-God-Mode)

- Server deals cards and stores per-player
- Each player receives ONLY their own cards via secure per-player channel (RPC, not broadcast)
- Broadcast state NEVER includes other players' hole cards
- At showdown: reveal only non-folded players' cards (or winners only if auto-muck)
- Even server logs should not contain all cards during a live hand (aspirational)

### 4.7-4.8 — Betting Round Flow

1. Determine first player to act:
   - Preflop: left of BB (or left of last straddler)
   - Postflop: first active player left of dealer
2. Player acts: fold, check, call, bet, raise, or all-in
3. Advance to next active non-all-in player
4. Repeat until betting round complete
5. Betting round complete when:
   - All non-all-in players have acted since last aggressive action
   - All non-all-in players' bets are equal to current bet
   - Only one player remains (everyone else folded)

### 4.9-4.14 — Action Validation Rules

- **Fold**: always legal (but server should auto-check if toCall=0)
- **Check**: legal only when toCall=0
- **Call**: legal when toCall>0, amount = min(toCall, playerStack)
- **Bet**: legal when currentBet=0, amount >= minBet (usually BB)
- **Raise**: legal when currentBet>0, amount >= currentBet + lastRaise
- **All-in**: always legal when player has chips, amount = remaining stack
- **Min raise**: raise must be at least the size of the last raise (or BB if first raise)
- **Max raise**: no-limit = entire stack; pot-limit = current pot + call amount
- **Short all-in**: if player goes all-in for less than a full raise, it does NOT reopen betting

### 4.15 — Pre-Action System

Pre-actions are intentions set before it's your turn:

- auto_fold: fold when my turn comes
- auto_check_fold: check if possible, otherwise fold
- auto_check: check if possible (invalid if there's a bet)
- auto_call: call current bet when my turn comes
- auto_call_any: call any bet (including raises after setting)

Rules:

- Pre-actions are evaluated when the turn reaches the player
- If game state changed (someone raised), pre-action may be invalidated
- Pre-action is ALWAYS cleared after evaluation (valid or not)
- Pre-action execution follows same validation as manual actions

### 4.16-4.18 — Stage Progression

- Preflop → Flop: deal 3 community cards, reset bets, first player left of dealer
- Flop → Turn: deal 1 community card, reset bets
- Turn → River: deal 1 community card, reset bets
- River → Showdown: if 2+ players remain after betting
- All-in runout: if all active players are all-in, deal remaining community cards automatically (with pause for RIT/insurance decisions)

### 4.19 — Insurance

When all players are all-in with cards to come:

1. Calculate equity for each player
2. Offer insurance to the player with the best hand
3. Player can buy insurance on specific outs
4. If bought: insurance payout is calculated regardless of board runout
5. Time limit to accept insurance offer

### 4.20 — Run It Twice (RIT)

When exactly 2 players are all-in:

1. Offer RIT to both players
2. Both must accept (either can decline)
3. If accepted: deal two separate boards from the remaining deck
4. Each board determines half the pot
5. Rake applies once (not per board)
6. 3× boards also supported (each board = 1/3 of pot)
7. Time limit to accept RIT offer

### 4.21 — Showdown Rules

- Last aggressor shows first
- If no aggressor (everyone checked river): first player left of dealer shows first
- Players can muck (hide cards) — but winner must show
- Auto-muck: if enabled, losing hands are automatically mucked
- Show hand: player can choose to show even when not required
- Showdown order proceeds clockwise from the first shower

### 4.22 — Bomb Pot

- All players post ante (multiplier × BB)
- Skip preflop betting — deal directly to flop
- Normal betting from flop onward
- Frequency: every N hands (configurable)
- PLO bomb pots: deal 4-6 cards, bet from flop

---

## CHAPTER 5: UI/POPUP/ANIMATION/SOUND/HAPTIC DOCTRINE

### 5.1 — Popup Doctrine

Every significant game event triggers a popup/overlay:

- Hand start: position badges appear
- Blind posting: chip animation from player to pot
- Card dealing: card flip animation
- Player action: action label popup (FOLD, CHECK, CALL $X, RAISE $X, ALL-IN)
- Community cards: card slide animation with stage label
- Showdown: card reveal animation with hand rank label
- Winner: chip slide animation from pot to winner with amount label
- Insurance/RIT: modal overlay with accept/decline buttons

### 5.2 — Animation Sequence

Animations are SEQUENTIAL, not simultaneous:

1. Action label appears (200ms)
2. Chip animation plays (300ms)
3. Pot updates (100ms)
4. Turn indicator moves (200ms)

### 5.3 — Sound Doctrine

- fold: soft card toss sound
- check: tap/knock sound
- call: chip clink sound
- bet/raise: chip stack sound (louder for larger amounts)
- all_in: dramatic chip slide + bell
- deal: card slide sound
- community cards: card flip sound
- showdown: dramatic reveal sound
- winner: celebration sound (confetti for large pots)
- timer warning: tick sound in last 5 seconds
- time bank activate: bank activation sound
- disconnect: subtle offline indicator sound

### 5.4 — Haptic Doctrine

- fold/check: light haptic
- call: light haptic
- bet/raise: medium haptic
- all_in: heavy haptic
- your turn: medium haptic
- you win: heavy celebration haptic
- timer warning (3s left): quick pulse haptic

---

## CHAPTER 6: TIMER SYSTEM

### 6.1 — Action Timer

- Server-authoritative, deadline-based (not setTimeout)
- Configurable per table: action_time_seconds (default 15)
- Timer starts when server broadcasts TURN_CHANGE
- Timer displayed on client as countdown
- Grace period: 2 seconds after timer reaches 0 (for network latency)
- On expiry: auto-fold (or auto-check if toCall=0 and preferCheckOverFold=true)

### 6.2 — Time Bank

**Two different numbers, and they have been conflated before.** The standard
decision clock is **15 seconds** (`action_time_seconds`). A time bank is an
**extension on top of that**, worth **20 seconds**. FIX 200 once set the grant
to 15 with the note "was incorrectly 20" — that was the conflation, and it is
reversed. Owner ruling, 2026-08-18.

- Decision clock: 15s for every player, cash and tournament alike
- **Per-STREET limit: 2 activations max.** Preflop, flop, turn and river each
  get their own allowance of 2. (Owner ruling 2026-08-18; previously 2 per hand,
  which stranded a player who spent both banks preflop.)
- Auto-activate: when primary timer expires and time bank available
- Manual activate: player clicks "Time Bank" button during their turn
- **Each activation adds exactly 20 seconds**
- Pool model: total seconds available per session, depletes 20s per use. The
  free session base is 40s — two whole banks — plus VIP allowance and any
  purchased extension.
- Refill: per orbit or per session (configurable). NOTE: the per-orbit branch is
  unreachable in production because nothing sets `refillPerOrbit`; per-session
  is what ships. See COMPLIANCE-TRACKER 6.2.c.

### 6.3 — Disconnect Timer

- Heartbeat interval: server pings every 3-5 seconds
- Disconnect detected: no heartbeat for disconnect_timeout_seconds (default 30s)
- During disconnect: action timer keeps running
- On disconnect + timer expiry: auto-fold/check
- maxConsecutiveTimeouts (default 3): after N consecutive timeouts, auto-sit-out
- Reconnect grace: 5 seconds after heartbeat resumes before next auto-action

---

## CHAPTER 7: EDGE CASES (200+ Test Scenarios)

### Critical Edge Cases:

- 7.1: Heads-up blind posting (dealer=SB)
- 7.2: Short blind (can't cover, all-in immediately)
- 7.3: All-in for less than minimum raise (doesn't reopen betting)
- 7.4: Side pot calculation with 3+ all-in players at different amounts
- 7.5: Split pot (identical hands)
- 7.6: Hi-Lo split with no qualifying low
- 7.7: Hi-Lo split with odd chip (goes to high winner)
- 7.8: Run-it-twice with different winners on each board
- 7.9: Disconnect during all-in runout
- 7.10: Bomb pot with player who can't cover ante
- 7.11: Straddle when next player can't cover
- 7.12: Player sits out during a hand (can't fold mid-hand, wait until next hand)
- 7.13: Player leaves table during a hand (process at hand end)
- 7.14: Tournament elimination (last chip goes to pot, player exits)
- 7.15: Final table bubble (hand-for-hand play)
- 7.16: Simultaneous disconnects at same table
- 7.17: Server crash recovery (reload state from DB, resume)
- 7.18: Rake calculation with no flop (no-flop-no-drop)
- 7.19: Rake cap per player count
- 7.20: Mixed game rotation (change variant every orbit)

---

## CHAPTER 8: EXTENSIBILITY

### 8.1 — New Game Variants

Adding a new variant requires:

- New evaluator function
- Cards-per-player configuration
- Blind/ante/straddle rules if different
- UI card layout if different

### 8.2 — New Tournament Types

Adding new tournament type requires:

- Blind structure definition
- Payout structure
- Elimination/rebuy/addon rules
- Timer/break configuration

---

## CHAPTER 9: WORLD-CLASS EXCELLENCE

### 9.1 — Performance

- Action processing: < 50ms server-side
- Broadcast latency: < 100ms to all clients
- UI update: < 16ms (60fps target)
- Hand throughput: 30+ hands/hour at full pace

### 9.2 — Reliability

- Zero tolerance for chip leaks (StateVerifier between every hand)
- Zero tolerance for card exposure
- Graceful degradation on network issues
- Auto-recovery from crashes

### 9.3 — Security

- All game logic server-side
- Per-player card provisioning
- Rate limiting on action submissions
- Auth validation on every request

---

## CHAPTER 10: ANIMATION STANDARDS

### 10.1 — Card Animations

- Deal: cards slide from deck to player positions
- Community: cards slide to center, flip face-up
- Showdown: cards flip to reveal hand

### 10.2 — Chip Animations

- Bet/raise: chips slide from player to pot
- Win: chips slide from pot to winner

### 10.3 — Timing

- All animations are sequential, not overlapping
- Total animation budget per action: < 800ms
- Skip animations option for speed players

---

## APPENDICES

### Appendix A: Rake Chart

Standard rake: 10% of pot with tier-based cap
No-flop-no-drop: if hand doesn't reach flop, no rake
Caps by blind level (see code for exact chart)

### Appendix B: Position Names

2 players: BTN/SB, BB
3 players: BTN/SB, BB, UTG
4 players: BTN, SB, BB, UTG
5 players: BTN, SB, BB, UTG, CO
6 players: BTN, SB, BB, UTG, MP, CO
7 players: BTN, SB, BB, UTG, UTG+1, MP, CO
8 players: BTN, SB, BB, UTG, UTG+1, MP, MP+1, CO
9 players: BTN, SB, BB, UTG, UTG+1, UTG+2, MP, HJ, CO

### Appendix C: Hand Rankings (Hold'em)

Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > One Pair > High Card

### Appendix D: Hand Rankings (Short Deck)

Flush beats Full House (harder to make with fewer cards)
A-6-7-8-9 is the lowest straight (ace plays low)

### Appendix E: Animation Physics

Chip trajectories follow parabolic arcs
Card deals follow bezier curves
Winner celebration uses particle system

### Appendix F: Sound Library Requirements

Each sound has: file reference, duration, volume level, priority (can interrupt lower priority)

---

## CHAPTER 11: TABLE SETTINGS & THEME CUSTOMIZATION

### 11.1 — Table Settings (User Preferences)

Every table setting toggle MUST exist in TWO locations:

1. **Table Settings panel** — accessible from the table view gear icon
2. **Club Arena hamburger menu** — accessible from the existing side navigation

Both locations read/write the SAME `user_table_settings` row in Supabase.
Changes persist across sessions via `user_table_settings` table.

#### 11.1.1 — Required Toggle Settings

| Setting                  | DB Column                  | Default | Description                                           |
| ------------------------ | -------------------------- | ------- | ----------------------------------------------------- |
| Highlight Active Players | `highlight_active_players` | `true`  | Highlight the currently-acting player's seat          |
| Show Avatars             | `show_avatars`             | `true`  | Display player avatar images at seats                 |
| Show Badges              | `show_badges`              | `false` | Display VIP/achievement badges at seats               |
| Cards Pre-Sort           | `cards_pre_sort`           | `true`  | Auto-sort hole cards by rank (high→low)               |
| Gestures                 | `gestures_enabled`         | `false` | Enable swipe/drag gesture controls for actions        |
| Card Slide               | `card_slide`               | `false` | Enable card peek/slide reveal animation               |
| Show Stack in Big Blinds | `show_stack_in_bb`         | `false` | Display chip stacks as BB count instead of chip value |
| Auto Time Bank           | `auto_time_bank`           | `false` | Auto-activate time bank when primary timer expires    |
| Enhanced View            | `enhanced_view`            | `false` | Enable enhanced visual effects and animations         |
| Voice Message            | `voice_message`            | `true`  | Enable voice chat at table                            |
| Text Message             | `text_message`             | `true`  | Enable text chat at table                             |
| Emoji                    | `emoji_enabled`            | `true`  | Enable emoji reactions/throwables                     |

#### 11.1.2 — Persistence

- All settings stored in `user_table_settings` table (keyed by `user_id`)
- Client reads settings on TablePage mount via `supabase.from('user_table_settings').select()`
- Changes are saved immediately on toggle via `supabase.from('user_table_settings').upsert()`
- Settings apply to ALL tables the user joins (not per-table)

### 11.2 — Theme Settings (Per-Game-Type Customization)

Theme customization is accessed via the "Theme Setting" row in Table Settings.
Themes are customizable PER GAME TYPE — each game type can have independent theme selections.

#### 11.2.1 — Game Types for Theme Customization

`ALL | NLH | FLH | 6+ | PLO | FLO | OFC | MIXED | MTT | SNG`

#### 11.2.2 — Theme Categories (5 Tabs)

**Tab 1: Themes** — Complete table appearance presets

- Free (2 options): Default dark, Classic brown
- VIP: Neon blue hexagonal, Rustic wood/leather, Casino green felt

**Tab 2: Table** — Table felt/surface customization

- Free (2 options): Dark felt, Brown felt
- VIP: Neon blue, Red leather, Green casino felt

**Tab 3: Button** — Dealer button style

- Free (2 options): Red "D" gear, Gray "D" gear
- VIP: Blue crystal "D", Gold star badge, Football/sports themed

**Tab 4: Background** — Room/environment behind table

- Free (2 options): Diamond pattern, Stone/concrete
- VIP: Galaxy/space nebula, Hardwood floor, Teal tile pattern

**Tab 5: Cards** — Card face design

- Free (2 options): Standard red/diamond, Standard blue/diamond
- VIP: Premium gold, Premium black, Platinum card designs

#### 11.2.3 — VIP Gating (Single Tier)

- **Free items**: Available to all users (2 per category)
- **VIP items**: Locked with "VIP" badge overlay — requires active VIP subscription (single tier, no Bronze/Silver/Gold)
- Client checks user's `is_vip` from `profiles` table
- Locked items show padlock overlay; tapping shows VIP upgrade prompt

#### 11.2.4 — Theme Persistence

- Stored in `user_theme_settings` table (new table required)
- Schema: `user_id, game_type, theme_id, table_id, button_id, background_id, cards_id`
- Each row = one game type's theme selections for one user
- "ALL" game type = default fallback if no per-game-type override exists
- Reset button: reverts all selections to Free defaults for current game type
- Confirm button: saves selections and closes Theme Settings modal

#### 11.2.5 — Asset Requirements

- Each theme asset needs: thumbnail image (for selector grid), full asset (for rendering)
- Thumbnails: ~100x80px for grid display
- Full assets: table felt texture, button sprite, background image, card face sprites
- All assets served from `smarter.poker/hub/club-arena/assets/themes/`

### 11.3 — Implementation Notes

- Table Settings component should be a reusable `<TableSettingsPanel />` that renders in both the table gear menu and the hamburger nav
- Theme Settings is a modal/page with 5-tab layout, game type dropdown at top
- Both require Supabase RPC or direct table access for persistence
- VIP gating requires reading the user's current VIP level and comparing against asset tier requirements
