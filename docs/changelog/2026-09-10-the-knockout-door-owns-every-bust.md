# The knockout door owns every bust a hand took

2026-09-10, 07:23 UTC. **Twenty running tournaments had stopped recording
eliminations.** The largest, `2dbc9bb6` ($100 Freeroll, 12:00 AM), held 357
live players of whom 97 had already busted, been seatless for up to twenty
minutes, and could not be recorded out. The engine had logged 1,611 stack
frames under `Tournament.entry_window_reprice_unproven` in sixteen minutes.

Nothing was wrong with the eliminator. Something else was taking its work.

## The loop

The engine records a bust through exactly one door,
`fn_eliminate_tournament_player_atomic` (or
`fn_claim_tournament_bounty_elimination` in a bounty event). That door demands
the knockout candidate the accepted hand froze, assigns the finishing place
off the ladder, records the prize entitlement, resolves the candidate and
releases the exact seat generation — one transaction, and the place is part of
it.

`fn_ca_eliminate_absent_tournament_players` (pg_cron job 362, every fifteen
minutes, dwell ten) writes the same status a different way: `eliminated`,
`chips = 0`, and **`position` deliberately NULL** — "places are the
normalizer's to assign from chronology at the finish". That is true of an
event that is finishing. It is not true of one still dealing, and this sweep
runs on `status = 'RUNNING'`.

Until 00:28 this morning the sweep read `tournament_players.chips` — a mirror —
and therefore repaired almost nothing (`2026-09-10-the-felt-decides-who-busted.md`
is the fix). From 00:28 it read the felt, worked exactly as written, and began
taking busts the door was still holding: 69 in the 00:00 hour, 117 in 03:00,
254 in 04:00, 338 in 06:00, and 346 in the first fifteen minutes of 07:00.
**Measured at 07:12: all 1,270 eliminated-without-a-place rows across the 44
RUNNING tournaments carried a `pending` knockout candidate.** A hand had taken
every one of those stacks. Not one was a player the engine could not reach.

Then the second half. After late registration closes, the engine must obtain a
proof from `fn_complete_tournament_entry_reprice` that every early finisher was
repriced against the final pool. That proof counts an eliminated row with no
place as an unfinished reprice:

```sql
AND (tp.position IS NULL
     OR tp.prize IS DISTINCT FROM COALESCE(a.amount,0))
```

So the proof could never pass. `reconcileTournamentEntryWindow` returned false,
and `runEliminationSweep` returns **before its bust stage** when it does — by
design, so a lost reprice can never be acknowledged by the elimination loop.

That closes the circle: the sweep steals a bust, the proof refuses, the engine
stops eliminating, more players sit busted and seatless, ten minutes later the
sweep takes those too. `db79a6df`, `cef15ddb` and `c5fce798` refused the proof
84 times each in sixteen minutes. `cef15ddb` and `db79a6df` had recorded **zero**
placed finishers in their entire lives; `33883f12` had recorded 14 and then
stopped at 06:08 with 134 stolen rows behind it.

Incident `b03db5f2` — "absent players", critical, on the drift board — is this
loop seen from the detector's side. It was not measuring a stall. It was
measuring itself.

## The fix

Migration `20260910072322_the_knockout_door_owns_every_bust_a_hand_took`:

1. **Both sweeps are unscheduled** (`fn_ca_eliminate_absent_tournament_players`,
   `fn_ca_release_broke_seats`). They are repair jobs racing the live path, and
   10.12 does not permit that to be the answer to anything.
2. **Both functions refuse a bust a hand took.** A player whose latest knockout
   candidate is not `rebought` belongs to the door, and neither sweep will now
   look at them even if somebody calls the function by hand.
3. **The 1,270 stolen rows were returned exactly as they were before the sweep
   took them** — `playing`, `chips = 0`, no `eliminated_at`. Every one still
   had its pending candidate, so the door records each with the place, prize
   and bounty the accepted hand determined. Nothing was renumbered and no money
   moved: these players had never been paid, and their entitlement is computed
   when the door writes the place.
