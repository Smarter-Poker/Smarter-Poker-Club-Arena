-- Fixture only. Three missing incoming-FK relations; never a live migration.
-- Actual read-only catalog capture: 2026-09-16T04:31:59.558616+00:00
-- captured-incoming-relations.json SHA256 d834a69ec303a0579b3776e93f065fd7d074f1a211237196b3fa61cbf4c270a4
-- No user rows. Existing production components and incoming-FK guard stay unchanged.
-- Internal RI triggers are recreated by their exact constraints, not copied by OID.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $isolation$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'isolated incoming relation fixture required'; END IF;
 IF to_regclass('public.commission_rate_audit') IS NOT NULL
  OR to_regclass('public.player_agent_assignments') IS NOT NULL
  OR to_regclass('public.sub_agents') IS NOT NULL
  OR to_regprocedure('public.touch_sub_agents()') IS NOT NULL
 THEN RAISE EXCEPTION 'incoming relation fixture preexists'; END IF;
 IF to_regprocedure('auth.uid()') IS NULL
  OR to_regprocedure('public.fn_is_any_union_overseer(uuid)') IS NULL
  OR to_regprocedure('public.fn_union_oversees_club(uuid,uuid)') IS NULL
  OR md5(pg_get_functiondef(to_regprocedure('public.fn_poker_reject_diamond_hierarchy()'))) IS DISTINCT FROM '49037a2bf4322d2a327bc9141a7a7a89'
 THEN RAISE EXCEPTION 'incoming relation fixture dependency changed'; END IF;
END $isolation$;
LOCK TABLE auth.users, public.profiles, public.clubs, public.agents IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.touch_sub_agents()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;
ALTER FUNCTION public.touch_sub_agents() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.touch_sub_agents() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_sub_agents() TO service_role;

CREATE TABLE public."commission_rate_audit" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "agent_id" uuid NOT NULL,
 "changed_by" uuid NOT NULL,
 "old_rate" numeric NOT NULL,
 "new_rate" numeric NOT NULL,
 "rate_type" text NOT NULL,
 "club_id" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "commission_rate_audit_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
 CONSTRAINT "commission_rate_audit_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES profiles(id) ON DELETE SET NULL,
 CONSTRAINT "commission_rate_audit_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL,
 CONSTRAINT "commission_rate_audit_pkey" PRIMARY KEY (id),
 CONSTRAINT "commission_rate_audit_rate_type_check" CHECK (rate_type = ANY (ARRAY['rakeback'::text, 'commission'::text, 'sub_agent_split'::text, 'bonus_pct'::text]))
);
CREATE INDEX idx_commission_rate_audit_changed_by ON public.commission_rate_audit USING btree (changed_by);
CREATE INDEX idx_commission_rate_audit_club_id_fk ON public.commission_rate_audit USING btree (club_id);
ALTER TABLE public."commission_rate_audit" OWNER TO postgres;
ALTER TABLE public."commission_rate_audit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."commission_rate_audit" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."commission_rate_audit" TO anon, authenticated;
GRANT ALL ON TABLE public."commission_rate_audit" TO service_role;
CREATE POLICY "commission_rate_audit_service_role_all" ON public."commission_rate_audit" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);

