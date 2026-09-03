# HORSE SYSTEM E2E VERIFICATION — BUG REPORT

**Date:** 2026-03-11
**Scope:** Complete end-to-end trace of table creation → horse seating → hand dealing → decision making → pot resolution → rake/BBJ collection → next hand

---

## CRITICAL BUGS (Severity: CRITICAL)

### BUG #1: HeadlessTableEngine - Incomplete Hand Result Processing

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 679-695
**Severity:** CRITICAL

**Issue:**
In `handleHandEvent()`, when processing the `HAND_COMPLETE` event, the code calls `HorseBrainAdapter.processHandResult()` with incomplete/placeholder data. Specifically:

- `chipDelta: 0` for all players (should calculate actual delta from initial stack - final stack)
- `showedCards: true` always (incorrect for players who folded)
- `folded: false` always (incorrect, should reflect actual fold status)
- `invested: 0` always (should reflect actual investment)

This means the Horse AI Brain's 32 anti-exploit modules are being fed FALSE data, so they cannot learn correctly.

**Code:**

```typescript
HorseBrainAdapter.processHandResult(
  this.tableId,
  this.tableInfo?.big_blind || 2,
  stage,
  this.currentHandPotSize,
  players.map((p) => ({
    user_id: p.user_id,
    chipDelta: 0, // ← WRONG: should be (initial - final) stack
    showedCards: true, // ← WRONG: hardcoded
    folded: false, // ← WRONG: hardcoded
    invested: 0, // ← WRONG: should track actual investment
  })),
  this.currentHandWinnerIds
).catch(() => {});
```

**Impact:**

- Horse AI cannot learn from hand results
- Anti-exploit modules receive corrupted training data
- No adaptation over time

**Fix:**
Calculate and pass real values:

```typescript
players.map((p) => {
  const enginePlayer = state.players.find((ep) => ep.user_id === p.user_id);
  return {
    user_id: p.user_id,
    chipDelta: p.stack - enginePlayer?.stack || 0,
    showedCards: enginePlayer?.showedCards || false,
    folded: enginePlayer?.is_folded || false,
    invested: enginePlayer?.totalInvested || 0,
  };
});
```

---

### BUG #2: RakeService - Missing Club ID in Distributed Hand Rake

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/RakeService.ts`
**Line:** 351-424 (distributeHandRake method)
**Severity:** CRITICAL

**Issue:**
The `distributeHandRake()` method extracts `clubId` from `players[0]?.clubId`, but the `DealtInPlayer` interface does NOT have a `clubId` field being passed from HeadlessTableEngine. This causes the rake_generated updates to silently fail.

**Code (Line 384):**

```typescript
const clubId = players[0]?.clubId; // ← clubId is undefined
if (clubId) {
  // ← This check fails, so no rake is attributed
  for (const attr of attributions) {
    // ... updates to club_members table
  }
}
```

**Impact:**

- Rake is collected from pots but NEVER attributed to players
- club_members.rake_generated is not updated
- Player earnings/commission tracking is broken

**Fix:**
Pass `clubId` from HeadlessTableEngine to executeWaterfall():

```typescript
// In HeadlessTableEngine.executeRakeWaterfall():
const dealtInPlayers: DealtInPlayer[] = players.map((p) => ({
  userId: p.user_id,
  agentId: undefined, // fetch if applicable
  clubId: this.tableInfo?.club_id!, // ← ADD THIS
  isSittingOut: false,
  hasCards: true,
  wentToFlop: this.currentHandWentToFlop,
}));
```

---

### BUG #3: HydraService - Floating Point Delay Calculation

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/HydraService.ts`
**Line:** 645-647
**Severity:** CRITICAL

**Issue:**
In `onRealPlayerLeft()`, the delay calculation converts seconds to milliseconds twice:

