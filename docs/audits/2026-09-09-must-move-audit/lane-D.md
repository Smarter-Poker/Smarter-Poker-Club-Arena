# Lane D - the engine side of must-move (server/src)

Audit of 2026-09-09, swarm lane D. Scope: the cluster controller, the seat-move
services, the presence handoff, and every place in the table engine that
mentions a seat move, an entry hold, a swap hold, a cluster id or the tab-follow
broadcast. Read against production rows (Club Arena is Supabase project
`kuklfnapbkmacvwxktbh`, NOT the `ydsaqnnuwyvtyxgvrnys` id in the brief - see
"Corrections to the brief") and against the live function bodies, never against
the migration files alone.

Status legend: DONE (code + test in this worktree), PARTIAL, NOT STARTED.

---

## Corrections to the brief

**The Supabase project id in BRIEF.md is wrong.** It names
`ydsaqnnuwyvtyxgvrnys` (`pepnationlab-prod`, 187 tables, 363 functions, no
`cash_*` anything). Club Arena production is `kuklfnapbkmacvwxktbh`
(`PokerIQ-Production`), which is also what CLAUDE.md section 2 names. Every
`fn_cash_*` lookup against the brief's id returns "function does not exist",
which reads exactly like "this function was never shipped". Every query in this
report was run against `kuklfnapbkmacvwxktbh`, read-only. Other lanes should
check they did not conclude something was missing from the empty database.

---

## Coverage: read line by line

| file | what was read |
| --- | --- |
| `server/src/cluster/ClusterController.ts` (681) | whole file: `wakeCluster`, lifecycle jobs/generation fence, `start`/`stop`, `wake` + debounce, `tickGame`, `frozenSkip`, `tick` (pass), `afterGameTick` (18.4 dealer wake), `rowByGame` staleness prune |
| `server/src/cluster/ClusterMetrics.ts` (255) | whole file: `actionKind` label folding, every gauge/counter, `recordPass`/`recordStalled`/`recordSkippedFrozen`, `healthSnapshot` |
| `server/src/cluster/ClusterController.test.ts` (616) | all 28 tests, shapes and helpers |
| `server/src/cluster/ClusterMetrics.test.ts` (286) | all tests |
| `server/src/cluster/theClusterPages.law.test.ts` (289) | all 5 laws incl. the alert-rule pins |
| `server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` (1286) | every `it` title; the move/announce/held/wake/balance blocks in full |
| `server/src/services/supabase/seatMoves.ts` (230) | whole file |
| `server/src/services/supabase/seatChange.ts` (87) | whole file |
| `server/src/engine/SeatMovePresence.ts` (160) | whole file: deposit/claim/prune, `MOVED_PRESENCE_FRESH_MS`, `MOVED_PRESENCE_MAX` |
| `server/src/engine/PresenceFollowsTheMove.test.ts` (265) | all 14 tests |
| `server/src/engine/ServerTableEngineBase.ts` | the start loop (2311-2620), `announcePendingSeatMoves` / `heldForSwap` / `wakeClusterGame` / `executePendingSeatMoves` / `depositPresenceForMove` / `adoptMovedPresence` / `stopIfClusterTableClosed` (2893-3210), `dealableCount` / `humansSeated` (3644-3690), `predictButtonSeat` / `getBBSeatIndex` (4591-4660), `persistEntryHold` / `restoreEntryHoldsFromSeats` (5478-5622) |
| `server/src/engine/ServerTableEngineDealing.ts` | the dealing loop 200-830: `adoptMovedPresence` order, arrival classification (`entry_hold` moved/waiting), the gone-player prune, `rosterChanged` wake, the natural-BB release, `postBBWhenClear` replay, the idle branch (`idle_seat_moves`, `idle_cluster_closed`), `announce_seat_moves` before `dealHand`, `activePlayers` filter |
| `server/src/engine/ServerTableEngineSettlement.ts` | `runStep`/`STEP_LANE` (1520-1600), step 6 `leave_pending` + `executePendingSeatMoves({announcedOnly:true})`, `table_unlock`, `wakeClusterGame('hand_complete')`, `readCashHandDepartures` (3225-3352) |
| `server/src/engine/ServerTableEngineRunout.ts` | grepped for every lane keyword: **no seat-move, cluster, entry-hold or lifecycle code at all**. Nothing to audit; the runout never touches a move. |
| `server/src/GameServer.ts` | the `ClusterController` construction + deps (1455-1475), `start()` wiring (2004), the owned-stop list (2228), `/health` `cluster` key (3019), the thaw installment driver (1595-1640) |
| `server/src/types.ts` | the cluster fields on the table row (287-290) |
| `server/src/transport/TableStateHub.ts` | `emitEvent`, `retainIfReplayable`, `replayRetained`, the D3 retention caps |
| `server/src/engine/DisconnectEngine.ts` | `registerPlayer` / `unregisterPlayer` / `restoreFsmStates` / `getFsmState` / `getFsmStatesForTable` / `checkStaleHeartbeats` / `tickSitOutsAndCollectEvictions` |
| `server/src/engine/ChipContinuity.ts` | `forget` / `welcome` / the roster reconcile |
| SQL, live bodies | `fn_cash_seat_move_execute`, `fn_cash_seat_move_execute_before_maintenance_gate`, `fn_cash_seat_swap_execute_before_maintenance_gate`, `fn_cash_seat_moves_pending`, `fn_cash_seat_move_announce`, `fn_cash_seat_move_window`, `fn_cash_seat_move_set_window`, `fn_thaw_platform`, `fn_thaw_platform_checkpointed` (the `cluster_move_expires_at` step) |
| client, read only to confirm the engine's events have a reader | `src/pages/TablePage.tsx` (`SEAT_MOVE_PENDING` / `SEAT_MOVED` / `SEAT_MOVE_HELD`, `movedToTableId`), `src/pages/MultiTablePage.tsx` (`updateTableInfo` tab-follow), `src/components/table/CashClusterHUD.tsx`, `src/services/cashGameLobby.ts` |

