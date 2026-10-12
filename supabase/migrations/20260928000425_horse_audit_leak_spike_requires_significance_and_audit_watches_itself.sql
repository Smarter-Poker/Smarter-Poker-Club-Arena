-- 2026-09-27 (daily-analysis agent). Three audit defects found in the 2026-09-26 review.
--
-- 1. leak_tag_spike treated ANY negative mirrored EV as a confirmed leak. On 2026-09-26
--    preflop_stackoff was warned at -0.73 bb/hand over 2,189 hands: z = -0.36, noise.
--    fn_horse_tag_ev_significance estimates each mirrored situation's per-hand SD from
--    its won and lost halves (a lower bound: it ignores within-side spread), so the gate
--    below is |z| >= 3, not 2, to compensate. Only significant losers stay warn/critical;
--    the rest become info 'leak_tag_spike_unresolved'.
-- 2. The audit could not see its own failure. daily_audit claimed 2026-09-26 and wrote no
--    row; nothing reported it. Each run now checks the previous two days.
-- 3. tuner_no_rows pointed readers at horse_error_log, which has never held a row.

create or replace function public.fn_horse_tag_ev_significance(p_since date)
returns table(situation text, hands bigint, bb_per_hand numeric, sd_est numeric, z numeric)
language sql stable security definer set search_path to 'public' as $f$
  with flat as (
    select k as tag, (r.leak_counts->>k)::bigint as cnt,
           coalesce((r.leak_net_bb->>k)::numeric, 0) as net
      from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
     where r.day >= p_since),
  agg as (select tag, sum(cnt)::numeric cnt, sum(net)::numeric net from flat group by tag),
  p as (select case when tag like '%\_won'  then left(tag, length(tag) - 4)
                    when tag like '%\_lost' then left(tag, length(tag) - 5)
                    else tag end as situation,
               tag like '%\_won' as is_won, cnt, net from agg),
  s as (select situation,
               sum(cnt) filter (where is_won)     as wn, sum(net) filter (where is_won)     as wnet,
               sum(cnt) filter (where not is_won) as ln, sum(net) filter (where not is_won) as lnet
          from p group by situation),
  m as (select situation, (wn + ln) as n, (wnet + lnet) / (wn + ln) as mu,
               sqrt(greatest((wn * power(wnet / wn, 2) + ln * power(lnet / ln, 2)) / (wn + ln)
                             - power((wnet + lnet) / (wn + ln), 2), 0::numeric)) as sd
          from s where wn > 0 and ln > 0 and wn + ln >= 100)
  select situation, n::bigint, round(mu, 2), round(sd, 1),
         round(mu / nullif(sd / sqrt(n), 0), 2)
    from m;
$f$;

do $mig$
declare
  d text := pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure);
  a1 text := E'          v_ev_win   numeric;\n';
  a2 text := E'           where e.situation = v_situation and e.mirrored\n           limit 1;\n';
  a3 text := E'          else\n            v_findings := v_findings || jsonb_build_object(\n              ''severity'', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5';
  a4 text := E'  v_findings := v_findings || fn_audit_nightly_job_health(p_day);\n';
begin
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 or position(a4 in d) = 0 then
    raise exception 'fn_run_horse_daily_audit changed since review - anchor missing, refusing to patch';
  end if;
  if position('fn_horse_tag_ev_significance' in d) > 0 then
    raise notice 'already patched'; return;
  end if;

  d := replace(d, a1, a1 || E'          v_ev_z     numeric;\n          v_ev_sd    numeric;\n');
  d := replace(d, a2, a2 || E'          select s.z, s.sd_est into v_ev_z, v_ev_sd\n            from fn_horse_tag_ev_significance(p_day - 6) s\n           where s.situation = v_situation\n           limit 1;\n');
  d := replace(d, a3,
E'          elsif v_ev_bb is not null and v_ev_z is not null and v_ev_z > -3 then
            -- NEGATIVE IS NOT THE SAME AS LOSING (2026-09-27). See migration header.
            v_findings := v_findings || jsonb_build_object(
              ''severity'',''info'',''category'',''gto'',''code'',''leak_tag_spike_unresolved'',
              ''title'',''Leak tag '' || r.tag || '' rose, but its mirrored EV ('' || v_ev_bb || ''bb/hand, z '' || v_ev_z || '') is indistinguishable from zero'',
              ''evidence'', jsonb_build_object(
                ''tag'', r.tag, ''situation'', v_situation, ''count'', r.cnt,
                ''rate_per_1k'', round(r.day_rate, 2), ''baseline_rate_per_1k'', round(r.base_rate, 2),
                ''mirrored_bb_per_hand'', v_ev_bb, ''mirrored_hands'', v_ev_hands,
                ''mirrored_sd_est'', v_ev_sd, ''mirrored_z'', v_ev_z, ''z_gate'', -3),
              ''recommendation'',''The spot is arising more often, but seven days of both outcomes cannot tell it from breakeven. Do not tune on it and do not open a matchup for it. It becomes a warning the day its z falls to -3 or below.'');
' || a3);
  d := replace(d, a4, a4 ||
E'  -- 2026-09-27: the audit reports its own missing days. daily_audit claimed
  -- 2026-09-26 and wrote nothing, and no instrument said so.
  for r in
    select j.run_date, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.job = ''daily_audit''
       and j.run_date between p_day - 2 and p_day - 1
       and not exists (select 1 from horse_daily_audit x where x.day = j.run_date)
  loop
    v_findings := v_findings || jsonb_build_object(
      ''severity'',''critical'',''category'',''schema'',''code'',''daily_audit_lost'',
      ''title'',''daily_audit claimed '' || r.run_date || '' and never wrote its row'',
      ''evidence'', jsonb_build_object(''run_date'', r.run_date, ''claimed_at'', r.claimed_at, ''claimed_by'', r.claimed_by),
      ''recommendation'',''The engine calls this function as service_role, whose statement_timeout is 8s. Run select fn_run_horse_daily_audit('''''' || r.run_date || ''''''::date) from a session with a longer timeout to recover the day, then find the step that outgrew 8s.'');
  end loop;
');
  execute d;
end
$mig$;

do $mig2$
declare
  d text := pg_get_functiondef('public.fn_audit_tuner_health(date)'::regprocedure);
  old text := 'check horse_error_log context HorseSelfTuner.';
begin
  if position(old in d) = 0 then
    raise notice 'tuner_health text already changed - skipping'; return;
  end if;
  d := replace(d, old,
    'horse_error_log has never held a row, so do not look there. Read the engine: docker logs club-arena-engine | grep -i HorseSelfTuner. On 2026-09-26 and 2026-09-27 the tuner read profiles, horse_daily_nets, horse_review_rollup and horse_daily_play (all HTTP 200) and then never called fn_prepare_horse_tuner_study, so it died in-process between reading and preparing.');
  execute d;
end
$mig2$;