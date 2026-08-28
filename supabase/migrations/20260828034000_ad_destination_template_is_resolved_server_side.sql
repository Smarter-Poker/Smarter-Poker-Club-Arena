-- A LIVE HOUSE AD SENT PLAYERS TO "CLUB NOT FOUND OR INVITATION EXPIRED"
--
-- OBSERVED, not inferred. 2026-08-28 03:32 UTC, signed in, SHARK CLUB lobby,
-- clicked the HOUSE strip:
--
--     ad_event id 182 - click - lobby_strip - bbj_running
--     browser landed on  /hub/club-arena/invite/%7BclubId%7D
--     page rendered      "Oops! Club not found or invitation expired"
--
-- `%7BclubId%7D` is the literal string `{clubId}`, URL-encoded. The template
-- was never substituted.
--
-- HOW IT GOT THERE. `ad_catalog.target_url` was changed to carry a template:
--
--     bbj_running    /clubs/{clubId}/jackpot
--     spins_jackpot  /clubs/{clubId}/tournaments
--
-- with the substitution to be performed by the Club Arena client. The data
-- change went live immediately; the client that understands it ships on the
-- Club Arena -> World Hub -> Vercel pipeline, which had not landed. So for the
-- window between them, every player clicking those two campaigns got an error
-- page. Before the change they merely bounced to the club picker, so this made
-- it worse, not better.
--
-- WHY THE FIX BELONGS HERE AND NOT IN A CLIENT. `AdService.ts` (Club Arena),
-- `src/lib/hubAds.js` and `src/services/adService.js` (World Hub) are three
-- clients on two repos and two deploy pipelines. A template only one of them
-- can expand is a destination the other two render literally, and every future
-- slot inherits the same trap. This system's founding rule is that the server
-- decides where an advert points:
--
--   "Targeting is an entitlement question ... every rule lives in
--    fn_resolve_ads so the client cannot disagree with the database."
--
-- A destination is the same kind of question. `fn_resolve_ads` is already
-- handed `p_club_id`; it can substitute the value it already has, once, for
-- every client at once, with no deploy.
--
-- WHAT THIS DOES
--
--   1. Substitutes {clubId} (and {club_id}) with p_club_id when the caller
--      gave one. A client that also does its own replacement finds nothing
--      left to replace, so this is safe to land before or after any client.
--   2. When there is no club in context -- the World Hub calls with NULL --
--      the placeholder cannot be honoured, so the row is DROPPED rather than
--      served. Handing a browser a destination known to be broken is worse
--      than showing one advert fewer, and it is exactly the failure this
--      migration exists to end. Nothing is lost today: every hub_promotions
--      placement carries its own target_url override.
--
-- WHAT IT DOES NOT CHANGE. The return signature is untouched, so no client
-- needs redeploying. Targeting, audience, club scoping and the per-surface
-- frequency cap from 20260828032000 are all carried through unchanged. VIP
-- suppression stays absent in both directions (Dan 2026-08-27: "even vips
-- will see ads remove that for now").
--
-- ROLLBACK
--   Re-create fn_resolve_ads from 20260828032000_ad_cap_is_per_surface.sql.
--   That version is the immediate parent of this one and differs only in the
--   target_url expression and the placeholder guard.

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
  WITH resolved AS (
    SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
           -- The placement decides where its own surface should land; the
           -- campaign default applies when it has no opinion. Then the club
           -- placeholder is expanded with the club we were already given.
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
       -- Frequency cap, PER SURFACE (20260828032000). `e.slot = pl.slot` is
       -- what keeps a lobby impression from spending the Hub's cap.
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
   -- An unresolved placeholder is a destination we KNOW is broken. Showing one
   -- advert fewer beats sending a player to an error page.
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY r.weight DESC, r.created_at DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

-- Assertions. Abort rather than half-apply.
do $$
declare
  v_def       text;
  v_club      uuid;
  v_templated int;
  v_broken    int;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'fn_resolve_ads';

  if v_def not like '%{clubId}%' then
    raise exception 'fn_resolve_ads did not take the club placeholder substitution';
  end if;

  -- The per-surface cap from the previous migration must survive this rewrite.
  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'the per-surface frequency cap was lost in this rewrite';
  end if;

  -- There is something to fix: at least one live destination is templated.
  select count(*) into v_templated
    from public.ad_catalog c
    join public.ad_placement pl on pl.ad_id = c.id
   where c.is_active and pl.is_active
     and coalesce(pl.target_url, c.target_url) like '%{%';
  if v_templated = 0 then
    raise notice 'no templated destinations remain; substitution is now a no-op guard';
  end if;

  -- With a real club in hand, nothing may resolve to a literal placeholder.
  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_broken
      from public.fn_resolve_ads('lobby_strip', v_club, 10) f
     where f.target_url like '%{%';
    if v_broken > 0 then
      raise exception '% lobby destination(s) still carry an unresolved placeholder', v_broken;
    end if;
  end if;
end $$;
