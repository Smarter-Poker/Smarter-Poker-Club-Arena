# 2026-09-05 - Horses change seats like humans, and presence follows the player across a move

Two of the five items `docs/changelog/2026-09-05-the-must-move-lobby.md` left
under "Still owed": _"horses using the seat change like humans (same button,
same once, same list)"_ and _"presence not carried across a move"_.

Migration: `20260905064237_horses_use_the_seat_change_and_presence_follows_the_move`.

---

## 1. A horse can press the seat change button

CLAUDE.md 10.5 is a hard law: _"HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"_ The must-move
lobby, shipped hours earlier, gave every player on a feeder table a **Seat
Change** they may use once per stay in a game. Horses could not use it, and not
because anybody decided they should not:

```sql
v_uid uuid := auth.uid();
...
IF v_uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first';
```

`fn_cash_seat_change_request` read `auth.uid()` and nothing else, so it was
reachable only from a browser. The engine authenticates as `service_role`,
where `auth.uid()` is NULL. Measured on production while writing this: of the
cluster tables with anybody sitting at them, **every feeder table was
horse-only**, so a lobby feature whose queue is meant to show players wanting
to move showed an empty queue on every game, permanently. That is 10.5's exact
shape - a feature a human gets and a horse does not, by construction - and it
is also a tell.

### The door, not a second door

`p_user_id` is a third argument, honoured **only** when
`public.fn_caller_is_engine()` - the estate's single definition of "is this the
engine" since `20260828090000` (service_role, or no PostgREST request context).
For a browser the parameter is ignored outright, so a signed-in player cannot
spend somebody else's once-per-stay change by passing their id.

Everything else in the body is byte-identical. There is deliberately **no
horse-specific RPC, no seed helper and no direct write** to
`cash_seat_change_requests` or `cash_game_roster`: the once-per-roster-row
budget, "never from Main 1", "never to Main 1", "not while a move is pending",
"not on a breaking table" and the maintenance freeze are enforced for a horse
because it is the same function.
`server/src/services/HorseSeatChange.test.ts` pins that both sides ask for the
same RPC name and that the rotator holds no query of its own.

**Replaced, not overloaded.** Postgres cannot add a parameter with `CREATE OR
REPLACE`, and a 3-arg overload sitting beside the 2-arg original would make the
client's own two-argument call **ambiguous** and break every human seat change.
So the 2-arg function is dropped and re-created with three, the third
defaulted; PostgREST resolves `{p_game_id, p_to_table_id}` to it exactly as
before. The migration asserts `count(*) = 1` for the name, so a future overload
fails the apply rather than the players.

### When a horse asks

`seatChangeVerdict` in `server/src/services/HorseBehavior.ts`, in the shape of
`wantsTableChange` beside it, because it is the same instinct one step short of
leaving: a player who does not like this table asks to be moved before they
give up on the game.

It returns a **verdict**, not a boolean, and every refusal is one the database
would also give (`main_one`, `table_closing`, `no_other_table`, `used`,
`leaving`, `too_new`), so the caller declines before spending a round trip on a
refusal it could have predicted.

- **25 minutes minimum** at the table. `wantsTableChange` waits 12 before a
  player walks out; asking the floor to move you is a considered request about
  THIS table, and doing it ten minutes after sitting down reads as a script.
  It is also past the rotator's `MIN_SESSION_MINUTES` (20), so a horse that
  will not be around to enjoy the new seat never asks.
- **Rate-limited per 90-second cycle**, deterministic in (horse, table,
  minute) so two passes in one minute cannot roll twice and a restart cannot
  re-roll a horse into asking immediately. Base 0.2% at a full table, 0.6% at
  five-handed, 1.2% at three, scaled by the same restlessness trait
  `wantsTableChange` reads. Over the ~35 eligible cycles of an average
  session that is roughly 6% / 18% / 33% of horses - a minority, which is what
  the human number looks like.
- **Never a horse on its way out**: leaving this cycle, on a short break,
  `leave_pending`, or on a retiring or night-parked table.
