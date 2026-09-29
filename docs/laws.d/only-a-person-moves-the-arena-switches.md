# tests/only-a-person-moves-the-arena-switches.law.test.ts

The Diamond Arena has two switches, ca_arena_settings.cash_games_enabled and
tournaments_enabled, and they are Dan's. The engine reads them and refuses a
closed kind of game, and nothing turns them on or off by itself. That means no
alarm, watch or door can lock the arena: financial alerts page a person and
lock nothing. This law pins that, as item 9 of the Phase 10 audit asked (line
5, "without arena-wide automatic lockout").

The law fails in two cases. The first is a migration that defines a function
that writes either switch. That covers a trigger, a watch, a door, a cron body,
or a body built by substitution inside a string. The second is the engine's
runtime source (server/src) writing ca_arena_settings at all. A migration's own
statement, whether top level or inside its DO block, runs once when a person
applies it. That counts as a person moving the switch and is allowed. The
detector is checked against written switches, reads, other columns and a
person's own statement. The engine's two readers of the switches must still be
there, so the check cannot pass on an empty search. The Diamond alarm migration
proves the live side when it is applied: no function in any schema writes the
settings row.
