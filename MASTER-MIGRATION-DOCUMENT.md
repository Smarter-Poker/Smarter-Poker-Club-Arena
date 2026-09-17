> Historical completed migration reference. Use current AGENTS.md, the operating law and PUBLISHING.md for execution. This document does not assign a new phase or impose another approval gate.

# MASTER MIGRATION DOCUMENT

## Club Arena Engine Migration: Client → Server

**Last Updated:** 2026-03-29
**Status:** ALL 8 STEPS COMPLETE — Server-Authoritative Migration Finished
**Phases:** 6 (Sequential, non-overlapping)
**Total Server Files to Port:** 20
**Total Client References to Remove:** 48 (handControllerRef) + 15 (broadcastLocalHandState) + ~200+ action handlers

---

## SECTION 1: ARCHITECTURE OVERVIEW

### Current Broken Architecture (MUST FIX)

**Dual Engine Model (WRONG):**

```
Client (TablePage.tsx):
  ├─ Local HandController (917 lines)
  │  ├─ runHand() — full game loop
  │  ├─ dealHand(), changeStreet(), distributeWinnings()
  │  ├─ calculateBettingState(), performAction()
  │  └─ broadcastLocalHandState() (15 calls via events)
  │
  └─ Event handlers (4005-4206) — each calls handControllerRef.current.performAction()
     ├─ handleFold()
     ├─ handleCheck()
     ├─ handleCall()
     ├─ handleBet()
     ├─ handleRaise()
     ├─ handleAllIn()
     └─ handleTimebank()

Server (index.ts):
  ├─ 3 endpoints (health, action, timebank)
  ├─ Parallel HandController (553 lines) — conflicts with client
  ├─ ServerTableEngine (990 lines) — runs but doesn't validate client actions
  │  ├─ handlePlayerAction() (auto-folds on error — BLOCKER #3)
  │  └─ broadcastCurrentState() (sends ALL cards — BLOCKER #2)
  │
  └─ Supabase Realtime — "receives" broadcasts from client, client ignores server

PROBLEM: Client is authoritative. Server is decorative. NO validation. Cards leaked to all players.
```

### Target Architecture (REQUIRED)

**Server-Authoritative Model (CORRECT):**

```
Client (TablePage.tsx):
  ├─ State machine (read from Supabase Realtime only)
  ├─ UI rendering (current hand, players, board, pot)
  │
  └─ Action Handlers (async HTTP POST):
     ├─ handleFold() → POST /action { action: 'fold' } → await result
     ├─ handleCheck() → POST /action { action: 'check' }
     ├─ handleCall() → POST /action { action: 'call' }
     ├─ handleBet() → POST /action { action: 'bet', amount }
     ├─ handleRaise() → POST /action { action: 'raise', amount }
     ├─ handleAllIn() → POST /action { action: 'allin', amount }
     ├─ heartbeat() → POST /heartbeat (every 5s while at table)
     ├─ handlePreAction() → POST /preaction { action, maxCall? }
     └─ [NO LOCAL ENGINE]

Supabase Realtime (Single Source of Truth):
  ├─ hand-state:{tableId}
  │  └─ event: hand_state
  │     └─ payload: { stage, pot, board, players[], activePlayerId, timerDeadline, ... }
  │        └─ cards: SCRUBBED (only requesting player's hole cards visible)
  │
  └─ Player disconnection stream (optional)

Server (Hetzner VPS Node.js — SOLE AUTHORITY):
  ├─ HTTP Endpoints (10+)
  │  ├─ POST /action { tableId, userId, action, amount? } → validates, executes, broadcasts
  │  ├─ POST /heartbeat { tableId, userId } → resets disconnect timer
  │  ├─ POST /preaction { tableId, userId, action, maxCall? }
  │  ├─ POST /timebank { tableId, userId }
  │  ├─ POST /sitout { tableId, userId }
  │  ├─ POST /rit { tableId, userId, response: 'accept'|'decline' }
  │  ├─ POST /insurance { tableId, userId, response: 'accept'|'decline' }
  │  ├─ POST /straddle { tableId, userId, enabled: boolean }
  │  ├─ POST /showhand { tableId, userId }
  │  ├─ GET /actions/:tableId/:userId
  │  ├─ GET /state/:tableId (scrubbed for requesting player)
  │  └─ GET /health
  │
  ├─ Engine (20+ files — AUTHORITATIVE)
  │  ├─ HandController.ts (upgraded, 600+ lines)
  │  │  ├─ runHand() — game loop (Server version only)
  │  │  ├─ dealHand(), changeStreet(), distributeWinnings()
  │  │  ├─ performAction() — validates + executes (Server version, with all client features)
  │  │  ├─ Integrated extensions:
  │  │  │  ├─ TimeBankEngine — pool-based time banks
  │  │  │  ├─ DisconnectEngine — auto-fold on disconnect
  │  │  │  ├─ PreActionEngine — auto-actions
  │  │  │  ├─ StraddleEngine — UTG/Mississippi straddles
  │  │  │  ├─ RunItTwiceEngine — dual board deals
  │  │  │  ├─ InsuranceEngine — all-in equity insurance
  │  │  │  ├─ MixedGameEngine — game rotation
  │  │  │  └─ RakebackEngine — per-player rake tracking
  │  │  │
  │  │  └─ Broadcasting:
  │  │     └─ broadcastHandState(tableId, {stage, pot, board, players[], ...})
  │  │        └─ Supabase channel hand-state:{tableId}
  │  │
  │  ├─ ServerTableEngine.ts (950 lines)
  │  │  ├─ handlePlayerAction() — async, HTTP endpoint handler
  │  │  ├─ validateAction() — uses ServerActionValidator
  │  │  ├─ broadcastCurrentState() — SCRUBBED (cards only for requesting player)
  │  │  └─ Timer management — uses PreciseActionTimer
  │  │
  │  ├─ ServerActionValidator.ts — full validation
  │  ├─ PreciseActionTimer.ts — deadline-based timers (no drift)
  │  ├─ StateVerifier.ts — integrity checks
  │  ├─ AtomicStackService.ts — race-condition-proof settlements
  │  ├─ [8 more engines]
  │  │
  │  └─ PokerEngine.ts (EXISTING — shared, no changes)
  │
  └─ Supabase Integration
     ├─ subscribeToHandState(tableId, callback) — client subscribes
     ├─ broadcastHandState(tableId, state) — server publishes
     └─ No client-to-server events (one-way)

DATA FLOW (Every Action):
  1. Player clicks "Fold" button
  2. Client: POST /action { tableId, userId, action: 'fold' }
  3. Server: validateAction() → HandController.performAction()
  4. Server: Updates table state, emits ACTION_PERFORMED event
  5. Server: broadcastHandState(tableId, newState) → Supabase Realtime
  6. Client: Receives broadcast via subscribeToHandState() callback
  7. Client: Updates local state, re-renders UI
  8. DONE — no local engine involved
```

---

## SECTION 2: THE BIG 3 BLOCKERS (MANDATORY FIXES FIRST)

### BLOCKER #1: DUAL ENGINE (48 handControllerRef references)

**Location:** `src/pages/TablePage.tsx` (lines 2711, 2727-2813)

```typescript
// LINE 2711 — THE REFERENCE
const handControllerRef = useRef<HandController | null>(null);

// LINES 2727-2813 — INITIALIZATION
useEffect(() => {
  handControllerRef.current = new HandController({
    tableId,
    players,
    blindStructure,
    ...config,
  });

  handControllerRef.current.on('hand_complete', (result) => {
    broadcastLocalHandState('HAND_COMPLETE', result);
  });
}, [tableId]);
```

**Impact:** 48 direct references throughout TablePage.tsx. Client runs its own game loop completely independent of server. Server's HandController on Railroad tracks — never invoked.

**Fix:**

- DELETE line 2711
- DELETE lines 2727-2813
- DELETE all 48 references (see spreadsheet in SECTION 7)
- All action handlers become async HTTP calls (pattern in SECTION 7)

**Why Blocking:** Server cannot fix card security, auto-fold bug, or timer accuracy while client engine runs in parallel.

---

### BLOCKER #2: CARD SECURITY (ALL cards broadcasted)

**Location:** `server/src/engine/ServerTableEngine.ts` (line 792)

```typescript
// LINE 792 — WRONG
broadcastCurrentState() {
  const state = {
    ...
    players: this.players.map(p => ({
      ...p,
      cards: p.cards ?? []  // ← LEAKS ALL HOLE CARDS TO ALL PLAYERS
    }))
  };
  this.broadcastState(state);
}
```

**Impact:** Every player receives every other player's hole cards in real-time. Removes all bluffing. Removes all poker.

**Fix:**

```typescript
// CORRECT
broadcastCurrentState(requestingPlayerId: string) {
  const scrubbed = this.players.map(p => ({
    ...p,
    cards: p.id === requestingPlayerId ? (p.cards ?? []) : [],
    // OR: cards: this.isShowdown ? (p.cards ?? []) : []
  }));

  const state = {
    ...
    players: scrubbed
  };
  this.broadcastState(state);
}
```

**Why Blocking:** Cheating vector. Every player can see every card before they act. Breaks game integrity.

---

### BLOCKER #3: AUTO-FOLD ON ERROR (removes error feedback)

**Location:** `server/src/engine/ServerTableEngine.ts` (lines 351-353)

```typescript
// LINES 351-353 — WRONG
async handlePlayerAction(
  tableId: string,
  userId: string,
  action: PlayerAction
): Promise<void> {

  const result = await this.validateAction(action);
  if (!result.valid) {
    // ← BUG: Silently auto-folds on ANY error
    await this.engine.handlePlayerAction(tableId, userId, {
      action: 'fold'
    });
    return;
  }
}
```

**Impact:**

- Invalid raise amount? Auto-fold (should show error to player)
- Duplicate action within 2s? Auto-fold (should reject)
- Timer expired? Auto-fold (should be pre-action, not surprise)
- Insufficient stack? Auto-fold (should reject)

Players think they folded intentionally; they actually hit a validation bug. Frustration ↑ trust ↓.

**Fix:**

```typescript
// CORRECT
async handlePlayerAction(
  tableId: string,
  userId: string,
  action: PlayerAction
): Promise<{success: boolean; error?: string}> {

  const result = this.validator.validate(action, context);
  if (!result.valid) {
    return {
      success: false,
      error: `Action invalid: ${result.errorCode}` // e.g., "INSUFFICIENT_STACK"
    };
  }

  await this.engine.handlePlayerAction(tableId, userId, action);
  return { success: true };
}
```

**Why Blocking:** Players have no feedback on why actions are rejected. Cannot fix without changing response type (all callers must await result).

---

## SECTION 3: HTTP ENDPOINT INVENTORY

### EXISTING ENDPOINTS (server/src/index.ts)

**1. GET /health**

```
Response: {
  status: "online",
  timestamp: number,
  gameServer: GameServerStatus {
    activeTables: number,
    activePlayers: number,
    runningHands: number,
    uptime: number
  }
}
```

No changes needed.

---

**2. POST /action**

```
Request:
{
  tableId: string,
  userId: string,
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin',
  amount?: number
}

Current Response: void (fire-and-forget)
MUST CHANGE TO:
{
  success: boolean,
  error?: string,
  state?: TableState (optional, for immediate feedback)
}

Current Implementation:
  - NO auth (trust userId param)
  - Call engine.handlePlayerAction() directly
  - NO error handling
  - NO validation beyond calculateBettingState

REQUIRED FIXES:
  1. Verify JWT token (getUser from Supabase auth)
  2. Return error result instead of auto-folding
  3. Use ServerActionValidator (20 specific error codes)
  4. Rate limiting (1 request per 100ms per player)
```

---

**3. POST /timebank**

```
Request:
{
  tableId: string,
  userId: string
}

Response: {
  success: boolean,
  error?: string,
  remaining?: number  // seconds remaining in time bank
}

Current Implementation:
  - Calls engine.activateTimeBank()
  - Basic time bank (single use per turn)

REQUIRED CHANGES:
  1. Use new TimeBankEngine (pool model)
  2. Check if player has uses remaining
  3. Return remaining seconds in pool
  4. Handle VIP extension requests (separate endpoint)
```

---

**4. GET /actions/:tableId/:userId**

```
Response: PlayerActions[] {
  tableId: string,
  userId: string,
  action: string,
  amount?: number,
  timestamp: number,
  stage: GameStage
}

Current Implementation:
  - Reads from action history in memory

REQUIRED CHANGES:
  1. Persist to Supabase (for hand history)
  2. Add auth (only players at table can see their own or all if showdown)
```

---

### MISSING ENDPOINTS (MUST ADD — PHASE 3-5)

**5. POST /preaction** (PHASE 3)

```
Request:
{
  tableId: string,
  userId: string,
  action: 'auto_fold' | 'auto_check_fold' | 'auto_check' | 'auto_call' | 'auto_call_any',
  maxCallAmount?: number
}

Response: {
  success: boolean,
  error?: string
}

Implementation:
  - Calls PreActionEngine.setPreAction()
  - Server applies during turn change (before action timer starts)
  - Can be cleared anytime (POST /preaction with action: 'clear')
```

