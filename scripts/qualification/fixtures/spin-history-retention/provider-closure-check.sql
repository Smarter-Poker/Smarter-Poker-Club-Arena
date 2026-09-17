-- No invocation: exact restored table and restored function identities only.
DO $closure_check$
DECLARE v_actual jsonb; v_expected constant jsonb := $expected$[{"acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"table_pending_addons","owner":"postgres","columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","ordinal":1,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"table_id","type":"uuid","default":null,"ordinal":2,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"user_id","type":"uuid","default":null,"ordinal":3,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"amount","type":"numeric","default":null,"ordinal":4,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","ordinal":5,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"resolved_at","type":"timestamp with time zone","default":null,"ordinal":6,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"applied_to_stack","type":"numeric","default":null,"ordinal":7,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"refunded","type":"numeric","default":null,"ordinal":8,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"kind","type":"text","default":"'addon'::text","ordinal":9,"identity":"","not_null":true,"generated":""}],"indexes":[{"live":true,"name":"idx_table_pending_addons_unresolved_all","owner":"postgres","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_table_pending_addons_unresolved_all ON public.table_pending_addons USING btree (created_at) WHERE (resolved_at IS NULL)"},{"live":true,"name":"table_pending_addons_pkey","owner":"postgres","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX table_pending_addons_pkey ON public.table_pending_addons USING btree (id)"}],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"table_pending_addons_amount_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (amount > 0::numeric)"},{"name":"table_pending_addons_amount_is_cents","type":"c","deferred":false,"validated":false,"deferrable":false,"definition":"CHECK (amount IS NULL OR (amount::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND amount = round(amount, 2)) NOT VALID"},{"name":"table_pending_addons_applied_is_cents","type":"c","deferred":false,"validated":false,"deferrable":false,"definition":"CHECK (applied_to_stack IS NULL OR (applied_to_stack::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND applied_to_stack = round(applied_to_stack, 2)) NOT VALID"},{"name":"table_pending_addons_kind_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (kind = ANY (ARRAY['addon'::text, 'rebuy'::text]))"},{"name":"table_pending_addons_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"table_pending_addons_refunded_is_cents","type":"c","deferred":false,"validated":false,"deferrable":false,"definition":"CHECK (refunded IS NULL OR (refunded::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND refunded = round(refunded, 2)) NOT VALID"}]}]$expected$::jsonb;
BEGIN
WITH selected AS (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN
     ('table_pending_addons')
), functions AS (
  SELECT p.* FROM pg_proc p WHERE p.oid IN (
    SELECT t.tgfoid FROM pg_trigger t JOIN selected c ON c.oid=t.tgrelid
     WHERE NOT t.tgisinternal
    UNION SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f' AND p.proname IN
        ('fn_ca_process_hand_post_commit_obligations','fn_ca_insert_hand_with_awards',
         'bbj_record_contribution','promo_apply_playthrough',
         'record_insurance_transaction','resolve_pending_addon')
  )
), packet AS (
  SELECT jsonb_build_object(
    'observed_at',clock_timestamp(),
    'server_version_num',current_setting('server_version_num'),
    'hash_domain','md5(pg_get_functiondef(oid))',
    'requested_relations',jsonb_build_array('table_pending_addons'),
    'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
      'acl',c.relacl::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object(
          'name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
          'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
          'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object(
          'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),
          'validated',k.convalidated,'deferrable',k.condeferrable,
          'deferred',k.condeferred) ORDER BY k.conname)
        FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object(
          'name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),
          'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
          'unique',i.indisunique,'primary',i.indisprimary,
          'owner',pg_get_userbyid(ic.relowner)) ORDER BY ic.relname)
        FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object(
          'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
          'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),
          'using',pg_get_expr(p.polqual,p.polrelid),
          'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
        FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object(
          'name',t.tgname,'enabled',t.tgenabled,'type',t.tgtype,
          'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
          'definition',pg_get_triggerdef(t.oid,true),
          'function',t.tgfoid::regprocedure::text,
          'function_full_definition_md5',md5(pg_get_functiondef(t.tgfoid))) ORDER BY t.tgname)
        FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY c.relname) FROM selected c),'[]'::jsonb),
    'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
      'full_definition_md5',md5(pg_get_functiondef(p.oid)),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
      'security_definer',p.prosecdef,'config',p.proconfig,
      'metadata',to_jsonb(p)-'oid'-'pronamespace'-'proowner'-'prosrc')
      ORDER BY p.oid::regprocedure::text) FROM functions p),'[]'::jsonb)
  ) AS value
)
 SELECT value->'relations' INTO v_actual FROM packet;
 IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'spin retention closure: table catalog differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_insert_hand_with_awards(jsonb,jsonb)')
  AND md5(pg_get_functiondef(p.oid))='e7f05bb7d61360be7424c5f429066047' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'spin retention closure: function drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_process_hand_post_commit_obligations(uuid)')
  AND md5(pg_get_functiondef(p.oid))='8d18dde12765610895b25e297a1f403f' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'spin retention closure: function drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='zz_ca_bomb_hand_keeps_its_award_units' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$trigger$CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units AFTER INSERT ON public.hand_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.bomb_pot IS NOT NULL)) EXECUTE FUNCTION fn_ca_bomb_hand_keeps_its_award_units()$trigger$
  AND t.tgfoid='public.fn_ca_bomb_hand_keeps_its_award_units()'::regprocedure)
 OR EXISTS(SELECT 1 FROM public.table_pending_addons) THEN RAISE EXCEPTION 'spin retention closure: binding/data drift'; END IF;
