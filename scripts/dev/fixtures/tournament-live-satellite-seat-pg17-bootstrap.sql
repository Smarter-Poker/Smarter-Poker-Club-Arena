\set ON_ERROR_STOP on

ALTER TABLE public.tournaments
  ADD COLUMN satellite_target_id uuid;

ALTER TABLE public.tournament_players
  ADD COLUMN is_satellite_qualifier boolean NOT NULL DEFAULT false,
  ADD COLUMN source_satellite_id uuid;

CREATE TABLE public.tournament_satellite_settlements (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  target_id uuid NOT NULL REFERENCES public.tournaments(id)
);

CREATE TABLE public.tournament_satellite_awards (
  tournament_id uuid NOT NULL
    REFERENCES public.tournament_satellite_settlements(tournament_id),
  place integer NOT NULL,
  user_id uuid NOT NULL,
  delivery_kind text NOT NULL CHECK (delivery_kind IN ('seat','cash','ticket')),
  registration_id uuid UNIQUE,
  PRIMARY KEY (tournament_id,place)
);

CREATE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,91));
END;
$function$;

CREATE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  p_tournament_id uuid,p_operation text,p_user_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR p_operation<>'satellite_finish' THEN
    RAISE EXCEPTION 'invalid probe seat-exit scope' USING ERRCODE='22023';
  END IF;
  RETURN gen_random_uuid();
END;
$function$;

CREATE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  p_token uuid,p_success boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF p_token IS NULL OR p_success IS NULL THEN
    RAISE EXCEPTION 'invalid probe seat-exit close' USING ERRCODE='22023';
  END IF;
END;
$function$;

CREATE FUNCTION public.fn_settle_satellite_tournament_seat_exit_core_v2(
  p_tournament_id uuid,p_observed_winner_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_target_id uuid;
  v_registration_id uuid;
BEGIN
  SELECT settlement.target_id INTO v_target_id
    FROM public.tournament_satellite_settlements settlement
   WHERE settlement.tournament_id=p_tournament_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',true,'tournament_id',p_tournament_id,'target_id',v_target_id,
      'seat_count',(
        SELECT count(*) FROM public.tournament_satellite_awards award
         WHERE award.tournament_id=p_tournament_id
           AND award.delivery_kind='seat'));
  END IF;

  SELECT source.satellite_target_id INTO STRICT v_target_id
    FROM public.tournaments source
   WHERE source.id=p_tournament_id FOR UPDATE;
  IF v_target_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.tournament_players source_player
     WHERE source_player.tournament_id=p_tournament_id
       AND source_player.user_id=p_observed_winner_id) THEN
    RAISE EXCEPTION 'probe source has no exact winner/target'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,status,chips,is_satellite_qualifier,
    source_satellite_id)
  VALUES(
    v_target_id,p_observed_winner_id,'registered',0,true,p_tournament_id)
  RETURNING id INTO v_registration_id;

  INSERT INTO public.tournament_satellite_settlements(tournament_id,target_id)
  VALUES(p_tournament_id,v_target_id);
  INSERT INTO public.tournament_satellite_awards(
    tournament_id,place,user_id,delivery_kind,registration_id)
  VALUES(p_tournament_id,1,p_observed_winner_id,'seat',v_registration_id);
  UPDATE public.tournaments SET status='COMPLETED'
   WHERE id=p_tournament_id;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'target_id',v_target_id,
    'seat_count',1);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_lock_daily_mission_user(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament_seat_exit_core_v2(
  uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