---

**6. POST /heartbeat** (PHASE 3)

```
Request:
{
  tableId: string,
  userId: string
}

Response: {
  success: boolean,
  connected: boolean,
  gracePeriodRemaining: number
}

Implementation:
  - Called every 5 seconds by client
  - DisconnectEngine.heartbeat(tableId, userId)
  - Resets disconnect timeout
  - Returns grace period for UI feedback ("You're about to be auto-folded")
```

---

**7. POST /sitout** (PHASE 3)

```
Request:
{
  tableId: string,
  userId: string,
  sitOut: boolean  // true = sit out, false = sit back in
}

Response: {
  success: boolean,
  error?: string,
  willFoldNextHand: boolean  // true if mid-hand
}

Implementation:
  - DisconnectEngine.sitOut(tableId, userId, "player_requested")
  - If mid-hand, marks for fold on next blind
  - If pre-hand, skips next deal
```

---

**8. POST /rit** (PHASE 4)

```
Request:
{
  tableId: string,
  userId: string,
  response: 'accept' | 'decline',
  ritState?: RunItTwiceState
}

Response: {
  success: boolean,
  error?: string,
  status?: 'accepted' | 'declined' | 'resolved',
  resolution?: RunItTwiceResult
}

Implementation:
  - RunItTwiceEngine.accept() / decline()
  - When both players respond, dealDualBoards()
  - Broadcast results
```

---

**9. POST /insurance** (PHASE 4)

```
Request:
{
  tableId: string,
  userId: string,
  response: 'accept' | 'decline',
  insuranceOfferId: string
}

Response: {
  success: boolean,
  error?: string,
  premium?: number,
  status?: 'accepted' | 'declined'
}

Implementation:
  - InsuranceEngine.accept() / decline()
  - Deduct premium from player stack
  - Settle after hand
```

---

**10. POST /straddle** (PHASE 4)

```
Request:
{
  tableId: string,
  userId: string,
  enabled: boolean  // toggle auto-straddle
}

Response: {
  success: boolean,
  error?: string
}

Implementation:
  - StraddleEngine.toggleAutoStraddle(tableId, userId, enabled)
  - Applied next hand
```

---

**11. POST /showhand** (PHASE 4)

```
Request:
{
  tableId: string,
  userId: string
}

Response: {
  success: boolean,
  error?: string
}

Implementation:
  - Broadcast player's cards to everyone
  - Used during showdown or voluntary reveal
```

---

**12. GET /state/:tableId** (PHASE 3)

```
Query Params:
  - userId? (if provided, scrub cards for other players)

Response: TableState {
  tableId: string,
  stage: 'preflop' | 'flop' | ... | 'showdown',
  pot: number,
  board: Card[],
  players: Player[],  // ← cards SCRUBBED
  activePlayerId: string,
  timerDeadline: number,  // absolute ms timestamp
  smallBlind: Player,
  bigBlind: Player,
  lastAction?: {action, amount, playerId},
  ...
}

Implementation:
  - Called on page load to sync with server state
  - Same format as Supabase Realtime broadcasts
  - Cards scrubbed for requesting player (only show own cards)
```

---

## SECTION 4: SUPABASE BROADCAST & SUBSCRIBE PATH

### Server Side (server/src/services/supabase.ts)

**broadcastHandState(tableId, handState)**

```typescript
// CURRENT (WRONG)
broadcastCurrentState() {
  const state = {
    stage: this.stage,
    pot: this.pot,
    players: this.players.map(p => ({
      ...p,
      cards: p.cards ?? []  // ← LEAKS CARDS
    }))
  };
  supabase.channel(`hand-state:${tableId}`).send({
    type: 'broadcast',
    event: 'hand_state',
    payload: state
  });
}

// CORRECT (REQUIRED)
async broadcastHandState(
  tableId: string,
  handState: HandState,
  requestingPlayerId?: string
) {
  const scrubbed = {
    ...handState,
    players: handState.players.map(p => ({
      ...p,
      cards: p.id === requestingPlayerId
        ? (p.cards ?? [])
        : (this.stage === 'showdown' ? (p.cards ?? []) : [])
      // Show cards to requesting player always
      // Show cards to all players at showdown
      // Otherwise hide
    }))
  };

  // Cache channel to avoid recreation per broadcast
  const channel = this.channelCache.get(tableId)
    ?? supabase.channel(`hand-state:${tableId}`);

  this.channelCache.set(tableId, channel);

  await channel.send({
    type: 'broadcast',
    event: 'hand_state',
    payload: scrubbed
  }).catch(err => {
    console.error(`Failed to broadcast hand state for table ${tableId}:`, err);
    // Fire-and-forget — no delivery confirmation
  });
}
```

**Channel Naming Convention:**

- `hand-state:{tableId}` — broadcast every state change
- Event name: `hand_state`
- Payload: Full TableState (serializable)

**Broadcast Frequency:**

- Every action (fold, check, call, bet, raise, allin)
- Every timer change (started, extended, paused, resumed, expired)
- Every street change (start of new round)
- Every player join/leave (connection state only, no cards)
- NOT on every 100ms timer tick (broadcast only on meaningful changes)

**Error Handling:**

- `.send().catch(err => console.error(...))` — fire-and-forget
- No retry logic — client can request full state via GET /state/:tableId

---

### Client Side (src/lib/supabase.ts)

**subscribeToHandState(tableId, callback)**

```typescript
// CURRENT (WORKS, NO CHANGES NEEDED)
export function subscribeToHandState(
  tableId: string,
  callback: (state: HandState) => void
): () => void {
  const channel = supabase.channel(`hand-state:${tableId}`);

  channel
    .on('broadcast', { event: 'hand_state' }, (payload) => {
      console.log('Received hand state broadcast:', payload);
      callback(payload.payload);
    })
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
```

**Usage in TablePage.tsx:**

```typescript
// PHASE 5 REPLACEMENT
useEffect(() => {
  const unsubscribe = subscribeToHandState(tableId, (newState) => {
    setTableState(newState); // React state
    // Re-render automatically
  });

  return unsubscribe;
}, [tableId]);
```

**Card Scrubbing Verification:**

- Client receives broadcast with `players[i].cards` = empty array for other players
- Client receives broadcast with `players[requesting].cards` = actual hole cards
- Client receives broadcast with ALL `cards` populated at showdown
- UI never displays opponent cards before showdown

---

## SECTION 5: PER-FILE MIGRATION SPECS

### FILE 1: TimeBankEngine.ts (374 lines)

**Location:** `src/engine/TimeBankEngine.ts`

**Purpose:** Extended think time pool management — configurable per table, per-player tracking

**Config Type:**

```typescript
interface TimeBankConfig {
  totalBankSeconds: number; // Total seconds in pool (default 30)
  maxUses: number; // Max activations per hand (default 4)
  secondsPerUse: number; // Seconds consumed per activation (default 15)
  refillPerOrbit: boolean; // Refill on button pass (default false)
  refillSeconds: number; // Seconds to add per orbit (default 15)
  autoActivate: boolean; // Auto-activate when timeout approaches (default true)
}
```

**State Type:**

```typescript
interface PlayerTimeBank {
  playerId: string;
  tableId: string;
  remainingSeconds: number; // Pool remaining
  usesRemaining: number; // Activations left this hand
  isActive: boolean; // Currently using time bank
  activatedAt?: number; // Timestamp of activation
  currentUseSeconds?: number; // Time in current use
  onExpire?: () => void; // Callback when activated time expires
}
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: TimeBankConfig): void
// Sets time bank config for table

// Player management
initializePlayer(
  tableId: string,
  playerId: string,
  initialState?: PlayerTimeBank
): void
// Create player time bank pool

removePlayer(tableId: string, playerId: string): void
// Cleanup player

// Primary activation hook
onPrimaryTimerExpired(
  tableId: string,
  playerId: string,
  onExpire: () => void
): boolean
// Called when action timer expires
// Returns true if auto-activated time bank
// If false, primary action timer expired for real

// Manual/auto activation
activate(
  tableId: string,
  playerId: string,
  onExpire: () => void
): boolean
// Start using time bank
// Uses PreciseActionTimer internally
// Returns false if no uses remaining

// Called when player acts
playerActed(tableId: string, playerId: string): void
// Cancel active time bank countdown
// Calculate elapsed time in current use

// Orbit refill hook
onOrbitComplete(tableId: string): void
// Called when small blind passes back to same player
// Add refillSeconds to all players' pools
// Reset usesRemaining to maxUses

// VIP extension (REMOVE FOR SERVER VERSION)
// requestExtension(tableId: string, playerId: string): Promise<boolean>
// Calls VIPService.chargeFor('timebank_extension')

// Query functions
getPlayerBank(tableId: string, playerId: string): PlayerTimeBank | null
hasTimeBank(tableId: string, playerId: string): boolean
getRemainingSeconds(tableId: string, playerId: string): number
getUsesRemaining(tableId: string, playerId: string): number

// Cleanup
dispose(tableId: string): void
// Clear all timers for table
```

**Dependencies:**

- `src/services/VIPService.ts` → REMOVE for server version
- Uses `setTimeout()` internally → REPLACE with `PreciseActionTimer`
- Emits events: `TIME_BANK_ACTIVATED`, `TIME_BANK_EXPIRED`, `TIME_BANK_EXTENDED`

**Server Changes Needed:**

1. Remove VIPService dependency (use HTTP endpoint for extensions instead)
2. Inject `PreciseActionTimer` for countdown
3. Call `onPrimaryTimerExpired()` in ServerTableEngine.handleTurnChange()
4. Call `playerActed()` in ServerTableEngine.handlePlayerAction() when action occurs
5. Call `onOrbitComplete()` in HandController.onOrbitComplete()
6. Call `removePlayer()` on player disconnect or leave

**Migration Action:** MOVE TO SERVER

---

### FILE 2: DisconnectEngine.ts (363 lines)

**Location:** `src/engine/DisconnectEngine.ts`

**Purpose:** Player disconnect detection and auto-action (fold/check/sit-out)

**Config Type:**

```typescript
interface DisconnectConfig {
  disconnectTimeoutSeconds: number; // Time before marking disconnected (default 30)
  maxConsecutiveTimeouts: number; // Timeouts before sit-out (default 3)
  preferCheckOverFold: boolean; // Auto-check instead of auto-fold if possible (default true)
  reconnectGraceSeconds: number; // Grace period after reconnect (default 5)
}
```

**State Type:**

```typescript
interface PlayerConnectionState {
  playerId: string;
  tableId: string;
  isConnected: boolean;
  lastHeartbeat: number; // Timestamp of last heartbeat
  consecutiveTimeouts: number; // Count toward sit-out threshold
  isSittingOut: boolean; // Voluntarily or forced
  disconnectedAt?: number; // Timestamp of disconnection
}
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: DisconnectConfig): void

// Callbacks
onAutoAction(
  tableId: string,
  callback: (tableId, playerId, action) => void
): void
// Register auto-action handler (fold/check)
// Called when timeout expires during player's turn

// Player tracking
registerPlayer(tableId: string, playerId: string): void
unregisterPlayer(tableId: string, playerId: string): void

// Heartbeat from client
heartbeat(tableId: string, playerId: string): void
// Update lastHeartbeat timestamp
// If reconnecting: reset consecutiveTimeouts to 0
// Emit PLAYER_RECONNECTED event
// Cancel pending timeout if exists

// Mark disconnected (from server detection or explicit call)
markDisconnected(tableId: string, playerId: string): void
// Set isConnected = false
// Emit PLAYER_DISCONNECTED event

// During turn change (CRITICAL)
onPlayerTurn(
  tableId: string,
  playerId: string,
  canCheck: boolean
): boolean
// Check if player is disconnected
// If sitting out: AUTO-FOLD immediately, return true
// If disconnected: Start timeout timer (call onAutoAction on expiry)
// If connected: No timeout, return false
// Used in HandController.handleTurnChange()

// Sit-out management
sitOut(
  tableId: string,
  playerId: string,
  reason: 'player_requested' | 'disconnect_timeout' | 'admin_removed'
): void
// Set isSittingOut = true
// Cancel pending disconnect timeout
// Emit PLAYER_SIT_OUT event

sitBack(tableId: string, playerId: string): void
// Set isSittingOut = false
// Reset lastHeartbeat to now
// Emit PLAYER_SAT_BACK event
// Player sits in next hand

// Cancel pending timeout
cancelTimeout(tableId: string, playerId: string): void
// Stop disconnect timer if running

// Query functions
isConnected(tableId: string, playerId: string): boolean
isSittingOut(tableId: string, playerId: string): boolean
getState(tableId: string, playerId: string): PlayerConnectionState | null
getConnectedPlayers(tableId: string): string[]

// Cleanup
dispose(tableId: string): void
```

**Dependencies:**

