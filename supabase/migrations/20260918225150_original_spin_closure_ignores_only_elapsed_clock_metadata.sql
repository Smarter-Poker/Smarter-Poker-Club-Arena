-- Five September 8 events retain original completed-hand, standings and money
-- evidence while their clocks tick. At 22:45 UTC only level_started_at and
-- blind_level_state.index differed. Ignore exactly those elapsed-clock fields.
-- Preserve captured witnesses, blind amounts, ante, physical/financial guards,
-- operation identities, original terminal payer, locks and permissions.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $clock$
DECLARE definition text;
 prior text:=$prior$IF actual IS DISTINCT FROM original THEN$prior$;
 successor text:=$successor$IF (actual #- '{tournament,level_started_at}' #- '{tournament,blind_level_state,index}')
 IS DISTINCT FROM (original #- '{tournament,level_started_at}' #- '{tournament,blind_level_state,index}') THEN$successor$;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p
 WHERE p.oid='public.fn_complete_sep8_spin_original_standings(uuid,jsonb)'::regprocedure
 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.provolatile='v'
 AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private','statement_timeout=30s','lock_timeout=3s']
 AND (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
   ='["postgres=X/postgres","service_role=X/postgres"]'::jsonb;
 IF definition IS NULL OR md5(definition)<>'c74c2e9f19687a882eed8d3e88200847'
 OR (length(definition)-length(replace(definition,prior,'')))/length(prior)<>1 THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_CLOCK_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,prior,successor);
END $clock$;
REVOKE ALL ON FUNCTION public.fn_complete_sep8_spin_original_standings(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_sep8_spin_original_standings(uuid,jsonb) TO service_role;
COMMIT;
