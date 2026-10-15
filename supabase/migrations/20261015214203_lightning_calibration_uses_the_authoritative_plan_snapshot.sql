-- 20261015214203_lightning_calibration_uses_the_authoritative_plan_snapshot.sql
-- A/A must compare identical inputs, not reconstructed queue/blind memory.
-- Requires the qualified 20261015212230 full-ring helper first. No money,
-- seat, session, matcher decision or historical comparison row is changed.
-- @live-proof: (SELECT pg_get_functiondef('public.fn_lightning_match(uuid,timestamptz,uuid[],text,jsonb)'::regprocedure) LIKE '%fn_lightning_matcher_snapshot%' AND pg_get_functiondef('public.fn_lightning_shadow_report(uuid,timestamptz,timestamptz)'::regprocedure) LIKE '%CURRENT AUTHORITATIVE SNAPSHOT BINDING%' AND has_function_privilege('service_role','public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)','EXECUTE') AND has_function_privilege('service_role','public.fn_lightning_matcher_binding(uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_lightning_matcher_binding(uuid)','EXECUTE'))
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION public.fn_lightning_matcher_snapshot(
 p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[], p_player_platforms jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public','pg_temp' AS $fn$
DECLARE
 v_now timestamptz := coalesce(p_now,now());
 v_cfg jsonb := public.fn_lightning_config(p_cluster_id);
 v_epoch integer;
 v_players jsonb;
 v_recent jsonb;
BEGIN
 SELECT cluster_epoch INTO v_epoch FROM public.cash_games WHERE id=p_cluster_id;
 IF v_epoch IS NULL OR (v_cfg->>'ok')::boolean IS DISTINCT FROM true THEN RETURN NULL; END IF;
 -- Keep this service-only response bounded. A larger pool gets an ordinary
 -- plan, but cannot claim an authoritative calibration snapshot from it.
 IF (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id=p_cluster_id AND exited_at IS NULL)>500 THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'playerId',l.player_id,'legal',l.legal,'reasonCode',l.reason_code,
   'idleSinceMs',coalesce(extract(epoch FROM sl.idle_since)*1000,extract(epoch FROM v_now)*1000),
   'enteredAtMs',extract(epoch FROM ps.entered_at)*1000,
   'joinedAtMs',extract(epoch FROM cps.opened_at)*1000,
   'slotOpenedAtMs',coalesce(extract(epoch FROM sl.opened_at)*1000,extract(epoch FROM ps.entered_at)*1000),
   'lastBbAtMs',extract(epoch FROM sl.last_bb_at)*1000,
   'bbUnresolved',coalesce(bl.missed_bb_debt,0)>0 OR coalesce(bl.bb_owed,0)>0,
   'debtSinceMs',coalesce(extract(epoch FROM coalesce(bl.debt_since,sl.opened_at))*1000,extract(epoch FROM ps.entered_at)*1000),
   'handsSinceBb',sl.hands_since_bb,'newcomer',bl.player_id IS NULL,
   'positions',jsonb_build_object('btn',coalesce(bl.btn_count,0),'co',coalesce(bl.co_count,0),
      'hj',coalesce(bl.hj_count,0),'utg',coalesce(bl.utg_count,0))) ORDER BY l.player_id),'[]'::jsonb)
 INTO v_players
 FROM public.fn_lightning_player_legality(p_cluster_id,v_now,p_disconnected,p_player_platforms) l
 JOIN public.lightning_pool_session ps ON ps.id=l.pool_session_id
 LEFT JOIN public.lightning_pool_slot sl ON sl.id=l.pool_slot_id
 LEFT JOIN public.cash_player_session cps ON cps.id=ps.cash_player_session_id
 LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id=p_cluster_id AND bl.player_id=l.player_id;

 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'handId',h.hand_id,'epoch',h.cluster_epoch,'formedAtMs',extract(epoch FROM h.formed_at)*1000,
   'players',(SELECT coalesce(jsonb_agg(hp.player_id ORDER BY hp.seat),'[]'::jsonb)
              FROM public.lightning_hand_player hp WHERE hp.hand_id=h.hand_id))
   ORDER BY h.formed_at DESC,h.hand_id),'[]'::jsonb)
 INTO v_recent FROM (
   SELECT hand_id,cluster_epoch,formed_at FROM public.lightning_hand
    WHERE cluster_id=p_cluster_id AND cluster_epoch=v_epoch AND formed_at<=v_now
      AND formed_at>v_now-make_interval(secs=>(v_cfg->>'recent_opponent_window_seconds')::integer)
    ORDER BY formed_at DESC,hand_id LIMIT (v_cfg->>'recent_opponent_window_hands')::integer
 ) h;
 RETURN jsonb_build_object('binding',public.fn_lightning_matcher_binding(p_cluster_id),
   'snapshot',jsonb_build_object('nowMs',extract(epoch FROM v_now)*1000,'epoch',v_epoch,
     'players',v_players,'recentHands',v_recent,
     'legalCount',(SELECT count(*) FROM jsonb_array_elements(v_players) p WHERE (p->>'legal')::boolean)));