- Uses `setTimeout()` internally → REPLACE with `PreciseActionTimer`
- Emits events: `PLAYER_DISCONNECTED`, `PLAYER_RECONNECTED`, `PLAYER_SIT_OUT`, `PLAYER_SAT_BACK`

**Server Changes Needed:**

1. Add POST /heartbeat endpoint (client calls every 5 seconds)
2. Inject `PreciseActionTimer` for timeout countdowns
3. Call `registerPlayer()` on seat taken
4. Call `unregisterPlayer()` on player leave
5. Call `heartbeat()` on POST /heartbeat request
6. Call `onPlayerTurn()` in HandController.handleTurnChange() — use result to auto-fold
7. Call `sitOut()` / `sitBack()` via POST /sitout endpoint
8. Set up automatic heartbeat verification (server-side: if no heartbeat in 30s, mark disconnected)

**Migration Action:** MOVE TO SERVER

---

### FILE 3: PreActionEngine.ts (264 lines)

**Location:** `src/engine/PreActionEngine.ts`

**Purpose:** Queued pre-actions (auto-fold, auto-check/fold, auto-check, auto-call, auto-call-any)

**Type Definitions:**

```typescript
type PreActionType =
  | 'auto_fold' // Always fold
  | 'auto_check_fold' // Check if can, else fold
  | 'auto_check' // Check if can, else invalid (wait)
  | 'auto_call' // Call current bet (even if all-in)
  | 'auto_call_any'; // Call any amount (up to stack)

interface PreActionEntry {
  tableId: string;
  playerId: string;
  action: PreActionType;
  maxCallAmount?: number; // For auto_call_any
  createdAt: number;
}

interface PreActionResult {
  valid: boolean;
  action?: PlayerAction;
  wasInvalidated?: boolean; // e.g., auto_check → bet placed → invalidated
}
```

**Public Functions:**

```typescript
// Set pre-action for player
setPreAction(
  tableId: string,
  playerId: string,
  action: PreActionType,
  maxCallAmount?: number
): void
// Store entry in Map<tableId:playerId, entry>
// Emit PRE_ACTION_SET event

// Clear pre-action
clearPreAction(tableId: string, playerId: string): void
// Remove entry
// Emit PRE_ACTION_CLEARED event

// Query
getPreAction(tableId: string, playerId: string): PreActionEntry | null
hasPreAction(tableId: string, playerId: string): boolean

// Execute pre-action during turn change
executePreAction(
  tableId: string,
  playerId: string,
  canCheck: boolean,
  amountToCall: number,
  playerStack: number
): PreActionResult
// Called in HandController.handleTurnChange()
// BEFORE starting action timer
// Returns { valid: true, action: {...} } if pre-action applies
// Returns { valid: false } if cannot execute
// Examples:
//   - auto_fold → always valid, returns { action: 'fold' }
//   - auto_check → valid only if amountToCall = 0, else invalidated
//   - auto_call → converts to call/allin based on stack
//   - auto_call_any → calls min(amountToCall, stack)

// Invalidation hook (called when another player bets)
onBetPlaced(tableId: string, bettingPlayerId: string): void
// Clear auto_check pre-actions for OTHER players
// (auto_check becomes invalid once bet placed)

// Cleanup
clearTable(tableId: string): void
dispose(tableId: string): void
```

**Dependencies:**

- No external dependencies
- Emits events: `PRE_ACTION_SET`, `PRE_ACTION_CLEARED`, `PRE_ACTION_EXECUTED`

**Server Changes Needed:**

1. Add POST /preaction endpoint
2. Call `executePreAction()` in HandController.handleTurnChange() BEFORE starting action timer
3. If `executePreAction()` returns valid result, apply action immediately
4. If returns invalid, start timer and wait for manual action
5. Call `onBetPlaced()` in HandController.handlePlayerAction() after bet is processed

**Migration Action:** MOVE TO SERVER

---

### FILE 4: PreciseActionTimer.ts (233 lines)

**Location:** `src/engine/PreciseActionTimer.ts`

**Purpose:** Deadline-based timer immune to CPU drift (critical for accurate tournament countdowns)

**Key Difference:** Instead of `setTimeout(callback, 5000)`, stores absolute deadline timestamp and checks against `Date.now()` every 100ms.

**State Type:**

```typescript
interface ActionDeadline {
  tableId: string;
  playerId: string;
  deadline: number; // Absolute ms timestamp (Date.now() + durationMs)
  durationMs: number; // Original duration
  startedAt: number; // When timer started
  isPaused: boolean; // Pause state
  pausedRemainingMs?: number; // Time left when paused
  onExpiry?: () => void; // Callback
}
```

**Public Functions:**

```typescript
// Start countdown timer
startTimer(
  tableId: string,
  playerId: string,
  durationMs: number,
  onExpiry?: () => void
): void
// Calculate deadline = Date.now() + durationMs
// Store ActionDeadline in Map
// Emit ACTION_TIMER_STARTED event
// 100ms polling loop starts (if not already running)

// Get remaining time
getRemainingMs(tableId: string, playerId: string): number
// Return Math.max(0, deadline - Date.now())

getRemainingSeconds(tableId: string, playerId: string): number
// Return Math.ceil(getRemainingMs(...) / 1000)

// Check expiry
isExpired(tableId: string, playerId: string): boolean
// Return Date.now() >= deadline

// Get absolute deadline
getDeadline(tableId: string, playerId: string): number
// Return deadline timestamp

// Extend timer
extendTimer(tableId: string, playerId: string, additionalMs: number): void
// deadline += additionalMs
// Emit ACTION_TIMER_EXTENDED event

// Pause/resume (for time bank)
pauseTimer(tableId: string, playerId: string): void
// pausedRemainingMs = getRemainingMs(...)
// isPaused = true
// Emit ACTION_TIMER_PAUSED

resumeTimer(tableId: string, playerId: string): void
// deadline = Date.now() + pausedRemainingMs
// isPaused = false
// pausedRemainingMs = undefined
// Emit ACTION_TIMER_RESUMED

// Cancel timer
cancelTimer(tableId: string, playerId: string): void
// Remove from Map
// Emit ACTION_TIMER_CANCELLED

// Cleanup per table
clearTable(tableId: string): void
// Clear all timers for tableId

// Cleanup all
dispose(): void
// Clear interval, clear all Maps
```

**Polling Mechanism:**

```typescript
private startPolling() {
  this.pollingInterval = setInterval(() => {
    for (const [key, deadline] of this.deadlines.entries()) {
      if (Date.now() >= deadline.deadline && !deadline.isPaused) {
        deadline.onExpiry?.();
        this.deadlines.delete(key);
      }
    }
  }, 100);  // Poll every 100ms
}
```

**Dependencies:**

- `Date.now()` — JavaScript built-in
- No external libraries

**Server Changes Needed:**

1. Port directly to server/src/engine/PreciseActionTimer.ts
2. Replace all `setTimeout()` calls in ServerTableEngine.ts with this
3. Inject into DisconnectEngine, TimeBankEngine, RunItTwiceEngine for their countdowns

**Why Critical:** Under load, `setTimeout` drifts by 500ms-2s. Tournament timers must be precise. Polling-based deadline checking is immune to CPU scheduling.

**Migration Action:** MOVE TO SERVER (HIGHEST PRIORITY)

---

### FILE 5: StateVerifier.ts (275 lines)

**Location:** `src/engine/StateVerifier.ts`

**Purpose:** Game state integrity checking between hands (chip conservation, no negative stacks, etc.)

**Verification Context:**

```typescript
interface VerificationContext {
  tableId: string;
  stage: GameStage;
  players: Player[];
  pot: number;
  boardCards: Card[];
  handNumber: number;
}

enum VerificationErrorCode {
  CHIP_CONSERVATION_FAILED = 'CHIP_CONSERVATION',
  NEGATIVE_STACK = 'NEGATIVE_STACK',
  DUPLICATE_CARDS = 'DUPLICATE_CARDS',
  INVALID_BOARD_STAGE = 'INVALID_BOARD_STAGE',
  INVALID_PLAYER_COUNT = 'INVALID_PLAYER_COUNT',
  POT_INTEGRITY_FAILED = 'POT_INTEGRITY',
  UNKNOWN = 'UNKNOWN',
}

interface VerificationResult {
  passed: boolean;
  errors: { code: VerificationErrorCode; details: string }[];
}
```

**Checks (6 total):**

1. **Chip Conservation:** sum(allStacks) + pot + totalRaked = originalTotal (tracked at hand start)
2. **No Negative Stacks:** All stacks >= 0
3. **No Duplicate Cards:** Each card appears in 0 or 1 location (hand or board)
4. **Community Cards Match Stage:** Preflop=0, Flop=3, Turn=4, River=5
5. **Active Player Count:** At least 2 players with chip > 0
6. **Pot Sanity:** pot = sum of all bets this hand, no phantom chips

**Public Functions:**

```typescript
// Record starting chips at hand begin
recordInitialChipTotal(tableId: string, players: Player[]): void
// Sum all stacks
// Store in Map<tableId, total>
// Emit STATE_VERIFIER_INITIALIZED

// Adjust for rake (after rake calculated)
deductRake(tableId: string, rakeAmount: number): void
// Get stored total
// Subtract rakeAmount
// Store adjusted total
// Emit STATE_VERIFIER_RAKE_RECORDED

// Run all 6 checks
verify(context: VerificationContext): VerificationResult
// Run all 6 checks in order
// Collect errors
// Emit STATE_INTEGRITY_VIOLATION if any errors
// Return VerificationResult

// Cleanup
clearTable(tableId: string): void
dispose(): void
```

**Event:**

```typescript
// Emitted on failure
STATE_INTEGRITY_VIOLATION: {
  tableId: string,
  errors: VerificationResult['errors']
}
```

**Dependencies:**

- No external dependencies
- Must be called at specific points in HandController flow

**Server Changes Needed:**

1. Call `recordInitialChipTotal()` at start of HandController.dealHand()
2. Call `deductRake()` after rake calculation in HandController.distributeWinnings()
3. Call `verify()` BEFORE moveToNextHand()
4. On verification failure: stop hand progression, emit error event, trigger admin alert

**Migration Action:** MOVE TO SERVER

---

### FILE 6: ServerActionValidator.ts (323 lines)

**Location:** `src/engine/ServerActionValidator.ts`

**Purpose:** Full action validation with turn order, timing, duplicate suppression

**Request Type:**

```typescript
interface ActionRequest {
  tableId: string;
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  amount?: number;
}
```

**Validation Context:**

```typescript
interface ValidationContext {
  currentPlayerId: string; // Whose turn is it?
  stage: GameStage;
  currentBet: number; // Highest bet this round
  playerBet: number; // This player's total bet this round
  playerStack: number; // Remaining chips
  bigBlind: number;
  minRaise: number; // Min legal raise
  pot: number;
  canCheck: boolean; // Amount to call === 0
  actionDeadline: number; // Absolute ms timestamp (from PreciseActionTimer)
  playerActedThisRound: boolean; // Already acted?
  isAllIn: boolean; // Player all-in already?
  isFolded: boolean; // Already folded?
  numActivePlayers: number;
  lastActionTime?: number; // Timestamp of last action (for duplicate suppression)
}

interface ValidationResult {
  valid: boolean;
  errorCode?: ActionValidationErrorCode;
  errorMessage?: string;
  normalizedAction?: PlayerAction; // For all-in conversions
}

enum ActionValidationErrorCode {
  NOT_YOUR_TURN = 'NOT_YOUR_TURN',
  ALREADY_ACTED = 'ALREADY_ACTED',
  ALREADY_FOLDED = 'ALREADY_FOLDED',
  ALREADY_ALL_IN = 'ALREADY_ALL_IN',
  ACTION_EXPIRED = 'ACTION_EXPIRED',
  INVALID_ACTION = 'INVALID_ACTION',
  INSUFFICIENT_STACK = 'INSUFFICIENT_STACK',
  BELOW_MIN_RAISE = 'BELOW_MIN_RAISE',
  ABOVE_MAX_RAISE = 'ABOVE_MAX_RAISE',
  CANNOT_CHECK = 'CANNOT_CHECK',
  NOTHING_TO_CALL = 'NOTHING_TO_CALL',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
}
```

**Validation Flow (5 Steps):**

```
Step 1: Turn Order
  if (playerId !== currentPlayerId) → NOT_YOUR_TURN

Step 2: Player State
  if (already acted) → ALREADY_ACTED
  if (folded) → ALREADY_FOLDED
  if (all-in and not heads-up) → ALREADY_ALL_IN

Step 3: Duplicate Suppression
  if (lastActionTime exists AND now - lastActionTime < 2000ms) → ALREADY_ACTED
  (grace period to avoid double-submit)

Step 4: Timing
  if (now > actionDeadline AND no pre-action to execute) → ACTION_EXPIRED

Step 5: Action-Specific Validation
  validateFold(amount, context)
  validateCheck(amount, context)
  validateCall(amount, context)
  validateBet(amount, context)
  validateRaise(amount, context)
  validateAllIn(amount, context)
```

**Public Functions:**

