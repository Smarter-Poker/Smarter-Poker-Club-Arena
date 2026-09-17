CREATE OR REPLACE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_club uuid;
BEGIN
 FOR v_club IN SELECT DISTINCT c FROM unnest(p_club_ids) c WHERE c IS NOT NULL ORDER BY c LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_club::text));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_lock_rakeback_payer_clubs(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fn_union_week_start(t timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT date_trunc('week',t AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
