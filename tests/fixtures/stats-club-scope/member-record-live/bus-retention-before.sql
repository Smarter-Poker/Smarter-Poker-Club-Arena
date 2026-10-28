CREATE TABLE public.bus_event_log(id uuid PRIMARY KEY, created_at timestamptz, payload jsonb);
INSERT INTO public.bus_event_log VALUES
 ('11111111-0000-0000-0000-000000000001', now()-interval '9 days', '{"old":true}'),
 ('11111111-0000-0000-0000-000000000002', now()-interval '8 days', '{"old":true}'),
 ('11111111-0000-0000-0000-000000000003', now()-interval '6 days', '{"keep":true}'),
 ('11111111-0000-0000-0000-000000000004', NULL, '{"unknown_age":true}');
-- Only the scheduler API is modeled; the retention DELETE below uses real PG.
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY,jobname text UNIQUE,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT(jobname) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command
 RETURNING jobid
$$;
