-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212026; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30: ca_hand_player_idx has no index on hand_id, so any
-- delete-by-hand (the pruner integration) is an 18.6M-row seq scan.
set local statement_timeout = '600s';
create index if not exists idx_ca_hand_player_idx_hand_id
  on public.ca_hand_player_idx (hand_id);
