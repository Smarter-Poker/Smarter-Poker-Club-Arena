CREATE TABLE public.fixture_migration_readiness(frozen boolean);INSERT INTO public.fixture_migration_readiness VALUES(false);
CREATE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM public.fixture_migration_readiness$$;
CREATE FUNCTION public.fixture_original_break_window_refusal(p_at timestamp with time zone) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  -- Pinned by tests/the-break-clocks-agree.law.test.ts: the window has to
  -- enclose the :53 announcement and the :00 thaw with margin.
  c_window_opens_minute  CONSTANT integer := 50;
  c_window_closes_minute CONSTANT integer := 3;
  v_minute integer;
BEGIN
  IF p_at IS NULL THEN
    RETURN NULL;
  END IF;

  v_minute := extract(minute FROM (p_at AT TIME ZONE 'UTC'))::integer;

  IF v_minute >= c_window_opens_minute OR v_minute < c_window_closes_minute THEN
    RETURN to_char(p_at AT TIME ZONE 'UTC', 'HH24:MI:SS')
        || ' UTC is inside the hourly maintenance break window (:'
        || lpad(c_window_opens_minute::text, 2, '0') || '-:'
        || lpad(c_window_closes_minute::text, 2, '0') || ' UTC); apply after :'
        || lpad(c_window_closes_minute::text, 2, '0')
        || ', or for an emergency fix SET LOCAL ca.break_window_migration_override'
        || ' = ''<reason>'' in the same transaction';
  END IF;

  -- engine-recovery-window-v1: absolute durable announcement through thaw.
  IF public.fn_entry_purchases_frozen() THEN
    RETURN 'an announced engine maintenance window or its thaw is active; apply after its durable release';
  END IF;

  RETURN NULL;
END;
$$;
CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql AS $$SELECT public.fixture_original_break_window_refusal(date_trunc('hour',$1)+interval '20 minutes')$$;
