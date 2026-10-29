-- Owner October 29: every new MTT pays the top 15%, replacing 12.5%.
-- Only the MTT trigger changes. Generic ladder helpers keep non-MTT defaults.
-- No hot-table DDL, row locks, money movement or finalized repricing.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $install$
DECLARE r record; before_meta jsonb; after_meta jsonb;
BEGIN
  FOR r IN SELECT * FROM (VALUES
('public.fn_ca_mtt_payout_depth_guard()', 'df4e5b504f5c8a2e30a01ac870899774', '83b17642b8aba085666fa8261bf165bd', 'postgres|{postgres=X/postgres,service_role=X/postgres}', $post$CREATE OR REPLACE FUNCTION public.fn_ca_mtt_payout_depth_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_union uuid;
  v_asset text;
  v_is_mtt boolean;
  v_enforced boolean;
  v_depth numeric;
BEGIN
  -- Payout terms that are already committed never move.
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.prize_pool_finalized, false) THEN
    NEW.payout_depth_percent := OLD.payout_depth_percent;
    RETURN NEW;
  END IF;

  v_is_mtt := upper(COALESCE(NEW.tournament_type,'')) = 'MTT'
          AND lower(COALESCE(NEW.variant,'')) NOT IN ('spin','sng','satellite')
          AND NEW.satellite_target_id IS NULL
          AND NEW.satellite_target IS NULL
          AND NOT COALESCE(NEW.is_premium_spin, false);
  IF NOT v_is_mtt THEN
    NEW.payout_depth_percent := NULL;
    RETURN NEW;
  END IF;

  -- Owner October 29: every new MTT pays the top fifteen percent.
  v_depth := 15;

  -- Never produce a diff an UPDATE did not need (Diamond and lifecycle guards
  -- compare whole rows).
  IF TG_OP = 'UPDATE' AND OLD.payout_depth_percent IS NOT DISTINCT FROM v_depth THEN
    NEW.payout_depth_percent := OLD.payout_depth_percent;
  ELSE
    NEW.payout_depth_percent := v_depth;
  END IF;
  RETURN NEW;
END $function$
$post$)
  ) AS x(signature, preimage, postimage, owner_acl, definition)
  LOOP
    IF md5(pg_get_functiondef(r.signature::regprocedure)) <> r.preimage
       OR (SELECT proowner::regrole::text || '|' || COALESCE(proacl::text,'')
             FROM pg_proc WHERE oid=r.signature::regprocedure) IS DISTINCT FROM r.owner_acl THEN
      RAISE EXCEPTION 'MTT_FIFTEEN_PREIMAGE_DRIFT: %', r.signature;
    END IF;
    IF md5(r.definition) <> r.postimage THEN
      RAISE EXCEPTION 'MTT_FIFTEEN_POSTIMAGE_DRIFT: %', r.signature;
    END IF;
    SELECT jsonb_build_array(proowner,proacl,prosecdef,proconfig,provolatile)
      INTO before_meta FROM pg_proc WHERE oid=r.signature::regprocedure;
    EXECUTE r.definition;
    SELECT jsonb_build_array(proowner,proacl,prosecdef,proconfig,provolatile)
      INTO after_meta FROM pg_proc WHERE oid=r.signature::regprocedure;
    IF md5(pg_get_functiondef(r.signature::regprocedure)) <> r.postimage
       OR before_meta IS DISTINCT FROM after_meta THEN
      RAISE EXCEPTION 'MTT_FIFTEEN_INSTALLATION_DRIFT: %', r.signature;
    END IF;
  END LOOP;
END $install$;
DO $declaration$
BEGIN
  UPDATE public.ca_declared_money_triggers
     SET note='Owner October 29: every new MTT pays the top 15%. Sets only NEW.payout_depth_percent; non-MTT formats and finalized ladders retain their own terms. No chip movement.'
   WHERE table_name='tournaments' AND trigger_name='ca_mtt_payout_depth_guard';
  IF NOT FOUND THEN RAISE EXCEPTION 'MTT_FIFTEEN_TRIGGER_DECLARATION_MISSING'; END IF;
END $declaration$;
COMMIT;
