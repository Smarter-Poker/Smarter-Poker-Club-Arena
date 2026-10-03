# The inventory seal is computed six hours at a time (2026-10-03)

## What happened

The original inventory seal of a closed week (`fn_union_pnl_inventory_checkpoint_seal`) is one
transaction over every event of the week: 534 s for the 478k rows of the week of 2026-09-21. The
week closing 2026-10-05 07:00 UTC carries ~2.2x those events (13.2M by 2026-10-03 07:00), so in
one go it would run well past the 5-minute cap every close transaction keeps during play, beyond
which tournament leases expire.

## Fix

Migration `20261003180832_the_inventory_seal_is_computed_six_hours_at_a_time`:

- Unlogged staging (`union_pnl_inventory_seal_layers`, `_layer_rows`, `_layer_issues`) keyed by
  boundary and layer end.
- `fn_union_pnl_inventory_layer_state`: `fn_union_pnl_inventory_state` over one six-hour layer's
  events, continuing each touched row from its latest earlier layer, else the week's base
  checkpoint, and returning each touched row with its complete issue set.
- `fn_union_pnl_inventory_seal_advance(at, verify)`: at least one layer per call; none started
  after the call's cutoff; once all layers exist, assembles the week (untouched base rows plus each
  touched row's latest layer) and seals it with exactly the statements of the one-go seal. With
  `verify` it compares the assembly with an already sealed checkpoint instead. Staging is
  recomputed whenever it belongs to another boundary or base (an unlogged table is emptied by a
  crash, so nothing is trusted that cannot be rebuilt).

Migration `20261003183034_the_weekly_close_seals_its_inventory_six_hours_at_a_time`:

- Inside a chunked close tick (job 272), `fn_union_pnl_inventory_checkpoint_due` seals a missing
  boundary with `fn_union_pnl_inventory_seal_advance` and returns `sealing` while layers remain;
  `fn_process_weekly_accounting_scope` then ends that tick before any scope (every scope's P&L
  reads the checkpoint) with `more_remaining`. Outside a chunked tick the seal is unchanged.
- The cutoff is 90 s (was 120 s): at the projected ~90 s for this week's largest layer, a call
  stays under ~3 minutes.
- The tick that completes a seal visits no scope either: it ran under job 272's large seal budget
  (3600 s, 50-minute scopes), and the next :40 tick visits the scopes with the ordinary one.
- Job 272 calls the close on every 5-minute tick while a split seal is in progress
  (`fn_union_pnl_inventory_seal_in_progress`: layers staged for the current week's boundary and no
  checkpoint yet), not only at :40, so a seal of ~7 calls takes ~35 minutes instead of ~7 hours.
  A crash empties the unlogged staging; the seal then restarts at the next :40 tick.
- `fn_accounting_close_seal_held` answers false. The gate of `20261003155132` held the gated week's
  seal only because it was one long transaction; the gate still holds that week's first close
  attempt, and the seal now runs from the first 40-minute tick after the week ends.

## Proof

On the sealed week ending 2026-09-28 (base: the 2026-09-21 checkpoint), against production,
`fn_union_pnl_inventory_seal_advance('2026-09-28 07:00+00', true)`: 28 layers in three calls of
132 s, 145 s and 80 s (largest layer 41.6 s, all layers 356 s), then the assembly in 14.7 s:
478,197 rows and 0 issues, rows_md5 `969158f5ab29272a49114d497bb4892f`, issues_md5
`d41d8cd98f00b204e9800998ecf8427e`, max_event_id 14440852 - the sealed checkpoint's own values.
The population readback (`fn_union_pnl_inventory_population`) of the assembled week took 8.7 s and
its result md5 equals the stored one.

Dry run of `20261003183034` against production at 2026-10-03 18:38 UTC, rolled back: the four
live proofs true; a chunked `checkpoint_due` with nothing missing returns `ready`; no seal in
progress; scheduler postimage md5 `7f78ea4582c827a26d5cb72093cea058`, equal to the substituted
text; job 272 command md5 `3d27a473c11051deb6fe00ceffd4e409`, schedule unchanged;
`plpgsql_check` finds nothing in the scheduler or `checkpoint_due`, and in `seal_advance` only the
existing false positive for its runtime temp table `_inv_layer`.
