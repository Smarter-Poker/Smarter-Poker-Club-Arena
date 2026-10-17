# A satellite winner is not capped by the satellite it won (2026-10-17)

## What happened

"Sunday Deep Stack Satellite 10" (a4445447, a Diamond satellite with 24
entrants into "Sunday 200 Deep Stack") decided its winner at 01:32:07 UTC and
did not finish. Every settlement was refused with
`diamond_satellite_winner_at_the_table_cap`, and at 01:50
`fn_ca_tournament_finished_but_not_completed` raised a critical alarm.

## The cause

Both satellite settlement authorities measure the winner's load with
`fn_concurrent_game_load(winner, NULL, NULL, target)`. That function stops
counting a tournament's seats once it is COMPLETING, COMPLETED or CANCELLED (a
2026-09-10 fix for this exact case). A satellite is still RUNNING while it
settles, though, so the winner's own final-table seat, which this same
settlement releases, counted as one of its four games.

It was also a livelock. With the satellite seat and two other games, a winner
could book a third (load 3 < 4), and the settlement then saw four.

## The fix

Migration `20261017025359_a_satellite_winner_is_not_capped_by_the_satellite_it_won`
has both authorities pass the winner's live seat at this satellite as
`p_exclude_table_id`. Nothing else changes. The four-game cap is still
absolute: a winner with four *other* games is still refused (Diamond) or held
a noncash ticket (chip), as Diamond phase 9 decided.

No money moves in the migration. The engine's existing retry settles the
satellite once the winner has three or fewer other games. Because the
satellite seat still counts toward any new booking, the winner can no longer
book back over the cap.

Law: `tests/a-satellite-winner-is-not-capped-by-the-satellite-it-won.law.test.ts`.
