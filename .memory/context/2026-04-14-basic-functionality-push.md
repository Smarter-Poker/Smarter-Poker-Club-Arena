# Basic Functionality Push — 2026-04-14 / 2026-04-15

**Type:** CONTEXT + PROBLEM (multi-entry consolidated)
**Project:** Smarter Poker Club Arena
**Phase:** post-REALIGN, pre-PokerBros comprehensive upgrade
**Trigger:** Dan's directive — "WORKING BASIC FUNCTIONALITY THAT WORKS 100%" before starting the PokerBros spec comprehensive upgrade plan.

## What shipped this session

| Fix                                                      | CA                    | WH                      | Status                           |
| -------------------------------------------------------- | --------------------- | ----------------------- | -------------------------------- |
| Server TURN_CHANGE deadline stamped BEFORE broadcast     | `ab13889c`            | —                       | Hetzner container `8b4ba435dc62` |
| Hero cards +4px right of avatar                          | `87a5c795`+`37586bf7` | `e0ea52ae`              | Live                             |
| Chip-to-pot collect animation on street end              | `50c287e0`            | `10c0ce1b` / `1530cf46` | Live                             |
| Timer v1 (useTableTimer deadline-driven reset)           | `37586bf7`            | `e0ea52ae`              | Live (superseded by v4)          |
| Timer v2 (RAF dep array fix)                             | `31604114`            | `4402d852`              | Live (superseded)                |
| Timer v3 (RAF subscribe-once)                            | `7e0a9214` (part)     | `b279b4ef`              | Live (superseded)                |
| Timer v4 PURE CSS `@property --timer-progress` animation | `7e0a9214`            | `47d64d67`              | Live                             |
| **seat--active CLASS COLLISION FIX**                     | `3b126827`            | `2fa7c88e`              | Live (final)                     |
| Rebuy-on-bust (SQL RPC + UI wiring)                      | included in v5 tree   | `47d64d67`              | Live                             |

## Timer ring journey — v1 → v5

### v1: Server deadline stamping ordering bug (FIXED)

