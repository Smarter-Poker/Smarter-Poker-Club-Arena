# tests/the-arena-counts-active-players-not-fixtures.law.test.ts

The Diamond Arena's ACTIVE figure, on its home card and its lobby rail, is
read from get_club_players_playing, and migration
20260929233000_the_arena_counts_active_players_not_fixtures makes a diamonds
club answer from fn_diamond_arena_players_playing: the players with a live
seat at an open arena table, counted by fn_diamond_arena_seated_players, the
rule and the number of the Players page's At Tables ("Fixture accounts are
not players; horses are", docs/DIAMOND-RULINGS.md). The law pins that the
reader counts through that rule, never names horses and answers only for the
one arena; that a signed-in player may call it and a visitor may not; that
get_club_players_playing changed only by asserted substitution with the live
md5 pinned and the reverse proved, so the chip count is untouched and stays
an invoker read; that the migration writes nothing and opens no switch; and
that the home card and the lobby rail still ask get_club_players_playing.
