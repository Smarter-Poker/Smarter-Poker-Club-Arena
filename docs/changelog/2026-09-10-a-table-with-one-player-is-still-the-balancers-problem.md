# A table with one player is still the balancer's problem

2026-09-10

## Root cause

Tournament balancing sourced its table list from `tableEngines`, the registry
of tables that are actively capable of dealing. A table reduced to one player
cannot deal, so it has no engine. That removed it from the balancer's view and
prevented its remaining player from ever being consolidated with another
one-player table.

Production measurement found 35 running tournaments in this shape. The worst
had 36 funded players spread one per table, leaving every table structurally
unable to begin a hand.

## Fix

Both ordinary balance passes now read live `running` or `waiting` tables that
hold at least one unleft seat from the database. `loadBalancerTables` already
loads its authoritative table and seat state from the database and tolerates a
missing engine by defaulting its button seat, so no synthetic engine or repair
loop is introduced.

The final-table counter delegates to the same reader. A failed table or seat
read remains unknown and schedules the existing coalesced balance redrive; it
is never interpreted as an empty or balanced tournament.
