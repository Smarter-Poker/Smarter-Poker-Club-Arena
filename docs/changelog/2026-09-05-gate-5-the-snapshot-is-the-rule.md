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
