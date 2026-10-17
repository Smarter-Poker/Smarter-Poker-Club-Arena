\set ON_ERROR_STOP on
CREATE SCHEMA auth;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE anon;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated') $$;
GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,is_public boolean);
CREATE TABLE club_members(club_id uuid,user_id uuid,status text);
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,cluster_mode text,enabled boolean,lightning_enabled boolean,ruleset_snapshot jsonb);
CREATE TABLE lightning_pool_session(id uuid,cluster_id uuid,player_id uuid,exited_at timestamptz,entered_at timestamptz,auto_rebuys integer,auto_rebuy_total numeric);
CREATE TABLE lightning_cluster_drain(cluster_id uuid,completed_at timestamptz);
CREATE FUNCTION fn_cash_cluster_pool_health(uuid,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"ok":true,"live_eligible":42}'::jsonb $$;
CREATE FUNCTION fn_lightning_config(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"diversity_large_min":32,"diversity_medium_min":16,"lightning_joins_enabled":true,"multi_table_limit":{"phone":2},"auto_rebuy_enabled":true,"auto_rebuy_trigger":"threshold","auto_rebuy_threshold_bb":20,"auto_rebuy_threshold_pct":25,"auto_rebuy_target":"max","auto_rebuy_max_count":3,"auto_rebuy_session_cap":100}'::jsonb $$;
INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',false);
INSERT INTO cash_games VALUES('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','lightning',true,true,'{"options":{"is_private":true}}');
INSERT INTO club_members SELECT '10000000-0000-0000-0000-000000000001'::uuid,
 ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,status
 FROM (VALUES(2,'active'),(3,'approved'),(4,'pending'),(5,'removed'),(6,'banned'),(7,'suspended'),(8,NULL)) x(n,status);
INSERT INTO lightning_pool_session VALUES
('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002',NULL,now(),2,3.50);
-- BEGIN EXACT PREDECESSOR
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_status(p_cluster_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  g         record;
  v_health  jsonb;
  v_cfg     jsonb;
  v_live    integer;
  v_status  text;
  v_ar_used  integer;
  v_ar_total numeric;
BEGIN
  IF p_cluster_id IS NULL OR (v_uid IS NULL AND NOT v_service) THEN
    RETURN NULL;
  END IF;
  -- THE LOBBY'S OWN RULE (policy cash_games_read): visible unless the
  -- ruleset marks it private, and a private Cluster to members of its club.
  SELECT cg.id, cg.cluster_mode, cg.enabled, cg.lightning_enabled INTO g
    FROM public.cash_games cg
   WHERE cg.id = p_cluster_id
     AND (v_service
          OR NOT coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false)
          OR EXISTS (SELECT 1 FROM public.club_members cm
                      WHERE cm.club_id = cg.club_id AND cm.user_id = v_uid));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_health := public.fn_cash_cluster_pool_health(p_cluster_id, clock_timestamp());
  v_live := CASE WHEN coalesce((v_health ->> 'ok')::boolean, false)
                 THEN coalesce((v_health ->> 'live_eligible')::integer, 0) ELSE 0 END;
  v_cfg := public.fn_lightning_config(p_cluster_id);
  v_status := CASE
    WHEN g.cluster_mode = 'pending_off' THEN 'THIN'
    WHEN g.cluster_mode IS DISTINCT FROM 'lightning' THEN 'BUILDING'
    WHEN v_live >= (v_cfg ->> 'diversity_large_min')::integer THEN 'HOT'
    WHEN v_live >= (v_cfg ->> 'diversity_medium_min')::integer THEN 'ACTIVE'
    ELSE 'THIN' END;
  -- 20261008043021: THE CLIENT CONTRACT IS {players, status, joinable,
  -- multi_table_limit}. cluster_mode leaked frozen, paused and the pending
  -- states to players; the lobby-facing facts are whether the pool can be
  -- entered right now and the per-platform limits the entry door enforces.
  -- LIGHTNING PHASE 12 (20261009143757): THE AUTO-REBUY STATUS LINE. The
  -- client cannot read fn_lightning_config (service_role only, and it stays
  -- so); this door already reads it as its owner, so the settings come from
  -- there (its clamps, its validation) and the usage from the CALLER'S OWN
  -- open pool session in this Cluster, null without one.
  SELECT ps.auto_rebuys, ps.auto_rebuy_total INTO v_ar_used, v_ar_total
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = v_uid AND ps.exited_at IS NULL
   ORDER BY ps.entered_at DESC, ps.id
   LIMIT 1;
  RETURN jsonb_build_object('players', v_live, 'status', v_status,
    'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE
                 AND coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true)),
    -- LIGHTNING PHASE 13 (20261009235505): the pool closed to newcomers by an
    -- operator, and Lightning ending (an emergency drain in flight).
    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),
    'draining', (g.cluster_mode = 'draining'
                 OR EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                             WHERE d.cluster_id = g.id AND d.completed_at IS NULL)),
    'multi_table_limit', v_cfg -> 'multi_table_limit',
    'auto_rebuy', jsonb_build_object(
      'enabled', v_cfg -> 'auto_rebuy_enabled',
      'trigger', v_cfg -> 'auto_rebuy_trigger',
      'threshold_bb', v_cfg -> 'auto_rebuy_threshold_bb',
      'threshold_pct', v_cfg -> 'auto_rebuy_threshold_pct',
      'target', v_cfg -> 'auto_rebuy_target',
      'max_count', v_cfg -> 'auto_rebuy_max_count',
      'session_cap', v_cfg -> 'auto_rebuy_session_cap',
      'used_count', to_jsonb(v_ar_used),
      'used_total', to_jsonb(v_ar_total)));
