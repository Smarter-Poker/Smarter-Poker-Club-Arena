-- 2026-09-27 (daily-analysis agent). The engine runs fn_run_horse_daily_audit as
-- service_role (statement_timeout 8s) around 06:00 UTC against a cold cache. On
-- 2026-09-26 it claimed the day and wrote nothing. The big-pot probe that caused
-- that is now indexed (idx_hand_history_big_pot_probe), but the cold-cache margin
-- under 8s is thin. This fallback runs later, as postgres (2min), and generates
-- the day ONLY if the engine did not. When it rescues a day it says so with a
-- critical finding, so a rescued day never looks like a healthy one.

create or replace function public.fn_horse_daily_audit_fallback()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $f$
declare
  d date := (now() at time zone 'utc')::date - 1;
  claim record;
begin
  if exists (select 1 from horse_daily_audit where day = d) then
    return jsonb_build_object('day', d, 'status', 'engine_row_present');
  end if;

  select j.claimed_at, j.claimed_by into claim
    from horse_job_runs j where j.job = 'daily_audit' and j.run_date = d;

  perform fn_run_horse_daily_audit(d);

  update horse_daily_audit
     set findings = coalesce(findings, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
       'severity','critical','category','schema','code','daily_audit_rescued_by_fallback',
       'title','The engine did not produce the ' || d || ' audit; the 07:30Z database fallback generated it',
       'evidence', jsonb_build_object(
         'day', d,
         'engine_claimed', claim.claimed_at is not null,
         'engine_claimed_at', claim.claimed_at,
         'engine_claimed_by', claim.claimed_by,
         'rescued_at', now()),
       'recommendation', case when claim.claimed_at is null
         then 'The engine never claimed daily_audit for this day - its nightly scheduler did not run it. Check the engine is up and its HorseDailyAudit schedule.'
         else 'The engine claimed the day and failed. It calls this function as service_role (8s statement_timeout) on a cold cache; time each step cold and find what outgrew 8s. docker logs club-arena-engine --since 24h | grep -i HorseDailyAudit.'
       end))
   where day = d;

  return jsonb_build_object('day', d, 'status', 'rescued', 'engine_claimed', claim.claimed_at is not null);
end
$f$;

revoke all on function public.fn_horse_daily_audit_fallback() from public, anon, authenticated;

select cron.schedule(
  'horse-daily-audit-fallback',
  '30 7 * * *',
  $$select public.fn_horse_daily_audit_fallback()$$
);