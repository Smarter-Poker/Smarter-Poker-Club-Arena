-- @live-proof: strpos(pg_get_functiondef('public.fn_ca_tournament_level_clock_floor()'::regprocedure), 'v_schedule_config') > 0 AND (SELECT count(*) = 9 FROM public.tournament_schedules WHERE created_at >= '2026-10-27 00:00 America/Chicago'::timestamptz AND created_at < '2026-10-29 00:00 America/Chicago'::timestamptz AND config->>'lateRegistrationMode' = 'levels' AND config->>'lateRegistrationLevels' = '10' AND config->>'lateRegistrationMinutes' = '0')
-- Owner October 28: newly authored freezeouts/MTTs admit through displayed level
-- 10 and close at 11. current_level is a zero-based index. Admission already
-- uses current_level < late_reg_levels; do not change that shared predicate.
-- Scheduled creation derives an extra wall-clock deadline and satellite creation
-- clamps its cap. The final clock trigger then recreates minutes on INSERT.
-- Preserve an explicit schedule levels-only contract at that existing authority,
-- after clock normalization. No new trigger, engine activation, chips, entries,
-- settled records, blind structure, rebuy or add-on terms are changed.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $patch$
DECLARE
 v_definition text;
 v_before text := E' RETURN NEW;\nEND';
 v_after text := $replacement$
 -- An explicit authored schedule may choose a level window without a second
 -- wall-clock deadline. Preserve it after all existing clock normalization.
 IF NEW.schedule_id IS NOT NULL
    AND upper(coalesce(NEW.status,'')) IN ('ANNOUNCED','REGISTERING','SCHEDULED','PENDING')
    AND upper(coalesce(NEW.tournament_type,'')) IN ('MTT','SATELLITE')
    AND lower(coalesce(NEW.variant,'')) NOT IN ('spin','sng')
    AND NOT coalesce(NEW.prize_pool_finalized,false) THEN
   SELECT s.config INTO v_schedule_config
   FROM public.tournament_schedules s WHERE s.id=NEW.schedule_id;
   IF v_schedule_config->>'lateRegistrationMode' = 'levels' THEN
     IF coalesce(v_schedule_config->>'lateRegistrationLevels','') !~ '^[0-9]{1,3}$'
        OR (v_schedule_config->>'lateRegistrationLevels')::integer NOT BETWEEN 1 AND 100 THEN
       RAISE EXCEPTION 'A levels-only schedule requires 1 through 100 registration levels';
     END IF;
     NEW.late_reg_levels := (v_schedule_config->>'lateRegistrationLevels')::integer;
     NEW.late_reg_mins := 0;
   END IF;
 END IF;
 RETURN NEW;
END$replacement$;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_tournament_level_clock_floor()'::regprocedure)
 INTO v_definition;
 IF strpos(v_definition,'v_schedule_config')>0
    OR length(v_definition)-length(replace(v_definition,v_before,''))<>length(v_before)
    OR strpos(v_definition,'DECLARE v_floor numeric;')=0 THEN
   RAISE EXCEPTION 'Unexpected level-clock function definition; refusing a blind patch';
 END IF;
 v_definition := replace(v_definition,'DECLARE v_floor numeric;',
   'DECLARE v_schedule_config jsonb; v_floor numeric;');
 EXECUTE replace(v_definition,v_before,v_after);
END $patch$;

-- Explicitly scope the contract to the nine definitions authored Oct 27/28.
UPDATE public.tournament_schedules
SET config = config || '{"lateRegistrationMode":"levels","lateRegistrationLevels":10,"lateRegistrationMinutes":0}'::jsonb,
    updated_at=now()
WHERE id = ANY (ARRAY[
 'a70c1028-1200-4000-9000-000000000001',
 'a70c1028-1600-4000-9000-000000000001',
 'a70c1028-1800-2500-9000-000000000001',
 'a70c1028-2000-4000-9000-000000000001',
 'a909956a-305b-4d15-8d14-34763473bddb',
 '1a6d6cf3-f549-4833-9f2b-840841c68e56',
 'd84a104f-2e43-4514-8f5f-142566033956',
 'c8e79691-bbfd-4c21-a226-c82e6bc3fe39',
 'cd46f09e-e168-4094-abaa-4889635e2a38'
]::uuid[]);
COMMIT;
