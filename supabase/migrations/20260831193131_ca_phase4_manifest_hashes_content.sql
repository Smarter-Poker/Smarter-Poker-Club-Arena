-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831193131; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT phase 4 fixup: the day manifest hashed only row_hash values,
-- which are NULL for rows written before the 2026-08-31 ledger hardening —
-- yesterday's manifest was the SHA-256 of an empty string. The manifest now
-- hashes deterministic row content (id, amount, accounts, category,
-- created_at, plus row_hash when present), ordered by (created_at, id), so
-- any historical day manifests meaningfully. Algorithm change ⇒ stored v1
-- manifests are dropped and recomputed (only one existed, written minutes
-- ago by this same phase).
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest(p_day date DEFAULT (CURRENT_DATE - 1))
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count bigint; v_net numeric; v_first bigint; v_last bigint; v_sha text; v_prior text;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0), min(chain_seq), max(chain_seq),
         encode(extensions.digest(
           COALESCE(string_agg(
             id::text || '|' || amount::text || '|' || from_type || ':' || COALESCE(from_entity_id::text,'') ||
             '>' || to_type || ':' || COALESCE(to_entity_id::text,'') || '|' || category || '|' ||
             extract(epoch from created_at)::text || '|' || COALESCE(row_hash,''),
             E'\n' ORDER BY created_at, id), ''), 'sha256'), 'hex')
    INTO v_count, v_net, v_first, v_last, v_sha
    FROM public.chip_ledger
   WHERE created_at >= p_day AND created_at < p_day + 1;

  SELECT sha256 INTO v_prior FROM public.ca_ledger_day_manifests WHERE day = p_day;
  IF v_prior IS NOT NULL AND v_prior <> v_sha THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_ledger_day_manifest', 'unauthorized_adjustment', 'critical',
      'manifest-mismatch:' || p_day::text,
      0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the recomputed ledger manifest for ' || p_day || ' no longer matches the stored one — historical rows changed',
      false, jsonb_build_object('day', p_day, 'stored', v_prior, 'recomputed', v_sha));
    RETURN jsonb_build_object('day', p_day, 'tampered', true, 'stored', v_prior, 'recomputed', v_sha);
  END IF;

  INSERT INTO public.ca_ledger_day_manifests (day, row_count, first_seq, last_seq, net_amount, sha256)
  VALUES (p_day, v_count, v_first, v_last, v_net, v_sha)
  ON CONFLICT (day) DO NOTHING;

  RETURN jsonb_build_object('day', p_day, 'rows', v_count, 'net', v_net,
    'first_seq', v_first, 'last_seq', v_last, 'sha256', v_sha, 'tampered', false);
END $function$;

-- Drop the single v1 (empty-hash) manifest and recompute with v2.
DELETE FROM public.ca_ledger_day_manifests WHERE day = '2026-08-30';
SELECT public.fn_ca_ledger_day_manifest('2026-08-30'::date);