END $fn$;

CREATE FUNCTION public.fn_lightning_matcher_binding(p_cluster_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $fn$
 SELECT md5(jsonb_build_object('contract','m1-port-authoritative-20261015',
   'parameters',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(public.fn_lightning_config(p_cluster_id))
    WHERE key=ANY(ARRAY['matcher_version','instance_min','instance_target','instance_max','first_entry_rule',
      'position_fairness','recent_opponent_window_hands','recent_opponent_window_seconds',
      'diversity_thin_min','diversity_medium_min','diversity_large_min','diversity_weight_medium',
      'diversity_weight_large','admission_batch_hands'])),
   'sources',(SELECT string_agg(pg_get_functiondef(p.oid),E'\n' ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      AND p.proname=ANY(ARRAY['fn_lightning_match_plan','fn_lightning_group_sizes','fn_lightning_formation_sizes',
        'fn_lightning_blind_order','fn_lightning_diversity_assign','fn_lightning_player_legality',
        'fn_lightning_matcher_snapshot'])))::text);
$fn$;
REVOKE ALL ON FUNCTION public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb), public.fn_lightning_matcher_binding(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb), public.fn_lightning_matcher_binding(uuid) TO service_role;

-- Both STABLE readers use the exact same statement snapshot and p_now. No
-- post-reservation read or second RPC can replace the input this plan saw.
CREATE OR REPLACE FUNCTION public.fn_lightning_match(
 p_cluster_id uuid,p_now timestamptz,p_disconnected uuid[],p_matcher_version text,p_player_platforms jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $fn$
 SELECT public.fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL, p_player_platforms)
   || jsonb_build_object('shadow_snapshot',public.fn_lightning_matcher_snapshot(p_cluster_id,p_now,p_disconnected,p_player_platforms));
$fn$;
REVOKE ALL ON FUNCTION public.fn_lightning_match(uuid,timestamptz,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_match(uuid,timestamptz,uuid[],text,jsonb) TO service_role;

-- Keep historical rows. An old source, estimated input, mixed binding or
-- empty window is missing current calibration evidence, never a passing one.
DO $patch$
DECLARE s text; old text := $old$WITH c AS (
    SELECT s.*
      FROM public.lightning_matcher_shadow_comparison s
     WHERE s.window_to > v_from AND s.window_to <= v_to
       AND (p_cluster_id IS NULL OR s.cluster_id = p_cluster_id)$old$;
 new text := $new$WITH bindings AS MATERIALIZED (
    SELECT g.id, public.fn_lightning_matcher_binding(g.id) AS binding
      FROM public.cash_games g
     WHERE (p_cluster_id IS NULL OR g.id=p_cluster_id)
       AND EXISTS (SELECT 1 FROM public.lightning_matcher_shadow_comparison x
                    WHERE x.cluster_id=g.id AND x.window_to>v_from AND x.window_to<=v_to)
  ), c AS (
    SELECT s.* FROM public.lightning_matcher_shadow_comparison s JOIN bindings b ON b.id=s.cluster_id
     WHERE s.window_to>v_from AND s.window_to<=v_to
       AND (p_cluster_id IS NULL OR s.cluster_id = p_cluster_id)
       -- CURRENT AUTHORITATIVE SNAPSHOT BINDING
       AND s.live_metrics->>'snapshot_binding'=b.binding
       AND s.shadow_metrics->>'snapshot_binding'=s.live_metrics->>'snapshot_binding'
       AND CASE WHEN jsonb_typeof(s.live_metrics->'seated')='number' THEN (s.live_metrics->>'seated')::numeric ELSE 0 END>0
       AND CASE WHEN jsonb_typeof(s.shadow_metrics->'seated')='number' THEN (s.shadow_metrics->>'seated')::numeric ELSE 0 END>0$new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_lightning_shadow_report(uuid,timestamptz,timestamptz)'::regprocedure) INTO s;
 IF (length(s)-length(replace(s,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Lightning shadow report source mismatch'; END IF;
 EXECUTE replace(s,old,new);
END $patch$;
COMMIT;
