-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820053916 "p0_rake_leg_key_deterministic_for_null_hand"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 823557013f59d85abe46e72e13775737 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- P0 CHIP MINT: atomic_distribute_rake was fully non-idempotent whenever
-- p_hand_id was NULL.
--
-- Every money leg (club_wallets accumulator, union rake_wallet, club
-- chip_treasury) is gated by rake_distribution_legs (leg_key, leg) with
-- ON CONFLICT DO NOTHING + ROW_COUNT. That gate is only as good as the key --
-- and the key was:
--
--     v_leg_key := COALESCE(p_hand_id, gen_random_uuid());
--
-- so with no hand id EVERY call minted a brand-new key and re-credited every
-- leg. The engine retries this call up to 3x, and the FeeReconciler added in
-- this session re-drives it again from the pending_fee_distributions queue, so
-- a commit-then-timeout paid the rake out two, three or four times.
--
-- This is not theoretical. Over the last 30 days there are 7,317 rake_records
-- rows with hand_id IS NULL; 55 (table_id, hand_number) pairs hold more than
-- one row, totalling 237.95 chips of rake and 16.38 of BBJ banked more than
-- once, with a worst case of one hand banked four times.
--
-- Fix: derive a STABLE key from the identity the caller always has --
-- (table_id, hand_number) -- so a re-drive of the same hand claims the same
-- key and credits nothing. md5(...)::uuid needs no extension and is
-- deterministic. p_hand_id remains the key whenever it is present, so nothing
-- about the normal path changes.
--
-- Patched by text substitution against the live definition rather than by
-- restating the whole 140-line body, so nothing else in this money function
-- can drift. The anchor check makes a silent no-op impossible.
DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'atomic_distribute_rake';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'atomic_distribute_rake not found';
  END IF;

  v_new := replace(
    v_src,
    'v_leg_key := COALESCE(p_hand_id, gen_random_uuid());',
    'v_leg_key := COALESCE(p_hand_id, md5(''rake:'' || COALESCE(p_table_id::text, ''-'') || '':'' || COALESCE(p_hand_number, -1)::text)::uuid);'
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION 'leg-key anchor not found - refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$mig$;
