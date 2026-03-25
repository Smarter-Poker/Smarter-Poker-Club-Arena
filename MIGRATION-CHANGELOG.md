# MIGRATION CHANGELOG
## Every Change, Documented. No Exceptions.

**Started:** 2026-03-24
**Current Step:** Step 6 — PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)

---

## Step 1 — RIP OUT Client-Side Engine Code

### Phase: COMPLETED 2026-03-24

**File: `src/pages/TablePage.tsx`**

**Removed (~780 lines net):**

1. **Engine imports removed (5 of 6):**
   - `Deck, compareHands, calculatePots, determineWinners` from `PokerEngine`
   - `HandController` from `HandController`
   - `serverActionValidator` from `ServerActionValidator`
   - `OFCPineappleEngine` from `OFCPineappleEngine`
   - `monteCarloEquity` from `MonteCarloEquity`
   - **KEPT:** `timeBankEngine` — deferred to Step 5 (8 active callsites)

2. **HandController initialization block removed (~940 lines):**
   - `handControllerRef` declaration + all 51 references → **0 remaining**
   - `handController` state + `setHandController` → removed
   - `handInProgressRef` → removed
   - `startNextHandRef` function body → removed (entire HC creation, config, event subscription)
   - All HC event handlers: HAND_START, CARDS_DEALT, COMMUNITY_CARDS, POT_UPDATE, PLAYER_ACTION, TURN_CHANGE, SHOWDOWN, WINNERS, HAND_COMPLETE
   - Horse auto-action logic (HydraService decision → HC performAction)
   - `handPersistenceService.wireToHandController()` call
   - First-hand trigger `useEffect` watching `tableState.players`

3. **`broadcastLocalHandState` function removed:**
   - Function declaration (was `useCallback` wrapping `broadcastHandState()`)
   - All 14 call sites across action handlers
   - `broadcastHandState` removed from supabase import (unused)

4. **Action handlers migrated to server-only:**
   - `handleFold` — local `performAction('fold')` removed, `submitAction` is now primary (awaited)
   - `handleCheck` — same pattern
   - `handleCall` — same pattern
   - `handleActionPanelAction` — all 5 cases (fold/check/call/raise/allin) cleaned
   - `handleConfirmRaise` — local engine call removed
   - `handleAllIn` — local engine call removed
   - `handleTimerAutoFold` — local engine call removed, `submitAction` only

5. **`validateAndExecuteAction` simplified:**
   - Removed `serverActionValidator.validate()` dependency
   - Removed `handControllerRef.current.getState()` for validation context
   - Now does basic client-side guard only (fold always allowed, check hero exists)
   - Server performs real validation

6. **HC state reads replaced with `tableState` (Zustand):**
   - Keyboard shortcut 'C' handler — `hcState.currentBet` → `tableState.lastBetAmounts`
   - `useTableKeyboard` `onCallCheck` — same replacement
   - `onBetPreset` — `state.pot` → `tableState.pot`
   - Pre-action check/callAny handlers — same replacement
   - ActionPanel render props (`canCheck`, `callAmount`, `minRaise`) — derived from `tableState`
   - PreActionBar `canCheck` prop — derived from `tableState`

7. **`monteCarloEquity` call replaced:**
   - Insurance equity calculation now uses heuristic fallback
   - TODO marker left for server-side equity endpoint (Step 3)

8. **Rabbit hunt handler updated:**
   - Removed `handControllerRef.current?.getState()?.deck` access
   - Falls through to random card generation (server-side rabbit hunt in Step 3)

9. **Comment cleanup:**
   - "LOCAL engine is authoritative" comments → removed or updated
   - "Use HC's authoritative pot value" → removed
   - HandController references in section headers → neutralized

