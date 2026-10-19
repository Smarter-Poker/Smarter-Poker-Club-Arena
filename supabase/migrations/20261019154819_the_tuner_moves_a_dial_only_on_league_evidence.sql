-- Reserved 2026-10-19 15:48:19 UTC. LEAGUE-GATED SELF-TUNER NUDGES.
--
-- Dan 2026-10-19 chose "League-gated nudges": a self-tuner dial move reaches a
-- live horse only after a league matchup shows that move significantly
-- positive, the same rule every brain layer is promoted by. Phase 14's
-- corrective path (reference producer, independent signer, applier) is left
-- untouched and inactive; fn_record_horse_tuner_update still refuses every
-- unqualified profile mutation. This is a SEPARATE, narrower door:
--
--   * only tightness, aggression and bluffFreq may change - leak counts,
--     persona and every authored key are byte-identical before and after;
--   * each changed dial moves at most 0.02 and stays inside 0.85..1.18;
--   * each move's direction must be ADMITTED: its league matchup
--     (tuner_<dial>_<up|down>) has >= 3 measured runs in the last 30 days and
--     a pooled (inverse-variance) bb/100 above 2 x the pooled stderr;
--   * the profile is compare-and-swapped against the caller's expected value;
--   * one receipt per horse per night, replay-safe.
--
-- The engine only calls this when HORSE_TUNER_LEAGUE_GATED_APPLY=1 (default
-- unset). The database re-checks the evidence itself; a caller cannot claim it.
BEGIN;
SET LOCAL lock_timeout='2s';

CREATE TABLE IF NOT EXISTS public.horse_tuner_league_nudges (
  horse_id uuid NOT NULL,
  run_date date NOT NULL,
  request_hash text NOT NULL,
  mods_before jsonb NOT NULL,
  mods_after jsonb NOT NULL,
  admitted_classes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (horse_id, run_date)
);
ALTER TABLE public.horse_tuner_league_nudges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.horse_tuner_league_nudges FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.horse_tuner_league_nudges TO service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_tuner_admitted_classes()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
SET statement_timeout TO '5s'
AS $function$
  SELECT coalesce(array_agg(cls ORDER BY cls), ARRAY[]::text[])
    FROM (
      SELECT substr(matchup, 7) AS cls
        FROM public.horse_league_results
       WHERE matchup IN ('tuner_tightness_up','tuner_tightness_down',
                         'tuner_aggression_up','tuner_aggression_down',
                         'tuner_bluff_up','tuner_bluff_down')
         AND status = 'measured'
         AND stderr IS NOT NULL AND stderr::numeric > 0
         AND bb100 IS NOT NULL
         AND illegal_actions = 0
         AND run_date >= (now() AT TIME ZONE 'utc')::date - 30
       GROUP BY matchup
      HAVING count(*) >= 3
         AND sum(bb100::numeric / (stderr::numeric ^ 2)) / sum(1 / (stderr::numeric ^ 2))
             > 2 * sqrt(1 / sum(1 / (stderr::numeric ^ 2)))
    ) q;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_tuner_admitted_classes() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_tuner_admitted_classes() TO service_role;
COMMENT ON FUNCTION public.fn_horse_tuner_admitted_classes() IS
  'Self-tuner dial directions whose league matchup pools significant positive (>=3 runs in 30 days, pooled bb/100 > 2 x pooled stderr).';