```typescript
// Main validation entry
validate(
  request: ActionRequest,
  context: ValidationContext
): ValidationResult
// Run 5-step validation
// Return { valid: true/false, errorCode?, normalizedAction? }

// Per-action validators
private validateFold(amount: number | undefined, context): ValidationResult
// Fold always valid (cannot fold if already folded or all-in)
// amount must be undefined

private validateCheck(amount: number | undefined, context): ValidationResult
// Valid only if amount === 0 (nothing to call)
// Invalid if must call amount > 0

private validateCall(amount: number | undefined, context): ValidationResult
// amount must be undefined (server calculates toCall)
// toCall = currentBet - playerBet
// If toCall > stack: convert to all-in
// Return { valid: true, normalizedAction: {action: 'allin', amount: stack} }

private validateBet(amount: number | undefined, context): ValidationResult
// Valid only on first aggression (currentBet === 0)
// amount must be >= bigBlind
// amount must be <= stack
// If amount === stack: convert to all-in
// If amount === 0 and no currentBet: INVALID

private validateRaise(amount: number | undefined, context): ValidationResult
// Valid only if there's a bet to raise
// amount must be >= minRaise
// amount must be <= stack
// Special case: short all-in raise (if amount < minRaise but all-in) → valid
// Example: stack=2BB, minRaise=5BB, amount=2BB → valid as all-in
// If amount === stack: convert to all-in

private validateAllIn(amount: number | undefined, context): ValidationResult
// amount must be defined and === stack
// Always valid if stack > 0 and player not already all-in
```

**Special Cases:**

1. **All-In Aggression:** Raise with <minRaise is valid if all-in

   ```
   Example: Stack=200, BB=100, minRaise=200
   Player raises to 200 → valid (all-in), not below min
   ```

2. **Short All-In:** Bet/raise <1BB all-in is valid

   ```
   Example: Stack=50, BB=100, can't bet full blind but can go all-in
   ```

3. **Call as All-In:** If toCall > stack, convert call → all-in
   ```
   Example: toCall=1000, stack=800 → normalizedAction: allin for 800
   ```

**Dependencies:**

- No external dependencies
- Called from ServerTableEngine.handlePlayerAction()

**Server Changes Needed:**

1. Replace basic validateAction() with this richer validator
2. Use error codes in HTTP response (not auto-fold)
3. Return specific error message to client for UI feedback

**Migration Action:** MOVE TO SERVER

---

### FILE 7: StraddleEngine.ts (246 lines)

**Location:** `src/engine/StraddleEngine.ts`

**Purpose:** UTG straddle and Mississippi straddle support

**Config Type:**

```typescript
interface StraddleConfig {
  enabled: boolean;
  mississippiEnabled: boolean; // Allow straddles after flop
  maxStraddles: number; // Max straddles per hand (default 2)
  straddleMultiplier: number; // Straddle = multiplier × BB (default 2)
}

interface StraddlePost {
  playerId: string;
  seatNumber: number;
  amount: number; // Actual straddle amount
  postedAt: number;
}

interface StraddleResult {
  posted: StraddlePost[];
  straddles: number; // Total straddle posts
  adjustedBigBlind: number; // BB after straddles (for min raise calc)
  firstToAct: string; // UTG+straddles
}
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: StraddleConfig): void

// Auto-straddle toggle
toggleAutoStraddle(tableId: string, playerId: string, enabled: boolean): void
// Store in Set<playerId> for table
// Applied NEXT hand

isAutoStraddleOn(tableId: string, playerId: string): boolean

// Process all straddles at hand start
processStraddles(
  tableId: string,
  bigBlind: number,
  seatOrder: string[],  // Seat numbers of players in order
  playerStacks: Map<string, number>  // Remaining stacks
): StraddleResult
// Called in dealHand() AFTER posting blinds
// Look for enrolled players in UTG position
// Post straddles up to maxStraddles limit
// Update betting order (first to act moves past straddles)
// Return StraddleResult

// Manual straddle (player can post manually)
postManualStraddle(
  tableId: string,
  playerId: string,
  seatNumber: number,
  bigBlind: number,
  stack: number
): StraddlePost | null
// Called from UI (toggle button)
// Post straddle if enabled and room for more
// Return StraddlePost or null

// Query
getState(tableId: string): {enabled: boolean, enrolled: Set<string>, straddles: StraddlePost[]}
dispose(tableId: string): void
```

**Impact on Betting:**

- Straddle is "bet to act on" → first to act is UTG + (straddle count)
- Min raise = BB + all straddles
- Straddle amount = straddleMultiplier × BB

**Client Current Implementation (REMOVE):**

- Lines 274-291 in client HandController: Injects straddles after blinds but BEFORE first-to-act calculation
- Incorrect: First to act doesn't move past straddle
- Server version must fix this

**Dependencies:**

- No external dependencies
- Emits events: `STRADDLE_POSTED`, `STRADDLE_REJECTED`

**Server Changes Needed:**

1. Add POST /straddle endpoint
2. Call `processStraddles()` in HandController.dealHand() AFTER postBlinds()
3. Use `StraddleResult.firstToAct` to set initial turn
4. Use `StraddleResult.adjustedBigBlind` in ServerActionValidator for min raise calculation
5. Deduct straddle amounts from stacks (already in processStraddles)

**Migration Action:** MOVE TO SERVER

---

### FILE 8: RunItTwiceEngine.ts (315 lines)

**Location:** `src/engine/RunItTwiceEngine.ts`

**Purpose:** Dual/triple board dealing when all players are all-in (run-it-twice/thrice)

**Config Type:**

```typescript
interface RITConfig {
  enabled: boolean;
  autoDeclineTimeout: number; // Seconds before auto-decline offer (default 10)
  maxRuns: 2 | 3; // Allow 2 or 3 boards (default 2)
}

type RITStatus = 'idle' | 'offered' | 'accepted' | 'declined' | 'resolved';

interface RITState {
  status: RITStatus;
  handId: string;
  offeredBy: string; // Player proposing RIT
  offeredTo: string; // Other all-in player
  acceptedBy: Set<string>; // Who accepted (if both accept → status='accepted')
  pot: number; // Amount to distribute
  board1: Card[];
  board2?: Card[];
  board3?: Card[];
  winners?: Map<string, number>; // Result: who won how much on each board
  createdAt: number;
}

interface RITResult {
  board1: Card[];
  board2: Card[];
  board3?: Card[];
  winners: string[]; // Winners per board
  distribution: Map<string, number>; // playerId → chips
}
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: RITConfig): void

isEnabled(tableId: string): boolean

// Offer flow
offer(
  tableId: string,
  handId: string,
  offeredBy: string,
  offeredTo: string,
  pot: number
): void
// Create RITState with status='offered'
// Set auto-decline timeout
// Emit RIT_OFFERED event (client shows UI)

accept(tableId: string, playerId: string): boolean
// Add playerId to acceptedBy
// If both players accepted: status='accepted', return true
// Else: return false (waiting for other player)

decline(tableId: string, playerId: string): void
// status='declined'
// Emit RIT_DECLINED event

// Dual board dealing (called when both accept)
dealDualBoards(
  tableId: string,
  remainingDeck: Card[],
  existingBoard: Card[]
): RITResult | null
// Deal 2 additional independent boards
// Each board = existing community cards + different runout
// Example: Flop dealt, 2 cards remaining → deal 2 different turn/river pairs
// Return RITResult with board1/board2/board3 and winners per board

// Resolve and distribute chips
resolve(
  tableId: string,
  board1Winner: string,
  board2Winner: string,
  board3Winner?: string
): Map<string, number>
// Split pot evenly per board
// board1 winner gets 50% (or 33% if 3-way)
// board2 winner gets 50% (or 33%)
// board3 winner gets 33% (if 3-way)
// status='resolved'
// Return chip distribution Map
// Emit RIT_RESOLVED event

// Query
isActive(tableId: string): boolean
getState(tableId: string): RITState | null
dispose(tableId: string): void
```

**Integration with HandController:**

```
Normal all-in flow:
  handlePlayerAction() → last player acts
    ↓
  Check: all players all-in or folded?
    ↓
  YES → offer RIT to all-in players
    ↓
  Pause action timer (pauseTimer)
    ↓
  Wait for accept/decline responses
    ↓
  If both accept: dealDualBoards() → show boards → resolve()
    ↓
  If decline: resumeTimer() → runOutCommunityCards() normally
```

**Client Current Implementation (REMOVE):**

- Lines 614-630: ALL_IN_RUNOUT_PENDING event
- Lines 652-715: resumeRunout/resolveRunItTwice handlers
- These must move to server

**Dependencies:**

- Uses PreciseActionTimer.pauseTimer/resumeTimer
- Emits events: `RIT_OFFERED`, `RIT_ACCEPTED`, `RIT_DECLINED`, `RIT_RESOLVED`

**Server Changes Needed:**

1. Add POST /rit endpoint
2. Call `offer()` in HandController when all-in
3. Call `pauseTimer()` on all-in player while waiting for responses
4. Call `dealDualBoards()` when both accept
5. Call `resolve()` to distribute chips
6. Call `resumeTimer()` if RIT declined → resume normal runout

**Migration Action:** MOVE TO SERVER

---

### FILE 9: InsuranceEngine.ts (290 lines)

**Location:** `src/engine/InsuranceEngine.ts`

**Purpose:** All-in equity insurance with Monte Carlo calculation

**Config Type:**

```typescript
interface InsuranceConfig {
  enabled: boolean;
  houseMargin: number; // Multiplier on premium (default 1.05)
  maxInsurablePercent: number; // % of pot that can be insured (default 100)
  offerTimeoutSeconds: number; // Offer expires after N seconds (default 15)
  minPotForInsurance: number; // Minimum pot to offer insurance (default 0)
  equityIterations: number; // MC iterations for equity calc (default 5000)
}

interface InsuranceOffer {
  offerId: string;
  handId: string;
  playerId: string; // All-in player
  equity: number; // Probability of winning (0-1)
  insuredAmount: number; // Amount to insure (can be partial)
  premium: number; // Cost = (1 - equity) × amount × margin
  status: 'offered' | 'accepted' | 'declined' | 'settled';
  response?: boolean; // true = accepted, false = declined
  createdAt: number;
}

interface InsuranceSettlement {
  offerId: string;
  playerId: string;
  won: boolean; // Did they win the hand?
  payout: number; // Insurance payout (if lost)
}
```

**Premium Calculation:**

```
equity = monteCarloEquity(playerCards, boardCards, numOpponents, 5000)
insuredAmount = min(pot × maxInsurablePercent, playerStack)
premium = (1 - equity) × insuredAmount × houseMargin
payout (if lost) = insuredAmount
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: InsuranceConfig): void

isEnabled(tableId: string): boolean

// Create offers (called when players all-in)
createOffers(
  tableId: string,
  handId: string,
  allInPlayers: {
    playerId: string,
    cards: Card[],
    stack: number
  }[],
  board: Card[],
  pot: number,
  deckRemaining: Card[]
): InsuranceOffer[]
// For each all-in player:
//   - Calculate equity using monteCarloEquity()
//   - Calculate premium
//   - Create InsuranceOffer
// Emit INSURANCE_OFFERED event (client shows UI)
// Return offers[]

// Player response
accept(tableId: string, offerId: string): void
// status='accepted'
// Deduct premium from player stack
// Emit INSURANCE_ACCEPTED

decline(tableId: string, offerId: string): void
// status='declined'
// Emit INSURANCE_DECLINED

// Settle after hand
settle(
  tableId: string,
  winnerId: string
): InsuranceSettlement[]
// For each accepted insurance offer:
//   - If player lost hand: payout insuredAmount
//   - If player won: no payout (premium lost)
// status='settled'
// Return settlements[]
// Emit INSURANCE_SETTLED

// Query
allResponded(tableId: string, handId: string): boolean
getOffers(tableId: string, handId: string): InsuranceOffer[]
dispose(tableId: string): void
```

**Dependencies:**

- Uses `MonteCarloEquity.monteCarloEquity()` for equity calculation
- Uses PreciseActionTimer for offer timeout
- Emits events: `INSURANCE_OFFERED`, `INSURANCE_ACCEPTED`, `INSURANCE_DECLINED`, `INSURANCE_SETTLED`

**Server Changes Needed:**

1. Port MonteCarloEquity to server
2. Add POST /insurance endpoint
3. Call `createOffers()` when players all-in
4. Pause action timer while waiting for insurance decisions
5. Call `settle()` after hand resolves
6. Handle premium deductions from stacks (via AtomicStackService)

**Migration Action:** MOVE TO SERVER (requires MonteCarloEquity)

---

### FILE 10: AtomicStackService.ts (235 lines)

**Location:** `src/engine/AtomicStackService.ts`

**Purpose:** Race-condition-proof stack operations with versioned optimistic locking

**State Type:**

