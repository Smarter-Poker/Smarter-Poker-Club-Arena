-- Reserved by scripts/reserve-migration-version.sh on 2026-09-11 20:41:01 UTC.
-- D12 retires non-satellite use of the legacy ruling payer. That payer tries
-- normalization, pays cached roster prizes, freezes its own batch, and writes
-- COMPLETED without the canonical terminal receipt. Historical rulings instead
-- restore their evidenced paid contract, complete through the normal terminal
-- authority, and record their audit. No money, standings, or receipt is changed
-- by this migration. The satellite path and all function metadata are retained.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $retire_non_satellite_ruling$
DECLARE
  v_oid oid := to_regprocedure('public.fn_settle_tournament_places_by_ruling(uuid,text,text)');
  v_body text;
  v_definition text;
  v_before jsonb;
  v_after jsonb;
  v_before_hash constant text := 'b5e3efd9216d9570b1101577a8788ad8';
  v_after_hash constant text := '9cc595c1950af528220a77e295bddd19';
  v_old_select constant text := $old_select$         COALESCE(t.prize_pool_finalized, false) AS finalized
$old_select$;
  v_new_select constant text := $new_select$         COALESCE(t.prize_pool_finalized, false) AS finalized,
         t.variant, t.tournament_type, t.satellite_target_id, t.satellite_target
$new_select$;
  v_anchor constant text := $anchor$  IF v_t.status <> 'COMPLETING' THEN$anchor$;
  v_guard constant text := $guard$  -- Non-satellite rulings restore the evidenced contract and complete through
  -- fn_complete_tournament_terminal, which owns fees and terminal receipts.
  -- Refuse before the legacy normalizer, any payment, or a frozen batch write.
  IF NOT (lower(COALESCE(v_t.variant, '')) = 'satellite'
          OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
          OR v_t.satellite_target_id IS NOT NULL
          OR v_t.satellite_target IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'non_satellite_ruling_retired',
      'detail', 'Restore the evidenced paid contract where required, complete through '
                || 'fn_complete_tournament_terminal, and record the ruling audit.');
  END IF;

$guard$;
BEGIN
  SELECT p.prosrc, pg_get_functiondef(p.oid), to_jsonb(p) - 'prosrc'
    INTO v_body, v_definition, v_before
    FROM pg_proc p WHERE p.oid = v_oid;
  IF v_oid IS NULL OR md5(v_body) NOT IN (v_before_hash, v_after_hash)
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = v_oid
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef AND NOT p.proisstrict
          AND p.provolatile = 'v'
          AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          AND p.prorettype = 'jsonb'::regtype
          AND p.pronargdefaults = 1
          AND pg_get_function_arguments(p.oid) =
              'p_tournament_id uuid, p_reason text, p_source text DEFAULT ''chip standard 10.9''::text'
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     )
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
          AND (a.grantee NOT IN ('postgres'::regrole, 'service_role'::regrole)
               OR a.is_grantable)
     ) THEN
    RAISE EXCEPTION 'non-satellite ruling retirement source or metadata differs';
  END IF;

  IF md5(v_body) = v_before_hash THEN
    IF (length(v_body) - length(replace(v_body, v_old_select, ''))) <> length(v_old_select)
       OR (length(v_body) - length(replace(v_body, v_anchor, ''))) <> length(v_anchor) THEN
      RAISE EXCEPTION 'non-satellite ruling retirement exact fragments differ';
    END IF;
    v_body := replace(replace(v_body, v_old_select, v_new_select), v_anchor, v_guard || v_anchor);
    IF md5(v_body) <> v_after_hash THEN
      RAISE EXCEPTION 'non-satellite ruling retirement composed body differs';
    END IF;
    EXECUTE replace(v_definition, (SELECT prosrc FROM pg_proc WHERE oid = v_oid), v_body);
  END IF;

  SELECT p.prosrc, to_jsonb(p) - 'prosrc' INTO v_body, v_after
    FROM pg_proc p WHERE p.oid = v_oid;
  IF md5(v_body) <> v_after_hash OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'non-satellite ruling retirement postcondition differs';
  END IF;
END;
$retire_non_satellite_ruling$;

COMMENT ON FUNCTION public.fn_settle_tournament_places_by_ruling(uuid,text,text) IS
  'Legacy satellite ruling behavior only. Non-satellite calls refuse before normalization or payment; restore the evidenced paid contract where required, use fn_complete_tournament_terminal, and record the ruling audit. Historical ruling batches are retained.';

COMMIT;