END;
$closure_check$;

-- Every real hand-history INSERT/DELETE trigger remains enabled and bound.
DO $history_bindings$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.hand_history'::regclass AND NOT tgisinternal)<>8 THEN
  RAISE EXCEPTION 'retention provider: unexpected history binding count'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='hand_history_club_member_stats' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER hand_history_club_member_stats AFTER INSERT ON public.hand_history FOR EACH ROW EXECUTE FUNCTION trg_hand_history_club_member_stats()$binding$ AND t.tgfoid=to_regprocedure('public.trg_hand_history_club_member_stats()')
  AND md5(pg_get_functiondef(p.oid))='4410a2ecf837afe8a47bb2956542c79e' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','hand_history_club_member_stats'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='hand_history_fold_stats' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER hand_history_fold_stats AFTER INSERT ON public.hand_history FOR EACH ROW EXECUTE FUNCTION fn_fold_hand_winnings()$binding$ AND t.tgfoid=to_regprocedure('public.fn_fold_hand_winnings()')
  AND md5(pg_get_functiondef(p.oid))='59814db07c86250f8642143caad0542b' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','hand_history_fold_stats'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='hand_history_position_stats' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER hand_history_position_stats AFTER INSERT ON public.hand_history FOR EACH ROW EXECUTE FUNCTION trg_hand_history_position_stats()$binding$ AND t.tgfoid=to_regprocedure('public.trg_hand_history_position_stats()')
  AND md5(pg_get_functiondef(p.oid))='11a70eefb5afe5e7b28c1bc29425289f' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','hand_history_position_stats'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='trg_ca_capture_hand_facts' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER trg_ca_capture_hand_facts BEFORE DELETE ON public.hand_history FOR EACH ROW EXECUTE FUNCTION fn_ca_capture_hand_facts()$binding$ AND t.tgfoid=to_regprocedure('public.fn_ca_capture_hand_facts()')
  AND md5(pg_get_functiondef(p.oid))='fcdf4dc8d0db55b61cbbb2f79b60a09e' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','trg_ca_capture_hand_facts'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='trg_ca_stats_live_from_hand' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER trg_ca_stats_live_from_hand AFTER INSERT ON public.hand_history FOR EACH ROW EXECUTE FUNCTION trg_ca_stats_live_from_hand()$binding$ AND t.tgfoid=to_regprocedure('public.trg_ca_stats_live_from_hand()')
  AND md5(pg_get_functiondef(p.oid))='3a8af7a54df499afea2049c0392c9a50' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','trg_ca_stats_live_from_hand'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='trg_enqueue_hand_daily_missions' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER trg_enqueue_hand_daily_missions AFTER INSERT ON public.hand_history FOR EACH ROW EXECUTE FUNCTION fn_enqueue_hand_daily_missions()$binding$ AND t.tgfoid=to_regprocedure('public.fn_enqueue_hand_daily_missions()')
  AND md5(pg_get_functiondef(p.oid))='a89665914529f8f2b981c26bfd10d6e4' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','trg_enqueue_hand_daily_missions'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='trg_log_jackpot_hand_deleted' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER trg_log_jackpot_hand_deleted BEFORE DELETE ON public.hand_history FOR EACH ROW EXECUTE FUNCTION fn_log_jackpot_hand_deleted()$binding$ AND t.tgfoid=to_regprocedure('public.fn_log_jackpot_hand_deleted()')
  AND md5(pg_get_functiondef(p.oid))='812b538f4aa1e10ec08fdee35df00d02' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','trg_log_jackpot_hand_deleted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.hand_history'::regclass
  AND t.tgname='zz_ca_bomb_hand_keeps_its_award_units' AND t.tgenabled='O'
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units AFTER INSERT ON public.hand_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.bomb_pot IS NOT NULL)) EXECUTE FUNCTION fn_ca_bomb_hand_keeps_its_award_units()$binding$ AND t.tgfoid=to_regprocedure('public.fn_ca_bomb_hand_keeps_its_award_units()')
  AND md5(pg_get_functiondef(p.oid))='4f19a7516985b6e452732a891289ad2b' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'retention provider: history trigger authority differs %','zz_ca_bomb_hand_keeps_its_award_units'; END IF;
END $history_bindings$;