```typescript
interface StackVersion {
  playerId: string;
  tableId: string;
  stack: number;
  version: number; // Incremented on each change
}

interface AtomicResult {
  success: boolean;
  reason?: 'version_mismatch' | 'insufficient_funds';
  newStack?: number;
  newVersion?: number;
}

interface StackSettlement {
  playerId: string;
  amount: number; // +/- chips
}

interface BatchSettlementResult {
  success: boolean;
  reason?: string;
  settlements: StackSettlement[];
}
```

**Public Functions:**

```typescript
// Get current stack with version
getStackWithVersion(tableId: string, userId: string): StackVersion
// Return { stack, version }

// Initialize new player
initializeStack(tableId: string, userId: string, stack: number): void
// version = 0

// Atomic debit (must succeed)
atomicDebit(
  tableId: string,
  userId: string,
  amount: number,
  expectedVersion: number
): AtomicResult
// Check: version === expectedVersion (optimistic lock)
// If mismatch: return {success: false, reason: 'version_mismatch'}
// Check: stack >= amount
// If insufficient: return {success: false, reason: 'insufficient_funds'}
// Debit: stack -= amount, version++
// Emit STACK_RACE_DETECTED if version mismatch
// Return {success: true, newStack, newVersion}

// Atomic credit (always succeeds)
atomicCredit(tableId: string, userId: string, amount: number): AtomicResult
// Credit: stack += amount, version++
// Never fails (ignores expectedVersion)
// Return {success: true, newStack, newVersion}

// Atomic batch settle (fail-safe all or nothing)
atomicSettle(
  tableId: string,
  settlements: StackSettlement[]
): BatchSettlementResult
// Phase 1: Validate all debits
//   For each settlement with amount < 0:
//     Check expectedVersion (stored from getStackWithVersion before any changes)
//     If mismatch or insufficient: ABORT, return failure
// Phase 2: Apply all atomically
//   If Phase 1 passed: apply all settlements
//   Increment all versions
// Return {success: boolean, settlements: applied}
// Emit STACK_RACE_DETECTED on failure

// Query
getTableStacks(tableId: string): Map<string, number>
// Return all stacks for table

// Cleanup
clearTable(tableId: string): void
dispose(): void
```

**Why Versioning?**

```
Without versioning (WRONG):
  Player A reads stack = 1000
  Player B reads stack = 1000
  Player A deducts 400 → stack = 600
  Player B deducts 600 → stack = 400  ← LOST 200 CHIPS
  Final stack = 400 (should be 0)

With versioning (CORRECT):
  Player A reads stack = 1000, version = 5
  Player B reads stack = 1000, version = 5
  Player A atomicDebit(400, version=5) → success, version=6
  Player B atomicDebit(600, version=5) → FAIL (version=6 expected)
  Player B re-reads: stack=600, version=6
  Player B atomicDebit(600, version=6) → success, version=7
  Final stack = 0 (correct)
```

**Dependencies:**

- No external dependencies
- Emits events: `STACK_RACE_DETECTED`

**Server Changes Needed:**

1. Port to server/src/engine/AtomicStackService.ts
2. Use in HandController.distributeWinnings() for all stack updates
3. Every debit call must use atomicDebit() with current version
4. Use atomicSettle() for multiple-player distributions (rake, winnings, etc.)

**Migration Action:** MOVE TO SERVER

---

### FILE 11: MixedGameEngine.ts (229 lines)

**Location:** `src/engine/MixedGameEngine.ts`

**Purpose:** Automatic game variant rotation (HORSE, custom sequences)

**Type Definitions:**

```typescript
type GameVariant = 'holdem' | 'omaha' | 'omaha5' | 'razz' | '7stud' | 'badugi' | '2-7' | 'horse';

interface GameVariantInfo {
  name: GameVariant;
  holeCards: number; // 2 for holdem, 4 for omaha, 5 for omaha5, etc.
  communityCards: number; // 0 for stud games, 5 for flop games
  evaluationMethod: string; // 'hilo' or 'high'
}

interface MixedGameConfig {
  presetName?: string; // 'HORSE', 'HOLDEM_OMAHA', etc.
  variants: GameVariant[];
  handsPerVariant: number; // Rotate every N hands
  rotatePerOrbit: boolean; // Rotate on button pass instead of hand count
}

enum MixedGamePreset {
  HORSE = ['holdem', 'omaha', 'razz', '7stud', 'holdem'],
  HOLDEM_OMAHA = ['holdem', 'omaha', 'holdem', 'omaha'],
  HOLDEM_PLO5 = ['holdem', 'omaha5', 'holdem', 'omaha5'],
  DOUBLE_BOARD_ROTATION = ['holdem', 'holdem_double_board'],
  OMAHA_VARIANTS = ['omaha', 'omaha5', 'omaha_hilo'],
}
```

**Public Functions:**

```typescript
// Configuration
configure(tableId: string, config: MixedGameConfig): void

configurePreset(
  tableId: string,
  presetName: keyof typeof MixedGamePreset,
  handsPerVariant: number,
  rotatePerOrbit: boolean
): void
// shortcuts for HORSE, HOLDEM_OMAHA, etc.

// Get current variant
getCurrentVariant(tableId: string): GameVariant | null
// Return current variant for this hand

// Called after hand completes
onHandComplete(tableId: string, playerCount: number): GameVariant | null
// Increment hand counter (if rotatePerOrbit=false)
// Check if rotation threshold reached
// If yes: rotate to next variant, emit GAME_ROTATED
// Return new variant (or current if no rotation)

// Manual rotation (admin)
forceRotate(tableId: string): GameVariant | null

// Query
getState(tableId: string): {current: GameVariant, variants: GameVariant[], handsUntil: number}
isActive(tableId: string): boolean
getSchedule(tableId: string): GameVariant[]
getHandsUntilRotation(tableId: string): number

// Cleanup
dispose(tableId: string): void
```

**Integration with HandController:**

```
dealHand():
  variant = getCurrentVariant(tableId)
  if (variant === 'omaha') {
    holeCardsPerPlayer = 4
  } else if (variant === 'holdem') {
    holeCardsPerPlayer = 2
  }
  // Deal accordingly

distributeWinnings():
  // normal
  onHandComplete():
    newVariant = engine.onHandComplete(tableId, numPlayers)
    if (newVariant !== oldVariant) {
      broadcastGameRotated(newVariant)
    }
```

**Dependencies:**

- No external dependencies
- Emits events: `GAME_ROTATED`

**Server Changes Needed:**

1. Port to server/src/engine/MixedGameEngine.ts
2. Call `getCurrentVariant()` at dealHand() to determine hole card count
3. Call `onHandComplete()` at end of hand to check for rotation
4. Use variant to determine card evaluation method

**Migration Action:** MOVE TO SERVER

---

### FILE 12: ChipRaceEngine.ts (182 lines) — TOURNAMENT ONLY

**Location:** `src/engine/ChipRaceEngine.ts`

**Purpose:** Tournament chip denomination removal via card-deal lottery

**Function:**

```typescript
executeChipRace(
  tournamentId: string,
  playerStacks: Map<string, number>,
  oldDenomination: number,
  newDenomination: number
): ChipRaceResult
```

**Algorithm:**

```
1. For each player:
   - Fractional chips = stack % newDenomination
   - Convert to count of old-denom chips
2. Distribute lottery tickets (fractional count)
3. Deal cards to each player (lottery)
4. Highest card wins (no one eliminated)
5. Convert all to new denomination
```

**Dependencies:**

- Uses CryptoRandom for fair card dealing

**Server Changes Needed:**

1. Port for tournament support
2. Call during tournament chip denomination change

**Migration Action:** MOVE TO SERVER (Tier 3 — Tournament only, not blocking)

---

### FILE 13: RakebackEngine.ts (300 lines)

**Location:** `src/engine/RakebackEngine.ts`

**Purpose:** Per-player rake contribution tracking + weighted rakeback tiers

**Tier Structure:**

```
Bronze:   5% rakeback
Silver:   10% rakeback
Gold:     15% rakeback
Platinum: 20% rakeback
Diamond:  25% rakeback
Elite:    30% rakeback
```

**Calculation (Weighted Contributed Method):**

```
Player's share of rake = (player's contribution to pot) / (total pot) × total rake

Example:
  Pot built up: A contributes $100, B contributes $150 = $250 pot
  Rake: $25
  A's rake share: (100/250) × 25 = $10
  B's rake share: (150/250) × 25 = $15
```

**Functions:**

```typescript
// Record hand rake for tracking
recordHandRake(
  tableId: string,
  handId: string,
  contributions: Map<string, number>,  // playerId → amount contributed
  rakeCollected: number
): void
// For each player:
//   rakeShare = (contribution / totalContribution) × rakeCollected
//   totalRake[playerId] += rakeShare

// Settle rakeback (daily/weekly)
settleRakeback(
  clubId: string,
  periodStart: number,
  periodEnd: number
): RakebackSettlement[]
// For each player in club:
//   totalRake = sum of hand rakes in period
//   rakebakRate = tierRate(vipLevel)
//   payout = totalRake × rakebackRate
//   deductFromPlayer? → or credit?
// Persist to rakeback_periods table via Supabase
// Emit RAKEBACK_SETTLED
```

**Server Changes Needed:**

1. Port to server/src/engine/RakebackEngine.ts
2. Call `recordHandRake()` in HandController.postHandTasks()
3. Set up cron job for `settleRakeback()` (daily or weekly)
4. Integrate with VIP level system (read from players table)

**Migration Action:** MOVE TO SERVER

---

### FILE 14: CryptoRandom.ts (92 lines)

**Location:** `src/engine/CryptoRandom.ts`

**Purpose:** Crypto-secure random for fair dealing and shuffling

**Functions:**

```typescript
secureRandomInt(exclusiveMax: number): number
// Return random int [0, exclusiveMax)
// Browser: uses crypto.getRandomValues(Uint32Array)
// Node: uses crypto.randomInt()

secureRandom(): number
// Return random float [0, 1)

secureShuffle<T>(array: T[]): T[]
// Fisher-Yates shuffle with crypto randomness
// Return shuffled copy
```

**Server Status:**

- Server already has `Deck.shuffle()` in `PokerEngine.ts` using `crypto.getRandomValues()`
- Can either reuse existing code or copy this utility

**Server Changes Needed:**

1. If reusing: no changes
2. If copying: duplicate to server/src/engine/CryptoRandom.ts
3. Use in Deck.shuffle() and InsuranceEngine.monteCarloEquity()

**Migration Action:** REUSE EXISTING (or copy if easier)

---

### FILE 15: FlashPoolEngine.ts (433 lines) — FUTURE FEATURE

**Location:** `src/engine/FlashPoolEngine.ts`

**Purpose:** Fast-fold (Zoom/Rush/Snap) pool system

**Scope:** Manages shared player pool across multiple tables, instant reassignment on fold

**Status:** Not blocking for core game launch

**Migration Action:** PORT WHEN FAST-FOLD FEATURE ADDED (Tier 3)

---

### FILE 16: EngineTelemetry.ts (245 lines)

**Location:** `src/engine/EngineTelemetry.ts`

**Purpose:** Production observability — hands/hour, avg timing, cache hits, timer utilization

**Metrics Tracked:**

- Hands played / hour
- Avg action time (turntime)
- Timer cache hit rate
- Validation error rates by code
- Broadcast latency
- State verification failures

**Auto-emit:** Every 60 seconds

**Server Changes Needed:**

1. Port for production monitoring
2. Emit to logging service (e.g., Datadog, LogRocket)
3. Set up alerts on error rate thresholds

**Migration Action:** MOVE TO SERVER (Lower priority, valuable for monitoring)

---

### FILE 17: TableBalancer.ts (238 lines) — TOURNAMENT ONLY

**Purpose:** MTT table balancing — minimize player movement

**Functions:**

```typescript
evaluateBalance(tables: Table[], balanceTarget: number): boolean
shouldRebalance(tables: Table[]): boolean  // gap > 1
calculateMoves(tables: Table[], balanceTarget: number): Move[]
shouldBreakTable(table: Table): boolean
breakTable(table: Table): Player[]  // players to redistribute
```

**Migration Action:** PORT WHEN TOURNAMENT SUPPORT ADDED (Tier 3)

---

### FILE 18: TableBreakEngine.ts (264 lines) — TOURNAMENT ONLY

**Purpose:** Tournament table breaking with countdown warning

**Flow:**

1. Check if table should break (all-but-one players busted)
2. Initiate break: 30s warning
3. Move remaining players to other tables
4. Seat lottery for positioning

**Migration Action:** PORT WHEN TOURNAMENT SUPPORT ADDED (Tier 3)

---

### FILE 19: OFCPineappleEngine.ts (690 lines) — SEPARATE GAME MODE

**Purpose:** Open Face Chinese Poker game logic

**Includes:**

- Full deck/dealing/placement
- Evaluation (high hand, middle hand, low hand)
- Foul detection
- Royalties calculation
- Fantasyland mode

**Migration Action:** PORT WHEN OFC FEATURE ADDED (Tier 3)

---

### FILE 20: OFCDealingOrchestrator.ts (304 lines) — SEPARATE GAME MODE