```typescript
const delay = randomInRange(
  this.config.entryDelayRange[0] * 1000, // Already converts sec → ms
  this.config.entryDelayRange[1] * 1000 // Already converts sec → ms
);
// But entryDelayRange is already in seconds, so delay is now SECONDS not MS
```

Then it's used directly in setTimeout (which expects milliseconds):

```typescript
setTimeout(() => {
  this.seedTable(tableId, bigBlind);
}, delay); // ← Delay is 10,000-90,000 seconds = 2.7-25 hours!
```

Compare with correct implementation in `seedTable()` (line 347-350):

```typescript
const delay = randomInRange(this.config.entryDelayRange[0], this.config.entryDelayRange[1]) * 1000; // Convert sec → ms
```

**Impact:**

- When a real player leaves, horses take 2.7-25 HOURS to reseed
- Table stays empty and unplayable for extended periods
- Contradicts "24/7 liquidity" design

**Fix:**

```typescript
async onRealPlayerLeft(tableId: string, bigBlind: number): Promise<void> {
    const status = await this.getTableLiquidityStatus(tableId);

    if (status.needsMoreHorses) {
        const delay = randomInRange(
            this.config.entryDelayRange[0],
            this.config.entryDelayRange[1]
        ) * 1000; // ← Correct: convert seconds to ms

        setTimeout(() => {
            this.seedTable(tableId, bigBlind);
        }, delay);
    }
}
```

---

### BUG #4: HeadlessTableEngine - Stack Sync Promise Never Awaited

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 630-656
**Severity:** CRITICAL

**Issue:**
The `stackSyncPromise` is created as a fire-and-forget async block but is not awaited before the next hand begins. In `dealNextHand()` (line 354-357), it checks:

```typescript
if (this.stackSyncPromise) {
  await this.stackSyncPromise;
  this.stackSyncPromise = null;
}
```

However, the assignment at line 631:

```typescript
this.stackSyncPromise = (async () => {
  // Sync stacks to database
  // ... but this is slow, can take 100-300ms
})();
```

The problem is that `this.stackSyncPromise` is set AFTER the event handler returns (async), so there's a race condition. If the next hand deals before the promise resolves, the `await` in `dealNextHand()` will catch it, but the data might be stale.

**Real Issue:** The stack sync Promise contains a `.catch(() => {})` that silently swallows errors. If the stack sync fails, the next hand loads STALE stacks from the database.

**Code (Line 658-663):**

```typescript
// Sync tournament player chips AFTER table_seats are written
if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
  try {
    await this.syncTournamentPlayerChips(players);
  } catch (err) {
    console.error(`...Tournament chip sync error:`, err);
    // ← Error is logged but hand continues with stale data
  }
}
```

**Impact:**

- Tournament tables can have chip count mismatches between table_seats and tournament_players
- If stack sync fails, next hand may deal with incorrect stacks
- Difficult to debug because errors are hidden

**Fix:**
Make stack sync failures throw and propagate up to the dealing loop:

```typescript
this.stackSyncPromise = (async () => {
  try {
    await this.syncStacksToDatabase(players);
  } catch (err) {
    console.error(`[HeadlessTableEngine:${this.tableId}] Stack sync FAILED:`, err);
    // Retry once
    await new Promise((r) => setTimeout(r, 500));
    await this.syncStacksToDatabase(players); // ← Throw if retry fails
  }

  // Tournament sync
  if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
    await this.syncTournamentPlayerChips(players); // ← Throw if fails
  }
})();
```

---

## HIGH-SEVERITY BUGS (Severity: HIGH)

