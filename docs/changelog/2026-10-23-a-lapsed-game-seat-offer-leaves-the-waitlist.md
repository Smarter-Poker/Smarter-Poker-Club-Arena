# A Lapsed Game Seat Offer Leaves The Waitlist (2026-10-23)

## What Was Wrong

Verified read-only on 2026-10-23 at 09:35 UTC: `cash_game_waitlist` row
`6955c265` (game `56d5d6f0`) had been `notified` since 2026-10-22 09:23:17.
The player was seated at 09:23 through the vacancy offer and left at 09:57,
and the row never moved on. It was the only live `notified` game row, and it
had no live table hold and no seat in the game.

- `fn_offer_open_seat` moves a game row `waiting` to `notified` and holds a
  chair at one table for sixty seconds, but it only ever expires or offers
  `waiting` game rows.
- `fn_cash_game_join` marks the game row `seated` only when the caller is
  already seated when they press Join Game, and its waitlist branch found the
  stranded `notified` row, so it answered `waitlisted` without re-queueing.
- The Cluster tick, which also tidies these rows, stands down for Lightning.

So once an offer's hold lapsed, or the player sat down through the offer and
later left, they could never be offered a seat in that game again, and every
rejoin said `waitlisted`. This applies to every Cluster cash game.

## The Change

Migration `20261023094000_a_lapsed_game_seat_offer_leaves_the_waitlist`:

1. `fn_offer_open_seat`, right where it already expires lapsed table holds,
   reads the game of the vacant table. Each `notified` game row whose player
   is seated at one of the game's tables becomes `seated`. Each one whose
   player holds no live hold in the game (`coalesce(hold_expires_at,
notified_at + offer TTL) > now()`) and sits nowhere in it becomes
   `expired`. Rows are claimed nonblocking (user claim and `SKIP LOCKED`), so
   the pass never waits while it owns the table key.
2. `fn_cash_game_join`, just before it queues the caller, expires a lapsed
   `notified` row of theirs (they are not seated, which the door answers
   first), so the caller is queued afresh as `waiting` behind the players
   already in line.
3. A one-time, bounded, idempotent sweep expires the rows already stranded
   and reports the count as `lapsed_game_offers_expired`.

Unchanged: the order among players genuinely waiting, hold durations, the
concurrent hold cap, wallet checks, money paths, function owners, `SECURITY
DEFINER`, `search_path` and grants. The migration refuses to install over any
definition other than the live one it was written against.

## Proof

`scripts/ci/test-unattended-cash-offer-postgres.py` (native PostgreSQL 17,
accounting shard 2) now also proves, failing before and passing after the
migration: a lapsed offer is expired and the next player is offered; the
lapsed player can rejoin, is queued as a fresh `waiting` row and is later
offered a seat; a live hold is never expired; a player seated through the
offer gets the game row `seated`; the order of the other waiters is
unchanged; the sweep expires only stranded rows; replay is refused.

## Follow Up: A Seated Player's Stranded Row Reads Seated

Installed 2026-10-23 12:38 UTC. The one-time sweep expired nothing, because
by then the player on row `6955c265` had sat down at game `56d5d6f0` again
(11:25 UTC). The offer pass marks such a row `seated`, but every chair in
that game was taken and no vacancy offer had run, so the row still read
`notified` and the game's waitlist and population counts still included her.

Migration `20261023124157_a_seated_players_stranded_game_offer_reads_seated`
applies the same rule once, as data only: a `notified` game row whose player
is seated at that game becomes `seated` (bounded, idempotent, locked rows
skipped, count reported as `seated_game_offers_marked`). No function changes.
The native test adds both cases (the seated row is marked, a row whose player
is not seated is left).