**What the client KEEPS (correct behavior):**
- `submitAction()` from GameServerAPI — HTTP POST to server (PRIMARY)
- `sendAction()` from useTableWebSocket — WebSocket action send
- `subscribeToHandState()` — Supabase Realtime listener
- All UI rendering — cards, chips, animations, sounds
- All Zustand state — populated by server events
- `timeBankEngine` — deferred to Step 5

**Verification (grep):**
- `handControllerRef`: 0 matches ✅
- `broadcastLocalHandState`: 0 non-comment matches ✅
- `.performAction(`: 0 matches ✅
- `monteCarloEquity`: 0 non-comment matches ✅
- `serverActionValidator`: 0 non-comment matches ✅
- Engine imports (`from '../engine/`): only `timeBankEngine` (Step 5) ✅

**Next:** Step 2 — VERIFY CLEAN (full grep confirms zero local authoritative state)

---

## Step 2 — VERIFY CLEAN (Mandatory Gate)

### Phase: COMPLETED 2026-03-24

**Scope:** Comprehensive grep of entire `src/` directory — NOT just TablePage.tsx.

**Grep 1: `handControllerRef | new HandController | .performAction(`**
- `src/pages/TablePage.tsx`: 0 matches ✅
- `src/engine/HeadlessTableEngine.ts`: multiple matches → EXPECTED (this IS the server engine, Step 4+)
- `src/engine/demo.ts`: 4 matches → EXPECTED (demo/test file, not gameplay UI)
- All other UI files: 0 matches ✅

**Grep 2: Engine imports in UI components (`from '../engine/'`)**
- `TablePage.tsx` → only `timeBankEngine` (deferred to Step 5) ✅
- `FlashPoolPage.tsx` → `flashPoolEngine` (deferred to Phase 6 per catalog) ✅
- `admin/EngineDashboard.tsx` → orchestrators (admin dashboard, not gameplay) ✅
- `StraddleToggle.tsx` → `straddleEngine` (deferred to Step 4 per catalog) ✅
- `HydraService.ts`, `BBJService.ts`, `HandPersistenceService.ts`, `SpinItWheel.tsx` → TYPE-ONLY imports (safe) ✅
- `RakeService.ts`, `FinancialCronService.ts` → `rakebackEngine` (Phase 6 per catalog) ✅

**Grep 3: "authoritative" claims in client code**
- `TablePage.tsx` → only Step 1 migration markers ("server is authoritative") ✅
- `GameServerAPI.ts` → correct: "server is the AUTHORITATIVE source" ✅
- All engine files → correct: server-side code claiming authority ✅
- Zero "client is authoritative" or "LOCAL engine is authoritative" claims remain ✅

**Grep 4: `broadcastLocalHandState | broadcastHandState`**
- `TablePage.tsx` → 0 non-comment matches (only migration marker comment) ✅
- `lib/supabase.ts` → function definition (kept, used by server engine) ✅
- `HeadlessTableEngine.ts` → server-side usage (correct) ✅

**GATE RESULT: PASS** — Zero client-side authoritative engine code remains in UI components. All remaining engine references are either server-side (correct), type-only (safe), or explicitly deferred to later phases per the removal catalog.

**Next:** Step 3 — FIX SERVER BLOCKERS (card security, auto-fold, timer)

---

## Step 3 — FIX SERVER BLOCKERS

### Phase: IN PROGRESS 2026-03-24

**Files Modified:**
- `server/src/engine/ServerTableEngine.ts` (3 server fixes)
- `src/pages/TablePage.tsx` (1 client fix for card handling)

---

### BLOCKER #1: Card Security — Hole Cards Leaked via Broadcast

**File:** `server/src/engine/ServerTableEngine.ts`

**Problem:** `broadcastCurrentState()` at line 792 sent `cards: p.cards ?? []` for ALL players to ALL subscribers via Supabase Realtime. Anyone inspecting the WebSocket payload could see every player's hole cards.

**Fix A — Scrub cards from broadcast (line ~849):**

**Before:**
```typescript
cards: p.cards ?? [],
```

