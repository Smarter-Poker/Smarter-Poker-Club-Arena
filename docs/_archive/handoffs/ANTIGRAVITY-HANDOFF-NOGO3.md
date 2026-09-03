# AntiGravity Handoff — 2026-04-14 — NO-GO-3 (Phase 1.2 PR-G-real)

## Context

REALIGN kill switches K6 and K10 going GREEN on this PR. Replaces the 4 named parallel clocks with `DeadlineScheduler` entries — making the scheduler the single, persistable source of truth for every engine deadline (turn timer, time bank, disconnect grace, insurance offer, RIT offer, table break countdown, heartbeat check). Server `npx tsc --noEmit` exits **0**. All 68 existing engine + transport tests still pass (`npx vitest run` GREEN — DeadlineScheduler 19, TableStateHub 16, EngineWebSocketServer 14, PreciseActionTimer 11, DisconnectEngine 8).

**Stack order with NO-GO-2 client:** Run the NO-GO-2 client handoff (`ANTIGRAVITY-HANDOFF-NOGO2-CLIENT.md`) first to commit + push the TablePage migration. This handoff is server-only — no Vite rebuild needed, no World Hub changes, no hub-vanguard deploy. Just commit + Hetzner Docker rebuild.

## What changed

### `server/src/engine/InsuranceEngine.ts`

- New constructor parameter `scheduler: DeadlineScheduler = deadlineScheduler` + private field.
- `InsuranceOffer.timeoutTimer` field deleted (comment tombstone left).
- `createOffers`: replaced `setTimeout(..., offerTimeoutSeconds * 1000)` with `scheduler.schedule({tableId, eventId: 'insurance_offer:<playerId>', deadlineMs, callback})`.
- `recalculateOffers` re-offer path: same replacement.
- `accept` / `acceptPartial` / `decline`: replaced `clearTimeout(offer.timeoutTimer)` with `scheduler.cancel(tableId, eventId)`.
- `settle`: belt-and-suspenders cancel for any lingering entries (chopped tie edge case).
- `dispose`: cancel all entries before deleting from Map.

### `server/src/engine/RunItTwiceEngine.ts`

- New constructor parameter `scheduler: DeadlineScheduler = deadlineScheduler` + private field.
- New static const `OFFER_EVENT_ID = 'rit_offer'` (one offer per table at a time).
- `RITState.timeoutTimer` field deleted (comment tombstone left).
- `offer`: replaced `setTimeout(..., autoDeclineTimeout * 1000)` with `scheduler.schedule(...)`.
- `accept` / `decline` / `chooserDecides`: replaced `clearTimeout` with `scheduler.cancel`.
- `clearOffer`: cancel before delete.

### `server/src/engine/TableBreakEngine.ts`

- New constructor parameter `scheduler: DeadlineScheduler = deadlineScheduler` + private field.
- `initiateBreak`: replaced `await new Promise(r => setTimeout(r, warningSeconds*1000))` with scheduler-backed Promise wrapping (`scheduler.schedule({eventId: 'table_break_countdown', callback: resolve})`).

### `server/src/engine/ServerTableEngine.ts`

- Removed `private heartbeatCheckInterval: NodeJS.Timeout | null` field.
- Added `private static readonly HEARTBEAT_EVENT_ID = 'heartbeat_check'`, `HEARTBEAT_INTERVAL_MS = 10_000`, and `private heartbeatActive: boolean = false`.
- `start()` swap: `setInterval(...)` → `this.heartbeatActive = true; this.scheduleHeartbeatCheck();`.
- `stop()` swap: `clearInterval(...)` → `this.heartbeatActive = false; deadlineScheduler.cancel(this.tableId, HEARTBEAT_EVENT_ID);`.
- New private method `scheduleHeartbeatCheck()` — recursive scheduler-backed loop. **Crucially preserves the horse heartbeat synthesis loop** (server-side bots have no real WS clients, so the loop walks `seatedPlayers` and calls `disconnectEngine.heartbeat()` for every `is_horse: true` player before sweeping for stale heartbeats — without this, every bot at every table would time out and fold their hand every 10s). Race-safe via `running && heartbeatActive` guard at both top and re-arm.

## Step 1: Pull NO-GO-2 client commit first

```bash
cd ~/Documents/club-arena
git pull origin main
```

Confirm HEAD is the NO-GO-2 client commit before proceeding.

## Step 2: Server typecheck

```bash
cd ~/Documents/club-arena/server
npx tsc --noEmit
```

Must exit 0.

## Step 3: Run tests

```bash
cd ~/Documents/club-arena/server
npx vitest run
```

Expected: 68 tests passing (DeadlineScheduler 19, TableStateHub 16, EngineWebSocketServer 14, PreciseActionTimer 11, DisconnectEngine 8). If any test that previously passed now fails, STOP.

## Step 4: Grep-for-absence (REALIGN Phase 9)

```bash
cd ~/Documents/club-arena/server/src/engine

# In the 3 named files, only comments should mention setInterval/setTimeout/clearTimeout/timeoutTimer:
grep -nE '^[^/]*(setInterval|setTimeout|clearInterval|clearTimeout)\(' \
  InsuranceEngine.ts RunItTwiceEngine.ts TableBreakEngine.ts
echo "exit=$?"
# Must print exit=1 (no matches outside comments).

# In ServerTableEngine.ts, heartbeatCheckInterval as a state field must be gone:
grep -n 'heartbeatCheckInterval' ServerTableEngine.ts
echo "exit=$?"
# Must print exit=1.

# Confirm new heartbeat machinery is in place:
grep -n 'heartbeatActive\|HEARTBEAT_EVENT_ID\|scheduleHeartbeatCheck' ServerTableEngine.ts
# Should print 8+ lines (field decl, set/clear sites, schedule method, recursive call).

# Confirm horse heartbeats are still wired in the new method:
grep -n 'is_horse' ServerTableEngine.ts
# Must include a hit inside scheduleHeartbeatCheck.
```