CREATE TABLE public."sub_agents" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "user_id" uuid NOT NULL,
 "parent_agent_id" uuid NOT NULL,
 "club_id" uuid NOT NULL,
 "commission_pct" numeric(5,2) DEFAULT 0 NOT NULL,
 "status" text DEFAULT 'active'::text NOT NULL,
 "suspended_reason" text,
 "suspended_at" timestamp with time zone,
 "total_players_recruited" integer DEFAULT 0 NOT NULL,
 "total_rake_generated" numeric(20,4) DEFAULT 0 NOT NULL,
 "total_commission_paid" numeric(20,4) DEFAULT 0 NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "sub_agents_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
 CONSTRAINT "sub_agents_commission_pct_check" CHECK (commission_pct >= 0::numeric AND commission_pct <= 100::numeric),
 CONSTRAINT "sub_agents_parent_agent_id_fkey" FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
 CONSTRAINT "sub_agents_pkey" PRIMARY KEY (id),
 CONSTRAINT "sub_agents_status_check" CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])),
 CONSTRAINT "sub_agents_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
 CONSTRAINT "sub_agents_user_id_key" UNIQUE (user_id)
);
CREATE INDEX idx_sub_agents_club_id_fk ON public.sub_agents USING btree (club_id);
CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON sub_agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy();
CREATE TRIGGER trg_sub_agents_updated BEFORE UPDATE ON sub_agents FOR EACH ROW EXECUTE FUNCTION touch_sub_agents();
ALTER TABLE public."sub_agents" OWNER TO postgres;
ALTER TABLE public."sub_agents" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."sub_agents" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."sub_agents" TO anon, authenticated;
GRANT ALL ON TABLE public."sub_agents" TO service_role;
CREATE POLICY "agents read own sub_agents" ON public."sub_agents" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((parent_agent_id IN ( SELECT a.id
   FROM agents a
  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))) OR (user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "service_role full access" ON public."sub_agents" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_overseer_read" ON public."sub_agents" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

CREATE TABLE public."player_agent_assignments" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "player_id" uuid NOT NULL,
 "club_id" uuid NOT NULL,
 "agent_id" uuid,
 "sub_agent_id" uuid,
 "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "player_agent_assignments_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
 CONSTRAINT "player_agent_assignments_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
 CONSTRAINT "player_agent_assignments_pkey" PRIMARY KEY (id),
 CONSTRAINT "player_agent_assignments_player_id_club_id_key" UNIQUE (player_id, club_id),
 CONSTRAINT "player_agent_assignments_player_id_fkey" FOREIGN KEY (player_id) REFERENCES auth.users(id) ON DELETE CASCADE,
 CONSTRAINT "player_agent_assignments_sub_agent_id_fkey" FOREIGN KEY (sub_agent_id) REFERENCES sub_agents(id) ON DELETE SET NULL,
 CONSTRAINT "player_assigned_exactly_one" CHECK (agent_id IS NOT NULL AND sub_agent_id IS NULL OR agent_id IS NULL AND sub_agent_id IS NOT NULL)
);
CREATE INDEX idx_player_agent_assignments_club_id_fk ON public.player_agent_assignments USING btree (club_id);
CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON player_agent_assignments FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy();
ALTER TABLE public."player_agent_assignments" OWNER TO postgres;
ALTER TABLE public."player_agent_assignments" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."player_agent_assignments" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."player_agent_assignments" TO anon, authenticated;
GRANT ALL ON TABLE public."player_agent_assignments" TO service_role;
CREATE POLICY "service_role full access" ON public."player_agent_assignments" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "union_overseer_read" ON public."player_agent_assignments" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

