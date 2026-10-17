# tests/horse-tournament-scoreboard-scores-finish-against-the-real-field.law.test.ts

fn_horse_tournament_daily_compile measures a horse's finish against the real
field: the number of tournament_players rows of that tournament (every seat,
horse or human), never t.current_players, which is 0 or 1 once a tournament is
COMPLETED. Before 20261017033522_horse_tournament_scoreboard_scores_finish_against_the_real_f.sql every finish scored 0 (a win) for all 432,313 horse
entries in the 7 days to 2026-10-16. The law also pins the satellite winner rule
(status 'winner' with no position counts as first, from PR #7091), the unchanged
invested/won formulas, the recompile of every scoreboard day, the service_role
grant and the single transaction.
