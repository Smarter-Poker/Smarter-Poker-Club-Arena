-- ===========================================================================
-- THE PGRST WATCHDOG LEARNS TO BARK (2026-08-31)
--
-- At 19:21 UTC today PostgREST began answering every request with
-- 503 PGRST002 "Could not query the database for the schema cache". The engine
-- talks to Supabase through PostgREST, so dealing stopped:
--
--   19:19   277 hands
--   19:20   246 hands
--   19:21   169 hands
--   19:22     0 hands          <- the outage
--   19:23   171 hands          <- after NOTIFY pgrst, 'reload schema'
--
-- One notify, sent by hand, and the next probe returned 200. That is the whole
-- recovery, and nothing in the estate was able to send it.
--
-- fn_pgrst_reload_watchdog already runs every fifteen minutes. It COUNTS
-- reload-triggering DDL events and raises warnings when the rate is high. It
-- has never sent a reload. A watchdog that can see the problem and cannot act
-- on it is a report, not a watchdog.
--
-- ---------------------------------------------------------------------------
-- WHY THE STORM HAPPENS
--
-- Measured in the hour around the outage, from ca_ddl_events:
--
--   mgmt-api  ALTER TABLE      153 events   all reload-triggering
--   mgmt-api  CREATE FUNCTION   28 events   all reload-triggering
--
-- 181 reload-triggering events in an hour, against this estate's own warn
-- threshold of 20 and breach threshold of 60. Every one makes PostgREST
-- re-introspect a schema of 974 tables and 2,490 functions. Enough of them at
-- once and an introspection does not finish, and the cache stays broken until
-- something asks for a reload.
--
-- (The 772 CREATE TABLE / CREATE INDEX events per hour from PostgREST itself
-- are temp-table churn inside RPCs. They do not trigger reloads and are not the
-- cause.)
--
-- ---------------------------------------------------------------------------
-- WHY A CONDITIONAL RELOAD IS SAFE, AND AN UNCONDITIONAL ONE IS NOT
--
-- A reload is idempotent and cheap relative to what DDL already costs - it is
-- exactly what PostgREST does of its own accord on every DDL event. So sending
-- one is harmless when the cache is healthy and curative when it is wedged.
--
-- What would NOT be safe is reloading on a timer regardless: that adds
-- introspections to a system whose failure mode is too many introspections.
--
-- So this fires only when BOTH hold:
--   * reload-triggering DDL happened in the last 15 minutes - the only window
--     in which the cache can be stale or wedged at all; and
--   * this function has not sent one in the last 5 minutes - so it can never
--     become the storm it exists to clear.
--
-- Worst case after a wedge is therefore five minutes of outage instead of
-- however long it takes a human to notice. Today that was two minutes only
-- because somebody happened to be looking.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if to_regclass('public.ca_ddl_events') is null then
    raise exception 'PRE-FLIGHT: public.ca_ddl_events is missing - the DDL signal this depends on does not exist';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='ca_ddl_events'
                    and column_name='triggers_pgrst_reload') then
    raise exception 'PRE-FLIGHT: ca_ddl_events.triggers_pgrst_reload is missing';
  end if;
end $$;

-- THE LOG (tiny, and the cooldown lives in it)
create table if not exists public.ca_pgrst_reload_log (
  id           bigint generated always as identity primary key,
  sent_at      timestamptz not null default now(),
  ddl_events   integer     not null,
  reason       text        not null
);

comment on table public.ca_pgrst_reload_log is
  'Every recovery reload fn_ca_pgrst_reload_if_stale has sent. Doubles as the cooldown: the newest row is the last time one went out.';

create index if not exists ca_pgrst_reload_log_sent_idx
  on public.ca_pgrst_reload_log (sent_at desc);

alter table public.ca_pgrst_reload_log enable row level security;

