# 2026-09-24: a past-start event counts its roster, not a stale counter

## What was wrong

Two mtt-v2 tournaments sat REGISTERING for days past their start time with 24
entrants in `tournament_players` and `tournaments.current_players = 1`. That
counter was written by an old reconcile branch (fixed for RUNNING events in
migration `20260922141704_a_running_field_is_counted_by_the_bust_that_shrinks_it`).

The REGISTERING start loop in `server/src/GameServer.ts` decided the event's
field from that counter: `needsPastStartTopUp = !poolFinalized && isPastStart &&
current_players < minPlayers`. So the start branch, which would have adopted the
dead generation's incomplete launch receipt through
`fn_begin_tournament_launch_atomic`, never ran. The row fell to the past-start
top-up instead. `topUpWithHorses` counts the real roster, found a shortfall of 0
and returned 0 without a word, and the loop only logged when something was
added. The events looped for ever, silently.

## The fix

- **The start gate reads the roster.** For every registration-first event (any
  format that is not seat-first) the gate's field is now the count the top-up
  itself uses: rows in `tournament_players` with status `registered` or
  `playing`, a horse counted exactly like a human (CLAUDE.md 10.5). `maxReached`,
  `timeReached`, `needsPastStartTopUp` and the past-start top-up branch all
  decide from that one number, and the start log reports it.
- **One batched read per pass.** `readEntrantRosterCounts` reads the roster
  beside the existing seat-first paid-seat read: chunks of 100 ids, keyset
  paged through `fetchAllRows`, only for rows whose decision depends on it
  (capped events, and events within ten minutes of their pre-seat lead or past
  it). No per-row query. A chunk that cannot be read completely is reported by
  `fetchAllRows` and those rows keep the counter for that pass.
- **Seat-first games are unchanged.** A Spin or heads-up game still starts on
  paid seats, and its roster is never read.
- **A top-up that adds nothing says why.** When `topUpWithHorses` returns 0
  because the roster already meets the target while `current_players`
  disagrees, it logs one line with the tournament id, the roster, the target
  and the counter, once per distinct disagreement.

No timer, sweep, repair job or counter rewrite was added, and the two events'
rows were not touched. Once deployed, the next discovery pass reads their
roster of 24, sends them to the start branch, and the launch path decides them.

## Tests

`server/src/tournament/aPastStartEventCountsItsRoster.test.ts` fails on the
previous main: a past-start mtt-v2 row with a counter of 1 and 24 roster
entrants now reaches the start branch, not the top-up; a row whose roster is
genuinely short still goes to the top-up whatever its counter says; a
seat-first game stays on its paid-seat gate and its roster is never read; and a
zero-result top-up with a disagreeing counter logs once. The discovery
harnesses in `theWalkReadsTheFleetOnce.test.ts` and
`PrestartTicketDiscovery.test.ts` now stub the roster read, and the source pin
in `aFinalizedPoolIsNotFilled.test.ts` follows the renamed gate.
