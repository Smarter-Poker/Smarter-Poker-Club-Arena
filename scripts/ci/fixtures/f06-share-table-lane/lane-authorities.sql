-- Live bodies (2026-10-03) of the lane authorities the F06 hand calls reach:
-- smarter_private.f06_authority, smarter_private.f06_prefix and
-- public.fn_ca_lock_settlement_lane_for_tournament: the live statements in the
-- live order, with the live signatures; comments trimmed. The three functions
-- the migration changes are NOT here: preimages.json holds their exact live
-- definitions, md5-pinned.
CREATE OR REPLACE FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
 OR NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid IS DISTINCT FROM t
 OR NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid IS DISTINCT FROM g OR t IS NULL OR g IS NULL THEN
 RAISE EXCEPTION 'F06_PROTOCOL2_REQUIRED' USING ERRCODE='42501'; END IF;
 IF take_lock THEN
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 ELSE
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;
  IF v_tournament_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION smarter_private.f06_prefix(t uuid, g uuid, users uuid[], ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE u uuid;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM smarter_private.f06_authority(t,g,false);
 FOR u IN SELECT DISTINCT x FROM unnest(users) x ORDER BY x LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)); END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t AND user_id=ANY(users) ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
 WHERE tb.tournament_id=t AND (s.user_id=ANY(users) OR s.table_id=ANY(ids)) ORDER BY s.id FOR UPDATE OF s;
END $function$;