-- THE CHANGE
create or replace function public.fn_ca_pgrst_reload_if_stale(
  p_ddl_window  interval default interval '15 minutes',
  p_cooldown    interval default interval '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_ddl      integer;
  v_last     timestamptz;
BEGIN
  SELECT count(*) INTO v_ddl
    FROM public.ca_ddl_events
   WHERE occurred_at > now() - p_ddl_window
     AND triggers_pgrst_reload;

  IF v_ddl = 0 THEN
    -- No DDL, so the cache cannot have gone stale. Reloading here would be the
    -- unconditional timer this deliberately is not.
    RETURN jsonb_build_object('sent', false, 'reason', 'no reload-triggering ddl in window', 'ddl_events', 0);
  END IF;

  SELECT max(sent_at) INTO v_last FROM public.ca_pgrst_reload_log;

  IF v_last IS NOT NULL AND v_last > now() - p_cooldown THEN
    RETURN jsonb_build_object('sent', false, 'reason', 'cooldown', 'ddl_events', v_ddl,
                              'last_sent_at', v_last);
  END IF;

  NOTIFY pgrst, 'reload schema';

  INSERT INTO public.ca_pgrst_reload_log (ddl_events, reason)
  VALUES (v_ddl, format('%s reload-triggering ddl event(s) in %s', v_ddl, p_ddl_window));

  RETURN jsonb_build_object('sent', true, 'ddl_events', v_ddl);
END;
$function$;

revoke all on function public.fn_ca_pgrst_reload_if_stale(interval, interval) from public, anon, authenticated;

-- WIRE IT
select cron.unschedule('ca-pgrst-reload-if-stale')
 where exists (select 1 from cron.job where jobname = 'ca-pgrst-reload-if-stale');

select cron.schedule(
  'ca-pgrst-reload-if-stale',
  '*/5 * * * *',
  $cron$select public.fn_ca_pgrst_reload_if_stale();$cron$
);

-- POST-APPLY: BOTH HALVES
do $$
declare
  v1 jsonb; v2 jsonb; v_rows_before bigint; v_rows_after bigint;
begin
  select count(*) into v_rows_before from public.ca_pgrst_reload_log;

  -- HALF ONE: it fires. There has certainly been reload-triggering DDL in the
  -- last fifteen minutes, because this migration is some.
  v1 := public.fn_ca_pgrst_reload_if_stale();
  if (v1->>'sent')::boolean is not true then
    raise exception 'POST-APPLY: the first call did not send a reload: %', v1;
  end if;

  select count(*) into v_rows_after from public.ca_pgrst_reload_log;
  if v_rows_after <> v_rows_before + 1 then
    raise exception 'POST-APPLY: the send was not logged (% -> %)', v_rows_before, v_rows_after;
  end if;

  -- ...and the cooldown holds, so it can never become the storm it clears.
  v2 := public.fn_ca_pgrst_reload_if_stale();
  if (v2->>'sent')::boolean is not false or v2->>'reason' <> 'cooldown' then
    raise exception 'POST-APPLY: the cooldown did not hold on the second call: %', v2;
  end if;

  -- ...and with no DDL in the window it declines rather than reloading blindly.
  if (public.fn_ca_pgrst_reload_if_stale(interval '0 seconds', interval '0 seconds')->>'reason')
     <> 'no reload-triggering ddl in window' then
    raise exception 'POST-APPLY: an empty DDL window did not decline';
  end if;

  -- HALF TWO: the promises not to break anything.
  if has_function_privilege('anon', 'public.fn_ca_pgrst_reload_if_stale(interval, interval)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_ca_pgrst_reload_if_stale(interval, interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: a browser role can execute the reload';
  end if;

  if not exists (select 1 from cron.job where jobname = 'ca-pgrst-reload-if-stale' and active) then
    raise exception 'POST-APPLY: the cron job is missing or inactive';
  end if;

  -- The existing watchdog is untouched and still scheduled.
  if not exists (select 1 from cron.job where jobname = 'pgrst-reload-watchdog' and active) then
    raise exception 'POST-APPLY: the existing pgrst-reload-watchdog is no longer scheduled';
  end if;

  raise notice 'POST-APPLY: recovery reload sent once, cooldown held, empty window declined, cron scheduled';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - returns recovery to "somebody happens to be looking":
--
--   SELECT cron.unschedule('ca-pgrst-reload-if-stale');
--   DROP FUNCTION IF EXISTS public.fn_ca_pgrst_reload_if_stale(interval, interval);
--   DROP TABLE IF EXISTS public.ca_pgrst_reload_log;
-- ===========================================================================
