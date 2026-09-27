-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820054020 "p0_rake_records_dedupe_for_null_hand"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6f4f2eff6f0055ca6455330a8c07bdb9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Second half of the null-hand rake fix.
--
-- The deterministic leg key stopped the wallet/treasury double-credit, but a
-- re-drive still INSERTED a second rake_records row: the only dedupe on that
-- insert is `ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL`, which by
-- definition cannot fire for a null hand. Proven by a rolled-back live test
-- after the leg-key fix: two calls -> wallet credited once (correct) but
-- rake_records went 0 -> 1 -> 2.
--
-- That duplicate row is not merely audit noise. rake_records is the rakeback
-- settler's sole input, and apply_rakeback_player_stats claims on
-- (rake_record_id, user_id) -- so a duplicate row carries a NEW id and pays
-- every player in that hand their rakeback share a second time.
--
-- Fix: when there is no hand id, look the record up by the identity the caller
-- does have -- (table_id, hand_number) -- and skip the insert if it is already
-- there. Deliberately NOT a unique index: 55 duplicate pairs already exist in
-- production, so an index would fail to build, and deleting historical money
-- rows is Dan's call, not a migration's. The check-then-insert is a TOCTOU, but
-- a losing race now costs one duplicate audit row and nothing else, because the
-- money legs are separately gated by the deterministic leg key.
--
-- Patched by text substitution against the live definition, with anchor checks,
-- so a silent no-op is impossible and nothing else in the body can drift.
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

  -- 1. Guard the INSERT with a null-hand pre-check.
  v_new := replace(
    v_src,
    '  INSERT INTO public.rake_records (',
    '  IF p_hand_id IS NULL THEN' || E'\n' ||
    '    SELECT id INTO v_rr_id' || E'\n' ||
    '      FROM public.rake_records' || E'\n' ||
    '     WHERE hand_id IS NULL' || E'\n' ||
    '       AND table_id = p_table_id' || E'\n' ||
    '       AND metadata->>''hand_number'' = p_hand_number::text' || E'\n' ||
    '     ORDER BY created_at' || E'\n' ||
    '     LIMIT 1;' || E'\n' ||
    '  END IF;' || E'\n' || E'\n' ||
    '  IF v_rr_id IS NULL THEN' || E'\n' ||
    '  INSERT INTO public.rake_records ('
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'rake_records INSERT anchor not found - refusing to patch blindly';
  END IF;

  -- 2. Close that IF and keep the existing-row lookup for the non-null path.
  v_src := v_new;
  v_new := replace(
    v_src,
    '  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING' || E'\n' ||
    '  RETURNING id INTO v_rr_id;' || E'\n' || E'\n' ||
    '  IF v_rr_id IS NOT NULL THEN v_first_claim := true;' || E'\n' ||
    '  ELSE SELECT id INTO v_rr_id FROM public.rake_records WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;' || E'\n' ||
    '  END IF;',
    '  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING' || E'\n' ||
    '  RETURNING id INTO v_rr_id;' || E'\n' ||
    '    IF v_rr_id IS NOT NULL THEN v_first_claim := true; END IF;' || E'\n' ||
    '  END IF;' || E'\n' || E'\n' ||
    '  IF v_rr_id IS NULL AND p_hand_id IS NOT NULL THEN' || E'\n' ||
    '    SELECT id INTO v_rr_id FROM public.rake_records WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;' || E'\n' ||
    '  END IF;'
  );
  IF v_new = v_src THEN
    RAISE EXCEPTION 'first-claim block anchor not found - refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$mig$;
