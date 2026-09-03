-- WEIGHT WAS A QUEUE POSITION. IT WAS ALWAYS MEANT TO BE A SHARE OF VOICE.
--
-- `fn_resolve_ads` has ordered by `c.weight DESC, c.created_at DESC` since
-- Phase 1. That is deterministic: the same player, on the same surface, gets
-- the same advert in the same position every time until a cap moves.
--
-- With one slot showing six adverts at once it did not matter - the strip
-- returned all six and rotated through them client-side, so the order only
-- decided which came first.
--
-- It matters now. `empty_state` and `session_summary` are single-card
-- surfaces: `HouseAdCard` asks for ONE advert. So the highest-weighted
-- eligible campaign wins EVERY draw, and the others are invisible until it
-- runs out of cap - and a campaign with no cap at all never runs out. On
-- `empty_state`, `tournaments_daily` (weight 80, cap 2) and `bbj_running`
-- (weight 100, cap 2) will trade places as caps burn, but a player who sees
-- the surface twice a day sees exactly two of the three campaigns, always the
-- same two, forever.
--
-- That is not what a weight is for. Everywhere else in this industry a weight
-- means "this campaign should get roughly this share of the impressions", and
-- the admin panel offers a free-text weight box that quietly means something
-- else entirely.
--
-- ── WHAT REPLACES IT ───────────────────────────────────────────────────────
--
-- Weighted sampling without replacement, by the exponential-key method
-- (Efraimidis-Spirakis A-Res): give each candidate the key
--
--     random() ^ (1.0 / weight)
--
-- and take the largest k. A candidate with twice the weight is twice as likely
-- to come first, and no candidate is ever locked out. One expression, no
-- second query, no state to keep anywhere.
--
-- `GREATEST(r.weight, 1)` guards the exponent: `weight` is a plain integer
-- column with no CHECK, so a 0 or a negative typed into the admin panel would
-- otherwise divide by zero or invert the ordering. A weight of 0 now means
-- "vanishingly unlikely" rather than "crash", which is the kinder reading of
-- what somebody typing 0 probably meant.
--
-- ── STABLE -> VOLATILE, DELIBERATELY ───────────────────────────────────────
--
-- `random()` is volatile, and a STABLE function is allowed to be evaluated
-- once and reused within a statement. Leaving the marking alone would let the
-- planner do exactly the thing this change exists to prevent. The clients call
-- this through `supabase.rpc()`, which POSTs, so a VOLATILE function is served
-- normally; only PostgREST's GET path requires STABLE, and nothing uses it.
--
-- ── WHAT DOES NOT CHANGE ───────────────────────────────────────────────────
--
-- Every eligibility rule: audience, club scoping, flight dates, the
-- per-surface frequency cap, and the guard that drops a destination with an
-- unresolved placeholder. Only the ORDER BY moves. The return signature is
-- untouched, so no client needs redeploying.
--
-- ROLLBACK
--   Re-create from 20260828034000 (identical but for the ORDER BY) and
--   `ALTER FUNCTION public.fn_resolve_ads(text, uuid, integer) STABLE;`

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
volatile
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
  WITH resolved AS (
    SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
           replace(
             replace(
               COALESCE(pl.target_url, c.target_url),
               '{clubId}',  COALESCE(p_club_id::text, '{clubId}')
             ),
             '{club_id}', COALESCE(p_club_id::text, '{club_id}')
           ) AS target_url,
           c.cta_label,
           c.weight,
           c.created_at
      FROM public.ad_catalog c
      JOIN public.ad_placement pl ON pl.ad_id = c.id
     WHERE c.is_active
       AND pl.is_active
       AND pl.slot = p_slot
       AND (c.starts_at IS NULL OR c.starts_at <= now())
       AND (c.ends_at   IS NULL OR c.ends_at   >  now())
       AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
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
       -- Frequency cap, PER SURFACE (20260828032000).
       AND (
             pl.daily_cap IS NULL
          OR v_user IS NULL
          OR (SELECT count(*) FROM public.ad_event e
               WHERE e.user_id = v_user AND e.ad_id = c.id
                 AND e.slot = pl.slot
                 AND e.event_type = 'impression'
                 AND e.created_at > now() - interval '24 hours') < pl.daily_cap
       )
  )
  SELECT r.id, r.ad_key, r.category, r.headline, r.body, r.glyph,
         r.target_url, r.cta_label
    FROM resolved r
   -- An unresolved placeholder is a destination we KNOW is broken
   -- (20260828034000).
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   -- SHARE OF VOICE, NOT RANK. Weighted sampling without replacement: twice
   -- the weight is twice as likely to lead, and nothing is ever locked out.
   -- GREATEST(weight, 1) because the column has no CHECK and a 0 typed into
   -- the panel would otherwise divide by zero.
   ORDER BY random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

-- Assertions. Abort rather than half-apply.
do $$
declare
  v_def   text;
  v_vol   char;
  v_club  uuid;
  v_seen  int;
  v_first text;
  v_diff  int := 0;
  i       int;
begin
  select pg_get_functiondef(oid), provolatile into v_def, v_vol
    from pg_proc where proname = 'fn_resolve_ads';

  if v_def not like '%random()%' then
    raise exception 'fn_resolve_ads did not take the weighted draw';
  end if;

  if v_vol <> 'v' then
    raise exception
      'fn_resolve_ads is still marked % - a STABLE function may evaluate random() once and reuse it', v_vol;
  end if;

  -- Every rule that is not the ordering must survive this rewrite. Each of
  -- these has its own migration and its own incident behind it.
  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'the per-surface frequency cap was lost in this rewrite';
  end if;
  if v_def not like '%{clubId}%' then
    raise exception 'the club placeholder substitution was lost in this rewrite';
  end if;
  if v_def not like '%NOT LIKE ''%{%''%' then
    raise exception 'the unresolved-placeholder guard was lost in this rewrite';
  end if;

  -- And it must actually vary. Draw one advert from a six-campaign slot
  -- twenty times; a deterministic ORDER BY returns the same key every time.
  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_seen
      from public.ad_placement where slot = 'lobby_strip' and is_active;
    if v_seen > 1 then
      select f.ad_key into v_first from public.fn_resolve_ads('lobby_strip', v_club, 1) f;
      for i in 1..20 loop
        if (select f.ad_key from public.fn_resolve_ads('lobby_strip', v_club, 1) f)
           is distinct from v_first then
          v_diff := v_diff + 1;
        end if;
      end loop;
      if v_diff = 0 then
        raise exception
          'twenty single draws from a % campaign slot all returned the same advert; the draw is not weighted', v_seen;
      end if;
    end if;
  end if;
end $$;
