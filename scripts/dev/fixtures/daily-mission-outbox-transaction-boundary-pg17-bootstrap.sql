\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text NOT NULL UNIQUE,
  schedule text NOT NULL,
  command text NOT NULL,
  username text NOT NULL DEFAULT current_user,
  database text NOT NULL DEFAULT current_database(),
  active boolean NOT NULL DEFAULT true
);

CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint
LANGUAGE plpgsql
AS $function$
DECLARE
  v_jobid bigint;
BEGIN
  INSERT INTO cron.job(jobname, schedule, command)
  VALUES (p_jobname, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE
    SET schedule = EXCLUDED.schedule,
        command = EXCLUDED.command,
        username = current_user,
        database = current_database(),
        active = true
  RETURNING jobid INTO v_jobid;
  RETURN v_jobid;
END;
$function$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY
);

CREATE TABLE public.daily_challenge_event_outbox (
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  event_key text NOT NULL,
  amounts jsonb NOT NULL DEFAULT '{}'::jsonb,
  magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dead_lettered_at timestamptz,
  last_error text,
  PRIMARY KEY (user_id, event_key)
);

CREATE INDEX idx_daily_challenge_event_outbox_shard_due
  ON public.daily_challenge_event_outbox (
    ((hashtext(user_id::text) & 2147483647) % 4),
    user_id,
    created_at
  )
  WHERE dead_lettered_at IS NULL;

CREATE TABLE public.daily_challenge_progress_events (
  user_id uuid NOT NULL,
  event_key text NOT NULL,
  booked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, event_key)
);

-- This foreign key reproduces the production hand-settlement check that was
-- queued behind profiles FOR UPDATE locks held by the old shard transaction.
CREATE TABLE public.table_seats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  stack numeric NOT NULL DEFAULT 100
);

CREATE SEQUENCE public.probe_slow_user_started
  MINVALUE 0 START WITH 0;

CREATE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$;

-- The lower UUID books immediately.  The higher UUID advertises its start
-- through a non-transactional sequence and then stays in-flight long enough
-- for a second session to test both unrelated- and same-player FK locking.
CREATE FUNCTION public.enqueue_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_values jsonb,
  p_occurred_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_lock_daily_mission_user(p_user_id);

  IF p_event_key = 'probe:rollback-second' THEN
    RAISE lock_not_available USING MESSAGE = 'forced second-event lock conflict';
  END IF;

  INSERT INTO public.daily_challenge_progress_events(user_id, event_key)
  VALUES (p_user_id, p_event_key)
  ON CONFLICT (user_id, event_key) DO NOTHING;

  IF p_user_id = '22222222-0000-4000-8000-000000000002'::uuid THEN
    PERFORM nextval('public.probe_slow_user_started');
    PERFORM pg_sleep(3);
  END IF;

  DELETE FROM public.daily_challenge_event_outbox
   WHERE user_id = p_user_id
     AND event_key = p_event_key;
  RETURN true;
END;
$function$;

INSERT INTO public.profiles(id) VALUES
  ('11111111-0000-4000-8000-000000000001'),
  ('22222222-0000-4000-8000-000000000002'),
  ('33333333-0000-4000-8000-000000000003');

INSERT INTO public.daily_challenge_event_outbox(
  user_id, event_key, amounts, magnitudes, threshold_values, occurred_at
) VALUES
  (
    '11111111-0000-4000-8000-000000000001',
    'probe:first-player',
    '{"hands_played":1}', '{}', '{}', clock_timestamp()
  ),
  (
    '22222222-0000-4000-8000-000000000002',
    'probe:slow-second-player',
    '{"hands_played":1}', '{}', '{}', clock_timestamp()
  );
