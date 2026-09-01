-- ===========================================================================
-- A CONSERVATION BREACH DOES NOT EXPIRE (2026-09-01)
--
-- Applied to production via the Supabase MCP; recorded here in the same
-- change, and idempotent (create table if not exists, create or replace, and
-- a splice that returns early when the hook is present).
--
-- check-chip-conservation.mjs, which gates every engine deploy, asks:
--
--     SELECT sum(unexplained) FROM ca_supply_snapshots
--      WHERE taken_at > now() - interval '4 hours'
--
-- A trailing window forgets. Four hours after a breach the gate goes green on
-- its own, whether or not anybody looked.
--
-- THE EVIDENCE WAS ALREADY IN THE TABLE. On 2026-08-31 seven consecutive
-- snapshots breached and total supply rose from 176,183,282 to 179,473,345 -
-- PLUS 3,290,063 CHIPS - with mint_since_prev recorded as zero on every one:
--
--     15:05   +20,606      18:05  +1,345,385
--     15:43   +79,099      19:05    +577,347
--     16:05  +145,163      20:05    +355,228
--     17:05  +767,234
--
-- Almost entirely member_wallets, with treasuries and agent wallets flat.
-- Chips entered player balances and no issuance was recorded against them.
-- All seven aged out of the window that same evening and the deploy gate has
-- been green over them ever since.
--
-- WHAT THIS DOES NOT DO: it does not change the deploy gate. Making that gate
-- consider all history would block every deploy on the platform right now over
-- rows from 2026-08-31, and that is a production-availability decision for Dan
-- rather than an agent.
--
-- What it does is make the breach impossible to forget: critical in the daily
-- audit until somebody acknowledges it by name and in writing. Nothing is
-- seeded as acknowledged - a fix whose first act is to silence its own
-- evidence is not a fix.
-- ===========================================================================
begin;

create table if not exists public.ca_supply_breach_ack (
  snapshot_id     bigint      primary key
    references public.ca_supply_snapshots (id) on delete cascade,
  acknowledged_by text        not null,
  reason          text        not null,
  acknowledged_at timestamptz not null default now(),
  constraint ca_supply_breach_ack_reason_is_a_sentence
    check (length(btrim(reason)) >= 20)
);

comment on table public.ca_supply_breach_ack is
  'A conservation breach stops being reported only when a person writes down why. The reason has a minimum length on purpose: "ok" is not an explanation, and this row is the audit trail for chips that could not be accounted for.';

alter table public.ca_supply_breach_ack enable row level security;
revoke all on table public.ca_supply_breach_ack from public, anon, authenticated;
grant select, insert on table public.ca_supply_breach_ack to service_role;

create or replace function public.fn_ca_unacknowledged_supply_breaches(
  p_threshold numeric default 5000
)
returns table (
  snapshot_id bigint,
  taken_at    timestamptz,
  unexplained numeric,
  total       numeric,
  age_hours   numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select s.id,
         s.taken_at,
         round(s.unexplained, 2),
         round(s.total, 2),
         round(extract(epoch from (now() - s.taken_at)) / 3600.0, 1)
    from ca_supply_snapshots s
    left join ca_supply_breach_ack a on a.snapshot_id = s.id
   where s.unexplained is not null
     and abs(s.unexplained) > p_threshold
     and a.snapshot_id is null
   order by s.taken_at desc;
$function$;

revoke all on function public.fn_ca_unacknowledged_supply_breaches(numeric) from public, anon, authenticated;
grant execute on function public.fn_ca_unacknowledged_supply_breaches(numeric) to service_role;

create or replace function public.fn_audit_supply_breaches(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_n int; v_sum numeric; v_oldest timestamptz; v_newest timestamptz; v_worst numeric;
begin
  select count(*), coalesce(sum(unexplained), 0), min(taken_at), max(taken_at),
         coalesce(max(abs(unexplained)), 0)
    into v_n, v_sum, v_oldest, v_newest, v_worst
    from fn_ca_unacknowledged_supply_breaches();

  if v_n = 0 then return v_findings; end if;

  v_findings := v_findings || jsonb_build_object(
    'severity', 'critical',
    'category', 'schema',
    'code', 'supply_breach_unacknowledged',
    'title', v_n || ' chip-supply breach(es) have never been explained, netting '
             || round(v_sum, 2) || ' chips',
    'evidence', jsonb_build_object(
      'breaches', v_n,
      'net_unexplained', round(v_sum, 2),
      'largest_single', round(v_worst, 2),
      'oldest', v_oldest,
      'newest', v_newest,
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                        'taken_at', b.taken_at,
                        'unexplained', b.unexplained,
                        'age_hours', b.age_hours) order by b.taken_at desc), '[]'::jsonb)
                 from fn_ca_unacknowledged_supply_breaches() b)
    ),
    'recommendation',
      'The deploy gate only sums a TRAILING FOUR HOURS, so each of these went '
      || 'green on its own within four hours of happening and has been invisible '
      || 'since. This finding does not expire. Either explain each one with an '
      || 'INSERT into ca_supply_breach_ack (snapshot_id, acknowledged_by, reason), '
      || 'which is a deliberate written act and the audit trail for chips that '
      || 'could not be accounted for, or treat it as a live money-integrity '
      || 'incident. If these are the gap already baselined by '
      || 'baseline_the_unledgered_gap on 2026-08-27, say so in the reason - do '
      || 'not assume it, because nothing in the data says it.'
  );
  return v_findings;
