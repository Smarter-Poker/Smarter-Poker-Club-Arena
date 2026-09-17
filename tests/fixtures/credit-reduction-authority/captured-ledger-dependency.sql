\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Exact missing direct ledger dependency captured14:41.
-- Load with original baseline before complete candidate. No economic rewrite.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'isolated PG17 owner baseline required';END IF;
 IF to_regprocedure('public.fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'captured ledger dependency preexists';END IF;
END$guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_post_leg(p_category text, p_from_type text, p_from_entity uuid, p_to_type text, p_to_entity uuid, p_amount numeric, p_club_id uuid, p_idempotency_key text, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_st text; v_msg text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description, idempotency_key)
    VALUES (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
            p_from_type, p_from_entity, p_to_type, p_to_entity,
            round(p_amount, 2), p_category, p_club_id, p_description, p_idempotency_key);
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

END $function$;
ALTER FUNCTION public.fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) TO postgres,service_role;
DO $exact$ DECLARE x jsonb:=$capture${"signature":"fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text)","definition_md5":"e6835ba26f6a2fc99c130a8b715c7866","body_md5":"f43e1453aba9edc498277627a185e59a","owner":"postgres","language":"plpgsql","security_definer":false,"volatility":"v","strict":false,"leakproof":false,"parallel":"u","config":["search_path=public"],"arguments":"p_category text, p_from_type text, p_from_entity uuid, p_to_type text, p_to_entity uuid, p_amount numeric, p_club_id uuid, p_idempotency_key text, p_description text","result":"boolean","acl":["postgres=X/postgres","service_role=X/postgres"],"effective_execute":{"anon":false,"service_role":true,"authenticated":false}}$capture$::jsonb;p oid;who text;BEGIN
 p:=to_regprocedure('public.'||(x->>'signature'));
 IF p IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_language l ON l.oid=f.prolang WHERE f.oid=p
  AND pg_get_userbyid(f.proowner)=x->>'owner' AND l.lanname=x->>'language' AND f.prokind='f'
  AND f.prosecdef=(x->>'security_definer')::boolean AND f.provolatile::text=x->>'volatility'
  AND f.proisstrict=(x->>'strict')::boolean AND f.proleakproof=(x->>'leakproof')::boolean AND f.proparallel::text=x->>'parallel'
  AND to_jsonb(f.proconfig) IS NOT DISTINCT FROM NULLIF(x->'config','null'::jsonb)
  AND pg_get_function_arguments(f.oid)=x->>'arguments' AND pg_get_function_result(f.oid)=x->>'result'
  AND md5(f.prosrc)=x->>'body_md5' AND md5(pg_get_functiondef(f.oid))=x->>'definition_md5')
 OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc f,LATERAL unnest(f.proacl)a WHERE f.oid=p)
  IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
 THEN RAISE EXCEPTION 'captured ledger dependency not reproduced exactly';END IF;
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(who,p,'EXECUTE') IS DISTINCT FROM (x->'effective_execute'->>who)::boolean
  THEN RAISE EXCEPTION 'captured ledger dependency effective access changed' USING DETAIL=who;END IF;
 END LOOP;
END$exact$;
COMMIT;