**After:**
```typescript
// Only reveal cards at showdown for players still in the hand (not folded)
cards: (state.stage === 'showdown' && !p.is_folded) ? (p.cards ?? []) : [],
```

**Fix B — Write cards to RLS-protected table (new CARDS_DEALT handler, lines 604-635):**

Added a `CARDS_DEALT` case to `handleHandEvent()` that writes each player's dealt cards to the `table_hole_cards` table via the existing `insert_hole_cards` RPC. This table has Row Level Security: `USING (auth.uid() = user_id)` — each player can only read their own cards.

The client already subscribes to `table_hole_cards` INSERT events (via `useMasterBusChannel` at TablePage line 1489-1496) and falls back to a direct query on reconnect (line 1501-1510). No client-side card delivery changes needed.

**Fix C — Client card handling for scrubbed broadcasts (TablePage.tsx line ~1576-1591):**

**Before:**
```typescript
holeCards: isHero ? sp.cards || existing?.holeCards || [] : existing?.holeCards || [],
showCards: isHero,
```

**After:**
```typescript
// Card security: server scrubs hole cards in broadcast (sends []) except at showdown.
// Hero gets cards via RLS-protected table_hole_cards channel.
// At showdown, server sends actual cards for all players → use sp.cards.
holeCards: sp.cards && sp.cards.length > 0
  ? sp.cards
  : existing?.holeCards || [],
// Show cards for hero always; show opponent cards at showdown ONLY if not folded
showCards: isHero || (sp.cards && sp.cards.length > 0 && !sp.is_folded),
```

**Why the old code was broken:** Empty arrays `[]` are truthy in JavaScript, so `sp.cards || existing?.holeCards` resolved to `[]` (the scrubbed empty array), wiping out the hero's stored cards on every broadcast.

**Verified:** Re-read both files after changes ✅

---

### BLOCKER #2: Auto-Fold on Error

**File:** `server/src/engine/ServerTableEngine.ts` (lines 347-354)

**Problem:** When `performAction()` threw an error (e.g., invalid raise amount), the catch block auto-folded the player. A typo in a bet amount shouldn't cost you your hand.

**Before:**
```typescript
} catch (err) {
  const errMsg = err instanceof Error ? err.message : 'Action failed';
  console.warn(`[ServerTableEngine:${this.tableId}] Player action failed:`, errMsg);
  // Auto-fold on invalid action
  try {
    this.handController.performAction(seat, 'fold');
    return { success: true, error: `Original action failed, auto-folded: ${errMsg}` };
  } catch {
    return { success: false, error: errMsg };
  }
}
```

**After:**
```typescript
} catch (err) {
  const errMsg = err instanceof Error ? err.message : 'Action failed';
  console.warn(`[ServerTableEngine:${this.tableId}] Player action failed:`, errMsg);
  // Return error to client — do NOT auto-fold. The player should see the error
  // and choose their next action. Auto-folding on invalid actions silently
  // destroys hands (e.g., a raise with wrong amount shouldn't fold the player).
  return { success: false, error: errMsg };
}
```

**Verified:** Re-read file after change ✅

---

### BLOCKER #3: Timer Auto-Check Logic

**File:** `server/src/engine/ServerTableEngine.ts` (lines 192-230)

**Problem:** When a player's timer expired, the server ALWAYS auto-folded — even when no bet was outstanding and the player could simply check. Standard poker: if you can check, time-out = auto-check.

**Before:**
```typescript
this.playerTurnTimer = setTimeout(() => {
  // ... guard checks ...
  console.warn(`... Auto-folding.`);
  try {
    this.handController.performAction(seat, 'fold');
  } catch (err) { ... }
}, safeDurationSeconds * 1000);
```

