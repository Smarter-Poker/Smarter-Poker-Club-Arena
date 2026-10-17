# A Union Club Leaderboard Ranks Its Own Players

**Date:** 2026-10-17
**Migration:** `20261017025229_a_union_club_leaderboard_ranks_its_own_players.sql`
**Test:** `tests/a-union-club-leaderboard-ranks-its-own-players.test.ts`

Shark Club's Today, This Week and This Month leaderboards were empty while All
Time listed 510 players. Cash hands fold into the `player_stats` row of the
table's club, and a union's shared tables belong to the union root, so a Shark
player's play since sharing began accrues on their Midway row and their Shark
row stopped moving (hands_dealt 4,300,198 in every snapshot since 10-09). No
writer had stopped; the reader looked in the wrong place.

For open periods, a union member club now ranks its own players (the Players
page's home attribution) on their deltas across the union's root and member
clubs. All Time, standalone clubs and the union root are unchanged. Prize
settlement reads `fn_leaderboard_complete_round_basis`, not this function, and
none of these clubs has a prize program, so nothing can pay or re-pay.

Proof on production: Shark daily 0 to 428 ranked, weekly 0 to 500, monthly 0 to
509, All Time 510 with zero differing rows; JAQK 0 to 1, 3 and 4; the Midway root
and a standalone club identical in every period.
