-- SOURCE ONLY / UNRUN. Install one future recovery-report message change.
-- Counts remain completed nonthrowing calls, not proof of record creation or
-- new banking. Source/legacy context/UUID/threshold/status/payment behavior stays
-- exact. Original alerts/history are untouched. Current-live-base component only.
DO $component$
DECLARE
  v_rollback constant boolean := false;
  v_oid oid := to_regprocedure('public.fn_rake_repair_unbanked(integer,integer)');
  v_actual text;
  v_pre text;
  v_post text;
  v_target text;
  v_is_post boolean;
  v_replay boolean;
  v_pass integer;
  v_old text := $old$            'Recovered ' || v_repaired || ' unbanked rake hand(s) totalling ' ||
              round(v_chips, 2) || ' chips (engine did not survive to bank them). ' ||
              'Attribution not invented: contributions were lost with the engine.',$old$;
  v_new text := $new$            'Completed ' || v_repaired || ' missing-rake-record recovery call(s) covering ' ||
              round(v_chips, 2) || ' recorded hand-rake chips. This is not a measure of newly credited funds. ' ||
              'Attribution was not reconstructed: contributions were not supplied by this recovery; the original interruption cause is unverified.',$new$;
BEGIN
  PERFORM set_config('lock_timeout','5s',true);
  PERFORM set_config('search_path','public',true);
  IF v_oid IS NULL THEN RAISE EXCEPTION 'rake repair wording: missing exact target'; END IF;
  v_actual:=pg_get_functiondef(v_oid);
  v_is_post:=md5(v_actual)<>'3d2ae7b1afa7510d91057d9ceca9c9b6';
  IF v_is_post THEN
    IF array_length(string_to_array(v_actual,v_new),1) IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'rake repair wording: postimage/anchor drift';
    END IF;
    v_pre:=replace(v_actual,v_new,v_old);
  ELSE
    v_pre:=v_actual;
  END IF;
  IF md5(v_pre) IS DISTINCT FROM '3d2ae7b1afa7510d91057d9ceca9c9b6'
     OR array_length(string_to_array(v_pre,v_old),1) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'rake repair wording: exact live preimage required';
  END IF;
  v_post:=replace(v_pre,v_old,v_new);
  IF v_is_post AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'rake repair wording: exact postimage required';
  END IF;
  v_target:=CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  v_replay:=v_is_post=(NOT v_rollback);
  FOR v_pass IN 1..2 LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
        AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public','statement_timeout=540s']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}')
       OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_rake_repair_unbanked')<>1 THEN
      RAISE EXCEPTION 'rake repair wording: target authority/overload drift';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)')
        AND md5(pg_get_functiondef(p.oid))='1b9bc9a006f45908bf65eb70a12e5f00'
        AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public','statement_timeout=30s']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN
      RAISE EXCEPTION 'rake repair wording: exact atomic banking dependency required';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_guard_watchlist()')
        AND md5(pg_get_functiondef(p.oid))='92ee208d0887728444bda396d0b4d442'
        AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}')
       OR 'fn_rake_repair_unbanked'=ANY(public.fn_ca_guard_watchlist())
       OR EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_rake_repair_unbanked') THEN
      RAISE EXCEPTION 'rake repair wording: explicit unwatchlisted mode drift';
    END IF;
    IF (SELECT count(*) FROM pg_attribute a JOIN (VALUES
        ('id','uuid'::regtype,true),('source','text'::regtype,true),
        ('severity','text'::regtype,true),('message','text'::regtype,true),
        ('context','jsonb'::regtype,false))e(name,type_oid,required_notnull)
        ON a.attname=e.name AND a.atttypid=e.type_oid AND a.attnotnull=e.required_notnull
        WHERE a.attrelid='public.financial_alerts'::regclass AND a.attnum>0 AND NOT a.attisdropped)<>5
       OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.financial_alerts'::regclass AND a.attname='id'
          AND pg_get_expr(d.adbin,d.adrelid)='gen_random_uuid()') THEN
      RAISE EXCEPTION 'rake repair wording: original event schema/default drift';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_index x WHERE x.indexrelid=to_regclass('public.financial_alerts_pkey')
        AND x.indisprimary AND x.indisunique AND x.indisvalid AND x.indisready
        AND pg_get_indexdef(x.indexrelid)='CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)')
       OR NOT EXISTS(SELECT 1 FROM pg_index x WHERE x.indexrelid=to_regclass('public.rake_distribution_legs_pkey')
        AND x.indisprimary AND x.indisunique AND x.indisvalid AND x.indisready
        AND pg_get_indexdef(x.indexrelid)='CREATE UNIQUE INDEX rake_distribution_legs_pkey ON public.rake_distribution_legs USING btree (leg_key, leg)')
       OR NOT EXISTS(SELECT 1 FROM pg_index x WHERE x.indexrelid=to_regclass('public.uq_rake_records_hand_id')
        AND x.indisunique AND x.indisvalid AND x.indisready
        AND pg_get_indexdef(x.indexrelid)='CREATE UNIQUE INDEX uq_rake_records_hand_id ON public.rake_records USING btree (hand_id) WHERE (hand_id IS NOT NULL)') THEN
      RAISE EXCEPTION 'rake repair wording: original/record/claim identity drift';
    END IF;
    IF v_pass=1 AND NOT v_replay THEN EXECUTE v_target; END IF;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION 'rake repair wording: exact body readback failed';
    END IF;
  END LOOP;
END;
$component$;
