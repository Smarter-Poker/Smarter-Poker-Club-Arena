-- Reserved 2026-09-14 00:27:16 UTC. One per-horse audit was incorrectly
-- treated as completion of the entire nightly study, including after restart.
-- Completion now requires a bounded captured eligible roster whose individual
-- atomic write receipts and audit identities all exist. Old audit rows alone
-- never certify completion. No diagnostic formula, schedule or money changes.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE INDEX horse_tuner_receipt_day_idx ON public.horse_tuner_write_receipts(run_date,horse_id);
CREATE TABLE public.horse_tuner_study_rosters (
  run_date date PRIMARY KEY,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  request_payload text NOT NULL CHECK(octet_length(request_payload)<=100000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.horse_tuner_study_rosters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_tuner_study_rosters FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.horse_tuner_study_completions (
  run_date date PRIMARY KEY,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  eligible_horses uuid[] NOT NULL CHECK(cardinality(eligible_horses)<=2048),
  studied integer NOT NULL CHECK(studied BETWEEN 0 AND 2048),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.horse_tuner_study_completions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_tuner_study_completions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.horse_tuner_study_completions TO service_role;
CREATE POLICY horse_tuner_completion_service_read ON public.horse_tuner_study_completions
FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.fn_horse_tuner_recorded_horses(p_run_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
DECLARE ids uuid[];
BEGIN
  IF p_run_date IS NULL THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_date');
  END IF;
  SELECT coalesce(array_agg(q.horse_id ORDER BY q.horse_id),ARRAY[]::uuid[]) INTO ids
    FROM (SELECT r.horse_id FROM public.horse_tuner_write_receipts r
      WHERE r.run_date=p_run_date ORDER BY r.horse_id LIMIT 2049) q;
  IF cardinality(ids)>2048 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','horse_budget_exceeded');
  END IF;
  RETURN jsonb_build_object('version',1,'status','snapshot',
    'runDate',to_char(p_run_date,'YYYY-MM-DD'),'horseIds',to_jsonb(ids));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_tuner_recorded_horses(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tuner_recorded_horses(date) TO service_role;

CREATE FUNCTION public.fn_prepare_horse_tuner_study(p_payload text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET lock_timeout TO '2s'
AS $function$
DECLARE r jsonb; day date; ids uuid[]; count_studied integer; digest text;
  previous public.horse_tuner_study_rosters%ROWTYPE;
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload)>100000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  BEGIN
    r:=p_payload::jsonb; day:=(r->>'runDate')::date;
    count_studied:=(r->>'studied')::integer;
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
      OR r->'version' IS DISTINCT FROM '1'::jsonb
      OR (r->>'runDate') IS DISTINCT FROM to_char(day,'YYYY-MM-DD')
      OR day IS NULL OR count_studied IS NULL
      OR coalesce(r->>'studied','') !~ '^(0|[1-9][0-9]*)$'
      OR count_studied NOT BETWEEN 0 AND 2048
      OR jsonb_typeof(r->'horseIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(r->'horseIds')>2048 THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
    SELECT coalesce(array_agg(x::uuid ORDER BY x::uuid),ARRAY[]::uuid[]) INTO ids
      FROM jsonb_array_elements_text(r->'horseIds') x;
    IF EXISTS(SELECT 1 FROM unnest(ids) u WHERE u IS NULL)
      OR cardinality(ids)<>(SELECT count(DISTINCT u) FROM unnest(ids) u)
      OR r->'horseIds' IS DISTINCT FROM to_jsonb(ids)
      OR count_studied<cardinality(ids)
      OR p_payload IS DISTINCT FROM format('{"version":1,"runDate":"%s","studied":%s,"horseIds":%s}',
        to_char(day,'YYYY-MM-DD'),count_studied,array_to_json(ids)::text) THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
    OR datetime_field_overflow OR numeric_value_out_of_range OR invalid_parameter_value THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END;
  digest:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-tuner-study:'||day::text,0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','study_busy');
  END IF;
  SELECT * INTO previous FROM public.horse_tuner_study_rosters s WHERE s.run_date=day;
  IF NOT FOUND THEN
    INSERT INTO public.horse_tuner_study_rosters(run_date,request_hash,request_payload)
      VALUES(day,digest,p_payload) RETURNING * INTO previous;
  END IF;
  RETURN jsonb_build_object('version',1,'status','prepared',
    'payload',previous.request_payload,'requestHash',previous.request_hash);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_prepare_horse_tuner_study(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prepare_horse_tuner_study(text) TO service_role;

CREATE FUNCTION public.fn_complete_horse_tuner_study(p_payload text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET lock_timeout TO '2s'
AS $function$
DECLARE r jsonb; day date; ids uuid[]; count_studied integer; digest text;
  previous public.horse_tuner_study_completions%ROWTYPE;
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload)>100000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  BEGIN
    r:=p_payload::jsonb; day:=(r->>'runDate')::date;
    count_studied:=(r->>'studied')::integer;
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
      OR r->'version' IS DISTINCT FROM '1'::jsonb
      OR (r->>'runDate') IS DISTINCT FROM to_char(day,'YYYY-MM-DD')
      OR day IS NULL OR count_studied IS NULL
      OR coalesce(r->>'studied','') !~ '^(0|[1-9][0-9]*)$'
      OR count_studied NOT BETWEEN 0 AND 2048
      OR jsonb_typeof(r->'horseIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(r->'horseIds')>2048 THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
    SELECT coalesce(array_agg(x::uuid ORDER BY x::uuid),ARRAY[]::uuid[]) INTO ids
      FROM jsonb_array_elements_text(r->'horseIds') x;
    IF EXISTS(SELECT 1 FROM unnest(ids) u WHERE u IS NULL)
      OR cardinality(ids)<>(SELECT count(DISTINCT u) FROM unnest(ids) u)
      OR r->'horseIds' IS DISTINCT FROM to_jsonb(ids)
      OR count_studied<cardinality(ids)
      OR p_payload IS DISTINCT FROM format('{"version":1,"runDate":"%s","studied":%s,"horseIds":%s}',
        to_char(day,'YYYY-MM-DD'),count_studied,array_to_json(ids)::text) THEN
      RAISE EXCEPTION 'invalid request' USING ERRCODE='22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
    OR datetime_field_overflow OR numeric_value_out_of_range OR invalid_parameter_value THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END;
  digest:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-tuner-study:'||day::text,0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','study_busy');
  END IF;
  SELECT * INTO previous FROM public.horse_tuner_study_completions c WHERE c.run_date=day;
  IF FOUND THEN
    IF previous.request_hash<>digest THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','study_conflict');
    END IF;
    RETURN jsonb_build_object('version',1,'status','recorded','runDate',to_char(day,'YYYY-MM-DD'),
      'requestHash',digest,'eligible',cardinality(ids),'replayed',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.horse_tuner_study_rosters s
    WHERE s.run_date=day AND s.request_hash=digest) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','study_roster_mismatch');
  END IF;
  -- Bind completion to the immutable receipt AND its original audit row,
  -- not merely the presence of some horse's log for this date.
  IF EXISTS(SELECT 1 FROM unnest(ids) horse
    WHERE NOT EXISTS(SELECT 1 FROM public.horse_tuner_write_receipts w
      JOIN public.horse_self_tune_log a ON a.id=w.audit_id
        AND a.horse_id=w.horse_id::text AND a.run_date=w.run_date
      WHERE w.horse_id=horse AND w.run_date=day)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','unfinished_horses');
  END IF;
  INSERT INTO public.horse_tuner_study_completions(run_date,request_hash,eligible_horses,studied)
    VALUES(day,digest,ids,count_studied);
  RETURN jsonb_build_object('version',1,'status','recorded','runDate',to_char(day,'YYYY-MM-DD'),
    'requestHash',digest,'eligible',cardinality(ids),'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_complete_horse_tuner_study(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_horse_tuner_study(text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_audit_nightly_job_health(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_rows bigint;
  v_last_league date;
  v_gap int;
  v_matchups bigint;
begin
  for r in
    select j.job, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.run_date = p_day
       and j.job in ('league', 'league_pm', 'self_tuner')
     order by j.job
  loop
    -- Execution receipts began on 2026-09-14. Earlier nights keep their
    -- historical liveness check; old audit rows are not retroactive receipts.
    if r.job = 'self_tuner' and p_day >= date '2026-09-14' then
      if not exists(select 1 from public.horse_tuner_study_completions c where c.run_date=p_day) then
        select count(*) into v_rows from public.horse_self_tune_log where run_date=p_day;
        v_findings := v_findings || jsonb_build_object(
          'severity','critical','category','schema','code','nightly_job_incomplete',
          'title','self_tuner claimed ' || p_day || ' without completing its study',
          'evidence',jsonb_build_object('job',r.job,'run_date',p_day,
            'claimed_at',r.claimed_at,'claimed_by',r.claimed_by,
            'individual_audit_rows',v_rows,'completion_receipts',0),
          'recommendation','Resume unfinished horses using their atomic daily receipts. Individual audit rows do not certify the captured eligible cohort.');
      end if;
      continue;
    end if;
    if r.job in ('league', 'league_pm') then
      select count(*) into v_rows from horse_league_results where run_date = p_day;
    else
      select count(*) into v_rows from horse_self_tune_log where run_date = p_day;
    end if;

    if v_rows = 0 then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical',
        'category', 'schema',
        'code', 'nightly_job_lost',
        'title', r.job || ' claimed ' || p_day || ' and produced nothing',
        'evidence', jsonb_build_object(
          'job', r.job,
          'run_date', p_day,
          'claimed_at', r.claimed_at,
          'claimed_by', r.claimed_by,
          'evidence_rows', 0
        ),
        'recommendation',
          'The job took the lock and died before writing a row - an engine ' ||
          'restart inside the run is the usual cause, and server/** merges ' ||
          'deploy automatically. Check the container logs for that window. ' ||
          'Any conclusion drawn from this job for this date is unsupported: ' ||
          'do not quote it.'
      );
    end if;
  end loop;

  select max(run_date) into v_last_league from horse_league_results;
  if v_last_league is null then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'critical',
      'category', 'schema',
      'code', 'league_card_empty',
      'title', 'horse_league_results has no rows at all',
      'evidence', jsonb_build_object('as_of', p_day),
      'recommendation',
        'No layer has ever been measured. Every strategy verdict is opinion ' ||
        'until the league runs.'
    );
  else
    v_gap := p_day - v_last_league;
    if v_gap >= 1 then
      select count(*) into v_matchups from horse_league_results where run_date = v_last_league;
      v_findings := v_findings || jsonb_build_object(
        'severity', case when v_gap >= 2 then 'critical' else 'warn' end,
        'category', 'schema',
        'code', 'league_card_stale',
        'title', 'The newest league measurement is ' || v_gap || ' day(s) before ' || p_day,
        'evidence', jsonb_build_object(
          'last_run_date', v_last_league,
          'days_stale', v_gap,
          'matchups_in_last_run', v_matchups
        ),
        'recommendation',
          'Layer verdicts are being read off a card this many days old. ' ||
          'Significance rules assume independent runs, so a single surviving ' ||
          'run cannot satisfy any three-run gate (v16_ratio_rescale in ' ||
          'particular). Fix the runner before tuning anything on this card.'
      );
    end if;
  end if;

  for r in
    select matchup, hands
      from horse_league_results
     where run_date = p_day and bb100 = 0 and stderr = 0 and hands > 0
     order by matchup
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'league_matchup_inert',
      'title', r.matchup || ' returned exactly zero over ' || r.hands || ' hands',
      'evidence', jsonb_build_object('matchup', r.matchup, 'hands', r.hands),
      'recommendation',
        'Both arms played identically. Confirm the b-side flag still gates ' ||
        'live code; if it does not, the layer is unreachable or the flag is ' ||
        'dead and the matchup should be retired or repointed.'
    );
  end loop;

  return v_findings;
end
$function$;
REVOKE ALL ON FUNCTION public.fn_audit_nightly_job_health(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_nightly_job_health(date) TO service_role;
COMMIT;