---

## Findings

### D1 (P1) A swap hold is released by a read that FAILED, and then the player can be moved mid-hand - DONE

`announcePendingSeatMoves` rebuilds the held set from the pending list:

```ts
const pending = await pendingSeatMoves(this.tableId);   // [] on ANY error
const liveHeld = new Set(pending.filter((m) => m.ready_at != null).map((m) => m.player_id));
for (const uid of this.heldForSwap) if (!liveHeld.has(uid)) this.heldForSwap.delete(uid);
```

`pendingSeatMoves` returns `[]` on error (`reportError(...); return []`), so a
transient PostgREST failure is indistinguishable from "no moves pending" -
CLAUDE.md 10.86 rule 2 exactly, "never coerce an unreadable answer into an
empty one". The consequence here is not cosmetic. `heldForSwap` is the ONLY
thing keeping the first side of a swap out of the deal, and the reason it must
stay out is that **a swap is landed by the OTHER table's transaction**, at the
other table's hand boundary, which is not this table's boundary. Release the
hold on a failed read, deal the player into a hand, and the partner's table can
land both chairs while this hand is live: a player moved mid-hand, chips and
all, which is the one thing the whole must-move design exists to prevent.

Fix: `pendingSeatMoves` now returns `PendingSeatMove[] | null` - `null` means
"could not read", and no caller may treat it as empty. The announce path
returns without pruning or announcing; the executor returns an empty outcome;
settlement maps null to `[]` for the boundary it is on (no moves execute that
boundary, exactly as before) and prunes nothing.

Test: `server/src/engine/TheMoveIsNeverMidHand.law.test.ts`.

### D2 (P1) A held swap side wedges an idle table for ever when its move dies - DONE

The held set is pruned in `announcePendingSeatMoves` and nowhere else, and that
method is called **immediately before `dealHand`**. A held player is filtered
out of `activePlayers`, so on a table with two players and one held, the table
falls below `minPlayersToDeal()`, takes the idle branch, and never reaches the
announce again. If the swap then dies for any reason the executor is not asked
about - the planner cancelling it (`fn_cash_seat_change_plan` writes
`cancelled` with note `left_table`), or plain expiry - the player is held out
of the deal permanently and the table never deals another hand.

Fix: the release is no longer tied to the announce. `executePendingSeatMoves`
in the engine now reads the pending list once, reconciles `heldForSwap` and
`announcedSeatMoves` against it, and passes it to the service as `prefetched`
(so it is the same one round trip as before, not an extra one). The idle branch
reaches it every 3 seconds, and the wait-for-players loop every 5.

Test: `server/src/engine/TheMoveIsNeverMidHand.law.test.ts`.

### D3 (P1) A move that was promised and then refused told the player nothing - DONE

Measured on production, 24 hours of `cash_seat_moves`:

| state | reason | note | count |
| --- | --- | --- | --- |
| cancelled | balance | destination_unavailable | 126 |
| cancelled | must_move | player_not_seated | 85 |
| cancelled | must_move | destination_full | 68 |
| cancelled | balance | player_not_seated | 52 |
| cancelled | balance | destination_full | 47 |
| cancelled | must_move | original_occupancy_not_recorded | 9 |
| cancelled | seat_change | destination_full / destination_unavailable | 3 |