**After:**
```typescript
this.playerTurnTimer = setTimeout(() => {
  // ... guard checks ...
  const player = state.players.find((p) => p.seat === seat);
  const amountToCall = player ? Math.max(0, state.currentBet - (player.bet ?? 0)) : 0;
  const canCheck = amountToCall === 0;

  if (canCheck) {
    // No bet outstanding → auto-check (standard poker behavior)
    this.handController.performAction(seat, 'check');
    // Fallback to fold if check somehow fails
  } else {
    // Bet outstanding → auto-fold
    this.handController.performAction(seat, 'fold');
  }
}, safeDurationSeconds * 1000);
```

**Verified:** Re-read file after change ✅

---

### Summary of All Step 3 Changes

| Blocker | File | Lines | Change |
|---------|------|-------|--------|
| #1 Card Security | ServerTableEngine.ts | 604-635 | Added CARDS_DEALT handler → writes to table_hole_cards via RPC |
| #1 Card Security | ServerTableEngine.ts | 849 | Scrubbed hole cards from broadcast (showdown + not folded only) |
| #1 Card Security | TablePage.tsx | 1576-1591 | Fixed client card handling for scrubbed broadcasts |
| #2 Auto-Fold | ServerTableEngine.ts | 347-354 | Removed auto-fold catch, return error to client |
| #3 Timer | ServerTableEngine.ts | 192-230 | Auto-check when canCheck, auto-fold only when bet outstanding |

**Step 3 Status:** DEPLOYED to smarter.poker ✅ (World Hub commit: `chore: update Club Arena — Step 3 server blockers fixed`, 2026-03-25)

---

## Step 4 — PORT CORE (PreciseActionTimer, ServerActionValidator, StateVerifier)

### Phase: COMPLETED 2026-03-25

**3 new files created, 1 file modified.**

---

### Change #1 — Port PreciseActionTimer to server

**File:** `server/src/engine/PreciseActionTimer.ts` (NEW — 261 lines)
**Ported from:** `src/engine/PreciseActionTimer.ts` (233 lines)

**Purpose:** Deadline-based timer immune to CPU drift. Replaces unreliable `setTimeout`-based timers with absolute deadline timestamps checked via 100ms polling.

**Key adaptation from client version:**
- Removed `masterBus` dependency (client-side event bus)
- Added optional `onEvent` callback constructor parameter for logging
- Exported as `class PreciseActionTimer` (not singleton) — each ServerTableEngine gets its own instance
- Added `hasTimer()` method for checking timer existence
- Added typed `TimerEvent` and `TimerEventType` interfaces

**Public API:** `startTimer()`, `getRemainingMs()`, `getRemainingSec()`, `isExpired()`, `getDeadline()`, `extendTimer()`, `pauseTimer()`, `resumeTimer()`, `cancelTimer()`, `clearTable()`, `hasTimer()`, `dispose()`

**Verified:** File created and read back ✅

---

### Change #2 — Port ServerActionValidator to server

**File:** `server/src/engine/ServerActionValidator.ts` (NEW — 278 lines)
**Ported from:** `src/engine/ServerActionValidator.ts` (323 lines)

**Purpose:** Full action validation with 12 error codes — turn order, timing, duplicate suppression, amount bounds, stack sufficiency.

**Key adaptation from client version:**
- Removed `masterBus` dependency
- Added optional `onRejection` callback for logging rejected actions
- Exported as `class ServerActionValidator` (not singleton)
- Uses server `ActionType` from `../types.js` instead of custom type
- Added `RejectionEvent` interface for typed rejection callbacks

**Validation flow (5 steps):**
1. Turn order (NOT_YOUR_TURN)
2. Player state (ALREADY_FOLDED, ALREADY_ALL_IN)
3. Duplicate suppression (ALREADY_ACTED)
4. Timing check (ACTION_EXPIRED — 2s grace period)
5. Action-specific: fold/check/call/bet/raise/all_in

**Verified:** File created and read back ✅

---

### Change #3 — Port StateVerifier to server

**File:** `server/src/engine/StateVerifier.ts` (NEW — 263 lines)
**Ported from:** `src/engine/StateVerifier.ts` (275 lines)

