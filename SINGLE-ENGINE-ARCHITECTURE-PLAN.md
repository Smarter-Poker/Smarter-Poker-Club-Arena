# SINGLE ENGINE ARCHITECTURE PLAN

## One Engine. One Truth. Hetzner VPS Server + Supabase Realtime.

**Date:** 2026-03-24
**Status:** APPROVED PLAN — Do not deviate.

---

## THE ARCHITECTURE (SIMPLE AND FINAL)

```
┌──────────────────────────────────────────────────────────────────┐
│                    HETZNER VPS SERVER (Node.js)                    │
│                    ========================                       │
│                                                                  │
│  GameServer                                                      │
│    ├── ServerTableEngine (1 per active table)                    │
│    │     ├── HandController (THE engine — deals, validates, runs)│
│    │     ├── DisconnectEngine (heartbeat, timeouts)              │
│    │     ├── PreActionEngine (auto-fold/check/call queue)        │
│    │     ├── TimeBankEngine (pool model, per-player)             │
│    │     ├── StraddleEngine (UTG/Mississippi)                    │
│    │     ├── RunItTwiceEngine (dual boards)                      │
│    │     ├── InsuranceEngine (equity, offers)                    │
│    │     ├── PreciseActionTimer (deadline-based)                 │
│    │     ├── StateVerifier (chip conservation between hands)     │
│    │     └── AtomicStackService (versioned stack mutations)      │
│    │                                                             │
│    ├── TournamentManager (per tournament)                        │
│    ├── HorseFleetManager                                         │
│    └── HorseLifecycleManager                                     │
│                                                                  │
│  HTTP Endpoints:                                                 │
│    POST /action     — player submits action                      │
│    POST /timebank   — player activates time bank                 │
│    POST /preaction  — player sets pre-action                     │
│    POST /insurance  — player accepts/declines insurance          │
│    POST /rit        — player accepts/declines run-it-twice       │
│    POST /sitout     — player sits out / sits in                  │
│    POST /showhand   — player shows/mucks at showdown             │
│    GET  /actions/:t/:u — available actions for player            │
│    GET  /state/:t   — current table state (initial load)         │
│    GET  /health     — health check                               │
│                                                                  │
│  Broadcasts (Supabase Realtime):                                 │
│    Channel: hand-state:{tableId}                                 │
│      → hand_state event (full table state, per-player card scrub)│
│    Channel: cards-secure:{tableId}:{userId}                      │
│      → hole_cards event (player's own cards only)                │
│    Channel: table-events:{tableId}                               │
│      → action_popup, timer_update, time_bank_activated,          │
│        insurance_offer, rit_offer, showdown_reveal,              │
│        winner_announcement, hand_complete                        │
└──────────────────────────────────────────────────────────────────┘
              │                              │
              │ HTTP POST (actions)          │ Supabase Realtime (state)
              │                              │
              ▼                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    CLIENT (React SPA — Dumb Terminal)             │
│                    =====================================          │
│                                                                  │
│  TablePage.tsx                                                   │
│    ├── subscribeToHandState() — receives authoritative state     │
│    ├── subscribeToHoleCards() — receives own cards securely      │
│    ├── subscribeToTableEvents() — receives UI events             │
│    ├── submitAction() — sends action to server via HTTP          │
│    ├── ActionPanel — renders available actions from server state  │
│    ├── SeatSlot[] — renders player state from server data        │
│    ├── CommunityCards — renders board from server data           │
│    ├── PotDisplay — renders pot from server data                 │
│    ├── TimerBar — renders countdown from server timestamps       │
│    └── All animations/sounds/haptics triggered by state diffs    │
│                                                                  │
│  ZERO game logic. ZERO HandController. ZERO local engine.        │
│  Client NEVER decides what the game state is.                    │
│  Client ONLY renders what the server tells it.                   │
└──────────────────────────────────────────────────────────────────┘
              │
              │ Supabase (PostgreSQL)
              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    DATABASE (Supabase PostgreSQL)                 │
│                    ================================               │
│                                                                  │
│  tables, table_seats, table_settings                             │
│  hand_history, hand_actions                                      │
│  tournaments, tournament_players                                 │
│  wallets, wallet_transactions                                    │
│  rake_collections                                                │
│  player_stats, achievements, vip_levels                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## WHAT GETS REMOVED FROM THE CLIENT

### A. Client-Side Engine Code to DELETE from TablePage.tsx

These are the specific poisonous patterns that must be surgically removed:

| Line(s)    | What                                                                                          | Why it's poison                                                       |
| ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 74         | `import { timeBankEngine } from '../engine/TimeBankEngine'`                                   | Client-side TB — server handles this                                  |
| 118        | `import { Deck, compareHands, calculatePots, determineWinners } from '../engine/PokerEngine'` | Client should never run game logic                                    |
| 119        | `import { HandController } from '../engine/HandController'`                                   | THE root cause — client has its own engine                            |
| 120        | `import { serverActionValidator } from '../engine/ServerActionValidator'`                     | Validation happens on server only                                     |
| 121        | `import { RakeWaterfallEngine } from '../engines/financial/RakeWaterfallEngine'`              | Rake is server-side                                                   |
| 122        | `import { OFCPineappleEngine } from '../engine/OFCPineappleEngine'`                           | Game logic is server-side                                             |
| 132        | `import { monteCarloEquity } from '../engine/MonteCarloEquity'`                               | Equity calc can stay for display only, but MUST NOT affect game state |
| 2708       | `const [handController, setHandController] = useState<HandController \| null>(null)`          | Local engine state                                                    |
| 2711       | `const handControllerRef = useRef<HandController \| null>(null)`                              | Local engine ref — 48 references throughout file                      |
| 2712       | `const handInProgressRef = useRef(false)`                                                     | Local hand tracking                                                   |
| 2727-2813  | Entire HandController creation block                                                          | Creates local engine with own deck, own cards                         |
| 2919-3300  | `handleHandEvent` block                                                                       | Processes LOCAL engine events — all of this is server's job           |
| 3034-3200  | Horse AI decision block in handleHandEvent                                                    | Horse decisions happen on server                                      |
| 3516       | `handControllerRef.current = null`                                                            | Cleanup of thing that shouldn't exist                                 |
| 3838-3860  | `broadcastLocalHandState()` definition                                                        | Client broadcasting "authoritative" state                             |
| 3870-3890  | `handleTimerAutoFold` with local performAction                                                | Client running auto-fold logic                                        |
| 3943-3960  | `validateAndExecuteAction`                                                                    | Client validating actions locally                                     |
| 4005-4020  | `handleFold` with local performAction + broadcastLocalHandState                               | Dual engine pattern                                                   |
| 4022-4043  | `handleCheck` with local performAction + broadcastLocalHandState                              | Dual engine pattern                                                   |
| 4045-4066  | `handleCall` with local performAction + broadcastLocalHandState                               | Dual engine pattern                                                   |
| 4068-4100  | `handleBet` with local state reads                                                            | Client reading local engine                                           |
| 4114-4206  | `handleActionPanelAction` with ALL local performAction calls                                  | The mega dual-engine function                                         |
| 4225-4247  | `handleRaiseConfirm` with local performAction                                                 | Dual engine pattern                                                   |
| 4253-4281  | `handleAllIn` with local performAction                                                        | Dual engine pattern                                                   |
| 4379-4410  | Insurance/RIT flows reading local engine state                                                | Should come from server                                               |
| 4526, 4547 | `handControllerRef.current?.getState()` for UI reads                                          | Should read from server state                                         |
| 4995, 5034 | Additional engine state reads                                                                 | Should use server state                                               |

**Total: ~48 handControllerRef usages + ~15 broadcastLocalHandState calls + all surrounding logic must be rewritten.**

### B. Client-Side Engine Files — Classification

| File                                   | Verdict                                   | Reason                                                    |
| -------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `src/engine/HandController.ts`         | MOVE TO SERVER                            | This is the richer version — port features to server's HC |
| `src/engine/HeadlessTableEngine.ts`    | DELETE (server has ServerTableEngine)     | Redundant with server                                     |
| `src/engine/CashGameOrchestrator.ts`   | DELETE (server has discoverCashTables)    | Redundant with server                                     |
| `src/engine/TournamentEngine.ts`       | DELETE (server has TournamentManager)     | Redundant with server                                     |
| `src/engine/TournamentOrchestrator.ts` | DELETE (server has discoverTournaments)   | Redundant with server                                     |
| `src/engine/SpinItEngine.ts`           | DELETE (server handles spins)             | Redundant with server                                     |
| `src/engine/FlashPoolEngine.ts`        | EVALUATE — may need server equivalent     |                                                           |
| `src/engine/PokerEngine.ts`            | MOVE TO SERVER (merge with server's copy) | Core math — server-only                                   |
| `src/engine/TimeBankEngine.ts`         | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/DisconnectEngine.ts`       | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/PreActionEngine.ts`        | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/PreciseActionTimer.ts`     | MOVE TO SERVER                            | Replace server's setTimeout                               |
| `src/engine/StateVerifier.ts`          | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/AtomicStackService.ts`     | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/ServerActionValidator.ts`  | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/StraddleEngine.ts`         | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/RunItTwiceEngine.ts`       | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/InsuranceEngine.ts`        | MOVE TO SERVER                            | Server needs this                                         |
| `src/engine/HorseLogic.ts`             | ALREADY ON SERVER                         | Keep server copy                                          |
| `src/engine/HorseBrainAdapter.ts`      | DELETE (server has HorseLogic)            | Redundant                                                 |
| `src/engine/MixedGameEngine.ts`        | MOVE TO SERVER                            | Server needs for rotation                                 |
| `src/engine/ChipRaceEngine.ts`         | MOVE TO SERVER                            | Tournament chip race                                      |
| `src/engine/TableBalancer.ts`          | MOVE TO SERVER                            | Tournament table balancing                                |
| `src/engine/TableBreakEngine.ts`       | MOVE TO SERVER                            | Tournament break management                               |
| `src/engine/OFCPineappleEngine.ts`     | MOVE TO SERVER                            | OFC is server-side                                        |
| `src/engine/OFCDealingOrchestrator.ts` | MOVE TO SERVER                            | OFC dealing is server-side                                |
| `src/engine/MonteCarloEquity.ts`       | KEEP ON CLIENT (display only)             | Equity display doesn't affect game state                  |
| `src/engine/HandReplayEngine.ts`       | KEEP ON CLIENT                            | Replay is a client feature                                |
| `src/engine/EngineTelemetry.ts`        | MOVE TO SERVER                            | Telemetry should be server-side                           |
| `src/engine/RakebackEngine.ts`         | MOVE TO SERVER                            | Financial calc is server-side                             |
| `src/engine/CryptoRandom.ts`           | MOVE TO SERVER                            | Crypto shuffle is server-side                             |
| `src/engine/demo.ts`                   | DELETE                                    | Dev demo only                                             |
| `src/engine/index.ts`                  | REWRITE (only export client-safe modules) |                                                           |

### C. Other Client Files Importing Engine (need audit/cleanup)

| File                                     | Action                                                               |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `src/pages/FlashPoolPage.tsx`            | Remove engine imports, make server-driven                            |
| `src/services/RakeService.ts`            | Evaluate — if just display math, keep; if game logic, move to server |
| `src/services/HydraService.ts`           | Evaluate — likely needs refactoring                                  |
| `src/services/BBJService.ts`             | Bad beat jackpot — trigger should be server-side                     |
| `src/services/FinancialCronService.ts`   | Should run server-side                                               |
| `src/services/HandPersistenceService.ts` | Server already has logHandHistory — remove client version            |

---

## WHAT GETS ADDED/UPGRADED ON THE SERVER

### Phase 1: Port Missing Engines to Server (THE BLOCKING WORK)

The server currently has 4 engine files. It needs ~15 more. These get ported from `src/engine/` to `server/src/engine/`:

| Priority | Engine                    | Port From                           | What It Does                                           |
| -------- | ------------------------- | ----------------------------------- | ------------------------------------------------------ |
| P0       | **Card Security**         | NEW                                 | Scrub cards from broadcast, per-player secure delivery |
| P0       | **DisconnectEngine**      | src/engine/DisconnectEngine.ts      | Heartbeat, timeout, auto-sit-out                       |
| P0       | **PreciseActionTimer**    | src/engine/PreciseActionTimer.ts    | Replace setTimeout with deadline-based timer           |
| P1       | **PreActionEngine**       | src/engine/PreActionEngine.ts       | Auto-fold/check/call queue                             |
| P1       | **TimeBankEngine**        | src/engine/TimeBankEngine.ts        | Pool model, per-player tracking                        |
| P1       | **StateVerifier**         | src/engine/StateVerifier.ts         | Chip conservation between hands                        |
| P1       | **ServerActionValidator** | src/engine/ServerActionValidator.ts | Full validation (replace auto-fold-on-error)           |
| P2       | **StraddleEngine**        | src/engine/StraddleEngine.ts        | UTG/Mississippi straddles                              |
| P2       | **RunItTwiceEngine**      | src/engine/RunItTwiceEngine.ts      | Dual/triple board support                              |
| P2       | **InsuranceEngine**       | src/engine/InsuranceEngine.ts       | Equity calc, offer/accept flow                         |
| P2       | **AtomicStackService**    | src/engine/AtomicStackService.ts    | Versioned stack mutations                              |
| P3       | **MixedGameEngine**       | src/engine/MixedGameEngine.ts       | Variant rotation per orbit                             |
| P3       | **ChipRaceEngine**        | src/engine/ChipRaceEngine.ts        | Tournament chip denomination                           |
| P3       | **TableBalancer**         | src/engine/TableBalancer.ts         | Tournament table balancing                             |
| P3       | **OFCPineappleEngine**    | src/engine/OFCPineappleEngine.ts    | OFC game variant                                       |

### Phase 2: Upgrade Server HandController

The server's HandController (500 lines) is a stripped-down version. It needs features from the client's richer version (800 lines):

| Feature                      | Current Server Status           | Required Action                    |
| ---------------------------- | ------------------------------- | ---------------------------------- |
| BBA (Big Blind Ante)         | Missing                         | Add to postBlinds()                |
| Straddle integration         | Missing                         | Wire StraddleEngine                |
| RIT integration              | Missing                         | Wire RunItTwiceEngine              |
| Insurance integration        | Missing                         | Wire InsuranceEngine               |
| ALL_IN_RUNOUT_PENDING event  | Missing                         | Emit before runOutCommunityCards() |
| Showdown muck/show logic     | Missing                         | Add showdown procedure             |
| Hi-Lo split                  | In PokerEngine, not wired in HC | Wire evaluateOmahaLowHand          |
| Short all-in reopening check | Unclear                         | Verify in isBettingRoundComplete   |
| minRaise tracking            | Basic                           | Ensure full Bible compliance       |

### Phase 3: Upgrade Server Broadcast

The broadcast must be SECURE and COMPLETE:

**Current broadcast (broken):**

```typescript
// ServerTableEngine.ts line 775-797
broadcastHandState(this.tableId, {
  players: state.players.map((p) => ({
    cards: p.cards ?? [], // ← EXPOSES ALL CARDS
  })),
});
```

**Required broadcast (secure):**

```typescript
// Scrubbed public state — everyone gets this
broadcastHandState(this.tableId, {
    table_id, hand_number, pot, community_cards,
    current_bet, current_player, dealer_seat, stage,
    min_raise, last_raise,
    turn_start_time_ms, turn_duration_ms,
    pots: [...],
    action_history: [...],  // NEW — clients need this for display
    players: state.players.map(p => ({
        seat, user_id, username, stack, bet,
        is_folded, is_all_in, is_sitting_out,
        cards: [],  // ← NEVER send other players' cards
        // At showdown: include cards for non-folded players
        // (or only winners if auto_muck enabled)
    })),
});