- **Never while somebody is queued** for a seat at that table: that is a table
  the fleet is standing horses UP from, not one to ask to be moved off.
- **At most two horses on the whole floor per cycle**, and the maintenance
  freeze stops the pass entirely (Dan 2026-09-01: horses do not rotate across
  the break).

### A refusal is logged, never retried in a loop

`HorseSessionRotator.seatChangeAsked` records `${gameId}:${horseId}` on **every**
outcome, success included, and the entry is written **before** the call so a
throw on the way out cannot leave the horse eligible next cycle. Two windows:
12 hours for a refusal that is true for the whole stay (`SEAT_CHANGE_USED`,
`SEAT_CHANGE_NOT_FROM_MAIN`, `NOT_IN_GAME`, ...), 30 minutes for a passing one
(`MOVE_PENDING`, `PLATFORM_FROZEN`, `SEAT_CHANGE_NO_OTHER_TABLE`) - a human
would look again later, so a horse may too, once, not every ninety seconds.

The destination-count read is chunked and **fails closed**, like every other id
list in that file: a pass that cannot count where a change could go declines
rather than asking blind.

---

## 2. Presence follows the player across a move

The lobby changelog put it plainly: _"presence is not transferred across a move
(the client re-subscribes)."_ What that meant is that the destination engine met
every arriving player as a stranger, and `DisconnectEngine.registerPlayer`
seeds a stranger as fully present with a clean record:

```ts
isConnected: true, consecutiveTimeouts: 0, isSittingOut: false,
awayBlindSbCharged: false, awayBlindBbCharged: false, pageLeftAt: null
```

Four things went wrong at once, and all four are the defects B10 and the
2026-09-04 disconnect audit fixed for a RESTART, re-opened by a MOVE:

| what was lost         | what the player saw                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the sit-out           | dealt into the first hand at the new table - the one hand they had chosen not to play - then auto-folded through it                                                            |
| away/disconnected     | an absent seat read as present, so it burned the table's whole action clock every orbit until the heartbeat checker noticed again                                              |
| the away-blind budget | Dan's cap is one SB and one BB per absence; a player one blind from eviction arrived with both slots free, so a game that moves its players often could never spend the budget |
| the strike count      | three timeouts force a sit-out; a move reset the ladder to zero                                                                                                                |

### The seat row half (SQL)

Both executors wrote the arriving chair with `is_sitting_out = false,
sit_out_at = NULL`. They carry both now, with the **original** `sit_out_at`, so
the five-minute eviction clock is the same clock it was rather than a fresh one
the move handed back - exactly what `restoreSitOutsFromSeats` already insists on
for a restart. `is_away` was already carried. Both sides of a swap carry their
own.

**Nothing about chips or entry state changed**: the stack, the chip-continuity
session, `entry_hold` and `entry_post_agreed` are untouched, and the test pins
those three lines so a later edit cannot quietly take them with it.

### The engine half

`server/src/engine/SeatMovePresence.ts` - a handoff keyed by player and
destination table. The source deposits `DisconnectEngine.getFsmState(...)`, the
identical shape a restart persists to `engine_presence_parked`, so the move and
the restart carry the same thing and cannot drift apart. The destination claims
it on its next seat sweep. One process holds every table, so it is a Map rather
than a round trip; an unclaimed deposit expires after ten minutes.

Three placements, each load-bearing:

1. **In `announcePendingSeatMoves`, for every pending move**, once per hand -
   because a **swap** is landed by the OTHER table's transaction, so the
   partner's own engine never runs an executor and this is its only chance to
   hand its player's presence over.
2. **In `executePendingSeatMoves`, immediately before `unregisterPlayer`** -
   the freshest possible stamp for the ordinary case, and again for a held swap
   side while this engine still has its presence to give.