### BUG #5: BotLogic - Invalid Bet Sizes When Stack is Low

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/BotLogic.ts`
**Line:** 320
**Severity:** HIGH

**Issue:**
In `playNuttedHand()`, when betting with nuts:

```typescript
const betSize = Math.trunc(pot * (0.6 + Math.random() * 0.2) * sizeMult);
return { action: 'bet', amount: Math.min(stack, Math.max(betSize, gs.minRaise)), thinkTime: 0 };
```

The `Math.min(stack, ...)` caps the bet to the stack, but this creates an all-in-like situation unintentionally. If `betSize` happens to be 60% of pot but player only has enough for 55%, the bet is silently capped down, which looks suspicious to opponents.

More critically: the code does NOT check if the resulting amount is achievable. If `betSize > stack`, the capped amount equals stack, making it look like an all-in when it's just a value bet.

**Impact:**

- Bet sizing looks unnatural (capped sizes)
- AI behavior becomes exploitable (opponents see suspicious all-in sizing)

**Fix:**

```typescript
if (betSize >= stack * 0.95) {
  action = 'allin';
  amount = undefined;
} else {
  amount = Math.min(stack, Math.max(betSize, gs.minRaise));
}
```

---

### BUG #6: RakeService - BBJ Contribution Can Be Null

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/RakeService.ts`
**Line:** 257-277
**Severity:** HIGH

**Issue:**
In `executeWaterfall()`, at line 260-269:

```typescript
const pool = await BBJService.getPool({ unionId, clubId });
if (pool) {
    const result = await BBJService.recordContribution({...});
    bbjContributed = result !== null;
    if (!result) {
        console.warn(`[RakeService] BBJ contribution returned null...`);
    }
}
```

If the pool doesn't exist OR `recordContribution()` fails, `bbjContributed` is set to `false`. But the waterfall returns this flag without any action taken. The BBJ money is GONE — dropped from the pot but never allocated to any pool.

**Impact:**

- BBJ money can disappear
- Audit trail shows money was collected but not contributed to any pool
- Violates financial integrity

**Fix:**
Ensure pool exists before attempting contribution:

```typescript
let bbjContributed = false;
if (calculation.bbjDrop > 0) {
    let pool = await BBJService.getPool({ unionId, clubId });

    // Auto-create pool if missing (backward compatibility)
    if (!pool && clubId) {
        pool = await BBJService.ensurePoolExists(clubId);
    }

    if (pool) {
        const result = await BBJService.recordContribution({...});
        bbjContributed = result !== null;
        if (!result) {
            throw new Error(`BBJ contribution failed for hand ${handId}`);
        }
    } else {
        throw new Error(`No BBJ pool found for club ${clubId}`);
    }
}
```

---

### BUG #7: HorseBrainAdapter - Missing Error Handling in Brain Load

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HorseBrainAdapter.ts`
**Line:** 156
**Severity:** HIGH

**Issue:**
In `initialize()`, after successfully loading the brain, it calls:

```typescript
await this.brain!.warmGTOCache();
```

But if this throws an error, it's swallowed by the try/catch block (line 162), causing the brain to be marked as available even though the GTO cache failed to warm up. This means later calls to `getDecision()` will expect GTO data that was never loaded.

**Code (Line 155-161):**

```typescript
// Warm GTO cache on startup
await this.brain!.warmGTOCache();

// Load horse IDs
this.horseIds = await this.brain!.loadHorseIds();

console.log(`[HorseBrainAdapter] HorsePokerBrain loaded — ${this.horseIds.size} horses registered`);
```

If `warmGTOCache()` fails silently, the brain is marked available but GTO features won't work.

**Impact:**

- GTO integration partially broken
- Brain thinks it's ready but critical data missing
- Unpredictable decision quality

**Fix:**

```typescript
try {
  // Warm GTO cache on startup — CRITICAL
  await this.brain!.warmGTOCache();

  // Load horse IDs
  this.horseIds = await this.brain!.loadHorseIds();

  this.brain = loadedBrain;
  this.brainAvailable = true;

  console.log(
    `[HorseBrainAdapter] HorsePokerBrain loaded — ${this.horseIds.size} horses registered`
  );
} catch (initErr) {
  console.error(
    '[HorseBrainAdapter] Brain initialization failed (GTO warmup, horse IDs, etc.):',
    initErr
  );
  this.brainAvailable = false;
  // Fall through to BotLogic
}
```

---

### BUG #8: AutoRebuyService - Concurrent Rebuy Key Uses Wrong Format

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/AutoRebuyService.ts`
**Line:** 260
**Severity:** HIGH

