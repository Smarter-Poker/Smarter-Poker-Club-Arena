# tests/a-template-table-refuses-a-bomb-edit-it-would-undo.law.test.ts

Launch audit, 2026-10-05. `fn_update_table_bomb_settings` wrote a table's bomb
pot columns while `fn_cash_apply_ruleset` wrote them back from the game's
ruleset on every cluster tick, so a host's saved edit reverted within seconds
after wiping the bomb schedule, and four columns the ruleset does not write
stuck against the template. Migration 20261006031707 makes the template the one
authority: the table-level door refuses a table with `cluster_id` before it
writes anything. The law pins the refusal, the migration's own assertions, the
page's message, and that no later migration redefines the door without it.