-- Verify complete relation/function postimages before any candidate component.
DO $readback$
DECLARE actual jsonb;
 expected jsonb := $catalog${"tables":[{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"commission_rate_audit","owner":"postgres","exists":true,"columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"position":1,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"agent_id","type":"uuid","default":null,"identity":"","not_null":true,"position":2,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"changed_by","type":"uuid","default":null,"identity":"","not_null":true,"position":3,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"old_rate","type":"numeric","default":null,"identity":"","not_null":true,"position":4,"collation":null,"generated":"","type_kind":"b","type_name":"numeric","type_schema":"pg_catalog"},{"acl":null,"name":"new_rate","type":"numeric","default":null,"identity":"","not_null":true,"position":5,"collation":null,"generated":"","type_kind":"b","type_name":"numeric","type_schema":"pg_catalog"},{"acl":null,"name":"rate_type","type":"text","default":null,"identity":"","not_null":true,"position":6,"collation":"\"default\"","generated":"","type_kind":"b","type_name":"text","type_schema":"pg_catalog"},{"acl":null,"name":"club_id","type":"uuid","default":null,"identity":"","not_null":false,"position":7,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"position":8,"collation":null,"generated":"","type_kind":"b","type_name":"timestamptz","type_schema":"pg_catalog"}],"indexes":[{"name":"commission_rate_audit_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX commission_rate_audit_pkey ON public.commission_rate_audit USING btree (id)"},{"name":"idx_commission_rate_audit_changed_by","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_commission_rate_audit_changed_by ON public.commission_rate_audit USING btree (changed_by)"},{"name":"idx_commission_rate_audit_club_id_fk","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_commission_rate_audit_club_id_fk ON public.commission_rate_audit USING btree (club_id)"}],"options":null,"parents":null,"policies":[{"name":"commission_rate_audit_service_role_all","roles":["service_role"],"using":"true","command":"*","permissive":true,"with_check":"true"}],"triggers":null,"force_rls":false,"sequences":null,"partitions":null,"constraints":[{"name":"commission_rate_audit_agent_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"},{"name":"commission_rate_audit_changed_by_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (changed_by) REFERENCES profiles(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"profiles"},{"name":"commission_rate_audit_club_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"clubs"},{"name":"commission_rate_audit_pkey","type":"p","validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","initially_deferred":false,"referenced_relation":null},{"name":"commission_rate_audit_rate_type_check","type":"c","validated":true,"deferrable":false,"definition":"CHECK (rate_type = ANY (ARRAY['rakeback'::text, 'commission'::text, 'sub_agent_split'::text, 'bonus_pct'::text]))","initially_deferred":false,"referenced_relation":null}],"persistence":"p"},{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"player_agent_assignments","owner":"postgres","exists":true,"columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"position":1,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"player_id","type":"uuid","default":null,"identity":"","not_null":true,"position":2,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"club_id","type":"uuid","default":null,"identity":"","not_null":true,"position":3,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"agent_id","type":"uuid","default":null,"identity":"","not_null":false,"position":4,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"sub_agent_id","type":"uuid","default":null,"identity":"","not_null":false,"position":5,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"assigned_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"position":6,"collation":null,"generated":"","type_kind":"b","type_name":"timestamptz","type_schema":"pg_catalog"}],"indexes":[{"name":"idx_player_agent_assignments_club_id_fk","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_player_agent_assignments_club_id_fk ON public.player_agent_assignments USING btree (club_id)"},{"name":"player_agent_assignments_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX player_agent_assignments_pkey ON public.player_agent_assignments USING btree (id)"},{"name":"player_agent_assignments_player_id_club_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX player_agent_assignments_player_id_club_id_key ON public.player_agent_assignments USING btree (player_id, club_id)"}],"options":null,"parents":null,"policies":[{"name":"service_role full access","roles":["service_role"],"using":"true","command":"*","permissive":true,"with_check":"true"},{"name":"union_overseer_read","roles":["authenticated"],"using":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","command":"r","permissive":true,"with_check":null}],"triggers":[{"name":"poker_arena_no_hierarchy","enabled":"O","function":"fn_poker_reject_diamond_hierarchy()","internal":false,"deferrable":false,"definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON player_agent_assignments FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","initially_deferred":false}],"force_rls":false,"sequences":null,"partitions":null,"constraints":[{"name":"player_agent_assignments_agent_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"agents"},{"name":"player_agent_assignments_club_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"clubs"},{"name":"player_agent_assignments_pkey","type":"p","validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","initially_deferred":false,"referenced_relation":null},{"name":"player_agent_assignments_player_id_club_id_key","type":"u","validated":true,"deferrable":false,"definition":"UNIQUE (player_id, club_id)","initially_deferred":false,"referenced_relation":null},{"name":"player_agent_assignments_player_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (player_id) REFERENCES auth.users(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"auth.users"},{"name":"player_agent_assignments_sub_agent_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (sub_agent_id) REFERENCES sub_agents(id) ON DELETE SET NULL","initially_deferred":false,"referenced_relation":"sub_agents"},{"name":"player_assigned_exactly_one","type":"c","validated":true,"deferrable":false,"definition":"CHECK (agent_id IS NOT NULL AND sub_agent_id IS NULL OR agent_id IS NULL AND sub_agent_id IS NOT NULL)","initially_deferred":false,"referenced_relation":null}],"persistence":"p"},{"acl":["anon=rxt/postgres","authenticated=rxt/postgres","postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"sub_agents","owner":"postgres","exists":true,"columns":[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"position":1,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"user_id","type":"uuid","default":null,"identity":"","not_null":true,"position":2,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"parent_agent_id","type":"uuid","default":null,"identity":"","not_null":true,"position":3,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"club_id","type":"uuid","default":null,"identity":"","not_null":true,"position":4,"collation":null,"generated":"","type_kind":"b","type_name":"uuid","type_schema":"pg_catalog"},{"acl":null,"name":"commission_pct","type":"numeric(5,2)","default":"0","identity":"","not_null":true,"position":5,"collation":null,"generated":"","type_kind":"b","type_name":"numeric","type_schema":"pg_catalog"},{"acl":null,"name":"status","type":"text","default":"'active'::text","identity":"","not_null":true,"position":6,"collation":"\"default\"","generated":"","type_kind":"b","type_name":"text","type_schema":"pg_catalog"},{"acl":null,"name":"suspended_reason","type":"text","default":null,"identity":"","not_null":false,"position":7,"collation":"\"default\"","generated":"","type_kind":"b","type_name":"text","type_schema":"pg_catalog"},{"acl":null,"name":"suspended_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"position":8,"collation":null,"generated":"","type_kind":"b","type_name":"timestamptz","type_schema":"pg_catalog"},{"acl":null,"name":"total_players_recruited","type":"integer","default":"0","identity":"","not_null":true,"position":9,"collation":null,"generated":"","type_kind":"b","type_name":"int4","type_schema":"pg_catalog"},{"acl":null,"name":"total_rake_generated","type":"numeric(20,4)","default":"0","identity":"","not_null":true,"position":10,"collation":null,"generated":"","type_kind":"b","type_name":"numeric","type_schema":"pg_catalog"},{"acl":null,"name":"total_commission_paid","type":"numeric(20,4)","default":"0","identity":"","not_null":true,"position":11,"collation":null,"generated":"","type_kind":"b","type_name":"numeric","type_schema":"pg_catalog"},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"position":12,"collation":null,"generated":"","type_kind":"b","type_name":"timestamptz","type_schema":"pg_catalog"},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"position":13,"collation":null,"generated":"","type_kind":"b","type_name":"timestamptz","type_schema":"pg_catalog"}],"indexes":[{"name":"idx_sub_agents_club_id_fk","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_sub_agents_club_id_fk ON public.sub_agents USING btree (club_id)"},{"name":"sub_agents_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX sub_agents_pkey ON public.sub_agents USING btree (id)"},{"name":"sub_agents_user_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX sub_agents_user_id_key ON public.sub_agents USING btree (user_id)"}],"options":null,"parents":null,"policies":[{"name":"agents read own sub_agents","roles":["authenticated"],"using":"((parent_agent_id IN ( SELECT a.id\n   FROM agents a\n  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))) OR (user_id = ( SELECT auth.uid() AS uid)))","command":"r","permissive":true,"with_check":null},{"name":"service_role full access","roles":["service_role"],"using":"true","command":"*","permissive":true,"with_check":"true"},{"name":"union_overseer_read","roles":["authenticated"],"using":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","command":"r","permissive":true,"with_check":null}],"triggers":[{"name":"poker_arena_no_hierarchy","enabled":"O","function":"fn_poker_reject_diamond_hierarchy()","internal":false,"deferrable":false,"definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON sub_agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","initially_deferred":false},{"name":"trg_sub_agents_updated","enabled":"O","function":"touch_sub_agents()","internal":false,"deferrable":false,"definition":"CREATE TRIGGER trg_sub_agents_updated BEFORE UPDATE ON sub_agents FOR EACH ROW EXECUTE FUNCTION touch_sub_agents()","initially_deferred":false}],"force_rls":false,"sequences":null,"partitions":null,"constraints":[{"name":"sub_agents_club_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"clubs"},{"name":"sub_agents_commission_pct_check","type":"c","validated":true,"deferrable":false,"definition":"CHECK (commission_pct >= 0::numeric AND commission_pct <= 100::numeric)","initially_deferred":false,"referenced_relation":null},{"name":"sub_agents_parent_agent_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"agents"},{"name":"sub_agents_pkey","type":"p","validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)","initially_deferred":false,"referenced_relation":null},{"name":"sub_agents_status_check","type":"c","validated":true,"deferrable":false,"definition":"CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text]))","initially_deferred":false,"referenced_relation":null},{"name":"sub_agents_user_id_fkey","type":"f","validated":true,"deferrable":false,"definition":"FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE","initially_deferred":false,"referenced_relation":"auth.users"},{"name":"sub_agents_user_id_key","type":"u","validated":true,"deferrable":false,"definition":"UNIQUE (user_id)","initially_deferred":false,"referenced_relation":null}],"persistence":"p"}],"trigger_functions":[{"acl":["postgres=X/postgres","service_role=X/postgres"],"owner":"postgres","signature":"fn_poker_reject_diamond_hierarchy()","definition":"CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_hierarchy()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public', 'pg_temp'\nAS $function$\nBEGIN\n  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=NEW.club_id AND asset='diamonds') THEN\n    RAISE EXCEPTION 'Diamond Arena Has No Agents Or Commissions' USING ERRCODE='23514';\n  END IF;\n  RETURN NEW;\nEND $function$\n","definition_md5":"49037a2bf4322d2a327bc9141a7a7a89"},{"acl":["postgres=X/postgres","service_role=X/postgres"],"owner":"postgres","signature":"touch_sub_agents()","definition":"CREATE OR REPLACE FUNCTION public.touch_sub_agents()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'public'\nAS $function$\nBEGIN NEW.updated_at = NOW(); RETURN NEW; END;\n$function$\n","definition_md5":"17ea75951ae3de7e39b5eb6e59330706"}]}$catalog$::jsonb;
