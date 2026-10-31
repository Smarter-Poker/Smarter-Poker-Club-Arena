-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_operator_floor_state(uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='2b435ae83349dd87fa926caf79ff8236' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND NOT cash_games_enabled AND NOT tournaments_enabled)
-- Owner requests complete Diamond shutdown before any compute resize.
-- The remaining old originals are parked intact, never refunded or disposed.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_operator_floor_state(uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='c14df5ec0456971521c545859cf7bd48' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_PARK_PREIMAGE_CHANGED';END IF;END $pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
 'hold',coalesce(
  (SELECT jsonb_build_object('operation_id',c.operation_id,'mode','park','reason',c.reason)
   FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id
   -- Park at the existing engine boundary, including old retained originals.
   -- Their persisted permits, continuations, snapshots and money remain intact.
   -- Recovery must wait for a separately authorized reopening.
   WHERE t.id=p_table_id AND c.closed),
  (SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h WHERE NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id AND EXISTS(SELECT 1 FROM public.tables st WHERE st.id=p_table_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))),
  (SELECT jsonb_build_object('operation_id',a.operation_id,'mode','park','reason',op.reason,'tournament_abort',true,'tournament_id',a.tournament_id)
   FROM smarter_private.tournament_abort_targets a JOIN public.tables t ON t.tournament_id=a.tournament_id
   JOIN smarter_private.tournament_abort_operations op ON op.operation_id=a.operation_id
   WHERE t.id=p_table_id
    -- Startup asks before it restores an original hand. An unfinished original
    -- is allowed through this READ so its existing permit can finish; the new
    -- permit door above is already stopped. Never mistake this read for ACK.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=t.id AND h.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete))),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid) TO service_role;
UPDATE public.ca_arena_settings SET cash_games_enabled=false,tournaments_enabled=false WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81';
DO $post$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_operator_floor_state(uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='2b435ae83349dd87fa926caf79ff8236' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_PARK_POSTIMAGE_CHANGED';END IF;IF NOT EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND NOT cash_games_enabled AND NOT tournaments_enabled) THEN RAISE EXCEPTION 'DIAMOND_SWITCHES_NOT_CLOSED';END IF;IF clock_timestamp()-transaction_timestamp()>=interval '8 seconds' THEN RAISE EXCEPTION 'DIAMOND_PARK_INSTALL_BUDGET';END IF;END $post$;
COMMIT;
