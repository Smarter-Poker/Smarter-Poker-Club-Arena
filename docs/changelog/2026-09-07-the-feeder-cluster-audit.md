# Auditing the must-move cluster: what works, and the one change nobody got back

2026-09-07. A full audit of the feeder / must-move machinery against live
production: table creation and closing, feeder to main promotion, balancing,
the one table change every player gets, and the lists.

## What is working, measured

Nine invariants over every live cluster table, and seven came back clean:

| check                                              | result |
| -------------------------------------------------- | ------ |
| a table seated over its capacity                   | 0      |
| a player holding two chairs in one cluster         | 0      |
| a roster row open with no chair in the game        | 0      |
| a chair in the game with no open roster row        | 0      |
| two tables sharing a main_index                    | 0      |
| a gap in a cluster's main_index sequence           | 0      |
| seat_change_used stamped with no request behind it | 0      |

The move pipeline over two hours: **2,094 done, 48 cancelled, 22 pending, 21
expired** - 96.8% of every planned move lands. The last hour shows the shape of
a working controller: 12 feeders opened, 11 went live, 4 promoted to main, 8
mains demoted back to feeder, 14 tables broken and 14 breaks completed, 1,076
moves planned and 1,044 executed, 48 games put to sleep and 48 woken.

**A stall I thought I had found was my own measurement racing the controller.**
The first sample showed four clusters with players on a feeder while a main had
a free seat. On one of them, by the time I read the census a moment later, the
seat was full and the census agreed with `table_seats` exactly. Sampling the
condition five times over 35 seconds found six clusters that persisted - and
reading their census showed the reason: every open main seat already had an
inbound `pending` move against it. The controller had planned them; they were
waiting for a hand boundary, which is what a must-move is supposed to do. The
oldest pending move on the platform was 198 seconds old.

## The defect: a seat change nobody got, spent anyway

Dan's rule is one table change per player per game. It is enforced at the door -
`fn_cash_seat_change_request` raises `SEAT_CHANGE_USED` - and the allowance is
spent when the request is MADE, not when the move lands.

`fn_cash_seat_change_cancel` already knows what to do when a request ends
without a move, and says so in its own comment:

```sql
-- The button comes back.
UPDATE public.cash_game_roster SET seat_change_used_at = NULL ...
```

`fn_cash_seat_change_plan` cancels a request for the same reason - the player is
no longer in the chair they asked from - and did not give it back:

```sql
IF NOT EXISTS (... ts.table_id = r.from_table_id ...) THEN
  UPDATE public.cash_seat_change_requests
     SET status = 'cancelled', resolved_at = p_now, note = 'left_table'
   WHERE id = r.id;
  CONTINUE;                       -- and the allowance stays spent
END IF;
```

Same event, same meaning, one line missing. And the reason the player is usually
out of that chair is that **the cluster moved them** - a must-move promotion or
a balance move took the seat they asked from. A change the system made for its
own reasons is not the change they asked for, and must not consume the one they
are owed.

Measured before the fix: 7 requests cancelled with note `left_table`, and **2
players sitting in a game right now with the allowance spent, no move delivered,
and no way to ask again**. Both restored; the migration asserts none is left.

`left_game` is untouched and needed no fix: that path closes the roster row, and
a rejoin opens a fresh one with a fresh allowance.

## Two things worth knowing, neither fixed here

**A move that expires says nothing about why.** Over six hours the failure
taxonomy is `destination_unavailable` 27, `player_not_seated` 22,
`destination_full` 16, `deadlock detected` 11 - and 29 `expired` with **no note
at all**. Expiry is the one outcome in the move lifecycle that carries no
explanation, and it is the one you most need explained: it cannot distinguish a
table that never reached a hand boundary from an engine that never saw the move.
10.86 rule 1 wants that named. Fixing it means re-emitting a 37KB
`fn_cash_cluster_tick` by hand, which is a worse risk than the gap, so it is
written down here rather than done badly.

**Deadlocks cancel player moves.** Eleven in six hours (`40P01`), and a
cancelled move puts that player under the planner's 60-second back-off, so an
infrastructure failure becomes a player waiting longer. There is an open PR on
union deadlock retries that may cover the same root.

**Controller tick errors are ordinary contention, not a defect.** 74 lock
timeouts and 12 pldbgapi2 stack errors in 24 hours, clock-aligned to the
hand-history maintenance crons at :00-:11 and :01/:16/:31/:46. Against 17,280
passes per game per day that is noise, and every one is retried five seconds
later. Worth noting: the pldbgapi2 message is `plpgsql_check`'s cursor-leak hook
failing to unwind after a cancellation, so it REPLACES the real error with its
own. That is why an earlier handoff blamed pldbgapi2 for a constraint outage.

## Files

- `supabase/migrations/20260907164541_a_seat_change_nobody_got_comes_back.sql`
  (applied and recorded on production, version `20260907164541`)
