# 2026-09-05 - Gate 5: the snapshot is the rule on every table

Operation Table Stakes, Gate 5 (Slice 4: antes + VPIP + bombs). The rules
themselves already reached the felt through the template snapshot: antes
(Action a small-blind ante from every seat, Madness the big blind's ante),
the VPIP floor and its ten-hand window, the bomb clock (Action every 15
minutes, now converting to 1-5 hands at three minutes out; Madness every
orbit), double boards, the buy-in band. What did not exist was the engine
that keeps a table's rules equal to its game's.

## What production showed

A game's `ruleset_snapshot` was copied onto a table once, by
`fn_cash_cluster_open_table`, and never read again. 27 Action games whose
snapshots say VPIP 30 / 35 / 40 by variant, every table at 30; 27 Madness
games whose snapshots say 60 / 65 / 70, every table at 50 (the template
floors were raised per variant after Main 1 had been opened). The felt
printed the table column, `fn_nit_check` judged by it, and the lobby card
printed the snapshot - one floor shown, another enforced.

## `20260905033729_the_snapshot_is_the_rule`

`fn_cash_apply_ruleset(game)`: the opener's exact snapshot mapping as an
UPDATE over every open table of the game, touching only rows that differ,
and emitting `ruleset_applied` with the count. The tick's RECONCILE calls
it before anything is planned, so a rule reaches every table of a game
within one tick of the snapshot changing. Probed rolled back on the real
rows (one game corrected by its tick, a second call idempotent, all 47
stale rows corrected, Madness keeps its BB-ante flag, Classic gains
nothing, Action keeps its 15-minute clock); applied 03:41 UTC; 46 tables of
46 games corrected within 12 s (the 47th belongs to a disabled game that
never ticks - its table is live with no game behind it and is the Gate 7
recon's).

The engine reads ante and bomb columns at boot and on its settings re-read;
the VPIP rule reads the row live. `TheTablesOpenAndCloseThemselves`
64 (+2).

## Still Dan's

Which floors and clocks the templates carry (`fn_cash_template_defaults`)
is his: this gate makes whatever they say true on every table.

## Gate 6, the copy (same branch)

OPORD 1.4 s2.9 / A3.6: a must-move game is joined, viewed and watched as a
GAME, because the platform picks the table. Every cash action surface -
the lobby row (`LobbyTable`), the pre-commit panel (`GameLobbyPanel`), the
premium card (`ArenaLobbyGameCard`) - now says Join Game / View Game /
Watch Game / Return To Game / Game Closed for a cluster entry and keeps
Join Table / View Table / Watch Table for a manual table.
`tests/a-game-is-joined-as-a-game.law.test.ts` renders both and greps
the game path. Straddles: R2 already holds (every cluster table is
written false, and the applier re-writes false every tick); the override
control's removal from the create flow is a Gate 7 item with the cutover.

## Gate 7, the cutover (same branch; Dan: "DO WHAT YOU THINK NEEDS TO BE DONE")

Option A of `docs/HANDOFF-TABLE-STAKES-GATE-7.md`.
`20260905034937_gate_7_every_cash_table_is_a_game`, probed rolled back over
every key (`scripts/dev/probe-cutover.sql`: the law holds on every row, one
Main 1 and at most one feeder per game, the adopted snapshots reproduce
their rulebooks under the applier, the roster covers everyone seated, the
ensure door finds and creates, a tick on the nine-table game runs clean),
applied 03:56 UTC in three transactions: **41 games written, 105 tables
adopted across 43 games, 184 seated, 41 empty tables set breaking**; the
CHECK `tables_cash_needs_a_game` added NOT VALID under a 3 s lock and
validated without blocking play. Zero open cash tables outside a cluster.

- `fn_cash_game_ensure(club, variant, sb, bb, template, handedness)` -
  service-only, idempotent on the key: the game, created with Main 1 if
  absent, re-enabled if a host had closed it.
- The adoption: one game per key, template by the shape of the key's oldest
  table's rules (Madness = BB ante + VPIP floor + orbit bomb; Action = VPIP
  floor + timed bomb; else Classic), snapshot built FROM that table so Gate
  5's applier changed nothing on those tables but straddles (R2; 6 keys),
  handedness the oldest table's seats (8 seated at an 8-max are not told to
  stand; new games still get R1's 6), `cap_mains` at least the key's table
  count so nothing was broken for the cap alone; oldest table Main 1, the
  rest Main 2..N by age, the newest of two the feeder; empty ones
  `breaking` (the tick closes them, nobody is cashed out); cluster names;
  the Stable Hand's park/retire keys and the lifecycle-pass flags off;
  everyone seated on the game's roster at their chair time.
- Engine (`HorseFleetManager`): the Stable Hand's open order is now
  `fn_cash_game_ensure` (a GAME on the host, never a table);
  `spawnOverflowTables`, `retireSurplusTables` and `MAX_TABLES_PER_CONFIG`
  are deleted (demand opens a feeder through the controller's OPEN rule,
  thin tables close through its BREAK rule); `ensureAllTablesExist` inserts
  and reactivates nothing (the union ladder is `cash_games`; RECONCILE keeps
  Main 1 open). `runTableLifecyclePass` stays: a manual (R9) game's table
  still closes itself when it empties. The browser-side `HorseOrchestrator`
  table insert now fails at the database and is left for its own retirement.
- What the Stable Hand loses: its night park and exotic-excess close acted
  on tables and no longer act on cash (a cluster table was already exempt);
  the controller's balance floor and break rule consolidate thin tables in
  their place. Its seating targets and host caps are untouched.

Watch after the engine lands (the :55 after merge): `game_adopted` games
ticking, `table_break_completed` on the 41 empties, must-move filling Deep
Stack Society's Main 1s in roster order, and no `openPlannedGame_failed`.
