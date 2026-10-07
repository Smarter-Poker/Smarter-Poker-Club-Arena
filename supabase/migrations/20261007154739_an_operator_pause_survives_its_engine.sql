-- An acknowledged operator pause was held only in engine memory and vanished
-- on replacement. This store retains that authority independently of maintenance,
-- without touching table status, seats, money, presence parks or their expiry.
-- Install before the engine change. Existing old-runtime holds require a qualified
-- handoff census/import before activation; rollback to an old engine is incompatible
-- while any operator hold is true. No production game is used to test this migration.
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
CREATE TABLE public.ca_table_operator_holds (
  table_id uuid PRIMARY KEY,
  paused boolean NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  command_id uuid,
  actor_id uuid,
  inherited_handoff_id uuid,
  CHECK ((command_id IS NOT NULL AND actor_id IS NOT NULL AND inherited_handoff_id IS NULL)
      OR (command_id IS NULL AND actor_id IS NULL AND inherited_handoff_id IS NOT NULL)),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_table_operator_hold_commands (
  command_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  paused boolean NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_operator_hold_handoffs (
  handoff_id uuid PRIMARY KEY,
  source_instance text NOT NULL,
  source_release_sha text NOT NULL CHECK (source_release_sha ~ '^[0-9a-f]{40}$'),
  fleet jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_operator_hold_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_hold_handoffs FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.ca_table_operator_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_table_operator_hold_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_table_operator_holds, public.ca_table_operator_hold_commands FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_ca_get_table_operator_hold(p_table_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
 SELECT coalesce((SELECT jsonb_build_object('paused',h.paused,'version',h.version,'command_id',h.command_id)
 FROM public.ca_table_operator_holds h WHERE h.table_id=p_table_id),
 jsonb_build_object('paused',false,'version',0,'command_id',null))
$$;

CREATE FUNCTION public.fn_ca_set_table_operator_hold(p_table_id uuid,p_paused boolean,p_actor_id uuid,p_command_id uuid,p_lease_generation uuid,p_instance_id text,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
SET lock_timeout = '500ms' SET statement_timeout = '5s'
AS $$
DECLARE t record; previous public.ca_table_operator_hold_commands%ROWTYPE; h public.ca_table_operator_holds%ROWTYPE; allowed boolean; lease_row record;
BEGIN
 IF p_table_id IS NULL OR p_paused IS NULL OR p_actor_id IS NULL OR p_command_id IS NULL OR p_lease_generation IS NULL OR p_instance_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0 THEN
   RAISE EXCEPTION 'operator_hold_invalid_request' USING ERRCODE='22023';
 END IF;
 SELECT tb.club_id,tb.union_id,tb.tournament_id,c.asset INTO t FROM public.tables tb LEFT JOIN public.clubs c ON c.id=tb.club_id WHERE tb.id=p_table_id;
 IF NOT FOUND OR (t.club_id IS NULL AND t.union_id IS NULL) THEN RAISE EXCEPTION 'operator_hold_table_not_found' USING ERRCODE='22023'; END IF;
 IF t.asset='diamonds' THEN
   SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_actor_id AND p.role IN ('admin','superadmin','god')) INTO allowed;
 ELSIF t.union_id IS NOT NULL THEN
   SELECT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=t.union_id AND u.owner_id=p_actor_id)
    OR EXISTS(SELECT 1 FROM public.union_admins a WHERE a.union_id=t.union_id AND a.user_id=p_actor_id)
    OR EXISTS(SELECT 1 FROM public.union_clubs uc JOIN public.club_members cm ON cm.club_id=uc.club_id
      WHERE uc.union_id=t.union_id AND cm.user_id=p_actor_id AND cm.role IN ('owner','co_owner','admin','super_agent')) INTO allowed;
 ELSE
   SELECT EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=t.club_id AND cm.user_id=p_actor_id
    AND cm.role IN ('owner','co_owner','admin','super_agent')) INTO allowed;
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'operator_hold_forbidden' USING ERRCODE='42501'; END IF;
 -- Match replacement/heartbeat lease row order. The former owner cannot
 -- commit a late hold after a successor acquired and read its authority.
 IF t.tournament_id IS NULL THEN
   SELECT * INTO lease_row FROM public.engine_table_leases WHERE table_id=p_table_id FOR SHARE;
 ELSE
   SELECT * INTO lease_row FROM public.engine_tournament_leases WHERE tournament_id=t.tournament_id FOR SHARE;
 END IF;
 IF NOT FOUND OR lease_row.instance_id<>p_instance_id OR lease_row.protocol_version<>2
   OR lease_row.lease_generation<>p_lease_generation OR lease_row.heartbeat_at IS NULL
   OR lease_row.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'operator_hold_engine_fenced' USING ERRCODE='42501';
 END IF;
 -- Only this table's operator commands serialize. Never a money/seat/global lane.
 PERFORM pg_advisory_xact_lock(hashtextextended('ca.operator-hold:'||p_table_id::text,0));
 SELECT * INTO previous FROM public.ca_table_operator_hold_commands WHERE command_id=p_command_id;
 IF FOUND THEN
   IF previous.table_id<>p_table_id OR previous.actor_id<>p_actor_id OR previous.paused<>p_paused THEN
     RAISE EXCEPTION 'operator_hold_command_mismatch' USING ERRCODE='22023';
   END IF;
   -- A replay reads the latest authority; it cannot reinstate an older pause.
   RETURN public.fn_ca_get_table_operator_hold(p_table_id);
 END IF;
 SELECT * INTO h FROM public.ca_table_operator_holds WHERE table_id=p_table_id;
 IF coalesce(h.version,0)<>p_expected_version THEN
   RAISE EXCEPTION 'operator_hold_version_changed' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.ca_table_operator_holds(table_id,paused,version,command_id,actor_id)
 VALUES(p_table_id,p_paused,coalesce(h.version,0)+1,p_command_id,p_actor_id)
 ON CONFLICT(table_id) DO UPDATE SET paused=EXCLUDED.paused,version=EXCLUDED.version,
 command_id=EXCLUDED.command_id,actor_id=EXCLUDED.actor_id,inherited_handoff_id=NULL,updated_at=now()
 RETURNING * INTO h;
 INSERT INTO public.ca_table_operator_hold_commands(command_id,table_id,actor_id,paused,version)
 VALUES(p_command_id,p_table_id,p_actor_id,p_paused,h.version);
 PERFORM public.fn_emit_game_management_event('game_changed',t.club_id,t.union_id,NULL,
   'table',p_table_id,p_command_id,jsonb_build_object('operation','operator_hold_changed',
     'operator_paused',h.paused,'operator_hold_version',h.version,'operator_actor_id',p_actor_id));
 RETURN public.fn_ca_get_table_operator_hold(p_table_id);
END $$;
-- A first-upgrade receipt is inherited authority, not a fabricated human command.
-- The existing owning release transport supplies the exact, setter-fenced live census.
CREATE FUNCTION public.fn_ca_import_operator_holds(p_handoff_id uuid,p_source_instance text,p_source_release_sha text,p_fleet jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='500ms' SET statement_timeout='5s'
AS $$
DECLARE item record; t record; lease_row record; previous public.ca_operator_hold_handoffs%ROWTYPE;
BEGIN
 IF p_handoff_id IS NULL OR p_source_instance IS NULL OR p_source_instance='' OR p_source_release_sha IS NULL OR p_source_release_sha !~ '^[0-9a-f]{40}$'
   OR p_fleet IS NULL OR jsonb_typeof(p_fleet)<>'array' THEN
   RAISE EXCEPTION 'operator_hold_import_invalid' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_fleet) x WHERE jsonb_typeof(x)<>'object'
    OR coalesce(jsonb_typeof(x->'paused'),'null')<>'boolean' OR x->>'table_id' IS NULL OR x->>'lease_generation' IS NULL)
    OR (SELECT count(*) FROM jsonb_array_elements(p_fleet))<>(SELECT count(DISTINCT x->>'table_id') FROM jsonb_array_elements(p_fleet) x) THEN
   RAISE EXCEPTION 'operator_hold_import_invalid' USING ERRCODE='22023';
 END IF;
 -- Acquire owning leases first, in deterministic order, before table hold locks.
 FOR item IN SELECT * FROM jsonb_to_recordset(p_fleet) AS x(table_id uuid,paused boolean,lease_generation uuid) ORDER BY table_id LOOP
   SELECT tournament_id INTO t FROM public.tables WHERE id=item.table_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'operator_hold_import_table_missing' USING ERRCODE='22023'; END IF;
   IF t.tournament_id IS NULL THEN
     SELECT * INTO lease_row FROM public.engine_table_leases WHERE table_id=item.table_id FOR SHARE;
   ELSE
     SELECT * INTO lease_row FROM public.engine_tournament_leases WHERE tournament_id=t.tournament_id FOR SHARE;
   END IF;
   IF NOT FOUND OR lease_row.instance_id<>p_source_instance OR lease_row.protocol_version<>2
      OR lease_row.lease_generation<>item.lease_generation OR lease_row.heartbeat_at IS NULL
      OR lease_row.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
     RAISE EXCEPTION 'operator_hold_import_engine_fenced' USING ERRCODE='42501';
   END IF;
 END LOOP;
 FOR item IN SELECT * FROM jsonb_to_recordset(p_fleet) AS x(table_id uuid,paused boolean,lease_generation uuid) ORDER BY table_id LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('ca.operator-hold:'||item.table_id::text,0));
 END LOOP;
 SELECT * INTO previous FROM public.ca_operator_hold_handoffs WHERE handoff_id=p_handoff_id;
 IF FOUND THEN
   IF previous.source_instance<>p_source_instance OR previous.source_release_sha<>p_source_release_sha OR previous.fleet<>p_fleet THEN
     RAISE EXCEPTION 'operator_hold_import_mismatch' USING ERRCODE='22023';
   END IF;
   RETURN jsonb_build_object('handoff_id',p_handoff_id,'imported',jsonb_array_length(p_fleet),'replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_table_operator_holds h JOIN jsonb_to_recordset(p_fleet) AS x(table_id uuid) USING(table_id)) THEN
   RAISE EXCEPTION 'operator_hold_import_conflicts_with_current_authority' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.ca_operator_hold_handoffs(handoff_id,source_instance,source_release_sha,fleet)
 VALUES(p_handoff_id,p_source_instance,p_source_release_sha,p_fleet);
 INSERT INTO public.ca_table_operator_holds(table_id,paused,version,inherited_handoff_id)
 SELECT x.table_id,x.paused,1,p_handoff_id FROM jsonb_to_recordset(p_fleet) AS x(table_id uuid,paused boolean);
 RETURN jsonb_build_object('handoff_id',p_handoff_id,'imported',jsonb_array_length(p_fleet),'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_import_operator_holds(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_import_operator_holds(uuid,text,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_get_table_operator_hold(uuid),public.fn_ca_set_table_operator_hold(uuid,boolean,uuid,uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_get_table_operator_hold(uuid),public.fn_ca_set_table_operator_hold(uuid,boolean,uuid,uuid,uuid,text,bigint) TO service_role;
-- The rollback preload must distinguish an original committed import from an
-- unknown outcome. This reads only its immutable original receipt, never writes.
CREATE FUNCTION public.fn_ca_get_operator_hold_handoff(p_handoff_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $$ SELECT jsonb_build_object('handoff_id',handoff_id,'source_instance',source_instance,
  'source_release_sha',source_release_sha,'fleet',fleet)
  FROM public.ca_operator_hold_handoffs WHERE handoff_id=p_handoff_id $$;
REVOKE ALL ON FUNCTION public.fn_ca_get_operator_hold_handoff(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_get_operator_hold_handoff(uuid) TO service_role;
-- Additive authorized projection: never turn a discovery/structure status into paused.
DO $projection$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer,text,uuid,integer)'::regprocedure) INTO definition;
 IF md5(definition)<>'aab6ac28551b11fdb6b74d7fcd430580' THEN
   RAISE EXCEPTION 'managed_games_operator_hold_preimage_changed';
 END IF;
 IF md5(pg_get_functiondef('public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb)'::regprocedure))<>'7286c5f7f9f749b236a0021f16194ca7'
    OR (length(definition)-length(replace(definition,'SELECT p.*,','')))/length('SELECT p.*,')<>1 THEN
   RAISE EXCEPTION 'managed_games_operator_hold_event_or_projection_changed';
 END IF;
 definition:=replace(definition,'SELECT p.*,',
   'SELECT p.*, (p.kind=''table'' AND EXISTS (SELECT 1 FROM public.ca_table_operator_holds h WHERE h.table_id=p.id AND h.paused)) AS operator_paused,');
 EXECUTE definition;
END $projection$;
-- Read-only admission witness for the original engine release transaction.
CREATE FUNCTION public.fn_ca_operator_hold_contract()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $$
 SELECT jsonb_build_object('kind','operator_hold_contract_v1',
  'migration',(SELECT jsonb_build_object('version',version,'name',name,'statements_count',cardinality(statements),'sql_md5',md5(statements[1]))
    FROM supabase_migrations.schema_migrations WHERE version='20261007154739'),
  'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
    'rls',c.relrowsecurity,'acl',c.relacl::text,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
      'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',q.conname,'type',q.contype,'validated',q.convalidated,
      'definition',pg_get_constraintdef(q.oid)) ORDER BY q.conname) FROM pg_constraint q WHERE q.conrelid=c.oid)
    ) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('ca_table_operator_holds','ca_table_operator_hold_commands','ca_operator_hold_handoffs')),
  'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
    'definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.oid IN ('public.fn_ca_get_table_operator_hold(uuid)'::regprocedure,
      'public.fn_ca_get_operator_hold_handoff(uuid)'::regprocedure,
      'public.fn_ca_set_table_operator_hold(uuid,boolean,uuid,uuid,uuid,text,bigint)'::regprocedure,
      'public.fn_ca_import_operator_holds(uuid,text,text,jsonb)'::regprocedure,
      'public.fn_list_managed_games(text,uuid,timestamp with time zone,text,uuid,integer,integer,integer,text,uuid,integer)'::regprocedure,
      'public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb)'::regprocedure)))
$$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_hold_contract() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_hold_contract() TO service_role;
COMMIT;