**Purpose:** Game state integrity checking — chip conservation, no negative stacks, no duplicate cards, community card count vs stage, pot sanity.

**Key adaptation from client version:**
- Removed `masterBus` dependency
- Added optional `onViolation` callback for alerting on integrity failures
- Exported as `class StateVerifier` (not singleton)
- Uses server types `Card`, `SeatPlayer`, `HandStage` from `../types.js`
- Added `ViolationEvent` interface for typed violation callbacks

**6 integrity checks:** Chip conservation, negative stacks, duplicate cards, community card count, player counts, pot sanity

**Verified:** File created and read back ✅

---

### Change #4 — Integrate all 3 modules into ServerTableEngine

**File:** `server/src/engine/ServerTableEngine.ts` (MODIFIED — ~15 integration points)

**What changed:**

1. **Imports added (lines 18-21):** PreciseActionTimer, ServerActionValidator, StateVerifier, ValidationContext
2. **Instance variables (lines 91-94):** `preciseTimer`, `actionValidator`, `stateVerifier` — initialized in constructor with logging callbacks
3. **Constructor (lines 100-108):** Creates instances of all 3 modules with table-scoped logging
4. **stop() (lines 152-155):** Disposes all 3 modules on engine shutdown
5. **clearTurnTimer() (line 207):** Comment noting preciseTimer coordination
6. **startTurnTimer() (line 222):** Registers deadline with PreciseActionTimer alongside existing setTimeout
7. **handlePlayerAction() (lines 395-438):** ServerActionValidator validates before performAction — timing, duplicates, state, amounts
8. **handlePlayerAction() (line 440):** Cancels precise timer on successful action
9. **dealHand() (line 643-644):** Records initial chip totals via StateVerifier
10. **HAND_COMPLETE handler (lines 791-815):** Deducts rake, runs StateVerifier.verify(), cleans up validator and timer state

**Why:** The existing code had no action validation beyond basic turn checks, no deadline-based timers, and no state integrity verification. These 3 modules close those gaps.

**Verified:** Grep confirmed all 15 integration points present ✅

---

### Summary of All Step 4 Changes

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| server/src/engine/PreciseActionTimer.ts | NEW | 261 | Deadline-based timer, immune to drift |
| server/src/engine/ServerActionValidator.ts | NEW | 278 | 12-error-code action validation |
| server/src/engine/StateVerifier.ts | NEW | 263 | 6-check state integrity verification |
| server/src/engine/ServerTableEngine.ts | MODIFIED | ~30 added | Integration of all 3 modules |

**Deployed:** 2026-03-25 — Club Arena + World Hub pushed, Vercel auto-deployed.

---

## Step 5 — PORT SUPPORTING (TimeBankEngine, DisconnectEngine, PreActionEngine, AtomicStackService)

### Phase: IN PROGRESS 2026-03-25

**4 new files created, 1 file modified.**

---

### Change #1 — Port TimeBankEngine to server

**File:** `server/src/engine/TimeBankEngine.ts` (NEW — ~280 lines)
**Ported from:** `src/engine/TimeBankEngine.ts` (374 lines)

**Purpose:** Pool-based time bank system with configurable uses per session, auto-activate on timer expiry, and orbit-based refill support.