CREATE OR REPLACE FUNCTION public.fn_apply_league_gated_horse_tuner_nudge(p_payload text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '5s'
AS $function$
DECLARE
  r jsonb; expected jsonb; next_profile jsonb; current_profile jsonb;
  mods_before jsonb := '{}'::jsonb; mods_after jsonb := '{}'::jsonb;
  horse uuid; day date; request_hash text; prior public.horse_tuner_league_nudges%ROWTYPE;
  admitted text[]; used text[] := ARRAY[]::text[];
  k text; slug text; b numeric; n numeric; dials text[] := ARRAY['tightness','aggression','bluffFreq'];
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload) > 65536 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  BEGIN
    r := p_payload::jsonb;
    horse := (r->>'horseId')::uuid;
    day := (r->>'runDate')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END;
  expected := r->'expectedProfile'; next_profile := r->'nextProfile';
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->'version' IS DISTINCT FROM '1'::jsonb
     OR horse IS NULL OR day IS NULL OR (r->>'runDate') IS DISTINCT FROM to_char(day,'YYYY-MM-DD')
     OR jsonb_typeof(expected) IS DISTINCT FROM 'object'
     OR jsonb_typeof(next_profile) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  -- Only the three dials may differ. Leaks, persona and authored keys are untouched.
  IF (next_profile - dials) IS DISTINCT FROM (expected - dials) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','non_dial_change');
  END IF;
  admitted := public.fn_horse_tuner_admitted_classes();
  FOREACH k IN ARRAY dials LOOP
    b := CASE WHEN jsonb_typeof(expected->k) = 'number' THEN (expected->>k)::numeric ELSE 1 END;
    IF next_profile ? k AND jsonb_typeof(next_profile->k) IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_modifiers');
    END IF;
    n := CASE WHEN next_profile ? k THEN (next_profile->>k)::numeric ELSE b END;
    mods_before := mods_before || jsonb_build_object(k, b);
    mods_after := mods_after || jsonb_build_object(k, n);
    IF n <> b THEN
      IF n NOT BETWEEN 0.85 AND 1.18 OR abs(n - b) > 0.02 + 1e-9 THEN
        RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_modifiers');
      END IF;
      slug := CASE k WHEN 'bluffFreq' THEN 'bluff' ELSE k END
              || CASE WHEN n > b THEN '_up' ELSE '_down' END;
      IF NOT slug = ANY(admitted) THEN
        RETURN jsonb_build_object('version',1,'status','unavailable','reason','not_league_admitted','class',slug);
      END IF;
      used := used || slug;
    END IF;
  END LOOP;
  IF cardinality(used) = 0 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','no_change');
  END IF;
  request_hash := encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-tuner-write:'||horse::text,0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','writer_busy');
  END IF;
  SELECT * INTO prior FROM public.horse_tuner_league_nudges WHERE horse_id = horse AND run_date = day;
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM request_hash THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','run_conflict');
    END IF;
    RETURN jsonb_build_object('version',1,'status','applied','requestHash',request_hash,
      'horseId',horse,'runDate',day,'classes',to_jsonb(prior.admitted_classes),'replayed',true);
  END IF;
  SELECT horse_profile INTO current_profile FROM public.profiles WHERE id = horse AND is_horse IS TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','horse_unavailable');
  END IF;
  IF coalesce(current_profile,'null'::jsonb) IS DISTINCT FROM expected THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','profile_changed');
  END IF;
  UPDATE public.profiles SET horse_profile = next_profile WHERE id = horse;
  INSERT INTO public.horse_tuner_league_nudges(horse_id, run_date, request_hash, mods_before, mods_after, admitted_classes)
    VALUES (horse, day, request_hash, mods_before, mods_after, used);
  RETURN jsonb_build_object('version',1,'status','applied','requestHash',request_hash,
    'horseId',horse,'runDate',day,'classes',to_jsonb(used),'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_apply_league_gated_horse_tuner_nudge(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_league_gated_horse_tuner_nudge(text) TO service_role;
COMMENT ON FUNCTION public.fn_apply_league_gated_horse_tuner_nudge(text) IS
  'Applies a self-tuner dial move (tightness/aggression/bluffFreq, <=0.02, 0.85..1.18) only when its direction is league-admitted by fn_horse_tuner_admitted_classes. CAS on the profile, dials only, one receipt per horse per night. Phase 14 corrective authority is separate and unchanged.';
COMMIT;