Every one of those players had been told, at the start of the hand, "Seat Open
On Main 2. Moving After This Hand." (a toast, plus the corner notice in
`CashClusterHUD` which persists while the lobby read returns `me.pending_move`).
When the executor refused, the engine wrote one console line and emitted
nothing. The player's notice simply disappeared at the next 10-second lobby
poll, with no explanation, while they stayed in the chair they had been told
they were leaving.

Fix (engine): `executePendingSeatMoves` in the service now returns `refused[]`
- terminal outcomes only, filtered by `SEAT_MOVE_NON_TERMINAL_REASONS`
(`transient`, `frozen`, `platform_frozen`, `waiting_partner`, `done`), so the
maintenance freeze and a retryable deadlock are never reported to a player as a
cancellation. The engine emits `seat_move_cancelled` with a Title Case,
em-dash-free sentence from `seatMoveCancelledNotice(reason)` ("The Seat Was
Taken. You Keep Your Chair." / "That Table Has Closed. ..." / "The Seat Change
Was Cancelled. ..."), clears the announcement and any swap hold, and logs.

Fix (client): `src/pages/TablePage.tsx` gained a `SEAT_MOVE_CANCELLED` case
beside `SEAT_MOVE_HELD` - refresh the cluster HUD, and show the sentence to the
hero only. A guard must have a reader (CLAUDE.md 10.86 rule 3), so the engine
half is not shipped without it. This is the one CLIENT file this lane touched;
it is a self-contained 15-line `case` arm and the integrator should expect it
to sit beside other lanes' edits to the same file.

### D4 (P1) An entry hold the once-per-process restore never saw, left standing on the row - DONE

`restoreEntryHoldsFromSeats()` is guarded `entryHoldsRestored` and runs ONCE
per engine. The start-up wait loop calls it (correctly - a table below the deal
minimum never reaches the dealing loop). So for a table that spends time
waiting for players - which is every feeder, and every Main 1 with one player -
the restore has already been spent by the time the dealing loop runs its
first iteration, and that first iteration treats every seated player as the
pre-existing roster:

```ts
if (this.dealingLoopFirstIteration) {
  this.restoreEntryHoldsFromSeats();          // no-op, already spent
  for (const p of this.seatedPlayers) {
    this.knownPlayerIds.add(p.user_id);
    if (this.waitingForBB.has(p.user_id)) continue;   // never true
    this.dealtInUserIds.add(p.user_id);       // seeded as a veteran
  }
```

A player who arrived by MOVE during that wait carries `entry_hold = 'moved'`
(must_move / break / balance) or `'waiting'` + `entry_post_agreed = true`
(seat change) on their chair, written by the executor. Neither is read, and
neither is cleared. Two consequences:

1. **The marker outlives its meaning, and the next :55 restart believes it.**
   `restoreEntryHoldsFromSeats` on the next boot reads `'waiting'` + agreed on
   a player who has been dealt in for an hour and puts them back in
   `waitingForBB` + `postBBWhenClear` - held out of the deal, and then billed a
   live big blind to re-enter a table they never left. That is the exact shape
   of the incident already written on `persistEntryHold` ("seat 7, table
   08746c1a"), reached by a different route, and it is real money.
2. A seat-change arrival is seeded as a veteran on the table's first hand, so
   "a new player never gets the button" is not enforced for them.

Fix: the first-iteration block now clears any row marker it finds (and does NOT
seed that chair as a veteran, because it has never been dealt a hand here). A
`'posting'` hold that the restore genuinely did see is left alone - its billing
clears it. This is the table's first deal, so the blinds post by position and
nobody enters behind them; clearing is the correct reading of the marker, not a
waiver.

Test: `server/src/engine/TheMoveIsNeverMidHand.law.test.ts` (entry-state block).

### D5 (P1) Stale presence, time bank, straddle and pre-action left on the OLD table - DONE

The dealing loop's gone-player prune dropped `knownPlayerIds`, `waitingForBB`,
`heldForSwap` and `mustPostBB` and nothing else. Every leave path this engine
runs itself tears the per-player mirrors down (settlement step 6, the idle
`leave_pending` sweep, the move executor). But a cash player can leave this
roster through a path this engine never runs:

- the OTHER table's transaction landing a swap (the partner never executes
  here - this is the documented design, see `SeatMovePresence.ts`);
- the tab-close beacon `player_leave_table(table_id, user_id)`;
- the controller cashing out a second chair on a breaking table
  (`atomic_seat_cashout_locked(..., 'forced')`).

In each case the departed player kept a `DisconnectEngine` entry on a chair
nobody sits in - which `checkStaleHeartbeats` then marks disconnected every
hand - plus a time bank, a straddle registration and a pre-action. Worse,
`getFsmStatesForTable` writes that phantom into `hand_state_snapshots.
disconnect_states` on every hand and into `engine_presence_parked` at every :55
park, so the lie is durable and survives the restart.

The lane brief asks for "presence follows the move (no stale presence on the
old table)". Half of that was built (the deposit/claim handoff); this is the
other half.

