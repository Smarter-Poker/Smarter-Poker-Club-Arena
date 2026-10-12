CREATE OR REPLACE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club uuid;
BEGIN
 FOR v_club IN SELECT DISTINCT c FROM unnest(p_club_ids) c WHERE c IS NOT NULL ORDER BY c LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_club::text));
 END LOOP;
END $function$
