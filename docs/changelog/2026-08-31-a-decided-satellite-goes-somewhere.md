# 2026-08-31 - A decided satellite goes somewhere too

A gap found while verifying Phase 5, in the one satellite state Phase 5 did not
touch. Not a regression: it has been terminal since the recovery path was
written, and the code's own comment says so.

## The hole

`recoverStuckCompleting` in `tournamentRecovery.ts` handles a satellite stuck
in `COMPLETING`. On 2026-08-30 the UNDECIDED case was fixed: two or more
entrants alive means play remains, so it is flipped back to `RUNNING` and
discovery resumes a manager within a cycle.

The DECIDED case - fewer than two alive - was reported and `continue`d. Every
recovery cycle. Forever. The comment three lines above states the reason it can
never resolve itself:

> a COMPLETING tournament is not RUNNING, so discovery never resumes a manager
> for it, and processSatelliteAwards only runs inside a manager's finish path

Grepped to confirm nothing else drives it: no `pg_cron` job, no edge function,
no workflow, no other caller anywhere transitions a `COMPLETING` satellite. The
only thing that touches one is the discovery watchdog, which calls this
function, which skips it.

So the buy-ins were collected, the pool exists, and the seats are never
awarded.

## It is worse than inert

Leaving the row `COMPLETING` is not a neutral holding state. `finishTournament`
claims the event with

```ts
.update({ status: 'COMPLETING' }).eq('id', this.tournamentId).eq('status', 'RUNNING')
```

so even if a manager did resume, the claim returns no row, the function logs
"Could not claim finish" and returns before `processSatelliteAwards`. Flipping
the status is a **prerequisite** for the awards pass, not a convenience.

## Three exits, and every stuck satellite now takes one

| state | exit |
| ----- | ---- |
| already awarded | `COMPLETING` -> `COMPLETED` |
| one survivor, nothing awarded | `COMPLETING` -> `RUNNING`, manager runs the awards |
| nobody alive, nothing awarded | stays `COMPLETING`, raises a **critical** alert |

**"Already awarded" is answerable because of Phase 3.** The payout record is
the authority; before it existed there was nothing to ask. A seat in the target
carrying this satellite's `source_satellite_id` is the second arm, for events
that ran before the record.

**The lone survivor is safe to re-drive, measured rather than assumed.** The
block above worried that flipping a decided satellite "would deal cards at a
settled event". It cannot: `minPlayersToDeal()` returns 2 for a tournament
table and the deal loop parks in `idle_not_enough_players` below it. What
actually happens is the elimination sweep sees `remainingCount <= 1` on its
first tick and runs the finish path, awards included. The survivor holds no
position yet, so stamping them first cannot collide with an existing place.

**The third case is left for a human on purpose.** With nobody alive and
nothing awarded, the engine's fallback treats the LAST ELIMINATED player as the
winner - which in a normal finish is second place. Guessing a winner and then
moving money on the guess is not a repair. It now raises
`Satellite.stuck_completing_unawarded` naming the event, its pool and its
target, instead of silently looping.

## Re-driving pays nobody twice

Every cash leg is keyed `tourney:{id}:prize:place:{n}` (or
`:satremainder:{user}:{n}`), and the seat leg dedupes on the target's unique
registration - `fn_award_satellite_seat` returns `awarded: false` on
`unique_violation` and the engine only pays cash when
`held_from_this_satellite === false`, which a re-drive of the same satellite
never is.

## Measured before and after

At the time of the change production held **1** tournament in `COMPLETING`,
none of them a satellite, and **0** stale beyond 30 minutes. This closes a
latent hole rather than draining a backlog.

The six satellites that looked unpaid on first inspection were a false alarm
worth recording: querying them by `source_satellite_id` reported no seat
awarded, because that column has only been written since 2026-08-30 and all six
ran before it. Joined on the winner instead, every one holds its seat in
*Sunday $200 Deep Stack* and played it out, finishing 15th to 109th. The audit
query had reproduced the exact NULL-is-not-FALSE bug Phase 5 fixed in the
engine.

## Tests

`aStuckSatelliteGoesSomewhere.law.test.ts` - 10 pins, including that the
ambiguous branch reaches neither `fn_credit_and_log` nor a `RUNNING` flip, that
the revive is a compare-and-set so two servers cannot both flip one event, and
that the deal guard the safety argument rests on still exists. The 2026-08-30
guard test is unchanged and still passes.
