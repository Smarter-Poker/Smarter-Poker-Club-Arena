# tests/horse-tournament-scoreboard-counts-satellite-winners.law.test.ts

fn_horse_tournament_daily_compile counts a tournament_players row whose status is
'winner' even when its position is NULL, which is how every satellite seat,
ticket and cash winner finishes. Before 20261016103322 the scoreboard kept only
rows with a position, dropped 2,975 satellite winners (164,900.00 in prizes) in
the 7 days to 2026-10-15, and read SATELLITE ROI -81.1% when the real figure is
-9.2%, the fee. The law pins the row filter, first place for a positionless
winner, the unchanged invested/won formulas, the 2026-09-18..2026-10-15
backfill, the service_role grant and the single transaction.
