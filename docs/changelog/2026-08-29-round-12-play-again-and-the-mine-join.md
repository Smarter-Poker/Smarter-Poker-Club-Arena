# 2026-08-29 — Round 12: Play Again seats the player, and Mine becomes a join

## Audit: seat-first supply — PERFECT coverage

Measured live: every spin stake x variant (4 game types x 8 stakes) holds
exactly ONE open REGISTERING game with free seats, and every Heads-Up
stake x variant (2 x 8) holds exactly TWO - all 48 combinations covered, no
holes. The recycler never leaves a player with nowhere to go, which is what
makes the enhancement below honest.

## Enhancement: Play Again is a seat, not a list

The ranking card's Play Again used to navigate to the tournaments list and
leave the player to find their own next game. Now, for a seat-first game
(spin or Heads-Up), TournamentRankingHost finds the open sibling - same
club, same buy-in, same game type, same class, the scoping rule PR #1702
made law - resolves its live table through the same occupancy election the
engine uses (fn_tournament_primary_table), and lands the player on the felt
to pick a seat. Nothing is charged by navigation; the seat is bought only at
the table's own confirm sheet. Plumbing: the session-summary payload now
carries the finished tournament's id from the exit path.

Every read is error-bound; every miss (old payload, unreadable origin, no
sibling, no live table, any throw) falls back to the list - a degraded
answer, never a dead end. A busy-ref makes a double tap a no-op. MTTs keep
the list on purpose: their "again" genuinely is the schedule.

## Optimization: the Mine filter is a join, not a client scan

The results page's My Results used to fetch EVERY tournament_players row the
player ever had (fetchAllRows, paged - thousands of rows for a regular) to
intersect against the newest-100 list in the browser. Beyond slow, it was
WRONG for the heaviest players: the list was the newest 100 completed events
OVERALL, so a spin regular whose games aged out of the global top 100 saw
their own history shrink toward empty. One `tournament_players!inner` join
now returns the newest 100 completed events THE PLAYER WAS IN - complete,
correct, one query. The CompleteSetReadsDoNotTruncate pin was moved to the
new mechanism in the same commit (the invariant is unchanged; the mechanism
that satisfies it is better).

## Verification

- tsc 0 errors client and server; full client suite green (see PR checks)
- New pins: 8 in tests/unit/playAgainSeatsThePlayer.test.ts
- Pin moved with its mechanism: CompleteSetReadsDoNotTruncate now guards the
  join