**Issue:**
In `reseatHorse()`, the concurrency check uses:

```typescript
const reseatKey = `reseat:${horseId}:${tableId}`;
// ...
this.rebuyInProgress.add(reseatKey);
```

But in `rebuyHorse()`, it uses:

```typescript
const rebuyKey = `${horseId}:${tableId}`;
```

These are DIFFERENT formats. So a reseat and rebuy can happen concurrently for the same horse:table combo because the keys don't match. This can cause:

1. Double deductions from wallet
2. Double stack updates
3. Orphaned seat records

**Impact:**

- Horses can be double-rebuyed
- Wallet balance goes negative
- Seat records become inconsistent

**Fix:**
Use consistent key format:

```typescript
private getHorseLockKey(horseId: string, tableId: string): string {
    return `${horseId}:${tableId}`;
}

async rebuyHorse(horseId: string, tableId: string, amount: number): Promise<boolean> {
    const rebuyKey = this.getHorseLockKey(horseId, tableId);
    if (this.rebuyInProgress.has(rebuyKey)) return false;
    this.rebuyInProgress.add(rebuyKey);
    try { ... }
    finally { this.rebuyInProgress.delete(rebuyKey); }
}

async reseatHorse(horseId: string, tableId: string): Promise<boolean> {
    const reseatKey = this.getHorseLockKey(horseId, tableId);
    if (this.rebuyInProgress.has(reseatKey)) return false;
    this.rebuyInProgress.add(reseatKey);
    try { ... }
    finally { this.rebuyInProgress.delete(reseatKey); }
}
```

---

## MEDIUM-SEVERITY BUGS (Severity: MEDIUM)

### BUG #9: HeadlessTableEngine - Hand Timeout Doesn't Clean Pending Timers

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 475-486
**Severity:** MEDIUM

**Issue:**
When a hand times out after 120 seconds, the code does clean up pending horse AI timers (line 478-481). However, if the timeout fires while a horse decision is being processed, the timer might get added AFTER cleanup, orphaning it.

The issue is that `this.pendingTimerIds` is cleaned on the main timeout, but a concurrent horse decision could be adding a new timer at the same moment, creating a race condition.

**Code:**

```typescript
const handCompleteTimeout = setTimeout(() => {
  console.warn(`[HeadlessTableEngine:${this.tableId}] Hand ${handNumber} timed out...`);
  for (const timerId of this.pendingTimerIds) {
    cancelWorkerTimeout(timerId);
  }
  this.pendingTimerIds = []; // ← Race condition: concurrent horse decision might add timer
  this.handController = null;
  resolve();
}, 120_000);
```

**Impact:**

- Memory leak from orphaned horse AI timers
- Over time, the worker timeout pool fills up
- System becomes sluggish

**Fix:**
Mark hand as invalidated instead of relying on timer cleanup:

```typescript
let handInvalidated = false;

const handCompleteTimeout = setTimeout(() => {
  handInvalidated = true;
  for (const timerId of this.pendingTimerIds) {
    cancelWorkerTimeout(timerId);
  }
  this.pendingTimerIds = [];
  this.handController = null;
  resolve();
}, 120_000);

// In horse decision handler:
const timerId = workerTimeout(() => {
  if (handInvalidated || !handControllerRef) return; // ← Check flag
  // ... perform action
}, thinkTime);
```

---

