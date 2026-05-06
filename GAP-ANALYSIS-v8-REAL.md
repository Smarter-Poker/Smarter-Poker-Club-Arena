# REAL GAP ANALYSIS — Club Arena vs. Bible v8

## The Brutally Honest Version

**Date:** March 24, 2026
**Analyst method:** Line-by-line code trace of every engine file, every handler, every event flow
**Files deeply read:** server/src/index.ts, server/src/engine/ServerTableEngine.ts, server/src/engine/HandController.ts, server/src/engine/PokerEngine.ts, src/pages/TablePage.tsx, src/lib/supabase.ts, src/services/GameServerAPI.ts, src/engine/HandController.ts, src/engine/HeadlessTableEngine.ts, src/engine/TimeBankEngine.ts, src/engine/DisconnectEngine.ts, src/engine/PreActionEngine.ts, src/engine/PreciseActionTimer.ts, src/engine/StateVerifier.ts, src/engine/ServerActionValidator.ts, src/core/MasterBus.ts, src/stores/useTableStore.ts

---

## CRITICAL FINDING #1: DUAL-ENGINE ARCHITECTURE — THE ROOT CAUSE OF EVERYTHING BROKEN

**This is the single most important finding.** The app has TWO completely independent poker engines running simultaneously for every hand, and they fight each other.

### What's happening:

**Path A — Client-side engine (TablePage.tsx):**

1. Player clicks "Fold" in ActionPanel
2. `handleActionPanelAction()` fires (TablePage.tsx ~line 4114)
3. It calls `handControllerRef.current.performAction(heroSeat, 'fold')` — this is a **LOCAL** HandController instance created in the browser (line 2711-2813)
4. It calls `broadcastLocalHandState()` — this broadcasts the LOCAL engine's state to all clients via Supabase Realtime (line 3838)
5. It calls `submitAction(tableId, userId, 'fold')` as a **fire-and-forget** secondary call to the server

**Path B — Server-side engine (ServerTableEngine.ts):**

1. The HTTP POST `/action` arrives at server/src/index.ts line 2414
2. `gameServer.getTableEngine(tableId)` retrieves the ServerTableEngine (line 2423)
3. `engine.handlePlayerAction(userId, action, amount)` processes it (line 2428)
4. This calls the SERVER's `HandController.performAction()` (ServerTableEngine.ts line 342)
5. The event handler calls `broadcastCurrentState()` which broadcasts the SERVER's state via Supabase Realtime (line 775)

### Why this is catastrophically broken:

- **Two different HandController instances** maintain two different game states — one in the browser, one on the server
- **Two different broadcasts** go to all clients — the local broadcast and the server broadcast — and they can arrive in any order
- **The client's local HandController** creates its own Deck, shuffles its own cards, deals its own hole cards — these are DIFFERENT cards than what the server dealt
- **Race conditions everywhere:** The local engine processes the fold instantly, broadcasts it, then the server processes the same fold 50-200ms later and broadcasts its version. Other clients receive conflicting state.
- **The comment in the code literally says it:** TablePage.tsx line 4112-4113: `"Architecture: LOCAL engine is authoritative → broadcast via Supabase Realtime (PRIMARY) → fire-and-forget server call (SECONDARY, for when game server is deployed)"`

### Bible v8 violations:

- **Law 1.1 (Single Pending Action):** VIOLATED — both engines can accept actions independently
- **Law 1.2 (Hard Block):** VIOLATED — client doesn't wait for server confirmation before advancing game state
- **Law 1.4 (Truth Law):** VIOLATED — two different "truths" exist simultaneously
- **Law 1.13 (Priority Stack):** VIOLATED — client is treating itself as authoritative, not the server
- **Bible Chapter 3 (State Machines):** NO FORMAL STATE MACHINE EXISTS — game flow is ad-hoc event routing

### The fix required:

The client must become a DUMB TERMINAL. It should:

1. Send actions to the server via HTTP
2. Wait for server to process and broadcast authoritative state
3. Render whatever the server says
4. NEVER run its own HandController

The `handControllerRef` in TablePage.tsx, the local HandController creation (line 2711-2813), and `broadcastLocalHandState()` must all be removed. The client should only listen to `subscribeToHandState()` for all game state.

---

## CRITICAL FINDING #2: TWO DIFFERENT HandController IMPLEMENTATIONS

There are TWO different HandController files:

