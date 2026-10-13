CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text;
BEGIN
  SELECT format_contract INTO v_format FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND OR v_format IS NULL OR v_format NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1') THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
  END IF;
  RETURN v_format;
END $function$
;
ALTER FUNCTION public.fn_ca_tournament_recorded_format(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_format(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $qualified$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='a7357dd1366f930eba6cd7f404090bbd' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid='public.fn_ca_tournament_recorded_format(uuid)'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_CAPTURED_FORMAT_SOURCE_MISMATCH';END IF;END $qualified$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text; v_cap integer; v_status text;
BEGIN
 SELECT t.format_contract,t.max_players,upper(COALESCE(t.status::text,''))
 INTO v_format,v_cap,v_status FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
 END IF;
 IF p_terminal_cleanup IS TRUE AND v_format IS NULL
    AND v_status IN ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN false;
 END IF;
 v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);
 RETURN v_format IN ('spin-v1','seat-first-satellite-v1')
     OR (v_format='sng-v1' AND v_cap BETWEEN 1 AND 2);
END $function$
;
ALTER FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $qualified$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='00e225cc67cf595af35831e981106d93' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid='public.fn_ca_tournament_recorded_seat_first(uuid,boolean)'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_CAPTURED_FORMAT_SOURCE_MISMATCH';END IF;END $qualified$;
