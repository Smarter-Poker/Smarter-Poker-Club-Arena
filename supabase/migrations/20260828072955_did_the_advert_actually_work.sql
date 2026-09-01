-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828072955; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_ad_conversions(p_window_hours integer default 24)
returns table(
  ad_id uuid,
  ad_key text,
  slot text,
  clicks bigint,
  clicks_followed_by bigint,
  conversion_rule text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  WITH w AS (
    SELECT make_interval(hours => GREATEST(1, LEAST(COALESCE(p_window_hours, 24), 720))) AS span
  ),
  clicks AS (
    SELECT e.id, e.ad_id, e.slot, e.user_id, e.created_at, c.ad_key
      FROM public.ad_event e
      JOIN public.ad_catalog c ON c.id = e.ad_id
     WHERE e.event_type = 'click'
       AND e.user_id IS NOT NULL
  ),
  followed AS (
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'vip_upsell'
       AND EXISTS (SELECT 1 FROM public.vip_subscriptions v
                    WHERE v.user_id = k.user_id
                      AND v.created_at >= k.created_at
                      AND v.created_at <  k.created_at + w.span)
    UNION
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'diamonds_store'
       AND EXISTS (SELECT 1 FROM public.diamond_purchases d
                    WHERE d.user_id = k.user_id
                      AND d.completed_at IS NOT NULL
                      AND d.completed_at >= k.created_at
                      AND d.completed_at <  k.created_at + w.span)
    UNION
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'referral_invite'
       AND EXISTS (SELECT 1 FROM public.referrals r
                    WHERE r.referrer_id = k.user_id
                      AND r.created_at >= k.created_at
                      AND r.created_at <  k.created_at + w.span)
    UNION
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'tournaments_daily'
       AND EXISTS (SELECT 1 FROM public.tournament_registrations tr
                    JOIN public.tournaments t ON t.id = tr.tournament_id
                   WHERE tr.user_id = k.user_id
                     AND t.tournament_type = 'MTT'
                     AND tr.registered_at >= k.created_at
                     AND tr.registered_at <  k.created_at + w.span)
    UNION
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'spins_jackpot'
       AND EXISTS (SELECT 1 FROM public.tournament_registrations tr
                    JOIN public.tournaments t ON t.id = tr.tournament_id
                   WHERE tr.user_id = k.user_id
                     AND t.tournament_type = 'SPIN'
                     AND tr.registered_at >= k.created_at
                     AND tr.registered_at <  k.created_at + w.span)
  )
  SELECT k.ad_id,
         k.ad_key,
         k.slot,
         count(*) AS clicks,
         CASE WHEN k.ad_key IN ('vip_upsell','diamonds_store','referral_invite',
                                'tournaments_daily','spins_jackpot')
              THEN count(*) FILTER (WHERE k.id IN (SELECT f.id FROM followed f))
              ELSE NULL END AS clicks_followed_by,
         CASE k.ad_key
           WHEN 'vip_upsell'        THEN 'A VIP subscription started'
           WHEN 'diamonds_store'    THEN 'A diamond purchase completed'
           WHEN 'referral_invite'   THEN 'Somebody used their referral code'
           WHEN 'tournaments_daily' THEN 'They registered for an MTT'
           WHEN 'spins_jackpot'     THEN 'They registered for a Spin'
           ELSE NULL
         END AS conversion_rule
    FROM clicks k
   GROUP BY k.ad_id, k.ad_key, k.slot;
$function$;

revoke all on function public.fn_ad_conversions(integer) from public, anon, authenticated;
grant execute on function public.fn_ad_conversions(integer) to service_role;

do $$
declare
  v_acl        text;
  v_click_rows bigint;
  v_fn_rows    bigint;
  v_null_rule  int;
begin
  if not exists (select 1 from pg_proc where proname = 'fn_ad_conversions') then
    raise exception 'fn_ad_conversions was not created';
  end if;

  select array_to_string(proacl, ' | ') into v_acl
    from pg_proc where proname = 'fn_ad_conversions';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception
      'fn_ad_conversions is executable by players; it joins ad_event to purchase history';
  end if;

  select count(*) into v_click_rows
    from public.ad_event where event_type = 'click' and user_id is not null;
  select coalesce(sum(clicks), 0) into v_fn_rows from public.fn_ad_conversions(24);
  if v_click_rows <> v_fn_rows then
    raise exception 'fn_ad_conversions counted % clicks; ad_event holds %', v_fn_rows, v_click_rows;
  end if;

  select count(*) into v_null_rule
    from public.fn_ad_conversions(24)
   where ad_key = 'bbj_running' and (clicks_followed_by is not null or conversion_rule is not null);
  if v_null_rule > 0 then
    raise exception 'bbj_running reported a conversion count; it has no rule and must report NULL';
  end if;
end $$;