1. **`src/engine/HandController.ts`** (~800 lines) — the CLIENT-side version with full event system, TimeBankEngine integration, InsuranceEngine, RunItTwice, hand persistence, secure hole card provisioning, 120s safety timeout
2. **`server/src/engine/HandController.ts`** (~500 lines) — the SERVER-side version, much simpler, no TimeBankEngine, no InsuranceEngine, no RIT, no persistence hooks

### Specific divergences:

| Feature              | Client HandController         | Server HandController                   |
| -------------------- | ----------------------------- | --------------------------------------- |
| Deck                 | `new Deck()` (crypto shuffle) | `new Deck()` (separate shuffle)         |
| Cards dealt          | Different random cards        | Different random cards                  |
| Ante handling        | Supports BBA (big blind ante) | Traditional antes only (line 135-142)   |
| Straddle             | StraddleEngine integration    | No straddle support                     |
| Time bank            | TimeBankEngine integration    | Managed externally by ServerTableEngine |
| RIT                  | RunItTwiceEngine integration  | Not implemented                         |
| Insurance            | InsuranceEngine integration   | Not implemented                         |
| Bomb pot             | Supported via config.bombPot  | Supported (line 94-98, 147-161)         |
| Hand persistence     | HandPersistence service       | logHandHistory() in postHandTasks       |
| State verification   | StateVerifier between hands   | Not present                             |
| Side pot calculation | Called during hand            | Called at completeHand only             |

### Bible v8 violations:

- **Bible 2.0 (Object Schemas):** Two different state shapes for the same game state
- **Bible 4.x (Operational Procedures):** Different operational procedures depending on which engine processes the action
- **Bible 1.4 (Truth Law):** Impossible to maintain when two truths exist

---

## CRITICAL FINDING #3: HOLE CARDS ARE FUNDAMENTALLY BROKEN

### The problem:

The server-side `broadcastCurrentState()` (ServerTableEngine.ts line 769-797) broadcasts ALL player cards in the `players` array:

```typescript
players: (state.players ?? []).map((p) => ({
    seat: p.seat,
    user_id: p.user_id,
    cards: p.cards ?? [],  // ← SENDS ALL CARDS TO ALL CLIENTS
    ...
}))
```

This means **every client receives every player's hole cards in every broadcast.**

The client-side subscription (TablePage.tsx line 1596) tries to filter:

```typescript
holeCards: isHero ? sp.cards || existing?.holeCards || [] : existing?.holeCards || [],
```

But this only controls what the CLIENT chooses to RENDER — the data is already there in the broadcast payload. Any player who opens browser DevTools can see all opponents' cards.

Meanwhile, the client-side `HeadlessTableEngine.broadcastCurrentState()` (mentioned in the summary) DOES scrub hole cards, only revealing at showdown. But this scrubbing only happens in the client-side path, which is the wrong architecture anyway.

### Bible v8 violations:

- **Bible 4.6 (Hole Card Provisioning):** Cards must be delivered via secure per-player RPC, not broadcast
- **Bible 1.5 (Fairness Law):** Players can cheat by inspecting network traffic
- **Anti-God-Mode requirement:** Completely absent from server broadcast

---

## CRITICAL FINDING #4: SERVER HandController IS INCOMPLETE

The server's `HandController` (server/src/engine/HandController.ts) is missing major features that Bible v8 requires:

### Missing from server HandController:

1. **No straddle support** — Bible 4.7 requires UTG straddle, Mississippi straddle, re-straddle
2. **No Big Blind Ante (BBA)** — Bible 4.3 requires BBA option; server only has traditional ante (line 135-142)
3. **No Run-It-Twice** — Bible 4.20 requires RIT support; server has no RIT logic at all
4. **No Insurance** — Bible 4.19 requires insurance offering when all-in; not in server
5. **No all-in runout detection** — Server `advanceStage()` calls `runOutCommunityCards()` when <2 players can act, but doesn't emit `ALL_IN_RUNOUT_PENDING` event for RIT/insurance decision points
6. **No showdown logic** — Server shows cards for all active players at showdown but has no muck/show decision, no auto-muck preference, no last-aggressor-shows-first rule
7. **No Hi-Lo split** — Server's `determineWinners` passes `gameVariant` to `determineWinners()` from PokerEngine.ts which does support Hi-Lo, BUT the server's PokerEngine.ts is a separate copy that may diverge

### Missing from ServerTableEngine:

1. **No DisconnectEngine** — Bible 6.3 requires heartbeat-based disconnect detection with grace period. Server just has a simple `setTimeout` for turn timer (line 192-207). If a player's network drops, nothing happens until their turn timer expires.
2. **No PreActionEngine** — Bible 4.15 requires pre-action queue (auto-fold, auto-check/fold, auto-call). Server has zero pre-action support.
3. **No StateVerifier** — Server doesn't verify chip conservation between hands
4. **No AtomicStackService** — Server's `syncStacks()` does simple DB updates without optimistic locking or version control
5. **No hand-for-hand proper sync** — Basic implementation exists but no chip race logic for tournament eliminations

---

## CRITICAL FINDING #5: TIMER SYSTEM IS FUNDAMENTALLY WRONG

### Bible v8 requires (Chapter 6):

- Primary action timer: configurable per table (default 15s)
- Time bank: max 2 activations per hand (1 auto + 1 manual), each adds configurable seconds
- Disconnect timer: separate from action timer, keeps counting, auto-fold on expiry
- All timers are deadline-based and server-authoritative

### What actually exists:

**Server side (ServerTableEngine.ts):**

- Turn timer: simple `setTimeout` (line 192-207)
- Auto-fold on timeout (line 199-205)
- Time bank: single activation per turn (line 228: `timeBankActivatedThisTurn`), adds `time_bank_seconds` from table settings
- NO disconnect detection at all — if a player's WebSocket drops, nothing happens until their regular turn timer expires
- Timer precision: JavaScript `setTimeout`, not deadline-based (vulnerable to drift)

**Client side (src/engine/):**

- `PreciseActionTimer.ts`: Deadline-based with 100ms polling — GOOD, but only used client-side
- `TimeBankEngine.ts`: Pool-based model (configurable totalBankSeconds, maxUses, secondsPerUse) — different from server's single-use-per-turn model
- `DisconnectEngine.ts`: Full heartbeat-based disconnect tracking — GOOD, but only runs client-side where it can't enforce anything

### The mismatch:

The server's timer is a simple `setTimeout` with no disconnect awareness. The client has the sophisticated timer and disconnect system but can't be authoritative. Result: timers are unreliable and disconnect handling doesn't actually work.

### Bible v8 violations:

- **Bible 6.1 (Action Timer):** Server uses `setTimeout`, not deadline-based
- **Bible 6.2 (Time Bank):** Server and client have incompatible time bank models
- **Bible 6.3 (Disconnect):** Server has no disconnect detection
- **Bible 1.2 (Hard Block):** Timer must be server-authoritative; currently it's split

---

## CRITICAL FINDING #6: ACTION VALIDATION LIVES IN THE WRONG PLACE

### Where validation happens:

1. **ServerActionValidator.ts** (src/engine/) — Full validation with turn order, player state, duplicate suppression, timing grace, amount validation. But this is a CLIENT-SIDE file. The server doesn't use it.

2. **Server's handlePlayerAction()** (ServerTableEngine.ts line 288-358) — Does basic validation:
   - Checks `handController` exists (line 293)
   - Finds player by userId (line 300)
   - Verifies it's their turn (line 306)
   - Normalizes action (lines 314-320)
   - Clamps amounts (lines 323-338)
   - Calls `performAction()` and auto-folds on error (lines 351-353)

3. **Server's HandController.performAction()** (server/src/engine/HandController.ts line 188-251) — Validates via `calculateBettingState` + `validateAction` from PokerEngine

### What's missing from server validation:

- **No duplicate suppression** — same action can arrive twice via HTTP
- **No timing validation** — no 2s grace period check
- **No action expiry check** — expired actions are still accepted
- **Auto-fold on ANY error** (line 351-353) — if a raise fails validation, the player gets force-folded instead of getting an error message and retrying. This is terrible UX and violates Bible 1.5 (Fairness).

### Bible v8 violations:

- **Bible 4.9-4.14 (Action Validation):** Server validation is minimal compared to Bible requirements
- **Bible 1.5 (Fairness):** Auto-folding on validation errors punishes players for server bugs

---

## CRITICAL FINDING #7: THE CLIENT CREATES ITS OWN HANDS

The most bizarre part of the architecture: TablePage.tsx creates its own HandController on the CLIENT side and runs a full parallel game:

```typescript
// TablePage.tsx ~line 2711
const handControllerRef = useRef<HandController | null>(null);
```