**Purpose:** OFC dealing loop driver

**Migration Action:** PORT WITH OFCPineappleEngine (Tier 3)

---

### FILE 21: MonteCarloEquity.ts (127 lines)

**Location:** `src/engine/MonteCarloEquity.ts`

**Purpose:** Equity calculator using Monte Carlo simulation (used by InsuranceEngine)

```typescript
monteCarloEquity(
  heroCards: Card[],
  boardCards: Card[],
  numOpponents: number,
  iterations: number
): number  // equity percentage (0-100)
```

**Algorithm:**

```
for (let i = 0; i < iterations; i++) {
  Deal random cards to opponents
  Deal random runout
  Evaluate all hands
  If hero wins: equity++
}
return (equity / iterations) × 100
```

**Dependencies:**

- Uses `evaluateHand()` from PokerEngine (already on server)
- Uses `secureShuffle()` from CryptoRandom

**Server Changes Needed:**

1. Port to server/src/engine/MonteCarloEquity.ts
2. Use in InsuranceEngine.createOffers()

**Migration Action:** MOVE TO SERVER (required for insurance)

---

### FILE 22: HandReplayEngine.ts (361 lines) — KEEP ON CLIENT

**Location:** `src/engine/HandReplayEngine.ts`

**Purpose:** Step-by-step hand history replayer with playback controls (UI feature)

**Functionality:**

- Load hand history from hand_history table
- Reconstruct game state from action list
- Playback controls: play, pause, rewind, fast-forward
- Show cards as they're revealed

**Why Client Only:**

- Pure UI state (replay position, playback speed)
- Reads from immutable hand_history (no writes)
- No game logic — just visualization
- No real-time requirements

**Server Changes Needed:**

1. Persist hand_history table (already done?)
2. Endpoint to query: GET /handhistory/:handId
3. Return: {actions[], finalState, outcome}

**Migration Action:** KEEP ON CLIENT (No server changes needed)

---

## SECTION 6: SERVER EXISTING CODE GAPS

### HandController.ts (server/src/engine/HandController.ts — 553 lines)