`ServerTableEngine.ts` TURN_CHANGE case broadcast the snapshot + emitted the discrete `turn_change` WS event BEFORE `handleTurnChange()` → `startTurnTimer()` wrote `playerTurnStartTime` / `playerTurnDuration`. Every broadcast shipped a `deadline_ms` / `turn_deadline_ms` from the PRIOR turn (or 0 on hand #1). Hero's countdown started already expired. Fixed by stamping intended deadline + resetting `timeBankActivatedThisTurn` BEFORE the broadcast, then handling pre-action / horse-think / disconnect grace.

### v2-v3: Client useTableTimer iterations

`useTableTimer` hook reset but never decremented. Investigated through three JS-based iterations:

- v2: added `turnDeadlineMs` + `activeSeatKey` to tick-effect deps.
- v3: collapsed reset + tick, made RAF subscribe once for hook lifetime, hero-timeout gated by `heroFiredRef` to fire at-most-once per turn.

### v4: Pure CSS @property animation (REPLACED JS hook entirely)

Discovered RAF is suspended on hidden tabs (including the Chrome MCP tab). Replaced JS timer with `@property --timer-progress` + `spTimerRingShrink` keyframes driven by `--sp-timer-duration` / `--sp-timer-delay` CSS vars. SeatSlot computes the two vars from server-authoritative `turnDeadlineMs` / `turnStartTimeMs` props. React `key={turnDeadlineMs}` on `.seat__info` remounts it per new turn so the animation restarts. Works identically for hero + opponents, on any tab.

### v5: Class collision ROOT CAUSE (final)

Even with v4 CSS animation, EVERY seated player glowed. Root cause: `cls.push(`seat--${player.status}`)` in `SeatSlot.tsx` pushed `seat--active` when `player.status === 'active'` (DB status meaning "seated in hand"), colliding with the current-turn class of the same name. Guard: skip `seat--${status}`when status === 'active' (it had no dedicated CSS anyway;`seat--in-hand` is the canonical in-hand indicator).

## Rebuy on bust (Dan: "I was straight booted from the table when I lost my chips")

### SQL: `atomic_table_rebuy` RPC

Applied to prod via Supabase MCP (`apply_migration` success). Source in `supabase/migrations/20260415_atomic_table_rebuy.sql`.

Logic:

1. Verify user has an active seat at the table (left_at IS NULL).
2. Deduct wallet balance (PLAYER wallet) — raises if insufficient.
3. UPDATE `table_seats.stack = stack + p_amount`.
4. INSERT wallet_transactions row (category = 'rebuy').
5. Return new stack.

### Client: TablePage wiring

- `useEffect` watches `heroPlayer.stack === 0 && !isHandInProgress && !isTournament`.
- Fetches wallet balance from `wallets` table.
- Opens `BuyInModal` in rebuy mode (reused component).
- `bustPromptFiredRef` guard prevents re-firing until next bust.
- Confirm → `supabase.rpc('atomic_table_rebuy', {p_user_id, p_table_id, p_amount})` → toast.
- Decline → forwards to `handleLeaveTable` (via `handleLeaveTableRef` to avoid declaration ordering issue).

### Server already handles it

`ServerTableEngine.ts:1539`:

```ts
const activePlayers = this.seatedPlayers.filter(
  (p) => p.stack > 0 && !this.disconnectEngine.isSittingOut(...)
);
```

Busted players are excluded from the next hand's dealing but stay seated. `processLeavePending` only removes explicit `leave_pending=true` rows, NOT busted humans. Perfect alignment with client rebuy prompt: player gets time to decide between hands.

## Engine audits — ALL CLEAN

- **ServerActionValidator**: turn order, min-raise, pot-limit, short all-in, sanitization paths
- **HandController.completeHand**: integer-cents distribution, rake/BBJ cap, no-winners guard, showdown order
- **calculatePots**: side-pot-by-investment math, folded contributors in main pot, eligibility per level
- **determineWinners**: hi-lo split, odd-chip clockwise from dealer (FIX 169)
- **PreActionEngine**: auto_check invalidates on bet, auto_call respects maxCallAmount
- **PreciseActionTimer**: thin wrapper over DeadlineScheduler, drift-free
- **processLeavePending**: only touches `leave_pending=true` seats

## Key gotchas documented for future agents

1. **Chrome MCP tabs have `document.visibilityState: hidden`** → rAF suspended. RAF-based probes return 0 calls even when code is correct. Use `setInterval`, CSS animations, or screenshots.
2. **GitHub Contents API commits don't always fire Vercel's webhook** — sometimes need a real `git push` with an empty commit to kick the queue.
3. **`.git/index.lock` EPERM on the Cowork mount** — can truncate (`: > .git/index.lock`) but can't delete. Use GitHub Contents API via Node scripts in `/sessions/funny-inspiring-cerf/scripts/`.
4. **VM bash hangs indefinitely on long-running git clones** — always wrap in `timeout` + poll state file from a separate call.
5. **`seat--${player.status}` class collision** — player.status === 'active' creates the same class as current-turn state.
6. **Vercel builds pile up** — up to 5 deploys can queue. Be patient or trigger the deploy hook.

## Next session entry point

Chrome MCP disconnected at 02:15 UTC mid-verification. All fixes committed + live; need visible-tab screenshots to confirm the ring shrinks on an opponent seat. After that confirm → move to the PokerBros spec comprehensive upgrade plan (Dan's roadmap item).

Verify on resume:

```
curl -sL 'https://smarter.poker/hub/club-arena/' | grep -oE 'assets/index-[^"]+\.js'
# Should return: index-f_1RKRxq.js (or newer if further ships)
```

Open a fresh tab, navigate to the test table, take a screenshot during a hand. ONE seat should have the yellow ring shrinking from 100% to 0%. No other seats should have the ring.

## Commit ladder

| Repo     | Commit                   | Purpose                                        |
| -------- | ------------------------ | ---------------------------------------------- |
| CA       | `ab13889c`               | Server deadline stamp-before-broadcast         |
| CA       | `50c287e0`               | Chip-to-pot collect animation                  |
| CA       | `87a5c795`               | Hero cards right of avatar                     |
| CA       | `37586bf7`               | useTableTimer v1 deadline-driven reset         |
| CA       | `31604114`               | useTableTimer v2 tick-deps                     |
| CA       | `7e0a9214`               | CSS @property + rebuy RPC + UI (v4)            |
| CA       | `3b126827`               | seat--active class collision guard (v5)        |
| WH       | `10c0ce1b` `1530cf46`    | Chip-collect + hero-cards bundles              |
| WH       | `e0ea52ae`               | Timer v1 bundle                                |
| WH       | `4402d852` `b279b4ef`    | Timer v2-v3 bundles                            |
| WH       | `47d64d67`               | Timer v4 + rebuy bundle                        |
| WH       | `2fa7c88e`               | Class-collision v5 bundle (FINAL THIS SESSION) |
| Supabase | `atomic_table_rebuy` RPC | Applied via MCP apply_migration                |
| Hetzner  | container `8b4ba435dc62` | Engine deadline fix deployed                   |