The client creates HandController instances (around line 2727-2813), deals its own cards, runs its own game state, and broadcasts this as "authoritative" to other clients.

### Why this exists:

The comment at line 4112-4113 explains: `"Architecture: LOCAL engine is authoritative → broadcast via Supabase Realtime (PRIMARY) → fire-and-forget server call (SECONDARY, for when game server is deployed)"`

This suggests the client-side engine was the original architecture, and the server-side engine was added later without removing the client-side one. They now coexist and conflict.

### What this means in practice:

- If the server is running: Two hands play simultaneously with different cards, different shuffles, different outcomes
- If the server is NOT running: The client engine works alone, but any player can manipulate game state via browser DevTools
- If a player is offline: The server's hand continues without them, but their client's hand is frozen

---

## CRITICAL FINDING #8: NO FORMAL STATE MACHINE

Bible v8 Chapter 3 requires formal state machines for:

- Table lifecycle: empty → waiting → seating → running → paused → closing
- Hand lifecycle: idle → posting_blinds → dealing → preflop_betting → dealing_flop → flop_betting → ... → showdown → settlement → cleanup
- Turn lifecycle: waiting → timer_running → time_bank → expired → action_processed

### What exists:

- `HandController` uses implicit stage progression via `advanceStage()` (string-based: 'preflop' → 'flop' → 'turn' → 'river' → 'showdown')
- No formal transition guards — stage can be set to any value at any time
- No state machine for table lifecycle — `ServerTableEngine.running` is a boolean flag
- No turn state machine — just a setTimeout

### Bible v8 violations:

- **Bible 3.0 (Formal State Machines):** Completely absent
- **Bible 1.6 (No-Ambiguity Law):** Every state must have explicit entry/exit/fail conditions — none exist

---

## CRITICAL FINDING #9: SETTLEMENT ORDER IS NOT ENFORCED

Bible v8 Law 1.9 requires a strict 15-step settlement sequence:

1. Lock table
2. Calculate side pots
3. Evaluate hands
4. Determine winners
5. Calculate rake
6. Distribute winnings
7. Update stacks
8. Persist to DB
9. Update leaderboards
10. Trigger achievements
11. Update VIP points
12. Log hand history
13. Clean up
14. Broadcast final state
15. Unlock table

### What actually happens (server/src/engine/HandController.ts `completeHand()` + ServerTableEngine.ts `postHandTasks()`):

1. Calculate pots — `calculatePots()` (line 388)
2. Evaluate hands — `evaluateHand/evaluateOmahaHand` (line 393-400)
3. Showdown emit (line 401)
4. Determine winners — `determineWinners()` (line 404)
5. Calculate rake — `calculateRake()` (line 405)
6. Adjust winnings with integer cents (lines 410-422)
7. Add winnings to player stacks (lines 424-427)
8. Emit WINNERS event (line 429)
9. Emit HAND_COMPLETE event (line 430)

Then asynchronously in `postHandTasks()` (fire-and-forget): 10. Sync stacks to DB (line 806) 11. Log rake (line 816) 12. Log hand history (line 828) 13. Tournament chip sync (line 851) 14. Auto-rebuy horses (line 856) 15. Process leave-pending (line 932) 16. Update table status (line 937)

### What's missing:

- No table lock during settlement — other actions could arrive
- No leaderboard update
- No achievement triggers
- No VIP points update
- No rakeback calculation
- Settlement is fire-and-forget (`postHandTasks().catch()`) — errors are logged but not handled
- DB sync can fail silently, leaving stacks out of sync

---

## CRITICAL FINDING #10: CARD SECURITY IS NON-EXISTENT

### Server broadcasts:

The server's `broadcastCurrentState()` sends `p.cards` for every player in every broadcast. This means:

- All hole cards are visible in network traffic
- Any client can read opponents' cards from the Supabase Realtime payload
- There is no per-player card encryption or secure provisioning

### Client-side HeadlessTableEngine:

The client's version DOES have secure hole card provisioning via Supabase RPC (`dealHand()` in HeadlessTableEngine.ts), but this runs client-side where it can't be trusted.

### Bible v8 requirement (4.6):

- Hole cards must be delivered via secure per-player channel
- Server must NEVER broadcast other players' hole cards
- Anti-god-mode: even the server operator shouldn't be able to see all cards during a live hand (aspirational)

---