## Step 5: Commit

```bash
cd ~/Documents/club-arena
git add -A
git commit -m "NO-GO-3 / Phase 1.2 PR-G-real: replace 4 parallel clocks with DeadlineScheduler

Eliminates the last 4 parallel timer paths so DeadlineScheduler is the sole
deadline authority across the engine. Fires REALIGN kill-switches K6 and K10 GREEN.

Per-engine changes:

InsuranceEngine.ts
- Constructor accepts optional scheduler (default = deadlineScheduler singleton).
- InsuranceOffer.timeoutTimer field deleted.
- createOffers + recalculateOffers re-offer path: setTimeout -> scheduler.schedule
  (eventId 'insurance_offer:<playerId>').
- accept/acceptPartial/decline: clearTimeout -> scheduler.cancel.
- settle + dispose: cancel any lingering entries before delete.

RunItTwiceEngine.ts
- Constructor accepts optional scheduler.
- RITState.timeoutTimer field deleted.
- offer: setTimeout -> scheduler.schedule (eventId 'rit_offer', one per table).
- accept/decline/chooserDecides/clearOffer: clearTimeout -> scheduler.cancel.

TableBreakEngine.ts
- Constructor accepts optional scheduler.
- initiateBreak countdown: bare setTimeout in Promise -> scheduler.schedule
  with resolve as callback (eventId 'table_break_countdown').

ServerTableEngine.ts
- heartbeatCheckInterval field deleted.
- New static HEARTBEAT_EVENT_ID + HEARTBEAT_INTERVAL_MS, instance heartbeatActive.
- start: setInterval -> scheduleHeartbeatCheck() recursive scheduler loop.
- stop: clearInterval -> heartbeatActive = false + scheduler.cancel.
- scheduleHeartbeatCheck preserves the horse heartbeat synthesis loop
  (is_horse seats get a synthesised heartbeat each tick — without this every
  bot at every table folds every 10s). Race-safe via running && heartbeatActive
  guard at both top and re-arm.

Verification:
- npx tsc --noEmit: 0
- npx vitest run: 68/68 pass (DeadlineScheduler 19, TableStateHub 16,
  EngineWebSocketServer 14, PreciseActionTimer 11, DisconnectEngine 8)
- grep -nE '^[^/]*(setInterval|setTimeout)\\(' on the 3 engine files: exit 1
- grep heartbeatCheckInterval on ServerTableEngine.ts: exit 1
- 'is_horse' still present inside scheduleHeartbeatCheck

REALIGN K6 (parallel clocks) GREEN. REALIGN K10 (engine restart loses pending
deadlines) GREEN — every deadline now persisted via deadlineScheduler.persistPending."
git push origin main
```

## Step 6: Hetzner deploy

SSH to the Hetzner box and rebuild the engine container:

```bash
ssh root@engine.smarter.poker
cd /srv/club-arena-server
git pull origin main
docker compose build engine && docker compose up -d engine
docker compose logs -f engine | head -60
# Look for: "[ServerTableEngine] Created for table ..." with no setTimeout/setInterval warnings
curl -s https://engine.smarter.poker/health | head -5
```

Health must report `status: "ok"`. Spot-check a real seat-down + hand to confirm:

1. Insurance offer on an all-in flop expires after configured timeout.
2. RIT offer auto-declines after configured timeout.
3. Bot horses keep their seats across at least 3 heartbeat ticks (don't time out).

## Step 7: Log NO-GO-3 in after-action log

Append to `~/Documents/Smarter-Poker-World-Hub/.memory/context/after-action-log.md`:

```
## NO-GO-3 — 2026-04-14 — Phase 1.2 PR-G-real — REALIGN K6 + K10 GREEN

### Atomic unit
Replace the 4 named parallel clocks in InsuranceEngine, RunItTwiceEngine,
TableBreakEngine, and ServerTableEngine.heartbeatCheckInterval with
DeadlineScheduler entries.

### Ship
- Commit CA <SHA>: server-only edit, no client/bundle changes.
- Hetzner rebuilt + /health GREEN.
- Spot-check: insurance offer expiry, RIT auto-decline, horse heartbeat
  survival across 3 ticks all confirmed.

### Verification
- server tsc: exit 0
- vitest: 68/68 pass
- grep '^[^/]*(setInterval|setTimeout)\\(' on the 3 engine files: exit 1
- grep 'heartbeatCheckInterval' on ServerTableEngine.ts: exit 1
- grep 'is_horse' inside scheduleHeartbeatCheck: 1 hit

### Kill switches now GREEN
- K1 (Supabase hand-state channel): GREEN (NO-GO-2)
- K2 (subscribeToHandState): GREEN (NO-GO-2)
- K3 (Dead parallel engine paths): GREEN (NO-GO-1)
- K6 (Parallel clocks): GREEN (this PR)
- K10 (Pending deadlines lost on restart): GREEN (this PR — every deadline
  is now persistable via deadlineScheduler.persistPending)
```

## Out of scope (next cycles)

- `waitForRITResponse` / `waitForInsuranceResponse` polling loops still use raw
  `setInterval` at `ServerTableEngine.ts:2384` and `:2808` — that's NO-GO-4
  scope, not PR-G-real.
- `pineappleDiscardTimer` (`:2211`), `handTimeout` (`:1758`), the `:1530`
  delay, and the `:2959` UI-coupling delay — all separate atomic units, not
  part of the 4 named clocks.
