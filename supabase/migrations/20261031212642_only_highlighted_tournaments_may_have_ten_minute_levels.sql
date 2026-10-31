-- @live-proof: strpos(pg_get_functiondef('public.fn_ca_tournament_lock_level_clock()'::regprocedure),'CASE WHEN NEW.is_pinned IS TRUE THEN 10 ELSE 8 END')>0
-- Owner 2026-10-31: eight-minute maximum, highlighted events alone may use ten.
-- Keep faster clocks and already-running events intact; update scheduled rows.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE FUNCTION public.fn_ca_cap_structure_clock(p_structure jsonb,p_minutes integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $cap$
  SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(e)='object'
    AND e->'isBreak' IS DISTINCT FROM 'true'::jsonb
    AND COALESCE(public.fn_ca_blind_contract_number(e->'durationMinutes'),
                 public.fn_ca_blind_contract_number(e->'duration_minutes'),
                 public.fn_ca_blind_contract_number(e->'duration')/60)>p_minutes
    THEN (e-'duration'-'duration_minutes')||jsonb_build_object('durationMinutes',p_minutes)
    ELSE e END ORDER BY ord),'[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_structure)='array' THEN p_structure ELSE '[]'::jsonb END) WITH ORDINALITY x(e,ord);
$cap$;
DO $patch$
DECLARE d text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_lock_level_clock()'::regprocedure) IS DISTINCT FROM '7a8ce88c885a98d8b1683e8794380b0f' THEN
    RAISE EXCEPTION 'HIGHLIGHTED_LEVEL_CLOCK_PREIMAGE_CHANGED';
  END IF;
  d:=pg_get_functiondef('public.fn_ca_tournament_lock_level_clock()'::regprocedure);
  d:=replace(d,$old$     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng') THEN
    RETURN NEW;
  END IF;$old$,$new$     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng') THEN
    -- Short formats keep their own faster ladder, subject to the global ceiling.
    IF TG_OP='UPDATE' AND upper(COALESCE(NEW.status,'')) NOT IN ('REGISTERING','ANNOUNCED','SCHEDULED','PENDING') THEN RETURN NEW; END IF;
    BEGIN authored:=NEW.blind_structure::jsonb;
    EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
    IF jsonb_typeof(authored)='array' THEN
      NEW.blind_structure:=public.fn_ca_cap_structure_clock(authored,CASE WHEN NEW.is_pinned IS TRUE THEN 10 ELSE 8 END)::text;
    END IF;
    RETURN NEW;
  END IF;$new$);
  d:=replace(d,'  locked := public.fn_ca_lock_structure_clock(authored, m);',
    '  -- Only highlighted tournaments may retain the ten-minute clock.
  m := LEAST(m, CASE WHEN NEW.is_pinned IS TRUE THEN 10 ELSE 8 END);
  locked := public.fn_ca_lock_structure_clock(authored, m);');
  EXECUTE d;
END;
$patch$;
SELECT set_config('app.lock_level_clock','on',true);
UPDATE public.tournaments
 SET blind_structure=blind_structure
 WHERE upper(COALESCE(status,'')) IN ('REGISTERING','ANNOUNCED','SCHEDULED','PENDING')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(blind_structure::jsonb) e
     WHERE e->'isBreak' IS DISTINCT FROM 'true'::jsonb
       AND COALESCE(public.fn_ca_blind_contract_number(e->'durationMinutes'),
                    public.fn_ca_blind_contract_number(e->'duration_minutes'),
                    public.fn_ca_blind_contract_number(e->'duration')/60)>CASE WHEN is_pinned IS TRUE THEN 10 ELSE 8 END);
UPDATE public.tournament_schedules s
 SET config=jsonb_set(config,'{blindStructure}',public.fn_ca_cap_structure_clock(config->'blindStructure',
         CASE WHEN config->>'isFeatured'='true' THEN 10 ELSE 8 END)),
     updated_at=now()
 WHERE jsonb_typeof(config->'blindStructure')='array'
   AND config->'blindStructure' IS DISTINCT FROM public.fn_ca_cap_structure_clock(config->'blindStructure',
         CASE WHEN config->>'isFeatured'='true' THEN 10 ELSE 8 END);
COMMIT;