END
$function$;

-- END EXACT PREDECESSOR
REVOKE ALL ON FUNCTION fn_lightning_pool_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION fn_lightning_pool_status(uuid) TO authenticated,service_role;
CREATE SCHEMA witness;
GRANT USAGE ON SCHEMA witness TO authenticated,service_role;
CREATE TABLE witness.catalog_before AS SELECT proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='fn_lightning_pool_status(uuid)'::regprocedure;
CREATE TABLE witness.output_before(actor integer PRIMARY KEY,doc jsonb);
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002',false);
INSERT INTO witness.output_before VALUES(2,fn_lightning_pool_status('30000000-0000-0000-0000-000000000001'));
GRANT SELECT ON witness.output_before TO authenticated,service_role;
CREATE FUNCTION witness.read_as(actor integer) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',CASE WHEN actor=0 THEN '' ELSE '20000000-0000-0000-0000-'||lpad(actor::text,12,'0') END,true);
 RETURN public.fn_lightning_pool_status('30000000-0000-0000-0000-000000000001');
END $$;
CREATE FUNCTION witness.expect_hidden(actor integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF witness.read_as(actor) IS NOT NULL THEN RAISE EXCEPTION 'PRIVATE_METADATA_EXPOSED actor %',actor; END IF; END $$;
CREATE FUNCTION witness.expect_visible(actor integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE doc jsonb;
BEGIN
 doc:=witness.read_as(actor);
 IF doc IS NULL OR doc->>'players'<>'42' OR doc->>'status'<>'HOT' OR doc->>'joinable'<>'true' OR doc->>'joins_enabled'<>'true'
 OR doc->>'draining'<>'false' OR doc->'multi_table_limit' IS DISTINCT FROM '{"phone":2}'::jsonb
 OR NOT(doc ? 'auto_rebuy') OR (SELECT count(*) FROM jsonb_object_keys(doc))<>7 THEN
  RAISE EXCEPTION 'private metadata return contract changed for %',actor;
 END IF;
 IF actor=2 AND doc IS DISTINCT FROM (SELECT output_before.doc FROM witness.output_before WHERE output_before.actor=2) THEN
  RAISE EXCEPTION 'own-session metadata or auto-rebuy fields changed';
 END IF;
 IF actor<>2 AND (doc->'auto_rebuy'->'used_count' IS DISTINCT FROM 'null'::jsonb OR doc->'auto_rebuy'->'used_total' IS DISTINCT FROM 'null'::jsonb) THEN
  RAISE EXCEPTION 'another players auto-rebuy data leaked';
 END IF;
END $$;
