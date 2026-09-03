-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045950; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Three partial unique indexes already make a replay safe for the agent
-- wallet, the club bank and the promo wallet. Three money types were left
-- outside all of them, so a retry after a lost response moved chips twice:
--   admin_removal            staff pulling from a member
--   chip_mint                diamonds burned into chips
--   cashout_expired_refund   the nightly expiry returning an escrow
-- Same shape as its siblings: unique on (club_id, op_id), only for rows that
-- carry an op_id, so every historical row without one is untouched.
create unique index if not exists chip_transactions_staff_ops_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type = any (array['admin_removal', 'chip_mint', 'cashout_expired_refund'])
    and metadata ? 'op_id';