Fix: the prune now runs the same teardown as every other leave path, cash
tables only (a tournament chair is released by `releaseDeadTournamentSeats`,
which has its own).

Test: `server/src/engine/TheMoveIsNeverMidHand.law.test.ts` (presence block).

### D6 (P2) `seat_moved` was fire-once: a hero mid-reconnect never learned their chair moved - DONE

`seat_moved` is the only packet that tells the hero's client to follow the
chair (`TablePage` navigates, or `MultiTablePage.updateTableInfo` re-points the
tab through `movedToTableId`). It was emitted once, with no `replay_until`, so
`TableStateHub.emitEvent` kept nothing: a hero whose socket was between
reconnects for that instant - or soft-dropped by the hub's own backpressure
rule - came back subscribed to a table they no longer sit at, with no seat, and
nothing to tell them where they went. This is the same class the D3 reveal
retention was built for.

Fix: both `seat_moved` emissions (the mover's own table, and the partner's
table on a landed swap) now carry `replay_until: Date.now() + 60_000`.

### D7 (P2) The stall latch could be cleared by a pass that no longer owned it - DONE

`ClusterController.tick()` releases `inTick` in a `finally`. When a pass is
found stuck past `CLUSTER_TICK_STALL_MS` the latch is deliberately released and
a fresh pass takes it - and then, if the stalled pass ever returns, its own
`finally` clears the latch the FRESH pass is holding. The pass after that
overlaps a live one with no report and no `recordStalled()`. The 11-minute
silent latch of 2026-09-04 is exactly the failure this ceiling was added for,
so the release path is the one place it must not be able to lie.

Fix: each pass takes a serial; only the holder clears the latch.

### D8 (P2) `stopIfClusterTableClosed` swallowed its read error - DONE

`if (error || !data) return;` - a read that keeps failing keeps an engine
running on a closed cluster table for ever (asking for seats, add-ons, leavers
and moves every three seconds on a table nobody can join) and nobody ever finds
out. Fix: the error is reported; a genuinely absent row still returns quietly.

### D9 (P3) The wait-for-players loop never woke its cluster on a roster change - DONE

The dealing loop wakes the controller on its roster diff
(`if (rosterChanged) this.wakeClusterGame('seat_change')`). The wait loop -
where a fresh feeder and a one-player Main 1 spend their whole life - did not,
so the second chair that takes a feeder LIVE reached the controller at the next
5-second pass rather than inside a second. Graded P3 honestly: a game with
anyone seated is due on every pass, so the delay was bounded at ~5 s, not the
30 s dormant rest. Fixed anyway; it is the same wake, debounced, and the
promote-at-two-seated decision is the one the delay was visible in.

### D10 (P2) The hub's per-table retention cap did not account for a breaking table - DONE

`HUB_MAX_RETAINED_EVENTS_PER_TABLE = 8` was derived from the five jackpot beats
one hand can produce. With D6 a BREAKING table can now emit one retained
`seat_moved` per seat at a single boundary - nine on a 9-max - and the
per-table splice drops the OLDEST, which is `bbj_hit`, the beat whose own
comment says it must survive. Raised to 16 with the arithmetic written beside
it (5 jackpot beats + a full 9-max table moved at one boundary = 14, plus
headroom). `AJackpotIsNeverLost.test.ts` asserts `cap >= retained beats counted
from source` and still passes.

Shared-file edit, surgical: one constant and its comment.

### D11 (P2) An EXPIRED move (as opposed to a refused one) is invisible to the engine - NOT MINE TO FIX (SQL; lanes A and B did it)

`fn_cash_seat_moves_pending` filters `expires_at > clock_timestamp()`, so a
move that timed out is invisible to the engine from the instant it lapses. The
engine therefore cannot tell the player "your move expired" and cannot attach a
reason; the expiry note is stamped by the tick
(`engine_did_not_execute_before_expiry`, migration 20260907171507). Measured:
137 expired moves in 24 h, of which 106 had been ANNOUNCED - i.e. 106 players
were told "Moving After This Hand" and then silently were not moved. The engine
side of D3 covers a REFUSED move; an EXPIRED one it never sees.

The clean fix is SQL, and it landed in this same swarm: lane A's
`20260909181642_every_expiry_says_why_including_the_executors.sql` (separating
`own_ttl_expired` from `swap_partner_gone`) and
`20260909181632_a_move_cannot_be_late_while_the_platform_is_parking.sql`, plus
lane B's `20260909181259_...`. I checked those three before writing anything so
as not to rewrite one statement from two migrations. Nothing further is owed on
the engine side; what the engine CAN see (a refusal) is D3.

