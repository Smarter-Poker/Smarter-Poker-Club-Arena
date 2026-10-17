# Club Player Hands Read Their Club Range

**Date:** 2026-10-17
**Migration:** `20261017005207_club_player_hands_read_their_club_range.sql`
**Test:** `tests/club-player-hands-read-their-club-range.test.ts`

The Club Data Players page and player summary timed out on about 21% of calls
(SQLSTATE 57014 under the 8s authenticated limit). The hand count joined
`club_member_daily_stats` to every attributed player, so a union club ran one
index probe per player per scoped club (2,300 probes, 870,515 rows, 1.6M
buffers for Shark Club's 14 days). The three player readers now read the
scoped clubs' date range once through `idx_cmds_club_date_hot` and sum by
player. Results were proven identical row by row in one production snapshot
(12 of 12 club and window cases). Shark Club's 93-day hand step went from
12.8 s to 1.0 s. No index carrying a per-hand column was added.