BEGIN
WITH wanted(name) AS (VALUES ('commission_rate_audit'),('player_agent_assignments'),('sub_agents')),
rels AS (SELECT w.name,c.oid,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relpersistence,c.reloptions FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public' LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name)
SELECT jsonb_build_object(
'trigger_functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(p.proacl)x),'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN (SELECT t.tgfoid FROM pg_trigger t JOIN rels r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal)),
'tables',(SELECT jsonb_agg(jsonb_build_object(
'name',r.name,'exists',r.oid IS NOT NULL,'kind',r.relkind,'owner',pg_get_userbyid(r.relowner),'acl',(SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(r.relacl)x),'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity,'persistence',r.relpersistence,'options',r.reloptions,
'columns',(SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'type_schema',tn.nspname,'type_name',t.typname,'type_kind',t.typtype,'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END,'acl',a.attacl) ORDER BY a.attnum) FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid,true),'validated',c.convalidated,'deferrable',c.condeferrable,'initially_deferred',c.condeferred,'referenced_relation',NULLIF(c.confrelid,0)::regclass::text) ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid=r.oid),
'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,'primary',i.indisprimary) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled,'internal',t.tgisinternal,'function',t.tgfoid::regprocedure::text,'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=r.oid AND NOT t.tgisinternal),
'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END) FROM unnest(p.polroles) x),'using',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=r.oid),
'parents',(SELECT jsonb_agg(i.inhparent::regclass::text) FROM pg_inherits i WHERE i.inhrelid=r.oid),
'partitions',(SELECT jsonb_agg(jsonb_build_object('name',i.inhrelid::regclass::text,'bound',pg_get_expr(c.relpartbound,c.oid))) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=r.oid),
'sequences',(SELECT jsonb_agg(jsonb_build_object('name',sc.oid::regclass::text,'owner',pg_get_userbyid(sc.relowner),'acl',sc.relacl,'column',a.attname,'type',format_type(s.seqtypid,NULL),'start',s.seqstart,'increment',s.seqincrement,'minimum',s.seqmin,'maximum',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle)) FROM pg_depend d JOIN pg_class sc ON sc.oid=d.objid AND sc.relkind='S' JOIN pg_sequence s ON s.seqrelid=sc.oid JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid WHERE d.refobjid=r.oid AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i'))
) ORDER BY r.name) FROM rels r)) INTO actual;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'incoming relation fixture catalog changed'; END IF;
END $readback$;
COMMIT;
