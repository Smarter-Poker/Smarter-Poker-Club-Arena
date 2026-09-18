-- One-time registry completion for the already installed R46 preparation.
-- Does not replay schema preparation, alter a trigger, or activate admission.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='5s';
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','zzzzzzz_tournaments_record_format','Records immutable proven tournament format; no financial mutation or capacity activation.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','a2_tournaments_new_satellite_target','Serializes new satellite target validation under the admission contract; preserves booked event economics.'),
 ('tournaments','a1_tournaments_restart_source','Binds a new restart to its immediate proven source and target; no historical event conversion.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