// Per-player secure card delivery — each player gets ONLY their cards
for (const player of state.players) {
    if (player.cards.length > 0 && !player.is_folded) {
        broadcastSecureCards(this.tableId, player.user_id, player.cards);
    }
}
```

### Phase 4: New HTTP Endpoints

| Endpoint             | Purpose                         | Current Status                          |
| -------------------- | ------------------------------- | --------------------------------------- |
| `POST /action`       | Submit action                   | EXISTS — needs auth + better validation |
| `POST /timebank`     | Activate time bank              | EXISTS — needs per-hand limits          |
| `GET /actions/:t/:u` | Available actions               | EXISTS                                  |
| `GET /health`        | Health check                    | EXISTS                                  |
| `POST /preaction`    | Set pre-action                  | NEW                                     |
| `POST /insurance`    | Accept/decline insurance        | NEW                                     |
| `POST /rit`          | Accept/decline RIT              | NEW                                     |
| `POST /sitout`       | Sit out / sit in                | NEW                                     |
| `POST /showhand`     | Show/muck at showdown           | NEW                                     |
| `GET /state/:t`      | Full table state (initial load) | NEW                                     |
| `POST /heartbeat`    | Player heartbeat for disconnect | NEW                                     |

---

## WHAT THE CLIENT BECOMES

### TablePage.tsx — The Dumb Terminal

After cleanup, TablePage.tsx does EXACTLY this and NOTHING more:

```typescript
// 1. SUBSCRIBE to server state on mount
useEffect(() => {
    // Main hand state (scrubbed — no other players' cards)
    subscribeToHandState(tableId, (state) => {
        setTableState(mapServerStateToUI(state));
        detectStateChanges(prevState, state, playAnimations);
    });

    // Secure hole cards (only YOUR cards)
    subscribeToSecureCards(tableId, userId, (cards) => {
        setMyCards(cards);
    });

    // Table events (for popups/animations)
    subscribeToTableEvents(tableId, (event) => {
        handleTableEvent(event);  // plays sounds, shows popups
    });
}, [tableId, userId]);