Evidence:

```
announced | count | avg window_s | min window_s
false     |    31 |          252 |          180
true      |   106 |          351 |          301
```

Hand cadence on cluster tables over the last 3 h: p50 20.5 s, p95 66.6 s,
p99 104.3 s, 186 gaps over five minutes out of 22,670. So the 2026-09-07
window derivation (3-15 min, from the table's own last four hands) is
comfortably above the hand length now; these expiries are not the old
"deadline shorter than a hand" defect. They are tables that stopped dealing
altogether (below the deal minimum, or engine-less) - which the idle branch and
the wait loop are supposed to cover, and D1/D2 are two ways that cover was
lost.

### D12 - the :55 freeze / :00 thaw interaction with pending moves - VERIFIED, no engine change needed

Lane A's A2 (the tick gates on `fn_platform_frozen()` while the executor gates
on the wider `fn_entry_purchases_frozen() OR fn_platform_frozen()`) needs
nothing on the engine side, and this is why:

1. **A freeze refusal is not a cancellation.** The outer executor returns
   `reason = 'platform_frozen'` and the inner gate returns `'frozen'`. Both are
   in `SEAT_MOVE_NON_TERMINAL_REASONS` (D3), so the engine never tells a player
   their move was cancelled because of the break, and never clears the
   announcement or the swap hold for it. The move stays `pending`.
2. **A held move survives the park.** `fn_thaw_platform_checkpointed` carries a
   `cluster_move_expires_at` step - `UPDATE cash_seat_moves SET expires_at =
   expires_at + v_shift WHERE state = 'pending' AND expires_at > p_freeze_started`
   - so the five frozen minutes are given back rather than burned, which is
   CLAUDE.md 13 rule 4. Verified in the live body, not the migration.
3. **The engine mostly does not even ask during the park.** Both loops park at
   `awaitPauseGate` before their seat sweep, and settlement does not run
   because no hand is running. The freeze branch is the belt to that braces.
4. `announcePendingSeatMoves` extends expiry with `GREATEST(expires_at, now +
   5 min)`, so an announce that lands either side of the park can only ever
   lengthen the window, never shorten one the thaw has just extended.

The one thing worth watching after lane A's SQL lands: if the tick stops
expiring moves during the park, the engine will find them still pending at the
thaw and execute them at the first boundary - which is the intended behaviour
and needs no change here.

---

## Verified working (checked, no defect found)

- **A move executes only at a hand boundary.** Three call sites, and only
  three: settlement step 6 with `announcedOnly: true` (after the leavers, at
  the end of the hand), the dealing loop's idle branch (no hand to finish), and
  the start-up wait loop (below the deal minimum). The pre-deal sweeps contain
  no executor - pinned by `TheTablesOpenAndCloseThemselves.law.test.ts`. The
  one path that could move a player mid-hand is a swap landed by the partner's
  table, and the swap hold is what prevents it (see D1/D2).
