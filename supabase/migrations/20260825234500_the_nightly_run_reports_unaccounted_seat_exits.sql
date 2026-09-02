-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825234500; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A detector nobody runs is a detector that does not exist.
--
-- reconcile_ledger_nightly already writes into ledger_reconcile_log and is
-- already read by whoever reads that table. So the seat-exit check reports
-- THERE, in the same severities, rather than in a new place with a new
-- audience of nobody.
--
-- One row per unaccounted exit, at 'critical': chips that stopped existing is
-- not a rounding warning. `ledger_balance` carries the stack that vanished and
-- `stored_balance` is 0, which is what the pair means here -- the ledger says
-- these chips were on the felt and nothing says where they went.
--
-- Patched rather than restated so nothing else in that function is disturbed.
DO $$
DECLARE
  v_def text;
  v_anchor CONSTANT text := '  -- Recompute the summary counts from what we just inserted today';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly does not exist - refusing to guess';
  END IF;
  IF position('seat_stack_exit' in v_def) > 0 THEN
    RAISE NOTICE 'the nightly run already reports seat exits';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def, v_anchor,
    E'  -- ── Chips that left the felt and landed nowhere (added 2026-08-25) ──\n'
    || E'  -- The two pools above are chip_ledger vs `wallets` and vs\n'
    || E'  -- `clubs.chip_pool`. Club Arena''s money is in NEITHER: it is in\n'
    || E'  -- club_members.chip_balance and table_seats.stack. Both were wholly\n'
    || E'  -- unreconciled, which is how 48 chips were destroyed on 2026-08-25\n'
    || E'  -- with nothing noticing. See fn_unaccounted_seat_exits.\n'
    || E'  INSERT INTO public.ledger_reconcile_log\n'
    || E'    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)\n'
    || E'  SELECT ''seat_stack_exit'', x.user_id, x.stack, 0, ''critical'',\n'
    || E'         jsonb_build_object(\n'
    || E'           ''source'', ''fn_unaccounted_seat_exits'',\n'
    || E'           ''exit_id'', x.exit_id, ''table_id'', x.table_id,\n'
    || E'           ''club_id'', x.club_id, ''exit_kind'', x.exit_kind,\n'
    || E'           ''db_role'', x.db_role, ''app_name'', x.app_name,\n'
    || E'           ''occurred_at'', x.occurred_at)\n'
    || E'  FROM public.fn_unaccounted_seat_exits(''1 day''::interval) x;\n\n'
    || v_anchor);
END $$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF position('seat_stack_exit' in v_def) = 0 THEN
    RAISE EXCEPTION 'the seat-exit check did not reach the nightly run';
  END IF;
  -- The two pools it already checked must both still be there.
  IF position('player_wallet' in v_def) = 0 OR position('club_treasury' in v_def) = 0 THEN
    RAISE EXCEPTION 'an existing reconciliation was dropped by this patch';
  END IF;
END $$;