// 2. SEND actions via HTTP (and WAIT)
const handleAction = async (action, amount?) => {
    setActionPending(true);  // show "pending" state
    const result = await GameServerAPI.submitAction(tableId, userId, action, amount);
    if (!result.success) {
        showError(result.error);  // show error to player
    }
    setActionPending(false);
    // DO NOT update local state — wait for server broadcast
};

// 3. RENDER from server state
return (
    <Table>
        {tableState.players.map(p => <SeatSlot {...p} />)}
        <CommunityCards cards={tableState.communityCards} />
        <PotDisplay pot={tableState.pot} />
        <DealerButton seat={tableState.dealerSeat} />
        <TimerBar
            startTime={tableState.turnStartTimeMs}
            duration={tableState.turnDurationMs}
        />
        {isMyTurn && (
            <ActionPanel
                actions={tableState.availableActions}
                onAction={handleAction}
                disabled={actionPending}
            />
        )}
    </Table>
);
```

That's it. No HandController. No Deck. No PokerEngine. No broadcastLocalHandState. No performAction. No validateAction. The client draws pictures and sends button clicks.

---

## EXECUTION ORDER (PHASES)

### Phase 0: Preparation (Do First, Break Nothing)

1. Port all missing engine files to `server/src/engine/`
2. Upgrade server HandController with missing features
3. Add new HTTP endpoints
4. Add secure card broadcast
5. Add `GET /state/:t` for initial table state load
6. Test server standalone (can it deal hands, process actions, broadcast correctly?)

### Phase 1: Cut the Client Engine (The Surgery)

1. Remove ALL `src/engine/` imports from TablePage.tsx except MonteCarloEquity (display only)
2. Remove `handControllerRef`, `handInProgressRef`, `handController` state
3. Remove entire HandController creation block (lines ~2727-2813)
4. Remove `broadcastLocalHandState()` function and ALL calls
5. Remove ALL `handControllerRef.current.performAction()` calls
6. Remove `handleHandEvent` block (lines ~2919-3300)
7. Remove `validateAndExecuteAction` function
8. Rewrite `handleFold/handleCheck/handleCall/handleBet/handleRaise/handleAllIn` to ONLY call `submitAction()` and wait for result
9. Rewrite `handleActionPanelAction` to ONLY call `submitAction()` and wait
10. Rewrite `handleTimerAutoFold` — timer is server-side now, client just shows countdown
11. Remove all `startTransition(() => performAction(...))` patterns

### Phase 2: Wire Client to Server

1. Make `subscribeToHandState` the ONLY source of game state
2. Add `subscribeToSecureCards` for per-player hole card delivery
3. Add `subscribeToTableEvents` for popup/animation triggers
4. Make ActionPanel derive available actions from server state
5. Make timer countdown derive from `turn_start_time_ms` + `turn_duration_ms`
6. Make `submitAction` async/await (not fire-and-forget)
7. Add loading/pending states while waiting for server response
8. Handle server errors gracefully (show error, don't auto-fold)

### Phase 3: Clean Up

1. Remove unused `src/engine/` files (HeadlessTableEngine, CashGameOrchestrator, etc.)
2. Update `src/engine/index.ts` to only export client-safe modules
3. Remove `broadcastHandState` export from `src/lib/supabase.ts` (client should never broadcast game state)
4. Clean up FlashPoolPage.tsx
5. Clean up service files that imported engine modules
6. Run `npx tsc --noEmit` — fix ALL type errors
7. Build and deploy

### Phase 4: Verify Against Bible v8

1. Trace complete action flow end-to-end against Bible Law 1.3
2. Verify card security against Bible 4.6
3. Verify timer behavior against Bible Chapter 6
4. Verify settlement against Bible Law 1.9
5. Update COMPLIANCE-TRACKER.md with new statuses
6. Run edge case scenarios from Bible Chapter 7

---

## ACTION FLOW — WHAT IT LOOKS LIKE WHEN DONE

```
Player clicks "Raise $50" in ActionPanel
    │
    ▼
