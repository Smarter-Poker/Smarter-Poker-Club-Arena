-- ═══════════════════════════════════════════════════════════════════════════
-- THE TOURNAMENT LANE GETS A SCOREBOARD AND A LEAK PROFILE (2026-09-05)
--
-- Seat-hands in the week to 2026-09-05: tournament 5,322,596 (66%), cash
-- 2,034,824, hu_cash 634,618. Nothing measured the tournament lane: the
-- self-tuner is cash-only by design, horse_daily_nets records tournament
-- chips as 0.0 bb/100 (chips are not bb-comparable), and no table anywhere
-- held a horse's ROI, ITM or finish. Computed by hand for the audit:
--   SPIN 99,946 entries ROI -8.8% ITM 33.7%; SNG 50,300 ROI -5.0%;
--   MTT 31,450 ROI +12.3% (overlay); SATELLITE 1,876 ROI -31.3%.
-- 61,955 tournament review rows (23,921 tagged) were written that week and
-- read by nobody.
--
-- Three pieces:
--   1. horse_tournament_daily - per horse/day/type/variant: entries,
--      invested (buy-in + fee + rebuys + add-on), won (prize + bounties +
--      mystery), ITM entries, finish percentile sum, best finish. Compiled
--      by fn_horse_tournament_daily_compile(p_day) from tournament_players x
--      tournaments COMPLETED that day; the daily audit calls it for its day.
--   2. fn_horse_tournament_leaks(p_since) - per horse tag counts and
--      reviewed hands over the tournament-format review rows, for the
--      self-tuner to write profiles.horse_profile.leaksTournament, which the
--      brain's ICM premium reads (HorseLogic.tourneyStackoffLoad).
--   3. fn_audit_tournament_results(p_day) - the audit's view: ROI per type
--      over seven days, a warn under -15% on 2,000+ entries, and a critical
--      when tournaments completed and the scoreboard has no rows.
--   Plus ca_horse_tournament_card(p_days) for the horse pages (admin-gated
--   like every ca_horse_* console function).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.horse_tournament_daily (
  horse_user_id    uuid not null,
  day              date not null,
  tournament_type  text not null default 'MTT',
  variant          text not null default 'nlh',
  entries          int not null default 0,
  invested         numeric not null default 0,
  won              numeric not null default 0,
  itm_entries      int not null default 0,
  finish_pct_sum   numeric not null default 0,
  best_finish      int,
  updated_at       timestamptz not null default now(),
  primary key (horse_user_id, day, tournament_type, variant)
);

comment on table public.horse_tournament_daily is
  'Per-horse/day/type/variant tournament results: entries, invested (buy-in + fee + rebuys + add-on), won (prize + bounties + mystery), ITM, finish percentile sum (0 = won, 1 = first out), best finish. Compiled by fn_horse_tournament_daily_compile from tournaments COMPLETED that day. The tournament lane''s scoreboard.';

alter table public.horse_tournament_daily enable row level security;
create index if not exists idx_htd_day on public.horse_tournament_daily (day desc);

create or replace function public.fn_horse_tournament_daily_compile(p_day date)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with rows_ as (
    select tp.user_id as horse_user_id,
           p_day as day,
           coalesce(t.tournament_type, 'MTT') as tournament_type,
           coalesce(nullif(t.variant, ''), 'nlh') as variant,
           count(*) as entries,
           sum(coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
               + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
               + case when tp.add_on then coalesce(t.addon_cost, 0) else 0 end) as invested,
           sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0)) as won,
           count(*) filter (where coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0) > 0) as itm_entries,
           sum(case when tp.position is not null and coalesce(t.current_players, 0) > 1
                    then (tp.position - 1)::numeric / (t.current_players - 1) else 0 end) as finish_pct_sum,
           min(tp.position) as best_finish
      from tournament_players tp
      join tournaments t on t.id = tp.tournament_id
      join profiles p on p.id = tp.user_id and p.is_horse = true
     where t.status = 'COMPLETED'
       and t.ended_at >= p_day and t.ended_at < p_day + 1
       and tp.position is not null
     group by 1, 2, 3, 4
  )
  insert into horse_tournament_daily as h
    (horse_user_id, day, tournament_type, variant, entries, invested, won, itm_entries, finish_pct_sum, best_finish)
  select horse_user_id, day, tournament_type, variant, entries, invested, won, itm_entries, finish_pct_sum, best_finish
    from rows_
  on conflict (horse_user_id, day, tournament_type, variant) do update set
    entries = excluded.entries,
    invested = excluded.invested,
    won = excluded.won,
    itm_entries = excluded.itm_entries,
    finish_pct_sum = excluded.finish_pct_sum,
    best_finish = excluded.best_finish,
    updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.fn_horse_tournament_daily_compile(date) from public, authenticated, anon;