### BUG #10: BBJService - compareKickers Has Array Length Mismatch Issue

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/BBJService.ts`
**Line:** 378-387
**Severity:** MEDIUM

**Issue:**
In `compareKickers()`:

```typescript
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const aKicker = a[i] || 0;
  const bKicker = b[i] || 0;
  // ...
}
```

If array `a` has kickers [14, 13, 12] and array `b` has [14, 13], comparing index 2 will use `0` for b, making it appear that `a` wins. This is incorrect — missing kickers should not be treated as 0 (which is invalid for card ranks).

**Impact:**

- BBJ trigger logic can be incorrect
- Wrong hands might trigger BBJ
- Wrong hands might be excluded

**Fix:**

```typescript
compareKickers(a: number[], b: number[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    // Longer array is better (more kickers)
    return a.length - b.length;
}
```

---

### BUG #11: BotLogic - Hand Strength Never Used for Postflop Weak Hands

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/BotLogic.ts`
**Line:** 296-298
**Severity:** MEDIUM

**Issue:**
In `decidePostflop()`, weak hands (< 0.30 strength) are passed to `playWeakHand()`, but within that function (line 446-450), there's a specific check:

```typescript
if (strength > 0.2 && toCall < pot * 0.3 && Math.random() < 0.08) {
  return { action: 'call', amount: toCall, thinkTime: 0 };
}
```

The problem: `strength` is in range [0.00, 0.30), and we check if `strength > 0.20`. But for many hands, this range is so small that the probability is essentially zero. This means bluff catches almost NEVER happen.

The deeper issue: `strength` is calculated once at line 144-146 and never recalculated for postflop streets. It uses preflop hand strength, not postflop strength.

**Impact:**

- Postflop decisions use PREFLOP hand strength
- River decisions are based on stale data
- Missing flop/turn outs means hand strength is wildly inaccurate

**Fix:**
Recalculate hand strength before postflop decision:

```typescript
private static decidePostflop(...): BotDecision {
    // Recalculate hand strength for this street
    const strength = this.calculateHandStrength(
        player.cards, gs.communityCards, gs.stage, gs.gameVariant
    );
    // Rest of logic...
}
```

---

### BUG #12: HydraService - Organic Recede Checks needsFewerHorses But Removes Any Horse

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/HydraService.ts`
**Line:** 628-635
**Severity:** MEDIUM

**Issue:**
In `onRealPlayerJoined()`:

```typescript
if (status.needsFewerHorses && status.horsePlayers > 0) {
  const horses = await this.getActiveHorses(tableId);
  const horseToRemove = horses.find((h) => !h.leavingAfterOrbit);

  if (horseToRemove) {
    await this.scheduleHorseRemoval(tableId, horseToRemove.id, playerId);
  }
}
```

The problem: `needsFewerHorses` is true when `realPlayers >= 3 && horsePlayers > 0`. So with 3 real players and 2 horses, it tries to remove 1 horse. But it removes the FIRST horse found with `find()`. There's no logic to remove the horse that just arrived OR the one that's been there longest.

According to "Organic Recede law," we should remove the horse that joined MOST RECENTLY, not the first one found.

**Impact:**

- Wrong horse gets removed
- Removing the wrong horse breaks seating arrangements
- Player experience is worse

**Fix:**

```typescript
const horses = await this.getActiveHorses(tableId);
// Sort by joinedAt descending (most recent first)
horses.sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime());

const horseToRemove = horses.find((h) => !h.leavingAfterOrbit);
```

---

## LOW-SEVERITY BUGS (Severity: LOW)

### BUG #13: HeadlessTableEngine - chipDelta in processHandResult Always 0

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 689
**Severity:** LOW

**Issue:**
Duplicate of BUG #1 (already listed above).

---

### BUG #14: RakeService - Union Total Rake Update Doesn't Check Union Exists

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/RakeService.ts`
**Line:** 280-297
**Severity:** LOW

**Issue:**
If `unionId` is provided but doesn't exist, the query silently fails. The waterfall continues without error, so rake is collected but never attributed to the union's total.

**Impact:**

- Union rake tracking is incomplete
- Audit logs show inconsistency

**Fix:**
Check union exists or log error explicitly.

---

