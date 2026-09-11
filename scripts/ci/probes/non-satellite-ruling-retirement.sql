-- Local fixture helpers only. The operational ruling call runs with origin
-- triggers. Synthetic classification changes live in an aborted subtransaction.
CREATE SCHEMA ruling_probe;
CREATE FUNCTION ruling_probe.application_state() RETURNS jsonb
LANGUAGE plpgsql AS $state$
DECLARE r record; result jsonb := '{}'::jsonb; fingerprint text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]'')::text) FROM public.%I t',r.relname)
      INTO fingerprint;
    result := result || jsonb_build_object(r.relname,fingerprint);
  END LOOP;
  RETURN result;
END;
$state$;

CREATE FUNCTION ruling_probe.exercise(p_event uuid,p_patch jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql AS $exercise$
DECLARE before_state jsonb; after_state jsonb; answer jsonb; result jsonb;
BEGIN
  BEGIN
    -- Opening fixture metadata only. Never disable guards around a ruling.
    PERFORM set_config('session_replication_role','replica',true);
    UPDATE public.tournaments SET
      variant=CASE WHEN p_patch ? 'variant' THEN p_patch->>'variant' ELSE variant END,
      tournament_type=CASE WHEN p_patch ? 'tournament_type' THEN p_patch->>'tournament_type' ELSE tournament_type END,
      satellite_target_id=CASE WHEN p_patch ? 'satellite_target_id' THEN (p_patch->>'satellite_target_id')::uuid ELSE satellite_target_id END,
      satellite_target=CASE WHEN p_patch ? 'satellite_target' THEN (p_patch->>'satellite_target')::uuid ELSE satellite_target END,
      is_bounty=COALESCE((p_patch->>'is_bounty')::boolean,is_bounty),
      is_pko=COALESCE((p_patch->>'is_pko')::boolean,is_pko),
      is_mystery_bounty=COALESCE((p_patch->>'is_mystery_bounty')::boolean,is_mystery_bounty),
      status=COALESCE(p_patch->>'status',status)
      WHERE id=p_event;
    IF p_patch->>'status'='COMPLETING' THEN
      UPDATE public.tournament_players SET status='winner',position=1,
        eliminated_at=NULL,elimination_sequence=NULL
        WHERE tournament_id=p_event AND status='playing';
    END IF;
    PERFORM set_config('session_replication_role','origin',true);
    before_state := ruling_probe.application_state();
    BEGIN
      answer := public.fn_settle_tournament_places_by_ruling(p_event,p_reason);
    EXCEPTION WHEN OTHERS THEN
      answer := jsonb_build_object('exception',SQLERRM,'sqlstate',SQLSTATE);
    END;
    after_state := ruling_probe.application_state();
    result := jsonb_build_object('result',answer,'unchanged',before_state=after_state,
      'operationalTriggerExecution',current_setting('session_replication_role'));
    RAISE EXCEPTION 'discard local classification fixture' USING ERRCODE='P9998';
  EXCEPTION WHEN SQLSTATE 'P9998' THEN
    RETURN result;
  END;
END;
$exercise$;
