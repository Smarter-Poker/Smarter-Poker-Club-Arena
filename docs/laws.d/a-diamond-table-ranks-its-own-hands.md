# tests/a-diamond-table-ranks-its-own-hands.law.test.ts

The Leaderboard a player opens at a table read player_stats, which never holds
a Diamond hand, so at a Diamond table it was empty for ever; and the Diamond
stat rows keep only a player's newest 1,000 hands per asset, so a window cannot
be read back from them. Migration 20260930043000_a_diamond_table_ranks_its_own_hands
adds ca_diamond_player_day, private per-player, per-day Diamond running totals
that the post-commit projection fills from each Diamond cash hand's own stat
rows, and fn_diamond_arena_leaderboard_period, the chip profit board over them.
The law pins that the projection changed only by asserted substitution (live md5
pinned, reverse proved), folds only Diamond cash hands of seats with a profile,
in player order, and writes no chip table; that the totals are private; that the
Diamond board shares the chip board's window, score, order, ties, activity rule
and rank change clause for clause (checked against the chip function's own
definition in the migration corpus), leaves fixture accounts out and never names
the horse flag; that a signed-in player may read it and a visitor may not; that
fn_club_leaderboard_period_v2 is untouched and nothing is priced or opened; and
that a Diamond table asks the Diamond board through its arena asset with
loading, empty and could-not-tell states while a chip table asks as before.