- **The executor takes the new seat before vacating the old** ("a move is not a
  leave"): the live body inserts or revives the destination chair, then sets
  the source stack to 0 and stamps `left_at`, inside one transaction, and the
  outer `fn_cash_seat_move_execute` then asserts conservation
  (`SEAT_MOVE_CONSERVATION_FAILED`) - destination stack equals source stack,
  the occupancy id changed, and no live row remains on the source occupancy.
  No wallet row, no session close.
- **Idempotency.** `cash_seat_move_receipts` is checked twice (before and after
  the locks) and the receipt is returned verbatim, so a move executed twice
  lands once. The engine's own re-run is therefore safe.
- **Entry state by reason.** `v_hold := CASE WHEN m.reason = 'seat_change' THEN
  'waiting' ELSE 'moved' END`, `v_agreed := (m.reason = 'seat_change')`. The
  engine's arrival path reads exactly that: `'moved'` clears and is dealt in
  owing nothing; `'waiting'` + agreed goes to `postBBWhenClear`, which replays
  the agreement until the seat clears or the big blind reaches them. Both
  halves match Dan's rules ("no post, free hands until BB" / "seat change
  always re posts the BB").
- **Presence follows the move.** Deposit before `unregisterPlayer`, deposit
  again for every pending move at the announce (the only chance a swap
  partner's engine gets), and `adoptMovedPresence()` BEFORE
  `restoreSitOutsFromSeats()` in BOTH sweeps. Order pinned. The seat row
  carries `is_sitting_out` and the ORIGINAL `sit_out_at`; the FSM entry carries
  strikes, away-blind budget and `sitOutSince`; the time bank rides in the
  handoff because the column cannot distinguish "never seeded" from "30 s".
- **A swap holds the first side and lands both in one transaction**, and a swap
  whose partner disappears is released: `swap_partner_gone` cancels/expires
  both rows. (What was NOT handled is the engine-side release when that
  happens - D2.)
- **A move to a table that closed mid-flight is cancelled and the player keeps
  their chair**: `dst.lifecycle IN ('breaking','closed')` or a status outside
  `waiting|running|active` writes `destination_unavailable`. The chair is never
  vacated first, so there is nothing to strand. (The player was not TOLD - D3.)
- **Horses are players everywhere in this lane.** No `is_horse` anywhere in
  `ClusterController.ts`, `ClusterMetrics.ts`, `seatMoves.ts`, `seatChange.ts`
  or `SeatMovePresence.ts`. `seatChange.ts` deliberately calls the same
  `fn_cash_seat_change_request` the browser calls, with `p_user_id` honoured
  only for the engine. `humansSeated()` exists solely for the deploy drain gate
  and is not used by any move decision; `dealableCount()` counts horses.
- **The controller's cadence, ceilings and metrics**: one RPC per pass, the
  eligible map keyed by Main 1 with zeros omitted, `rested_games` folded into
  `rowByGame` so a wake on a dormant game still finds its Main 1, the 20-pass
  staleness prune, the never-awaited 18.4 dealer wake (the parked-worker
  incident), `recordPass`/`recordStalled`/`recordSkippedFrozen` and the seven
  break-guarded alert rules.
- No stubs, no TODO/FIXME, and no dead code found in the lane's own files.
  `ServerTableEngineRunout.ts` has no must-move surface at all.

---

## Handed to other lanes

- **SQL lanes**: D11 - already covered by lanes A and B, see that finding.
- **Nothing else.** The client arm D3 needed was small enough to ship with the
  engine that emits it rather than hand over (10.86 rule 3), and it is the only
  client file this lane touched.
- **Integrator**: the shared-file edits this lane owns are listed under
  "Hunks owned by lane D".

---

## Hunks owned by lane D

Verified against `git diff` on the host. **Four files are 100% lane D** - no
other lane has a hunk in them:

| file | hunks (`git diff -U0`) | what |
| --- | --- | --- |
| `server/src/cluster/ClusterController.ts` | `@213,9` `@481,1` `@616,3` | D7, the latch serial |
| `server/src/services/supabase/seatMoves.ts` | `@86` `@97` `@135` `@176` `@183` `@188` `@240` `@247` | D1 (null read), D3 (`refused` + `SEAT_MOVE_NON_TERMINAL_REASONS` + `seatMoveCancelledNotice`) |
| `server/src/engine/ServerTableEngineBase.ts` | `@70` `@2456` `@2494` `@2508` `@2927` `@2930` `@2945` `@2957` `@3043` `@3047` `@3059` `@3120` `@3138` `@3159` `@3277` | D1/D2 (`reconcileSeatMoveHolds`, null guards), D3 (the cancelled arm), D6 (`replay_until` x2), D8, D9 |
| `server/src/engine/ServerTableEngineDealing.ts` | `@291,21` `@382,22` | D4, D5 |

**Files shared with other lanes - my hunks named exactly, all surgical:**

| file | MY hunks | not mine |
| --- | --- | --- |
| `server/src/engine/ServerTableEngineSettlement.ts` | `@3330` `@3333` `@3345` - the three lines that carry a failed move read through `readCashHandDepartures` as `null` instead of `[]` (D1) | nothing else in the file is touched |
| `server/src/transport/TableStateHub.ts` | `@208,14` `@223` - one constant (`HUB_MAX_RETAINED_EVENTS_PER_TABLE` 8 -> 16) and the arithmetic comment above it (D10) | - |
| `server/src/engine/CashDepartureReadOverlap.test.ts` | `@117,22` - a PIN MOVED with its mechanism (CLAUDE.md 5.8): the outcome shape now carries `refused`, plus a new case for the null read | - |
| `src/pages/TablePage.tsx` | `@15229,15` ONLY - the `SEAT_MOVE_CANCELLED` case arm (D3) | `@26262` and `@26283` are another lane's; I did not touch them |

**New files (lane D):**

- `server/src/engine/TheMoveIsNeverMidHand.law.test.ts` - 23 tests, the law for
  D1-D9.
- `docs/laws.d/the-move-is-never-mid-hand.md` - its registry entry, required by
  `tests/law-registry.law.test.ts` for any new `*.law.test.*`.

Every new function is called from production code, not only from tests:
`reconcileSeatMoveHolds` from `announcePendingSeatMoves` and from
`executePendingSeatMoves` (2 call sites, pinned); `seatMoveCancelledNotice`
from the refusal arm in `ServerTableEngineBase`;
`SEAT_MOVE_NON_TERMINAL_REASONS` from the service's own classification. Every
new branch is reachable from a live loop: the refusal arm from all three
executor call sites, the null guards from any PostgREST failure, the wait-loop
wake from the start loop, the entry-hold clear from the first dealing
iteration, the prune teardown from every roster departure.

## Commands and results

All run on the host in the worktree
`~/Documents/.agent-trees/club-arena/cowork-mustmove`, with the changes above
applied. Counts, not adjectives.

```
$ cd server && npx tsc --noEmit -p .
(0 bytes of output - clean)

$ npx tsc --noEmit           # repo root, because this lane touched TablePage.tsx
(0 bytes of output - clean)

$ cd server && npx vitest run src/engine src/services/supabase src/transport src/cluster
 Test Files  297 passed | 1 skipped (298)
      Tests  4318 passed | 18 skipped (4336)

$ cd server && npx vitest run src/cluster src/engine/PresenceFollowsTheMove.test.ts \
      src/engine/TheMoveIsNeverMidHand.law.test.ts src/services/HorseSeatChange.test.ts \
      src/transport/TableStateHub.replay.test.ts src/engine/AJackpotIsNeverLost.test.ts
 PASS src/cluster/ClusterController.test.ts            (28 tests)
 PASS src/cluster/ClusterMetrics.test.ts               (tests)
 PASS src/cluster/theClusterPages.law.test.ts          (14 tests)
 PASS src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts
 PASS src/engine/TheMoveIsNeverMidHand.law.test.ts     (23 tests)   <- new, this lane
 PASS src/engine/PresenceFollowsTheMove.test.ts        (14 tests)
 PASS src/engine/AJackpotIsNeverLost.test.ts
 PASS src/transport/TableStateHub.replay.test.ts       (10 tests)
 PASS src/services/HorseSeatChange.test.ts             (20 tests)
 Test Files  9 passed (9)
      Tests  235 passed (235)

$ npx vitest run tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx \
      tests/must-move-lobby.test.tsx      # the client surface this lane's event reaches
 Test Files  2 passed (2)
      Tests  44 passed (44)
```

Baseline before any of my edits, for comparison: the same cluster/presence/
seat-change selection was `6 passed (6) / 185 passed (185)`, server `tsc`
clean. The only red at any point was one PIN I then moved deliberately, in the
same change as the mechanism it guards:
`CashDepartureReadOverlap.test.ts:117` asserted `SeatMoveOutcome` was exactly
`{done, held}` and my D3 adds `refused` to it. The behaviour it pins (a
`player_not_seated` candidate is executed once and lands nothing) is unchanged
and still asserted; a case for the null read (D1) was added beside it.

The `[Supabase.FATAL] SUPABASE_SERVICE_ROLE_KEY is not set` lines in the vitest
stderr are pre-existing environment noise, present identically in the baseline
run, and no test asserts against them.

## The 2026-09-10 merge: main solved D1 the other way, and its way won

Main moved 171 commits under this branch and had fixed the SAME defect with the
OPPOSITE mechanism. `seatMoves.ts` came back with three conflict hunks; the
integrator resolved the other three files and left this one to me because I
wrote both call sites.

**Adopted: main's THROW contract. Kept: this lane's invariant and `refused[]`.**

The invariant was never "returns null" - it is *a read that FAILED must never
cause a held swap side to be pruned*, because the first half of a swap is
landed by the OTHER table's transaction and a released hold is a player that
transaction can move out of a live hand. A throw enforces that MORE strongly
than a null did: a caller cannot ignore it by accident, because there is no
value to ignore. Main's contract is also the shipped one and the occupancy
receipt work (#3974) and its own tests depend on it (CLAUDE.md 10.8: deployed
code is evidence, and here the written law and the shipped mechanism agree once
you state the law properly).

| hunk | resolution |
| --- | --- |
| `SeatMoveOutcome.held` | MAIN's shape, with `source_occupancy_id` |
| `pendingSeatMoves` signature | MAIN's `Promise<PendingSeatMove[]>` |
| the error branch | MAIN's `throw new Error(... 'Seat move enumeration failed')` |
| `SEAT_MOVE_NON_TERMINAL_REASONS`, `refused[]`, `seatMoveCancelledNotice` | MINE, kept - main did not do D3 |
| the refusal arm | BOTH, composed: main's `Seat move outcome was not confirmed` throw proves the reason is real, and only then does this lane classify it terminal or not. `res.reason ?? 'unknown'` is gone, because by that line the reason is proven to be a non-empty string |
| the service's `prefetched` | main's non-nullable shape; `| null` now lives only in the engine |

**Call sites changed (2), and one deliberately NOT changed:**

1. `ServerTableEngineBase.readPendingSeatMoves()` - NEW, private, one place. It
   catches the throw, reports `pending_seat_moves_unreadable`, and returns
   `null`. Both `announcePendingSeatMoves` and `executePendingSeatMoves` use it
   and keep their existing `if (pending === null) return` branch untouched. A
   notice that could not be read must never stop a table dealing, which is why
   the throw is translated rather than propagated at these two.
2. `ServerTableEngineDealing` gone-player prune - dropped `this.forcedLeaves`,
   which main retired at this merge (the leave path is occupancy-keyed now).
   `tsc` caught it; the teardown is now exactly settlement step 6's list.
3. **NOT changed: `readCashHandDepartures`.** Main already owns that rejection
   (`Promise.allSettled` then `if (moves.status === 'rejected') throw`), and
   `runStep('leave_pending', moneyCritical=true)` catches it, reports it and
   raises a financial alert while settlement continues. The throw lands BEFORE
   anything is pruned or executed, so main's own structure already takes this
   law's branch. A second catch would only have hidden the alert.

**`PendingSeatMove[] | null` does not leak.** It is confined to the engine:
`readPendingSeatMoves`, the engine's own `executePendingSeatMoves(prefetched)`,
and `readCashHandDepartures`'s `pendingMoves` field - where `null` now arises
only from the `!lifecycleCanMutate()` early return. The integrator's resolution
of that field to `PendingSeatMove[] | null` is correct and I kept it.

**Two pins moved with their mechanisms, none weakened or deleted:**

- MY D1 pin was `pendingSeatMoves returns null on error, never []` - a claim
  about a return type. It is now BEHAVIOURAL and stronger: a throwing read
  leaves `heldForSwap` and `announcedSeatMoves` intact and emits nothing, **with
  a control** proving the same call DOES release the hold on a read that
  succeeded (without the control the test would pass on a method that simply
  never prunes, which is a different bug). Plus pins that the service still
  throws, that the translation exists in exactly one place with exactly two
  callers, and that settlement is not double-wrapped.
- MY D2 pin read the idle branch for `executePendingSeatMoves()`. Main wrapped
  both loops in `executeIdleSeatMoves` (seat boundary + step budget), so the
  pin now follows that wrapper and additionally asserts the wrapper reaches the
  executor and takes `acquireSeatBoundary()`.
- MAIN's `SeatMoveReceipt.test.ts` "treats a refused move as no transfer"
  asserted `toEqual({done: [], held: []})`. Its meaning is unchanged and still
  asserted - nothing done, nothing held - and it now also carries the `refused`
  entry, with the reasoning written beside it. Nothing of main's was deleted.

Gate after the resolution, read-only, `node_modules` present:

```
$ cd server && npx tsc --noEmit -p .
(0 bytes - clean; it is what caught the retired `forcedLeaves`)

$ cd server && npx vitest run src/engine/TheMoveIsNeverMidHand.law.test.ts \
      src/services/supabase/SeatMoveReceipt.test.ts \
      src/engine/CashDepartureReadOverlap.test.ts
 Test Files  3 passed (3)
      Tests  54 passed (54)

$ cd server && npx vitest run <the three above> src/cluster src/engine/PresenceFollowsTheMove.test.ts
 Test Files  8 passed (8)
      Tests  219 passed (219)
```

Nothing was committed; the merge is the integrator's to drive.

## What I could not do, precisely

1. **Nothing was applied to production, committed or pushed** - per the brief.
   The migrations that fix the SQL halves of D11/D12 belong to lanes A and B
   and are theirs to hand over.
2. **No live probe of the move executor.** CLAUDE.md 11.5 forbids spending real
   chips to test a rule, and every path in this lane moves a real stack between
   two real chairs. The executor's behaviour is read from
   `pg_get_functiondef` and from 24 hours of `cash_seat_moves` outcomes, and
   asserted in unit tests; it was reasoned about, not executed. The one thing
   this leaves genuinely unproven end to end is the exact wording a player sees
   when a refusal arrives, which no test can prove anyway.
3. **D11 is closed by other lanes' SQL, not by me**, and I did not verify their
   migrations beyond reading enough of each header to be sure I was not about
   to rewrite the same statement from a second file.
4. **The 137 expired moves in 24 h are explained but not eliminated.** D1 and
   D2 remove two ways the engine could stop executing at a table that is
   otherwise fine; whether they account for all of that population can only be
   measured after this ships, by re-running the expiry-by-note query.