grant execute on function public.fn_horse_tournament_daily_compile(date) to service_role;

-- Per-horse tag counts over the tournament-format review rows. The rollup
-- (horse_review_rollup) has no format column, so the tuner's tournament
-- family comes straight from the reviews, which keep 30 days and are
-- indexed on (horse_user_id, played_at).
create or replace function public.fn_horse_tournament_leaks(p_since date)
returns table (horse_user_id uuid, reviewed bigint, leak_counts jsonb)
language sql stable security definer set search_path = public as $$
  with rv as (
    select r.horse_user_id, r.leak_tags
      from horse_hand_reviews r
     where r.format = 'tournament' and r.played_at >= p_since
  ),
  per as (
    select rv.horse_user_id, count(*) as reviewed from rv group by 1
  ),
  tags as (
    select rv.horse_user_id, u.tag, count(*) as n
      from rv, lateral unnest(rv.leak_tags) as u(tag)
     group by 1, 2
  )
  select per.horse_user_id, per.reviewed,
         coalesce((select jsonb_object_agg(tags.tag, tags.n) from tags where tags.horse_user_id = per.horse_user_id), '{}'::jsonb)
    from per;
$$;

revoke all on function public.fn_horse_tournament_leaks(date) from public, authenticated, anon;
grant execute on function public.fn_horse_tournament_leaks(date) to service_role;