### BUG #15: AutoRebuyService - No Check for Negative Topup Amount

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/AutoRebuyService.ts`
**Line:** 386
**Severity:** LOW

**Issue:**
In `topUpWallet()`, if `currentBalance > this.minWalletBalance`, the topup amount is:

```typescript
const topupAmount = this.minWalletBalance - currentBalance;
```

If `currentBalance` is 100,000 and `minWalletBalance` is 50,000, topup is NEGATIVE (-50,000). The code doesn't validate this before calling the RPC.

**Impact:**

- Wallet could be debited instead of credited
- Edge case but breaks if min ever decreases

**Fix:**

```typescript
if (currentBalance >= requiredAmount && currentBalance >= this.minWalletBalance) {
  return true; // No topup needed
}

const topupAmount = Math.max(0, this.minWalletBalance - currentBalance);
if (topupAmount === 0) return true; // Already above threshold
```

---

### BUG #16: BotLogic - Variance Calculation Can Be Negative

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/BotLogic.ts`
**Line:** 151-153
**Severity:** LOW

**Issue:**

```typescript
const variance = Math.random() * 0.1 - 0.05; // Range: -0.05 to 0.05
const effectiveStrength = Math.max(0, Math.min(1, handStrength + variance));
```

This is actually fine (clamped to 0-1). But it could be clearer. Minor readability issue.

**Impact:** None significant, but could be written more clearly.

---

## GAPS & INCOMPLETE CODE PATHS

### GAP #1: No Validation of Dealer Seat Rotation

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 452-456

**Issue:**
When rotating the dealer button (line 452-456):

```typescript
this.dealerSeatIndex = this.dealerSeatIndex % players.length;
const dealerSeat = players[this.dealerSeatIndex].seat_number;
this.currentHandDealerSeat = dealerSeat;
this.dealerSeatIndex++;
```

There's no validation that `players[this.dealerSeatIndex].seat_number` actually exists in the game engine's player array. If seat_number is 5 but there are only 3 players, the engine might crash or calculate positions incorrectly.

**Fix:**
Validate seat numbers before using:

```typescript
const dealerIndex = this.dealerSeatIndex % players.length;
const dealerSeat = players[dealerIndex].seat_number;

// Verify dealer seat exists in engine
const dealerExists = hcPlayers.some((p) => p.seat === dealerSeat);
if (!dealerExists) {
  console.error(`[HeadlessTableEngine] Dealer seat ${dealerSeat} not found in players`);
  return;
}
```

---

### GAP #2: Tournament Auto-Blinds Never Applied

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 275-289

**Issue:**
`refreshBlinds()` is called before each hand (line 362), but it only reads blinds from the database. There's NO logic to automatically ADVANCE blind levels on a schedule (e.g., every 20 minutes or N hands).

The code loads tournament_id and checks if it's a tournament, but there's no integration with a tournament blind scheduler.

**Impact:**

- Tournament blind levels won't advance
- Hands will continue at same blinds forever
- Tournament will never end

**Fix:**
Integrate with a tournament blind scheduler or add automatic advancement logic.

---

### GAP #3: No Validation That Hand Completed Successfully

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 493-519

**Issue:**
After `handController!.start()` is called (line 526), the code waits for a `HAND_COMPLETE` event. But there's no validation that the event actually came from THIS hand.

If two hands somehow start concurrently or events get mixed up, the wrong event could resolve the promise, causing hand state to be corrupted.

**Fix:**
Include hand number in events:

```typescript
if (event.type === 'HAND_COMPLETE' && event.handNumber === handNumber) {
  // Resolve
}
```

---

### GAP #4: No Check for Minimum Betting Unit

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/BotLogic.ts`
**Line:** 788-802

**Issue:**
When validating bet amounts in HeadlessTableEngine (line 788-802), there's no check for minimum betting units. On some games, the minimum bet might be 1 cent, and the code could try to bet fractional cents.

**Impact:**

- Potential for sub-cent bets
- Database precision issues

---

## SECURITY & RACE CONDITIONS

### RACE CONDITION #1: Stack Sync and Next Hand Deal

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/engine/HeadlessTableEngine.ts`
**Line:** 354-358, 630-656

