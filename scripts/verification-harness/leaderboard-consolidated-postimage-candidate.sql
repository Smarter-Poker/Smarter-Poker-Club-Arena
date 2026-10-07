-- UNQUALIFIED isolated post-image assertions, not a production probe.
-- Run immediately after exact consolidated installation, before any fixture.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
DO $verify$
DECLARE expected record; actual record; relation regclass; trigger_count integer;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
    RAISE EXCEPTION 'Exact disposable post-image socket required';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('public.fn_snapshot_player_stats()','7911816236ac2b3a05dfde830eced607',true,'v','search_path=public','postgres,service_role'),
    ('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)','a18a33b02c4577c984907828dff7e8cb',true,'s','search_path=public, pg_temp','authenticated,postgres,service_role'),
    ('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)','a16e33f315facd1141d69956edd53efc',true,'v','search_path=public, pg_temp','postgres,service_role'),
    ('public.fn_enforce_leaderboard_program_funding()','62ecd6c4857a31c5c8742296318484da',true,'v','search_path=public, pg_temp','postgres,service_role'),
    ('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)','4b9ec3c93eb0381aaeb610b3e12a961c',true,'v','search_path=public, pg_temp','postgres,service_role'),
    ('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)','dd6c1b5f9c553134aa477c64f166d05c',true,'v','search_path=public, pg_temp','authenticated,postgres,service_role'),
    ('public.fn_refuse_leaderboard_basis_mutation()','a4597e7680f0c95a7768817442d72f72',false,'v','search_path=pg_catalog','postgres'),
    ('public.fn_leaderboard_complete_round_basis(uuid,text,date,date)','66f807b894def716f010b8a50dbb9573',true,'s','search_path=public, pg_temp','postgres,service_role')
  ) AS x(signature,body_hash,security_definer,volatility,configuration,executors)
  LOOP
    SELECT p.*,pg_get_userbyid(p.proowner) AS owner_name INTO actual FROM pg_proc p
      WHERE p.oid=to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) IS DISTINCT FROM expected.body_hash
      OR actual.owner_name IS DISTINCT FROM 'postgres'
      OR actual.prosecdef IS DISTINCT FROM expected.security_definer
      OR actual.provolatile::text IS DISTINCT FROM expected.volatility
      OR actual.proconfig IS DISTINCT FROM ARRAY[expected.configuration]::text[]
      OR (SELECT string_agg(pg_get_userbyid(a.grantee),',' ORDER BY pg_get_userbyid(a.grantee))
          FROM aclexplode(actual.proacl) a) IS DISTINCT FROM expected.executors
      OR EXISTS(SELECT 1 FROM aclexplode(actual.proacl) a WHERE a.grantee=0
          OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>'postgres'::regrole) THEN
      RAISE EXCEPTION 'Consolidated function post-image differs';
    END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('leaderboard_complete_captures','capture_date'),
    ('leaderboard_capture_counters','snapshot_date, club_id, user_id'),
    ('leaderboard_basis_rollout','singleton'),
    ('leaderboard_basis_existing_clubs','club_id'),
    ('leaderboard_round_basis_receipts','club_id, period, period_start')
  ) AS x(name,keys)
  LOOP
    relation:=to_regclass('public.'||expected.name);
    SELECT c.* INTO actual FROM pg_class c WHERE c.oid=relation;
    IF NOT FOUND OR actual.relkind<>'r' OR actual.relowner<>'postgres'::regrole
      OR NOT actual.relrowsecurity OR actual.relforcerowsecurity
      OR EXISTS(SELECT 1 FROM aclexplode(actual.relacl) a WHERE a.grantee<>'postgres'::regrole)
      OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) g
          WHERE a.attrelid=relation AND g.grantee<>'postgres'::regrole)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation)
      OR (SELECT count(*) FROM pg_index WHERE indrelid=relation)<>1
      OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=relation AND i.indisprimary
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
          AND pg_get_indexdef(i.indexrelid)=format('CREATE UNIQUE INDEX %I ON public.%I USING btree (%s)',
            expected.name||'_pkey',expected.name,expected.keys)) THEN
      RAISE EXCEPTION 'Consolidated table security or primary index differs';
    END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('leaderboard_complete_captures','leaderboard_capture_header_immutable',27),
    ('leaderboard_complete_captures','leaderboard_capture_header_no_truncate',34),
    ('leaderboard_capture_counters','leaderboard_capture_counter_immutable',27),
    ('leaderboard_capture_counters','leaderboard_capture_counter_no_truncate',34),
    ('leaderboard_basis_rollout','leaderboard_rollout_immutable',27),
    ('leaderboard_basis_rollout','leaderboard_rollout_no_truncate',34),
    ('leaderboard_basis_existing_clubs','leaderboard_existing_club_inventory_immutable',31),
    ('leaderboard_basis_existing_clubs','leaderboard_existing_club_inventory_no_truncate',34),
    ('leaderboard_round_basis_receipts','leaderboard_round_basis_receipt_immutable',27),
    ('leaderboard_round_basis_receipts','leaderboard_round_basis_receipt_no_truncate',34)
  ) AS x(relation_name,name,type)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||expected.relation_name)
      AND t.tgname=expected.name AND t.tgtype=expected.type AND t.tgenabled='O'
      AND NOT t.tgisinternal AND t.tgparentid=0 AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgattr=''::int2vector AND t.tgargs=''::bytea AND t.tgconstraint=0
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND t.tgfoid='public.fn_refuse_leaderboard_basis_mutation()'::regprocedure) THEN
      RAISE EXCEPTION 'Consolidated immutable trigger differs';
    END IF;
  END LOOP;
  SELECT count(*) INTO trigger_count FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN
    ('public.leaderboard_complete_captures'::regclass,'public.leaderboard_capture_counters'::regclass,
    'public.leaderboard_basis_rollout'::regclass,'public.leaderboard_basis_existing_clubs'::regclass,
    'public.leaderboard_round_basis_receipts'::regclass);
  IF trigger_count<>10 OR (SELECT count(*) FROM public.leaderboard_basis_rollout)<>1
    OR NOT EXISTS(SELECT 1 FROM public.leaderboard_basis_rollout r
      WHERE r.singleton AND r.contract_version='complete_capture_v2'
      AND r.installed_at<=clock_timestamp()
      AND r.weekly_v2_from=(SELECT end_date FROM public.fn_leaderboard_period_window('weekly',0))
      AND r.monthly_v2_from=(SELECT end_date FROM public.fn_leaderboard_period_window('monthly',0)))
    OR EXISTS((SELECT club_id FROM public.leaderboard_basis_existing_clubs EXCEPT SELECT id FROM public.clubs)
      UNION ALL (SELECT id FROM public.clubs EXCEPT SELECT club_id FROM public.leaderboard_basis_existing_clubs))
    OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
    OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters)
    OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN
    RAISE EXCEPTION 'Consolidated rollout or untouched empty capture inventory differs';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_snapshot_player_stats_if_missing()'::regprocedure)
      IS DISTINCT FROM '45b3a6ffbacfac889d78ff126953c806'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_due_leaderboards()'::regprocedure)
      IS DISTINCT FROM '8f2b1c2ff47e45431be6fee4639f9cb8' THEN
    RAISE EXCEPTION 'Original recovery or worker differs';
  END IF;
END;
$verify$;
SELECT 'CONSOLIDATED_POSTIMAGE|PASS';
ROLLBACK;