4. The migration asserts, before committing, that **no RUNNING receipt would
   still fail the reprice proof** — zero — and refuses if any stolen row
   belonged to an event with a settlement batch (a prepared result is
   immutable). It found none.

Migration `20260910072351_an_elimination_without_a_place_cannot_be_written`
makes the row impossible to write again: a DEFERRED constraint trigger on
`tournament_players` refuses `status = 'eliminated'` with `position IS NULL`
in a RUNNING, COMPLETING or COMPLETED tournament. Deferred matters twice —
`fn_normalize_tournament_final_standings` clears every eliminated position and
reassigns them inside one transaction, and a cancellation flips the event to
CANCELLED in the same transaction as its rows. Both still pass; both were
checked against the live definitions before the trigger shipped.

**And the first version of that trigger was wrong, in a way worth writing
down.** It judged `NEW`, and a DEFERRED constraint trigger is handed the tuple
its FIRING STATEMENT produced, not the row as it commits. A settlement that
writes `status='eliminated'` first and the finishing place second therefore
queued an event whose `NEW.position` was NULL, and the check refused the whole
transaction on a row that was about to be correct. Five satellites could not
finish between 07:24 and 07:52 — `19b22b48`, `0c007b41`, `56deda8a`,
`df08cfbf`, `84d3755b`, each down to its last player. Corrected at 07:59:58 in
`20260910075958_a_deferred_check_reads_the_row_at_commit_not_the_statement`:
a deferred check re-reads the row it is checking. All five settled through
their own door within 36 seconds, seat delivered, remainder paid, escrow zero;
every refusal had aborted its own transaction, so nothing was half-written and
no correction was owed. Recorded in
`20260910080242_the_guard_that_stopped_five_satellites_is_answered_for`.

It is a separate migration because `CREATE TRIGGER` holds a table lock on
`tournament_players` for the rest of its transaction. Doing it in the same
transaction as the 1,270-row return deadlocked against a live engine hand
commit (40P01 at 07:19: the return waited on tournament row locks the engine
held, while the engine waited on the table lock the DDL had taken). Production
DDL policy rule 7 says exactly this; it cost one refused attempt to remember
it. The retry then hit `TOURNAMENT_TRANSITION_BUSY` because the roster trigger
takes each event's launch receipt `FOR UPDATE NOWAIT` — so the final version
takes the launch receipts and the tournaments itself, in id order, waiting,
before it writes the first row.

## Measured after

|                                                         |                   07:12 |  07:25 |
| ------------------------------------------------------- | ----------------------: | -----: |
| eliminated rows with no place in RUNNING events         |                   1,270 |  **0** |
| RUNNING close receipts still awaiting the reprice proof |                      20 |  **0** |
| `reprice proof refused` in the engine log, per 90s      |                     ~95 |  **0** |
| events recording a finish in the last 2 minutes         |                      ~6 | **31** |
| placed finishers recorded in the last 2 minutes         | 0 in the stalled events | **61** |

The last refusal in the log is 07:23:22, the second the migration committed.

## What this says about the class

`2026-09-10-the-felt-decides-who-busted.md` fixed this sweep to read the right
column, eight hours ago, and that fix was correct on its own terms. It made a
band-aid work — and a working band-aid that races the live path is worse than
a broken one, because the broken one was harmless. The sweep was never the
answer to a stalled elimination; the elimination door was already holding
every one of those players.

CLAUDE.md 10.12's rule is "you may not build the repair either". The corollary
this cost us today: **when you find a repair job that is not repairing
anything, do not fix the repair job.** Ask what the live path was doing with
those rows.

## Register

`docs/BAND-AIDS-REGISTER.md`, TIER 2: both jobs recorded as retired today,
with this file as the root fix.
