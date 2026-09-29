-- Reserved 2026-09-14 02:07:27 UTC. Observational diagnostics do not
-- authorize profile changes. New unqualified mutations refuse even without
-- an intent label; exact historical receipts and no-change audits remain valid.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_record_horse_tuner_update(text)'::regprocedure)
    IS DISTINCT FROM '74a40f2accdf486fe09b8cccef04fc3d' THEN
    RAISE EXCEPTION 'HORSE_TUNER_WRITER_BODY_CHANGED';
  END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION public.fn_record_horse_tuner_update(p_payload text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '5s'
AS $function$
DECLARE
  r jsonb; a jsonb; expected jsonb; next_profile jsonb; current_profile jsonb;
  normalized jsonb; mods_before jsonb; mods_after jsonb;
  horse uuid; day date; request_hash text; changed boolean; audit_id bigint;
  prior public.horse_tuner_write_receipts%ROWTYPE; k text; before_value jsonb;
  owned text[] := ARRAY['tightness','aggression','bluffFreq','leaks','leaksHands',
    'leaksOmaha','leaksHandsOmaha','leaksHoldem','leaksHandsHoldem',
    'leaksTournament','leaksHandsTournament'];
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload)>65536 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  BEGIN
    r:=p_payload::jsonb;
    horse:=(r->>'horseId')::uuid;
    day:=(r->>'runDate')::date;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END;
  a:=r->'audit'; expected:=r->'expectedProfile'; next_profile:=r->'nextProfile';
  mods_before:=a->'modsBefore'; mods_after:=a->'modsAfter';
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->'version' IS DISTINCT FROM '1'::jsonb
    OR horse IS NULL OR day IS NULL OR (r->>'runDate') IS DISTINCT FROM to_char(day,'YYYY-MM-DD')
    OR (r ? 'intent' AND r->'intent' IS DISTINCT FROM '"observational_only"'::jsonb)
    OR expected IS NULL OR next_profile IS NULL
    OR jsonb_typeof(expected) NOT IN ('object','string','null')
    OR jsonb_typeof(next_profile) NOT IN ('object','string','null')
    OR jsonb_typeof(a) IS DISTINCT FROM 'object'
    OR jsonb_typeof(a->'hands') IS DISTINCT FROM 'number'
    OR (a->>'hands') !~ '^[0-9]{1,10}$'
    OR (a->>'hands')::numeric NOT BETWEEN 300 AND 2147483647
    OR jsonb_typeof(a->'stats') IS DISTINCT FROM 'object'
    OR jsonb_typeof(mods_before) IS DISTINCT FROM 'object'
    OR jsonb_typeof(mods_after) IS DISTINCT FROM 'object'
    OR jsonb_typeof(a->'reasons') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  IF jsonb_array_length(a->'reasons')>64
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'reasons') e WHERE jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>512)
    OR EXISTS(SELECT 1 FROM jsonb_each(a->'stats') e WHERE jsonb_typeof(e.value)<>'number') THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_request');
  END IF;
  normalized:=CASE jsonb_typeof(expected) WHEN 'object' THEN expected
    WHEN 'string' THEN jsonb_build_object('style',expected) ELSE '{}'::jsonb END;
  changed:=next_profile IS DISTINCT FROM expected;
  IF changed AND (jsonb_typeof(next_profile)<>'object' OR
      (next_profile-owned) IS DISTINCT FROM (normalized-owned)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','authored_profile_change');
  END IF;
  FOREACH k IN ARRAY ARRAY['tightness','aggression','bluffFreq'] LOOP
    before_value:=CASE WHEN k='bluffFreq' THEN coalesce(nullif(normalized->k,'null'::jsonb),normalized->'bluff_freq') ELSE normalized->k END;
    IF jsonb_typeof(before_value) IS DISTINCT FROM 'number' THEN before_value:='1'::jsonb; END IF;
    IF mods_before->k IS DISTINCT FROM before_value
      OR jsonb_typeof(mods_after->k) IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_modifiers');
    END IF;
    -- A no-change audit must preserve authored values, including values outside
    -- the tuner's proposal range. The range still constrains every mutation.
    IF (changed AND (mods_after->>k)::numeric NOT BETWEEN 0.85 AND 1.18)
      OR (changed AND next_profile->k IS DISTINCT FROM mods_after->k)
      OR (NOT changed AND mods_after->k IS DISTINCT FROM before_value) THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_modifiers');
    END IF;
  END LOOP;
  request_hash:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-tuner-write:'||horse::text,0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','writer_busy');
  END IF;
  SELECT * INTO prior FROM public.horse_tuner_write_receipts WHERE horse_id=horse AND run_date=day;
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM request_hash OR prior.request_payload IS DISTINCT FROM p_payload THEN
      RETURN jsonb_build_object('version',1,'status','unavailable','reason','run_conflict');
    END IF;
    RETURN jsonb_build_object('version',1,'status','recorded','requestHash',request_hash,
      'horseId',horse,'runDate',day,'changed',prior.profile_changed,'replayed',true);
  END IF;
  -- An omitted intent is not causal authority. All new profile mutations
  -- require the separately qualified activation path, which is not provided
  -- by this legacy diagnostic RPC. Exact historical receipts replay above.
  IF changed THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','causal_permission_missing');
  END IF;
  SELECT horse_profile INTO current_profile FROM public.profiles WHERE id=horse AND is_horse IS TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','horse_unavailable');
  END IF;
  IF coalesce(current_profile,'null'::jsonb) IS DISTINCT FROM expected THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','profile_changed');
  END IF;
  IF EXISTS(SELECT 1 FROM public.horse_self_tune_log WHERE horse_id=horse::text AND run_date=day) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','legacy_run_unavailable');
  END IF;
  INSERT INTO public.horse_self_tune_log(horse_id,run_date,hands,stats,mods_before,mods_after,reasons)
    VALUES(horse::text,day,(a->>'hands')::integer,a->'stats',mods_before,mods_after,
      ARRAY(SELECT jsonb_array_elements_text(a->'reasons'))) RETURNING id INTO audit_id;
  INSERT INTO public.horse_tuner_write_receipts(horse_id,run_date,request_hash,request_payload,profile_changed,audit_id)
    VALUES(horse,day,request_hash,p_payload,changed,audit_id);
  RETURN jsonb_build_object('version',1,'status','recorded','requestHash',request_hash,
    'horseId',horse,'runDate',day,'changed',changed,'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_record_horse_tuner_update(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_horse_tuner_update(text) TO service_role;
COMMENT ON FUNCTION public.fn_record_horse_tuner_update(text) IS
  'Atomic profile CAS, audit and exact-request receipt. New unqualified profile mutations refuse even without an audit-only label. Exact historical receipts replay without a new mutation; no-op audits preserve authored values. No causal activation authority.';
COMMIT;