Client: submitAction(tableId, userId, 'raise', 50)
    │   → HTTP POST to Hetzner VPS server /action
    │   → Client shows "pending" spinner on ActionPanel
    │   → Client WAITS for response
    │
    ▼
Server: POST /action handler (index.ts)
    │   → Parse body: { tableId, userId, action: 'raise', amount: 50 }
    │   → Get engine: gameServer.getTableEngine(tableId)
    │   → Call: engine.handlePlayerAction(userId, 'raise', 50)
    │
    ▼
ServerTableEngine.handlePlayerAction()
    │   → ServerActionValidator validates:
    │       ✓ Player exists at table
    │       ✓ It's this player's turn
    │       ✓ 'raise' is legal (currentBet > 0)
    │       ✓ Amount >= minRaise
    │       ✓ Amount <= maxRaise (stack)
    │       ✓ Not a duplicate submission
    │       ✓ Within timer + grace period
    │   → Clear turn timer
    │   → HandController.performAction(seat, 'raise', 50)
    │       → Updates pot, bets, stacks, currentBet
    │       → Records action in history
    │       → Calls advanceGame() → determines next player
    │       → Emits PLAYER_ACTION event
    │       → Emits TURN_CHANGE event
    │   → Return { success: true } to HTTP response
    │
    ▼