**Missing Features (vs Client's 917 lines):**

| Gap                                | Client Lines | Current Server | Impact                                |
| ---------------------------------- | ------------ | -------------- | ------------------------------------- |
| Big Blind Ante (BBA)               | 252-271      | Missing        | BBA games unplayable                  |
| Straddle injection                 | 274-291      | Missing        | Straddles don't post                  |
| Bomb pot preflop skip              | 191-208      | Missing        | Bomb pot doesn't skip preflop betting |
| ALL_IN_RUNOUT_PENDING event        | 614-630      | Missing        | RIT not supported                     |
| Raise clamp fix (ENG-01)           | 394-398      | Missing        | Can over-raise in edge cases          |
| No-winners safety guard            | 755-781      | Missing        | Crash if no winner detected           |
| resumeRunout()                     | 652-715      | Missing        | Can't pause for insurance             |
| resolveRunItTwice()                | 652-715      | Missing        | RIT settlement broken                 |
| Correct aggression tracking        | ✓            | Incorrect      | Min-raise calc wrong for all-ins      |
| runningCurrentBet for short all-in | 498-511      | Missing        | Short all-in detection broken         |

**PRIORITY UPGRADES:**

1. Add BBA support
2. Add straddle processing
3. Add bomb pot skip logic
4. Fix raise clamping (ENG-01)
5. Add no-winners guard
6. Fix aggression tracking

---

### ServerTableEngine.ts (server/src/engine/ServerTableEngine.ts — 990 lines)

**Critical Gaps:**

| Issue                              | Line    | Current                    | Required                         | Blocker        |
| ---------------------------------- | ------- | -------------------------- | -------------------------------- | -------------- |
| Cards leaked to all players        | 792     | `cards: p.cards ?? []`     | Scrub for non-requesting players | **BLOCKER #2** |
| Auto-fold on error                 | 351-353 | Auto-folds                 | Return error response            | **BLOCKER #3** |
| Timer always auto-folds            | 199-205 | `if(!canCheck) fold()`     | Auto-check if toCall=0           | **BLOCKER #3** |
| setTimeout not deadline-based      | 192     | `setTimeout(...)`          | Use PreciseActionTimer           | Drift issue    |
| No time bank pool model            | N/A     | Single use per turn        | Pool model with refill           | Feature gap    |
| No orbit refill                    | N/A     | Missing                    | onOrbitComplete hook             | Feature gap    |
| No disconnect detection            | N/A     | Missing                    | DisconnectEngine                 | Feature gap    |
| No pre-action system               | N/A     | Missing                    | PreActionEngine                  | Feature gap    |
| No state verification              | N/A     | Missing                    | StateVerifier                    | Data integrity |
| No action validation beyond basics | N/A     | calculateBettingState only | ServerActionValidator            | Security gap   |
| No bomb pot detection              | N/A     | Missing                    | Check for preflop skip           | Feature gap    |

**PRIORITY FIXES:**

1. Scrub cards in broadcast (BLOCKER #2)
2. Return error instead of auto-fold (BLOCKER #3)
3. Auto-check when toCall=0 (BLOCKER #3)
4. Replace setTimeout with PreciseActionTimer
5. Add bomb pot detection

---

### HTTP Endpoints (server/src/index.ts)

**Security Gaps:**

| Endpoint                      | Current         | Issue              | Fix                        |
| ----------------------------- | --------------- | ------------------ | -------------------------- |
| POST /action                  | No auth         | Trust userId param | Add JWT validation         |
| POST /action                  | No auth         | No rate limiting   | Add 1 req/100ms per player |
| POST /timebank                | No auth         | Trust userId param | Add JWT validation         |
| GET /actions/:tableId/:userId | No auth         | Trust userId param | Add JWT validation         |
| All                           | Fire-and-forget | No error response  | Return {success, error}    |

**PHASE 3 Additions:**

```
Missing endpoints:
  POST /preaction
  POST /heartbeat
  POST /sitout
  POST /rit
  POST /insurance
  POST /straddle
  POST /showhand
  GET /state/:tableId
```

---

### Server Types (server/src/types.ts)

**HandConfig Missing Fields:**

```typescript
// Current
interface HandConfig {
  blinds: BlindStructure,
  tableSize: number,
  ...
}

// Required additions
interface HandConfig {
  // Existing...

  // Missing:
  bigBlindAnte?: boolean;     // For BBA games
  straddles?: StraddleConfig; // UTG straddles
  ritEnabled?: boolean;       // Run-it-twice
  insuranceEnabled?: boolean; // All-in insurance
  mixedGameVariant?: GameVariant; // Current game variant
}
```

**HandEvent Missing Variants:**

```typescript
// Current
type HandEvent =
  | {type: 'HAND_STARTED', ...}
  | {type: 'ACTION_PERFORMED', ...}
  | {type: 'HAND_COMPLETE', ...}
  | ...

// Required additions
type HandEvent =
  | {type: 'ALL_IN_RUNOUT_PENDING', ...}  // New
  | {type: 'STRADDLE_POSTED', ...}        // New
  | {type: 'INSURANCE_OFFERED', ...}      // New
  | ...
```

**HAND_COMPLETE Missing Fields:**

```typescript
// Current
interface HandCompleteEvent {
  handId: string,
  winnerId: string,
  amount: number,
  ...
}

// Required additions
interface HandCompleteEvent {
  // Existing...

  // Missing:
  pot: number;            // Final pot size
  sawFlop: boolean;       // For rakeback tiers
  winnerCards?: Card[];   // For history
  allActions: PlayerAction[]; // For replay
}
```

**SeatPlayer Missing Fields:**

```typescript
// Current
interface SeatPlayer {
  userId: string,
  stack: number,
  name: string,
  ...
}

// Required additions
interface SeatPlayer {
  // Existing...

  // Missing:
  is_disconnected?: boolean;     // For UI indicator
  position?: 'sb' | 'bb' | 'utg' | ...; // Calculated at deal
  time_bank_remaining?: number;  // Current pool seconds
}
```

---

## SECTION 7: CLIENT POISON CATALOG (TablePage.tsx)

**Lines to REMOVE (48 handControllerRef references + 15 broadcastLocalHandState calls):**

### handControllerRef References (48 total)

**Initialization & Setup (lines 2711, 2727-2813):**

```
Line 2711:   const handControllerRef = useRef<HandController | null>(null);
Line 2732:   handControllerRef.current = new HandController({...})
Line 2741:   handControllerRef.current.on('hand_complete', ...)
Line 2753:   handControllerRef.current.dispose()
```

**Action Handlers (lines 4005-4206):**

```
Line 4012:   handleFold:        () => handControllerRef.current?.performAction(...)
Line 4018:   handleCheck:       () => handControllerRef.current?.performAction(...)
Line 4024:   handleCall:        () => handControllerRef.current?.performAction(...)
Line 4030:   handleBet:         (amount) => handControllerRef.current?.performAction(...)
Line 4036:   handleRaise:       (amount) => handControllerRef.current?.performAction(...)
Line 4042:   handleAllIn:       (amount) => handControllerRef.current?.performAction(...)
Line 4048:   handleTimebank:    () => handControllerRef.current?.activate(...)
(+ ~40 more similar calls in event handlers)
```

**State Reads (lines 2919-2926, 3034-3193, 3242-3253):**

```
Line 2921:   streetPotsRef.current = handControllerRef.current?.getState().streetPots
Line 3045:   Hand rotation uses handControllerRef.current?.getState().variant
Line 3243:   WINNERS event reads engineState = handControllerRef.current?.getState()
```

**broadcastLocalHandState Calls (15 total):**

```
Line 2741:   broadcastLocalHandState('HAND_STARTED', ...)
Line 2855:   broadcastLocalHandState('STREET_CHANGED', ...)
Line 2919:   broadcastLocalHandState('POT_UPDATED', ...)
Line 2942:   broadcastLocalHandState('ACTION_PERFORMED', ...)
Line 3124:   broadcastLocalHandState('PLAYERS_ROTATED', ...)
Line 3156:   broadcastLocalHandState('HORSE_VARIANT_ROTATED', ...)
Line 3198:   broadcastLocalHandState('PRE_HAND_CHECK', ...)
Line 3243:   broadcastLocalHandState('WINNERS', ...)
(+ 7 more)
```

### REPLACEMENT PATTERN (Every Handler)

**Before (WRONG):**

```typescript
handleFold: () => {
  handControllerRef.current?.performAction('fold');
  broadcastLocalHandState('ACTION_PERFORMED', { action: 'fold' });
};
```

**After (CORRECT):**

```typescript
handleFold: async () => {
  setPendingAction('fold'); // Show spinner immediately

  try {
    const result = await GameServerAPI.submitAction(tableId, userId, {
      action: 'fold',
    });

    if (!result.success) {
      showError(result.error); // e.g., "Action already performed"
      setPendingAction(null);
      return;
    }

    // Do NOT update state here!
    // State update comes from Supabase Realtime broadcast (subscribeToHandState)
  } catch (err) {
    showError('Network error: ' + err.message);
    setPendingAction(null);
  }
};
```

### Removed Imports (7 total)

Lines 1-165 in TablePage.tsx:

```typescript
import { HandController } from 'src/engine/HandController'; // DELETE
import { PokerEngine } from 'src/engine/PokerEngine'; // DELETE (use server)
import { ServerActionValidator } from 'src/engine/ServerActionValidator'; // DELETE
import { RakeWaterfallEngine } from 'src/engine/RakeWaterfallEngine'; // DELETE
import { OFCPineappleEngine } from 'src/engine/OFCPineappleEngine'; // DELETE
import { MonteCarloEquity } from 'src/engine/MonteCarloEquity'; // DELETE
import { TimeBankEngine } from 'src/engine/TimeBankEngine'; // DELETE
```

---

## SECTION 8: EXECUTION PHASES (7 Total — CORRECTED ORDER)

**⚠ CRITICAL: See MIGRATION-LAW.md — Order of Operations is SACRED**

```
STEP 1: RIP OUT — Remove ALL client-side engine code (ONE source of truth)
STEP 2: VERIFY CLEAN — Grep confirms ZERO local authoritative state
STEP 3: FIX SERVER BLOCKERS — Card security, auto-fold, timer
STEP 4: PORT CORE — PreciseActionTimer, ServerActionValidator, StateVerifier
STEP 5: PORT SUPPORTING — TimeBankEngine, DisconnectEngine, PreActionEngine
STEP 6: PORT ADVANCED — Straddle, RIT, Insurance, MixedGame, Rakeback
STEP 7: TOURNAMENT & EXTRAS — ChipRace, TableBalancer, OFC, Telemetry
STEP 8: TABLE SETTINGS & THEME CUSTOMIZATION — See Bible V8 Chapter 11
```

YOU CANNOT BUILD ON A BROKEN FOUNDATION.
Client engine MUST be removed BEFORE server gets fixed or enhanced.

---

### PHASE 1: RIP OUT CLIENT ENGINE (MUST BE FIRST)

**Duration:** 3-4 days
**Approval:** CRITICAL — this is the foundational change
**Files Modified:**

- src/pages/TablePage.tsx (MAJOR — remove 48 handControllerRef + 15 broadcastLocalHandState)
- src/pages/TablePage.tsx action handlers (convert to server-only API calls)
- All src/engine/ imports removed from TablePage.tsx

**What gets removed:**

- handControllerRef and ALL 48 references
- broadcastLocalHandState() function and ALL 15 calls
- ALL local engine imports (HandController, etc.)
- ALL local action processing (performAction calls)
- ALL "client is authoritative" patterns

**What replaces it:**

- Action handlers become: async POST to server → wait for response → show error or wait for Realtime broadcast
- State updates come ONLY from Supabase Realtime subscriptions
- Client becomes a dumb terminal: send actions, receive state, render

**Verification:**

- grep -rn "handControllerRef" src/ → ZERO results
- grep -rn "broadcastLocalHandState" src/ → ZERO results
- grep -rn "performAction" src/pages/TablePage.tsx → ZERO local engine calls
- npx tsc --noEmit → ZERO errors

---

### PHASE 2: VERIFY CLEAN (MANDATORY GATE)

Comprehensive grep of entire src/ directory for ANY remaining:

- Local HandController usage
- Local engine calculations
- Local state that claims to be authoritative
- Any engine import in UI components

Only after this gate passes do we touch the server.

---

### PHASE 3: Fix the 3 Server Blockers

**Duration:** 2-3 days
**Approval:** Not needed (bugfixes)
**Files Modified:**

- server/src/engine/ServerTableEngine.ts (3 fixes)

**BLOCKER #1: Card Security**

**File:** `server/src/engine/ServerTableEngine.ts` (line 792)
**Current:**

```typescript
broadcastCurrentState() {
  const state = {
    ...
    players: this.players.map(p => ({
      ...p,
      cards: p.cards ?? []  // LEAKS ALL CARDS
    }))
  };
  this.broadcastState(state);
}
```

**Fixed:**

```typescript
broadcastCurrentState(requestingPlayerId?: string) {
  const scrubbed = this.players.map(p => ({
    ...p,
    cards: this.stage === 'showdown'
      ? (p.cards ?? [])                    // Show all at showdown
      : (p.id === requestingPlayerId
        ? (p.cards ?? [])                 // Show to requesting player
        : [])                             // Hide from others
  }));

  const state = {
    ...
    players: scrubbed
  };
  this.broadcastState(state);
}
```

**Verification:**

```bash
# After fix: test with 2 players
# Player A should see: own 2 cards + opponent 0 cards (preflop)
# Player B should see: own 2 cards + opponent 0 cards (preflop)
# At showdown: both should see all cards
```

---

**BLOCKER #2: Auto-Fold on Error**

**File:** `server/src/engine/ServerTableEngine.ts` (lines 351-353)
**Current:**

```typescript
async handlePlayerAction(tableId: string, userId: string, action: PlayerAction): Promise<void> {
  const result = await this.validateAction(action);
  if (!result.valid) {
    await this.engine.handlePlayerAction(tableId, userId, {action: 'fold'});  // WRONG
    return;
  }
}
```

**Fixed:**

```typescript
async handlePlayerAction(
  tableId: string,
  userId: string,
  action: PlayerAction
): Promise<{success: boolean; error?: string}> {

  const result = this.validator.validate(action, context);
  if (!result.valid) {
    return {
      success: false,
      error: `Action invalid: ${result.errorCode}`
    };
  }

  await this.engine.handlePlayerAction(tableId, userId, action);
  return { success: true };
}
```

**HTTP Endpoint Change:**

```typescript
app.post('/action', async (req, res) => {
  // OLD: fire-and-forget
  // await engine.handlePlayerAction(...)
  // res.send('OK')

  // NEW: return result
  const result = await engine.handlePlayerAction(
    req.body.tableId,
    req.body.userId,
    req.body.action
  );
  res.json(result);
});
```

**Client Updates:**

```typescript
async function handleFold() {
  const result = await fetch('/action', {
    method: 'POST',
    body: JSON.stringify({ tableId, userId, action: 'fold' }),
  }).then((r) => r.json());

  if (!result.success) {
    showError(result.error); // "Action invalid: INSUFFICIENT_STACK"
  }
}
```

**Verification:**

```bash
# Test 1: Valid action
# POST /action {action: 'fold'} → {success: true}
# ✓ Action performed

# Test 2: Invalid action (wrong turn)
# POST /action {action: 'raise'} as wrong player → {success: false, error: 'NOT_YOUR_TURN'}
# ✓ Error returned, no fold

# Test 3: Invalid action (insufficient stack)
# POST /action {action: 'bet', amount: 10000} with stack=100 → {success: false, error: 'INSUFFICIENT_STACK'}
# ✓ Error returned, no fold
```

---

**BLOCKER #3: Timer Auto-Check Logic**

**File:** `server/src/engine/ServerTableEngine.ts` (lines 199-205)
**Current:**

```typescript
private async handleActionTimer(tableId: string, playerId: string) {
  if (!canCheck) {
    // Always fold on timeout
    await this.handlePlayerAction(tableId, playerId, {action: 'fold'});
  }
}
```

**Fixed:**

```typescript
private async handleActionTimer(tableId: string, playerId: string) {
  if (canCheck && amountToCall === 0) {
    // Can check → auto-check
    await this.handlePlayerAction(tableId, playerId, {action: 'check'});
  } else if (!canCheck && amountToCall > 0) {
    // Cannot check, must call/fold → use pre-action or fold
    if (player has auto_call pre-action) {
      await this.handlePlayerAction(tableId, playerId, {action: 'call'});
    } else {
      await this.handlePlayerAction(tableId, playerId, {action: 'fold'});
    }
  }
}
```

**Verification:**

```bash
# Test 1: Timer expires on big blind (no bet)
# canCheck=true, amountToCall=0 → AUTO-CHECK (not fold)
# ✓ Check performed

# Test 2: Timer expires with bet outstanding
# canCheck=false, amountToCall=100 → AUTO-FOLD (unless pre-action)
# ✓ Fold performed

# Test 3: Timer expires with auto_call pre-action
# canCheck=false, amountToCall=100, pre_action='auto_call' → AUTO-CALL
# ✓ Call performed
```

---

### PHASE 2: Port Core Engine Extensions (5 days)

**Duration:** 5-6 days
**Execution:** Proceed only within the assigned phase, without another approval gate.
**Files Modified:**

- server/src/engine/PreciseActionTimer.ts (NEW — 233 lines)
- server/src/engine/ServerActionValidator.ts (ENHANCED — 323 lines)
- server/src/engine/HandController.ts (UPGRADED — +200 lines)
- server/src/engine/StateVerifier.ts (NEW — 275 lines)

**PRIORITY ORDER:**

1. **PreciseActionTimer (Day 1)**
   - Port entire file from client
   - Replace setTimeout in ServerTableEngine
   - Test: Timer doesn't drift under load (10+ simultaneous timers)

2. **ServerActionValidator (Day 1-2)**
   - Port entire file from client
   - Integration: ServerTableEngine calls validate() before performAction()
   - Test: All 11 error codes work as expected

3. **HandController Upgrades (Day 2-3)**
   - Add BBA support (lines 252-271 from client)
   - Add straddle injection (lines 274-291 from client)
   - Add bomb pot skip logic (lines 191-208 from client)
   - Fix raise clamping (lines 394-398 from client)
   - Add no-winners guard (lines 755-781 from client)
   - Fix aggression tracking
   - Add RIT event support
   - Test: Each feature independently

4. **StateVerifier (Day 3-4)**
   - Port entire file from client
   - Integration: HandController calls verify() between hands
   - Test: All 6 checks catch intentional violations

5. **Integration & Cleanup (Day 4-5)**
   - Remove setTimeout from ServerTableEngine
   - Wire up all new validators
   - End-to-end test: Full hand with all new features
   - TypeScript: `npx tsc --noEmit` (zero errors)

---

### PHASE 3: Port Supporting Systems (6 days)

**Duration:** 6-7 days
**Execution:** Proceed only within the assigned phase, without another approval gate.
**Files Modified:**

- server/src/engine/TimeBankEngine.ts (NEW)
- server/src/engine/DisconnectEngine.ts (NEW)
- server/src/engine/PreActionEngine.ts (NEW)
- server/src/engine/AtomicStackService.ts (NEW)
- server/src/index.ts (ADD 5 endpoints)

**PRIORITY ORDER:**

1. **TimeBankEngine (Day 1)**
   - Port from client, remove VIPService dependency
   - Integration: HandController.handleTurnChange calls onPrimaryTimerExpired()
   - Endpoint: POST /timebank
   - Test: Pool refills per orbit, multiple uses per hand

2. **DisconnectEngine (Day 1-2)**
   - Port from client
   - Integration: registerPlayer on seat, heartbeat tracking
   - Endpoint: POST /heartbeat (called every 5s by client)
   - Test: Disconnect after 30s → auto-fold, reconnect clears flag

3. **PreActionEngine (Day 2)**
   - Port from client
   - Integration: HandController.handleTurnChange calls executePreAction() BEFORE timer
   - Endpoint: POST /preaction
   - Test: auto_check clears on bet, auto_call converts to all-in

4. **AtomicStackService (Day 2-3)**
   - Port from client
   - Integration: All stack mutations go through atomicDebit/atomicCredit
   - Test: Race condition detection works (version mismatch)

5. **HTTP Endpoints (Day 3-4)**
   - Add JWT validation to existing endpoints
   - Add 5 new endpoints: /preaction, /heartbeat, /sitout, GET /state, (more in Phase 4)
   - Add rate limiting (1 req/100ms per player per action)
   - Test: All endpoints require valid JWT

6. **Integration & Cleanup (Day 4-5)**
   - End-to-end test: Time bank usage + disconnect detection + pre-action
   - TypeScript: `npx tsc --noEmit`

---

### PHASE 4: Port Advanced Features (8 days)

**Duration:** 8-9 days
**Execution:** Proceed only within the assigned phase, without another approval gate.
**Files Modified:**

- server/src/engine/StraddleEngine.ts (NEW)
- server/src/engine/RunItTwiceEngine.ts (NEW)
- server/src/engine/InsuranceEngine.ts (NEW)
- server/src/engine/MonteCarloEquity.ts (NEW)
- server/src/engine/MixedGameEngine.ts (NEW)
- server/src/engine/RakebackEngine.ts (NEW)
- server/src/index.ts (ADD 5+ endpoints)

**PRIORITY ORDER:**

1. **MonteCarloEquity (Day 1)**
   - Port from client (127 lines)
   - No changes needed, just copy
   - Used by InsuranceEngine

2. **StraddleEngine (Day 1-2)**
   - Port from client
   - Integration: HandController.dealHand() calls processStraddles() after blinds
   - Endpoint: POST /straddle
   - Test: UTG straddles post correctly, first-to-act moves right

3. **MixedGameEngine (Day 2)**
   - Port from client
   - Integration: HandController.dealHand() calls getCurrentVariant()
   - Integration: HandController.postHandTasks() calls onHandComplete()
   - Test: Rotation triggers at hand threshold

4. **RunItTwiceEngine (Day 2-3)**
   - Port from client
   - Integration: HandController all-in path calls offer()
   - Integration: PreciseActionTimer.pauseTimer() during RIT offer window
   - Endpoint: POST /rit
   - Test: Dual boards dealt correctly, pot split correctly

5. **InsuranceEngine (Day 3-4)**
   - Port from client (uses MonteCarloEquity)
   - Integration: All-in path calls createOffers()
   - Integration: Timer paused during offer window
   - Endpoint: POST /insurance
   - Test: Premium calculation correct, settlement correct

6. **RakebackEngine (Day 4-5)**
   - Port from client
   - Integration: HandController.postHandTasks() calls recordHandRake()
   - Cron job: Daily/weekly settleRakeback()
   - Test: Per-player rake share calculated correctly

7. **HTTP Endpoints (Day 5-6)**
   - Add: /rit, /insurance, /straddle, /showhand, /state
   - All with JWT validation and error handling

8. **Integration & Cleanup (Day 6-7)**
   - End-to-end test: Full hand with straddles + RIT + insurance + rakeback
   - TypeScript: `npx tsc --noEmit`

---

### PHASE 5: Remove Client Engine (3-4 days)

**Duration:** 3-4 days
**Approval:** CRITICAL — cannot rollback after this
**Files Modified:**

- src/pages/TablePage.tsx (MAJOR — remove 48 refs + 15 calls)
- src/lib/supabase.ts (MINOR — ensure subscribeToHandState works)
- src/components/\*.tsx (UPDATE all action handlers)

**STEP-BY-STEP (in order):**

1. **Remove handControllerRef (Day 1)**
   - Delete line 2711: `const handControllerRef = useRef(...)`
   - Delete lines 2727-2813: initialization block
   - Delete lines 2753: cleanup block
   - Verify: TypeScript errors (expected)

2. **Update All Action Handlers (Day 1-2)**
   - Convert all 48 handler calls from `handControllerRef.current.performAction()` to async `GameServerAPI.submitAction()`
   - Add pending state spinners
   - Add error handling
   - Pattern: See SECTION 7 REPLACEMENT PATTERN
   - Verify: No more handControllerRef references

3. **Remove broadcastLocalHandState (Day 2)**
   - Delete all 15 calls to `broadcastLocalHandState()`
   - Delete the function itself (lines 3838-3860)
   - State updates now come from Supabase Realtime only
   - Verify: No more broadcastLocalHandState references

4. **Remove Engine Imports (Day 2)**
   - Delete 7 imports (see SECTION 7 — Removed Imports)
   - Verify: No remaining `src/engine/` imports in TablePage.tsx

5. **Verify State Flow (Day 3)**
   - Test: Click action button → API call → no local change → Supabase broadcast → state updates
   - Test: Open DevTools → Network tab → See /action POST
   - Test: Open DevTools → Console → No errors
   - Verify: TypeScript compiles: `npx tsc --noEmit`

6. **Smoke Tests (Day 3-4)**
   - Sit at table → see cards ✓
   - Click fold → error handling works ✓
   - Invalid action → error shown ✓
   - Timer expires → auto-action works ✓
   - Opponent action → state updates from Realtime ✓
   - Hand complete → showdown correct ✓

---

### PHASE 6: Tournament & Extras (4-5 days) — OPTIONAL

**Duration:** 4-5 days
**Execution:** Include only when tournament work is part of the assignment; no additional approval gate.
**Files Modified:**

- server/src/engine/ChipRaceEngine.ts
- server/src/engine/TableBalancer.ts
- server/src/engine/TableBreakEngine.ts
- server/src/engine/OFCPineappleEngine.ts
- server/src/engine/OFCDealingOrchestrator.ts
- server/src/engine/EngineTelemetry.ts

**Scope:**

- ChipRaceEngine: Chip denomination removal via lottery
- TableBalancer/TableBreakEngine: MTT table management
- OFCPineappleEngine/OFCDealingOrchestrator: Open Face Chinese Poker game mode
- EngineTelemetry: Production observability

**Note:** These do NOT block core game launch. Port only if those features are needed.

---

## SECTION 9: SERVER FILE STRUCTURE (TARGET)

### Directory Layout

```
server/src/
├── engine/
│   ├── HandController.ts              ← UPGRADED (600+ lines)
│   ├── ServerTableEngine.ts           ← ENHANCED (950 lines)
│   ├── PokerEngine.ts                 ← EXISTING (no changes)
│   │
│   ├── PreciseActionTimer.ts          ← NEW (PHASE 2)
│   ├── ServerActionValidator.ts       ← NEW (PHASE 2)
│   ├── StateVerifier.ts               ← NEW (PHASE 2)
│   │
│   ├── TimeBankEngine.ts              ← NEW (PHASE 3)
│   ├── DisconnectEngine.ts            ← NEW (PHASE 3)
│   ├── PreActionEngine.ts             ← NEW (PHASE 3)
│   ├── AtomicStackService.ts          ← NEW (PHASE 3)
│   │
│   ├── StraddleEngine.ts              ← NEW (PHASE 4)
│   ├── RunItTwiceEngine.ts            ← NEW (PHASE 4)
│   ├── InsuranceEngine.ts             ← NEW (PHASE 4)
│   ├── MonteCarloEquity.ts            ← NEW (PHASE 4)
│   ├── MixedGameEngine.ts             ← NEW (PHASE 4)
│   ├── RakebackEngine.ts              ← NEW (PHASE 4)
│   │
│   ├── ChipRaceEngine.ts              ← NEW (PHASE 6 — tournament)
│   ├── TableBalancer.ts               ← NEW (PHASE 6 — tournament)
│   ├── TableBreakEngine.ts            ← NEW (PHASE 6 — tournament)
│   ├── OFCPineappleEngine.ts          ← NEW (PHASE 6 — game mode)
│   ├── OFCDealingOrchestrator.ts      ← NEW (PHASE 6 — game mode)
│   │
│   ├── CryptoRandom.ts                ← NEW (if not reusing existing)
│   └── EngineTelemetry.ts             ← NEW (PHASE 6 — monitoring)
│
├── services/
│   ├── supabase.ts                    ← ENHANCED (broadcastHandState scrubbing)
│   └── ...
│
├── types.ts                           ← ENHANCED (HandConfig, HandEvent, SeatPlayer)
├── index.ts                           ← ENHANCED (10+ HTTP endpoints)
└── ...
```

### Type Upgrades Checklist

**File:** `server/src/types.ts`

```typescript
// HandConfig
interface HandConfig {
  blinds: BlindStructure;
  tableSize: number;
  // NEW:
  bigBlindAnte?: boolean;
  straddles?: StraddleConfig;
  ritEnabled?: boolean;
  insuranceEnabled?: boolean;
  mixedGameVariant?: GameVariant;
}

// HandEvent
type HandEvent =
  | {type: 'HAND_STARTED', ...}
  | {type: 'ACTION_PERFORMED', ...}
  | {type: 'STREET_CHANGED', ...}
  | {type: 'HAND_COMPLETE', ...}
  | // NEW:
  | {type: 'ALL_IN_RUNOUT_PENDING', tableId, players}
  | {type: 'STRADDLE_POSTED', seatNumber, amount}
  | {type: 'INSURANCE_OFFERED', offers[]}
  | {type: 'RIT_OFFERED', offeredBy, offeredTo}
  | ...

// HAND_COMPLETE additions
interface HandCompleteEvent {
  handId: string;
  winnerId?: string;  // nullable if split/chop
  amount: number;
  // NEW:
  pot: number;
  sawFlop: boolean;
  winnerCards?: Card[];
  allActions: PlayerAction[];
}

// SeatPlayer additions
interface SeatPlayer {
  userId: string;
  stack: number;
  name: string;
  // NEW:
  is_disconnected?: boolean;
  position?: 'sb' | 'bb' | 'utg' | 'utg+1' | 'co' | 'btn';
  time_bank_remaining?: number;
}
```

---

## SECTION 10: VERIFICATION CHECKLIST

For EACH phase, before marking complete:

### PHASE 1 (Blockers)

- [ ] POST /action returns `{success, error}` not void
- [ ] Card broadcast scrubbed: opponent cards = `[]` until showdown
- [ ] Timer expires: auto-check if `canCheck=true`, else auto-fold
- [ ] Test A: Player 1 can't see Player 2's cards
- [ ] Test B: Invalid action returns error code, NOT auto-fold
- [ ] Test C: Blind post → timeout → auto-check (not fold)
- [ ] TypeScript: `npx tsc --noEmit` (zero errors)

### PHASE 2 (Core Extensions)

- [ ] PreciseActionTimer: Timer not drift under 10+ concurrent timers
- [ ] ServerActionValidator: All 11 error codes return correct error
- [ ] HandController: BBA posting correct amount
- [ ] HandController: Straddle injection correct, first-to-act updated
- [ ] HandController: Bomb pot skip working (preflop action skipped)
- [ ] HandController: Raise clamping prevents over-raises
- [ ] HandController: No-winners guard prevents crash
- [ ] StateVerifier: Detects chip conservation violation
- [ ] Test: Full hand with all features → no errors
- [ ] TypeScript: `npx tsc --noEmit`

### PHASE 3 (Supporting Systems)

- [ ] TimeBankEngine: Pool persists, refills per orbit
- [ ] DisconnectEngine: 30s timeout → auto-fold, reconnect clears
- [ ] PreActionEngine: auto_check clears on bet, auto_call converts to all-in
- [ ] AtomicStackService: Version mismatch detected and returned
- [ ] POST /heartbeat: Resets disconnect timer
- [ ] POST /preaction: Sets and clears pre-actions
- [ ] POST /sitout: Player sits out next hand
- [ ] GET /state: Returns scrubbed table state
- [ ] Test: Full hand with time bank + disconnect + pre-action
- [ ] TypeScript: `npx tsc --noEmit`

### PHASE 4 (Advanced Features)

- [ ] StraddleEngine: Straddles post in correct position
- [ ] MixedGameEngine: Game rotates at threshold
- [ ] RunItTwiceEngine: Both boards dealt, pot split correctly
- [ ] InsuranceEngine: Premium = `(1 - equity) × amount × 1.05`
- [ ] POST /rit: Accept/decline responses work
- [ ] POST /insurance: Accept/decline responses work
- [ ] POST /straddle: Toggle auto-straddle
- [ ] RakebackEngine: Per-player rake share calculated correctly
- [ ] Test: Full hand with straddles + RIT + insurance
- [ ] TypeScript: `npx tsc --noEmit`

### PHASE 5 (Remove Client Engine)

- [ ] handControllerRef: 0 references (was 48)
- [ ] broadcastLocalHandState: 0 calls (was 15)
- [ ] Engine imports: 0 remaining (was 7)
- [ ] All action handlers: async HTTP POST → await result
- [ ] State updates: All from `subscribeToHandState` callback
- [ ] Test: Click fold → API call → error handling works
- [ ] Test: Open DevTools → Network → See /action POST
- [ ] Test: Opponent action → state updates from Realtime
- [ ] TypeScript: `npx tsc --noEmit`

### PHASE 6 (Tournament — if applicable)

- [ ] ChipRaceEngine: Chip race lottery fair (uses CryptoRandom)
- [ ] TableBalancer: Tables balanced to within 1 player
- [ ] TableBreakEngine: Table breaks correctly, seats assigned fairly
- [ ] OFC: Full game loop works (deal, place, evaluate)
- [ ] Test: Full MTT hand with chip race + table break
- [ ] TypeScript: `npx tsc --noEmit`

### GENERAL VERIFICATION (All Phases)

**Code Quality:**

- [ ] No `console.log` debugging statements left
- [ ] No `TODO` comments without jira issues
- [ ] No commented-out code
- [ ] Variable names clear and consistent

**Type Safety:**

- [ ] `npx tsc --noEmit` returns exit code 0
- [ ] No `any` types used without justification
- [ ] All function parameters typed
- [ ] All return types specified

**Testing:**

- [ ] Full hand from deal to showdown
- [ ] Multi-hand sequence (5+ hands)
- [ ] Error cases (invalid action, timeout, disconnect)
- [ ] Edge cases (all-in, side pot, chop, split)
- [ ] Concurrent actions (multiple players acting simultaneously)

**Performance:**

- [ ] Timer accuracy within 100ms under load
- [ ] Broadcast latency < 500ms (Supabase Realtime)
- [ ] No memory leaks (dispose() called on cleanup)
- [ ] No infinite loops in polling intervals

**Security:**

- [ ] All HTTP endpoints validate JWT
- [ ] No SQL injection vectors (using parameterized queries)
- [ ] No card information leakage (scrubbed in broadcasts)
- [ ] Rate limiting prevents action spam

---

## SECTION 11: BIBLE CHAPTERS AFFECTED

This migration impacts the following sections of the Club Arena Poker Bible:

**Chapter 1 — Game States & Transitions**

- Updates: Add RIT_OFFERED, INSURANCE_OFFERED, STRADDLE_POSTED states
- Updates: Pause states during RIT/insurance offer windows

**Chapter 2 — Dealing & Card Flow**

- Updates: BBA posting logic
- Updates: Straddle injection
- Updates: RIT dual board dealing
- NEW: MixedGameEngine variant support

**Chapter 3 — Betting & Action**

- Updates: ServerActionValidator (20 checks vs current 3)
- Updates: PreActionEngine auto-action execution
- Updates: Timer behavior (auto-check when toCall=0)
- Updates: Raise clamping fixes

**Chapter 4 — Settlement**

- Updates: AtomicStackService versioned debits
- Updates: RIT settlement (pot split per board)
- NEW: Rakeback settlement
- NEW: Insurance settlement

**Chapter 5 — Tournaments** (if Phase 6 executed)

- NEW: ChipRaceEngine
- NEW: TableBalancer
- NEW: TableBreakEngine

---

## SECTION 12: ROLLBACK PROCEDURE

If any phase fails catastrophically:

1. **During PHASE 1-4:** No rollback needed (server-side only, client unaffected)
2. **During PHASE 5:** CRITICAL — if client fails mid-removal, revert TablePage.tsx to last known good
   ```bash
   git revert <phase-5-commit>
   # Then server rolls back to use old broadcastLocalHandState format
   ```
3. **Recovery:** Return to client-authoritative model until Phase 5 can be re-executed

---

## DOCUMENT VERSION HISTORY

| Version | Date       | Changes                         |
| ------- | ---------- | ------------------------------- |
| 1.0     | 2026-03-24 | Initial comprehensive blueprint |

---

**END OF MASTER MIGRATION DOCUMENT**

This document is the authoritative guide for migrating Club Arena from a dual-engine (client + server) architecture to a server-authoritative model with a dumb-terminal client. Execute phases sequentially. Do not skip phases. Verify before proceeding to next phase.