**Issue:**
The `stackSyncPromise` is a fire-and-forget async operation. Between when it completes and when the next hand loads players, a real player could leave or join, causing the loaded player list to be stale.

**Impact:**

- Hand might deal with wrong player counts
- Seating positions might be invalid

**Fix:**
Make stack sync part of the hand completion event, not separate.

---

### RACE CONDITION #2: Concurrent HydraService.seatHorse Calls

**File:** `/sessions/exciting-quirky-noether/mnt/smarter.poker/Documents/club-arena/src/services/HydraService.ts`
**Line:** 332-372

**Issue:**
In `seedTable()`, multiple `seatHorse()` calls are parallelized (line 370: `Promise.all(seatPromises)`). If two horses try to seat simultaneously, they might both write to the same seat number, causing a database constraint violation.

**Fix:**
Ensure seat selection is atomic with seat insertion.

---

## SUMMARY TABLE

| Bug # | File                   | Line    | Severity | Type               | Impact                               |
| ----- | ---------------------- | ------- | -------- | ------------------ | ------------------------------------ |
| 1     | HeadlessTableEngine.ts | 679-695 | CRITICAL | Data Corruption    | Horse AI gets false training data    |
| 2     | RakeService.ts         | 351-424 | CRITICAL | Missing Logic      | Rake not attributed to players       |
| 3     | HydraService.ts        | 645-647 | CRITICAL | Wrong Logic        | 25-hour delay to reseed tables       |
| 4     | HeadlessTableEngine.ts | 630-656 | CRITICAL | Race Condition     | Stack sync failures cause stale data |
| 5     | BotLogic.ts            | 320     | HIGH     | Logic Error        | Suspicious bet sizing                |
| 6     | RakeService.ts         | 260-269 | HIGH     | Missing Validation | BBJ money disappears                 |
| 7     | HorseBrainAdapter.ts   | 156     | HIGH     | Error Handling     | GTO cache not loaded                 |
| 8     | AutoRebuyService.ts    | 260     | HIGH     | Concurrency        | Double rebuys possible               |
| 9     | HeadlessTableEngine.ts | 475-486 | MEDIUM   | Memory Leak        | Orphaned timers accumulate           |
| 10    | BBJService.ts          | 378-387 | MEDIUM   | Logic Error        | Incorrect kicker comparison          |
| 11    | BotLogic.ts            | 296-298 | MEDIUM   | Stale Data         | Uses preflop strength postflop       |
| 12    | HydraService.ts        | 628-635 | MEDIUM   | Wrong Logic        | Removes wrong horse                  |
| 13    | HeadlessTableEngine.ts | 689     | LOW      | Duplicate          | (See BUG #1)                         |
| 14    | RakeService.ts         | 280-297 | LOW      | Missing Validation | Union rake not tracked               |
| 15    | AutoRebuyService.ts    | 386     | LOW      | Edge Case          | Negative topup amount                |
| 16    | BotLogic.ts            | 151-153 | LOW      | Code Clarity       | Minor readability                    |

---

## RECOMMENDED FIX PRIORITY

**IMMEDIATE (Fix Today):**

1. BUG #3 (HydraService delay) — Breaks table liquidity
2. BUG #1 (HeadlessTableEngine hand result) — Breaks Horse AI learning
3. BUG #2 (RakeService clubId) — Money tracking broken

**URGENT (Fix This Week):** 4. BUG #4 (Stack sync failures) 5. BUG #8 (AutoRebuy concurrent rebuys) 6. BUG #6 (BBJ pool missing)

**SOON (Fix Next Sprint):** 7. BUG #5, 7, 10, 11, 12 (Remaining HIGH/MEDIUM)

**LATER (Low Priority):** 8. BUG #14, 15, 16, and GAPS

---