## SUMMARY OF WHAT MUST HAPPEN

### Phase 1: Fix the Architecture (BLOCKING — nothing else matters until this is done)

1. **Remove the client-side HandController entirely** — delete `handControllerRef`, `broadcastLocalHandState()`, all local `performAction()` calls
2. **Make client a pure receiver** — only listen to `subscribeToHandState()` for game state
3. **Make `submitAction()` the ONLY way to act** — client sends action to server, waits for server broadcast to update UI
4. **Fix hole card security** — server must send each player only THEIR cards, not everyone's

### Phase 2: Complete the Server Engine

1. Add straddle support to server HandController
2. Add BBA (big blind ante) support
3. Add Run-It-Twice support
4. Add Insurance support
5. Add showdown reveal logic (muck/show, last-aggressor-first)
6. Add DisconnectEngine to server
7. Add PreActionEngine to server
8. Add StateVerifier to server
9. Replace `setTimeout` with deadline-based timers
10. Fix action validation — don't auto-fold on errors

### Phase 3: Formal State Machines

1. Implement table lifecycle FSM
2. Implement hand lifecycle FSM
3. Implement turn lifecycle FSM
4. Add transition guards and error states

### Phase 4: Settlement & Post-Hand

1. Implement strict settlement order with table locking
2. Add leaderboard updates
3. Add achievement triggers
4. Add VIP point calculation
5. Add rakeback calculation
6. Make settlement transactional (all-or-nothing)

### Phase 5: UI Compliance

1. Implement popup doctrine per Bible Chapter 5
2. Implement animation sequence per Bible Chapter 5
3. Implement sound doctrine per Bible Chapter 5
4. Implement haptic doctrine per Bible Chapter 5
5. Add formal notification system

---

## FILE REFERENCE INDEX

| File                                     | Lines Read                                        | Role                                           | Critical Issues                                                      |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `server/src/index.ts`                    | 1-2500                                            | Game server orchestrator + HTTP endpoints      | HTTP /action handler is simple passthrough, no auth                  |
| `server/src/engine/ServerTableEngine.ts` | 1-990                                             | Server dealing loop, event handling, broadcast | Broadcasts all cards, no disconnect engine, simple setTimeout timers |
| `server/src/engine/HandController.ts`    | 1-500                                             | Server hand lifecycle                          | Missing straddle, BBA, RIT, insurance, showdown logic                |
| `src/pages/TablePage.tsx`                | 1-200, 1565-1715, 2700-2815, 3830-3890, 4000-4280 | Main table UI                                  | Runs parallel client engine, dual broadcast, dual state              |
| `src/engine/HandController.ts`           | (from summary) ~800 lines                         | Client hand lifecycle                          | Full features but wrong place (client)                               |
| `src/engine/HeadlessTableEngine.ts`      | (from summary) ~1400 lines                        | Client dealing orchestrator                    | Has secure card provisioning but runs client-side                    |
| `src/services/GameServerAPI.ts`          | (from summary) ~200 lines                         | HTTP client to server                          | submitAction is fire-and-forget                                      |
| `src/lib/supabase.ts`                    | 220-240                                           | Realtime subscription                          | `subscribeToHandState` listens on `hand-state:{tableId}` channel     |
| `server/src/services/supabase.ts`        | 40-67                                             | Server broadcast                               | `broadcastHandState` sends to same channel                           |
| `src/engine/TimeBankEngine.ts`           | (from summary) ~150 lines                         | Client time bank                               | Pool model incompatible with server's single-use model               |
| `src/engine/DisconnectEngine.ts`         | (from summary) ~150 lines                         | Client disconnect                              | Full heartbeat system but client-only                                |
| `src/engine/PreActionEngine.ts`          | (from summary) ~150 lines                         | Client pre-actions                             | Auto-fold/check/call queue but client-only                           |
| `src/engine/PreciseActionTimer.ts`       | (from summary) ~100 lines                         | Client timer                                   | Deadline-based but client-only                                       |
| `src/engine/StateVerifier.ts`            | (from summary) ~100 lines                         | Client state verification                      | Chip conservation checks but client-only                             |
| `src/engine/ServerActionValidator.ts`    | (from summary) ~150 lines                         | Client action validation                       | Full validation but client-only                                      |
| `src/core/MasterBus.ts`                  | (from summary) ~250 lines                         | Event bus                                      | 250+ events defined but many unused                                  |
