# The Club Data Screen Lists What Was Played (2026-10-15)

Found in Dan's "check for any and all bugs, gaps ... wiring issues" sweep.

The everyday Club Data screen took its game list from `ca_club_data_snapshot.rows`, which keeps the games with the latest `started_at`. For SHARK CLUB on 1 Day (14:15 UTC) that was 11,898 games and the first rows were tournaments still registering for Saturday and Sunday. A cash table's `started_at` is the day the table was created, so the day's live cash games sorted below thousands of future registrations and never reached the list.

`ca_club_data_screen` (migration `20261015142005`) returns the same totals the snapshot reports for the window (`fn_ca_club_game_summary` plus the live felt) and the games ordered by activity inside the window: games in play first, then the most recently active. Cash rows show their last activity time; tournaments their start time. Measured on SHARK CLUB: 1 Day in 1.4 s with live cash tables at the top. The 14-day window no longer pays for the snapshot's previous-window comparison and row materialisation (14.7 s with them); now 0.8 s for 1 Day and 1.3 s for 14 Days, measured on production.

The advanced report keeps `ca_club_data_snapshot` and its cursor paging unchanged.

Also in this change: `useTableArt` remembers which URL actually decoded (the original or the retry that succeeded), so a second table paints the copy the browser already holds instead of the original URL that failed.
