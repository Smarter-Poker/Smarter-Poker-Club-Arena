-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826050145; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_mint_chips_from_diamonds writes transaction_type 'mint'. The index added
-- moments ago guessed 'chip_mint' from the function name - which is the
-- category deduct_diamonds uses on the DIAMOND side, not the chip ledger's
-- word. An index on a type nobody writes protects nothing.
drop index if exists public.chip_transactions_staff_ops_op_id_uidx;

create unique index chip_transactions_staff_ops_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type = any (array['admin_removal', 'mint', 'cashout_expired_refund'])
    and metadata ? 'op_id';