ServerTableEngine.handleHandEvent(PLAYER_ACTION)
    │   → Record action for hand history
    │   → broadcastCurrentState() [SCRUBBED — no other players' cards]
    │
    ▼
ServerTableEngine.handleHandEvent(TURN_CHANGE)
    │   → Start PreciseActionTimer for next player
    │   → broadcastCurrentState() [includes turn_start_time_ms, turn_duration_ms]
    │
    ▼
Supabase Realtime → ALL clients receive hand_state broadcast
    │
    ▼
Client A (the raiser): subscribeToHandState callback fires
    │   → Updates tableState from server data
    │   → Sees pot increased, their bet changed, turn moved to next player
    │   → ActionPanel disappears (not their turn)
    │   → Pending spinner clears
    │   → Animation: chips slide to pot
    │   → Sound: raise chip sound
    │   → Haptic: medium
    │
Client B (next to act): subscribeToHandState callback fires
    │   → Updates tableState from server data
    │   → Sees it's now their turn
    │   → ActionPanel appears with: Fold, Call $50, Raise (slider)
    │   → Timer countdown starts from server timestamps
    │   → Sound: "your turn" alert
    │   → Haptic: medium pulse
    │
Client C (spectator): subscribeToHandState callback fires
    │   → Updates tableState, sees raise animation
    │   → No action panel (not their turn)
```

---

## NON-NEGOTIABLE RULES

1. **The client NEVER creates a HandController instance**
2. **The client NEVER calls performAction()**
3. **The client NEVER broadcasts game state**
4. **The client NEVER validates actions** (except basic UI guards like "is it my turn?")
5. **The client NEVER generates cards, shuffles decks, or evaluates hands** for live game state
6. **The client ONLY sends HTTP requests and renders server broadcasts**
7. **The server NEVER sends other players' hole cards in broadcasts**
8. **The server NEVER auto-folds on validation errors** — it returns errors
9. **The server uses deadline-based timers, not setTimeout**
10. **Every game state change originates from the server and only the server**

---

## FILE INVENTORY — FINAL STATE

### Server (`server/src/`)

```
server/src/
├── index.ts                    — HTTP server + GameServer orchestrator
├── types.ts                    — All server types
├── engine/
│   ├── HandController.ts       — THE hand lifecycle engine (upgraded)
│   ├── PokerEngine.ts          — Core math: evaluation, pots, rake, winners
│   ├── ServerTableEngine.ts    — Per-table orchestrator (upgraded)
│   ├── HorseLogic.ts           — Horse AI decisions
│   ├── DisconnectEngine.ts     — NEW: heartbeat disconnect tracking
│   ├── PreciseActionTimer.ts   — NEW: deadline-based action timer
│   ├── PreActionEngine.ts      — NEW: pre-action queue
│   ├── TimeBankEngine.ts       — NEW: pool-model time bank
│   ├── StraddleEngine.ts       — NEW: UTG/Mississippi straddles
│   ├── RunItTwiceEngine.ts     — NEW: dual/triple board
│   ├── InsuranceEngine.ts      — NEW: equity + offer flow
│   ├── StateVerifier.ts        — NEW: chip conservation check
│   ├── AtomicStackService.ts   — NEW: versioned stack mutations
│   ├── ServerActionValidator.ts— NEW: full action validation
│   └── CryptoRandom.ts         — NEW: crypto shuffle
├── services/
│   ├── supabase.ts             — DB + Realtime (upgraded broadcast)
│   ├── HorseFleetManager.ts
│   ├── HorseLifecycleManager.ts
│   ├── AutoRebuyService.ts
│   └── TournamentRecurringService.ts
```

### Client (`src/`) — Engine directory after cleanup

```
src/engine/
├── MonteCarloEquity.ts         — KEEP: display-only equity estimation
├── HandReplayEngine.ts         — KEEP: replay is client feature
├── index.ts                    — REWRITE: only export above two
│
│ Everything else: DELETED or already lives on server
```

### Client (`src/pages/TablePage.tsx`) — After cleanup

```
- ZERO imports from src/engine/ (except MonteCarloEquity if needed)
- ZERO HandController references
- ZERO broadcastLocalHandState calls
- ZERO performAction calls
- ALL state comes from subscribeToHandState
- ALL actions go through submitAction (async/await, NOT fire-and-forget)
```
