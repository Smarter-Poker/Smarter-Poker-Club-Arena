# tests/the-arena-counts-its-players.law.test.ts

The Diamond Arena's Players page shows four figures, members, online, at
tables and tables, from fn_diamond_arena_counts, and lists the arena's
players from fn_diamond_arena_roster (migration
20260929214500_the_arena_counts_its_players). The law pins who counts as a
player, written once in fn_diamond_arena_is_player: a live sign-in, an open
account, not a certification fixture, and horses never named, so they can
never be left out (CLAUDE.md 10.5). It pins that every figure is read through
that rule and answers a number or NULL with a named reason, never a zero made
from a failed read; that online is a number only while the presence feed
shows the person asking; that a roster row carries its seven fields and no
role, upline, downline, fee, wallet, chip or horse field; that only signed-in
players can call the two readers while the rules stay internal; that the
migration writes nothing, touches no chip roster reader and opens no switch;
and that the arena's Players door opens the Diamond page by the server's
entitlement while a chip club still gets the chip roster.