3. **`adoptMovedPresence()` BEFORE `restoreSitOutsFromSeats()`**, in BOTH seat
   sweeps (the start-up wait loop and the dealing loop - a table below the
   minimum to deal never reaches the second, and a feeder's mover often lands
   on exactly such a table). The order is not tidiness:
   `restoreSitOutsFromSeats` calls `registerPlayer`, and `restoreFsmStates`
   correctly refuses to clobber a live entry, so registering first would throw
   away everything the move carried. The test pins the order.

A live observation still wins: a player whose client re-subscribed before the
sweep keeps the fresh state, and the deposit is discarded.

**The time bank rides along**, and it is the one piece the seat row could not
do. `time_bank_remaining` is carried by the SQL, but
`ServerTableEngineDealing` deliberately does not read it back - see the long
"REVERTED 2026-08-25" note there: the column is `DEFAULT 30` and never null, so
nothing can tell "never seeded" from "30 seconds left", and reading it charged
every VIP's monthly quota at every seat. A handoff has no such ambiguity: a
deposit exists only when the source engine genuinely held a bank. That reverted
path is unchanged.

---

## Verified against production

Applied 07:07 UTC in one transaction (one ~28s PostgREST schema reload, not
three). Two probes, each ONE MCP call containing ONE `DO` block ending in
`RAISE EXCEPTION` - CLAUDE.md 11.5: a transaction does not span two MCP calls,
so the raise is what rolls the fixtures back, and **an error is the success
case**.

1. **The engine path works for a real horse.** Picked a live horse on a
   non-Main-1 table of a must-move game with somewhere to send it, called
   `fn_cash_seat_change_request(game, NULL, horse)` as the engine:
   `{"ok": true, "action": "listed", "position": 1}`, and
   `cash_game_roster.seat_change_used_at` stamped. Rolled back.
2. **A browser cannot spend somebody else's change, and nothing leaked.** The
   request row from probe 1 was gone. Then, with
   `request.jwt.claims` set to `{"role":"authenticated","sub":<an outsider>}`
   so `fn_caller_is_engine()` reads false, calling the door with a seated
   horse as `p_user_id` was refused as **the caller**:
   `NOT_IN_GAME: you are not seated in this game`. The horse's change was not
   touched.

The migration's own `DO` assertions ran and passed: exactly one
`fn_cash_seat_change_request`, three arguments, `p_user_id` gated on
`fn_caller_is_engine`, and neither executor containing `is_sitting_out = false`
any more.

**One trap worth writing down.** The first apply aborted on its own assertion,
correctly and harmlessly (the whole transaction rolled back - verified by
re-reading `pg_proc` afterwards). The assertion compared
`pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, uuid'`, and on this
server that function returns the parameter NAMES too
(`p_game_id uuid, p_to_table_id uuid`), so it can never equal a bare type list.
The assertion now uses `pronargs = 3` plus a regex on
`pg_get_function_arguments`. If you write an argument-shape assertion, check
what these two functions actually return here first.

---

## Tests

| file                                               | tests |
| -------------------------------------------------- | ----- |
| `server/src/engine/PresenceFollowsTheMove.test.ts` | 14    |
| `server/src/services/HorseSeatChange.test.ts`      | 20    |

The two headline cases each have a **control** that reproduces the old bug
without the handoff, so a change that quietly stops depositing turns them red
rather than passing on a coincidence.

**One existing pin updated in the same commit**, as CLAUDE.md 5.8 requires:
`theClubProgrammeMirrorsTheHouse.test.ts` pinned the rotator's seats select
verbatim, and `role`, `main_index` and `lifecycle` joined it so the seat-change
pass can tell a Main 1 chair from a feeder chair and see a closing table. The
columns that pin was written for (`settings` for `isRetiringTable`,
`cluster_id` for the drain) are still there.

`npx vitest run src/services src/cluster src/engine` in `server/`: 284 files,
4377 tests, all green. `npx tsc --noEmit` clean in both the repo root and
`server/`.

---

## Still owed from the must-move lobby

Placard 375 px squash; a "moving in N hands" countdown; the break/fleet fight.
