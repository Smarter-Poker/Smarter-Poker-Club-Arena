# A template table refuses a bomb edit it would undo (2026-10-06)

## What was wrong

"Edit Bomb Pot Settings" (staff, from the in-table Game Rules) calls
`fn_update_table_bomb_settings`, a plain UPDATE of `public.tables`. A table
that belongs to a cash game has the same columns written back from
`cash_games.ruleset_snapshot` by `fn_cash_apply_ruleset` on every cluster tick,
about every five seconds, and every open cash table on production belongs to
one. The host saw "saved", the table reverted with no message, and the save had
already cleared `bomb_pot_sched_state` and `bomb_pot_next_due_at`. The four
columns the ruleset does not write (fixed ante, bomb variant, button policy,
announce seconds) stuck, so a table could play a bomb its lobby card did not
describe. `table_settings_changes` held zero rows: nobody had ever made the
page work.

## The fix, at the cause

Two writers of one rule; the template is the authority. Migration
`20261006031707` adds one block to the installed function: a table with
`cluster_id` is refused with `set_by_the_game_template` before anything is
read or written. The page shows "Bomb Pots At This Table Are Set By The Game
Template". A table with no cluster keeps the door as it was.

Changing a running game's bomb rules belongs in an owner door on the game's
ruleset (as kills have in `fn_set_cash_game_kill_settings`); that door does
not exist yet and is not invented here.

## Proof

Scratch PostgreSQL 16: a clustered table answers the refusal and its enabled
flag and schedule state are untouched; a table with no cluster saves as
before. On production the anchor occurs exactly once in the installed
definition (md5 `1686b0072db257921e0dfba91a888bf4`).