create or replace function public.fn_audit_tournament_results(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_completed int;
  v_rows int;
begin
  select count(*) into v_completed from tournaments
   where status = 'COMPLETED' and ended_at >= p_day and ended_at < p_day + 1;
  select count(*) into v_rows from horse_tournament_daily where day = p_day;
  if v_completed >= 20 and v_rows = 0 then
    v := v || jsonb_build_object('severity','critical','category','schema','code','tournament_results_missing',
      'title', v_completed || ' tournaments completed on ' || p_day || ' and the horse scoreboard has no rows',
      'evidence', jsonb_build_object('completed', v_completed, 'scoreboard_rows', v_rows),
      'recommendation','fn_horse_tournament_daily_compile did not run or found no horse entries. It is called from fn_run_horse_daily_audit; check the audit ran and tournament_players.position is being written at completion.');
    return v;
  end if;
  for r in
    select tournament_type,
           sum(entries) as entries,
           sum(invested) as invested,
           sum(won) as won,
           case when sum(invested) > 0 then round(100 * (sum(won) - sum(invested)) / sum(invested), 1) end as roi_pct,
           case when sum(entries) > 0 then round(100.0 * sum(itm_entries) / sum(entries), 1) end as itm_pct
      from horse_tournament_daily
     where day > p_day - 7 and day <= p_day
     group by 1
  loop
    if r.entries >= 2000 and r.roi_pct is not null and r.roi_pct < -15 then
      v := v || jsonb_build_object('severity','warn','category','gto','code','tournament_roi_negative',
        'title', r.tournament_type || ' ROI ' || r.roi_pct || '% over ' || r.entries || ' entries (7 days)',
        'evidence', jsonb_build_object('tournament_type', r.tournament_type, 'entries', r.entries, 'invested', round(r.invested), 'won', round(r.won), 'roi_pct', r.roi_pct, 'itm_pct', r.itm_pct),
        'recommendation','The fleet plays itself, so a type''s pooled ROI is minus the fee and any overlay; compare against -fee%. A type far below that is a format the brain plays badly: read the tournament-format tags for it (fn_horse_tournament_leaks) before touching the ICM dials.');
    else
      v := v || jsonb_build_object('severity','info','category','gto','code','tournament_results',
        'title', r.tournament_type || ' ROI ' || coalesce(r.roi_pct::text, 'n/a') || '%, ITM ' || coalesce(r.itm_pct::text, 'n/a') || '% over ' || r.entries || ' entries (7 days)',
        'evidence', jsonb_build_object('tournament_type', r.tournament_type, 'entries', r.entries, 'invested', round(r.invested), 'won', round(r.won), 'roi_pct', r.roi_pct, 'itm_pct', r.itm_pct),
        'recommendation','The tournament lane scoreboard. Not a finding; the number Dan asked for.');
    end if;
  end loop;
  return v;
end $$;

revoke all on function public.fn_audit_tournament_results(date) from public, authenticated, anon;
grant execute on function public.fn_audit_tournament_results(date) to service_role;

-- The console card, admin-gated like ca_horse_tag_trends.
create or replace function public.ca_horse_tournament_card(p_days integer default 7)
returns table (tournament_type text, variant text, entries bigint, invested numeric, won numeric, roi_pct numeric, itm_pct numeric, avg_finish_pct numeric, horses bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select h.tournament_type, h.variant,
           sum(h.entries)::bigint,
           round(sum(h.invested), 2),
           round(sum(h.won), 2),
           case when sum(h.invested) > 0 then round(100 * (sum(h.won) - sum(h.invested)) / sum(h.invested), 1) end,
           case when sum(h.entries) > 0 then round(100.0 * sum(h.itm_entries) / sum(h.entries), 1) end,
           case when sum(h.entries) > 0 then round(sum(h.finish_pct_sum) / sum(h.entries), 3) end,
           count(distinct h.horse_user_id)::bigint
      from horse_tournament_daily h
     where h.day >= (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 90)
     group by 1, 2
     order by 3 desc;
end $$;

-- A console card needs an account; the function then gates on
-- fn_is_horse_admin() like the rest of the ca_horse_* family.
revoke all on function public.ca_horse_tournament_card(integer) from public, anon;
grant execute on function public.ca_horse_tournament_card(integer) to authenticated, service_role;

insert into public.ca_browser_definer_allowlist (proname, reason)
values ('ca_horse_tournament_card', 'Horse tournament scoreboard, read from the horse pages. Gates itself on fn_is_horse_admin() like the other ca_horse_* console functions.')
on conflict (proname) do nothing;

-- Retention rides the existing daily prune.
create or replace function public.sp_prune_horse_hand_reviews() returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int; k int; j int;
begin
  delete from horse_hand_reviews where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from horse_daily_nets where day < current_date - 180;
  get diagnostics m = row_count;
  delete from horse_daily_play where day < current_date - 180;
  get diagnostics k = row_count;
  delete from horse_tournament_daily where day < current_date - 180;
  get diagnostics j = row_count;
  return n + m + k + j;
end $$;
revoke all on function public.sp_prune_horse_hand_reviews() from public, authenticated, anon;
grant execute on function public.sp_prune_horse_hand_reviews() to service_role;

-- The audit compiles the day's scoreboard, then reads it. Patched in place
-- from the LIVE definition so a concurrent change to any other step of
-- fn_run_horse_daily_audit is not overwritten by a stale copy.
do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into d;
  if position('fn_audit_tournament_results(p_day)' in d) > 0 then
    return;
  end if;
  d := replace(d,
    'v_findings := v_findings || fn_audit_data_receipts(p_day);',
    'v_findings := v_findings || fn_audit_data_receipts(p_day);' || chr(10) ||
    '  -- 2026-09-05: the tournament lane scoreboard, compiled for the day then judged.' || chr(10) ||
    '  perform fn_horse_tournament_daily_compile(p_day);' || chr(10) ||
    '  v_findings := v_findings || fn_audit_tournament_results(p_day);');
  execute d;
end $patch$;
