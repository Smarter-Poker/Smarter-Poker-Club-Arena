-- Admin kicks previously wrote moderation history after the financial action,
-- fire-and-forget. A lost process or failed insert erased who authorized it.
-- Record original authority and accepted departure together before cashout.
-- The existing occupancy receipt is the separate proof of committed payment;
-- a request audit must never claim that a pending cashout has completed.
-- No FK on retained authority: deleting a profile/table must not erase it.
-- This additive contract follows occupancy adoption; no balance repair.
SET lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS public.seat_admin_departure_authorizations (
 occupancy_id uuid PRIMARY KEY, user_id uuid NOT NULL, table_id uuid NOT NULL,
 seat_number integer NOT NULL, actor_id uuid NOT NULL, club_id uuid NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.seat_admin_departure_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seat_admin_departure_authorizations FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_request_admin_seat_departure(
 p_user_id uuid,p_table_id uuid,p_seat_number integer,p_occupancy_id uuid,
 p_actor_id uuid,p_club_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_result jsonb; v_authority public.seat_admin_departure_authorizations%ROWTYPE;
 v_inserted integer;
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
  RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
 END IF;
 -- Actor and club come only from the HTTP authorization result, never body fields.
 IF p_actor_id IS NULL OR p_club_id IS NULL OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'ADMIN_DEPARTURE_AUTHORITY_REQUIRED' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.tables WHERE id=p_table_id AND club_id=p_club_id) THEN
  RAISE EXCEPTION 'ADMIN_DEPARTURE_CLUB_MISMATCH' USING ERRCODE='22023';
 END IF;
 -- This takes the shared user/parent/seat locks and validates exact occupancy.
 -- Any later audit failure rolls its flags and durable forced authority back.
 v_result := public.fn_request_seat_departure(
  p_user_id,p_table_id,p_seat_number,p_occupancy_id,'forced');
 INSERT INTO public.seat_admin_departure_authorizations
  (occupancy_id,user_id,table_id,seat_number,actor_id,club_id,reason)
 VALUES(p_occupancy_id,p_user_id,p_table_id,p_seat_number,p_actor_id,p_club_id,p_reason)
 ON CONFLICT(occupancy_id) DO NOTHING;
 GET DIAGNOSTICS v_inserted = ROW_COUNT;
 SELECT * INTO STRICT v_authority FROM public.seat_admin_departure_authorizations
  WHERE occupancy_id=p_occupancy_id;
 IF v_authority.user_id IS DISTINCT FROM p_user_id
    OR v_authority.table_id IS DISTINCT FROM p_table_id
    OR v_authority.seat_number IS DISTINCT FROM p_seat_number
    OR v_authority.club_id IS DISTINCT FROM p_club_id THEN
  RAISE EXCEPTION 'ADMIN_DEPARTURE_SCOPE_MISMATCH' USING ERRCODE='22023';
 END IF;
 IF v_inserted=1 THEN
  INSERT INTO public.anti_cheat_events
   (event_type,player_id,club_id,table_id,details,triggered_by)
  VALUES('player_kicked',p_user_id,p_club_id,p_table_id,
   jsonb_build_object('reason',v_authority.reason,'kicked_by',v_authority.actor_id,
    'source','engine_admin_kick','occupancy_id',p_occupancy_id,
    'state','departure_requested','cashout_confirmed',false),
   v_authority.actor_id::text);
 END IF;
 RETURN v_result || jsonb_build_object('admin_authorization',
  jsonb_build_object('occupancy_id',v_authority.occupancy_id,'actor_id',v_authority.actor_id,
   'club_id',v_authority.club_id,'reason',v_authority.reason));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_request_admin_seat_departure(uuid,uuid,integer,uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_request_admin_seat_departure(uuid,uuid,integer,uuid,uuid,uuid,text)
 TO service_role;