**Key adaptation from client version:**
- Removed `masterBus` dependency
- Removed `VIPService` / `requestExtension` (server doesn't need VIP gating)
- Constructor takes injected `PreciseActionTimer` instance (not singleton import)
- Added optional `onEvent` callback for logging
- Exported as `class TimeBankEngine` (not singleton)
- Uses `preciseTimer.startTimer(tableId, 'timebank:${playerId}', ...)` for countdown

**Public API:** `configure()`, `initializePlayer()`, `removePlayer()`, `onPrimaryTimerExpired()`, `activate()`, `playerActed()`, `onOrbitComplete()`, `getPlayerBank()`, `hasTimeBank()`, `getRemainingSeconds()`, `getUsesRemaining()`, `dispose()`, `disposeAll()`

---

### Change #2 — Port DisconnectEngine to server

**File:** `server/src/engine/DisconnectEngine.ts` (NEW — ~310 lines)
**Ported from:** `src/engine/DisconnectEngine.ts` (363 lines)

**Purpose:** Heartbeat-based disconnect detection with auto-fold/check on timeout, reconnection recovery, consecutive timeout tracking, and forced sit-out.

**Key adaptation from client version:**
- Removed `masterBus` dependency (6 event emissions replaced with callback)
- Constructor takes injected `PreciseActionTimer` instance
- Added optional `onEvent` callback with typed `DisconnectEvent` and `DisconnectEventType`
- Exported as `class DisconnectEngine` (not singleton)
- Added `disposeAll()` for full cleanup

**Public API:** `configure()`, `onAutoAction()`, `registerPlayer()`, `unregisterPlayer()`, `heartbeat()`, `markDisconnected()`, `onPlayerTurn()`, `cancelTimeout()`, `sitOut()`, `sitBack()`, `isConnected()`, `isSittingOut()`, `getState()`, `getConnectedPlayers()`, `dispose()`, `disposeAll()`

---

### Change #3 — Port PreActionEngine to server

**File:** `server/src/engine/PreActionEngine.ts` (NEW — ~270 lines)
**Ported from:** `src/engine/PreActionEngine.ts` (264 lines)

**Purpose:** Queued pre-actions (auto-fold, auto-check/fold, auto-check, auto-call, auto-call-any) that execute instantly when a player's turn arrives, with validation that the action is still legal.

**Key adaptation from client version:**
- Removed `masterBus` dependency (3 event emissions replaced with callback)
- Uses server `ActionType` from `../types.js` instead of client import
- Added optional `onEvent` callback with typed `PreActionEvent` and `PreActionEventType`
- Exported as `class PreActionEngine` (not singleton)
- Added `disposeAll()` for full cleanup

**Public API:** `setPreAction()`, `clearPreAction()`, `getPreAction()`, `hasPreAction()`, `executePreAction()`, `onBetPlaced()`, `clearTable()`, `dispose()`, `disposeAll()`

---

### Change #4 — Port AtomicStackService to server

**File:** `server/src/engine/AtomicStackService.ts` (NEW — ~240 lines)
**Ported from:** `src/engine/AtomicStackService.ts` (235 lines)

**Purpose:** Versioned optimistic locking for race-condition-proof stack mutations. Eliminates races between concurrent rebuy, cashout, and hand settlement.

**Key adaptation from client version:**
- Removed `masterBus` dependency (2 event emissions replaced with callback)
- Added optional `onEvent` callback with typed `StackEvent` and `StackEventType`
- Exported as `class AtomicStackService` (not singleton)

**Public API:** `getStackWithVersion()`, `initializeStack()`, `atomicDebit()`, `atomicCredit()`, `atomicSettle()`, `getTableStacks()`, `clearTable()`, `dispose()`

---

### Change #5 — Integrate all 4 modules into ServerTableEngine

**File:** `server/src/engine/ServerTableEngine.ts` (MODIFIED — ~40 lines added)

**What changed:**

1. **Imports added (lines 21-24):** TimeBankEngine, DisconnectEngine, PreActionEngine, AtomicStackService
2. **Instance variables (lines 100-104):** `timeBankEngine`, `disconnectEngine`, `preActionEngine`, `atomicStackService`
3. **Constructor (lines 120-131):** Creates instances of all 4 modules with table-scoped logging. TimeBankEngine and DisconnectEngine receive injected PreciseActionTimer.
4. **stop() (lines 157-161):** Disposes all 4 supporting modules on engine shutdown
5. **dealHand() (after line 644):** Initializes atomic stacks, time banks, and disconnect tracking for each player at hand start. Wires disconnect auto-action callback into HandController.
6. **handleTurnChange() — real player branch:** Pre-action check before starting timer. If pre-action executes successfully, turn completes instantly. Disconnect state check — if player is disconnected, DisconnectEngine handles auto-action via callback.
7. **HAND_COMPLETE handler:** Cleans up preActionEngine and timeBankEngine between hands. DisconnectEngine and AtomicStackService persist across hands.

**Why:** These 4 modules provide the full supporting infrastructure for server-authoritative play — time banks, disconnect handling, pre-queued actions, and race-condition-proof stack management.

---

### Summary of All Step 5 Changes

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| server/src/engine/TimeBankEngine.ts | NEW | ~280 | Pool-based time bank with auto-activate |
| server/src/engine/DisconnectEngine.ts | NEW | ~310 | Heartbeat disconnect detection + auto-fold |
| server/src/engine/PreActionEngine.ts | NEW | ~270 | Queued pre-actions with validation |
| server/src/engine/AtomicStackService.ts | NEW | ~240 | Versioned optimistic locking for stacks |
| server/src/engine/ServerTableEngine.ts | MODIFIED | ~40 added | Integration of all 4 modules |

**Deployed:** 2026-03-25 — Club Arena `96c6f4db` pushed, zero TypeScript errors.

---

## Step 6 — PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)

### Phase: IN PROGRESS 2026-03-25

**7 new files created + 1 dependency, 1 file modified.**

---

### Change #1 — Port CryptoRandom to server (dependency)

**File:** `server/src/engine/CryptoRandom.ts` (NEW — 93 lines)
**Ported from:** `src/engine/CryptoRandom.ts` (93 lines — identical)

**Purpose:** Cryptographically secure random number generator for Fisher-Yates shuffle. Needed by MonteCarloEquity.

**No adaptation needed** — already supports Node.js `crypto.randomInt()`.

**Exports:** `secureRandomInt()`, `secureRandom()`, `secureShuffle()`

---

### Change #2 — Port MonteCarloEquity to server

**File:** `server/src/engine/MonteCarloEquity.ts` (NEW — 122 lines)
**Ported from:** `src/engine/MonteCarloEquity.ts` (127 lines)

**Purpose:** Monte Carlo equity calculator for insurance premium calculations. Runs N simulations (default 1000) in <10ms.

**Key adaptation:** Updated imports to use server `Card` type from `../types.js`, server `PokerEngine.js` exports, and server `CryptoRandom.js`.

**No masterBus** — pure function, stateless.

---

### Change #3 — Port StraddleEngine to server

**File:** `server/src/engine/StraddleEngine.ts` (NEW — ~240 lines)
**Ported from:** `src/engine/StraddleEngine.ts` (247 lines)

**Purpose:** Auto-straddle and Mississippi straddle support for cash games.

**Key adaptation:** Removed 2 `masterBus.emit` calls → optional `onEvent` callback. Class export, not singleton. Added `disposeAll()`.

**Public API:** `configure()`, `toggleAutoStraddle()`, `isAutoStraddleOn()`, `processStraddles()`, `postManualStraddle()`, `getState()`, `dispose()`, `disposeAll()`

---

### Change #4 — Port MixedGameEngine to server

**File:** `server/src/engine/MixedGameEngine.ts` (NEW — ~210 lines)
**Ported from:** `src/engine/MixedGameEngine.ts` (230 lines)

**Purpose:** Automatic game variant rotation (HORSE, Hold'em/Omaha, custom sequences).

**Key adaptation:** Removed 1 `masterBus.emit` → optional `onEvent` callback. Uses server `GameVariant` type from `../types.js`. Class export, not singleton. Added `disposeAll()`.

**Presets:** HORSE, HOLDEM_OMAHA, HOLDEM_PLO5, DOUBLE_BOARD_ROTATION, OMAHA_VARIANTS

---

### Change #5 — Port RunItTwiceEngine to server

**File:** `server/src/engine/RunItTwiceEngine.ts` (NEW — ~290 lines)
**Ported from:** `src/engine/RunItTwiceEngine.ts` (316 lines)

**Purpose:** Dual-board (or triple-board) dealing for all-in scenarios with pot division.

**Key adaptation:** Removed 4 `masterBus.emit` calls → optional `onEvent` callback. Class export, not singleton. Added `disposeAll()`.

**Public API:** `configure()`, `isEnabled()`, `offer()`, `accept()`, `decline()`, `dealDualBoards()`, `resolve()`, `isActive()`, `getState()`, `dispose()`, `disposeAll()`

---

### Change #6 — Port InsuranceEngine to server

**File:** `server/src/engine/InsuranceEngine.ts` (NEW — ~275 lines)
**Ported from:** `src/engine/InsuranceEngine.ts` (291 lines)

**Purpose:** All-in equity insurance with Monte Carlo-based premium calculation.

**Key adaptation:** Removed 4 `masterBus.emit` calls → optional `onEvent` callback. Uses server `MonteCarloEquity.js` and server `Card` type. Class export, not singleton. Added `disposeAll()`.

**Premium formula:** `(1 - equity%) × insuredAmount × houseMargin`

---

### Change #7 — Port RakebackEngine to server

**File:** `server/src/engine/RakebackEngine.ts` (NEW — ~290 lines)
**Ported from:** `src/engine/RakebackEngine.ts` (301 lines)

**Purpose:** Weighted contributed rake tracking with volume-based tier system and Supabase persistence.

**Key adaptation:** Removed 2 `masterBus.emit` calls → optional `onEvent` callback. Replaced global `supabase` import with constructor-injected `SupabaseClient`. Class export, not singleton. Added `disposeAll()`.

**Tiers:** Bronze (5%), Silver (10%), Gold (15%), Platinum (20%), Diamond (25%), Elite (30%)

---

### Change #8 — Integrate all 7 modules into ServerTableEngine

**File:** `server/src/engine/ServerTableEngine.ts` (MODIFIED — ~50 lines added)

**What changed:**

1. **Imports added (lines 25-29):** StraddleEngine, MixedGameEngine, RunItTwiceEngine, InsuranceEngine, RakebackEngine
2. **Instance variables (lines 110-114):** 5 new private fields for advanced modules
3. **Constructor (lines 140-158):** Creates instances of all 5 modules with logging callbacks. RakebackEngine receives injected `supabase` client.
4. **stop():** Disposes all 5 advanced modules on engine shutdown
5. **HAND_COMPLETE handler:** Cleans up RIT and insurance between hands. Triggers mixedGameEngine rotation. Straddle, mixed game, and rakeback persist across hands.
6. **postHandTasks():** Records per-hand rake contributions to rakebackEngine after logRakeCollection.

---

### Summary of All Step 6 Changes

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| server/src/engine/CryptoRandom.ts | NEW | 93 | Cryptographic RNG (dependency) |
| server/src/engine/MonteCarloEquity.ts | NEW | 122 | Monte Carlo equity calculator |
| server/src/engine/StraddleEngine.ts | NEW | ~240 | UTG/Mississippi straddles |
| server/src/engine/MixedGameEngine.ts | NEW | ~210 | HORSE / variant rotation |
| server/src/engine/RunItTwiceEngine.ts | NEW | ~290 | Dual-board all-in dealing |
| server/src/engine/InsuranceEngine.ts | NEW | ~275 | All-in equity insurance |
| server/src/engine/RakebackEngine.ts | NEW | ~290 | Weighted rakeback tracking |
| server/src/engine/ServerTableEngine.ts | MODIFIED | ~50 added | Integration of all 7 modules |

**Next:** Run `npx tsc --noEmit` on server, commit, build, deploy to smarter.poker.
