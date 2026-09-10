# One refused bust does not freeze an event

2026-09-10, 12:40 UTC. With the elimination sweep running again
(`2026-09-10-the-knockout-door-owns-every-bust.md`,
`2026-09-10-a-sweep-that-cannot-afford-its-first-mutation.md`), the platform
went from 1,077 busted players waiting to 310, and 1,731 tournaments finished in
four hours. What was left was seven events that would not move at all, each
holding escrow nobody could be paid:

| event                             |     held | busted waiting | last hand |
| --------------------------------- | -------: | -------------: | --------- |
| Turbo Tuesday PKO `9320fe50`      | 1,283.76 |             39 | 01:27     |
| Midweek Mystery `7d240805`        |   939.00 |             38 | 06:40     |
| Midweek Bounty `5e1f17e4`         |   485.00 |             28 | 06:40     |
| $100 Freeroll 12:00 PM `7aa16fa7` |   216.00 |             55 | 02:20     |
| Midnight Bounty `bb179b59`        |   157.50 |             20 | 04:10     |
| Early Bird Freeroll `a5aa6984`    |   102.00 |             12 | 01:25     |
| Early Bird Freeroll `798866ae`    |        — |              1 | —         |

My own new signal is what found them. `Tournament.bust_mutation_grace_granted`
fired 184 times in twenty minutes, which proved the bust pass was now being
reached — and immediately behind each grant sat a refusal from the knockout
door itself, the same player, every fifteen seconds, for hours.

## Four doors, four refusals, one shape

- `invalid_claimants` — bb179b59, 5e1f17e4, 7d240805
- `pko_order_already_advanced` — 9320fe50
- `unresolved_knockout_generation_chain` — 7aa16fa7, a5aa6984
- `knockout_generation_has_new_live_seat` — 798866ae

Every one of them is a **deterministic** refusal: the same player, the same
reason, for ever. And the assignment pass aborted on the FIRST refusal — so one
player the door could not accept meant nobody else in that event could be
recorded either. The field never shrank, the event never finished, the escrow
was never paid.

## `invalid_claimants` was a rule that excluded horses

The bounty claim door validates a claimant's `user_id` with

```
'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                            ^^^^^          ^^^^^^
```

— a UUID **version and variant** check. A horse is
`00000000-0000-0000-0000-0000000000NN`: version nibble `0`, variant nibble `0`.
It fails.

**Measured: 95 of 1,198 profiles fail that pattern and all 1,198 are valid
uuids — 62 horses and 33 humans** whose accounts predate the v4 generator. Any
knockout whose claimants included one of them was refused. Midnight Bounty's
twenty waiting players are every one of them horses.

`fn_exact_tournament_knockout_claimants` used the same pattern to decide who
counts as a claimant at all, so a horse that knocked somebody out was dropped
from the claim set before the door ever saw it — a horse winning a bounty share
and not being counted for it. That is exactly the shape CLAUDE.md 10.5 was
written about, and the version nibble never carried any authority here: the
column is `uuid` typed and Postgres accepts every one of these.
`20260910124023_a_player_id_is_a_uuid_not_a_uuid_version` fixes both.

Within four minutes 7d240805, 5e1f17e4 and bb179b59 were recording finishes
again.

## `unresolved_knockout_generation_chain` was a rebuy that never closed its bust

Seventeen knockout candidates platform-wide sat `pending` while a strictly newer
candidate existed for the same player — and for all seventeen, that newer
candidate has `stack_before > 0`. A player cannot lose chips they never had, so
holding chips after the earlier bust is proof they came back from it. 5e94c522
in 7aa16fa7: busted at hand 8259513 (5,000 → 0), `rebuys = 2` with two rebuy
legs seven seconds after each bust, a new seat one second before the prompt
expired, and a second bust holding 2,179. The rebuy happened. The candidate was
never marked.

`20260910124524_a_bust_the_player_came_back_from_is_a_rebought_bust` writes what
the rebuy would have written, only for rows carrying that proof, and aborts
rather than guess if any successor shows no chips. All seventeen were created on
2026-09-08 or 09-09; none today.

## And the hardening, which is the actual fix

Both of those were real defects worth fixing. Neither should ever have been able
to stop an event.

`BUST_REFUSAL_SKIP_AFTER = 3`. The pass still aborts on the first two refusals
of the same player — a CAS miss or an evidence defer clears in seconds and hand
order is worth keeping — and after that it records the rest of the field and
says who it could not record
(`Tournament.bust_blocked_player_skipped`). Skipping is bounded and safe:
everyone the door accepts is still recorded in hand order, the blocked player
keeps their chronological `eliminated_at`, and
`fn_normalize_tournament_final_standings` re-derives every finishing place from
that chronology before the event pays anybody.

The old comment justified the abort with "hand order must never be skipped:
doing so would advance a PKO watermark past unpaid money". True of a transient
refusal. Of a permanent one it is the opposite: waiting pays nobody at all.

## And the one that made no sound at all

Six more events had no refusal in the log, no grace grant, no error - nothing
but a blind clock. `236d8826` had auto-escalated to **level 989 of a 24-level
structure**; `09ac876f` to 243. Ten and ten busted players, three alive each,
one per table, no hand possible.

`registerEliminationScheduler` returned early when a registration already
existed. Both the sweep runner and the scheduler's `isActive` predicate close
over the lifecycle token taken AT REGISTRATION, and `resume()` begins a new
epoch without always passing through the stop fence that clears that handle. So
a manager could end up wired to an epoch that was no longer current: the
scheduler either skips it in `pump()` (isActive false) or dispatches a run that
returns at its first line. Silent, permanent, and invisible to every metric -
`registered` counts the entry, `stalled_slots` counts nothing, and the level
timer belongs to the new epoch and keeps ticking, which is exactly why these
events looked alive.

A re-registration now replaces the old entry instead of being ignored. The
scheduler's own `register()` already removes any previous entry for the same
tournament; dropping our stale handle first keeps the two in step.
