-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:23:38 UTC on kuklfnapbkmacvwxktbh.

-- SIGNAL-NOT-NOISE part 2: an INFO incident is a dashboard metric by
-- definition — its RAISE must not push either (the round-2 policy silenced
-- info escalations but the initial 🚨 still went out; verified by sim:
-- info raise produced 3 pushes). Criticals and warnings keep their single
-- raise push (storm-capped as before).
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef((SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE n.nspname='public' AND p.proname='fn_ca_raise_drift_incident')::regprocedure);
  v_new := replace(v_def,
'  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval ''2 minutes'') >= 10 THEN',
'  IF p_severity = ''info'' THEN
    -- dashboard-only by definition: record, never page
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval ''2 minutes'') >= 10 THEN');
  IF v_new = v_def THEN RAISE EXCEPTION 'raise anchor not found'; END IF;
  EXECUTE v_new;
END $$;;
