-- A CLICK IS ATTENTION. IT IS NOT A RESULT.
--
-- Everything this system has measured so far answers "did anyone look at it".
-- That was the whole point, and it was worth building: eleven promotional
-- surfaces shipped in this product before any of them recorded a single
-- impression. But the question it CANNOT answer is the one an operator
-- actually acts on: did the advert work.
--
-- `vip_upsell` has clicks. Did anybody buy VIP? `referral_invite` has clicks.
-- Did an invite get sent? Today the panel would show the same two numbers for
-- a campaign that converts a third of its clicks and one that converts none,
-- and turning the wrong one off is an easy mistake to make from a rate alone.
--
-- Every one of those outcomes is already in this database. Nothing new has to
-- be logged; the join simply was not made.
--
-- ── WHAT THIS MEASURES, PRECISELY ──────────────────────────────────────────
--
-- For each click, whether the SAME PLAYER did the thing the campaign was
-- promoting within a window afterwards. That is correlation inside a window,
-- and it is NOT proof the advert caused it: a player who was going to buy VIP
-- anyway will be counted. It is the honest version of the question and it is
-- far more useful than a click, but the name matters, so nothing here is
-- called "conversions caused by" and the column reads `clicks_followed_by`.
--
-- ── WHY THE RULES ARE A CASE STATEMENT AND NOT A TABLE ─────────────────────
--
-- A `conversion_sql` column would be dynamic SQL executed with a SECURITY
-- DEFINER role. Five hand-written rules, auditable in a diff and changed by
-- migration, is the version that cannot become an injection surface. Adding a
-- rule is a deliberate act, which is correct: deciding what counts as success
-- for a campaign is a judgement, not configuration.
--
-- ── THE CAMPAIGN WITH NO RULE ──────────────────────────────────────────────
--
-- `bbj_running` promotes the Bad Beat Jackpot. Reading a jackpot page is not a
-- database event, and the nearest proxy - "sat at a qualifying table" - would
-- count almost everybody who plays and mean nothing.
--
-- So it returns NULL, not 0. This is the same rule the panel already follows
-- for unreadable stats, and it matters more here: a confident 0 would read as
-- "this campaign converts nobody" when the truth is "we have not defined what
-- success looks like for it". Inventing a metric to avoid an empty cell is how
-- a reporting system starts lying.
--
-- ── THE RULES ──────────────────────────────────────────────────────────────
--
--   vip_upsell         a row in vip_subscriptions        (they subscribed)
--   diamonds_store     a COMPLETED diamond_purchases row (they paid, not just started)
--   referral_invite    a referrals row they referred     (somebody used their code)
--   tournaments_daily  an MTT registration               (they entered a tournament)
--   spins_jackpot      a SPIN registration               (they sat in a Spin)
--   bbj_running        none, deliberately                (returns NULL)
--
-- diamond_purchases is filtered on `completed_at IS NOT NULL` rather than on
-- status text: an abandoned checkout is not a purchase, and a started one is
-- not either.
--
-- ── WINDOW ─────────────────────────────────────────────────────────────────
--
-- 24 hours by default, and a parameter so a shorter window can be asked for
-- without a migration. A tighter window is a stronger claim about the advert
-- and a weaker count; both are useful and neither is the truth on its own.
--
-- ── GRANTS ─────────────────────────────────────────────────────────────────
--
-- service_role only, like fn_ad_stats and fn_ad_suppression. This joins
-- ad_event to purchase and subscription history; `ad_event` has no select
-- policy precisely so one player can never read another's, and this would
-- otherwise hand back rather more than that.
--
-- ROLLBACK
--   drop function if exists public.fn_ad_conversions(integer);

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
    -- They subscribed.
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'vip_upsell'
       AND EXISTS (SELECT 1 FROM public.vip_subscriptions v
                    WHERE v.user_id = k.user_id
                      AND v.created_at >= k.created_at
                      AND v.created_at <  k.created_at + w.span)
    UNION
    -- They paid. An abandoned checkout is not a purchase.
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'diamonds_store'
       AND EXISTS (SELECT 1 FROM public.diamond_purchases d
                    WHERE d.user_id = k.user_id
                      AND d.completed_at IS NOT NULL
                      AND d.completed_at >= k.created_at
                      AND d.completed_at <  k.created_at + w.span)
    UNION
    -- Somebody used their code.
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'referral_invite'
       AND EXISTS (SELECT 1 FROM public.referrals r
                    WHERE r.referrer_id = k.user_id
                      AND r.created_at >= k.created_at
                      AND r.created_at <  k.created_at + w.span)
    UNION
    -- They entered a tournament.
    SELECT k.id FROM clicks k, w
     WHERE k.ad_key = 'tournaments_daily'
       AND EXISTS (SELECT 1 FROM public.tournament_registrations tr
                    JOIN public.tournaments t ON t.id = tr.tournament_id
                   WHERE tr.user_id = k.user_id
                     AND t.tournament_type = 'MTT'
                     AND tr.registered_at >= k.created_at
                     AND tr.registered_at <  k.created_at + w.span)
    UNION
    -- They sat in a Spin.
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
         -- NULL, not 0, where no rule exists. A confident zero would read as
         -- "converts nobody" when the truth is "success is undefined here".
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

-- Assertions. Abort rather than half-apply.
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

  -- Every click with a known user must be accounted for exactly once. If this
  -- drifts, the panel is dividing by a denominator that is not the clicks.
  select count(*) into v_click_rows
    from public.ad_event where event_type = 'click' and user_id is not null;
  select coalesce(sum(clicks), 0) into v_fn_rows from public.fn_ad_conversions(24);
  if v_click_rows <> v_fn_rows then
    raise exception 'fn_ad_conversions counted % clicks; ad_event holds %', v_fn_rows, v_click_rows;
  end if;

  -- bbj_running must come back NULL rather than 0. This is the assertion that
  -- stops a future edit from quietly inventing a metric for it.
  select count(*) into v_null_rule
    from public.fn_ad_conversions(24)
   where ad_key = 'bbj_running' and (clicks_followed_by is not null or conversion_rule is not null);
  if v_null_rule > 0 then
    raise exception 'bbj_running reported a conversion count; it has no rule and must report NULL';
  end if;
end $$;
