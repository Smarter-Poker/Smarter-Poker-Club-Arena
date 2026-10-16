# Record Five Applied Migrations

Production had applied five migrations that had no file on main, so `Applied Migrations Are Recorded` and the PR check `Installed and merged migrations agree` reported them as installed with no record.

Each file is the exact bytes production holds in `supabase_migrations.schema_migrations.statements`, confirmed through `public.fn_ca_migration_text`:

- `20261015181721_a_close_proving_loop_stops_on_the_statement_clock.sql` (MD5 `3c85514ade70bc534d316ab1655af111`)
- `20261015213617_diamond_hand_history_admits_automatic_arena_membership.sql` (MD5 `4e52c01d47aaf3374e85cf33e4788af1`)
- `20261015220449_diamond_launch_copy_and_report_only_rule_are_explicit.sql` (MD5 `3c87c59a9abf58a71813ea590160ee32`)
- `20261015222118_an_owner_floor_park_is_not_an_outage.sql` (MD5 `9bcbe6631a8f538fc9b188b4682d9bbe`, identical to open PR #7050)

Every guard finding was checked against production and written into the manifest row. The flagged deletes in `20261015181721` are text anchors, and the live statement keeps its `WHERE` clause. The functions the stale schema snapshot did not list all exist live with the recorded owners, security mode, search paths and grants. Nothing is installed or replayed.

`20261015180754` is recorded exactly as production holds it: one 73-byte statement that is the file name itself (MD5 `922e8c28f55e49a2c8a88d01fd12071b`). It is not executable SQL and must never be replayed. Production did not store the SQL that ran under that version. What is live from it is described in the manifest row: the `trg_weekly_statement_issue_settled` trigger on `settlement_invoices` and its function.
