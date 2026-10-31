-- Owner 2026-10-31: eight-minute maximum, highlighted events alone may use ten.
-- Keep faster clocks and already-running events intact; update scheduled rows.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $patch$
DECLARE d text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_lock_level_clock()'::regprocedure) IS DISTINCT FROM '7a8ce88c885a98d8b1683e8794380b0f' THEN
    RAISE EXCEPTION 'HIGHLIGHTED_LEVEL_CLOCK_PREIMAGE_CHANGED';
  END IF;
  d:=pg_get_functiondef('public.fn_ca_tournament_lock_level_clock()'::regprocedure);
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
   AND upper(COALESCE(tournament_type,'')) IN ('MTT','SATELLITE')
   AND lower(COALESCE(variant,'')) NOT IN ('spin','sng')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(blind_structure::jsonb) e
     WHERE e->'isBreak' IS DISTINCT FROM 'true'::jsonb
       AND COALESCE(public.fn_ca_blind_contract_number(e->'durationMinutes'),
                    public.fn_ca_blind_contract_number(e->'duration_minutes'),
                    public.fn_ca_blind_contract_number(e->'duration')/60)>CASE WHEN is_pinned IS TRUE THEN 10 ELSE 8 END);
UPDATE public.tournament_schedules s
 SET config=jsonb_set(config,'{blindStructure}',public.fn_ca_lock_structure_clock(config->'blindStructure',
       LEAST(public.fn_ca_locked_level_minutes(COALESCE(config->>'name',s.name),
         CASE WHEN config ? 'buyIn' THEN public.fn_ca_blind_contract_number(config->'buyIn') END,
         COALESCE(public.fn_ca_blind_contract_number(config->'bountyAmount'),0)>0
           OR lower(COALESCE(config->>'type','')) IN ('bounty','progressive_bounty','mystery_bounty'),
         lower(COALESCE(config->>'type',''))='satellite',config->'blindStructure'),
         CASE WHEN config->>'isFeatured'='true' THEN 10 ELSE 8 END))),
     updated_at=now()
 WHERE jsonb_typeof(config->'blindStructure')='array'
   AND lower(COALESCE(config->>'type','mtt')) NOT IN ('spin','sng')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(config->'blindStructure') e
     WHERE e->'isBreak' IS DISTINCT FROM 'true'::jsonb
       AND COALESCE(public.fn_ca_blind_contract_number(e->'durationMinutes'),
                    public.fn_ca_blind_contract_number(e->'duration_minutes'),
                    public.fn_ca_blind_contract_number(e->'duration')/60)>
             CASE WHEN config->>'isFeatured'='true' THEN 10 ELSE 8 END);
COMMIT;
