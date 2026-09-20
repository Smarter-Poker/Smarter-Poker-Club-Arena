# tests/a-diamond-figure-is-real-or-it-is-unknown.law.test.ts

The Diamond Arena reported an empty room that nobody had measured. Its ACTIVE
count came from `fn_batch_club_realtime_active_counts`, which reaches its seats
through `club_members ... status IN ('active','approved')` - and Diamond
membership is an entitlement, one row, status `automatic`, so that join matched
nobody and the answer was structurally 0 for every player on every load while
the arena carried 17 live tables. In the lobby the same figure was 0 for a
different reason: `get_club_home` short-circuits for a diamonds arena with
`access_only` and carries no `players_playing` at all, so `ClubIdentityCard`
rendered a null as the string "0". `lobbyFigureCache` then filed that zero as
the last known figure and served it back on the next visit. All three fold "I
could not tell" into "nobody is playing", which CLAUDE.md 10.86 rule 1 forbids.
This pins that no Diamond count is derived from `club_members`, that the count
comes from a live-seat read, that an unreadable figure renders as an unknown
rather than a zero, and that the figure cache neither stores nor serves a zero
as something it knew. The three answers a count may give are defined once in
`src/lib/countFigure.ts`: a number, a pending null that still prints Dan's
loading zero, and an explicit unknown that never prints a number.