end
$function$;

revoke all on function public.fn_audit_supply_breaches(date) from public, anon, authenticated;
grant execute on function public.fn_audit_supply_breaches(date) to service_role;

do $splice$
declare
  v_def text;
  v_anchor constant text := 'v_findings := v_findings || fn_audit_layer_drift(p_day);';
  v_new constant text := 'v_findings := v_findings || fn_audit_layer_drift(p_day);'
    || E'\n  -- 2026-09-01: a conservation breach stays reported until a person'
    || E'\n  -- explains it. The deploy gate forgets after four hours; this does not.'
    || E'\n  v_findings := v_findings || fn_audit_supply_breaches(p_day);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
  if position('fn_audit_supply_breaches(p_day)' in v_def) > 0 then
    raise notice 'supply-breach hook already present'; return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'expected exactly one layer-drift hook to anchor on, found %',
      (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  end if;
  execute replace(v_def, v_anchor, v_new);
end
$splice$;

revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;

do $assert$
declare v_def text; v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
  if position('fn_audit_supply_breaches(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the audit does not call the supply-breach check';
  end if;
  if position('fn_audit_layer_drift(p_day)' in v_def) = 0
     or position('fn_audit_river_aggression_ev(p_day)' in v_def) = 0
     or position('fn_audit_nightly_job_health(p_day)' in v_def) = 0
     or position('fn_audit_fleet_health(p_day)' in v_def) = 0
     or position('fn_audit_layer_silence_and_coverage(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: a hook was lost by the splice';
  end if;
  select jsonb_array_length(fn_audit_supply_breaches(current_date)) into v_n;
  if v_n <> 1 then
    raise exception 'POST-APPLY: expected exactly one breach finding, got %', v_n;
  end if;
end
$assert$;

commit;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- begin;
--   do $rb$
--   declare
--     v_def text;
--     v_hook constant text :=
--       E'\n  -- 2026-09-01: a conservation breach stays reported until a person'
--       || E'\n  -- explains it. The deploy gate forgets after four hours; this does not.'
--       || E'\n  v_findings := v_findings || fn_audit_supply_breaches(p_day);';
--   begin
--     select pg_get_functiondef(p.oid) into v_def
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';
--     if position(v_hook in v_def) = 0 then
--       raise exception 'ROLLBACK: hook not found in its expected form - undo by hand';
--     end if;
--     execute replace(v_def, v_hook, '');
--   end
--   $rb$;
--   revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
--   grant execute on function public.fn_run_horse_daily_audit(date) to service_role;
--   drop function if exists public.fn_audit_supply_breaches(date);
--   drop function if exists public.fn_ca_unacknowledged_supply_breaches(numeric);
--   -- The ack table is an audit trail. Dropping it destroys the record of who
--   -- explained what, so it is left in place deliberately.
-- commit;
