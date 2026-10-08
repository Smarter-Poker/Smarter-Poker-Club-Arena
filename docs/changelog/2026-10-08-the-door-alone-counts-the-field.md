# The Door Alone Counts the Field (2026-10-08)

Horse Brain lane F-ROSTER-CACHE. The Phase 13/14 audit saw repeated engine
lines `Tournament roster cache diverged before horse registration`.

## What the Line Is

`tournaments.current_players` is a cached count of the field. Before it admits
anyone, the horse door (`fn_register_horse_for_tournament_before_maintenance_gate`),
the person's door and the ticket door each compare it with the roster
(`tournament_players` rows in `registered` or `playing`) under the event's row
lock, and raise `P0404` when the two disagree. On success each door writes
`before + 1` only if the row still holds the value it expects, so the cache and
the roster commit together. `trg_sync_tournament_current_players` recounts
before the start and on every bust; a seat-first format is counted from its
seats by `trg_seat_change_syncs_seat_first_count`. The refusal rolls the whole
entry back: no charge, no roster row.

## Two Different Causes Behind One Message

Engine archives on the Hetzner host (`/var/log/club-arena-engine`, 40 runs,
2026-10-04 21:56 to 2026-10-08 04:07 UTC, plus the live container):

| class                                                           | lines | refused calls | events                                                     | status                                                             |
| --------------------------------------------------------------- | ----- | ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| seat-first fill refused (`P0404`)                               | 3,946 | 3,946         | 9 boards, 3 of them for 31 hours                           | correct refusal, settled by #6424 and the 20261007151627 migration |
| MTT fill pass summary (`Horse registration: N seated, skipped`) | 25    | 170           | recurring MTTs and field SNGs filled by two passes at once | defective, fixed here                                              |

**Seat-first boards.** Every one of these lines names a board the 15:33 UTC
drain of 2026-10-06 wrote under `session_replication_role = replica`
(`2026-10-07-fifty-drained-entries-return-or-are-refunded.md`): seats vacated
and roster rows marked `eliminated` with no trigger running, so the seat count
stayed at 2 or 1 over an empty roster. The door was right to refuse; it was the
only thing that noticed. The three heads-up and Spin boards were cancelled and
refunded at 23:05:16 UTC on 2026-10-07 and the lines stopped. No change here.

**MTT fill passes.** The engine was a second writer of the cached count, from
outside the door's transaction:

- `topUpWithHorses` finished an MTT pass by counting the roster and writing
  that number back in a separate statement;
- `createTournament`, `createXMTT` and the field SNG in `createSNG` wrote this
  pass's own `registered` tally after `registerHorses`.

A second fill pass on the same event is routine (the pre-start ramp and the
creation pass overlap), so these writes landed a count from before a committed
entry. Example: Midnight Bounty (NLH) `fb8931b5`, created 02:30:46 UTC on
2026-10-08. Eleven horses entered between 02:30:49.26 and 02:30:51.30, a
concurrent pass found six of them already registered, and at 02:30:51.51 the
twelfth call read `cached 10, actual 11` and was refused. At 22:26:25 on
2026-10-07 one pass wrote its 11 over a committed 25 and the other pass lost
nine entries. The stale value stays until some other roster change recounts
it, and the person's door holds the same check, so a person registering in
that window is refused too.

Rate, MTT class only: 25 summary lines and 170 refused registrations over 78
hours (0.32 lines and 2.2 refusals an hour); 13 lines and 73 refusals in the
last 24 hours. The fields did fill on later ticks (Midnight Bounty started with
39 entrants), so the cost was refused entries, a late field and person-facing
`P0404` errors, not a missing event.

## What Changed

`server/src/services/TournamentRecurringService.ts` writes no
`current_players` for any registration. The two creation paths and the field
SNG update `status` only; the top-up pass writes nothing after it registers.
Every door already publishes the count in its own transaction, so no writer
moves and no new one is added. Tournament rules (field sizes, horse fill
policy, payouts) are unchanged.

Regression: `server/src/services/theDoorAloneCountsTheField.test.ts` drives
`topUpWithHorses`, `createTournament`, `createXMTT` and `createSNG` against a
mocked database that shows the counter one behind the roster, and fails if the
service sends any `tournaments` update carrying `current_players`. All five
cases fail on the previous source and pass on this one.
`tests/unit/tournamentsNeverCancel.test.ts` and
`server/src/services/seatFirstCountSync.test.ts` used to require the old write;
they now forbid it.

## How to See It Hold

On the engine serving this commit, the MTT class should read zero:

    docker logs club-arena-engine 2>&1 | grep 'Horse registration:' | grep -c 'roster cache diverged'

and, read-only, no pre-start event's count should disagree with its roster:

    SELECT count(*) FROM public.tournaments t
     WHERE t.status IN ('ANNOUNCED','REGISTERING')
       AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)
       AND t.current_players IS DISTINCT FROM (
             SELECT count(*) FROM public.tournament_players tp
              WHERE tp.tournament_id = t.id AND tp.status IN ('registered','playing'));

Read at 04:18:50 UTC on 2026-10-08, before this commit served: 0 of 117. A
divergence from this class lasts only until the next roster change recounts
it, so the engine log is the measure that counts.

## Served and Measured

#6463 merged as `38cf975a1d` at 04:54:55 UTC. Its own release run
(37730040646) stood aside at the 05:55 break because newer main already
contained it; the sealed release `4dbbd0672d` (#6470, which contains
`38cf975a1d`) cut over at 05:55:30 UTC and is what `engine.smarter.poker/health`
reports.

| engine                    | window (UTC)      | hours | horse entries | `Horse registration:` passes | roster cache diverged lines | refused calls |
| ------------------------- | ----------------- | ----- | ------------- | ---------------------------- | --------------------------- | ------------- |
| `a29a591da2` (before fix) | 01:55:21-05:53:02 | 3.96  | 10,182        | 63                           | 3                           | 5             |
| `4dbbd0672d` (fix served) | 05:55:30-06:51:52 | 0.94  | 2,199         | 2                            | 0                           | 0             |

Before: 0.76 lines and 1.26 refused registrations an hour on the last engine
without the fix (2.2 refusals an hour over the 78-hour archive). After: zero
over the first served hour at a comparable entry rate (about 2,340 horse
entries an hour against 2,570). Read-only at 06:52:08 UTC, 0 of 113 pre-start
events held a count that disagreed with its roster. One served hour is short
against a 0.76-an-hour baseline, so the engine-log command above remains the
measure on every later engine.
