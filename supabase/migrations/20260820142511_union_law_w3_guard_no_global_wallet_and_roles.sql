-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820142511 "union_law_w3_guard_no_global_wallet_and_roles"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 35b4eb3a86a9b1ed80e37f0d6110fed4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Fold the two owner rules into the daily self-test as HARD breaches:
--   * no Club Arena money path may reference the global wallets table
--   * club roles must stay within the canonical six
CREATE OR REPLACE FUNCTION public.fn_union_law_extra_breaches()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb := '[]'::jsonb; v_dupes text[]; v_type text; v_globals text[]; v_roles text[];
BEGIN
  SELECT array_agg(fn || ' x' || signatures) INTO v_dupes
    FROM public.fn_union_overload_check();
  IF v_dupes IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('check','money_path_duplicate_signatures',
                                         'functions', to_jsonb(v_dupes));
  END IF;

  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='club_members' AND column_name='chip_balance';
  IF v_type IS DISTINCT FROM 'numeric' THEN
    v_out := v_out || jsonb_build_object('check','club_chip_balance_not_numeric',
                                         'actual_type', COALESCE(v_type,'missing'));
  END IF;

  -- OWNER RULE: the Club Arena has no global wallet.
  SELECT array_agg(fn ORDER BY fn) INTO v_globals
    FROM public.fn_club_arena_global_wallet_check();
  IF v_globals IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('check','club_arena_uses_global_wallet',
                                         'functions', to_jsonb(v_globals));
  END IF;

  -- OWNER RULE: exactly six roles.
  SELECT array_agg(DISTINCT role) INTO v_roles
    FROM club_members
   WHERE role IS NULL
      OR role NOT IN ('owner','admin','super_agent','agent','sub_agent','player');
  IF v_roles IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('check','non_canonical_club_role',
                                         'roles', to_jsonb(v_roles));
  END IF;

  RETURN v_out;
END $function$;

