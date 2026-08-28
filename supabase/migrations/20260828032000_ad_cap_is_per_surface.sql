-- THE FREQUENCY CAP COUNTED THE WRONG THING, AND IT KILLED THE HUB ON ARRIVAL
--
-- SYMPTOM, observed in production 2026-08-28 03:1x UTC. The World Hub ad
-- surface shipped, deployed, and rendered nothing. Two independently written
-- Hub clients (this session's and PR #903's) both showed an empty surface. The
-- Club Arena lobby strip, meanwhile, kept serving and logging normally.
--
-- CAUSE. `fn_resolve_ads` counts a player's impressions of a campaign like
-- this:
--
--     SELECT count(*) FROM public.ad_event e
--      WHERE e.user_id = v_user AND e.ad_id = c.id
--        AND e.event_type = 'impression'
--        AND e.created_at > now() - interval '24 hours'
--
-- There is no slot in that predicate. The count is therefore GLOBAL across
-- every surface, while `daily_cap` is a property of ONE placement on ONE
-- surface. So impressions earned in the lobby are spent against the Hub's cap,
-- and against every future slot's cap.
--
-- The measured state of the account that found it:
--
--     spins_jackpot     36 impressions   all lobby_strip
--     bbj_running       24               all lobby_strip
--     referral_invite   19               all lobby_strip
--     tournaments_daily 16               all lobby_strip
--     diamonds_store     3               all lobby_strip
--
-- Every hub_promotions placement carries a cap of 2 or 3. Every one was
-- already over it before the Hub had ever shown a single advert. Confirmed by
-- probe: `fn_resolve_ads('hub_promotions', null, 3)` returns 3 rows as
-- postgres (auth.uid() null, so the cap is skipped entirely) and 0 rows as the
-- authenticated player. That gap is the whole bug.
--
-- WHY THIS IS THE SHAPE THAT MATTERS. It is PR #1505 again in a different
-- costume: a suppression rule that could not be observed. Every refusal
-- returned an empty list, which is indistinguishable from "no campaigns are
-- running", so a brand-new surface could be born permanently silent and
-- nothing anywhere would go red. The first Hub client to ship would have been
-- blamed for a bug that lived in the resolver.
--
-- Left alone, this gets worse, not better: EVERY slot wired from here on
-- (session_summary, empty_state, table_between_hands) inherits a cap that an
-- active player has already exhausted somewhere else.
--
-- THE FIX, in two parts.
--
--   1. The cap counts impressions ON THE PLACEMENT'S OWN SURFACE. A cap is a
--      statement about how often a player sees a thing IN A PLACE. "Three
--      times in the lobby" and "twice on the Hub" are different sentences and
--      the database now reads them that way.
--
--   2. Suppression becomes countable. `fn_ad_cap_status(slot)` answers, for
--      the caller, exactly why a slot is empty: which campaigns exist, how
--      many impressions they have spent in that slot's window, their cap, and
--      whether they are currently suppressed. Dan, 2026-08-28: "if you add a
--      cap or a hold, make it rotate, and make a suppressed ad countable."
--      The window is rolling, so it rotates on its own; this is the countable
--      half, and it is the part that was missing.
--
-- WHAT THIS DOES NOT CHANGE. No targeting rule moves out of the resolver. The
-- return signature is untouched, so no client needs redeploying. VIP
-- suppression stays absent in both directions (Dan 2026-08-27: "even vips will
-- see ads remove that for now").
--
-- ROLLBACK
--   1. Re-create fn_resolve_ads with the cap subquery's `AND e.slot = pl.slot`
--      line removed. Nothing else in the body differs.
--   2. drop function if exists public.fn_ad_cap_status(text);

-- 1. The resolver. Body is otherwise byte-identical to the version this
--    replaces; only the cap subquery gains one predicate.
create or replace function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null::uuid,
  p_limit integer default 3
)
returns table(
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_vip  boolean := false;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_vip, false) INTO v_vip FROM public.profiles p WHERE p.id = v_user;
  END IF;

  RETURN QUERY
  SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
         -- The placement decides where its own surface should land; the
         -- campaign default applies when it has no opinion.
         COALESCE(pl.target_url, c.target_url) AS target_url,
         c.cta_label
    FROM public.ad_catalog c
    JOIN public.ad_placement pl ON pl.ad_id = c.id
   WHERE c.is_active
     AND pl.is_active
     AND pl.slot = p_slot
     AND (c.starts_at IS NULL OR c.starts_at <= now())
     AND (c.ends_at   IS NULL OR c.ends_at   >  now())
     AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
     -- Audience. A signed-out viewer only ever matches 'all'/NULL.
     AND (
           pl.audience IS NULL
        OR pl.audience = 'all'
        OR (pl.audience = 'vip'      AND v_vip)
        OR (pl.audience = 'non_vip'  AND v_user IS NOT NULL AND NOT v_vip)
        OR (pl.audience = 'new_player' AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p
               WHERE p.id = v_user AND p.created_at > now() - interval '7 days'))
        OR (pl.audience = 'returning'  AND v_user IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.profiles p
               WHERE p.id = v_user AND p.created_at <= now() - interval '7 days'))
     )
     -- Frequency cap, PER SURFACE. `e.slot = pl.slot` is the whole fix: the
     -- cap belongs to this placement, so only impressions this placement
     -- actually produced may spend it. Without it, a player who reads the
     -- lobby all evening arrives at every other surface pre-capped.
     AND (
           pl.daily_cap IS NULL
        OR v_user IS NULL
        OR (SELECT count(*) FROM public.ad_event e
             WHERE e.user_id = v_user AND e.ad_id = c.id
               AND e.slot = pl.slot
               AND e.event_type = 'impression'
               AND e.created_at > now() - interval '24 hours') < pl.daily_cap
     )
   ORDER BY c.weight DESC, c.created_at DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

-- 2. Why is this slot empty? A question nothing could answer until now.
--
-- Returns one row per active placement on the slot, for the CALLING user:
-- what it is, what its cap is, how much of that cap has been spent on this
-- surface in the rolling window, and whether it is suppressed right now.
--
-- An empty ad surface has three completely different causes -- no placements,
-- no audience match, or a spent cap -- and until this function they all
-- looked identical from outside. `suppressed_by_cap` is the countable half of
-- Dan's rule.
create or replace function public.fn_ad_cap_status(p_slot text)
returns table(
  ad_key text,
  audience text,
  daily_cap integer,
  impressions_in_window bigint,
  suppressed_by_cap boolean
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  RETURN QUERY
  SELECT c.ad_key,
         pl.audience,
         pl.daily_cap,
         COALESCE((SELECT count(*) FROM public.ad_event e
                    WHERE e.user_id = v_user AND e.ad_id = c.id
                      AND e.slot = pl.slot
                      AND e.event_type = 'impression'
                      AND e.created_at > now() - interval '24 hours'), 0) AS impressions_in_window,
         (pl.daily_cap IS NOT NULL
          AND v_user IS NOT NULL
          AND (SELECT count(*) FROM public.ad_event e
                WHERE e.user_id = v_user AND e.ad_id = c.id
                  AND e.slot = pl.slot
                  AND e.event_type = 'impression'
                  AND e.created_at > now() - interval '24 hours') >= pl.daily_cap
         ) AS suppressed_by_cap
    FROM public.ad_catalog c
    JOIN public.ad_placement pl ON pl.ad_id = c.id
   WHERE pl.slot = p_slot
     AND pl.is_active
     AND c.is_active
   ORDER BY c.weight DESC;
END;
$function$;

grant execute on function public.fn_ad_cap_status(text) to anon, authenticated;

-- 3. Assertions. Abort rather than half-apply.
do $$
declare
  v_def   text;
  v_user  uuid;
  v_eligible int;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'fn_resolve_ads';
  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'fn_resolve_ads did not take the per-surface cap predicate';
  end if;

  if not exists (select 1 from pg_proc where proname = 'fn_ad_cap_status') then
    raise exception 'fn_ad_cap_status was not created';
  end if;

  -- The regression itself, asserted rather than described: take the player
  -- with the most lobby_strip impressions in the window -- the one the old
  -- rule punished hardest -- and prove that at least one hub_promotions
  -- placement is eligible for them under the new predicate. Before this
  -- migration that number was zero.
  select e.user_id into v_user
    from public.ad_event e
   where e.slot = 'lobby_strip' and e.event_type = 'impression'
     and e.created_at > now() - interval '24 hours'
   group by e.user_id order by count(*) desc limit 1;

  if v_user is not null then
    select count(*) into v_eligible
      from public.ad_catalog c
      join public.ad_placement pl on pl.ad_id = c.id
     where pl.slot = 'hub_promotions' and pl.is_active and c.is_active
       and (pl.daily_cap is null
            or (select count(*) from public.ad_event e
                 where e.user_id = v_user and e.ad_id = c.id
                   and e.slot = pl.slot
                   and e.event_type = 'impression'
                   and e.created_at > now() - interval '24 hours') < pl.daily_cap);
    if v_eligible = 0 then
      raise exception
        'the busiest lobby reader still has no eligible hub_promotions placement; the cap is still leaking across surfaces';
    end if;
  end if;
end $$;
